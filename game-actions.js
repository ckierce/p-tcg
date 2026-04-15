// ══════════════════════════════════════════════════════════════════════════════
// GAME-ACTIONS.JS — Card actions, combat, and turn flow
//
// Covers: getActionsForCard, playAsActive, evolve, attachEnergy, retreat,
//   handleBenchClick, cancelAction, coin flips, performAttack,
//   checkKO, resolvePromotion, endTurn
//
// Depends on globals: G, myRole, vsComputer, CARD_DATA, transitionPhase,
//   renderAll, renderHands, renderField, renderPrizes, addLog, setMidline,
//   clearHighlights, showTab, showActionMenu, closeActionMenu, showToast,
//   showTurnFlash, showTrainerFlash, showPromoteBanner, showCoinAnimation,
//   updateDeckCounts, updatePhase, updateTurnBadge, escapeHtml,
//   drawCard, shuffle, enrichCard, pushGameState,
//   preAttackChecks, preDamageModify, applyMoveEffects, endTurnEffectsCleanup,
//   isPowerActive, hasPower, isMukActive, prehistoricPowerActive,
//   hasThickSkin, hasInvisibleWall, hasEnergyBurn, rainDanceActive,
//   energyTransActive, damageSwapActive, retreatCostReduction,
//   doDamageSwap, doEnergyTrans, doCurse, doBuzzap, doMetronome,
//   dittoAttacks, getDittoTransformStats, tryApplyStatus, playTrainer,
//   isMyTurn, isTrainerBlocked, openCardPicker
// ══════════════════════════════════════════════════════════════════════════════

function getActionsForCard(player, card, handIdx) {
  const p = G.players[player];
  const actions = [];
  const isSetup = G.phase === 'SETUP';

  if (card.supertype === 'Pokémon' && card.subtypes?.includes('Basic')) {
    if (!p.active) actions.push({ label: 'Play as Active', fn: () => playAsActive(player, handIdx) });
    const benchFull = p.bench.every(s => s !== null);
    if (!benchFull) {
      // During SETUP: if this is the only Basic and you have no Active yet, force it to Active
      const basicsInHand = p.hand.filter(c => c.supertype === 'Pokémon' && c.subtypes?.includes('Basic')).length;
      const onlyBasicInSetup = isSetup && !p.active && basicsInHand === 1;
      actions.push({
        label: 'Play to Bench',
        fn: onlyBasicInSetup ? null : () => startBenchPlay(player, handIdx),
        disabled: onlyBasicInSetup,
        tooltip: onlyBasicInSetup ? 'Only Basic — must play as Active' : null
      });
    }
  }

  // Evolution — Stage 1 or Stage 2 can evolve a matching pokemon on the board
  if (!isSetup && card.supertype === 'Pokémon' &&
      (card.subtypes?.includes('Stage 1') || card.subtypes?.includes('Stage 2'))) {
    const evolvesFrom = card.evolvesFrom;
    if (evolvesFrom) {
      const evolvedUids = G.evolvedThisTurn || [];
      const prehistoric = prehistoricPowerActive();
      // Check active
      if (p.active?.name === evolvesFrom) {
        const justEvolved = evolvedUids.includes(p.active.uid);
        const blocked = prehistoric || justEvolved;
        const tooltip = prehistoric ? 'Aerodactyl\u2019s Prehistoric Power prevents evolution'
                       : justEvolved ? 'Cannot evolve again this turn' : null;
        actions.push({
          label: `Evolve Active (${evolvesFrom} → ${card.name})`,
          fn: blocked ? null : () => evolve(player, handIdx, 'active', null),
          disabled: blocked,
          tooltip
        });
      }
      // Check bench
      p.bench.forEach((b, i) => {
        if (b?.name === evolvesFrom) {
          const justEvolved = evolvedUids.includes(b.uid);
          const blocked = prehistoric || justEvolved;
          const tooltip = prehistoric ? 'Aerodactyl\u2019s Prehistoric Power prevents evolution'
                         : justEvolved ? 'Cannot evolve again this turn' : null;
          actions.push({
            label: `Evolve Bench ${i+1} (${evolvesFrom} → ${card.name})`,
            fn: blocked ? null : () => evolve(player, handIdx, 'bench', i),
            disabled: blocked,
            tooltip
          });
        }
      });
    }
  }

  // Healing/status trainers that target active Pokémon
  if (!isSetup && card.supertype === 'Trainer') {
    const healNames = /^(potion|super potion|full heal|full restore|max potion|pokémon center|revive)$/i;
    if (healNames.test(card.name) && p.active) {
      highlightSlot('active-p1', 'heal');
    }
  }

  if (!isSetup && card.supertype === 'Energy') {
    const isWaterEnergy = /water/i.test(card.name);
    const rainDanceAvailable = rainDanceActive(player) && isWaterEnergy;
    const canAttach = !G.energyPlayedThisTurn || rainDanceAvailable;
    if (canAttach) {
      // Rain Dance label + Water-only restriction only when normal once-per-turn attach is spent
      const isRainDanceAttach = rainDanceAvailable && G.energyPlayedThisTurn;
      const activeIsWater = !isRainDanceAttach || (p.active?.types || []).some(t => /water/i.test(t));
      if (activeIsWater) {
        actions.push({
          label: isRainDanceAttach ? 'Attach to Active (Rain Dance)' : 'Attach to Active',
          fn: () => attachEnergy(player, handIdx, 'active', null, isRainDanceAttach)
        });
      }
      const waterBench = p.bench.filter((s, i) => s !== null && (!isRainDanceAttach || (s.types || []).some(t => /water/i.test(t))));
      if (waterBench.length > 0 || (!isRainDanceAttach && p.bench.some(s => s !== null))) {
        actions.push({
          label: isRainDanceAttach ? 'Attach to Bench... (Rain Dance)' : 'Attach to Bench...',
          fn: () => startEnergyAttach(player, handIdx, isRainDanceAttach)
        });
      }
    }
  }
  if (!isSetup && card.supertype === 'Trainer') {
    const opp = player === 1 ? 2 : 1;
    const oppP = G.players[opp];
    const myPokemon = [p.active, ...p.bench].filter(Boolean);
    const oppPokemon = [oppP.active, ...oppP.bench].filter(Boolean);
    const nm = card.name;
    let unplayableReason = null;
    if (/^potion$/i.test(nm) && !myPokemon.some(s => (s.damage || 0) > 0))
      unplayableReason = 'No damaged Pokémon to heal';
    else if (/^super potion$/i.test(nm) && !myPokemon.some(s => (s.damage || 0) > 0 && (s.attachedEnergy||[]).length))
      unplayableReason = 'No damaged Pokémon with energy to discard';
    else if (/^max potion$/i.test(nm) && !myPokemon.some(s => (s.damage || 0) > 0))
      unplayableReason = 'No damaged Pokémon to heal';
    else if (/^pokémon center$/i.test(nm) && !myPokemon.some(s => (s.damage || 0) > 0))
      unplayableReason = 'No damaged Pokémon to heal';
    else if (/^full heal$/i.test(nm) && !p.active?.status)
      unplayableReason = 'Active Pokémon has no status condition';
    else if (/^full restore$/i.test(nm) && !p.active?.status)
      unplayableReason = 'Active Pokémon has no status condition';
    else if (/^scoop up$/i.test(nm) && !myPokemon.some(s => s.subtypes?.includes('Basic') && !s.isDoll))
      unplayableReason = 'No eligible Basic Pokémon';
    else if (/^switch$/i.test(nm) && !p.bench.some(s => s !== null))
      unplayableReason = 'No bench Pokémon to switch with';
    else if (/^gust of wind$/i.test(nm) && !oppP.bench.some(s => s !== null))
      unplayableReason = 'Opponent has no benched Pokémon';
    else if (/^pluspower$/i.test(nm) && !p.active)
      unplayableReason = 'No active Pokémon';
    else if (/^defender$/i.test(nm) && !p.active)
      unplayableReason = 'No active Pokémon';
    else if (/^energy removal$/i.test(nm) && !oppPokemon.some(s => (s.attachedEnergy||[]).length))
      unplayableReason = 'Opponent has no energy to remove';
    else if (/^super energy removal$/i.test(nm) && (!oppPokemon.some(s => (s.attachedEnergy||[]).length) || !myPokemon.some(s => (s.attachedEnergy||[]).length)))
      unplayableReason = !oppPokemon.some(s => (s.attachedEnergy||[]).length) ? 'Opponent has no energy' : 'You have no energy to discard';
    else if (/^energy retrieval$/i.test(nm) && !p.discard.some(c => c.supertype === 'Energy' && !/double colorless/i.test(c.name)))
      unplayableReason = 'No basic energy in discard';
    else if (/^energy search$/i.test(nm) && !p.deck.some(c => c.supertype === 'Energy' && !/double colorless/i.test(c.name)))
      unplayableReason = 'No basic energy in deck';
    else if (/^computer search$/i.test(nm) && (p.hand.filter((_,i)=>i!==handIdx).length < 2 || !p.deck.length))
      unplayableReason = p.deck.length ? 'Need at least 2 other cards in hand' : 'Deck is empty';
    else if (/^item finder$/i.test(nm) && (!p.discard.some(c => c.supertype === 'Trainer') || p.hand.filter((_,i)=>i!==handIdx).length < 2))
      unplayableReason = !p.discard.some(c => c.supertype === 'Trainer') ? 'No Trainers in discard' : 'Need at least 2 other cards to discard';
    else if (/^maintenance$/i.test(nm) && p.hand.filter((_,i)=>i!==handIdx).length < 2)
      unplayableReason = 'Need at least 2 other cards in hand';
    else if (/^revive$/i.test(nm) && (!p.discard.some(c => c.supertype === 'Pokémon' && c.subtypes?.includes('Basic')) || p.bench.every(s => s !== null)))
      unplayableReason = !p.discard.some(c => c.supertype === 'Pokémon' && c.subtypes?.includes('Basic')) ? 'No Basic Pokémon in discard' : 'Bench is full';
    else if (/^mr\. fuji$/i.test(nm) && !p.bench.some(s => s !== null))
      unplayableReason = 'No bench Pokémon to choose';
    else if (/^pokémon trader$/i.test(nm) && (!p.hand.some((c,i) => i !== handIdx && c.supertype === 'Pokémon') || !p.deck.some(c => c.supertype === 'Pokémon')))
      unplayableReason = !p.deck.some(c => c.supertype === 'Pokémon') ? 'No Pokémon in deck' : 'No other Pokémon in hand to trade';
    else if (/^pokémon breeder$/i.test(nm) && !p.hand.some((c,i) => i !== handIdx && c.subtypes?.includes('Stage 2')))
      unplayableReason = 'No Stage 2 Pokémon in hand';
    else if (/^pokémon flute$/i.test(nm) && (!oppP.discard.some(c => c.supertype === 'Pokémon' && c.subtypes?.includes('Basic')) || oppP.bench.every(s => s !== null)))
      unplayableReason = !oppP.discard.some(c => c.supertype === 'Pokémon' && c.subtypes?.includes('Basic')) ? "No Basic Pokémon in opponent's discard" : "Opponent's bench is full";
    else if (/^devolution spray$/i.test(nm) && !myPokemon.some(s => s.subtypes?.includes('Stage 1') || s.subtypes?.includes('Stage 2')))
      unplayableReason = 'No evolved Pokémon to devolve';
    else if (/^recycle$/i.test(nm) && !p.discard.length)
      unplayableReason = 'Discard pile is empty';
    else if (/^clefairy doll$/i.test(nm) && p.bench.every(s => s !== null) && p.active)
      unplayableReason = 'Bench is full';
    else if (/^mysterious fossil$/i.test(nm) && p.bench.every(s => s !== null) && p.active)
      unplayableReason = 'Bench is full';
    if (unplayableReason) {
      actions.push({ label: `Cannot play — ${unplayableReason}`, disabled: true, fn: () => {} });
    } else {
      actions.push({ label: 'Play Trainer', fn: async () => { closeActionMenu(); await playTrainer(player, handIdx); } });
    }
  }
  // Always allow viewing the card image
  const _viewSrc = card.images?.large || card.images?.small || '';
  if (_viewSrc) {
    actions.push({ label: 'View Card', fn: () => { closeActionMenu(); showCardDetail(_viewSrc); } });
  }
  return actions;
}

