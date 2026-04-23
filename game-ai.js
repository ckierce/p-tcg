// ══════════════════════════════════════════════════════════════════════════════
// GAME-AI.JS — VS Computer AI logic
//
// Covers: VS Computer setup, AI turn loop, energy targeting, retreat logic,
//   trainer play, attack selection, promotion, and function hooks.
//
// Depends on globals: G, vsComputer, aiDifficulty, myRole, trainerName,
//   currentUser, roomCode, gameRef, db, generateCode,
//   endTurn, resolvePromotion, checkKO, doneSetup, loadDeck,
//   startGame, performAttack, evolve, attachEnergy, executeRetreat,
//   drawCard, shuffle, addLog, renderAll, showToast, showPanel,
//   setMidline, updatePhase, transitionPhase,
//   canAffordAttack, energyValue, RULES,
//   rainDanceActive, isPowerActive, dittoAttacks, prehistoricPowerActive,
//   document
// ══════════════════════════════════════════════════════════════════════════════

// ── State ────────────────────────────────────────────────────────────────────
let vsComputer = false;     // true when playing against AI
let aiDifficulty = 'normal'; // 'easy' | 'normal' | 'hard'
let aiThinking = false;     // guard against re-entrant AI turns

// ── Difficulty selector ───────────────────────────────────────────────────────
function setAiDiff(d) {
  aiDifficulty = d;
  ['easy','normal','hard'].forEach(x => {
    const btn = document.getElementById(`diff-${x}`);
    if (!btn) return;
    btn.style.borderColor = x === d ? 'var(--ok)' : '';
    btn.style.color       = x === d ? 'var(--ok)' : '';
  });
}
setAiDiff('normal'); // default highlight

// ── Panel entry point ─────────────────────────────────────────────────────────
function startVsComputer() {
  showPanel('vs-computer-panel');
  // Reset status displays — G was cleared on returnToLobby so stale deck names must be cleared too
  const st1 = document.getElementById('p1-vs-cpu-status');
  const st2 = document.getElementById('p2-cpu-status');
  if (st1) { st1.textContent = 'No deck loaded'; st1.style.color = ''; }
  if (st2) { st2.textContent = 'Click to choose deck'; st2.style.color = ''; }
  document.querySelector('.setup-player.p1')?.classList.remove('loaded');
  document.querySelector('#vs-computer-panel .setup-player.p2')?.classList.remove('loaded');
  const btn = document.getElementById('start-cpu-btn');
  if (btn) btn.disabled = true;
}

// Called when either player loads a deck in VS Computer mode
function checkVsCpuReady() {
  if (document.getElementById('vs-computer-panel')?.style.display === 'none') return;
  const p1loaded = G.players[1].deckData !== null;
  const p2loaded = G.players[2].deckData !== null;

  const st1 = document.getElementById('p1-vs-cpu-status');
  if (st1) {
    st1.textContent = p1loaded ? `✓ ${G.players[1].deckData.name}` : 'No deck loaded';
    st1.style.color = p1loaded ? 'var(--p1color)' : '';
    document.querySelector('.setup-player.p1')?.classList.toggle('loaded', p1loaded);
  }

  const st2 = document.getElementById('p2-cpu-status');
  if (st2) {
    st2.textContent = p2loaded ? `✓ ${G.players[2].deckData.name}` : 'Click to choose deck';
    st2.style.color = p2loaded ? 'var(--p2color)' : '';
    document.querySelector('.setup-player.p2')?.classList.toggle('loaded', p2loaded);
  }

  const btn = document.getElementById('start-cpu-btn');
  if (btn) btn.disabled = !(p1loaded && p2loaded);
}

async function startVsCpuGame() {
  vsComputer = true;
  myRole = 1; // human is always P1
  G.players[1].name = trainerName || 'Player 1';
  G.players[2].name = 'Computer';

  if (!G.players[1].deck.length) { showToast('Load your deck first!', true); return; }
  if (!G.players[2].deck.length) { showToast("Choose the AI's deck first!", true); return; }

  // Give AI deck cards fresh UIDs and reset combat state
  G.players[2].deck = shuffle(G.players[2].deck.map(c => ({
    ...c,
    uid: `ai-${c.id}-${Math.random().toString(36).slice(2,7)}`,
    damage: 0, attachedEnergy: [], status: null,
    defender: false, plusPower: 0
  })));
  G.players[2].name = '🤖 Computer';

  const cpuSt = document.getElementById('p2-cpu-status');
  if (cpuSt) { cpuSt.textContent = `✓ ${G.players[2].deckData.name}`; cpuSt.style.color = 'var(--p2color)'; }

  // Persist AI game to Firebase so it shows in My Games
  roomCode = generateCode();
  gameRef = db.ref(`games/${roomCode}`);
  await gameRef.set({
    created: Date.now(),
    ownerUid: currentUser ? currentUser.uid : null,
    isAiGame: true,
    p1Name: trainerName || 'Player 1',
    p2Name: '🤖 Computer',
    p1DeckName: G.players[1].deckData?.name || null,
    p2DeckName: G.players[2].deckData?.name || null,
    state: null
  });

  await startGame();

  // AI does setup immediately after a short delay
  setTimeout(() => aiDoSetup(), 800);
}

// ── SETUP phase ───────────────────────────────────────────────────────────────
function aiDoSetup() {
  if (!vsComputer || G.phase !== 'SETUP') return;
  const p2 = G.players[2];
  const hand = p2.hand;

  function basicScore(c) {
    if (!c.attacks?.length) return 0;
    const hp = parseInt(c.hp) || 0;
    const minCost = c.attacks.reduce((min, atk) => Math.min(min, atk.cost?.length || 0), 99);
    const maxDmg = c.attacks.reduce((max, atk) => {
      const d = parseInt((atk.damage || '0').replace(/[^0-9]/g, '')) || 0;
      return Math.max(max, d);
    }, 0);
    return hp / 10 + maxDmg / 10 - minCost * 5;
  }

  const basics = hand.reduce((acc, c, i) => {
    if (c.supertype === 'Pokémon' && c.subtypes?.includes('Basic')) acc.push({ c, i });
    return acc;
  }, []);
  if (!basics.length) return;

  basics.sort((a, b) => basicScore(b.c) - basicScore(a.c));

  const activeChoice = basics[0];
  p2.active = activeChoice.c;
  hand.splice(activeChoice.i, 1);
  if (!G.evolvedThisTurn) G.evolvedThisTurn = [];
  G.evolvedThisTurn.push(activeChoice.c.uid);
  addLog(`🤖 Computer placed ${activeChoice.c.name} as Active.`, true);

  const maxBench = aiDifficulty === 'easy' ? 2 : 4;
  const remaining = basics.slice(1).sort((a, b) => basicScore(b.c) - basicScore(a.c));
  let placed = 0;
  for (const { c } of remaining) {
    if (placed >= maxBench) break;
    const slot = p2.bench.findIndex(s => s === null);
    if (slot === -1) break;
    const handIdx = hand.findIndex(h => h === c);
    if (handIdx === -1) continue;
    p2.bench[slot] = c;
    G.evolvedThisTurn.push(c.uid);
    hand.splice(handIdx, 1);
    addLog(`🤖 Computer placed ${c.name} on bench.`);
    placed++;
  }

  renderAll();
}

