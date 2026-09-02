#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
// AI-SIM.JS — Headless AI-vs-AI simulator for the Pokémon TCG engine
//
// Loads the REAL game engine (game-utils / game-render / game-actions / game-ai
// / pokemon-powers / trainer-cards / move-effects / game-init) into a Node VM
// with a stub DOM, a virtual clock, and no-op renderers, then plays complete
// games between two agents and reports win rates.
//
// Usage:
//   node ai-sim.js                         # new AI (P1) vs old AI at HEAD (P2)
//   node ai-sim.js --games 40              # games per matchup
//   node ai-sim.js --p1 new --p2 simple    # agents: new | old | simple
//   node ai-sim.js --p1 new --p2 old --diff hard
//   node ai-sim.js --decks haymaker,raindance
//   node ai-sim.js --old-ref HEAD~3        # git ref for the "old" AI file
//   node ai-sim.js --verbose               # print per-game results
//   node ai-sim.js --log 3                 # dump the log of game #3
//
// Agents:
//   new    — game-ai.js in the working tree (player-parametric via aiPlayerNum)
//   old    — game-ai.js from a git ref, loaded in a closure (P2 seat only)
//   simple — a naive scripted bot (bench everything, attach to active,
//            highest-damage attack) used as a fixed yardstick
//
// This file is a dev tool — it is never loaded by the browser.
// ══════════════════════════════════════════════════════════════════════════════
'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;
const ENGINE_FILES = [
  'game-utils.js', 'game-render.js', 'game-actions.js', 'game-ai.js',
  'pokemon-powers.js', 'trainer-cards.js', 'move-effects.js', 'game-init.js',
];

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argVal(name, def) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : def;
}
const OPTS = {
  games: parseInt(argVal('--games', '20')),
  p1: argVal('--p1', 'new'),
  p2: argVal('--p2', 'old'),
  diff: argVal('--diff', 'hard'),
  decks: argVal('--decks', 'all'),
  oldRef: argVal('--old-ref', 'HEAD'),
  verbose: args.includes('--verbose'),
  logGame: argVal('--log', null),
  maxTurns: parseInt(argVal('--max-turns', '120')),
  seed: parseInt(argVal('--seed', '1')),
};

// ── Deterministic RNG (so runs are reproducible) ─────────────────────────────
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Stub DOM ─────────────────────────────────────────────────────────────────
// A permissive element proxy: any property read returns something harmless,
// any method call is a no-op that returns another stub. `then` must be
// undefined so awaiting a stub never treats it as a thenable.
function makeStubEl() {
  const store = Object.create(null);
  const style = new Proxy({}, {
    get: (t, p) => (p === 'setProperty' || p === 'removeProperty') ? () => {} : (p in t ? t[p] : ''),
    set: (t, p, v) => { t[p] = v; return true; },
  });
  const classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  const el = new Proxy(function () {}, {
    get(t, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'then') return undefined;
      if (prop in store) return store[prop];
      switch (prop) {
        case 'style': return style;
        case 'classList': return classList;
        case 'dataset': return (store.dataset = store.dataset || {});
        case 'children': case 'childNodes': return [];
        case 'querySelectorAll': return () => [];
        case 'querySelector': case 'getElementById': case 'closest':
        case 'createElement': case 'appendChild': case 'insertBefore':
        case 'parentElement': case 'parentNode': case 'firstChild': case 'cloneNode':
          return () => makeStubEl();
        case 'getBoundingClientRect': return () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
        case 'textContent': case 'innerHTML': case 'value': case 'id': case 'className': case 'title': case 'src':
          return '';
        case 'offsetWidth': case 'offsetHeight': case 'clientWidth': case 'clientHeight': case 'scrollTop': case 'length':
          return 0;
        case 'disabled': case 'hidden': return false;
        case 'readyState': return 'complete';
        case 'body': case 'documentElement': case 'head': return (store.body = store.body || makeStubEl());
        default: return () => makeStubEl();
      }
    },
    set(t, prop, v) { store[prop] = v; return true; },
    apply() { return makeStubEl(); },
    has() { return true; },
  });
  return el;
}

