// ══════════════════════════════════════════════════════════════════════════════
// GAME-AI.JS — VS Computer AI logic
//
// Covers: VS Computer setup, AI turn loop, energy targeting, retreat logic,
//   trainer play, Pokémon Power use, attack selection, promotion, and hooks.
//
// Architecture (top to bottom):
//   1. State + lobby glue (difficulty, VS Computer panel, game start)
//   2. Damage model — attackProfile() turns an attack's text into a probability
//      distribution over damage plus its side effects (self-damage, status,
//      energy discards, protection, bench damage...). Every decision in the
//      file is built on this one model so the AI values coin flips, recoil,
//      status effects and energy costs consistently.
//   3. Threat model — what the opponent can do to a given Pokémon next turn.
//      The decision paths do NOT read the human's hand (that would be cheating);
//      they assume the opponent may attach one energy of whatever type they
//      need. The legacy opponentThreatNextTurn() keeps its hand-peeking,
//      worst-case semantics because tests pin it and because it is only used
//      as a conservative fallback.
//   4. Turn planner — enumerates attacker configurations (stay / evolve /
//      Breeder / retreat / Switch / Step In / Scoop Up) × energy attach ×
//      PlusPower × Gust target × attack, scores each with the damage + threat
//      models, and picks the best. Score buckets: win the game ≫ KO ≫ survive
//      ≫ damage progress ≫ resource costs.
//   5. Turn execution — draw/search trainers first (so drawn cards can be used
//      this turn), bench, evolve, powers, disruption/heal trainers, plan,
//      energy, attack.
//   6. Hooks into endTurn / resolvePromotion / checkKO / doneSetup / loadDeck.
//
// The AI is player-parametric (aiPlayerNum) so the headless simulator
// (ai-sim.js) can seat it as either player. In the browser it is always P2.
//
// Depends on globals: G, myRole, trainerName, currentUser, roomCode, gameRef,
//   db, generateCode, endTurn, resolvePromotion, checkKO, koBenchAndPrize,
//   doneSetup, loadDeck, startGame, performAttack, evolve, attachEnergy,
//   drawCard, shuffle, addLog, renderAll, showToast, showPanel, setMidline,
//   updatePhase, transitionPhase, canAffordAttack, energyValue, RULES,
//   computeDamageAfterWR, parseStatusEffects, clearAllStatus,
//   clearActiveOnlyEffects, buildEvolutionStackUnder, genderLineBasicFor,
//   rainDanceActive, isPowerActive, hasInvisibleWall, dittoAttacks,
//   prehistoricPowerActive, retreatCostReduction, energyTransActive,
//   damageSwapActive, isMukActive, CARD_DATA, document
// ══════════════════════════════════════════════════════════════════════════════

// ── State ────────────────────────────────────────────────────────────────────
let vsComputer = false;     // true when playing against AI
let aiDifficulty = 'normal'; // 'easy' | 'normal' | 'hard'
let aiThinking = false;     // guard against re-entrant AI turns
let aiPlayerNum = 2;        // which seat the AI occupies (2 in the browser)

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
    document.querySelector('#vs-computer-panel .setup-player.p2')?.classList.toggle('loaded', p2loaded);
  }

  const btn = document.getElementById('start-cpu-btn');
  if (btn) btn.disabled = !(p1loaded && p2loaded);
}

