// ══════════════════════════════════════════════════════════════════════════════
// TRAINER-CARDS.JS — Name-keyed dispatch table for all Trainer cards
//
// Each entry in TRAINER_EFFECTS maps a card name (exactly as in cards.json)
// to an async handler function:
//
//   async handler(ctx) — executes the card's effect
//   ctx: { player, opp, p, oppP, card, handIdx, consume }
//     consume() — removes card from hand and puts in discard
//
// Public API (replaces playTrainer in pokemon-game.html):
//   async function playTrainer(player, handIdx)
//
// Shares access to all globals: G, flipCoin, openCardPicker, addLog,
// showToast, renderAll, drawCard, shuffle, enrichCard, showTrainerFlash,
// showLassModal, openPokedex, isTrainerBlocked
// ══════════════════════════════════════════════════════════════════════════════

const TRAINER_EFFECTS = {

  // ── Bill ─────────────────────────────────────────────────────────────────
  // Draw 2 cards.
  'Bill': async ({ player, consume }) => {
    consume();
    drawCard(player, true); drawCard(player, true);
    addLog(`P${player} played Bill — drew 2 cards.`, true);
    renderAll();
  },

  // ── Professor Oak ─────────────────────────────────────────────────────────
  // Discard your hand, draw 7 cards.
  'Professor Oak': async ({ player, p, card, handIdx, consume }) => {
    p.hand.splice(handIdx, 1); // remove Oak first
    p.discard.push(...p.hand, card);
    p.hand = [];
    for (let i = 0; i < 7; i++) drawCard(player, true);
    addLog(`P${player} played Professor Oak — discarded hand and drew 7.`, true);
    renderAll();
  },

  // ── Impostor Professor Oak ────────────────────────────────────────────────
  // Opponent shuffles hand INTO deck (not discard), then draws 7.
  'Impostor Professor Oak': async ({ player, oppP, consume }) => {
    consume();
    oppP.deck = shuffle([...oppP.deck, ...oppP.hand]);
    oppP.hand = [];
    for (let i = 0; i < 7 && oppP.deck.length; i++) oppP.hand.push(oppP.deck.shift());
    addLog(`P${player} played Impostor Professor Oak — opponent shuffled hand into deck and drew 7.`, true);
    renderAll();
  },

  // ── Potion ────────────────────────────────────────────────────────────────
  // Remove up to 2 damage counters (20 damage) from 1 of your Pokémon (active or bench).
  'Potion': async ({ player, p, consume }) => {
    const targets = [p.active, ...p.bench].filter(c => c && (c.damage || 0) > 0);
    if (!targets.length) { showToast('No damaged Pokémon to heal!', true); return; }
    consume();
    let target = targets[0];
    if (targets.length > 1) {
      const picked = await openCardPicker({ title: 'Potion', subtitle: 'Choose a Pokémon to heal (remove 20 damage)', cards: targets, maxSelect: 1 });
      if (picked && picked.length) target = targets[picked[0]];
    }
    target.damage = Math.max(0, target.damage - 20);
    addLog(`P${player} used Potion — removed 20 damage from ${target.name}.`, true);
    renderAll();
  },

  // ── Super Potion ──────────────────────────────────────────────────────────
  // Discard 1 energy from 1 of your Pokémon to remove 4 damage counters (40 damage) from it.
  // Can target active or bench. Player chooses which energy to discard.
  'Super Potion': async ({ player, p, consume }) => {
    const targets = [p.active, ...p.bench].filter(c => c && (c.damage || 0) > 0 && (c.attachedEnergy || []).length > 0);
    if (!targets.length) {
      const hasDamage = [p.active, ...p.bench].some(c => c && c.damage > 0);
      showToast(hasDamage ? 'Damaged Pokémon must have energy attached to use Super Potion!' : 'No damaged Pokémon to heal!', true);
      return;
    }
    // Step 1: choose which Pokémon to heal
    let target = targets[0];
    if (targets.length > 1) {
      const picked = await openCardPicker({ title: 'Super Potion — Choose Pokémon', subtitle: 'Choose a Pokémon to heal (removes 40 damage, costs 1 energy)', cards: targets, maxSelect: 1 });
      if (!picked?.length) { showToast('Super Potion cancelled.'); return; }
      target = targets[picked[0]];
    }
    // Step 2: choose which energy to discard
    let energyIdx = 0;
    if (target.attachedEnergy.length > 1) {
      const picked = await openCardPicker({ title: 'Super Potion — Discard Energy', subtitle: `Choose 1 energy to discard from ${target.name}`, cards: target.attachedEnergy, maxSelect: 1 });
      if (!picked?.length) { showToast('Super Potion cancelled.'); return; }
      energyIdx = picked[0];
    }
    consume();
    const discarded = target.attachedEnergy.splice(energyIdx, 1)[0];
    p.discard.push(discarded);
    target.damage = Math.max(0, target.damage - 40);
    addLog(`P${player} used Super Potion — discarded ${discarded.name} from ${target.name}, removed 40 damage.`, true);
    renderAll();
  },

  // ── Full Heal ─────────────────────────────────────────────────────────────
  // Cure Active Pokémon of all status conditions.
  'Full Heal': async ({ player, p, consume }) => {
    if (!p.active) { showToast('No active Pokémon!', true); return; }
    consume();
    p.active.status = null;
    addLog(`P${player} used Full Heal — ${p.active.name} is cured of all status conditions.`, true);
    renderAll();
  },

  // ── Full Restore ──────────────────────────────────────────────────────────
  // Heal all damage AND cure status from Active Pokémon.
  'Full Restore': async ({ player, p, consume }) => {
    if (!p.active) { showToast('No active Pokémon!', true); return; }
    consume();
    p.active.damage = 0;
    p.active.status = null;
    addLog(`P${player} used Full Restore — ${p.active.name} fully healed and cured.`, true);
    renderAll();
  },

  // ── Pokémon Center ────────────────────────────────────────────────────────
  // Remove all damage from all your Pokémon; discard all their energy.
  'Pokémon Center': async ({ player, p, consume }) => {
    consume();
    const healed = [];
    [p.active, ...p.bench].forEach(c => {
      if (!c || !c.damage) return;
      c.damage = 0;
      p.discard.push(...(c.attachedEnergy || []));
      c.attachedEnergy = [];
      healed.push(c.name);
    });
    addLog(`P${player} used Pokémon Center — healed all Pokémon, discarded energy: ${healed.join(', ') || 'none'}.`, true);
    renderAll();
  },

  // ── Max Potion ────────────────────────────────────────────────────────────
  // Remove all damage from 1 of your Pokémon; discard all its energy.
  'Max Potion': async ({ player, p, consume }) => {
    const targets = [p.active, ...p.bench].filter(c => c && c.damage > 0);
    if (!targets.length) { showToast('No damaged Pokémon to heal!', true); return; }
    consume();
    let target = targets[0];
    if (targets.length > 1) {
      const picked = await openCardPicker({ title: 'Max Potion', subtitle: 'Choose a Pokémon to fully heal', cards: targets, maxSelect: 1 });
      if (picked && picked.length) target = targets[picked[0]];
    }
    p.discard.push(...(target.attachedEnergy || []));
    target.attachedEnergy = [];
    target.damage = 0;
    addLog(`P${player} used Max Potion — ${target.name} fully healed, energy discarded.`, true);
    renderAll();
  },

  // ── Revive ────────────────────────────────────────────────────────────────
  // Return a Basic Pokémon from discard to bench at half HP.
  'Revive': async ({ player, p, consume }) => {
    const basics = p.discard.filter(c => c.supertype === 'Pokémon' && c.subtypes?.includes('Basic'));
    if (!basics.length) { showToast('No Basic Pokémon in discard!', true); return; }
    if (p.bench.every(s => s !== null)) { showToast('Bench is full!', true); return; }
    consume();
    let chosen = basics[0];
    if (basics.length > 1) {
      const picked = await openCardPicker({ title: 'Revive', subtitle: 'Choose a Basic Pokémon to revive', cards: basics, maxSelect: 1 });
      if (picked && picked.length) chosen = basics[picked[0]];
    }
    const idx = p.discard.findIndex(c => c === chosen);
    const revived = p.discard.splice(idx, 1)[0];
    const halfHp = parseInt(revived.hp) || 0;
    revived.damage = Math.floor(halfHp / 20) * 10; // half HP rounded DOWN to nearest 10
    revived.attachedEnergy = []; revived.status = null;
    const slot = p.bench.findIndex(s => s === null);
    p.bench[slot] = revived;
    addLog(`P${player} used Revive — ${revived.name} returned to bench at half HP.`, true);
    renderAll();
  },

  // ── Scoop Up ──────────────────────────────────────────────────────────────
  // Return a Basic Pokémon to hand, discarding all its attachments.
  'Scoop Up': async ({ player, p, consume }) => {
    const benchCount = p.bench.filter(s => s !== null).length;
    const targets = [];
    if (p.active?.subtypes?.includes('Basic') && !p.active.isDoll && benchCount >= 1)
      targets.push({ label: `Active: ${p.active.name}`, zone: 'active', idx: null });
    p.bench.forEach((b, i) => {
      if (b?.subtypes?.includes('Basic') && !b.isDoll)
        targets.push({ label: `Bench ${i+1}: ${b.name}`, zone: 'bench', idx: i });
    });
    if (!targets.length) { showToast('No eligible Basic Pokémon to scoop!', true); return; }
    consume();
    const doScoop = (zone, idx) => {
      const target = zone === 'active' ? p.active : p.bench[idx];
      p.discard.push(...(target.attachedEnergy || []));
      target.attachedEnergy = []; target.damage = 0; target.status = null;
      p.hand.push(target);
      if (zone === 'active') p.active = null; else p.bench[idx] = null;
      addLog(`P${player} used Scoop Up — ${target.name} returned to hand.`, true);
      renderAll();
    };
    if (targets.length === 1) { doScoop(targets[0].zone, targets[0].idx); return; }
    const picked = await openCardPicker({ title: 'Scoop Up', subtitle: 'Choose a Pokémon to return to hand', cards: targets.map(t => ({ name: t.label, images: { small: '' } })), maxSelect: 1 });
    if (picked && picked.length) doScoop(targets[picked[0]].zone, targets[picked[0]].idx);
  },

  // ── Switch ────────────────────────────────────────────────────────────────
  // Switch your Active Pokémon with one from your bench.
  'Switch': async ({ player, p, consume }) => {
    const benchSlots = p.bench.map((s, i) => ({ s, i })).filter(x => x.s !== null);
    if (!benchSlots.length) { showToast('No bench Pokémon to switch with!', true); return; }
    const doSwitch = ({ s, i }) => {
      consume();
      const old = p.active;
      if (old?.status) { addLog(`${old.name}'s ${old.status} cleared by Switch.`); old.status = null; }
      p.active = s; p.bench[i] = old;
      addLog(`P${player} used Switch — ${old?.name} ↔ ${p.active.name}.`, true);
      renderAll();
    };
    if (benchSlots.length === 1) { doSwitch(benchSlots[0]); return; }
    const picked = await openCardPicker({ title: 'Switch — Choose a Pokémon', subtitle: 'Choose a bench Pokémon to switch in', cards: benchSlots.map(x => x.s), maxSelect: 1 });
    if (picked && picked.length) doSwitch(benchSlots[picked[0]]);
  },

  // ── Gust of Wind ─────────────────────────────────────────────────────────
  // Force one of opponent's bench Pokémon to become Active.
  'Gust of Wind': async ({ player, opp, oppP, consume }) => {
    const bench = oppP.bench.map((s, i) => ({ s, i })).filter(x => x.s !== null);
    if (!bench.length) { showToast("Opponent has no bench Pokémon!", true); return; }
    const doGust = ({ s, i }) => {
      consume();
      const old = oppP.active;
      oppP.active = s; oppP.bench[i] = old;
      addLog(`P${player} used Gust of Wind — opponent's ${oppP.active.name} forced to Active.`, true);
      renderAll();
    };
    if (bench.length === 1) { doGust(bench[0]); return; }
    const picked = await openCardPicker({ title: "Gust of Wind — Choose Opponent's Pokémon", subtitle: 'Choose 1 to force Active', cards: bench.map(x => x.s), maxSelect: 1 });
    if (picked && picked.length) doGust(bench[picked[0]]);
  },

  // ── PlusPower ─────────────────────────────────────────────────────────────
  // Active Pokémon's next attack does +10 damage.
  'PlusPower': async ({ player, p, consume }) => {
    if (!p.active) { showToast('No Active Pokémon!', true); return; }
    consume();
    p.active.plusPower = (p.active.plusPower || 0) + 10;
    addLog(`P${player} attached PlusPower to ${p.active.name} (+10 damage next attack).`, true);
    renderAll();
  },

  // ── Defender ─────────────────────────────────────────────────────────────
  // Attach Defender to 1 of your Pokémon (active or bench).
  // Damage from attacks reduced by 20 (after W/R) until end of opponent's next turn.
  'Defender': async ({ player, p, consume }) => {
    const targets = [p.active, ...p.bench].filter(Boolean);
    if (!targets.length) { showToast('No Pokémon to attach Defender to!', true); return; }
    let target = targets[0];
    if (targets.length > 1) {
      const picked = await openCardPicker({ title: 'Defender', subtitle: 'Choose a Pokémon to attach Defender to (-20 damage next attack)', cards: targets, maxSelect: 1 });
      if (!picked?.length) { showToast('Defender cancelled.'); return; }
      target = targets[picked[0]];
    }
    consume();
    target.defender = true;
    addLog(`P${player} attached Defender to ${target.name} (-20 damage until end of opponent's next turn).`, true);
    renderAll();
  },

  // ── Energy Removal ────────────────────────────────────────────────────────
  // Choose 1 energy attached to an opponent's Pokémon and discard it.
  'Energy Removal': async ({ player, opp, oppP, consume }) => {
    const targets = [
      ...(oppP.active?.attachedEnergy?.length ? [{ card: oppP.active, zone: 'active', idx: null }] : []),
      ...oppP.bench.map((b, i) => b?.attachedEnergy?.length ? { card: b, zone: 'bench', idx: i } : null).filter(Boolean)
    ];
    if (!targets.length) { showToast("Opponent has no energy to remove!", true); return; }
    consume();
    let entry = targets[0];
    if (targets.length > 1) {
      const picked = await openCardPicker({ title: 'Energy Removal', subtitle: "Choose opponent's Pokémon to remove energy from", cards: targets.map(e => e.card), maxSelect: 1 });
      if (!picked?.length) { addLog('Energy Removal cancelled.'); renderAll(); return; }
      entry = targets[picked[0]];
    }
    const targetCard = entry.zone === 'active' ? oppP.active : oppP.bench[entry.idx];
    let removed;
    if (targetCard.attachedEnergy.length === 1) {
      removed = targetCard.attachedEnergy.splice(0, 1)[0];
    } else {
      const picked = await openCardPicker({ title: 'Energy Removal', subtitle: `Choose 1 energy to discard from ${targetCard.name}`, cards: targetCard.attachedEnergy, maxSelect: 1 });
      if (!picked?.length) { addLog('Energy Removal cancelled.'); renderAll(); return; }
      removed = targetCard.attachedEnergy.splice(picked[0], 1)[0];
    }
    oppP.discard.push(removed);
    addLog(`P${player} used Energy Removal — discarded ${removed.name} from ${targetCard.name}.`, true);
    renderAll();
  },

  // ── Super Energy Removal ──────────────────────────────────────────────────
  // Discard 1 of your own energy to remove up to 2 from an opponent's Pokémon.
  'Super Energy Removal': async ({ player, opp, p, oppP, consume }) => {
    const oppHasEnergy = [oppP.active, ...oppP.bench].some(c => c?.attachedEnergy?.length);
    if (!oppHasEnergy) { showToast("Opponent has no energy!", true); return; }
    if (!p.active?.attachedEnergy?.length) { showToast("Must discard 1 of your energy first!", true); return; }
    // Step 1: discard 1 of own energy
    let myCostIdx = 0;
    if (p.active.attachedEnergy.length > 1) {
      const picked = await openCardPicker({ title: 'Super Energy Removal — Your Cost', subtitle: `Discard 1 energy from your ${p.active.name}`, cards: p.active.attachedEnergy, maxSelect: 1 });
      if (!picked?.length) { addLog('Super Energy Removal cancelled.'); renderAll(); return; }
      myCostIdx = picked[0];
    }
    consume();
    const myRemoved = p.active.attachedEnergy.splice(myCostIdx, 1)[0];
    p.discard.push(myRemoved);
    addLog(`P${player} discarded ${myRemoved.name} from ${p.active.name} as cost.`);
    // Step 2: choose opponent's target
    const oppTargets = [
      ...(oppP.active?.attachedEnergy?.length ? [{ label: `Active: ${oppP.active.name}`, zone: 'active', idx: null }] : []),
      ...oppP.bench.map((b, i) => b?.attachedEnergy?.length ? { label: `Bench ${i+1}: ${b.name}`, zone: 'bench', idx: i } : null).filter(Boolean)
    ];
    let targetCard = oppP.active;
    if (oppTargets.length > 1) {
      const picked = await openCardPicker({ title: 'Super Energy Removal — Target', subtitle: "Choose opponent's Pokémon", cards: oppTargets.map(e => { const c = e.zone === 'active' ? oppP.active : oppP.bench[e.idx]; return { ...c, _entry: e }; }), maxSelect: 1 });
      if (!picked?.length) { addLog('Super Energy Removal cancelled.'); renderAll(); return; }
      const entry = oppTargets[picked[0]];
      targetCard = entry.zone === 'active' ? oppP.active : oppP.bench[entry.idx];
    }
    // Step 3: remove up to 2 energies
    let removed = [];
    if (targetCard.attachedEnergy.length <= 2) {
      removed = targetCard.attachedEnergy.splice(0);
    } else {
      const picked = await openCardPicker({ title: 'Super Energy Removal — Discard Energy', subtitle: `Choose up to 2 energy from ${targetCard.name}`, cards: targetCard.attachedEnergy, maxSelect: 2 });
      if (!picked?.length) { addLog('Super Energy Removal cancelled.'); renderAll(); return; }
      picked.sort((a,b)=>b-a).forEach(i => removed.push(...targetCard.attachedEnergy.splice(i, 1)));
    }
    oppP.discard.push(...removed);
    addLog(`P${player} used Super Energy Removal — discarded ${removed.length} energy from ${targetCard.name}.`, true);
    renderAll();
  },

  // ── Energy Retrieval ──────────────────────────────────────────────────────
  // Trade 1 other card from hand for up to 2 basic Energy from discard.
  // Player chooses which card to trade and which energies to retrieve.
  'Energy Retrieval': async ({ player, p, card, handIdx }) => {
    const basics = p.discard.filter(c => c.supertype === 'Energy' && !/double colorless/i.test(c.name));
    if (!basics.length) { showToast('No basic energy in discard!', true); return; }
    const others = p.hand.filter((_, i) => i !== handIdx);
    if (!others.length) { showToast('Need at least 1 other card to trade!', true); return; }
    // Step 1: choose 1 card from hand to discard as the trade cost
    let tradedCard = others[0];
    if (others.length > 1) {
      const picked = await openCardPicker({ title: 'Energy Retrieval — Trade Cost', subtitle: 'Choose 1 card from your hand to discard', cards: others, maxSelect: 1 });
      if (!picked?.length) { showToast('Energy Retrieval cancelled.'); return; }
      tradedCard = others[picked[0]];
    }
    // Step 2: choose up to 2 basic energies from discard to retrieve
    const energyPicked = await openCardPicker({ title: 'Energy Retrieval — Choose Energy', subtitle: 'Choose up to 2 basic Energy cards to retrieve', cards: basics, maxSelect: 2 });
    if (!energyPicked?.length) { showToast('Energy Retrieval cancelled.'); return; }
    // Execute: discard Retrieval + traded card, retrieve chosen energies
    p.hand.splice(handIdx, 1); p.discard.push(card);
    const tradeIdx = p.hand.findIndex(c => c === tradedCard);
    if (tradeIdx !== -1) p.discard.push(...p.hand.splice(tradeIdx, 1));
    energyPicked.map(i => basics[i]).forEach(e => {
      const di = p.discard.findIndex(c => c === e);
      if (di !== -1) p.hand.push(...p.discard.splice(di, 1));
    });
    addLog(`P${player} used Energy Retrieval — traded ${tradedCard.name}, retrieved ${energyPicked.length} energy card(s).`, true);
    renderAll();
  },

  // ── Energy Search ─────────────────────────────────────────────────────────
  // Search deck for any basic Energy card.
  'Energy Search': async ({ player, p, card, handIdx, consume }) => {
    const energy = p.deck.filter(c => c.supertype === 'Energy' && !/double colorless/i.test(c.name));
    if (!energy.length) { showToast('No basic energy in deck!', true); return; }
    consume();
    const picked = await openCardPicker({ title: 'Energy Search', subtitle: 'Choose 1 basic energy from your deck', cards: energy, maxSelect: 1 });
    if (!picked) { p.hand.push(card); p.discard.pop(); return; }
    const found = energy[picked[0]];
    const i = p.deck.findIndex(c => c === found);
    if (i !== -1) p.hand.push(...p.deck.splice(i, 1));
    p.deck = shuffle(p.deck);
    addLog(`P${player} used Energy Search — took ${found.name} from deck.`, true);
    renderAll();
  },

  // ── Computer Search ───────────────────────────────────────────────────────
  // Discard 2 cards from hand to search deck for any card.
  'Computer Search': async ({ player, p, card, handIdx }) => {
    const others = p.hand.filter((_, i) => i !== handIdx);
    if (others.length < 2) { showToast('Need at least 2 other cards in hand!', true); return; }
    if (!p.deck.length) { showToast('Deck is empty!', true); return; }
    const discardPicked = await openCardPicker({ title: 'Computer Search', subtitle: 'Discard exactly 2 cards from your hand', cards: others, maxSelect: 2 });
    if (!discardPicked || discardPicked.length < 2) { showToast('Must discard exactly 2 cards.', true); return; }
    p.hand.splice(handIdx, 1); p.discard.push(card);
    discardPicked.map(i => others[i]).forEach(dc => { const hi = p.hand.findIndex(c => c === dc); if (hi !== -1) p.discard.push(...p.hand.splice(hi, 1)); });
    const deckPicked = await openCardPicker({ title: 'Computer Search', subtitle: 'Choose any card from your deck', cards: p.deck, maxSelect: 1 });
    if (!deckPicked) { addLog(`P${player} used Computer Search — discarded 2 but found nothing.`, true); renderAll(); return; }
    const found = p.deck[deckPicked[0]];
    const di = p.deck.findIndex(c => c === found);
    if (di !== -1) p.hand.push(...p.deck.splice(di, 1));
    p.deck = shuffle(p.deck);
    addLog(`P${player} used Computer Search — discarded 2, found ${found.name}.`, true);
    renderAll();
  },

  // ── Item Finder ───────────────────────────────────────────────────────────
  // Discard 2 cards to retrieve any Trainer from discard.
  'Item Finder': async ({ player, p, card, handIdx }) => {
    const trainers = p.discard.filter(c => c.supertype === 'Trainer');
    if (!trainers.length) { showToast('No Trainer cards in discard!', true); return; }
    const others = p.hand.filter((_, i) => i !== handIdx);
    if (others.length < 2) { showToast('Need at least 2 other cards to discard!', true); return; }
    const discardPicked = await openCardPicker({ title: 'Item Finder', subtitle: 'Discard 2 cards from your hand', cards: others, maxSelect: 2 });
    if (!discardPicked || discardPicked.length < 2) { showToast('Item Finder cancelled.'); return; }
    p.hand.splice(handIdx, 1); p.discard.push(card);
    discardPicked.map(i => others[i]).forEach(dc => { const hi = p.hand.findIndex(c => c === dc); if (hi !== -1) p.discard.push(...p.hand.splice(hi, 1)); });
    const trainerPicked = await openCardPicker({ title: 'Item Finder', subtitle: 'Choose a Trainer from your discard', cards: trainers, maxSelect: 1 });
    if (!trainerPicked) { addLog(`P${player} used Item Finder — discarded 2 but found nothing.`, true); renderAll(); return; }
    const found = trainers[trainerPicked[0]];
    const di = p.discard.findIndex(c => c === found);
    if (di !== -1) p.hand.push(...p.discard.splice(di, 1));
    addLog(`P${player} used Item Finder — discarded 2, retrieved ${found.name}.`, true);
    renderAll();
  },

  // ── Maintenance ───────────────────────────────────────────────────────────
  // Shuffle 2 cards from hand into deck, draw 1.
  'Maintenance': async ({ player, p, card, handIdx }) => {
    const others = p.hand.filter((_, i) => i !== handIdx);
    if (others.length < 2) { showToast('Need at least 2 other cards in hand!', true); return; }
    const picked = await openCardPicker({ title: 'Maintenance', subtitle: 'Choose 2 cards to shuffle back into your deck', cards: others, maxSelect: 2 });
    if (!picked || picked.length < 2) { showToast('Maintenance cancelled.'); return; }
    p.hand.splice(handIdx, 1); p.discard.push(card);
    picked.map(i => others[i]).forEach(sc => { const hi = p.hand.findIndex(c => c === sc); if (hi !== -1) p.deck.push(...p.hand.splice(hi, 1)); });
    p.deck = shuffle(p.deck);
    drawCard(player, true);
    addLog(`P${player} used Maintenance — shuffled 2 cards back, drew 1.`, true);
    renderAll();
  },

  // ── Lass ──────────────────────────────────────────────────────────────────
  // Both players reveal hands; shuffle all Trainer cards from both hands into their decks.
  'Lass': async ({ player, p, card, handIdx }) => {
    p.hand.splice(handIdx, 1);
    const snapshots = {};
    for (const pNum of [1, 2]) {
      snapshots[pNum] = G.players[pNum].hand.map(c => ({ name: c.name, img: c.images?.small || '', isTrainer: c.supertype === 'Trainer' }));
    }
    const shuffled = { 1: [], 2: [] };
    for (const pNum of [1, 2]) {
      const pp = G.players[pNum];
      const trainers = pp.hand.filter(c => c.supertype === 'Trainer');
      trainers.forEach(t => { const i = pp.hand.findIndex(c => c === t); if (i !== -1) pp.deck.push(...pp.hand.splice(i, 1)); });
      pp.deck = shuffle(pp.deck);
      shuffled[pNum] = trainers.map(t => t.name);
    }
    p.deck.push(card); p.deck = shuffle(p.deck); // Lass itself goes into deck too
    addLog(`P${player} used Lass — P1 shuffled into deck: ${shuffled[1].join(', ')||'none'}; P2 shuffled into deck: ${shuffled[2].join(', ')||'none'}.`, true);
    G.pendingLass = { snapshots, player };
    renderAll();
    showLassModal(snapshots, player);
  },

  // ── Gambler ───────────────────────────────────────────────────────────────
  // Shuffle hand into deck. Flip coin: heads=draw 8, tails=draw 1.
  'Gambler': async ({ player, p, consume }) => {
    consume();
    p.deck = shuffle([...p.deck, ...p.hand]);
    p.hand = [];
    const heads = await flipCoin('Gambler: Heads = draw 8, Tails = draw 1');
    const count = heads ? 8 : 1;
    for (let i = 0; i < count && p.deck.length; i++) drawCard(player, true);
    addLog(`P${player} used Gambler — ${heads ? 'HEADS' : 'TAILS'}, drew ${count} card(s).`, true);
    renderAll();
  },

  // ── Recycle ───────────────────────────────────────────────────────────────
  // Flip coin: heads = player chooses any card from discard pile, puts it on top of deck.
  'Recycle': async ({ player, p, consume }) => {
    if (!p.discard.length) { showToast('Discard pile is empty!', true); return; }
    consume();
    const heads = await flipCoin('Recycle: Heads = choose a card from discard to put on top of deck');
    if (heads) {
      let chosen = p.discard[p.discard.length - 1];
      if (p.discard.length > 1) {
        const picked = await openCardPicker({ title: 'Recycle', subtitle: 'Choose a card from your discard to put on top of your deck', cards: p.discard, maxSelect: 1 });
        if (picked && picked.length) chosen = p.discard[picked[0]];
      }
      const di = p.discard.findIndex(c => c === chosen);
      if (di !== -1) p.deck.unshift(...p.discard.splice(di, 1));
      addLog(`P${player} used Recycle — HEADS! ${chosen.name} placed on top of deck.`, true);
    } else {
      addLog(`P${player} used Recycle — TAILS! No effect.`);
    }
    renderAll();
  },

  // ── Poké Ball ─────────────────────────────────────────────────────────────
  // Flip coin: heads = search deck for any Pokémon.
  'Poké Ball': async ({ player, p, consume }) => {
    consume();
    const heads = await flipCoin('Poké Ball: Heads = search deck for any Pokémon');
    if (heads) {
      const pokemon = p.deck.filter(c => c.supertype === 'Pokémon');
      if (!pokemon.length) { addLog(`P${player} used Poké Ball — HEADS but no Pokémon in deck.`); renderAll(); return; }
      const picked = await openCardPicker({ title: 'Poké Ball', subtitle: 'Choose a Pokémon from your deck', cards: pokemon, maxSelect: 1 });
      if (picked) {
        const found = pokemon[picked[0]];
        const i = p.deck.findIndex(c => c === found);
        if (i !== -1) p.hand.push(...p.deck.splice(i, 1));
        p.deck = shuffle(p.deck);
        addLog(`P${player} used Poké Ball — HEADS! Found ${found.name}.`, true);
      } else { addLog(`P${player} used Poké Ball — HEADS but no Pokémon chosen.`); }
    } else { addLog(`P${player} used Poké Ball — TAILS! No effect.`); }
    renderAll();
  },

  // ── Pokédex ───────────────────────────────────────────────────────────────
  // Look at top 5 cards of deck, rearrange in any order.
  'Pokédex': async ({ player, p, consume }) => {
    if (!p.deck.length) { showToast('Deck is empty!', true); return; }
    consume();
    await openPokedex(player);
    renderAll();
  },

  // ── Clefairy Doll ─────────────────────────────────────────────────────────
  // Play as a Basic Pokémon on bench. No prize on KO.
  'Clefairy Doll': async ({ player, p, card, consume }) => {
    if (p.bench.every(s => s !== null)) { showToast('Bench is full!', true); return; }
    consume();
    const doll = { ...card, name: 'Clefairy Doll', supertype: 'Pokémon', subtypes: ['Basic'], hp: '10', attacks: [], attachedEnergy: [], damage: 0, status: null, isDoll: true, canRetreat: false };
    p.bench[p.bench.findIndex(s => s === null)] = doll;
    addLog(`P${player} played Clefairy Doll to the bench.`, true);
    renderAll();
  },

  // ── Mysterious Fossil ─────────────────────────────────────────────────────
  // Play as a Basic Pokémon (Active or Bench). No prize on KO.
  'Mysterious Fossil': async ({ player, p, card, consume }) => {
    const hasActive = !!p.active;
    if (hasActive && p.bench.every(s => s !== null)) { showToast('Bench is full!', true); return; }
    const fossilUid = `fossil-${Math.random().toString(36).slice(2,9)}`;
    const fossil = { ...card, name: 'Mysterious Fossil', uid: fossilUid, supertype: 'Pokémon', subtypes: ['Basic'], hp: '10', attacks: [], attachedEnergy: [], damage: 0, status: null, isDoll: true, isFossil: true, canRetreat: false };
    consume();
    if (!G.evolvedThisTurn) G.evolvedThisTurn = [];
    G.evolvedThisTurn.push(fossilUid);
    if (!hasActive) { p.active = fossil; addLog(`P${player} played Mysterious Fossil as their Active.`, true); }
    else { p.bench[p.bench.findIndex(s => s === null)] = fossil; addLog(`P${player} played Mysterious Fossil to the bench.`, true); }
    renderAll();
  },

  // ── Mr. Fuji ──────────────────────────────────────────────────────────────
  // Shuffle a bench Pokémon and all its attachments into your deck.
  'Mr. Fuji': async ({ player, p, consume }) => {
    const bench = p.bench.filter(s => s !== null);
    if (!bench.length) { showToast('No bench Pokémon to choose!', true); return; }
    consume();
    let target = bench[0];
    if (bench.length > 1) {
      const picked = await openCardPicker({ title: 'Mr. Fuji', subtitle: 'Choose a bench Pokémon to shuffle into deck', cards: bench, maxSelect: 1 });
      if (picked && picked.length) target = bench[picked[0]];
    }
    const idx = p.bench.findIndex(s => s === target);
    p.bench[idx] = null;
    p.deck.push(target, ...(target.attachedEnergy || []));
    p.deck = shuffle(p.deck);
    addLog(`P${player} used Mr. Fuji — ${target.name} and attachments shuffled into deck.`, true);
    renderAll();
  },

  // ── Devolution Spray ──────────────────────────────────────────────────────
  // Discard ALL Evolution cards (Stage 1 and Stage 2) from the chosen Pokémon,
  // returning it to its Basic form. Clears all status conditions.
  'Devolution Spray': async ({ player, p, consume }) => {
    const evolved = [];
    if (p.active?.subtypes?.includes('Stage 1') || p.active?.subtypes?.includes('Stage 2')) evolved.push({ label: `Active: ${p.active.name}`, zone: 'active', idx: null });
    p.bench.forEach((b, i) => { if (b?.subtypes?.includes('Stage 1') || b?.subtypes?.includes('Stage 2')) evolved.push({ label: `Bench ${i+1}: ${b.name}`, zone: 'bench', idx: i }); });
    if (!evolved.length) { showToast('No evolved Pokémon to devolve!', true); return; }
    consume();

    const doDevolution = (zone, idx) => {
      const target = zone === 'active' ? p.active : p.bench[idx];
      if (!target?.evolvesFrom) return;

      // Collect the full evolution chain of this card by tracing evolvesFrom
      // We need to find the Basic — look through hand, discard, deck for each stage
      const allCards = [...p.hand, ...p.discard, ...p.deck];
      const discardedEvolutions = [target];
      let current = target;

      // Walk back through the chain until we find a Basic
      while (current.subtypes?.includes('Stage 1') || current.subtypes?.includes('Stage 2')) {
        const preEvoName = current.evolvesFrom;
        if (!preEvoName) break;
        const preEvo = allCards.find(c => c.name === preEvoName && c.supertype === 'Pokémon');
        if (!preEvo) break;
        if (preEvo.subtypes?.includes('Basic')) {
          // Found the Basic — restore it
          const src = p.hand.includes(preEvo) ? p.hand : p.discard.includes(preEvo) ? p.discard : p.deck;
          const si = src.findIndex(c => c === preEvo);
          const restored = src.splice(si, 1)[0];
          restored.damage = target.damage;
          restored.attachedEnergy = target.attachedEnergy;
          restored.status = null;
          // Discard all evolution cards in the chain
          discardedEvolutions.forEach(e => p.discard.push(e));
          if (zone === 'active') p.active = restored; else p.bench[idx] = restored;
          addLog(`P${player} used Devolution Spray — ${target.name} devolved to ${restored.name} (discarded ${discardedEvolutions.map(e=>e.name).join(', ')}).`, true);
          renderAll();
          return;
        } else {
          // Intermediate stage — add to discard list and continue walking back
          discardedEvolutions.push(preEvo);
          const src = p.hand.includes(preEvo) ? p.hand : p.discard.includes(preEvo) ? p.discard : p.deck;
          const si = src.findIndex(c => c === preEvo);
          if (si !== -1) src.splice(si, 1); // remove from source, will be discarded
          current = preEvo;
        }
      }
      // No Basic found — discard all and leave slot empty
      discardedEvolutions.forEach(e => p.discard.push(e));
      if (zone === 'active') p.active = null; else p.bench[idx] = null;
      addLog(`P${player} used Devolution Spray — ${target.name} discarded (no Basic found).`, true);
      renderAll();
    };

    if (evolved.length === 1) { doDevolution(evolved[0].zone, evolved[0].idx); return; }
    const picked = await openCardPicker({ title: 'Devolution Spray', subtitle: 'Choose a Pokémon to devolve to Basic', cards: evolved.map(e => ({ name: e.label, images: { small: '' } })), maxSelect: 1 });
    if (picked && picked.length) doDevolution(evolved[picked[0]].zone, evolved[picked[0]].idx);
  },

  // ── Pokémon Trader ────────────────────────────────────────────────────────
  // Trade a Pokémon in hand for one in deck.
  'Pokémon Trader': async ({ player, p, card, handIdx }) => {
    const handPokemon = p.hand.filter((c, i) => i !== handIdx && c.supertype === 'Pokémon');
    const deckPokemon = p.deck.filter(c => c.supertype === 'Pokémon');
    if (!handPokemon.length) { showToast('No other Pokémon in hand to trade!', true); return; }
    if (!deckPokemon.length) { showToast('No Pokémon in deck!', true); return; }
    const fromHand = await openCardPicker({ title: 'Pokémon Trader', subtitle: 'Choose a Pokémon from your hand to trade', cards: handPokemon, maxSelect: 1 });
    if (!fromHand) { showToast('Pokémon Trader cancelled.'); return; }
    const fromDeck = await openCardPicker({ title: 'Pokémon Trader', subtitle: 'Choose a Pokémon from your deck to take', cards: deckPokemon, maxSelect: 1 });
    if (!fromDeck) { showToast('Pokémon Trader cancelled.'); return; }
    p.hand.splice(handIdx, 1); p.discard.push(card);
    const handPoke = handPokemon[fromHand[0]];
    const hi = p.hand.findIndex(c => c === handPoke);
    if (hi !== -1) p.deck.push(...p.hand.splice(hi, 1));
    const deckPoke = deckPokemon[fromDeck[0]];
    const di = p.deck.findIndex(c => c === deckPoke);
    if (di !== -1) p.hand.push(...p.deck.splice(di, 1));
    p.deck = shuffle(p.deck);
    addLog(`P${player} used Pokémon Trader — traded ${handPoke.name} for ${deckPoke.name}.`, true);
    renderAll();
  },

  // ── Pokémon Breeder ───────────────────────────────────────────────────────
  // Play a Stage 2 directly onto its matching Basic, skipping Stage 1.
  // Can only be used when you would normally be allowed to evolve that Pokémon
  // (not the turn the Basic was played, not turn 1).
  'Pokémon Breeder': async ({ player, p, card, handIdx }) => {
    const stage2s = p.hand.filter((c, i) => i !== handIdx && c.subtypes?.includes('Stage 2'));
    if (!stage2s.length) { showToast('No Stage 2 Pokémon in hand!', true); return; }
    const picked = await openCardPicker({ title: 'Pokémon Breeder', subtitle: 'Choose a Stage 2 to play directly', cards: stage2s, maxSelect: 1 });
    if (!picked) { showToast('Pokémon Breeder cancelled.'); return; }
    const stage2 = stage2s[picked[0]];

    // Trace evolution chain to find matching Basic name
    const allCards = [...p.hand, ...p.discard, ...p.deck];
    const stage1 = allCards.find(c => c.subtypes?.includes('Stage 1') && c.name === stage2.evolvesFrom);
    const rootBasicName = stage1?.evolvesFrom || stage2.evolvesFrom;

    // Valid targets: matching Basic that wasn't played this turn
    const allInPlay = [p.active, ...p.bench].filter(Boolean);
    const validTargets = allInPlay.filter(c =>
      c.supertype === 'Pokémon' &&
      c.subtypes?.includes('Basic') &&
      c.name === rootBasicName &&
      !(G.evolvedThisTurn || []).includes(c.uid)
    );

    if (!validTargets.length) {
      const hasBasic = allInPlay.some(c => c.name === rootBasicName);
      showToast(hasBasic
        ? `${rootBasicName} was played this turn and can't be evolved yet!`
        : `No matching Basic (${rootBasicName}) in play for ${stage2.name}!`, true);
      return;
    }
    p.hand.splice(handIdx, 1); p.discard.push(card);
    const s2idx = p.hand.findIndex(c => c === stage2);
    if (s2idx !== -1) p.hand.splice(s2idx, 1);

    const targetSlots = validTargets.map(c => ({
      zone: p.active === c ? 'active' : 'bench',
      idx: p.bench.indexOf(c),
    }));
    const doBreed = ({ zone, idx }) => {
      const tCard = zone === 'active' ? p.active : p.bench[idx];
      stage2.damage = tCard.damage || 0; stage2.attachedEnergy = tCard.attachedEnergy || []; stage2.status = null;
      if (!G.evolvedThisTurn) G.evolvedThisTurn = [];
      G.evolvedThisTurn.push(stage2.uid);
      if (zone === 'active') p.active = stage2; else p.bench[idx] = stage2;
      addLog(`P${player} used Pokémon Breeder — ${tCard.name} → ${stage2.name}!`, true);
      renderAll();
    };
    if (targetSlots.length === 1) { doBreed(targetSlots[0]); return; }
    const tpicked = await openCardPicker({ title: 'Pokémon Breeder — Target', subtitle: 'Choose which Pokémon to evolve', cards: validTargets, maxSelect: 1 });
    if (tpicked && tpicked.length) doBreed(targetSlots[tpicked[0]]);
  },

  // ── Pokémon Flute ─────────────────────────────────────────────────────────
  // Put a Basic from opponent's discard onto their bench.
  'Pokémon Flute': async ({ player, opp, oppP, consume }) => {
    const basics = oppP.discard.filter(c => c.supertype === 'Pokémon' && c.subtypes?.includes('Basic'));
    if (!basics.length) { showToast("No Basic Pokémon in opponent's discard!", true); return; }
    if (oppP.bench.every(s => s !== null)) { showToast("Opponent's bench is full!", true); return; }
    const picked = await openCardPicker({ title: "Pokémon Flute", subtitle: "Choose a Basic from opponent's discard", cards: basics, maxSelect: 1 });
    if (!picked) { showToast('Pokémon Flute cancelled.'); return; }
    consume();
    const chosen = basics[picked[0]];
    const di = oppP.discard.findIndex(c => c === chosen);
    if (di !== -1) {
      const moved = oppP.discard.splice(di, 1)[0];
      moved.damage = 0; moved.attachedEnergy = []; moved.status = null;
      oppP.bench[oppP.bench.findIndex(s => s === null)] = moved;
      addLog(`P${player} used Pokémon Flute — ${moved.name} placed on opponent's bench.`, true);
    }
    renderAll();
  },

};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API — replaces the inline playTrainer function
// ─────────────────────────────────────────────────────────────────────────────
async function playTrainer(player, handIdx) {
  const p = G.players[player];
  const opp = player === 1 ? 2 : 1;
  const oppP = G.players[opp];
  const card = p.hand[handIdx];
  if (!card) return;
  const name = card.name;

  // Flash trainer card name for the opponent
  showTrainerFlash(player, name);

  // Headache block — opponent can't play Trainer cards this turn
  if (typeof isTrainerBlocked === 'function' && isTrainerBlocked(player)) {
    showToast(`Headache prevents playing Trainer cards this turn!`, true);
    addLog(`P${player} tried to play ${name} but is blocked by Headache!`, true);
    return;
  }

  // Helper: remove card from hand and discard it
  const consume = () => { p.hand.splice(handIdx, 1); p.discard.push(card); };

  const handler = TRAINER_EFFECTS[name];
  if (handler) {
    await handler({ player, opp, p, oppP, card, handIdx, consume });
    return;
  }

  // Fallback for any unimplemented trainer
  const rules = card.rules?.[0] || '';
  consume();
  addLog(`P${player} played ${name}. (effect not yet automated)`, true);
  showToast(`${name}: ${rules.substring(0, 60)}...`);
  renderAll();
}