function playAsActive(player, handIdx) {
  closeActionMenu();
  // During PROMOTE phase, the player must choose from their bench, not play from hand
  if (G.phase === 'PROMOTE') {
    showToast(`Choose a Benched Pokémon to promote — you cannot play from hand now!`, true);
    return;
  }
  const p = G.players[player];
  const card = p.hand.splice(handIdx, 1)[0];
  card.damage = 0; card.attachedEnergy = []; card.status = null;
  p.active = card;
  // Mark as played this turn — cannot evolve until next turn
  if (G.phase !== 'SETUP') {
    if (!G.evolvedThisTurn) G.evolvedThisTurn = [];
    G.evolvedThisTurn.push(card.uid);
  }
  addLog(`Player ${player} played ${card.name} as their Active Pokémon.`, true);
  showActionFlash(player, 'PLAYS', card.name, 'AS ACTIVE');
  renderAll();
}

function evolve(player, handIdx, zone, benchIdx) {
  closeActionMenu();
  const p = G.players[player];
  const target = zone === 'active' ? p.active : p.bench[benchIdx];
  if (!target) { showToast('Target not found!', true); return; }

  // Guard: cannot evolve a Pokémon placed or evolved this turn
  const evolvedUids = G.evolvedThisTurn || [];
  if (evolvedUids.includes(target.uid)) {
    showToast(`${target.name} was played this turn and cannot be evolved yet!`, true);
    return;
  }

  // Guard: Aerodactyl's Prehistoric Power blocks all evolution
  if (typeof prehistoricPowerActive === 'function' && prehistoricPowerActive()) {
    showToast("Aerodactyl's Prehistoric Power prevents evolution!", true);
    return;
  }

  // All guards passed — now remove card from hand
  const evoCard = p.hand.splice(handIdx, 1)[0];

  // Carry over damage, energy, status from the base pokemon
  evoCard.damage = target.damage || 0;
  evoCard.attachedEnergy = target.attachedEnergy || [];
  evoCard.status = null; // evolving cures status conditions

  // Store pre-evolution cards underneath (they go to discard only when KO'd, not on evolve)
  // Mysterious Fossil is an exception — it IS discarded on evolution per Base Set rules
  const isFossil = /mysterious fossil/i.test(target.name);
  if (isFossil) {
    target.attachedEnergy = [];
    target.damage = 0;
    p.discard.push(target);
  } else {
    evoCard.prevStages = [...(target.prevStages || []), { ...target, attachedEnergy: [], damage: 0, prevStages: undefined }];
  }

  if (zone === 'active') {
    p.active = evoCard;
  } else {
    p.bench[benchIdx] = evoCard;
  }

  // Track that this card was just evolved — cannot be evolved again this turn
  if (!G.evolvedThisTurn) G.evolvedThisTurn = [];
  G.evolvedThisTurn.push(evoCard.uid);

  addLog(`Player ${player} evolved ${target.name} into ${evoCard.name}!`, true);
  showActionFlash(player, 'EVOLVES', evoCard.name, `from ${target.name}`);
  renderAll();
}

function startBenchPlay(player, handIdx) {
  closeActionMenu();
  const p = G.players[player];
  const freeSlot = p.bench.findIndex(s => s === null);
  if (freeSlot === -1) { showToast('Bench is full!', true); return; }
  const card = p.hand.splice(handIdx, 1)[0];
  card.damage = 0; card.attachedEnergy = []; card.status = null;
  p.bench[freeSlot] = card;
  // Mark as played this turn — cannot evolve until next turn
  if (G.phase !== 'SETUP') {
    if (!G.evolvedThisTurn) G.evolvedThisTurn = [];
    G.evolvedThisTurn.push(card.uid);
  }
  G.pendingAction = null;
  addLog(`Player ${player} played ${card.name} to the bench.`);
  showActionFlash(player, 'BENCHES', card.name, '');
  renderAll();
}

function playToBench(player, slotIdx) {
  if (!G.pendingAction || G.pendingAction.type !== 'bench') return;
  if (G.pendingAction.player !== player) return;
  if (G.players[player].bench[slotIdx] !== null) return;
  const { handIdx } = G.pendingAction;
  const p = G.players[player];
  const card = p.hand.splice(handIdx, 1)[0];
  card.damage = 0; card.attachedEnergy = []; card.status = null;
  p.bench[slotIdx] = card;
  G.pendingAction = null;
  clearHighlights();
  addLog(`Player ${player} played ${card.name} to the bench.`);
  showActionFlash(player, 'BENCHES', card.name, '');
  renderAll();
}

function attachEnergy(player, handIdx, target, benchIdx = null, isRainDance = false) {
  closeActionMenu();
  if (G.energyPlayedThisTurn && !isRainDance) { showToast('Already attached energy this turn!', true); return; }
  const p = G.players[player];
  const energy = p.hand.splice(handIdx, 1)[0];
  let targetCard = target === 'active' ? p.active : p.bench[benchIdx];
  if (!targetCard) { showToast('No Pokémon there!', true); p.hand.splice(handIdx, 0, energy); return; }
  // Rain Dance: target must be a Water Pokémon
  if (isRainDance && !(targetCard.types || []).some(t => /water/i.test(t))) {
    showToast('Rain Dance only works on Water Pokémon!', true);
    p.hand.splice(handIdx, 0, energy); return;
  }
  if (!targetCard.attachedEnergy) targetCard.attachedEnergy = [];
  targetCard.attachedEnergy.push(energy);
  if (!isRainDance) G.energyPlayedThisTurn = true;
  G.pendingAction = null;
  clearHighlights();
  addLog(`Player ${player} attached ${energy.name} to ${targetCard.name}${isRainDance ? ' (Rain Dance)' : ''}.`);
  showActionFlash(player, 'ATTACHES', energy.name, `→ ${targetCard.name}`);
  renderAll();
}

function startEnergyAttach(player, handIdx, isRainDance = false) {
  closeActionMenu();
  G.pendingAction = { type: 'energy', player, handIdx, isRainDance };
  const p = G.players[player];
  for (let i = 0; i < 5; i++) {
    const bench = p.bench[i];
    if (bench) {
      // Rain Dance: only highlight Water Pokémon
      const eligible = !isRainDance || (bench.types || []).some(t => /water/i.test(t));
      if (eligible) document.getElementById(`bench-p${player}-${i}`)?.classList.add('highlight');
    }
  }
  setMidline(isRainDance ? 'Rain Dance: choose a Water Pokémon to attach energy to' : 'Choose a bench Pokémon to attach energy to');
}


function onActiveClick(player, evt) {
  // Remap slot IDs to actual players based on perspective
  if (myRole === 2) player = player === 1 ? 2 : 1;

  // Always allow View Card on any slot regardless of turn/role
  const viewCardFn = (card) => {
    const src = card?.images?.large || card?.images?.small || '';
    if (src) showActionMenu(card.name, [{ label: 'View Card', fn: () => { closeActionMenu(); showCardDetail(src); } }], evt);
  };

  if (G.pendingAction?.type === 'energy' && G.pendingAction.player === player) {
    attachEnergy(player, G.pendingAction.handIdx, 'active', null, G.pendingAction.isRainDance || false);
    G.pendingAction = null; clearHighlights(); return;
  }
  const p = G.players[player];
  const isMyPokemon = myRole === null || player === myRole;
  const canAct = isMyPokemon && (G.phase === 'SETUP' || (G.turn === player && G.phase === 'MAIN'));
  if (p.active && canAct) {
    showFieldActionMenu(player, 'active', null, evt);
  } else if (p.active) {
    // Not our pokemon or not our turn — View Card only
    viewCardFn(p.active);
  }
}

// canAffordAttack — defined in game-utils.js (loaded before this file)

function showFieldActionMenu(player, zone, benchIdx, evt) {
  const p = G.players[player];
  const opp = G.players[player === 1 ? 2 : 1];
  const card = zone === 'active' ? p.active : p.bench[benchIdx];
  if (!card) return;
  const actions = [];

  // Move bench pokemon to active if active is empty
  if (zone !== 'active' && !p.active) {
    actions.push({ label: 'Move to Active', fn: () => {
      p.active = card; p.bench[benchIdx] = null;
      addLog(`P${player} moved ${card.name} to Active.`);
      renderAll(); closeActionMenu();
    }});
  }

  // Attacks — only from active slot, only on your turn, only your own pokemon
  if (zone === 'active' && G.turn === player && G.phase === 'MAIN' && (myRole === null || player === myRole)) {
    // Ditto: use opponent's attacks via Transform power
    const transformAttacks = dittoAttacks(player);
    const attacks = transformAttacks || card.attacks || [];
    if (transformAttacks) addLog && undefined; // no-op, just using the branch
    if (attacks.length === 0) {
      actions.push({ label: 'No attacks', disabled: true });
    } else {
      attacks.forEach(atk => {
        const costStr = atk.cost?.join(', ') || '—';
        const dmg = atk.damage || '0';
        const canAfford = canAffordAttack(card.attachedEnergy, atk.cost, card);
        const isDisabled = card.disabledAttack && card.disabledAttack === atk.name;
        const isLeekSlapUsed = card.leekSlapUsed && /can't use this attack again as long as/i.test(atk.text || '');
        // Conversion 1 requires the opponent to have a Weakness — block it if they don't
        const isConversion1Blocked = atk.name === 'Conversion 1' &&
          !(G.players[player === 1 ? 2 : 1].active?.weaknesses || []).length;
        const isStatusBlocked = card.status === 'paralyzed' || card.status === 'asleep';
        // Agility/Barrier (defenderFullEffects) and Tail Wag (immuneToAttack) are handled
        // inside performAttack — don't grey out attacks here, player should still be able to select them
        const blocked = !canAfford || isDisabled || isLeekSlapUsed || isConversion1Blocked || isStatusBlocked;
        const subLabel = isStatusBlocked ? `${costStr} · CANNOT ATTACK (${card.status.toUpperCase()})` :
                         isLeekSlapUsed ? `${costStr} · USED (once only)` :
                         isDisabled ? `${costStr} · DISABLED` :
                         isConversion1Blocked ? `${costStr} · NO WEAKNESS TO CHANGE` :
                         canAfford ? `${costStr} · ${dmg} dmg` :
                         `${costStr} · ${dmg} dmg — NOT ENOUGH ENERGY`;
        actions.push({
          label: `⚔ ${atk.name}`,
          sub: subLabel,
          fn: blocked ? null : async () => { closeActionMenu(); await performAttack(player, atk); },
          disabled: blocked,
        });
      });
    }
    const activeStatus = card.status;
    const retreatBlocked = activeStatus === 'paralyzed' || activeStatus === 'asleep';
    const retreatConfused = activeStatus === 'confused';
    const retreatLabel = retreatBlocked
      ? `Retreat — blocked (${activeStatus})`
      : retreatConfused
        ? 'Retreat (flip coin — confused)'
        : 'Retreat';
    actions.push({
      label: retreatLabel,
      disabled: retreatBlocked,
      fn: retreatBlocked ? null : () => { attemptRetreat(player); closeActionMenu(); }
    });

  }

  // ── Pokémon Power actions — own Pokémon, own turn, active OR bench ──────────
  // Must be outside the active-only block so bench powers (Step In, Buzzap, etc.) work.
  if (G.turn === player && G.phase === 'MAIN' && (myRole === null || player === myRole)) {
    if (typeof getFieldActionExtras === 'function') {
      actions.push(...getFieldActionExtras(player, zone, benchIdx, card));
    }
  }

  // Clefairy Doll / Mysterious Fossil: can be voluntarily discarded from bench on your turn
  if (zone !== 'active' && (card.isDoll || card.isFossil) && G.turn === player && G.phase === 'MAIN') {
    actions.push({
      label: `Discard ${card.name}`,
      danger: true,
      fn: () => {
        p.bench[benchIdx] = null;
        p.discard.push(card);
        addLog(`P${player} discarded ${card.name} from the bench.`, true);
        closeActionMenu();
        renderAll();
      }
    });
  }

  const _src = card.images?.large || card.images?.small || '';
  if (_src) actions.push({ label: 'View Card', fn: () => { closeActionMenu(); showCardDetail(_src); } });
  showActionMenu(card.name, actions, evt);
}