// ── Engine context ───────────────────────────────────────────────────────────
function loadEngine({ oldRef, rng }) {
  const timers = [];
  let vnow = 0, seq = 0;
  const loadListeners = [];

  const sandbox = {
    console,
    Math: Object.assign(Object.create(Math), { random: rng }),
    JSON, Date, Promise, Array, Object, Number, String, Boolean, RegExp, Error, Map, Set, Symbol, parseInt, parseFloat, isNaN, isFinite, Infinity, NaN, undefined,
    queueMicrotask, structuredClone,
    setTimeout(fn, ms = 0, ...a) { const id = ++seq; timers.push({ id, at: vnow + Math.max(0, ms | 0), fn, a }); return id; },
    clearTimeout(id) { const i = timers.findIndex(t => t.id === id); if (i !== -1) timers.splice(i, 1); },
    setInterval() { return ++seq; },
    clearInterval() {},
    requestAnimationFrame(fn) { return sandbox.setTimeout(fn, 0); },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { search: '', origin: 'http://sim', pathname: '/', href: 'http://sim/' },
    navigator: { userAgent: 'sim' },
    URLSearchParams,
    fetch: async (url) => ({ json: async () => JSON.parse(fs.readFileSync(path.join(ROOT, url), 'utf8')) }),
    firebase: null,
    alert() {}, confirm() { return true; }, prompt() { return ''; },
  };
  const fbRef = {
    set: async () => {}, update: async () => {}, remove: async () => {},
    once: async () => ({ val: () => null, exists: () => false }),
    on() {}, off() {}, child() { return fbRef; }, push() { return fbRef; },
    onDisconnect() { return { remove() {} }; },
  };
  sandbox.firebase = {
    initializeApp() {},
    database: () => ({ ref: () => fbRef, ServerValue: { TIMESTAMP: 0 } }),
    auth: () => ({ onAuthStateChanged() {}, signInWithEmailAndPassword: async () => {}, signOut: async () => {} }),
  };
  sandbox.document = makeStubEl();
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.addEventListener = (ev, fn) => { if (ev === 'load') loadListeners.push(fn); };
  sandbox.removeEventListener = () => {};
  sandbox.dispatchEvent = () => {};

  const ctx = vm.createContext(sandbox);
  const run = (code, name) => vm.runInContext(code, ctx, { filename: name || 'sim-inline.js' });

  for (const f of ENGINE_FILES) {
    run(fs.readFileSync(path.join(ROOT, f), 'utf8'), f);
  }

  // Populate CARD_DATA synchronously (the engine fetches it asynchronously).
  run(`(function(){ const cards = ${fs.readFileSync(path.join(ROOT, 'cards.json'), 'utf8')}; cards.forEach(c => { CARD_DATA[c.id] = c; }); })();`, 'cards-load.js');

  // ── Neutralize UI ─────────────────────────────────────────────────────────
  run(`
    const __noop = function(){};
    renderAll = __noop; renderHands = __noop; renderField = __noop; renderPrizes = __noop;
    renderSidebarP2Hand = __noop; renderPrizesTab = __noop; updateDeckCounts = __noop;
    updatePhase = __noop; updateTurnBadge = __noop; updatePerspectiveLabels = __noop;
    renderLog = __noop; initDragDrop = __noop; showToast = __noop; showMoveFlash = __noop;
    showBlockedFlash = __noop; showActionFlash = __noop; showTrainerFlash = __noop;
    showSetupFlash = __noop; showTurnFlash = __noop; showPromoteBanner = __noop;
    hidePromoteBanner = __noop; spawnConfetti = __noop; notifyMyTurn = __noop;
    ensureTurnNotifications = __noop; pushGameState = __noop; applyRoleVisibility = __noop;
    clearHighlights = __noop; setMidline = __noop; showActionMenu = __noop; closeActionMenu = __noop;
    showCardDetail = __noop; hideCardDetail = __noop; showLassModal = __noop;
    renderWhenIdle = __noop; _queueFlash = function(fn){ try { fn(); } catch(e){ console.error(e); } };
    showWinScreen = function(w, r){ G.winner = w; G.winReason = r || ''; };
    addLog = function(msg, important){ G.log.push({ msg, important: !!important, turn: G.turnNum }); if (G.log.length > 4000) G.log.splice(0, 1000); };
    // Coin flips: instant, no animation.
    flipCoin = function(){ const heads = Math.random() < 0.5; return Promise.resolve(heads); };
    closeCoinOverlay = __noop;
    // Pickers: auto-pick the first N options for whoever is acting.
    openCardPicker = function({ cards, maxSelect = 1 } = {}) {
      if (!cards || !cards.length) return Promise.resolve(null);
      const n = Math.max(1, Math.min(maxSelect, cards.length));
      const out = []; for (let i = 0; i < n; i++) out.push(i);
      return Promise.resolve(out);
    };
    pickType = function(){ return Promise.resolve('Fire'); };
    openPokedex = function(){ return Promise.resolve(); };
    prophecyModal = function(){ return Promise.resolve(); };
    doPeek = function(){ return Promise.resolve(); };
    // Forced switches where the OPPONENT chooses: pick their highest-HP bench.
    forceOpponentSwitch = async function(opp, attackerChooses, attackName) {
      const oppP = G.players[opp];
      const bench = oppP.bench.map((s, i) => ({ s, i })).filter(x => x.s !== null);
      if (!bench.length) return;
      let pick;
      if (attackerChooses) {
        pick = bench.reduce((a, b) => ((parseInt(b.s.hp)||0) - (b.s.damage||0)) < ((parseInt(a.s.hp)||0) - (a.s.damage||0)) ? b : a);
      } else {
        pick = bench.reduce((a, b) => ((parseInt(b.s.hp)||0) - (b.s.damage||0)) > ((parseInt(a.s.hp)||0) - (a.s.damage||0)) ? b : a);
      }
      const old = oppP.active;
      if (old && typeof clearAllStatus === 'function') clearAllStatus(old);
      if (old && typeof clearActiveOnlyEffects === 'function') clearActiveOnlyEffects(old);
      oppP.active = pick.s; oppP.bench[pick.i] = old;
      while (oppP.bench.length < 5) oppP.bench.push(null);
      addLog(attackName + ': P' + opp + "'s " + pick.s.name + ' forced to Active!', true);
    };
    globalThis.__H = {
      get G() { return G; },
      set vsComputer(v) { vsComputer = v; },
      get vsComputer() { return vsComputer; },
      set aiDifficulty(v) { aiDifficulty = v; },
      set aiThinking(v) { aiThinking = v; },
      get aiThinking() { return aiThinking; },
      setAiPlayer(n) { if (typeof aiPlayerNum !== 'undefined') aiPlayerNum = n; },
      hasAiPlayerNum() { return typeof aiPlayerNum !== 'undefined'; },
      resetG(newG) { G = newG; },
      fn(name) { return eval(name); },
      enrich(c) { return enrichCard(c); },
    };
  `, 'sim-overrides.js');

  // ── Old AI (from git) loaded in a closure so it doesn't clash ────────────
  let oldAI = null;
  if (oldRef) {
    let src;
    try { src = execSync(`git show ${oldRef}:game-ai.js`, { cwd: ROOT, encoding: 'utf8' }); }
    catch (e) { throw new Error(`Could not load old AI from git ref ${oldRef}: ${e.message}`); }
    run(`globalThis.__OLD_AI = (function(){
      ${src}
      vsComputer = true;
      return {
        takeTurn: () => aiTakeTurn(),
        setup: () => aiDoSetup(),
        promote: () => aiDoPromotion(),
        setDiff: (d) => { aiDifficulty = d; },
        resetThinking: () => { aiThinking = false; },
      };
    })();`, `old-game-ai(${oldRef}).js`);
    oldAI = run('__OLD_AI');
  }

  // ── Simple scripted bot (yardstick) ───────────────────────────────────────
  run(`globalThis.__SIMPLE = {
    basicScore(c) {
      const hp = parseInt(c.hp) || 0;
      const maxDmg = (c.attacks || []).reduce((m, a) => Math.max(m, parseInt((a.damage||'0').replace(/[^0-9]/g,''))||0), 0);
      return hp + maxDmg;
    },
    setup(p) {
      const P = G.players[p];
      const basics = P.hand.filter(c => c.supertype === 'Pokémon' && c.subtypes?.includes('Basic'));
      basics.sort((a, b) => this.basicScore(b) - this.basicScore(a));
      if (!basics.length) return;
      P.active = basics[0]; P.hand.splice(P.hand.indexOf(basics[0]), 1);
      for (const c of basics.slice(1)) {
        const slot = P.bench.findIndex(s => s === null); if (slot === -1) break;
        P.bench[slot] = c; P.hand.splice(P.hand.indexOf(c), 1);
      }
    },
    promote(p) {
      const P = G.players[p];
      let best = -1, bs = -Infinity;
      P.bench.forEach((b, i) => { if (!b) return; const s = (parseInt(b.hp)||0) - (b.damage||0); if (s > bs) { bs = s; best = i; } });
      if (best !== -1) resolvePromotion(p, best);
    },
    async takeTurn(p) {
      const P = G.players[p], O = G.players[p === 1 ? 2 : 1];
      if (G.phase === 'DRAW') { drawCard(p, true); G.phase = 'MAIN'; }
      if (!P.active) { const i = P.bench.findIndex(s => s); if (i === -1) { endTurn(); return; } P.active = P.bench[i]; P.bench[i] = null; }
      // Bench basics
      for (let i = P.hand.length - 1; i >= 0; i--) {
        const c = P.hand[i]; const slot = P.bench.findIndex(s => s === null);
        if (slot === -1) break;
        if (c.supertype === 'Pokémon' && c.subtypes?.includes('Basic')) { P.bench[slot] = c; P.hand.splice(i, 1); (G.evolvedThisTurn = G.evolvedThisTurn || []).push(c.uid); }
      }
      // Evolve
      let evolved = true;
      while (evolved) {
        evolved = false;
        for (let i = 0; i < P.hand.length; i++) {
          const c = P.hand[i];
          if (c.supertype !== 'Pokémon' || !c.evolvesFrom) continue;
          if (!(c.subtypes?.includes('Stage 1') || c.subtypes?.includes('Stage 2'))) continue;
          if (prehistoricPowerActive()) break;
          const ev = G.evolvedThisTurn || [];
          if (P.active?.name === c.evolvesFrom && !ev.includes(P.active.uid)) { evolve(p, i, 'active', null); evolved = true; break; }
          const bi = P.bench.findIndex(b => b && b.name === c.evolvesFrom && !ev.includes(b.uid));
          if (bi !== -1) { evolve(p, i, 'bench', bi); evolved = true; break; }
        }
      }
      // Bill / Oak
      for (let i = P.hand.length - 1; i >= 0; i--) {
        const c = P.hand[i];
        if (c.name === 'Bill') { P.hand.splice(i, 1); P.discard.push(c); drawCard(p, true); drawCard(p, true); }
      }
      // Energy: active first if it can't attack, else bench
      if (!G.energyPlayedThisTurn) {
        const ei = P.hand.findIndex(c => c.supertype === 'Energy');
        if (ei !== -1) {
          const a = P.active;
          const canAtk = (a.attacks || []).some(atk => canAffordAttack(a.attachedEnergy, atk.cost, a));
          const maxCost = (a.attacks || []).reduce((m, atk) => Math.max(m, (atk.cost||[]).length), 0);
          if (!canAtk || energyValue(a.attachedEnergy) < maxCost || !P.bench.some(Boolean)) attachEnergy(p, ei, 'active', null);
          else { const bi = P.bench.findIndex(Boolean); attachEnergy(p, ei, 'bench', bi); }
        }
      }
      // Attack: highest base damage affordable
      const a = P.active;
      const sp = a.special ?? a.status ?? null;
      if (O.active && sp !== 'paralyzed' && sp !== 'asleep') {
        const affordable = (a.attacks || []).filter(atk => canAffordAttack(a.attachedEnergy, atk.cost, a) && a.disabledAttack !== atk.name && atk.name !== 'Conversion 1' && atk.name !== 'Conversion 2' && !/Selfdestruct|Explosion|Destiny Bond/i.test(atk.name));
        if (affordable.length) {
          const best = affordable.reduce((b, atk) => (parseInt((atk.damage||'0').replace(/[^0-9]/g,''))||0) > (parseInt((b.damage||'0').replace(/[^0-9]/g,''))||0) ? atk : b);
          await performAttack(p, best);
          return;
        }
      }
      endTurn();
    },
  };`, 'simple-bot.js');

  // ── Scheduler: drives the virtual clock ───────────────────────────────────
  let running = true;
  let idleTicks = 0;
  (async function scheduler() {
    while (running) {
      await new Promise(r => setImmediate(r));
      if (!timers.length) { idleTicks++; continue; }
      idleTicks = 0;
      let bi = 0;
      for (let i = 1; i < timers.length; i++) {
        if (timers[i].at < timers[bi].at || (timers[i].at === timers[bi].at && timers[i].id < timers[bi].id)) bi = i;
      }
      const t = timers.splice(bi, 1)[0];
      vnow = t.at;
      try { t.fn(...t.a); } catch (e) { console.error('timer threw:', e); }
    }
  })();

  return {
    ctx, run, oldAI,
    H: run('__H'),
    simple: run('__SIMPLE'),
    stop() { running = false; },
    timersPending: () => timers.length,
    idle: () => idleTicks,
  };
}

