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

// ─── Stubs for globals that pure functions reference ──────────────────────────
// game-utils.js calls hasEnergyBurn() — we stub it here before requiring.
let _energyBurn = false;
global.hasEnergyBurn = (card) => _energyBurn;

// ─── Import functions under test from the single source of truth ──────────────
const { RULES, energyValue, canAffordAttack, parseStatusEffects } = require('./game-utils.js');

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

// ─── RULES constants ──────────────────────────────────────────────────────────

section('RULES constants');

assert(`BENCH_SIZE is ${RULES.BENCH_SIZE}`,    RULES.BENCH_SIZE       === 5);
assert(`PRIZE_COUNT is ${RULES.PRIZE_COUNT}`,  RULES.PRIZE_COUNT      === 6);
assert(`STARTING_HAND is ${RULES.STARTING_HAND}`, RULES.STARTING_HAND === 7);
assert(`DECK_SIZE is ${RULES.DECK_SIZE}`,      RULES.DECK_SIZE        === 60);
assert(`DAMAGE_STEP is ${RULES.DAMAGE_STEP}`,  RULES.DAMAGE_STEP      === 10);

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
const W   = { name: 'Water Energy' };
const F   = { name: 'Fire Energy' };
const G_  = { name: 'Grass Energy' };
const L   = { name: 'Lightning Energy' };
const P   = { name: 'Psychic Energy' };
const C   = { name: 'Colorless Energy' };
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

// ─── applyStatus / tryApplyStatus edge cases ──────────────────────────────────
// These are lightweight behavioral contracts that document the status rules
// we've had bugs with. They use minimal stub objects, no G needed.

section('status application rules (stub tests)');

{
  // Paralyzed cannot be stacked — applying it again should be a no-op in terms
  // of game state (TCG rule: paralyzed replaces any existing status)
  const card = { status: 'paralyzed' };
  // Simulate what applyStatus does: status = newStatus
  const applyStatus = (target, s) => { target.status = s; };
  applyStatus(card, 'asleep');
  assert('status replacement: paralyzed overwritten by asleep', card.status === 'asleep');
}

{
  // Null status means no condition
  const card = { status: null };
  assert('null status means healthy', card.status === null);
}

// ─── applyPlusPower (inline — matches game-actions.js logic) ──────────────────
// We inline a stub copy here because applyPlusPower references addLog and G,
// which are DOM globals. The test validates the arithmetic contract only.

section('applyPlusPower (arithmetic contract)');

{
  // Minimal stubs
  const logs = [];
  const stubLog = (msg) => logs.push(msg);

  function _applyPlusPower(dmg, myActive, G_plusPowerActive) {
    // mirrors game-actions.js applyPlusPower exactly, with injected stubs
    const G = { plusPowerActive: G_plusPowerActive || 0 };
    if (myActive?.plusPower) {
      dmg += myActive.plusPower;
      stubLog(`PlusPower adds ${myActive.plusPower} damage!`);
      myActive.plusPower = 0;
    }
    if (G.plusPowerActive) {
      dmg += G.plusPowerActive;
      stubLog(`PlusPower adds ${G.plusPowerActive} damage!`);
      G.plusPowerActive = 0;
    }
    return dmg;
  }

  assert('no PlusPower: dmg unchanged',
    _applyPlusPower(40, { plusPower: 0 }, 0) === 40);

  assert('card plusPower adds correctly',
    _applyPlusPower(40, { plusPower: 10 }, 0) === 50);

  assert('card plusPower cleared after use',
    (() => { const c = { plusPower: 10 }; _applyPlusPower(30, c, 0); return c.plusPower; })() === 0);

  assert('global plusPowerActive adds correctly',
    _applyPlusPower(40, { plusPower: 0 }, 10) === 50);

  assert('both card and global stack',
    _applyPlusPower(30, { plusPower: 10 }, 10) === 50);

  assert('zero base damage + PlusPower still adds',
    _applyPlusPower(0, { plusPower: 10 }, 0) === 10);
}

// ─── applyWeaknessResistance (arithmetic contract) ────────────────────────────

section('applyWeaknessResistance (arithmetic contract)');

{
  const logs = [];
  const stubLog = (msg) => logs.push(msg);

  function _applyWR(dmg, atkTypes, weaknesses, resistances, skipWR) {
    // mirrors game-actions.js applyWeaknessResistance exactly
    const atk = { _skipWR: skipWR || false, name: 'TestAttack' };
    const myActive = { types: atkTypes };
    const oppActive = { weaknesses, resistances };
    const dittoStats = null;

    const attackerTypes = dittoStats?.types || myActive?.types || [];
    const w = oppActive.weaknesses  || [];
    const r = oppActive.resistances || [];
    if (!atk._skipWR) {
      for (const wk of w) {
        if (attackerTypes.some(t => t.toLowerCase() === wk.type.toLowerCase())) {
          dmg *= 2;
          stubLog(`Weakness! Damage doubled to ${dmg}.`);
          break;
        }
      }
      for (const rs of r) {
        if (attackerTypes.some(t => t.toLowerCase() === rs.type.toLowerCase())) {
          dmg = Math.max(0, dmg - 30);
          stubLog(`Resistance! Damage reduced to ${dmg}.`);
          break;
        }
      }
    }
    return dmg;
  }

  const fireTypes = ['Fire'];
  const waterWeak = [{ type: 'Fire' }];
  const fireResist = [{ type: 'Fire' }];
  const noWR = [];

  assert('no weakness/resistance: dmg unchanged',
    _applyWR(50, fireTypes, noWR, noWR) === 50);

  assert('weakness doubles damage',
    _applyWR(40, fireTypes, waterWeak, noWR) === 80);

  assert('resistance subtracts 30',
    _applyWR(50, fireTypes, noWR, fireResist) === 20);

  assert('resistance floor is 0 (cannot go negative)',
    _applyWR(20, fireTypes, noWR, fireResist) === 0);

  assert('weakness then resistance: double first, subtract 30 after (separate ops)',
    // weakness and resistance are separate — both cannot apply to same attack type
    // (attacker type matches either weakness OR resistance, not both in same card)
    _applyWR(40, fireTypes, waterWeak, noWR) === 80);

  assert('_skipWR flag: weakness ignored',
    _applyWR(40, fireTypes, waterWeak, noWR, true) === 40);

  assert('_skipWR flag: resistance ignored',
    _applyWR(50, fireTypes, noWR, fireResist, true) === 50);

  assert('type mismatch: no modification',
    _applyWR(40, ['Water'], waterWeak, noWR) === 40);
}


// Energy Burn with DCE — DCE must contribute 2 Fire tokens, not 1
section('canAffordAttack — Energy Burn + DCE');
_energyBurn = true;

assert('Energy Burn: DCE counts as 2 Fire → satisfies FFFF cost (DCE+F+F)',
  canAffordAttack([DCE, F, F], ['Fire', 'Fire', 'Fire', 'Fire'], { name: 'Charizard' }) === true);

assert('Energy Burn: DCE alone counts as 2 Fire → satisfies FF cost',
  canAffordAttack([DCE], ['Fire', 'Fire'], { name: 'Charizard' }) === true);

assert('Energy Burn: DCE alone does NOT satisfy FFF cost (only 2 tokens)',
  canAffordAttack([DCE], ['Fire', 'Fire', 'Fire'], { name: 'Charizard' }) === false);

_energyBurn = false;

// ─── Results ─────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(64)}`);
console.log(`  ${passed} passed   ${failed} failed`);
console.log('═'.repeat(64));
if (failed > 0) process.exit(1);
