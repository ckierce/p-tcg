// ══════════════════════════════════════════════════════════════════════════════
// MOVE-EFFECTS.JS — Name-keyed dispatch table for Pokémon TCG special attacks
//
// Each entry in MOVE_EFFECTS maps an attack name (exactly as in cards.json) to
// an object with up to three optional hooks plus an optional metadata flag:
//
//   preAttack(ctx)      — runs BEFORE damage. Return 'block' to cancel attack.
//   modifyDamage(ctx)   — runs AFTER coin-flip damage, BEFORE W/R. Return new dmg.
//   postAttack(ctx)     — runs AFTER damage + KO check. Return true to skip endTurn.
//   allowVanilla        — opt-in: run this handler even when the attack's card
//                         text is EMPTY. By default `getMoveEffect` refuses to
//                         attach a handler to a text-less attack, because the
//                         table is keyed by attack NAME and many names are
//                         shared across cards with different effects (Victreebel's
//                         Acid flips for can't-retreat; Tentacool's Acid is a
//                         plain 10). Only Slash needs this: its text is blank on
//                         every card but Scyther's Swords Dance boosts it.
//   requireText         — optional RegExp the attack's text must match for the
//                         handler to apply. Use when two cards share a name AND
//                         both have text, but only one has this effect.
//   targetsDefender     — true if postAttack ONLY does things to the opponent's
//                         Active Pokémon (status, energy discard, smokescreen,
//                         disable, etc.). When the defender has Agility/Barrier
//                         heads or Transparency heads (both surfaced as
//                         `atk._defenderEffectsBlocked`), `applyMoveEffects`
//                         will skip handlers flagged this way — per WotC ruling
//                         that these effects only block things "done TO" the
//                         defender, NOT self-effects on the attacker (Fetch,
//                         drains, etc.) nor effects on the bench. If a handler
//                         does BOTH (e.g. Foul Odor confuses both, Mirror Move
//                         reflects damage), leave this flag off and check
//                         `atk._defenderEffectsBlocked` INSIDE the handler to
//                         skip only the defender-targeting portion.
//
// ctx always contains: { player, opp, atk, dmg, dmgDealt, myActive, oppActive }
//
// Public API (called from performAttack hooks in pokemon-game.html):
//   preAttackChecks(player, atk, myActive, oppActive)       → 'block' or null
//   preDamageModify(player, atk, dmg, myActive, oppActive)  → new dmg number
//   applyMoveEffects(player, atk, dmgDealt, myActive, opp)  → true or undefined
// ══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// SHARED HANDLER FACTORIES
// ─────────────────────────────────────────────────────────────────────────────

// No-flip status on opponent
const _statusOpp = (status) => ({
  targetsDefender: true,
  postAttack: async ({ oppActive, atk }) => {
    if (!oppActive) return;
    tryApplyStatus(oppActive, status);
    addLog(`${atk.name}: ${oppActive.name} is now ${status}!`, true);
  }
});

// Flip → heads = status on opponent
const _statusOppFlip = (status) => ({
  targetsDefender: true,
  postAttack: async ({ oppActive, atk }) => {
    if (!oppActive) return;
    const heads = await flipCoin(`${atk.name}: Heads = ${oppActive.name} is now ${status}!`);
    if (heads) {
      tryApplyStatus(oppActive, status);
      addLog(`${atk.name}: HEADS — ${oppActive.name} is now ${status}!`, true);
    } else {
      addLog(`${atk.name}: TAILS — no ${status}.`);
    }
  }
});

// Flip → heads = full damage prevention on self next turn
const _selfProtectFlip = () => ({
  postAttack: async ({ myActive, atk }) => {
    if (!myActive) return;
    const heads = await flipCoin(`${atk.name}: Heads = ${myActive.name} protected next turn!`);
    if (heads) {
      myActive.defender = true; myActive.defenderFull = true;
      addLog(`${atk.name}: HEADS — ${myActive.name} protected from all damage next turn!`, true);
    } else {
      addLog(`${atk.name}: TAILS — no protection.`);
    }
  }
});

// Flip → heads = immune to all attack effects (Agility-style)
const _agilityFlip = () => ({
  postAttack: async ({ myActive, atk }) => {
    if (!myActive) return;
    const heads = await flipCoin(`${atk.name}: Heads = immune to all attack effects next turn!`);
    if (heads) {
      myActive.defender = true; myActive.defenderFull = true; myActive.defenderFullEffects = true;
      addLog(`${atk.name}: HEADS — ${myActive.name} fully protected next turn!`, true);
    } else {
      addLog(`${atk.name}: TAILS — no protection.`);
    }
  }
});

// Deal `dmg` to the Pokémon in bench slot `i` of player `pNum` (KO → prize).
function _hitBench(pNum, i, dmg, label) {
  const c = G.players[pNum].bench[i];
  if (!c) return;
  c.damage = (c.damage || 0) + dmg;
  addLog(`${label}: ${dmg} damage to P${pNum}'s ${c.name}! (${c.damage}/${c.hp} HP)`);
  const hp = parseInt(c.hp) || 0;
  if (hp > 0 && c.damage >= hp) {
    addLog(`${c.name} was knocked out!`, true);
    koBenchAndPrize(pNum, i);
  }
}

// Bench damage lives in preAttack (not postAttack) so it still resolves when
// the main hit Knocks Out the Defending Pokémon — performAttack returns early
// on a KO to run the promotion flow, which used to swallow Blizzard's flip,
// Spark's splash, etc. TCG rule: bench damage happens regardless of the KO.
// Choose 1 opp bench → N damage to it (Spark / Stretch Kick style)
const _benchDamageN = (n) => ({
  preAttack: async ({ opp, atk }) => {
    const bench = G.players[opp].bench.map((s, i) => ({ s, i })).filter(x => x.s !== null);
    if (!bench.length) { addLog(`${atk.name}: no opponent bench to target.`); return null; }
    let target = bench[0];
    if (bench.length > 1) {
      const picked = await openCardPicker({
        title: `${atk.name} — Bench Damage`,
        subtitle: `Choose 1 of opponent's Benched Pokémon for ${n} damage`,
        cards: bench.map(x => x.s), maxSelect: 1
      });
      if (picked && picked.length) target = bench[picked[0]];
    }
    _hitBench(opp, target.i, n, atk.name);
    renderAll();
    return null;
  }
});
const _benchDamage10 = () => _benchDamageN(10);
const _benchDamage20 = () => _benchDamageN(20);

// Pounce-style: incoming damage from the Defending Pokémon is reduced by 10
// next turn (after W/R). Consumed via `pounceActive` in applyDamageModifiers;
// benching either Pokémon ends it (clearActiveOnlyEffects / endTurnEffectsCleanup).
const _reduceIncomingBy10 = () => ({
  postAttack: async ({ myActive, atk }) => {
    if (!myActive) return;
    myActive.pounceActive = true;
    addLog(`${atk.name}: incoming attack next turn does 10 less damage!`, true);
  }
});

// Drain: heal self by (fraction × dmgDealt) rounded up to nearest 10
const _drain = (fraction) => ({
  postAttack: async ({ myActive, dmgDealt, atk }) => {
    if (!myActive || dmgDealt <= 0) return;
    const heal = Math.ceil((dmgDealt * fraction) / 10) * 10;
    myActive.damage = Math.max(0, (myActive.damage || 0) - heal);
    addLog(`${atk.name}: ${myActive.name} healed ${heal} damage!`, true);
  }
});

// Discard 1 energy from opponent's active (Hyper Beam / Whirlpool)
// Uses ctx.oppActive snapshot — the Pokémon that was defending when the attack
// landed, not whoever is currently active (which may be null if KO'd or
// different if a switch happened mid-attack).
const _discardOppEnergy = () => ({
  targetsDefender: true,
  postAttack: async ({ opp, oppActive, atk }) => {
    // oppActive is the snapshot passed from performAttack. Fall back to current
    // active only if the snapshot is somehow missing.
    const target = oppActive || G.players[opp].active;
    if (!target || !(target.attachedEnergy || []).length) {
      addLog(`${atk.name}: opponent has no energy to discard.`); return;
    }
    // Always prompt — even with one energy, the player should see what's being
    // discarded and confirm. TCG rule: attacker chooses which energy to discard.
    const picked = await openCardPicker({
      title: `${atk.name} — Discard Energy`,
      subtitle: `Choose 1 energy to discard from ${target.name}`,
      cards: target.attachedEnergy, maxSelect: 1
    });
    const idx = (picked && picked.length) ? picked[0] : 0;
    const removed = target.attachedEnergy.splice(idx, 1)[0];
    G.players[opp].discard.push(removed);
    addLog(`${atk.name}: discarded ${removed.name} from ${target.name}!`, true);
    renderAll();
  }
});

// Smokescreen / Sand-attack: opponent must flip to attack next turn (tails = does nothing)
const _smokescreen = () => ({
  targetsDefender: true,
  postAttack: async ({ oppActive, atk }) => {
    if (!oppActive) return;
    oppActive.smokescreened = true;
    addLog(`${atk.name}: ${oppActive.name} must flip to attack next turn — tails = no attack!`, true);
  }
});

// Tail Wag / Leer: flip — heads = defending Pokémon can't attack this Pokémon next turn
const _tailWag = () => ({
  postAttack: async ({ myActive, atk }) => {
    if (!myActive) return;
    const heads = await flipCoin(`${atk.name}: Heads = opponent can't attack ${myActive.name} next turn!`);
    if (heads) {
      myActive.immuneToAttack = true;
      addLog(`${atk.name}: HEADS — opponent can't attack ${myActive.name} next turn!`, true);
    } else {
      addLog(`${atk.name}: TAILS — no effect.`);
    }
  }
});

