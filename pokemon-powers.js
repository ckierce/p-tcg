// ══════════════════════════════════════════════════════════════════════════════
// POKEMON-POWERS.JS — All Pokémon Power logic extracted from pokemon-game.html
//
// Powers are passive or once-per-turn abilities on Pokémon cards.
// This file provides:
//
//   Query helpers (passive checks used throughout the game):
//     getPower(card)               → ability object or null
//     hasPower(card, name)         → bool
//     isMukActive()                → bool — Toxic Gas suppresses all other powers
//     prehistoricPowerActive()     → bool — no evolution while Aerodactyl in play
//     isPowerActive(card, name)    → bool — checks Muk suppression + status
//     hasThickSkin(card)           → bool — immune to status conditions
//     hasInvisibleWall(card)       → bool — blocks ≤30 damage
//     hasEnergyBurn(card)          → bool — all energy counts as Fire
//     rainDanceActive(player)      → bool — unlimited Water energy attachment
//     energyTransActive(player)    → bool — move Grass energy freely
//     damageSwapActive(player)     → bool — move damage counters freely
//     retreatCostReduction(player) → number — Dodrio's Retreat Aid discount
//
//   Status guard:
//     tryApplyStatus(target, status) → bool — blocked by Thick Skinned
//
//   Active power actions (triggered from showFieldActionMenu):
//     doDamageSwap(player)         — Alakazam: redistribute damage counters
//     doEnergyTrans(player)        — Venusaur: move Grass energy
//     doCurse(player)              — Gengar: move 1 damage counter to opponent
//     doBuzzap(player, benchIdx)   — Electrode: sacrifice for 2 Lightning energy
//     doMetronome(player)          — Clefable: copy opponent's attack
//     dittoAttacks(player)         — Ditto Transform: returns opp's attacks or null
//
//   Passive powers wired elsewhere in performAttack:
//     strikesBack already handled inline in performAttack
//
//   Powers added to the action menu (injected via getFieldActionExtras):
//     getFieldActionExtras(player, zone, benchIdx, card) → action[] for menu
// ══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// QUERY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Returns the Pokémon Power ability object for a card, or null if none.
function getPower(card) {
  if (!card) return null;
  return (card.abilities || []).find(a =>
    a.type === 'Pokémon Power' || a.type === 'Pokemon Power' ||
    a.type === 'Poké-Power'    || a.type === 'Poke-Power'
  ) || null;
}

// Returns true if a card has a specific named power (case-insensitive match).
function hasPower(card, name) {
  const p = getPower(card);
  return !!(p && p.name.toLowerCase() === name.toLowerCase());
}

// Muk's Toxic Gas: suppresses ALL other Pokémon Powers while Muk is in play.
function isMukActive() {
  for (const pNum of [1, 2]) {
    const all = [G.players[pNum].active, ...G.players[pNum].bench].filter(Boolean);
    if (all.some(c => hasPower(c, 'Toxic Gas') && !_isStatusBlocked(c))) return true;
  }
  return false;
}

// Internal: returns true if a card's status would block its power from working.
function _isStatusBlocked(card) {
  return card?.status === 'asleep' || card?.status === 'confused' || card?.status === 'paralyzed';
}

// Aerodactyl's Prehistoric Power: no evolution can be played while it's in play.
// Muk's Toxic Gas suppresses Prehistoric Power.
function prehistoricPowerActive() {
  if (isMukActive()) return false;
  for (const pNum of [1, 2]) {
    const all = [G.players[pNum].active, ...G.players[pNum].bench].filter(Boolean);
    if (all.some(c => hasPower(c, 'Prehistoric Power') && !_isStatusBlocked(c))) return true;
  }
  return false;
}

// Is a named power currently active on a specific card?
// Checks: card has the power, Muk isn't suppressing it, card isn't status-blocked.
function isPowerActive(card, powerName) {
  if (!hasPower(card, powerName)) return false;
  if (powerName === 'Toxic Gas') return !_isStatusBlocked(card); // Toxic Gas can't suppress itself
  if (isMukActive()) return false;
  if (_isStatusBlocked(card)) return false;
  return true;
}

// Snorlax — Thick Skinned: immune to all special conditions.
function hasThickSkin(card) {
  return isPowerActive(card, 'Thick Skinned');
}

// Mr. Mime — Invisible Wall: prevents damage of 30 or less.
function hasInvisibleWall(card) {
  return isPowerActive(card, 'Invisible Wall');
}