async function startVsCpuGame() {
  vsComputer = true;
  aiPlayerNum = 2;
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

// ══════════════════════════════════════════════════════════════════════════════
// SMALL HELPERS
// ══════════════════════════════════════════════════════════════════════════════

const AI_LOG_PREFIX = '🤖 Computer';

function aiMe()  { return G.players[aiPlayerNum]; }
function aiOpp() { return G.players[aiPlayerNum === 1 ? 2 : 1]; }
function aiOppNum() { return aiPlayerNum === 1 ? 2 : 1; }

function aiHp(card)     { return parseInt(card?.hp) || 0; }
function aiHpLeft(card) { return Math.max(0, aiHp(card) - (card?.damage || 0)); }
function aiBaseDamage(atk) { return parseInt((atk?.damage || '0').replace(/[^0-9]/g, '')) || 0; }
function aiSpecialStatus(card) { return card?.special ?? card?.status ?? null; }
function aiIsBasic(c) { return c?.supertype === 'Pokémon' && !!c.subtypes?.includes('Basic'); }
function aiIsEvolution(c) {
  return c?.supertype === 'Pokémon' && (!!c.subtypes?.includes('Stage 1') || !!c.subtypes?.includes('Stage 2'));
}
function aiStage(c) {
  if (c?.subtypes?.includes('Stage 2')) return 2;
  if (c?.subtypes?.includes('Stage 1')) return 1;
  return 0;
}
function aiEnergyType(name) {
  if (/double colorless/i.test(name || '')) return 'Colorless';
  return (name || '').replace(/\s*energy/i, '').trim() || 'Colorless';
}
function aiAllInPlay(p) { return [p?.active, ...(p?.bench || [])].filter(Boolean); }
function aiBenchCount(p) { return (p?.bench || []).filter(Boolean).length; }
function aiFreeBenchSlot(p) { return (p?.bench || []).findIndex(s => s === null); }
function aiClamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function aiRand() { return Math.random(); }

// Attacks a card can use right now (Ditto borrows the opponent's via Transform).
function aiAttacksOf(card, playerNum) {
  if (!card) return [];
  if (playerNum != null && typeof isPowerActive === 'function' && typeof dittoAttacks === 'function'
      && isPowerActive(card, 'Transform')) {
    const copied = dittoAttacks(playerNum);
    if (copied && copied.length) return copied;
  }
  return card.attacks || [];
}

// Energy tokens a Pokémon still needs before its most expensive attack is
// affordable. 0 = fully powered. Water Gun / Hydro Pump users get +2 because
// extra Water energy adds damage.
function aiUsefulEnergyCap(card) {
  const attacks = card?.attacks || [];
  if (!attacks.length) return 0;
  let cap = 0;
  for (const atk of attacks) {
    let c = (atk.cost || []).length;
    if (/^(Water Gun|Hydro Pump)$/i.test(atk.name || '')) c += 2;
    if (c > cap) cap = c;
  }
  return cap;
}

function aiCanAttack(card) {
  if (!card?.attacks?.length) return false;
  return card.attacks.some(atk => canAffordAttack(card.attachedEnergy, atk.cost, card));
}

// Deck-out awareness: can we afford to draw `n` extra cards right now?
// We need roughly two turns per prize still to take, plus a small cushion,
// because the mandatory draw each turn will otherwise deck us out.
function aiCanAffordDraw(n, p) {
  const me = p || aiMe();
  const deck = (me.deck || []).length;
  const turnsNeeded = Math.max(4, Math.round(prizesRemaining(me) * 2.5));
  return deck - n >= turnsNeeded;
}

// ══════════════════════════════════════════════════════════════════════════════
// PRIZE AWARENESS
// ══════════════════════════════════════════════════════════════════════════════
// Number of prizes the given player still has to take (the prize cards that
// will be given to their OPPONENT when the opponent KOs one of their Pokémon).
// In this codebase each player's `prizes` array is the pile THEY draw from,
// so prizes remaining for player N = count of non-null entries in p[N].prizes.
function prizesRemaining(playerObj) {
  if (!playerObj?.prizes) return 6;
  return playerObj.prizes.filter(p => p).length;
}

// ══════════════════════════════════════════════════════════════════════════════
// DAMAGE MODEL
// ══════════════════════════════════════════════════════════════════════════════

// Binomial distribution helper: P(k heads in n flips) × perHeads damage.
function aiBinomialOutcomes(n, per, base = 0) {
  n = Math.max(0, n | 0);
  const out = [];
  let coef = 1;
  for (let k = 0; k <= n; k++) {
    if (k > 0) coef = coef * (n - k + 1) / k;
    out.push({ p: coef / Math.pow(2, n), dmg: base + k * per });
  }
  return out;
}

// Merge equal-damage outcomes.
function aiMergeOutcomes(list) {
  const m = new Map();
  for (const o of list) m.set(o.dmg, (m.get(o.dmg) || 0) + o.p);
  return [...m.entries()].map(([dmg, p]) => ({ dmg, p })).sort((a, b) => a.dmg - b.dmg);
}

function aiExpected(outcomes) { return outcomes.reduce((s, o) => s + o.p * o.dmg, 0); }
function aiProbAtLeast(outcomes, x) { return outcomes.reduce((s, o) => s + (o.dmg >= x ? o.p : 0), 0); }
function aiMaxOutcome(outcomes) { return outcomes.reduce((m, o) => Math.max(m, o.dmg), 0); }

// Max possible damage of a single attack, treating all coin flips as heads.
// Kept for compatibility — the planner uses attackProfile() below.
function maxDamageForAttack(move, energyCount) {
  const prof = attackProfile(move, { attachedEnergy: [], attacks: [move] }, null, { energyCount });
  return aiMaxOutcome(prof.raw);
}

// attackProfile — describe an attack as a distribution over raw damage (before
// PlusPower / Weakness / Resistance / defender modifiers) plus side effects.
//
//   move       attack object { name, cost, damage, text }
//   attacker   the Pokémon using it (for Flail/Rage/Water Gun/Swords Dance...)
//   defender   the Pokémon receiving it (for Meditate/Psychic/Super Fang...)
//   ctx        { energyCount, ownBenchCount, oppBenchCount, nidokings,
//                lastAttackDamage, oppAsleep }
//
// Returns:
//   raw:            [{p, dmg}]           damage outcomes to the defender
//   self:           [{p, dmg}]           self-damage outcomes (independent)
//   selfKO:         bool                 self-damage is unconditional and lethal-sized (Selfdestruct)
//   statusOpp:      [{p, status}]        statuses applied to the defender
//   statusSelf:     [{p, status}]
//   discardEnergy:  n                    energy discarded from attacker as cost (Infinity = all)
//   protect:        {p, kind}            'full' | 'threshold30' | 'minus20' | 'minus10' | 'immune'
//   smokescreen:    bool                 defender must flip to attack next turn
//   heal:           n | 'all' | {frac}   self heal
//   draw:           n
//   benchOpp:       {dmg, count|'all'}   damage to opposing bench
//   benchSelf:      {dmg, count|'all'}
//   oppEnergyDiscard: n
//   forceSwitch:    'attacker' | 'opponent' | 'self' | null
//   disable:        bool                 Amnesia
//   skipWR:         bool
//   unusable:       bool                 cannot be used right now (Dream Eater w/o sleep, Leek Slap used)
//   misc:           number               small flat bonus for effects not otherwise modelled
function attackProfile(move, attacker, defender, ctx = {}) {
  const name = move?.name || '';
  const text = move?.text || '';
  const t = text.toLowerCase();
  const base = aiBaseDamage(move);
  const energyCount = ctx.energyCount != null ? ctx.energyCount : energyValue(attacker?.attachedEnergy || []);
  const ownCounters = Math.floor((attacker?.damage || 0) / 10);
  const defCounters = Math.floor((defender?.damage || 0) / 10);

  const prof = {
    raw: null, self: [], selfKO: false, statusOpp: [], statusSelf: [],
    discardEnergy: 0, protect: null, smokescreen: false, heal: 0, draw: 0,
    benchOpp: null, benchSelf: null, oppEnergyDiscard: 0, forceSwitch: null,
    disable: false, skipWR: false, unusable: false, misc: 0, cantRetreat: 0,
    swordsDance: false, destinyBond: false, trainerBlock: false, hurricane: false,
  };
  let coinHandled = false; // mirrors atk._coinFlipHandled → status flips skipped

  // ── Named attacks whose damage is computed in MOVE_EFFECTS.modifyDamage ────
  switch (name) {
    case 'Water Gun': case 'Hydro Pump': {
      const waterInCost = (move.cost || []).filter(c => /water/i.test(c)).length;
      const waterAttached = (attacker?.attachedEnergy || []).filter(e => /water/i.test(e.name)).length;
      const extras = Math.max(0, waterAttached - waterInCost);
      prof.raw = [{ p: 1, dmg: base + Math.min(extras, 2) * 10 }];
      break;
    }
    case 'Thrash': case 'Thunderpunch':
      prof.raw = [{ p: 0.5, dmg: 40 }, { p: 0.5, dmg: 30 }];
      prof.self = [{ p: 0.5, dmg: 10 }];
      coinHandled = true;
      break;
    case 'Clamp':
      prof.raw = [{ p: 0.5, dmg: base }, { p: 0.5, dmg: 0 }];
      prof.statusOpp.push({ p: 0.5, status: 'paralyzed' });
      coinHandled = true;
      break;
    case 'Boyfriends':
      prof.raw = [{ p: 1, dmg: 20 + (ctx.nidokings || 0) * 20 }];
      break;
    case 'Do the Wave':
      prof.raw = [{ p: 1, dmg: 10 + (ctx.ownBenchCount || 0) * 10 }];
      break;
    case 'Flail':
      prof.raw = [{ p: 1, dmg: ownCounters * 10 }];
      break;
    case 'Rage':
      prof.raw = [{ p: 1, dmg: 10 + ownCounters * 10 }];
      break;
    case 'Rampage':
      prof.raw = [{ p: 1, dmg: 20 + ownCounters * 10 }];
      prof.statusSelf.push({ p: 0.5, status: 'confused' });
      break;
    case 'Karate Chop':
      prof.raw = [{ p: 1, dmg: Math.max(0, 50 - ownCounters * 10) }];
      break;
    case 'Meditate':
      prof.raw = [{ p: 1, dmg: base + defCounters * 10 }];
      break;
    case 'Psychic':
      prof.raw = [{ p: 1, dmg: 10 + (defender?.attachedEnergy || []).length * 10 }];
      break;
    case 'Super Fang':
      prof.raw = [{ p: 1, dmg: Math.ceil(Math.max(0, aiHpLeft(defender)) / 2 / 10) * 10 }];
      prof.skipWR = true;
      break;
    case 'Sonicboom':
      prof.raw = [{ p: 1, dmg: base }];
      prof.skipWR = true;
      break;
    case 'Slash':
      prof.raw = [{ p: 1, dmg: attacker?.swordsDanceActive ? 60 : base }];
      break;
    case 'Leek Slap':
      if (attacker?.leekSlapUsed) prof.unusable = true;
      prof.raw = [{ p: 0.5, dmg: base }, { p: 0.5, dmg: 0 }];
      coinHandled = true;
      break;
    case 'Mirror Move':
      prof.raw = [{ p: 1, dmg: ctx.lastAttackDamage || 0 }];
      prof.skipWR = true;
      break;
    case 'Dream Eater':
      if (!ctx.oppAsleep) prof.unusable = true;
      prof.raw = [{ p: 1, dmg: base }];
      break;
    case 'Tantrum':
      prof.raw = [{ p: 1, dmg: base }];
      prof.statusSelf.push({ p: 0.5, status: 'confused' });
      break;
    case 'Petal Dance':
      prof.raw = aiBinomialOutcomes(3, 40);
      prof.statusSelf.push({ p: 1, status: 'confused' });
      coinHandled = true;
      break;
    case 'Foul Odor':
      prof.raw = [{ p: 1, dmg: base }];
      prof.statusOpp.push({ p: 1, status: 'confused' });
      prof.statusSelf.push({ p: 1, status: 'confused' });
      break;
    case 'Foul Gas':
      prof.raw = [{ p: 1, dmg: base }];
      prof.statusOpp.push({ p: 0.5, status: 'poisoned' }, { p: 0.5, status: 'confused' });
      break;
    case 'Venom Powder':
      prof.raw = [{ p: 1, dmg: base }];
      prof.statusOpp.push({ p: 0.5, status: 'confused' }, { p: 0.5, status: 'poisoned' });
      break;
    case 'Toxic':
      prof.raw = [{ p: 1, dmg: base }];
      prof.statusOpp.push({ p: 1, status: 'poisoned-toxic' });
      break;
    case 'Blizzard':
      prof.raw = [{ p: 1, dmg: base }];
      prof.benchOpp = { dmg: 10, count: 'all', p: 0.5 };
      prof.benchSelf = { dmg: 10, count: 'all', p: 0.5 };
      break;
    case 'Thunderstorm':
      prof.raw = [{ p: 1, dmg: base }];
      prof.benchOpp = { dmg: 20, count: 'all', p: 0.5 };
      prof.self = [{ p: 1, dmg: 5 * (ctx.oppBenchCount || 0) }]; // expected 10 × tails
      break;
    case 'Earthquake':
      prof.raw = [{ p: 1, dmg: base }];
      prof.benchSelf = { dmg: 10, count: 'all', p: 1 };
      break;
    case 'Chain Lightning':
      prof.raw = [{ p: 1, dmg: base }];
      prof.benchOpp = { dmg: 10, count: 'type', p: 1 };
      prof.benchSelf = { dmg: 10, count: 'type', p: 1 };
      break;
    case 'Gigashock':
      prof.raw = [{ p: 1, dmg: base }];
      prof.benchOpp = { dmg: 10, count: 3, p: 1 };
      break;
    case 'Dark Mind': case 'Spark':
      prof.raw = [{ p: 1, dmg: base }];
      prof.benchOpp = { dmg: 10, count: 1, p: 1 };
      break;
    case 'Stretch Kick':
      prof.raw = [{ p: 1, dmg: 0 }];
      prof.benchOpp = { dmg: 20, count: 1, p: 1 };
      break;
    case 'Hyper Beam': case 'Whirlpool':
      prof.raw = [{ p: 1, dmg: base }];
      prof.oppEnergyDiscard = 1;
      break;
    case 'Amnesia':
      prof.raw = [{ p: 1, dmg: 0 }];
      prof.disable = true;
      break;
    case 'Headache':
      prof.raw = [{ p: 1, dmg: 0 }];
      prof.trainerBlock = true;
      break;
    case 'Lure':
      prof.raw = [{ p: 1, dmg: 0 }];
      prof.forceSwitch = 'attacker';
      break;
    case 'Whirlwind': case 'Ram':
      prof.raw = [{ p: 1, dmg: base }];
      prof.forceSwitch = 'opponent';
      break;
    case 'Terror Strike':
      prof.raw = [{ p: 1, dmg: base }];
      prof.forceSwitch = 'opponent';
      prof.misc -= 5; // only 50% of the time
      break;
    case 'Teleport':
      prof.raw = [{ p: 1, dmg: 0 }];
      prof.forceSwitch = 'self';
      break;
    case 'Hurricane':
      prof.raw = [{ p: 1, dmg: base }];
      prof.hurricane = true;
      break;
    case 'Barrier':
      prof.raw = [{ p: 1, dmg: 0 }];
      prof.protect = { p: 1, kind: 'full' };
      break;
    case 'Agility':
      prof.raw = [{ p: 1, dmg: base }];
      prof.protect = { p: 0.5, kind: 'full' };
      break;
    case 'Harden':
      prof.raw = [{ p: 1, dmg: 0 }];
      prof.protect = { p: 1, kind: 'threshold30' };
      break;
    case 'Minimize':
      prof.raw = [{ p: 1, dmg: 0 }];
      prof.protect = { p: 1, kind: 'minus20' };
      break;
    case 'Pounce':
      prof.raw = [{ p: 1, dmg: base }];
      prof.protect = { p: 1, kind: 'minus10' };
      break;
    case 'Snivel':
      prof.raw = [{ p: 1, dmg: 0 }];
      prof.protect = { p: 1, kind: 'minus20' };
      break;
    case 'Tail Wag': case 'Leer':
      prof.raw = [{ p: 1, dmg: 0 }];
      prof.protect = { p: 0.5, kind: 'immune' };
      break;
    case 'Smokescreen': case 'Sand-attack':
      prof.raw = [{ p: 1, dmg: base }];
      prof.smokescreen = true;
      break;
    case 'Swords Dance':
      prof.raw = [{ p: 1, dmg: 0 }];
      prof.swordsDance = true;
      break;
    case 'Destiny Bond':
      prof.raw = [{ p: 1, dmg: 0 }];
      prof.destinyBond = true;
      prof.discardEnergy = 1;
      break;
    case 'Recover':
      prof.raw = [{ p: 1, dmg: 0 }];
      prof.heal = 'all';
      prof.discardEnergy = 1;
      break;
    case 'Spacing Out':
      prof.raw = [{ p: 1, dmg: 0 }];
      prof.heal = 5;
      break;
    case 'Leech Seed':
      prof.raw = [{ p: 1, dmg: base }];
      prof.heal = 10;
      break;
    case 'Leech Life':
      prof.raw = [{ p: 1, dmg: base }];
      prof.heal = { frac: 1 };
      break;
    case 'Mega Drain': case 'Absorb':
      prof.raw = [{ p: 1, dmg: base }];
      prof.heal = { frac: 0.5 };
      break;
    case 'Fetch':
      prof.raw = [{ p: 1, dmg: 0 }];
      prof.draw = 1;
      break;
    case 'Pay Day':
      prof.raw = [{ p: 1, dmg: base }];
      prof.draw = 0.5;
      break;
    case 'Energy Conversion':
      prof.raw = [{ p: 1, dmg: 0 }];
      prof.self = [{ p: 1, dmg: 10 }];
      prof.misc += 12 * Math.min(2, ctx.energyInDiscard || 0);
      break;
    case 'Scavenge':
      prof.raw = [{ p: 1, dmg: 0 }];
      prof.discardEnergy = 1;
      prof.misc += (ctx.trainersInDiscard ? 20 : 0);
      break;
    case 'Call for Family': case 'Sprout': case 'Call for Friend':
      prof.raw = [{ p: 1, dmg: 0 }];
      prof.misc += (ctx.canBench && ctx.searchTargetInDeck) ? 35 : 0;
      break;
    case 'Prophecy': case 'Peek':
      prof.raw = [{ p: 1, dmg: 0 }];
      prof.misc += 2;
      break;
    case 'Conversion 1': case 'Conversion 2':
      prof.raw = [{ p: 1, dmg: 0 }];
      if (name === 'Conversion 1' && !(defender?.weaknesses || []).length) prof.unusable = true;
      break;
    case 'Metronome':
      // Handled by the caller (expands to the opponent's attacks).
      prof.raw = [{ p: 1, dmg: 0 }];
      prof.metronome = true;
      break;
    case 'Wildfire':
      prof.raw = [{ p: 1, dmg: 0 }];
      prof.misc += 3;
      break;
    default:
      break;
  }

  // ── Generic text patterns (mirror resolveCoinFlipDamage in game-actions.js) ─
  if (!prof.raw) {
    const timesHeads = t.match(/(\d+) damage times the number of heads/);
    if (/flip a coin until you get tails/.test(t)) {
      const per = timesHeads ? parseInt(timesHeads[1]) : base;
      const out = [];
      let rest = 1;
      for (let k = 0; k < 7; k++) { out.push({ p: rest * 0.5, dmg: k * per }); rest *= 0.5; }
      out.push({ p: rest, dmg: 7 * per });
      prof.raw = out; coinHandled = true;
    } else if (/flip a coin for each [^.]*energy/.test(t) && (timesHeads || base > 0)) {
      const per = timesHeads ? parseInt(timesHeads[1]) : base;
      prof.raw = aiBinomialOutcomes(Math.max(1, energyCount), per); coinHandled = true;
    } else if (/flip (\d+|a) coins?[\s\S]*?times the number of heads/.test(t) && timesHeads) {
      const m = t.match(/flip (\d+|a) coins?/);
      const n = m[1] === 'a' ? 1 : parseInt(m[1]);
      prof.raw = aiBinomialOutcomes(n, parseInt(timesHeads[1])); coinHandled = true;
    } else if (/flip a coin\. if tails[^.]*(?:does nothing|no damage|attack fails)/.test(t) && base > 0) {
      prof.raw = [{ p: 0.5, dmg: base }, { p: 0.5, dmg: 0 }]; coinHandled = true;
    } else if (/if heads[^.]*?(\d+) (?:more|additional) damage/.test(t) && base > 0) {
      const extra = parseInt(t.match(/if heads[^.]*?(\d+) (?:more|additional) damage/)[1]);
      prof.raw = [{ p: 0.5, dmg: base + extra }, { p: 0.5, dmg: base }]; coinHandled = true;
      const selfM = t.match(/if tails[^.]*does (\d+) damage to itself/);
      if (selfM) prof.self.push({ p: 0.5, dmg: parseInt(selfM[1]) });
    } else if (/if heads[^.]*does (\d+) damage instead/.test(t)) {
      const alt = parseInt(t.match(/if heads[^.]*does (\d+) damage instead/)[1]);
      prof.raw = [{ p: 0.5, dmg: alt }, { p: 0.5, dmg: base }]; coinHandled = true;
    } else if (/if tails[^.]*does (\d+) damage to itself/.test(t) && base > 0) {
      const selfM = t.match(/if tails[^.]*does (\d+) damage to itself/);
      prof.raw = [{ p: 1, dmg: base }];
      prof.self.push({ p: 0.5, dmg: parseInt(selfM[1]) }); coinHandled = true;
    } else if (/flip a number of coins equal to/.test(t) && timesHeads) {
      const n = /energy/.test(t.match(/flip a number of coins equal to[^.]+/)[0])
        ? Math.max(1, energyCount) : Math.max(1, defCounters);
      prof.raw = aiBinomialOutcomes(n, parseInt(timesHeads[1])); coinHandled = true;
    } else {
      prof.raw = [{ p: 1, dmg: base }];
    }
  }

  // Unconditional recoil: "X does N damage to itself" (not coin-gated)
  const selfDmgM = text.match(/\w+ does (\d+) damage to itself/i);
  const coinGatedRecoil = /if tails[^.]*does \d+ damage to itself/i.test(text);
  if (selfDmgM && !coinGatedRecoil && !prof.self.length && name !== 'Energy Conversion') {
    const n = parseInt(selfDmgM[1]);
    prof.self.push({ p: 1, dmg: n });
    if (n >= aiHp(attacker) && aiHp(attacker) > 0) prof.selfKO = true;
  }

  // Bench splash "does N damage to each Pokémon on each player's Bench"
  const splashM = text.match(/does (\d+) damage to each pok[eé]mon on each player[''s]* bench/i);
  if (splashM && !prof.benchOpp) {
    const n = parseInt(splashM[1]);
    prof.benchOpp = { dmg: n, count: 'all', p: 1 };
    prof.benchSelf = { dmg: n, count: 'all', p: 1 };
  }

  // Bench-target "does N damage to (1 of) your opponent's Benched Pokémon"
  const benchTargetM = text.match(/does (\d+) damage to (?:1 of )?(?:your )?opponent[''s]* benched pok[eé]mon/i);
  if (benchTargetM && !prof.benchOpp) {
    prof.benchOpp = { dmg: parseInt(benchTargetM[1]), count: 1, p: 1 };
    prof.raw = [{ p: 1, dmg: 0 }];
  }

  // Energy discard cost
  const discM = text.match(/discard (all|\d+|an?)\s+(?:(\S+) )?energy card[s]?\s+attached[^.]*in order to/i);
  if (discM && !prof.discardEnergy) {
    const raw = discM[1].toLowerCase();
    prof.discardEnergy = raw === 'all' ? Infinity : (/^\d+$/.test(raw) ? parseInt(raw) : 1);
  }

  // Draw effects.
  if (!prof.draw) {
    const drawN = text.match(/draw (\d+) cards?/i);
    if (drawN) prof.draw = parseInt(drawN[1]);
    // Named handlers (Fetch, Pay Day) were resolved in the switch above — the
    // same role the engine's _hasPostAttackDispatch guard plays there.
    else if (/draw a card/i.test(text)) prof.draw = 1;
  }

  // Self heal
  if (!prof.heal) {
    if (/remove all damage counters from/i.test(text)) prof.heal = 'all';
    else {
      const rm = text.match(/remove (\d+) damage counters? from/i);
      if (rm) prof.heal = parseInt(rm[1]) * 10;
    }
  }

  // Protection patterns (only when no named handler set one)
  if (!prof.protect) {
    if (/flip a coin[^.]*\.\s*if heads[^.]*prevent all damage done to/i.test(text)) prof.protect = { p: 0.5, kind: 'full' };
    else if (/flip a coin\. if heads[^.]*prevent all effects of attacks[^.]*done to/i.test(text)) prof.protect = { p: 0.5, kind: 'full' };
    else if (/whenever (\d+) or less damage is done[^,]*,?\s*prevent that damage/i.test(text)) prof.protect = { p: 1, kind: 'threshold30' };
    else if (/damage done to .+ during your opponent.s next turn is reduced by 20/i.test(text)) prof.protect = { p: 1, kind: 'minus20' };
    else if (/can.t attack [^.]* during your opponent.s next turn/i.test(text) && /flip a coin/i.test(text)) prof.protect = { p: 0.5, kind: 'immune' };
  }
  if (!prof.smokescreen && /defending pok[eé]mon tries to attack[^.]*next turn[^.]*flip a coin[^.]*tails[^.]*does nothing/i.test(text)) prof.smokescreen = true;
  if (/defending pok[eé]mon can.t retreat/i.test(text)) prof.cantRetreat = /flip a coin/i.test(text) ? 0.5 : 1;

  // Statuses from text (skip if a named handler already populated them)
  if (!prof.statusOpp.length && !prof.statusSelf.length && typeof parseStatusEffects === 'function') {
    for (const eff of parseStatusEffects(text)) {
      if (eff.type === 'either') {
        prof.statusOpp.push({ p: 0.5, status: eff.heads }, { p: 0.5, status: eff.tails });
        continue;
      }
      if (eff.coinRequired && coinHandled) continue; // engine skips a second flip
      const p = eff.coinRequired ? 0.5 : 1;
      (eff.self ? prof.statusSelf : prof.statusOpp).push({ p, status: eff.status });
    }
  }

  // Deck search "put it into your hand"
  if (/search your deck for [^.]*put (?:it|them) into your hand/i.test(text)) prof.misc += 15;

  return prof;
}

// Apply PlusPower, Weakness/Resistance and the defender's modifiers to one raw
// damage number. Mirrors computeFinalDamage / applyDamageModifiers.
function aiFinalDamage(raw, plus, attacker, defender, skipWR, opts = {}) {
  if (raw <= 0) return 0;
  let dmg = raw + (plus || 0); // PlusPower applies before W/R (matches engine + TCG rule)
  if (!skipWR) {
    const types = opts.attackerTypes || attacker?.types || [];
    dmg = computeDamageAfterWR(dmg, types, defender?.weaknesses || [], defender?.resistances || []);
  }
  if (dmg <= 0) return 0;
  if (typeof isPowerActive === 'function' && defender && isPowerActive(defender, 'Kabuto Armor')) {
    dmg = Math.floor(dmg / 20) * 10;
  }
  if (defender?.defenderFull) return 0;
  if (defender?.defenderThreshold && dmg <= defender.defenderThreshold) return 0;
  if (typeof hasInvisibleWall === 'function' && defender && hasInvisibleWall(defender) && dmg >= 30) return 0;
  if (defender?.defender) dmg = Math.max(0, dmg - 20);
  if (defender?.pounceActive && dmg > 0) dmg = Math.max(0, dmg - (defender.pounceReduction || 10));
  if (opts.attackReduction) dmg = Math.max(0, dmg - opts.attackReduction);
  return dmg;
}

// Full damage distribution of `move` from `attacker` onto `defender`.
// Returns { outcomes:[{p,dmg}], prof, expected, max }.
const _aiProfileCache = new Map();
function aiProfileCacheKey(move, attacker, defender, ctx) {
  const waterAttached = (attacker?.attachedEnergy || []).filter(e => /water/i.test(e.name)).length;
  return [
    move?.name, (move?.text || '').length, (move?.cost || []).join(''), move?.damage,
    ctx.energyCount, attacker?.damage || 0, attacker?.hp, attacker?.swordsDanceActive ? 1 : 0,
    attacker?.leekSlapUsed ? 1 : 0, waterAttached,
    defender?.damage || 0, defender?.hp, (defender?.attachedEnergy || []).length,
    (defender?.weaknesses || []).length,
    ctx.ownBenchCount, ctx.oppBenchCount, ctx.nidokings, ctx.lastAttackDamage,
    ctx.oppAsleep ? 1 : 0, ctx.energyInDiscard, ctx.trainersInDiscard ? 1 : 0,
    ctx.canBench ? 1 : 0, ctx.searchTargetInDeck ? 1 : 0,
  ].join('|');
}

function aiDamageDistribution(move, attacker, defender, opts = {}) {
  const ctx = aiProfileContext(attacker, defender, opts);
  const key = aiProfileCacheKey(move, attacker, defender, ctx);
  let prof = _aiProfileCache.get(key);
  if (!prof) {
    if (_aiProfileCache.size > 5000) _aiProfileCache.clear();
    prof = attackProfile(move, attacker, defender, ctx);
    _aiProfileCache.set(key, prof);
  }
  let outcomes = prof.raw.map(o => ({ p: o.p, dmg: aiFinalDamage(o.dmg, opts.plus || 0, attacker, defender, prof.skipWR, opts) }));
  // Transparency (Haunter Fossil): 50% everything is prevented
  if (typeof isPowerActive === 'function' && defender && isPowerActive(defender, 'Transparency')) {
    outcomes = [...outcomes.map(o => ({ p: o.p * 0.5, dmg: o.dmg })), { p: 0.5, dmg: 0 }];
  }
  outcomes = aiMergeOutcomes(outcomes);
  return { outcomes, prof, expected: aiExpected(outcomes), max: aiMaxOutcome(outcomes) };
}

function aiProfileContext(attacker, defender, opts = {}) {
  const ownerNum = opts.attackerPlayerNum;
  const owner = ownerNum ? G?.players?.[ownerNum] : null;
  const oppNum = ownerNum ? (ownerNum === 1 ? 2 : 1) : null;
  const opp = oppNum ? G?.players?.[oppNum] : null;
  return {
    energyCount: opts.energyCount != null ? opts.energyCount : energyValue(attacker?.attachedEnergy || []),
    ownBenchCount: opts.ownBenchCount != null ? opts.ownBenchCount : aiBenchCount(owner),
    oppBenchCount: opts.oppBenchCount != null ? opts.oppBenchCount : aiBenchCount(opp),
    nidokings: owner ? aiAllInPlay(owner).filter(c => c.name === 'Nidoking').length : 0,
    lastAttackDamage: (ownerNum && G?.lastAttackOnPlayer?.[ownerNum]?.damage) || 0,
    oppAsleep: aiSpecialStatus(defender) === 'asleep',
    energyInDiscard: owner ? (owner.discard || []).filter(c => c.supertype === 'Energy').length : 0,
    trainersInDiscard: owner ? (owner.discard || []).some(c => c.supertype === 'Trainer') : false,
    canBench: owner ? aiFreeBenchSlot(owner) !== -1 : false,
    searchTargetInDeck: owner ? (owner.deck || []).some(c => aiIsBasic(c)) : false,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// THREAT MODEL — what can `attackerPlayer` do to `defenderCard` next turn?
// ══════════════════════════════════════════════════════════════════════════════
//
// threatSummary(attackerPlayer, defenderPlayer, opts) → {
//   maxDmg    worst case (all flips heads)
//   expDmg    expected damage of the attack that maximises KO chance
//   koProb    probability the defender is KO'd
// }
//
// opts.peekHand   — legacy mode: read the attacker's hand for energy /
//                   PlusPower / Switch / Scoop Up (used only by the pinned
//                   opponentThreatNextTurn helper).
// opts.defender   — evaluate against this card instead of defenderPlayer.active
// opts.attackerPlayerNum — seat number of attackerPlayer (for Do the Wave etc.)
//
// Non-peeking assumptions (fair play): the opponent may attach ONE energy of
// any type they need if they have any cards in hand (two Water under Rain
// Dance), no PlusPower, and they can reach a benched attacker only by paying
// its retreat cost with the energy already on their active.
function threatSummary(attackerPlayer, defenderPlayer, opts = {}) {
  const def = opts.defender || defenderPlayer?.active;
  const zero = { maxDmg: 0, expDmg: 0, koProb: 0, attacker: null, attack: null };
  if (!def || !attackerPlayer) return zero;
  const hpLeft = opts.hpLeft != null ? opts.hpLeft : aiHpLeft(def);
  const hand = attackerPlayer.hand || [];
  const peek = !!opts.peekHand;
  const atkNum = opts.attackerPlayerNum || null;

  let attachmentOptions;
  let plusPower = 0;
  if (peek) {
    const names = [...new Set(hand.filter(c => c?.supertype === 'Energy').map(c => c.name))];
    attachmentOptions = [[], ...names.map(n => [{ name: n }])];
    if (hand.some(c => c?.name === 'PlusPower')) plusPower = 10;
  } else {
    attachmentOptions = [[]];
    if (hand.length > 0 && !opts.noAttach) {
      attachmentOptions.push([{ name: 'ANY' }]);
      if (atkNum && typeof rainDanceActive === 'function' && rainDanceActive(atkNum) && hand.length > 1) {
        attachmentOptions.push([{ name: 'Water Energy' }, { name: 'Water Energy' }]);
      }
    }
  }

  const defenderForCalc = opts.defenderOverrides ? { ...def, ...opts.defenderOverrides } : def;

  function bestFromAttacker(atkCard, isActiveNow) {
    let best = { maxDmg: 0, expDmg: 0, koProb: 0, attack: null };
    if (!atkCard) return best;
    const moves = aiAttacksOf(atkCard, atkNum);
    if (!moves.length) return best;
    for (const extra of attachmentOptions) {
      // "ANY" energy = one wildcard that pays whatever the attack needs.
      let attached = [...(atkCard.attachedEnergy || [])];
      let wildcard = false;
      for (const e of extra) { if (e.name === 'ANY') wildcard = true; else attached.push({ name: e.name }); }
      for (const move of moves) {
        if (atkCard.disabledAttack && move.name === atkCard.disabledAttack) continue;
        let affordable = canAffordAttack(attached, move.cost || [], atkCard);
        if (!affordable && wildcard) {
          // Try every type for the wildcard.
          for (const ty of ['Colorless', ...(move.cost || [])]) {
            if (canAffordAttack([...attached, { name: `${ty} Energy` }], move.cost || [], atkCard)) { affordable = true; break; }
          }
        }
        if (!affordable) continue;
        const energyCount = energyValue(attached) + (wildcard ? 1 : 0);
        const dist = aiDamageDistribution(move, atkCard, defenderForCalc, {
          plus: plusPower, energyCount, attackerPlayerNum: atkNum,
          attackReduction: atkCard.attackReduction || 0,
        });
        if (dist.prof.unusable) continue;
        let outcomes = dist.outcomes;
        // Smokescreen on the attacker: 50% the attack fails outright
        if (atkCard.smokescreened && isActiveNow) outcomes = aiMergeOutcomes([...outcomes.map(o => ({ p: o.p * 0.5, dmg: o.dmg })), { p: 0.5, dmg: 0 }]);
        // Confused attacker: 50% hurts itself instead
        if (isActiveNow && aiSpecialStatus(atkCard) === 'confused') outcomes = aiMergeOutcomes([...outcomes.map(o => ({ p: o.p * 0.5, dmg: o.dmg })), { p: 0.5, dmg: 0 }]);
        const koProb = aiProbAtLeast(outcomes, hpLeft);
        const exp = aiExpected(outcomes);
        const mx = aiMaxOutcome(outcomes);
        const better = koProb > best.koProb + 1e-9 || (Math.abs(koProb - best.koProb) < 1e-9 && exp > best.expDmg);
        if (better) best = { maxDmg: Math.max(best.maxDmg, mx), expDmg: exp, koProb, attack: move };
        else if (mx > best.maxDmg) best.maxDmg = mx;
      }
    }
    return best;
  }

  const active = attackerPlayer.active;
  let result = { ...zero };
  const activeSpecial = aiSpecialStatus(active);
  if (active && activeSpecial !== 'paralyzed' && !(activeSpecial === 'asleep' && !peek && opts.strictSleep)) {
    const r = bestFromAttacker(active, true);
    // Asleep: they flip at the start of their turn; heads = wake up.
    if (activeSpecial === 'asleep') { r.koProb *= 0.5; r.expDmg *= 0.5; }
    result = { ...r, attacker: active };
  }

  // Bench attackers they could bring up this turn
  let canReach = false;
  if (peek) {
    const hasSwitch = hand.some(c => c?.name === 'Switch');
    const hasScoop = hand.some(c => c?.name === 'Scoop Up');
    let canRetreat = false;
    if (active && activeSpecial !== 'paralyzed' && activeSpecial !== 'asleep') {
      canRetreat = energyValue(active.attachedEnergy || []) >= (active.convertedRetreatCost || 0);
    }
    canReach = hasSwitch || hasScoop || canRetreat;
  } else {
    if (!active) canReach = true;
    else if (activeSpecial !== 'paralyzed' && activeSpecial !== 'asleep' && !active.cantRetreat) {
      const discount = (atkNum && typeof retreatCostReduction === 'function') ? retreatCostReduction(atkNum) : 0;
      canReach = energyValue(active.attachedEnergy || []) >= Math.max(0, (active.convertedRetreatCost || 0) - discount);
    }
    // Dragonite's Step In is a free switch.
    if (!canReach && (attackerPlayer.bench || []).some(b => b && typeof isPowerActive === 'function' && isPowerActive(b, 'Step In'))) canReach = true;
  }
  if (canReach) {
    for (const b of (attackerPlayer.bench || [])) {
      if (!b) continue;
      const r = bestFromAttacker(b, false);
      const better = r.koProb > result.koProb + 1e-9 || (Math.abs(r.koProb - result.koProb) < 1e-9 && r.expDmg > result.expDmg);
      if (better) result = { ...r, attacker: b, maxDmg: Math.max(r.maxDmg, result.maxDmg) };
      else if (r.maxDmg > result.maxDmg) result.maxDmg = r.maxDmg;
    }
  }
  return result;
}

// Opponent threat model (legacy, worst case, peeks at hand) — pinned by tests.
// Returns the maximum damage `attackerPlayer` could do to `defenderPlayer`'s
// active next turn, treating every coin flip as heads.
function opponentThreatNextTurn(attackerPlayer, defenderPlayer) {
  return threatSummary(attackerPlayer, defenderPlayer, { peekHand: true }).maxDmg;
}

// True if the opponent's next turn is likely to KO our active (worst case).
function willActiveDieNextTurn(defenderPlayer, attackerPlayer) {
  const def = defenderPlayer?.active;
  if (!def) return false;
  const hpLeft = aiHpLeft(def);
  if (hpLeft <= 0) return false;
  return opponentThreatNextTurn(attackerPlayer, defenderPlayer) >= hpLeft;
}

// Fair-play threat against one of OUR cards (as if it were active), from the
// opponent's current board. Used by every decision path.
function aiThreatAgainst(card, opts = {}) {
  const opp = opts.opp || aiOpp();
  const me = opts.me || aiMe();
  return threatSummary(opp, me, {
    defender: card, hpLeft: opts.hpLeft, attackerPlayerNum: aiOppNum(),
    defenderOverrides: opts.defenderOverrides,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// VALUES
// ══════════════════════════════════════════════════════════════════════════════
const AI_SCORE = {
  WIN:        1_000_000,
  KO:         100_000,
  SURVIVE:    50_000,     // scaled by how valuable the surviving Pokémon is
  SUICIDE_LAST_PRIZE: 200_000,
  PLUSPOWER:  15_000,     // in the KO bucket — only worth it for a real KO chance
  GUST:       10_000,
  SWITCH:     15,
  EVOLVE:     20,
  BREEDER:    25,
  RETREAT_PER_ENERGY: 8,
  ATTACH:     1,
  SCOOP:      30,
};

// How much a Pokémon is "worth" (0..1): HP, stage and energy investment.
function aiPokemonWorth(card) {
  if (!card) return 0;
  const hp = aiHp(card);
  const energy = energyValue(card.attachedEnergy || []);
  const stage = aiStage(card);
  const bestDmg = (card.attacks || []).reduce((m, a) => Math.max(m, aiBaseDamage(a)), 0);
  return aiClamp((hp / 100) * 0.4 + (energy / 4) * 0.3 + stage * 0.1 + (bestDmg / 80) * 0.2, 0.15, 1);
}

// Value of a status effect landing on the opponent's active (points ≈ damage).
function aiStatusValue(status, target, oppThreatExp) {
  const threat = Math.max(10, oppThreatExp || 0);
  switch (status) {
    case 'paralyzed': return 12 + threat * 0.8;   // they lose an attack (and can't retreat)
    case 'asleep':    return 8 + threat * 0.45;   // ~50% they lose the attack
    case 'confused':  return 6 + threat * 0.35;   // 50% attack fails and hurts them 30
    case 'poisoned':  return 15;                  // 10 per turn boundary → ~20-30 over the fight
    case 'poisoned-toxic': return 28;
    case 'burned':    return 20;
    default: return 0;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// PLAN EVALUATION FOR ONE ATTACKER CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════
//
// evaluateAttackerPlan(attacker, p2, p1, preStep, opts)
//   attacker — Pokémon that will be Active AFTER preStep (energy/damage as
//              they will be then)
//   p2 / p1  — our player object / opponent player object (unmutated)
//   preStep  — null | { kind, handIdx?, benchIdx?, energyDiscardCount?, ... }
//   opts     — { energyAvailable: bool (override G.energyPlayedThisTurn) }
//
// Returns the best plan for this configuration or null when the configuration
// has no usable attack and no defensive value:
//   { score, outcome, preStep, target:{benchIdx, card, gustHandIdx}, attachList,
//     plusPowerCount, attack, expectedDamage, koProb, willKO, pSurvive,
//     willSurvive, wouldWinByPrizes, wouldWinByNoPokemon }
function evaluateAttackerPlan(attacker, p2, p1, preStep, opts = {}) {
  if (!attacker || !p1?.active) return null;
  const meNum = opts.meNum || aiPlayerNum;
  const oppNum = meNum === 1 ? 2 : 1;
  // Multi-status: the blocking condition lives in `.special` (`.status` is a
  // stale legacy alias). Read `.special` first so we never plan an attack with
  // an Asleep/Paralyzed Pokémon (performAttack would block it).
  const special = attacker.special ?? attacker.status ?? null;
  const blocked = special === 'paralyzed' || special === 'asleep';
  const canAttackAtAll = !blocked;

  const fullHand = p2.hand || [];
  const consumed = new Set();
  if (preStep?.handIdx != null && (preStep.kind === 'evolve' || preStep.kind === 'switch' || preStep.kind === 'breeder')) consumed.add(preStep.handIdx);
  if (preStep?.breederHandIdx != null) consumed.add(preStep.breederHandIdx);
  if (preStep?.scoopHandIdx != null) consumed.add(preStep.scoopHandIdx);
  const hand = fullHand.map((c, i) => ({ c, i })).filter(x => !consumed.has(x.i));

  const energyAlreadyPlayed = opts.energyAvailable === true ? false : !!G.energyPlayedThisTurn;
  const rainDance = (typeof rainDanceActive === 'function') && rainDanceActive(meNum)
    && (attacker.types || []).some(t => /water/i.test(t));

  const energiesInHand = hand.filter(x => x.c?.supertype === 'Energy');
  const distinctEnergyNames = [...new Set(energiesInHand.map(x => x.c.name))];
  const attachOptions = [[]];
  if (!energyAlreadyPlayed) {
    for (const name of distinctEnergyNames) {
      const first = energiesInHand.find(x => x.c.name === name);
      attachOptions.push([{ name, handIdx: first.i }]);
    }
  }
  if (rainDance) {
    const waters = energiesInHand.filter(x => /water/i.test(x.c.name));
    for (let n = 2; n <= waters.length; n++) attachOptions.push(waters.slice(0, n).map(w => ({ name: w.c.name, handIdx: w.i })));
  }

  const easy = aiDifficulty === 'easy' && !opts.fullStrength;
  const plusPowerIdxs = easy ? [] : hand.filter(x => x.c?.name === 'PlusPower').map(x => x.i);
  const maxPlusPowers = Math.min(2, plusPowerIdxs.length);
  const gustEntry = easy ? null : hand.find(x => x.c?.name === 'Gust of Wind');

  const targetOptions = [{ benchIdx: null, card: p1.active, gustHandIdx: null }];
  if (gustEntry) {
    for (let b = 0; b < (p1.bench?.length || 0); b++) {
      if (p1.bench[b]) targetOptions.push({ benchIdx: b, card: p1.bench[b], gustHandIdx: gustEntry.i });
    }
  }

  const myPrizesLeft = prizesRemaining(p2);
  const oppPrizesLeft = prizesRemaining(p1);
  const hpLeft = aiHpLeft(attacker);
  const worth = aiPokemonWorth(attacker);
  const oppHasBench = (p1.bench || []).some(b => b);
  const oppPokemonCount = aiAllInPlay(p1).length;

  // Our survival next turn given the opponent's active after our attack.
  const _survCache = new Map();
  function survivalAfter(oppActiveAfter, extraDefender, oppBenchOverride) {
    const key = `${oppActiveAfter?.uid || oppActiveAfter?.name || 'none'}|${extraDefender ? JSON.stringify(extraDefender) : ''}|${oppBenchOverride ? 'b' : ''}`;
    if (_survCache.has(key)) return _survCache.get(key);
    const r = _survivalAfter(oppActiveAfter, extraDefender, oppBenchOverride);
    _survCache.set(key, r);
    return r;
  }
  function _survivalAfter(oppActiveAfter, extraDefender, oppBenchOverride) {
    const oppView = { ...p1, active: oppActiveAfter, bench: oppBenchOverride || p1.bench };
    const defCard = extraDefender ? { ...attacker, ...extraDefender } : attacker;
    const th = threatSummary(oppView, { active: defCard }, { defender: defCard, hpLeft, attackerPlayerNum: oppNum });
    return { pSurvive: 1 - th.koProb, threat: th };
  }

  // Threat from whichever Pokémon they'd promote if we KO their active.
  function survivalAfterKO(koTarget) {
    if (koTarget !== p1.active) return survivalAfter(p1.active); // gusted bench target KO'd; their active stays
    let worst = null;
    for (const b of (p1.bench || [])) {
      if (!b) continue;
      const s = survivalAfter(b);
      if (!worst || s.pSurvive < worst.pSurvive) worst = s;
    }
    return worst || { pSurvive: 1, threat: null };
  }

  const baseline = survivalAfter(p1.active);
  const oppThreatExp = baseline.threat?.expDmg || 0;

  let best = null;

  if (canAttackAtAll && (attacker.attacks?.length || isPowerActive?.(attacker, 'Transform'))) {
    let moves = aiAttacksOf(attacker, meNum);
    // Metronome: usable copies of the opponent's attacks (no energy cost beyond Metronome's own)
    const expanded = [];
    for (const m of moves) {
      if (m.name === 'Metronome') {
        for (const om of (p1.active.attacks || [])) expanded.push({ ...om, cost: m.cost, _metronomeOf: m });
      } else expanded.push(m);
    }
    moves = expanded;

    for (const target of targetOptions) {
      const targetCard = target.card;
      const targetHp = aiHpLeft(targetCard);
      if (targetHp <= 0) continue;
      const isGust = target.gustHandIdx !== null;

      for (const attachList of attachOptions) {
        const attached = [...(attacker.attachedEnergy || [])];
        for (const a of attachList) attached.push({ name: a.name });
        const plannedAttacker = { ...attacker, attachedEnergy: attached };

        for (let pp = 0; pp <= maxPlusPowers; pp++) {
          for (const atk of moves) {
            if (!canAffordAttack(attached, atk.cost || [], attacker)) continue;
            if (attacker.disabledAttack && attacker.disabledAttack === atk.name) continue;

            const dist = aiDamageDistribution(atk, plannedAttacker, targetCard, {
              plus: pp * 10, attackerPlayerNum: meNum,
            });
            const prof = dist.prof;
            if (prof.unusable) continue;
            let outcomes = dist.outcomes;
            // Confusion: 50% we hit ourselves for 30 instead
            const confused = special === 'confused';
            if (confused) outcomes = aiMergeOutcomes([...outcomes.map(o => ({ p: o.p * 0.5, dmg: o.dmg })), { p: 0.5, dmg: 0 }]);
            if (attacker.smokescreened) outcomes = aiMergeOutcomes([...outcomes.map(o => ({ p: o.p * 0.5, dmg: o.dmg })), { p: 0.5, dmg: 0 }]);

            const koProb = aiProbAtLeast(outcomes, targetHp);
            const expCapped = outcomes.reduce((s, o) => s + o.p * Math.min(o.dmg, targetHp), 0);
            const expDmg = aiExpected(outcomes);
            const anyDamage = expDmg > 0;
            const hasEffect = prof.statusOpp.length || prof.protect || prof.heal || prof.draw || prof.benchOpp
              || prof.oppEnergyDiscard || prof.forceSwitch || prof.disable || prof.misc > 0 || prof.swordsDance
              || prof.destinyBond || prof.smokescreen || prof.trainerBlock || prof.hurricane || prof.cantRetreat;
            if (!anyDamage && !hasEffect) continue; // dead attack (e.g. Conversion with nothing to convert)

            // ── Self damage / self KO ──────────────────────────────────────
            const selfExp = prof.self.reduce((s, o) => s + o.p * o.dmg, 0);
            let pSelfKO = prof.self.reduce((s, o) => s + (o.dmg >= hpLeft ? o.p : 0), 0);
            if (confused) pSelfKO = Math.max(pSelfKO, 30 >= hpLeft ? 0.5 : 0);
            if (typeof isPowerActive === 'function' && isPowerActive(targetCard, 'Strikes Back') && expDmg > 0 && 10 >= hpLeft) pSelfKO = Math.max(pSelfKO, 1);

            // ── Survival next turn ─────────────────────────────────────────
            const defenderMods = {};
            if (prof.protect) {
              if (prof.protect.kind === 'full' || prof.protect.kind === 'immune') defenderMods.defenderFull = true;
              else if (prof.protect.kind === 'threshold30') defenderMods.defenderThreshold = 30;
              else if (prof.protect.kind === 'minus20') defenderMods.defender = true;
              else if (prof.protect.kind === 'minus10') { defenderMods.pounceActive = true; defenderMods.pounceReduction = 10; }
            }
            let surv;
            if (koProb > 0) {
              const sKO = survivalAfterKO(targetCard);
              const sNo = survivalAfter(isGust ? targetCard : p1.active, null);
              surv = { pSurvive: koProb * sKO.pSurvive + (1 - koProb) * sNo.pSurvive };
            } else {
              surv = survivalAfter(isGust ? targetCard : p1.active, null);
            }
            let pSurvive = surv.pSurvive;
            if (prof.protect) {
              const withProt = survivalAfter(isGust ? targetCard : p1.active, defenderMods).pSurvive;
              pSurvive = prof.protect.p * withProt + (1 - prof.protect.p) * pSurvive;
            }
            // Paralysis / sleep on their active (if it survives) skips their attack
            let pTheyCantAttack = 0;
            for (const st of prof.statusOpp) {
              if (st.status === 'paralyzed') pTheyCantAttack += st.p;
              else if (st.status === 'asleep') pTheyCantAttack += st.p * 0.5;
              else if (st.status === 'confused') pTheyCantAttack += st.p * 0.5;
            }
            if (prof.smokescreen) pTheyCantAttack = Math.max(pTheyCantAttack, 0.5);
            if (pTheyCantAttack > 0 && !isGust) pSurvive = pSurvive + (1 - pSurvive) * (1 - koProb) * Math.min(1, pTheyCantAttack) * 0.9;
            pSurvive *= (1 - pSelfKO);
            // Self-inflicted confusion/status makes the next turn worse
            const selfStatusPenalty = prof.statusSelf.reduce((s, o) => s + o.p * (o.status === 'confused' ? 15 : 10), 0);

            // ── Win detection ──────────────────────────────────────────────
            const winsByPrizes = koProb > 0 && myPrizesLeft === 1;
            const winsByNoPokemon = koProb > 0 && targetCard === p1.active && !oppHasBench;
            const winsByNoPokemonGust = koProb > 0 && isGust && oppPokemonCount <= 1;
            const wouldWin = winsByPrizes || winsByNoPokemon || winsByNoPokemonGust;

            // ── Score ──────────────────────────────────────────────────────
            let score = 0;
            if (wouldWin) score += AI_SCORE.WIN * koProb;
            score += AI_SCORE.KO * koProb;
            // Survival is scored as EXPECTED LOSS: a Pokémon that is safe either
            // way contributes nothing, so the planner never shuffles a bigger
            // Pokémon in front "because it would survive better".
            score -= AI_SCORE.SURVIVE * (1 - pSurvive) * (0.4 + 0.6 * worth);
            if (oppPrizesLeft === 1) score -= AI_SCORE.SUICIDE_LAST_PRIZE * (1 - pSurvive);
            // Self-KO hands them a prize (and possibly the game) — but taking their last prize first wins.
            if (pSelfKO > 0 && !wouldWin) score -= pSelfKO * (AI_SCORE.KO * 0.8 + (oppPrizesLeft === 1 ? AI_SCORE.WIN : 0));

            // Damage progress (capped at target HP). Damage onto a gusted
            // bench Pokémon is worth less: they can retreat it.
            score += Math.min(expCapped, 999) * (isGust ? 0.6 : 1);
            // Status value only matters if the target survives
            for (const st of prof.statusOpp) score += st.p * (1 - koProb) * aiStatusValue(st.status, targetCard, oppThreatExp);
            if (prof.disable) score += Math.min(40, oppThreatExp * 0.8) * (1 - koProb);
            if (prof.oppEnergyDiscard) {
              const tEnergy = energyValue(targetCard.attachedEnergy || []);
              score += tEnergy > 0 ? (prof.oppEnergyDiscard * 15 + (tEnergy <= prof.oppEnergyDiscard ? 15 : 0)) * (1 - koProb) : 0;
            }
            if (prof.forceSwitch === 'attacker') score += 12 * (1 - koProb);
            if (prof.forceSwitch === 'opponent') score += 4 * (1 - koProb);
            if (prof.hurricane) score += (1 - koProb) * (10 + energyValue(targetCard.attachedEnergy || []) * 12 + aiStage(targetCard) * 15);
            if (prof.trainerBlock) score += 8;
            if (prof.cantRetreat) score += 4 * prof.cantRetreat;
            if (prof.destinyBond) score += (1 - pSurvive) * AI_SCORE.KO * 0.5 * (oppPrizesLeft === 1 ? 0 : 1);
            if (prof.swordsDance) score += pSurvive * 25;
            if (prof.draw) score += prof.draw * (aiCanAffordDraw(Math.ceil(prof.draw), p2) ? 8 : -25);
            if (prof.heal) {
              const dmgOn = attacker.damage || 0;
              let healed = 0;
              if (prof.heal === 'all') healed = dmgOn;
              else if (typeof prof.heal === 'object') healed = Math.min(dmgOn, expDmg * prof.heal.frac);
              else healed = Math.min(dmgOn, prof.heal);
              score += healed * 0.7;
            }
            if (prof.benchOpp) {
              const benchCards = (p1.bench || []).filter(Boolean);
              let n = prof.benchOpp.count === 'all' ? benchCards.length
                : prof.benchOpp.count === 'type' ? benchCards.filter(b => (b.types || []).some(t => (targetCard.types || []).includes(t))).length
                : Math.min(prof.benchOpp.count, benchCards.length);
              const p = prof.benchOpp.p || 1;
              score += p * n * prof.benchOpp.dmg * 0.7;
              // KO chances on bench Pokémon are worth a prize
              const koable = benchCards.filter(b => aiHpLeft(b) <= prof.benchOpp.dmg).length;
              if (koable) score += p * Math.min(koable, n === benchCards.length ? koable : 1) * AI_SCORE.KO * 0.9;
            }
            if (prof.benchSelf) {
              const mine = (p2.bench || []).filter(Boolean);
              const p = prof.benchSelf.p || 1;
              let n = prof.benchSelf.count === 'all' ? mine.length
                : prof.benchSelf.count === 'type' ? mine.filter(b => (b.types || []).some(t => (targetCard.types || []).includes(t))).length : 0;
              score -= p * n * prof.benchSelf.dmg * 0.8;
              const dead = mine.filter(b => aiHpLeft(b) <= prof.benchSelf.dmg).length;
              if (dead && prof.benchSelf.count === 'all') score -= p * dead * AI_SCORE.KO * 0.6;
            }
            score += prof.misc;
            score -= selfExp * 0.6;
            score -= selfStatusPenalty;
            // Energy discarded as an attack cost = lost tempo
            if (prof.discardEnergy) {
              const n = prof.discardEnergy === Infinity ? (attacker.attachedEnergy || []).length : prof.discardEnergy;
              score -= n * (wouldWin ? 0 : 14);
            }

            // Resource costs
            score -= pp * AI_SCORE.PLUSPOWER;
            // PlusPower that raised the KO chance is reimbursed proportionally
            if (pp > 0) {
              const distNoPP = aiDamageDistribution(atk, plannedAttacker, targetCard, { plus: 0, attackerPlayerNum: meNum });
              const koNoPP = aiProbAtLeast(distNoPP.outcomes, targetHp);
              score += Math.max(0, koProb - koNoPP) * AI_SCORE.PLUSPOWER * pp; // net: PP is free when it makes the KO
              if (koProb <= koNoPP + 1e-9) score -= 5; // pure damage boost — keep the card
            }
            if (isGust) score -= AI_SCORE.GUST;
            score -= attachList.length * AI_SCORE.ATTACH;
            if (preStep?.kind === 'evolve')  score -= AI_SCORE.EVOLVE;
            if (preStep?.kind === 'breeder') score -= AI_SCORE.BREEDER;
            if (preStep?.kind === 'switch')  score -= AI_SCORE.SWITCH;
            if (preStep?.kind === 'stepin')  score -= 2;
            if (preStep?.kind === 'scoop')   score -= AI_SCORE.SCOOP + (preStep.energyLost || 0) * 10;
            if (preStep?.kind === 'retreat') score -= (preStep.energyDiscardCount || 0) * AI_SCORE.RETREAT_PER_ENERGY;

            if (!best || score > best.score) {
              const willKO = koProb >= 0.5;
              let outcome;
              if (wouldWin && willKO) outcome = 'WIN_GAME';
              else if (willKO) outcome = 'KO';
              else outcome = 'DAMAGE';
              best = {
                score, outcome, preStep, target, attachList, plusPowerCount: pp,
                attack: atk._metronomeOf || atk,
                metronomeTarget: atk._metronomeOf ? atk.name : null,
                expectedDamage: koProb >= 0.999 ? aiMaxOutcome(outcomes) : Math.round(expDmg),
                koProb, willKO, pSurvive, willSurvive: pSurvive >= 0.5,
                wouldWinByPrizes: winsByPrizes && willKO,
                wouldWinByNoPokemon: (winsByNoPokemon || winsByNoPokemonGust) && willKO,
              };
            }
          }
        }
      }
    }
  }

  // ── No-attack rescue branch ───────────────────────────────────────────────
  // A preStep (evolve / breeder / retreat / switch / step in / scoop) can be
  // worth doing purely for defensive value even when no attack follows.
  if (!best && preStep) {
    const pSurvive = baseline.pSurvive;
    if (pSurvive < 0.5) return null;
    let score = -AI_SCORE.SURVIVE * (1 - pSurvive) * (0.4 + 0.6 * worth);
    if (preStep.kind === 'evolve')  score -= AI_SCORE.EVOLVE;
    if (preStep.kind === 'breeder') score -= AI_SCORE.BREEDER;
    if (preStep.kind === 'switch')  score -= AI_SCORE.SWITCH;
    if (preStep.kind === 'stepin')  score -= 2;
    if (preStep.kind === 'scoop')   score -= AI_SCORE.SCOOP + (preStep.energyLost || 0) * 10;
    if (preStep.kind === 'retreat') score -= (preStep.energyDiscardCount || 0) * AI_SCORE.RETREAT_PER_ENERGY;
    best = {
      score, outcome: 'RESCUE', preStep,
      target: { benchIdx: null, card: p1.active, gustHandIdx: null },
      attachList: [], plusPowerCount: 0, attack: null, expectedDamage: 0,
      koProb: 0, willKO: false, pSurvive, willSurvive: true,
      wouldWinByPrizes: false, wouldWinByNoPokemon: false,
    };
  }

  return best;
}

// Score of doing nothing with the current active (used to decide whether a
// negative-value attack is worse than passing).
function aiPassScore(p2, p1) {
  if (!p2?.active) return -Infinity;
  const worth = aiPokemonWorth(p2.active);
  const th = threatSummary(p1, p2, { defender: p2.active, attackerPlayerNum: aiOppNum() });
  let score = -AI_SCORE.SURVIVE * th.koProb * (0.4 + 0.6 * worth);
  if (prizesRemaining(p1) === 1) score -= AI_SCORE.SUICIDE_LAST_PRIZE * th.koProb;
  return score;
}

// ── KO Plan search (current active only) ─────────────────────────────────────
function aiFindBestKOPlan(p2, p1) {
  if (!p2?.active || !p1?.active) return null;
  return evaluateAttackerPlan(p2.active, p2, p1, null);
}

// ── Pokémon Breeder lineage lookup ───────────────────────────────────────────
// Basic that a Stage 2 evolves from (Breeder skips the Stage 1).
function breederRootBasicName(stage2Card, player) {
  if (!stage2Card) return null;
  if (typeof genderLineBasicFor === 'function') {
    const gl = genderLineBasicFor(stage2Card.name);
    if (gl) return gl;
  }
  const stage1Name = stage2Card.evolvesFrom;
  if (!stage1Name) return null;
  if (typeof CARD_DATA === 'object' && CARD_DATA) {
    const s1 = Object.values(CARD_DATA).find(c => c?.name === stage1Name && c.subtypes?.includes('Stage 1'));
    if (s1?.evolvesFrom) return s1.evolvesFrom;
  }
  const allCards = [...(player?.hand || []), ...(player?.discard || []), ...(player?.deck || [])];
  const stage1 = allCards.find(c => c?.name === stage1Name && c.subtypes?.includes('Stage 1'));
  return stage1?.evolvesFrom || null;
}

// Post-evolution copy of a Pokémon (energy + damage carry over, status cleared).
function aiEvolvedCopy(evoCard, base) {
  return {
    ...evoCard,
    attachedEnergy: base.attachedEnergy || [],
    damage: base.damage || 0,
    status: null, special: null, poison: null, burn: false,
    plusPower: 0, defender: false, disabledAttack: null,
    swordsDanceActive: false, smokescreened: false, leekSlapUsed: false,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// GOAL-DIRECTED TURN PLANNER
// ══════════════════════════════════════════════════════════════════════════════
// Enumerates attacker configurations and returns the best-scoring plan:
//   1. current active (baseline)
//   2. evolve the active (Stage 1/2 from hand)
//   3. Pokémon Breeder onto the active
//   4. retreat into each bench Pokémon
//   5. Switch into each bench Pokémon
//   6. Dragonite's Step In (free switch)
//   7. Scoop Up the active, promote a bench Pokémon
// Returns null when nothing is viable.
function aiBuildTurnPlan(p2, p1, opts = {}) {
  if (!p2 || !p1) return null;
  const meNum = opts.meNum || aiPlayerNum;
  const candidates = [];
  const ev = (attacker, preStep) => evaluateAttackerPlan(attacker, p2, p1, preStep, { ...opts, meNum });

  if (p2.active) {
    const plan = ev(p2.active, null);
    if (plan) candidates.push(plan);
  }

  const evolvedUids = G.evolvedThisTurn || [];
  const evolveBlocked = (typeof prehistoricPowerActive === 'function') && prehistoricPowerActive();
  const hand = p2.hand || [];

  if (p2.active && !evolveBlocked && !evolvedUids.includes(p2.active.uid) && !opts.noEvolve) {
    for (let i = 0; i < hand.length; i++) {
      const evoCard = hand[i];
      if (!aiIsEvolution(evoCard) || evoCard.evolvesFrom !== p2.active.name) continue;
      const plan = ev(aiEvolvedCopy(evoCard, p2.active), { kind: 'evolve', handIdx: i, zone: 'active' });
      if (plan) candidates.push(plan);
    }
    if (aiIsBasic(p2.active)) {
      const breederIdx = hand.findIndex(c => c?.name === 'Pokémon Breeder');
      if (breederIdx !== -1) {
        for (let i = 0; i < hand.length; i++) {
          const s2 = hand[i];
          if (!s2?.subtypes?.includes('Stage 2')) continue;
          const root = breederRootBasicName(s2, p2);
          if (!root || root !== p2.active.name) continue;
          const plan = ev(aiEvolvedCopy(s2, p2.active), { kind: 'breeder', handIdx: i, breederHandIdx: breederIdx, zone: 'active' });
          if (plan) candidates.push(plan);
        }
      }
    }
  }

  const special = aiSpecialStatus(p2.active);
  if (p2.active && special !== 'paralyzed' && special !== 'asleep' && !p2.active.cantRetreat && !opts.noRetreat) {
    const baseRetreat = p2.active.convertedRetreatCost || 0;
    const discount = (typeof retreatCostReduction === 'function') ? retreatCostReduction(meNum) : 0;
    const retreatCost = Math.max(0, baseRetreat - discount);
    if (energyValue(p2.active.attachedEnergy || []) >= retreatCost && !(special === 'confused' && retreatCost > 0 && aiDifficulty !== 'hard')) {
      for (let b = 0; b < (p2.bench?.length || 0); b++) {
        const benchCard = p2.bench[b];
        if (!benchCard || benchCard.isDoll) continue;
        const plan = ev(benchCard, { kind: 'retreat', benchIdx: b, energyDiscardCount: retreatCost });
        if (plan) candidates.push(plan);
      }
    }
  }

  if (p2.active && !opts.noSwitch) {
    const switchIdx = hand.findIndex(c => c?.name === 'Switch');
    if (switchIdx !== -1) {
      for (let b = 0; b < (p2.bench?.length || 0); b++) {
        const benchCard = p2.bench[b];
        if (!benchCard || benchCard.isDoll) continue;
        const plan = ev(benchCard, { kind: 'switch', handIdx: switchIdx, benchIdx: b });
        if (plan) candidates.push(plan);
      }
    }
    // Dragonite — Step In
    if (!G.stepInThisTurn && typeof isPowerActive === 'function') {
      for (let b = 0; b < (p2.bench?.length || 0); b++) {
        const benchCard = p2.bench[b];
        if (!benchCard || !isPowerActive(benchCard, 'Step In')) continue;
        const plan = ev(benchCard, { kind: 'stepin', benchIdx: b });
        if (plan) candidates.push(plan);
      }
    }
    // Scoop Up the active (Basic only) → promote a bench Pokémon
    const scoopIdx = hand.findIndex(c => c?.name === 'Scoop Up');
    if (scoopIdx !== -1 && aiIsBasic(p2.active) && !p2.active.isDoll && aiDifficulty !== 'easy') {
      const energyLost = energyValue(p2.active.attachedEnergy || []);
      for (let b = 0; b < (p2.bench?.length || 0); b++) {
        const benchCard = p2.bench[b];
        if (!benchCard || benchCard.isDoll) continue;
        const plan = ev(benchCard, { kind: 'scoop', scoopHandIdx: scoopIdx, benchIdx: b, energyLost });
        if (plan) candidates.push(plan);
      }
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

// ══════════════════════════════════════════════════════════════════════════════
// PLAN EXECUTION
// ══════════════════════════════════════════════════════════════════════════════
function aiDelayMs() {
  return aiDifficulty === 'easy' ? 1400 : aiDifficulty === 'hard' ? 600 : 1000;
}
const aiDelay = ms => new Promise(r => setTimeout(r, ms));

function aiLog(msg, important = false) { addLog(`${AI_LOG_PREFIX} ${msg}`, important); }

// Execute the whole plan: preStep → Gust → PlusPower → attach → attack.
async function executeTurnPlan(plan, delayMs) {
  const p2 = aiMe();
  if (plan.preStep) {
    const ok = await executePreStepOnly(plan.preStep, delayMs);
    if (!ok) return false;
  }
  await executePlanTail(plan, delayMs);
  return true;
}

async function executePlanTail(plan, delayMs) {
  const p2 = aiMe();
  const p1 = aiOpp();

  if (plan.target?.gustHandIdx !== null && plan.target?.benchIdx !== null && plan.target?.benchIdx != null) {
    const gustIdx = p2.hand.findIndex(c => c?.name === 'Gust of Wind');
    const pulled = p1.bench[plan.target.benchIdx];
    if (gustIdx !== -1 && pulled) {
      const card = p2.hand.splice(gustIdx, 1)[0];
      p2.discard.push(card);
      const old = p1.active;
      if (old) { clearAllStatus(old); clearActiveOnlyEffects(old); }
      p1.bench[plan.target.benchIdx] = old;
      p1.active = pulled;
      while (p1.bench.length < 5) p1.bench.push(null);
      aiLog(`played Gust of Wind — pulled ${pulled.name} into the Active spot!`, true);
      renderAll();
      await aiDelay(delayMs * 0.6);
    }
  }

  for (let n = 0; n < (plan.plusPowerCount || 0); n++) {
    const ppIdx = p2.hand.findIndex(c => c?.name === 'PlusPower');
    if (ppIdx === -1 || !p2.active) break;
    const card = p2.hand.splice(ppIdx, 1)[0];
    p2.discard.push(card);
    p2.active.plusPower = (p2.active.plusPower || 0) + 10;
    aiLog(`played PlusPower on ${p2.active.name}.`, true);
    renderAll();
    await aiDelay(delayMs * 0.4);
  }

  for (const attach of (plan.attachList || [])) {
    const idx = p2.hand.findIndex(c => c?.supertype === 'Energy' && c.name === attach.name);
    if (idx === -1 || !p2.active) continue;
    const isRainDance = /water/i.test(attach.name) && G.energyPlayedThisTurn
      && (typeof rainDanceActive === 'function') && rainDanceActive(aiPlayerNum);
    if (G.energyPlayedThisTurn && !isRainDance) continue;
    attachEnergy(aiPlayerNum, idx, 'active', null, isRainDance);
    aiLog(`attached ${attach.name} to ${p2.active?.name}.`);
    renderAll();
    await aiDelay(delayMs * 0.5);
  }

  if (plan.attack && p2.active && p1.active) {
    const attackToUse = plan.attack;
    aiLog(`uses ${attackToUse.name}${plan.metronomeTarget ? ` (copying ${plan.metronomeTarget})` : ''}!`, true);
    aiThinking = false;
    await performAttack(aiPlayerNum, attackToUse);
  } else {
    aiLog(`ends turn.`, true);
    aiThinking = false;
    if (G.started && G.turn === aiPlayerNum && G.phase !== 'PROMOTE') endTurn();
  }
}

// Choose which energy cards to discard for a retreat — least useful first.
function aiPickRetreatDiscards(card, cost) {
  const attached = card.attachedEnergy || [];
  const costTypes = new Set();
  for (const atk of (card.attacks || [])) for (const c of (atk.cost || [])) if (c !== 'Colorless') costTypes.add(c.toLowerCase());
  const ranked = attached.map((e, i) => {
    const ty = aiEnergyType(e.name).toLowerCase();
    const isDCE = /double colorless/i.test(e.name || '');
    // Prefer discarding off-type basics, then on-type basics, DCE last (it's worth 2)
    const rank = isDCE ? 3 : (costTypes.has(ty) ? 2 : 1);
    return { e, i, rank, val: isDCE ? 2 : 1 };
  }).sort((a, b) => a.rank - b.rank);
  const out = [];
  let need = cost;
  // Try to hit the cost exactly with basics first
  for (const r of ranked) {
    if (need <= 0) break;
    if (r.val === 2 && need < 2) continue;
    out.push(r); need -= r.val;
  }
  if (need > 0) for (const r of ranked) { if (need <= 0) break; if (!out.includes(r)) { out.push(r); need -= r.val; } }
  return out.map(r => r.e);
}

async function executePreStepOnly(step, delayMs) {
  const p2 = aiMe();

  if (step.kind === 'evolve') {
    const plannedCardName = p2.hand[step.handIdx]?.name;
    const evoIdx = p2.hand.findIndex(c => c?.name === plannedCardName && c?.evolvesFrom === p2.active?.name);
    if (evoIdx !== -1) {
      evolve(aiPlayerNum, evoIdx, 'active', null);
      await aiDelay(delayMs * 0.7);
      return true;
    }
    return false;
  }

  if (step.kind === 'breeder') {
    const plannedS2Name = p2.hand[step.handIdx]?.name;
    return aiPlayBreeder(plannedS2Name, 'active', null, delayMs);
  }

  if (step.kind === 'retreat') {
    const active = p2.active;
    if (active && step.benchIdx != null && p2.bench[step.benchIdx]) {
      const cost = step.energyDiscardCount || 0;
      if (cost > 0 && active.attachedEnergy?.length) {
        const toDiscard = aiPickRetreatDiscards(active, cost);
        for (const e of toDiscard) {
          const i = active.attachedEnergy.indexOf(e);
          if (i !== -1) p2.discard.push(...active.attachedEnergy.splice(i, 1));
        }
        aiLog(`discarded ${toDiscard.map(e => e.name).join(', ')} to retreat ${active.name}.`);
      }
      clearActiveOnlyEffects(active);
      clearAllStatus(active);
      if (typeof clearLastAttack === 'function') clearLastAttack(aiPlayerNum);
      const out = p2.bench[step.benchIdx];
      p2.bench[step.benchIdx] = active;
      p2.active = out;
      while (p2.bench.length < 5) p2.bench.push(null);
      aiLog(`retreated ${active.name} → sent out ${out.name}.`, true);
      renderAll();
      await aiDelay(delayMs * 0.7);
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
      clearActiveOnlyEffects(old);
      clearAllStatus(old);
      if (typeof clearLastAttack === 'function') clearLastAttack(aiPlayerNum);
      p2.bench[step.benchIdx] = old;
      p2.active = out;
      while (p2.bench.length < 5) p2.bench.push(null);
      aiLog(`played Switch — swapped ${old.name} for ${out.name}.`, true);
      renderAll();
      await aiDelay(delayMs * 0.6);
      return true;
    }
    return false;
  }

  if (step.kind === 'stepin') {
    const d = p2.bench[step.benchIdx];
    if (d && !G.stepInThisTurn) {
      const old = p2.active;
      if (old) { clearActiveOnlyEffects(old); clearAllStatus(old); }
      if (typeof clearLastAttack === 'function') clearLastAttack(aiPlayerNum);
      p2.active = d; p2.bench[step.benchIdx] = old;
      G.stepInThisTurn = true;
      aiLog(`used Step In — ${d.name} switched to Active!`, true);
      renderAll();
      await aiDelay(delayMs * 0.6);
      return true;
    }
    return false;
  }

  if (step.kind === 'scoop') {
    const scoopIdx = p2.hand.findIndex(c => c?.name === 'Scoop Up');
    const bench = p2.bench[step.benchIdx];
    if (scoopIdx !== -1 && bench && p2.active) {
      const card = p2.hand.splice(scoopIdx, 1)[0];
      p2.discard.push(card);
      const scooped = p2.active;
      p2.discard.push(...(scooped.attachedEnergy || []));
      scooped.attachedEnergy = []; scooped.damage = 0;
      clearAllStatus(scooped); clearActiveOnlyEffects(scooped);
      scooped.prevStages = undefined;
      p2.hand.push(scooped);
      p2.active = bench; p2.bench[step.benchIdx] = null;
      if (typeof clearLastAttack === 'function') clearLastAttack(aiPlayerNum);
      aiLog(`played Scoop Up — returned ${scooped.name} to hand, sent out ${bench.name}!`, true);
      renderAll();
      await aiDelay(delayMs * 0.6);
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

// Play Pokémon Breeder: Stage 2 named `s2Name` onto the Basic in `zone`/`benchIdx`.
async function aiPlayBreeder(s2Name, zone, benchIdx, delayMs) {
  const p2 = aiMe();
  const target = zone === 'active' ? p2.active : p2.bench[benchIdx];
  const s2Idx = p2.hand.findIndex(c => c?.name === s2Name && c.subtypes?.includes('Stage 2'));
  const breederIdx = p2.hand.findIndex(c => c?.name === 'Pokémon Breeder');
  if (s2Idx === -1 || breederIdx === -1 || !target) return false;
  const hi = Math.max(s2Idx, breederIdx), lo = Math.min(s2Idx, breederIdx);
  const hiCard = p2.hand.splice(hi, 1)[0];
  const loCard = p2.hand.splice(lo, 1)[0];
  const s2Card = s2Idx > breederIdx ? hiCard : loCard;
  const breederCard = s2Idx > breederIdx ? loCard : hiCard;
  p2.discard.push(breederCard);
  s2Card.damage = target.damage || 0;
  s2Card.attachedEnergy = target.attachedEnergy || [];
  clearAllStatus(s2Card);
  s2Card.plusPower = 0; s2Card.defender = false; s2Card.disabledAttack = null;
  if (typeof buildEvolutionStackUnder === 'function') s2Card.prevStages = buildEvolutionStackUnder(target);
  if (!G.evolvedThisTurn) G.evolvedThisTurn = [];
  G.evolvedThisTurn.push(s2Card.uid);
  if (zone === 'active') p2.active = s2Card; else p2.bench[benchIdx] = s2Card;
  aiLog(`used Pokémon Breeder — ${target.name} → ${s2Card.name}!`, true);
  renderAll();
  await aiDelay(delayMs * 0.8);
  return true;
}

// ══════════════════════════════════════════════════════════════════════════════
// ENERGY TARGETING
// ══════════════════════════════════════════════════════════════════════════════

// How much closer `energyName` gets `card` to its most expensive attack, with
// a bonus when it fills a typed slot. Kept for compatibility.
function aiEnergyDeficit(card, energyName) {
  if (!card?.attacks?.length) return 0;
  const attached = card.attachedEnergy || [];
  const isDCE = /double colorless/i.test(energyName);
  const incomingType = isDCE ? 'Colorless' : aiEnergyType(energyName);
  let bestScore = 0;
  for (const atk of card.attacks) {
    const cost = atk.cost || [];
    if (cost.length === 0) continue;
    if (!canAffordAttack(attached, cost, card)) {
      const testPool = [...attached, { name: energyName }];
      const before = cost.filter(req => req === 'Colorless' || attached.some(e => aiEnergyType(e.name).toLowerCase() === req.toLowerCase())).length;
      const after  = cost.filter(req => req === 'Colorless' || testPool.some(e => aiEnergyType(e.name).toLowerCase() === req.toLowerCase())).length;
      const gain = after - before;
      const typedMatch = cost.some(req => req !== 'Colorless' && req.toLowerCase() === incomingType.toLowerCase());
      const score = gain + (typedMatch ? 1 : 0);
      if (score > bestScore) bestScore = score;
    }
  }
  return bestScore;
}

// Would attaching `energyName` to `card` make an attack affordable that isn't now?
function aiEnergyEnablesAttack(card, energyName) {
  if (!card?.attacks?.length) return false;
  const attached = card.attachedEnergy || [];
  const withEnergy = [...attached, { name: energyName || 'Colorless Energy' }];
  for (const atk of card.attacks) {
    const cost = atk.cost || [];
    if (cost.length === 0) continue;
    if (canAffordAttack(attached, cost, card)) continue;
    if (canAffordAttack(withEnergy, cost, card)) return true;
  }
  return false;
}

// Does this energy card contribute anything to this Pokémon's attack costs?
// (DCE only pays Colorless slots; a typed basic pays its type or Colorless.)
function aiEnergyUsableBy(card, energyName) {
  const attacks = card?.attacks || [];
  if (!attacks.length) return false;
  const isDCE = /double colorless/i.test(energyName || '');
  const ty = aiEnergyType(energyName).toLowerCase();
  if (typeof hasEnergyBurn === 'function' && hasEnergyBurn(card)) return true;
  for (const atk of attacks) {
    for (const c of (atk.cost || [])) {
      if (c === 'Colorless') return true;
      if (!isDCE && c.toLowerCase() === ty) return true;
    }
  }
  return false;
}

// Tokens still missing before `card` can use `atk` (0 = affordable now).
function aiAttackDeficit(card, atk, attached) {
  const cost = atk?.cost || [];
  if (!cost.length) return 0;
  if (canAffordAttack(attached, cost, card)) return 0;
  const pool = [...(attached || [])];
  const ordered = [...cost].sort((a, b) => (a === 'Colorless' ? 1 : 0) - (b === 'Colorless' ? 1 : 0));
  let k = 0;
  for (const req of ordered) {
    if (canAffordAttack(pool, cost, card)) break;
    pool.push({ name: `${req === 'Colorless' ? 'Colorless' : req} Energy` });
    k++;
  }
  return canAffordAttack(pool, cost, card) ? k : cost.length;
}

// Rough worth of an attack for readiness scoring (damage + a little for effects).
function aiAttackWorth(atk) {
  let v = aiBaseDamage(atk) || 6;   // even a damage-less attack is worth enabling
  const t = (atk?.text || '').toLowerCase();
  if (/\d+×/.test(atk?.damage || '')) v = v * 1.4;          // multi-flip attacks average more than the printed number
  if (/paralyzed|asleep|confused|poisoned/.test(t)) v += 12;
  if (/prevent all damage|draw a card|search your deck|remove .* damage counters/.test(t)) v += 10;
  return v;
}

// "Readiness" of a Pokémon with a given energy set: value of the best attack
// it is working toward, discounted by how many more attachments it needs.
function aiReadiness(card, attached) {
  const rs = [];
  for (const atk of (card?.attacks || [])) {
    const w = aiAttackWorth(atk);
    if (w <= 0) continue;
    const d = aiAttackDeficit(card, atk, attached);
    rs.push(w / (1 + d * 1.6));
  }
  if (!rs.length) return 0;
  rs.sort((a, b) => b - a);
  // Best attack counts fully; extra attacks are worth a little (options matter).
  return rs[0] + rs.slice(1).reduce((s, r) => s + r * 0.35, 0);
}

// Value of attaching `energyName` to `card` (0 = pointless).
function aiEnergyAttachValue(card, energyName, { isActive, opp } = {}) {
  if (!card || card.isDoll) return 0;
  const cap = aiUsefulEnergyCap(card);
  const have = energyValue(card.attachedEnergy || []);
  if (cap === 0 || have >= cap) return 0;
  if (!aiEnergyUsableBy(card, energyName)) return 0;
  const before = card.attachedEnergy || [];
  const after = [...before, { name: energyName }];
  const enables = aiEnergyEnablesAttack(card, energyName);
  let value = (aiReadiness(card, after) - aiReadiness(card, before)) * 2.2;
  // Water Gun / Hydro Pump users keep gaining +10 per extra Water
  if (value <= 0 && /water/i.test(energyName) && (card.attacks || []).some(a => /^(Water Gun|Hydro Pump)$/.test(a.name))) value = 8;
  if (value <= 0) return 0;
  if (enables) value += isActive ? 45 : 22;
  if (isActive) value += 12;
  // Matchup: hitting the opposing active for weakness
  if (opp?.active && (opp.active.weaknesses || []).some(w => (card.types || []).some(t => t.toLowerCase() === (w.type || '').toLowerCase()))) value += 8;
  // Fragile / heavily damaged Pokémon are poor investments
  value -= Math.min(15, (card.damage || 0) / 5);
  if (aiHp(card) <= 40 && !isActive) value -= 6;
  return Math.max(0, value);
}

// Compatibility API: best target for one named energy card.
function aiChooseEnergyTarget(p2, energyName) {
  const opp = (typeof G !== 'undefined' && G?.players) ? G.players[aiPlayerNum === 1 ? 2 : 1] : null;
  let best = null, bestScore = 0;
  if (p2.active) {
    const s = aiEnergyAttachValue(p2.active, energyName, { isActive: true, opp });
    if (s > 0) { best = { zone: 'active', idx: null }; bestScore = s; }
  }
  for (let i = 0; i < RULES.BENCH_SIZE; i++) {
    const b = p2.bench?.[i];
    if (!b) continue;
    const s = aiEnergyAttachValue(b, energyName, { isActive: false, opp });
    if (s > bestScore) { best = { zone: 'bench', idx: i }; bestScore = s; }
  }
  return best;
}

// Choose the best (energy card in hand, target) pair.
function aiChooseEnergyPlay(p2, opp, { waterOnly = false } = {}) {
  const hand = p2.hand || [];
  let best = null;
  const seen = new Set();
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c?.supertype !== 'Energy') continue;
    if (waterOnly && !/water/i.test(c.name)) continue;
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    const targets = [{ card: p2.active, zone: 'active', idx: null }, ...p2.bench.map((b, bi) => ({ card: b, zone: 'bench', idx: bi }))];
    for (const t of targets) {
      if (!t.card) continue;
      if (waterOnly && !(t.card.types || []).some(ty => /water/i.test(ty))) continue;
      let v = aiEnergyAttachValue(t.card, c.name, { isActive: t.zone === 'active', opp });
      if (v <= 0) continue;
      // Keep DCE for Pokémon that actually have Colorless slots to fill
      if (/double colorless/i.test(c.name)) {
        const colorlessSlots = (t.card.attacks || []).reduce((m, a) => Math.max(m, (a.cost || []).filter(x => x === 'Colorless').length), 0);
        if (colorlessSlots < 2) v -= 12;
      }
      if (!best || v > best.value) best = { handIdx: i, name: c.name, zone: t.zone, idx: t.idx, value: v };
    }
  }
  return best;
}

// ══════════════════════════════════════════════════════════════════════════════
// BENCH PROMOTION SCORING
// ══════════════════════════════════════════════════════════════════════════════
// Quick heuristic score of a bench Pokémon as an active candidate (pinned by
// tests). The smarter aiChoosePromotion below uses the full planner.
function benchPromotionScore(b, oppActive) {
  if (!b) return -Infinity;
  const remainingHp = aiHpLeft(b);
  const canAttack = aiCanAttack(b);
  let score = remainingHp + (canAttack ? 100 : 0);
  if (oppActive) {
    let bestDmg = 0;
    for (const atk of (b.attacks || [])) {
      if (!canAffordAttack(b.attachedEnergy, atk.cost || [], b)) continue;
      let dmg = aiBaseDamage(atk);
      if (dmg === 0) continue;
      dmg = computeDamageAfterWR(dmg, b.types || [], oppActive.weaknesses || [], oppActive.resistances || []);
      if (dmg > bestDmg) bestDmg = dmg;
    }
    score += bestDmg * 2;
  }
  return score;
}

// Pick the bench Pokémon to promote. Uses the planner (attack potential next
// turn with an energy attach + survival), with benchPromotionScore as the
// tiebreaker/fallback.
function aiChoosePromotion(p2, p1) {
  let bestIdx = -1, bestScore = -Infinity;
  for (let i = 0; i < RULES.BENCH_SIZE; i++) {
    const b = p2.bench[i];
    if (!b) continue;
    let score = benchPromotionScore(b, p1?.active || null) * 0.01;
    if (p1?.active && aiDifficulty !== 'easy') {
      const plan = evaluateAttackerPlan(b, p2, p1, null, { energyAvailable: true, meNum: aiPlayerNum });
      if (plan) score += plan.score;
      else {
        const th = aiThreatAgainst(b, { opp: p1, me: p2 });
        score -= AI_SCORE.SURVIVE * th.koProb * (0.4 + 0.6 * aiPokemonWorth(b));
      }
      if (b.isDoll) score -= 1000; // a Doll gives no prize but does nothing
    }
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  return bestIdx;
}

// ══════════════════════════════════════════════════════════════════════════════
// CARD VALUE (for discard choices: Computer Search, Oak, Item Finder...)
// ══════════════════════════════════════════════════════════════════════════════
// Higher = more worth keeping in hand right now.
function aiHoldValue(card, p2, p1) {
  if (!card) return 0;
  const inPlay = aiAllInPlay(p2);
  if (card.supertype === 'Energy') {
    const needy = inPlay.filter(c => aiEnergyAttachValue(c, card.name, { isActive: c === p2.active, opp: p1 }) > 0).length;
    const energyInHand = (p2.hand || []).filter(c => c.supertype === 'Energy').length;
    return needy ? 30 - Math.max(0, energyInHand - 2) * 5 : 8;
  }
  if (card.supertype === 'Pokémon') {
    if (aiIsBasic(card)) {
      const room = aiFreeBenchSlot(p2) !== -1;
      const evoInDeckOrHand = [...(p2.hand || []), ...(p2.deck || [])].some(c => c.evolvesFrom === card.name);
      return (room ? 25 : 6) + (evoInDeckOrHand ? 8 : 0) + aiHp(card) / 10;
    }
    // Evolution: is its base on the field / in hand?
    const baseOnField = inPlay.some(c => c.name === card.evolvesFrom);
    const baseInHand = (p2.hand || []).some(c => c.name === card.evolvesFrom);
    if (card.subtypes?.includes('Stage 2')) {
      const root = breederRootBasicName(card, p2);
      const rootOnField = inPlay.some(c => c.name === root);
      const hasBreeder = (p2.hand || []).some(c => c.name === 'Pokémon Breeder');
      const breederInDeck = (p2.deck || []).some(c => c.name === 'Pokémon Breeder');
      if (baseOnField) return 60;
      if (rootOnField && hasBreeder) return 58;
      if (rootOnField) return breederInDeck ? 48 : 40;
      if (baseInHand) return 38;
      return 16;
    }
    if (baseOnField) return 55;
    if (baseInHand) return 30;
    const baseInDeck = (p2.deck || []).some(c => c.name === card.evolvesFrom);
    return baseInDeck ? 14 : 5;
  }
  // Trainers
  const oppActiveEnergy = energyValue(p1?.active?.attachedEnergy || []);
  switch (card.name) {
    case 'Professor Oak': return (p2.deck || []).length > 12 ? 40 : 5;
    case 'Bill': return (p2.deck || []).length > 4 ? 35 : 3;
    case 'Computer Search': return 45;
    case 'Item Finder': return (p2.discard || []).some(c => c.supertype === 'Trainer') ? 30 : 10;
    case 'Gust of Wind': return 40;
    case 'Energy Removal': return oppActiveEnergy ? 38 : 25;
    case 'Super Energy Removal': return oppActiveEnergy >= 2 ? 40 : 22;
    case 'PlusPower': return 28;
    case 'Switch': return 26;
    case 'Scoop Up': return 20;
    case 'Pokémon Breeder': return (p2.hand || []).some(c => c.subtypes?.includes('Stage 2')) || (p2.deck || []).some(c => c.subtypes?.includes('Stage 2')) ? 34 : 6;
    case 'Pokémon Trader': return 22;
    case 'Poké Ball': return 18;
    case 'Energy Search': return 20;
    case 'Energy Retrieval': return (p2.discard || []).filter(c => c.supertype === 'Energy').length >= 2 ? 24 : 8;
    case 'Defender': return 16;
    case 'Potion': return 14;
    case 'Super Potion': return 15;
    case 'Full Heal': return 12;
    case 'Full Restore': return 16;
    case 'Pokémon Center': return 10;
    case 'Revive': return 12;
    case 'Maintenance': return 8;
    case 'Gambler': return 12;
    case 'Recycle': return 8;
    case 'Pokédex': return 10;
    case 'Lass': return 14;
    case 'Impostor Professor Oak': return 16;
    case 'Mr. Fuji': return 6;
    case 'Devolution Spray': return 3;
    case 'Clefairy Doll': return 8;
    case 'Mysterious Fossil': return [...(p2.hand || []), ...(p2.deck || [])].some(c => c.evolvesFrom === 'Mysterious Fossil') ? 20 : 4;
    case 'Pokémon Flute': return 6;
    default: return 10;
  }
}

// Which card would we most like to fetch from the deck right now? Returns the
// deck index or -1. Used by Computer Search / Pokémon Trader / Poké Ball.
function aiDeckWish(p2, p1, filter = () => true) {
  const deck = p2.deck || [];
  let bestIdx = -1, bestVal = 0;
  const seen = new Set();
  for (let i = 0; i < deck.length; i++) {
    const c = deck[i];
    if (!filter(c) || seen.has(c.name)) continue;
    seen.add(c.name);
    let v = aiHoldValue(c, p2, p1);
    // A card we already hold a copy of is worth less
    if ((p2.hand || []).some(h => h.name === c.name)) v *= 0.6;
    // Basics matter more when the board is thin
    if (aiIsBasic(c) && aiAllInPlay(p2).length <= 2) v += 20;
    if (v > bestVal) { bestVal = v; bestIdx = i; }
  }
  return { idx: bestIdx, value: bestVal };
}

// ══════════════════════════════════════════════════════════════════════════════
// SETUP
// ══════════════════════════════════════════════════════════════════════════════
function aiSetupScore(c, hand, forActive) {
  if (!c.attacks?.length) return -50;
  const hp = aiHp(c);
  let early = 0; // best damage reachable with ≤ 2 energy
  for (const atk of c.attacks) {
    const cost = (atk.cost || []).length;
    const d = aiBaseDamage(atk);
    if (cost <= 1) early = Math.max(early, d * 1.2 + 5);
    else if (cost === 2) early = Math.max(early, d);
    else early = Math.max(early, d * 0.4);
  }
  const hasEvoInHand = hand.some(h => h.evolvesFrom === c.name);
  let score = hp / 2 + early - (c.convertedRetreatCost || 0) * 4;
  if (forActive && hasEvoInHand) score -= 12;   // keep evolving Basics safe on the bench
  if (forActive && c.isDoll) score -= 100;
  return score;
}

function aiDoSetup() {
  if (!vsComputer || G.phase !== 'SETUP') return;
  const p2 = aiMe();
  if (p2.active) return; // idempotent
  const hand = p2.hand;
  const basics = hand.filter(c => aiIsBasic(c));
  if (!basics.length) return;

  const activeChoice = [...basics].sort((a, b) => aiSetupScore(b, hand, true) - aiSetupScore(a, hand, true))[0];
  p2.active = activeChoice;
  hand.splice(hand.indexOf(activeChoice), 1);
  if (!G.evolvedThisTurn) G.evolvedThisTurn = [];
  G.evolvedThisTurn.push(activeChoice.uid);
  aiLog(`placed ${activeChoice.name} as Active.`, true);

  const maxBench = aiDifficulty === 'easy' ? 2 : 5;  // Easy under-develops its bench
  const remaining = basics.filter(c => c !== activeChoice).sort((a, b) => aiSetupScore(b, hand, false) - aiSetupScore(a, hand, false));
  let placed = 0;
  for (const c of remaining) {
    if (placed >= maxBench) break;
    const slot = aiFreeBenchSlot(p2);
    if (slot === -1) break;
    const handIdx = hand.indexOf(c);
    if (handIdx === -1) continue;
    p2.bench[slot] = c;
    G.evolvedThisTurn.push(c.uid);
    hand.splice(handIdx, 1);
    aiLog(`placed ${c.name} on bench.`);
    placed++;
  }
  renderAll();
}

// ══════════════════════════════════════════════════════════════════════════════
// TURN PHASES
// ══════════════════════════════════════════════════════════════════════════════

// 1. Draw / search trainers — played FIRST so what they find is usable this turn.
//    Returns true if the hand changed.
async function aiPlayDrawTrainers(delayMs) {
  const p2 = aiMe(), p1 = aiOpp();
  if (aiDifficulty === 'easy' && aiRand() < 0.4) return false;
  if (typeof isTrainerBlocked === 'function' && isTrainerBlocked(aiPlayerNum)) return false;
  const hand = p2.hand;
  const deckLen = () => p2.deck.length;
  const easyOnlyBill = aiDifficulty === 'easy';
  const usefulCount = () => hand.reduce((n, c) => n + (aiHoldValue(c, p2, p1) >= 25 ? 1 : 0), 0);
  // "Developmental" cards: things that build the board this turn or next
  // (usable energy, a Basic we can bench, an evolution whose base is around).
  // Trainers like Gust/Switch don't count — a hand of only those is still dead.
  const devCount = () => hand.reduce((n, c) => {
    if (c.supertype === 'Energy') return n + (aiHoldValue(c, p2, p1) >= 25 ? 1 : 0);
    if (c.supertype === 'Pokémon') return n + (aiHoldValue(c, p2, p1) >= 25 ? 1 : 0);
    return n;
  }, 0);

  // Bill — nearly always right, unless it decks us.
  {
    const i = hand.findIndex(c => c?.name === 'Bill');
    if (i !== -1 && aiCanAffordDraw(2, p2)) {
      const card = hand.splice(i, 1)[0]; p2.discard.push(card);
      for (let d = 0; d < 2 && p2.deck.length; d++) drawCard(aiPlayerNum, true);
      aiLog(`played Bill — drew 2 cards.`, true);
      renderAll(); await aiDelay(delayMs * 0.5);
      return true;
    }
  }
  if (easyOnlyBill) return false;
  // Pokédex — free look; put the most useful cards on top.
  {
    const i = hand.findIndex(c => c?.name === 'Pokédex');
    if (i !== -1 && deckLen() >= 2) {
      const card = hand.splice(i, 1)[0]; p2.discard.push(card);
      const top = p2.deck.splice(0, Math.min(5, p2.deck.length));
      top.sort((a, b) => aiHoldValue(b, p2, p1) - aiHoldValue(a, p2, p1));
      p2.deck.unshift(...top);
      aiLog(`played Pokédex — rearranged the top of the deck.`, true);
      renderAll(); await aiDelay(delayMs * 0.4);
      return true;
    }
  }
  // Energy Search — a free basic energy when something can use it.
  {
    const i = hand.findIndex(c => c?.name === 'Energy Search');
    if (i !== -1) {
      const energies = p2.deck.map((c, di) => ({ c, di })).filter(x => x.c.supertype === 'Energy' && !/double colorless/i.test(x.c.name));
      let best = null;
      for (const e of energies) {
        if (best && best.c.name === e.c.name) continue;
        const v = Math.max(...aiAllInPlay(p2).map(pk => aiEnergyAttachValue(pk, e.c.name, { isActive: pk === p2.active, opp: p1 })), 0);
        if (!best || v > best.v) best = { ...e, v };
      }
      if (best && best.v > 0) {
        const card = hand.splice(i, 1)[0]; p2.discard.push(card);
        const found = p2.deck.splice(best.di, 1)[0];
        p2.hand.push(found);
        p2.deck = shuffle(p2.deck);
        aiLog(`played Energy Search — took ${found.name}.`, true);
        renderAll(); await aiDelay(delayMs * 0.4);
        return true;
      }
    }
  }
  // Poké Ball — free Pokémon search (coin flip).
  {
    const i = hand.findIndex(c => c?.name === 'Poké Ball');
    if (i !== -1) {
      const wish = aiDeckWish(p2, p1, c => c.supertype === 'Pokémon');
      if (wish.idx !== -1 && wish.value >= 20) {
        const card = hand.splice(i, 1)[0]; p2.discard.push(card);
        const heads = await flipCoin('Poké Ball: Heads = search deck for any Pokémon');
        if (heads) {
          const wish2 = aiDeckWish(p2, p1, c => c.supertype === 'Pokémon');
          const found = p2.deck.splice(wish2.idx, 1)[0];
          p2.hand.push(found); p2.deck = shuffle(p2.deck);
          aiLog(`played Poké Ball — HEADS! Found ${found.name}.`, true);
        } else aiLog(`played Poké Ball — TAILS, no effect.`);
        renderAll(); await aiDelay(delayMs * 0.4);
        return true;
      }
    }
  }
  // Pokémon Trader — trade a dead Pokémon card for the one we need.
  {
    const i = hand.findIndex(c => c?.name === 'Pokémon Trader');
    if (i !== -1) {
      const wish = aiDeckWish(p2, p1, c => c.supertype === 'Pokémon');
      const handPoke = hand.map((c, hi) => ({ c, hi })).filter(x => x.hi !== i && x.c.supertype === 'Pokémon')
        .sort((a, b) => aiHoldValue(a.c, p2, p1) - aiHoldValue(b.c, p2, p1));
      const giveValue = handPoke.length ? aiHoldValue(handPoke[0].c, p2, p1) : Infinity;
      if (wish.idx !== -1 && handPoke.length && giveValue < 36 && wish.value >= giveValue + 15) {
        const card = hand.splice(i, 1)[0]; p2.discard.push(card);
        const give = handPoke[0].c;
        hand.splice(hand.indexOf(give), 1);
        const found = p2.deck.splice(wish.idx, 1)[0];
        p2.deck.push(give); p2.hand.push(found); p2.deck = shuffle(p2.deck);
        aiLog(`played Pokémon Trader — traded ${give.name} for ${found.name}.`, true);
        renderAll(); await aiDelay(delayMs * 0.5);
        return true;
      }
    }
  }
  // Computer Search — discard the two least useful cards for the card we need.
  {
    const i = hand.findIndex(c => c?.name === 'Computer Search');
    if (i !== -1 && deckLen() >= 1) {
      const others = hand.map((c, hi) => ({ c, hi })).filter(x => x.hi !== i)
        .sort((a, b) => aiHoldValue(a.c, p2, p1) - aiHoldValue(b.c, p2, p1));
      if (others.length >= 2) {
        const wish = aiDeckWish(p2, p1);
        const cost = aiHoldValue(others[0].c, p2, p1) + aiHoldValue(others[1].c, p2, p1);
        const threshold = aiDifficulty === 'hard' ? 20 : 30;
        if (wish.idx !== -1 && wish.value >= cost + threshold) {
          const card = hand.splice(i, 1)[0]; p2.discard.push(card);
          const d1 = others[0].c, d2 = others[1].c;
          for (const dc of [d1, d2]) { const hi = hand.indexOf(dc); if (hi !== -1) p2.discard.push(...hand.splice(hi, 1)); }
          const wish2 = aiDeckWish(p2, p1);
          const found = p2.deck.splice(wish2.idx, 1)[0];
          p2.hand.push(found); p2.deck = shuffle(p2.deck);
          aiLog(`played Computer Search — discarded ${d1.name} + ${d2.name}, found ${found.name}.`, true);
          renderAll(); await aiDelay(delayMs * 0.5);
          return true;
        }
      }
    }
  }
  // Item Finder — get back a key trainer (Oak / Gust / Computer Search / ER).
  {
    const i = hand.findIndex(c => c?.name === 'Item Finder');
    if (i !== -1) {
      const trainers = p2.discard.filter(c => c.supertype === 'Trainer');
      const others = hand.map((c, hi) => ({ c, hi })).filter(x => x.hi !== i)
        .sort((a, b) => aiHoldValue(a.c, p2, p1) - aiHoldValue(b.c, p2, p1));
      if (trainers.length && others.length >= 2) {
        const want = trainers.map(c => ({ c, v: aiHoldValue(c, p2, p1) })).sort((a, b) => b.v - a.v)[0];
        const cost = aiHoldValue(others[0].c, p2, p1) + aiHoldValue(others[1].c, p2, p1);
        if (want.v >= cost + 15) {
          const card = hand.splice(i, 1)[0]; p2.discard.push(card);
          for (const dc of [others[0].c, others[1].c]) { const hi = hand.indexOf(dc); if (hi !== -1) p2.discard.push(...hand.splice(hi, 1)); }
          const di = p2.discard.indexOf(want.c);
          if (di !== -1) p2.hand.push(...p2.discard.splice(di, 1));
          aiLog(`played Item Finder — retrieved ${want.c.name}.`, true);
          renderAll(); await aiDelay(delayMs * 0.5);
          return true;
        }
      }
    }
  }
  // Energy Retrieval — trade a weak card for 2 energy when we're energy-starved.
  {
    const i = hand.findIndex(c => c?.name === 'Energy Retrieval');
    if (i !== -1) {
      const basicsInDiscard = p2.discard.map((c, di) => ({ c, di })).filter(x => x.c.supertype === 'Energy' && !/double colorless/i.test(x.c.name));
      const energyInHand = hand.filter(c => c.supertype === 'Energy').length;
      const others = hand.map((c, hi) => ({ c, hi })).filter(x => x.hi !== i)
        .sort((a, b) => aiHoldValue(a.c, p2, p1) - aiHoldValue(b.c, p2, p1));
      if (basicsInDiscard.length >= 1 && energyInHand <= 1 && others.length && aiHoldValue(others[0].c, p2, p1) <= 15) {
        const card = hand.splice(i, 1)[0]; p2.discard.push(card);
        const give = others[0].c; const hi = hand.indexOf(give); if (hi !== -1) p2.discard.push(...hand.splice(hi, 1));
        // Prefer energy types our Pokémon can use
        const ranked = p2.discard.map((c, di) => ({ c, di })).filter(x => x.c.supertype === 'Energy' && !/double colorless/i.test(x.c.name))
          .map(x => ({ ...x, v: Math.max(...aiAllInPlay(p2).map(pk => aiEnergyAttachValue(pk, x.c.name, { isActive: pk === p2.active, opp: p1 })), 0) }))
          .sort((a, b) => b.v - a.v).slice(0, 2);
        for (const r of ranked.sort((a, b) => b.di - a.di)) p2.hand.push(...p2.discard.splice(r.di, 1));
        aiLog(`played Energy Retrieval — traded ${give.name} for ${ranked.length} energy.`, true);
        renderAll(); await aiDelay(delayMs * 0.5);
        return true;
      }
    }
  }
  // Professor Oak — when the hand is dead and the deck can afford it (once a turn).
  {
    const i = hand.findIndex(c => c?.name === 'Professor Oak');
    if (i !== -1 && !G._aiOakThisTurn) {
      const useful = usefulCount() - 1; // excluding Oak itself
      const dev = devCount();
      const deadHand = aiDifficulty === 'hard' ? (dev <= 1 && useful <= 3) : (dev === 0 && useful <= 2);
      if (aiCanAffordDraw(7, p2) && hand.length <= 6 && (deadHand || hand.length <= 2)) {
        G._aiOakThisTurn = true;
        const discarded = hand.length - 1;
        p2.discard.push(...hand.splice(0));
        for (let d = 0; d < 7 && p2.deck.length; d++) drawCard(aiPlayerNum, true);
        aiLog(`played Professor Oak — discarded ${discarded} and drew 7.`, true);
        renderAll(); await aiDelay(delayMs * 0.6);
        return true;
      }
    }
  }
  // Gambler — only with a tiny hand.
  {
    const i = hand.findIndex(c => c?.name === 'Gambler');
    if (i !== -1 && hand.length <= 2 && aiCanAffordDraw(8, p2)) {
      const card = hand.splice(i, 1)[0]; p2.discard.push(card);
      p2.deck = shuffle([...p2.deck, ...hand.splice(0)]);
      const heads = await flipCoin('Gambler: Heads = draw 8, Tails = draw 1');
      const n = heads ? 8 : 1;
      for (let d = 0; d < n && p2.deck.length; d++) drawCard(aiPlayerNum, true);
      aiLog(`played Gambler — ${heads ? 'HEADS' : 'TAILS'}, drew ${n}.`, true);
      renderAll(); await aiDelay(delayMs * 0.5);
      return true;
    }
  }
  // Maintenance — shuffle back two dead cards, draw one.
  {
    const i = hand.findIndex(c => c?.name === 'Maintenance');
    if (i !== -1 && deckLen() >= 3) {
      const others = hand.map((c, hi) => ({ c, hi })).filter(x => x.hi !== i)
        .sort((a, b) => aiHoldValue(a.c, p2, p1) - aiHoldValue(b.c, p2, p1));
      if (others.length >= 2 && aiHoldValue(others[1].c, p2, p1) <= 10) {
        const card = hand.splice(i, 1)[0]; p2.discard.push(card);
        for (const sc of [others[0].c, others[1].c]) { const hi = hand.indexOf(sc); if (hi !== -1) p2.deck.push(...hand.splice(hi, 1)); }
        p2.deck = shuffle(p2.deck);
        drawCard(aiPlayerNum, true);
        aiLog(`played Maintenance.`, true);
        renderAll(); await aiDelay(delayMs * 0.4);
        return true;
      }
    }
  }
  // Recycle — 50% to put a premium card back on top of the deck.
  {
    const i = hand.findIndex(c => c?.name === 'Recycle');
    if (i !== -1 && p2.discard.length) {
      const best = p2.discard.map((c, di) => ({ c, di, v: aiHoldValue(c, p2, p1) })).sort((a, b) => b.v - a.v)[0];
      if (best && best.v >= 30 && deckLen() >= 2) {
        const card = hand.splice(i, 1)[0]; p2.discard.push(card);
        const heads = await flipCoin('Recycle: Heads = choose a card from discard to put on top of deck');
        if (heads) {
          const di = p2.discard.indexOf(best.c);
          if (di !== -1) p2.deck.unshift(...p2.discard.splice(di, 1));
          aiLog(`played Recycle — HEADS! ${best.c.name} placed on top of deck.`, true);
        } else aiLog(`played Recycle — TAILS, no effect.`);
        renderAll(); await aiDelay(delayMs * 0.4);
        return true;
      }
    }
  }
  return false;
}

// 2. Bench Basics (and Doll / Fossil when they help).
async function aiBenchBasics(delayMs) {
  const p2 = aiMe(), p1 = aiOpp();
  if (aiDifficulty === 'easy' && aiRand() < 0.3) return false;
  const hand = p2.hand;
  let played = false;
  // Bench the best basics first when slots are scarce
  const basics = hand.map((c, i) => ({ c, i })).filter(x => aiIsBasic(x.c))
    .sort((a, b) => aiSetupScore(b.c, hand, false) - aiSetupScore(a.c, hand, false));
  for (const { c } of basics) {
    const slot = aiFreeBenchSlot(p2);
    if (slot === -1) break;
    const idx = hand.indexOf(c);
    if (idx === -1) continue;
    hand.splice(idx, 1);
    c.damage = 0; c.attachedEnergy = c.attachedEnergy || []; clearAllStatus(c);
    p2.bench[slot] = c;
    if (!G.evolvedThisTurn) G.evolvedThisTurn = [];
    G.evolvedThisTurn.push(c.uid);
    aiLog(`played ${c.name} to bench.`, true);
    renderAll(); played = true;
    await aiDelay(delayMs * 0.5);
  }
  // Mysterious Fossil — a Basic for Aerodactyl / Kabuto / Omanyte lines.
  {
    const i = hand.findIndex(c => c?.name === 'Mysterious Fossil');
    if (i !== -1 && aiFreeBenchSlot(p2) !== -1) {
      const hasFossilLine = [...hand, ...p2.deck].some(c => c.evolvesFrom === 'Mysterious Fossil');
      const thinBoard = aiAllInPlay(p2).length <= 1;
      if (hasFossilLine || thinBoard) {
        const card = hand.splice(i, 1)[0];
        p2.discard.push(card);
        const fossilUid = `fossil-${Math.random().toString(36).slice(2, 9)}`;
        const fossil = { ...card, name: 'Mysterious Fossil', uid: fossilUid, supertype: 'Pokémon', subtypes: ['Basic'], hp: '10', attacks: [], attachedEnergy: [], damage: 0, status: null, isDoll: true, isFossil: true, canRetreat: false };
        if (!G.evolvedThisTurn) G.evolvedThisTurn = [];
        G.evolvedThisTurn.push(fossilUid);
        p2.bench[aiFreeBenchSlot(p2)] = fossil;
        aiLog(`played Mysterious Fossil to the bench.`, true);
        renderAll(); played = true;
        await aiDelay(delayMs * 0.4);
      }
    }
  }
  // Clefairy Doll — prize-free blocker; only when the board is thin or Do the Wave wants bodies.
  {
    const i = hand.findIndex(c => c?.name === 'Clefairy Doll');
    if (i !== -1 && aiFreeBenchSlot(p2) !== -1) {
      const thinBoard = aiAllInPlay(p2).length <= 1;
      const wave = aiAllInPlay(p2).some(c => c.name === 'Wigglytuff') || hand.some(c => c.name === 'Wigglytuff');
      if (thinBoard || (wave && aiBenchCount(p2) < 5)) {
        const card = hand.splice(i, 1)[0];
        p2.discard.push(card);
        const doll = { ...card, name: 'Clefairy Doll', uid: `doll-${Math.random().toString(36).slice(2, 9)}`, supertype: 'Pokémon', subtypes: ['Basic'], hp: '10', attacks: [], attachedEnergy: [], damage: 0, status: null, isDoll: true, canRetreat: false };
        p2.bench[aiFreeBenchSlot(p2)] = doll;
        aiLog(`played Clefairy Doll to the bench.`, true);
        renderAll(); played = true;
        await aiDelay(delayMs * 0.4);
      }
    }
  }
  return played;
}

// Would evolving `target` into `evoCard` be a mistake right now?
function aiEvolutionIsBad(evoCard, target, p2) {
  // Aerodactyl stops ALL evolution — including ours. Only bring it out when we
  // have nothing left to evolve.
  if (evoCard.abilities?.some(a => a.name === 'Prehistoric Power')) {
    const pendingEvos = (p2.hand || []).some(c => aiIsEvolution(c) && c !== evoCard);
    const fieldCanEvolve = aiAllInPlay(p2).some(c => c !== target && (p2.deck || []).some(d => d.evolvesFrom === c.name));
    if (pendingEvos || fieldCanEvolve) return true;
  }
  return false;
}

// 3. Evolve everything on the bench; the active is decided by the planner.
async function aiEvolveBench(delayMs) {
  const p2 = aiMe();
  if (aiDifficulty === 'easy' && aiRand() < 0.5) return false;
  if (typeof prehistoricPowerActive === 'function' && prehistoricPowerActive()) return false;
  const hand = p2.hand;
  let evolved = false, progress = true;
  while (progress) {
    progress = false;
    const evolvedUids = G.evolvedThisTurn || [];
    for (let i = 0; i < hand.length; i++) {
      const card = hand[i];
      if (!aiIsEvolution(card)) continue;
      const b = p2.bench.findIndex(s => s && s.name === card.evolvesFrom && !evolvedUids.includes(s.uid));
      if (b === -1) continue;
      if (aiEvolutionIsBad(card, p2.bench[b], p2)) continue;
      evolve(aiPlayerNum, i, 'bench', b);
      evolved = progress = true;
      await aiDelay(delayMs * 0.5);
      break;
    }
    if (progress) continue;
    // Pokémon Breeder onto a benched Basic
    const breederIdx = aiDifficulty === 'easy' ? -1 : hand.findIndex(c => c?.name === 'Pokémon Breeder');
    if (breederIdx !== -1) {
      for (let i = 0; i < hand.length; i++) {
        const s2 = hand[i];
        if (!s2?.subtypes?.includes('Stage 2')) continue;
        const root = breederRootBasicName(s2, p2);
        if (!root) continue;
        const b = p2.bench.findIndex(s => s && aiIsBasic(s) && s.name === root && !evolvedUids.includes(s.uid));
        if (b === -1) continue;
        if (await aiPlayBreeder(s2.name, 'bench', b, delayMs)) { evolved = progress = true; break; }
      }
    }
  }
  return evolved;
}

// Evolve the active when the planner didn't already (free HP), unless the
// evolution would lose the plan's outcome bucket.
async function aiEvolveActiveIfFree(plan, delayMs) {
  const p2 = aiMe(), p1 = aiOpp();
  if (!p2.active || !p1.active) return false;
  if (aiDifficulty === 'easy' && aiRand() < 0.5) return false;
  if ((G.evolvedThisTurn || []).includes(p2.active.uid)) return false;
  if (typeof prehistoricPowerActive === 'function' && prehistoricPowerActive()) return false;
  const hand = p2.hand;
  const bucket = s => Math.round((s || 0) / (AI_SCORE.SURVIVE / 2));
  const baseScore = plan ? plan.score : aiPassScore(p2, p1);
  for (let i = 0; i < hand.length; i++) {
    const evoCard = hand[i];
    if (!aiIsEvolution(evoCard) || evoCard.evolvesFrom !== p2.active.name) continue;
    if (aiEvolutionIsBad(evoCard, p2.active, p2)) continue;
    const evolved = aiEvolvedCopy(evoCard, p2.active);
    const evoPlan = evaluateAttackerPlan(evolved, p2, p1, { kind: 'evolve', handIdx: i, zone: 'active' });
    const evoScore = evoPlan ? evoPlan.score : (-AI_SCORE.SURVIVE * aiThreatAgainst(evolved).koProb * (0.4 + 0.6 * aiPokemonWorth(evolved)));
    if (bucket(evoScore) >= bucket(baseScore)) {
      evolve(aiPlayerNum, i, 'active', null);
      await aiDelay(delayMs * 0.6);
      return true;
    }
  }
  return false;
}

// 4. Pokémon Powers.
async function aiUsePowers(delayMs) {
  const p2 = aiMe(), p1 = aiOpp();
  if (aiDifficulty === 'easy') return;
  if (typeof isPowerActive !== 'function' || (typeof isMukActive === 'function' && isMukActive())) return;
  const active = p2.active;

  // Vileplume — Heal (free, once per turn)
  const vile = aiAllInPlay(p2).find(c => isPowerActive(c, 'Heal'));
  if (vile && !G.healedThisTurn) {
    const damaged = aiAllInPlay(p2).filter(c => (c.damage || 0) >= 10);
    if (damaged.length) {
      G.healedThisTurn = true;
      const heads = await flipCoin('Heal (Vileplume): Heads = remove 1 damage counter');
      if (heads) {
        const target = damaged.sort((a, b) => (b === active ? 1 : 0) - (a === active ? 1 : 0))[0];
        target.damage = Math.max(0, target.damage - 10);
        aiLog(`used Heal — removed 1 damage counter from ${target.name}.`, true);
      } else aiLog(`used Heal — TAILS.`);
      renderAll(); await aiDelay(delayMs * 0.3);
    }
  }

  // Venusaur — Energy Trans: move Grass energy to where it attacks.
  if (typeof energyTransActive === 'function' && energyTransActive(aiPlayerNum) && active) {
    const grassOn = c => (c.attachedEnergy || []).filter(e => /grass/i.test(e.name));
    const threat = aiThreatAgainst(active);
    const dying = threat.koProb >= 0.6;
    if (dying && grassOn(active).length) {
      // Save the energy: move it to the best bench attacker.
      const dest = p2.bench.filter(Boolean).filter(b => (b.types || []).some(t => /grass/i.test(t)) || (b.attacks || []).some(a => (a.cost || []).includes('Colorless')))
        .sort((a, b) => aiUsefulEnergyCap(b) - energyValue(b.attachedEnergy || []) - (aiUsefulEnergyCap(a) - energyValue(a.attachedEnergy || [])))[0];
      if (dest) {
        let moved = 0;
        while (grassOn(active).length && energyValue(dest.attachedEnergy || []) < aiUsefulEnergyCap(dest)) {
          const e = grassOn(active)[0];
          active.attachedEnergy.splice(active.attachedEnergy.indexOf(e), 1);
          (dest.attachedEnergy = dest.attachedEnergy || []).push(e);
          moved++;
        }
        if (moved) { aiLog(`used Energy Trans — moved ${moved} Grass Energy from ${active.name} to ${dest.name}.`, true); renderAll(); await aiDelay(delayMs * 0.4); }
      }
    } else if (!aiCanAttack(active) || energyValue(active.attachedEnergy || []) < aiUsefulEnergyCap(active)) {
      // Power up the active from bench Pokémon that don't need it this turn.
      let moved = 0;
      const needs = () => Math.max(0, aiUsefulEnergyCap(active) - energyValue(active.attachedEnergy || []));
      const usable = (active.attacks || []).some(a => (a.cost || []).some(c => c === 'Grass' || c === 'Colorless'));
      while (usable && needs() > 0) {
        const src = p2.bench.filter(Boolean).filter(b => grassOn(b).length).sort((a, b) => grassOn(b).length - grassOn(a).length)[0];
        if (!src) break;
        const e = grassOn(src)[0];
        src.attachedEnergy.splice(src.attachedEnergy.indexOf(e), 1);
        (active.attachedEnergy = active.attachedEnergy || []).push(e);
        moved++;
        if (moved >= 4) break;
      }
      if (moved) { aiLog(`used Energy Trans — moved ${moved} Grass Energy to ${active.name}.`, true); renderAll(); await aiDelay(delayMs * 0.4); }
    }
  }

  // Alakazam — Damage Swap / Slowbro — Strange Behavior: pull damage off a
  // threatened active onto bench Pokémon with HP to spare.
  const swapper = aiAllInPlay(p2).find(c => isPowerActive(c, 'Damage Swap'));
  const slowbro = aiAllInPlay(p2).find(c => isPowerActive(c, 'Strange Behavior'));
  if ((swapper || slowbro) && active && (active.damage || 0) >= 10) {
    const threat = aiThreatAgainst(active);
    if (threat.koProb > 0.25 || (active.damage || 0) >= aiHp(active) * 0.5) {
      let moved = 0;
      while ((active.damage || 0) >= 10 && moved < 8) {
        const sinks = (slowbro && !swapper ? [slowbro] : p2.bench.filter(Boolean)).filter(b => b !== active && !b.isDoll && (b.damage || 0) + 10 < aiHp(b))
          .sort((a, b) => aiHpLeft(b) - aiHpLeft(a));
        const sink = sinks[0];
        if (!sink) break;
        // Stop once the active survives comfortably
        const th = aiThreatAgainst(active);
        if (th.koProb === 0 && (active.damage || 0) < aiHp(active) * 0.5) break;
        active.damage -= 10; sink.damage = (sink.damage || 0) + 10; moved++;
      }
      if (moved) { aiLog(`used ${swapper ? 'Damage Swap' : 'Strange Behavior'} — moved ${moved} damage counter${moved > 1 ? 's' : ''} off ${active.name}.`, true); renderAll(); await aiDelay(delayMs * 0.4); }
    }
  }

  // Gengar — Curse: finish a 10-HP Pokémon, or make this turn's KO possible.
  const gengar = aiAllInPlay(p2).find(c => isPowerActive(c, 'Curse'));
  if (gengar && !G.cursedThisTurn && p1.active) {
    const oppAll = aiAllInPlay(p1);
    const sources = oppAll.filter(c => (c.damage || 0) >= 10);
    if (oppAll.length >= 2 && sources.length) {
      let move = null;
      // (a) KO something outright
      for (const dst of oppAll) {
        if (aiHpLeft(dst) === 10 && !dst.isDoll) {
          const src = sources.find(s => s !== dst);
          if (src) { move = { src, dst }; break; }
        }
      }
      // (b) put the active exactly in range of our best attack
      if (!move && active) {
        const plan = evaluateAttackerPlan(active, p2, p1, null);
        if (plan && plan.attack && plan.koProb < 0.5 && plan.target.card === p1.active) {
          const dist = aiDamageDistribution(plan.attack, { ...active, attachedEnergy: [...(active.attachedEnergy || []), ...plan.attachList.map(a => ({ name: a.name }))] }, p1.active, { plus: plan.plusPowerCount * 10, attackerPlayerNum: aiPlayerNum });
          const koAfter = aiProbAtLeast(dist.outcomes, aiHpLeft(p1.active) - 10);
          if (koAfter >= 0.5) {
            const src = sources.filter(s => s !== p1.active).sort((a, b) => (b.damage || 0) - (a.damage || 0))[0];
            if (src) move = { src, dst: p1.active };
          }
        }
      }
      if (move) {
        move.src.damage -= 10; move.dst.damage = (move.dst.damage || 0) + 10;
        G.cursedThisTurn = true;
        aiLog(`used Curse — moved 1 damage counter from ${move.src.name} to ${move.dst.name}.`, true);
        if (aiHpLeft(move.dst) <= 0) {
          if (move.dst === p1.active) checkKO(aiPlayerNum, aiOppNum(), move.dst, false);
          else { const bi = p1.bench.indexOf(move.dst); if (bi !== -1 && typeof koBenchAndPrize === 'function') koBenchAndPrize(aiOppNum(), bi); }
        }
        renderAll(); await aiDelay(delayMs * 0.4);
      }
    }
  }

  // Venomoth — Shift: become the type the opponent is weak to.
  if (active && isPowerActive(active, 'Shift') && !G.shiftedThisTurn && p1.active) {
    const weak = (p1.active.weaknesses || [])[0]?.type;
    if (weak && !/colorless/i.test(weak) && !(active.types || []).includes(weak)) {
      const inPlay = new Set();
      for (const pl of [p1, p2]) aiAllInPlay(pl).forEach(c => (c.types || []).forEach(t => inPlay.add(t)));
      if (inPlay.has(weak)) {
        active.types = [weak]; G.shiftedThisTurn = true;
        aiLog(`used Shift — ${active.name} is now ${weak} type!`, true);
        renderAll(); await aiDelay(delayMs * 0.3);
      }
    }
  }

  // Tentacool — Cowardice: save it (and the prize) when it's about to die.
  if (active && isPowerActive(active, 'Cowardice') && !(G.evolvedThisTurn || []).includes(active.uid) && aiBenchCount(p2) > 0) {
    const th = aiThreatAgainst(active);
    if (th.koProb >= 0.6) {
      p2.discard.push(...(active.attachedEnergy || []));
      active.attachedEnergy = []; active.damage = 0; clearAllStatus(active);
      p2.hand.push(active); p2.active = null;
      aiLog(`used Cowardice — ${active.name} returned to hand.`, true);
      renderAll();
      const idx = aiChoosePromotion(p2, p1);
      if (idx !== -1) { p2.active = p2.bench[idx]; p2.bench[idx] = null; aiLog(`moved ${p2.active.name} to Active.`); renderAll(); }
      await aiDelay(delayMs * 0.4);
    }
  }
}

// 5. Cures + disruption + healing trainers. `phase` is 'pre' (before the plan:
//    cures, energy removal) or 'post' (after preStep: Defender/Potion on the
//    Pokémon that will actually be active).
async function aiPlayUtilityTrainers(phase, delayMs) {
  const p2 = aiMe(), p1 = aiOpp();
  if (aiDifficulty === 'easy' && aiRand() < 0.5) return;
  if (typeof isTrainerBlocked === 'function' && isTrainerBlocked(aiPlayerNum)) return;
  const hand = p2.hand;
  const take = (name) => { const i = hand.findIndex(c => c?.name === name); if (i === -1) return null; const c = hand.splice(i, 1)[0]; p2.discard.push(c); return c; };
  const has = (name) => hand.some(c => c?.name === name);
  const active = p2.active;

  if (phase === 'pre') {
    // ── Status cures ────────────────────────────────────────────────────────
    const sp = aiSpecialStatus(active);
    const badStatus = sp === 'paralyzed' || sp === 'asleep' || sp === 'confused' || active?.poison || active?.burn;
    if (active && badStatus) {
      const worthCuring = sp === 'paralyzed' || sp === 'asleep' || sp === 'confused' || aiHpLeft(active) <= 30;
      if (worthCuring && has('Full Restore') && (active.damage || 0) >= 20) {
        take('Full Restore'); active.damage = 0; clearAllStatus(active);
        aiLog(`played Full Restore on ${active.name}.`, true); renderAll(); await aiDelay(delayMs * 0.4);
      } else if (worthCuring && has('Full Heal')) {
        take('Full Heal'); clearAllStatus(active);
        aiLog(`played Full Heal — ${active.name} is cured.`, true); renderAll(); await aiDelay(delayMs * 0.4);
      }
    }

    // ── Energy Removal — the energy whose loss hurts them most ──────────────
    if (aiDifficulty !== 'easy') {
      while (has('Energy Removal')) {
        const pick = aiEnergyRemovalTarget(p1, p2, 1);
        const threshold = aiDifficulty === 'hard' ? 14 : 22;
        if (!pick || pick.value < threshold) break;
        take('Energy Removal');
        const removed = pick.card.attachedEnergy.splice(pick.energyIdx, 1);
        p1.discard.push(...removed);
        aiLog(`played Energy Removal — discarded ${removed[0]?.name} from ${pick.card.name}!`, true);
        renderAll(); await aiDelay(delayMs * 0.5);
      }
      if (aiDifficulty === 'hard' && has('Super Energy Removal')) {
        const pick = aiEnergyRemovalTarget(p1, p2, 2);
        const mine = aiAllInPlay(p2).filter(c => (c.attachedEnergy || []).length);
        if (pick && pick.value >= 34 && mine.length) {
          // Pay with the energy we can most afford to lose
          const payer = mine.map(c => ({ c, surplus: energyValue(c.attachedEnergy) - aiUsefulEnergyCap(c), isActive: c === active }))
            .sort((a, b) => (b.surplus - a.surplus) || (a.isActive ? 1 : 0) - (b.isActive ? 1 : 0))[0];
          const costEnergy = aiPickRetreatDiscards(payer.c, 1)[0] || payer.c.attachedEnergy[0];
          take('Super Energy Removal');
          payer.c.attachedEnergy.splice(payer.c.attachedEnergy.indexOf(costEnergy), 1);
          p2.discard.push(costEnergy);
          const removed = [];
          for (const idx of pick.energyIdxs.sort((a, b) => b - a)) removed.push(...pick.card.attachedEnergy.splice(idx, 1));
          p1.discard.push(...removed);
          aiLog(`played Super Energy Removal — stripped ${removed.length} energy from ${pick.card.name}!`, true);
          renderAll(); await aiDelay(delayMs * 0.5);
        }
      }
    }

    // ── Impostor Professor Oak / Lass — hand disruption ─────────────────────
    if (aiDifficulty === 'hard') {
      if (has('Impostor Professor Oak') && (p1.hand || []).length >= 6 && (p1.deck || []).length >= 7) {
        take('Impostor Professor Oak');
        const oppHandSize = p1.hand.length;
        p1.deck = shuffle([...p1.deck, ...p1.hand]); p1.hand = [];
        for (let i = 0; i < 7 && p1.deck.length; i++) p1.hand.push(p1.deck.shift());
        aiLog(`played Impostor Professor Oak — opponent shuffled ${oppHandSize} cards away and drew 7.`, true);
        renderAll(); await aiDelay(delayMs * 0.5);
      }
      if (has('Lass') && (p1.hand || []).length >= 5 && hand.filter(c => c.supertype === 'Trainer').length <= 2) {
        const i = hand.findIndex(c => c.name === 'Lass'); const lass = hand.splice(i, 1)[0];
        const moved = { mine: 0, theirs: 0 };
        for (const [pl, key] of [[p1, 'theirs'], [p2, 'mine']]) {
          const trainers = pl.hand.filter(c => c.supertype === 'Trainer');
          for (const t of trainers) { pl.hand.splice(pl.hand.indexOf(t), 1); pl.deck.push(t); moved[key]++; }
          pl.deck = shuffle(pl.deck);
        }
        p2.deck.push(lass); p2.deck = shuffle(p2.deck);
        aiLog(`played Lass — opponent shuffled ${moved.theirs} Trainer card(s) into their deck.`, true);
        renderAll(); await aiDelay(delayMs * 0.5);
      }
    }

    // ── Revive — rebuild a thin bench ───────────────────────────────────────
    if (has('Revive') && aiFreeBenchSlot(p2) !== -1 && aiAllInPlay(p2).length <= 3) {
      const basics = p2.discard.filter(c => aiIsBasic(c) && !c.isDoll);
      if (basics.length) {
        const best = basics.reduce((a, b) => aiSetupScore(b, hand, false) > aiSetupScore(a, hand, false) ? b : a);
        take('Revive');
        p2.discard.splice(p2.discard.indexOf(best), 1);
        best.damage = Math.floor(aiHp(best) / 20) * 10; best.attachedEnergy = []; clearAllStatus(best); best.prevStages = undefined;
        p2.bench[aiFreeBenchSlot(p2)] = best;
        if (!G.evolvedThisTurn) G.evolvedThisTurn = [];
        G.evolvedThisTurn.push(best.uid);
        aiLog(`played Revive — brought back ${best.name}!`, true);
        renderAll(); await aiDelay(delayMs * 0.4);
      }
    }

    // ── Pokémon Center — mass heal when damage far exceeds energy invested ──
    if (has('Pokémon Center')) {
      const mine = aiAllInPlay(p2);
      const totalDmg = mine.reduce((s, c) => s + (c.damage || 0), 0);
      const energyLost = mine.filter(c => c.damage > 0).reduce((s, c) => s + energyValue(c.attachedEnergy || []), 0);
      if (totalDmg >= 80 && totalDmg >= energyLost * 25) {
        take('Pokémon Center');
        mine.forEach(c => { if (c.damage > 0) { p2.discard.push(...(c.attachedEnergy || [])); c.attachedEnergy = []; c.damage = 0; } });
        aiLog(`played Pokémon Center — healed everything!`, true);
        renderAll(); await aiDelay(delayMs * 0.4);
      }
    }

    // ── Mr. Fuji — rescue a badly damaged bench Pokémon from Gust/bench damage
    if (has('Mr. Fuji') && aiDifficulty === 'hard') {
      const victim = p2.bench.filter(Boolean).filter(b => !b.isDoll && aiHpLeft(b) <= 20 && energyValue(b.attachedEnergy || []) <= 1)
        .sort((a, b) => aiHpLeft(a) - aiHpLeft(b))[0];
      if (victim && aiAllInPlay(p2).length >= 3) {
        take('Mr. Fuji');
        const idx = p2.bench.indexOf(victim);
        p2.bench[idx] = null;
        p2.deck.push(victim, ...(victim.attachedEnergy || []), ...(victim.prevStages || []));
        victim.attachedEnergy = []; victim.damage = 0; victim.prevStages = undefined;
        p2.deck = shuffle(p2.deck);
        aiLog(`played Mr. Fuji — ${victim.name} shuffled back into the deck.`, true);
        renderAll(); await aiDelay(delayMs * 0.4);
      }
    }

    // ── Pokémon Flute — hand them a free Basic we can Gust up and KO ─────────
    if (has('Pokémon Flute') && has('Gust of Wind') && aiDifficulty === 'hard' && aiFreeBenchSlot(p1) !== -1 && aiAllInPlay(p1).length >= 2) {
      const weak = p1.discard.filter(c => aiIsBasic(c) && aiHp(c) <= 50).sort((a, b) => aiHp(a) - aiHp(b))[0];
      if (weak && active && aiCanAttack(active)) {
        take('Pokémon Flute');
        p1.discard.splice(p1.discard.indexOf(weak), 1);
        weak.damage = 0; weak.attachedEnergy = []; clearAllStatus(weak); weak.prevStages = undefined;
        p1.bench[aiFreeBenchSlot(p1)] = weak;
        aiLog(`played Pokémon Flute — ${weak.name} placed on the opponent's bench.`, true);
        renderAll(); await aiDelay(delayMs * 0.4);
      }
    }
    return;
  }

  // ── phase === 'post' — protection / healing for the Pokémon that stays active
  if (!active) return;
  const threat = aiThreatAgainst(active);
  const hpLeft = aiHpLeft(active);
  const worth = aiPokemonWorth(active);

  // Potion / Super Potion: escape a KO, or top up a valuable Pokémon.
  if ((active.damage || 0) >= 20) {
    const heals = [];
    if (has('Potion')) heals.push({ name: 'Potion', amount: RULES.POTION_HEAL, cost: 0 });
    if (has('Super Potion') && (active.attachedEnergy || []).length > 0 && energyValue(active.attachedEnergy) > aiUsefulEnergyCap(active) - 1) heals.push({ name: 'Super Potion', amount: RULES.SUPER_POTION_HEAL, cost: 1 });
    for (const h of heals) {
      const healed = Math.min(active.damage || 0, h.amount);
      const after = aiThreatAgainst(active, { hpLeft: hpLeft + healed });
      const saves = threat.koProb - after.koProb;
      const topUp = healed >= 20 && worth >= 0.5 && threat.koProb === 0 && (active.damage || 0) >= 30;
      if (saves >= 0.3 || (topUp && h.cost === 0) || (h.name === 'Potion' && (active.damage || 0) >= 40 && aiDifficulty !== 'hard')) {
        take(h.name);
        if (h.cost) { const e = aiPickRetreatDiscards(active, 1)[0]; if (e) { active.attachedEnergy.splice(active.attachedEnergy.indexOf(e), 1); p2.discard.push(e); } }
        active.damage = Math.max(0, (active.damage || 0) - h.amount);
        aiLog(`played ${h.name} — healed ${active.name}.`, true);
        renderAll(); await aiDelay(delayMs * 0.4);
        break;
      }
    }
  }
  // Defender: play if it turns a likely KO into a likely survival (or shields a valuable Pokémon).
  if (has('Defender') && aiDifficulty !== 'easy') {
    const th = aiThreatAgainst(active);
    const withDef = aiThreatAgainst(active, { defenderOverrides: { defender: true } });
    if (th.koProb - withDef.koProb >= 0.3 || (th.expDmg >= 30 && worth >= 0.7 && aiDifficulty === 'hard' && hand.filter(c => c.name === 'Defender').length >= 2)) {
      take('Defender');
      active.defender = true;
      aiLog(`played Defender on ${active.name}.`, true);
      renderAll(); await aiDelay(delayMs * 0.4);
    }
  }
}

// Which opposing energy should Energy Removal (count=1) / Super Energy Removal
// (count=2) hit? Returns { card, energyIdx, energyIdxs, value } or null.
function aiEnergyRemovalTarget(p1, p2, count) {
  const me = p2;
  let best = null;
  const myActive = me.active;
  const candidates = aiAllInPlay(p1).filter(c => (c.attachedEnergy || []).length);
  for (const card of candidates) {
    const isActive = card === p1.active;
    const attached = card.attachedEnergy;
    // Try removing each subset of size `count` (DCE first — it's worth two)
    const idxs = attached.map((e, i) => i).sort((a, b) => (/double colorless/i.test(attached[b].name) ? 1 : 0) - (/double colorless/i.test(attached[a].name) ? 1 : 0));
    const combos = [];
    if (count === 1) idxs.forEach(i => combos.push([i]));
    else { for (let a = 0; a < idxs.length; a++) for (let b = a + 1; b < idxs.length; b++) combos.push([idxs[a], idxs[b]]); if (idxs.length === 1) combos.push([idxs[0]]); }
    for (const combo of combos) {
      const after = attached.filter((e, i) => !combo.includes(i));
      const removedValue = energyValue(attached) - energyValue(after);
      let value = removedValue * 10;
      const before = isActive && myActive ? threatSummary(p1, me, { defender: myActive, attackerPlayerNum: aiOppNum() }) : null;
      if (isActive && myActive) {
        const oppView = { ...p1, active: { ...card, attachedEnergy: after } };
        const afterTh = threatSummary(oppView, me, { defender: myActive, attackerPlayerNum: aiOppNum() });
        value += (before.expDmg - afterTh.expDmg) * 1.2 + (before.koProb - afterTh.koProb) * 60;
        // Can they still attack at all?
        const canStill = (card.attacks || []).some(a => canAffordAttack(after, a.cost || [], card));
        if (!canStill) value += 12;
      } else {
        // Bench: slow down the Pokémon they're building
        const bestDmg = (card.attacks || []).reduce((m, a) => Math.max(m, aiBaseDamage(a)), 0);
        value += Math.min(15, bestDmg / 5) + (aiStage(card) * 4);
        if (energyValue(after) === 0) value += 4;
      }
      if (!best || value > best.value) best = { card, energyIdx: combo[0], energyIdxs: combo, value };
    }
  }
  return best;
}

// Attach one energy (or several under Rain Dance) outside the attack plan.
async function aiAttachEnergyOutsidePlan(delayMs) {
  const p2 = aiMe(), p1 = aiOpp();
  if (!G.energyPlayedThisTurn) {
    let pick = aiChooseEnergyPlay(p2, p1);
    if (aiDifficulty === 'easy' && pick && aiRand() < 0.5) {
      const targets = [{ zone: 'active', idx: null }, ...p2.bench.map((b, i) => b ? { zone: 'bench', idx: i } : null).filter(Boolean)];
      const t = targets[Math.floor(aiRand() * targets.length)];
      pick = { ...pick, ...t };
    }
    if (pick) {
      attachEnergy(aiPlayerNum, pick.handIdx, pick.zone, pick.idx, false);
      const tgt = pick.zone === 'active' ? p2.active : p2.bench[pick.idx];
      aiLog(`attached ${pick.name} to ${tgt?.name}.`);
      renderAll(); await aiDelay(delayMs * 0.5);
    }
  }
  if (typeof rainDanceActive === 'function' && rainDanceActive(aiPlayerNum) && aiDifficulty !== 'easy') {
    for (let n = 0; n < 6; n++) {
      const pick = aiChooseEnergyPlay(p2, p1, { waterOnly: true });
      if (!pick) break;
      attachEnergy(aiPlayerNum, pick.handIdx, pick.zone, pick.idx, true);
      const tgt = pick.zone === 'active' ? p2.active : p2.bench[pick.idx];
      aiLog(`attached Water Energy via Rain Dance to ${tgt?.name}.`);
      renderAll(); await aiDelay(delayMs * 0.35);
    }
  }
}

// Make sure we have an active Pokémon (after a Cowardice / odd state).
async function aiEnsureActive(delayMs) {
  const p2 = aiMe(), p1 = aiOpp();
  if (p2.active) return true;
  const idx = aiChoosePromotion(p2, p1);
  if (idx === -1) return false;
  p2.active = p2.bench[idx]; p2.bench[idx] = null;
  aiLog(`moved ${p2.active.name} to Active.`);
  renderAll(); await aiDelay(delayMs * 0.5);
  return true;
}

// ══════════════════════════════════════════════════════════════════════════════
// FULL TURN
// ══════════════════════════════════════════════════════════════════════════════
async function aiTakeTurn() {
  if (!vsComputer || G.turn !== aiPlayerNum || aiThinking || !G.started) return;
  if (G.phase === 'PROMOTE') {
    if (G.pendingPromotion === aiPlayerNum) aiDoPromotion();
    return;
  }
  aiThinking = true;

  const badge = document.getElementById('turn-badge');
  if (badge) { badge.textContent = '🤖 THINKING...'; badge.className = `turn-badge p${aiPlayerNum}`; }

  const AI_DELAY = aiDelayMs();

  try {
    if (G.phase === 'DRAW') {
      drawCard(aiPlayerNum, true);
      if (!G.started) { aiThinking = false; return; }
      transitionPhase('MAIN');
      await aiDelay(AI_DELAY * 0.5);
    }
    if (G.phase !== 'MAIN') { aiThinking = false; return; }

    const p2 = aiMe();
    const p1 = aiOpp();
    G._aiOakThisTurn = false;

    if (!(await aiEnsureActive(AI_DELAY))) { aiThinking = false; endTurn(); return; }

    // ── Development loop: draw/search → bench → evolve → powers ────────────
    for (let pass = 0; pass < 4 && G.started; pass++) {
      const drew = await aiPlayDrawTrainers(AI_DELAY);
      await aiBenchBasics(AI_DELAY);
      await aiEvolveBench(AI_DELAY);
      if (!drew) break;
    }
    if (!G.started) { aiThinking = false; return; }
    await aiPlayUtilityTrainers('pre', AI_DELAY);
    await aiUsePowers(AI_DELAY);
    if (!G.started || G.phase === 'PROMOTE') { aiThinking = false; return; }
    if (!(await aiEnsureActive(AI_DELAY))) { aiThinking = false; endTurn(); return; }

    // ── Plan the attack (with positioning) ─────────────────────────────────
    let plan = null;
    if (p1.active) {
      plan = aiDifficulty === 'easy'
        ? aiBuildTurnPlan(p2, p1, { noRetreat: true, noSwitch: true })   // Easy never repositions
        : aiBuildTurnPlan(p2, p1);
      if (plan && aiDifficulty === 'easy') {
        // Easy makes mistakes: sometimes ignore positioning, often pick a random attack.
        if (plan.preStep && aiRand() < 0.7) plan = evaluateAttackerPlan(p2.active, p2, p1, null);
        if (plan && aiRand() < 0.5) {
          const affordable = (p2.active.attacks || []).filter(a => canAffordAttack(p2.active.attachedEnergy, a.cost, p2.active));
          if (affordable.length) plan = { ...plan, attack: affordable[Math.floor(aiRand() * affordable.length)], plusPowerCount: 0, attachList: [], target: { benchIdx: null, card: p1.active, gustHandIdx: null } };
        }
      }
      // Never act when passing scores better: a self-KO attack for nothing, or
      // a retreat/Switch/Scoop that only shuffles Pokémon around.
      if (plan && plan.score < aiPassScore(p2, p1) - 5) plan = null;
    }

    if (plan?.wouldWinByPrizes || plan?.wouldWinByNoPokemon) aiLog(`sees the winning move!`, true);

    if (plan?.preStep) {
      const ok = await executePreStepOnly(plan.preStep, AI_DELAY);
      if (!ok) plan = aiBuildTurnPlan(p2, p1, { noEvolve: true, noRetreat: true, noSwitch: true });
    }
    if (!G.started || G.phase === 'PROMOTE') { aiThinking = false; return; }

    // Evolve the active for free HP when the planner didn't already.
    if (await aiEvolveActiveIfFree(plan?.preStep ? null : plan, AI_DELAY)) {
      plan = p1.active ? aiBuildTurnPlan(p2, p1, { noEvolve: true, noRetreat: true, noSwitch: true }) : null;
      if (plan && plan.attack && plan.score < aiPassScore(p2, p1) - 5) plan = null;
    }

    // ── Protection / healing on the Pokémon that will stay active ──────────
    await aiPlayUtilityTrainers('post', AI_DELAY);
    if (!G.started) { aiThinking = false; return; }

    // Re-plan the tail (attach / PlusPower / Gust / attack) against the final board.
    if (p1.active && p2.active) {
      const tail = aiBuildTurnPlan(p2, p1, { noEvolve: true, noRetreat: true, noSwitch: true });
      if (tail && (!tail.attack || tail.score >= aiPassScore(p2, p1) - 5)) plan = tail;
      else plan = null;
    } else plan = null;

    // ── Energy outside the plan (bench building) ───────────────────────────
    const planAttaches = plan?.attachList?.length ? true : false;
    if (!planAttaches) await aiAttachEnergyOutsidePlan(AI_DELAY);
    else if (typeof rainDanceActive === 'function' && rainDanceActive(aiPlayerNum)) {
      // Plan attaches to the active; Rain Dance can still feed the bench afterwards.
    }
    if (!G.started) { aiThinking = false; return; }

    // Second look at the plan (energy attach may have enabled something)
    if (!planAttaches && p1.active && p2.active) {
      const again = aiBuildTurnPlan(p2, p1, { noEvolve: true, noRetreat: true, noSwitch: true });
      if (again && again.attack && again.score >= aiPassScore(p2, p1) - 5) plan = again;
    }

    if (plan && p2.active && p1.active) {
      await executePlanTail(plan, AI_DELAY);
      // Rain Dance leftovers for the bench after the plan's own attaches
      return;
    }

    await aiDelay(AI_DELAY * 0.4);
    aiThinking = false;
    if (G.started && G.turn === aiPlayerNum && G.phase !== 'PROMOTE') endTurn();
  } catch (e) {
    console.error('AI error:', e);
    aiThinking = false;
    if (G.started && G.turn === aiPlayerNum && G.phase !== 'PROMOTE') endTurn();
  }
}

// Fallback attack chooser (kept for compatibility with older callers).
async function aiChooseAndAttack() {
  const p2 = aiMe(), p1 = aiOpp();
  if (!p2.active || !p1.active) return false;
  const plan = evaluateAttackerPlan(p2.active, p2, p1, null);
  if (!plan || !plan.attack) return false;
  await executePlanTail({ ...plan, attachList: [], plusPowerCount: 0, target: { benchIdx: null, card: p1.active, gustHandIdx: null } }, aiDelayMs());
  return true;
}

// ── Promotion ─────────────────────────────────────────────────────────────────
function aiDoPromotion() {
  if (!vsComputer || G.phase !== 'PROMOTE' || G.pendingPromotion !== aiPlayerNum) return;
  const p2 = aiMe();
  const p1 = aiOpp();
  const bestIdx = aiChoosePromotion(p2, p1);
  if (bestIdx === -1) {
    if (G.started) {
      const winner = aiOppNum();
      addLog(`Computer has no Pokémon left — Player ${winner} wins!`, true);
      G.started = false;
      showWinScreen(winner, 'OPPONENT HAS NO POKÉMON LEFT');
      if (typeof pushGameState === 'function') pushGameState();
    }
    return;
  }
  resolvePromotion(aiPlayerNum, bestIdx);
}

// ── Function hooks — deferred until game-actions.js is loaded ─────────────────
window.addEventListener('load', () => {
  {
    const _orig = endTurn;
    endTurn = function() {
      _orig();
      if (!vsComputer || !G.started) return;
      if (G.phase === 'PROMOTE') {
        // e.g. our attacker KO'd itself with recoil while scoring a KO — the
        // engine asks us to promote through endTurn's safety net.
        if (G.pendingPromotion === aiPlayerNum) setTimeout(() => aiDoPromotion(), 500);
        return;
      }
      if (G.turn === aiPlayerNum) {
        aiThinking = false;
        setTimeout(() => aiTakeTurn(), 900);
      }
    };
  }
  {
    const _orig = resolvePromotion;
    resolvePromotion = function(player, benchIdx) {
      _orig(player, benchIdx);
      if (!vsComputer || !G.started) return;
      if (G.phase === 'PROMOTE' && G.pendingPromotion === aiPlayerNum) { setTimeout(() => aiDoPromotion(), 400); return; }
      if (G.turn === aiPlayerNum && G.phase !== 'PROMOTE') {
        aiThinking = false;
        setTimeout(() => aiTakeTurn(), 900);
      }
    };
  }
  {
    const _orig = checkKO;
    checkKO = function(attackingPlayer, defendingPlayer, card, isSelf) {
      const result = _orig(attackingPlayer, defendingPlayer, card, isSelf);
      if (vsComputer && result === 'promote' && G.pendingPromotion === aiPlayerNum) {
        setTimeout(() => aiDoPromotion(), 400);
      }
      return result;
    };
  }
  {
    const _orig = doneSetup;
    doneSetup = async function() {
      if (vsComputer && !aiMe().active) aiDoSetup();
      await _orig();
    };
  }
  {
    const _origLoad = loadDeck;
    loadDeck = async function(fKey, deckName) {
      await _origLoad(fKey, deckName);
      if (document.getElementById('vs-computer-panel')?.style.display !== 'none') checkVsCpuReady();
    };
  }
  setMidline('Load decks and press Start Game');
});

// ── Node export for tests — no-op in the browser ──────────────────────────────
if (typeof module !== 'undefined') {
  module.exports = {
    aiChooseEnergyTarget,
    aiChooseEnergyPlay,
    aiEnergyDeficit,
    aiEnergyAttachValue,
    aiCanAttack,
    opponentThreatNextTurn,
    willActiveDieNextTurn,
    threatSummary,
    maxDamageForAttack,
    attackProfile,
    aiDamageDistribution,
    aiFindBestKOPlan,
    aiBuildTurnPlan,
    evaluateAttackerPlan,
    aiPassScore,
    prizesRemaining,
    benchPromotionScore,
    aiChoosePromotion,
    breederRootBasicName,
    aiHoldValue,
    aiEnergyRemovalTarget,
    aiSetupScore,
    aiCanAffordDraw,
    aiReadiness,
    AI_SCORE,
  };
}
