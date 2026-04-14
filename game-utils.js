// ══════════════════════════════════════════════════════════════════════════════
// GAME-UTILS.JS — Pure utility functions shared between game logic and tests
//
// No DOM, no Firebase, no G — completely stateless pure functions.
// Loaded before game-actions.js in the browser; required directly by game-tests.js.
//
// Exports (Node/CommonJS):  canAffordAttack, energyValue, parseStatusEffects
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
      pool.push('Fire');
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

// ── Node.js export (for game-tests.js) ───────────────────────────────────────
if (typeof module !== 'undefined') {
  module.exports = { RULES, energyValue, canAffordAttack, parseStatusEffects };
}