function attemptRetreat(player) {
  const p = G.players[player];
  if (!p.active) return;
  if (p.active.canRetreat === false) { showToast(`${p.active.name} cannot retreat!`, true); return; }

  // Paralyzed and Asleep Pokémon cannot retreat (TCG rule)
  if (p.active.status === 'paralyzed') {
    showToast(`${p.active.name} is Paralyzed and cannot retreat!`, true); return;
  }
  if (p.active.status === 'asleep') {
    showToast(`${p.active.name} is Asleep and cannot retreat!`, true); return;
  }
  // Confused Pokémon must flip a coin to retreat — heads OK, tails fail
  if (p.active.status === 'confused') {
    (async () => {
      const heads = await flipCoin(`${p.active.name} is Confused! Heads = can retreat, Tails = cannot retreat`);
      if (!heads) {
        addLog(`${p.active.name} is Confused — TAILS! Cannot retreat this turn.`, true);
        showToast(`${p.active.name} is too Confused to retreat!`, true);
        return;
      }
      addLog(`${p.active.name} is Confused — HEADS! Retreating...`);
      await doRetreat(player, p);
    })();
    return;
  }
  doRetreat(player, p); // async — fire and forget is fine here (no await needed at call site)
}

// energyValue — defined in game-utils.js (loaded before this file)

async function doRetreat(player, p) {

  const benchSlots = p.bench.map((s, i) => ({ s, i })).filter(x => x.s !== null);
  if (!benchSlots.length) { showToast('No bench Pokémon to retreat to!', true); return; }

  const _baseRetreat = p.active.convertedRetreatCost || 0;
  const _retreatDiscount = typeof retreatCostReduction === 'function' ? retreatCostReduction(player) : 0;
  const retreatCost = Math.max(0, _baseRetreat - _retreatDiscount);
  const attached = p.active.attachedEnergy || [];
  if (energyValue(attached) < retreatCost) {
    showToast(`Need ${retreatCost} energy to retreat — only ${energyValue(attached)} attached!`, true);
    return;
  }

  // If only one bench option, do it immediately
  if (benchSlots.length === 1) {
    await executeRetreat(player, benchSlots[0].i);
    return;
  }

  // Multiple bench options — highlight slots and wait for bench click
  G.pendingAction = { type: 'retreat', player };
  benchSlots.forEach(({ i }) => {
    document.getElementById(`bench-p${player}-${i}`)?.classList.add('highlight');
  });
  setMidline(`Choose a bench Pokémon to switch in for ${p.active.name}`);
}

async function executeRetreat(player, benchIdx) {
  const p = G.players[player];

  // Final guard
  if (p.active?.status === 'paralyzed' || p.active?.status === 'asleep') {
    showToast(`${p.active.name} cannot retreat!`, true);
    G.pendingAction = null; clearHighlights(); return;
  }

  const _baseRetreat = p.active.convertedRetreatCost || 0;
  const _retreatDiscount = typeof retreatCostReduction === 'function' ? retreatCostReduction(player) : 0;
  const retreatCost = Math.max(0, _baseRetreat - _retreatDiscount);

  // ── Energy discard for retreat ───────────────────────────────────────────
  // Player chooses which energy cards to discard. The total energy VALUE of
  // chosen cards must equal or exceed retreatCost. DCE counts as 2.
  let toDiscard = [];
  if (retreatCost > 0) {
    const attached = p.active.attachedEnergy || [];

    // Always show picker so player is reminded of the cost.
    // Auto-select if there is genuinely no choice (exactly one card and it covers cost).
    const noRealChoice = attached.length === 1 ||
      (attached.length > 0 && energyValue(attached) === retreatCost && !attached.some(e => /double colorless/i.test(e.name || '')));

    if (noRealChoice) {
      // Auto-select the minimum cards needed — no choice to make
      let remaining = retreatCost;
      for (const e of attached) {
        if (remaining <= 0) break;
        toDiscard.push(e);
        remaining -= /double colorless/i.test(e.name || '') ? 2 : 1;
      }
      // Show picker with ONLY the cards being discarded so the player can confirm or cancel
      const picked = await openCardPicker({
        title: `${p.active.name} — Retreat Cost`,
        subtitle: `Discard ${toDiscard.map(e => e.name).join(' + ')} to retreat?`,
        cards: toDiscard,
        maxSelect: toDiscard.length,
      });
      if (!picked || !picked.length) {
        showToast('Retreat cancelled.', true);
        G.pendingAction = null; clearHighlights();
        return;
      }
      // Use auto-selected toDiscard (pre-computed above)
    } else {
      // Multiple options — let player choose.
      // Cap maxSelect at retreatCost: worst case is all basic energy at 1 each,
      // so you never need to select more cards than the cost value.
      const picked = await openCardPicker({
        title: `${p.active.name} — Retreat`,
        subtitle: `Choose energy to discard (need ${retreatCost} energy value)`,
        cards: attached,
        maxSelect: retreatCost,
      });

      if (!picked || !picked.length) {
        showToast('Retreat cancelled.', true);
        G.pendingAction = null; clearHighlights();
        return;
      }

      toDiscard = picked.map(i => attached[i]);
      const chosenValue = energyValue(toDiscard);
      if (chosenValue < retreatCost) {
        showToast(`Not enough energy selected (${chosenValue} of ${retreatCost} needed). Retreat cancelled.`, true);
        G.pendingAction = null; clearHighlights();
        return;
      }
      if (chosenValue > retreatCost) {
        showToast(`Too much energy selected (${chosenValue} of ${retreatCost} needed). Retreat cancelled.`, true);
        G.pendingAction = null; clearHighlights();
        return;
      }
    }

    // Remove chosen cards from attachedEnergy and discard them
    toDiscard.forEach(e => {
      const idx = p.active.attachedEnergy.indexOf(e);
      if (idx !== -1) p.active.attachedEnergy.splice(idx, 1);
    });
    p.discard.push(...toDiscard);
    addLog(`P${player} discarded ${toDiscard.map(e => e.name).join(', ')} to retreat.`);
  }

  const old = p.active;
  if (old) {
    old.leekSlapUsed = false;
    old.immuneToAttack = false;
    old.swordsDanceActive = false;
    old.destinyBond = false;
    old.pounceActive = false;
    if (typeof clearLastAttack === 'function') clearLastAttack(player);
  }
  if (old.status) {
    addLog(`${old.name}'s ${old.status} condition cleared on retreat.`);
    old.status = null;
  }
  p.active = p.bench[benchIdx];
  p.bench[benchIdx] = old;
  G.pendingAction = null;
  clearHighlights();
  showActionFlash(player, 'RETREATS', old.name, `→ ${p.active.name}`);
  addLog(`Player ${player} retreated ${old.name} → sent out ${p.active.name}.`);
  renderAll();
}

async function handleBenchClick(player, slotIdx, evt) {
  // Remap slot IDs to actual players based on perspective
  if (myRole === 2) player = player === 1 ? 2 : 1;
  const slot = G.players[player].bench[slotIdx];

  // Force-switch handler (Whirlwind, Ram, Terror Strike — defending player chooses)
  if (window._forceSwitchHandler && window._forceSwitchHandler.opp === player && slot) {
    const handler = window._forceSwitchHandler;
    if (handler.benchSlots.some(x => x.i === slotIdx)) {
      handler.resolve(slotIdx);
      return;
    }
  }

  // During PROMOTE phase — only the KO'd player can act, and only to pick a bench slot
  if (G.phase === 'PROMOTE') {
    const isMyPromote = myRole === null || myRole === G.pendingPromotion;
    if (G.pendingPromotion === player && slot && isMyPromote) {
      resolvePromotion(player, slotIdx);
    } else if (!isMyPromote || G.pendingPromotion !== player) {
      showToast(`Player ${G.pendingPromotion} must choose a new Active first!`, true);
    }
    return;
  }

  if (G.pendingAction?.type === 'retreat' && G.pendingAction.player === player && slot) {
    await executeRetreat(player, slotIdx); return;
  }

  if (G.pendingAction?.type === 'bench' && G.pendingAction.player === player && !slot) {
    playToBench(player, slotIdx); return;
  }
  if (G.pendingAction?.type === 'energy' && G.pendingAction.player === player && slot) {
    attachEnergy(player, G.pendingAction.handIdx, 'bench', slotIdx, G.pendingAction.isRainDance || false);
    G.pendingAction = null; clearHighlights(); return;
  }
  const isMyPokemon = myRole === null || player === myRole;
  const canAct = isMyPokemon && (G.phase === 'SETUP' || G.turn === player);
  if (slot && canAct) {
    showFieldActionMenu(player, 'bench', slotIdx, evt);
  } else if (slot) {
    // Not our pokemon or not our turn — View Card only
    const src = slot.images?.large || slot.images?.small || '';
    if (src) showActionMenu(slot.name, [{ label: 'View Card', fn: () => { closeActionMenu(); showCardDetail(src); } }], evt);
  }
}

function cancelAction() {
  G.pendingAction = null;
  clearHighlights();
  document.querySelectorAll('.hand-card').forEach(el => el.classList.remove('selected'));
  setMidline('');
}

// ══════════════════════════════════════════════════
// COIN FLIP
// ══════════════════════════════════════════════════
function showCoinAnimation(label, heads, opts = {}) {
  return new Promise(resolve => {
    const overlay = document.getElementById('coin-overlay');
    const coin = document.getElementById('coin');
    const resultEl = document.getElementById('coin-result');
    const labelEl = document.getElementById('coin-label');
    const endDeg = heads ? 1440 : 1620;
    if (!overlay.classList.contains('show')) {
      _flashQueue.length = 0; _flashBusy = false;
      document.getElementById('move-flash')?.classList.remove('show');
      document.getElementById('action-flash')?.classList.remove('show');
    }
    const PRE_DELAY = overlay.classList.contains('show') ? 200 : 700;
    setTimeout(() => {
      coin.style.setProperty('--coin-end-deg', `${endDeg}deg`);
      const header = (opts.flipNum && opts.totalFlips && opts.totalFlips > 1)
        ? `Flip ${opts.flipNum} of ${opts.totalFlips} — ${label}` : label;
      labelEl.textContent = header || 'Flipping a coin...';
      resultEl.textContent = '';
      overlay.classList.add('show');
      coin.classList.remove('flipping');
      void coin.offsetWidth;
      coin.classList.add('flipping');
      setTimeout(() => {
        resultEl.textContent = heads ? '✦ HEADS ✦' : '✦ TAILS ✦';
        resultEl.style.color = heads ? 'var(--ok)' : 'var(--p2color)';
        setTimeout(() => {
          if (!opts.persistent) overlay.classList.remove('show');
          coin.classList.remove('flipping');
          resolve();
        }, 1200);
      }, 1000);
    }, PRE_DELAY);
  });
}

function flipCoin(label, opts = {}) {
  // opts.persistent: keep overlay open after resolving (caller closes via closeCoinOverlay())
  // opts.flipNum / opts.totalFlips: show "Flip X of Y" when in a multi-flip sequence
  return new Promise(resolve => {
    const overlay = document.getElementById('coin-overlay');
    const coin = document.getElementById('coin');
    const resultEl = document.getElementById('coin-result');
    const labelEl = document.getElementById('coin-label');

    const heads = Math.random() < 0.5;
    if (!G.coinFlipLog) G.coinFlipLog = [];
    G.coinFlipLog.push({ label, heads, flipNum: opts.flipNum, totalFlips: opts.totalFlips });
    const endDeg = heads ? 1440 : 1620;

    // Shorter pre-delay if overlay is already showing (consecutive flips)
    const PRE_DELAY = overlay.classList.contains('show') ? 200 : 700;

    setTimeout(() => {
      coin.style.setProperty('--coin-end-deg', `${endDeg}deg`);
      const header = (opts.flipNum && opts.totalFlips && opts.totalFlips > 1)
        ? `Flip ${opts.flipNum} of ${opts.totalFlips} — ${label}`
        : label;
      labelEl.textContent = header || 'Flipping a coin...';
      resultEl.textContent = '';
      overlay.classList.add('show');

      coin.classList.remove('flipping');
      void coin.offsetWidth;
      coin.classList.add('flipping');

      setTimeout(() => {
        resultEl.textContent = heads ? '✦ HEADS ✦' : '✦ TAILS ✦';
        resultEl.style.color = heads ? 'var(--ok)' : 'var(--p2color)';
        setTimeout(() => {
          if (!opts.persistent) overlay.classList.remove('show');
          coin.classList.remove('flipping');
          resolve(heads);
        }, 1200);
      }, 1000);
    }, PRE_DELAY);
  });
}