// ── Decks ────────────────────────────────────────────────────────────────────
const CARDS = JSON.parse(fs.readFileSync(path.join(ROOT, 'cards.json'), 'utf8'));
const BY_ID = Object.fromEntries(CARDS.map(c => [c.id, c]));
const byName = (name, setPref) => {
  const hits = CARDS.filter(c => c.name === name);
  if (!hits.length) throw new Error(`No card named ${name}`);
  if (setPref) { const h = hits.find(c => c.set.id === setPref); if (h) return h; }
  return hits[0];
};

// Deck lists: [name, qty, setId?]
const DECKS = {
  haymaker: [
    ['Hitmonchan', 4], ['Electabuzz', 4], ['Scyther', 3], ['Magmar', 2, 'base3'],
    ['Bill', 4], ['Professor Oak', 3], ['Computer Search', 2], ['Gust of Wind', 3],
    ['Energy Removal', 4], ['Super Energy Removal', 2], ['PlusPower', 3], ['Switch', 2],
    ['Scoop Up', 1], ['Item Finder', 1],
    ['Fighting Energy', 10], ['Lightning Energy', 8], ['Double Colorless Energy', 4],
  ],
  raindance: [
    ['Squirtle', 4], ['Wartortle', 2], ['Blastoise', 3], ['Lapras', 2], ['Articuno', 2],
    ['Pokémon Breeder', 4], ['Professor Oak', 3], ['Bill', 4], ['Computer Search', 2],
    ['Energy Retrieval', 2], ['Gust of Wind', 2], ['Switch', 2], ['Pokémon Trader', 1],
    ['Item Finder', 2], ['Super Potion', 2],
    ['Water Energy', 23],
  ],
  wigglytuff: [
    ['Jigglypuff', 4], ['Wigglytuff', 3], ['Scyther', 3], ['Kangaskhan', 2], ['Lickitung', 2],
    ['Bill', 4], ['Professor Oak', 3], ['Computer Search', 2], ['Gust of Wind', 3],
    ['PlusPower', 2], ['Switch', 2], ['Energy Removal', 2], ['Super Energy Removal', 1],
    ['Poké Ball', 2], ['Defender', 1],
    ['Double Colorless Energy', 4], ['Grass Energy', 20],
  ],
  fire: [
    ['Charmander', 4], ['Charmeleon', 3], ['Charizard', 2], ['Growlithe', 3], ['Arcanine', 2], ['Magmar', 2, 'base3'],
    ['Bill', 3], ['Professor Oak', 3], ['Pokémon Breeder', 2], ['Computer Search', 2],
    ['Energy Retrieval', 2], ['Gust of Wind', 2], ['Switch', 2], ['Potion', 2], ['Defender', 1],
    ['Fire Energy', 23], ['Double Colorless Energy', 2],
  ],
  psychic: [
    ['Abra', 4], ['Kadabra', 2], ['Alakazam', 2], ['Mewtwo', 3], ['Jynx', 2], ['Chansey', 2], ['Mr. Mime', 2],
    ['Bill', 4], ['Professor Oak', 3], ['Computer Search', 2], ['Pokémon Breeder', 2],
    ['Gust of Wind', 2], ['Energy Removal', 2], ['Switch', 2], ['Scoop Up', 2], ['Potion', 2],
    ['Psychic Energy', 18], ['Double Colorless Energy', 4],
  ],
  grass: [
    ['Nidoran ♂', 4], ['Nidorino', 2], ['Nidoking', 2], ['Bulbasaur', 3], ['Ivysaur', 2], ['Venusaur', 1], ['Scyther', 2],
    ['Bill', 3], ['Professor Oak', 3], ['Pokémon Breeder', 3], ['Computer Search', 2],
    ['Gust of Wind', 2], ['Switch', 2], ['Potion', 2], ['Defender', 2], ['Pokémon Trader', 1],
    ['Grass Energy', 24],
  ],
};