// ── Full turn logic ───────────────────────────────────────────────────────────
async function aiTakeTurn() {
  if (!vsComputer || G.turn !== 2 || aiThinking || !G.started) return;
  if (G.phase === 'PROMOTE') return; // handled by resolvePromotion
  aiThinking = true;

  const badge = document.getElementById('turn-badge');
  if (badge) { badge.textContent = '🤖 THINKING...'; badge.className = 'turn-badge p2'; }

  const delay = ms => new Promise(r => setTimeout(r, ms));
  const AI_DELAY = aiDifficulty === 'easy' ? 1400 : aiDifficulty === 'hard' ? 600 : 1000;

  try {
    // ── DRAW phase ────────────────────────────────────
    if (G.phase === 'DRAW') {
      drawCard(2, true);
      transitionPhase('MAIN');
      updatePhase();
      await delay(AI_DELAY * 0.5);
    }

    if (G.phase !== 'MAIN') { aiThinking = false; return; }

    const p2 = G.players[2];
    const p1 = G.players[1];

    // 1. Ensure we have an active
    if (!p2.active) {
      const benchPoke = p2.bench.find(s => s !== null);
      if (benchPoke) {
        const idx = p2.bench.findIndex(s => s === benchPoke);
        p2.active = benchPoke;
        p2.bench[idx] = null;
        addLog(`🤖 Computer moved ${benchPoke.name} to Active.`);
        renderAll();
        await delay(AI_DELAY);
      } else {
        aiThinking = false;
        endTurn();
        return;
      }
    }

    // 2. Play basics from hand to bench
    if (aiDifficulty !== 'easy' || Math.random() > 0.3) {
      const hand = p2.hand;
      for (let i = hand.length - 1; i >= 0; i--) {
        const card = hand[i];
        const benchFull = p2.bench.every(s => s !== null);
        if (benchFull) break;
        if (card.supertype === 'Pokémon' && card.subtypes?.includes('Basic')) {
          const slot = p2.bench.findIndex(s => s === null);
          if (slot === -1) break;
          p2.bench[slot] = card;
          if (!G.evolvedThisTurn) G.evolvedThisTurn = [];
          G.evolvedThisTurn.push(card.uid);
          hand.splice(i, 1);
          addLog(`🤖 Computer played ${card.name} to bench.`, true);
          renderAll();
          await delay(AI_DELAY * 0.6);
        }
      }
    }

    // 2.5 Turn plan — look ahead across attacker configurations (current
    // active, evolve-active, retreat-into-bench, Switch-into-bench) and pick
    // the best-scoring plan. Two levels of commitment:
    //
    //   FULL COMMIT — plan scores a KO (or wins the game). Execute the plan
    //     in full (preStep + Gust + PlusPower + attach + attack) and skip
    //     the rest of the turn pipeline entirely.
    //
    //   PARTIAL COMMIT — plan requires a preStep (evolve / retreat / Switch)
    //     to reach the best-scoring attacker configuration, but doesn't KO.
    //     Execute ONLY the preStep so we're set up for the right attacker,
    //     then fall through to the normal pipeline for trainers, energy
    //     attach, and attack selection. This preserves the utility moves
    //     (Bill/Oak/Potion/status cures) while still correcting the attacker
    //     selection that the old pipeline couldn't plan around.
    //
    //   NO COMMIT — plan uses current active (no preStep) and doesn't KO.
    //     Fall through entirely; fallback pipeline makes the same decisions
    //     it always has.
    //
    // Easy mode skips planning — Easy should make mistakes.
    if (aiDifficulty !== 'easy' && p2.active && p1.active) {
      const plan = aiBuildTurnPlan(p2, p1);
      if (plan && plan.willKO) {
        // Full commit
        if (plan.wouldWinByPrizes || plan.wouldWinByNoPokemon) {
          addLog(`🤖 Computer sees the winning move!`, true);
        }
        await executeTurnPlan(plan, AI_DELAY);
        return;
      }
      if (plan && plan.preStep) {
        // Partial commit: run the preStep only, then fall through. The
        // plan's preStep is the one thing the fallback pipeline cannot
        // reconstruct on its own (it evolves greedily and retreats based
        // on damage heuristics rather than goal-directed setup).
        await executePreStepOnly(plan.preStep, AI_DELAY);
      }
    }

    // 3. Evolve on normal/hard
    if (aiDifficulty !== 'easy' && !prehistoricPowerActive()) {
      const hand = p2.hand;
      const evolvedUids = G.evolvedThisTurn || [];
      for (let i = hand.length - 1; i >= 0; i--) {
        const card = hand[i];
        if (card.supertype !== 'Pokémon') continue;
        if (!card.subtypes?.includes('Stage 1') && !card.subtypes?.includes('Stage 2')) continue;
        if (!card.evolvesFrom) continue;

        if (p2.active?.name === card.evolvesFrom && !evolvedUids.includes(p2.active.uid)) {
          evolve(2, i, 'active', null);
          await delay(AI_DELAY * 0.7);
          break;
        }
        for (let b = 0; b < RULES.BENCH_SIZE; b++) {
          if (p2.bench[b]?.name === card.evolvesFrom && !evolvedUids.includes(p2.bench[b].uid)) {
            evolve(2, i, 'bench', b);
            await delay(AI_DELAY * 0.7);
            break;
          }
        }
      }
    }

    // 4. Consider retreating — before trainers/energy so PlusPower isn't wasted on a benched Pokémon
    if (aiDifficulty !== 'easy') {
      const retreated = await aiConsiderRetreat(p2);
      if (retreated) await delay(AI_DELAY);
    }

    // 5. Play trainer cards
    await aiPlayTrainers();
    await delay(AI_DELAY * 0.5);

    // 6. Attach energy (one per turn unless Rain Dance)
    if (!G.energyPlayedThisTurn) {
      const hand = p2.hand;
      const energyIdx = hand.findIndex(c => c.supertype === 'Energy');
      if (energyIdx !== -1) {
        const energyName = hand[energyIdx]?.name || '';
        const target = aiChooseEnergyTarget(p2, energyName);
        if (target !== null) {
          const isRainDance = /water/i.test(energyName) && rainDanceActive(2);
          attachEnergy(2, energyIdx, target.zone, target.idx, isRainDance);
          addLog(`🤖 Computer attached energy to ${target.zone === 'active' ? p2.active?.name : p2.bench[target.idx]?.name}.`);
          renderAll();
          await delay(AI_DELAY * 0.7);
        }
      }
    }

    // 6b. Rain Dance: keep attaching Water energy while possible
    if (rainDanceActive(2)) {
      let keepAttaching = true;
      while (keepAttaching) {
        keepAttaching = false;
        const hand = p2.hand;
        const waterIdx = hand.findIndex(c => c.supertype === 'Energy' && /water/i.test(c.name));
        if (waterIdx !== -1) {
          const energyName = hand[waterIdx]?.name || '';
          const target = aiChooseEnergyTarget(p2, energyName);
          if (target !== null) {
            attachEnergy(2, waterIdx, target.zone, target.idx, true);
            addLog(`🤖 Computer attached Water Energy via Rain Dance to ${target.zone === 'active' ? p2.active?.name : p2.bench[target.idx]?.name}.`);
            renderAll();
            await delay(AI_DELAY * 0.5);
            keepAttaching = true;
          }
        }
      }
    }

    // 7. Attack if possible
    const attacked = await aiChooseAndAttack();

    if (!attacked) {
      await delay(AI_DELAY * 0.5);
      aiThinking = false;
      if (G.started && G.turn === 2) endTurn();
    }
    // If attacked, endTurn() is called inside performAttack → endTurn flow

  } catch (e) {
    console.error('AI error:', e);
    aiThinking = false;
    if (G.started && G.turn === 2) endTurn();
  }
}

// ── Energy targeting ──────────────────────────────────────────────────────────

function aiEnergyDeficit(card, energyName) {
  if (!card?.attacks?.length) return 0;
  const attached = card.attachedEnergy || [];
  const isDCE = /double colorless/i.test(energyName);
  const incomingType = isDCE ? 'Colorless' : (energyName.replace(/\s*energy/i, '').trim() || 'Colorless');
  let bestScore = 0;
  for (const atk of card.attacks) {
    const cost = atk.cost || [];
    if (cost.length === 0) continue;
    if (!canAffordAttack(attached, cost, card)) {
      const testPool = [...attached, { name: energyName }];
      const before = cost.filter(req => req === 'Colorless' || attached.some(e => e.name.replace(/\s*energy/i,'').trim().toLowerCase() === req.toLowerCase())).length;
      const after  = cost.filter(req => req === 'Colorless' || testPool.some(e => e.name.replace(/\s*energy/i,'').trim().toLowerCase() === req.toLowerCase())).length;
      const gain = after - before;
      const typedMatch = cost.some(req => req !== 'Colorless' && req.toLowerCase() === incomingType.toLowerCase());
      const score = gain + (typedMatch ? 1 : 0);
      if (score > bestScore) bestScore = score;
    }
  }
  return bestScore;
}

function aiChooseEnergyTarget(p2, energyName) {
  // Deficit to the Pokémon's MOST EXPENSIVE attack — i.e., "how many more
  // energies do I need before this Pokémon is fully powered?" Using max-cost
  // (rather than min-cost) means "deficit 0" correctly identifies a Pokémon
  // that cannot benefit from more energy, instead of one that can just barely
  // use its cheapest attack.
  //
  // Prior bug (Issue: Lickitung over-attach): this used min-cost, so a
  // Pokémon with a cheap attack (e.g., Tongue Wrap CC) and an expensive one
  // (Supersonic CCC) registered deficit 0 as soon as the cheap attack was
  // affordable — and the fallback branch then attached to the active anyway,
  // piling endless energy onto a Pokémon that couldn't spend it.
  function energyNeeded(card) {
    if (!card?.attacks?.length) return 99;
    const attached = card.attachedEnergy || [];
    const haveTokens = energyValue(attached);
    let maxCost = 0;
    for (const atk of card.attacks) {
      const cost = atk.cost || [];
      if (cost.length > maxCost) maxCost = cost.length;
    }
    if (maxCost === 0) return 0; // only free attacks — no energy ever needed
    return Math.max(0, maxCost - haveTokens);
  }

  // Does attaching this energy ENABLE an attack that isn't currently affordable?
  // This is the single most important signal — if the active can attack this turn
  // thanks to this energy, that nearly always beats bench-stacking for future turns.
  function enablesAttack(card) {
    if (!card?.attacks?.length) return false;
    const attached = card.attachedEnergy || [];
    const withEnergy = [...attached, { name: energyName || 'Colorless Energy' }];
    for (const atk of card.attacks) {
      const cost = atk.cost || [];
      if (cost.length === 0) continue; // free attacks already affordable
      const alreadyAffordable = canAffordAttack(attached, cost, card);
      if (alreadyAffordable) continue;
      if (canAffordAttack(withEnergy, cost, card)) return true;
    }
    return false;
  }

  // Positive score = this Pokémon benefits from an energy attach.
  // Zero        = fully powered for all attacks; no benefit.
  // The caller skips attachment entirely when no candidate scores > 0.
  function targetScore(card) {
    if (!card) return 0;
    const deficit = energyNeeded(card);
    if (deficit === 0) return 0;
    const typeBonus = energyName ? aiEnergyDeficit(card, energyName) : 0;
    return deficit + typeBonus * 2;
  }

  const active = p2.active;
  const activeEnables = active ? enablesAttack(active) : false;
  const activeScore = targetScore(active);

  let bestBenchIdx = -1, bestBenchScore = 0, bestBenchEnables = false;
  for (let i = 0; i < RULES.BENCH_SIZE; i++) {
    const b = p2.bench[i];
    if (!b) continue;
    const s = targetScore(b);
    if (s > bestBenchScore) { bestBenchScore = s; bestBenchIdx = i; bestBenchEnables = enablesAttack(b); }
  }

  // Highest priority: attach to the active if it enables an attack THIS turn.
  // Only the active attacks this turn, so "enables attack now" on the active
  // beats any bench setup benefit. A benched Pokémon becoming attack-ready is
  // only useful once it's promoted, which may be several turns away.
  if (active && activeEnables) return { zone: 'active', idx: null };

  if (activeScore > 0 && activeScore >= bestBenchScore) return { zone: 'active', idx: null };
  if (bestBenchIdx !== -1 && bestBenchScore > 0) return { zone: 'bench', idx: bestBenchIdx };
  // NO TARGET — nothing on the field benefits from more energy. Keep the card
  // in hand for a future turn (it's free to hold, and may matter when a new
  // Pokémon enters play or an evolution card needs fueling).
  return null;
}

