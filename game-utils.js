// ══════════════════════════════════════════════════════════════════════════════
// GAME-UTILS.JS — Pure utility functions shared between game logic and tests
//
// No DOM, no Firebase, no G — completely stateless pure functions.
// Loaded before game-actions.js in the browser; required directly by game-tests.js.
//
// Exports (Node/CommonJS):
//   RULES, energyValue, canAffordAttack, parseStatusEffects,
//   padBench, isLegalRetreatStatus, invisibleWallBlocks,
//   isValidDeckSize, countCopies, computeDamageAfterWR, applyPlusPowerValue,
//   coerceCardArrays, mergeGameStateDefaults, GAME_STATE_DEFAULTS
//
// Any time you fix a bug, add a pure helper here (or a test against an existing
// helper) — the push script runs `node game-tests.js` and will block the push
// if anything fails.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

// ── TCG Rule Constants ────────────────────────────────────────────────────────
// Single source of truth for fixed game parameters.
// Reference these everywhere instead of bare magic numbers.
const RULES = {
  BENCH_SIZE:       5,   // maximum Pokémon on each bench
  PRIZE_COUNT:      6,   // prizes set aside at game start
  STARTING_HAND:    7,   // cards drawn at game start
  DECK_SIZE:        60,  // legal deck size
  DAMAGE_STEP:      10,  // one damage counter = 10 damage
  POTION_HEAL:      20,  // Potion removes 2 counters
  SUPER_POTION_HEAL:40,  // Super Potion removes 4 counters
  FULL_HEAL_HEAL:   80,  // Full Heal / Full Restore max
  MAX_CARD_COPIES:  4,   // max copies of any non-basic-energy card
  INVISIBLE_WALL_THRESHOLD: 30, // Mr. Mime blocks attacks doing >= this much damage
};

// ── GAME_STATE_DEFAULTS ───────────────────────────────────────────────────────
// Mutable per-card fields that must survive every Firebase round-trip.
// Mirrored in game-render.js (the browser-side definition); kept here so
// tests can verify the schema without loading the renderer.
// If you add a field in one place, add it in the other too.
const GAME_STATE_DEFAULTS = {
  status:               null,
  damage:               0,
  defender:             false,
  defenderFull:         false,
  defenderFullEffects:  false,
  defenderThreshold:    0,
  defenderReduction:    0,
  plusPower:            0,
  nextAttackDouble:     false,
  smokescreened:        false,
  immuneToAttack:       false,
  disabledAttack:       null,
  cantRetreat:          false,
  destinyBond:          false,
  leekSlapUsed:         false,
  pounceActive:         false,
  pounceReduction:      0,
  swordsDanceActive:    false,
  attackReduction:      0,
  conversionWeakness:   null,
  conversionResistance: null,
  trainerBlocked:       false,
};

// ── energyValue ───────────────────────────────────────────────────────────────
// Returns the total number of energy tokens provided by an array of attached
// energy cards. Double Colorless Energy counts as 2.
function energyValue(attachedEnergy) {
  return (attachedEnergy || []).reduce((sum, e) =>
    sum + (/double colorless/i.test(e.name || '') ? 2 : 1), 0);
}

// ── canAffordAttack ───────────────────────────────────────────────────────────
// Returns true if `attachedEnergy` satisfies the energy `cost` array.
// Handles: typed energy, Colorless wildcards, Double Colorless Energy,
// and Charizard's Energy Burn (all energy counts as Fire).
//
// `attackerCard` is passed so hasEnergyBurn() can be called; the caller
// (game-actions.js) supplies the real hasEnergyBurn; game-tests.js stubs it.
function canAffordAttack(attachedEnergy, cost, attackerCard) {
  if (!cost || cost.length === 0) return true;

  // Build a pool of energy tokens from attached cards.
  // Energy Burn (Charizard): all attached energy counts as Fire.
  const energyBurn = attackerCard && hasEnergyBurn(attackerCard);
  const pool = [];
  for (const e of (attachedEnergy || [])) {
    const name = e.name || '';
    if (energyBurn) {
      // DCE still counts as 2 energy under Energy Burn — both become Fire
      const count = /double colorless/i.test(name) ? 2 : 1;
      for (let i = 0; i < count; i++) pool.push('Fire');
    } else if (/double colorless/i.test(name)) {
      pool.push('Colorless', 'Colorless');
    } else {
      // Derive type from name e.g. "Water Energy" → "Water"
      const type = name.replace(/\s*energy/i, '').trim() || 'Colorless';
      pool.push(type);
    }
  }

  // Sort cost: specific types first, Colorless last —
  // prevents wasting typed energy on Colorless slots.
  const sortedCost = [...cost].sort((a, b) =>
    (a === 'Colorless' ? 1 : 0) - (b === 'Colorless' ? 1 : 0)
  );

  const remaining = [...pool];
  for (const req of sortedCost) {
    if (req === 'Colorless') {
      // Any single energy satisfies Colorless
      if (remaining.length === 0) return false;
      remaining.splice(0, 1);
    } else {
      // Must match exact type
      const idx = remaining.indexOf(req);
      if (idx === -1) return false;
      remaining.splice(idx, 1);
    }
  }
  return true;
}

