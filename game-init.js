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
  if (user) {
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
  document.getElementById('login-error').textContent = '';
}

async function doLoginOrSignup() {
  if (_authInFlight) return;
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl    = document.getElementById('login-error');
  const btn      = document.getElementById('login-submit');

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
  } catch (e) {
    console.warn('[recordResult] failed:', e);
  }
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
    await loadDeck(pick.fKey, pick.deckName);
  } catch (e) {
    showToast('Error picking random deck', true);
    console.error('loadRandomDeck error:', e);
  }
}

async function loadDeck(fKey, deckName) {
  const p = loadingForPlayer;
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
    const flat = [];
    for (const entry of Object.values(d.deck)) {
      const card = {
        id: entry.cardId,
        name: entry.name,
        supertype: entry.supertype,
        images: { small: entry.img || '' },
        subtypes: entry.subtypes || [],
        hp: entry.hp || '0',
        attacks: entry.attacks || [],
        types: entry.types || []
      };
      for (let i = 0; i < entry.qty; i++) {
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

async function startGame() {
  // In networked mode, P1 needs to load P2's deck from Firebase first
  if (myRole === 1 && gameRef) {
    const snap = await gameRef.once('value');
    const data = snap.val();
    if (!data?.p2DeckName) { showToast("Player 2 hasn't loaded a deck yet!", true); return; }
    if (!G.players[2].deckData) {
      // Load P2's deck silently
      showToast('Loading P2 deck...', false);
      const saved = loadingForPlayer;
      loadingForPlayer = 2;
      await loadDeck(data.p2DeckFolder || '', data.p2DeckName);
      loadingForPlayer = saved;
    }
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
    if (!G.players[G.turn].active) {
      showToast('You must have an Active Pokémon before ending your turn!', true);
      return;
    }
    endTurn();
  }
}

async function doneSetup() {
  if (!G.players[1].active) { showToast('Player 1 must place an Active Pokémon first!', true); return; }
  if (!G.players[2].active) { showToast('Player 2 must place an Active Pokémon first!', true); return; }

  // Coin flip to decide who goes first — heads = P1, tails = P2
  const heads = await flipCoin('Coin flip! Heads = Player 1 goes first, Tails = Player 2 goes first');
  const firstPlayer = heads ? 1 : 2;

  G.phase = 'DRAW';
  G.turn = firstPlayer;
  G.turnNum = 1;
  G.energyPlayedThisTurn = false;
  // Clear the SETUP ready flags now that we've left SETUP — they're meaningless
  // outside the setup phase, and the auto-advance guard needs to be cleared so
  // a future game (e.g. via playAgain) can use it fresh.
  setupReady = { 1: false, 2: false };
  G._setupAdvancing = false;
  document.getElementById('end-turn-btn').textContent = 'END TURN';

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
  if (G.phase === 'PROMOTE') {
    showToast(`Player ${G.pendingPromotion} must choose a new Active first!`, true); return;
  }
  // Role guard: only act on your own hand
  if (myRole !== null && player !== myRole) {
    showToast(`Those are Player ${player}'s cards!`, true); return;
  }
  if (G.phase !== 'SETUP' && G.turn !== player) {
    showToast(`It's Player ${G.turn}'s turn!`, true); return;
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
  document.querySelectorAll('.drag-valid, .drag-valid-evolve, .drag-valid-energy, .drag-valid-heal').forEach(el => {
    el.classList.remove('drag-valid', 'drag-valid-evolve', 'drag-valid-energy', 'drag-valid-heal');
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

    if (dtype === 'valid') {
      const droppedCard = G.players[player].hand[handIdx];
      const isFossilOrDollDrop = droppedCard && /mysterious fossil|clefairy doll/i.test(droppedCard.name) && droppedCard.supertype === 'Trainer';
      if (isFossilOrDollDrop) {
        // Route through playTrainer which handles Fossil/Doll placement
        playTrainer(player, handIdx);
      } else if (zone === 'active') {
        playAsActive(player, handIdx);
      } else {
        startBenchPlay(player, handIdx);
      }
    } else if (dtype === 'evolve') {
      evolve(player, handIdx, zone, benchIdx);
    } else if (dtype === 'energy') {
      const isWaterEnergy = /water/i.test(G.players[player].hand[handIdx]?.name || '');
      const rainDance = rainDanceActive(player) && isWaterEnergy;
      if (zone === 'active') attachEnergy(player, handIdx, 'active', null, rainDance);
      else attachEnergy(player, handIdx, 'bench', benchIdx, rainDance);
    } else if (dtype === 'heal') {
      // Route heal trainers directly through playTrainer
      playTrainer(player, handIdx);
    }
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

// ── Panel helpers ─────────────────────────────────
function showLobby()     { ['lobby-panel','waiting-panel','join-panel','joined-panel','vs-computer-panel','resume-panel'].forEach(id => { const el = document.getElementById(id); if(el) el.style.display = id === 'lobby-panel' ? '' : 'none'; }); }
function showPanel(id)   { ['lobby-panel','waiting-panel','join-panel','joined-panel','vs-computer-panel','resume-panel'].forEach(i => { const el = document.getElementById(i); if(el) el.style.display = i === id ? '' : 'none'; }); }

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
  list.innerHTML = '<div style="font-size:9px;color:var(--muted)">Loading games...</div>';
  db.ref('games').once('value', snap => {
    const games = snap.val();
    if (!games) { list.innerHTML = '<div style="font-size:9px;color:var(--muted)">No active games found.</div>'; return; }
    const active = Object.entries(games)
      .filter(([, d]) => d.state && d.state.started)
      .sort(([, a], [, b]) => (b.created || 0) - (a.created || 0));
    if (!active.length) { list.innerHTML = '<div style="font-size:9px;color:var(--muted)">No active games found.</div>'; return; }
    list.innerHTML = active.map(([code, d]) => {
      const s = d.state;
      const turnLabel = s.phase === 'PROMOTE' ? `P${s.pendingPromotion} PROMOTING` : `P${s.turn} TURN`;
      const prizes1 = (s.players?.[1]?.prizes || []);
      const prizes2 = (s.players?.[2]?.prizes || []);
      const p1rem = Array.isArray(prizes1) ? prizes1.filter(p=>p).length : Object.values(prizes1).filter(p=>p).length;
      const p2rem = Array.isArray(prizes2) ? prizes2.filter(p=>p).length : Object.values(prizes2).filter(p=>p).length;
      const age = d.created ? Math.round((Date.now() - d.created) / 60000) : '?';
      return `<div onclick="resumeGame('${code}')" style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:10px 14px;cursor:pointer;text-align:left;transition:border-color .1s" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-family:var(--font);font-size:11px;color:var(--accent);letter-spacing:2px">${code}</span>
          <span style="font-size:8px;color:var(--muted)">${age}m ago</span>
        </div>
        <div style="font-size:9px;color:var(--text2);margin-top:4px">
          🔵 ${d.p1DeckName||'?'} &nbsp;vs&nbsp; 🔴 ${d.p2DeckName||'?'}
        </div>
        <div style="font-size:8px;color:var(--muted);margin-top:3px">
          ${turnLabel} &nbsp;·&nbsp; P1 prizes: ${p1rem} left &nbsp;·&nbsp; P2 prizes: ${p2rem} left
        </div>
      </div>`;
    }).join('');
  });
}

function resumeGame(code) {
  const role = _resumeRole;
  db.ref(`games/${code}/state`).once('value', snap => {
    const s = snap.val();
    if (!s) { showToast('Game not found!', true); return; }
    roomCode = code;
    myRole = role;
    gameRef = db.ref(`games/${code}`);
    // Delegate state decoding to receiveGameState — it pads bench to 5,
    // pads prizes to 6, runs every card through enrichCard (which restores
    // attack text/cost lost in Firebase round-trip), and handles all the
    // SETUP/PROMOTE/win-screen transitions. Duplicating that logic here is
    // exactly the drift pattern that caused the "Bench is full" bug when
    // resuming with a 4-card bench (Firebase strips trailing nulls, and the
    // old manual decode forgot to re-pad to 5).
    receiveGameState(s);
    gameRef.on('value', data => {
      if (isWriting) return;
      const d = data.val();
      if (d && d.state && G.phase !== 'SETUP') {
        receiveGameState(d.state);
      }
    });
    addLog(`P${role} rejoined game ${code}.`, true);
  });
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

// ── Create room (P1) ──────────────────────────────
async function createRoom() {
  myRole = 1;
  roomCode = generateCode();
  gameRef = db.ref(`games/${roomCode}`);

  // Write initial room record
  await gameRef.set({
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

  showPanel('waiting-panel');
  const url = `${location.origin}${location.pathname}?room=${roomCode}`;
  document.getElementById('room-url-box').textContent = url;
  document.getElementById('room-code-display').textContent = roomCode;

  // Watch for P2 joining and all game state changes
  gameRef.on('value', snap => {
    if (isWriting) return;
    const data = snap.val();
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

async function joinRoom() {
  const code = document.getElementById('join-code-input').value.trim().toUpperCase();
  if (code.length !== 6) { showToast('Enter a 6-character room code', true); return; }
  roomCode = code;
  gameRef = db.ref(`games/${roomCode}`);
  const snap = await gameRef.once('value');
  if (!snap.val()) { showToast('Room not found!', true); return; }

  myRole = 2;
  showPanel('joined-panel');

  // Write our name into the room, read P1's name back into local G
  await gameRef.update({ p2Name: trainerName || 'Player 2' });
  const roomData = snap.val() || {};
  G.players[1].name = roomData.p1Name || 'Player 1';
  G.players[2].name = trainerName || 'Player 2';

  // Watch for game start and all P1 moves
  gameRef.on('value', snap => {
    if (isWriting) return;
    const data = snap.val();
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
  });
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

function checkBothReady(data) {
  const startBtn = document.getElementById('start-btn');
  if (!startBtn) return;
  if (data.p1Ready && data.p2Ready) {
    startBtn.disabled = false;
    document.getElementById('setup-hint').textContent = 'Both decks loaded — P1 can start!';
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
  if (hasActive) p.active = slotData.active ? enrichCard(slotData.active) : null;
  if (hasBench)  p.bench  = Array.from({ length: 5 }, (_, i) => { const c = (slotData.bench || [])[i]; return c ? enrichCard(c) : null; });
  if (hasReady && playerNum !== myRole) setupReady[playerNum] = !!slotData.setupReady;
  // Re-render just the field without pushing (we're receiving)
  renderField(1);
  renderField(2);
  updatePerspectiveLabels();
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
  // Defer to a microtask so any pending renders settle first
  setTimeout(() => { try { doneSetup(); } catch (e) { console.error(e); G._setupAdvancing = false; } }, 0);
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
  // If we're P1 and just set our flag, opponent may already be ready
  maybeAutoAdvanceSetup();
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
      // Re-render the button so P1/P2 sees their flag was reset
      try { renderField(myRole); } catch (e) {}
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
        const myP = G.players[myRole];
        await gameRef.update({
          [`setup_p${myRole}`]: serializeG({
            active: myP.active,
            bench: myP.bench,
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
    const localMe = G.players[myRole];
    const incomingMe = myRole === 1 ? incomingP1 : incomingP2;
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
    if (sleepTarget && sleepTarget.name === sleepName && sleepTarget.status === 'asleep'
        && (myRole === null || G.turn === myRole)) {
      setTimeout(async () => {
        const wakeUp = await flipCoin(`${sleepName} is Asleep!\nHeads = wake up, Tails = stay asleep`);
        if (wakeUp) {
          sleepTarget.status = null;
          addLog(`${sleepName} woke up!`, true);
        } else {
          addLog(`${sleepName} is still Asleep.`);
        }
        renderAll();
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
      const myReady    = !!setupReady[myRole];
      const oppRole    = myRole === 1 ? 2 : 1;
      const oppReady   = !!setupReady[oppRole];
      const isMultiplayer = myRole !== null && !vsComputer;
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
        endBtn.textContent = `WAITING FOR P${oppRole}`;
        endBtn.style.opacity = '0.7';
      } else if (!myReady && oppReady) {
        // Opponent is ready, we aren't — prompt us to confirm
        endBtn.textContent = myRole === 1 ? 'DONE SETUP' : "I'M READY";
      } else {
        // Neither ready
        endBtn.textContent = myRole === 1 ? 'DONE SETUP' : "I'M READY";
      }
    } else {
      const isAiTurn = vsComputer && G.turn === 2;
      const canAct = !isAiTurn && (G.turn === myRole ||
                     (G.phase === 'PROMOTE' && G.pendingPromotion === myRole));
      endBtn.style.opacity = canAct ? '' : '0.4';
      endBtn.style.pointerEvents = canAct ? '' : 'none';
      if (isAiTurn) {
        endBtn.textContent = 'AI THINKING...';
      } else if (!endBtn.textContent || endBtn.textContent === 'WAITING FOR P1' || endBtn.textContent === 'WAITING FOR P2' || endBtn.textContent === "I'M READY" || endBtn.textContent === 'STARTING...' || endBtn.textContent === 'BOTH READY' || endBtn.textContent === 'WAITING...' || endBtn.textContent === 'AI THINKING...') {
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
  if (!urlCode) { console.log('[checkUrlRoom] no ?room= in URL'); return; }
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