// ── Shared bench-promotion scoring (#3) ───────────────────────────────────────
// Score a bench Pokémon as a candidate for the active slot. Used by retreat,
// Switch, Scoop Up, and post-KO promotion. Previously each call site used only
// HP + "can attack" — which led to mistakes like retreating Charizard into
// Bulbasaur against a Blastoise active.
//
// Scoring factors (higher is better):
//   + remainingHp                  tanky Pokémon are better candidates
//   + 100 if b can attack now      attack-ready is a meaningful bonus
//   + 2 × best damage vs oppActive type-matchup + raw damage potential
//
// The 2× multiplier on damage is deliberate: it makes a 40-damage attacker
// worth +80, which outweighs ~30 HP difference but not large HP gaps. This
// matches the intuition "matchup matters but so does survivability."
//
// oppActive may be null (e.g. post-KO promotion when opponent's active is
// temporarily empty). In that case only HP and can-attack are considered.
function benchPromotionScore(b, oppActive) {
  if (!b) return -Infinity;
  const remainingHp = (parseInt(b.hp) || 0) - (b.damage || 0);
  const canAttack = aiCanAttack(b);
  let score = remainingHp + (canAttack ? 100 : 0);

  if (oppActive) {
    // Best damage b can deal to oppActive with its CURRENT attached energy,
    // after W/R. Uses the same effective-damage formula as aiChooseAndAttack.
    const atkTypes = b.types || [];
    const weaknesses = oppActive.weaknesses || [];
    const resistances = oppActive.resistances || [];
    let bestDmg = 0;
    for (const atk of (b.attacks || [])) {
      if (!canAffordAttack(b.attachedEnergy, atk.cost || [], b)) continue;
      let dmg = parseInt((atk.damage || '0').replace(/[^0-9]/g, '')) || 0;
      if (dmg === 0) continue;
      dmg = computeDamageAfterWR(dmg, atkTypes, weaknesses, resistances);
      if (dmg > bestDmg) bestDmg = dmg;
    }
    score += bestDmg * 2;
  }

  return score;
}

// ── Retreat consideration ─────────────────────────────────────────────────────
async function aiConsiderRetreat(p2, force = false) {
  if (!p2.active || !p2.bench.some(s => s)) return false;
  const active = p2.active;
  const hp = parseInt(active.hp) || 0;
  const dmg = active.damage || 0;
  const pctDmg = hp > 0 ? dmg / hp : 0;

  const retreatCost = active.convertedRetreatCost || 0;
  if (energyValue(active.attachedEnergy) < retreatCost) return false;

  const p1 = G.players[1];
  const oppActive = p1?.active || null;

  let bestBench = -1, bestScore = -Infinity;
  for (let i = 0; i < RULES.BENCH_SIZE; i++) {
    const b = p2.bench[i];
    if (!b) continue;
    const s = benchPromotionScore(b, oppActive);
    if (s > bestScore) { bestScore = s; bestBench = i; }
  }
  if (bestBench === -1) return false;

  const bench = p2.bench[bestBench];
  const activeCanAttack = aiCanAttack(active);
  const benchCanAttack = aiCanAttack(bench);

  // Threat-aware: if active will die next turn and bench candidate will survive,
  // retreating saves a prize. This is the most important retreat signal and
  // overrides the old damage-percentage heuristic.
  const activeDying = willActiveDieNextTurn(p2, p1);
  const benchHpLeft = (parseInt(bench.hp) || 0) - (bench.damage || 0);
  const benchThreat = opponentThreatNextTurn(p1, { ...p2, active: bench });
  const benchWouldSurvive = benchHpLeft > benchThreat;

  const shouldRetreat = force
    || (activeDying && benchWouldSurvive)
    || pctDmg >= 0.65
    || (!activeCanAttack && benchCanAttack)
    || (benchPromotionScore(bench, oppActive) > benchPromotionScore(active, oppActive) + 50 && pctDmg >= 0.4);

  if (!shouldRetreat) return false;

  const outName = bench?.name || '?';
  executeRetreat(2, bestBench);
  addLog(`🤖 Computer retreated ${active.name} → sent out ${outName}.`, true);
  renderAll();
  return true;
}