function buildDeck(listName, rng) {
  const list = DECKS[listName];
  if (!list) throw new Error(`Unknown deck ${listName}`);
  const out = [];
  for (const [name, qty, setPref] of list) {
    const c = byName(name, setPref);
    for (let i = 0; i < qty; i++) out.push(c);
  }
  if (out.length !== 60) throw new Error(`Deck ${listName} has ${out.length} cards, expected 60`);
  return out;
}

// ── One game ─────────────────────────────────────────────────────────────────
async function playGame(eng, { deck1, deck2, agent1, agent2, diff, maxTurns, tag }) {
  const { run, H } = eng;
  const flat = (deck, p) => deck.map((c, i) => H.enrich({
    ...c,
    uid: `p${p}-${c.id}-${i}`,
    damage: 0, attachedEnergy: [], status: null, special: null, poison: null, burn: false,
    defender: false, plusPower: 0,
  }));

  // Fresh game state, mirroring game-init.js's initial G.
  run(`G = {
    started: false, turn: 1, phase: 'DRAW', turnNum: 1, energyPlayedThisTurn: false,
    plusPowerThisTurn: false, pendingAction: null, evolvedThisTurn: [],
    players: {
      1: { name:'P1', deck:[], hand:[], active:null, bench:[null,null,null,null,null], prizes:[], discard:[], deckData:{name:'d1'}, mulligans:0 },
      2: { name:'P2', deck:[], hand:[], active:null, bench:[null,null,null,null,null], prizes:[], discard:[], deckData:{name:'d2'}, mulligans:0 }
    },
    log: []
  }; myRole = null; roomCode = null; gameRef = null;`);
  const G = H.G;
  H.vsComputer = true;
  H.aiDifficulty = diff;
  H.aiThinking = false;
  if (eng.oldAI) { eng.oldAI.setDiff(diff); eng.oldAI.resetThinking(); }

  const shuffle = run('shuffle');
  G.players[1].deck = shuffle(flat(deck1, 1));
  G.players[2].deck = shuffle(flat(deck2, 2));

  const agents = { 1: agent1, 2: agent2 };

  await run('startGame')();           // deals hands + prizes, phase SETUP
  agents[1].setup(1);
  agents[2].setup(2);
  if (!G.players[1].active || !G.players[2].active) {
    return { winner: 0, reason: 'SETUP_FAIL', turns: 0 };
  }

  // Replicate doneSetup without the DOM/AI kick-off.
  const heads = run('Math.random()') < 0.5;    // context RNG (seeded) so runs reproduce
  const first = heads ? 1 : 2;
  G.phase = 'DRAW'; G.turn = first; G.turnNum = 1; G.energyPlayedThisTurn = false;
  G._setupAdvancing = false; G._doneSetupRunning = false;
  const drawCard = run('drawCard');
  const extras = G.pendingExtraDraws?.[first] || 0;
  if (extras > 0) G.pendingExtraDraws[first] = 0;
  for (let i = 0; i <= extras; i++) drawCard(first, true);

  const settle = async (pred, label) => {
    let spins = 0;
    while (!pred()) {
      await new Promise(r => setImmediate(r));
      if (eng.timersPending() === 0 && eng.idle() > 200) {
        throw new Error(`STALL waiting for ${label} (turn ${G.turnNum}, phase ${G.phase}, turn player ${G.turn})`);
      }
      if (++spins > 2_000_000) throw new Error(`Runaway settle: ${label}`);
    }
  };

  let turns = 0, promoteStalls = 0;
  const started = Date.now();
  while (G.started && turns < maxTurns) {
    if (Date.now() - started > 20000) return { winner: 0, reason: 'TIMEOUT', turns };
    if (G.phase === 'PROMOTE') {
      const who = G.pendingPromotion;
      const before = `${G.turnNum}|${G.players[who].active?.uid || ''}|${G.players[who].bench.map(b => b?.uid || '').join(',')}`;
      if (process.env.SIM_DEBUG) console.log(`[sim] PROMOTE for P${who}: bench=${G.players[who].bench.map(b => b ? b.name : '-').join(',')} active=${G.players[who].active?.name} turn=${G.turn} started=${G.started}`);
      agents[who].promote(who);
      // Promotion is synchronous; flush timers/microtasks, then verify the
      // board actually changed (a between-turns poison KO can legitimately
      // ask the SAME player to promote again right away).
      for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
      const after = `${G.turnNum}|${G.players[who].active?.uid || ''}|${G.players[who].bench.map(b => b?.uid || '').join(',')}`;
      if (process.env.SIM_DEBUG) console.log(`[sim] after promote: phase=${G.phase} pending=${G.pendingPromotion} active=${G.players[who].active?.name} turn=${G.turn}`);
      if (G.started && G.phase === 'PROMOTE' && G.pendingPromotion === who && before === after) {
        if (++promoteStalls > 3) throw new Error(`STALL waiting for promotion (P${who}) (turn ${G.turnNum})`);
      } else promoteStalls = 0;
      continue;
    }
    const cur = G.turn;
    const startTurnNum = G.turnNum;
    turns++;
    H.aiThinking = false;
    await agents[cur].takeTurn(cur);
    await settle(() => !G.started || G.phase === 'PROMOTE' || G.turnNum !== startTurnNum, `turn end (P${cur})`);
  }
  if (!G.started && G.winner) return { winner: G.winner, reason: G.winReason, turns, log: G.log };
  return { winner: 0, reason: 'TURN_LIMIT', turns, log: G.log };
}