// Charizard — Energy Burn: all attached energy counts as Fire.
function hasEnergyBurn(card) {
  return isPowerActive(card, 'Energy Burn');
}

// Blastoise — Rain Dance: may attach unlimited Water energy to Water Pokémon per turn.
function rainDanceActive(player) {
  const all = [G.players[player].active, ...G.players[player].bench].filter(Boolean);
  return all.some(c => isPowerActive(c, 'Rain Dance'));
}

// Venusaur — Energy Trans: may move Grass energy freely between Grass Pokémon.
function energyTransActive(player) {
  const all = [G.players[player].active, ...G.players[player].bench].filter(Boolean);
  return all.some(c => isPowerActive(c, 'Energy Trans'));
}

// Alakazam — Damage Swap: may redistribute damage counters among own Pokémon.
function damageSwapActive(player) {
  const all = [G.players[player].active, ...G.players[player].bench].filter(Boolean);
  return all.some(c => isPowerActive(c, 'Damage Swap'));
}

// Dodrio — Retreat Aid: reduce retreat cost by 1 Colorless for each Dodrio on bench.
function retreatCostReduction(player) {
  return G.players[player].bench.filter(c => c && isPowerActive(c, 'Retreat Aid')).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS GUARD — applies status unless Thick Skinned blocks it
// ─────────────────────────────────────────────────────────────────────────────

function tryApplyStatus(target, status) {
  if (hasThickSkin(target)) {
    addLog(`${target.name}'s Thick Skinned prevents ${status}!`, true);
    showToast(`${target.name} is immune to status conditions!`);
    return false;
  }
  target.status = status;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// DITTO — Transform: treat Ditto as a copy of the Defending Pokémon
// Returns the opponent's active attacks if Ditto is active and Transform is
// working; otherwise null.
// ─────────────────────────────────────────────────────────────────────────────

function dittoAttacks(player) {
  const p = G.players[player];
  if (!isPowerActive(p.active, 'Transform')) return null;
  const opp = G.players[player === 1 ? 2 : 1];
  return opp.active?.attacks || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVE POWER ACTIONS
// ─────────────────────────────────────────────────────────────────────────────

// Alakazam — Damage Swap
// Move 1 damage counter from one of your Pokémon to another.
async function doDamageSwap(player) {
  if (!damageSwapActive(player)) { showToast('Alakazam not in play!', true); return; }
  if (isMukActive())             { showToast("Muk's Toxic Gas suppresses Damage Swap!", true); return; }
  const p = G.players[player];
  const all = [
    ...(p.active ? [{ label: `Active: ${p.active.name} (${p.active.damage||0} dmg)`, card: p.active }] : []),
    ...p.bench.map((b, i) => b ? { label: `Bench ${i+1}: ${b.name} (${b.damage||0} dmg)`, card: b } : null).filter(Boolean)
  ];
  if (all.length < 2) { showToast('Need at least 2 Pokémon to swap damage!', true); return; }

  const sources = all.filter(x => (x.card.damage || 0) >= 10);
  if (!sources.length) { showToast('No Pokémon have damage counters to move!', true); return; }

  const srcPicked = await openCardPicker({
    title: 'Damage Swap — Source',
    subtitle: 'Choose a Pokémon to take a damage counter FROM',
    cards: sources.map(x => x.card), maxSelect: 1
  });
  if (!srcPicked) return;
  const srcCard = sources[srcPicked[0]].card;

  const dsts = all.filter(x => x.card !== srcCard);
  const dstPicked = await openCardPicker({
    title: 'Damage Swap — Destination',
    subtitle: 'Choose a Pokémon to move the damage counter TO',
    cards: dsts.map(x => x.card), maxSelect: 1
  });
  if (!dstPicked) return;
  const dstCard = dsts[dstPicked[0]].card;

  srcCard.damage = (srcCard.damage || 0) - 10;
  dstCard.damage = (dstCard.damage || 0) + 10;
  addLog(`P${player} used Damage Swap — moved 10 damage from ${srcCard.name} to ${dstCard.name}.`, true);

  // Check if destination Pokémon is now KO'd
  checkKO(player === 1 ? 2 : 1, player, dstCard, false);
  renderAll();
}

// Venusaur — Energy Trans
// Move 1 Grass energy from one of your Grass Pokémon to another.
async function doEnergyTrans(player) {
  if (!energyTransActive(player)) { showToast('Venusaur not in play!', true); return; }
  if (isMukActive())              { showToast("Muk's Toxic Gas suppresses Energy Trans!", true); return; }
  const p = G.players[player];

  const all = [p.active, ...p.bench].filter(Boolean);
  const withGrass = all.filter(c => (c.attachedEnergy || []).some(e => /grass/i.test(e.name)));
  if (!withGrass.length) { showToast('No Grass Energy to move!', true); return; }

  const srcPicked = await openCardPicker({
    title: 'Energy Trans — Source',
    subtitle: 'Choose a Pokémon to take Grass Energy FROM',
    cards: withGrass, maxSelect: 1
  });
  if (!srcPicked) return;
  const srcCard = withGrass[srcPicked[0]];

  const grassOnSrc = srcCard.attachedEnergy.filter(e => /grass/i.test(e.name));
  let energyCard = grassOnSrc[0];
  if (grassOnSrc.length > 1) {
    const ePicked = await openCardPicker({
      title: 'Energy Trans — Which Energy',
      subtitle: 'Choose which Grass Energy to move',
      cards: grassOnSrc, maxSelect: 1
    });
    if (!ePicked) return;
    energyCard = grassOnSrc[ePicked[0]];
  }

  const dsts = all.filter(c => c !== srcCard);
  if (!dsts.length) { showToast('No other Pokémon to attach Grass Energy to!', true); return; }

  const dstPicked = await openCardPicker({
    title: 'Energy Trans — Destination',
    subtitle: 'Choose a Pokémon to attach Grass Energy TO',
    cards: dsts, maxSelect: 1
  });
  if (!dstPicked) return;
  const dstCard = dsts[dstPicked[0]];

  const idx = srcCard.attachedEnergy.findIndex(e => e === energyCard);
  if (idx !== -1) {
    srcCard.attachedEnergy.splice(idx, 1);
    dstCard.attachedEnergy = dstCard.attachedEnergy || [];
    dstCard.attachedEnergy.push(energyCard);
    addLog(`P${player} used Energy Trans — moved Grass Energy from ${srcCard.name} to ${dstCard.name}.`, true);
    renderAll();
  }
}

// Gengar — Curse
// Once per turn: move 1 damage counter from Gengar to the Defending Pokémon.
async function doCurse(player) {
  if (isMukActive()) { showToast("Muk's Toxic Gas suppresses Curse!", true); return; }
  const p = G.players[player];
  const gengar = [p.active, ...p.bench].find(c => isPowerActive(c, 'Curse'));
  if (!gengar)                     { showToast('Gengar not in play!', true); return; }
  if ((gengar.damage || 0) < 10)   { showToast('Gengar has no damage counters to move!', true); return; }
  const opp = G.players[player === 1 ? 2 : 1];
  if (!opp.active)                 { showToast('No opposing Active Pokémon!', true); return; }

  gengar.damage -= 10;
  opp.active.damage = (opp.active.damage || 0) + 10;
  addLog(`P${player} used Curse — moved 1 damage counter from ${gengar.name} to ${opp.active.name}.`, true);
  G.cursedThisTurn = true;
  checkKO(player, player === 1 ? 2 : 1, opp.active, false);
  renderAll();
}

// Electrode — Buzzap
// Sacrifice Electrode to add 2 Lightning energy to another Pokémon.
async function doBuzzap(player, benchIdx) {
  if (isMukActive()) { showToast("Muk's Toxic Gas suppresses Buzzap!", true); return; }
  const p = G.players[player];
  const electrode = p.bench[benchIdx];
  if (!isPowerActive(electrode, 'Buzzap')) { showToast('No Buzzap Electrode!', true); return; }

  const targets = [
    ...(p.active && p.active !== electrode ? [p.active] : []),
    ...p.bench.map((b, i) => (b && b !== electrode) ? b : null).filter(Boolean)
  ];
  if (!targets.length) { showToast('No other Pokémon to power up!', true); return; }

  const picked = await openCardPicker({
    title: 'Buzzap!',
    subtitle: 'Choose a Pokémon to attach 2 Lightning Energy to',
    cards: targets, maxSelect: 1
  });
  if (!picked) return;
  const target = targets[picked[0]];

  const lightning = { id: 'base1-100', name: 'Lightning Energy', supertype: 'Energy', images: { small: '' } };
  target.attachedEnergy = target.attachedEnergy || [];
  target.attachedEnergy.push({ ...lightning }, { ...lightning });

  p.discard.push(electrode);
  p.bench[benchIdx] = null;
  addLog(`P${player} used Buzzap! — ${electrode.name} sacrificed to give ${target.name} 2 ⚡ Energy!`, true);
  renderAll();
}

// Clefable — Metronome (Power version, triggered from action menu)
// Copy any one of the opponent's Active Pokémon's attacks and use it.
async function doMetronome(player) {
  if (isMukActive()) { showToast("Muk's Toxic Gas suppresses Metronome!", true); return; }
  const p = G.players[player];
  if (!isPowerActive(p.active, 'Metronome')) { showToast('Clefable must be Active!', true); return; }
  const opp = G.players[player === 1 ? 2 : 1];
  if (!opp.active?.attacks?.length) { showToast('Opponent has no attacks to copy!', true); return; }

  const attacks = opp.active.attacks;
  if (attacks.length === 1) {
    addLog(`${p.active.name} uses Metronome — copying ${attacks[0].name}!`, true);
    closeActionMenu();
    await performAttack(player, attacks[0]);
    return;
  }

  closeActionMenu();
  showActionMenu('Metronome — choose attack to copy', attacks.map(atk => ({
    label: `⚔ ${atk.name}`,
    sub: `${atk.cost?.join(', ') || '—'} · ${atk.damage || '0'} dmg`,
    fn: async () => {
      addLog(`${p.active.name} uses Metronome — copying ${atk.name}!`, true);
      closeActionMenu();
      await performAttack(player, atk);
    }
  })), null);
}

// Slowbro — Strange Behavior
// Move 1 damage counter from any of your Pokémon to Slowbro.
async function doStrangeBehavior(player) {
  if (isMukActive()) { showToast("Muk's Toxic Gas suppresses Strange Behavior!", true); return; }
  const p = G.players[player];
  const slowbro = [p.active, ...p.bench].find(c => isPowerActive(c, 'Strange Behavior'));
  if (!slowbro) { showToast('Slowbro not in play!', true); return; }

  const sources = [p.active, ...p.bench].filter(c => c && c !== slowbro && (c.damage || 0) >= 10);
  if (!sources.length) { showToast('No Pokémon with damage counters to move!', true); return; }

  const picked = await openCardPicker({
    title: 'Strange Behavior',
    subtitle: `Choose a Pokémon to move 1 damage counter FROM (to Slowbro)`,
    cards: sources, maxSelect: 1
  });
  if (!picked) return;
  const src = sources[picked[0]];
  src.damage -= 10;
  slowbro.damage = (slowbro.damage || 0) + 10;
  addLog(`P${player} used Strange Behavior — moved 1 damage counter from ${src.name} to ${slowbro.name}.`, true);
  checkKO(player === 1 ? 2 : 1, player, slowbro, false);
  renderAll();
}

// Venomoth — Shift
// Change Venomoth's type to any type currently in play.
async function doShift(player) {
  if (isMukActive()) { showToast("Muk's Toxic Gas suppresses Shift!", true); return; }
  const p = G.players[player];
  if (!isPowerActive(p.active, 'Shift')) { showToast('Venomoth must be Active!', true); return; }

  // Collect all types currently in play
  const typesInPlay = new Set();
  for (const pNum of [1, 2]) {
    [G.players[pNum].active, ...G.players[pNum].bench].forEach(c => {
      if (c) (c.types || []).forEach(t => typesInPlay.add(t));
    });
  }
  const typeList = [...typesInPlay].filter(t => !/colorless/i.test(t));
  if (!typeList.length) { showToast('No non-Colorless types in play!', true); return; }

  const picked = await openCardPicker({
    title: 'Shift — Choose Type',
    subtitle: "Choose a type to change Venomoth's type to",
    cards: typeList.map(t => ({ name: t, images: { small: '' } })),
    maxSelect: 1
  });
  if (!picked) return;
  const chosenType = typeList[picked[0]];
  p.active.types = [chosenType];
  addLog(`P${player} used Shift — ${p.active.name} is now ${chosenType} type!`, true);
  renderAll();
}

// Dragonite — Step In
// Switch Dragonite from bench to Active.
function doStepIn(player, benchIdx) {
  if (isMukActive()) { showToast("Muk's Toxic Gas suppresses Step In!", true); return; }
  const p = G.players[player];
  const dragonite = p.bench[benchIdx];
  if (!isPowerActive(dragonite, 'Step In')) { showToast('Step In: Dragonite not on bench!', true); return; }
  const old = p.active;
  p.active = dragonite;
  p.bench[benchIdx] = old;
  addLog(`P${player} used Step In — ${dragonite.name} switched to Active!`, true);
  renderAll();
}

// Tentacool — Cowardice
// Return Tentacool to hand with all attachments discarded.
function doCowardice(player) {
  if (isMukActive()) { showToast("Muk's Toxic Gas suppresses Cowardice!", true); return; }
  const p = G.players[player];
  const tentacool = [p.active, ...p.bench].find(c => isPowerActive(c, 'Cowardice'));
  if (!tentacool) { showToast('Tentacool not in play!', true); return; }

  p.discard.push(...(tentacool.attachedEnergy || []));
  tentacool.attachedEnergy = []; tentacool.damage = 0; tentacool.status = null;
  p.hand.push(tentacool);

  if (p.active === tentacool) {
    p.active = null;
  } else {
    const idx = p.bench.findIndex(c => c === tentacool);
    if (idx !== -1) p.bench[idx] = null;
  }
  addLog(`P${player} used Cowardice — ${tentacool.name} returned to hand.`, true);
  renderAll();
}

// Mankey — Peek
// Look at top card of either deck or one card in opponent's hand.
async function doPeek(player) {
  if (isMukActive()) { showToast("Muk's Toxic Gas suppresses Peek!", true); return; }
  const opp = player === 1 ? 2 : 1;
  const choice = await new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:1100;
      display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;`;
    overlay.innerHTML = `
      <div style="font-family:var(--font);font-size:10px;color:var(--accent)">Peek — Choose What to Look At</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;">
        <button onclick="this.closest('div').parentElement.remove();window._peekChoice='myDeck'"
          style="font-family:var(--font);font-size:8px;padding:8px 14px;background:var(--surface2);border:1px solid var(--p1color);color:var(--p1color);cursor:pointer;border-radius:4px;">Your Deck (top card)</button>
        <button onclick="this.closest('div').parentElement.remove();window._peekChoice='oppDeck'"
          style="font-family:var(--font);font-size:8px;padding:8px 14px;background:var(--surface2);border:1px solid var(--p2color);color:var(--p2color);cursor:pointer;border-radius:4px;">Opp Deck (top card)</button>
        <button onclick="this.closest('div').parentElement.remove();window._peekChoice='oppHand'"
          style="font-family:var(--font);font-size:8px;padding:8px 14px;background:var(--surface2);border:1px solid var(--muted);color:var(--muted);cursor:pointer;border-radius:4px;">Opp Hand (1 card)</button>
      </div>`;
    document.body.appendChild(overlay);
    const interval = setInterval(() => {
      if (window._peekChoice !== undefined) {
        clearInterval(interval); const v = window._peekChoice; window._peekChoice = undefined; resolve(v);
      }
    }, 100);
  });

  if (choice === 'myDeck') {
    const card = G.players[player].deck[0];
    if (!card) { addLog('Peek: your deck is empty!'); return; }
    addLog(`P${player} used Peek — top card of own deck: ${card.name}.`, true);
    if (card.images?.large || card.images?.small) showCardDetail(card.images.large || card.images.small);
  } else if (choice === 'oppDeck') {
    const card = G.players[opp].deck[0];
    if (!card) { addLog('Peek: opponent\'s deck is empty!'); return; }
    addLog(`P${player} used Peek — top card of opponent's deck: ${card.name}.`, true);
    if (card.images?.large || card.images?.small) showCardDetail(card.images.large || card.images.small);
  } else if (choice === 'oppHand') {
    const hand = G.players[opp].hand;
    if (!hand.length) { addLog('Peek: opponent\'s hand is empty!'); return; }
    const picked = await openCardPicker({ title: 'Peek — Opponent\'s Hand', subtitle: 'Choose 1 card to look at', cards: hand, maxSelect: 1 });
    if (picked && picked.length) {
      const card = hand[picked[0]];
      addLog(`P${player} used Peek — saw ${card.name} in opponent's hand.`, true);
      if (card.images?.large || card.images?.small) showCardDetail(card.images.large || card.images.small);
    }
  }
}

// Vileplume — Heal
// Once per turn: flip a coin — heads = remove 1 damage counter from any of your Pokémon.
async function doHeal(player) {
  if (isMukActive()) { showToast("Muk's Toxic Gas suppresses Heal!", true); return; }
  const p = G.players[player];
  const damaged = [p.active, ...p.bench].filter(c => c && (c.damage || 0) >= 10);
  if (!damaged.length) { showToast('No Pokémon with damage counters!', true); return; }

  const heads = await flipCoin('Heal (Vileplume): Heads = remove 1 damage counter from a Pokémon');
  if (!heads) { addLog(`P${player} used Heal — TAILS! No effect.`); return; }

  let target = damaged[0];
  if (damaged.length > 1) {
    const picked = await openCardPicker({ title: 'Heal — Choose Pokémon', subtitle: 'Remove 1 damage counter from which Pokémon?', cards: damaged, maxSelect: 1 });
    if (picked && picked.length) target = damaged[picked[0]];
  }
  target.damage = Math.max(0, (target.damage || 0) - 10);
  addLog(`P${player} used Heal — HEADS! Removed 1 damage counter from ${target.name}.`, true);
  renderAll();
}

// ─────────────────────────────────────────────────────────────────────────────
// FIELD ACTION EXTRAS
// Returns additional actions to show in the action menu for a Pokémon slot.
// Called from showFieldActionMenu in the main HTML.
// ─────────────────────────────────────────────────────────────────────────────
function getFieldActionExtras(player, zone, benchIdx, card) {
  if (G.phase !== 'MAIN' || G.turn !== player) return [];
  if (isMukActive()) return [];

  const actions = [];

  // Alakazam — Damage Swap (on any slot, since Alakazam could be active or bench)
  if (damageSwapActive(player)) {
    actions.push({ label: '⚡ Damage Swap (Alakazam)', fn: () => { closeActionMenu(); doDamageSwap(player); } });
  }

  // Venusaur — Energy Trans
  if (energyTransActive(player)) {
    actions.push({ label: '🌿 Energy Trans (Venusaur)', fn: () => { closeActionMenu(); doEnergyTrans(player); } });
  }

  // Gengar — Curse (once per turn, Gengar on bench or active)
  if (!G.cursedThisTurn) {
    const p = G.players[player];
    if ([p.active, ...p.bench].some(c => isPowerActive(c, 'Curse'))) {
      actions.push({ label: '👻 Curse (Gengar)', fn: () => { closeActionMenu(); doCurse(player); } });
    }
  }

  // Clefable — Metronome (only from active slot)
  if (zone === 'active' && isPowerActive(card, 'Metronome')) {
    actions.push({ label: '🎵 Metronome (Clefable)', fn: () => doMetronome(player) });
  }

  // Electrode — Buzzap (only from bench slot)
  if (zone === 'bench' && isPowerActive(card, 'Buzzap')) {
    actions.push({ label: '⚡ Buzzap! (Electrode)', fn: () => { closeActionMenu(); doBuzzap(player, benchIdx); } });
  }

  // Slowbro — Strange Behavior (from any slot)
  if ([G.players[player].active, ...G.players[player].bench].some(c => isPowerActive(c, 'Strange Behavior'))) {
    actions.push({ label: '🌀 Strange Behavior (Slowbro)', fn: () => { closeActionMenu(); doStrangeBehavior(player); } });
  }

  // Venomoth — Shift (only from active slot)
  if (zone === 'active' && isPowerActive(card, 'Shift')) {
    actions.push({ label: '🦋 Shift (Venomoth)', fn: () => { closeActionMenu(); doShift(player); } });
  }

  // Dragonite — Step In (only from bench slot)
  if (zone === 'bench' && isPowerActive(card, 'Step In')) {
    actions.push({ label: '🐉 Step In (Dragonite)', fn: () => { closeActionMenu(); doStepIn(player, benchIdx); } });
  }

  // Tentacool — Cowardice (from any slot)
  if (isPowerActive(card, 'Cowardice')) {
    actions.push({ label: '🌊 Cowardice (Tentacool)', fn: () => { closeActionMenu(); doCowardice(player); } });
  }

  // Mankey — Peek (from any slot)
  if ([G.players[player].active, ...G.players[player].bench].some(c => isPowerActive(c, 'Peek'))) {
    actions.push({ label: '👁 Peek (Mankey)', fn: () => { closeActionMenu(); doPeek(player); } });
  }

  // Vileplume — Heal (from any slot)
  if (!G.healedThisTurn && [G.players[player].active, ...G.players[player].bench].some(c => isPowerActive(c, 'Heal'))) {
    actions.push({ label: '🌸 Heal (Vileplume)', fn: async () => { closeActionMenu(); await doHeal(player); G.healedThisTurn = true; } });
  }

  return actions;
}
