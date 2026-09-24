// ══════════════════════════════════════════════════════════════════════════════
// GAME-INIT.JS — Firebase init, auth, lobby, multiplayer sync, drag-and-drop,
//                deck loading, game state G, push/receive state, init.
//
// Extracted from the inline <script> in pokemon-game.html. Loads AFTER all
// other modules so it can call functions from game-utils, game-render,
// game-actions, game-ai, pokemon-powers, trainer-cards, and move-effects.
//
// Architecture rule (still enforced): functions defined here MUST NOT also
// be defined in any other .js file or inline anywhere — duplicate declarations
// silently shadow each other and cause regressions. See push_to_github.sh.
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════
// FIREBASE
// ══════════════════════════════════════════════════
const firebaseConfig = {
  apiKey: "AIzaSyBw2KlsuxDum68R8H_ZehtEeWVlT-7zD9s",
  authDomain: "p-tcg-a6b2c.firebaseapp.com",
  databaseURL: "https://p-tcg-a6b2c-default-rtdb.firebaseio.com",
  projectId: "p-tcg-a6b2c",
  storageBucket: "p-tcg-a6b2c.firebasestorage.app",
  messagingSenderId: "660283340232",
  appId: "1:660283340232:web:68722a7b5f60de8cda7cfd"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();
const auth = firebase.auth();

// ══════════════════════════════════════════════════
// AUTH STATE
// ══════════════════════════════════════════════════
// Sign-in is OPTIONAL — guests can play without signing in.
// Signed-in trainers get persistent W/L records and named multiplayer rooms.
//
// State summary:
//   currentUser   — Firebase user object, or null when guest
//   trainerName   — display name; falls back to 'Guest' when not signed in
//   _authInFlight — guard against double-clicks during sign-in/up
//   _authMode     — 'signin' | 'signup' (toggles login form behavior)
//
// onAuthStateChanged below is intentionally NON-BLOCKING on its DB reads:
// if Firebase rules reject `users/{uid}/...` reads, the lobby still appears —
// it just shows email-prefix as the name and a default 0/0 record. Do NOT
// make the screen-swap depend on a successful read; that's the bug that froze
// the screen on the first version of this feature.
let currentUser   = null;
let trainerName   = 'Guest';
let _authInFlight = false;
let _authMode     = 'signin';

auth.onAuthStateChanged(async user => {
  // Anonymous sessions are guests: no badge, no record, no leaderboard entry.
  if (user && !user.isAnonymous) {
    currentUser = user;
    _authInFlight = false;
    // Show lobby immediately — don't block on DB reads
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('setup-screen').style.display = '';
    document.getElementById('trainer-badge').style.display = '';
    document.getElementById('guest-badge').style.display = 'none';
    // Best-effort: load name
    try {
      const nameSnap = await db.ref(`users/${user.uid}/name`).once('value');
      trainerName = nameSnap.val() || user.email.split('@')[0];
    } catch (e) {
      trainerName = user.email.split('@')[0];
    }
    // Best-effort: load W/L record
    try {
      const recSnap = await db.ref(`users/${user.uid}/record`).once('value');
      const rec = recSnap.val() || { wins: 0, losses: 0 };
      document.getElementById('trainer-record').textContent = `W: ${rec.wins || 0} / L: ${rec.losses || 0}`;
      // Mirror into the public leaderboard node so accounts created before
      // the leaderboard existed appear on it the next time they sign in.
      publishLeaderboardEntry(trainerName, rec);
    } catch (e) { /* rules may not allow read yet */ }
    document.getElementById('trainer-name-display').textContent = trainerName;
  } else {
    currentUser = null;
    trainerName = 'Guest';
    // Guest mode — lobby stays visible; login screen hidden unless user clicks "sign in"
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('setup-screen').style.display = '';
    document.getElementById('trainer-badge').style.display = 'none';
    document.getElementById('guest-badge').style.display = '';
    // Guests still need a Firebase identity once the database rules require
    // `auth != null` for writes (see database.rules.json). Anonymous sign-in is
    // silent and needs no UI; if the Anonymous provider isn't enabled in the
    // Firebase console this fails quietly and everything works as before.
    if (!user) auth.signInAnonymously().catch(() => {});
  }
});

function showLoginScreen() {
  document.getElementById('setup-screen').style.display = 'none';
  document.getElementById('login-screen').style.display = '';
  document.getElementById('login-error').textContent = '';
}

function cancelLogin() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('setup-screen').style.display = '';
}

function setAuthMode(mode) {
  _authMode = mode;
  const nameRow   = document.getElementById('login-name-row');
  const submitBtn = document.getElementById('login-submit');
  const toggle    = document.getElementById('login-mode-toggle');
  const pwInput   = document.getElementById('login-password');
  const forgot    = document.getElementById('login-forgot');
  if (forgot) forgot.style.display = (mode === 'signup') ? 'none' : '';
  if (mode === 'signup') {
    nameRow.style.display = '';
    submitBtn.textContent = 'CREATE ACCOUNT →';
    toggle.innerHTML = 'Already have an account? <a onclick="setAuthMode(\'signin\')">Sign in</a>';
    pwInput.placeholder = 'Choose a password (6+ chars)';
  } else {
    nameRow.style.display = 'none';
    submitBtn.textContent = 'SIGN IN →';
    toggle.innerHTML = 'No account? <a onclick="setAuthMode(\'signup\')">Create one</a>';
    pwInput.placeholder = '••••••••';
  }
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  errEl.classList.remove('ok');
}

// "Forgot password?" — Firebase emails a reset link to the address in the
// email field (the reset page itself is hosted by Firebase Auth). The message
// is deliberately the same whether or not an account exists, so the form
// can't be used to probe which emails are registered.
async function sendPasswordReset() {
  if (_authInFlight) return;
  const email = document.getElementById('login-email').value.trim();
  const errEl = document.getElementById('login-error');
  errEl.classList.remove('ok');
  if (!email) { errEl.textContent = 'Enter your email above, then click Forgot password.'; return; }
  _authInFlight = true;
  errEl.textContent = 'Sending reset email…';
  try {
    await auth.sendPasswordResetEmail(email);
    errEl.classList.add('ok');
    errEl.textContent = `If an account exists for ${email}, a reset link is on its way. Check spam too.`;
  } catch (e) {
    // Email-enumeration protection off: Firebase reports unknown addresses.
    // Show the same neutral message so the behaviour matches either setting.
    if (e.code === 'auth/user-not-found') {
      errEl.classList.add('ok');
      errEl.textContent = `If an account exists for ${email}, a reset link is on its way. Check spam too.`;
    } else {
      errEl.textContent = friendlyAuthError(e.code);
    }
  } finally {
    _authInFlight = false;
  }
}

async function doLoginOrSignup() {
  if (_authInFlight) return;
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl    = document.getElementById('login-error');
  const btn      = document.getElementById('login-submit');

  errEl.classList.remove('ok');
  if (!email || !password) { errEl.textContent = 'Enter email and password.'; return; }

  if (_authMode === 'signup') {
    const name = document.getElementById('login-name').value.trim();
    if (!name) { errEl.textContent = 'Enter a trainer name.'; return; }
    if (password.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; return; }
    errEl.textContent = '';
    _authInFlight = true;
    btn.disabled = true;
    btn.textContent = 'Creating account…';
    try {
      const cred = await auth.createUserWithEmailAndPassword(email, password);
      // Best-effort: persist trainer name + initial record
      try { await db.ref(`users/${cred.user.uid}/name`).set(name); } catch (e) {}
      try { await db.ref(`users/${cred.user.uid}/record`).set({ wins: 0, losses: 0 }); } catch (e) {}
      publishLeaderboardEntry(name, { wins: 0, losses: 0 });
      // onAuthStateChanged handles the UI swap
    } catch (e) {
      errEl.textContent = friendlyAuthError(e.code);
      _authInFlight = false;
      btn.disabled = false;
      btn.textContent = 'CREATE ACCOUNT →';
    }
  } else {
    errEl.textContent = '';
    _authInFlight = true;
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      await auth.signInWithEmailAndPassword(email, password);
      // onAuthStateChanged handles the UI swap
    } catch (e) {
      errEl.textContent = friendlyAuthError(e.code);
      _authInFlight = false;
      btn.disabled = false;
      btn.textContent = 'SIGN IN →';
    }
  }
}

function doSignOut() {
  auth.signOut();
  setAuthMode('signin');
  const ids = ['login-email', 'login-password', 'login-name'];
  ids.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
}

function friendlyAuthError(code) {
  switch (code) {
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential':  return 'Invalid email or password.';
    case 'auth/too-many-requests':   return 'Too many attempts. Try again later.';
    case 'auth/invalid-email':       return 'Invalid email address.';
    case 'auth/email-already-in-use':return 'That email is already registered.';
    case 'auth/weak-password':       return 'Password must be at least 6 characters.';
    case 'auth/missing-email':       return 'Enter your email address.';
    case 'auth/network-request-failed': return 'Network error. Check your connection and try again.';
    default: return 'Sign in failed. Check your credentials.';
  }
}

// ── Record win/loss after a game ends ─────────────
// Called from game-render.js showWinScreen(). No-op if not signed in.
async function recordResult(didWin) {
  if (!currentUser) return;
  try {
    const ref  = db.ref(`users/${currentUser.uid}/record`);
    const snap = await ref.once('value');
    const rec  = snap.val() || { wins: 0, losses: 0 };
    if (didWin) rec.wins   = (rec.wins   || 0) + 1;
    else        rec.losses = (rec.losses || 0) + 1;
    await ref.set(rec);
    const badge = document.getElementById('trainer-record');
    if (badge) badge.textContent = `W: ${rec.wins} / L: ${rec.losses}`;
    publishLeaderboardEntry(trainerName, rec);
  } catch (e) {
    console.warn('[recordResult] failed:', e);
  }
}

// ══════════════════════════════════════════════════
// LEADERBOARD
// ══════════════════════════════════════════════════
// The private per-user record lives at users/{uid}/record, which other
// clients can't read. The leaderboard is a separate, public mirror at
// leaderboard/{uid} = { name, wins, losses, updatedAt } that each client
// writes for ITS OWN uid only. Required Realtime Database rules:
//
//   "leaderboard": {
//     ".read": true,
//     "$uid": {
//       ".write": "auth != null && auth.uid === $uid",
//       ".validate": "newData.hasChildren(['name', 'wins', 'losses'])"
//     }
//   }
//
// Every call is best-effort: if the rules aren't in place yet, nothing
// else changes and the panel explains what's missing.
async function publishLeaderboardEntry(name, rec) {
  if (!currentUser) return;
  try {
    await db.ref(`leaderboard/${currentUser.uid}`).set({
      name: String(name || 'Trainer').slice(0, 20),
      wins: Number(rec?.wins) || 0,
      losses: Number(rec?.losses) || 0,
      updatedAt: firebase.database.ServerValue.TIMESTAMP,
    });
  } catch (e) {
    console.warn('[leaderboard] publish failed:', e?.code || e);
  }
}

// Sort order: most wins, then best win rate, then fewest losses, then name.
function sortLeaderboard(entries) {
  const pct = e => (e.wins + e.losses) ? e.wins / (e.wins + e.losses) : 0;
  return entries.sort((a, b) =>
    (b.wins - a.wins) || (pct(b) - pct(a)) || (a.losses - b.losses) || a.name.localeCompare(b.name));
}

const LEADERBOARD_MAX_ROWS = 25;

async function showLeaderboard() {
  showPanel('leaderboard-panel');
  const list = document.getElementById('leaderboard-list');
  list.innerHTML = `<div class="lb-empty">Loading…</div>`;
  let raw;
  try {
    raw = (await db.ref('leaderboard').once('value')).val() || {};
  } catch (e) {
    const denied = /permission/i.test(String(e?.code || e?.message || e));
    list.innerHTML = `<div class="lb-empty">${denied
      ? 'The leaderboard isn\'t enabled yet — the database rules need to allow reading <code>leaderboard</code>.'
      : 'Couldn\'t load the leaderboard. Check your connection and try again.'}</div>`;
    return;
  }
  const entries = Object.entries(raw).map(([uid, v]) => ({
    uid,
    name: String(v?.name || 'Trainer'),
    wins: Number(v?.wins) || 0,
    losses: Number(v?.losses) || 0,
  })).filter(e => e.wins + e.losses > 0 || e.uid === currentUser?.uid);
  if (!entries.length) {
    list.innerHTML = `<div class="lb-empty">No games recorded yet. Sign in and win an online match to claim the top spot.</div>`;
    return;
  }
  sortLeaderboard(entries);
  const rows = entries.slice(0, LEADERBOARD_MAX_ROWS).map((e, i) => {
    const games = e.wins + e.losses;
    const pct = games ? Math.round(100 * e.wins / games) : 0;
    const me = currentUser && e.uid === currentUser.uid;
    return `<div class="lb-row${me ? ' lb-me' : ''}">
      <span class="lb-rank">${i + 1}</span>
      <span class="lb-name" title="${escapeHtml(e.name)}">${escapeHtml(e.name)}${me ? ' (you)' : ''}</span>
      <span class="lb-wins">${e.wins}</span>
      <span class="lb-losses">${e.losses}</span>
      <span class="lb-pct">${pct}%</span>
    </div>`;
  }).join('');
  list.innerHTML = `<div class="lb-row lb-head"><span>#</span><span>TRAINER</span><span class="lb-wins">W</span><span class="lb-losses">L</span><span class="lb-pct">WIN%</span></div>${rows}`;
}

// ══════════════════════════════════════════════════
// GAME STATE
// ══════════════════════════════════════════════════
let G = {
  started: false,
  turn: 1,
  phase: 'DRAW',
  turnNum: 1,
  energyPlayedThisTurn: false,
  plusPowerThisTurn: false,
  pendingAction: null,
  players: {
    1: { name:'Player 1', deck:[], hand:[], active:null, bench:[null,null,null,null,null], prizes:[], discard:[], deckData:null, mulligans:0 },
    2: { name:'Player 2', deck:[], hand:[], active:null, bench:[null,null,null,null,null], prizes:[], discard:[], deckData:null, mulligans:0 }
  },
  log: []
};