// ── Trainer play ──────────────────────────────────────────────────────────────
async function aiPlayTrainers() {
  if (aiDifficulty === 'easy' && Math.random() > 0.4) return;

  const p2 = G.players[2];
  const hand = p2.hand;
  const opp = G.players[1];

  function aiExpectedDamage() {
    const card = p2.active;
    if (!card?.attacks?.length) return 0;
    const affordable = card.attacks.filter(atk => canAffordAttack(card.attachedEnergy, atk.cost, card));
    if (!affordable.length) return 0;
    return Math.max(...affordable.map(atk => parseInt((atk.damage || '0').replace(/[^0-9]/g,'')) || 0));
  }

  function canKOWithPlusPower() {
    if (!opp.active) return false;
    const remaining = (parseInt(opp.active.hp) || 0) - (opp.active.damage || 0);
    const baseDmg = aiExpectedDamage();
    return baseDmg > 0 && baseDmg + 10 >= remaining && baseDmg < remaining;
  }

  function benchTotalDamage() {
    return p2.bench.reduce((sum, b) => sum + (b?.damage || 0), 0);
  }

  let played = true;
  let trainerPlays = 0;
  const MAX_TRAINER_PLAYS = aiDifficulty === 'hard' ? 5 : 3;

  while (played && trainerPlays < MAX_TRAINER_PLAYS) {
    played = false;
    const activeStatus = p2.active?.status;
    const isStatusBad = activeStatus === 'paralyzed' || activeStatus === 'asleep' || activeStatus === 'confused';

    // 1. Status cures
    if (isStatusBad) {
      for (let i = hand.length - 1; i >= 0; i--) {
        const card = hand[i];
        if (card.supertype !== 'Trainer') continue;
        const name = card.name;
        if (name === 'Full Heal' || name === 'Full Restore') {
          hand.splice(i, 1); p2.discard.push(card);
          const cured = p2.active.status; p2.active.status = null;
          if (name === 'Full Restore') p2.active.damage = 0;
          addLog(`🤖 Computer played ${name} — cured ${p2.active.name} of ${cured}!`, true);
          renderAll(); trainerPlays++; played = true; break;
        }
        if (name === 'Switch') {
          const benchSlots = p2.bench.map((s, bi) => ({ s, bi })).filter(x => x.s !== null);
          if (benchSlots.length) {
            let bestIdx = benchSlots[0].bi, bestScore = -Infinity;
            for (const { s, bi } of benchSlots) {
              const score = benchPromotionScore(s, opp.active);
              if (score > bestScore) { bestScore = score; bestIdx = bi; }
            }
            hand.splice(i, 1); p2.discard.push(card);
            const old = p2.active; old.status = null;
            p2.active = p2.bench[bestIdx]; p2.bench[bestIdx] = old;
            addLog(`🤖 Computer played Switch — escaped ${activeStatus}! Sent out ${p2.active.name}.`, true);
            renderAll(); trainerPlays++; played = true; break;
          }
        }
        if (name === 'Scoop Up' && (activeStatus === 'paralyzed' || activeStatus === 'asleep')) {
          const benchSlots = p2.bench.filter(s => s !== null);
          if (benchSlots.length) {
            hand.splice(i, 1); p2.discard.push(card);
            const scooped = p2.active;
            scooped.damage = 0; scooped.attachedEnergy = []; scooped.status = null;
            p2.hand.push(scooped); p2.active = null;
            let bestBench = 0, bestScore = -Infinity;
            for (let b = 0; b < RULES.BENCH_SIZE; b++) {
              if (!p2.bench[b]) continue;
              const score = benchPromotionScore(p2.bench[b], opp.active);
              if (score > bestScore) { bestScore = score; bestBench = b; }
            }
            p2.active = p2.bench[bestBench]; p2.bench[bestBench] = null;
            addLog(`🤖 Computer played Scoop Up — returned ${scooped.name} to hand, sent out ${p2.active.name}!`, true);
            renderAll(); trainerPlays++; played = true; break;
          }
        }
      }
      if (played) continue;
      if (activeStatus === 'paralyzed' || activeStatus === 'asleep') {
        await aiConsiderRetreat(p2, true); return;
      }
    }

    // 2. PlusPower for KO
    if (aiDifficulty !== 'easy' && canKOWithPlusPower() && p2.active && aiCanAttack(p2.active)) {
      for (let i = hand.length - 1; i >= 0; i--) {
        if (hand[i].name !== 'PlusPower') continue;
        const card = hand.splice(i, 1)[0]; p2.discard.push(card);
        p2.active.plusPower = (p2.active.plusPower || 0) + 10;
        addLog(`🤖 Computer played PlusPower — going for the KO on ${opp.active?.name}!`, true);
        renderAll(); trainerPlays++; played = true; break;
      }
      if (played) continue;
    }

    // 3. Gust of Wind
    if (aiDifficulty !== 'easy' && opp.bench.some(s => s !== null)) {
      for (let i = hand.length - 1; i >= 0; i--) {
        if (hand[i].name !== 'Gust of Wind') continue;
        const oppActiveHpLeft = opp.active ? (parseInt(opp.active.hp)||0) - (opp.active.damage||0) : Infinity;
        let bestTarget = -1, bestTargetScore = Infinity;
        for (let b = 0; b < RULES.BENCH_SIZE; b++) {
          const bench = opp.bench[b]; if (!bench) continue;
          const hpLeft = (parseInt(bench.hp)||0) - (bench.damage||0);
          const score = hpLeft - energyValue(bench.attachedEnergy) * 10;
          if (score < bestTargetScore) { bestTargetScore = score; bestTarget = b; }
        }
        if (bestTarget !== -1 && bestTargetScore < oppActiveHpLeft - 10) {
          const card = hand.splice(i, 1)[0]; p2.discard.push(card);
          const pulled = opp.bench[bestTarget];
          opp.bench[bestTarget] = opp.active; opp.active = pulled;
          // Defensive pad — ensure bench stays exactly 5 slots after swap
          while (opp.bench.length < 5) opp.bench.push(null);
          while (p2.bench.length < 5) p2.bench.push(null);
          addLog(`🤖 Computer played Gust of Wind — pulled ${pulled.name} into the Active spot!`, true);
          renderAll(); trainerPlays++; played = true;
        }
        break;
      }
      if (played) continue;
    }

    // 4. Energy Removal
    if (aiDifficulty !== 'easy' && opp.active && (opp.active.attachedEnergy?.length || 0) > 0) {
      for (let i = hand.length - 1; i >= 0; i--) {
        if (hand[i].name !== 'Energy Removal') continue;
        const card = hand.splice(i, 1)[0]; p2.discard.push(card);
        const removed = opp.active.attachedEnergy.splice(opp.active.attachedEnergy.length - 1, 1);
        opp.discard.push(...removed);
        addLog(`🤖 Computer played Energy Removal on ${opp.active.name}!`, true);
        renderAll(); trainerPlays++; played = true; break;
      }
      if (played) continue;
    }

    // 5. Super Energy Removal (hard only)
    if (aiDifficulty === 'hard' && opp.active && (opp.active.attachedEnergy?.length || 0) >= 2) {
      const myWithEnergy = [p2.active, ...p2.bench].filter(c => c && (c.attachedEnergy?.length || 0) > 0);
      if (myWithEnergy.length > 0) {
        for (let i = hand.length - 1; i >= 0; i--) {
          if (hand[i].name !== 'Super Energy Removal') continue;
          myWithEnergy[myWithEnergy.length - 1].attachedEnergy.splice(0, 1);
          const toRemove = Math.min(2, opp.active.attachedEnergy.length);
          const removed = opp.active.attachedEnergy.splice(opp.active.attachedEnergy.length - toRemove, toRemove);
          opp.discard.push(...removed);
          const card = hand.splice(i, 1)[0]; p2.discard.push(card);
          addLog(`🤖 Computer played Super Energy Removal — stripped ${toRemove} energy from ${opp.active.name}!`, true);
          renderAll(); trainerPlays++; played = true; break;
        }
        if (played) continue;
      }
    }

    // 6. Defender — play if it moves us out of KO range next turn.
    // Falls back to the old damage-threshold heuristic when we can't predict
    // (e.g., opponent active missing / status hides damage).
    if (p2.active && aiDifficulty !== 'easy') {
      const threat = opponentThreatNextTurn(opp, p2);
      const hpLeft = (parseInt(p2.active.hp) || 0) - (p2.active.damage || 0);
      // Defender reduces incoming damage by 20. Only useful if:
      //   - We'd die without it (threat >= hpLeft), AND
      //   - With it we'd survive (threat - 20 < hpLeft)
      const defenderSaves = threat >= hpLeft && (threat - 20) < hpLeft;
      const fallbackHeuristic = (p2.active.damage || 0) >= 30 && threat === 0;
      if (defenderSaves || fallbackHeuristic) {
        for (let i = hand.length - 1; i >= 0; i--) {
          if (hand[i].name !== 'Defender') continue;
          const card = hand.splice(i, 1)[0]; p2.discard.push(card);
          p2.active.defender = true;
          addLog(`🤖 Computer played Defender on ${p2.active.name}.`, true);
          renderAll(); trainerPlays++; played = true; break;
        }
        if (played) continue;
      }
    }

    // 7. Revive
    if (aiDifficulty !== 'easy' && p2.bench.some(s => s === null)) {
      for (let i = hand.length - 1; i >= 0; i--) {
        if (hand[i].name !== 'Revive') continue;
        const basics = p2.discard.filter(c => c.supertype === 'Pokémon' && c.subtypes?.includes('Basic'));
        if (!basics.length) break;
        const best = basics.reduce((a, b) => (parseInt(a.hp)||0) > (parseInt(b.hp)||0) ? a : b);
        p2.discard.splice(p2.discard.indexOf(best), 1);
        best.damage = Math.floor((parseInt(best.hp)||0) / 2);
        p2.bench[p2.bench.findIndex(s => s === null)] = best;
        const card = hand.splice(i, 1)[0]; p2.discard.push(card);
        addLog(`🤖 Computer played Revive — brought back ${best.name}!`, true);
        renderAll(); trainerPlays++; played = true; break;
      }
      if (played) continue;
    }

    // 8. Pokémon Center
    {
      const totalDmg = benchTotalDamage() + (p2.active?.damage || 0);
      const energyCount = [p2.active, ...p2.bench].filter(Boolean).reduce((s, c) => s + (c.attachedEnergy?.length || 0), 0);
      if (totalDmg >= 80 && totalDmg >= energyCount * 20) {
        for (let i = hand.length - 1; i >= 0; i--) {
          if (hand[i].name !== 'Pokémon Center') continue;
          const card = hand.splice(i, 1)[0]; p2.discard.push(card);
          [p2.active, ...p2.bench].filter(Boolean).forEach(c => {
            if (c.damage > 0) { c.attachedEnergy.forEach(e => p2.discard.push(e)); c.attachedEnergy = []; c.damage = 0; }
          });
          addLog(`🤖 Computer played Pokémon Center — healed all Pokémon!`, true);
          renderAll(); trainerPlays++; played = true; break;
        }
        if (played) continue;
      }
    }

    // 9. Potion / Super Potion — heal to escape next-turn KO, or as top-up
    // when damage is accumulating but no immediate threat.
    if (p2.active && (p2.active.damage || 0) >= 20) {
      const threat = opponentThreatNextTurn(opp, p2);
      const hpLeft = (parseInt(p2.active.hp) || 0) - (p2.active.damage || 0);
      const dying = threat >= hpLeft;

      for (let i = hand.length - 1; i >= 0; i--) {
        const name = hand[i].name;
        // Super Potion: heals 40 (at cost of 1 energy).
        if (name === 'Super Potion' && (p2.active.attachedEnergy?.length || 0) > 0) {
          // Primary use: escape a KO.
          const willSaveUs = dying && (hpLeft + RULES.SUPER_POTION_HEAL) > threat;
          // Fallback: damage is piling up and we have plenty of energy to spare.
          const efficientTopUp = (p2.active.damage || 0) >= 50 &&
            (p2.active.attachedEnergy.length >= 2);
          if (willSaveUs || efficientTopUp) {
            p2.discard.push(...p2.active.attachedEnergy.splice(0, 1));
            const card = hand.splice(i, 1)[0]; p2.discard.push(card);
            p2.active.damage = Math.max(0, (p2.active.damage || 0) - RULES.SUPER_POTION_HEAL);
            addLog(`🤖 Computer played Super Potion — healed ${p2.active.name}.`, true);
            renderAll(); trainerPlays++; played = true; break;
          }
        }
        // Potion: heals 20, free. Play if it escapes KO, or if damage is high enough.
        if (name === 'Potion') {
          const willSaveUs = dying && (hpLeft + RULES.POTION_HEAL) > threat;
          const worthItAnyway = (p2.active.damage || 0) >= 30;
          if (willSaveUs || worthItAnyway) {
            const card = hand.splice(i, 1)[0]; p2.discard.push(card);
            p2.active.damage = Math.max(0, (p2.active.damage || 0) - RULES.POTION_HEAL);
            addLog(`🤖 Computer played Potion — healed ${p2.active.name}.`, true);
            renderAll(); trainerPlays++; played = true; break;
          }
        }
      }
      if (played) continue;
    }

    // 10. PlusPower (general)
    if (aiDifficulty !== 'easy' && p2.active && aiCanAttack(p2.active)) {
      for (let i = hand.length - 1; i >= 0; i--) {
        if (hand[i].name !== 'PlusPower') continue;
        const card = hand.splice(i, 1)[0]; p2.discard.push(card);
        p2.active.plusPower = (p2.active.plusPower || 0) + 10;
        addLog(`🤖 Computer played PlusPower on ${p2.active.name}.`, true);
        renderAll(); trainerPlays++; played = true; break;
      }
      if (played) continue;
    }

    // 11. Draw trainers
    for (let i = hand.length - 1; i >= 0; i--) {
      const card = hand[i];
      if (card.supertype !== 'Trainer') continue;
      const name = card.name;
      if (name === 'Bill') {
        hand.splice(i, 1); p2.discard.push(card);
        for (let d = 0; d < 2 && p2.deck.length; d++) drawCard(2, true);
        addLog(`🤖 Computer played Bill — drew 2 cards.`, true);
        renderAll(); trainerPlays++; played = true; break;
      }
      const oakThreshold = aiDifficulty === 'hard' ? 6 : 4;
      if (name === 'Professor Oak' && hand.length <= oakThreshold) {
        p2.discard.push(...hand.splice(0));
        for (let d = 0; d < 7 && p2.deck.length; d++) drawCard(2, true);
        addLog(`🤖 Computer played Professor Oak — drew 7 cards.`, true);
        renderAll(); trainerPlays++; played = true; break;
      }
      if (name === 'Gambler' && hand.length <= 2) {
        hand.splice(i, 1); p2.discard.push(card);
        for (let d = 0; d < 8 && p2.deck.length; d++) drawCard(2, true);
        addLog(`🤖 Computer played Gambler.`, true);
        renderAll(); trainerPlays++; played = true; break;
      }
      if (name === 'Maintenance' && aiDifficulty === 'hard' && hand.length >= 3) {
        const others = hand.filter((c, ci) => ci !== i);
        if (others.length >= 2) {
          const toShuffle = others.slice(0, 2);
          toShuffle.forEach(c => { const idx = hand.indexOf(c); if (idx !== -1) hand.splice(idx, 1); p2.deck.push(c); });
          for (let s = p2.deck.length - 1; s > 0; s--) { const r = Math.floor(Math.random()*(s+1)); [p2.deck[s],p2.deck[r]]=[p2.deck[r],p2.deck[s]]; }
          hand.splice(hand.indexOf(card), 1); p2.discard.push(card);
          drawCard(2, true);
          addLog(`🤖 Computer played Maintenance.`, true);
          renderAll(); trainerPlays++; played = true; break;
        }
      }
    }
  }
}

// ── Attack selection ──────────────────────────────────────────────────────────
function aiCanAttack(card) {
  if (!card?.attacks?.length) return false;
  return card.attacks.some(atk => canAffordAttack(card.attachedEnergy, atk.cost, card));
}

// Max possible damage of a single attack, treating all coin flips as heads.
// Reads the attack's text to detect "flip N coins" / "flip once" / "if heads
// +N damage" patterns. Returns the number that goes on the opponent BEFORE
// weakness/resistance/PlusPower. Returns 0 if the attack deals no damage.
//
// This is a conservative ("worst case for us") estimate used by the threat
// model. When we can't infer a multiplier, we fall back to the base damage.
function maxDamageForAttack(move, energyCount) {
  const base = parseInt((move.damage || '0').replace(/[^0-9]/g, '')) || 0;
  const text = (move.text || '').toLowerCase();
  if (!text) return base;

  // "Flip N coins. ... does X damage times the number of heads."
  // e.g. Comet Punch: N=4, X=20 → max 80
  const flipNMatch = text.match(/flip (\d+|a) coins?[\s\S]*?times the number of heads/i);
  const timesHeadsMatch = text.match(/does (\d+) damage times the number of heads/i);
  if (flipNMatch && timesHeadsMatch) {
    const rawN = flipNMatch[1];
    const numFlips = rawN === 'a' ? 1 : parseInt(rawN);
    const perFlip = parseInt(timesHeadsMatch[1]);
    return numFlips * perFlip;
  }

  // "Flip a number of coins equal to the number of Energy attached."
  const equalEnergyMatch = text.match(/flip a number of coins equal to[^.]*energy/i);
  if (equalEnergyMatch && timesHeadsMatch) {
    const perFlip = parseInt(timesHeadsMatch[1]);
    return Math.max(1, energyCount) * perFlip;
  }

  // "If heads, does N more/additional damage"
  const headsMoreMatch = text.match(/if heads[\s\S]*?(\d+) more damage/i)
    || text.match(/if heads[\s\S]*?(\d+) additional damage/i);
  if (headsMoreMatch) return base + parseInt(headsMoreMatch[1]);

  // "If heads, does N damage instead"
  const headsInsteadMatch = text.match(/if heads[\s\S]*?does (\d+) damage instead/i);
  if (headsInsteadMatch) return Math.max(base, parseInt(headsInsteadMatch[1]));

  // "Flip a coin. If tails, no damage / does nothing" — max = base (heads lands it)
  // Already returned as `base` below.

  return base;
}