function closeCoinOverlay() {
  document.getElementById('coin-overlay')?.classList.remove('show');
}

// Prompts the player to pick a number between min and max (inclusive).
// Returns a Promise that resolves to the chosen number, or null if cancelled.
function pickNumber(title, min, max) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:1200;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;';
    const buttons = [];
    for (let n = min; n <= max; n++) {
      buttons.push(`<button onclick="this.closest('div').remove();window._pickNumberVal=${n}"
        style="font-family:var(--font);font-size:10px;width:44px;height:44px;border-radius:50%;background:var(--surface2);border:2px solid var(--accent);color:var(--accent);cursor:pointer;font-weight:bold;">${n}</button>`);
    }
    overlay.innerHTML = `
      <div style="font-family:var(--font);font-size:10px;color:var(--accent);text-align:center;max-width:300px;padding:0 20px">${title}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;max-width:280px;">${buttons.join('')}</div>
      <button onclick="this.closest('div').remove();window._pickNumberVal=null"
        style="font-family:var(--font);font-size:8px;padding:6px 16px;background:var(--surface2);border:1px solid var(--muted);color:var(--muted);cursor:pointer;border-radius:4px;">Cancel</button>`;
    document.body.appendChild(overlay);
    const interval = setInterval(() => {
      if (window._pickNumberVal !== undefined) {
        clearInterval(interval);
        const v = window._pickNumberVal;
        window._pickNumberVal = undefined;
        resolve(v);
      }
    }, 50);
  });
}

// ══════════════════════════════════════════════════
// STATUS PARSING
// ══════════════════════════════════════════════════
// parseStatusEffects — defined in game-utils.js (loaded before this file)

function applyStatus(target, status) {
  target.status = status;
}

// ══════════════════════════════════════════════════
// ATTACK
// ══════════════════════════════════════════════════
// ══════════════════════════════════════════════════
// COIN-FLIP DAMAGE PARSING
// ══════════════════════════════════════════════════
// Returns { baseDmg, needsFlip } — baseDmg is the final resolved damage,
// needsFlip means we already resolved via coin flips inside this function.
async function resolveCoinFlipDamage(atk, energyCount, myActive, player) {
  const text = atk.text || '';
  const dmgStr = atk.damage || '0';
  const baseDmg = parseInt(dmgStr.replace(/[^0-9]/g, '')) || 0;

  // Pattern 1a: "Flip a coin until you get tails. This attack does N damage times the number of heads."
  // e.g. Stone Barrage (Geodude), Continuous Lick (Haunter)
  const untilTailsMatch = text.match(/flip a coin until you get tails/i);
  const untilTailsDmgMatch = text.match(/(\d+) damage times the number of heads/i);
  if (untilTailsMatch && (untilTailsDmgMatch || baseDmg > 0)) {
    const perFlip = untilTailsDmgMatch ? parseInt(untilTailsDmgMatch[1]) : baseDmg;
    let heads = 0;
    let flipNum = 0;
    while (true) {
      flipNum++;
      const result = await flipCoin(`${atk.name} — Heads = +${perFlip} dmg, keep flipping | Tails = stop`, { persistent: true, flipNum, totalFlips: flipNum });
      if (!result) { closeCoinOverlay(); break; }
      heads++;
    }
    addLog(`${atk.name}: ${heads} heads before tails — ${heads * perFlip} damage!`);
    return heads * perFlip;
  }

  // Pattern 1b: "Flip a coin for each [Type] Energy card attached...
  //              This attack does N damage times the number of heads."
  // e.g. Kingler Crabhammer
  const perEnergyMatch = text.match(/flip a coin for each [^\n.]*energy[^\n.]*/i);
  const timesHeadsMatch = text.match(/(\d+)\s*damage.*times the number of heads/i)
    || text.match(/times the number of heads.*?(\d+)\s*damage/i);
  if (perEnergyMatch && (timesHeadsMatch || baseDmg > 0)) {
    const perFlip = timesHeadsMatch ? parseInt(timesHeadsMatch[1]) : baseDmg;
    const numFlips = energyCount || 1;
    let heads = 0;
    for (let i = 0; i < numFlips; i++) {
      const result = await flipCoin(`${atk.name} (${perFlip} damage per heads)`, { persistent: i < numFlips - 1, flipNum: i + 1, totalFlips: numFlips });
      if (result) heads++;
    }
    if (numFlips > 1) closeCoinOverlay();
    addLog(`${atk.name}: ${heads} heads out of ${numFlips} flips — ${heads * perFlip} damage!`);
    return heads * perFlip;
  }

  // Pattern 2: "Flip N coins. This attack does X damage times the number of heads."
  // e.g. Slam, Doubleslap, Twineedle, Bonemerang, Comet Punch, Pin Missile, etc.
  // NOTE: uses [\s\S]*? (not [^.]*) so it crosses the sentence-boundary period.
  const flipNMatch = text.match(/flip (\d+|a) coin[s]?[\s\S]*?times the number of heads/i);
  const timesHeadsMatch2 = text.match(/does (\d+) damage times the number of heads/i);
  if (flipNMatch && timesHeadsMatch2) {
    const rawN = flipNMatch[1];
    const numFlips2 = rawN === 'a' ? 1 : parseInt(rawN);
    const perFlip2 = parseInt(timesHeadsMatch2[1]);
    let heads2 = 0;
    for (let i = 0; i < numFlips2; i++) {
      const result = await flipCoin(`${atk.name} (${perFlip2} damage per heads)`, { persistent: i < numFlips2 - 1, flipNum: i + 1, totalFlips: numFlips2 });
      if (result) heads2++;
    }
    if (numFlips2 > 1) closeCoinOverlay();
    addLog(`${atk.name}: ${heads2} heads out of ${numFlips2} flips — ${heads2 * perFlip2} damage!`);
    return heads2 * perFlip2;
  }

  // Pattern 3: "Flip a coin. If tails, this attack does nothing." / "If tails, no damage."
  const tailsNothingMatch = text.match(/flip a coin\. if tails[^.]*(?:does nothing|no damage|attack fails)/i);
  if (tailsNothingMatch && baseDmg > 0) {
    const heads = await flipCoin(`${atk.name}: Heads = ${baseDmg} damage, Tails = no damage`);
    if (!heads) {
      addLog(`${atk.name}: TAILS — no damage!`);
      return 0;
    }
    return baseDmg;
  }

  // Pattern 4: "Flip a coin. If heads, this attack does N more/extra damage."
  const headsMoreMatch = text.match(/if heads.*?(?:does )?(\d+) more damage/i)
    || text.match(/if heads.*?(\d+) additional damage/i);
  if (headsMoreMatch && baseDmg > 0) {
    const extra = parseInt(headsMoreMatch[1]);
    const heads = await flipCoin(`${atk.name}: Heads = ${baseDmg + extra} damage, Tails = ${baseDmg} damage`);
    if (heads) {
      addLog(`${atk.name}: HEADS — +${extra} bonus damage!`);
      return baseDmg + extra;
    }
    return baseDmg;
  }

  // Pattern 5: "Flip a coin. If heads, this attack does N damage instead of N2."
  const headsInsteadMatch = text.match(/if heads.*?does (\d+) damage instead/i);
  if (headsInsteadMatch) {
    const altDmg = parseInt(headsInsteadMatch[1]);
    const heads = await flipCoin(`${atk.name}: Heads = ${altDmg} damage, Tails = ${baseDmg} damage`);
    return heads ? altDmg : baseDmg;
  }

  // Pattern 6: "If tails, [Pokémon name] does N damage to itself."
  // e.g. Rapidash, Electrode, many others
  const selfDmgMatch = text.match(/if tails[^.]*does (\d+) damage to itself/i);
  if (selfDmgMatch && baseDmg > 0) {
    const selfDmg = parseInt(selfDmgMatch[1]);
    const heads = await flipCoin(`${atk.name}: Heads = no recoil, Tails = ${selfDmg} self-damage`);
    if (!heads) {
      // Apply self-damage now — KO check happens in caller
      // Defender on the attacker reduces recoil by 20
      let actualSelfDmg = selfDmg;
      if (myActive?.defender && actualSelfDmg > 0) {
        const reduced = Math.min(20, actualSelfDmg);
        actualSelfDmg = Math.max(0, actualSelfDmg - 20);
        addLog(`${atk.name}: TAILS — ${myActive.name} takes ${actualSelfDmg} recoil (Defender reduced by ${reduced})!`);
      } else {
        addLog(`${atk.name}: TAILS — ${myActive?.name || 'attacker'} takes ${actualSelfDmg} recoil!`);
      }
      if (myActive && actualSelfDmg > 0) myActive.damage = (myActive.damage || 0) + actualSelfDmg;
    }
    return baseDmg; // full damage to opponent regardless
  }

  // Pattern 7: "Flip a number of coins equal to [something]. Does N damage × heads."
  // Two variants:
  //   a) "equal to the number of Energy attached" → use energyCount (e.g. Big Eggsplosion)
  //   b) "equal to the number of damage counters"  → use opp damage / 10 (Chansey-style)
  const equalToMatch = text.match(/flip a number of coins equal to[^.]+/i);
  const timesHeadsMatch3 = text.match(/(\d+) damage.*times the number of heads/i);
  if (equalToMatch && timesHeadsMatch3) {
    const equalToText = equalToMatch[0].toLowerCase();
    const numFlips7 = /energy/i.test(equalToText)
      ? Math.max(1, energyCount)
      : Math.max(1, Math.floor(((G.players[player === 1 ? 2 : 1].active)?.damage || 0) / 10));
    const perFlip7 = parseInt(timesHeadsMatch3[1]);
    let heads7 = 0;
    for (let i = 0; i < numFlips7; i++) {
      const result = await flipCoin(`${atk.name} (${perFlip7} damage per heads)`, { persistent: i < numFlips7 - 1, flipNum: i + 1, totalFlips: numFlips7 });
      if (result) heads7++;
    }
    if (numFlips7 > 1) closeCoinOverlay();
    addLog(`${atk.name}: ${heads7} heads out of ${numFlips7} flips — ${heads7 * perFlip7} damage!`);
    return heads7 * perFlip7;
  }

  // No coin-flip damage pattern — return base damage unchanged (no flip needed)
  return null; // null = use normal damage pipeline
}


// ── computeFinalDamage ─────────────────────────────────────────────────────────
// ── applyPlusPower ───────────────────────────────────────────────────────────
// Applies PlusPower bonus from the active card and the legacy global, returns
// updated dmg. Separated so it's easy to test and reason about in isolation.
function applyPlusPower(dmg, myActive) {
  if (myActive?.plusPower) {
    dmg += myActive.plusPower;
    addLog(`PlusPower adds ${myActive.plusPower} damage!`);
    myActive.plusPower = 0;
  }
  if (G.plusPowerActive) {
    dmg += G.plusPowerActive;
    addLog(`PlusPower adds ${G.plusPowerActive} damage!`);
    G.plusPowerActive = 0;
  }
  return dmg;
}

