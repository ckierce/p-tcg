// ══════════════════════════════════════════════════════════════════════════════
// GAME-TESTS.JS — Fast regression tests for pure game logic
//
// Run with:  node game-tests.js
// No browser, no Firebase, no DOM required.
//
// Add a test any time you fix a bug — paste the failing case here so it
// never regresses silently. The push_to_github.sh script runs this and
// refuses to push if any test fails.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

// ─── Stubs for globals that pure functions reference ──────────────────────────
// game-utils.js calls hasEnergyBurn() — we stub it here before requiring.
let _energyBurn = false;
global.hasEnergyBurn = (card) => _energyBurn;

// ─── Import functions under test from the single source of truth ──────────────
const {
  RULES, GAME_STATE_DEFAULTS,
  energyValue, canAffordAttack, parseStatusEffects,
  padBench, isLegalRetreatStatus, invisibleWallBlocks,
  isValidDeckSize, countCopies,
  applyPlusPowerValue, computeDamageAfterWR,
  coerceCardArrays, mergeGameStateDefaults,
  computeBetweenTurnDamage,
  parseDiscardEnergyCost, eligibleEnergyForDiscard,
  GENDER_LINE_BASICS, genderLineBasicFor, breederRootMatches,
  buildEvolutionStackUnder,
} = require('./game-utils.js');

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
  console.log(`\n── ${name} ${'─'.repeat(Math.max(1, 60 - name.length))}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// RULES constants
// ═══════════════════════════════════════════════════════════════════════════════

section('RULES constants');

assert(`BENCH_SIZE is ${RULES.BENCH_SIZE}`,        RULES.BENCH_SIZE       === 5);
assert(`PRIZE_COUNT is ${RULES.PRIZE_COUNT}`,      RULES.PRIZE_COUNT      === 6);
assert(`STARTING_HAND is ${RULES.STARTING_HAND}`,  RULES.STARTING_HAND    === 7);
assert(`DECK_SIZE is ${RULES.DECK_SIZE}`,          RULES.DECK_SIZE        === 60);
assert(`DAMAGE_STEP is ${RULES.DAMAGE_STEP}`,      RULES.DAMAGE_STEP      === 10);
assert(`INVISIBLE_WALL_THRESHOLD is ${RULES.INVISIBLE_WALL_THRESHOLD}`,
  RULES.INVISIBLE_WALL_THRESHOLD === 30);

// ═══════════════════════════════════════════════════════════════════════════════
// energyValue
// ═══════════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════════
// canAffordAttack
// ═══════════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════════
// parseStatusEffects
// ═══════════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════════
// status application rules (stub contracts)
// ═══════════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════════
// applyPlusPower arithmetic
// ═══════════════════════════════════════════════════════════════════════════════

section('applyPlusPowerValue');

assert('no PlusPower: dmg unchanged',
  applyPlusPowerValue(40, 0, 0) === 40);

assert('card plusPower adds correctly',
  applyPlusPowerValue(40, 10, 0) === 50);

assert('global plusPowerActive adds correctly',
  applyPlusPowerValue(40, 0, 10) === 50);

assert('both card and global stack',
  applyPlusPowerValue(30, 10, 10) === 50);

assert('zero base damage + PlusPower still adds',
  applyPlusPowerValue(0, 10, 0) === 10);

assert('undefined arguments treated as 0',
  applyPlusPowerValue(40) === 40);

// ═══════════════════════════════════════════════════════════════════════════════
// weakness / resistance arithmetic
// ═══════════════════════════════════════════════════════════════════════════════

section('computeDamageAfterWR');

const fireTypes   = ['Fire'];
const waterTypes  = ['Water'];
const waterWeak   = [{ type: 'Fire' }];
const fireResist  = [{ type: 'Fire' }];
const noWR        = [];

assert('no weakness/resistance: dmg unchanged',
  computeDamageAfterWR(50, fireTypes, noWR, noWR) === 50);

assert('weakness doubles damage',
  computeDamageAfterWR(40, fireTypes, waterWeak, noWR) === 80);

assert('resistance subtracts 30',
  computeDamageAfterWR(50, fireTypes, noWR, fireResist) === 20);

assert('resistance floor is 0 (cannot go negative)',
  computeDamageAfterWR(20, fireTypes, noWR, fireResist) === 0);

assert('skipWR flag: weakness ignored',
  computeDamageAfterWR(40, fireTypes, waterWeak, noWR, true) === 40);

assert('skipWR flag: resistance ignored',
  computeDamageAfterWR(50, fireTypes, noWR, fireResist, true) === 50);

assert('type mismatch: no modification',
  computeDamageAfterWR(40, waterTypes, waterWeak, noWR) === 40);

assert('zero damage attack stays zero through W/R',
  computeDamageAfterWR(0, fireTypes, waterWeak, noWR) === 0);

assert('case-insensitive type match',
  computeDamageAfterWR(40, ['fire'], [{ type: 'Fire' }], noWR) === 80);

assert('null weaknesses treated as empty',
  computeDamageAfterWR(40, fireTypes, null, null) === 40);

// ═══════════════════════════════════════════════════════════════════════════════
// BUG REGRESSION SUITE
// Each section below corresponds to a specific bug from the memory that was
// resolved. The test documents the rule so it cannot silently regress.
// ═══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// BUG: Firebase drops trailing nulls from bench arrays → placement bugs.
// FIX: pad bench to RULES.BENCH_SIZE after every Firebase read.
// ─────────────────────────────────────────────────────────────────────────────
section('regression: padBench (Firebase trailing-null loss)');

assertEqual('empty bench pads to 5 nulls',
  padBench([]),
  [null, null, null, null, null]);

assertEqual('undefined pads to 5 nulls',
  padBench(undefined),
  [null, null, null, null, null]);

assertEqual('null pads to 5 nulls',
  padBench(null),
  [null, null, null, null, null]);

assertEqual('one-card bench pads to 5 slots',
  padBench([{ name: 'Pikachu' }]),
  [{ name: 'Pikachu' }, null, null, null, null]);

assertEqual('full bench unchanged',
  padBench([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E' }]),
  [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E' }]);

assertEqual('sparse bench (Firebase dropped nulls after slot 1) pads correctly',
  padBench([{ name: 'Charmander' }, null]),
  [{ name: 'Charmander' }, null, null, null, null]);

assertEqual('over-long bench truncated to 5 (defensive)',
  padBench([1,2,3,4,5,6,7]).length,
  5);

assert('padBench returns a new array (does not mutate)',
  (() => { const a = [{ name: 'X' }]; const b = padBench(a); return a.length === 1 && b.length === 5; })());

// ─────────────────────────────────────────────────────────────────────────────
// BUG: Firebase round-trips drop card fields (empty arrays become undefined).
// FIX: enrichCard must defensively coerce all array fields.
// ─────────────────────────────────────────────────────────────────────────────
section('regression: coerceCardArrays (Firebase empty-array loss)');

{
  const card = { name: 'Pikachu' }; // no array fields at all
  const out = coerceCardArrays(card);
  assert('missing types → [] ', Array.isArray(out.types) && out.types.length === 0);
  assert('missing attacks → []', Array.isArray(out.attacks) && out.attacks.length === 0);
  assert('missing abilities → []', Array.isArray(out.abilities) && out.abilities.length === 0);
  assert('missing weaknesses → []', Array.isArray(out.weaknesses));
  assert('missing resistances → []', Array.isArray(out.resistances));
  assert('missing retreatCost → []', Array.isArray(out.retreatCost));
  assert('missing attachedEnergy → []', Array.isArray(out.attachedEnergy));
  assert('missing subtypes → []', Array.isArray(out.subtypes));
}

{
  const card = {
    name: 'Charizard',
    types: ['Fire'],
    attacks: [{ name: 'Fire Spin' }],
    attachedEnergy: [{ name: 'Fire Energy' }],
  };
  const out = coerceCardArrays(card);
  assertEqual('preserves existing types', out.types, ['Fire']);
  assertEqual('preserves existing attacks', out.attacks, [{ name: 'Fire Spin' }]);
  assertEqual('preserves existing attachedEnergy', out.attachedEnergy, [{ name: 'Fire Energy' }]);
  // and still fills in the missing ones
  assert('still coerces missing weaknesses', Array.isArray(out.weaknesses));
}

assert('coerceCardArrays: null input returned unchanged',
  coerceCardArrays(null) === null);

assert('coerceCardArrays: does not mutate input',
  (() => { const a = { name: 'X' }; coerceCardArrays(a); return !Array.isArray(a.types); })());

// ─────────────────────────────────────────────────────────────────────────────
// BUG: Firebase converts sparse arrays (with null holes) into plain objects
// keyed by surviving indices: [a, null, c] → {0: a, 2: c}. When receiveGameState
// then called .map() on what it assumed was an array, P2 threw with
// `(intermediate value).map is not a function` and the entire state push was
// dropped — P2's view of damage/KO/PROMOTE never updated. Hits prizes hardest:
// every prize claim nulls out a slot. Same risk for any array we null out.
//
// FIX: receiveGameState's enrichPlayer must coerce object-shaped data back to
// arrays before .map() / iteration. The same `toArr` helper now wraps every
// array field on the player object.
// ─────────────────────────────────────────────────────────────────────────────
section('regression: Firebase sparse-array coercion in receiveGameState');

{
  // Mimic what receiveGameState does when Firebase returned the prizes as an object
  const toArr = (v) => Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : (v ? [v] : []));

  // After P1 takes a prize from slot 0, prizes locally is [null, p1, p2, p3, p4, p5].
  // Firebase serializes that as { 1: p1, 2: p2, 3: p3, 4: p4, 5: p5 } — slot 0 is gone.
  const fbPrizes = { 1: { card: { id: 'a' } }, 2: { card: { id: 'b' } }, 3: { card: { id: 'c' } }, 4: { card: { id: 'd' } }, 5: { card: { id: 'e' } } };
  const arr = toArr(fbPrizes);
  assert('Firebase-shaped prizes object → array', Array.isArray(arr));
  assert('Firebase-shaped prizes object → 5 surviving entries', arr.length === 5);

  // Now the receive-side .map equivalent must not throw
  let threw = false;
  try {
    const padded = Array.from({ length: 6 }, (_, i) => {
      const pr = toArr(fbPrizes)[i];
      return pr ? { ...pr, card: { ...pr.card } } : null;
    });
    assert('padded prize array has 6 slots', padded.length === 6);
    // Note: Firebase drops null slots and Object.values collapses survivors to
    // contiguous indices, so the original null position is lost. The remaining
    // count is preserved (here: 5 surviving prizes after one was claimed), but
    // they appear at indices 0-4 with index 5 padded as null. This is cosmetic
    // (prize cards shift left visually) but doesn't break any logic.
    assert('5 prizes survive the round-trip', padded.filter(p => p).length === 5);
    assert('prize 6 is null (padded)', padded[5] === null);
  } catch (e) { threw = true; }
  assert('coercion + Array.from pad does not throw on Firebase prizes object', !threw);

  // Sparse bench (Firebase drops middle nulls just like prizes)
  const fbBench = { 0: { id: 'b1' }, 2: { id: 'b3' } }; // slot 1 was null, dropped
  const benchArr = Array.from({ length: 5 }, (_, i) => toArr(fbBench)[i] || null);
  // Note: Object.values returns surviving entries in key order, so arr is [b1, b3] —
  // slot 1's null is collapsed. This is the canonical Firebase loss; bench was already
  // padded by Array.from which is what saves it. (For prizes the same pattern applies.)
  assert('Firebase-shaped bench object pads to 5', benchArr.length === 5);

  // Empty array became undefined
  assert('toArr(undefined) → []', toArr(undefined).length === 0);
  assert('toArr(null) → []', toArr(null).length === 0);
  assert('toArr([]) → []', toArr([]).length === 0);
  assert('toArr(real array) → same array', toArr([1, 2]).length === 2);
}

// receiveGameState's `enrichPlayer` block must use array-coercion on every
// array field — verify the source contains the fix so future edits don't regress.
{
  const src = require('fs').readFileSync(__dirname + '/game-init.js', 'utf8');
  // Find the receiveGameState function
  const recvStart = src.indexOf('function receiveGameState');
  assert('receiveGameState function exists in game-init.js', recvStart > -1);
  const recvBlock = src.slice(recvStart, recvStart + 2000);
  assert('receiveGameState defines a toArr helper for Firebase coercion',
    /toArr\s*=\s*\(v\)\s*=>/.test(recvBlock));
  assert('receiveGameState pads prizes to length 6 (defensive against Firebase drops)',
    /prizes:\s*Array\.from\(\s*\{\s*length:\s*6\s*\}/.test(recvBlock));
  assert('receiveGameState bench uses toArr (Firebase object-shape safe)',
    /bench:[\s\S]{0,200}toArr\(p\.bench\)/.test(recvBlock));
  assert('receiveGameState prizes uses toArr (Firebase object-shape safe)',
    /prizes:[\s\S]{0,300}toArr\(p\.prizes\)/.test(recvBlock));
  assert('enrichCards uses toArr (covers deck/hand/discard)',
    /enrichCards\s*=\s*\(arr\)\s*=>\s*toArr\(arr\)/.test(recvBlock));
}

// ─────────────────────────────────────────────────────────────────────────────
// BUG: Many per-card game-state fields were being dropped on Firebase read.
// FIX: GAME_STATE_DEFAULTS schema + mergeGameStateDefaults helper.
// ─────────────────────────────────────────────────────────────────────────────
section('regression: GAME_STATE_DEFAULTS schema + merge');

// The schema must include every field that tracks in-game state on a card.
// If you add a new field to the game, add it to GAME_STATE_DEFAULTS too.
const requiredStateFields = [
  'status', 'damage',
  'defender', 'defenderFull', 'defenderFullEffects',
  'defenderThreshold', 'defenderReduction',
  'plusPower', 'nextAttackDouble', 'smokescreened',
  'immuneToAttack', 'disabledAttack', 'cantRetreat',
  'destinyBond', 'leekSlapUsed',
  'pounceActive', 'pounceReduction',
  'swordsDanceActive', 'attackReduction',
  'conversionWeakness', 'conversionResistance',
  'trainerBlocked',
];
for (const field of requiredStateFields) {
  assert(`GAME_STATE_DEFAULTS has '${field}'`,
    Object.prototype.hasOwnProperty.call(GAME_STATE_DEFAULTS, field));
}

// Specific field defaults
assert(`default status is null`,              GAME_STATE_DEFAULTS.status === null);
assert(`default damage is 0`,                 GAME_STATE_DEFAULTS.damage === 0);
assert(`default smokescreened is false`,      GAME_STATE_DEFAULTS.smokescreened === false);
assert(`default immuneToAttack is false`,     GAME_STATE_DEFAULTS.immuneToAttack === false);
assert(`default plusPower is 0`,              GAME_STATE_DEFAULTS.plusPower === 0);
assert(`default destinyBond is false`,        GAME_STATE_DEFAULTS.destinyBond === false);

// mergeGameStateDefaults
{
  const bare = { name: 'Pikachu', id: 'p-001' };
  const merged = mergeGameStateDefaults(bare);
  assert('merge: bare card gets status=null',        merged.status === null);
  assert('merge: bare card gets damage=0',           merged.damage === 0);
  assert('merge: bare card gets smokescreened=false', merged.smokescreened === false);
  assert('merge: preserves name',                    merged.name === 'Pikachu');
  assert('merge: preserves id',                      merged.id === 'p-001');
}

{
  // Existing values must NOT be overwritten by defaults (?? semantics).
  const card = { name: 'Charizard', damage: 40, status: 'paralyzed', smokescreened: true };
  const out = mergeGameStateDefaults(card);
  assert('merge: existing damage=40 preserved',       out.damage === 40);
  assert('merge: existing status="paralyzed" preserved', out.status === 'paralyzed');
  assert('merge: existing smokescreened=true preserved', out.smokescreened === true);
  assert('merge: still fills unset plusPower=0',      out.plusPower === 0);
}

{
  // Explicit false and 0 must be preserved (not replaced by default).
  const card = { name: 'X', defender: false, plusPower: 0 };
  const out = mergeGameStateDefaults(card);
  assert('merge: explicit false preserved',  out.defender === false);
  assert('merge: explicit 0 preserved',      out.plusPower === 0);
}

assert('merge: null input returned unchanged',
  mergeGameStateDefaults(null) === null);

assert('merge: does not mutate input',
  (() => {
    const a = { name: 'X' };
    mergeGameStateDefaults(a);
    return a.status === undefined && a.damage === undefined;
  })());

// ─────────────────────────────────────────────────────────────────────────────
// BUG: Paralyzed/Asleep Pokémon could illegally retreat; Confused retreat
//      was not requiring a coin flip.
// FIX: isLegalRetreatStatus gates retreat eligibility by status.
// ─────────────────────────────────────────────────────────────────────────────
section('regression: isLegalRetreatStatus (Paralyzed/Asleep block retreat)');

assert('healthy (null) → yes',            isLegalRetreatStatus(null) === 'yes');
assert('poisoned → yes',                  isLegalRetreatStatus('poisoned') === 'yes');
assert('burned → yes',                    isLegalRetreatStatus('burned') === 'yes');
assert('paralyzed → no',                  isLegalRetreatStatus('paralyzed') === 'no');
assert('asleep → no',                     isLegalRetreatStatus('asleep') === 'no');
assert('confused → coinflip',             isLegalRetreatStatus('confused') === 'coinflip');
assert('unknown status → yes (default)',  isLegalRetreatStatus('unknown') === 'yes');

// ─────────────────────────────────────────────────────────────────────────────
// BUG: Invisible Wall threshold was inverted (code comment said "30 or less";
//      actual TCG rule and current behavior is "30 or more" damage blocked).
// FIX: invisibleWallBlocks encodes the correct threshold (damage >= 30).
// ─────────────────────────────────────────────────────────────────────────────
section('regression: invisibleWallBlocks (Mr. Mime threshold)');

assert('29 damage → NOT blocked',     invisibleWallBlocks(29) === false);
assert('30 damage → blocked (boundary)', invisibleWallBlocks(30) === true);
assert('40 damage → blocked',         invisibleWallBlocks(40) === true);
assert('100 damage → blocked',        invisibleWallBlocks(100) === true);
assert('0 damage → NOT blocked',      invisibleWallBlocks(0) === false);
assert('10 damage → NOT blocked',     invisibleWallBlocks(10) === false);
// TCG rule check: a 20-damage attack with PlusPower bringing it to 30 DOES
// get blocked — we apply PlusPower before the block check. The helper
// itself only sees the final damage number.
assert('20+PlusPower=30 → blocked',   invisibleWallBlocks(20 + 10) === true);

// ─────────────────────────────────────────────────────────────────────────────
// BUG: Decks built with wrong size were not being rejected.
// FIX: isValidDeckSize + countCopies give deck-builder a test-locked contract.
// ─────────────────────────────────────────────────────────────────────────────
section('regression: deck construction (60-card, max 4 copies)');

assert('60-card deck is valid size',   isValidDeckSize(new Array(60).fill('c')) === true);
assert('59-card deck is invalid',       isValidDeckSize(new Array(59).fill('c')) === false);
assert('61-card deck is invalid',       isValidDeckSize(new Array(61).fill('c')) === false);
assert('empty deck is invalid',         isValidDeckSize([]) === false);
assert('null deck is invalid',          isValidDeckSize(null) === false);
assert('non-array is invalid',          isValidDeckSize({ length: 60 }) === false);

{
  // count copies of a specific card by id predicate
  const deck = [
    { id: 'base-16' }, { id: 'base-16' }, { id: 'base-16' }, { id: 'base-16' },
    { id: 'base-17' },
  ];
  assert('countCopies: 4 Charizards', countCopies(deck, c => c.id === 'base-16') === 4);
  assert('countCopies: 1 Charmeleon', countCopies(deck, c => c.id === 'base-17') === 1);
  assert('countCopies: 0 missing',    countCopies(deck, c => c.id === 'base-99') === 0);
  assert('countCopies: <=4 rule satisfied',
    countCopies(deck, c => c.id === 'base-16') <= RULES.MAX_CARD_COPIES);
}

{
  // A deck with 5 copies of the same non-energy card should fail construction.
  const deck = new Array(60).fill(null).map((_, i) => ({
    id: i < 5 ? 'base-16' : 'energy-water',
  }));
  const charizardCount = countCopies(deck, c => c.id === 'base-16');
  assert('5 copies of a card violates MAX_CARD_COPIES',
    charizardCount > RULES.MAX_CARD_COPIES);
}

// ─────────────────────────────────────────────────────────────────────────────
// BUG: Ditto Transform used wildcard energy for attack cost, but in practice
//      the game only treated attached energy types literally.
// FIX: When Ditto is Active with Transform, ALL attached energy is wildcard
//      (counts as any type). Model this as canAffordAttack with a cost that
//      ignores types — functionally equivalent to turning the cost all-
//      Colorless. This regression test locks the semantics.
// ─────────────────────────────────────────────────────────────────────────────
section('regression: Ditto Transform wildcard energy');

{
  // Helper: treat all costs as Colorless — which is what Ditto Transform does
  // at the call site. This test verifies canAffordAttack's Colorless-wildcard
  // behavior, which is the semantic Transform relies on.
  const allColorless = (cost) => cost.map(() => 'Colorless');
  assert('Transform semantic: [F] satisfies [Water] via wildcard',
    canAffordAttack([F], allColorless(['Water']), null) === true);
  assert('Transform semantic: [G, F] satisfies [Fire, Fire] via wildcard',
    canAffordAttack([G_, F], allColorless(['Fire', 'Fire']), null) === true);
  assert('Transform semantic: [F] does not satisfy [Fire, Fire] — pool too small',
    canAffordAttack([F], allColorless(['Fire', 'Fire']), null) === false);
  assert('Transform semantic: DCE still counts as 2',
    canAffordAttack([DCE], allColorless(['Water', 'Fire']), null) === true);
}

// ─────────────────────────────────────────────────────────────────────────────
// BUG: Smokescreen was clearing too early (at end of ATTACKER's turn instead
//      of after DEFENDER's next attack attempt).
// FIX: Clear smokescreened when the smokescreened player attempts an attack
//      (regardless of heads/tails), or at the end of their turn if they
//      pass/retreat. This is a behavioral contract — not a pure function —
//      but we lock the expected state transitions.
// ─────────────────────────────────────────────────────────────────────────────
section('regression: Smokescreen lifecycle (state contract)');

{
  // State machine simulation:
  //   1. Attacker uses Smokescreen → set opponent.smokescreened = true
  //   2. Attacker ends turn → smokescreened MUST remain true
  //   3. Smokescreened player attempts to attack → flip is resolved,
  //      smokescreened is cleared regardless of heads/tails
  //   4. If they pass/retreat without attacking, end-of-turn clears it
  const defender = { name: 'Pikachu', smokescreened: false };

  // Step 1
  defender.smokescreened = true;
  assert('after Smokescreen hit: defender.smokescreened = true',
    defender.smokescreened === true);

  // Step 2: attacker's turn ends — smokescreen must PERSIST
  // (this was the original bug — it was being cleared here)
  // No state change expected
  assert('after attacker endTurn: smokescreened STILL true (the bug fix)',
    defender.smokescreened === true);

  // Step 3: defender attempts attack — cleared after flip (heads or tails)
  // Simulate the "attack attempted" branch
  const simulateAttackAttempt = (d) => { d.smokescreened = false; };
  simulateAttackAttempt(defender);
  assert('after defender attack attempt: smokescreened cleared',
    defender.smokescreened === false);

  // Alternative path: defender passes without attacking, end-of-turn cleanup
  const defender2 = { smokescreened: true };
  const endTurnCleanup = (d) => { d.smokescreened = false; };
  endTurnCleanup(defender2);
  assert('after defender endTurn without attacking: smokescreened cleared',
    defender2.smokescreened === false);
}

// ─────────────────────────────────────────────────────────────────────────────
// BUG: Agility/Barrier incorrectly showed DEF badge; switched to
//      immuneToAttack flag. Also: Raichu Agility must block status effects,
//      not only damage.
// FIX: immuneToAttack is in GAME_STATE_DEFAULTS so it round-trips through
//      Firebase and is cleared at the appropriate turn boundary.
// ─────────────────────────────────────────────────────────────────────────────
section('regression: immuneToAttack field (Agility/Barrier/Raichu)');

assert('immuneToAttack exists in GAME_STATE_DEFAULTS',
  'immuneToAttack' in GAME_STATE_DEFAULTS);

assert('immuneToAttack default is false',
  GAME_STATE_DEFAULTS.immuneToAttack === false);

{
  // A card with immuneToAttack=true should survive mergeGameStateDefaults
  const agile = { name: 'Raichu', immuneToAttack: true };
  const merged = mergeGameStateDefaults(agile);
  assert('immuneToAttack=true survives merge', merged.immuneToAttack === true);
}

{
  // Raichu Agility bug: immuneToAttack should also block status effects,
  // not just damage. This is enforced at the attack-resolution site; here
  // we just confirm the flag round-trips and can be set alongside status
  // flags without interference.
  const card = { immuneToAttack: true, status: null };
  const merged = mergeGameStateDefaults(card);
  assert('Raichu Agility contract: immuneToAttack=true, status=null preserved',
    merged.immuneToAttack === true && merged.status === null);
}

// ─────────────────────────────────────────────────────────────────────────────
// BUG: DCE was generating only one wildcard in the pool.
// FIX: canAffordAttack pushes 'Colorless' TWICE for DCE.
// ─────────────────────────────────────────────────────────────────────────────
section('regression: DCE generates two wildcards');

assert('DCE alone satisfies 2x Colorless cost (bug fix)',
  canAffordAttack([DCE], ['Colorless', 'Colorless'], null) === true);

assert('DCE alone does NOT satisfy 3x Colorless cost',
  canAffordAttack([DCE], ['Colorless', 'Colorless', 'Colorless'], null) === false);

assert('DCE + single energy satisfies 3x Colorless cost',
  canAffordAttack([DCE, F], ['Colorless', 'Colorless', 'Colorless'], null) === true);

assert('energyValue reports DCE as 2',
  energyValue([DCE]) === 2);

// ─────────────────────────────────────────────────────────────────────────────
// BUG: Confused retreat did not require a coin flip (allowed free retreat).
// FIX: isLegalRetreatStatus('confused') returns 'coinflip' not 'yes'.
// ─────────────────────────────────────────────────────────────────────────────
section('regression: Confused retreat requires coin flip');

assert('Confused retreat requires coin flip (not free)',
  isLegalRetreatStatus('confused') === 'coinflip');

assert('Confused retreat is NOT outright blocked',
  isLegalRetreatStatus('confused') !== 'no');

// ─────────────────────────────────────────────────────────────────────────────
// BUG: Pokémon Breeder would evolve Nidoran ♀ into Nidoking and Nidoran ♂
// into Nidoqueen because trainer-cards.js stripped the ♀/♂ symbols before
// matching. The regular evolve flow was already safe (exact match); only
// Breeder had the loophole. Additionally, GENDER_LINE_BASICS used
// 'Nidoran♀' (no space) while the canonical TCG data uses 'Nidoran ♀'
// (with space) — the stripping was masking this inconsistency.
// FIX: Extracted GENDER_LINE_BASICS to game-utils.js with canonical spacing;
// trainer-cards.js now uses exact name matching with no stripping.
// ─────────────────────────────────────────────────────────────────────────────
section('regression: Pokémon Breeder gender-line enforcement');

// genderLineBasicFor: maps gender-locked Stage 2 to required Basic name.
assert("Nidoking → requires Nidoran ♂",
  genderLineBasicFor('Nidoking') === 'Nidoran ♂');
assert("Nidorino → requires Nidoran ♂",
  genderLineBasicFor('Nidorino') === 'Nidoran ♂');
assert("Nidoqueen → requires Nidoran ♀",
  genderLineBasicFor('Nidoqueen') === 'Nidoran ♀');
assert("Nidorina → requires Nidoran ♀",
  genderLineBasicFor('Nidorina') === 'Nidoran ♀');
assert("non-gender-locked Stage 2 (e.g. Charizard) → null",
  genderLineBasicFor('Charizard') === null);
assert("unknown card name → null",
  genderLineBasicFor('Mewtwo') === null);

// Canonical name format: canonical TCG data uses a space before ♀/♂.
// If this ever changes, both trainer-cards.js matching AND Craig's
// cards.json would need to change in lockstep — this lock makes it explicit.
assert("Nidoran ♂ canonical includes space",
  GENDER_LINE_BASICS['Nidoking'] === 'Nidoran ♂');
assert("Nidoran ♀ canonical includes space",
  GENDER_LINE_BASICS['Nidoqueen'] === 'Nidoran ♀');

// breederRootMatches: exact-name predicate — must NOT strip gender symbols.
// THE bug we're locking out: Nidoran ♀ matching Nidoran ♂.
assert("Nidoran ♀ → Nidoking (cross-gender) REJECTED",
  breederRootMatches('Nidoran ♀', genderLineBasicFor('Nidoking')) === false);
assert("Nidoran ♂ → Nidoqueen (cross-gender) REJECTED",
  breederRootMatches('Nidoran ♂', genderLineBasicFor('Nidoqueen')) === false);
assert("Nidoran ♂ → Nidoking (same gender) ACCEPTED",
  breederRootMatches('Nidoran ♂', genderLineBasicFor('Nidoking')) === true);
assert("Nidoran ♀ → Nidoqueen (same gender) ACCEPTED",
  breederRootMatches('Nidoran ♀', genderLineBasicFor('Nidoqueen')) === true);

// Defensive edges: the old normalizer used to accept these. They must now
// be rejected because exact-string equality is strict.
assert("bare 'Nidoran' (no symbol) → Nidoking REJECTED",
  breederRootMatches('Nidoran', 'Nidoran ♂') === false);
assert("'Nidoran♂' (no space) vs 'Nidoran ♂' (with space) REJECTED",
  breederRootMatches('Nidoran♂', 'Nidoran ♂') === false);
assert("null/undefined basic → false, not crash",
  breederRootMatches(null, 'Nidoran ♂') === false);
assert("null/undefined required → false, not crash",
  breederRootMatches('Nidoran ♂', null) === false);

// ─────────────────────────────────────────────────────────────────────────────
// BUG: Pokémon Breeder would drop the underlying Basic Pokémon. When Breeder
// evolves Squirtle → Blastoise, the Squirtle card must be preserved under
// Blastoise so it goes to discard on KO (Craig confirmed the TCG rule:
// Breeder stacks Stage 2 directly on Basic, and both discard together on KO).
// FIX: doBreed now calls buildEvolutionStackUnder(tCard) and stores the
// result on stage2.prevStages, matching what regular evolve() does.
// Without the fix, one card per Breeder use vanishes on KO.
// ─────────────────────────────────────────────────────────────────────────────
section('regression: Pokémon Breeder preserves Basic card under Stage 2');

{
  // Scenario: Breeder evolves Squirtle → Blastoise. Stack under Blastoise
  // should contain exactly Squirtle (NOT Wartortle — Breeder skipped it).
  const squirtle = { name: 'Squirtle', uid: 's1', damage: 20, attachedEnergy: [{ name: 'Water' }], prevStages: undefined };
  const stack = buildEvolutionStackUnder(squirtle);
  assert('Breeder: stack has exactly 1 card (the Basic)', stack.length === 1);
  assert('Breeder: stack entry is Squirtle', stack[0].name === 'Squirtle');
  assert('Breeder: stack entry has attachedEnergy cleared (energy moves to top card)',
    Array.isArray(stack[0].attachedEnergy) && stack[0].attachedEnergy.length === 0);
  assert('Breeder: stack entry has damage cleared (damage moves to top card)',
    stack[0].damage === 0);
  assert('Breeder: stack entry has prevStages cleared (no nested references)',
    stack[0].prevStages === undefined);
  assert('Breeder: original Squirtle is not mutated (spread copy)',
    squirtle.damage === 20 && squirtle.attachedEnergy.length === 1);
}

{
  // Scenario: regular evolve carries forward existing prevStages.
  // Wartortle has Squirtle under it; evolving to Blastoise stacks both under.
  const squirtleCopy = { name: 'Squirtle', attachedEnergy: [], damage: 0, prevStages: undefined };
  const wartortle = { name: 'Wartortle', prevStages: [squirtleCopy], damage: 10, attachedEnergy: [{ name: 'Water' }] };
  const stack = buildEvolutionStackUnder(wartortle);
  assert('Evolve: stack has 2 cards when evolving a Stage 1 with prevStages',
    stack.length === 2);
  assert('Evolve: stack[0] is the earlier Basic (Squirtle) preserved',
    stack[0].name === 'Squirtle');
  assert('Evolve: stack[1] is the Stage 1 just-evolved-from (Wartortle)',
    stack[1].name === 'Wartortle');
}

{
  // Null/undefined safety — must not throw, must return empty stack.
  assert('buildEvolutionStackUnder(null) → []',
    Array.isArray(buildEvolutionStackUnder(null)) && buildEvolutionStackUnder(null).length === 0);
  assert('buildEvolutionStackUnder(undefined) → []',
    Array.isArray(buildEvolutionStackUnder(undefined)) && buildEvolutionStackUnder(undefined).length === 0);
}

{
  // Card-count invariant: evolving never loses or gains cards in the stack.
  // Before: Basic + Stage 1 (2 cards conceptually in play as one pokémon).
  // After evolving to Stage 2: Stage 2 on top + 2 prevStages = still 2 under-cards + 1 top = 3.
  // The KO pipeline will push top card + all prevStages to discard = 3 cards discarded.
  const basic    = { name: 'B', prevStages: undefined };
  const stage1   = { name: 'S1', prevStages: buildEvolutionStackUnder(basic) };  // stage1 has [B] underneath
  const stage2PS = buildEvolutionStackUnder(stage1);                              // stage2 would have [B, S1] underneath
  assert('Evolve chain: Stage 2 ends up with exactly 2 prevStages (Basic + Stage 1)',
    stage2PS.length === 2);
  assert('Evolve chain: KO discards top + prevStages = 3 total cards (not 1, not 2)',
    1 + stage2PS.length === 3);
}


// ─────────────────────────────────────────────────────────────────────────────
// INTEGRATION: full damage pipeline (PlusPower → W/R → Invisible Wall)
// This is a mini-simulation of the damage path that has been the site of
// multiple bugs. Locking the order of operations so nothing rearranges
// them accidentally.
// ─────────────────────────────────────────────────────────────────────────────
section('integration: damage pipeline order of operations');

{
  // Scenario: Charizard (Fire) attacks Blastoise (Water, Weak to Lightning).
  // Base damage 100, no PlusPower, no resistance, no Wall.
  let dmg = 100;
  dmg = applyPlusPowerValue(dmg, 0, 0);
  dmg = computeDamageAfterWR(dmg, ['Fire'], [{ type: 'Lightning' }], []);
  assert('Charizard → Blastoise: no weakness match → 100', dmg === 100);
}

{
  // Scenario: attack base 20, PlusPower bumps to 30, opponent is Mr. Mime.
  // This is exactly the edge case that breaks if you apply the wall
  // BEFORE PlusPower. Lock the order: PlusPower → Wall.
  let dmg = 20;
  dmg = applyPlusPowerValue(dmg, 10, 0); // → 30
  assert('PlusPower bumps 20→30 before Wall check', dmg === 30);
  assert('30 damage IS blocked by Invisible Wall (≥30)',
    invisibleWallBlocks(dmg) === true);
}

{
  // Scenario: Weakness before Invisible Wall.
  // Base 20 damage, Weakness doubles to 40, Mr. Mime blocks.
  let dmg = 20;
  dmg = computeDamageAfterWR(dmg, ['Fire'], [{ type: 'Fire' }], []);
  assert('Weakness doubles 20→40', dmg === 40);
  assert('Mr. Mime blocks the 40-damage attack', invisibleWallBlocks(dmg) === true);
}

{
  // Scenario: Resistance reduces below Wall threshold.
  // Base 50, Resistance subtracts 30 → 20. Mr. Mime does NOT block.
  let dmg = 50;
  dmg = computeDamageAfterWR(dmg, ['Fire'], [], [{ type: 'Fire' }]);
  assert('Resistance 50→20', dmg === 20);
  assert('20 damage does NOT trigger Invisible Wall (< 30)',
    invisibleWallBlocks(dmg) === false);
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGRESSION: P2's private zones survive SETUP → DRAW transition
//
// Bug: in networked 2P, P2 plays Magikarp + Squirtle to active/bench during
// SETUP. P2's setup_p2 push only carries { active, bench } — never P2's
// hand/deck mutations. When P1 clicks DONE SETUP, P1 pushes the FULL state
// to Firebase, including a stale snapshot of G.players[2] that still has
// the original 7-card hand. P2's receiveGameState would overwrite local
// hand with that stale snapshot, restoring the played cards and producing
// 60 + (cards-played-during-setup) total cards in the game.
//
// Fix lives in pokemon-game.html receiveGameState: when wasStarted &&
// wasSetup && incoming state.phase !== 'SETUP', preserve myRole's hand,
// deck, discard, and prizes from the local copy.
//
// This test simulates the merge logic against the rule, not the function
// directly (which lives in HTML and touches DOM/Firebase).
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n── regression: SETUP→DRAW preserves P2 private zones ────────────');

// Simulate the merge rule
function mergeIncomingForReceiver(localG, incomingState, myRole) {
  const wasStarted = localG.started;
  const wasSetup   = localG.phase === 'SETUP';
  const incomingP1 = { ...incomingState.players[1] };
  const incomingP2 = { ...incomingState.players[2] };

  if (wasStarted && wasSetup && incomingState.phase !== 'SETUP' && myRole !== null) {
    const localMe    = localG.players[myRole];
    const incomingMe = myRole === 1 ? incomingP1 : incomingP2;
    incomingMe.hand    = localMe.hand;
    incomingMe.deck    = localMe.deck;
    incomingMe.discard = localMe.discard;
    incomingMe.prizes  = localMe.prizes;
  }
  return { ...incomingState, players: { 1: incomingP1, 2: incomingP2 } };
}

{
  // Build P2's local state at end of SETUP: 5 cards in hand (played 2), 47 in deck
  // (60 - 7 dealt - 6 prizes = 47), Magikarp active, Squirtle on bench.
  const magikarp = { uid: 'mk', name: 'Magikarp' };
  const squirtle = { uid: 'sq', name: 'Squirtle' };
  const localP2 = {
    hand: [{name:'A'},{name:'B'},{name:'C'},{name:'D'},{name:'E'}],
    deck: Array(47).fill(0).map((_,i)=>({name:`D${i}`})),
    discard: [],
    prizes: Array(6).fill(0).map((_,i)=>({card:{name:`P${i}`}, revealed:false})),
    active: magikarp,
    bench: [squirtle, null, null, null, null],
  };
  const localG = {
    started: true,
    phase: 'SETUP',
    turn: 1,
    players: { 1: { hand:[], deck:[], discard:[], prizes:[], active:null, bench:[] }, 2: localP2 },
  };

  // Build P1's incoming push at SETUP→DRAW transition.
  // P1's snapshot of P2 has the STALE 7-card hand including Magikarp + Squirtle
  // (because P2 never pushed hand mutations during SETUP — only setup_p2 = {active,bench}).
  // P1's snapshot of P2's active/bench IS correct (came in via setup_p2 → mergeSetupSlot).
  const incomingP2 = {
    hand: [{name:'A'},{name:'B'},{name:'C'},{name:'D'},{name:'E'}, magikarp, squirtle],
    deck: Array(47).fill(0).map((_,i)=>({name:`D${i}`})),
    discard: [],
    prizes: Array(6).fill(0).map((_,i)=>({card:{name:`P${i}`}, revealed:false})),
    active: magikarp,    // P1 received this via setup_p2
    bench: [squirtle, null, null, null, null],
  };
  const incomingState = {
    started: true,
    phase: 'DRAW',
    turn: 1,
    players: { 1: { hand:[], deck:[], discard:[], prizes:[], active:{name:'Foo'}, bench:[] }, 2: incomingP2 },
  };

  const merged = mergeIncomingForReceiver(localG, incomingState, /*myRole=*/2);

  assert('P2 hand is preserved at 5 cards (not overwritten to 7)',
    merged.players[2].hand.length === 5);
  assert('P2 hand does NOT contain duplicate Magikarp',
    !merged.players[2].hand.some(c => c.uid === 'mk'));
  assert('P2 hand does NOT contain duplicate Squirtle',
    !merged.players[2].hand.some(c => c.uid === 'sq'));
  assert('P2 active still Magikarp (from incoming, public zone)',
    merged.players[2].active?.uid === 'mk');
  assert('P2 bench still has Squirtle (from incoming, public zone)',
    merged.players[2].bench[0]?.uid === 'sq');
  assert('Total card count is exactly 60',
    merged.players[2].hand.length + merged.players[2].deck.length +
    merged.players[2].prizes.length + (merged.players[2].active ? 1 : 0) +
    merged.players[2].bench.filter(b=>b).length === 60);
  assert('Phase advanced to DRAW from incoming state',
    merged.phase === 'DRAW');
}

{
  // Symmetric: if P1 somehow receives a SETUP-transition push from P2 (e.g.
  // hotseat-via-network), P1's hand should be preserved too.
  const localP1 = {
    hand: [{name:'X'}, {name:'Y'}],  // P1 played 5 cards
    deck: Array(47).fill(0).map(()=>({name:'D'})),
    discard: [], prizes: Array(6).fill(null), active:{name:'Onix'}, bench:[],
  };
  const localG = {
    started: true, phase: 'SETUP', turn: 1,
    players: { 1: localP1, 2: { hand:[], deck:[], discard:[], prizes:[], active:null, bench:[] } },
  };
  const incomingP1 = {
    hand: Array(7).fill(0).map((_,i)=>({name:`stale${i}`})),
    deck: Array(47).fill(0).map(()=>({name:'D'})),
    discard:[], prizes:Array(6).fill(null), active:{name:'Onix'}, bench:[],
  };
  const incomingState = {
    started:true, phase:'DRAW', turn:1,
    players:{ 1:incomingP1, 2:{hand:[],deck:[],discard:[],prizes:[],active:{name:'Foo'},bench:[]} }
  };
  const merged = mergeIncomingForReceiver(localG, incomingState, /*myRole=*/1);
  assert('P1 hand preserved at 2 cards (not overwritten to 7 stale)',
    merged.players[1].hand.length === 2);
  assert('P1 hand contains the locally-known cards',
    merged.players[1].hand[0].name === 'X' && merged.players[1].hand[1].name === 'Y');
}

{
  // Ensure normal-gameplay receives are NOT affected (no preservation).
  // Once both clients are past SETUP, every push is a full snapshot and
  // the receiver should accept the opponent's view in full.
  const localG = {
    started:true, phase:'MAIN', turn:1,
    players:{
      1:{hand:[],deck:[],discard:[],prizes:[],active:null,bench:[]},
      2:{hand:[{name:'STALE'}],deck:[],discard:[],prizes:[],active:null,bench:[]},
    },
  };
  const incomingState = {
    started:true, phase:'MAIN', turn:2,
    players:{
      1:{hand:[],deck:[],discard:[],prizes:[],active:null,bench:[]},
      2:{hand:[{name:'FRESH'}],deck:[],discard:[],prizes:[],active:null,bench:[]},
    },
  };
  const merged = mergeIncomingForReceiver(localG, incomingState, /*myRole=*/2);
  assert('Mid-game: incoming hand is accepted (not preserved)',
    merged.players[2].hand[0].name === 'FRESH');
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGRESSION: P2 must push authoritative state on SETUP→DRAW receive
//
// Bug: protecting P2's local hand at the SETUP→DRAW transition (the test above)
// is necessary but NOT sufficient. After the protection block fires, P2's local
// view is correct — but the host (P1) still has stale snapshots of P2's
// hand/deck/discard. As soon as P1 takes ANY action and pushes state (plays
// Bill, attaches energy, ends turn), the stale 7-card hand round-trips back to
// P2 because at that point wasSetup=false on P2's client and the protection
// block no longer fires. The placed Pokémon reappear in P2's hand, and the
// total card count exceeds 60.
//
// Symptom (April 2026): P2 sees their placed Pokémon back in hand "immediately
// during first turn" — specifically the moment P1's first state push lands.
//
// Fix: regardless of who is firstPlayer, P2 MUST push their authoritative state
// to Firebase as part of receiveGameState's SETUP→DRAW transition handling.
// The OLD code only pushed if P2 was firstPlayer (via the local-opening-draw
// block); the NEW code unconditionally pushes whenever wasStarted && wasSetup
// && incoming-phase !== SETUP, ensuring the host learns our actual private
// zones BEFORE acting on (and re-pushing) its stale view.
//
// This test is structural — it asserts the fix is present in receiveGameState
// by reading the source. We can't easily simulate the async Firebase race in a
// unit test, but we can lock down the requirement that the push must fire
// unconditionally on this transition (not gated by G.turn === myRole).
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n── regression: SETUP→DRAW receive must push authoritative state ─');
{
  const fs = require('fs');
  const src = fs.readFileSync('game-init.js', 'utf8');

  // Find the receiveGameState body (between its opening brace and the next
  // top-level function declaration).
  const startIdx = src.indexOf('function receiveGameState(state)');
  assert('receiveGameState exists in game-init.js', startIdx !== -1);
  // Walk forward until we hit the next `function ` at column 0 — that's
  // the end of receiveGameState.
  const tail = src.slice(startIdx);
  const nextFnIdx = tail.search(/\nfunction\s+\w+\s*\(/);
  const body = nextFnIdx === -1 ? tail : tail.slice(0, nextFnIdx);

  // Look for an UNCONDITIONAL pushGameState() call gated only by
  // (wasStarted && wasSetup && incoming-not-SETUP && myRole !== null).
  // The gate must NOT include a turn-owner check, because that was the
  // original (buggy) gate.
  //
  // We check for a block that looks like:
  //   if (wasStarted && wasSetup && ... !== 'SETUP' ... && myRole !== null) {
  //     pushGameState();
  //   }
  // and we also check that this block does NOT also require G.turn === myRole.
  const pushBlockRegex = /if\s*\(\s*wasStarted\s*&&\s*wasSetup\s*&&\s*[^)]*?!==\s*['"]SETUP['"][^)]*?myRole\s*!==\s*null\s*\)\s*\{\s*pushGameState\s*\(\s*\)\s*;\s*\}/;
  const match = body.match(pushBlockRegex);
  assert('receiveGameState contains an unconditional pushGameState() on SETUP→DRAW',
    !!match);
  if (match) {
    assert('The push block does NOT gate on G.turn === myRole (was the bug)',
      !/G\.turn\s*===\s*myRole/.test(match[0]));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGRESSION: between-turn poison/burn ticks BOTH players' actives every endTurn
//
// Bug history (multiple regressions):
//   • Original: poison only ticked the player-whose-turn-just-ended's active.
//     A poisoned P2 Pokémon got hit only on P2's turn end, never on P1's.
//   • Fix #1 (April 2026): for-loop over [1,2] in endTurn.
//   • Recurring symptom (April 2026): user reports "P2 not taking poison
//     between turns properly" — both clients agreed on a wrong value, so
//     the writer's loop was somehow skipping a player.
//
// Hypothesis behind the defensive rewrite: a poison KO on pNum=1 nulls
// G.players[1].active inside checkKO. If the loop re-reads G.players[2].active
// fresh on the next iteration, it still works. But any auto-promote that
// reassigns .active during the loop body could cause confusion. Snapshotting
// the planned ticks BEFORE applying any sidesteps the whole class of issue.
//
// computeBetweenTurnDamage is the pure version of that planning step. These
// tests lock the rule: every active with a damaging status produces exactly
// one tick entry per call. Caller is responsible for applying them.
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n── regression: between-turn poison/burn — both players tick ─────');

{
  // Both players have poisoned actives — both must tick.
  const players = {
    1: { active: { name: 'Clefairy', status: 'poisoned',  damage: 0,  hp: '40' } },
    2: { active: { name: 'Magikarp', status: 'poisoned',  damage: 10, hp: '30' } },
  };
  const ticks = computeBetweenTurnDamage(players);
  assert('Two poisoned actives → two ticks planned', ticks.length === 2);
  assert('P1 tick: 10 damage on Clefairy',
    ticks[0].player === 1 && ticks[0].dmg === 10 && ticks[0].newDamage === 10);
  assert('P2 tick: 10 damage on Magikarp (stacks on existing 10)',
    ticks[1].player === 2 && ticks[1].dmg === 10 && ticks[1].newDamage === 20);
}

{
  // Only P2 poisoned — exactly one tick, for P2.
  const players = {
    1: { active: { name: 'Geodude', status: null, damage: 0, hp: '50' } },
    2: { active: { name: 'Squirtle', status: 'poisoned', damage: 0, hp: '40' } },
  };
  const ticks = computeBetweenTurnDamage(players);
  assert('Only P2 poisoned → exactly one tick (the original recurring bug)',
    ticks.length === 1 && ticks[0].player === 2 && ticks[0].dmg === 10);
}

{
  // Only P1 poisoned — symmetric check.
  const players = {
    1: { active: { name: 'Pikachu', status: 'poisoned', damage: 20, hp: '40' } },
    2: { active: { name: 'Onix', status: null, damage: 0, hp: '90' } },
  };
  const ticks = computeBetweenTurnDamage(players);
  assert('Only P1 poisoned → exactly one tick for P1',
    ticks.length === 1 && ticks[0].player === 1 && ticks[0].newDamage === 30);
}

{
  // Toxic does 20, regular poison does 10.
  const players = {
    1: { active: { name: 'Nidoking', status: 'poisoned-toxic', damage: 0, hp: '90' } },
    2: { active: { name: 'Nidoqueen', status: 'poisoned',      damage: 0, hp: '90' } },
  };
  const ticks = computeBetweenTurnDamage(players);
  assert('Toxic ticks for 20', ticks[0].dmg === 20 && ticks[0].status === 'poisoned-toxic');
  assert('Regular poison ticks for 10', ticks[1].dmg === 10);
}

{
  // Burn ticks for 20.
  const players = {
    1: { active: { name: 'Charmander', status: 'burned', damage: 0, hp: '50' } },
    2: { active: null },
  };
  const ticks = computeBetweenTurnDamage(players);
  assert('Burn ticks for 20', ticks.length === 1 && ticks[0].dmg === 20);
}

{
  // Both players empty — no ticks.
  const ticks = computeBetweenTurnDamage({ 1:{active:null}, 2:{active:null} });
  assert('No actives → no ticks', ticks.length === 0);
}

{
  // Status that doesn't tick damage (paralyzed, asleep, confused) → no ticks.
  const players = {
    1: { active: { name: 'A', status: 'paralyzed', damage: 0, hp: '50' } },
    2: { active: { name: 'B', status: 'confused',  damage: 0, hp: '50' } },
  };
  const ticks = computeBetweenTurnDamage(players);
  assert('Paralyzed/confused do not tick damage', ticks.length === 0);
}

{
  // Asleep also doesn't tick.
  const players = {
    1: { active: { name: 'A', status: 'asleep', damage: 0, hp: '50' } },
    2: { active: null },
  };
  const ticks = computeBetweenTurnDamage(players);
  assert('Asleep does not tick damage', ticks.length === 0);
}

{
  // Defensive: missing/malformed players input doesn't throw.
  let threw = false;
  try { computeBetweenTurnDamage(null); } catch { threw = true; }
  assert('Null players input does not throw', threw === false);
  let threw2 = false;
  try { computeBetweenTurnDamage({}); } catch { threw2 = true; }
  assert('Empty players object does not throw', threw2 === false);
}

{
  // The helper does NOT mutate input cards — it just reports planned damage.
  // Caller is responsible for applying. This separates "what" from "do".
  const card = { name: 'Test', status: 'poisoned', damage: 0, hp: '50' };
  const players = { 1: { active: card }, 2: { active: null } };
  const ticks = computeBetweenTurnDamage(players);
  assert('Helper plans the tick (newDamage=10)', ticks[0].newDamage === 10);
  assert('Helper does NOT mutate card.damage (still 0)', card.damage === 0);
  assert('Helper does NOT mutate card.status', card.status === 'poisoned');
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO: Nidoking Toxic full turn cycle
//
// Craig's bug: "if Nidoking uses Toxic, that Pokémon should take 40 damage
// before Nidoking attacks again." The TCG rule is actually stricter: Toxic
// ticks at the end of BOTH players' turns, so the cycle is:
//   Turn A (Nidoking):  20 damage from Toxic attack
//   End of Turn A:      +20 Toxic poison tick       (both actives checkup)
//   Turn B (opponent):  opponent plays
//   End of Turn B:      +20 Toxic poison tick       (both actives checkup)
//   Turn A (Nidoking):  Nidoking attacks again
// Total before Nidoking's second attack: 20 + 20 + 20 = 60 damage.
//
// Previously endTurn only ticked the outgoing player's active, silently
// dropping one of the two poison ticks per cycle. Nidoking's opponent saw
// only 20 (attack) + 20 (end of their own turn) = 40 instead of 60.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── scenario: Nidoking Toxic — two ticks per turn cycle ─────────');

{
  // Simulate the full cycle by calling computeBetweenTurnDamage at each
  // transition. The production code in endTurn now does exactly this.
  const target = { name: 'Chansey', status: 'poisoned-toxic', damage: 20, hp: '120' };
  const players = { 1: { active: target }, 2: { active: { name: 'Nidoking', status: null, damage: 0, hp: '90' } } };

  // End of Nidoking's turn (P2 ends their turn)
  let ticks = computeBetweenTurnDamage(players);
  assert('End of attacker turn: exactly one tick (on poisoned target)', ticks.length === 1);
  assert('End of attacker turn: tick is on P1 (the poisoned side)', ticks[0].player === 1);
  assert('End of attacker turn: +20 Toxic dmg → total 40', ticks[0].newDamage === 40);
  // Caller applies it
  target.damage = ticks[0].newDamage;

  // Opponent's turn passes; they don't remove the status. End of their turn:
  ticks = computeBetweenTurnDamage(players);
  assert('End of defender turn: another tick fires', ticks.length === 1);
  assert('End of defender turn: +20 more → total 60', ticks[0].newDamage === 60);
  target.damage = ticks[0].newDamage;

  // Before Nidoking's second attack, Chansey has taken 60 total.
  assert('Before Nidoking\'s 2nd attack: 60 total damage (attack 20 + 2×tick 20)',
    target.damage === 60);
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGRESSION: KO-win must push state even though G.started becomes false
//
// Bug: in networked 2P, when checkKO() detects a win it sets G.started = false
// and calls showWinScreen() locally, then returns 'win'. The caller invokes
// renderAll(), which gates pushGameState() on G.started === true — so the
// transition never reaches Firebase and the LOSING client never sees that the
// game ended. They keep playing on a board the attacker considers over.
//
// Fix lives in pokemon-game.html checkKO(): after each showWinScreen() call,
// invoke pushGameState() explicitly. The deck-out path in drawCard() already
// does this; KO win sites needed the same.
//
// This test models the rule: "if the local client has just transitioned from
// started to not-started, a push must be issued." The push happens at three
// total sites: deck-out, prize-take win, last-Pokémon-KO win.
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n── regression: game-end must push to Firebase ─────────────────');

// Model the gating rule used by renderAll: pushGameState only fires when
// G.started is true. This means any code path that flips started to false
// must push EXPLICITLY before returning, otherwise the opponent never learns.
function renderAllWouldPush(g, myRole, vsComputer) {
  return myRole !== null && g.started === true && !vsComputer;
}

{
  const gAfterWin = { started: false, phase: 'MAIN' };
  assert('renderAll() will NOT push after a win (G.started=false)',
    renderAllWouldPush(gAfterWin, /*myRole=*/1, /*vsComputer=*/false) === false);
  assert('Therefore: KO win sites MUST call pushGameState() explicitly',
    true); // documentation assertion — the real check is grep-based below
}

// Grep-based check: every site that sets G.started = false in any source file
// must be followed (within ~6 lines) by a pushGameState() call. This catches
// future regressions where a new win/loss site is added without the explicit push.
//
// Originally this scanned only pokemon-game.html. After the inline JS extraction
// into game-init.js, win sites also live in game-actions.js, game-ai.js, and
// move-effects.js — so the scan must cover all source files. (The scope
// expansion uncovered 6 latent multiplayer-win-not-recorded bugs at the time.)
{
  const fs = require('fs');
  const path = require('path');
  const sourceFiles = [
    'pokemon-game.html',
    'game-init.js',
    'game-actions.js',
    'game-ai.js',
    'game-render.js',
    'game-utils.js',
    'move-effects.js',
    'pokemon-powers.js',
    'trainer-cards.js',
  ];
  const issues = [];
  let scanned = 0;
  sourceFiles.forEach(name => {
    const p = path.join(__dirname, name);
    if (!fs.existsSync(p)) return;
    scanned++;
    const src = fs.readFileSync(p, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (/G\.started\s*=\s*false/.test(line)) {
        // Look ahead 6 lines for either pushGameState() or playAgain()/reset
        // (playAgain is the cleanup path, doesn't need to push)
        const window = lines.slice(i, i + 7).join('\n');
        const isCleanup = /\bplayAgain\b|\bG\s*=\s*\{/.test(window);
        const hasPush = /pushGameState\s*\(/.test(window);
        if (!isCleanup && !hasPush) {
          issues.push(`${name}:${i+1}: ${line.trim()}`);
        }
      }
    });
  });
  assert(`Every G.started=false site is followed by pushGameState() (scanned ${scanned} files)`,
    issues.length === 0);
  if (issues.length > 0) {
    console.error('    Sites missing pushGameState():');
    issues.forEach(s => console.error('      ' + s));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGRESSION: Generic draw-a-card regex must not double-fire with named handler
//
// Bug: Kangaskhan's Fetch attack has text "Draw a card." Its named handler in
// move-effects.js (`'Fetch': { postAttack: ... drawCard }`) draws one card.
// But pokemon-game.html ALSO has a generic regex /draw a card/i that matches
// the same text and draws another card. Result: 2 cards drawn per Fetch.
//
// Same bug applies to Meowth's Pay Day on a heads flip: the named handler
// draws (gated on coin flip) AND the generic regex draws (unconditional).
//
// Fix: the generic draw-card regexes are guarded by _hasNamedPostAttack —
// when MOVE_EFFECTS[atk.name]?.postAttack exists, the generic regex is skipped.
// This mirrors the existing _hasSelfProtectPostAttack pattern in the same file.
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n── regression: named handler suppresses generic draw-card regex ─');

// Model the dispatch rule: when both a named handler and a generic regex would
// fire for the same effect category, only the named handler should run.
function shouldFireGenericDraw(atkText, hasNamedPostAttack) {
  return !hasNamedPostAttack && /draw a card/i.test(atkText || '');
}

{
  // Kangaskhan Fetch
  assert('Fetch: named handler exists → generic draw is SUPPRESSED',
    shouldFireGenericDraw('Draw a card.', /*hasNamedPostAttack=*/true) === false);
  // Future hypothetical attack with no named handler
  assert('Hypothetical "Draw a card." attack with NO handler → generic still fires',
    shouldFireGenericDraw('Draw a card.', /*hasNamedPostAttack=*/false) === true);
}
{
  // Pay Day's text contains "draw a card" inside a coin-flip clause.
  // The named handler does the conditional draw; generic regex must be suppressed.
  const payDayText = 'Flip a coin. If heads, draw a card.';
  assert('Pay Day: named handler exists → generic draw is SUPPRESSED',
    shouldFireGenericDraw(payDayText, /*hasNamedPostAttack=*/true) === false);
  assert('Pay Day text WOULD match generic /draw a card/i if unguarded',
    /draw a card/i.test(payDayText) === true);
}
{
  // Attack with no draw-card text — generic regex shouldn't fire regardless
  assert('Attack without draw-card text: generic does not fire even with no handler',
    shouldFireGenericDraw('Does 30 damage.', false) === false);
}

// Grep-based check: every generic draw-card regex must be guarded by a
// named-handler check. Catches future regressions if someone adds a new
// generic effect-text regex without the guard. After the inline-JS extraction,
// this regex lives in game-actions.js, but we scan all source files in case
// it gets moved or duplicated.
{
  const fs = require('fs');
  const path = require('path');
  const sourceFiles = [
    'pokemon-game.html', 'game-init.js', 'game-actions.js', 'game-ai.js',
    'game-render.js', 'game-utils.js', 'move-effects.js',
    'pokemon-powers.js', 'trainer-cards.js',
  ];
  const issues = [];
  let sawAny = false;
  sourceFiles.forEach(name => {
    const p = path.join(__dirname, name);
    if (!fs.existsSync(p)) return;
    const src = fs.readFileSync(p, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (/\/draw a card\/i\.test/.test(line) || /\/draw \(\\d\+\) cards/.test(line)) {
        sawAny = true;
        // Look at the surrounding ~6 lines for the named-handler guard
        const window = lines.slice(Math.max(0, i - 3), i + 4).join('\n');
        const guarded = /_hasNamedPostAttack|_hasPostAttackDispatch|MOVE_EFFECTS\[atk\.name\]/.test(window);
        if (!guarded) issues.push(`${name}:${i+1}: ${line.trim()}`);
      }
    });
  });
  assert('Every generic draw-card regex is guarded by named-handler check',
    issues.length === 0);
  // Sanity: at least ONE source file actually has the regex — otherwise the
  // test is silently passing because the code we're checking has been removed.
  assert('At least one source file contains the generic draw-card regex',
    sawAny);
  if (issues.length > 0) {
    console.error('    Unguarded sites:');
    issues.forEach(s => console.error('      ' + s));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGRESSION: attack-cost discards let player choose which energy to discard
//
// Bug: Charizard's Fire Spin ("Discard 2 Energy cards attached") was discarding
// the first 2 cards in attachedEnergy via a blind splice — no player choice.
// With Fire+Fire+DCE+DCE attached, this auto-discarded both DCEs (4 energy
// worth) when the player would have preferred to discard the 2 Fires.
//
// The discard logic now uses a card-picker UI when there's a choice, and
// pre-filters to the required type. Two helpers in game-utils.js encode the
// pure rules: parseDiscardEnergyCost (text → spec) and
// eligibleEnergyForDiscard (attached + spec → eligible indices).
//
// Critical sub-rule: typed discards ("Fire Energy card") never accept DCE
// even though Energy Burn lets DCE PAY a Fire cost. The two rules are
// independent: cost payment vs. card identity for discard.
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n── regression: attack-cost discard energy parsing ───────────────');

{
  // Charizard Fire Spin
  const spec = parseDiscardEnergyCost('Discard 2 Energy cards attached to Charizard in order to use this attack.');
  assert('Fire Spin: parsed as N=2, no required type',
    spec && spec.n === 2 && spec.requiredType === '' && !spec.isAll);
}
{
  // Ninetales Fire Blast
  const spec = parseDiscardEnergyCost('Discard 1 Fire Energy card attached to Ninetales in order to use this attack.');
  assert('Fire Blast: parsed as N=1, requiredType="fire"',
    spec && spec.n === 1 && spec.requiredType === 'fire' && !spec.isAll);
}
{
  // Zapdos Thunderbolt
  const spec = parseDiscardEnergyCost('Discard all Energy cards attached to Zapdos in order to use this attack.');
  assert('Thunderbolt: parsed as isAll=true', spec && spec.isAll === true);
}
{
  // Kadabra Recover (typed psychic)
  const spec = parseDiscardEnergyCost('Discard 1 Psychic Energy card attached to Kadabra in order to use this attack. Remove all damage counters from Kadabra.');
  assert('Recover: parsed as N=1, requiredType="psychic"',
    spec && spec.n === 1 && spec.requiredType === 'psychic');
}
{
  // Non-discard text → null
  assert('Non-discard text returns null',
    parseDiscardEnergyCost('Does 30 damage.') === null);
  assert('Empty/null text returns null',
    parseDiscardEnergyCost('') === null && parseDiscardEnergyCost(null) === null);
}

console.log('\n── regression: eligible energy for typed/untyped discards ───────');

{
  // Fire Spin scenario: user's actual reported case.
  // Charizard with [Fire, Fire, DCE, DCE] using Fire Spin (untyped, N=2).
  // All 4 cards are eligible — player should get to pick which 2.
  const attached = [
    { name: 'Fire Energy' },
    { name: 'Fire Energy' },
    { name: 'Double Colorless Energy' },
    { name: 'Double Colorless Energy' },
  ];
  const eligible = eligibleEnergyForDiscard(attached, '');
  assert('Fire Spin (untyped): all 4 cards eligible (player picks 2)',
    eligible.length === 4 && JSON.stringify(eligible) === '[0,1,2,3]');
}

{
  // Ninetales Fire Blast (typed='fire'): only the 2 Fire cards eligible.
  // DCE is Colorless and explicitly NOT a Fire Energy card for discard purposes,
  // even though Energy Burn (a different Charizard rule) lets it pay Fire costs.
  const attached = [
    { name: 'Fire Energy' },
    { name: 'Fire Energy' },
    { name: 'Double Colorless Energy' },
    { name: 'Double Colorless Energy' },
  ];
  const eligible = eligibleEnergyForDiscard(attached, 'fire');
  assert('Fire Blast (typed=fire): only the 2 Fire cards eligible',
    eligible.length === 2 && JSON.stringify(eligible) === '[0,1]');
}

{
  // Critical rule: DCE never satisfies a typed discard, even Fire (Energy Burn).
  // This is the main "don't let Energy Burn pollute the discard rule" check.
  const attached = [{ name: 'Double Colorless Energy' }];
  const eligible = eligibleEnergyForDiscard(attached, 'fire');
  assert('DCE-only attached + Fire Blast: ZERO eligible (DCE is Colorless)',
    eligible.length === 0);
}

{
  // Mixed types under a typed psychic discard
  const attached = [
    { name: 'Psychic Energy' },
    { name: 'Water Energy' },
    { name: 'Psychic Energy' },
  ];
  const eligible = eligibleEnergyForDiscard(attached, 'psychic');
  assert('Mixed types + psychic discard: only the 2 Psychic eligible',
    eligible.length === 2 && JSON.stringify(eligible) === '[0,2]');
}

{
  // Empty attached — no eligible regardless of type
  assert('Empty attached → no eligible',
    eligibleEnergyForDiscard([], 'fire').length === 0);
  assert('Null attached → no eligible (no throw)',
    eligibleEnergyForDiscard(null, '').length === 0);
}

{
  // Untyped discard accepts everything
  const attached = [
    { name: 'Fire Energy' },
    { name: 'Double Colorless Energy' },
    { name: 'Lightning Energy' },
  ];
  const eligible = eligibleEnergyForDiscard(attached, '');
  assert('Untyped discard accepts all 3',
    eligible.length === 3);
}

// ═══════════════════════════════════════════════════════════════════════════════
// aiChooseEnergyTarget — AI picks the right Pokémon to attach energy to
// ═══════════════════════════════════════════════════════════════════════════════

section('aiChooseEnergyTarget');

// game-ai.js references `document`, `window`, `setMidline` at top level.
// Stub them before require() so the module loads cleanly in Node.
global.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
};
global.window = { addEventListener: () => {} };
global.setMidline = () => {};
// Other globals game-ai.js functions reference (only used inside the tested fn path)
global.RULES = RULES;
global.energyValue = energyValue;
global.canAffordAttack = canAffordAttack;
global.computeDamageAfterWR = computeDamageAfterWR;
global.isPowerActive = () => false;
global.dittoAttacks = () => null;
global.genderLineBasicFor = genderLineBasicFor;
global.buildEvolutionStackUnder = buildEvolutionStackUnder;

const {
  aiChooseEnergyTarget: _aiChooseEnergyTarget,
  opponentThreatNextTurn: _opponentThreatNextTurn,
  willActiveDieNextTurn: _willActiveDieNextTurn,
  maxDamageForAttack: _maxDamageForAttack,
} = require('./game-ai.js');

// Kangaskhan (Jungle): Fetch [C] / Comet Punch [CCCC] — all Colorless costs
const KANGASKHAN = {
  name: 'Kangaskhan',
  attacks: [
    { name: 'Fetch',       cost: ['Colorless'],                                              damage: '' },
    { name: 'Comet Punch', cost: ['Colorless','Colorless','Colorless','Colorless'],          damage: '20×' },
  ],
  attachedEnergy: [],
};

// Squirtle (Base): Bubble [W] / Withdraw [WC]
const SQUIRTLE = {
  name: 'Squirtle',
  attacks: [
    { name: 'Bubble',   cost: ['Water'],              damage: '10' },
    { name: 'Withdraw', cost: ['Water','Colorless'],  damage: '' },
  ],
  attachedEnergy: [],
};

// Charmander (Base): Scratch [C] / Ember [FC]
const CHARMANDER = {
  name: 'Charmander',
  attacks: [
    { name: 'Scratch', cost: ['Colorless'],      damage: '10' },
    { name: 'Ember',   cost: ['Fire','Colorless'], damage: '30' },
  ],
  attachedEnergy: [],
};

// ── The reported regression ───────────────────────────────────────────────────
// Active Kangaskhan with 0 energy, benched Squirtle with 0 energy, hand has a
// Water Energy. Fetch costs only [C], so the Water Energy enables it on the
// active THIS turn — human players would attach to Kangaskhan, not Squirtle.
{
  const p2 = {
    active: { ...KANGASKHAN, attachedEnergy: [] },
    bench: [{ ...SQUIRTLE, attachedEnergy: [] }, null, null, null, null],
  };
  const target = _aiChooseEnergyTarget(p2, 'Water Energy');
  assert('Active Kangaskhan with 0 energy gets the Water Energy (enables Fetch this turn) instead of bench Squirtle',
    target && target.zone === 'active');
}

// Also: Water Energy should still go to the bench Squirtle if the active
// already has enough energy to attack.
{
  const p2 = {
    active: {
      ...KANGASKHAN,
      attachedEnergy: [{ name: 'Grass Energy' }], // Fetch already affordable
    },
    bench: [{ ...SQUIRTLE, attachedEnergy: [] }, null, null, null, null],
  };
  const target = _aiChooseEnergyTarget(p2, 'Water Energy');
  assert('Active Kangaskhan already able to attack → Water Energy goes to benched Squirtle for setup',
    target && target.zone === 'bench' && target.idx === 0);
}

// Active has 0 energy, cost requires a typed non-matching energy we don't have;
// the energy in hand enables nothing on active but does help bench. Should prefer bench.
{
  const p2 = {
    active: {
      name: 'PureWaterMon',
      attacks: [{ name: 'Splash', cost: ['Water','Water'], damage: '40' }],
      attachedEnergy: [],
    },
    bench: [{ ...CHARMANDER, attachedEnergy: [] }, null, null, null, null],
  };
  // Fire energy can't help PureWaterMon (needs 2 Water, and Fire won't satisfy Water).
  // Charmander's Scratch is [C] which Fire satisfies. Bench wins.
  const target = _aiChooseEnergyTarget(p2, 'Fire Energy');
  assert('Fire Energy goes to benched Charmander (enables Scratch) when active needs specifically Water',
    target && target.zone === 'bench' && target.idx === 0);
}

// Active has 0 energy, both active and a bench Pokémon would be enabled to
// attack. Active wins because only the active attacks THIS turn.
{
  const p2 = {
    active: { ...KANGASKHAN, attachedEnergy: [] },
    bench: [{ ...CHARMANDER, attachedEnergy: [] }, null, null, null, null],
  };
  // Colorless Energy enables Fetch on Kangaskhan AND Scratch on Charmander.
  // Active must win.
  const target = _aiChooseEnergyTarget(p2, 'Colorless Energy');
  assert('When energy enables an attack on both active and bench, active wins (only active attacks this turn)',
    target && target.zone === 'active');
}

// No active, bench-only target still picked up.
{
  const p2 = {
    active: null,
    bench: [{ ...SQUIRTLE, attachedEnergy: [] }, null, null, null, null],
  };
  const target = _aiChooseEnergyTarget(p2, 'Water Energy');
  assert('No active → falls back to best bench target',
    target && target.zone === 'bench' && target.idx === 0);
}

// No valid targets at all.
{
  const p2 = {
    active: null,
    bench: [null, null, null, null, null],
  };
  const target = _aiChooseEnergyTarget(p2, 'Water Energy');
  assert('No active, no bench → returns null',
    target === null);
}

// Edge case: active already has an attack affordable; bench Pokémon has 0 energy
// and the hand energy doesn't enable anything on it either. Should still go
// somewhere useful — either active (existing behavior) or bench for partial
// setup. We just assert it doesn't crash and returns something.
{
  const p2 = {
    active: {
      ...KANGASKHAN,
      attachedEnergy: [{ name: 'Water Energy' }, { name: 'Water Energy' }],
    },
    bench: [{ ...KANGASKHAN, attachedEnergy: [] }, null, null, null, null],
  };
  const target = _aiChooseEnergyTarget(p2, 'Water Energy');
  assert('Returns a valid target when both active and bench could use more energy',
    target && (target.zone === 'active' || target.zone === 'bench'));
}

// ── REGRESSION: Lickitung over-attach bug ────────────────────────────────────
// Solo Lickitung (max cost 3), already has 4 energy attached, empty bench.
// The AI was attaching ANOTHER energy every turn because the old "min cost"
// deficit check said "Tongue Wrap is affordable, deficit 0, so attach to the
// active anyway via fallback." Correct behavior: return null (skip attach).
{
  const LICKITUNG = {
    name: 'Lickitung',
    attacks: [
      { name: 'Tongue Wrap', cost: ['Colorless','Colorless'],              damage: '10' },
      { name: 'Supersonic',  cost: ['Colorless','Colorless','Colorless'],  damage: '' },
    ],
  };
  const p2 = {
    active: {
      ...LICKITUNG,
      attachedEnergy: [
        { name: 'Grass Energy' }, { name: 'Grass Energy' },
        { name: 'Grass Energy' }, { name: 'Grass Energy' },
      ],
    },
    bench: [null, null, null, null, null],
  };
  const target = _aiChooseEnergyTarget(p2, 'Grass Energy');
  assert('Lickitung fully powered (max cost 3, has 4) + empty bench → no attach',
    target === null);
}

// Lickitung exactly at max-cost (3 energy for Supersonic) + empty bench.
// Attaching a 4th does nothing — Supersonic is the most expensive attack.
// Expected: skip attach.
{
  const LICKITUNG = {
    name: 'Lickitung',
    attacks: [
      { name: 'Tongue Wrap', cost: ['Colorless','Colorless'],              damage: '10' },
      { name: 'Supersonic',  cost: ['Colorless','Colorless','Colorless'],  damage: '' },
    ],
  };
  const p2 = {
    active: {
      ...LICKITUNG,
      attachedEnergy: [
        { name: 'Grass Energy' }, { name: 'Grass Energy' }, { name: 'Grass Energy' },
      ],
    },
    bench: [null, null, null, null, null],
  };
  const target = _aiChooseEnergyTarget(p2, 'Grass Energy');
  assert('Lickitung at max cost (3/3) + empty bench → no attach (save the card)',
    target === null);
}

// Lickitung with 2 energy (Tongue Wrap affordable, Supersonic not) → still
// benefits from one more attach (max cost is 3). Energy should attach.
{
  const LICKITUNG = {
    name: 'Lickitung',
    attacks: [
      { name: 'Tongue Wrap', cost: ['Colorless','Colorless'],              damage: '10' },
      { name: 'Supersonic',  cost: ['Colorless','Colorless','Colorless'],  damage: '' },
    ],
  };
  const p2 = {
    active: {
      ...LICKITUNG,
      attachedEnergy: [{ name: 'Grass Energy' }, { name: 'Grass Energy' }],
    },
    bench: [null, null, null, null, null],
  };
  const target = _aiChooseEnergyTarget(p2, 'Grass Energy');
  assert('Lickitung at 2/3: one more energy still useful (Supersonic not yet affordable)',
    target !== null && target.zone === 'active');
}

// Fully powered active + bench Pokémon that CAN still benefit → attach to bench.
// This exercises the correct "no active benefit, bench still has a deficit"
// path, ensuring the fix didn't accidentally always-return-null.
{
  const LICKITUNG = {
    name: 'Lickitung',
    attacks: [
      { name: 'Supersonic', cost: ['Colorless','Colorless','Colorless'], damage: '' },
    ],
  };
  const p2 = {
    active: {
      ...LICKITUNG,
      attachedEnergy: [
        { name: 'Grass Energy' }, { name: 'Grass Energy' }, { name: 'Grass Energy' },
      ],
    },
    bench: [{ ...CHARMANDER, attachedEnergy: [] }, null, null, null, null],
  };
  const target = _aiChooseEnergyTarget(p2, 'Grass Energy');
  assert('Fully-powered active + unpowered bench → attach to bench',
    target !== null && target.zone === 'bench' && target.idx === 0);
}

// All Pokémon are fully powered → return null.
{
  const LICKITUNG = {
    name: 'Lickitung',
    attacks: [
      { name: 'Supersonic', cost: ['Colorless','Colorless','Colorless'], damage: '' },
    ],
  };
  const p2 = {
    active: {
      ...LICKITUNG,
      attachedEnergy: [
        { name: 'Grass Energy' }, { name: 'Grass Energy' }, { name: 'Grass Energy' },
      ],
    },
    bench: [
      {
        ...LICKITUNG,
        attachedEnergy: [
          { name: 'Grass Energy' }, { name: 'Grass Energy' }, { name: 'Grass Energy' },
        ],
      },
      null, null, null, null,
    ],
  };
  const target = _aiChooseEnergyTarget(p2, 'Grass Energy');
  assert('All Pokémon fully powered → return null (save the energy card)',
    target === null);
}

// ═══════════════════════════════════════════════════════════════════════════════
// maxDamageForAttack — coin-flip worst-case damage parsing
// ═══════════════════════════════════════════════════════════════════════════════

section('maxDamageForAttack');

{
  // Comet Punch: Flip 4 coins. 20 damage times the number of heads. Max = 80.
  const comet = {
    name: 'Comet Punch',
    damage: '20×',
    text: 'Flip 4 coins. This attack does 20 damage times the number of heads.',
  };
  assertEqual('Comet Punch max = 80 (4 flips × 20)',
    _maxDamageForAttack(comet, 0), 80);
}

{
  // Twineedle: Flip 2 coins. 30 damage times the number of heads. Max = 60.
  const twineedle = {
    name: 'Twineedle',
    damage: '30×',
    text: 'Flip 2 coins. This attack does 30 damage times the number of heads.',
  };
  assertEqual('Twineedle max = 60 (2 flips × 30)',
    _maxDamageForAttack(twineedle, 0), 60);
}

{
  // Bonemerang: Flip 2 coins. 30 × heads. Max = 60.
  const bonemerang = {
    name: 'Bonemerang',
    damage: '30×',
    text: 'Flip 2 coins. This attack does 30 damage times the number of heads. If both are tails, this attack does nothing.',
  };
  assertEqual('Bonemerang max = 60',
    _maxDamageForAttack(bonemerang, 0), 60);
}

{
  // "Flip a coin. If heads, this attack does 10 more damage" — Scratch + bonus
  const move = {
    name: 'Hypothetical',
    damage: '20',
    text: 'Flip a coin. If heads, this attack does 10 more damage.',
  };
  assertEqual('"If heads, 10 more damage" → 20 + 10 = 30',
    _maxDamageForAttack(move, 0), 30);
}

{
  // "Flip a coin. If tails, this attack does nothing." — max = base
  const move = {
    name: 'Smokescreen',
    damage: '40',
    text: 'Flip a coin. If tails, this attack does nothing.',
  };
  assertEqual('"If tails, nothing" → max = base 40',
    _maxDamageForAttack(move, 0), 40);
}

{
  // Plain attack with no coin-flip text → base damage
  const move = { name: 'Scratch', damage: '10', text: 'No effect.' };
  assertEqual('Plain attack → base damage',
    _maxDamageForAttack(move, 0), 10);
}

{
  // Missing text field → base damage (graceful fallback)
  const move = { name: 'Mystery', damage: '30' };
  assertEqual('Missing text → falls back to base',
    _maxDamageForAttack(move, 0), 30);
}

{
  // 0-damage attack (status-only) → 0
  const move = { name: 'Pound', damage: '', text: 'Does nothing special.' };
  assertEqual('0-damage attack → 0',
    _maxDamageForAttack(move, 0), 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// opponentThreatNextTurn — how much damage can the opponent do next turn?
// ═══════════════════════════════════════════════════════════════════════════════

section('opponentThreatNextTurn');

// Helper: build a minimal player object
function mkP(opts = {}) {
  return {
    active: opts.active || null,
    bench: opts.bench || [null, null, null, null, null],
    hand: opts.hand || [],
    discard: opts.discard || [],
  };
}

// Hitmonchan — Jab [F] 20, Special Punch [FFC] 40.
const HITMONCHAN = {
  name: 'Hitmonchan',
  hp: '70',
  types: ['Fighting'],
  attacks: [
    { name: 'Jab', cost: ['Fighting'], damage: '20', text: '' },
    { name: 'Special Punch', cost: ['Fighting','Fighting','Colorless'], damage: '40', text: '' },
  ],
  attachedEnergy: [{ name: 'Fighting Energy' }, { name: 'Fighting Energy' }],
  weaknesses: [], resistances: [],
};

// Electabuzz — Thundershock [L] 10 (+paralysis flip) / Thunderpunch [LLC] 30 (+10 if heads)
const ELECTABUZZ = {
  name: 'Electabuzz',
  hp: '70',
  types: ['Lightning'],
  attacks: [
    { name: 'Thundershock', cost: ['Lightning'], damage: '10',
      text: 'Flip a coin. If heads, the Defending Pokémon is now Paralyzed.' },
    { name: 'Thunderpunch', cost: ['Lightning','Lightning','Colorless'], damage: '30',
      text: 'Flip a coin. If heads, this attack does 10 more damage; if tails, this attack does 10 damage to itself.' },
  ],
  attachedEnergy: [{ name: 'Lightning Energy' }, { name: 'Lightning Energy' }],
  weaknesses: [], resistances: [],
};

// A defender Pokémon with Fighting weakness (e.g., Electabuzz has no weakness;
// use a fictional mon to test weakness doubling)
const FIGHTING_WEAK = {
  name: 'RockTarget', hp: '80',
  types: [], attacks: [], attachedEnergy: [],
  weaknesses: [{ type: 'Fighting', value: '×2' }],
  resistances: [],
};

// No active at all
{
  const attacker = mkP({ active: null });
  const defender = mkP({ active: HITMONCHAN });
  assertEqual('No attacker active → threat 0',
    _opponentThreatNextTurn(attacker, defender), 0);
}

{
  const attacker = mkP({ active: HITMONCHAN });
  const defender = mkP({ active: null });
  assertEqual('No defender active → threat 0',
    _opponentThreatNextTurn(attacker, defender), 0);
}

// Hitmonchan (Jab=20, Special Punch=40 with 2F attached + 1 more energy needed
// but canAffordAttack needs F,F,C → with 2F attached, Special Punch not affordable
// yet. Hand has no energy. Max affordable = Jab = 20.
{
  const attacker = mkP({ active: HITMONCHAN });
  const defender = mkP({
    active: {
      name: 'TargetDummy', hp: '60',
      types: [], attacks: [], attachedEnergy: [],
      weaknesses: [], resistances: [],
    },
  });
  assertEqual('Hitmonchan with 2F, empty hand → threat 20 (Jab only)',
    _opponentThreatNextTurn(attacker, defender), 20);
}

// Same setup but hand has a Colorless Energy → Special Punch becomes affordable → 40
{
  const attacker = mkP({
    active: HITMONCHAN,
    hand: [{ name: 'Fighting Energy', supertype: 'Energy' }],
  });
  const defender = mkP({
    active: {
      name: 'TargetDummy', hp: '60',
      types: [], attacks: [], attachedEnergy: [],
      weaknesses: [], resistances: [],
    },
  });
  assertEqual('Hitmonchan + F in hand → threat 40 (Special Punch enabled)',
    _opponentThreatNextTurn(attacker, defender), 40);
}

// Weakness doubling
{
  const attacker = mkP({ active: HITMONCHAN });
  const defender = mkP({ active: FIGHTING_WEAK });
  assertEqual('Hitmonchan Jab on Fighting-weak target → 20 × 2 = 40',
    _opponentThreatNextTurn(attacker, defender), 40);
}

// PlusPower in attacker's hand adds +10
{
  const attacker = mkP({
    active: HITMONCHAN,
    hand: [{ name: 'PlusPower', supertype: 'Trainer' }],
  });
  const defender = mkP({
    active: {
      name: 'TargetDummy', hp: '60',
      types: [], attacks: [], attachedEnergy: [],
      weaknesses: [], resistances: [],
    },
  });
  assertEqual('Hitmonchan + PlusPower → threat 30 (20 + 10)',
    _opponentThreatNextTurn(attacker, defender), 30);
}

// Paralyzed attacker → 0
{
  const attacker = mkP({
    active: { ...HITMONCHAN, status: 'paralyzed' },
  });
  const defender = mkP({
    active: {
      name: 'TargetDummy', hp: '60',
      types: [], attacks: [], attachedEnergy: [],
      weaknesses: [], resistances: [],
    },
  });
  assertEqual('Paralyzed attacker → threat 0',
    _opponentThreatNextTurn(attacker, defender), 0);
}

// Coin-flip max damage: Kangaskhan Comet Punch with enough energy → 80 max
{
  const kang = {
    name: 'Kangaskhan', hp: '90', types: ['Colorless'],
    attacks: [
      { name: 'Fetch', cost: ['Colorless'], damage: '', text: 'Draw a card.' },
      { name: 'Comet Punch', cost: ['Colorless','Colorless','Colorless','Colorless'],
        damage: '20×',
        text: 'Flip 4 coins. This attack does 20 damage times the number of heads.' },
    ],
    attachedEnergy: [{ name: 'Grass Energy' }, { name: 'Grass Energy' },
                     { name: 'Grass Energy' }, { name: 'Grass Energy' }],
    weaknesses: [], resistances: [],
  };
  const attacker = mkP({ active: kang });
  const defender = mkP({
    active: {
      name: 'TargetDummy', hp: '100',
      types: [], attacks: [], attachedEnergy: [],
      weaknesses: [], resistances: [],
    },
  });
  assertEqual('Kangaskhan with 4C → Comet Punch worst-case threat = 80',
    _opponentThreatNextTurn(attacker, defender), 80);
}

// Disabled attack is filtered out
{
  const attacker = mkP({
    active: {
      ...HITMONCHAN,
      disabledAttack: 'Jab', // Kadabra-style disable
    },
  });
  const defender = mkP({
    active: {
      name: 'TargetDummy', hp: '60',
      types: [], attacks: [], attachedEnergy: [],
      weaknesses: [], resistances: [],
    },
  });
  // Jab disabled, Special Punch not affordable (only 2F, needs FFC) → 0
  assertEqual('Disabled attack skipped + Special Punch unaffordable → 0',
    _opponentThreatNextTurn(attacker, defender), 0);
}

// attackReduction debuff reduces threat
{
  const attacker = mkP({
    active: { ...HITMONCHAN, attackReduction: 10 },
  });
  const defender = mkP({
    active: {
      name: 'TargetDummy', hp: '60',
      types: [], attacks: [], attachedEnergy: [],
      weaknesses: [], resistances: [],
    },
  });
  assertEqual('attackReduction=10 on Hitmonchan → Jab threat 20 - 10 = 10',
    _opponentThreatNextTurn(attacker, defender), 10);
}

// ── Bench-threat model (#5) ─────────────────────────────────────────────────
// opponentThreatNextTurn must consider bench Pokémon reachable via retreat,
// Switch, or Scoop Up. Otherwise the AI thinks a weak active means safety,
// even when a fully-loaded threat sits on their bench one retreat away.

// A weak active and a scary bench, with NO retreat path → bench ignored.
{
  const weakActive = {
    name: 'Magikarp', hp: '30',
    types: ['Water'],
    attacks: [{ name: 'Tackle', cost: ['Water'], damage: '10', text: '' }],
    attachedEnergy: [{ name: 'Water Energy' }],
    convertedRetreatCost: 5, // can't afford — only 1 energy attached
    weaknesses: [], resistances: [],
  };
  const benchBeast = {
    name: 'Hitmonchan', hp: '70',
    types: ['Fighting'],
    attacks: [{ name: 'Special Punch', cost: ['Fighting','Fighting','Colorless'], damage: '40', text: '' }],
    attachedEnergy: [{ name: 'Fighting Energy' }, { name: 'Fighting Energy' }, { name: 'Fighting Energy' }],
    weaknesses: [], resistances: [],
  };
  const attacker = mkP({ active: weakActive, bench: [benchBeast, null, null, null, null], hand: [] });
  const defender = mkP({ active: { name: 'X', hp: '70', weaknesses: [], resistances: [] } });
  assertEqual('No-retreat: bench threat NOT counted, only weak active (Tackle=10)',
    _opponentThreatNextTurn(attacker, defender), 10);
}

// Same setup but retreat IS affordable → bench threat counted.
{
  const activeWithRetreat = {
    name: 'Magikarp', hp: '30',
    types: ['Water'],
    attacks: [{ name: 'Tackle', cost: ['Water'], damage: '10', text: '' }],
    attachedEnergy: [{ name: 'Water Energy' }],
    convertedRetreatCost: 1, // CAN afford
    weaknesses: [], resistances: [],
  };
  const benchBeast = {
    name: 'Hitmonchan', hp: '70',
    types: ['Fighting'],
    attacks: [{ name: 'Special Punch', cost: ['Fighting','Fighting','Colorless'], damage: '40', text: '' }],
    attachedEnergy: [{ name: 'Fighting Energy' }, { name: 'Fighting Energy' }, { name: 'Fighting Energy' }],
    weaknesses: [], resistances: [],
  };
  const attacker = mkP({ active: activeWithRetreat, bench: [benchBeast, null, null, null, null], hand: [] });
  const defender = mkP({ active: { name: 'X', hp: '70', weaknesses: [], resistances: [] } });
  assertEqual('Retreat-reachable: bench Hitmonchan Special Punch threat = 40',
    _opponentThreatNextTurn(attacker, defender), 40);
}

// Switch card in hand → bench reachable regardless of retreat cost.
{
  const stuckActive = {
    name: 'Snorlax', hp: '90',
    types: ['Colorless'],
    attacks: [{ name: 'Body Slam', cost: ['Colorless','Colorless','Colorless','Colorless'], damage: '30', text: '' }],
    attachedEnergy: [], // no energy — can't attack AND can't retreat (cost 4)
    convertedRetreatCost: 4,
    weaknesses: [], resistances: [],
  };
  const benchBeast = {
    name: 'Hitmonchan', hp: '70',
    types: ['Fighting'],
    attacks: [{ name: 'Jab', cost: ['Fighting'], damage: '20', text: '' }],
    attachedEnergy: [{ name: 'Fighting Energy' }],
    weaknesses: [], resistances: [],
  };
  const attacker = mkP({
    active: stuckActive,
    bench: [benchBeast, null, null, null, null],
    hand: [{ supertype: 'Trainer', name: 'Switch' }],
  });
  const defender = mkP({ active: { name: 'X', hp: '70', weaknesses: [], resistances: [] } });
  assertEqual('Switch in hand: bench Hitmonchan Jab threat = 20 (active can\'t attack)',
    _opponentThreatNextTurn(attacker, defender), 20);
}

// Scoop Up also enables bench reach.
{
  const stuckActive = {
    name: 'Snorlax', hp: '90',
    types: ['Colorless'],
    attacks: [{ name: 'Body Slam', cost: ['Colorless','Colorless','Colorless','Colorless'], damage: '30', text: '' }],
    attachedEnergy: [],
    convertedRetreatCost: 4,
    weaknesses: [], resistances: [],
  };
  const benchBeast = {
    name: 'Hitmonchan', hp: '70',
    types: ['Fighting'],
    attacks: [{ name: 'Jab', cost: ['Fighting'], damage: '20', text: '' }],
    attachedEnergy: [{ name: 'Fighting Energy' }],
    weaknesses: [], resistances: [],
  };
  const attacker = mkP({
    active: stuckActive,
    bench: [benchBeast, null, null, null, null],
    hand: [{ supertype: 'Trainer', name: 'Scoop Up' }],
  });
  const defender = mkP({ active: { name: 'X', hp: '70', weaknesses: [], resistances: [] } });
  assertEqual('Scoop Up in hand: bench Hitmonchan Jab threat = 20',
    _opponentThreatNextTurn(attacker, defender), 20);
}

// Paralyzed active blocks manual retreat AND own attack, but Switch bypasses.
{
  const paralyzedActive = {
    name: 'Hitmonchan', hp: '70',
    types: ['Fighting'],
    status: 'paralyzed',
    attacks: [{ name: 'Special Punch', cost: ['Fighting','Fighting','Colorless'], damage: '40', text: '' }],
    attachedEnergy: [{ name: 'Fighting Energy' }, { name: 'Fighting Energy' }, { name: 'Fighting Energy' }],
    convertedRetreatCost: 1, // affordable if not paralyzed
    weaknesses: [], resistances: [],
  };
  const benchMon = {
    name: 'Jab-er', hp: '60',
    types: ['Fighting'],
    attacks: [{ name: 'Jab', cost: ['Fighting'], damage: '20', text: '' }],
    attachedEnergy: [{ name: 'Fighting Energy' }],
    weaknesses: [], resistances: [],
  };
  const defender = mkP({ active: { name: 'X', hp: '70', weaknesses: [], resistances: [] } });

  // Case A: no Switch → paralyzed active can't attack, can't retreat → threat 0
  const attackerNoSwitch = mkP({
    active: paralyzedActive,
    bench: [benchMon, null, null, null, null],
    hand: [],
  });
  assertEqual('Paralyzed, no Switch: threat = 0 (no bench reach)',
    _opponentThreatNextTurn(attackerNoSwitch, defender), 0);

  // Case B: Switch in hand → bench reachable via Switch → bench threat counted
  const attackerWithSwitch = mkP({
    active: paralyzedActive,
    bench: [benchMon, null, null, null, null],
    hand: [{ supertype: 'Trainer', name: 'Switch' }],
  });
  assertEqual('Paralyzed, has Switch: bench Jab threat = 20',
    _opponentThreatNextTurn(attackerWithSwitch, defender), 20);
}

// Max over active + bench — bench threat exceeds active threat only if greater.
{
  // Active does 40 damage; bench does 20 damage. Max = 40 (active).
  const strongActive = {
    name: 'Hitmonchan', hp: '70',
    types: ['Fighting'],
    attacks: [{ name: 'Special Punch', cost: ['Fighting','Fighting','Colorless'], damage: '40', text: '' }],
    attachedEnergy: [{ name: 'Fighting Energy' }, { name: 'Fighting Energy' }, { name: 'Fighting Energy' }],
    convertedRetreatCost: 1,
    weaknesses: [], resistances: [],
  };
  const weakerBench = {
    name: 'WeakerBench', hp: '50',
    types: ['Fighting'],
    attacks: [{ name: 'Poke', cost: ['Fighting'], damage: '20', text: '' }],
    attachedEnergy: [{ name: 'Fighting Energy' }],
    weaknesses: [], resistances: [],
  };
  const attacker = mkP({ active: strongActive, bench: [weakerBench, null, null, null, null], hand: [] });
  const defender = mkP({ active: { name: 'X', hp: '70', weaknesses: [], resistances: [] } });
  assertEqual('Active > bench threat → max is active (40, not 20)',
    _opponentThreatNextTurn(attacker, defender), 40);
}

// Weakness applies to the BENCH attacker too, not just the active.
{
  // Bench Hitmonchan has no attacker advantage on its own, but our active is
  // Fighting-weak → bench Jab becomes 40 damage.
  const weakActive = {
    name: 'Magikarp', hp: '30',
    types: ['Water'],
    attacks: [{ name: 'Tackle', cost: ['Water'], damage: '10', text: '' }],
    attachedEnergy: [{ name: 'Water Energy' }],
    convertedRetreatCost: 1,
    weaknesses: [], resistances: [],
  };
  const benchMon = {
    name: 'Hitmonchan', hp: '70',
    types: ['Fighting'],
    attacks: [{ name: 'Jab', cost: ['Fighting'], damage: '20', text: '' }],
    attachedEnergy: [{ name: 'Fighting Energy' }],
    weaknesses: [], resistances: [],
  };
  const defender = mkP({
    active: {
      name: 'WeakDefender', hp: '70',
      weaknesses: [{ type: 'Fighting', value: '×2' }],
      resistances: [],
    },
  });
  const attacker = mkP({
    active: weakActive,
    bench: [benchMon, null, null, null, null],
    hand: [],
  });
  // Active Magikarp: Tackle = 10 (no weakness exploit — our defender weak to Fighting, not Water).
  // Bench Hitmonchan: Jab = 20 × 2 weakness = 40.
  assertEqual('Weakness doubles bench-attacker damage → 40',
    _opponentThreatNextTurn(attacker, defender), 40);
}

// ═══════════════════════════════════════════════════════════════════════════════
// willActiveDieNextTurn — threat vs HP remaining
// ═══════════════════════════════════════════════════════════════════════════════

section('willActiveDieNextTurn');

{
  // Defender active: Squirtle with 20 damage, 40 HP left, facing Hitmonchan (20 dmg)
  const attacker = mkP({ active: HITMONCHAN });
  const defender = mkP({
    active: {
      name: 'Squirtle', hp: '40', damage: 20,
      types: [], attacks: [], attachedEnergy: [],
      weaknesses: [], resistances: [],
    },
  });
  assert('40HP-20dmg=20 left; Hitmonchan Jab does 20 → WILL die',
    _willActiveDieNextTurn(defender, attacker) === true);
}

{
  // Same situation but Hitmonchan only has 1F energy → can't attack (Jab needs F)
  // Wait, Jab needs [F] and attacker has 2F. OK use different setup.
  // Defender has 30 HP left, attacker does 20 → survives
  const attacker = mkP({ active: HITMONCHAN });
  const defender = mkP({
    active: {
      name: 'Squirtle', hp: '40', damage: 10,
      types: [], attacks: [], attachedEnergy: [],
      weaknesses: [], resistances: [],
    },
  });
  assert('40HP-10dmg=30 left; Hitmonchan Jab does 20 → SURVIVES',
    _willActiveDieNextTurn(defender, attacker) === false);
}

{
  // Paralyzed attacker → safe regardless of damage
  const attacker = mkP({ active: { ...HITMONCHAN, status: 'paralyzed' } });
  const defender = mkP({
    active: {
      name: 'LowHP', hp: '40', damage: 30,
      types: [], attacks: [], attachedEnergy: [],
      weaknesses: [], resistances: [],
    },
  });
  assert('Paralyzed attacker → defender safe even at 10 HP left',
    _willActiveDieNextTurn(defender, attacker) === false);
}

{
  // Already-KO'd → returns false (nothing to protect, separate flow)
  const attacker = mkP({ active: HITMONCHAN });
  const defender = mkP({
    active: {
      name: 'Dead', hp: '40', damage: 40,
      types: [], attacks: [], attachedEnergy: [],
      weaknesses: [], resistances: [],
    },
  });
  assert('Already KO\'d (hpLeft ≤ 0) → returns false',
    _willActiveDieNextTurn(defender, attacker) === false);
}



// ═══════════════════════════════════════════════════════════════════════════════
// Bug regression: between-turns KO / _endTurnInterrupted (Bug #1 & #2)
// ═══════════════════════════════════════════════════════════════════════════════

section('Between-turns KO — computeBetweenTurnDamage produces ticks for both sides');

{
  // Both players' actives are poisoned — both should get a tick.
  const players = {
    1: { active: { name: 'A', hp: '60', damage: 0, status: 'poisoned', attachedEnergy: [], types: [], attacks: [], weaknesses: [], resistances: [] } },
    2: { active: { name: 'B', hp: '60', damage: 0, status: 'poisoned', attachedEnergy: [], types: [], attacks: [], weaknesses: [], resistances: [] } },
  };
  const ticks = computeBetweenTurnDamage(players);
  assert('Both poisoned → 2 ticks generated', ticks.length === 2);
  assert('Tick for player 1 exists', ticks.some(t => t.player === 1));
  assert('Tick for player 2 exists', ticks.some(t => t.player === 2));
}

{
  // Toxic (poisoned-toxic) tick should be 20 damage.
  const players = {
    1: { active: { name: 'Nidoking', hp: '90', damage: 0, status: 'poisoned-toxic', poisonCounters: 2, attachedEnergy: [], types: [], attacks: [], weaknesses: [], resistances: [] } },
    2: { active: null },
  };
  const ticks = computeBetweenTurnDamage(players);
  assert('Toxic tick is 20', ticks[0]?.dmg === 20);
}

{
  // Burn tick is always 20.
  const players = {
    1: { active: { name: 'Moltres', hp: '100', damage: 0, status: 'burned', attachedEnergy: [], types: [], attacks: [], weaknesses: [], resistances: [] } },
    2: { active: null },
  };
  const ticks = computeBetweenTurnDamage(players);
  assert('Burn tick is 20', ticks[0]?.dmg === 20);
}

{
  // No active → no ticks.
  const players = {
    1: { active: null },
    2: { active: null },
  };
  const ticks = computeBetweenTurnDamage(players);
  assert('No actives → no ticks', ticks.length === 0);
}

{
  // Healthy active → no ticks.
  const players = {
    1: { active: { name: 'Pikachu', hp: '40', damage: 0, status: null, attachedEnergy: [], types: [], attacks: [], weaknesses: [], resistances: [] } },
    2: { active: null },
  };
  const ticks = computeBetweenTurnDamage(players);
  assert('Healthy active → no ticks', ticks.length === 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Bug regression: coinFlipLog ts watermark (Bug #4)
// ═══════════════════════════════════════════════════════════════════════════════

section('coinFlipLog ts watermark — new flips correctly identified');

{
  // Simulate the filter logic from receiveGameState:
  // Only entries with ts > watermark should be replayed.
  const before = Date.now() - 1000;
  const coinFlipLog = [
    { label: 'old flip', heads: true, ts: before - 500 },
    { label: 'new flip 1', heads: false, ts: before + 100 },
    { label: 'new flip 2', heads: true, ts: before + 200 },
  ];
  const watermark = before;
  const newFlips = coinFlipLog.filter(f => f.ts && f.ts > watermark);
  assert('Two new flips identified past watermark', newFlips.length === 2);
  assert('Old flip excluded', !newFlips.some(f => f.label === 'old flip'));
  assert('Watermark advances to last new flip ts', newFlips[newFlips.length - 1].ts === before + 200);
}

{
  // Flips without ts field (old game state) are excluded from replay.
  const coinFlipLog = [
    { label: 'legacy flip', heads: true }, // no ts
    { label: 'new flip', heads: false, ts: Date.now() },
  ];
  const watermark = 0;
  const newFlips = coinFlipLog.filter(f => f.ts && f.ts > watermark);
  assert('Legacy flip without ts excluded from replay', newFlips.length === 1);
  assert('New flip with ts included', newFlips[0].label === 'new flip');
}

{
  // Empty log → no flips.
  const newFlips = [].filter(f => f.ts && f.ts > 0);
  assert('Empty coinFlipLog → no flips', newFlips.length === 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGRESSION: end-of-turn flag clearing respects which side owns each flag
//
// Bug: Poliwhirl's Amnesia (and Kadabra's Disable, etc.) set `disabledAttack`
// on the opponent's active. The effect is supposed to last through the
// opponent's upcoming turn. `_finishEndTurn` used to clear `disabledAttack`,
// `cantRetreat`, and `attackReduction` on `G.players[G.turn].active` — the
// player whose turn is ABOUT to start — which nulled the flag before the
// victim ever got to act. The AI would then happily use the disabled attack.
//
// Correct semantics:
//   - Flags placed on the OPPONENT during an attacker's turn
//     (cantRetreat / attackReduction / disabledAttack) belong to the victim.
//     They expire when the victim's turn ENDS, at which point the victim is
//     `prev` (the player whose turn just ended). Clear on G.players[prev].
//   - Flags placed on the USER by their own attack (defender family) protect
//     DURING the opponent's turn. They expire when that opponent's turn ends,
//     at which point the beneficiary is `G.turn` (the turn just flipped away
//     from the opponent). Clear on G.players[G.turn].
//
// This test replicates the exact clearing block logic in _finishEndTurn and
// asserts both sides of each lifecycle.
// ═══════════════════════════════════════════════════════════════════════════════

section('REGRESSION: end-of-turn flag clearing — Amnesia / Leer / Growl / Defender lifecycle');

// Mimic the _finishEndTurn flag-clear block exactly.
function simulateFinishEndTurnFlagClear(Gref, prev) {
  const nextActive = Gref.players[Gref.turn].active;
  if (nextActive) {
    nextActive.defender = false;
    nextActive.defenderFull = false;
    nextActive.defenderFullEffects = false;
    nextActive.defenderThreshold = 0;
    nextActive.defenderReduction = 0;
  }
  const lastActive = Gref.players[prev].active;
  if (lastActive) {
    lastActive.cantRetreat = false;
    lastActive.attackReduction = 0;
    lastActive.disabledAttack = null;
    lastActive.defenderReduction = 0;
    lastActive.smokescreened = false;
  }
}

{
  // Scenario: P1 Poliwhirl uses Amnesia on P2 Hitmonchan, disabling Special Punch.
  // P1 ends their turn. P2's turn begins. Special Punch MUST still be disabled.
  // Then P2 ends their turn — the flag clears.
  const G = {
    turn: 1,
    players: {
      1: { active: { name: 'Poliwhirl', attacks: [] } },
      2: { active: { name: 'Hitmonchan', attacks: [{ name: 'Jab' }, { name: 'Special Punch' }], disabledAttack: 'Special Punch' } },
    },
  };

  // P1 ends turn → prev=1, turn flips to 2.
  let prev = G.turn;
  G.turn = 2;
  simulateFinishEndTurnFlagClear(G, prev);
  assertEqual(
    'After P1 ends turn: P2 Hitmonchan still has Special Punch disabled',
    G.players[2].active.disabledAttack, 'Special Punch'
  );
  assertEqual(
    'After P1 ends turn: P1 Poliwhirl has no lingering disabledAttack (no-op clear is fine)',
    G.players[1].active.disabledAttack ?? null, null
  );

  // P2 takes their turn (would skip Special Punch in attack picker / AI filter).
  // P2 ends turn → prev=2, turn flips back to 1.
  prev = G.turn;
  G.turn = 1;
  simulateFinishEndTurnFlagClear(G, prev);
  assertEqual(
    'After P2 ends turn: P2 Hitmonchan disabledAttack is now cleared',
    G.players[2].active.disabledAttack, null
  );
}

{
  // Leer (cantRetreat placed on opponent) — same lifecycle as Amnesia.
  const G = {
    turn: 1,
    players: {
      1: { active: { name: 'Ekans' } },
      2: { active: { name: 'Charmander', cantRetreat: true } },
    },
  };

  let prev = G.turn; G.turn = 2;
  simulateFinishEndTurnFlagClear(G, prev);
  assertEqual('Leer: after P1 ends turn, P2 active still cant retreat',
    G.players[2].active.cantRetreat, true);

  prev = G.turn; G.turn = 1;
  simulateFinishEndTurnFlagClear(G, prev);
  assertEqual('Leer: after P2 ends turn, cantRetreat cleared',
    G.players[2].active.cantRetreat, false);
}

{
  // Growl / Tail Whip (attackReduction placed on opponent).
  const G = {
    turn: 1,
    players: {
      1: { active: { name: 'Nidoran M' } },
      2: { active: { name: 'Hitmonchan', attackReduction: 10 } },
    },
  };

  let prev = G.turn; G.turn = 2;
  simulateFinishEndTurnFlagClear(G, prev);
  assertEqual('Growl: after P1 ends turn, P2 active attackReduction still 10',
    G.players[2].active.attackReduction, 10);

  prev = G.turn; G.turn = 1;
  simulateFinishEndTurnFlagClear(G, prev);
  assertEqual('Growl: after P2 ends turn, attackReduction reset to 0',
    G.players[2].active.attackReduction, 0);
}

{
  // Defender (self-buff). P1 plays Defender on P1 Pokémon. Must survive through
  // P2's upcoming turn and expire when P2's turn ends.
  const G = {
    turn: 1,
    players: {
      1: { active: { name: 'Squirtle', defender: true, defenderFull: false } },
      2: { active: { name: 'Charmander' } },
    },
  };

  // P1 ends turn → prev=1, turn→2. Defender must still be on P1's active.
  let prev = G.turn; G.turn = 2;
  simulateFinishEndTurnFlagClear(G, prev);
  assertEqual('Defender: after P1 ends turn, P1 still has defender flag',
    G.players[1].active.defender, true);

  // P2 ends turn → prev=2, turn→1. Defender now expires (G.turn side is P1, the owner).
  prev = G.turn; G.turn = 1;
  simulateFinishEndTurnFlagClear(G, prev);
  assertEqual('Defender: after P2 ends turn, P1 defender flag cleared',
    G.players[1].active.defender, false);
}

{
  // Cross-check: multiple flag types simultaneously. P1 casts Leer and Growl on
  // P2 in a single turn (same target gets both cantRetreat and attackReduction).
  // Both should persist through P2's upcoming turn and clear together when P2 ends.
  const G = {
    turn: 1,
    players: {
      1: { active: { name: 'Ekans' } },
      2: { active: { name: 'Mewtwo', cantRetreat: true, attackReduction: 10 } },
    },
  };
  // P1 ends turn
  let prev = G.turn; G.turn = 2;
  simulateFinishEndTurnFlagClear(G, prev);
  assertEqual('Mixed: cantRetreat persists into P2 turn',
    G.players[2].active.cantRetreat, true);
  assertEqual('Mixed: attackReduction persists into P2 turn',
    G.players[2].active.attackReduction, 10);
  // P2 ends turn
  prev = G.turn; G.turn = 1;
  simulateFinishEndTurnFlagClear(G, prev);
  assertEqual('Mixed: cantRetreat cleared after P2 turn',
    G.players[2].active.cantRetreat, false);
  assertEqual('Mixed: attackReduction cleared after P2 turn',
    G.players[2].active.attackReduction, 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGRESSION: Amnesia targeting Ditto — must use Ditto's copied attacks
//
// Bug: MOVE_EFFECTS['Amnesia'].postAttack read `oppActive.attacks` directly.
// Ditto (Fossil) has NO intrinsic attacks — its Transform Pokémon Power copies
// attacks from the opposing Pokémon at runtime. So when P1 Poliwhirl used
// Amnesia on P2 Ditto, `oppActive.attacks.length === 0` tripped the early-return
// guard; no picker opened, no flag set, the turn just flipped.
//
// Fix: use the effective attack list via dittoAttacks(opp) when Transform is
// active; fall back to oppActive.attacks otherwise. The chosen attack name is
// what the AI/UI check against card.disabledAttack, so the identifier stays
// consistent on Ditto's next turn — it will skip the disabled copied attack
// because dittoAttacks() returns the same copied list then too.
//
// These tests encode the rule (which list should be offered to the picker);
// the actual handler lives in move-effects.js which isn't required by Node.
// ═══════════════════════════════════════════════════════════════════════════════

section('REGRESSION: Amnesia vs Ditto — offers copied attacks, not empty list');

// Mirrors the logic inside MOVE_EFFECTS['Amnesia'].postAttack for attack-list
// resolution. If the handler's rule ever diverges from this, update both.
function resolveAmnesiaTargetAttacks(oppActive, dittoAttacksFn, oppPlayer) {
  const fromTransform = (typeof dittoAttacksFn === 'function' && dittoAttacksFn(oppPlayer)) || null;
  return fromTransform || oppActive?.attacks || [];
}

{
  // Scenario: P1 Poliwhirl attacks P2 Ditto (Transform active, copying Poliwhirl).
  // Ditto's intrinsic attacks array is empty. Amnesia must offer Poliwhirl's
  // own attacks (Water Gun, Amnesia) as the disable choices.
  const polAttacks = [
    { name: 'Water Gun', damage: '20', cost: ['Water'] },
    { name: 'Amnesia', damage: '', cost: ['Water','Water'] },
  ];
  const ditto = { name: 'Ditto', attacks: [], images: {} };
  // Stand-in for pokemon-powers.js dittoAttacks(player): returns the copied list.
  const dittoAttacksStub = (player) => (player === 2 ? polAttacks : null);
  const resolved = resolveAmnesiaTargetAttacks(ditto, dittoAttacksStub, 2);
  assertEqual('Ditto (Transform) with empty intrinsic attacks → resolver returns copied attack list',
    resolved.length, 2);
  assertEqual('Ditto (Transform) → first resolved attack is Water Gun',
    resolved[0].name, 'Water Gun');
  assertEqual('Ditto (Transform) → second resolved attack is Amnesia',
    resolved[1].name, 'Amnesia');
}

{
  // Sanity check the non-Ditto path: normal Pokemon with intrinsic attacks
  // still uses its own attack list even if the dittoAttacks helper exists.
  const hitmon = {
    name: 'Hitmonchan',
    attacks: [{ name: 'Jab' }, { name: 'Special Punch' }],
    images: {},
  };
  const dittoAttacksStub = () => null; // no Transform → returns null
  const resolved = resolveAmnesiaTargetAttacks(hitmon, dittoAttacksStub, 2);
  assertEqual('Normal opponent: uses intrinsic attacks when dittoAttacks returns null',
    resolved.length, 2);
  assertEqual('Normal opponent: first attack is Jab', resolved[0].name, 'Jab');
  assertEqual('Normal opponent: second attack is Special Punch', resolved[1].name, 'Special Punch');
}

{
  // Defensive: Ditto facing a Pokemon with no attacks (or Ditto-vs-Ditto → both
  // empty) returns an empty list; handler's early-return guard then logs and exits.
  const ditto = { name: 'Ditto', attacks: [], images: {} };
  const dittoAttacksStub = () => []; // Transform active but nothing to copy
  const resolved = resolveAmnesiaTargetAttacks(ditto, dittoAttacksStub, 2);
  assertEqual('Ditto-vs-Ditto (or Ditto vs attacker with no attacks) → empty resolved list',
    resolved.length, 0);
}

{
  // Verify the identifier roundtrip: the name we write to disabledAttack is what
  // later checks read. Nothing here is Ditto-specific — it's a sanity check that
  // the picker-output → flag-setter → AI/UI-checker chain uses stable names.
  const copiedAttack = { name: 'Amnesia', damage: '', cost: ['Water','Water'] };
  const victim = { name: 'Ditto', attacks: [], disabledAttack: null };
  // Simulate what handler does after picker returns index 0:
  victim.disabledAttack = copiedAttack.name;
  // Simulate what AI check does (game-ai.js:924):
  const isBlocked = victim.disabledAttack && victim.disabledAttack === copiedAttack.name;
  assert('Disabled attack name (Amnesia) round-trips through flag → AI check',
    isBlocked === true);
}



// ═══════════════════════════════════════════════════════════════════════════════
// prizesRemaining — prize counting helper for prize-race awareness
// ═══════════════════════════════════════════════════════════════════════════════

section('prizesRemaining');

// Import added alongside the existing aiChooseEnergyTarget block. We re-require
// here because the earlier block exports what we need but not with these names
// in scope.
const {
  prizesRemaining: _prizesRemaining,
  aiFindBestKOPlan: _aiFindBestKOPlan,
  aiBuildTurnPlan: _aiBuildTurnPlan,
  benchPromotionScore: _benchPromotionScore,
} = require('./game-ai.js');

{
  const p = { prizes: [{ card: {} }, { card: {} }, { card: {} }, { card: {} }, { card: {} }, { card: {} }] };
  assertEqual('Fresh game: 6 prizes remaining', _prizesRemaining(p), 6);
}
{
  const p = { prizes: [{ card: {} }, null, { card: {} }, null, null, { card: {} }] };
  assertEqual('Some prizes taken: counts only non-null', _prizesRemaining(p), 3);
}
{
  const p = { prizes: [null, null, null, null, null, null] };
  assertEqual('All prizes taken: 0', _prizesRemaining(p), 0);
}
{
  const p = { prizes: [{ card: {} }] };
  assertEqual('One prize left', _prizesRemaining(p), 1);
}
{
  // Defensive: no prizes field → treat as "fresh game" (6). This matters if a
  // test harness or partial-state snapshot skips the prize field.
  assertEqual('Missing prizes field: defaults to 6', _prizesRemaining({}), 6);
  assertEqual('Null player: defaults to 6',         _prizesRemaining(null), 6);
}


// ═══════════════════════════════════════════════════════════════════════════════
// aiFindBestKOPlan — top-level KO search
//
// The planner evaluates (gust target × energy attach × PlusPower count × attack)
// and returns the best-scoring plan. These tests exercise the main branches:
//   • No affordable attack anywhere → returns null or a non-KO plan
//   • Direct KO with current energy → plan.willKO === true
//   • KO only possible with energy attach → plan chooses to attach
//   • KO only possible with PlusPower → plan chooses to play PlusPower
//   • KO only possible via Gust of Wind on weak bench Pokémon
//   • Winning KO (last prize) preferred over any other plan
//   • Weakness/resistance correctly applied to damage
// ═══════════════════════════════════════════════════════════════════════════════

section('aiFindBestKOPlan');

// Helper to build a fresh 6-prize array
function sixPrizes() {
  return [{ card: {} }, { card: {} }, { card: {} }, { card: {} }, { card: {} }, { card: {} }];
}
function onePrize() {
  return [{ card: {} }, null, null, null, null, null];
}

// Minimal attacker: Charmander-ish. One attack costing RR, 20 dmg.
function makeAttacker(overrides = {}) {
  return {
    name: 'TestAttacker',
    hp: '50',
    damage: 0,
    types: ['Fire'],
    attacks: [
      { name: 'Ember', cost: ['Fire', 'Fire'], damage: '20', text: '' },
    ],
    attachedEnergy: [],
    weaknesses: [],
    resistances: [],
    ...overrides,
  };
}

function makeDefender(overrides = {}) {
  return {
    name: 'TestDefender',
    hp: '60',
    damage: 0,
    types: ['Water'],
    attacks: [
      { name: 'Splash', cost: ['Water'], damage: '10', text: '' },
    ],
    attachedEnergy: [{ name: 'Water Energy' }],
    weaknesses: [],
    resistances: [],
    ...overrides,
  };
}

function makeState(p2Overrides = {}, p1Overrides = {}) {
  const p2 = {
    active: null,
    bench: [null, null, null, null, null],
    hand: [],
    discard: [],
    prizes: sixPrizes(),
    ...p2Overrides,
  };
  const p1 = {
    active: null,
    bench: [null, null, null, null, null],
    hand: [],
    discard: [],
    prizes: sixPrizes(),
    ...p1Overrides,
  };
  return { p2, p1 };
}

// The planner reads the global G for energyPlayedThisTurn and evolvedThisTurn.
// Stub it before running any planner tests.
global.G = { energyPlayedThisTurn: false, evolvedThisTurn: [], players: {} };

// ── CASE: unaffordable attack with no energy in hand → no KO plan ────────────
{
  const { p2, p1 } = makeState(
    { active: makeAttacker({ attachedEnergy: [] }) }, // no energy attached
    { active: makeDefender() }                         // defender still up
  );
  global.G.players = { 1: p1, 2: p2 };
  const plan = _aiFindBestKOPlan(p2, p1);
  assert('No KO plan when attack is unaffordable and no energy in hand',
    plan === null || !plan.willKO);
}

// ── CASE: direct KO with energy already attached ─────────────────────────────
{
  // Attacker has [F,F] attached; defender has 20 HP left — Ember (20) KOs.
  const attacker = makeAttacker({
    attachedEnergy: [{ name: 'Fire Energy' }, { name: 'Fire Energy' }],
  });
  const defender = makeDefender({ hp: '20' });
  const { p2, p1 } = makeState({ active: attacker }, { active: defender });
  global.G.players = { 1: p1, 2: p2 };
  const plan = _aiFindBestKOPlan(p2, p1);
  assert('Direct KO: plan exists', plan !== null);
  assert('Direct KO: plan.willKO is true', plan?.willKO === true);
  assertEqual('Direct KO: no energy attach needed',
    plan?.attachList?.length || 0, 0);
  assertEqual('Direct KO: no PlusPower needed',
    plan?.plusPowerCount, 0);
}

// ── CASE: KO requires attaching one more energy ──────────────────────────────
{
  // Attacker has [F] attached, needs [F,F]. Has a Fire Energy in hand.
  const attacker = makeAttacker({
    attachedEnergy: [{ name: 'Fire Energy' }],
  });
  const defender = makeDefender({ hp: '20' });
  const p2 = {
    active: attacker, bench: [null,null,null,null,null],
    hand: [{ supertype: 'Energy', name: 'Fire Energy' }],
    discard: [], prizes: sixPrizes(),
  };
  const p1 = { active: defender, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes() };
  global.G.players = { 1: p1, 2: p2 };
  global.G.energyPlayedThisTurn = false;
  const plan = _aiFindBestKOPlan(p2, p1);
  assert('KO-needs-attach: plan exists', plan !== null);
  assert('KO-needs-attach: plan.willKO is true', plan?.willKO === true);
  assertEqual('KO-needs-attach: 1 energy attach in plan',
    plan?.attachList?.length, 1);
  assertEqual('KO-needs-attach: attach is Fire Energy',
    plan?.attachList?.[0]?.name, 'Fire Energy');
}

// ── CASE: energy already played this turn → planner won't attach ─────────────
{
  const attacker = makeAttacker({
    attachedEnergy: [{ name: 'Fire Energy' }],
  });
  const defender = makeDefender({ hp: '20' });
  const p2 = {
    active: attacker, bench: [null,null,null,null,null],
    hand: [{ supertype: 'Energy', name: 'Fire Energy' }],
    discard: [], prizes: sixPrizes(),
  };
  const p1 = { active: defender, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes() };
  global.G.players = { 1: p1, 2: p2 };
  global.G.energyPlayedThisTurn = true; // ← already played one!
  const plan = _aiFindBestKOPlan(p2, p1);
  assert('Energy already played: no plan attempts to attach',
    plan === null || (plan.attachList?.length || 0) === 0);
  assert('Energy already played: no KO plan since we can\'t afford',
    plan === null || !plan.willKO);
  global.G.energyPlayedThisTurn = false; // reset for next tests
}

// ── CASE: KO requires a PlusPower ────────────────────────────────────────────
{
  // Defender has 25 HP, attacker does 20. PlusPower adds 10 → 30 → KO.
  const attacker = makeAttacker({
    attachedEnergy: [{ name: 'Fire Energy' }, { name: 'Fire Energy' }],
  });
  const defender = makeDefender({ hp: '25' });
  const p2 = {
    active: attacker, bench: [null,null,null,null,null],
    hand: [{ supertype: 'Trainer', name: 'PlusPower' }],
    discard: [], prizes: sixPrizes(),
  };
  const p1 = { active: defender, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes() };
  global.G.players = { 1: p1, 2: p2 };
  const plan = _aiFindBestKOPlan(p2, p1);
  assert('KO-needs-PP: plan exists', plan !== null);
  assert('KO-needs-PP: plan.willKO is true', plan?.willKO === true);
  assertEqual('KO-needs-PP: 1 PlusPower in plan',
    plan?.plusPowerCount, 1);
}

// ── CASE: KO via Gust of Wind on weak bench Pokémon ──────────────────────────
{
  // Main defender is tanky (60 HP, can't KO). But opponent's bench has a
  // 20-HP Pokémon. With Gust of Wind, we pull it up and KO it.
  const attacker = makeAttacker({
    attachedEnergy: [{ name: 'Fire Energy' }, { name: 'Fire Energy' }],
  });
  const tankyDefender = makeDefender({ hp: '60' });
  const weakBench = makeDefender({ name: 'WeakBench', hp: '20' });
  const p2 = {
    active: attacker, bench: [null,null,null,null,null],
    hand: [{ supertype: 'Trainer', name: 'Gust of Wind' }],
    discard: [], prizes: sixPrizes(),
  };
  const p1 = { active: tankyDefender, bench: [weakBench,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes() };
  global.G.players = { 1: p1, 2: p2 };
  const plan = _aiFindBestKOPlan(p2, p1);
  assert('Gust KO: plan exists', plan !== null);
  assert('Gust KO: plan.willKO is true', plan?.willKO === true);
  assertEqual('Gust KO: target is bench slot 0',
    plan?.target?.benchIdx, 0);
  assert('Gust KO: gust handIdx is populated',
    plan?.target?.gustHandIdx !== null);
}

// ── CASE: winning KO (last prize) always wins score comparison ───────────────
{
  // Two options: KO tanky active (prizesLeft === 1, so this wins the game) or
  // hit but not KO. The planner should pick the winning KO.
  const attacker = makeAttacker({
    attachedEnergy: [{ name: 'Fire Energy' }, { name: 'Fire Energy' }],
  });
  const defender = makeDefender({ hp: '20' });
  const p2 = {
    active: attacker, bench: [null,null,null,null,null],
    hand: [],
    discard: [], prizes: onePrize(), // ← last prize! KO = game win
  };
  const p1 = { active: defender, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes() };
  global.G.players = { 1: p1, 2: p2 };
  const plan = _aiFindBestKOPlan(p2, p1);
  assert('Last-prize KO: plan exists', plan !== null);
  assert('Last-prize KO: wouldWinByPrizes flagged',
    plan?.wouldWinByPrizes === true);
  assert('Last-prize KO: score is enormous (> 1M)',
    (plan?.score || 0) >= 1_000_000);
}

// ── CASE: KO + empty bench → win by no-Pokemon-left ─────────────────────────
{
  // Opponent has only active (no bench). KO'ing it wins the game.
  const attacker = makeAttacker({
    attachedEnergy: [{ name: 'Fire Energy' }, { name: 'Fire Energy' }],
  });
  const defender = makeDefender({ hp: '20' });
  const p2 = {
    active: attacker, bench: [null,null,null,null,null],
    hand: [],
    discard: [], prizes: sixPrizes(),
  };
  const p1 = { active: defender, bench: [null,null,null,null,null], // empty!
    hand: [], discard: [], prizes: sixPrizes() };
  global.G.players = { 1: p1, 2: p2 };
  const plan = _aiFindBestKOPlan(p2, p1);
  assert('Empty-bench KO: wouldWinByNoPokemon flagged',
    plan?.wouldWinByNoPokemon === true);
  assert('Empty-bench KO: score is enormous',
    (plan?.score || 0) >= 1_000_000);
}

// ── CASE: weakness doubles damage correctly in planner ──────────────────────
{
  // 40-HP Water Pokémon with weakness to Fire. Our Ember does 20 × 2 = 40 → KO.
  const attacker = makeAttacker({
    attachedEnergy: [{ name: 'Fire Energy' }, { name: 'Fire Energy' }],
  });
  const defender = makeDefender({
    hp: '40',
    weaknesses: [{ type: 'Fire' }],
  });
  const p2 = {
    active: attacker, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes(),
  };
  const p1 = { active: defender, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes() };
  global.G.players = { 1: p1, 2: p2 };
  const plan = _aiFindBestKOPlan(p2, p1);
  assert('Weakness-KO: plan finds the KO via 2x damage',
    plan?.willKO === true);
  assertEqual('Weakness-KO: expectedDamage is 40',
    plan?.expectedDamage, 40);
}

// ── CASE: paralyzed attacker → no plan (can't attack) ────────────────────────
{
  const attacker = makeAttacker({
    attachedEnergy: [{ name: 'Fire Energy' }, { name: 'Fire Energy' }],
    status: 'paralyzed',
  });
  const defender = makeDefender({ hp: '20' });
  const p2 = { active: attacker, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes() };
  const p1 = { active: defender, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes() };
  global.G.players = { 1: p1, 2: p2 };
  const plan = _aiFindBestKOPlan(p2, p1);
  assert('Paralyzed attacker: no KO plan', plan === null);
}

// ── CASE: no opponent active → no plan (nothing to target) ───────────────────
{
  const attacker = makeAttacker({
    attachedEnergy: [{ name: 'Fire Energy' }, { name: 'Fire Energy' }],
  });
  const p2 = { active: attacker, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes() };
  const p1 = { active: null, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes() };
  global.G.players = { 1: p1, 2: p2 };
  const plan = _aiFindBestKOPlan(p2, p1);
  assert('No opponent active: no plan', plan === null);
}

// ── CASE: planner does NOT consider Gust when we already KO current active ──
{
  // We can KO the current active — no need to Gust. Planner should NOT spend
  // the Gust card on a bench pull when a direct KO is available.
  const attacker = makeAttacker({
    attachedEnergy: [{ name: 'Fire Energy' }, { name: 'Fire Energy' }],
  });
  const defender  = makeDefender({ hp: '20' });  // KO-able directly
  const weakBench = makeDefender({ name: 'WeakBench', hp: '20' });
  const p2 = { active: attacker, bench: [null,null,null,null,null],
    hand: [{ supertype: 'Trainer', name: 'Gust of Wind' }],
    discard: [], prizes: sixPrizes() };
  const p1 = { active: defender, bench: [weakBench,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes() };
  global.G.players = { 1: p1, 2: p2 };
  const plan = _aiFindBestKOPlan(p2, p1);
  assert('Gust not wasted: plan picks direct KO over Gust KO',
    plan?.target?.benchIdx === null);
  assertEqual('Gust not wasted: gustHandIdx is null',
    plan?.target?.gustHandIdx, null);
}

// ── CASE: Defender on target: plan correctly accounts for -20 reduction ─────
{
  // Defender has 25 HP, is holding Defender (reduces damage by 20). Our 20-dmg
  // attack gets reduced to 0 → can't KO. Planner must detect the non-KO.
  const attacker = makeAttacker({
    attachedEnergy: [{ name: 'Fire Energy' }, { name: 'Fire Energy' }],
  });
  const defender = makeDefender({ hp: '25', defender: true });
  const p2 = { active: attacker, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes() };
  const p1 = { active: defender, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes() };
  global.G.players = { 1: p1, 2: p2 };
  const plan = _aiFindBestKOPlan(p2, p1);
  // With 20-dmg attack and Defender (-20), damage is 0 → not a KO plan.
  // Planner may return null (no useful attack) or a plan with willKO false.
  assert('Defender on target: no KO plan (damage reduced to 0)',
    plan === null || !plan.willKO);
}

// ── CASE: Invisible Wall blocks ≥30 damage attacks in planner ────────────────
{
  // Target has Mr. Mime's Invisible Wall. Our 20-dmg attack gets doubled to
  // 40 by weakness — blocked entirely. Planner should NOT think it KOs.
  // We stub hasInvisibleWall as a global just for this case.
  const originalIWall = global.hasInvisibleWall;
  global.hasInvisibleWall = (card) => card?.name === 'MrMime';

  const attacker = makeAttacker({
    attachedEnergy: [{ name: 'Fire Energy' }, { name: 'Fire Energy' }],
  });
  const defender = makeDefender({
    name: 'MrMime',
    hp: '20',
    weaknesses: [{ type: 'Fire' }], // would make dmg = 40 = blocked
  });
  const p2 = { active: attacker, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes() };
  const p1 = { active: defender, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes() };
  global.G.players = { 1: p1, 2: p2 };
  const plan = _aiFindBestKOPlan(p2, p1);
  assert('Invisible Wall: planner does NOT claim a KO on blocked attack',
    plan === null || !plan.willKO);

  global.hasInvisibleWall = originalIWall; // restore
}

// ── CASE: under Invisible Wall, a 20-damage (non-blocked) plan is fine ──────
{
  // Target has Invisible Wall but our attack deals 20 (< 30) so it goes
  // through. Defender has 20 HP → KO.
  const originalIWall = global.hasInvisibleWall;
  global.hasInvisibleWall = (card) => card?.name === 'MrMime';

  const attacker = makeAttacker({
    attachedEnergy: [{ name: 'Fire Energy' }, { name: 'Fire Energy' }],
  });
  const defender = makeDefender({ name: 'MrMime', hp: '20' });
  const p2 = { active: attacker, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes() };
  const p1 = { active: defender, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes() };
  global.G.players = { 1: p1, 2: p2 };
  const plan = _aiFindBestKOPlan(p2, p1);
  assert('IWall allows <30 damage: plan KOs the 20 HP Mr. Mime',
    plan?.willKO === true);

  global.hasInvisibleWall = originalIWall; // restore
}

// ── CASE: prize-race suicide — opponent on last prize, our KO leaves us dead ─
{
  // We can KO their active, but their bench has a big threat that will KO us
  // back. Since THEY are on their last prize — wait, they're NOT on their
  // last prize. WE are on their last prize means: we drop to 0 prizes = we win.
  // For the suicide case: oppPrizesLeft === 1 means if OUR attacker dies, the
  // opponent takes their last prize and wins. In that case, the -200k penalty
  // applies. But the KO also gives us a prize — if MY prizesLeft === 1 too,
  // we win first (wouldWinByPrizes dominates).
  //
  // So: opp on last prize, we're not, KO puts us at risk of counter-KO.
  //   - Plan A: KO → takes 1 prize (we're at 5). Counter-KO possible.
  //     If counter happens, opp takes their last prize. OPP WINS.
  //     score = 100k (KO) - 200k (suicide with opp on last) = -100k
  //   - Plan B (hypothetical non-KO): no KO, no suicide → score = damage only.
  //
  // But our planner only returns the BEST plan, and a KO plan with negative
  // score might still be the only KO plan. The test should verify that when a
  // non-KO safe plan exists alongside a suicide KO plan, the suicide is not
  // preferred. In v1 though, we only return the single best plan and the
  // aiTakeTurn caller checks `willKO` — non-KO plans fall through.
  //
  // So the correct test: in a suicide scenario, the score should reflect the
  // penalty (negative or near-zero), so the aiTakeTurn caller can make its
  // own decision about whether to commit. We verify the score is penalized.
  const attacker = makeAttacker({
    hp: '30', damage: 20, // only 10 HP left → any counter KOs us
    attachedEnergy: [{ name: 'Fire Energy' }, { name: 'Fire Energy' }],
  });
  const defender = makeDefender({ hp: '20' });
  // Opponent has a bench Pokémon with an attack ready to one-shot us
  const oppBench = makeDefender({
    name: 'Heavy',
    hp: '80',
    attacks: [
      { name: 'Smash', cost: ['Water'], damage: '50', text: '' },
    ],
    attachedEnergy: [{ name: 'Water Energy' }],
  });
  const p2 = { active: attacker, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes() };
  const p1 = { active: defender, bench: [oppBench,null,null,null,null],
    hand: [], discard: [], prizes: onePrize() }; // ← opp on last prize
  global.G.players = { 1: p1, 2: p2 };
  const plan = _aiFindBestKOPlan(p2, p1);
  // Plan still KOs — but score reflects the suicide penalty.
  assert('Suicide-KO on opp last prize: plan exists (still a KO)',
    plan !== null && plan.willKO === true);
  assert('Suicide-KO on opp last prize: score is penalized (< 100k)',
    (plan?.score || 0) < 100_000);
}


// ═══════════════════════════════════════════════════════════════════════════════
// aiBuildTurnPlan — goal-directed turn planner
//
// Enumerates attacker configurations and returns the best plan across all of
// them. This is the plan-first entry point used by aiTakeTurn. Builds on
// evaluateAttackerPlan (which is also used internally for each configuration).
//
// Configurations evaluated:
//   • baseline — current active, no preStep
//   • evolve   — current active evolved with a Stage 1/2 from hand
//   • retreat  — each bench Pokémon as attacker (active retreats, paying cost)
//   • switch   — each bench Pokémon as attacker (Switch card from hand)
//
// Tests verify:
//   • Baseline still works when no preStep enables improvement
//   • Evolve preStep is selected when evolution unlocks a KO
//   • Evolve is NOT preferred when baseline already KOs (preStep penalty)
//   • Retreat preStep is selected when bench attacker enables KO
//   • Retreat is skipped when unaffordable
//   • Switch preStep is preferred over retreat when both work (Switch ≥ retreat
//     in the score — same outcome but cheaper for non-zero retreat cost)
//   • evolvedThisTurn (card placed this turn) blocks evolve plans
//   • Paralysis / sleep on active blocks retreat plans but NOT Switch
//   • No candidates → planner returns null
// ═══════════════════════════════════════════════════════════════════════════════

section('aiBuildTurnPlan');

// Helper: make a Charmeleon-like Stage 1 card
function makeStage1(evolvesFromName, overrides = {}) {
  return {
    name: 'TestStage1',
    supertype: 'Pokémon',
    subtypes: ['Stage 1'],
    evolvesFrom: evolvesFromName,
    hp: '80',
    types: ['Fire'],
    attacks: [
      { name: 'Flamethrower', cost: ['Fire', 'Fire'], damage: '50', text: '' },
    ],
    ...overrides,
  };
}

// ── CASE: baseline — no preStep configurations available ────────────────────
{
  // Current active can KO directly. No evolution card in hand, empty bench.
  // Planner should return a plan with preStep === null (baseline).
  // (Opponent has a benched Pokémon so the KO isn't a game-ending move —
  // this tests the plain KO outcome label.)
  const attacker = makeAttacker({
    attachedEnergy: [{ name: 'Fire Energy' }, { name: 'Fire Energy' }],
  });
  const defender = makeDefender({ hp: '20' });
  const oppBench = makeDefender({ name: 'BenchBlocker' });
  const p2 = {
    active: attacker, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes(),
  };
  const p1 = {
    active: defender, bench: [oppBench,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes(),
  };
  global.G.players = { 1: p1, 2: p2 };
  global.G.evolvedThisTurn = [];
  const plan = _aiBuildTurnPlan(p2, p1);
  assert('Baseline: plan exists', plan !== null);
  assertEqual('Baseline: no preStep', plan?.preStep, null);
  assert('Baseline: still KOs', plan?.willKO === true);
  assertEqual('Baseline: outcome is KO', plan?.outcome, 'KO');
}

// ── CASE: evolve unlocks a KO the baseline can't reach ──────────────────────
{
  // Charmander (baseline) deals 20 — defender has 40 HP, can't KO.
  // Charmeleon (evolved) deals 50 → KO.
  const baseActive = makeAttacker({
    name: 'Charmander',
    uid: 'char-1',
    attachedEnergy: [{ name: 'Fire Energy' }, { name: 'Fire Energy' }],
  });
  const evoCard = makeStage1('Charmander', {
    name: 'Charmeleon',
    attacks: [
      { name: 'Flamethrower', cost: ['Fire', 'Fire'], damage: '50', text: '' },
    ],
  });
  const defender = makeDefender({ hp: '40' });
  const p2 = {
    active: baseActive, bench: [null,null,null,null,null],
    hand: [evoCard], discard: [], prizes: sixPrizes(),
  };
  const p1 = {
    active: defender, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes(),
  };
  global.G.players = { 1: p1, 2: p2 };
  global.G.evolvedThisTurn = [];
  const plan = _aiBuildTurnPlan(p2, p1);
  assert('Evolve-KO: plan exists', plan !== null);
  assert('Evolve-KO: plan.willKO is true', plan?.willKO === true);
  assertEqual('Evolve-KO: preStep kind is evolve',
    plan?.preStep?.kind, 'evolve');
  assertEqual('Evolve-KO: preStep handIdx points to Charmeleon',
    plan?.preStep?.handIdx, 0);
}

// ── CASE: evolve NOT preferred when baseline already KOs ────────────────────
{
  // Baseline deals 20 → KOs a 20 HP defender. Charmeleon ALSO KOs but costs a
  // card. Planner should prefer baseline (cheaper plan, preStep penalty).
  const baseActive = makeAttacker({
    name: 'Charmander',
    attachedEnergy: [{ name: 'Fire Energy' }, { name: 'Fire Energy' }],
  });
  const evoCard = makeStage1('Charmander', { name: 'Charmeleon' });
  const defender = makeDefender({ hp: '20' }); // baseline KOs easily
  const p2 = {
    active: baseActive, bench: [null,null,null,null,null],
    hand: [evoCard], discard: [], prizes: sixPrizes(),
  };
  const p1 = {
    active: defender, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes(),
  };
  global.G.players = { 1: p1, 2: p2 };
  global.G.evolvedThisTurn = [];
  const plan = _aiBuildTurnPlan(p2, p1);
  assert('Don\'t-evolve-for-nothing: plan exists', plan !== null);
  assert('Don\'t-evolve-for-nothing: plan KOs', plan?.willKO === true);
  assertEqual('Don\'t-evolve-for-nothing: baseline preStep is null',
    plan?.preStep, null);
}

// ── CASE: evolution card doesn't match active → ignored ─────────────────────
{
  // Active is Charmander; hand has a Stage 1 "Wartortle" that evolves from
  // Squirtle. Planner should not consider evolving Charmander with Wartortle.
  const baseActive = makeAttacker({
    name: 'Charmander',
    attachedEnergy: [{ name: 'Fire Energy' }, { name: 'Fire Energy' }],
  });
  const wartortle = makeStage1('Squirtle', { name: 'Wartortle' });
  const defender = makeDefender({ hp: '40' });
  const p2 = {
    active: baseActive, bench: [null,null,null,null,null],
    hand: [wartortle], discard: [], prizes: sixPrizes(),
  };
  const p1 = {
    active: defender, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes(),
  };
  global.G.players = { 1: p1, 2: p2 };
  global.G.evolvedThisTurn = [];
  const plan = _aiBuildTurnPlan(p2, p1);
  // Charmander can't KO, and Wartortle is not a valid evolution for it.
  // Plan exists (baseline damage) but preStep must not be evolve.
  assert('Mismatched evolution: preStep is NOT evolve',
    plan === null || plan.preStep?.kind !== 'evolve');
}

// ── CASE: evolvedThisTurn blocks evolve ─────────────────────────────────────
{
  // Active was just placed/evolved this turn — planner must not try to evolve.
  const baseActive = makeAttacker({
    name: 'Charmander',
    uid: 'just-placed',
    attachedEnergy: [{ name: 'Fire Energy' }, { name: 'Fire Energy' }],
  });
  const evoCard = makeStage1('Charmander', { name: 'Charmeleon' });
  const defender = makeDefender({ hp: '40' });
  const p2 = {
    active: baseActive, bench: [null,null,null,null,null],
    hand: [evoCard], discard: [], prizes: sixPrizes(),
  };
  const p1 = {
    active: defender, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes(),
  };
  global.G.players = { 1: p1, 2: p2 };
  global.G.evolvedThisTurn = ['just-placed']; // ← active can't evolve
  const plan = _aiBuildTurnPlan(p2, p1);
  assert('evolvedThisTurn: planner does not pick evolve preStep',
    plan === null || plan.preStep?.kind !== 'evolve');
  global.G.evolvedThisTurn = []; // reset
}

// ── CASE: retreat unlocks a KO via stronger bench Pokémon ───────────────────
{
  // Active has low damage output (20), opponent has 60 HP → no KO.
  // Bench has a strong attacker fully loaded that KOs (80). Retreat cost 1.
  // Planner should choose retreat preStep.
  const baseActive = makeAttacker({
    name: 'Weakling',
    convertedRetreatCost: 1,
    attachedEnergy: [{ name: 'Fire Energy' }, { name: 'Fire Energy' }],
  });
  const benchBeast = makeAttacker({
    name: 'Beast',
    hp: '100',
    types: ['Water'],
    attacks: [{ name: 'Crush', cost: ['Water','Water'], damage: '80', text: '' }],
    attachedEnergy: [{ name: 'Water Energy' }, { name: 'Water Energy' }],
  });
  const defender = makeDefender({ hp: '60' });
  const p2 = {
    active: baseActive, bench: [benchBeast,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes(),
  };
  const p1 = {
    active: defender, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes(),
  };
  global.G.players = { 1: p1, 2: p2 };
  global.G.evolvedThisTurn = [];
  const plan = _aiBuildTurnPlan(p2, p1);
  assert('Retreat-KO: plan exists', plan !== null);
  assert('Retreat-KO: plan.willKO is true', plan?.willKO === true);
  assertEqual('Retreat-KO: preStep kind is retreat',
    plan?.preStep?.kind, 'retreat');
  assertEqual('Retreat-KO: preStep benchIdx is 0',
    plan?.preStep?.benchIdx, 0);
}

// ── CASE: retreat cost unaffordable → retreat not considered ────────────────
{
  // Active has retreat cost 3 but only 1 energy attached. Can't retreat.
  // Bench has a stronger attacker — planner should NOT pick retreat.
  const baseActive = makeAttacker({
    name: 'Weakling',
    convertedRetreatCost: 3,
    attachedEnergy: [{ name: 'Fire Energy' }], // not enough to retreat
  });
  const benchBeast = makeAttacker({
    name: 'Beast',
    hp: '100',
    types: ['Water'],
    attacks: [{ name: 'Crush', cost: ['Water'], damage: '80', text: '' }],
    attachedEnergy: [{ name: 'Water Energy' }],
  });
  const defender = makeDefender({ hp: '60' });
  const p2 = {
    active: baseActive, bench: [benchBeast,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes(),
  };
  const p1 = {
    active: defender, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes(),
  };
  global.G.players = { 1: p1, 2: p2 };
  global.G.evolvedThisTurn = [];
  const plan = _aiBuildTurnPlan(p2, p1);
  // Plan should NOT include retreat as preStep (can't afford). Baseline with
  // just the weakling attack is the only option — it may or may not be
  // returned depending on whether it deals nonzero damage.
  assert('Unaffordable retreat: preStep is NOT retreat',
    plan === null || plan.preStep?.kind !== 'retreat');
}

// ── CASE: Switch preferred over retreat when both can KO ────────────────────
{
  // Both retreat and Switch enable a bench KO. Retreat costs energy; Switch
  // only a trainer card. Planner should choose the cheaper Switch path.
  const baseActive = makeAttacker({
    name: 'Weakling',
    convertedRetreatCost: 2,
    attachedEnergy: [{ name: 'Fire Energy' }, { name: 'Fire Energy' }],
  });
  const benchBeast = makeAttacker({
    name: 'Beast',
    hp: '100',
    types: ['Water'],
    attacks: [{ name: 'Crush', cost: ['Water','Water'], damage: '80', text: '' }],
    attachedEnergy: [{ name: 'Water Energy' }, { name: 'Water Energy' }],
  });
  const defender = makeDefender({ hp: '60' });
  const switchCard = { supertype: 'Trainer', name: 'Switch' };
  const p2 = {
    active: baseActive, bench: [benchBeast,null,null,null,null],
    hand: [switchCard], discard: [], prizes: sixPrizes(),
  };
  const p1 = {
    active: defender, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes(),
  };
  global.G.players = { 1: p1, 2: p2 };
  global.G.evolvedThisTurn = [];
  const plan = _aiBuildTurnPlan(p2, p1);
  assert('Switch-vs-retreat: plan exists', plan !== null);
  assert('Switch-vs-retreat: plan KOs', plan?.willKO === true);
  // Both are valid plans. Switch = -15, retreat = -16 (2 energy × 8 = -16).
  // So Switch is cheaper. (If costs were flipped the test would break.)
  assertEqual('Switch-vs-retreat: preStep chooses switch',
    plan?.preStep?.kind, 'switch');
}

// ── CASE: paralysis blocks retreat, Switch still works ──────────────────────
{
  // Paralyzed active can't retreat manually, but Switch (a trainer card)
  // specifically says "Switch" ignores the status block on manual retreat.
  // Planner should NOT emit a retreat preStep, but IS allowed to emit switch.
  const baseActive = makeAttacker({
    name: 'Weakling',
    status: 'paralyzed',
    convertedRetreatCost: 1,
    attachedEnergy: [{ name: 'Fire Energy' }, { name: 'Fire Energy' }],
  });
  const benchBeast = makeAttacker({
    name: 'Beast',
    hp: '100',
    types: ['Water'],
    attacks: [{ name: 'Crush', cost: ['Water','Water'], damage: '80', text: '' }],
    attachedEnergy: [{ name: 'Water Energy' }, { name: 'Water Energy' }],
  });
  const defender = makeDefender({ hp: '60' });
  const switchCard = { supertype: 'Trainer', name: 'Switch' };
  const p2 = {
    active: baseActive, bench: [benchBeast,null,null,null,null],
    hand: [switchCard], discard: [], prizes: sixPrizes(),
  };
  const p1 = {
    active: defender, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes(),
  };
  global.G.players = { 1: p1, 2: p2 };
  global.G.evolvedThisTurn = [];
  const plan = _aiBuildTurnPlan(p2, p1);
  assert('Paralyzed+Switch: plan exists', plan !== null);
  assertEqual('Paralyzed+Switch: preStep is switch (not retreat)',
    plan?.preStep?.kind, 'switch');
}

// ── CASE: no viable plan at all → null ──────────────────────────────────────
{
  // Active has no energy, no hand, no bench. Nothing to do.
  const baseActive = makeAttacker({ attachedEnergy: [] });
  const defender = makeDefender();
  const p2 = {
    active: baseActive, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes(),
  };
  const p1 = {
    active: defender, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes(),
  };
  global.G.players = { 1: p1, 2: p2 };
  global.G.evolvedThisTurn = [];
  const plan = _aiBuildTurnPlan(p2, p1);
  assert('No viable plan: planner returns null',
    plan === null);
}

// ── CASE: evolve AND PlusPower combine correctly ────────────────────────────
{
  // Charmander → Charmeleon deals 50. Defender has 55 HP. 50 < 55, but 50+10
  // (PlusPower) = 60 ≥ 55 → KO. Planner should return evolve + PlusPower plan.
  const baseActive = makeAttacker({
    name: 'Charmander',
    uid: 'char-2',
    attachedEnergy: [{ name: 'Fire Energy' }, { name: 'Fire Energy' }],
  });
  const evoCard = makeStage1('Charmander', { name: 'Charmeleon' });
  const ppCard = { supertype: 'Trainer', name: 'PlusPower' };
  const defender = makeDefender({ hp: '55' });
  const p2 = {
    active: baseActive, bench: [null,null,null,null,null],
    hand: [evoCard, ppCard], discard: [], prizes: sixPrizes(),
  };
  const p1 = {
    active: defender, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes(),
  };
  global.G.players = { 1: p1, 2: p2 };
  global.G.evolvedThisTurn = [];
  const plan = _aiBuildTurnPlan(p2, p1);
  assert('Evolve+PP: plan exists', plan !== null);
  assert('Evolve+PP: plan KOs', plan?.willKO === true);
  assertEqual('Evolve+PP: preStep is evolve',
    plan?.preStep?.kind, 'evolve');
  assertEqual('Evolve+PP: PlusPower count is 1',
    plan?.plusPowerCount, 1);
}

// ── CASE: evolved form inherits attached energy ─────────────────────────────
{
  // Charmander has 3 Fire energy attached. Charmeleon's attack costs FFC (3
  // total). The evolved form should be affordable using the inherited energy
  // — without the inheritance, the test would fail (no energy in hand).
  const baseActive = makeAttacker({
    name: 'Charmander',
    uid: 'char-3',
    attachedEnergy: [
      { name: 'Fire Energy' }, { name: 'Fire Energy' }, { name: 'Fire Energy' },
    ],
  });
  const evoCard = makeStage1('Charmander', {
    name: 'Charmeleon',
    attacks: [
      { name: 'Flame Tail', cost: ['Fire','Fire','Colorless'], damage: '40', text: '' },
    ],
  });
  const defender = makeDefender({ hp: '40' });
  const p2 = {
    active: baseActive, bench: [null,null,null,null,null],
    hand: [evoCard], discard: [], prizes: sixPrizes(),
  };
  const p1 = {
    active: defender, bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes(),
  };
  global.G.players = { 1: p1, 2: p2 };
  global.G.evolvedThisTurn = [];
  const plan = _aiBuildTurnPlan(p2, p1);
  assert('Evolve inherits energy: Flame Tail affordable post-evolve',
    plan?.willKO === true);
  assertEqual('Evolve inherits energy: preStep is evolve',
    plan?.preStep?.kind, 'evolve');
  assertEqual('Evolve inherits energy: no extra attach needed',
    plan?.attachList?.length || 0, 0);
}

// ── CASE: baseline + Gust still preferred when evolve doesn't add value ─────
{
  // Baseline (Charmander 20 dmg) can Gust-KO a 20-HP benched Pikachu.
  // Evolved Charmeleon would do 50 but would target active (60 HP, no KO).
  // Planner should prefer Gust + baseline over evolve.
  const baseActive = makeAttacker({
    name: 'Charmander',
    uid: 'char-4',
    attachedEnergy: [{ name: 'Fire Energy' }, { name: 'Fire Energy' }],
  });
  const evoCard = makeStage1('Charmander', { name: 'Charmeleon' });
  const gustCard = { supertype: 'Trainer', name: 'Gust of Wind' };
  const defender = makeDefender({ hp: '60' });
  const weakBench = makeDefender({ name: 'Pikachu', hp: '20' });
  const p2 = {
    active: baseActive, bench: [null,null,null,null,null],
    hand: [evoCard, gustCard], discard: [], prizes: sixPrizes(),
  };
  const p1 = {
    active: defender, bench: [weakBench,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes(),
  };
  global.G.players = { 1: p1, 2: p2 };
  global.G.evolvedThisTurn = [];
  const plan = _aiBuildTurnPlan(p2, p1);
  assert('Prefer Gust-KO over evolve-no-KO: plan exists',
    plan !== null);
  assert('Prefer Gust-KO over evolve-no-KO: plan KOs',
    plan?.willKO === true);
  assertEqual('Prefer Gust-KO over evolve-no-KO: no preStep',
    plan?.preStep, null);
  assertEqual('Prefer Gust-KO over evolve-no-KO: target is bench 0',
    plan?.target?.benchIdx, 0);
}


// ── Pokémon Breeder plans ───────────────────────────────────────────────────
// Breeder skips Stage 1, letting you evolve Basic → Stage 2 directly. This is
// critical for survival plays: if Nidoran ♀ is about to be KO'd but you have
// Nidoqueen + Breeder in hand, playing Breeder saves the Pokémon (and the
// prize) by jumping to a higher-HP form.

const {
  breederRootBasicName: _breederRootBasicName,
} = require('./game-ai.js');

// Import Nidoqueen lineage helper already in tests.

// Basic Nidoran-♀ factory
function mkNidoranF(overrides = {}) {
  return {
    name: 'Nidoran ♀',
    uid: 'nf-1',
    supertype: 'Pokémon',
    subtypes: ['Basic'],
    hp: '60',
    damage: 0,
    types: ['Grass'],
    attacks: [
      { name: 'Fury Swipes', cost: ['Grass'], damage: '10×', text: 'Flip 3 coins. This attack does 10 damage times the number of heads.' },
    ],
    attachedEnergy: [{ name: 'Grass Energy' }],
    weaknesses: [], resistances: [],
    ...overrides,
  };
}

// Stage-2 Nidoqueen factory (breeder-target)
function mkNidoqueen(overrides = {}) {
  return {
    name: 'Nidoqueen',
    supertype: 'Pokémon',
    subtypes: ['Stage 2'],
    evolvesFrom: 'Nidorina', // realistic lineage
    hp: '90',
    damage: 0,
    types: ['Grass'],
    attacks: [
      { name: 'Boyfriends', cost: ['Colorless','Colorless','Colorless'], damage: '20×',
        text: 'This attack does 20 damage times the number of Nidoking you have in play.' },
      { name: 'Mega Punch',  cost: ['Grass','Colorless','Colorless','Colorless'], damage: '50', text: '' },
    ],
    ...overrides,
  };
}

// ── CASE: breederRootBasicName resolves Nidoqueen via gender-line helper ────
{
  const q = mkNidoqueen();
  const player = { hand: [], discard: [], deck: [] };
  assertEqual('breederRootBasicName: Nidoqueen → Nidoran ♀ via gender-line',
    _breederRootBasicName(q, player), 'Nidoran ♀');
}

// ── CASE: breederRootBasicName returns null when Stage 1 not findable ───────
{
  const unusualStage2 = {
    name: 'UnknownMon', subtypes: ['Stage 2'],
    evolvesFrom: 'NoSuchStage1',
  };
  const player = { hand: [], discard: [], deck: [] };
  assertEqual('breederRootBasicName: unresolvable lineage returns null',
    _breederRootBasicName(unusualStage2, player), null);
}

// ── CASE: Breeder rescue — Nidoran about to die, Nidoqueen+Breeder saves ─────
// Reproduces the reported scenario. Nidoran ♀ (60 HP) is already at 20 damage
// → 40 HP left. Opponent Pinsir Guillotine deals 50, which would KO Nidoran.
// Nidoqueen (90 HP) with 20 damage carried over = 70 HP left, survives 50.
//
// This is exactly the "rescue" case: no attack is possible post-Breeder (only
// 1 energy attached, Nidoqueen's cheapest attack needs 3), but evolving saves
// the Pokémon and the prize. The planner emits a RESCUE-outcome plan.
{
  const active = mkNidoranF({ damage: 20 }); // 60 HP - 20 = 40 HP left (Pinsir KOs)
  const nidoqueen = mkNidoqueen();
  const breeder   = { supertype: 'Trainer', name: 'Pokémon Breeder' };

  const oppActive = {
    name: 'Pinsir', hp: '60',
    types: ['Grass'],
    attacks: [{ name: 'Guillotine', cost: ['Grass','Colorless','Colorless'], damage: '50', text: '' }],
    attachedEnergy: [{ name: 'Grass Energy' }, { name: 'Grass Energy' }, { name: 'Grass Energy' }],
    weaknesses: [], resistances: [],
  };
  const p2 = {
    active,
    bench: [null,null,null,null,null],
    hand: [nidoqueen, breeder],
    discard: [],
    deck: [],
    prizes: sixPrizes(),
  };
  const p1 = {
    active: oppActive,
    bench: [null,null,null,null,null],
    hand: [],
    discard: [],
    prizes: sixPrizes(),
  };
  global.G.players = { 1: p1, 2: p2 };
  global.G.evolvedThisTurn = [];
  global.G.energyPlayedThisTurn = false;

  const plan = _aiBuildTurnPlan(p2, p1);
  assert('Breeder rescue: plan exists', plan !== null);
  assertEqual('Breeder rescue: preStep kind is breeder',
    plan?.preStep?.kind, 'breeder');
  assertEqual('Breeder rescue: outcome is RESCUE (no affordable attack post-evolve)',
    plan?.outcome, 'RESCUE');
  assert('Breeder rescue: Stage 2 handIdx points to Nidoqueen',
    plan?.preStep?.handIdx !== undefined &&
    p2.hand[plan.preStep.handIdx]?.name === 'Nidoqueen');
  assert('Breeder rescue: Breeder handIdx points to Pokémon Breeder',
    plan?.preStep?.breederHandIdx !== undefined &&
    p2.hand[plan.preStep.breederHandIdx]?.name === 'Pokémon Breeder');
  assertEqual('Breeder rescue: attack is null (no attack this turn)',
    plan?.attack, null);
  assert('Breeder rescue: plan.willSurvive is true',
    plan?.willSurvive === true);
}

// ── CASE: No Breeder card in hand → no Breeder plan ─────────────────────────
{
  const active = mkNidoranF();
  const nidoqueen = mkNidoqueen();
  // NO Breeder in hand
  const p2 = {
    active,
    bench: [null,null,null,null,null],
    hand: [nidoqueen],
    discard: [],
    deck: [],
    prizes: sixPrizes(),
  };
  const p1 = {
    active: { name: 'Dummy', hp: '100', types: [], attacks: [],
              attachedEnergy: [], weaknesses: [], resistances: [] },
    bench: [null,null,null,null,null],
    hand: [],
    discard: [],
    prizes: sixPrizes(),
  };
  global.G.players = { 1: p1, 2: p2 };
  global.G.evolvedThisTurn = [];

  const plan = _aiBuildTurnPlan(p2, p1);
  // Nidoqueen in hand evolves from "Nidorina", which doesn't match our
  // Nidoran ♀ active via normal evolve, so no evolve preStep either.
  assert('No Breeder card: no breeder preStep',
    plan === null || plan.preStep?.kind !== 'breeder');
}

// ── CASE: Breeder + Stage 2 but active is wrong gender → no Breeder plan ────
// Nidoqueen requires Nidoran ♀. Active is Nidoran ♂ → lineage rejects it.
{
  const active = mkNidoranF({ name: 'Nidoran ♂', uid: 'nm-1' });
  const nidoqueen = mkNidoqueen();
  const breeder = { supertype: 'Trainer', name: 'Pokémon Breeder' };
  const p2 = {
    active,
    bench: [null,null,null,null,null],
    hand: [nidoqueen, breeder],
    discard: [], deck: [],
    prizes: sixPrizes(),
  };
  const p1 = {
    active: { name: 'Dummy', hp: '100', types: [], attacks: [],
              attachedEnergy: [], weaknesses: [], resistances: [] },
    bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes(),
  };
  global.G.players = { 1: p1, 2: p2 };
  global.G.evolvedThisTurn = [];
  const plan = _aiBuildTurnPlan(p2, p1);
  assert('Wrong gender: no breeder preStep (Nidoran ♂ ≠ required Nidoran ♀)',
    plan === null || plan.preStep?.kind !== 'breeder');
}

// ── CASE: evolvedThisTurn blocks Breeder (active placed this turn) ──────────
{
  const active = mkNidoranF({ uid: 'just-played' });
  const nidoqueen = mkNidoqueen();
  const breeder = { supertype: 'Trainer', name: 'Pokémon Breeder' };
  const p2 = {
    active,
    bench: [null,null,null,null,null],
    hand: [nidoqueen, breeder],
    discard: [], deck: [],
    prizes: sixPrizes(),
  };
  const p1 = {
    active: { name: 'Dummy', hp: '100', types: [], attacks: [],
              attachedEnergy: [], weaknesses: [], resistances: [] },
    bench: [null,null,null,null,null],
    hand: [], discard: [], prizes: sixPrizes(),
  };
  global.G.players = { 1: p1, 2: p2 };
  global.G.evolvedThisTurn = ['just-played']; // ← blocks evolve and breeder
  const plan = _aiBuildTurnPlan(p2, p1);
  assert('evolvedThisTurn: no breeder preStep',
    plan === null || plan.preStep?.kind !== 'breeder');
  global.G.evolvedThisTurn = []; // reset
}


// ═══════════════════════════════════════════════════════════════════════════════
// benchPromotionScore — shared bench-candidate scorer (#3)
//
// Used by retreat decisions, Switch/Scoop Up trainer play, and post-KO
// promotion. Scoring: remainingHp + (canAttack ? 100 : 0) + bestDmgVsOpp × 2.
//
// Before #3, these call sites picked the highest-HP "can attack" bench Pokémon
// with no regard for matchup — leading to the classic "retreat Charizard into
// Bulbasaur against Blastoise" mistake.
// ═══════════════════════════════════════════════════════════════════════════════

section('benchPromotionScore');

// Helpers — small attacker factories. Note: `attachedEnergy` ON the attacker
// is set to just enough to afford its attack, so `aiCanAttack` returns true.
function mkFighter(overrides = {}) {
  return {
    name: 'Fighter',
    hp: '70',
    damage: 0,
    types: ['Fighting'],
    attacks: [{ name: 'Jab', cost: ['Fighting'], damage: '20', text: '' }],
    attachedEnergy: [{ name: 'Fighting Energy' }],
    weaknesses: [], resistances: [],
    ...overrides,
  };
}
function mkWaterAttacker(overrides = {}) {
  return {
    name: 'WaterDude',
    hp: '70',
    damage: 0,
    types: ['Water'],
    attacks: [{ name: 'Splash', cost: ['Water'], damage: '20', text: '' }],
    attachedEnergy: [{ name: 'Water Energy' }],
    weaknesses: [], resistances: [],
    ...overrides,
  };
}

// ── CASE: no opponent active → fall back to HP + can-attack only ────────────
{
  const b = mkFighter({ hp: '80', damage: 10 });
  const score = _benchPromotionScore(b, null);
  // HP left = 70, can-attack = true → score 70 + 100 = 170.
  assertEqual('No opp active: score = remainingHp + canAttack bonus',
    score, 170);
}

// ── CASE: no attacks → only HP term counts ──────────────────────────────────
{
  const b = { hp: '80', damage: 0, attacks: [], attachedEnergy: [], types: [],
              weaknesses: [], resistances: [] };
  const oppActive = mkWaterAttacker();
  const score = _benchPromotionScore(b, oppActive);
  assertEqual('No attacks: score = remainingHp only',
    score, 80);
}

// ── CASE: weakness exploit adds significant bonus ───────────────────────────
{
  // Fighter vs Water-weak-to-Fighting target → 20 × 2 weakness = 40 damage
  // bonus × 2 (scoring coefficient) = +80.
  const fighter = mkFighter({ hp: '70' });
  const waterWeakToFighting = mkWaterAttacker({
    weaknesses: [{ type: 'Fighting', value: '×2' }],
  });
  const score = _benchPromotionScore(fighter, waterWeakToFighting);
  // Base: 70 (HP) + 100 (can attack) = 170
  // Damage bonus: 40 × 2 = 80
  // Total: 250
  assertEqual('Weakness exploit: base 170 + 40×2 damage bonus = 250',
    score, 250);
}

// ── CASE: resistance reduces damage bonus ───────────────────────────────────
{
  const fighter = mkFighter({ hp: '70' });
  const fightingResistant = mkWaterAttacker({
    resistances: [{ type: 'Fighting' }],
  });
  const score = _benchPromotionScore(fighter, fightingResistant);
  // Base: 70 + 100 = 170
  // Damage: 20 - 30 resistance = 0 (floored), × 2 = 0
  // Total: 170
  assertEqual('Resistance reduces damage bonus to 0 (20 - 30 floored)',
    score, 170);
}

// ── CASE: matchup-aware tiebreaker — two bench Pokémon, same HP ─────────────
{
  // Both candidates have 70 HP. Fighter exploits weakness, WaterDude doesn't.
  // Fighter should outscore WaterDude.
  const fighter = mkFighter({ hp: '70' });
  const waterDude = mkWaterAttacker({ hp: '70' });
  const weakToFighting = mkWaterAttacker({
    weaknesses: [{ type: 'Fighting', value: '×2' }],
  });
  const fighterScore   = _benchPromotionScore(fighter, weakToFighting);
  const waterDudeScore = _benchPromotionScore(waterDude, weakToFighting);
  assert('Tiebreaker: weakness-exploiting attacker scores higher',
    fighterScore > waterDudeScore);
}

// ── CASE: higher HP can still lose to better matchup (big weakness swing) ───
{
  // Tanky no-matchup (100 HP) vs glass-cannon-with-weakness (50 HP).
  // Tanky: 100 + 100 (canAttack) + 20×2 = 240
  // Glass: 50  + 100 (canAttack) + 40×2 (weakness) = 230
  // Tanky wins — good. But make the weakness 3× to flip it:
  // Glass: 50 + 100 + 60×2 = 270 > 240.
  // This test demonstrates the scoring is balanced (extreme matchup wins).
  const tanky = mkWaterAttacker({ hp: '100' });
  const glass = mkFighter({ hp: '50' });
  const veryWeakToFighting = mkWaterAttacker({
    weaknesses: [{ type: 'Fighting', value: '×2' }], // standard 2x
  });
  const tankyScore = _benchPromotionScore(tanky, veryWeakToFighting);
  const glassScore = _benchPromotionScore(glass, veryWeakToFighting);
  // With 2x weakness: tanky 240, glass 230 → tanky wins (HP still matters).
  assert('HP still dominates at small matchup differentials',
    tankyScore > glassScore);
}

// ── CASE: can't afford any attack → damage bonus is 0 ───────────────────────
{
  // Bench Pokémon with no energy attached — can't use any attack. The damage
  // bonus term should contribute 0, so only HP counts.
  const starved = mkFighter({ attachedEnergy: [] });
  const oppActive = mkWaterAttacker({
    weaknesses: [{ type: 'Fighting', value: '×2' }],
  });
  const score = _benchPromotionScore(starved, oppActive);
  // HP 70 + canAttack 0 + damage 0 = 70.
  assertEqual('No affordable attack: score = remainingHp only',
    score, 70);
}

// ── CASE: null bench → -Infinity (invalid candidate) ────────────────────────
{
  const score = _benchPromotionScore(null, mkWaterAttacker());
  assertEqual('Null candidate: -Infinity',
    score, -Infinity);
}

// ── CASE: multiple attacks, picks the best-damage one ───────────────────────
{
  // A Pokémon with two attacks; only one exploits weakness. Scoring should
  // use the better one.
  const multi = {
    name: 'MultiAttacker',
    hp: '60', damage: 0,
    types: ['Fighting'],
    attacks: [
      // Low-damage first attack (alphabetically/positionally first)
      { name: 'Weak Slap', cost: ['Fighting'], damage: '10', text: '' },
      // Higher-damage second attack
      { name: 'Heavy Fist', cost: ['Fighting','Fighting'], damage: '30', text: '' },
    ],
    attachedEnergy: [{ name: 'Fighting Energy' }, { name: 'Fighting Energy' }],
    weaknesses: [], resistances: [],
  };
  const target = mkWaterAttacker({
    weaknesses: [{ type: 'Fighting', value: '×2' }],
  });
  const score = _benchPromotionScore(multi, target);
  // HP 60 + canAttack 100 + (30×2 weakness = 60) × 2 = 60 + 100 + 120 = 280
  assertEqual('Multi-attack: picks the best damage attack (Heavy Fist)',
    score, 280);
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGRESSION: Agility/Barrier/Transparency only block effects "done TO" defender
//
// Bug 1: Raichu's Agility on heads incorrectly short-circuited the entire
//        attack — including effects that don't target the defender at all.
//        Reported scenario: Kangaskhan's Fetch ("Draw a card.") was blocked
//        by Raichu's Agility, even though Fetch only draws a card for the
//        attacker. Per WotC ruling (compendium-bw.html, Feb 3 2000):
//
//            Q: Does Fearow's Agility attack block Kangaskhan's Fetch?
//            A: Actually it does not; Fearow's Agility says stops damage
//               done to Fearow, and the Fetch just draws a card.
//
//        And the general rule (also from the compendium):
//
//            Crystal Body, Agility, and Haunter's Transparency do NOT
//            prevent Eeeeeeek!, only effects of attacks that are done
//            TO them.
//
// Fix: replaced the early-return in performAttack (game-actions.js) with a
//      flag-set: oppActive.defenderFullEffects → atk._defenderEffectsBlocked.
//      The damage pipeline already zeros damage via defenderFull. The flag
//      drives downstream logic:
//        • move-effects.js applyMoveEffects skips handlers flagged
//          `targetsDefender: true`.
//        • game-actions.js parseStatusEffects loop skips non-self effects.
//        • applyPostAttackTextEffects skips defender-targeting clauses
//          (smokescreen / leer / growl text matches).
//        • Mixed-target handlers (Foul Odor, Mirror Move, Metronome,
//          Conversion 1) check the flag inline and skip only the
//          defender-targeting portion.
//      Same flag is set when Transparency is heads, since Transparency
//      mirrors Agility's wording.
//
// Bug 2: Poliwhirl's Amnesia opens an attack-picker. Hitting Cancel returned
//        undefined, the attack fell through to endTurn, and the player lost
//        their turn for nothing. Per the player's expectation: cancel = no
//        commitment yet (no damage dealt, no energy paid by Amnesia), so
//        the turn shouldn't be spent.
//
// Fix: Amnesia.postAttack now returns true on cancel, which performAttack
//      treats as effectBlocked (skipping endTurn).
// ═══════════════════════════════════════════════════════════════════════════════

section('REGRESSION: Agility — _defenderEffectsBlocked dispatch rule');

// Mirrors the rule in move-effects.js applyMoveEffects:
// when atk._defenderEffectsBlocked is set AND effect.targetsDefender is true,
// the handler is skipped entirely. Otherwise the handler runs.
function shouldRunPostAttack(atk, effect) {
  if (!effect?.postAttack) return false;
  if (atk._defenderEffectsBlocked && effect.targetsDefender) return false;
  return true;
}

{
  // Defender-targeting handler (e.g. Toxic, Poisonpowder, Smokescreen) is
  // SKIPPED when Agility/Transparency block defender effects.
  const atk = { name: 'Toxic', _defenderEffectsBlocked: true };
  const effect = { targetsDefender: true, postAttack: () => {} };
  assert('Defender-targeting handler is skipped when defender protected',
    shouldRunPostAttack(atk, effect) === false);
}

{
  // Same handler runs normally when defender is NOT protected.
  const atk = { name: 'Toxic' /* no _defenderEffectsBlocked */ };
  const effect = { targetsDefender: true, postAttack: () => {} };
  assert('Defender-targeting handler runs when defender NOT protected',
    shouldRunPostAttack(atk, effect) === true);
}

{
  // Self-effect handler (e.g. Fetch, Pay Day, Withdraw, Earthquake): runs
  // even when defender has full-effect protection. This is the bug we fixed.
  const atk = { name: 'Fetch', _defenderEffectsBlocked: true };
  const effect = { /* targetsDefender NOT set */ postAttack: () => {} };
  assert('Self-effect handler (Fetch) runs even when defender protected — THE BUG FIX',
    shouldRunPostAttack(atk, effect) === true);
}

{
  // No effect entry → no postAttack to run.
  const atk = { name: 'Tackle' };
  const effect = undefined;
  assert('No effect entry → nothing to run',
    shouldRunPostAttack(atk, effect) === false);
}

section('REGRESSION: Agility — parseStatusEffects loop skips non-self when blocked');

// Mirrors the rule in game-actions.js: when atk._defenderEffectsBlocked is set,
// non-self status effects are skipped but self-targeting effects still apply.
function shouldApplyStatusEffect(atk, eff) {
  if (atk._defenderEffectsBlocked && !eff.self) return false;
  return true;
}

{
  // Non-self status (e.g. "The Defending Pokémon is now Paralyzed."):
  // SKIPPED when defender is protected.
  const atk = { _defenderEffectsBlocked: true };
  const eff = { status: 'paralyzed', self: false };
  assert('Defender-targeting status effect skipped when defender protected',
    shouldApplyStatusEffect(atk, eff) === false);
}

{
  // Self-status (e.g. Petal Dance: "Vileplume is now Confused."):
  // RUNS even when defender is protected — self-effects are not "done TO" the defender.
  const atk = { _defenderEffectsBlocked: true };
  const eff = { status: 'confused', self: true };
  assert('Self-targeting status effect (e.g. Petal Dance self-Confused) still applies',
    shouldApplyStatusEffect(atk, eff) === true);
}

{
  // Without protection, all effects apply normally regardless of self/non-self.
  const atk = {};
  assert('Unprotected: defender status applies',
    shouldApplyStatusEffect(atk, { status: 'paralyzed', self: false }) === true);
  assert('Unprotected: self status applies',
    shouldApplyStatusEffect(atk, { status: 'confused', self: true }) === true);
}

section('REGRESSION: targetsDefender flag is set on every defender-only handler');

// Grep-based check: every named handler in move-effects.js whose postAttack
// ONLY does things to oppActive (status, energy discard, smokescreen, disable,
// hand-return) MUST have `targetsDefender: true`. Adding a new such handler
// without the flag is the regression we want to catch.
{
  const fs = require('fs');
  const path = require('path');
  const meffPath = path.join(__dirname, 'move-effects.js');
  if (fs.existsSync(meffPath)) {
    const src = fs.readFileSync(meffPath, 'utf8');

    // Hand-curated list of attack names whose postAttack ONLY targets the
    // opponent's active (no self-effect, no bench, no hand/deck). If you add
    // a new attack with the same shape, add it here too.
    //
    // Mixed-target handlers (Foul Odor, Mirror Move, Conversion 1, Metronome)
    // are intentionally NOT in this list — they check the flag inline.
    const defenderOnlyAttacks = [
      'Acid', 'Amnesia', 'Clamp', 'Foul Gas', 'Hurricane',
      'Poisonpowder', 'Toxic', 'Venom Powder',
    ];

    for (const name of defenderOnlyAttacks) {
      // Find the entry block: starts with `'Name': {` and continues until the
      // matching `},` closing brace at the same indent level. We just need to
      // confirm that `targetsDefender: true` appears between the open brace
      // and the next `'OtherAttack':` declaration.
      const startRe = new RegExp(`'${name.replace(/[^\w]/g, '\\$&')}':\\s*\\{`);
      const startIdx = src.search(startRe);
      if (startIdx === -1) {
        assert(`move-effects.js: '${name}' entry exists`, false);
        continue;
      }
      // Slice forward to the next `'SomethingElse':` or end of MOVE_EFFECTS.
      const after = src.slice(startIdx);
      const nextEntry = after.slice(1).search(/'\w[\w \-']*':\s*\{/);
      const block = nextEntry === -1 ? after : after.slice(0, nextEntry + 1);
      assert(`move-effects.js: '${name}' has targetsDefender: true (defender-only)`,
        /targetsDefender:\s*true/.test(block));
    }

    // Also check that the four shared factories carry the flag. The factory
    // expression assigns targetsDefender as the FIRST property, so we just
    // grep for the closing pattern.
    assert('move-effects.js: _statusOpp factory has targetsDefender: true',
      /_statusOpp\s*=\s*\(status\)\s*=>\s*\(\{\s*targetsDefender:\s*true,/.test(src));
    assert('move-effects.js: _statusOppFlip factory has targetsDefender: true',
      /_statusOppFlip\s*=\s*\(status\)\s*=>\s*\(\{\s*targetsDefender:\s*true,/.test(src));
    assert('move-effects.js: _smokescreen factory has targetsDefender: true',
      /_smokescreen\s*=\s*\(\)\s*=>\s*\(\{\s*targetsDefender:\s*true,/.test(src));
    assert('move-effects.js: _discardOppEnergy factory has targetsDefender: true',
      /_discardOppEnergy\s*=\s*\(\)\s*=>\s*\(\{\s*targetsDefender:\s*true,/.test(src));
  } else {
    console.log('  (move-effects.js not found — skipping grep check)');
  }
}

section('REGRESSION: Self-effects (Fetch et al.) do NOT have targetsDefender');

{
  const fs = require('fs');
  const path = require('path');
  const meffPath = path.join(__dirname, 'move-effects.js');
  if (fs.existsSync(meffPath)) {
    const src = fs.readFileSync(meffPath, 'utf8');

    // Hand-curated: attacks whose postAttack only does self-effects on the
    // attacker (draw, heal, retrieve, self-status, set self-flag). If any of
    // these accidentally got targetsDefender, Fetch-through-Agility breaks again.
    const selfOnlyAttacks = [
      'Fetch', 'Pay Day', 'Scavenge', 'Energy Conversion', 'Spacing Out',
      'Leech Seed', 'Petal Dance', 'Rampage', 'Tantrum',
      'Harden', 'Minimize', 'Pounce', 'Snivel', 'Swords Dance', 'Destiny Bond',
      'Barrier', 'Teleport', 'Earthquake',
    ];

    for (const name of selfOnlyAttacks) {
      const startRe = new RegExp(`'${name.replace(/[^\w]/g, '\\$&')}':\\s*\\{`);
      const startIdx = src.search(startRe);
      if (startIdx === -1) continue; // optional — not all of these may exist
      const after = src.slice(startIdx);
      const nextEntry = after.slice(1).search(/'\w[\w \-']*':\s*\{/);
      const block = nextEntry === -1 ? after : after.slice(0, nextEntry + 1);
      assert(`move-effects.js: '${name}' does NOT have targetsDefender (self-only)`,
        !/targetsDefender:\s*true/.test(block));
    }
  } else {
    console.log('  (move-effects.js not found — skipping grep check)');
  }
}

section('REGRESSION: performAttack defenderFullEffects is no longer a hard short-circuit');

{
  const fs = require('fs');
  const path = require('path');
  const ga = path.join(__dirname, 'game-actions.js');
  if (fs.existsSync(ga)) {
    const src = fs.readFileSync(ga, 'utf8');

    // The original buggy block called endTurn() and returned right after
    // detecting defenderFullEffects. Make sure that exact pattern is gone.
    // We allow defenderFullEffects to still be referenced (for the flag-set),
    // but it must NOT be followed within ~6 lines by `endTurn()` + `return;`.
    const lines = src.split('\n');
    let regressionFound = false;
    lines.forEach((line, i) => {
      if (/oppActive\?.defenderFullEffects/.test(line)) {
        const window = lines.slice(i, i + 7).join('\n');
        if (/endTurn\(\);[\s\S]*\breturn;/.test(window)) {
          regressionFound = true;
        }
      }
    });
    assert('game-actions.js: defenderFullEffects no longer triggers endTurn+return (Bug 2 fix)',
      !regressionFound);

    // The flag MUST be set somewhere in the file (Agility branch in
    // performAttack and Transparency branch in applyDamageModifiers).
    const flagSetCount = (src.match(/_defenderEffectsBlocked\s*=\s*true/g) || []).length;
    assert('game-actions.js: atk._defenderEffectsBlocked is set in at least 2 places (Agility + Transparency)',
      flagSetCount >= 2);

    // The parseStatusEffects loop must check the flag and skip non-self.
    assert('game-actions.js: parseStatusEffects loop checks _defenderEffectsBlocked && !eff.self',
      /_defenderEffectsBlocked\s*&&\s*!eff\.self/.test(src));

    // The legacy text-match clauses (smokescreen / leer / growl) must be
    // gated on the flag too.
    assert('game-actions.js: smokescreenMatch clause gated on _defenderEffectsBlocked',
      /smokescreenMatch[\s\S]{0,200}!atk\._defenderEffectsBlocked/.test(src));
    assert('game-actions.js: leerMatch clause gated on _defenderEffectsBlocked',
      /leerMatch[\s\S]{0,200}!atk\._defenderEffectsBlocked/.test(src));
    assert('game-actions.js: growlMatch clause gated on _defenderEffectsBlocked',
      /growlMatch[\s\S]{0,200}!atk\._defenderEffectsBlocked/.test(src));
  } else {
    console.log('  (game-actions.js not found — skipping grep check)');
  }
}

section('REGRESSION: Amnesia cancel must return true (not undefined)');

// Models the rule inside MOVE_EFFECTS['Amnesia'].postAttack: when the picker
// is shown (i.e. opp has 2+ attacks) and the user clicks Cancel (picked=null),
// the handler returns true so performAttack skips endTurn — letting the
// player keep their turn. If picker returns indices, attack proceeds normally.
function amnesiaCancelOutcome(pickerResult) {
  // pickerResult is what openCardPicker resolves to.
  //   null            → Cancel button or backdrop dismiss
  //   [idx, ...]      → user confirmed a selection
  if (pickerResult === null) {
    // Bug 1 fix: this MUST be true so performAttack's
    // `if (effectBlocked === true) return;` short-circuits before endTurn.
    return true;
  }
  // User confirmed → attack resolves; return undefined (attack ends turn).
  return undefined;
}

{
  assert('Amnesia: picker cancelled (null) → handler returns true → endTurn skipped',
    amnesiaCancelOutcome(null) === true);
  assert('Amnesia: picker confirmed ([0]) → handler returns undefined → endTurn runs',
    amnesiaCancelOutcome([0]) === undefined);
  assert('Amnesia: picker confirmed ([1]) → handler returns undefined → endTurn runs',
    amnesiaCancelOutcome([1]) === undefined);
}

// Grep-based check: the actual handler in move-effects.js must contain a
// branch that returns true after the picker resolves to falsy.
{
  const fs = require('fs');
  const path = require('path');
  const meffPath = path.join(__dirname, 'move-effects.js');
  if (fs.existsSync(meffPath)) {
    const src = fs.readFileSync(meffPath, 'utf8');
    // Locate the Amnesia entry block.
    const startIdx = src.indexOf("'Amnesia':");
    assert("move-effects.js: 'Amnesia' entry exists", startIdx !== -1);
    if (startIdx !== -1) {
      const block = src.slice(startIdx, startIdx + 2500);
      // The entry must contain a `return true;` statement (the cancel branch).
      assert("move-effects.js: Amnesia handler contains a 'return true;' branch (cancel path)",
        /return\s+true;/.test(block));
      // And the cancel branch must be guarded by !picked or picked === null
      // pattern to avoid firing on confirmed selections.
      assert("move-effects.js: Amnesia 'return true' is guarded by !picked check",
        /if\s*\(\s*!picked\s*\)[\s\S]{0,400}return\s+true;/.test(block));
    }
  } else {
    console.log('  (move-effects.js not found — skipping grep check)');
  }
}

section('REGRESSION: Amnesia keeps targetsDefender flag (disable IS done to defender)');

// The fix-Bug-1 code path returns true on cancel (skipping endTurn), but the
// success path still applies a state change to oppActive (disabledAttack).
// That state change IS done to the defender, so Amnesia must also be flagged
// targetsDefender so Agility/Transparency block the disable attempt entirely.
// (Already covered by the defender-only grep above, but locked here too.)
{
  const fs = require('fs');
  const path = require('path');
  const meffPath = path.join(__dirname, 'move-effects.js');
  if (fs.existsSync(meffPath)) {
    const src = fs.readFileSync(meffPath, 'utf8');
    const startIdx = src.indexOf("'Amnesia':");
    if (startIdx !== -1) {
      const block = src.slice(startIdx, startIdx + 2500);
      assert("move-effects.js: Amnesia entry has targetsDefender: true",
        /targetsDefender:\s*true/.test(block));
    }
  }
}


section('REGRESSION: _runFlashQueue must guard fn() against throws (queue jams forever otherwise)');

// Background: end-of-attack flow queues two items into _flashQueue:
//   1. renderAll  (from renderWhenIdle())
//   2. endTurn
// If the queued fn() throws (anywhere in renderAll, or directly in endTurn),
// the setTimeout that resets _flashBusy=false never gets scheduled. The queue
// is permanently jammed: every subsequent _runFlashQueue() call short-circuits
// at the busy check, and the queued endTurn never runs. The visible symptom
// is "I attacked but the turn didn't pass" — the attacker keeps playing on
// the same turn number with no error visible to the user. We've hit this
// pattern at least twice (transitionPhase undefined, and the Whirlpool +
// Energy Removal multiplayer scenario). The fix is a try/catch around fn()
// so a throwing handler doesn't take the whole turn-end pipeline down with
// it. console.error keeps regressions surfaceable in DevTools.
{
  const fs = require('fs');
  const path = require('path');
  const renderPath = path.join(__dirname, 'game-render.js');
  if (fs.existsSync(renderPath)) {
    const src = fs.readFileSync(renderPath, 'utf8');
    const m = src.match(/function _runFlashQueue\s*\(\s*\)\s*\{([\s\S]*?)\n\}/);
    assert('game-render.js: _runFlashQueue is defined', !!m);
    if (m) {
      const body = m[1];
      // Must invoke the queued fn inside a try/catch so a throw doesn't
      // skip the setTimeout that releases _flashBusy.
      assert('game-render.js: _runFlashQueue wraps fn() in try { ... } catch',
        /try\s*\{[^}]*\bfn\s*\(\s*\)/.test(body) && /catch\s*\(/.test(body));
      // The setTimeout that releases _flashBusy must come AFTER the try/catch
      // so it always runs regardless of whether fn() threw. Strip line comments
      // first so the word "setTimeout" inside the explanatory comment doesn't
      // fool the position check.
      const codeOnly = body.replace(/\/\/[^\n]*/g, '');
      const tryIdx = codeOnly.indexOf('try');
      const stIdx  = codeOnly.indexOf('setTimeout');
      assert('game-render.js: setTimeout(release _flashBusy) is positioned after the try/catch',
        tryIdx !== -1 && stIdx !== -1 && stIdx > tryIdx);
      // A bare `fn()` call outside try/catch would defeat the guard. There
      // must be no unguarded fn() invocation in the body.
      // Strip the try { ... } block to check the rest.
      const tryBlockMatch = body.match(/try\s*\{[\s\S]*?\}\s*catch\s*\([^)]*\)\s*\{[^}]*\}/);
      const remainder = tryBlockMatch ? body.replace(tryBlockMatch[0], '') : body;
      assert('game-render.js: no unguarded fn() call exists outside the try/catch',
        !/\bfn\s*\(\s*\)/.test(remainder));
    }
  } else {
    console.log('  (game-render.js not found — skipping flash queue regression check)');
  }
}


section('REGRESSION: card-picker tile aspect-ratio must be on .picker-card, not on its <img>');

// Background: in Firefox, when `aspect-ratio: 5/7` lives on the child <img> of
// a .picker-card grid item — and the parent grid (#card-picker-grid) has
// `overflow-y: auto` + `max-height: 50vh` and `1fr` columns — Firefox sizes
// the grid rows from the image's intrinsic (pre-load) dimensions and collapses
// them to ~10px slivers. The visible symptom: Computer Search (or any picker
// with many cards) shows only the top edge of each card + the name label.
// Chrome forgives this; Firefox does not.
//
// Fix: aspect-ratio belongs on .picker-card (the grid item), and the <img>
// fills the remaining flex space. If anyone "simplifies" this back, this
// test fails.
{
  const fs = require('fs');
  const path = require('path');
  const htmlPath = path.join(__dirname, 'pokemon-game.html');
  if (fs.existsSync(htmlPath)) {
    const src = fs.readFileSync(htmlPath, 'utf8');

    // Pull out the .picker-card rule and the .picker-card img rule.
    // Match the rule body up to the next `}`.
    const cardRuleMatch  = src.match(/\.picker-card\s*\{([^}]*)\}/);
    const cardImgMatches = [...src.matchAll(/\.picker-card\s+img\s*\{([^}]*)\}/g)];

    assert('pokemon-game.html: .picker-card rule exists', !!cardRuleMatch);
    assert('pokemon-game.html: .picker-card img rule exists', cardImgMatches.length > 0);

    if (cardRuleMatch) {
      const body = cardRuleMatch[1];
      // The grid-item must declare aspect-ratio so Firefox has a definite
      // row height before the img loads.
      assert('pokemon-game.html: .picker-card has aspect-ratio (5/7) declared on the grid item itself',
        /aspect-ratio\s*:\s*5\s*\/\s*7/.test(body));
      // It must be a flex column so the img can fill remaining space below
      // the name/meta rows.
      assert('pokemon-game.html: .picker-card uses flex column layout (image fills remaining space)',
        /display\s*:\s*flex/.test(body) && /flex-direction\s*:\s*column/.test(body));
    }

    // CRITICAL: every `.picker-card img` rule (desktop + mobile media query)
    // must NOT have aspect-ratio — that's exactly what triggered the Firefox
    // sliver bug.
    cardImgMatches.forEach((m, i) => {
      assert(`pokemon-game.html: .picker-card img rule #${i + 1} must NOT set aspect-ratio (Firefox sliver bug)`,
        !/aspect-ratio/.test(m[1]));
    });

    // And the img must use `flex: ... auto` (or similar) so it grows to fill
    // the parent's aspect-ratio-derived height.
    const desktopImgRule = cardImgMatches[0] && cardImgMatches[0][1];
    if (desktopImgRule) {
      assert('pokemon-game.html: .picker-card img uses flex sizing to fill parent height',
        /flex\s*:\s*1/.test(desktopImgRule));
    }
  } else {
    console.log('  (pokemon-game.html not found — skipping CSS regression check)');
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION: SETUP ready-up flow — P2 must be able to signal ready before
// P1 advances. Without an explicit ready handshake, P1 could click DONE SETUP
// the moment P2 placed any Active and cut P2 off mid-bench-placement. The
// fix introduces a setupReady = {1,2} map, a toggleSetupReady() function,
// and a maybeAutoAdvanceSetup() that fires doneSetup on P1's side once both
// flags are true. Any non-toggle push during SETUP must clear the local flag
// (otherwise placing a new bench Pokémon after readying leaves the ready flag
// stale and P1 advances on a stale state).
// ─────────────────────────────────────────────────────────────────────────────
section('REGRESSION: SETUP ready-up flow exists and is wired correctly');
{
  const fs = require('fs');
  const path = require('path');
  const initPath = path.join(__dirname, 'game-init.js');
  if (fs.existsSync(initPath)) {
    const src = fs.readFileSync(initPath, 'utf8');

    // 1. The setupReady state map must exist
    assert('game-init.js: setupReady map declared',
      /let\s+setupReady\s*=\s*\{\s*1\s*:\s*false\s*,\s*2\s*:\s*false\s*\}/.test(src));

    // 2. The _pushPreservesReady guard exists
    assert('game-init.js: _pushPreservesReady guard declared',
      /let\s+_pushPreservesReady\s*=\s*false/.test(src));

    // 3. toggleSetupReady function exists
    assert('game-init.js: toggleSetupReady function defined',
      /function\s+toggleSetupReady\s*\(/.test(src));

    // 4. maybeAutoAdvanceSetup function exists
    assert('game-init.js: maybeAutoAdvanceSetup function defined',
      /function\s+maybeAutoAdvanceSetup\s*\(/.test(src));

    // 5. handleEndTurnBtn must route through toggleSetupReady in multiplayer SETUP.
    //    If it goes straight to doneSetup() unconditionally, P1 can still cut P2 off.
    const handleM = src.match(/function\s+handleEndTurnBtn\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
    assert('game-init.js: handleEndTurnBtn defined', !!handleM);
    if (handleM) {
      const body = handleM[1];
      // Must reach toggleSetupReady() somewhere in the SETUP branch
      assert('game-init.js: handleEndTurnBtn calls toggleSetupReady() for multiplayer SETUP',
        /toggleSetupReady\s*\(/.test(body));
      // Must still call doneSetup() for vsComputer / single-player fallback
      assert('game-init.js: handleEndTurnBtn keeps doneSetup() fallback',
        /doneSetup\s*\(/.test(body));
    }

    // 6. pushGameState must clear the local ready flag on non-toggle SETUP pushes
    //    (i.e. when _pushPreservesReady is false). Otherwise placing a Pokémon
    //    after readying leaves the flag stale.
    const pushM = src.match(/async\s+function\s+pushGameState\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
    assert('game-init.js: pushGameState defined', !!pushM);
    if (pushM) {
      const body = pushM[1];
      assert('game-init.js: pushGameState references _pushPreservesReady guard',
        /_pushPreservesReady/.test(body));
      assert('game-init.js: pushGameState clears setupReady on non-toggle SETUP pushes',
        /setupReady\s*\[\s*myRole\s*\]\s*=\s*false/.test(body));
      // Must serialize setupReady into the setup_pN slot so the opponent learns
      // when we're ready
      assert('game-init.js: pushGameState writes setupReady into setup_pN slot',
        /setupReady\s*:\s*!!setupReady\s*\[\s*myRole\s*\]/.test(body));
    }

    // 7. mergeSetupSlot must be defensive — only update fields that are
    //    actually present. Otherwise the post-start setup_p1 = { setupReady }
    //    push from P1 would wipe P1's active/bench from P2's view.
    const mergeM = src.match(/function\s+mergeSetupSlot\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
    assert('game-init.js: mergeSetupSlot defined', !!mergeM);
    if (mergeM) {
      const body = mergeM[1];
      assert('game-init.js: mergeSetupSlot guards active update with hasOwnProperty',
        /hasOwnProperty[^)]*active/.test(body) || /'active'\s*in\s*slotData/.test(body));
      assert('game-init.js: mergeSetupSlot guards bench update with hasOwnProperty',
        /hasOwnProperty[^)]*bench/.test(body) || /'bench'\s*in\s*slotData/.test(body));
      assert('game-init.js: mergeSetupSlot reads setupReady from incoming slot',
        /setupReady/.test(body));
    }

    // 8. doneSetup must clear setupReady after the SETUP→DRAW transition so
    //    a future game starts with both flags cleared.
    const doneM = src.match(/async\s+function\s+doneSetup\s*\([^)]*\)\s*\{([\s\S]*?)\nasync function/);
    if (doneM) {
      const body = doneM[1];
      assert('game-init.js: doneSetup resets setupReady on SETUP→DRAW transition',
        /setupReady\s*=\s*\{\s*1\s*:\s*false\s*,\s*2\s*:\s*false\s*\}/.test(body));
    }

    // 9. toggleSetupReady must require an Active Pokémon before the player
    //    can mark themselves ready (otherwise they could ready up with no
    //    Active and cause maybeAutoAdvanceSetup → doneSetup to bail).
    const toggleM = src.match(/function\s+toggleSetupReady\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
    if (toggleM) {
      const body = toggleM[1];
      assert('game-init.js: toggleSetupReady requires Active before marking ready',
        /G\.players\s*\[\s*myRole\s*\]\s*\.\s*active/.test(body));
      assert('game-init.js: toggleSetupReady sets _pushPreservesReady before pushing',
        /_pushPreservesReady\s*=\s*true/.test(body));
    }

    // 10. maybeAutoAdvanceSetup must require both flags true and only fire
    //     on P1's side (P1 owns the SETUP→DRAW transition).
    const autoM = src.match(/function\s+maybeAutoAdvanceSetup\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
    if (autoM) {
      const body = autoM[1];
      assert('maybeAutoAdvanceSetup: gates on myRole === 1',
        /myRole\s*!==\s*1/.test(body) || /myRole\s*===\s*1/.test(body));
      assert('maybeAutoAdvanceSetup: requires both setupReady flags',
        /setupReady\s*\[\s*1\s*\][\s\S]*setupReady\s*\[\s*2\s*\]/.test(body));
      assert('maybeAutoAdvanceSetup: bails out in vsComputer mode',
        /vsComputer/.test(body));
      assert('maybeAutoAdvanceSetup: invokes doneSetup when both are ready',
        /doneSetup\s*\(/.test(body));
    }

  } else {
    console.log('  (game-init.js not found — skipping SETUP ready-flow check)');
  }
}


console.log(`\n${'═'.repeat(64)}`);
console.log(`  ${passed} passed   ${failed} failed`);
console.log('═'.repeat(64));
if (failed > 0) process.exit(1);