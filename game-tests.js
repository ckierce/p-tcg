// ══════════════════════════════════════════════════════════════════════════════
// GAME-TESTS.JS — Fast regression tests for pure game logic
//
// Run with:  node game-tests.js
// No browser, no Firebase, no DOM required.
//
// Add a test any time you fix a bug — paste the failing case here so it
// never regresses silently.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

// ─── Minimal stubs for globals that pure functions reference ─────────────────

// canAffordAttack calls hasEnergyBurn → isPowerActive → isMukActive → G.players
// We stub isMukActive and hasEnergyBurn directly so tests don't need G at all.
let _mukActive   = false;
let _energyBurn  = false;

function isMukActive()          { return _mukActive; }
function hasEnergyBurn(card)    { return _energyBurn; }
function hasPower()             { return false; }
function isPowerActive()        { return false; }
function _isStatusBlocked()     { return false; }

// ─── Functions under test (inline copies — keep in sync with game-actions.js / pokemon-powers.js) ─

function canAffordAttack(attachedEnergy, cost, attackerCard) {
  if (!cost || cost.length === 0) return true;
  const energyBurnActive = attackerCard && hasEnergyBurn(attackerCard);
  const pool = [];
  for (const e of (attachedEnergy || [])) {
    const name = e.name || '';
    if (energyBurnActive) {
      pool.push('Fire');
    } else if (/double colorless/i.test(name)) {
      pool.push('Colorless', 'Colorless');
    } else {
      const type = name.replace(/\s*energy/i, '').trim() || 'Colorless';
      pool.push(type);
    }
  }
  const sortedCost = [...cost].sort((a, b) =>
    (a === 'Colorless' ? 1 : 0) - (b === 'Colorless' ? 1 : 0)
  );
  const remaining = [...pool];
  for (const req of sortedCost) {
    if (req === 'Colorless') {
      if (remaining.length === 0) return false;
      remaining.splice(0, 1);
    } else {
      const idx = remaining.indexOf(req);
      if (idx === -1) return false;
      remaining.splice(idx, 1);
    }
  }
  return true;
}

function energyValue(attachedEnergy) {
  return (attachedEnergy || []).reduce((sum, e) =>
    sum + (/double colorless/i.test(e.name || '') ? 2 : 1), 0);
}

function parseStatusEffects(text) {
  if (!text) return [];
  const effects = [];
  const t = text;

  if (/poisoned.*if tails.*confused/i.test(t)) {
    effects.push({ type: 'either', heads: 'poisoned', tails: 'confused', self: false });
    return effects;
  }
  if (/confused and poisoned/i.test(t)) {
    effects.push({ status: 'confused', coinRequired: false, self: false });
    effects.push({ status: 'poisoned', coinRequired: false, self: false });
    return effects;
  }
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
  const seen = new Set();
  return effects.filter(e => {
    const key = `${e.status || e.type}-${e.self}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

// ─── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  FAIL: ${label}`);
    failed++;
  }
}