// ── Agent factories ──────────────────────────────────────────────────────────
function makeAgent(kind, eng) {
  const { H, run, oldAI, simple } = eng;
  if (kind === 'simple') {
    return {
      kind,
      setup: p => simple.setup(p),
      promote: p => simple.promote(p),
      takeTurn: p => simple.takeTurn(p),
    };
  }
  if (kind === 'old') {
    if (!oldAI) throw new Error('old AI not loaded');
    return {
      kind,
      setup: p => { if (p !== 2) throw new Error('old AI can only sit in seat 2'); oldAI.setup(); },
      promote: () => oldAI.promote(),
      takeTurn: async () => { oldAI.resetThinking(); await oldAI.takeTurn(); },
    };
  }
  if (kind === 'new') {
    const aiDoSetup = run('aiDoSetup'), aiTakeTurn = run('aiTakeTurn'), aiDoPromotion = run('aiDoPromotion');
    if (!H.hasAiPlayerNum()) {
      // Working-tree AI is not yet player-parametric: seat 2 only.
      return {
        kind,
        setup: p => { if (p !== 2) throw new Error('working-tree AI is not player-parametric yet (seat 2 only)'); aiDoSetup(); },
        promote: () => aiDoPromotion(),
        takeTurn: async () => { H.aiThinking = false; await aiTakeTurn(); },
      };
    }
    return {
      kind,
      setup: p => { H.setAiPlayer(p); aiDoSetup(); },
      promote: p => { H.setAiPlayer(p); aiDoPromotion(); },
      takeTurn: async p => { H.setAiPlayer(p); H.aiThinking = false; await aiTakeTurn(); },
    };
  }
  throw new Error(`Unknown agent ${kind}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const rng = mulberry32(OPTS.seed);
  const needOld = OPTS.p1 === 'old' || OPTS.p2 === 'old';
  const eng = loadEngine({ oldRef: needOld ? OPTS.oldRef : null, rng });
  const deckNames = OPTS.decks === 'all' ? Object.keys(DECKS) : OPTS.decks.split(',');
  const decks = Object.fromEntries(deckNames.map(n => [n, buildDeck(n, rng)]));

  const agent1 = makeAgent(OPTS.p1, eng);
  const agent2 = makeAgent(OPTS.p2, eng);

  const results = [];
  let gameNo = 0;
  const t0 = Date.now();
  for (const d1 of deckNames) {
    for (const d2 of deckNames) {
      for (let g = 0; g < OPTS.games; g++) {
        gameNo++;
        let r;
        try {
          r = await playGame(eng, { deck1: decks[d1], deck2: decks[d2], agent1, agent2, diff: OPTS.diff, maxTurns: OPTS.maxTurns });
        } catch (e) {
          r = { winner: 0, reason: 'ERROR: ' + (e && e.message || e), turns: 0, log: eng.H.G?.log };
          if (OPTS.verbose) console.error(e);
        }
        r.d1 = d1; r.d2 = d2; r.no = gameNo;
        results.push(r);
        if (OPTS.verbose) console.log(`#${gameNo} ${d1} vs ${d2}: winner P${r.winner} (${r.reason}) in ${r.turns} turns`);
        if (OPTS.logGame && String(gameNo) === String(OPTS.logGame)) {
          console.log(`\n── LOG of game #${gameNo} (${d1} vs ${d2}) ──`);
          for (const l of (r.log || [])) console.log(`[T${l.turn}] ${l.msg}`);
          console.log('');
        }
      }
    }
  }
  eng.stop();

  // ── Report ────────────────────────────────────────────────────────────────
  const total = results.length;
  const p1w = results.filter(r => r.winner === 1).length;
  const p2w = results.filter(r => r.winner === 2).length;
  const errs = results.filter(r => /^ERROR/.test(r.reason));
  const stalls = results.filter(r => r.reason === 'TURN_LIMIT' || r.reason === 'TIMEOUT');
  const avgTurns = results.reduce((s, r) => s + r.turns, 0) / Math.max(1, total);
  console.log(`\n═══ ${OPTS.p1.toUpperCase()} (P1) vs ${OPTS.p2.toUpperCase()} (P2) — difficulty ${OPTS.diff}, ${total} games in ${((Date.now() - t0) / 1000).toFixed(1)}s ═══`);
  console.log(`P1 (${OPTS.p1}) wins: ${p1w} (${(100 * p1w / total).toFixed(1)}%)`);
  console.log(`P2 (${OPTS.p2}) wins: ${p2w} (${(100 * p2w / total).toFixed(1)}%)`);
  console.log(`no result: ${total - p1w - p2w} (errors ${errs.length}, turn-limit/timeouts ${stalls.length}), avg turns ${avgTurns.toFixed(1)}`);
  const reasons = {};
  for (const r of results) { const k = r.reason.replace(/\(.*$/, '').slice(0, 60); reasons[k] = (reasons[k] || 0) + 1; }
  console.log('end reasons:', reasons);
  console.log('\nBy matchup (P1 deck → P2 deck: P1 wins / P2 wins):');
  for (const d1 of deckNames) {
    const row = deckNames.map(d2 => {
      const rs = results.filter(r => r.d1 === d1 && r.d2 === d2);
      return `${d2.padStart(10)}: ${String(rs.filter(r => r.winner === 1).length).padStart(2)}/${String(rs.filter(r => r.winner === 2).length).padEnd(2)}`;
    }).join('  ');
    console.log(`${d1.padEnd(10)} → ${row}`);
  }
  if (errs.length) {
    console.log('\nFirst errors:');
    for (const e of errs.slice(0, 5)) console.log(`  #${e.no} ${e.d1} vs ${e.d2}: ${e.reason}`);
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { loadEngine, playGame, makeAgent, buildDeck, DECKS };