// Opponent threat model — worst-case damage that `attackerPlayer` (the OPPONENT)
// can do to `defenderPlayer`'s active on their NEXT turn.
//
// Assumptions ("conservative for us"):
//   - Any of their Pokémon may end up as the attacker: their CURRENT active, or
//     any bench Pokémon they can promote by retreating or playing Switch /
//     Scoop Up. Bench threat is considered only when reachable this turn.
//   - They may attach up to one energy from their hand (to whichever attacker
//     ends up active).
//   - Coin-flip attacks resolve maximally in their favor.
//   - PlusPower in their hand adds +10 (they'd play it for a KO).
//   - Weakness/Resistance applied relative to OUR active's types.
//   - Mitigations on our side (Invisible Wall, Defender, Pounce) are NOT
//     subtracted — threat = "what lands if unmitigated". Those mitigations
//     are considered by callers when deciding whether to play/use them.
//
// Pure helper — no side effects, no DOM. Exported for tests.
function opponentThreatNextTurn(attackerPlayer, defenderPlayer) {
  const def = defenderPlayer?.active;
  if (!def) return 0;

  const hand = attackerPlayer?.hand || [];
  const energyNamesInHand = [...new Set(
    hand.filter(c => c?.supertype === 'Energy').map(c => c.name)
  )];
  const attachmentOptions = [null, ...energyNamesInHand.map(n => ({ name: n }))];
  const hasPlusPower = hand.some(c => c?.name === 'PlusPower');
  const weaknesses  = def.weaknesses  || [];
  const resistances = def.resistances || [];

  // Inner helper — damage one specific attacker card deals to `def`, assuming
  // best-case energy attach + PlusPower. Returns the max damage across all
  // attacks the attacker could legally use.
  function damageFromAttacker(atk) {
    if (!atk?.attacks?.length) return 0;
    // Paralysis prevents a Pokémon from attacking if it's the active — but
    // this check only applies to the CURRENT active. When we evaluate a bench
    // Pokémon as the "hypothetical attacker" it's not yet in the active slot,
    // so we don't short-circuit on paralysis.
    const atkTypes = atk.types || [];
    const disabledName = atk.disabledAttack || null;
    const attackReduction = atk.attackReduction || 0;

    let maxDmg = 0;
    for (const extraEnergy of attachmentOptions) {
      const attached = extraEnergy
        ? [...(atk.attachedEnergy || []), extraEnergy]
        : (atk.attachedEnergy || []);
      const energyCount = energyValue(attached);

      for (const move of atk.attacks) {
        if (!canAffordAttack(attached, move.cost || [], atk)) continue;
        if (disabledName && move.name === disabledName) continue;

        let dmg = maxDamageForAttack(move, energyCount);
        if (dmg === 0) continue;

        dmg = computeDamageAfterWR(dmg, atkTypes, weaknesses, resistances);
        if (hasPlusPower) dmg += 10;
        dmg = Math.max(0, dmg - attackReduction);

        if (dmg > maxDmg) maxDmg = dmg;
      }
    }
    return maxDmg;
  }

  // 1. Threat from current active (unless paralyzed — paralyzed active simply
  //    can't attack this turn; paralysis wears off AFTER their turn, not before).
  const activeAtk = attackerPlayer?.active;
  let threat = 0;
  if (activeAtk && activeAtk.status !== 'paralyzed') {
    threat = damageFromAttacker(activeAtk);
  }

  // 2. Threat from any bench Pokémon the opponent could promote THIS turn.
  //    Reachable means they can get a bench Pokémon into the active slot
  //    through one of: Switch card, Scoop Up, or manual retreat.
  const hasSwitch  = hand.some(c => c?.name === 'Switch');
  const hasScoopUp = hand.some(c => c?.name === 'Scoop Up');
  let canManualRetreat = false;
  if (activeAtk && activeAtk.status !== 'paralyzed' && activeAtk.status !== 'asleep') {
    const baseCost = activeAtk.convertedRetreatCost || 0;
    // Retreat-cost reductions (e.g. Wigglytuff Power) are opponent-side
    // effects we don't typically model; baseCost is a safe conservative value.
    const attachedVal = energyValue(activeAtk.attachedEnergy || []);
    canManualRetreat = attachedVal >= baseCost;
  }
  const canReachBench = hasSwitch || hasScoopUp || canManualRetreat;

  if (canReachBench) {
    for (const b of (attackerPlayer?.bench || [])) {
      if (!b) continue;
      const benchThreat = damageFromAttacker(b);
      if (benchThreat > threat) threat = benchThreat;
    }
  }

  return threat;
}

// True if the opponent's next turn is likely to KO our active.
// Compares projected damage to HP remaining (HP − current damage).
function willActiveDieNextTurn(defenderPlayer, attackerPlayer) {
  const def = defenderPlayer?.active;
  if (!def) return false;
  const hpLeft = (parseInt(def.hp) || 0) - (def.damage || 0);
  if (hpLeft <= 0) return false; // already KO'd; nothing to protect
  const threat = opponentThreatNextTurn(attackerPlayer, defenderPlayer);
  return threat >= hpLeft;
}

// ── Prize awareness ──────────────────────────────────────────────────────────
// Number of prizes the given player still has to take (the prize cards that
// will be given to their OPPONENT when the opponent KOs one of their Pokémon).
// i.e. prizesRemaining(2) = prizes P1 still has to draw to win.
// In this codebase each player's `prizes` array is the pile THEY draw from,
// so prizes remaining for player N = count of non-null entries in p[N].prizes.
function prizesRemaining(playerObj) {
  if (!playerObj?.prizes) return 6;
  return playerObj.prizes.filter(p => p).length;
}