function assertEqual(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  FAIL: ${label}`);
    console.error(`       expected: ${JSON.stringify(expected)}`);
    console.error(`       actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

function section(name) {
  console.log(`\n── ${name} ${'─'.repeat(60 - name.length)}`);
}

// ─── energyValue ──────────────────────────────────────────────────────────────

section('energyValue');

assert('empty array → 0',
  energyValue([]) === 0);

assert('null → 0',
  energyValue(null) === 0);

assert('one Water Energy → 1',
  energyValue([{ name: 'Water Energy' }]) === 1);

assert('two single energies → 2',
  energyValue([{ name: 'Fire Energy' }, { name: 'Grass Energy' }]) === 2);

assert('Double Colorless → 2',
  energyValue([{ name: 'Double Colorless Energy' }]) === 2);

assert('DCE + one single → 3',
  energyValue([{ name: 'Double Colorless Energy' }, { name: 'Water Energy' }]) === 3);

assert('two DCE → 4',
  energyValue([{ name: 'Double Colorless Energy' }, { name: 'Double Colorless Energy' }]) === 4);

// ─── canAffordAttack ──────────────────────────────────────────────────────────

section('canAffordAttack');

// Helpers
const W  = { name: 'Water Energy' };
const F  = { name: 'Fire Energy' };
const G_ = { name: 'Grass Energy' };
const L  = { name: 'Lightning Energy' };
const P  = { name: 'Psychic Energy' };
const C  = { name: 'Colorless Energy' };
const DCE = { name: 'Double Colorless Energy' };

_energyBurn = false;

assert('no cost → always affordable',
  canAffordAttack([], [], null) === true);

assert('empty cost array → true',
  canAffordAttack([W], [], null) === true);

assert('exact type match: 1W satisfied by Water Energy',
  canAffordAttack([W], ['Water'], null) === true);

assert('exact type mismatch: 1W not satisfied by Fire Energy',
  canAffordAttack([F], ['Water'], null) === false);

assert('Colorless satisfied by any energy',
  canAffordAttack([F], ['Colorless'], null) === true);

assert('Colorless not satisfied by empty pool',
  canAffordAttack([], ['Colorless'], null) === false);

assert('typed first then Colorless: WC satisfied by [Water, Fire]',
  canAffordAttack([W, F], ['Water', 'Colorless'], null) === true);

assert('typed first: WC not satisfied by [Fire, Fire] (no Water)',
  canAffordAttack([F, F], ['Water', 'Colorless'], null) === false);

assert('DCE satisfies CC cost',
  canAffordAttack([DCE], ['Colorless', 'Colorless'], null) === true);

assert('DCE satisfies C cost (any one energy consumed)',
  canAffordAttack([DCE], ['Colorless'], null) === true);

assert('DCE does NOT satisfy typed cost (e.g. Water)',
  canAffordAttack([DCE], ['Water'], null) === false);

assert('WWC satisfied by [Water, Water, Fire]',
  canAffordAttack([W, W, F], ['Water', 'Water', 'Colorless'], null) === true);

assert('WWC not satisfied by [Water, Fire, Fire] (only 1 Water)',
  canAffordAttack([W, F, F], ['Water', 'Water', 'Colorless'], null) === false);

assert('3-energy cost (FFC) satisfied exactly',
  canAffordAttack([F, F, C], ['Fire', 'Fire', 'Colorless'], null) === true);

assert('3-energy cost not satisfied when one short',
  canAffordAttack([F, C], ['Fire', 'Fire', 'Colorless'], null) === false);

// Energy Burn (Charizard) — all attached energy treated as Fire
section('canAffordAttack — Energy Burn');
_energyBurn = true;

assert('Energy Burn: Water treated as Fire → satisfies Fire cost',
  canAffordAttack([W], ['Fire'], { name: 'Charizard' }) === true);

assert('Energy Burn: Grass treated as Fire → satisfies FFC cost',
  canAffordAttack([G_, G_, W], ['Fire', 'Fire', 'Colorless'], { name: 'Charizard' }) === true);

assert('Energy Burn: still fails if not enough energy',
  canAffordAttack([W], ['Fire', 'Fire'], { name: 'Charizard' }) === false);

_energyBurn = false;

// ─── parseStatusEffects ───────────────────────────────────────────────────────

section('parseStatusEffects');

assert('null text → empty array',
  parseStatusEffects(null).length === 0);

assert('empty string → empty array',
  parseStatusEffects('').length === 0);

assert('no status text → empty array',
  parseStatusEffects('Does 20 damage.').length === 0);

{
  const fx = parseStatusEffects('The Defending Pokémon is now Asleep.');
  assert('simple Asleep — one effect', fx.length === 1);
  assert('simple Asleep — status is asleep', fx[0]?.status === 'asleep');
  assert('simple Asleep — no coin', fx[0]?.coinRequired === false);
  assert('simple Asleep — not self', fx[0]?.self === false);
}

{
  const fx = parseStatusEffects('The Defending Pokémon is now Paralyzed.');
  assert('simple Paralyzed — status', fx[0]?.status === 'paralyzed');
  assert('simple Paralyzed — no coin', fx[0]?.coinRequired === false);
}

{
  const fx = parseStatusEffects('The Defending Pokémon is now Poisoned.');
  assert('simple Poisoned — status', fx[0]?.status === 'poisoned');
}

{
  const fx = parseStatusEffects('The Defending Pokémon is now Confused.');
  assert('simple Confused — status', fx[0]?.status === 'confused');
}

{
  // Gloom / Vileplume self-status
  const fx = parseStatusEffects('Gloom is now Confused.');
  assert('self Confused (Gloom) — self flag', fx[0]?.self === true);
}

{
  // "Poisoned; if tails, it is now Confused" → either branch, one flip
  const fx = parseStatusEffects('The Defending Pokémon is now Poisoned; if tails, it is now Confused.');
  assert('either branch — type is either', fx[0]?.type === 'either');
  assert('either branch — heads is poisoned', fx[0]?.heads === 'poisoned');
  assert('either branch — tails is confused', fx[0]?.tails === 'confused');
  assert('either branch — exactly one effect', fx.length === 1);
}

{
  // "Confused and Poisoned" → both applied directly
  const fx = parseStatusEffects('The Defending Pokémon is now Confused and Poisoned.');
  assert('both Confused+Poisoned — two effects', fx.length === 2);
  const statuses = fx.map(e => e.status).sort();
  assert('both Confused+Poisoned — contains confused', statuses.includes('confused'));
  assert('both Confused+Poisoned — contains poisoned', statuses.includes('poisoned'));
  assert('both Confused+Poisoned — no coin on either', fx.every(e => e.coinRequired === false));
}

// ─── Results ─────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(64)}`);
console.log(`  ${passed} passed   ${failed} failed`);
console.log('═'.repeat(64));
if (failed > 0) process.exit(1);