// ── applyWeaknessResistance ───────────────────────────────────────────────────
// Applies weakness (×2) and resistance (−30) to dmg, returns updated dmg.
// Skipped if atk._skipWR is set. Logs each application.
function applyWeaknessResistance(dmg, atk, myActive, oppActive, dittoStats) {
  const attackerTypes = dittoStats?.types || myActive?.types || [];
  const weaknesses    = oppActive.weaknesses  || [];
  const resistances   = oppActive.resistances || [];
  if (!atk._skipWR) {
    for (const w of weaknesses) {
      if (attackerTypes.some(t => t.toLowerCase() === w.type.toLowerCase())) {
        dmg *= 2;
        addLog(`Weakness! Damage doubled to ${dmg}.`);
        break;
      }
    }
    for (const r of resistances) {
      if (attackerTypes.some(t => t.toLowerCase() === r.type.toLowerCase())) {
        dmg = Math.max(0, dmg - 30);
        addLog(`Resistance! Damage reduced to ${dmg}.`);
        break;
      }
    }
  } else {
    addLog(`${atk.name}: Weakness and Resistance ignored!`);
  }
  return dmg;
}

// ── applyDamageModifiers ──────────────────────────────────────────────────────
// Applies Kabuto Armor, Transparency, Defender/Invisible Wall/Pounce reductions
// in sequence. Returns { dmg, transparencyBlocked } so callers can skip
// post-attack status effects on a transparency block.
// This is async because Transparency requires a coin flip.
async function applyDamageModifiers(dmg, atk, player, myActive, oppActive) {
  // Kabuto Armor: halve damage (after W/R), rounded DOWN to nearest 10
  if (typeof isPowerActive === 'function' && isPowerActive(oppActive, 'Kabuto Armor') && dmg > 0) {
    const before = dmg;
    dmg = Math.floor(dmg / 20) * 10;
    addLog(`Kabuto Armor: damage halved to ${dmg}!`, true);
    showMoveFlash(player, myActive?.name || '?', atk.name, dmg, oppActive.name, `🛡 KABUTO ARMOR (${before}→${dmg})`);
  }

  // Transparency (Haunter): flip — heads = prevent all effects including damage
  let transparencyBlocked = false;
  if (typeof isPowerActive === 'function' && isPowerActive(oppActive, 'Transparency')) {
    const transpHeads = await flipCoin(`Transparency: Heads = prevent ALL effects on ${oppActive.name} (including damage)!`);
    if (transpHeads) {
      addLog(`Transparency: HEADS — all damage and attack effects prevented!`, true);
      showBlockedFlash(player, myActive?.name || '?', atk.name, `TRANSPARENCY — all effects prevented`);
      dmg = 0;
      transparencyBlocked = true;
    } else {
      addLog(`Transparency: TAILS — attack applies normally.`);
    }
  }

  if (!transparencyBlocked) {
    // Defender / Invisible Wall / Pounce (only if not already zeroed by Transparency)
    if (oppActive.defenderFull) {
      addLog(`${oppActive.name} is fully protected — all damage prevented!`);
      showBlockedFlash(player, myActive?.name || '?', atk.name, `${oppActive.name} FULLY PROTECTED`);
      dmg = 0;
    } else if (oppActive.defenderThreshold && dmg <= oppActive.defenderThreshold) {
      addLog(`${oppActive.name} is protected — ${dmg} damage is blocked (≤${oppActive.defenderThreshold} threshold)!`);
      showBlockedFlash(player, myActive?.name || '?', atk.name, `${oppActive.name} PROTECTED — damage blocked`);
      dmg = 0;
    } else if (hasInvisibleWall(oppActive) && dmg >= 30) {
      addLog(`${oppActive.name}'s Invisible Wall blocks ${dmg} damage!`, true);
      showBlockedFlash(player, myActive?.name || '?', atk.name, `INVISIBLE WALL — ${dmg} damage blocked`);
      dmg = 0;
    } else if (oppActive.defender) {
      dmg = Math.max(0, dmg - 20);
      addLog(`Defender reduces damage to ${dmg}.`);
    }

    // Pounce (Persian): reduce damage if defender used Pounce last turn
    if (oppActive.pounceActive && dmg > 0) {
      dmg = Math.max(0, dmg - 10);
      addLog(`Pounce: ${oppActive.name} reduces incoming damage by 10 (now ${dmg}).`);
    }
  }

  return { dmg, transparencyBlocked };
}

// ── computeFinalDamage ────────────────────────────────────────────────────────
// Orchestrates the full damage pipeline: PlusPower → W/R → modifiers →
// apply to oppActive → flash → log → checkKO → Strikes Back.
// Returns { dmg, done } — done=true means performAttack should return immediately.
async function computeFinalDamage(player, opp, atk, dmg, myActive, oppActive, attackerSelfKOd) {
  if (dmg > 0) {
    dmg = applyPlusPower(dmg, myActive);

    const dittoStats = (typeof getDittoTransformStats === 'function') ? getDittoTransformStats(player) : null;
    dmg = applyWeaknessResistance(dmg, atk, myActive, oppActive, dittoStats);

    const modResult = await applyDamageModifiers(dmg, atk, player, myActive, oppActive);
    dmg = modResult.dmg;
    if (modResult.transparencyBlocked) atk._transparencyBlocked = true;

    // Damage modifiers (Kabuto Armor, Transparency, Defender, Invisible Wall, Pounce)
    // have already been applied by applyDamageModifiers above.

    if (!modResult.transparencyBlocked) {
      oppActive.damage = (oppActive.damage || 0) + dmg;
      const oppHp = parseInt(oppActive.hp) || 0;
      if (typeof recordLastAttack === 'function') recordLastAttack(player, atk.name, dmg);

      // Flash shows final post-W/R damage with appropriate label
      const wrSuffix = (() => {
        const atkTypes = myActive?.types || [];
        const wasWeak   = (oppActive.weaknesses  || []).some(w => atkTypes.some(t => t.toLowerCase() === w.type.toLowerCase()));
        const wasResist = (oppActive.resistances || []).some(r => atkTypes.some(t => t.toLowerCase() === r.type.toLowerCase()));
        if (wasWeak)   return '⚡ WEAKNESS';
        if (wasResist) return '🛡 RESISTANCE';
        return '';
      })();
      showMoveFlash(player, myActive?.name || '?', atk.name, dmg, oppActive?.name || '?', wrSuffix);
      addLog(`P${player} used ${atk.name}! ${dmg} damage to ${oppActive.name} (${oppActive.damage}/${oppHp} HP).`, true);

      const koResult = checkKO(player, opp, oppActive, false);

      // ── Strikes Back (Machamp) ─────────────────────────────────
      // Whenever Machamp takes damage, deal 10 automatic damage to the attacker.
      // No coin flip. Not usable if Machamp is Asleep, Confused, or Paralyzed.
      if (dmg > 0 && isPowerActive(oppActive, 'Strikes Back') &&
          oppActive.status !== 'asleep' && oppActive.status !== 'confused' && oppActive.status !== 'paralyzed') {
        if (myActive) {
          myActive.damage = (myActive.damage || 0) + 10;
          addLog(`Strikes Back! (${oppActive.name}) — ${myActive.name} takes 10 damage! (${myActive.damage}/${myActive.hp} HP)`, true);
          showActionFlash(opp, 'STRIKES BACK', oppActive.name, `→ 10 damage to ${myActive.name}`);
          const strikeKo = checkKO(opp, player, myActive, false);
          if (strikeKo === 'win')     { renderWhenIdle(); return { dmg, done: true }; }
          if (strikeKo === 'promote') { renderWhenIdle(); return { dmg, done: true }; }
        }
      }

      if (koResult === 'win') {
        if (attackerSelfKOd && myActive) {
          addLog(`${myActive.name} was also knocked out by recoil!`, true);
          G.players[player].discard.push(myActive);
          G.players[player].active = null;
        }
        renderWhenIdle(); return { dmg, done: true };
      }
      if (koResult === 'promote') {
        if (attackerSelfKOd && myActive) {
          addLog(`${myActive.name} was also knocked out by recoil!`, true);
          G.players[player].discard.push(myActive);
          G.players[player].active = null;
        }
        renderWhenIdle(); return { dmg, done: true };
      }
    } // end if (!transparencyBlocked)
  } else {
    addLog(`P${player} used ${atk.name}!`, true);
    if (typeof recordLastAttack === 'function') recordLastAttack(player, atk.name, 0);
  }
  return { dmg, done: false };
}