// ── parseStatusEffects ────────────────────────────────────────────────────────
// Parses a move's text for status-inflicting effects.
// Returns an array of effect descriptors:
//   { status, coinRequired, onTails, self }  — standard status
//   { type:'either', heads, tails, self }    — branching single-flip effect
function parseStatusEffects(text) {
  if (!text) return [];
  const effects = [];
  const t = text;

  // ── Special patterns that need single coin flip with branching outcomes ──

  // "Poisoned; if tails, it is now Confused" → one flip: heads=Poison, tails=Confused
  if (/poisoned.*if tails.*confused/i.test(t)) {
    effects.push({ type: 'either', heads: 'poisoned', tails: 'confused', self: false });
    return effects; // handled completely
  }

  // "Confused and Poisoned" → apply both directly, no flip
  if (/confused and poisoned/i.test(t)) {
    effects.push({ status: 'confused', coinRequired: false, self: false });
    effects.push({ status: 'poisoned', coinRequired: false, self: false });
    return effects;
  }

  // ── Standard patterns ──
  const statuses = ['Paralyzed','Asleep','Poisoned','Confused','Burned'];
  for (const status of statuses) {
    const re = new RegExp(`(If (heads|tails), )?[^.]*(?:Defending|${text.match(/[A-Z][a-z]+(?= is now)/)?.[0]||''})[^.]*is now ${status}`, 'i');
    const match = t.match(re);
    if (match) {
      const coinRequired = /if (heads|tails)/i.test(match[0]);
      const onTails = /if tails/i.test(match[0]);
      const selfStatus = /(?:Vileplume|Gloom|Primeape|Tauros|[A-Z][a-z]+) is now/i.test(match[0]) &&
                         !/Defending/i.test(match[0]);
      effects.push({ status: status.toLowerCase(), coinRequired, onTails, self: selfStatus });
    }
  }

  // Deduplicate
  const seen = new Set();
  return effects.filter(e => {
    const key = `${e.status || e.type}-${e.self}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// BUG-REGRESSION HELPERS
// Each of these encodes a rule that was either wrong in the past or is easy
// to get wrong in the future. The live game code mirrors these rules inline;
// these helpers exist primarily to be test-locked. Callers may optionally
// switch to these helpers to reduce duplication.
// ══════════════════════════════════════════════════════════════════════════════

// ── padBench ──────────────────────────────────────────────────────────────────
// Firebase Realtime Database drops trailing nulls from arrays during
// serialization. After every read from Firebase, bench arrays must be padded
// back to BENCH_SIZE so index-based placement/evolution/retreat logic works.
// Returns a NEW array (does not mutate input).
function padBench(bench) {
  const out = Array.isArray(bench) ? [...bench] : [];
  while (out.length < RULES.BENCH_SIZE) out.push(null);
  return out.slice(0, RULES.BENCH_SIZE);
}

// ── isLegalRetreatStatus ──────────────────────────────────────────────────────
// TCG rule: Paralyzed and Asleep Pokémon cannot retreat at all.
// Confused Pokémon can attempt to retreat but must flip a coin (handled
// separately). Healthy, Poisoned, Burned Pokémon may proceed to the normal
// retreat-cost check.
// Returns: 'yes' | 'no' | 'coinflip'
function isLegalRetreatStatus(status) {
  if (status === 'paralyzed' || status === 'asleep') return 'no';
  if (status === 'confused') return 'coinflip';
  return 'yes'; // null, poisoned, burned
}

// ── invisibleWallBlocks ───────────────────────────────────────────────────────
// Mr. Mime's Invisible Wall Power: prevents an attack that would do
// 30 or more damage before applying weakness/resistance.
// (Precondition: Mr. Mime is the Defender and his Power is not suppressed.)
function invisibleWallBlocks(damage) {
  return damage >= RULES.INVISIBLE_WALL_THRESHOLD;
}

// ── isValidDeckSize / countCopies ─────────────────────────────────────────────
// Deck construction rules: exactly 60 cards, no more than 4 copies of any
// single non-basic-energy card.
function isValidDeckSize(deck) {
  return Array.isArray(deck) && deck.length === RULES.DECK_SIZE;
}

function countCopies(deck, predicate) {
  return (deck || []).filter(predicate).length;
}

// ── applyPlusPowerValue ───────────────────────────────────────────────────────
// Returns the damage number after PlusPower bonuses. Both per-card
// `plusPower` and per-turn-global `plusPowerActive` stack.
// This is a PURE computation — the in-game version also mutates state and
// logs, but those side effects are not this helper's job.
function applyPlusPowerValue(damage, cardPlusPower = 0, globalPlusPower = 0) {
  return damage + (cardPlusPower || 0) + (globalPlusPower || 0);
}

// ── computeDamageAfterWR ──────────────────────────────────────────────────────
// Apply weakness and resistance to a damage number.
//   - Weakness doubles damage (only one weakness applies; match any type).
//   - Resistance subtracts 30, floor at 0 (only one resistance applies).
//   - skipWR=true disables both (used by Gust of Wind, some rare attacks).
// W and R for a given defender rarely overlap, but if both match the
// attacker's types, weakness applies first, then resistance.
function computeDamageAfterWR(damage, attackerTypes, weaknesses, resistances, skipWR = false) {
  if (skipWR || damage === 0) return damage;
  const types = (attackerTypes || []).map(t => t.toLowerCase());
  let dmg = damage;
  for (const wk of (weaknesses || [])) {
    if (types.includes((wk.type || '').toLowerCase())) { dmg *= 2; break; }
  }
  for (const rs of (resistances || [])) {
    if (types.includes((rs.type || '').toLowerCase())) { dmg = Math.max(0, dmg - 30); break; }
  }
  return dmg;
}

// ── coerceCardArrays ──────────────────────────────────────────────────────────
// Firebase round-trips drop empty arrays and can turn them into undefined.
// After reading a card from Firebase, every array-valued field must be
// coerced back to an array. This mirrors the defensive coercion inside
// enrichCard (game-render.js) — it exists here so the contract is testable.
// Returns a NEW object (does not mutate input).
function coerceCardArrays(card) {
  if (!card || typeof card !== 'object') return card;
  const arrayFields = [
    'types', 'subtypes', 'attacks', 'abilities',
    'weaknesses', 'resistances', 'retreatCost', 'attachedEnergy',
  ];
  const out = { ...card };
  for (const f of arrayFields) {
    if (!Array.isArray(out[f])) out[f] = [];
  }
  return out;
}

// ── mergeGameStateDefaults ────────────────────────────────────────────────────
// Given a card (possibly fresh from Firebase, possibly missing fields),
// returns it with every GAME_STATE_DEFAULTS field filled in. Uses ?? so
// existing `false`, `0`, `null` values are preserved (only undefined falls
// back to default). Returns a NEW object; does not mutate input.
function mergeGameStateDefaults(card) {
  if (!card) return card;
  const out = { ...card };
  for (const [k, def] of Object.entries(GAME_STATE_DEFAULTS)) {
    out[k] = out[k] ?? def;
  }
  return out;
}

// ── parseDiscardEnergyCost ────────────────────────────────────────────────────
// Parses an attack's "Discard N [Type] Energy card(s) attached..." cost text.
// Returns { isAll, n, requiredType } or null if the text doesn't match.
//   isAll:        true if the attack discards ALL attached energy
//   n:            number to discard (Infinity if isAll)
//   requiredType: lowercase type word ('fire', 'water', 'psychic', '') —
//                 empty string means any type satisfies
function parseDiscardEnergyCost(text) {
  const m = (text || '').match(
    /discard (all|\d+|an?)\s+(?:(\S+) )?energy card[s]?\s+attached[^.]*in order to use this attack/i
  );
  if (!m) return null;
  const rawN = m[1].toLowerCase();
  const requiredType = (m[2] || '').toLowerCase();
  const isAll = rawN === 'all';
  const n = isAll ? Infinity : (/^\d+$/.test(rawN) ? parseInt(rawN) : 1);
  return { isAll, n, requiredType };
}

// ── eligibleEnergyForDiscard ──────────────────────────────────────────────────
// Given the attached-energy array and a parsed cost, returns the indices of
// cards eligible to satisfy that discard. A typed cost ('fire') only accepts
// energy cards whose name contains that type AND is not Double Colorless.
//
// This is the rule that prevents Charizard's Energy Burn from polluting the
// discard mechanic: even though Energy Burn lets DCE pay a Fire cost, a DCE
// is still a "Colorless Energy card" — it does not satisfy "Discard 1 Fire
// Energy card."
//
// `attachedEnergy` is the raw attached array; entries look like { name: 'Fire Energy', ... }.
function eligibleEnergyForDiscard(attachedEnergy, requiredType) {
  return (attachedEnergy || [])
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => {
      if (!requiredType) return true;
      const nm = (e.name || '').toLowerCase();
      if (/double colorless/.test(nm)) return false;
      return nm.includes(requiredType);
    })
    .map(({ i }) => i);
}


// TCG rule: at every turn boundary, EVERY active Pokémon with poison/burn
// takes a tick of damage. Not "the player whose turn just ended" — both.
// One full round (P1→P2→P1) ticks each poisoned Pokémon twice.
//
// Returns an array of {player, status, dmg, newDamage} entries describing
// what damage SHOULD be applied — caller is responsible for mutating cards,
// logging, and running KO checks. Pure: no mutation, no side effects.
//
// Why a helper? The inline loop in endTurn was reportedly skipping P2's tick
// in some cases. Extracting and unit-testing the computation locks the rule
// down so the caller can't subtly miss it.
//
// `players` shape: { 1: { active: card|null }, 2: { active: card|null } }
function computeBetweenTurnDamage(players) {
  const out = [];
  for (const pNum of [1, 2]) {
    const active = players?.[pNum]?.active;
    if (!active || !active.status) continue;
    let dmg = 0;
    if (active.status === 'poisoned')        dmg = 10;
    else if (active.status === 'poisoned-toxic') dmg = 20;
    else if (active.status === 'burned')     dmg = 20;
    if (dmg === 0) continue;
    out.push({
      player:    pNum,
      status:    active.status,
      dmg,
      newDamage: (active.damage || 0) + dmg,
    });
  }
  return out;
}


// ── Pokémon Breeder gender-line helpers ───────────────────────────────────────
// Nidoqueen/Nidorina require a Nidoran ♀ on the field; Nidoking/Nidorino
// require a Nidoran ♂. Encoded here as a pure map so tests can lock the
// contract: Pokémon Breeder MUST NOT cross genders.
//
// Names match the canonical Pokémon TCG data format (pokemontcg.io), which
// uses "Nidoran ♀" / "Nidoran ♂" with a space before the gender symbol.
// If Craig's cards.json ever diverges from this, the evolve attempt will
// fall through to the regular CARD_DATA lookup in trainer-cards.js.
const GENDER_LINE_BASICS = {
  'Nidoqueen': 'Nidoran ♀',
  'Nidorina':  'Nidoran ♀',
  'Nidoking':  'Nidoran ♂',
  'Nidorino':  'Nidoran ♂',
};

// Returns the required Basic name for a gender-locked Stage 2, or null if
// the Stage 2 isn't gender-locked (use normal evolvesFrom lookup in that case).
function genderLineBasicFor(stage2Name) {
  return GENDER_LINE_BASICS[stage2Name] || null;
}

// Is this Basic the correct evolutionary target for this Stage 2?
// Exact name match — DO NOT strip gender symbols. Previously this was
// normalized via .replace(/[♀♂]/g,''), which let Nidoran ♀ evolve into
// Nidoking via Pokémon Breeder (since "Nidoran" == "Nidoran" after stripping).
function breederRootMatches(basicName, requiredRootName) {
  if (!basicName || !requiredRootName) return false;
  return basicName === requiredRootName;
}

// ── transitionPhase ───────────────────────────────────────────────────────────
// Sets G.phase to the given phase. Optionally merges additional top-level state
// (e.g. pendingPromotion) into G. Calls updatePhase() so the DOM phase pill
// reflects the new phase immediately. Safe to call on non-browser (Node/tests)
// since G and updatePhase are tolerated as undefined.
//
// Why this exists: all 6 callers in game-actions.js and 1 in game-ai.js want
// the same three-step operation (set phase, optionally patch G, update DOM).
// Centralizing prevents the classic bug of one site forgetting updatePhase()
// and the phase pill drifting out of sync with G.phase.
function transitionPhase(phase, extras) {
  if (typeof G === 'undefined' || !G) return;
  G.phase = phase;
  if (extras && typeof extras === 'object') {
    for (const k of Object.keys(extras)) G[k] = extras[k];
  }
  if (typeof updatePhase === 'function') updatePhase();
}

if (typeof module !== 'undefined') {
  module.exports = {
    RULES, GAME_STATE_DEFAULTS,
    energyValue, canAffordAttack, parseStatusEffects,
    padBench, isLegalRetreatStatus, invisibleWallBlocks,
    isValidDeckSize, countCopies,
    applyPlusPowerValue, computeDamageAfterWR,
    coerceCardArrays, mergeGameStateDefaults,
    computeBetweenTurnDamage,
    parseDiscardEnergyCost, eligibleEnergyForDiscard,
    transitionPhase,
    GENDER_LINE_BASICS, genderLineBasicFor, breederRootMatches,
  };
}
