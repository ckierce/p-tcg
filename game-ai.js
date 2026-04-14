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

  // Pick a Basic for Active — prefer Pokémon with attacks
  const basics = hand.reduce((acc, c, i) => {
    if (c.supertype === 'Pokémon' && c.subtypes?.includes('Basic')) acc.push({ c, i });
    return acc;
  }, []);
  if (!basics.length) return; // no basics — shouldn't happen after mulligan

  basics.sort((a, b) => (b.c.attacks?.length || 0) - (a.c.attacks?.length || 0));

  const activeChoice = basics[0];
  p2.active = activeChoice.c;
  hand.splice(activeChoice.i, 1);
  if (!G.evolvedThisTurn) G.evolvedThisTurn = [];
  G.evolvedThisTurn.push(activeChoice.c.uid);
  addLog(`🤖 Computer placed ${activeChoice.c.name} as Active.`, true);

  // Place remaining basics on bench (up to 2 on easy, 4 on normal/hard)
  const maxBench = aiDifficulty === 'easy' ? 2 : 4;
  let placed = 0;
  for (let attempt = hand.length - 1; attempt >= 0 && placed < maxBench; attempt--) {
    const card = hand[attempt];
    if (card.supertype === 'Pokémon' && card.subtypes?.includes('Basic')) {
      const slot = p2.bench.findIndex(s => s === null);
      if (slot === -1) break;
      p2.bench[slot] = card;
      G.evolvedThisTurn.push(card.uid);
      hand.splice(attempt, 1);
      addLog(`🤖 Computer placed ${card.name} on bench.`);
      placed++;
    }
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

    // 4. Play trainer cards
    await aiPlayTrainers();
    await delay(AI_DELAY * 0.5);

    // 5. Attach energy (one per turn unless Rain Dance)
    if (!G.energyPlayedThisTurn) {
      const hand = p2.hand;
      const energyIdx = hand.findIndex(c => c.supertype === 'Energy');
      if (energyIdx !== -1) {
        const target = aiChooseEnergyTarget(p2);
        if (target !== null) {
          const isRainDance = /water/i.test(hand[energyIdx].name) && rainDanceActive(2);
          attachEnergy(2, energyIdx, target.zone, target.idx, isRainDance);
          addLog(`🤖 Computer attached energy to ${target.zone === 'active' ? p2.active?.name : p2.bench[target.idx]?.name}.`);
          renderAll();
          await delay(AI_DELAY * 0.7);
        }
      }
    }

    // 6. Consider retreating if active is badly damaged
    if (aiDifficulty !== 'easy') {
      const retreated = await aiConsiderRetreat(p2);
      if (retreated) await delay(AI_DELAY);
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
function aiChooseEnergyTarget(p2) {
  // How many more energy does a Pokémon need to fire its cheapest attack?
  function energyNeeded(card) {
    if (!card?.attacks?.length) return 99;
    const attached = card.attachedEnergy || [];
    const haveTokens = energyValue(attached);
    let minDeficit = 99;
    for (const atk of card.attacks) {
      const cost = atk.cost || [];
      if (cost.length === 0) { minDeficit = 0; break; }
      const deficit = Math.max(0, cost.length - haveTokens);
      if (deficit < minDeficit) minDeficit = deficit;
    }
    return minDeficit;
  }

  const active = p2.active;
  if (active) {
    if (energyNeeded(active) > 0) return { zone: 'active', idx: null };
  }

  // Active is fully powered — charge the bench slot most in need
  let bestIdx = -1, bestDeficit = 0;
  for (let i = 0; i < RULES.BENCH_SIZE; i++) {
    const b = p2.bench[i];
    if (!b) continue;
    const deficit = energyNeeded(b);
    if (deficit > bestDeficit) { bestDeficit = deficit; bestIdx = i; }
  }
  if (bestIdx !== -1) return { zone: 'bench', idx: bestIdx };

  return null; // everyone fully powered
}

// ── Retreat consideration ─────────────────────────────────────────────────────
async function aiConsiderRetreat(p2, force = false) {
  if (!p2.active || !p2.bench.some(s => s)) return false;
  const active = p2.active;
  const hp = parseInt(active.hp) || 0;
  const dmg = active.damage || 0;
  const pctDmg = hp > 0 ? dmg / hp : 0;

  if (!force && pctDmg < 0.6) return false;
  const retreatCost = active.convertedRetreatCost || 0;
  if (energyValue(active.attachedEnergy) < retreatCost) return false;

  let bestBench = -1, bestScore = -1;
  for (let i = 0; i < RULES.BENCH_SIZE; i++) {
    const b = p2.bench[i];
    if (!b) continue;
    const score = (parseInt(b.hp) || 0) - (b.damage || 0);
    if (score > bestScore) { bestScore = score; bestBench = i; }
  }

  if (bestBench === -1) return false;

  executeRetreat(2, bestBench);
  addLog(`🤖 Computer retreated ${active.name}.`, true);
  renderAll();
  return true;
}

// ── Trainer play ──────────────────────────────────────────────────────────────
async function aiPlayTrainers() {
  if (aiDifficulty === 'easy' && Math.random() > 0.4) return;

  const p2 = G.players[2];
  const hand = p2.hand;
  const opp = G.players[1];
  const activeStatus = p2.active?.status;
  const isStatusBad = activeStatus === 'paralyzed' || activeStatus === 'asleep' || activeStatus === 'confused';

  // Priority: cure bad status conditions
  if (isStatusBad) {
    for (let i = hand.length - 1; i >= 0; i--) {
      const card = hand[i];
      if (card.supertype !== 'Trainer') continue;
      const name = card.name;

      if (name === 'Full Heal' || name === 'Full Restore') {
        hand.splice(i, 1);
        p2.discard.push(card);
        const cured = p2.active.status;
        p2.active.status = null;
        if (name === 'Full Restore') p2.active.damage = 0;
        addLog(`🤖 Computer played ${name} — cured ${p2.active.name} of ${cured}!`, true);
        renderAll();
        return;
      }

      if (name === 'Switch') {
        const benchSlots = p2.bench.map((s, i) => ({ s, i })).filter(x => x.s !== null);
        if (benchSlots.length) {
          let bestIdx = benchSlots[0].i, bestScore = -1;
          for (const { s, i: bi } of benchSlots) {
            const score = (parseInt(s.hp) || 0) - (s.damage || 0);
            if (score > bestScore) { bestScore = score; bestIdx = bi; }
          }
          hand.splice(i, 1);
          p2.discard.push(card);
          const old = p2.active;
          const clearedStatus = old.status;
          old.status = null;
          p2.active = p2.bench[bestIdx];
          p2.bench[bestIdx] = old;
          if (clearedStatus) addLog(`🤖 Computer played Switch — ${old.name}'s ${clearedStatus} cleared! Sent out ${p2.active.name}.`, true);
          else addLog(`🤖 Computer played Switch — swapped ${old.name} for ${p2.active.name}!`, true);
          renderAll();
          return;
        }
      }

      if (name === 'Scoop Up' && activeStatus === 'paralyzed') {
        const benchSlots = p2.bench.filter(s => s !== null);
        if (benchSlots.length) {
          hand.splice(i, 1);
          p2.discard.push(card);
          const scooped = p2.active;
          scooped.damage = 0; scooped.attachedEnergy = []; scooped.status = null;
          p2.hand.push(scooped);
          p2.active = null;
          let bestBench = 0, bestScore = -1;
          for (let b = 0; b < RULES.BENCH_SIZE; b++) {
            if (!p2.bench[b]) continue;
            const score = (parseInt(p2.bench[b].hp) || 0) - (p2.bench[b].damage || 0);
            if (score > bestScore) { bestScore = score; bestBench = b; }
          }
          p2.active = p2.bench[bestBench];
          p2.bench[bestBench] = null;
          addLog(`🤖 Computer played Scoop Up — returned ${scooped.name} to hand, sent out ${p2.active.name}!`, true);
          renderAll();
          return;
        }
      }
    }

    // No cure trainer — try retreating to escape status
    if (activeStatus === 'paralyzed' || activeStatus === 'asleep') {
      const retreated = await aiConsiderRetreat(p2, true);
      if (retreated) return;
    }
  }

  // Draw trainers and utility plays
  for (let i = hand.length - 1; i >= 0; i--) {
    const card = hand[i];
    if (card.supertype !== 'Trainer') continue;
    const name = card.name;

    if (name === 'Bill') {
      hand.splice(i, 1);
      p2.discard.push(card);
      for (let d = 0; d < 2 && p2.deck.length; d++) drawCard(2, true);
      addLog(`🤖 Computer played Bill — drew 2 cards.`, true);
      renderAll();
      return;
    }

    if (name === 'Professor Oak' && hand.length < 5) {
      p2.discard.push(...hand.splice(0));
      hand.length = 0;
      for (let d = 0; d < 7 && p2.deck.length; d++) drawCard(2, true);
      addLog(`🤖 Computer played Professor Oak — drew 7 cards.`, true);
      renderAll();
      return;
    }

    if (name === 'Potion' && p2.active && (p2.active.damage || 0) >= 30) {
      hand.splice(i, 1);
      p2.discard.push(card);
      p2.active.damage = Math.max(0, (p2.active.damage || 0) - RULES.POTION_HEAL);
      addLog(`🤖 Computer played Potion — healed ${p2.active.name} for ${RULES.POTION_HEAL}.`, true);
      renderAll();
      return;
    }

    if (name === 'Super Potion' && p2.active && (p2.active.damage || 0) >= 50 && (p2.active.attachedEnergy?.length || 0) > 0) {
      const removed = p2.active.attachedEnergy.splice(0, 1);
      p2.discard.push(...removed);
      hand.splice(i, 1);
      p2.discard.push(card);
      p2.active.damage = Math.max(0, (p2.active.damage || 0) - RULES.SUPER_POTION_HEAL);
      addLog(`🤖 Computer played Super Potion — healed ${p2.active.name} for ${RULES.SUPER_POTION_HEAL}.`, true);
      renderAll();
      return;
    }

    if (name === 'PlusPower' && p2.active && aiCanAttack(p2.active)) {
      hand.splice(i, 1);
      p2.discard.push(card);
      p2.active.plusPower = (p2.active.plusPower || 0) + 10;
      addLog(`🤖 Computer played PlusPower on ${p2.active.name}.`, true);
      renderAll();
      return;
    }
  }
}

// ── Attack selection ──────────────────────────────────────────────────────────
function aiCanAttack(card) {
  if (!card?.attacks?.length) return false;
  return card.attacks.some(atk => canAffordAttack(card.attachedEnergy, atk.cost, card));
}

async function aiChooseAndAttack() {
  const p2 = G.players[2];
  const p1 = G.players[1];
  if (!p2.active || !p1.active) return false;

  const card = p2.active;
  if (card.status === 'paralyzed' || card.status === 'asleep') return false;

  const attacks = (card && isPowerActive(card, 'Transform') && dittoAttacks(2)) || card?.attacks || [];
  if (!attacks.length) return false;

  const affordable = attacks.filter(atk =>
    canAffordAttack(card.attachedEnergy, atk.cost, card) &&
    !(card.disabledAttack && card.disabledAttack === atk.name)
  );
  if (!affordable.length) return false;

  if (aiDifficulty === 'easy' && Math.random() < 0.25) return false;

  let chosen;
  if (aiDifficulty === 'hard') {
    const oppHp = parseInt(p1.active.hp) || 0;
    const oppDmg = p1.active.damage || 0;
    const remaining = oppHp - oppDmg;
    chosen = affordable.reduce((best, atk) => {
      const dmg = parseInt((atk.damage || '0').replace(/[^0-9]/g, '')) || 0;
      const bestDmg = parseInt((best.damage || '0').replace(/[^0-9]/g, '')) || 0;
      return dmg >= remaining ? atk : (dmg > bestDmg ? atk : best);
    });
  } else {
    chosen = affordable.reduce((best, atk) => {
      const dmg = parseInt((atk.damage || '0').replace(/[^0-9]/g, '')) || 0;
      const bestDmg = parseInt((best.damage || '0').replace(/[^0-9]/g, '')) || 0;
      return dmg > bestDmg ? atk : best;
    });
  }

  addLog(`🤖 Computer uses ${chosen.name}!`, true);
  aiThinking = false; // release before async attack
  await performAttack(2, chosen);
  return true;
}

// ── Promotion ─────────────────────────────────────────────────────────────────
function aiDoPromotion() {
  if (!vsComputer || G.phase !== 'PROMOTE' || G.pendingPromotion !== 2) return;
  const p2 = G.players[2];
  let bestIdx = -1, bestScore = -1;
  for (let i = 0; i < RULES.BENCH_SIZE; i++) {
    if (!p2.bench[i]) continue;
    const hp = parseInt(p2.bench[i].hp) || 0;
    const dmg = p2.bench[i].damage || 0;
    const score = hp - dmg;
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  if (bestIdx === -1) return;
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
        setTimeout(() => aiDoPromotion(), 700);
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