// ── applyPostAttackTextEffects ──────────────────────────────────────────────────
// Handles text-parsed attack effects that fire AFTER damage:
// draw, self-heal, energy discard, protection moves (Withdraw/Harden/Agility/
// Minimize), Smokescreen, Leer, Growl, Disable, partial heal, deck search,
// status application, and attacker self-KO resolution.
//
// Returns true if it handled turn-end (caller should return), else undefined.
async function applyPostAttackTextEffects(player, opp, atk, myActive, oppActive, attackerSelfKOd) {
  // ── Draw a card: "Draw a card." (Kangaskhan Fetch, etc.) ──
  if (/draw a card/i.test(atk.text || '')) {
    drawCard(player, true);
    addLog(`${atk.name}: ${myActive?.name || 'attacker'} drew a card.`, true);
  }

  // ── Draw N cards: "Draw N cards." ──
  const drawNMatch = (atk.text || '').match(/draw (\d+) cards?/i);
  if (drawNMatch) {
    const n = parseInt(drawNMatch[1]);
    for (let i = 0; i < n; i++) drawCard(player, true);
    addLog(`${atk.name}: drew ${n} card(s).`, true);
  }

  // ── Self-heal effect: "Remove all damage counters from [Pokémon]" ──
  const healAllMatch = (atk.text || '').match(/remove all damage counters from/i);
  if (healAllMatch && myActive) {
    myActive.damage = 0;
    addLog(`${myActive.name} removed all damage counters!`, true);
  }

  // ── Attack energy cost discard: energy that must be discarded to use the attack ──
  // Covers: "in order to use this attack" (Charizard Fire Spin) AND
  //         "in order to [do/prevent]..." (Mewtwo Barrier, Arcanine Flamethrower, etc.)
  const discardCostMatch = (atk.text || '').match(
    /discard (all|\d+|an?)\s+(?:\S+ )?energy card[s]?\s+attached[^.]*in order to/i
  );
  if (discardCostMatch && myActive) {
    const rawN = discardCostMatch[1].toLowerCase();
    const discarded = rawN === 'all'
      ? myActive.attachedEnergy.splice(0)
      : myActive.attachedEnergy.splice(0, /^\d+$/.test(rawN) ? parseInt(rawN) : 1);
    G.players[player].discard.push(...discarded);
    addLog(`${myActive.name} discarded ${discarded.length} energy for ${atk.name}.`);
  }


  // ── Coin-flip self-protection (Withdraw-style): "Flip a coin. If heads, prevent all damage" ──
  const _hasSelfProtectPostAttack = !!(typeof MOVE_EFFECTS !== 'undefined' && MOVE_EFFECTS[atk.name]?.postAttack);
  const selfProtectMatch = !_hasSelfProtectPostAttack && (atk.text || '').match(
    /flip a coin[^.]*\.\s*if heads[^.]*prevent all damage done to/i
  );
  if (selfProtectMatch && myActive) {
    const heads = await flipCoin(`${atk.name}: Heads = prevent all damage next turn, Tails = no effect`);
    if (heads) {
      myActive.defender = true;
      myActive.defenderFull = true;
      addLog(`${atk.name}: HEADS — ${myActive.name} is protected from all damage until end of opponent's next turn!`, true);
    } else {
      addLog(`${atk.name}: TAILS — no protection.`);
    }
  }

  // ── Threshold self-protection (Harden-style): "whenever N or less damage is done... prevent that damage" ──
  const hardenMatch = (atk.text || '').match(/whenever (\d+) or less damage is done[^,]*,?\s*prevent that damage/i);
  if (hardenMatch && myActive) {
    const threshold = parseInt(hardenMatch[1]);
    myActive.defender = true;
    myActive.defenderThreshold = threshold;
    addLog(`${atk.name}: ${myActive.name} will block any attack doing ${threshold} or less damage next turn!`, true);
  }


  // ── Minimize / "damage reduced by 20 during opponent's next turn" ──
  // e.g. Grimer Minimize: "All damage done to Grimer during your opponent's next turn is reduced by 20"
  // Same mechanical outcome as Defender card: sets defender flag on self
  const minimizeMatch = (atk.text || '').match(/damage done to .+ during your opponent.s next turn is reduced by 20/i)
    || (atk.text || '').match(/all damage.+reduced by 20.+opponent.s next turn/i);
  if (minimizeMatch && myActive) {
    myActive.defender = true;
    addLog(`${atk.name}: ${myActive.name} will take 20 less damage next turn!`, true);
  }

  // ── "Damage reduced by 10" variant (Sharpen, etc.) ──
  const reducedBy10Match = (atk.text || '').match(/damage.+reduced by 10.+opponent.s next turn/i)
    || (atk.text || '').match(/opponent.s next turn.+reduced by 10/i);
  if (reducedBy10Match && myActive && !minimizeMatch) {
    myActive.defenderThreshold = myActive.defenderThreshold
      ? myActive.defenderThreshold : 0;
    // Use a custom flat reduction stored as negative threshold
    myActive.defender = true;
    myActive.defenderReduction = 10;
    addLog(`${atk.name}: ${myActive.name} will take 10 less damage next turn!`, true);
  }

  // ── Agility-style: "Flip a coin. If heads, prevent all effects of attacks done to [Pokémon]" ──
  // Guard: skip generic flip if MOVE_EFFECTS already handles it via postAttack (e.g. Raichu's Agility)
  const _hasAgilityPostAttack = !!(typeof MOVE_EFFECTS !== 'undefined' && MOVE_EFFECTS[atk.name]?.postAttack)
    || /^agility$/i.test(atk.name);
  const agilityMatch = !_hasAgilityPostAttack && (atk.text || '').match(/flip a coin\. if heads[^.]*prevent all effects of attacks[^.]*done to/i);
  if (agilityMatch && myActive) {
    const heads = await flipCoin(`${atk.name}: Heads = immune to all attack effects next turn, Tails = no effect`);
    if (heads) {
      myActive.defender = true;
      myActive.defenderFull = true;
      addLog(`${atk.name}: HEADS — ${myActive.name} is fully protected from all attack effects next turn!`, true);
    } else {
      addLog(`${atk.name}: TAILS — no protection.`);
    }
  }

  // ── Smokescreen / Sand Attack: "If Defending Pokémon tries to attack next turn, flip coin; tails = does nothing" ──
  const smokescreenMatch = (atk.text || '').match(/if the defending pok[eé]mon tries to attack next turn[^.]*flip a coin[^.]*tails[^.]*does nothing/i)
    || (atk.text || '').match(/defending pok[eé]mon.+attack next turn.+tails.+does nothing/i);
  if (smokescreenMatch && oppActive) {
    oppActive.smokescreened = true;
    addLog(`${atk.name}: ${oppActive.name} must flip before attacking next turn — tails = no attack!`, true);
  }

  // ── Leer / "The Defending Pokémon can't retreat during your opponent's next turn" ──
  const leerMatch = (atk.text || '').match(/defending pok[eé]mon can.t retreat/i);
  if (leerMatch && oppActive) {
    oppActive.cantRetreat = true;
    addLog(`${atk.name}: ${oppActive.name} cannot retreat next turn!`, true);
  }

  // ── Tail Whip / Growl / "Defending Pokémon's attacks do N less damage" ──
  const growlMatch = (atk.text || '').match(/defending pok[eé]mon.s attacks do (\d+) less damage/i);
  if (growlMatch && oppActive) {
    const reduction = parseInt(growlMatch[1]);
    oppActive.attackReduction = (oppActive.attackReduction || 0) + reduction;
    addLog(`${atk.name}: ${oppActive.name}'s attacks do ${reduction} less damage next turn!`, true);
  }

  // ── Disable: "Choose 1 of the Defending Pokémon's attacks. That Pokémon can't use that attack next turn" ──
  const disableMatch = (atk.text || '').match(/defending pok[eé]mon.s attacks[^.]*can.t use that attack/i)
    || (atk.text || '').match(/choose 1 of the defending.+can.t use/i);
  if (disableMatch && oppActive?.attacks?.length) {
    if (oppActive.attacks.length === 1) {
      oppActive.disabledAttack = oppActive.attacks[0].name;
      addLog(`${atk.name}: ${oppActive.name}'s ${oppActive.disabledAttack} is disabled next turn!`, true);
    } else {
      const choice = await openCardPicker({
        title: `${atk.name} — Disable`,
        subtitle: `Choose an attack to disable on ${oppActive.name}`,
        cards: oppActive.attacks.map(a => ({ name: a.name, images: oppActive.images })),
        maxSelect: 1
      });
      if (choice && choice.length) {
        oppActive.disabledAttack = oppActive.attacks[choice[0]].name;
        addLog(`${atk.name}: ${oppActive.name}'s ${oppActive.disabledAttack} is disabled next turn!`, true);
      }
    }
  }

  // ── "Remove N damage counters from [Pokémon]" (partial heal) ──
  const removeNMatch = (atk.text || '').match(/remove (\d+) damage counters? from/i);
  if (removeNMatch && myActive) {
    const counters = parseInt(removeNMatch[1]);
    const healed = Math.min(myActive.damage || 0, counters * 10);
    myActive.damage = Math.max(0, (myActive.damage || 0) - healed);
    addLog(`${atk.name}: removed ${counters} damage counter(s) from ${myActive.name}.`, true);
  }

  // ── "Search your deck for a [Type] card and put it into your hand" ──
  const searchDeckMatch = (atk.text || '').match(/search your deck for (?:a |an |up to \d+ )?(\w+) card[s]?[^.]*put (?:it|them) into your hand/i);
  if (searchDeckMatch) {
    const typeFilter = searchDeckMatch[1].toLowerCase();
    let candidates = G.players[player].deck.filter(c => {
      if (/trainer/i.test(typeFilter)) return c.supertype === 'Trainer';
      if (/pok[eé]mon/i.test(typeFilter)) return c.supertype === 'Pokémon';
      if (/energy/i.test(typeFilter)) return c.supertype === 'Energy';
      return true; // "any" card
    });
    if (candidates.length) {
      const picked = await openCardPicker({
        title: `${atk.name} — Search Deck`,
        subtitle: `Choose a card to take into your hand`,
        cards: candidates,
        maxSelect: 1
      });
      if (picked && picked.length) {
        const found = candidates[picked[0]];
        const di = G.players[player].deck.findIndex(c => c === found);
        if (di !== -1) {
          G.players[player].hand.push(...G.players[player].deck.splice(di, 1));
          G.players[player].deck = shuffle(G.players[player].deck);
          addLog(`${atk.name}: ${myActive?.name} searched deck and found ${found.name}.`, true);
        }
      }
    } else {
      addLog(`${atk.name}: no matching cards in deck.`);
    }
  }

  // Parse and apply status effects — skip if the dispatch table already handled them,
  // or if Transparency blocked all effects this attack.
  const _handledByDispatch = typeof applyMoveEffects === 'function' &&
    typeof MOVE_EFFECTS !== 'undefined' && !!MOVE_EFFECTS[atk.name];
  const effects = (_handledByDispatch || atk._transparencyBlocked) ? [] : parseStatusEffects(atk.text || '');
  for (const eff of effects) {
    const target = eff.self ? myActive : oppActive;
    if (!target) continue;

    // If resolveCoinFlipDamage already handled this attack's coin flip,
    // skip any status effects that require their own coin flip (they would be double-flipping
    // the same flip that already determined damage). Unconditional status effects still apply.
    if (atk._coinFlipHandled && (eff.coinRequired || eff.type === 'either')) continue;

    // Don't apply status effects if the game ended (opponent was KO'd)
    if (!G.started) continue;

    // "either" type: single flip, heads=one status, tails=another
    if (eff.type === 'either') {
      const headsName = eff.heads.charAt(0).toUpperCase() + eff.heads.slice(1);
      const tailsName = eff.tails.charAt(0).toUpperCase() + eff.tails.slice(1);
      const flip = await flipCoin(`${atk.name}: Heads = ${headsName}, Tails = ${tailsName}`);
      const appliedStatus = flip ? eff.heads : eff.tails;
      const appliedName = flip ? headsName : tailsName;
      tryApplyStatus(target, appliedStatus);
      addLog(`Coin flip: ${flip ? 'HEADS' : 'TAILS'} — ${target.name} is now ${appliedName}!`, true);
    } else if (eff.coinRequired) {
      const statusName = eff.status.charAt(0).toUpperCase() + eff.status.slice(1);
      const flip = await flipCoin(`${atk.name}: flip for ${statusName}!\n${eff.onTails ? 'Tails' : 'Heads'} = ${statusName}`);
      const shouldApply = eff.onTails ? !flip : flip;
      if (shouldApply) {
        tryApplyStatus(target, eff.status);
        addLog(`${target.name} is now ${statusName}!`, true);
      } else {
        addLog(`Coin flip: no ${statusName}.`);
      }
    } else {
      const statusName = eff.status.charAt(0).toUpperCase() + eff.status.slice(1);
      tryApplyStatus(target, eff.status);
      addLog(`${target.name} is now ${statusName}!`, true);
    }
  }

  // Check if attacker KO'd itself (e.g. Selfdestruct, Explosion recoil)
  if (attackerSelfKOd && myActive) {
    addLog(`${myActive.name} was knocked out by its own attack!`, true);
    G.players[player].discard.push(myActive);
    G.players[player].active = null;
    const myBenchLeft = G.players[player].bench.filter(s => s !== null);
    if (myBenchLeft.length === 0) {
      G.started = false;
      showWinScreen(opp, `${myActive.name} KNOCKED ITSELF OUT`);
      if (typeof pushGameState === 'function') pushGameState();
      renderWhenIdle(); return true;
    } else if (myBenchLeft.length === 1) {
      const idx = G.players[player].bench.findIndex(s => s !== null);
      G.players[player].active = G.players[player].bench[idx];
      G.players[player].bench[idx] = null;
      addLog(`${G.players[player].active.name} was automatically moved to Active!`, true);
      // Fall through to renderAll/endTurn below
    } else {
      transitionPhase('PROMOTE', { pendingPromotion: player });
      _flashQueue.length = 0; _flashBusy = false;
      for (let i = 0; i < 5; i++) {
        if (G.players[player].bench[i]) {
          document.getElementById(`bench-p${player}-${i}`)?.classList.add('highlight');
        }
      }
      setMidline(`Player ${player}: choose a bench Pokémon to promote to Active!`);
      showPromoteBanner(player);
      addLog(`Player ${player} must choose a new Active Pokémon.`, true);
      renderWhenIdle(); return true; // done — endTurn fires inside resolvePromotion
    }
  }

}

