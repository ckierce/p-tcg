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

  function targetScore(card) {
    if (!card) return -1;
    const deficit = energyNeeded(card);
    if (deficit === 0) return 0;
    const typeBonus = energyName ? aiEnergyDeficit(card, energyName) : 0;
    return deficit + typeBonus * 2;
  }

  const active = p2.active;
  const activeEnables = active ? enablesAttack(active) : false;
  const activeScore = targetScore(active);

  let bestBenchIdx = -1, bestBenchScore = -1, bestBenchEnables = false;
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
  if (active) return { zone: 'active', idx: null };
  return null;
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

  function benchCandidateScore(b) {
    if (!b) return -Infinity;
    const remainingHp = (parseInt(b.hp) || 0) - (b.damage || 0);
    const canAttack = aiCanAttack(b);
    return remainingHp + (canAttack ? 100 : 0);
  }

  let bestBench = -1, bestScore = -Infinity;
  for (let i = 0; i < RULES.BENCH_SIZE; i++) {
    const b = p2.bench[i];
    if (!b) continue;
    const s = benchCandidateScore(b);
    if (s > bestScore) { bestScore = s; bestBench = i; }
  }
  if (bestBench === -1) return false;

  const bench = p2.bench[bestBench];
  const activeCanAttack = aiCanAttack(active);
  const benchCanAttack = aiCanAttack(bench);

  // Threat-aware: if active will die next turn and bench candidate will survive,
  // retreating saves a prize. This is the most important retreat signal and
  // overrides the old damage-percentage heuristic.
  const p1 = G.players[1];
  const activeDying = willActiveDieNextTurn(p2, p1);
  const benchHpLeft = (parseInt(bench.hp) || 0) - (bench.damage || 0);
  const benchThreat = opponentThreatNextTurn(p1, { ...p2, active: bench });
  const benchWouldSurvive = benchHpLeft > benchThreat;

  const shouldRetreat = force
    || (activeDying && benchWouldSurvive)
    || pctDmg >= 0.65
    || (!activeCanAttack && benchCanAttack)
    || (benchCandidateScore(bench) > benchCandidateScore(active) + 50 && pctDmg >= 0.4);

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
            let bestIdx = benchSlots[0].bi, bestScore = -1;
            for (const { s, bi } of benchSlots) {
              const score = (parseInt(s.hp)||0) - (s.damage||0) + (aiCanAttack(s) ? 100 : 0);
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
            let bestBench = 0, bestScore = -1;
            for (let b = 0; b < RULES.BENCH_SIZE; b++) {
              if (!p2.bench[b]) continue;
              const score = (parseInt(p2.bench[b].hp)||0) - (p2.bench[b].damage||0) + (aiCanAttack(p2.bench[b]) ? 100 : 0);
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
// can do to `defenderPlayer`'s active on their NEXT turn, assuming:
//   - They may attach up to one energy from their hand
//   - Coin-flip attacks resolve maximally in their favor (conservative for us)
//   - PlusPower in their hand adds +10 (they'd play it for a KO)
//   - Weakness/Resistance applied; Invisible Wall / Defender / etc. ignored
//     (those are our mitigations — threat = "what lands if unmitigated")
//
// Pure helper — no side effects, no DOM. Exported for tests.
function opponentThreatNextTurn(attackerPlayer, defenderPlayer) {
  const atk = attackerPlayer?.active;
  const def = defenderPlayer?.active;
  if (!atk || !def || !atk.attacks?.length) return 0;

  // Paralysis prevents attacking next turn — paralysis wears off at the end of
  // the paralyzed player's turn, but the attack resolves BEFORE that cleanup.
  if (atk.status === 'paralyzed') return 0;

  // Enumerate energy-attachment possibilities: no attach, or attach each
  // distinct energy type the attacker has in hand.
  const hand = attackerPlayer.hand || [];
  const energyNamesInHand = [...new Set(
    hand.filter(c => c?.supertype === 'Energy').map(c => c.name)
  )];
  const attachmentOptions = [null, ...energyNamesInHand.map(n => ({ name: n }))];

  const hasPlusPower = hand.some(c => c?.name === 'PlusPower');
  const weaknesses = def.weaknesses || [];
  const resistances = def.resistances || [];
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

      // Use text-aware max damage so Comet Punch reads as 80, not 20.
      let dmg = maxDamageForAttack(move, energyCount);
      if (dmg === 0) continue;

      // Apply weakness/resistance
      dmg = computeDamageAfterWR(dmg, atkTypes, weaknesses, resistances);

      // PlusPower available → assume they'd play it
      if (hasPlusPower) dmg += 10;

      // Attack-reduction debuff on the attacker (e.g., from our Scrunch)
      dmg = Math.max(0, dmg - attackReduction);

      if (dmg > maxDmg) maxDmg = dmg;
    }
  }

  return maxDmg;
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

  function attackScore(atk) {
    const eff = effectiveDamage(atk);
    const koBonus = eff >= oppHpLeft ? 1000 : 0;
    return eff + koBonus;
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
  let bestIdx = -1, bestScore = -Infinity;
  for (let i = 0; i < RULES.BENCH_SIZE; i++) {
    if (!p2.bench[i]) continue;
    const hp = parseInt(p2.bench[i].hp) || 0;
    const dmg = p2.bench[i].damage || 0;
    const canAttack = aiCanAttack(p2.bench[i]);
    const score = (hp - dmg) + (canAttack ? 200 : 0);
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
  };
}