// ── Plan evaluation for a given "attacker configuration" ────────────────────
// Given:
//   attacker — the Pokémon that will be Active AFTER any preStep (evolve,
//              retreat, switch). Its `attachedEnergy` must reflect the state
//              AFTER the preStep.
//   p2, p1   — current (unmutated) game state. Used for hand / bench / prizes.
//   preStep  — metadata about what had to happen to get `attacker` into the
//              active slot. Consumed-hand cards (e.g. Switch) reduce the set
//              of hand cards available for attach / PlusPower / Gust.
//              Shape: null | { kind, handIdx?, benchIdx?, energyDiscardCount }
//                       kind: 'evolve' | 'retreat' | 'switch'
//   hpLeftOverride — if the attacker card we're evaluating has different HP
//              (e.g. post-evolve HP), pass it here. Otherwise derived from card.
//
// Returns the best plan or null if no affordable attack exists.
//
// IMPORTANT: this function does NOT mutate p2 / p1 / hand in any way. The
// preStep is consumed only by excluding its card from our "available hand"
// view when enumerating attach / PlusPower / Gust options.
function evaluateAttackerPlan(attacker, p2, p1, preStep) {
  if (!attacker || !p1?.active) return null;
  if (attacker.status === 'paralyzed' || attacker.status === 'asleep') return null;
  if (!attacker.attacks?.length) return null;

  const fullHand = p2.hand || [];
  // Hand as visible for the rest of the plan — excludes cards consumed by the
  // preStep. We represent "consumed" as a Set of hand indices to ignore.
  const consumed = new Set();
  if (preStep?.kind === 'evolve'  && preStep.handIdx != null) consumed.add(preStep.handIdx);
  if (preStep?.kind === 'switch'  && preStep.handIdx != null) consumed.add(preStep.handIdx);
  // (retreat has no hand card)

  const hand = fullHand.filter((_, i) => !consumed.has(i));

  const energyAlreadyPlayed = !!G.energyPlayedThisTurn;
  const rainDance = (typeof rainDanceActive === 'function') && rainDanceActive(2);

  // Distinct energy names in hand
  const energiesInHand = hand
    .map((c, i) => ({ c, i }))
    .filter(x => x.c?.supertype === 'Energy');
  const distinctEnergyNames = [...new Set(energiesInHand.map(x => x.c.name))];

  const attachOptions = [[]];
  if (!energyAlreadyPlayed) {
    for (const name of distinctEnergyNames) {
      const first = energiesInHand.find(x => x.c.name === name);
      if (first) attachOptions.push([{ name, handIdx: first.i }]);
    }
  }
  if (rainDance) {
    const waters = energiesInHand.filter(x => /water/i.test(x.c.name));
    if (waters.length >= 1) {
      attachOptions.push(waters.map(w => ({ name: w.c.name, handIdx: w.i })));
    }
  }

  const plusPowerHandIdxs = hand
    .map((c, i) => ({ c, i }))
    .filter(x => x.c?.name === 'PlusPower')
    .map(x => x.i);
  const maxPlusPowers = Math.min(2, plusPowerHandIdxs.length);

  const hasGust = hand.some(c => c?.name === 'Gust of Wind');
  const targetOptions = [{ benchIdx: null, card: p1.active, gustHandIdx: null }];
  if (hasGust) {
    const gustIdx = hand.findIndex(c => c?.name === 'Gust of Wind');
    for (let b = 0; b < (p1.bench?.length || 0); b++) {
      const bc = p1.bench[b];
      if (bc) targetOptions.push({ benchIdx: b, card: bc, gustHandIdx: gustIdx });
    }
  }

  function attackerWithPlan(attachList, plusPowerN) {
    const attached = [...(attacker.attachedEnergy || [])];
    for (const a of attachList) attached.push({ name: a.name });
    return { attached, plus: plusPowerN * 10 };
  }

  function computePlannedDamage(atk, planned, target) {
    if (!canAffordAttack(planned.attached, atk.cost || [], attacker)) return 0;
    if (attacker.disabledAttack && attacker.disabledAttack === atk.name) return 0;
    if (atk.name === 'Conversion 1' && !(target.weaknesses || []).length) return 0;

    const energyCount = energyValue(planned.attached);
    let dmg = maxDamageForAttack(atk, energyCount);
    if (dmg === 0) return 0;

    const atkTypes = attacker.types || [];
    dmg = computeDamageAfterWR(dmg, atkTypes, target.weaknesses, target.resistances);
    dmg += planned.plus;

    if (typeof hasInvisibleWall === 'function' && hasInvisibleWall(target) && dmg >= 30) {
      return 0;
    }

    if (target.defender && dmg > 0) dmg = Math.max(0, dmg - 20);

    return dmg;
  }

  function threatAfterKO(target) {
    const targetIsActive = target === p1.active;
    if (!targetIsActive) return opponentThreatNextTurn(p1, p2);
    let maxThreat = 0;
    for (const b of (p1.bench || [])) {
      if (!b) continue;
      const hypothetical = { ...p1, active: b };
      const t = opponentThreatNextTurn(hypothetical, p2);
      if (t > maxThreat) maxThreat = t;
    }
    return maxThreat;
  }

  const myPrizesLeft = prizesRemaining(p2);
  const oppPrizesLeft = prizesRemaining(p1);
  const hpLeft = (parseInt(attacker.hp) || 0) - (attacker.damage || 0);

  let best = null;

  for (const target of targetOptions) {
    const targetHp = (parseInt(target.card.hp) || 0) - (target.card.damage || 0);
    if (targetHp <= 0) continue;

    for (const attachList of attachOptions) {
      for (let pp = 0; pp <= maxPlusPowers; pp++) {
        const planned = attackerWithPlan(attachList, pp);

        for (const atk of attacker.attacks) {
          const dmg = computePlannedDamage(atk, planned, target.card);
          if (dmg === 0) continue;

          const willKO = dmg >= targetHp;
          let counterDamage;
          if (willKO && target.card === p1.active) {
            const benchAnyoneAlive = (p1.bench || []).some(b => b);
            counterDamage = benchAnyoneAlive ? threatAfterKO(target.card) : 0;
          } else {
            counterDamage = opponentThreatNextTurn(p1, p2);
          }
          const willSurvive = counterDamage < hpLeft;

          const wouldWinByPrizes = willKO && myPrizesLeft === 1;
          const wouldWinByNoPokemon =
            willKO && target.card === p1.active && !(p1.bench || []).some(b => b);

          let score = 0;
          if (wouldWinByPrizes || wouldWinByNoPokemon) score += 1_000_000;
          if (willKO) score += 100_000;
          if (willSurvive) score += 50_000;

          // Damage as tiebreaker, but capped at target HP — overkill doesn't
          // make a KO plan "better" than another KO plan. This matters so
          // preStep penalties actually discourage unnecessary evolves.
          const effectiveDmgForScore = Math.min(dmg, targetHp, 999);
          score += effectiveDmgForScore;

          if (!willSurvive && oppPrizesLeft === 1) score -= 200_000;

          // Resource cost — prefer cheaper plans among equal-outcome ones.
          score -= pp * 5;
          score -= (target.gustHandIdx !== null ? 10 : 0);
          score -= attachList.length * 1;

          // preStep cost: evolving or switching uses a card; retreating discards
          // energy. Small penalty so we prefer plans that avoid these when a
          // simple plan achieves the same outcome.
          if (preStep?.kind === 'evolve')  score -= 20;
          if (preStep?.kind === 'breeder') score -= 25; // uses 2 cards (Breeder + Stage 2)
          if (preStep?.kind === 'switch')  score -= 15;
          if (preStep?.kind === 'retreat') score -= (preStep.energyDiscardCount || 0) * 8;

          if (!best || score > best.score) {
            // Derive an outcome label for callers. This drives the
            // "commit to plan" decision in aiTakeTurn — non-KO plans that
            // require a preStep are still committed (because the fallback
            // pipeline would not make the same move), but pure-pass-through
            // non-KO plans fall through to the fallback.
            let outcome;
            if (wouldWinByPrizes || wouldWinByNoPokemon) outcome = 'WIN_GAME';
            else if (willKO)                             outcome = 'KO';
            else                                         outcome = 'DAMAGE';

            best = {
              score,
              outcome,
              preStep,           // null | { kind, handIdx?, benchIdx?, energyDiscardCount }
              target,            // { benchIdx, card, gustHandIdx }
              attachList,        // [{ name, handIdx }, ...]
              plusPowerCount: pp,
              attack: atk,
              expectedDamage: dmg,
              willKO,
              willSurvive,
              wouldWinByPrizes,
              wouldWinByNoPokemon,
            };
          }
        }
      }
    }
  }

  // ── No-attack rescue branch ─────────────────────────────────────────────
  // If we didn't find ANY attack plan, and we have a preStep (evolve / breeder
  // / retreat / switch), we may still want to commit to the preStep purely
  // for defensive value — e.g. Breeder onto Nidoqueen to escape a KO even
  // though Nidoqueen has no affordable attack this turn.
  //
  // Baseline plans with no preStep aren't emitted here — passing without a
  // preStep is what the fallback pipeline does by default. Only preStep plans
  // bring value the fallback can't reconstruct.
  //
  // Scoring is survival-based: +50,000 if we'd survive, nothing otherwise,
  // minus the preStep cost. This naturally places no-attack rescue plans
  // between "do nothing and die" (0 score) and "attack and die" (damage only).
  if (!best && preStep) {
    // Compute post-preStep survival against opponent's next turn.
    // The attacker state already reflects the post-preStep Pokémon — the
    // caller built it that way (evolve carries over energy/damage, retreat
    // uses the bench card, etc.). Threat is what the opponent's CURRENT
    // active (and reachable bench) can do to our active after this turn.
    const counterDamage = opponentThreatNextTurn(p1, { ...p2, active: attacker });
    const willSurvive = counterDamage < hpLeft;

    let score = 0;
    if (willSurvive) score += 50_000;

    // preStep cost — same as the attack branches above.
    if (preStep.kind === 'evolve')  score -= 20;
    if (preStep.kind === 'breeder') score -= 25;
    if (preStep.kind === 'switch')  score -= 15;
    if (preStep.kind === 'retreat') score -= (preStep.energyDiscardCount || 0) * 8;

    // Opp-last-prize suicide penalty: if we'd still die, don't make a play
    // that hands them the game. But in the no-attack case we're spending
    // cards for no upside, which is worse than just passing → only emit the
    // plan when survival is actually achieved.
    if (!willSurvive) return null;

    best = {
      score,
      outcome: 'RESCUE',         // distinct from KO/DAMAGE — signals "no attack"
      preStep,
      target: { benchIdx: null, card: p1.active, gustHandIdx: null },
      attachList: [],
      plusPowerCount: 0,
      attack: null,              // no-attack plan
      expectedDamage: 0,
      willKO: false,
      willSurvive: true,
      wouldWinByPrizes: false,
      wouldWinByNoPokemon: false,
    };
  }

  return best;
}

// ── KO Plan search ──────────────────────────────────────────────────────────
// Public API: find the best attack plan using the CURRENT active (no evolve,
// no retreat). Preserved for backward compatibility with tests and callers
// that don't need to consider preStep transformations.
//
// For the full goal-directed turn planner, use aiBuildTurnPlan below.
function aiFindBestKOPlan(p2, p1) {
  if (!p2?.active || !p1?.active) return null;
  return evaluateAttackerPlan(p2.active, p2, p1, null);
}

// ── Pokémon Breeder lineage lookup ───────────────────────────────────────────
// Determine the Basic Pokémon that a Stage 2 evolves from via Pokémon Breeder.
// Breeder skips the Stage 1, so this is a two-step chain lookup:
//   stage2.evolvesFrom  → Stage 1 name  → Stage 1.evolvesFrom → Basic name
// Gender-line Stage 2s use a hardcoded mapping (Nidoqueen ← Nidoran ♀, etc.)
// via genderLineBasicFor, because the gender-symbol naming breaks naive lookup.
//
// Returns the Basic Pokémon name that this Stage 2 can be played onto via
// Breeder, or null if the chain can't be resolved (Stage 1 not in player's
// cards — rare, since decks almost always carry the Stage 1).
function breederRootBasicName(stage2Card, player) {
  if (!stage2Card) return null;
  if (typeof genderLineBasicFor === 'function') {
    const gl = genderLineBasicFor(stage2Card.name);
    if (gl) return gl;
  }
  const stage1Name = stage2Card.evolvesFrom;
  if (!stage1Name) return null;
  const allCards = [
    ...(player?.hand || []),
    ...(player?.discard || []),
    ...(player?.deck || []),
  ];
  const stage1 = allCards.find(c =>
    c?.name === stage1Name && c.subtypes?.includes('Stage 1')
  );
  return stage1?.evolvesFrom || null;
}