// ══════════════════════════════════════════════════
// DECK LOADING
// ══════════════════════════════════════════════════
let loadingForPlayer = 0;

async function openLoadModal(player) {
  loadingForPlayer = player;
  const list = document.getElementById('saved-decks-list');
  const psel = document.getElementById('player-select');
  if (player === 1 || player === 2) {
    document.querySelectorAll('.player-opt').forEach(b => b.classList.remove('sel'));
    document.querySelector(`.player-opt.p${player}`).classList.add('sel');
    psel.style.display = 'none';
  } else {
    psel.style.display = 'flex';
    document.querySelectorAll('.player-opt').forEach(b => b.classList.remove('sel'));
  }
  list.innerHTML = `<div class="no-saved">Loading decks...</div>`;
  document.getElementById('load-modal').classList.add('show');
  try {
    const snap = await db.ref('decks').once('value');
    const data = snap.val() || {};
    if (!Object.keys(data).length) {
      list.innerHTML = `<div class="no-saved">No saved decks. <a href="deck-builder.html" style="color:var(--accent)">Build one first →</a></div>`;
    } else {
      function isLegacyDeck(node) { return node && typeof node === 'object' && node.deck && node.name; }

      // Build folder map — legacy flat decks go into _uncategorized
      const folders = {};
      for (const [fKey, node] of Object.entries(data)) {
        if (isLegacyDeck(node)) {
          if (!folders['_uncategorized']) folders['_uncategorized'] = { displayName: 'Uncategorized', decks: [] };
          folders['_uncategorized'].decks.push(node);
        } else if (node && typeof node === 'object' && !node.deck) {
          const children = Object.values(node).filter(v => isLegacyDeck(v));
          const displayName = children.find(v => v.folder)?.folder || fKey;
          folders[fKey] = { displayName, decks: children };
        }
      }

      function renderFolders() {
        const folderKeys = Object.keys(folders).sort();
        list.innerHTML = folderKeys.map(fKey => {
          const { displayName, decks } = folders[fKey];
          const icon = fKey === '_uncategorized' ? '📂' : '📁';
          return `<div class="modal-deck-item" data-fkey="${escapeAttr(fKey)}" data-fname="${escapeAttr(displayName)}">
            <div>
              <div class="d-name">${icon} ${escapeHtml(displayName)}</div>
              <div class="d-count">${decks.length} deck${decks.length !== 1 ? 's' : ''}</div>
            </div>
            <span style="color:var(--muted);font-size:18px">›</span>
          </div>`;
        }).join('');
        list.querySelectorAll('.modal-deck-item').forEach(el => {
          el.addEventListener('click', () => renderDeckList(el.dataset.fkey, el.dataset.fname));
        });
      }

      function renderDeckList(fKey, displayName) {
        const entries = (folders[fKey]?.decks || []).sort((a,b) => b.savedAt - a.savedAt);
        list.innerHTML =
          `<div class="modal-deck-item modal-back-item">
            <div class="d-name">← ${escapeHtml(displayName)}</div>
          </div>` +
          (entries.length ? entries.map(d => {
            const total = Object.values(d.deck).reduce((s,c) => s + c.qty, 0);
            return `<div class="modal-deck-item" data-fkey="${escapeAttr(fKey)}" data-name="${escapeAttr(d.name)}">
              <div>
                <div class="d-name">${escapeHtml(d.name)}</div>
                <div class="d-count">${total} cards</div>
              </div>
              <span style="color:var(--muted);font-size:18px">›</span>
            </div>`;
          }).join('') : `<div class="no-saved">No decks in this folder.</div>`);
        list.querySelector('.modal-back-item').addEventListener('click', () => renderFolders());
        list.querySelectorAll('.modal-deck-item[data-name]').forEach(el => {
          el.addEventListener('click', () => loadDeck(el.dataset.fkey, el.dataset.name));
        });
      }
      renderFolders();
    }
  } catch(e) {
    list.innerHTML = `<div class="no-saved" style="color:var(--p2color)">Could not connect to Firebase.</div>`;
    console.error('Firebase error:', e);
  }
}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escapeAttr(str) {
  return String(str).replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function selectPlayer(p) {
  loadingForPlayer = p;
  document.querySelectorAll('.player-opt').forEach(b => b.classList.remove('sel'));
  document.querySelector(`.player-opt.p${p}`).classList.add('sel');
}
function closeLoadModal() {
  document.getElementById('load-modal').classList.remove('show');
}

// ── Load a random deck from Firebase for the given player slot ──────────────
// Walks the same folder structure as openLoadModal() — both legacy flat decks
// (under decks/<name>) and folder-grouped decks (under decks/<folder>/<name>).
// Picks one uniformly at random and routes through loadDeck() so the slot UI,
// broadcast, and in-memory deck state all update consistently.
async function loadRandomDeck(player) {
  loadingForPlayer = player;
  showToast('🎲 Picking a random deck...');
  try {
    const snap = await db.ref('decks').once('value');
    const data = snap.val() || {};
    function isLegacyDeck(node) { return node && typeof node === 'object' && node.deck && node.name; }
    // Collect every (fKey, deckName) pair across both layouts.
    const all = [];
    for (const [fKey, node] of Object.entries(data)) {
      if (isLegacyDeck(node)) {
        all.push({ fKey: '_uncategorized', deckName: node.name });
      } else if (node && typeof node === 'object' && !node.deck) {
        for (const child of Object.values(node)) {
          if (isLegacyDeck(child)) all.push({ fKey, deckName: child.name });
        }
      }
    }
    if (!all.length) {
      showToast('No decks found! Build one in the deck builder first.', true);
      return;
    }
    const pick = all[Math.floor(Math.random() * all.length)];
    await loadDeck(pick.fKey, pick.deckName, player);
  } catch (e) {
    showToast('Error picking random deck', true);
    console.error('loadRandomDeck error:', e);
  }
}

async function loadDeck(fKey, deckName, forPlayer = loadingForPlayer) {
  // `forPlayer` is captured by the caller BEFORE any await: loadRandomDeck used
  // to read the shared `loadingForPlayer` global after its Firebase fetch, so
  // clicking P1 RANDOM then P2 RANDOM back to back loaded both decks into P2.
  const p = forPlayer;
  if (!p) { showToast('Select a player first', true); return; }
  const key = deckName.replace(/[.#$[\]]/g, '_');
  closeLoadModal();
  showToast(`Loading ${deckName}...`);
  try {
    const path = fKey === '_uncategorized'
      ? `decks/${key}`
      : `decks/${fKey}/${key}`;
    const snap = await db.ref(path).once('value');
    const d = snap.val();
    if (!d) { showToast('Deck not found', true); return; }
    // The game in this room started while the deck was fetching (a rejoin
    // racing P1's START). The zones below are live now — leave them alone.
    if (G.started && roomCode) { console.warn('[loadDeck] game already started — not replacing live zones'); return; }
    const flat = [];
    for (const entry of Object.values(d.deck)) {
      // Never trust stored card fields — rebuild from the catalogue (see
      // cardFromDeckEntry in game-utils.js for why).
      const card = cardFromDeckEntry(entry, CARD_DATA);
      const qty = Math.max(0, Math.min(60, parseInt(entry.qty) || 0));
      for (let i = 0; i < qty; i++) {
        flat.push(enrichCard({ ...card, uid: `${card.id}-${Math.random().toString(36).slice(2,7)}` }));
      }
    }
    if (!flat.length) { showToast('Deck appears empty!', true); return; }
    G.players[p].deckData = { name: deckName, folderKey: fKey };
    G.players[p].deck = shuffle([...flat]);
    G.players[p].hand = [];
    G.players[p].active = null;
    G.players[p].bench = [null,null,null,null,null];
    G.players[p].prizes = [];
    G.players[p].discard = [];
    const statusEl = document.getElementById(`p${p}-deck-status`);
    if (statusEl) {
      statusEl.textContent = `✓ ${deckName} (${flat.length} cards)`;
      statusEl.style.color = p === 1 ? 'var(--p1color)' : 'var(--p2color)';
      document.querySelector(`.setup-player.p${p}`)?.classList.add('loaded');
    }
    broadcastDeckReady(p, deckName, fKey);
    showToast(`${deckName} loaded for Player ${p}!`, false, 'ok');
    updateDeckCounts();
  } catch(e) {
    showToast('Error loading deck', true);
    console.error('loadDeck error:', e);
  }
}

// ══════════════════════════════════════════════════
// GAME START
// ══════════════════════════════════════════════════
function hasBasic(hand) {
  return hand.some(c => c.supertype === 'Pokémon' && c.subtypes?.includes('Basic'));
}

let _startGameRunning = false;
async function startGame() {
  // Re-entrancy guard: this awaits Firebase reads and a deck load, so a double
  // click on START dealt hands and prizes twice from the same deck.
  if (_startGameRunning || G.started) return;
  _startGameRunning = true;
  try {
    await _startGameInner();
  } finally {
    _startGameRunning = false;
  }
}

async function _startGameInner() {
  // In networked mode, P1 needs to load P2's deck from Firebase first
  if (myRole === 1 && gameRef) {
    const snap = await gameRef.once('value');
    const data = snap.val();
    if (!data) { showToast('Room no longer exists — create a new one.', true); return; }
    // Our own deck must be loaded IN THIS ROOM (broadcast as p1Ready) and still
    // held locally. A stale "✓ deck loaded" slot from a previous room used to
    // pass straight through here and deal from an empty deck.
    if (!data.p1Ready || !G.players[1].deckData || !G.players[1].deck.length) {
      showToast('Load your deck first!', true);
      checkBothReady(data);
      return;
    }
    if (!data.p2Ready || !data.p2DeckName) {
      showToast("Player 2 hasn't loaded a deck yet!", true);
      checkBothReady(data);
      return;
    }
    if (!G.players[2].deckData) {
      // Load P2's deck silently
      showToast('Loading P2 deck...', false);
      const saved = loadingForPlayer;
      loadingForPlayer = 2;
      await loadDeck(data.p2DeckFolder || '', data.p2DeckName, 2);
      loadingForPlayer = saved;
      if (!G.players[2].deckData || !G.players[2].deck.length) {
        showToast("Couldn't load Player 2's deck — ask them to load it again.", true);
        return;
      }
    }
  } else if (!G.players[1].deck.length || !G.players[2].deck.length) {
    showToast('Both players need a deck first!', true);
    return;
  }

  let mulligans = { 1: 0, 2: 0 };
  for (const p of [1,2]) {
    G.players[p].hand = G.players[p].deck.splice(0, 7);
    let attempts = 0;
    while (!hasBasic(G.players[p].hand) && attempts < 4) {
      G.players[p].deck = shuffle([...G.players[p].deck, ...G.players[p].hand]);
      G.players[p].hand = G.players[p].deck.splice(0, 7);
      attempts++; mulligans[p]++;
    }
    G.players[p].prizes = G.players[p].deck.splice(0, 6).map(c => ({ card: c, revealed: false }));
  }

  G.started = true;
  G.turn = 1;
  G.phase = 'SETUP';
  G.turnNum = 0;
  G.energyPlayedThisTurn = false;
  // Fresh game (incl. rematch) — clear any leftover handoff-guard state.
  _preserveOwnPrivateZones = false;
  document.getElementById('setup-screen').style.display = 'none';
  document.getElementById('end-turn-btn').textContent = 'DONE SETUP';

  addLog('Game started! Both players place their starting Pokémon.', true);
  if (mulligans[1] > 0) addLog(`P1 mulliganed ${mulligans[1]} time(s) — opponent draws ${mulligans[1]} extra card(s) next turn.`);
  if (mulligans[2] > 0) addLog(`P2 mulliganed ${mulligans[2]} time(s) — opponent draws ${mulligans[2]} extra card(s) next turn.`);
  G.pendingExtraDraws = mulligans;

  addLog('Each player drew 7 cards and set aside 6 prizes.');
  renderAll();
  const isMP = myRole !== null && !vsComputer;
  setMidline(isMP
    ? 'Place your Active Pokémon (and optional bench), then click READY'
    : 'Both players: place your Active Pokémon (and optionally bench basics)');
  showSetupFlash('SETUP', 'Place your Starting Pokémon',
    isMP ? "then click I'M READY (or DONE SETUP)" : 'then click DONE SETUP');
}

function handleEndTurnBtn() {
  if (G.phase === 'SETUP') {
    // An advance is already running (coin flip in progress). Ignore extra clicks
    // so an impatient player can't toggle their own READY flag back off, or kick
    // off a second advance, while the handshake is resolving.
    if (G._setupAdvancing || G._doneSetupRunning) return;
    // This click is a user gesture — the one chance to request OS-notification
    // permission and unlock audio for the "your turn" nudge. Harmless if denied.
    if (typeof ensureTurnNotifications === 'function') ensureTurnNotifications();
    // In multiplayer, the SETUP button toggles the local ready flag instead
    // of advancing directly. P1's listener auto-advances when both flags are
    // true (see maybeAutoAdvanceSetup). vsComputer / single-player still
    // calls doneSetup() directly — AI setup is synchronous from P1's view.
    if (myRole !== null && !vsComputer) {
      toggleSetupReady();
    } else {
      doneSetup();
    }
  } else {
    if (G.phase === 'PROMOTE') {
      showToast(G.pendingPromotion === myRole ? 'Choose a bench Pokémon to promote first!' : 'Waiting for the opponent to choose a new Active.', true);
      return;
    }
    if (!G.players[G.turn].active) {
      showToast('You must have an Active Pokémon before ending your turn!', true);
      return;
    }
    endTurn();
  }
}

async function doneSetup() {
  if (!G.players[1].active) { showToast('Player 1 must place an Active Pokémon first!', true); return; }

  // vsComputer: the AI places its Active ~800ms after the game starts. If the
  // human clicks DONE SETUP before that timer fires, P2.active is still null and
  // setup would silently stall — the symptom of "keep clicking, nothing happens".
  // Drive the AI's setup right now so the human is never blocked on a timer.
  if (vsComputer && !G.players[2].active && typeof aiDoSetup === 'function') {
    aiDoSetup();
  }

  if (!G.players[2].active) { showToast('Player 2 must place an Active Pokémon first!', true); return; }

  // Re-entrancy guard: this function awaits the coin-flip animation. Without a
  // guard, a second click (or a multiplayer auto-advance) firing during that
  // await would run the whole sequence twice — double coin flip, double opening
  // draw, corrupted turn state.
  if (G._doneSetupRunning) return;
  G._doneSetupRunning = true;

  // Coin flip to decide who goes first — heads = P1, tails = P2
  const heads = await flipCoin('Coin flip! Heads = Player 1 goes first, Tails = Player 2 goes first');
  const firstPlayer = heads ? 1 : 2;

  G.phase = 'DRAW';
  G.turn = firstPlayer;
  G.turnNum = 1;
  G.energyPlayedThisTurn = false;
  // Neither player may evolve on their first turn: everything placed during
  // SETUP counts as played on that turn (see inPlayPokemonUids in game-utils).
  // Seeding here (on the host) reaches P2 through the state push below.
  G.evolvedThisTurn = [...inPlayPokemonUids(G, 1), ...inPlayPokemonUids(G, 2)];
  // Clear the SETUP ready flags now that we've left SETUP — they're meaningless
  // outside the setup phase, and the auto-advance guard needs to be cleared so
  // a future game (e.g. via playAgain) can use it fresh.
  setupReady = { 1: false, 2: false };
  G._setupAdvancing = false;
  G._doneSetupRunning = false;
  document.getElementById('end-turn-btn').textContent = 'END TURN';
  setMidline(''); // drop the "place your Active" prompt now that play has started

  // Opening draw — must happen on the firstPlayer's OWN client in networked
  // play. If P1 (the host) drew for P2 here, P1's view of P2's hand is stale
  // (still the original 7-deal — P2's actual played-out cards aren't reflected
  // because P2 only pushed setup_p2 = {active, bench} during SETUP). That stale
  // mutated hand would then wipe out P2's authoritative local state on receive.
  // So: only draw locally if it's our own first turn or non-networked play.
  // For networked games where the OTHER player goes first, the receive path
  // on their client will run the opening draw locally with their correct deck.
  const isNetworked = myRole !== null && !vsComputer;
  const shouldDrawHere = !isNetworked || firstPlayer === myRole;
  if (shouldDrawHere) {
    const extras = G.pendingExtraDraws?.[firstPlayer] || 0;
    if (extras > 0) G.pendingExtraDraws[firstPlayer] = 0; // consumed, don't redo on receive
    for (let i = 0; i <= extras; i++) drawCard(firstPlayer, true);
  }

  const winner = vsComputer
    ? (firstPlayer === 1 ? 'You go first!' : '🤖 Computer goes first!')
    : `Player ${firstPlayer} goes first!`;
  addLog(`Setup complete! ${winner}`, true);
  renderAll();
  showTurnFlash(firstPlayer);
  showToast(winner, false, 'ok');

  // If AI won the flip, kick off its turn
  if (vsComputer && firstPlayer === 2) {
    setTimeout(() => aiTakeTurn(), 1200);
  }
}

// ══════════════════════════════════════════════════
// TURN MANAGEMENT
// ══════════════════════════════════════════════════
function drawCard(player, auto = false) {
  if (!G.started && !auto) return;
  // Block manual draws if not in DRAW phase or not the active player
  if (!auto && (G.phase !== 'DRAW' || G.turn !== player)) {
    showToast('You can only draw once per turn!', true);
    return;
  }
  const p = G.players[player];
  if (p.deck.length === 0) {
    addLog(`Player ${player} has no cards left to draw! Game over.`, true);
    const deckLossWinner = player === 1 ? 2 : 1;
    G.started = false;
    showWinScreen(deckLossWinner, `PLAYER ${player} DECKED OUT`);
    pushGameState();
    return;
  }
  const card = p.deck.shift();
  p.hand.push(card);
  if (!auto) addLog(`Player ${player} drew a card.`);
  if (G.turn === player && G.phase === 'DRAW') G.phase = 'MAIN';
  updateDeckCounts();
  renderHands();
  updatePhase();
}

// ══════════════════════════════════════════════════
// PLAY CARDS
// ══════════════════════════════════════════════════
function selectHandCard(player, handIdx, evt) {
  // Role guard: only act on your own hand
  if (myRole !== null && player !== myRole) {
    showToast(`Those are Player ${player}'s cards!`, true); return;
  }
  const handCard = G.players[player].hand[handIdx];
  if (!handCard) return;
  // Off-turn or mid-promotion: nothing can be played, but the card can still
  // be read — a menu with the reason and View Card instead of a bare toast.
  const viewOnly = (why) => {
    const src = handCard.images?.large || handCard.images?.small || '';
    const actions = [{ label: why, disabled: true, fn: () => {} }];
    if (src) actions.push({ label: 'View Card', fn: () => { closeActionMenu(); showCardDetail(src); } });
    showActionMenu(handCard.name, actions, evt);
  };
  if (G.phase === 'PROMOTE') {
    viewOnly(G.pendingPromotion === player ? 'Choose a new Active Pokémon first' : `${playerLabel(G.pendingPromotion)} must choose a new Active first`);
    return;
  }
  if (G.phase !== 'SETUP' && G.turn !== player) {
    viewOnly(`It's ${playerLabel(G.turn)}'s turn — view only`);
    return;
  }
  // Clear any stale pending action (e.g. abandoned energy attach) before building new actions
  if (G.pendingAction) {
    G.pendingAction = null;
    clearHighlights();
  }
  const card = G.players[player].hand[handIdx];
  if (!card) return;
  const actions = getActionsForCard(player, card, handIdx);
  if (!actions.length) { showToast('No valid actions for this card now.', true); return; }
  document.querySelectorAll('.hand-card').forEach(el => el.classList.remove('selected'));
  document.getElementById(`hand-card-${player}-${handIdx}`)?.classList.add('selected');
  G.pendingAction = { player, card, handIdx };
  showActionMenu(card.name, actions, evt);
}
// (removed: getActionsForCard — now lives in extracted .js file)

// (removed: playAsActive — now lives in extracted .js file)

// (removed: evolve — now lives in extracted .js file)

// (removed: startBenchPlay — now lives in extracted .js file)

// (removed: playToBench — now lives in extracted .js file)

// (removed: attachEnergy — now lives in extracted .js file)

// (removed: startEnergyAttach — now lives in extracted .js file)

// (removed: onActiveClick — now lives in extracted .js file)

// (removed: canAffordAttack — now lives in extracted .js file)


// (removed: showFieldActionMenu — now lives in extracted .js file)
// The inline copy here had drifted behind the canonical one in game-actions.js
// (missing Conversion 1 / paralyzed / asleep gating). Because pokemon-game.html's
// inline <script> loads AFTER game-actions.js, the inline duplicate was silently
// shadowing the canonical version at runtime. See push_to_github.sh architecture
// note: function defined in a .js file MUST NOT also be defined inline in HTML.
// (removed: attemptRetreat — now lives in extracted .js file)

// (removed: energyValue — now lives in extracted .js file)

// (removed: doRetreat — now lives in extracted .js file)

// (removed: executeRetreat — now lives in extracted .js file)

// (removed: handleBenchClick — now lives in extracted .js file)

// (removed: cancelAction — now lives in extracted .js file)

// (removed: showCoinAnimation — now lives in extracted .js file)

// (removed: flipCoin — now lives in extracted .js file)

// (removed: closeCoinOverlay — now lives in extracted .js file)

// (removed: pickNumber — now lives in extracted .js file)

// (removed: parseStatusEffects — now lives in extracted .js file)

// (removed: applyStatus — now lives in extracted .js file)

// (removed: resolveCoinFlipDamage — now lives in extracted .js file)

// (removed: performAttack — now lives in extracted .js file)

// (removed: checkKO — now lives in extracted .js file)

// (removed: resolvePromotion — now lives in extracted .js file)

// (removed: endTurn — now lives in extracted .js file)

// (removed: renderAll — now lives in extracted .js file)

// (removed: updatePerspectiveLabels — now lives in extracted .js file)

// (removed: renderField — now lives in extracted .js file)

// (removed: renderSlotP1 — now lives in extracted .js file)

// (removed: renderHands — now lives in extracted .js file)

// (removed: renderSidebarP2Hand — now lives in extracted .js file)

// (removed: renderPrizes — now lives in extracted .js file)

// (removed: renderPrizesTab — now lives in extracted .js file)

// (removed: updateDeckCounts — now lives in extracted .js file)

// (removed: updatePhase — now lives in extracted .js file)

// (removed: updateTurnBadge — now lives in extracted .js file)

// (removed: setMidline — now lives in extracted .js file)

// (removed: clearHighlights — now lives in extracted .js file)

// (removed: addLog — now lives in extracted .js file)

// (removed: renderLog — now lives in extracted .js file)

// (removed: showTab — now lives in extracted .js file)

// (removed: showActionMenu — now lives in extracted .js file)

// (removed: closeActionMenu — now lives in extracted .js file)

// (removed: showCardDetail — now lives in extracted .js file)

// (removed: hideCardDetail — now lives in extracted .js file)


document.addEventListener('click', e => {
  const menu = document.getElementById('action-menu');
  if (menu.classList.contains('show') && !menu.contains(e.target)) {
    closeActionMenu();
    cancelAction();
  }
});
document.getElementById('load-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeLoadModal();
});
document.getElementById('card-picker-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget && !_cardPickerNoCancel) cancelCardPick();
});

// ══════════════════════════════════════════════════
// TOAST
// ══════════════════════════════════════════════════
// (removed: toastTimer + showToast — now live in extracted .js file)

// (removed: shuffle — now lives in extracted .js file)

// (removed: energyColor — now lives in extracted .js file)

// (removed: energyTypeKey — now lives in extracted .js file)

// (removed: energyIcon — now lives in extracted .js file)

// (removed: damageCounters — now lives in extracted .js file)

// (removed: statusEmoji — now lives in extracted .js file)


// ══════════════════════════════════════════════════
// CARD DATA LOOKUP (loaded once from cards.json)
// ══════════════════════════════════════════════════
// CARD_DATA and ENERGY_ICONS are declared AND loaded in game-render.js.
// Do not duplicate the fetch here — it was causing two parallel loads per page.
// (removed: enrichCard — now lives in extracted .js file)

// (removed: showPromoteBanner — now lives in extracted .js file)

// (removed: hidePromoteBanner — now lives in extracted .js file)


// ── Flash queue ───────────────────────────────────────────────────────────────
// All flash state (_flashQueue, _flashBusy) and related functions now live in
// extracted game-render.js.
// (removed: _runFlashQueue — now lives in extracted .js file)

// (removed: _queueFlash — now lives in extracted .js file)

// (removed: renderWhenIdle — now lives in extracted .js file)

// (removed: showTurnFlash — now lives in extracted .js file)

// (removed: showMoveFlash — now lives in extracted .js file)

// (removed: showBlockedFlash — now lives in extracted .js file)

// (removed: showActionFlash — now lives in extracted .js file)

// (removed: showTrainerFlash — now lives in extracted .js file)

// (removed: showWinScreen — now lives in extracted .js file)

// (removed: playAgain — now lives in extracted .js file)

// (removed: viewBoard — now lives in extracted .js file)

// (removed: spawnConfetti — now lives in extracted .js file)


// ══════════════════════════════════════════════════
// CARD PICKER MODAL
// ══════════════════════════════════════════════════
// Card picker state (_cardPickerResolve, _cardPickerSelected, _cardPickerMax)
// and functions live in extracted game-render.js.
// (removed: openCardPicker — now lives in extracted .js file)

// (removed: togglePickerCard — now lives in extracted .js file)

// (removed: confirmCardPick — now lives in extracted .js file)

// (removed: cancelCardPick — now lives in extracted .js file)

// (removed: showLassModal — now lives in extracted .js file)

// (removed: dismissLass — now lives in extracted .js file)


// ══════════════════════════════════════════════════
// POKéDEX
// ══════════════════════════════════════════════════
// Pokédex state (_dexResolve, _dexCards, _dexDragSrc) and functions live in
// extracted game-render.js.
// (removed: openPokedex — now lives in extracted .js file)

// (removed: renderDexCards — now lives in extracted .js file)

// (removed: dexMove — now lives in extracted .js file)

// (removed: confirmPokedex — now lives in extracted .js file)

// (removed: cancelPokedex — now lives in extracted .js file)



// ══════════════════════════════════════════════════
// DRAG AND DROP
// ══════════════════════════════════════════════════
let _dragHandIdx = null;   // index in hand of card being dragged
let _dragPlayer  = null;   // which player's hand

function initDragDrop() {
  // Call after each renderHands() to wire up the newly created hand card elements
  const localPlayer = (myRole === 2) ? 2 : 1;
  document.querySelectorAll(`#hand-p1 .hand-card[id^="hand-card-${localPlayer}-"]`).forEach(el => {
    const parts = el.id.split('-');
    const idx = parseInt(parts[parts.length - 1]);
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', e => onHandDragStart(e, localPlayer, idx));
    el.addEventListener('dragend', onHandDragEnd);
    // Touch drag — long-press to initiate
    addTouchDrag(el, localPlayer, idx);
  });

  // Wire drop targets: active slot, bench slots
  wireDropTarget(document.getElementById('active-p1'), 'active', null);
  for (let i = 0; i < 5; i++) {
    wireDropTarget(document.getElementById(`bench-p1-${i}`), 'bench', i);
  }
}

// ── Touch drag support ──────────────────────────────
let _touchDragEl = null;
let _touchDragGhost = null;
let _touchLongPressTimer = null;
let _touchStartX = 0, _touchStartY = 0;

function addTouchDrag(el, player, handIdx) {
  el.addEventListener('touchstart', e => {
    _touchStartX = e.touches[0].clientX;
    _touchStartY = e.touches[0].clientY;
    // Long-press (300ms) to initiate drag
    _touchLongPressTimer = setTimeout(() => {
      if (!isMyTurn() && G.phase !== 'SETUP') return;
      _dragPlayer = player;
      _dragHandIdx = handIdx;
      el.classList.add('dragging');
      // Highlight valid slots
      onHandDragStart({ dataTransfer: { effectAllowed: 'move' } }, player, handIdx);
      // Create ghost
      _touchDragEl = el;
      _touchDragGhost = el.cloneNode(true);
      _touchDragGhost.style.cssText = `position:fixed;opacity:.75;pointer-events:none;z-index:9999;width:${el.offsetWidth}px;transform:scale(1.08);`;
      _touchDragGhost.style.left = (e.touches[0].clientX - el.offsetWidth / 2) + 'px';
      _touchDragGhost.style.top  = (e.touches[0].clientY - el.offsetHeight * 0.7) + 'px';
      document.body.appendChild(_touchDragGhost);
    }, 300);
  }, { passive: true });

  el.addEventListener('touchmove', e => {
    const dx = Math.abs(e.touches[0].clientX - _touchStartX);
    const dy = Math.abs(e.touches[0].clientY - _touchStartY);
    // Cancel long-press if moved significantly before it fires
    if (dx > 8 || dy > 8) { clearTimeout(_touchLongPressTimer); _touchLongPressTimer = null; }
    if (!_touchDragGhost) return;
    e.preventDefault();
    _touchDragGhost.style.left = (e.touches[0].clientX - _touchDragGhost.offsetWidth / 2) + 'px';
    _touchDragGhost.style.top  = (e.touches[0].clientY - _touchDragGhost.offsetHeight * 0.7) + 'px';
  }, { passive: false });

  el.addEventListener('touchend', e => {
    clearTimeout(_touchLongPressTimer);
    _touchLongPressTimer = null;
    if (!_touchDragGhost) return;
    // Find drop target under finger
    _touchDragGhost.style.display = 'none';
    const touch = e.changedTouches[0];
    const target = document.elementFromPoint(touch.clientX, touch.clientY);
    _touchDragGhost.style.display = '';
    // Walk up to find a wired drop zone
    let dropEl = target;
    while (dropEl && dropEl !== document.body) {
      if (dropEl.dataset.dragType) {
        // Simulate a drop
        const dtype = dropEl.dataset.dragType;
        const hi = _dragHandIdx, pl = _dragPlayer;
        onHandDragEnd();
        _touchDragGhost.remove(); _touchDragGhost = null;
        executeDrop(dtype, dropEl, pl, hi);
        return;
      }
      dropEl = dropEl.parentElement;
    }
    // No drop zone — cancel
    onHandDragEnd();
    _touchDragGhost.remove(); _touchDragGhost = null;
  }, { passive: true });

  el.addEventListener('touchcancel', () => {
    clearTimeout(_touchLongPressTimer);
    _touchLongPressTimer = null;
    onHandDragEnd();
    if (_touchDragGhost) { _touchDragGhost.remove(); _touchDragGhost = null; }
  }, { passive: true });
}

function executeDrop(dtype, dropEl, player, handIdx) {
  // The drop type must match the card actually being dragged. A stale
  // highlight (or a mis-targeted touch drop) must never route a card through
  // the wrong play path — an Energy handed to playTrainer was discarded by
  // its unimplemented-trainer fallback ("my Double Colorless vanished").
  const dropped = G.players[player]?.hand?.[handIdx];
  if (!dropped) return;
  const expects = { valid: 'Pokémon', evolve: 'Pokémon', energy: 'Energy', trainer: 'Trainer', heal: 'Trainer' }[dtype];
  const isFossilOrDoll = /mysterious fossil|clefairy doll/i.test(dropped.name) && dropped.supertype === 'Trainer';
  if (!expects || !(dropped.supertype === expects || (dtype === 'valid' && isFossilOrDoll))) {
    showToast(`Can't play ${dropped.name} there.`, true);
    return;
  }
  // Determine zone and benchIdx from element id
  const id = dropEl.id || dropEl.closest('[id]')?.id || '';
  let zone = 'active', benchIdx = null;
  if (id.includes('bench')) {
    zone = 'bench';
    benchIdx = parseInt(id.split('-').pop());
  }
  if (dtype === 'valid') {
    const droppedCard = G.players[player].hand[handIdx];
    const isFossilOrDollDrop = droppedCard && /mysterious fossil|clefairy doll/i.test(droppedCard.name) && droppedCard.supertype === 'Trainer';
    if (isFossilOrDollDrop) playTrainer(player, handIdx);
    else if (zone === 'active') playAsActive(player, handIdx);
    else startBenchPlay(player, handIdx);
  } else if (dtype === 'evolve') {
    evolve(player, handIdx, zone, benchIdx);
  } else if (dtype === 'energy') {
    const isWaterEnergy = /water/i.test(G.players[player].hand[handIdx]?.name || '');
    const rainDance = rainDanceActive(player) && isWaterEnergy;
    if (zone === 'active') attachEnergy(player, handIdx, 'active', null, rainDance);
    else attachEnergy(player, handIdx, 'bench', benchIdx, rainDance);
  } else if (dtype === 'trainer') {
    // Trainer cards dragged onto a Pokémon slot (Defender, PlusPower, Potion, Super Potion)
    // Pass a target hint so the trainer handler can skip its own target picker
    const targetHint = zone === 'active' ? { zone: 'active', benchIdx: null } : { zone: 'bench', benchIdx };
    playTrainer(player, handIdx, targetHint);
  } else if (dtype === 'heal') {
    playTrainer(player, handIdx);
  }
}

function onHandDragStart(e, player, handIdx) {
  if (!isMyTurn() && G.phase !== 'SETUP') return;
  _dragPlayer  = player;
  _dragHandIdx = handIdx;
  e.dataTransfer.effectAllowed = 'move';
  document.getElementById(`hand-card-${player}-${handIdx}`)?.classList.add('dragging');

  // Highlight valid drop targets
  const card = G.players[player].hand[handIdx];
  if (!card) return;

  const p = G.players[player];
  const isSetup = G.phase === 'SETUP';

  // Treat Mysterious Fossil and Clefairy Doll as Basic Pokémon for drag purposes
  const isFossilOrDoll = /mysterious fossil|clefairy doll/i.test(card.name) && card.supertype === 'Trainer';
  if ((card.supertype === 'Pokémon' && card.subtypes?.includes('Basic')) || isFossilOrDoll) {
    // Can play to active (if empty)
    if (!p.active) highlightSlot('active-p1', 'valid');
    // Can play to any empty bench slot (Fossil/Doll needs a free bench if active is occupied)
    for (let i = 0; i < 5; i++) {
      if (!p.bench[i]) highlightSlot(`bench-p1-${i}`, 'valid');
    }
  }

  if (!isSetup && card.supertype === 'Pokémon' &&
      (card.subtypes?.includes('Stage 1') || card.subtypes?.includes('Stage 2')) &&
      card.evolvesFrom && !prehistoricPowerActive()) {
    const evolvedUids = G.evolvedThisTurn || [];
    // Highlight active if it matches
    if (p.active?.name === card.evolvesFrom && !evolvedUids.includes(p.active.uid)) {
      highlightSlot('active-p1', 'evolve');
    }
    // Highlight bench slots that match
    for (let i = 0; i < 5; i++) {
      const b = p.bench[i];
      if (b?.name === card.evolvesFrom && !evolvedUids.includes(b.uid)) {
        highlightSlot(`bench-p1-${i}`, 'evolve');
      }
    }
  }

  if (!isSetup && card.supertype === 'Energy') {
    const isWaterEnergy = /water/i.test(card.name);
    const rainDance = rainDanceActive(player) && isWaterEnergy;
    const canAttach = !G.energyPlayedThisTurn || rainDance;
    if (canAttach) {
      if (p.active) {
        const activeIsWater = !rainDance || (p.active.types || []).some(t => /water/i.test(t));
        if (activeIsWater) highlightSlot('active-p1', 'energy');
      }
      for (let i = 0; i < 5; i++) {
        if (p.bench[i]) {
          const benchIsWater = !rainDance || (p.bench[i].types || []).some(t => /water/i.test(t));
          if (benchIsWater) highlightSlot(`bench-p1-${i}`, 'energy');
        }
      }
    }
  }

  // Draggable trainer cards: Defender, PlusPower, Potion, Super Potion
  // Highlight own Pokémon slots as valid drop targets
  if (!isSetup && card.supertype === 'Trainer') {
    const isTargetedTrainer = /^(defender|pluspower|potion|super potion)$/i.test(card.name);
    if (isTargetedTrainer) {
      if (p.active) highlightSlot('active-p1', 'trainer');
      for (let i = 0; i < 5; i++) {
        if (p.bench[i]) highlightSlot(`bench-p1-${i}`, 'trainer');
      }
    }
  }
}

function onHandDragEnd() {
  _dragHandIdx = null;
  _dragPlayer  = null;
  document.querySelectorAll('.hand-card.dragging').forEach(el => el.classList.remove('dragging'));
  clearDragHighlights();
}

function highlightSlot(id, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('drag-valid', 'drag-valid-evolve', 'drag-valid-energy', 'drag-valid-heal', 'drag-valid-trainer');
  if (type === 'valid')   el.classList.add('drag-valid');
  if (type === 'evolve')  el.classList.add('drag-valid-evolve');
  if (type === 'energy')  el.classList.add('drag-valid-energy');
  if (type === 'heal')    el.classList.add('drag-valid-heal');
  if (type === 'trainer') el.classList.add('drag-valid-trainer');
  el.dataset.dragType = type;
}

function clearDragHighlights() {
  // Every highlight class highlightSlot() can set must be swept here. The
  // trainer class used to be missing, so a slot stayed a "trainer" drop target
  // after a Potion drag and later swallowed an Energy card (see executeDrop).
  document.querySelectorAll('.drag-valid, .drag-valid-evolve, .drag-valid-energy, .drag-valid-heal, .drag-valid-trainer').forEach(el => {
    el.classList.remove('drag-valid', 'drag-valid-evolve', 'drag-valid-energy', 'drag-valid-heal', 'drag-valid-trainer');
    delete el.dataset.dragType;
  });
}

function wireDropTarget(el, zone, benchIdx) {
  if (!el) return;
  el.addEventListener('dragover', e => {
    if (_dragHandIdx === null) return;
    if (el.classList.contains('drag-valid') ||
        el.classList.contains('drag-valid-evolve') ||
        el.classList.contains('drag-valid-energy') ||
        el.classList.contains('drag-valid-trainer')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  });
  el.addEventListener('drop', e => {
    e.preventDefault();
    if (_dragHandIdx === null || _dragPlayer === null) return;
    const dtype = el.dataset.dragType;
    if (!dtype) return;
    const handIdx = _dragHandIdx;
    const player  = _dragPlayer;
    onHandDragEnd(); // clear state before action (action may re-render)
    // One drop implementation for mouse and touch (executeDrop): the old inline
    // copy here had drifted — it never handled the 'trainer' drop type, so a
    // mouse-dragged Potion/Defender silently did nothing.
    executeDrop(dtype, el, player, handIdx);
  });
}

// ══════════════════════════════════════════════════
// VS COMPUTER MODE
// ══════════════════════════════════════════════════
// vsComputer, aiDifficulty, aiThinking, setAiDiff, startVsComputer,
// checkVsCpuReady, startVsCpuGame, aiDoSetup all live in extracted game-ai.js.

// (removed: startVsComputer — now lives in extracted .js file)

// (removed: checkVsCpuReady — now lives in extracted .js file)

// (removed: startVsCpuGame — now lives in extracted .js file)

// (removed: aiDoSetup — now lives in extracted .js file)

// (removed: aiTakeTurn — now lives in extracted .js file)

// (removed: aiChooseEnergyTarget — now lives in extracted .js file)

// (removed: aiConsiderRetreat — now lives in extracted .js file)

// (removed: aiPlayTrainers — now lives in extracted .js file)

// (removed: aiCanAttack — now lives in extracted .js file)

// (removed: aiChooseAndAttack — now lives in extracted .js file)


// ── AI hooks (endTurn, resolvePromotion, checkKO, doneSetup, loadDeck) ───
// All of these hooks live in game-ai.js, applied via window.addEventListener('load').
// Do not re-wrap them here — double-wrapping causes aiTakeTurn to fire twice per
// turn, which races on the aiThinking mutex and freezes the computer's turn.

// ══════════════════════════════════════════════════
// MULTIPLAYER / ROOM SYSTEM
// ══════════════════════════════════════════════════
let myRole = null;       // 1 or 2
let roomCode = null;
let gameRef = null;
let isWriting = false;   // prevent echo loops

// ── SETUP ready flags (multiplayer only) ──────────────────────────────────────
// Each player explicitly signals when they're done placing — prevents P1 from
// cutting P2 off mid-bench-placement. Both flags must be true before P1's
// DONE SETUP advances the game. Toggling un-readies. Any field change during
// SETUP also clears the local flag (see pushGameState — gated by
// _pushPreservesReady which only the explicit toggle sets).
let setupReady = { 1: false, 2: false };
let _pushPreservesReady = false;

// ── Dropped-snapshot replay (SETUP handshake reliability) ─────────────────────
// The Firebase listeners ignore snapshots that arrive while THIS client is mid-
// write (isWriting) to avoid processing our own echo. But that also drops the
// opponent's update if it lands during our write — and during the SETUP ready
// handshake the dropped update is often the opponent's READY flag (when both
// players click at the same instant) or the SETUP→DRAW handoff. Losing it left
// the player clicking READY with nothing happening. We stash the last snapshot
// dropped during a write and replay it once the write finishes (see
// pushGameState's finally). Scoped to SETUP so normal-gameplay echo handling is
// unchanged.
let _pendingSetupSnap = null;
let _setupSnapHandler = null;

// At the SETUP→post-SETUP handoff the host's snapshot of OUR private zones
// (hand/deck/discard/prizes) is stale — during SETUP we only pushed our
// active/bench, never the cards we played out of hand. We re-push our
// authoritative private zones on the transition (see receiveGameState), but
// the host may push again before ingesting that re-push, re-broadcasting the
// stale 7-card hand. This flag keeps us guarding our own private zones on
// EVERY receive until the host's pushes echo our real hand back — i.e. until
// it has caught up. Without it, played Pokémon pop back into the hand.
let _preserveOwnPrivateZones = false;

// ── Panel helpers ─────────────────────────────────
function showLobby()     { ['lobby-panel','waiting-panel','join-panel','joined-panel','vs-computer-panel','resume-panel','leaderboard-panel'].forEach(id => { const el = document.getElementById(id); if(el) el.style.display = id === 'lobby-panel' ? '' : 'none'; }); }
function showPanel(id)   { ['lobby-panel','waiting-panel','join-panel','joined-panel','vs-computer-panel','resume-panel','leaderboard-panel'].forEach(i => { const el = document.getElementById(i); if(el) el.style.display = i === id ? '' : 'none'; }); }

let _resumeRole = 1;
function setResumeRole(role) {
  _resumeRole = role;
  document.getElementById('resume-as-p1').style.background = role === 1 ? 'var(--p1color)' : 'var(--surface2)';
  document.getElementById('resume-as-p1').style.color = role === 1 ? '#000' : 'var(--p1color)';
  document.getElementById('resume-as-p2').style.background = role === 2 ? 'var(--p2color)' : 'var(--surface2)';
  document.getElementById('resume-as-p2').style.color = role === 2 ? '#000' : 'var(--p2color)';
}

function showResumePanel() {
  showPanel('resume-panel');
  setResumeRole(1);
  const list = document.getElementById('resume-game-list');
  list.innerHTML = '<div style="font-size:11px;color:var(--muted)">Loading games...</div>';
  db.ref('games').once('value', snap => {
    const games = snap.val();
    if (!games) { list.innerHTML = '<div style="font-size:11px;color:var(--muted)">No active games found.</div>'; return; }
    const active = Object.entries(games)
      .filter(([, d]) => d.state && d.state.started)
      .sort(([, a], [, b]) => (b.created || 0) - (a.created || 0));
    if (!active.length) { list.innerHTML = '<div style="font-size:11px;color:var(--muted)">No active games found.</div>'; return; }
    list.innerHTML = active.map(([code, d]) => {
      const s = d.state;
      const turnLabel = s.phase === 'PROMOTE' ? `P${s.pendingPromotion} PROMOTING` : `P${s.turn} TURN`;
      const prizes1 = (s.players?.[1]?.prizes || []);
      const prizes2 = (s.players?.[2]?.prizes || []);
      const p1rem = Array.isArray(prizes1) ? prizes1.filter(p=>p).length : Object.values(prizes1).filter(p=>p).length;
      const p2rem = Array.isArray(prizes2) ? prizes2.filter(p=>p).length : Object.values(prizes2).filter(p=>p).length;
      const age = d.created ? Math.round((Date.now() - d.created) / 60000) : '?';
      // Room codes and deck names come from the database: escape them, and
      // pass the code through a data attribute rather than an inline handler.
      return `<div data-code="${escapeHtml(code)}" onclick="resumeGame(this.dataset.code)" style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:10px 14px;cursor:pointer;text-align:left;transition:border-color .1s" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-family:var(--font);font-size:11px;color:var(--accent);letter-spacing:2px">${escapeHtml(code)}</span>
          <span style="font-size:10px;color:var(--muted)">${age}m ago</span>
        </div>
        <div style="font-size:11px;color:var(--text2);margin-top:4px">
          🔵 ${escapeHtml(d.p1DeckName||'?')} &nbsp;vs&nbsp; 🔴 ${escapeHtml(d.p2DeckName||'?')}
        </div>
        <div style="font-size:10px;color:var(--muted);margin-top:3px">
          ${turnLabel} &nbsp;·&nbsp; P1 prizes: ${p1rem} left &nbsp;·&nbsp; P2 prizes: ${p2rem} left
        </div>
      </div>`;
    }).join('');
  });
}

function resumeGame(code) {
  let role = _resumeRole;
  db.ref(`games/${code}`).once('value', roomSnap => {
    const room = roomSnap.val();
    const s = room && room.state;
    if (!s) { showToast('Game not found!', true); return; }
    if (gameRef) { try { gameRef.off(); } catch (e) {} }
    // VS Computer games persist to Firebase too (isAiGame), but returnToLobby /
    // a reload cleared `vsComputer`. Resuming without restoring it left every
    // AI hook (the endTurn wrapper in game-ai.js) inert, so the computer never
    // took another turn after the human's next END TURN. The human is always
    // P1 in an AI game regardless of the resume-panel role toggle.
    const isAi = !!room.isAiGame;
    if (isAi) {
      role = 1;
      vsComputer = true;
      aiPlayerNum = 2;
      aiThinking = false;
      if (room.aiDifficulty && typeof setAiDiff === 'function') setAiDiff(room.aiDifficulty);
    }
    roomCode = code;
    myRole = role;
    gameRef = db.ref(`games/${code}`);
    rememberRoom(code, role);
    // Delegate state decoding to receiveGameState — it pads bench to 5,
    // pads prizes to 6, runs every card through enrichCard (which restores
    // attack text/cost lost in Firebase round-trip), and handles all the
    // SETUP/PROMOTE/win-screen transitions. Duplicating that logic here is
    // exactly the drift pattern that caused the "Bench is full" bug when
    // resuming with a 4-card bench (Firebase strips trailing nulls, and the
    // old manual decode forgot to re-pad to 5).
    receiveGameState(s);
    // Rejoining DURING setup: `state` is P1's view, and its copy of the NON-host's
    // hand/deck is the original deal — the cards that player already placed are
    // still in it. Our own setup slot is the authoritative copy of our zones
    // (pushed on every placement), so restore from it before anything renders
    // as playable. Also re-adopt our READY flag so the button matches Firebase.
    const ownSlot = room[`setup_p${role}`];
    if (G.phase === 'SETUP' && ownSlot && ownSlot.zones) {
      mergeSetupSlot(role, ownSlot);
      setupReady[role] = !!ownSlot.setupReady;
      renderField(role);
      refreshSetupReadyUI(false); // button + midline show the re-adopted flag
    }
    // Rejoining DURING setup needs the same slot-merge handling as the original
    // create/join listeners. The stored `state` snapshot is written by P1 and can
    // predate the opponent's placement, so on its own it leaves us with a null
    // opponent Active. Without merging setup_p1/setup_p2 here we'd never learn
    // about it — and maybeAutoAdvanceSetup's `!G.players[n].active` check would
    // block forever, the "both players clicked READY and nothing happens" hang.
    const _handleResumeSnapshot = (data) => {
      if (!data) return;
      if (G.phase === 'SETUP') {
        if (role === 1) {
          if (data.setup_p2) mergeSetupSlot(2, data.setup_p2);
        } else {
          // P1 publishes its placement inside `state`; setup_p1 carries its ready flag.
          if (data.state?.players?.[1]) mergeSetupSlot(1, data.state.players[1]);
          if (data.setup_p1) mergeSetupSlot(1, data.setup_p1);
        }
      }
      // Accept full state during normal play, and also when the other client has
      // already advanced past SETUP while we're still sitting in it.
      if (data.state && (G.phase !== 'SETUP' || data.state.phase !== 'SETUP')) {
        receiveGameState(data.state);
      }
    };
    if (isAi) {
      // No remote peer: a fresh AI game never attaches a room listener (its
      // pushes would just echo back mid-AI-turn and rebuild the card objects
      // the AI is holding across awaits), so don't attach one here either.
      // If we left while it was the computer's move, pick that move back up.
      setTimeout(() => resumeAiTurnIfPending(), 900);
      addLog(`Rejoined game ${code} vs Computer.`, true);
      return;
    }
    gameRef.on('value', snap => {
      const data = snap.val();
      // Mirror the create/join listeners: stash a snapshot that lands mid-write
      // so the SETUP handshake isn't lost to a write collision.
      if (isWriting) { _pendingSetupSnap = data; _setupSnapHandler = _handleResumeSnapshot; return; }
      _handleResumeSnapshot(data);
    });
    addLog(`P${role} rejoined game ${code}.`, true);
  });
}

// After resuming a VS Computer game, hand control back to the AI wherever the
// saved state left it: mid-SETUP without an Active, a pending promotion, or
// its own DRAW/MAIN turn. Anything else waits for the human as usual.
function resumeAiTurnIfPending() {
  if (!vsComputer || !G.started) return;
  if (G.phase === 'SETUP') {
    if (!G.players[aiPlayerNum].active && typeof aiDoSetup === 'function') aiDoSetup();
    return;
  }
  if (G.phase === 'PROMOTE') {
    if (G.pendingPromotion === aiPlayerNum && typeof aiDoPromotion === 'function') aiDoPromotion();
    return;
  }
  if (G.turn === aiPlayerNum && typeof aiTakeTurn === 'function') {
    aiThinking = false;
    aiTakeTurn();
  }
}

function generateCode() {
  return Math.random().toString(36).substring(2,8).toUpperCase();
}

function copyRoomUrl() {
  const url = document.getElementById('room-url-box').textContent;
  navigator.clipboard?.writeText(url).then(() => showToast('Link copied!', false, 'ok')).catch(() => showToast('Copy the link manually', false));
}

// ── Sidebar toggle ────────────────────────────────
function toggleSidebar() {
  const board = document.getElementById('game-board');
  const btn = document.getElementById('sidebar-toggle-btn');
  const isOpen = board.classList.toggle('sidebar-open');
  btn.textContent = isOpen ? 'LOG ◂' : 'LOG ▸';
  if (isOpen) {
    // Ensure log tab is active and freshly rendered
    const activeTab = document.querySelector('.sidebar-tab.active');
    if (!activeTab || activeTab.id === 'tab-log') {
      document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
      document.getElementById('tab-log')?.classList.add('active');
    }
    renderLog();
  }
}

function toggleHandCollapse() {
  const bar = document.getElementById('bottom-bar');
  const btn = document.getElementById('hand-toggle-btn');
  const collapsed = bar.classList.toggle('hand-collapsed');
  btn.textContent = collapsed ? 'SHOW ▴' : 'HIDE ▾';
}

// ── Fresh-room reset ──────────────────────────────
// The waiting/joined panels are static DOM that survives Play Again / Return
// to Lobby, so a second room in the same tab inherited the previous room's
// "✓ deck loaded" slots, "Both decks loaded — P1 can start!" hint, and an
// ENABLED start button — while the new room record had no decks and the local
// decks had been wiped by the G reset. Both players believed they were ready;
// START only ever toasted "Player 2 hasn't loaded a deck yet!" and the fix was
// to reload the page. Every room create/join now starts from a blank slate,
// both in the DOM and in the local deck slots (a deck loaded for a previous
// room was never broadcast to this one, so it must be re-picked).
function resetRoomLobbyState() {
  for (const p of [1, 2]) {
    const pl = G.players[p];
    pl.deck = []; pl.hand = []; pl.active = null; pl.bench = [null,null,null,null,null];
    pl.prizes = []; pl.discard = []; pl.deckData = null;
    const st = document.getElementById(`p${p}-deck-status`);
    if (st) { st.textContent = 'No deck loaded'; st.style.color = ''; }
    document.querySelectorAll(`.setup-player.p${p}`).forEach(el => el.classList.remove('loaded'));
  }
  const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  set('waiting-status', '⏳ Waiting for Player 2 to join...');
  set('setup-hint', 'Both players must load decks first');
  set('joined-status', 'Waiting for Player 1 to start...');
  set('p1-ready-status', '');
  const startBtn = document.getElementById('start-btn');
  if (startBtn) startBtn.disabled = true;
  setupReady = { 1: false, 2: false };
  _pushPreservesReady = false;
  _pendingSetupSnap = null; _setupSnapHandler = null;
  _preserveOwnPrivateZones = false;
  if (typeof updateDeckCounts === 'function') { try { updateDeckCounts(); } catch (e) {} }
}

// ── Room persistence across reloads ──────────────────────────────────────────
// A reload used to throw P1 out of their room entirely (a new CREATE ROOM made
// a new code, so P2 sat in the old room forever) and made P2 re-pick their
// deck. The room code + role live in sessionStorage — per tab, survives a
// reload, gone when the tab closes — and rejoinStoredRoom() re-enters the same
// room in the same role on load: waiting/joined panel before the game starts
// (re-loading the deck the room record says we picked), resumeGame() after.
const ROOM_STORE_KEY = 'tcg.room';
function rememberRoom(code, role) { try { sessionStorage.setItem(ROOM_STORE_KEY, JSON.stringify({ code, role })); } catch (e) {} }
function forgetRoom() { try { sessionStorage.removeItem(ROOM_STORE_KEY); } catch (e) {} }
function storedRoom() {
  try {
    const r = JSON.parse(sessionStorage.getItem(ROOM_STORE_KEY) || 'null');
    return r && typeof r.code === 'string' && (r.role === 1 || r.role === 2) ? r : null;
  } catch (e) { return null; }
}

// After a rejoin, the room record still says which deck we picked but the
// local G was reset — load it again so the slot, p{n}Ready and G agree.
function restoreOwnDeck(role, room) {
  const name = room && room[`p${role}DeckName`];
  // Never reload a deck over a running game: if the room listener already
  // delivered a started `state` (P1 hit START while we were rejoining), our
  // zones are live and a fresh shuffle would wipe them.
  if (G.started) return;
  if (!name || G.players[role].deckData) return;
  return loadDeck(room[`p${role}DeckFolder`] || '', name, role);
}

async function rejoinStoredRoom() {
  const r = storedRoom();
  if (!r) return;
  if (roomCode) return; // a ?room= link or a click already put us somewhere
  try {
    const snap = await db.ref(`games/${r.code}`).once('value');
    const room = snap.val();
    if (!room) { forgetRoom(); return; }          // room deleted (Play Again)
    if (room.state) {
      if (!room.state.started) { forgetRoom(); return; } // game over
      setResumeRole(r.role);
      resumeGame(r.code);
      showToast(`Rejoined game ${r.code} as Player ${r.role}`, false, 'ok');
      return;
    }
    if (r.role === 1) {
      if (gameRef) { try { gameRef.off(); } catch (e) {} }
      resetRoomLobbyState();
      enterWaitingRoom(r.code);
      G.players[1].name = room.p1Name || G.players[1].name;
      showToast(`Back in room ${r.code} as Player 1`, false, 'ok');
      await restoreOwnDeck(1, room);
    } else {
      await _joinRoomInner(r.code); // restores the deck itself
    }
  } catch (e) {
    console.error('[rejoinStoredRoom] failed:', e);
  }
}

// ── Create room (P1) ──────────────────────────────
async function createRoom() {
  // Detach any listener from a previous room so its snapshots can't leak into
  // this one (BACK from a waiting room, or a rematch in the same tab).
  if (gameRef) { try { gameRef.off(); } catch (e) {} }
  resetRoomLobbyState();
  const code = generateCode();

  // Write initial room record
  await db.ref(`games/${code}`).set({
    created: Date.now(),
    ownerUid: currentUser ? currentUser.uid : null,
    p1Ready: false,
    p2Ready: false,
    p1DeckName: null,
    p2DeckName: null,
    p1Name: trainerName || 'Player 1',
    p2Name: null,
    state: null
  });

  // Seed local G with our own name immediately
  G.players[1].name = trainerName || 'Player 1';
  enterWaitingRoom(code);
}

// Become P1 of an existing room record: panel, share link, and the room
// listener. Shared by createRoom (fresh record) and rejoinStoredRoom (reload).
function enterWaitingRoom(code) {
  myRole = 1;
  roomCode = code;
  gameRef = db.ref(`games/${roomCode}`);
  rememberRoom(code, 1);

  showPanel('waiting-panel');
  const url = `${location.origin}${location.pathname}?room=${roomCode}`;
  document.getElementById('room-url-box').textContent = url;
  document.getElementById('room-code-display').textContent = roomCode;

  // Watch for P2 joining and all game state changes
  const _handleRoomSnapshot = (data) => {
    if (!data) return;
    if (!G.started) {
      if (data.p2Ready) {
        const ws = document.getElementById('waiting-status');
        if (ws) ws.textContent = '✅ Player 2 has joined and loaded a deck!';
      }
      if (data.p2Name && G.players[2]) G.players[2].name = data.p2Name;
      checkBothReady(data);
      if (data.setup_p2 && G.phase === 'SETUP') mergeSetupSlot(2, data.setup_p2);
      if (data.state?.started) receiveGameState(data.state);
    } else {
      // Post-start SETUP: only merge P2's placement — P1 owns the full state here
      if (G.phase === 'SETUP' && data.setup_p2) mergeSetupSlot(2, data.setup_p2);
      // Normal gameplay: receive opponent's state updates
      if (G.phase !== 'SETUP' && data.state) receiveGameState(data.state);
    }
  };
  gameRef.on('value', snap => {
    const data = snap.val();
    // Don't drop a snapshot that lands mid-write — stash it so pushGameState can
    // replay it (the SETUP READY handshake depends on this; see _pendingSetupSnap).
    if (isWriting) { _pendingSetupSnap = data; _setupSnapHandler = _handleRoomSnapshot; return; }
    _handleRoomSnapshot(data);
  });
}

// ── Join room (P2) ────────────────────────────────
function showJoinPanel() {
  myRole = 2;
  showPanel('join-panel');
  // Pre-fill if URL has ?room=
  const urlCode = new URLSearchParams(location.search).get('room');
  if (urlCode) document.getElementById('join-code-input').value = urlCode.toUpperCase();
}

let _joinInFlight = false;
async function joinRoom() {
  const code = document.getElementById('join-code-input').value.trim().toUpperCase();
  if (code.length !== 6) { showToast('Enter a 6-character room code', true); return; }
  // The ?room= auto-join and a manual JOIN click can overlap; two joins in
  // flight attached two listeners to the same room.
  if (_joinInFlight) return;
  _joinInFlight = true;
  try { await _joinRoomInner(code); } finally { _joinInFlight = false; }
}

async function _joinRoomInner(code) {
  const nextRef = db.ref(`games/${code}`);
  const snap = await nextRef.once('value');
  if (!snap.val()) { showToast('Room not found!', true); return; }
  const roomData = snap.val() || {};

  // The game in this room is already running — a ?room= link reopened on a
  // started game (mobile Safari reloads a backgrounded tab, so this is every
  // P2 who switched apps mid-game) or JOIN clicked on one. Joining is wrong
  // here: resetRoomLobbyState() blanks our zones, the listener's first
  // snapshot restores the live state, then restoreOwnDeck() lands a FRESH
  // 60-card deck on top of it — our side rendered as deck 60 / hand 0 / no
  // Active / no prizes with every action blocked. Resume instead, in the seat
  // this tab held (a reload keeps sessionStorage); a bare join link is P2's.
  if (roomData.state && roomData.state.started) {
    const stored = storedRoom();
    const role = stored && stored.code === code ? stored.role : 2;
    setResumeRole(role);
    resumeGame(code);
    showToast(`Rejoined game ${code} as Player ${role}`, false, 'ok');
    return;
  }

  // Same blank-slate rule as createRoom: drop the previous room's listener and
  // lobby state before showing the joined panel for this one.
  if (gameRef && gameRef !== nextRef) { try { gameRef.off(); } catch (e) {} }
  roomCode = code;
  gameRef = nextRef;
  resetRoomLobbyState();
  myRole = 2;
  rememberRoom(code, 2);
  showPanel('joined-panel');

  // Write our name into the room, read P1's name back into local G. On a
  // reload auth may not have resolved yet, so don't overwrite a real name in
  // the room with the 'Guest' placeholder.
  const myName = trainerName || 'Player 2';
  if (!roomData.p2Name || myName !== 'Guest') await gameRef.update({ p2Name: myName });
  G.players[1].name = roomData.p1Name || 'Player 1';
  G.players[2].name = roomData.p2Name && myName === 'Guest' ? roomData.p2Name : myName;

  // Watch for game start and all P1 moves
  const _handleJoinSnapshot = (data) => {
    if (!data) return;
    if (!G.started) {
      if (data.p1Ready) {
        const el = document.getElementById('p1-ready-status');
        if (el) el.textContent = '✅ Player 1 has loaded a deck';
      }
      if (data.setup_p1 && G.phase === 'SETUP') mergeSetupSlot(1, data.setup_p1);
      if (data.state?.started) receiveGameState(data.state);
    } else {
      // Post-start SETUP: P1 pushes to 'state', so read P1's placement from there
      if (G.phase === 'SETUP' && data.state?.players?.[1]) {
        mergeSetupSlot(1, data.state.players[1]);
      }
      if (data.setup_p1) mergeSetupSlot(1, data.setup_p1);
      // Receive full state only once P1 advances past SETUP, or during normal gameplay
      if (data.state && (G.phase !== 'SETUP' || data.state.phase !== 'SETUP')) {
        receiveGameState(data.state);
      }
    }
  };
  gameRef.on('value', snap => {
    const data = snap.val();
    // Don't drop a snapshot that lands mid-write — stash it so pushGameState can
    // replay it. For P2 the dropped event is usually P1's SETUP→DRAW handoff,
    // which otherwise leaves P2 stuck on the SETUP screen. See _pendingSetupSnap.
    if (isWriting) { _pendingSetupSnap = data; _setupSnapHandler = _handleJoinSnapshot; return; }
    _handleJoinSnapshot(data);
  });

  // Reload mid-lobby: the room still knows our deck — load it again.
  await restoreOwnDeck(2, roomData);
}

// Called after P1 or P2 loads their deck — broadcast readiness
async function broadcastDeckReady(playerNum, deckName, folderKey) {
  if (!gameRef) return;
  const update = {};
  update[`p${playerNum}Ready`] = true;
  update[`p${playerNum}DeckName`] = deckName;
  update[`p${playerNum}DeckFolder`] = folderKey || '';
  await gameRef.update(update);
}

// Drive the START button from the live room record in BOTH directions. It used
// to only ever enable, so a button enabled by a previous room stayed enabled.
function checkBothReady(data) {
  const startBtn = document.getElementById('start-btn');
  if (!startBtn) return;
  const hint = document.getElementById('setup-hint');
  const both = !!(data.p1Ready && data.p2Ready);
  startBtn.disabled = !both;
  if (hint) {
    hint.textContent = both ? 'Both decks loaded — P1 can start!'
      : !data.p1Ready && !data.p2Ready ? 'Both players must load decks first'
      : !data.p1Ready ? 'Load your deck to start'
      : 'Waiting for Player 2 to load a deck...';
  }
}

// ── Serialize G for Firebase ──────────────────────
// Firebase can't store undefined, class instances, or circular refs.
// We strip everything to plain data.
function serializeG(g) {
  return JSON.parse(JSON.stringify(g, (key, val) => {
    if (val === undefined) return null;
    return val;
  }));
}

// ── Merge opponent's setup slot without overwriting our own ──
// slotData may contain any subset of: active, bench, setupReady. Only update
// fields that are actually present so a setupReady-only push (P1's post-start
// mirror) doesn't wipe out previously merged active/bench data.
function mergeSetupSlot(playerNum, slotData) {
  if (!slotData) return;
  const p = G.players[playerNum];
  const hasActive = Object.prototype.hasOwnProperty.call(slotData, 'active');
  const hasBench  = Object.prototype.hasOwnProperty.call(slotData, 'bench');
  const hasReady  = Object.prototype.hasOwnProperty.call(slotData, 'setupReady');
  const hasZones  = Object.prototype.hasOwnProperty.call(slotData, 'zones');
  if (hasActive) p.active = slotData.active ? enrichCard(slotData.active) : null;
  if (hasBench)  p.bench  = Array.from({ length: 5 }, (_, i) => { const c = (slotData.bench || [])[i]; return c ? enrichCard(c) : null; });
  const readyChanged = hasReady && playerNum !== myRole && setupReady[playerNum] !== !!slotData.setupReady;
  if (hasReady && playerNum !== myRole) setupReady[playerNum] = !!slotData.setupReady;
  // Private zones travel in the slot too (see pushGameState's non-host SETUP
  // branch). Firebase drops empty arrays entirely, so a missing zone key means
  // "empty" once the `zones` marker says the pusher included them at all.
  // Merging them keeps the host's card counts honest during SETUP and lets a
  // reload restore the player's own real hand instead of the stale deal.
  const toArr = v => Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : []);
  const cards = v => toArr(v).filter(Boolean).map(c => enrichCard(c));
  if (hasZones) {
    p.hand    = cards(slotData.hand);
    p.deck    = cards(slotData.deck);
    p.discard = cards(slotData.discard);
    p.prizes  = Array.from({ length: 6 }, (_, i) => { const pr = toArr(slotData.prizes)[i]; return pr ? { ...pr, card: enrichCard(pr.card) } : null; });
    if (typeof renderHands === 'function') renderHands();
    if (typeof renderPrizes === 'function') { renderPrizes(1); renderPrizes(2); }
    if (typeof updateDeckCounts === 'function') updateDeckCounts();
    if (typeof initDragDrop === 'function') initDragDrop();
  }
  // Re-render just the field without pushing (we're receiving)
  renderField(1);
  renderField(2);
  updatePerspectiveLabels();
  // The opponent's READY flag flipped: update our button/midline and say so.
  if (readyChanged) {
    refreshSetupReadyUI(false);
    if (typeof showToast === 'function') {
      const who = typeof oppDisplayName === 'function' ? oppDisplayName() : `Player ${playerNum}`;
      showToast(setupReady[playerNum] ? `${who} is ready!` : `${who} is no longer ready.`, false, setupReady[playerNum] ? 'ok' : '');
    }
  }
  // After the merge, P1 may now have both ready flags true → auto-advance
  maybeAutoAdvanceSetup();
}

// ── Auto-advance: when we are P1 and both flags are true, fire doneSetup ──
// Only P1 can advance the game (the existing architecture). P2's "I'M READY"
// does not advance directly — P1's listener picks it up via mergeSetupSlot
// and, if P1 is also ready, advances automatically.
function maybeAutoAdvanceSetup() {
  if (G.phase !== 'SETUP' || !G.started) return;
  if (vsComputer || myRole !== 1) return;
  if (!setupReady[1] || !setupReady[2]) return;
  if (!G.players[1].active || !G.players[2].active) return;
  if (G._setupAdvancing) return; // guard against double-fire
  G._setupAdvancing = true;
  // Defer to a microtask so any pending renders settle first. doneSetup is async
  // (it awaits a ~3s coin-flip), so chain on the promise and ALWAYS release the
  // guard if we're still in SETUP afterward — otherwise an early-return inside
  // doneSetup would leave _setupAdvancing stuck true and permanently disable
  // auto-advance, the "READY does nothing no matter how many times I click" bug.
  setTimeout(() => {
    Promise.resolve()
      .then(() => doneSetup())
      .catch(e => console.error(e))
      .finally(() => { if (G.phase === 'SETUP') G._setupAdvancing = false; });
  }, 0);
}

// ── Toggle our own ready flag (multiplayer SETUP only) ───────────────────────
// Called when P1 or P2 clicks the SETUP button. Validates that the player has
// at least placed an Active Pokémon, then flips the flag and pushes — the
// _pushPreservesReady guard tells pushGameState NOT to clear the flag.
function toggleSetupReady() {
  if (G.phase !== 'SETUP' || !G.started) return;
  if (vsComputer || myRole === null) return;
  // Must have an Active Pokémon to mark ready
  if (!G.players[myRole].active && !setupReady[myRole]) {
    showToast('Place an Active Pokémon first!', true);
    return;
  }
  setupReady[myRole] = !setupReady[myRole];
  _pushPreservesReady = true;
  try {
    pushGameState();
  } finally {
    // pushGameState is async but we only need the guard for the synchronous
    // ready-flag check at its top — clear immediately.
    _pushPreservesReady = false;
  }
  renderField(myRole);
  refreshSetupReadyUI(true);
  // If we're P1 and just set our flag, opponent may already be ready
  maybeAutoAdvanceSetup();
}

// ── Make the SETUP handshake visible on THIS client ──────────────────────────
// renderField() only redraws the cards; the button's text and colour live in
// applyRoleVisibility, which the ready toggle never called — so P2 clicked
// I'M READY and nothing on screen changed ("did that register? has P1 hit
// start?"). Called after our own toggle (announce = true → toast), when the
// opponent's flag arrives via mergeSetupSlot, and when a field change resets
// our flag in pushGameState. Sets the button, the midline and a toast so all
// three agree on who is ready.
function refreshSetupReadyUI(announce) {
  if (G.phase !== 'SETUP' || !G.started || myRole === null || vsComputer) return;
  const opp = myRole === 1 ? 2 : 1;
  const oppName = typeof oppDisplayName === 'function' ? oppDisplayName() : `Player ${opp}`;
  const me = !!setupReady[myRole], them = !!setupReady[opp];
  const myBtn = myRole === 1 ? 'DONE SETUP' : "I'M READY";
  if (typeof applyRoleVisibility === 'function') applyRoleVisibility();
  let line;
  if (me && them) line = '✅ Both players ready — starting…';
  else if (me)    line = `✅ You're ready — waiting for ${oppName} to finish setup…`;
  else if (them)  line = `${oppName} is ready — place your Pokémon, then click ${myBtn}`;
  else            line = `Place your Active Pokémon (and optional bench), then click ${myBtn}`;
  if (typeof setMidline === 'function') setMidline(line);
  if (announce && typeof showToast === 'function') {
    showToast(me ? `You're ready! Waiting for ${oppName}…` : `Ready cancelled — click ${myBtn} when you're set.`, !me, me ? 'ok' : '');
  }
}

// ── Push state to Firebase ────────────────────────
async function pushGameState() {
  if (!gameRef) return;
  // Any push during SETUP that ISN'T from the explicit ready-toggle means
  // something on the field changed — invalidate our own ready flag so we
  // can't accidentally advance with a bench we're still editing. The toggle
  // sets _pushPreservesReady before calling, then clears it after.
  if (G.phase === 'SETUP' && G.started && myRole !== null && !_pushPreservesReady) {
    if (setupReady[myRole]) {
      setupReady[myRole] = false;
      // Re-render the button so P1/P2 sees their flag was reset, and say why.
      try {
        renderField(myRole);
        refreshSetupReadyUI(false);
        showToast(`You changed your setup — click ${myRole === 1 ? 'DONE SETUP' : "I'M READY"} again when you're done.`, true);
      } catch (e) {}
    }
  }
  isWriting = true;
  try {
    if (G.phase === 'SETUP' && !G.started) {
      // Pre-game: only push own player slot so players don't overwrite each other
      const myP = G.players[myRole];
      await gameRef.update({
        [`setup_p${myRole}`]: serializeG({
          active: myP.active,
          bench: myP.bench,
          setupReady: !!setupReady[myRole],
        })
      });
    } else if (G.phase === 'SETUP' && G.started) {
      // Post-start SETUP: P1 owns and pushes full state; P2 pushes own slot only
      if (myRole === 1) {
        await gameRef.update({
          state: serializeG(G),
          // Mirror P1's ready flag into setup_p1 so P2's listener can see it
          // (P2 only reads setup_p1 / state.players[1] for P1's field, but the
          // ready flag is a UI signal that doesn't belong inside G itself).
          setup_p1: { setupReady: !!setupReady[1] },
        });
      } else {
        // Non-host: push our WHOLE slot, private zones included. P1 never
        // touches our hand/deck during SETUP, but its `state` node still holds
        // the original 7-card deal it dealt us — so a P2 reload that resumed
        // from `state` got the placed Pokémon back in hand on top of the ones
        // already on the field (duplicate cards). setup_p2 is the only place
        // our real hand/deck exists server-side; resumeGame restores from it.
        const myP = G.players[myRole];
        await gameRef.update({
          [`setup_p${myRole}`]: serializeG({
            active: myP.active,
            bench: myP.bench,
            hand: myP.hand,
            deck: myP.deck,
            prizes: myP.prizes,
            discard: myP.discard,
            zones: true, // marker: private zones included (empty arrays vanish in Firebase)
            setupReady: !!setupReady[myRole],
          })
        });
      }
    } else {
      // Normal gameplay: always push full state after any action
      await gameRef.update({ state: serializeG(G) });
    }
  } finally {
    isWriting = false;
    // Replay any snapshot that arrived while we were writing so a SETUP handshake
    // event (opponent's READY flag, or the SETUP→DRAW handoff) isn't lost to a
    // write-collision. Scoped to SETUP: once past setup, the listener's normal
    // echo-skip behavior is unchanged.
    if (_pendingSetupSnap && _setupSnapHandler) {
      const d = _pendingSetupSnap, h = _setupSnapHandler;
      _pendingSetupSnap = null; _setupSnapHandler = null;
      if (G.phase === 'SETUP') { try { h(d); } catch (e) { console.error(e); } }
    }
  }
}

// ── Receive state from Firebase ───────────────────
function receiveGameState(state) {
  if (!state) return;

  // Firebase converts sparse arrays (with null holes) into plain objects keyed
  // by surviving indices — e.g. [a, null, c] becomes {0: a, 2: c}. We MUST
  // coerce these back to arrays before .map() / iteration, or `.map is not
  // a function` blows up here and the entire receive throws (P2 misses every
  // subsequent state push). Prizes hits this hardest because we null-out a
  // slot every time a prize is claimed.
  const toArr = (v) => Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : (v ? [v] : []));
  const enrichCards = (arr) => toArr(arr).map(c => c ? enrichCard(c) : null);
  const enrichPlayer = (p) => ({
    ...p,
    deck: enrichCards(p.deck),
    hand: enrichCards(p.hand),
    active: p.active ? enrichCard(p.active) : null,
    // bench: pad to exactly 5 slots since Firebase drops trailing nulls
    bench: Array.from({ length: 5 }, (_, i) => { const c = toArr(p.bench)[i]; return c ? enrichCard(c) : null; }),
    // prizes: pad to exactly 6 slots; preserve holes (null = claimed prize)
    prizes: Array.from({ length: 6 }, (_, i) => { const pr = toArr(p.prizes)[i]; return pr ? { ...pr, card: enrichCard(pr.card) } : null; }),
    discard: enrichCards(p.discard),
  });

  const prevTurn = G.turn;
  const wasStarted = G.started;
  const wasSetup   = G.phase === 'SETUP';
  const wasPromote = G.phase === 'PROMOTE';

  // Build incoming player snapshots
  const incomingP1 = enrichPlayer(state.players[1]);
  const incomingP2 = enrichPlayer(state.players[2]);

  // ── Private-zone preservation at SETUP → post-SETUP transition ────────────
  // During SETUP, P2 only pushes setup_p2 = { active, bench } — never their
  // hand/deck/discard/prizes. So P1's full-state push at the SETUP→DRAW
  // transition contains a STALE snapshot of P2's private zones (still showing
  // the original 7-card hand even though P2 played cards from it).
  // If we accept that snapshot, played cards reappear in P2's hand and the
  // total card count exceeds 60.
  // Symmetrically protect P1: if we're P1 and somehow receive a state push
  // from P2 during a SETUP transition, preserve our own private zones too.
  // Only applies the FIRST receive after wasStarted && wasSetup — once we've
  // seen one full-state push past SETUP, both clients are in sync.
  if (wasStarted && wasSetup && state.phase !== 'SETUP' && myRole !== null) {
    _preserveOwnPrivateZones = true;
  }
  if (_preserveOwnPrivateZones && myRole !== null) {
    const localMe = G.players[myRole];
    const incomingMe = myRole === 1 ? incomingP1 : incomingP2;
    // Has the host caught up to our authoritative hand yet? Compare what it
    // actually sent against what we hold locally. The first stale push still
    // carries our original 7-card deal, so this won't match until the host has
    // ingested our re-push (line below) — at which point it's safe to accept
    // incoming private zones normally again. (Matching means the overwrite is a
    // no-op anyway, so clearing here can't drop a legitimate update.)
    const sameUids = (a, b) => {
      const ua = (a || []).filter(Boolean).map(c => c.uid).sort();
      const ub = (b || []).filter(Boolean).map(c => c.uid).sort();
      return ua.length === ub.length && ua.every((x, i) => x === ub[i]);
    };
    if (sameUids(incomingMe.hand, localMe.hand)) _preserveOwnPrivateZones = false;
    incomingMe.hand    = localMe.hand;
    incomingMe.deck    = localMe.deck;
    incomingMe.discard = localMe.discard;
    incomingMe.prizes  = localMe.prizes;
  }

  G = {
    ...state,
    players: { 1: incomingP1, 2: incomingP2 }
  };

  // ── Local opening draw (mirror of doneSetup's deferred-draw behavior) ─────
  // doneSetup skips the opening draw for the firstPlayer when that player is
  // NOT the host (P1), because P1's view of P2's hand/deck is stale during
  // SETUP. Now that P2 has received the SETUP→DRAW transition with their own
  // authoritative hand/deck preserved above, we do the opening draw locally.
  // Guards: only on the SETUP→DRAW transition; only if we're the new turn-owner;
  // only if we haven't drawn yet (G.phase still 'DRAW'); deck must be non-empty.
  if (wasStarted && wasSetup && G.phase === 'DRAW' && G.turn === myRole && myRole !== null) {
    const me = G.players[myRole];
    if (me.deck.length > 0) {
      const extras = G.pendingExtraDraws?.[myRole] || 0;
      if (extras > 0) G.pendingExtraDraws[myRole] = 0;
      for (let i = 0; i <= extras; i++) {
        if (me.deck.length === 0) break;
        const card = me.deck.shift();
        me.hand.push(card);
      }
      // Phase advances to MAIN once we've drawn (matches drawCard's behavior)
      G.phase = 'MAIN';
    }
  }

  // ── Push authoritative state on SETUP→DRAW transition ─────────────────────
  // Whenever we receive the SETUP→DRAW transition (regardless of whose turn it
  // is), we MUST push our own authoritative state back to Firebase. The host's
  // (P1's) snapshot of our private zones is stale because during SETUP we only
  // pushed setup_p2 = {active, bench} — never our hand/deck mutations. The
  // protection block above keeps OUR view correct on this receive, but the
  // host still believes our hand is the original 7-card deal. As soon as the
  // host takes any action (plays a Trainer, attaches energy, ends turn) and
  // pushes state, the stale 7-card hand reappears on our screen — placed
  // Pokémon back in hand, total cards exceed 60.
  //
  // Pushing here gives the host an authoritative copy of our private zones
  // BEFORE they take any action, so subsequent host pushes carry the correct
  // hand/deck/discard. Required for both firstPlayer cases (we just drew) and
  // non-firstPlayer cases (we didn't draw, but our placed-card splices still
  // need to propagate).
  if (wasStarted && wasSetup && G.phase !== 'SETUP' && myRole !== null) {
    pushGameState();
  }

  // Hide setup screen and show board
  document.getElementById('setup-screen').style.display = 'none';
  // Restore button text if transitioning out of SETUP
  if (G.phase !== 'SETUP') {
    const endBtn = document.getElementById('end-turn-btn');
    if (endBtn) endBtn.textContent = 'END TURN';
  }
  // The remote player's promotion is over: drop the bench highlights and the
  // "choose a bench Pokémon" prompt this client put up for it.
  if (wasPromote && G.phase !== 'PROMOTE' && typeof clearHighlights === 'function') clearHighlights();
  // The midline prompt is only ever set by the client that ACTS, so the
  // receiving side used to keep whatever it last showed ("Load decks…" through
  // setup, "Player 2: choose a bench Pokémon…" after they had). Set it from
  // the received phase instead, unless this client is mid-action.
  if (typeof setMidline === 'function' && !G.pendingAction) {
    if (G.phase === 'SETUP') setMidline('Place your Active Pokémon (and optional bench), then click READY');
    else if (G.phase === 'PROMOTE' && G.pendingPromotion && G.pendingPromotion !== myRole) setMidline(`${oppDisplayName()} is choosing a new Active Pokémon…`);
    else if (G.phase === 'PROMOTE') setMidline('Choose a bench Pokémon to promote to Active!');
    else setMidline('');
  }
  // Show/hide promote banner based on incoming phase
  if (G.phase === 'PROMOTE' && G.pendingPromotion) {
    showPromoteBanner(G.pendingPromotion);
    const promotingPlayer = G.pendingPromotion;
    const isMyPromote = myRole === null || myRole === promotingPlayer;
    if (isMyPromote) {
      const benchPlayerNum = myRole === 2 ? (promotingPlayer === 1 ? 2 : 1) : promotingPlayer;
      for (let i = 0; i < 5; i++) {
        if (G.players[promotingPlayer].bench[i]) {
          document.getElementById(`bench-p${benchPlayerNum}-${i}`)?.classList.add('highlight');
        }
      }
    }
  } else {
    hidePromoteBanner();
  }
  // Render without pushing (we're receiving, not acting)
  renderHands();
  renderField(1);
  renderField(2);
  renderPrizes(1);
  renderPrizes(2);
  updateDeckCounts();
  updatePhase();
  updateTurnBadge();
  updatePerspectiveLabels();
  if (document.getElementById('tab-log').classList.contains('active')) renderLog();
  initDragDrop();
  applyRoleVisibility();
  if (!G.started && wasStarted) {
    // Use the winner recorded by showWinScreen if available; fall back to prize
    // count heuristic only as a last resort (e.g. very old game states).
    if (G.winner) {
      showWinScreen(G.winner, G.winReason || '');
    } else {
      const p1prizes = G.players[1].prizes.filter(p => p).length;
      const p2prizes = G.players[2].prizes.filter(p => p).length;
      showWinScreen(p1prizes <= p2prizes ? 2 : 1, '');
    }
    return;
  }
  // Show turn flash if turn just switched to this player
  if (G.started && G.phase !== 'SETUP' && G.turn === myRole && prevTurn !== myRole) {
    showTurnFlash(myRole);
    // Background nudge (OS notification + beep + title blink) if they've tabbed
    // away. notifyMyTurn() self-gates on visibility, so it's a no-op if focused.
    if (typeof notifyMyTurn === 'function') notifyMyTurn();
  }
  // Replay the opponent's latest non-attack banner (attach / trainer / evolve /
  // retreat / promote) — attacks already replay via lastMoveFlash below.
  if (myRole !== null && G.lastActionFlash && G.lastActionFlash.ts !== window._lastActionFlashTs) {
    window._lastActionFlashTs = G.lastActionFlash.ts;
    const af = G.lastActionFlash;
    if (af.player !== myRole) showActionFlash(af.player, af.verb, af.subject, af.detail);
  }
  // Show opponent move flash
  if (myRole !== null && G.lastMoveFlash && G.lastMoveFlash.ts !== window._lastMoveFlashTs) {
    window._lastMoveFlashTs = G.lastMoveFlash.ts;
    const mf = G.lastMoveFlash;
    if (mf.attackingPlayer !== myRole) {
      showMoveFlash(mf.attackingPlayer, mf.attackerName, mf.moveName, mf.dmg, mf.targetName, mf.suffix);
    }
  }
  // Replay any coin flips the opponent made that we haven't shown yet.
  // Uses a per-flip ts watermark so non-attack flips (confusion retreat,
  // sleep wake-up) are also replayed — not just flips attached to moves.
  if (myRole !== null && G.coinFlipLog && G.coinFlipLog.length) {
    const watermark = window._lastCoinFlipTs || 0;
    const newFlips = G.coinFlipLog.filter(f => f.ts && f.ts > watermark);
    if (newFlips.length) {
      // Only replay flips that belong to the opponent (or all flips in observer mode)
      const opponentFlips = newFlips.filter(() => {
        // If a move flash is also new this receive, these are attack flips — only
        // show if the attacker is the opponent.  Otherwise (non-attack flip) show
        // regardless since it came from the opponent's action.
        return true; // always show: the attacker check is done by lastMoveFlash above
      });
      // Advance the watermark to the highest ts we are about to replay.
      window._lastCoinFlipTs = newFlips[newFlips.length - 1].ts;
      const delay = (G.lastMoveFlash && G.lastMoveFlash.ts === window._lastMoveFlashTs) ? 800 : 200;
      setTimeout(async () => {
        for (const flip of opponentFlips) {
          await showCoinAnimation(flip.label, flip.heads, { flipNum: flip.flipNum, totalFlips: flip.totalFlips });
        }
      }, delay);
    }
  }
  // Sleep flip: resolve on the new turn player's client
  if (G.pendingSleepFlip) {
    const sleepName = G.pendingSleepFlip;
    const sleepTarget = G.players[G.turn].active;
    G.pendingSleepFlip = null; // always clear regardless of outcome
    // Multi-status: the Asleep condition lives in `.special` (`.status` is only a
    // stale legacy alias and is NOT kept in sync by setStatusSlot). Reading
    // `.status` here meant this check was always false, so in multiplayer the
    // wake-up flip never fired — Asleep Pokémon never woke up. Read `.special`.
    const _sleepSpecial = sleepTarget?.special ?? sleepTarget?.status ?? null;
    if (sleepTarget && sleepTarget.name === sleepName && _sleepSpecial === 'asleep'
        && (myRole === null || G.turn === myRole)) {
      setTimeout(async () => {
        const wakeUp = await flipCoin(`${sleepName} is Asleep!\nHeads = wake up, Tails = stay asleep`);
        if (wakeUp) {
          // Clear only the special slot; any poison/burn must keep ticking.
          sleepTarget.special = null;
          sleepTarget.status = sleepTarget.poison || (sleepTarget.burn ? 'burned' : null);
          addLog(`${sleepName} woke up!`, true);
        } else {
          addLog(`${sleepName} is still Asleep.`);
        }
        renderAll();
        if (typeof pushGameState === 'function') pushGameState();
      }, 400);
    }
  }
  // Show Lass reveal modal if opponent just played Lass
  if (G.pendingLass && !document.getElementById('lass-modal').classList.contains('show')) {
    showLassModal(G.pendingLass.snapshots, G.pendingLass.player);
  }
  // Hide Lass modal if opponent dismissed it (pendingLass cleared)
  if (!G.pendingLass) {
    document.getElementById('lass-modal').classList.remove('show');
  }
}