// Search deck for a named Basic and bench it (Call for Family variants)
//
// targetName is either a single string or an array of target names. Names are
// matched gender-tolerantly (♀/♂ stripped) because cards.json stores Nidoran
// lines as "Nidoran" without the gender symbol, matching the existing pattern
// in trainer-cards.js (search for _normName there).
//
// If multiple matches exist in deck, prompts the player to pick one.
// If zero matches, surfaces a visible toast (not just a log line) so the
// player understands why nothing happened.
const _normName = n => (n || '').replace(/[♀♂]/g, '').trim();
const _callForFamily = (targetName) => ({
  postAttack: async ({ player, atk }) => {
    const myP = G.players[player];
    const slot = myP.bench.findIndex(s => s === null);
    if (slot === -1) {
      addLog(`${atk.name}: bench is full!`, true);
      if (typeof showToast === 'function') showToast(`${atk.name}: bench is full!`, true);
      return;
    }
    const names = (Array.isArray(targetName) ? targetName : [targetName]).map(_normName);
    const candidates = myP.deck.filter(c =>
      c.supertype === 'Pokémon' &&
      c.subtypes?.includes('Basic') &&
      names.includes(_normName(c.name))
    );
    if (!candidates.length) {
      addLog(`${atk.name}: no matching Basic in deck.`, true);
      if (typeof showToast === 'function') showToast(`${atk.name}: no matching Basic in deck.`, true);
      // Shuffle the deck anyway — the attack still "searched" per TCG rules.
      myP.deck = shuffle(myP.deck);
      return;
    }
    let chosen = candidates[0];
    if (candidates.length > 1) {
      const picked = await openCardPicker({
        title: atk.name,
        subtitle: 'Choose a Basic Pokémon to put onto your Bench',
        cards: candidates,
        maxSelect: 1,
      });
      if (picked && picked.length) chosen = candidates[picked[0]];
    }
    const di = myP.deck.findIndex(c => c === chosen);
    if (di !== -1) {
      chosen.damage = 0; chosen.attachedEnergy = []; clearAllStatus(chosen);
      myP.bench[slot] = myP.deck.splice(di, 1)[0];
      myP.deck = shuffle(myP.deck);
      addLog(`${atk.name}: ${chosen.name} placed on bench!`, true);
      renderAll();
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function roundUp10(n) { return Math.ceil(n / 10) * 10; }
const ALL_TYPES = ['Fire','Water','Grass','Lightning','Psychic','Fighting','Darkness','Metal','Colorless'];

function pickType(title) {
  return new Promise(resolve => {
    const existing = document.getElementById('type-picker-overlay');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'type-picker-overlay';
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:1100;
      display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;`;
    const titleEl = document.createElement('div');
    titleEl.textContent = title;
    titleEl.style.cssText = 'font-family:var(--font);font-size:10px;color:var(--accent);text-align:center;';
    const grid = document.createElement('div');
    grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;justify-content:center;max-width:360px;';
    ALL_TYPES.forEach(type => {
      const btn = document.createElement('button');
      btn.style.cssText = `background:var(--surface2);border:1px solid var(--border2);color:var(--text);
        font-family:var(--font);font-size:8px;padding:8px 12px;cursor:pointer;border-radius:4px;
        display:flex;align-items:center;gap:6px;`;
      const iconEl = document.createElement('span');
      if (typeof energyIcon === 'function') iconEl.innerHTML = energyIcon(type, 16);
      else iconEl.textContent = type[0];
      btn.appendChild(iconEl);
      btn.appendChild(document.createTextNode(type));
      btn.addEventListener('click', () => { overlay.remove(); resolve(type); });
      grid.appendChild(btn);
    });
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = `background:none;border:1px solid var(--border2);color:var(--muted);
      font-family:var(--font);font-size:8px;padding:6px 14px;cursor:pointer;border-radius:4px;margin-top:4px;`;
    cancelBtn.addEventListener('click', () => { overlay.remove(); resolve(null); });
    overlay.appendChild(titleEl); overlay.appendChild(grid); overlay.appendChild(cancelBtn);
    document.body.appendChild(overlay);
  });
}

async function forceOpponentSwitch(opp, attackerChooses, attackName) {
  const oppP = G.players[opp];
  const bench = oppP.bench.map((s, i) => ({ s, i })).filter(x => x.s !== null);
  if (!bench.length) return;
  const doSwitch = (idx) => {
    const entry = bench.find(x => x.i === idx);
    if (!entry) return;
    const old = oppP.active;
    // Multi-status: per TCG rules, all special conditions are removed when
    // a Pokémon leaves the active spot — including via forced switches like
    // Whirlwind, Terror Strike, Ram, and Hurricane's promote step. Without
    // this clear, a Poisoned/Asleep/etc. active that gets benched would
    // continue carrying its status on the bench.
    if (old) {
      const conds = (typeof activeStatuses === 'function')
        ? activeStatuses(old)
        : (old.status ? [old.status] : []);
      if (conds.length) addLog(`${old.name}'s ${conds.join(' and ')} cleared on being benched.`);
      if (typeof clearAllStatus === 'function') clearAllStatus(old);
      // Attack effects bound to being Active (Smokescreen, Swords Dance, …)
      // end when the Pokémon is benched — same as retreat / Switch / Gust.
      if (typeof clearActiveOnlyEffects === 'function') clearActiveOnlyEffects(old);
    }
    oppP.active = entry.s; oppP.bench[idx] = old;
    // Defensive pad — bench should always be exactly 5 slots
    while (oppP.bench.length < 5) oppP.bench.push(null);
    addLog(`${attackName}: P${opp}'s ${entry.s.name} forced to Active!`, true);
    renderAll();
  };
  if (bench.length === 1) { doSwitch(bench[0].i); return; }
  if (attackerChooses) {
    const picked = await openCardPicker({
      title: `${attackName} — Choose Opponent's Pokémon`,
      subtitle: `Choose 1 of P${opp}'s Benched Pokémon to force Active`,
      cards: bench.map(x => x.s), maxSelect: 1
    });
    if (picked && picked.length) doSwitch(bench[picked[0]].i);
  } else {
    return new Promise(resolve => {
      addLog(`P${opp} must choose a bench Pokémon to switch in (${attackName})!`, true);
      bench.forEach(({ i }) => document.getElementById(`bench-p${opp}-${i}`)?.classList.add('highlight'));
      window._forceSwitchHandler = { opp, benchSlots: bench, resolve: (idx) => {
        for (let k = 0; k < 5; k++) document.getElementById(`bench-p${opp}-${k}`)?.classList.remove('highlight');
        window._forceSwitchHandler = null;
        doSwitch(idx); resolve();
      }};
    });
  }
}

function prophecyModal(player, targetPlayer, numCards) {
  return new Promise(resolve => {
    const deck = G.players[targetPlayer].deck;
    if (!deck.length) { addLog('Prophecy: deck is empty!'); resolve(); return; }
    const n = Math.min(numCards, deck.length);
    const topCards = deck.slice(0, n);
    const existing = document.getElementById('prophecy-overlay');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'prophecy-overlay';
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:1100;
      display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;`;
    const title = document.createElement('div');
    title.textContent = `Prophecy — P${targetPlayer}'s Top ${n} Cards`;
    title.style.cssText = 'font-family:var(--font);font-size:10px;color:var(--accent);';
    const sub = document.createElement('div');
    sub.textContent = 'Drag to reorder. Position 1 is drawn first.';
    sub.style.cssText = 'font-family:var(--font);font-size:8px;color:var(--muted);';
    const cardRow = document.createElement('div');
    cardRow.style.cssText = 'display:flex;gap:10px;align-items:flex-end;';
    let orderIndices = topCards.map((_, i) => i);
    const buildCards = () => {
      cardRow.innerHTML = '';
      orderIndices.forEach((origIdx, pos) => {
        const c = topCards[origIdx];
        const el = document.createElement('div');
        el.draggable = true; el.dataset.pos = pos;
        el.style.cssText = `width:70px;height:98px;border:1px solid var(--border2);border-radius:4px;
          overflow:hidden;cursor:grab;position:relative;background:var(--surface2);`;
        el.innerHTML = `<img src="${c.images?.small||''}" alt="${c.name}" style="width:100%;height:100%;object-fit:cover;">
          <div style="position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,.7);
            font-family:var(--font);font-size:5px;color:#fff;text-align:center;padding:2px;">${c.name}</div>
          <div style="position:absolute;top:2px;left:2px;background:rgba(0,0,0,.7);
            font-family:var(--font);font-size:6px;color:var(--accent);padding:1px 3px;border-radius:2px;">#${pos+1}</div>`;
        el.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', pos); el.style.opacity='.5'; });
        el.addEventListener('dragend', () => { el.style.opacity='1'; });
        el.addEventListener('dragover', e => { e.preventDefault(); el.style.borderColor='var(--accent)'; });
        el.addEventListener('dragleave', () => { el.style.borderColor='var(--border2)'; });
        el.addEventListener('drop', e => {
          e.preventDefault(); el.style.borderColor='var(--border2)';
          const from = parseInt(e.dataTransfer.getData('text/plain')), to = parseInt(el.dataset.pos);
          if (from === to) return;
          const tmp = orderIndices[from]; orderIndices.splice(from,1); orderIndices.splice(to,0,tmp);
          buildCards();
        });
        cardRow.appendChild(el);
      });
    };
    buildCards();
    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = 'Confirm Order';
    confirmBtn.style.cssText = `background:var(--accent);color:#000;border:none;font-family:var(--font);
      font-size:9px;padding:10px 24px;cursor:pointer;border-radius:4px;`;
    confirmBtn.addEventListener('click', () => {
      overlay.remove();
      const reordered = orderIndices.map(i => topCards[i]);
      for (let i = 0; i < n; i++) deck[i] = reordered[i];
      addLog(`Prophecy: P${player} rearranged top ${n} cards of P${targetPlayer}'s deck.`, true);
      resolve();
    });
    overlay.appendChild(title); overlay.appendChild(sub);
    overlay.appendChild(cardRow); overlay.appendChild(confirmBtn);
    document.body.appendChild(overlay);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// THE DISPATCH TABLE  (one entry per attack name, exactly as in cards.json)
// ─────────────────────────────────────────────────────────────────────────────
const MOVE_EFFECTS = {

  // ═══════════════════════════════════════════════════════════════════════════
  // WIZARDS BLACK STAR PROMOS
  // ═══════════════════════════════════════════════════════════════════════════

  // Devolution Beam (Mew Promo): choose an evolved Pokémon on EITHER side and
  // return its highest Stage Evolution card to its owner's hand. The lower stage
  // comes back with the same damage + Energy and no conditions/effects (helper:
  // devolveTopStage in game-utils.js). If its damage now meets the lower stage's
  // HP it is Knocked Out and the other player takes a prize.
  // Not flagged targetsDefender — the player may target their own Pokémon; the
  // opponent's protected Active is simply removed from the choices.
  'Devolution Beam': {
    postAttack: async ({ player, opp, atk }) => {
      const candidates = [];
      for (const pNum of [opp, player]) {
        const P = G.players[pNum];
        if (P.active?.prevStages?.length) candidates.push({ pNum, zone: 'active', idx: null, card: P.active });
        P.bench.forEach((b, i) => { if (b?.prevStages?.length) candidates.push({ pNum, zone: 'bench', idx: i, card: b }); });
      }
      const eligible = candidates.filter(c => !(atk._defenderEffectsBlocked && c.pNum === opp && c.zone === 'active'));
      if (!eligible.length) { addLog(`${atk.name}: no evolved Pokémon to devolve.`); return; }
      let pick = eligible[0];
      if (eligible.length > 1) {
        const picked = await openCardPicker({
          title: `${atk.name} — Devolve`,
          subtitle: "Choose an evolved Pokémon (yours or your opponent's) — its top Evolution card returns to hand",
          cards: eligible.map(c => ({ name: `${c.pNum === player ? 'Your' : "Opp's"} ${c.card.name}`, images: c.card.images })),
          maxSelect: 1
        });
        if (!picked) {
          // No damage, no cost paid — backing out leaves the turn unused (see Amnesia).
          addLog(`${atk.name}: cancelled — turn not used.`);
          if (typeof showToast === 'function') showToast(`${atk.name} cancelled.`);
          return true;
        }
        if (picked.length) pick = eligible[picked[0]];
      }
      const owner = G.players[pick.pNum];
      const res = devolveTopStage(pick.card);
      if (!res) { addLog(`${atk.name}: ${pick.card.name} has no Evolution card to remove.`); return; }
      const { restored, evoCard } = res;
      if (pick.zone === 'active') owner.active = restored; else owner.bench[pick.idx] = restored;
      owner.hand.push(evoCard);
      addLog(`${atk.name}: ${evoCard.name} returned to P${pick.pNum}'s hand — ${restored.name} is back in play (${restored.damage}/${restored.hp} HP).`, true);
      if (typeof showActionFlash === 'function') showActionFlash(player, 'DEVOLVED', evoCard.name, `→ ${restored.name}`);
      // Damage already on it may exceed the lower stage's HP → Knocked Out.
      const hp = parseInt(restored.hp) || 0;
      if (hp > 0 && (restored.damage || 0) >= hp) {
        if (pick.zone === 'active') {
          const ko = checkKO(player, opp, restored, pick.pNum === player);
          if (ko === 'win' || ko === 'promote') { renderAll(); return true; } // endTurn fires from the promotion flow
        } else if (koBenchAndPrize(pick.pNum, pick.idx) === 'win') {
          renderAll(); return true;
        }
      }
      renderAll();
    }
  },

  // Energy Absorption (Mewtwo Promo): attach up to 2 Energy cards from your
  // discard pile to Mewtwo. Self-effect — never blocked by Agility/Barrier.
  'Energy Absorption': {
    postAttack: async ({ player, myActive, atk }) => {
      if (!myActive) return;
      const myP = G.players[player];
      const energy = myP.discard.filter(c => c.supertype === 'Energy');
      if (!energy.length) { addLog(`${atk.name}: no Energy cards in the discard pile.`); return; }
      const aiAutoPick = (typeof vsComputer !== 'undefined' && vsComputer && typeof aiPlayerNum !== 'undefined' && G.turn === aiPlayerNum);
      let picked;
      if (aiAutoPick || energy.length <= 2) {
        // Psychic first — that's what Mewtwo's attacks cost.
        picked = energy.map((c, i) => i)
          .sort((a, b) => (/psychic/i.test(energy[b].name) ? 1 : 0) - (/psychic/i.test(energy[a].name) ? 1 : 0))
          .slice(0, 2);
      } else {
        picked = await openCardPicker({ title: atk.name, subtitle: `Choose up to 2 Energy cards to attach to ${myActive.name}`, cards: energy, maxSelect: 2 }) || [];
      }
      if (!Array.isArray(myActive.attachedEnergy)) myActive.attachedEnergy = [];
      const attached = [];
      for (const i of picked) {
        const di = myP.discard.indexOf(energy[i]);
        if (di !== -1) attached.push(...myP.discard.splice(di, 1));
      }
      myActive.attachedEnergy.push(...attached);
      addLog(`${atk.name}: attached ${attached.length ? attached.map(c => c.name).join(', ') : 'nothing'} to ${myActive.name} from the discard pile.`, true);
      renderAll();
    }
  },

  // Fly (Flying Pikachu Promo): ONE flip decides everything — heads = 30 damage
  // AND full protection (Agility-style) during the opponent's next turn; tails =
  // nothing at all (not even damage). modifyDamage owns the flip so the generic
  // coin parser is skipped, and sets the protection on heads BEFORE damage so a
  // KO on the defender (which ends performAttack early) can't skip it. The
  // postAttack entry exists only so applyPostAttackTextEffects' generic
  // "prevent all effects of attacks" parser doesn't flip a second coin.
  'Fly': {
    modifyDamage: async ({ myActive, atk, dmg }) => {
      const heads = await flipCoin(`${atk.name}: Heads = ${dmg} damage + ${myActive?.name || 'Flying Pikachu'} protected next turn | Tails = nothing`);
      atk._coinFlipHandled = true;
      if (!heads) { addLog(`${atk.name}: TAILS — the attack does nothing (not even damage).`, true); return 0; }
      if (myActive) {
        myActive.defender = true; myActive.defenderFull = true; myActive.defenderFullEffects = true;
        addLog(`${atk.name}: HEADS — ${dmg} damage, and ${myActive.name} is protected from all effects of attacks (including damage) next turn!`, true);
      }
      return dmg;
    },
    postAttack: async () => {}
  },

  // Growl (Pikachu Promo): same text as Persian's Pounce — incoming damage −10 next turn.
  'Growl': _reduceIncomingBy10(),

  // Light Screen (Electabuzz Promo): attacks on Electabuzz do half damage (after
  // W/R, rounded down to nearest 10) during the opponent's next turn. Consumed in
  // applyDamageModifiers; expires with the other defender flags in endTurn.
  'Light Screen': {
    postAttack: async ({ myActive, atk }) => {
      if (!myActive) return;
      myActive.lightScreen = true;
      addLog(`${atk.name}: attacks on ${myActive.name} do half damage next turn (rounded down to the nearest 10)!`, true);
    }
  },

  // Psywave (Mew Promo): 10 × Energy CARDS attached to the defender (DCE counts once).
  'Psywave': {
    modifyDamage: ({ oppActive }) => (oppActive?.attachedEnergy || []).length * 10
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // BASE / JUNGLE / FOSSIL (alphabetical)
  // ═══════════════════════════════════════════════════════════════════════════

  // Absorb (Kabutops): drain half damage dealt
  'Absorb': _drain(0.5),

  // Acid (Victreebel): flip — heads = can't retreat next turn.
  // Tentacool (Fossil) also has an attack named Acid with NO text — the vanilla
  // guard in getMoveEffect keeps this handler off it; requireText is belt-and-
  // braces for any future same-named Acid whose text differs.
  'Acid': {
    targetsDefender: true,
    requireText: /can't retreat/i,
    postAttack: async ({ oppActive, atk }) => {
      if (!oppActive) return;
      const heads = await flipCoin(`${atk.name}: Heads = ${oppActive.name} can't retreat next turn!`);
      if (heads) { oppActive.cantRetreat = true; addLog(`${atk.name}: HEADS — ${oppActive.name} can't retreat!`, true); }
      else addLog(`${atk.name}: TAILS — no effect.`);
    }
  },

  // Agility (Raichu/Fearow/Rapidash/Seadra): flip → immune to all attack effects
  'Agility': _agilityFlip(),

  // Amnesia (Poliwhirl): choose 1 of opp's attacks — disable it next turn.
  // Ditto note: Ditto (Fossil) has no intrinsic attacks — it borrows the
  // attacker's attacks via Transform (its Pokémon Power). Reading
  // `oppActive.attacks` directly would be empty and the disable would silently
  // no-op. Use `dittoAttacks(opp)` which returns the copied attack list when
  // Transform is active; fall back to the intrinsic list otherwise.
  //
  // Cancel behaviour: if the player opens the picker (i.e. opp has 2+ attacks)
  // and clicks Cancel, treat the whole attack as not-yet-resolved and return
  // `true` so performAttack skips endTurn. Amnesia does no damage and discards
  // no energy, so backing out leaves the game state where it was — the player
  // can attack again or take some other action this turn.
  'Amnesia': {
    targetsDefender: true,
    postAttack: async ({ opp, oppActive, atk }) => {
      if (!oppActive) return;
      const effectiveAttacks =
        (typeof dittoAttacks === 'function' && dittoAttacks(opp)) || oppActive.attacks || [];
      if (!effectiveAttacks.length) {
        addLog(`${atk.name}: no attacks to disable on ${oppActive.name}.`);
        return;
      }
      let atkName;
      if (effectiveAttacks.length === 1) {
        atkName = effectiveAttacks[0].name;
      } else {
        const picked = await openCardPicker({
          title: `${atk.name} — Disable Attack`,
          subtitle: `Choose an attack to disable on ${oppActive.name}`,
          cards: effectiveAttacks.map(a => ({ name: a.name, images: oppActive.images })),
          maxSelect: 1
        });
        if (!picked) {
          // Picker was cancelled — abort the whole attack so the turn isn't spent.
          addLog(`${atk.name}: cancelled — turn not used.`);
          if (typeof showToast === 'function') showToast(`${atk.name} cancelled.`);
          return true;
        }
        if (picked.length) atkName = effectiveAttacks[picked[0]].name;
      }
      if (atkName) { oppActive.disabledAttack = atkName; addLog(`${atk.name}: ${oppActive.name}'s ${atkName} disabled next turn!`, true); }
    }
  },

  // Barrier (Mewtwo): full protection next turn (energy discard handled elsewhere)
  'Barrier': {
    postAttack: async ({ myActive, atk }) => {
      if (!myActive) return;
      myActive.defender = true; myActive.defenderFull = true; myActive.defenderFullEffects = true;
      addLog(`${atk.name}: ${myActive.name} fully protected next turn!`, true);
    }
  },

  // Boyfriends (Nidoqueen): 20 + 20 per Nidoking in play (active or bench)
  'Boyfriends': {
    modifyDamage: ({ player }) => {
      const all = [G.players[player].active, ...G.players[player].bench].filter(Boolean);
      const nidokings = all.filter(c => c.name === 'Nidoking').length;
      return 20 + nidokings * 20;
    }
  },

  // Water Gun (Poliwrath, Poliwag, Vaporeon, Lapras, Omastar, Seadra, Omanyte):
  // Base damage + 10 per extra Water energy beyond what was paid in cost, max +20
  'Water Gun': {
    modifyDamage: ({ myActive, atk }) => {
      const base = parseInt((atk.damage || '0').replace(/[^0-9]/g, '')) || 0;
      const waterInCost = (atk.cost || []).filter(c => /water/i.test(c)).length;
      const waterAttached = (myActive?.attachedEnergy || []).filter(e => /water/i.test(e.name)).length;
      const extras = Math.max(0, waterAttached - waterInCost);
      const bonus = Math.min(extras, 2) * 10;
      if (bonus > 0) addLog(`Water Gun: +${bonus} bonus (${extras} extra Water Energy).`);
      return base + bonus;
    }
  },

  // Hydro Pump (Blastoise): same formula as Water Gun
  'Hydro Pump': {
    modifyDamage: ({ myActive, atk }) => {
      const base = parseInt((atk.damage || '0').replace(/[^0-9]/g, '')) || 0;
      const waterInCost = (atk.cost || []).filter(c => /water/i.test(c)).length;
      const waterAttached = (myActive?.attachedEnergy || []).filter(e => /water/i.test(e.name)).length;
      const extras = Math.max(0, waterAttached - waterInCost);
      const bonus = Math.min(extras, 2) * 10;
      if (bonus > 0) addLog(`Hydro Pump: +${bonus} bonus (${extras} extra Water Energy).`);
      return base + bonus;
    }
  },

  // Thrash (Nidoking): single flip — heads = 30+10=40; tails = 30 + 10 self-damage
  // Handled here so engine Pattern 4 AND Pattern 6 don't each flip independently
  'Thrash': {
    modifyDamage: async ({ atk }) => {
      const heads = await flipCoin(`${atk.name}: Heads = 40 damage, Tails = 30 damage + Nidoking takes 10`);
      atk._thrashHeads = heads;
      return heads ? 40 : 30;
    },
    postAttack: async ({ myActive, atk }) => {
      if (!atk._thrashHeads && myActive) {
        let recoil = 10;
        if (myActive.defender) {
          addLog(`${atk.name}: TAILS — Defender blocks Nidoking's 10 recoil!`);
          recoil = 0;
        }
        if (recoil > 0) {
          myActive.damage = (myActive.damage || 0) + recoil;
          addLog(`${atk.name}: TAILS — ${myActive.name} takes ${recoil} recoil! (${myActive.damage}/${myActive.hp} HP)`, true);
        }
      }
    }
  },

  // Thunderpunch (Electabuzz): single flip — heads = 40; tails = 30 + 10 self-damage
  'Thunderpunch': {
    modifyDamage: async ({ atk }) => {
      const heads = await flipCoin(`${atk.name}: Heads = 40 damage, Tails = 30 damage + Electabuzz takes 10`);
      atk._tpunchHeads = heads;
      return heads ? 40 : 30;
    },
    postAttack: async ({ myActive, atk }) => {
      if (!atk._tpunchHeads && myActive) {
        if (myActive.defender) {
          addLog(`${atk.name}: TAILS — Defender blocks Electabuzz's 10 recoil!`);
        } else {
          myActive.damage = (myActive.damage || 0) + 10;
          addLog(`${atk.name}: TAILS — ${myActive.name} takes 10 damage! (${myActive.damage}/${myActive.hp})`, true);
        }
      }
    }
  },

  // Clamp (Cloyster): single flip — heads = full damage + Paralyzed; tails = 0 damage, no effect
  // Must be in MOVE_EFFECTS so engine Pattern 3 (tails=no damage) doesn't fire a separate flip,
  // and parseStatusEffects doesn't fire a third flip.
  // targetsDefender: postAttack only paralyzes the defender. Damage is already
  // handled by the normal pipeline (and zeroed by defenderFull when applicable).
  'Clamp': {
    targetsDefender: true,
    modifyDamage: async ({ atk }) => {
      const heads = await flipCoin('Clamp: Heads = damage + Paralyzed, Tails = does nothing');
      atk._clampHeads = heads;
      return heads ? null : 0; // null = use base damage; 0 = no damage
    },
    postAttack: async ({ oppActive, atk }) => {
      if (atk._clampHeads && oppActive) {
        tryApplyStatus(oppActive, 'paralyzed');
        addLog(`Clamp: HEADS — ${oppActive.name} is now Paralyzed!`, true);
      } else {
        addLog(`Clamp: TAILS — no damage, no effect.`);
      }
    }
  },

  // Bind/Bubble/Bubblebeam/Body Slam/Freeze Dry/Ice Beam/Irongrip/Lick/
  // Nasty Goo/Psyshock/Star Freeze/String Shot/Stun Spore/Thunder Wave/
  // Tongue Wrap/Wrap: flip → paralyzed
  'Bind':        _statusOppFlip('paralyzed'),
  'Bubble':      _statusOppFlip('paralyzed'),
  'Bubblebeam':  _statusOppFlip('paralyzed'),
  'Body Slam':   _statusOppFlip('paralyzed'),
  'Freeze Dry':  _statusOppFlip('paralyzed'),
  'Ice Beam':    _statusOppFlip('paralyzed'),
  // Irongrip: Pinsir (Jungle) flips for Paralyzed; Krabby (Fossil) shares the
  // name but has no text (plain 20) — vanilla guard + requireText keep it clean.
  'Irongrip':    { ..._statusOppFlip('paralyzed'), requireText: /paralyzed/i },
  'Lick':        _statusOppFlip('paralyzed'),
  'Nasty Goo':   _statusOppFlip('paralyzed'),
  'Psyshock':    _statusOppFlip('paralyzed'),
  'Star Freeze': _statusOppFlip('paralyzed'),
  'String Shot': _statusOppFlip('paralyzed'),
  'Stun Spore':  _statusOppFlip('paralyzed'),
  'Thunder Wave':_statusOppFlip('paralyzed'),
  'Tongue Wrap': _statusOppFlip('paralyzed'),
  'Wrap':        _statusOppFlip('paralyzed'),

  // Blizzard (Articuno): flip — heads=10 to opp bench, tails=10 to own bench.
  // Resolved in preAttack so the splash still happens when Blizzard KOs.
  'Blizzard': {
    preAttack: async ({ player, opp, atk }) => {
      const heads = await flipCoin(`${atk.name}: Heads=10 to opp bench | Tails=10 to your bench`);
      const target = heads ? opp : player;
      const slots = G.players[target].bench.map((c, i) => c ? i : -1).filter(i => i !== -1);
      if (!slots.length) { addLog(`${atk.name}: ${heads ? 'HEADS' : 'TAILS'} — no Benched Pokémon to hit.`); return null; }
      for (const i of slots) _hitBench(target, i, 10, atk.name);
      addLog(`${atk.name}: ${heads ? "HEADS — opp" : "TAILS — own"} bench took 10 each!`, true);
      renderAll();
      return null;
    }
  },

  // Call for Family — three different cards share this attack name but each
  // targets only its own evolutionary line:
  //   Bellsprout (Jungle) → Bellsprout only
  //   Nidoran ♀  (Jungle) → Nidoran ♀ or Nidoran ♂ (either gender)
  //   Krabby    (Fossil) → Krabby only
  // Dispatches by attacker name so each card behaves per its printed text.
  // Name match is gender-symbol-tolerant inside _callForFamily, so "Nidoran"
  // as stored in cards.json still matches both "Nidoran ♀" and "Nidoran ♂".
  'Call for Family': {
    postAttack: async (ctx) => {
      const attacker = _normName(ctx.myActive?.name);
      let targets;
      if (attacker === 'Nidoran')        targets = ['Nidoran ♀', 'Nidoran ♂'];
      else if (attacker === 'Bellsprout') targets = 'Bellsprout';
      else if (attacker === 'Krabby')     targets = 'Krabby';
      else {
        // Unknown attacker with this move name — safest is to default to the
        // attacker's own name so we never cross evolutionary lines.
        targets = ctx.myActive?.name || '';
      }
      return _callForFamily(targets).postAttack(ctx);
    }
  },

  // Sprout (Oddish): same pattern
  'Sprout': _callForFamily('Oddish'),

  // Call for Friend (Marowak): search for Fighting Basic
  'Call for Friend': {
    postAttack: async ({ player, atk }) => {
      const myP = G.players[player];
      const slot = myP.bench.findIndex(s => s === null);
      if (slot === -1) { addLog(`${atk.name}: bench is full!`); return; }
      const candidates = myP.deck.filter(c =>
        c.supertype === 'Pokémon' && c.subtypes?.includes('Basic') &&
        (c.types || []).some(t => /fighting/i.test(t))
      );
      if (!candidates.length) { addLog(`${atk.name}: no Fighting Basic in deck.`); return; }
      let chosen = candidates[0];
      if (candidates.length > 1) {
        const picked = await openCardPicker({ title: `${atk.name}`, subtitle: 'Choose a Fighting Basic to bench', cards: candidates, maxSelect: 1 });
        if (picked && picked.length) chosen = candidates[picked[0]];
      }
      const di = myP.deck.findIndex(c => c === chosen);
      if (di !== -1) {
        chosen.damage = 0; chosen.attachedEnergy = []; clearAllStatus(chosen);
        myP.bench[slot] = myP.deck.splice(di, 1)[0];
        myP.deck = shuffle(myP.deck);
        addLog(`${atk.name}: ${chosen.name} placed on bench!`, true);
        renderAll();
      }
    }
  },

  // Chain Lightning (Electrode): 10 to all bench of same type as defender (preAttack — see above)
  'Chain Lightning': {
    preAttack: async ({ oppActive, atk }) => {
      const defTypes = (oppActive?.types || []);
      if (!defTypes.length || defTypes.some(t => /colorless/i.test(t))) {
        addLog(`${atk.name}: Defending Pokémon is Colorless — no splash.`); return null;
      }
      const matchType = defTypes[0];
      for (const pNum of [1, 2]) {
        G.players[pNum].bench.forEach((c, i) => {
          if (c && (c.types || []).some(t => t.toLowerCase() === matchType.toLowerCase())) _hitBench(pNum, i, 10, atk.name);
        });
      }
      renderAll();
      return null;
    }
  },

  // Confuse Ray (Alakazam/Drowzee/Vulpix/Lapras): flip → confused
  'Confuse Ray': _statusOppFlip('confused'),

  // Conversion 1 (Porygon): change opp's weakness type — preAttack so cancel blocks the turn
  // If the defender has full effect protection (Agility/Barrier/Transparency),
  // the conversion can't take — but the attack itself proceeds (still uses the
  // turn). Per the WotC ruling, those protections only block effects "done TO"
  // the defender; here, changing the defender's weakness IS done to the defender,
  // so we skip the conversion but DON'T return 'block' (the player has paid for
  // and committed to the attack).
  'Conversion 1': {
    preAttack: async ({ opp, atk }) => {
      const oppActive = G.players[opp].active;
      if (!oppActive) return 'block';
      if (oppActive.defenderFullEffects) {
        addLog(`${atk.name}: ${oppActive.name} is fully protected — Conversion has no effect.`, true);
        if (typeof showToast === 'function') showToast(`${oppActive.name} is protected!`);
        return null; // don't block — attack still resolves (and ends the turn)
      }
      if (!(oppActive.weaknesses || []).length) { addLog(`${atk.name}: ${oppActive.name} has no Weakness.`); return 'block'; }
      const chosen = await pickType(`${atk.name} — Choose new Weakness type for ${oppActive.name}`);
      if (!chosen || chosen === 'Colorless') return 'block';
      oppActive.weaknesses = [{ type: chosen, value: '×2' }];
      oppActive.conversionWeakness = chosen;
      addLog(`${atk.name}: ${oppActive.name}'s Weakness → ${chosen}!`, true);
      renderAll();
      return null;
    }
  },

  // Conversion 2 (Porygon): change own resistance type — preAttack so cancel blocks the turn
  'Conversion 2': {
    preAttack: async ({ player, atk }) => {
      const myActive = G.players[player].active;
      if (!myActive) return 'block';
      const chosen = await pickType(`${atk.name} — Choose new Resistance type for ${myActive.name}`);
      if (!chosen || chosen === 'Colorless') return 'block';
      myActive.resistances = [{ type: chosen, value: '-30' }];
      myActive.conversionResistance = chosen;
      addLog(`${atk.name}: ${myActive.name}'s Resistance → ${chosen}!`, true);
      renderAll();
      return null;
    }
  },

  // Dark Mind (Gengar/Hypno): 10 to chosen opp bench
  // Dark Mind (Gengar): 30 damage to Active + 10 to 1 chosen opponent bench Pokémon.
  // Bench damage must fire EVEN IF the 30 damage KOs the Active (TCG rule).
  // We handle this by setting a flag in preAttack and resolving bench damage there,
  // before the main damage pipeline runs (so it always fires regardless of KO).
  'Dark Mind': {
    preAttack: async ({ opp, atk }) => {
      const bench = G.players[opp].bench.map((s, i) => ({ s, i })).filter(x => x.s !== null);
      if (!bench.length) { addLog(`${atk.name}: opponent has no bench.`); return null; }
      let target, slotIdx;
      if (bench.length === 1) {
        target = bench[0].s; slotIdx = bench[0].i;
      } else {
        const picked = await openCardPicker({
          title: 'Dark Mind — Bench Damage',
          subtitle: "Choose 1 of opponent's Benched Pokémon to deal 10 damage to",
          cards: bench.map(x => x.s), maxSelect: 1
        });
        if (!picked?.length) { addLog(`${atk.name}: bench target cancelled.`); return null; }
        target = bench[picked[0]].s; slotIdx = bench[picked[0]].i;
      }
      target.damage = (target.damage || 0) + 10;
      addLog(`${atk.name}: 10 damage to ${target.name} on bench! (${target.damage}/${target.hp} HP)`, true);
      const hp = parseInt(target.hp) || 0;
      if (hp > 0 && target.damage >= hp) {
        addLog(`${target.name} was knocked out!`, true);
        koBenchAndPrize(opp, slotIdx);
      }
      return null; // null = don't block the main attack
    }
  },

  // Destiny Bond (Gastly): mark self — KO attacker if KO'd next turn
  'Destiny Bond': {
    postAttack: async ({ myActive, atk }) => {
      if (!myActive) return;
      myActive.destinyBond = true;
      addLog(`${atk.name}: ${myActive.name} will take its attacker down with it!`, true);
    }
  },

  // Do the Wave (Wigglytuff): 10 + 10 per own benched Pokémon
  'Do the Wave': {
    modifyDamage: ({ player }) => 10 + G.players[player].bench.filter(Boolean).length * 10
  },

  // Dream Eater (Haunter): pre-check — only usable when opp is Asleep
  'Dream Eater': {
    preAttack: ({ oppActive, atk }) => {
      // Multi-status: read special slot; legacy `status` as fallback.
      const oppSpecial = oppActive?.special ?? oppActive?.status ?? null;
      if (oppSpecial !== 'asleep') {
        showToast(`${atk.name}: opponent must be Asleep!`, true);
        addLog(`${atk.name}: ${oppActive?.name} is not Asleep — failed!`, true);
        return 'block';
      }
    }
  },

  // Earthquake (Dugtrio): 10 to each of own bench (preAttack — see above)
  'Earthquake': {
    preAttack: async ({ player, atk }) => {
      G.players[player].bench.forEach((c, i) => { if (c) _hitBench(player, i, 10, atk.name); });
      renderAll();
      return null;
    }
  },

  // Energy Conversion (Gastly): retrieve up to 2 energy from own discard; Gastly takes 10 damage to itself
  // Card text: "Put up to 2 Energy cards from your discard pile into your hand. Gastly does 10 damage to itself."
  'Energy Conversion': {
    postAttack: async ({ player, myActive, atk }) => {
      const myP = G.players[player];
      const opp = player === 1 ? 2 : 1;
      const energy = myP.discard.filter(c => c.supertype === 'Energy');
      if (!energy.length) { addLog(`${atk.name}: no energy in discard.`); }
      else {
        const picked = await openCardPicker({ title: `${atk.name}`, subtitle: 'Choose up to 2 energy from your discard', cards: energy, maxSelect: 2 });
        if (picked && picked.length) {
          picked.forEach(pi => { const di = myP.discard.findIndex(c => c === energy[pi]); if (di !== -1) myP.hand.push(...myP.discard.splice(di, 1)); });
          addLog(`${atk.name}: retrieved ${picked.length} energy to hand.`, true);
        }
      }
      // Gastly does 10 damage to itself (per card text)
      if (myActive) {
        myActive.damage = (myActive.damage || 0) + 10;
        addLog(`${atk.name}: ${myActive.name} takes 10 damage to itself! (${myActive.damage}/${myActive.hp} HP)`, true);
        checkKO(opp, player, myActive, true);
      }
      renderAll();
    }
  },

  // Fetch (Kangaskhan): draw a card
  'Fetch': {
    postAttack: async ({ player, atk }) => { drawCard(player, true); addLog(`${atk.name}: drew a card.`, true); }
  },

  // Flail (Magikarp/Kingler): 10 × own damage counters
  'Flail': {
    modifyDamage: ({ myActive }) => Math.floor((myActive?.damage || 0) / 10) * 10
  },

  // Foul Gas (Koffing): flip — heads=Poisoned, tails=Confused
  'Foul Gas': {
    targetsDefender: true,
    postAttack: async ({ oppActive, atk }) => {
      if (!oppActive) return;
      const heads = await flipCoin(`${atk.name}: Heads=Poisoned | Tails=Confused`);
      const status = heads ? 'poisoned' : 'confused';
      tryApplyStatus(oppActive, status);
      addLog(`${atk.name}: ${heads ? 'HEADS' : 'TAILS'} — ${oppActive.name} is now ${status}!`, true);
    }
  },

  // Foul Odor (Gloom): both self and opp Confused
  // Mixed-target: confuses BOTH attacker and defender. When defender has full
  // effect protection (Agility/Barrier/Transparency), only the self-confusion
  // applies. We deliberately do NOT set targetsDefender here; instead the
  // handler inspects atk._defenderEffectsBlocked directly.
  'Foul Odor': {
    postAttack: async ({ myActive, oppActive, atk }) => {
      if (myActive)  { tryApplyStatus(myActive, 'confused');  addLog(`${atk.name}: ${myActive.name} is now Confused!`, true); }
      if (oppActive && !atk._defenderEffectsBlocked) {
        tryApplyStatus(oppActive, 'confused');
        addLog(`${atk.name}: ${oppActive.name} is now Confused!`, true);
      } else if (oppActive && atk._defenderEffectsBlocked) {
        addLog(`${atk.name}: ${oppActive.name} is protected — Confused effect blocked.`);
      }
    }
  },

  // Gigashock (Raichu): 10 to up to 3 opp bench (preAttack — see above)
  'Gigashock': {
    preAttack: async ({ opp, atk }) => {
      const bench = G.players[opp].bench.map((s, i) => ({ s, i })).filter(x => x.s !== null);
      if (!bench.length) { addLog(`${atk.name}: no bench to target.`); return null; }
      let targets = bench;
      if (bench.length > 3) {
        const picked = await openCardPicker({ title: `${atk.name}`, subtitle: 'Choose up to 3 Benched Pokémon (10 each)', cards: bench.map(x => x.s), maxSelect: 3 });
        if (picked && picked.length) targets = picked.map(pi => bench[pi]);
      }
      targets.forEach(({ i }) => _hitBench(opp, i, 10, atk.name));
      renderAll();
      return null;
    }
  },

  // Harden (Onix/Graveler): block attacks doing ≤30 damage next turn
  'Harden': {
    postAttack: async ({ myActive, atk }) => {
      if (!myActive) return;
      myActive.defender = true; myActive.defenderThreshold = 30;
      addLog(`${atk.name}: ${myActive.name} blocks attacks doing 30 or less next turn!`, true);
    }
  },

  // Headache (Psyduck): opponent can't play Trainer cards next turn
  'Headache': {
    postAttack: async ({ opp, atk }) => {
      G.players[opp].trainerBlocked = true;
      addLog(`${atk.name}: P${opp} cannot play Trainer cards next turn!`, true);
    }
  },

  // Hide in Shell (Shellder): flip → full protection next turn
  'Hide in Shell': _selfProtectFlip(),

  // Hurricane (Pidgeot): return opp + all attachments + pre-evos to hand (unless KO'd)
  'Hurricane': {
    targetsDefender: true,
    postAttack: async ({ opp, player, atk }) => {
      const oppP = G.players[opp];
      const oppActive = oppP.active;
      if (!oppActive) return; // already KO'd — no return effect
      const toHand = [oppActive, ...(oppActive.attachedEnergy || [])];
      oppActive.attachedEnergy = []; oppActive.damage = 0; clearAllStatus(oppActive);
      let evoName = oppActive.evolvesFrom;
      while (evoName) {
        const idx = oppP.discard.findIndex(c => c.name === evoName && c.supertype === 'Pokémon');
        if (idx !== -1) { const pre = oppP.discard.splice(idx, 1)[0]; pre.damage = 0; pre.attachedEnergy = []; clearAllStatus(pre); toHand.push(pre); evoName = pre.evolvesFrom; }
        else break;
      }
      oppP.active = null; oppP.hand.push(...toHand);
      addLog(`${atk.name}: ${oppActive.name} + attachments returned to P${opp}'s hand!`, true);
      const benchLeft = oppP.bench.filter(s => s !== null);
      if (!benchLeft.length) { G.started = false; showWinScreen(player, 'OPPONENT HAS NO POKÉMON LEFT'); if (typeof pushGameState === 'function') pushGameState(); renderAll(); return true; }
      else if (benchLeft.length === 1) { const idx = oppP.bench.findIndex(s => s !== null); oppP.active = oppP.bench[idx]; oppP.bench[idx] = null; addLog(`${oppP.active.name} auto-promoted.`, true); }
      else { await forceOpponentSwitch(opp, false, `${atk.name} (promote)`); if (!G.players[opp].active) { const idx = G.players[opp].bench.findIndex(s => s !== null); if (idx !== -1) { G.players[opp].active = G.players[opp].bench[idx]; G.players[opp].bench[idx] = null; } } }
      renderAll();
    }
  },

  // Hyper Beam (Dragonair/Golduck): discard 1 energy from opp
  'Hyper Beam': _discardOppEnergy(),

  // Hypnosis (Haunter/Exeggcute): opp is Asleep (no flip)
  'Hypnosis': _statusOpp('asleep'),

  // Jellyfish Sting (Tentacruel): opp is Poisoned (no flip)
  'Jellyfish Sting': _statusOpp('poisoned'),

  // Karate Chop (Machoke): 50 - 10 per own damage counter
  'Karate Chop': {
    modifyDamage: ({ myActive }) => Math.max(0, 50 - Math.floor((myActive?.damage || 0) / 10) * 10)
  },

  // Leech Life (Venonat/Golbat/Zubat): drain = full damage dealt
  'Leech Life': _drain(1.0),

  // Leech Seed (Bulbasaur/Exeggcute): remove 1 damage counter if dmg > 0
  'Leech Seed': {
    postAttack: async ({ myActive, dmgDealt, atk }) => {
      if (!myActive || dmgDealt <= 0) return;
      myActive.damage = Math.max(0, (myActive.damage || 0) - 10);
      addLog(`${atk.name}: removed 1 damage counter from ${myActive.name}!`, true);
    }
  },

  // Leek Slap (Farfetch'd): flip coin — tails = does nothing; can't use again either way
  // Card text: "Flip a coin. If tails, this attack does nothing. Either way, you can't
  // use this attack again as long as Farfetch'd stays in play."
  // modifyDamage is present (even though it returns null) so resolveCoinFlipDamage
  // skips its generic "tails = nothing" pattern and doesn't double-flip.
  'Leek Slap': {
    preAttack: async ({ myActive, atk }) => {
      if (myActive?.leekSlapUsed) {
        showToast(`${atk.name}: already used — can't use again while Farfetch'd is in play!`, true);
        addLog(`${atk.name}: already used — blocked!`, true);
        return 'block';
      }
      // Mark as used regardless of flip result (card says "either way")
      if (myActive) myActive.leekSlapUsed = true;
      // Flip: tails = attack does nothing
      const heads = await flipCoin(`${atk.name}: Heads = 30 damage, Tails = does nothing`);
      if (!heads) {
        addLog(`${atk.name}: TAILS — attack does nothing! (can't use again either way)`, true);
        return 'block';
      }
      addLog(`${atk.name}: HEADS — 30 damage! (can't use again while Farfetch'd is in play)`, true);
    },
    modifyDamage: () => null  // prevents resolveCoinFlipDamage from adding a second flip
  },

  // Leer (Rhyhorn): flip → defending can't attack this Pokémon next turn
  'Leer': _tailWag(),

  // Lullaby (Wigglytuff/Jigglypuff): opp is Asleep (no flip)
  'Lullaby': _statusOpp('asleep'),

  // Lure (Ninetales/Victreebel): attacker chooses opp bench → active
  'Lure': {
    postAttack: async ({ opp, atk }) => {
      if (!G.players[opp].bench.some(s => s !== null)) { addLog(`${atk.name}: opponent has no bench.`); return; }
      await forceOpponentSwitch(opp, true, atk.name);
    }
  },

  // Meditate: base damage + 10 per damage counter on defender.
  // TWO different cards share this attack name with different base damage:
  //   Jynx (Base)      → "Does 20 damage plus 10 more per damage counter" (20+)
  //   Mr. Mime (Jungle)→ "Does 10 damage plus 10 more per damage counter" (10+)
  // Reading the base from atk.damage (not a hardcoded 10) makes both correct —
  // previously Jynx wrongly did Mr. Mime's 10.
  'Meditate': {
    modifyDamage: ({ atk, oppActive }) => {
      const base = parseInt((atk.damage || '0').replace(/[^0-9]/g, '')) || 0;
      return base + Math.floor((oppActive?.damage || 0) / 10) * 10;
    }
  },

  // Mega Drain (Butterfree): heal half damage dealt
  'Mega Drain': _drain(0.5),

  // Metronome (Clefairy/Clefable): copy opp's attack including its effects
  // When the defender has full effect protection (Agility/Barrier/Transparency),
  // the copied attack's damage AND effects on the defender are also blocked.
  // We propagate the flag onto the copied attack so its postAttack handler
  // (and any of our internal _defenderEffectsBlocked checks) honour it.
  'Metronome': {
    postAttack: async ({ player, opp, myActive, atk }) => {
      const oppActive = G.players[opp].active;
      if (!oppActive?.attacks?.length) { addLog(`${atk.name}: opponent has no attacks to copy!`); return; }
      let chosenAtk;
      if (oppActive.attacks.length === 1) { chosenAtk = oppActive.attacks[0]; }
      else if (player !== myRole) {
        // AI picks randomly among the opponent's attacks
        chosenAtk = oppActive.attacks[Math.floor(Math.random() * oppActive.attacks.length)];
      } else {
        chosenAtk = await new Promise(resolve => {
          showActionMenu(`Metronome — copy attack from ${oppActive.name}`,
            oppActive.attacks.map(a => ({
              label: a.name,
              sub: `${a.damage || '—'} dmg · ${a.text || 'No effect'}`,
              fn: () => { closeActionMenu(); resolve(a); }
            })),
            null,
            () => resolve(null) // on dismiss
          );
        });
      }
      if (!chosenAtk) return;
      // Propagate defender-protection flags onto the copied attack so its own
      // postAttack respects them (Agility/Barrier/Transparency on defender).
      if (atk._defenderEffectsBlocked) chosenAtk._defenderEffectsBlocked = true;
      addLog(`${atk.name}: copying ${oppActive.name}'s ${chosenAtk.name}!`, true);
      const energyCount = (myActive?.attachedEnergy || []).length;
      const coinDmg = await resolveCoinFlipDamage(chosenAtk, energyCount, myActive, player);
      let dmg = coinDmg !== null ? coinDmg : (parseInt((chosenAtk.damage || '0').replace(/[^0-9]/g,'')) || 0);
      // Apply damage scaling from dispatch table
      const copyEffect = getMoveEffect(chosenAtk);
      if (copyEffect?.modifyDamage) dmg = copyEffect.modifyDamage({ player, opp, atk: chosenAtk, dmg, myActive, oppActive }) ?? dmg;
      // Defender protection zeroes the copied damage (Agility/Barrier/Transparency).
      if (dmg > 0 && (oppActive.defenderFull || atk._defenderEffectsBlocked)) {
        addLog(`${atk.name}: ${oppActive.name} is fully protected — copied damage prevented.`);
        dmg = 0;
      }
      if (dmg > 0) {
        const currentOpp = G.players[opp].active;
        if (currentOpp) {
          currentOpp.damage = (currentOpp.damage || 0) + dmg;
          addLog(`${atk.name} (${chosenAtk.name}): ${dmg} damage to ${currentOpp.name}!`, true);
          const koResult = checkKO(player, opp, currentOpp, false);
          if (koResult === 'win') { renderAll(); return true; }
        }
      }
      // Apply copied attack's post effects — but skip defender-targeting ones
      // when blocked, matching the same rule applyMoveEffects uses.
      if (copyEffect?.postAttack) {
        const skipForDefenderBlock = atk._defenderEffectsBlocked && copyEffect.targetsDefender;
        if (skipForDefenderBlock) {
          addLog(`${atk.name}: ${chosenAtk.name}'s effect on ${oppActive.name} is prevented.`);
        } else {
          const currentOpp2 = G.players[opp].active;
          await copyEffect.postAttack({ player, opp, atk: chosenAtk, dmgDealt: dmg, myActive, oppActive: currentOpp2 });
        }
      }
      renderAll();
    }
  },

  // Minimize (Clefable/Grimer): reduce damage by 20 next turn
  'Minimize': {
    postAttack: async ({ myActive, atk }) => {
      if (!myActive) return;
      myActive.defender = true;
      addLog(`${atk.name}: ${myActive.name} takes 20 less damage next turn!`, true);
    }
  },

  // Mirror Move (Pidgeotto/Spearow): reflect last attack taken back at opponent
  // Mixed-target: the reflected damage is done TO the defender, so when the
  // defender has full effect protection (Agility/Barrier/Transparency), the
  // reflected damage doesn't apply. We don't use targetsDefender here because
  // we still want to log the "no last attack" / "reflecting X" message.
  'Mirror Move': {
    postAttack: async ({ player, opp, myActive, atk }) => {
      const lastAtk = G.lastAttackOnPlayer?.[player];
      if (!lastAtk) { addLog(`${atk.name}: ${myActive?.name} was not attacked last turn.`); return; }
      addLog(`${atk.name}: reflecting ${lastAtk.attackName} back!`, true);
      if (lastAtk.damage > 0) {
        if (atk._defenderEffectsBlocked) {
          addLog(`${atk.name}: defender is protected — reflected damage prevented.`);
          return;
        }
        const currentOpp = G.players[opp].active;
        if (currentOpp) {
          currentOpp.damage = (currentOpp.damage || 0) + lastAtk.damage;
          addLog(`Mirror Move: ${lastAtk.damage} damage to ${currentOpp.name}!`, true);
          const ko = checkKO(player, opp, currentOpp, false);
          if (ko === 'win') { renderAll(); return true; }
        }
      }
      renderAll();
    }
  },

  // Nightmare (Haunter): opp is Asleep (no flip)
  'Nightmare': _statusOpp('asleep'),

  // Pay Day (Meowth): flip — heads = draw a card
  'Pay Day': {
    postAttack: async ({ player, atk }) => {
      const heads = await flipCoin(`${atk.name}: Heads = draw a card!`);
      if (heads) { drawCard(player, true); addLog(`${atk.name}: HEADS — drew a card!`, true); }
      else addLog(`${atk.name}: TAILS — no draw.`);
    }
  },

  // Petal Dance (Vileplume): coins×40 then self Confused
  'Petal Dance': {
    postAttack: async ({ myActive, atk }) => {
      if (!myActive) return;
      tryApplyStatus(myActive, 'confused');
      addLog(`${atk.name}: ${myActive.name} is now Confused!`, true);
    }
  },

  // Poison Fang (Arbok): opp Poisoned (no flip)
  'Poison Fang': _statusOpp('poisoned'),

  // Poison Sting (Beedrill/Weedle): flip → Poisoned
  'Poison Sting': _statusOppFlip('poisoned'),

  // Poisonpowder — Ivysaur/Tangela/Gloom: no flip, opponent is Poisoned
  // Kakuna/Weepinbell: flip a coin, heads = opponent Poisoned
  // Per card text: Ivysaur/Tangela/Gloom say "The Defending Pokémon is now Poisoned."
  //                Kakuna/Weepinbell say "Flip a coin. If heads, the Defending Pokémon is now Poisoned."
  'Poisonpowder': {
    targetsDefender: true,
    postAttack: async ({ myActive, oppActive, atk }) => {
      const flipCards = ['Kakuna', 'Weepinbell'];
      if (flipCards.includes(myActive?.name)) {
        const heads = await flipCoin(`${atk.name}: Heads = ${oppActive?.name} is Poisoned!`);
        if (heads) {
          tryApplyStatus(oppActive, 'poisoned');
          addLog(`${atk.name}: HEADS — ${oppActive?.name} is now Poisoned!`, true);
        } else {
          addLog(`${atk.name}: TAILS — no poison.`);
        }
      } else {
        tryApplyStatus(oppActive, 'poisoned');
        addLog(`${atk.name}: ${oppActive?.name} is now Poisoned!`, true);
      }
    }
  },

  // Pounce (Persian): incoming attack next turn does 10 less damage
  'Pounce': _reduceIncomingBy10(),

  // Prophecy (Hypno): look at top 3 of either deck, rearrange
  'Prophecy': {
    postAttack: async ({ player, opp, atk }) => {
      const deckChoice = await new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:1100;
          display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;`;
        overlay.innerHTML = `<div style="font-family:var(--font);font-size:10px;color:var(--accent)">Prophecy — Choose Deck</div>
          <div style="display:flex;gap:12px;">
            <button onclick="this.closest('div[style]').remove();window._prophecyChoice=${player}"
              style="font-family:var(--font);font-size:9px;padding:10px 18px;background:var(--surface2);border:1px solid var(--p1color);color:var(--p1color);cursor:pointer;border-radius:4px;">Your Deck (P${player})</button>
            <button onclick="this.closest('div[style]').remove();window._prophecyChoice=${opp}"
              style="font-family:var(--font);font-size:9px;padding:10px 18px;background:var(--surface2);border:1px solid var(--p2color);color:var(--p2color);cursor:pointer;border-radius:4px;">Opponent's Deck (P${opp})</button>
          </div>`;
        document.body.appendChild(overlay);
        const check = setInterval(() => { if (window._prophecyChoice !== undefined) { clearInterval(check); const v = window._prophecyChoice; window._prophecyChoice = undefined; resolve(v); } }, 100);
      });
      await prophecyModal(player, deckChoice, 3);
      renderAll();
    }
  },

  // Psychic (Mewtwo): 10 + 10 per energy attached to defender
  'Psychic': {
    modifyDamage: ({ oppActive }) => 10 + (oppActive?.attachedEnergy || []).length * 10
  },

  // Rage (Dodrio/Cubone): 10 + 10 per own damage counter
  'Rage': {
    modifyDamage: ({ myActive }) => 10 + Math.floor((myActive?.damage || 0) / 10) * 10
  },

  // Rampage (Tauros): 20 + 10 per own damage counter, flip → self Confused
  'Rampage': {
    modifyDamage: ({ myActive }) => 20 + Math.floor((myActive?.damage || 0) / 10) * 10,
    postAttack: async ({ myActive, atk }) => {
      if (!myActive) return;
      const heads = await flipCoin(`${atk.name}: Tails = ${myActive.name} is now Confused!`);
      if (!heads) { tryApplyStatus(myActive, 'confused'); addLog(`${atk.name}: TAILS — ${myActive.name} Confused!`, true); }
      else addLog(`${atk.name}: HEADS — no confusion.`);
    }
  },

  // Sand-attack (Sandshrew): smokescreen-style (must flip to attack next turn)
  'Sand-attack': _smokescreen(),

  // Scavenge (Slowpoke): retrieve Trainer from own discard
  'Scavenge': {
    postAttack: async ({ player, atk }) => {
      const myP = G.players[player];
      const trainers = myP.discard.filter(c => c.supertype === 'Trainer');
      if (!trainers.length) { addLog(`${atk.name}: no Trainers in discard.`); return; }
      const picked = await openCardPicker({ title: `${atk.name}`, subtitle: 'Choose a Trainer to retrieve', cards: trainers, maxSelect: 1 });
      if (picked && picked.length) {
        const card = trainers[picked[0]];
        const di = myP.discard.findIndex(c => c === card);
        if (di !== -1) myP.hand.push(...myP.discard.splice(di, 1));
        addLog(`${atk.name}: retrieved ${card.name} to hand.`, true);
        renderAll();
      }
    }
  },

  // Scrunch (Chansey): flip → full protection
  'Scrunch': _selfProtectFlip(),

  // Sing (Clefairy): flip → Asleep
  'Sing': _statusOppFlip('asleep'),

  // Slash (Scyther): boosted to 60 if Swords Dance was used this turn.
  // Slash has blank card text on every printing (Dugtrio, Charmeleon, Scyther,
  // Parasect, Sandslash), so it must opt in past the vanilla guard. Harmless on
  // non-Scyther: swordsDanceActive is only ever set by Swords Dance.
  'Slash': {
    allowVanilla: true,
    modifyDamage: ({ myActive }) => {
      if (myActive?.swordsDanceActive) {
        myActive.swordsDanceActive = false;
        myActive.swordsDanceJustSet = false;
        addLog(`Swords Dance: Slash boosted to 60!`, true);
        return 60;
      }
      return null; // use normal base damage
    }
  },

  // Sleeping Gas (Gastly): flip → Asleep
  'Sleeping Gas': _statusOppFlip('asleep'),

  // Sludge (Muk): flip → Poisoned
  'Sludge': _statusOppFlip('poisoned'),

  // Smog (Magmar/Weezing): flip → Poisoned
  'Smog': _statusOppFlip('poisoned'),

  // Smokescreen (Magmar/Horsea): must flip to attack next turn
  'Smokescreen': _smokescreen(),

  // Snivel (Cubone): reduce incoming damage by 20 next turn
  'Snivel': {
    postAttack: async ({ myActive, atk }) => {
      if (!myActive) return;
      myActive.pounceActive = true; myActive.pounceReduction = 20;
      addLog(`${atk.name}: incoming attack next turn does 20 less damage!`, true);
    }
  },

  // Sonicboom (Magneton): skip W/R entirely (flag read by performAttack)
  'Sonicboom': {
    preAttack: ({ atk }) => { atk._skipWR = true; }
  },

  // Spacing Out (Slowpoke): flip — heads = remove 1 damage counter from self
  'Spacing Out': {
    postAttack: async ({ myActive, atk }) => {
      if (!myActive || (myActive.damage || 0) <= 0) { addLog(`${atk.name}: ${myActive?.name} has no damage counters.`); return; }
      const heads = await flipCoin(`${atk.name}: Heads = remove 1 damage counter from ${myActive.name}`);
      if (heads) { myActive.damage = Math.max(0, (myActive.damage || 0) - 10); addLog(`${atk.name}: HEADS — removed 1 counter from ${myActive.name}!`, true); }
      else addLog(`${atk.name}: TAILS — no healing.`);
    }
  },

  // Spark (Pikachu): 10 to chosen opp bench
  'Spark': _benchDamage10(),

  // Spit Poison (Ekans): flip → Poisoned
  'Spit Poison': _statusOppFlip('poisoned'),

  // Spore (Parasect/Paras): opp Asleep (no flip)
  'Spore': _statusOpp('asleep'),

  // Stiffen (Kakuna/Metapod): flip → full protection
  'Stiffen': _selfProtectFlip(),

  // Stretch Kick (Hitmonlee): 20 to chosen opp bench
  'Stretch Kick': _benchDamage20(),

  // Supersonic (Lickitung/Nidorina/Tentacruel/Shellder/Zubat): flip → Confused
  'Supersonic': _statusOppFlip('confused'),

  // Super Fang (Raticate): damage = half opp's remaining HP (rounded up to 10)
  // Super Fang (Raticate): damage = half opp's remaining HP (rounded up to nearest 10)
  // Card does not apply Weakness or Resistance
  'Super Fang': {
    preAttack: ({ atk }) => { atk._skipWR = true; },
    modifyDamage: ({ oppActive }) => {
      const hp = parseInt(oppActive?.hp) || 0;
      return roundUp10(Math.max(0, hp - (oppActive?.damage || 0)) / 2);
    }
  },

  // Swords Dance (Scyther): flag next Slash to do 60 instead of 30.
  // swordsDanceJustSet prevents endTurn from clearing the buff on the same
  // turn it was set — the buff must survive until the player's NEXT turn
  // when they can actually use Slash. endTurn will see the JustSet flag,
  // clear it, and leave swordsDanceActive intact for the upcoming turn.
  'Swords Dance': {
    postAttack: async ({ myActive, atk }) => {
      if (!myActive) return;
      myActive.swordsDanceActive = true;
      myActive.swordsDanceJustSet = true;
      addLog(`${atk.name}: ${myActive.name}'s next Slash will do 60!`, true);
    }
  },

  // Tail Wag (Eevee): flip → defending can't attack this Pokémon next turn
  'Tail Wag': _tailWag(),

  // Tantrum (Primeape): flip — tails = self Confused
  'Tantrum': {
    postAttack: async ({ myActive, atk }) => {
      if (!myActive) return;
      const heads = await flipCoin(`${atk.name}: Tails = ${myActive.name} is now Confused!`);
      if (!heads) { tryApplyStatus(myActive, 'confused'); addLog(`${atk.name}: TAILS — ${myActive.name} Confused!`, true); }
      else addLog(`${atk.name}: HEADS — no confusion.`);
    }
  },

  // Teleport (Exeggutor): switch self with a bench Pokémon
  'Teleport': {
    postAttack: async ({ player, atk }) => {
      const myP = G.players[player];
      const bench = myP.bench.map((s, i) => ({ s, i })).filter(x => x.s !== null);
      if (!bench.length) { addLog(`${atk.name}: no bench Pokémon to switch with.`); return; }
      let target = bench[0];
      if (bench.length > 1) {
        const picked = await openCardPicker({ title: `${atk.name}`, subtitle: 'Choose a bench Pokémon to switch to Active', cards: bench.map(x => x.s), maxSelect: 1 });
        if (picked && picked.length) target = bench[picked[0]];
      }
      const old = myP.active;
      // Leaving the Active spot ends attack effects on the card (Smokescreen,
      // Leer, Amnesia…) and cures Special Conditions, as with any bench swap.
      if (old) { clearAllStatus(old); clearActiveOnlyEffects(old); }
      myP.active = target.s; myP.bench[target.i] = old;
      addLog(`${atk.name}: switched ${old?.name} with ${target.s.name}.`, true);
      renderAll();
    }
  },

  // Terror Strike (Arbok): flip — heads = Whirlwind effect (opp chooses bench → active)
  'Terror Strike': {
    postAttack: async ({ opp, atk }) => {
      const heads = await flipCoin(`${atk.name}: Heads = force opp to switch!`);
      if (heads) {
        if (G.players[opp].bench.some(s => s !== null)) await forceOpponentSwitch(opp, false, atk.name);
        else addLog(`${atk.name}: HEADS, but opponent has no bench.`);
      } else addLog(`${atk.name}: TAILS — no switch.`);
    }
  },

  // Thunderstorm (Zapdos): flip per opp bench — heads=20 to it, tails=10 to self.
  // preAttack so the bench hits land even when the 40 KOs the Defending Pokémon.
  // Recoil that KOs Zapdos is flagged for performAttack (atk._selfKOdInPre) so
  // the normal "also knocked out by recoil" flow handles the promotion.
  'Thunderstorm': {
    preAttack: async ({ player, opp, myActive, atk }) => {
      const bench = G.players[opp].bench.map((s, i) => ({ s, i })).filter(x => x.s !== null);
      if (!bench.length) { addLog(`${atk.name}: opponent has no bench.`); return null; }
      let tails = 0;
      const total = bench.length;
      for (let fi = 0; fi < bench.length; fi++) {
        const { s, i } = bench[fi];
        const heads = await flipCoin(
          `${atk.name}: Flip for ${s.name} — Heads=20 damage, Tails=10 recoil`,
          { persistent: fi < total - 1, flipNum: fi + 1, totalFlips: total }
        );
        if (fi === total - 1) closeCoinOverlay();
        if (heads) _hitBench(opp, i, 20, atk.name);
        else { tails++; addLog(`${atk.name}: TAILS for ${s.name}.`); }
      }
      if (tails > 0 && myActive) {
        const selfDmg = tails * 10;
        myActive.damage = (myActive.damage || 0) + selfDmg;
        addLog(`${atk.name}: ${tails} tails — ${myActive.name} takes ${selfDmg} recoil!`, true);
        const hp = parseInt(myActive.hp) || 0;
        if (hp > 0 && myActive.damage >= hp) atk._selfKOdInPre = true;
      }
      renderAll();
      return null;
    }
  },

  // Toxic (Nidoking): heavy poison — 20 damage per turn instead of 10
  'Toxic': {
    targetsDefender: true,
    postAttack: async ({ oppActive, atk }) => {
      if (!oppActive) return;
      // Use tryApplyStatus so Thick Skinned (Snorlax) properly blocks it,
      // and so the multi-status routing puts this in the poison slot
      // independently of any special condition the defender may have.
      tryApplyStatus(oppActive, 'poisoned-toxic');
      addLog(`${atk.name}: ${oppActive.name} is now Badly Poisoned (20/turn)!`, true);
    }
  },

  // Venom Powder (Venomoth): flip — heads = Confused AND Poisoned
  'Venom Powder': {
    targetsDefender: true,
    postAttack: async ({ oppActive, atk }) => {
      if (!oppActive) return;
      const heads = await flipCoin(`${atk.name}: Heads = Confused AND Poisoned!`);
      if (heads) {
        tryApplyStatus(oppActive, 'confused'); tryApplyStatus(oppActive, 'poisoned');
        addLog(`${atk.name}: HEADS — ${oppActive.name} is Confused and Poisoned!`, true);
      } else addLog(`${atk.name}: TAILS — no effect.`);
    }
  },

  // Whirlpool (Poliwrath): discard 1 energy from opp
  'Whirlpool': _discardOppEnergy(),

  // Whirlwind (Pidgeotto/Pidgey/Butterfree): opp chooses bench Pokémon → active
  'Whirlwind': {
    postAttack: async ({ opp, atk }) => {
      if (!G.players[opp].bench.some(s => s !== null)) { addLog(`${atk.name}: opponent has no bench.`); return; }
      await forceOpponentSwitch(opp, false, atk.name);
    }
  },

  // Wildfire (Moltres): discard own fire energy → mill that many from opp's deck
  'Wildfire': {
    postAttack: async ({ player, opp, myActive, atk }) => {
      if (!myActive) return;
      const fireEnergy = (myActive.attachedEnergy || []).filter(e => /fire/i.test(e.name));
      if (!fireEnergy.length) { addLog(`${atk.name}: no Fire Energy to discard.`); return; }
      const picked = await openCardPicker({ title: `${atk.name}`, subtitle: 'Choose Fire Energy to discard (1 mill per card)', cards: fireEnergy, maxSelect: fireEnergy.length });
      if (picked && picked.length) {
        picked.sort((a,b)=>b-a).forEach(pi => { const ei = myActive.attachedEnergy.findIndex(e => e === fireEnergy[pi]); if (ei !== -1) G.players[player].discard.push(...myActive.attachedEnergy.splice(ei,1)); });
        const milled = G.players[opp].deck.splice(0, picked.length);
        G.players[opp].discard.push(...milled);
        addLog(`${atk.name}: discarded ${picked.length} Fire Energy — milled ${milled.length} cards!`, true);
        if (!G.players[opp].deck.length) { G.started = false; showWinScreen(player, "OPPONENT'S DECK EMPTY"); if (typeof pushGameState === 'function') pushGameState(); renderAll(); return true; }
        renderAll();
      }
    }
  },

  // Withdraw (Wartortle/Squirtle): flip → full protection next turn
  'Withdraw': _selfProtectFlip(),
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API — called from the hooks in pokemon-game.html
// ─────────────────────────────────────────────────────────────────────────────

// Resolve the dispatch entry for an attack, or null if none applies.
// MOVE_EFFECTS is keyed by attack NAME, and names are reused across cards with
// different effects (Tentacool's Acid vs Victreebel's Acid, Krabby's Irongrip
// vs Pinsir's). So a name hit is only accepted when the attack's own text
// supports it:
//   • blank text  → no handler (unless the entry sets allowVanilla)
//   • requireText → text must match that RegExp
// Every lookup (this file and game-actions.js) MUST go through here; never
// index MOVE_EFFECTS[atk.name] directly.
function getMoveEffect(atk) {
  if (!atk?.name) return null;
  const effect = MOVE_EFFECTS[atk.name];
  if (!effect) return null;
  const text = (atk.text || '').trim();
  if (!text && !effect.allowVanilla) return null;
  if (effect.requireText && !effect.requireText.test(text)) return null;
  return effect;
}

function preAttackChecks(player, atk, myActive, oppActive) {
  const effect = getMoveEffect(atk);
  if (!effect?.preAttack) return null;
  return effect.preAttack({ player, opp: player === 1 ? 2 : 1, atk, myActive, oppActive });
}

async function preDamageModify(player, atk, dmg, myActive, oppActive) {
  const effect = getMoveEffect(atk);
  if (!effect?.modifyDamage) return dmg;
  const result = await effect.modifyDamage({ player, opp: player === 1 ? 2 : 1, atk, dmg, myActive, oppActive });
  return (result !== null && result !== undefined) ? result : dmg;
}

async function applyMoveEffects(player, atk, dmgDealt, myActive, oppActive) {
  const effect = getMoveEffect(atk);
  if (!effect?.postAttack) return;
  // Defender protection (Agility/Barrier heads, Transparency heads) blocks
  // effects "done TO" the defender's Active. If this handler is declared
  // targetsDefender, skip the whole postAttack — but log so the player sees
  // why nothing happened. Mixed-target handlers (Foul Odor, Mirror Move,
  // Metronome) leave the flag off and check atk._defenderEffectsBlocked
  // internally to skip only the defender-targeting portion.
  if (atk._defenderEffectsBlocked && effect.targetsDefender) {
    addLog(`${atk.name}: ${oppActive?.name || 'defender'} is fully protected — effect prevented.`, true);
    return;
  }
  return effect.postAttack({ player, opp: player === 1 ? 2 : 1, atk, dmgDealt, myActive, oppActive });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUPPORT FUNCTIONS — called from performAttack hooks in pokemon-game.html
// ─────────────────────────────────────────────────────────────────────────────

function checkDestinyBond(koedCard, attackingPlayer) {
  if (!koedCard?.destinyBond) return;
  const attacker = G.players[attackingPlayer].active;
  if (!attacker) return;
  addLog(`Destiny Bond! ${attacker.name} is also knocked out!`, true);
  attacker.damage = parseInt(attacker.hp) || 999;
  G.players[attackingPlayer].discard.push(attacker);
  G.players[attackingPlayer].active = null;
  koedCard.destinyBond = false;
  const defPlayer = attackingPlayer === 1 ? 2 : 1;
  const prizeIdx = G.players[defPlayer].prizes.findIndex(p => p);
  if (prizeIdx !== -1) {
    const prizeCard = G.players[defPlayer].prizes[prizeIdx];
    G.players[defPlayer].hand.push(prizeCard.card);
    G.players[defPlayer].prizes[prizeIdx] = null;
    const remaining = G.players[defPlayer].prizes.filter(p => p).length;
    addLog(`P${defPlayer} took a prize from Destiny Bond! (${remaining} remaining)`, true);
    if (remaining === 0) { G.started = false; showWinScreen(defPlayer, 'ALL 6 PRIZES TAKEN'); if (typeof pushGameState === 'function') pushGameState(); return; }
  }
  if (!G.players[attackingPlayer].bench.filter(s => s !== null).length) {
    G.started = false; showWinScreen(defPlayer, 'DESTINY BOND — ATTACKER HAS NO POKÉMON LEFT');
    if (typeof pushGameState === 'function') pushGameState();
  }
}

function recordLastAttack(attackingPlayer, atkName, dmgDealt) {
  if (!G.lastAttackOnPlayer) G.lastAttackOnPlayer = {};
  G.lastAttackOnPlayer[attackingPlayer === 1 ? 2 : 1] = { attackName: atkName, damage: dmgDealt };
}

function clearLastAttack(playerWhoseActiveChanged) {
  if (!G.lastAttackOnPlayer) return;
  G.lastAttackOnPlayer[playerWhoseActiveChanged] = null;
}

function endTurnEffectsCleanup(prevPlayer, newPlayer) {
  // Tail Wag / Leer immunity: clears after one attack turn
  const prevOppActive = G.players[prevPlayer].active;
  if (prevOppActive?.immuneToAttack) prevOppActive.immuneToAttack = false;
  // Pounce / Growl: protects DURING the opponent's turn and expires when that
  // turn ends — at which point the flag-holder is `newPlayer` (the same rule the
  // defender* flags follow in endTurn). Clearing BOTH sides here used to wipe the
  // flag at the end of the user's own turn, before it could ever apply.
  const nextActive = G.players[newPlayer].active;
  if (nextActive?.pounceActive) { nextActive.pounceActive = false; nextActive.pounceReduction = 0; }
  // Headache: unblocks the new player at the start of their turn
  if (G.players[newPlayer].trainerBlocked) {
    G.players[newPlayer].trainerBlocked = false;
    addLog(`P${newPlayer} can play Trainer cards again.`);
  }
}

function conversionBadges(card) {
  const parts = [];
  if (card.conversionWeakness) {
    const ico = typeof energyIcon === 'function' ? energyIcon(card.conversionWeakness, 10) : '';
    parts.push(`<div class="card-badge" style="background:rgba(232,104,58,.9);color:#fff;" title="Weakness changed">${ico}WK</div>`);
  }
  if (card.conversionResistance) {
    const ico = typeof energyIcon === 'function' ? energyIcon(card.conversionResistance, 10) : '';
    parts.push(`<div class="card-badge" style="background:rgba(91,200,120,.9);color:#000;" title="Resistance changed">${ico}RS</div>`);
  }
  return parts.join('');
}

function isTrainerBlocked(player) {
  return !!G.players[player].trainerBlocked;
}