// ── Goal-directed turn planner ──────────────────────────────────────────────
// Build a plan for the current turn by enumerating attacker configurations:
//
//   1. Current active, no transformation (baseline — same as aiFindBestKOPlan)
//   2. Current active evolved with a Stage 1/2 from hand (carries energy over)
//   3. Retreat current active, promote bench-N (must afford retreat cost)
//   4. Switch: play Switch trainer, promote bench-N (no retreat cost)
//
// For each configuration, run evaluateAttackerPlan and keep the best.
//
// Guardrails on enumeration:
//   • Evolve: only if the active was not placed/evolved this turn
//   • Evolve: checks prehistoricPowerActive (Aerodactyl blocks all evolution)
//   • Retreat: requires active's attached energy >= retreat cost, and active
//     not paralyzed/asleep
//   • Switch: requires a Switch card in hand, and active not blocked (asleep/
//     paralyzed don't block Switch — it explicitly says "Switch" ignores them)
//
// Scope limits:
//   • Does NOT consider Scoop Up as a retreat alternative (loses all energy)
//   • Does NOT evolve a benched Pokémon then retreat into it (too combinatorial
//     and rare-to-correct)
//   • Does NOT combine preSteps (e.g. retreat then evolve the new active)
//
// Returns null when no plan has a viable attack.
function aiBuildTurnPlan(p2, p1) {
  if (!p2 || !p1) return null;

  const candidates = [];

  // 1. Baseline — current active as attacker, no preStep.
  if (p2.active) {
    const plan = evaluateAttackerPlan(p2.active, p2, p1, null);
    if (plan) candidates.push(plan);
  }

  // 2. Evolve current active.
  const evolvedUids = G.evolvedThisTurn || [];
  const evolveBlocked = (typeof prehistoricPowerActive === 'function') && prehistoricPowerActive();
  if (p2.active && !evolveBlocked && !evolvedUids.includes(p2.active.uid)) {
    const hand = p2.hand || [];
    for (let i = 0; i < hand.length; i++) {
      const evoCard = hand[i];
      if (evoCard?.supertype !== 'Pokémon') continue;
      if (!evoCard.subtypes?.includes('Stage 1') && !evoCard.subtypes?.includes('Stage 2')) continue;
      if (evoCard.evolvesFrom !== p2.active.name) continue;

      // Build the post-evolve attacker: inherit attached energy + damage.
      const evolvedActive = {
        ...evoCard,
        attachedEnergy: p2.active.attachedEnergy || [],
        damage: p2.active.damage || 0,
        status: null,          // evolving cures status
        plusPower: 0,
        defender: false,
        disabledAttack: null,  // Amnesia etc. wear off on evolve
      };
      const plan = evaluateAttackerPlan(evolvedActive, p2, p1, {
        kind: 'evolve',
        handIdx: i,
        zone: 'active',
      });
      if (plan) candidates.push(plan);
    }
  }

  // 2b. Pokémon Breeder — play a Stage 2 directly onto a matching Basic active,
  //     skipping Stage 1. Gated on having BOTH the Breeder trainer and the
  //     Stage 2 in hand, and on the active being a non-just-placed Basic that
  //     matches the Stage 2's root lineage.
  //
  //     This handles the case where the active is about to die but the player
  //     has Breeder + Stage 2 in hand — e.g. Nidoran about to be KO'd, hand
  //     has Nidoqueen (90 HP) + Breeder → Breeder rescues the Pokémon by
  //     jumping straight to Stage 2 with more HP.
  if (p2.active && !evolveBlocked && !evolvedUids.includes(p2.active.uid) &&
      p2.active.subtypes?.includes('Basic')) {
    const hand = p2.hand || [];
    const breederIdxs = [];
    for (let i = 0; i < hand.length; i++) {
      if (hand[i]?.name === 'Pokémon Breeder') breederIdxs.push(i);
    }
    if (breederIdxs.length > 0) {
      for (let i = 0; i < hand.length; i++) {
        const s2 = hand[i];
        if (s2?.supertype !== 'Pokémon') continue;
        if (!s2.subtypes?.includes('Stage 2')) continue;
        // Resolve the root Basic. Without a match, can't breeder this Stage 2.
        const rootBasic = breederRootBasicName(s2, p2);
        if (!rootBasic || rootBasic !== p2.active.name) continue;

        // Post-Breeder attacker: same energy/damage carryover as normal evolve.
        // Stage 1 is skipped entirely (no Stage 1 card leaves/enters play).
        const evolvedActive = {
          ...s2,
          attachedEnergy: p2.active.attachedEnergy || [],
          damage: p2.active.damage || 0,
          status: null,
          plusPower: 0,
          defender: false,
          disabledAttack: null,
        };
        // Use the FIRST Breeder in hand for the preStep.
        const plan = evaluateAttackerPlan(evolvedActive, p2, p1, {
          kind: 'breeder',
          handIdx: i,                    // index of Stage 2 in hand
          breederHandIdx: breederIdxs[0],// index of Breeder trainer in hand
          zone: 'active',
        });
        if (plan) candidates.push(plan);
      }
    }
  }

  // 3. Retreat — for each bench Pokémon, simulate retreating into it.
  if (p2.active &&
      p2.active.status !== 'paralyzed' &&
      p2.active.status !== 'asleep') {
    const baseRetreat = p2.active.convertedRetreatCost || 0;
    const discount = (typeof retreatCostReduction === 'function') ? retreatCostReduction(2) : 0;
    const retreatCost = Math.max(0, baseRetreat - discount);
    const attachedValue = energyValue(p2.active.attachedEnergy || []);
    if (attachedValue >= retreatCost) {
      for (let b = 0; b < (p2.bench?.length || 0); b++) {
        const benchCard = p2.bench[b];
        if (!benchCard) continue;
        // The bench card becomes the new active with its CURRENT attached
        // energy. The retreat cost is discarded from the OLD active's energy,
        // which doesn't affect our this-turn attack with the new active.
        const plan = evaluateAttackerPlan(benchCard, p2, p1, {
          kind: 'retreat',
          benchIdx: b,
          energyDiscardCount: retreatCost,
        });
        if (plan) candidates.push(plan);
      }
    }
  }

  // 4. Switch card — free retreat via trainer card.
  {
    const hand = p2.hand || [];
    const switchIdx = hand.findIndex(c => c?.name === 'Switch');
    if (switchIdx !== -1 && p2.active) {
      for (let b = 0; b < (p2.bench?.length || 0); b++) {
        const benchCard = p2.bench[b];
        if (!benchCard) continue;
        const plan = evaluateAttackerPlan(benchCard, p2, p1, {
          kind: 'switch',
          handIdx: switchIdx,
          benchIdx: b,
        });
        if (plan) candidates.push(plan);
      }
    }
  }

  if (!candidates.length) return null;

  // Pick the top-scoring plan across all attacker configurations.
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

// ── Plan execution ───────────────────────────────────────────────────────────
// Execute a plan produced by aiBuildTurnPlan or aiFindBestKOPlan. Runs any
// preStep (evolve, retreat, switch) before the attack sequence. Mutates game
// state via the same primitives the rest of the AI uses.
//
// Order of operations (all conditional on plan fields):
//   1. preStep  (evolve the active, retreat, or play Switch)
//   2. Gust of Wind on opposing bench target
//   3. PlusPowers (one card at a time)
//   4. Energy attach(es) — may be multiple under Rain Dance
//   5. Attack
//
// Returns true when an attack fires. Caller is responsible for endTurn flow
// (performAttack → endTurn handles that path).
async function executeTurnPlan(plan, delayMs) {
  const p2 = G.players[2];
  const delay = ms => new Promise(r => setTimeout(r, ms));

  // 1. preStep
  if (plan.preStep) {
    const ok = await executePreStepOnly(plan.preStep, delayMs);
    if (!ok) return false;
  }

  // 2. Gust of Wind first, if the plan targets a bench Pokémon.
  if (plan.target.gustHandIdx !== null && plan.target.benchIdx !== null) {
    const p1 = G.players[1];
    const hand = p2.hand;
    const gustIdx = hand.findIndex(c => c?.name === 'Gust of Wind');
    if (gustIdx !== -1) {
      const card = hand.splice(gustIdx, 1)[0];
      p2.discard.push(card);
      const pulled = p1.bench[plan.target.benchIdx];
      p1.bench[plan.target.benchIdx] = p1.active;
      p1.active = pulled;
      while (p1.bench.length < 5) p1.bench.push(null);
      addLog(`🤖 Computer played Gust of Wind — pulled ${pulled.name} into the Active spot!`, true);
      renderAll();
      await delay(delayMs * 0.6);
    }
  }

  // 3. PlusPowers (one at a time).
  for (let n = 0; n < plan.plusPowerCount; n++) {
    const hand = p2.hand;
    const ppIdx = hand.findIndex(c => c?.name === 'PlusPower');
    if (ppIdx === -1) break;
    const card = hand.splice(ppIdx, 1)[0];
    p2.discard.push(card);
    p2.active.plusPower = (p2.active.plusPower || 0) + 10;
    addLog(`🤖 Computer played PlusPower on ${p2.active.name}.`, true);
    renderAll();
    await delay(delayMs * 0.4);
  }

  // 4. Energy attach(es). For Rain Dance the plan may list multiple.
  for (const attach of plan.attachList) {
    const hand = p2.hand;
    const idx = hand.findIndex(c => c?.supertype === 'Energy' && c.name === attach.name);
    if (idx === -1) continue;
    const energyName = hand[idx]?.name || '';
    const isRainDance = /water/i.test(energyName) && (typeof rainDanceActive === 'function') && rainDanceActive(2);
    attachEnergy(2, idx, 'active', null, isRainDance);
    addLog(`🤖 Computer attached energy to ${p2.active?.name}.`);
    renderAll();
    await delay(delayMs * 0.5);
  }

  // 5. Attack — or pass the turn if this is a rescue plan (no attack).
  if (plan.attack) {
    addLog(`🤖 Computer uses ${plan.attack.name}!`, true);
    aiThinking = false;
    await performAttack(2, plan.attack);
  } else {
    // No-attack rescue plan: preStep already fired. End turn without attacking.
    addLog(`🤖 Computer sets up and ends turn.`, true);
    aiThinking = false;
    if (G.started && G.turn === 2) endTurn();
  }
  return true;
}

// Execute just the preStep portion of a plan (evolve, retreat, or Switch).
// Separated from executeTurnPlan so aiTakeTurn can do a "partial commit" —
// apply the planner's preStep to get the right attacker in place, then fall
// through to the normal pipeline for everything else. Returns true on
// success, false on unexpected failure (e.g. evolution card missing).
async function executePreStepOnly(step, delayMs) {
  const p2 = G.players[2];
  const delay = ms => new Promise(r => setTimeout(r, ms));

  if (step.kind === 'evolve') {
    const plannedCardName = p2.hand[step.handIdx]?.name;
    const evoIdx = p2.hand.findIndex(c =>
      c?.name === plannedCardName && c?.evolvesFrom === p2.active?.name);
    if (evoIdx !== -1) {
      evolve(2, evoIdx, 'active', null);
      await delay(delayMs * 0.7);
      return true;
    }
    return false;
  }

  if (step.kind === 'breeder') {
    // Play Pokémon Breeder to evolve Basic active directly to Stage 2.
    // Mirrors the trainer-cards.js Breeder handler but with no picker —
    // the planner already chose both cards and verified legality.
    const plannedS2Name = p2.hand[step.handIdx]?.name;
    const s2Idx = p2.hand.findIndex(c =>
      c?.name === plannedS2Name && c.subtypes?.includes('Stage 2')
    );
    const breederIdx = p2.hand.findIndex(c => c?.name === 'Pokémon Breeder');
    if (s2Idx === -1 || breederIdx === -1 || !p2.active) return false;

    // Remove both cards from hand; discard Breeder. Stage 2 is placed on
    // top of the Basic active, inheriting damage + energy (same carryover
    // rules as normal evolve).
    // NOTE: indices may shift as we splice; resolve them in descending order.
    const hiIdx = Math.max(s2Idx, breederIdx);
    const loIdx = Math.min(s2Idx, breederIdx);
    const s2WasHigher = s2Idx > breederIdx;
    const hiCard = p2.hand.splice(hiIdx, 1)[0];
    const loCard = p2.hand.splice(loIdx, 1)[0];
    const s2Card = s2WasHigher ? hiCard : loCard;
    const breederCard = s2WasHigher ? loCard : hiCard;

    p2.discard.push(breederCard);

    // Apply carryover onto the Stage 2 card.
    s2Card.damage = p2.active.damage || 0;
    s2Card.attachedEnergy = p2.active.attachedEnergy || [];
    s2Card.status = null;
    s2Card.plusPower = 0;
    s2Card.defender = false;
    s2Card.disabledAttack = null;

    // Stack evolution chain so KO discards everything together (matches the
    // trainer-cards.js Breeder behavior via buildEvolutionStackUnder).
    if (typeof buildEvolutionStackUnder === 'function') {
      s2Card.prevStages = buildEvolutionStackUnder(p2.active);
    }

    // Track that this Pokémon was evolved this turn — can't evolve again.
    if (!G.evolvedThisTurn) G.evolvedThisTurn = [];
    G.evolvedThisTurn.push(s2Card.uid);

    const oldName = p2.active.name;
    p2.active = s2Card;

    addLog(`🤖 Computer used Pokémon Breeder — ${oldName} → ${s2Card.name}!`, true);
    renderAll();
    await delay(delayMs * 0.8);
    return true;
  }

  if (step.kind === 'retreat') {
    const active = p2.active;
    if (active && step.benchIdx != null && p2.bench[step.benchIdx]) {
      const cost = step.energyDiscardCount || 0;
      if (cost > 0 && active.attachedEnergy?.length) {
        let remaining = cost;
        while (remaining > 0 && active.attachedEnergy.length) {
          const e = active.attachedEnergy.shift();
          p2.discard.push(e);
          remaining -= /double colorless/i.test(e.name || '') ? 2 : 1;
        }
        addLog(`🤖 Computer discarded energy to retreat ${active.name}.`);
      }
      // Clear per-turn flags on the retreating Pokémon (match executeRetreat)
      active.leekSlapUsed = false;
      active.immuneToAttack = false;
      active.swordsDanceActive = false;
      active.destinyBond = false;
      active.pounceActive = false;
      if (active.status) active.status = null;
      // Swap
      const out = p2.bench[step.benchIdx];
      p2.bench[step.benchIdx] = active;
      p2.active = out;
      while (p2.bench.length < 5) p2.bench.push(null);
      addLog(`🤖 Computer retreated ${active.name} → sent out ${out.name}.`, true);
      renderAll();
      await delay(delayMs * 0.7);
      return true;
    }
    return false;
  }

  if (step.kind === 'switch') {
    const switchIdx = p2.hand.findIndex(c => c?.name === 'Switch');
    if (switchIdx !== -1 && step.benchIdx != null && p2.bench[step.benchIdx]) {
      const card = p2.hand.splice(switchIdx, 1)[0];
      p2.discard.push(card);
      const out = p2.bench[step.benchIdx];
      const old = p2.active;
      old.leekSlapUsed = false;
      old.immuneToAttack = false;
      old.swordsDanceActive = false;
      old.destinyBond = false;
      old.pounceActive = false;
      if (old.status) old.status = null;
      p2.bench[step.benchIdx] = old;
      p2.active = out;
      while (p2.bench.length < 5) p2.bench.push(null);
      addLog(`🤖 Computer played Switch — swapped ${old.name} for ${out.name}.`, true);
      renderAll();
      await delay(delayMs * 0.6);
      return true;
    }
    return false;
  }

  return false;
}

// Backward-compat wrapper — older callers may reference executeKOPlan.
async function executeKOPlan(plan, delayMs) {
  return executeTurnPlan(plan, delayMs);
}

async function aiChooseAndAttack() {
  const p2 = G.players[2];
  const p1 = G.players[1];
  if (!p2.active || !p1.active) return false;

  const card = p2.active;
  if (card.status === 'paralyzed' || card.status === 'asleep') return false;

  const oppActive = p1.active;

  const attacks = (card && isPowerActive(card, 'Transform') && dittoAttacks(2)) || card?.attacks || [];
  if (!attacks.length) return false;

  const oppWeaknesses  = oppActive.weaknesses  || [];
  const oppResistances = oppActive.resistances || [];

  function effectiveDamage(atk) {
    let dmg = parseInt((atk.damage || '0').replace(/[^0-9]/g, '')) || 0;
    if (dmg === 0) return 0;
    const atkTypes = card.types || [];
    if (oppWeaknesses.some(w => atkTypes.some(t => t.toLowerCase() === w.type.toLowerCase()))) dmg *= 2;
    if (oppResistances.some(r => atkTypes.some(t => t.toLowerCase() === r.type.toLowerCase()))) dmg = Math.max(0, dmg - 30);
    return dmg;
  }

  const affordable = attacks.filter(atk => {
    if (!canAffordAttack(card.attachedEnergy, atk.cost, card)) return false;
    if (card.disabledAttack && card.disabledAttack === atk.name) return false;
    if (atk.name === 'Conversion 1' && !oppWeaknesses.length) return false;
    return true;
  });
  if (!affordable.length) return false;

  if (aiDifficulty === 'easy' && Math.random() < 0.25) return false;

  const oppHpLeft = (parseInt(oppActive.hp) || 0) - (oppActive.damage || 0);

  // Prize awareness — a KO that wins the game trumps everything else.
  // If the opponent is on their last prize (oppPrizesLeft === 1) and we're
  // about to die, be extra aggressive: even a non-KO that has upside beats a
  // safe play if the safe play lets them KO us next turn.
  const myPrizesLeft    = prizesRemaining(p2);
  const oppPrizesLeft   = prizesRemaining(p1);
  const winsGameIfKO    = myPrizesLeft === 1;

  function attackScore(atk) {
    const eff = effectiveDamage(atk);
    const isKO = eff >= oppHpLeft;
    let score = eff;
    if (isKO) score += 1000;
    if (isKO && winsGameIfKO) score += 100000;
    return score;
  }

  const chosen = aiDifficulty === 'easy'
    ? affordable.reduce((best, atk) => {
        const dmg = parseInt((atk.damage||'0').replace(/[^0-9]/g,''))||0;
        const bestDmg = parseInt((best.damage||'0').replace(/[^0-9]/g,''))||0;
        return dmg > bestDmg ? atk : best;
      })
    : affordable.reduce((best, atk) => attackScore(atk) > attackScore(best) ? atk : best);

  addLog(`🤖 Computer uses ${chosen.name}!`, true);
  aiThinking = false;
  await performAttack(2, chosen);
  return true;
}

// ── Promotion ─────────────────────────────────────────────────────────────────
function aiDoPromotion() {
  if (!vsComputer || G.phase !== 'PROMOTE' || G.pendingPromotion !== 2) return;
  const p2 = G.players[2];
  const p1 = G.players[1];
  const oppActive = p1?.active || null;
  let bestIdx = -1, bestScore = -Infinity;
  for (let i = 0; i < RULES.BENCH_SIZE; i++) {
    if (!p2.bench[i]) continue;
    const score = benchPromotionScore(p2.bench[i], oppActive);
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  if (bestIdx === -1) {
    // No bench Pokémon left — P1 wins
    if (G.started) {
      addLog(`Computer has no Pokémon left — Player 1 wins!`, true);
      G.started = false;
      showWinScreen(1, 'OPPONENT HAS NO POKÉMON LEFT');
    }
    return;
  }
  resolvePromotion(2, bestIdx);
}

// ── Function hooks — deferred until game-actions.js is loaded ─────────────────
// endTurn, resolvePromotion, checkKO, doneSetup, loadDeck are defined in files
// that load after this one, so we patch them on window load.
window.addEventListener('load', () => {
  // Hook endTurn to trigger AI turn
  {
    const _orig = endTurn;
    endTurn = function() {
      _orig();
      if (vsComputer && G.started && G.turn === 2 && G.phase !== 'PROMOTE') {
        aiThinking = false;
        setTimeout(() => aiTakeTurn(), 900);
      }
    };
  }

  // Hook resolvePromotion to resume AI after promotion
  {
    const _orig = resolvePromotion;
    resolvePromotion = function(player, benchIdx) {
      _orig(player, benchIdx);
      if (vsComputer && G.started && G.turn === 2 && G.phase !== 'PROMOTE') {
        aiThinking = false;
        setTimeout(() => aiTakeTurn(), 900);
      }
    };
  }

  // Hook checkKO to detect when AI needs to pick a new active
  {
    const _orig = checkKO;
    checkKO = function(attackingPlayer, defendingPlayer, card, isSelf) {
      const result = _orig(attackingPlayer, defendingPlayer, card, isSelf);
      if (vsComputer && result === 'promote' && G.pendingPromotion === 2) {
        setTimeout(() => aiDoPromotion(), 400);
      }
      return result;
    };
  }

  // Hook doneSetup to trigger AI setup completion
  {
    const _orig = doneSetup;
    doneSetup = async function() {
      if (vsComputer && !G.players[2].active) {
        aiDoSetup();
      }
      await _orig();
    };
  }

  // Hook loadDeck to detect VS CPU deck load completion
  {
    const _origLoad = loadDeck;
    loadDeck = async function(fKey, deckName) {
      await _origLoad(fKey, deckName);
      if (document.getElementById('vs-computer-panel')?.style.display !== 'none') {
        checkVsCpuReady();
      }
    };
  }

  // Initial UI state
  setMidline('Load decks and press Start Game');
});

// ── Node export for tests — no-op in the browser ──────────────────────────────
// Guarded so nothing else is exported. The browser never executes this branch
// (module is undefined), so game-ai.js keeps working as a plain <script>.
if (typeof module !== 'undefined') {
  module.exports = {
    aiChooseEnergyTarget,
    aiEnergyDeficit,
    aiCanAttack,
    opponentThreatNextTurn,
    willActiveDieNextTurn,
    maxDamageForAttack,
    aiFindBestKOPlan,
    aiBuildTurnPlan,
    evaluateAttackerPlan,
    prizesRemaining,
    benchPromotionScore,
    breederRootBasicName,
  };
}