async function performAttack(player, atk) {
  const opp = player === 1 ? 2 : 1;
  const myActive = G.players[player].active;
  const oppActive = G.players[opp].active;
  if (!oppActive) { showToast('No opponent Active Pokémon to attack!', true); return; }

  // ── Status guards ────────────────────────────────────────────────────────────
  if (myActive?.status === 'paralyzed') {
    addLog(`${myActive.name} is Paralyzed and cannot attack!`, true);
    showToast(`${myActive.name} is Paralyzed!`, true);
    showBlockedFlash(player, myActive.name, atk.name, 'PARALYZED — cannot attack');
    return;
  }
  if (myActive?.status === 'asleep') {
    addLog(`${myActive.name} is Asleep and cannot attack!`, true);
    showToast(`${myActive.name} is Asleep!`, true);
    showBlockedFlash(player, myActive.name, atk.name, 'ASLEEP — cannot attack');
    return;
  }

  // ── Confusion check ──────────────────────────────────────────────────────────
  if (myActive?.status === 'confused') {
    addLog(`${myActive.name} is Confused — flipping coin...`);
    const confusionHeads = await flipCoin(`${myActive.name} is Confused!\nHeads = attack normally, Tails = hurt itself`);
    addLog(`Coin flip: ${confusionHeads ? 'HEADS — attacks normally!' : 'TAILS — hurt itself for 30!'}`);
    if (!confusionHeads) {
      myActive.damage = (myActive.damage || 0) + 30;
      addLog(`${myActive.name} hurt itself for 30 damage in confusion! (${myActive.damage}/${myActive.hp} HP)`, true);
      const selfKoResult = checkKO(player, opp, myActive, true);
      renderAll();
      if (!G.started || selfKoResult === 'win') return;
      if (selfKoResult === 'promote') return;
      endTurn();
      return;
    }
  }

  // ── Opponent full-effect immunity (Agility/Barrier heads, Tail Wag heads) ────
  // defenderFull alone (Withdraw/Stiffen) only blocks damage — attack still proceeds
  if (oppActive?.defenderFullEffects) {
    addLog(`${oppActive.name} is fully protected — ${myActive?.name}'s attack has no effect!`, true);
    showToast(`${oppActive.name} is protected!`, true);
    showBlockedFlash(player, myActive?.name || '?', atk.name, `${oppActive.name} FULLY PROTECTED`);
    endTurn();
    return;
  }
  if (oppActive?.immuneToAttack) {
    addLog(`${oppActive.name} cannot be attacked this turn!`, true);
    showToast(`${oppActive.name} cannot be attacked!`, true);
    showBlockedFlash(player, myActive?.name || '?', atk.name, `${oppActive.name} IMMUNE TO ATTACK`);
    endTurn();
    return;
  }

  // ── Smokescreen ──────────────────────────────────────────────────────────────
  if (myActive?.smokescreened) {
    const smokeHeads = await flipCoin(`${myActive.name} is Smokescreened! Heads = attack normally, Tails = attack fails`);
    if (!smokeHeads) {
      addLog(`${myActive.name}'s attack was blocked by Smokescreen! (TAILS)`, true);
      showBlockedFlash(player, myActive.name, atk.name, 'SMOKESCREENED — attack failed');
      myActive.smokescreened = false;
      renderAll();
      endTurn();
      return;
    }
    addLog(`${myActive.name} broke through the Smokescreen! (HEADS)`, true);
    myActive.smokescreened = false;
  }

  // ── Pre-attack hook (move-effects.js) ───────────────────────────────────────
  if (typeof preAttackChecks === 'function') {
    const preResult = await preAttackChecks(player, atk, myActive, oppActive);
    if (preResult === 'block') {
      showBlockedFlash(player, myActive?.name || '?', atk.name, 'BLOCKED — attack failed');
      renderAll(); endTurn(); return;
    }
  }

  // ── Base damage + coin-flip resolution ──────────────────────────────────────
  let dmg = parseInt((atk.damage || '0').replace(/[^0-9]/g, '')) || 0;

  // "Next attack does double damage" self-buff (e.g. Swords Dance)
  const _hasDoublePostAttack = !!(typeof MOVE_EFFECTS !== 'undefined' && MOVE_EFFECTS[atk.name]?.postAttack);
  const doubleNextMatch = !_hasDoublePostAttack && (
    (atk.text || '').match(/next turn[^.]*does double(?:\s+the)?\s+damage/i)
    || (atk.text || '').match(/does double(?:\s+the)?\s+damage[^.]*next turn/i)
    || (atk.text || '').match(/double(?:\s+the)?\s+damage[^.]*next turn/i)
    || /^swords dance$/i.test(atk.name || ''));
  if (doubleNextMatch && myActive && dmg === 0) {
    myActive.nextAttackDouble = true;
    addLog(`${atk.name}: ${myActive.name}'s next attack will do double damage!`, true);
  }

  const _hasModifyDamage = typeof MOVE_EFFECTS !== 'undefined' && !!MOVE_EFFECTS[atk.name]?.modifyDamage;
  const energyCount = (myActive?.attachedEnergy || []).length;
  const coinDmg = _hasModifyDamage ? null : await resolveCoinFlipDamage(atk, energyCount, myActive, player);
  if (coinDmg !== null) {
    dmg = coinDmg;
    atk._coinFlipHandled = true; // signal that a flip already resolved this attack's main coin
  }

  // Pre-damage modifications (move-effects.js: Karate Chop, Flail, Rage, etc.)
  if (typeof preDamageModify === 'function') {
    dmg = await preDamageModify(player, atk, dmg, myActive, oppActive);
  }

  // Swords Dance doubling — after coin flip
  if (myActive?.nextAttackDouble && dmg > 0) {
    dmg *= 2;
    myActive.nextAttackDouble = false;
    addLog(`${myActive.name}'s Swords Dance doubles ${atk.name}'s damage to ${dmg}!`, true);
  } else if (myActive?.nextAttackDouble && dmg === 0 && coinDmg !== null) {
    myActive.nextAttackDouble = false;
    addLog(`${myActive.name}'s Swords Dance buff wasted — ${atk.name} did no damage (tails).`);
  }

  // Extra-energy bonus damage (beyond-first variant)
  const extraEnergyMatch = (atk.text || '').match(
    /does? (\d+) (?:more|extra|additional) damage for each (?:extra )?(\w+) energy[^.]*beyond the first/i
  );
  if (extraEnergyMatch) {
    const bonusPerEnergy = parseInt(extraEnergyMatch[1]);
    const requiredType   = extraEnergyMatch[2];
    const typeEnergies   = (myActive?.attachedEnergy || []).filter(e =>
      new RegExp(requiredType, 'i').test(e.name)
    );
    const extras = Math.max(0, typeEnergies.length - 1);
    if (extras > 0) {
      dmg += extras * bonusPerEnergy;
      addLog(`${atk.name}: +${extras * bonusPerEnergy} bonus damage (${extras} extra ${requiredType} Energy).`);
    }
  }

  // Extra-energy bonus (simple variant — no "beyond first")
  const extraEnergySimple = !extraEnergyMatch && (atk.text || '').match(
    /does? (\d+) (?:more|extra|additional) damage for each (\w+) energy attached/i
  );
  if (extraEnergySimple) {
    const bonusPerEnergy = parseInt(extraEnergySimple[1]);
    const requiredType   = extraEnergySimple[2];
    const typeEnergies   = (myActive?.attachedEnergy || []).filter(e =>
      new RegExp(requiredType, 'i').test(e.name)
    );
    if (typeEnergies.length > 0) {
      dmg += typeEnergies.length * bonusPerEnergy;
      addLog(`${atk.name}: +${typeEnergies.length * bonusPerEnergy} bonus damage (${typeEnergies.length} ${requiredType} Energy).`);
    }
  }

  // Bench splash damage (Selfdestruct, Explosion)
  const benchSplashMatch = (atk.text || '').match(/does (\d+) damage to each pok[eé]mon on each player[''s]* bench/i);
  if (benchSplashMatch) {
    const splashDmg = parseInt(benchSplashMatch[1]);
    for (const pNum of [1, 2]) {
      const pObj = G.players[pNum];
      for (let i = 0; i < pObj.bench.length; i++) {
        const b = pObj.bench[i];
        if (!b) continue;
        b.damage = (b.damage || 0) + splashDmg;
        addLog(`${b.name} (P${pNum} bench) took ${splashDmg} splash damage! (${b.damage}/${b.hp} HP)`);
        const bHp = parseInt(b.hp) || 0;
        if (bHp > 0 && b.damage >= bHp) {
          addLog(`${b.name} was knocked out by splash damage!`, true);
          pObj.discard.push(b);
          pObj.bench[i] = null;
        }
      }
    }
  }

  // RAM (Rhydon) — force opponent switch before self-damage
  if (/rhydon does 20 damage to itself.*switch/i.test(atk.text || '') || /switch.*even if rhydon is knocked out/i.test(atk.text || '')) {
    const ramOppBench = G.players[opp].bench.map((s, i) => ({ s, i })).filter(x => x.s !== null);
    if (ramOppBench.length && typeof forceOpponentSwitch === 'function') {
      await forceOpponentSwitch(opp, false, atk.name);
    }
  }

  // Unconditional self-damage (Selfdestruct/Explosion — not coin-gated)
  const selfDmgTextMatch = (atk.text || '').match(/\w+ does (\d+) damage to itself/i);
  const isCoinGatedRecoil = /if tails[^.]*does \d+ damage to itself/i.test(atk.text || '');
  let attackerSelfKOd = false;
  if (selfDmgTextMatch && !isCoinGatedRecoil && myActive) {
    let selfDmg = parseInt(selfDmgTextMatch[1]);
    if (myActive.defender && selfDmg > 0) {
      const reduced = Math.min(20, selfDmg);
      selfDmg = Math.max(0, selfDmg - 20);
      addLog(`Defender reduces ${myActive.name}'s recoil by ${reduced} (${selfDmg} self-damage).`);
    }
    if (selfDmg > 0) {
      myActive.damage = (myActive.damage || 0) + selfDmg;
      addLog(`${myActive.name} took ${selfDmg} recoil damage! (${myActive.damage}/${myActive.hp} HP)`);
    }
    let myHp = parseInt(myActive.hp) || 0;
    if (myHp === 0 && myActive.id && typeof CARD_DATA !== 'undefined') {
      myHp = parseInt(CARD_DATA[myActive.id]?.hp) || 0;
    }
    if (myHp > 0 && myActive.damage >= myHp) attackerSelfKOd = true;
  }

  // Bench-targeting attacks (e.g. Hitmonlee Stretch Kick)
  const benchTargetMatch = (atk.text || '').match(
    /does (\d+) damage to (?:1 of )?(?:your )?opponent[''s]* benched pok[eé]mon/i
  );
  if (benchTargetMatch) {
    const benchDmg = parseInt(benchTargetMatch[1]);
    const oppBench = G.players[opp].bench.map((s, i) => ({ s, i })).filter(x => x.s !== null);
    if (!oppBench.length) {
      addLog(`${atk.name}: opponent has no Benched Pokémon to target!`);
    } else if (oppBench.length === 1) {
      const target = oppBench[0].s;
      target.damage = (target.damage || 0) + benchDmg;
      showMoveFlash(player, myActive?.name || '?', atk.name, benchDmg, target.name, '(bench)');
      addLog(`${atk.name}: ${benchDmg} damage to ${target.name} on opponent's bench! (${target.damage}/${target.hp} HP)`, true);
      const tHp = parseInt(target.hp) || 0;
      if (tHp > 0 && target.damage >= tHp) {
        addLog(`${target.name} was knocked out!`, true);
        G.players[opp].discard.push(target);
        G.players[opp].bench[oppBench[0].i] = null;
      }
    } else {
      const picked = await openCardPicker({
        title: atk.name,
        subtitle: "Choose an opponent's Benched Pokémon to deal damage to",
        cards: oppBench.map(x => x.s),
        maxSelect: 1
      });
      if (picked && picked.length) {
        const { s: target, i: slotIdx } = oppBench[picked[0]];
        target.damage = (target.damage || 0) + benchDmg;
        showMoveFlash(player, myActive?.name || '?', atk.name, benchDmg, target.name, '(bench)');
        addLog(`${atk.name}: ${benchDmg} damage to ${target.name} on opponent's bench! (${target.damage}/${target.hp} HP)`, true);
        const tHp = parseInt(target.hp) || 0;
        if (tHp > 0 && target.damage >= tHp) {
          addLog(`${target.name} was knocked out!`, true);
          G.players[opp].discard.push(target);
          G.players[opp].bench[slotIdx] = null;
        }
      }
    }
    dmg = 0;
  }

  // ── Apply damage: W/R, power mods, KO check ─────────────────────────────────
  const dmgResult = await computeFinalDamage(player, opp, atk, dmg, myActive, oppActive, attackerSelfKOd);
  if (dmgResult.done) return;
  dmg = dmgResult.dmg;
  const _dmgDealt = dmg;

  // ── Post-attack text effects (draw, protect, status, self-KO) ───────────────
  const postDone = await applyPostAttackTextEffects(player, opp, atk, myActive, oppActive, attackerSelfKOd);
  if (postDone) return;

  // ── Special move effects dispatch (move-effects.js) ─────────────────────────
  if (typeof applyMoveEffects === 'function' && G.started) {
    const currentOpp = G.players[opp].active;
    const effectBlocked = await applyMoveEffects(player, atk, _dmgDealt, myActive, currentOpp);
    if (effectBlocked === true) return;
  }

  // Attack always ends the turn
  renderWhenIdle();
  _flashQueue.push({ fn: () => endTurn(), duration: 0 });
  _runFlashQueue();
}

