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

// ── Node.js export (for game-tests.js) ───────────────────────────────────────
if (typeof module !== 'undefined') {
  module.exports = {
    RULES, GAME_STATE_DEFAULTS,
    energyValue, canAffordAttack, parseStatusEffects,
    padBench, isLegalRetreatStatus, invisibleWallBlocks,
    isValidDeckSize, countCopies,
    applyPlusPowerValue, computeDamageAfterWR,
    coerceCardArrays, mergeGameStateDefaults,
  };
}