// ── Action guard: only act on your turn / role ────
function isMyTurn() {
  if (G.phase === 'SETUP') return true; // both players set up simultaneously
  if (G.phase === 'PROMOTE' && G.pendingPromotion === myRole) return true;
  return G.turn === myRole;
}

function applyRoleVisibility() {
  if (myRole === null) return;

  // Hand cards in the bottom bar — only the local player's cards are interactive.
  // In P2 perspective, these cards have id="hand-card-2-N"; in P1 they're "hand-card-1-N".
  // We check the id prefix rather than the container so we don't accidentally grey our own cards.
  document.querySelectorAll('#hand-p1 .hand-card').forEach(el => {
    const isMyCard = el.id.startsWith(`hand-card-${myRole}-`);
    const isAiTurn = vsComputer && G.turn === 2;
    el.style.opacity = (isMyCard && !isAiTurn) ? '' : '0.35';
    el.style.pointerEvents = (isMyCard && !isAiTurn) ? '' : 'none';
  });

  // Opponent hand in sidebar — always non-interactive (face down)
  document.querySelectorAll('#hand-p2 .hand-card').forEach(el => {
    el.style.pointerEvents = 'none';
  });

  // DONE SETUP / END TURN button
  const endBtn = document.getElementById('end-turn-btn');
  if (endBtn) {
    if (G.phase === 'SETUP') {
      // Always interactive in SETUP — the click handler validates active
      // placement and routes through toggleSetupReady (multiplayer) or
      // doneSetup (vsComputer/single-player).
      endBtn.style.opacity = '';
      endBtn.style.pointerEvents = '';
      endBtn.disabled = false;
      const myReady    = !!setupReady[myRole];
      const oppRole    = myRole === 1 ? 2 : 1;
      const oppReady   = !!setupReady[oppRole];
      const isMultiplayer = myRole !== null && !vsComputer;
      // Green "ready" look while OUR flag is up — the click has registered.
      endBtn.classList.toggle('ready', isMultiplayer && myReady);
      if (!isMultiplayer) {
        // Single-player / vsComputer — original DONE SETUP behavior
        endBtn.textContent = 'DONE SETUP';
      } else if (myReady && oppReady) {
        // Both ready — P1 advances on next tick via maybeAutoAdvanceSetup;
        // P2 just sees a brief confirmation. Keep the button passive here.
        endBtn.textContent = myRole === 1 ? 'STARTING...' : 'BOTH READY';
        endBtn.style.opacity = '0.6';
        endBtn.style.pointerEvents = 'none';
      } else if (myReady && !oppReady) {
        // We're ready, opponent isn't — clicking again un-readies us
        endBtn.textContent = `✓ READY — WAITING FOR P${oppRole}`;
        endBtn.title = 'Click again to cancel ready';
      } else if (!myReady && oppReady) {
        // Opponent is ready, we aren't — prompt us to confirm
        endBtn.textContent = myRole === 1 ? 'DONE SETUP' : "I'M READY";
      } else {
        // Neither ready
        endBtn.textContent = myRole === 1 ? 'DONE SETUP' : "I'M READY";
      }
    } else {
      endBtn.classList.remove('ready');
      endBtn.title = '';
      const isAiTurn = vsComputer && G.turn === 2;
      const canAct = !isAiTurn && (G.turn === myRole ||
                     (G.phase === 'PROMOTE' && G.pendingPromotion === myRole));
      endBtn.style.opacity = canAct ? '' : '0.4';
      endBtn.style.pointerEvents = canAct ? '' : 'none';
      endBtn.disabled = !canAct; // real disabled state: skipped by Tab, announced by screen readers
      const myPromote = G.phase === 'PROMOTE' && G.pendingPromotion === myRole;
      const oppPromote = G.phase === 'PROMOTE' && G.pendingPromotion && G.pendingPromotion !== myRole;
      if (oppPromote) {
        // You knocked out their Active on your turn: the turn cannot end until
        // they have chosen a replacement, so the button is not a control now.
        endBtn.textContent = vsComputer ? 'COMPUTER CHOOSING...' : 'OPPONENT CHOOSING...';
        endBtn.style.opacity = '0.4';
        endBtn.style.pointerEvents = 'none';
        endBtn.disabled = true;
      } else if (myPromote) {
        // Your knockout on the opponent's turn: the bench is the control now,
        // not this button — say so instead of "AI THINKING..." / "END TURN".
        endBtn.textContent = 'CHOOSE A POKÉMON';
        endBtn.style.opacity = '0.7';
        endBtn.style.pointerEvents = 'none';
        endBtn.disabled = true;
      } else if (isAiTurn) {
        endBtn.textContent = 'AI THINKING...';
      } else if (!endBtn.textContent || ['WAITING FOR P1', 'WAITING FOR P2', '✓ READY — WAITING FOR P1', '✓ READY — WAITING FOR P2', "I'M READY", 'STARTING...', 'BOTH READY', 'WAITING...', 'AI THINKING...', 'CHOOSE A POKÉMON', 'COMPUTER CHOOSING...', 'OPPONENT CHOOSING...'].includes(endBtn.textContent)) {
        endBtn.textContent = 'END TURN';
      }
    }
  }

}