function checkKO(attackingPlayer, defendingPlayer, card, isSelf) {
  // Resolve HP: prefer card.hp, fall back to CARD_DATA lookup, then enrichCard full data
  let hp = parseInt(card.hp) || 0;
  if (hp === 0 && card.id) {
    const full = CARD_DATA[card.id];
    hp = parseInt(full?.hp) || 0;
    if (hp > 0) console.warn(`checkKO: card.hp missing for ${card.name}, used CARD_DATA fallback (${hp})`);
  }
  if (hp === 0) console.warn(`checkKO: could not resolve HP for ${card.name} (id: ${card.id}) — KO check skipped`);
  if (hp > 0 && (card.damage || 0) >= hp) {
    addLog(`${card.name} is knocked out!`, true);
    const owner = isSelf ? attackingPlayer : defendingPlayer;
    const prizeWinner = isSelf ? defendingPlayer : attackingPlayer;

    // Destiny Bond — if the KO'd card had it, KO the attacker too
    if (!isSelf && card.destinyBond && typeof checkDestinyBond === 'function') {
      checkDestinyBond(card, attackingPlayer);
    }

    G.players[owner].discard.push(card);
    // Also discard any previous evolution stages stored under this card
    if (card.prevStages && card.prevStages.length) {
      G.players[owner].discard.push(...card.prevStages);
    }
    // Discard attached energy
    G.players[owner].active = null;
    // Defensive pad — bench must always be exactly 5 slots
    while (G.players[owner].bench.length < 5) G.players[owner].bench.push(null);

    // Clefairy Doll KO — no prize, no win check
    if (card.isDoll) {
      addLog(`Clefairy Doll was discarded — no prize awarded.`);
      const dollBench = G.players[owner].bench.filter(s => s !== null);
      if (dollBench.length === 1) {
        const idx = G.players[owner].bench.findIndex(s => s !== null);
        G.players[owner].active = G.players[owner].bench[idx];
        G.players[owner].bench[idx] = null;
        addLog(`${G.players[owner].active.name} was automatically moved to Active!`, true);
      } else if (dollBench.length > 1) {
        transitionPhase('PROMOTE', { pendingPromotion: owner });
        for (let i = 0; i < 5; i++) {
          if (G.players[owner].bench[i]) document.getElementById(`bench-p${owner}-${i}`)?.classList.add('highlight');
        }
        setMidline(`Player ${owner}: choose a bench Pokémon to promote to Active!`);
        showPromoteBanner(owner);
        if (typeof pushGameState === 'function') pushGameState();
        return 'promote';
      }
      return 'ko';
    }

    // Award a prize card to the attacker
    const prizeIdx = G.players[prizeWinner].prizes.findIndex(p => p);
    if (prizeIdx !== -1) {
      const prizeCard = G.players[prizeWinner].prizes[prizeIdx];
      G.players[prizeWinner].hand.push(prizeCard.card);
      G.players[prizeWinner].prizes[prizeIdx] = null;
      const remaining = G.players[prizeWinner].prizes.filter(p => p).length;
      addLog(`P${prizeWinner} took a prize! (${remaining} remaining)`, true);
      if (remaining === 0) {
        addLog(`Player ${prizeWinner} has taken all prizes — they win!`, true);
        G.started = false;
        showWinScreen(prizeWinner, 'ALL 6 PRIZES TAKEN');
        if (typeof pushGameState === 'function') pushGameState();
        return 'win';
      }
    }

    // Win by knocking out opponent's last Pokémon
    const benchLeft = G.players[owner].bench.filter(s => s !== null);
    if (benchLeft.length === 0) {
      addLog(`Player ${owner} has no Pokémon left — Player ${prizeWinner} wins!`, true);
      G.started = false;
      showWinScreen(prizeWinner, 'OPPONENT HAS NO POKÉMON LEFT');
      if (typeof pushGameState === 'function') pushGameState();
      return 'win';
    }

    // Always show the promote banner — even with one bench Pokémon the player must confirm
    transitionPhase('PROMOTE', { pendingPromotion: owner });
    _flashQueue.length = 0; _flashBusy = false; // clear pending flashes
    // Highlight available bench slots for the KO'd player
    for (let i = 0; i < 5; i++) {
      if (G.players[owner].bench[i]) {
        document.getElementById(`bench-p${owner}-${i}`)?.classList.add('highlight');
      }
    }
    setMidline(`Player ${owner}: choose a bench Pokémon to promote to Active!`);
    showPromoteBanner(owner);
    addLog(`Player ${owner} must choose a new Active Pokémon.`, true);
    if (typeof pushGameState === 'function') pushGameState();
    return 'promote';
  }
  return false;
}

function resolvePromotion(player, benchIdx) {
  if (G.phase !== 'PROMOTE' || G.pendingPromotion !== player) return;
  const p = G.players[player];
  const chosen = p.bench[benchIdx];
  if (!chosen) return;
  p.active = chosen;
  p.bench[benchIdx] = null;
  // Ensure bench is always exactly 5 slots — defensive pad after any swap
  while (p.bench.length < 5) p.bench.push(null);
  transitionPhase('MAIN');
  // Clear Mirror Move tracking — new active didn't see last attack
  if (typeof clearLastAttack === 'function') clearLastAttack(player);
  addLog(`Player ${player} promoted ${chosen.name} to Active!`, true);
  showActionFlash(player, 'PROMOTES', chosen.name, 'TO ACTIVE');
  hidePromoteBanner();
  clearHighlights();
  renderAll();
  // Push state before endTurn so the cleared PROMOTE phase reaches both clients
  // (endTurn's push only fires when myRole === G.turn, but the promoting player
  // may not be the current turn player in multiplayer)
  if (typeof pushGameState === 'function') pushGameState();
  endTurn();
}

// ══════════════════════════════════════════════════
// TURN MANAGEMENT (with status effects between turns)
// ══════════════════════════════════════════════════
function endTurn() {
  if (!G.started) return;
  if (G.phase === 'PROMOTE') {
    showToast(`Player ${G.pendingPromotion} must choose a new Active first!`, true);
    return;
  }
  // Safety: if any player has no active but still has bench Pokémon, they must promote first
  for (const pNum of [1, 2]) {
    if (!G.players[pNum].active && G.players[pNum].bench.some(s => s !== null)) {
      transitionPhase('PROMOTE', { pendingPromotion: pNum });
      _flashQueue.length = 0; _flashBusy = false;
      for (let i = 0; i < 5; i++) {
        if (G.players[pNum].bench[i]) {
          document.getElementById(`bench-p${pNum}-${i}`)?.classList.add('highlight');
        }
      }
      setMidline(`Player ${pNum}: choose a bench Pokémon to promote to Active!`);
      showPromoteBanner(pNum);
      addLog(`Player ${pNum} must choose a new Active Pokémon.`, true);
      renderAll();
      return;
    }
  }
  const prev = G.turn;

  // Apply between-turn status effects to ALL active Pokémon (both players)
  // Poison and Burn tick once per turn boundary regardless of whose turn it was
  for (const pNum of [1, 2]) {
    const active = G.players[pNum].active;
    const oppNum = pNum === 1 ? 2 : 1;
    if (!active) continue;

    if (active.status === 'poisoned' || active.status === 'poisoned-toxic') {
      const dmg = active.status === 'poisoned-toxic' ? 20 : 10;
      active.damage = (active.damage || 0) + dmg;
      addLog(`${active.name} took ${dmg} Poison damage! (${active.damage}/${active.hp} HP)`);
      const koResult = checkKO(oppNum, pNum, active, false);
      if (koResult === 'win') { renderAll(); return; }
      if (koResult === 'promote') { renderAll(); return; }
    }

    if (active.status === 'burned') {
      active.damage = (active.damage || 0) + 20;
      addLog(`${active.name} took 20 Burn damage! (${active.damage}/${active.hp} HP)`);
      const koResult = checkKO(oppNum, pNum, active, false);
      if (koResult === 'win') { renderAll(); return; }
      if (koResult === 'promote') { renderAll(); return; }
    }
  }

  // Paralysis wears off on the player whose turn just ended
  const prevActive = G.players[prev].active;
  if (prevActive?.status === 'paralyzed') {
    prevActive.status = null;
    addLog(`${prevActive.name} is no longer Paralyzed.`);
  }

  // Also clear PlusPower and Swords Dance boost from active (applied or expires at end of turn)
  if (G.players[prev].active?.plusPower) {
    G.players[prev].active.plusPower = 0;
  }
  if (G.players[prev].active?.swordsDanceActive) {
    G.players[prev].active.swordsDanceActive = false;
    addLog(`Swords Dance boost expired — Slash returns to 30 damage.`);
  }
  G.turn = prev === 1 ? 2 : 1;  // ← flip turn
  G.turnNum++;

  // move-effects.js cleanup (immuneToAttack, pounce, trainerBlocked)
  if (typeof endTurnEffectsCleanup === 'function') endTurnEffectsCleanup(prev, G.turn);
  transitionPhase('DRAW');
  G.pendingLass = null;
  G.energyPlayedThisTurn = false;
  G.cursedThisTurn = false;
  G.healedThisTurn = false;
  G.shiftedThisTurn = false;
  G.stepInThisTurn = false;
  G.evolvedThisTurn = [];

  // Clear per-turn attack debuff flags.
  // Effects applied to the OPPONENT's active last for one of their turns:
  //   cantRetreat, attackReduction, disabledAttack — these are on G.players[G.turn].active
  //   (the new current player, who was the defender last turn).
  // smokescreened: cleared by performAttack itself after the flip.
  // defender: on the defending player's active, clears at end of opponent's next turn (= now).
  const nextActive = G.players[G.turn].active;
  if (nextActive) {
    nextActive.cantRetreat = false;
    nextActive.attackReduction = 0;
    nextActive.disabledAttack = null;
    nextActive.smokescreened = false; // smokescreen lasts one opponent turn regardless of whether they attacked
    // Defender expires at end of the opponent's next turn — that's now (the new current player
    // was the defending player last turn; their defender expires as their turn begins).
    if (nextActive.defender) addLog(`Defender on ${nextActive.name} has expired.`);
    nextActive.defender = false;
    nextActive.defenderFull = false;
    nextActive.defenderFullEffects = false;
    nextActive.defenderThreshold = 0;
    nextActive.defenderReduction = 0;
  }
  const lastActive = G.players[prev].active;
  if (lastActive) {
    // Clear flags that were set ON the previous player (attacker) during their turn
    // defenderReduction is for moves like Scrunch/Harden that set it on self
    lastActive.defenderReduction = 0;
  }
  // nextAttackDouble persists across the turn boundary (Swords Dance lasts until used),
  // so we do NOT clear it here — it clears itself when the attack fires.
  G.plusPowerActive = 0;
  G.pendingAction = null;
  clearHighlights();
  addLog(`Player ${prev} ended their turn.`, true);

  // Extra draws for the new player due to opponent mulligans
  const extras = G.pendingExtraDraws?.[G.turn] || 0;
  if (extras > 0) {
    G.pendingExtraDraws[G.turn] = 0;
    for (let i = 0; i < extras; i++) drawCard(G.turn, true);
    addLog(`P${G.turn} draws ${extras} extra card(s) from opponent mulligan(s).`);
  }

  const sleepTarget = G.players[G.turn].active;
  if (sleepTarget?.status === 'asleep') {
    G.pendingSleepFlip = sleepTarget.name;
  }

  drawCard(G.turn, true);
  renderAll();
  showTurnFlash(G.turn);

  if (G.pendingSleepFlip && (myRole === null || vsComputer)) {
    const sleepName = G.pendingSleepFlip;
    G.pendingSleepFlip = null;
    setTimeout(async () => {
      const target = G.players[G.turn].active;
      if (target && target.name === sleepName && target.status === 'asleep') {
        const wakeUp = await flipCoin(`${sleepName} is Asleep!\nHeads = wake up, Tails = stay asleep`);
        if (wakeUp) {
          target.status = null;
          addLog(`${sleepName} woke up!`, true);
        } else {
          addLog(`${sleepName} is still Asleep.`);
        }
        renderAll();
      }
    }, 400);
  }
}