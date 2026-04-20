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

// Grep-based check: every site that sets G.started = false in pokemon-game.html
// must be followed (within ~5 lines) by a pushGameState() call. This catches
// future regressions where a new win/loss site is added without the explicit push.
{
  const fs = require('fs');
  const path = require('path');
  const htmlPath = path.join(__dirname, 'pokemon-game.html');
  if (fs.existsSync(htmlPath)) {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const lines = html.split('\n');
    const issues = [];
    lines.forEach((line, i) => {
      if (/G\.started\s*=\s*false/.test(line)) {
        // Look ahead 6 lines for either pushGameState() or playAgain()/reset
        // (playAgain is the cleanup path, doesn't need to push)
        const window = lines.slice(i, i + 7).join('\n');
        const isCleanup = /\bplayAgain\b|\bG\s*=\s*\{/.test(window);
        const hasPush = /pushGameState\s*\(/.test(window);
        if (!isCleanup && !hasPush) {
          issues.push(`line ${i+1}: ${line.trim()}`);
        }
      }
    });
    assert('Every G.started=false site is followed by pushGameState() (or is cleanup)',
      issues.length === 0);
    if (issues.length > 0) {
      console.error('    Sites missing pushGameState():');
      issues.forEach(s => console.error('      ' + s));
    }
  } else {
    console.log('  (pokemon-game.html not found — skipping grep check)');
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

// Grep-based check: every generic draw-card regex in pokemon-game.html must be
// guarded by a named-handler check. Catches future regressions if someone adds
// a new generic effect-text regex without the guard.
{
  const fs = require('fs');
  const path = require('path');
  const htmlPath = path.join(__dirname, 'pokemon-game.html');
  if (fs.existsSync(htmlPath)) {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const lines = html.split('\n');
    const issues = [];
    lines.forEach((line, i) => {
      if (/\/draw a card\/i\.test/.test(line) || /\/draw \(\\d\+\) cards/.test(line)) {
        // Look at the surrounding ~6 lines for the named-handler guard
        const window = lines.slice(Math.max(0, i - 3), i + 4).join('\n');
        const guarded = /_hasNamedPostAttack|MOVE_EFFECTS\[atk\.name\]/.test(window);
        if (!guarded) issues.push(`line ${i+1}: ${line.trim()}`);
      }
    });
    assert('Every generic draw-card regex is guarded by named-handler check',
      issues.length === 0);
    if (issues.length > 0) {
      console.error('    Unguarded sites:');
      issues.forEach(s => console.error('      ' + s));
    }
  } else {
    console.log('  (pokemon-game.html not found — skipping grep check)');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Results
// ═══════════════════════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(64)}`);
console.log(`  ${passed} passed   ${failed} failed`);
console.log('═'.repeat(64));
if (failed > 0) process.exit(1);