// ── Check URL on load for auto-join ──────────────
// If someone opened a join link (?room=CODE), auto-advance them to the join
// panel and fire the join. Logs to the console on every step so when this
// breaks the next time, DevTools shows exactly where it stopped.
(function checkUrlRoom() {
  const urlCode = new URLSearchParams(location.search).get('room');
  if (!urlCode) {
    console.log('[checkUrlRoom] no ?room= in URL');
    // No link — but this tab may have been in a room before the reload.
    if (!storedRoom()) return;
    const rejoin = () => setTimeout(() => { rejoinStoredRoom(); }, 300);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', rejoin);
    else rejoin();
    return;
  }
  console.log('[checkUrlRoom] found ?room=' + urlCode);

  // Pre-fill the join input immediately so a manual click on "JOIN ROOM" works
  // even if the auto-flow below fails for any reason.
  const prefill = () => {
    const input = document.getElementById('join-code-input');
    if (input) {
      input.value = urlCode.toUpperCase();
      console.log('[checkUrlRoom] pre-filled join-code-input');
    } else {
      console.warn('[checkUrlRoom] join-code-input element not found');
    }
  };

  const go = () => {
    try {
      myRole = 2;
      if (typeof showPanel !== 'function') {
        console.error('[checkUrlRoom] showPanel is not defined — inline script did not fully load');
        return;
      }
      showPanel('join-panel');
      console.log('[checkUrlRoom] switched to join-panel');
      prefill();
      // Delay the actual join call by one tick so Firebase and the DOM have
      // settled. Wrapped in try/catch so any error surfaces in the console
      // instead of silently leaving the user on the lobby.
      setTimeout(() => {
        try {
          if (typeof joinRoom !== 'function') {
            console.error('[checkUrlRoom] joinRoom is not defined');
            return;
          }
          console.log('[checkUrlRoom] calling joinRoom()');
          joinRoom();
        } catch (e) {
          console.error('[checkUrlRoom] joinRoom threw:', e);
        }
      }, 300);
    } catch (e) {
      console.error('[checkUrlRoom] failed:', e);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', go);
  } else {
    go();
  }
})();

// ══════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════
setMidline('Load decks and press Start Game');

// Clean up room when tab/window closes
window.addEventListener('beforeunload', () => {
  // Don't delete room on unload — player may be refreshing to recover
  // Room cleanup happens only via playAgain()
});

// ── Re-measure when the field changes size ────────────────
// Card sizes are height-aware (cqh), so a resize, rotation, sidebar toggle or
// hand collapse changes slot pixel sizes. The energy-column margins are
// measured from those sizes at render time, so re-render the two fields (not
// renderAll — that also pushes networked state) once the size settles.
(function watchFieldSize() {
  let timer = null;
  const rerender = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (typeof G === 'undefined' || !G || !G.started) return;
      try { renderField(1); renderField(2); } catch (e) { /* board not mounted yet */ }
    }, 150);
  };
  const field = typeof document !== 'undefined' && document.getElementById
    ? document.getElementById('field-body') : null;
  if (field && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(rerender).observe(field);
  } else if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('resize', rerender);
  }
})();
