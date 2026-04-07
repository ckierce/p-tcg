// ══════════════════════════════════════════════════════════════════════════════
// MOVE-EFFECTS.JS — Special attack effect handlers for Pokémon TCG
// All functions here are called from performAttack() in pokemon-game.html.
// They share access to the global G state, flipCoin, openCardPicker, addLog,
// showToast, renderAll, checkKO, endTurn, drawCard, tryApplyStatus,
// shuffle, and ENERGY_ICONS.
// ══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Round up to nearest 10
function roundUp10(n) { return Math.ceil(n / 10) * 10; }

// All Pokémon types for pickers
const ALL_TYPES = ['Fire','Water','Grass','Lightning','Psychic','Fighting','Darkness','Metal','Colorless'];

// Build a type-picker overlay; resolves with chosen type string or null
function pickType(title) {
  return new Promise(resolve => {
    const existing = document.getElementById('type-picker-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'type-picker-overlay';
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:900;
      display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;`;

    const titleEl = document.createElement('div');
    titleEl.textContent = title;
    titleEl.style.cssText = 'font-family:var(--font);font-size:10px;color:var(--accent);text-align:center;';

    const grid = document.createElement('div');
    grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;justify-content:center;max-width:360px;';

    ALL_TYPES.forEach(type => {
      const btn = document.createElement('button');
      btn.style.cssText = `
        background:var(--surface2);border:1px solid var(--border2);color:var(--text);
        font-family:var(--font);font-size:8px;padding:8px 12px;cursor:pointer;border-radius:4px;
        display:flex;align-items:center;gap:6px;`;
      const iconKey = type.toLowerCase() === 'lightning' ? 'lightning' : type.toLowerCase();
      const iconEl = document.createElement('span');
      // Use energyIcon if available globally
      if (typeof energyIcon === 'function') {
        iconEl.innerHTML = energyIcon(type, 16);
      } else {
        iconEl.textContent = type[0];
      }
      btn.appendChild(iconEl);
      btn.appendChild(document.createTextNode(type));
      btn.addEventListener('click', () => { overlay.remove(); resolve(type); });
      grid.appendChild(btn);
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = `
      background:none;border:1px solid var(--border2);color:var(--muted);
      font-family:var(--font);font-size:8px;padding:6px 14px;cursor:pointer;border-radius:4px;margin-top:4px;`;
    cancelBtn.addEventListener('click', () => { overlay.remove(); resolve(null); });

    overlay.appendChild(titleEl);
    overlay.appendChild(grid);
    overlay.appendChild(cancelBtn);
    document.body.appendChild(overlay);
  });
}

// Force-switch the opponent's active Pokémon with a bench Pokémon.
// If attacker chooses: attackerChooses=true. Else defending player chooses.
// Returns a promise that resolves when the switch is complete (or skipped).
async function forceOpponentSwitch(opp, attackerChooses, attackName) {
  const oppP = G.players[opp];
  const benchSlots = oppP.bench.map((s, i) => ({ s, i })).filter(x => x.s !== null);
  if (!benchSlots.length) return; // nothing to switch to

  const doSwitch = (idx) => {
    const { s } = benchSlots.find(x => x.i === idx) || {};
    if (!s) return;
    const old = oppP.active;
    oppP.active = s;
    oppP.bench[idx] = old;
    addLog(`${attackName}: P${opp}'s ${s.name} was forced to Active!`, true);
    renderAll();
  };

  if (benchSlots.length === 1) {
    doSwitch(benchSlots[0].i);
    return;
  }

  if (attackerChooses) {
    // Attacking player picks from opponent's bench
    const picked = await openCardPicker({
      title: `${attackName} — Choose Opponent's Pokémon`,
      subtitle: `Choose 1 of P${opp}'s benched Pokémon to force Active`,
      cards: benchSlots.map(x => x.s),
      maxSelect: 1
    });
    if (picked && picked.length) doSwitch(benchSlots[picked[0]].i);
  } else {
    // Defending player chooses which bench Pokémon becomes active
    return new Promise(resolve => {
      addLog(`P${opp} must choose a bench Pokémon to switch in (${attackName})!`, true);
      // Highlight opp bench slots
      benchSlots.forEach(({ i }) => {
        document.getElementById(`bench-p${opp}-${i}`)?.classList.add('highlight');
      });
      // Temporarily override bench-slot click to resolve the switch
      const origHandler = window._forceSwitchHandler;
      window._forceSwitchHandler = { opp, benchSlots, resolve: (idx) => {
        // Clear highlights
        for (let k = 0; k < 5; k++) document.getElementById(`bench-p${opp}-${k}`)?.classList.remove('highlight');
        window._forceSwitchHandler = null;
        doSwitch(idx);
        resolve();
      }};
    });
  }
}

// Show a "Prophecy" deck reorder modal — show top N cards of a deck, let
// the active player drag them into their preferred order, then put back.
function prophecyModal(player, targetPlayer, numCards) {
  return new Promise(resolve => {
    const deck = G.players[targetPlayer].deck;
    if (!deck.length) { addLog('Prophecy: deck is empty!'); resolve(); return; }
    const n = Math.min(numCards, deck.length);
    const topCards = deck.slice(0, n); // index 0 = top of deck

    const existing = document.getElementById('prophecy-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'prophecy-overlay';
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:900;
      display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;`;

    const title = document.createElement('div');
    title.textContent = `Prophecy — P${targetPlayer}'s Top ${n} Cards`;
    title.style.cssText = 'font-family:var(--font);font-size:10px;color:var(--accent);';

    const sub = document.createElement('div');
    sub.textContent = 'Drag to reorder. Top card will be drawn first.';
    sub.style.cssText = 'font-family:var(--font);font-size:8px;color:var(--muted);';

    const cardRow = document.createElement('div');
    cardRow.style.cssText = 'display:flex;gap:10px;align-items:flex-end;';

    // Build draggable card elements
    let orderIndices = topCards.map((_, i) => i); // maps position -> original index

    const buildCards = () => {
      cardRow.innerHTML = '';
      orderIndices.forEach((origIdx, pos) => {
        const c = topCards[origIdx];
        const el = document.createElement('div');
        el.draggable = true;
        el.dataset.pos = pos;
        el.style.cssText = `
          width:70px;height:98px;border:1px solid var(--border2);border-radius:4px;
          overflow:hidden;cursor:grab;position:relative;background:var(--surface2);`;
        el.innerHTML = `
          <img src="${c.images?.small || ''}" alt="${c.name}" style="width:100%;height:100%;object-fit:cover;">
          <div style="position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,.7);
            font-family:var(--font);font-size:5px;color:#fff;text-align:center;padding:2px;">${c.name}</div>
          <div style="position:absolute;top:2px;left:2px;background:rgba(0,0,0,.7);
            font-family:var(--font);font-size:6px;color:var(--accent);padding:1px 3px;border-radius:2px;">#${pos + 1}</div>`;

        el.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', pos); el.style.opacity = '.5'; });
        el.addEventListener('dragend', () => { el.style.opacity = '1'; });
        el.addEventListener('dragover', e => { e.preventDefault(); el.style.borderColor = 'var(--accent)'; });
        el.addEventListener('dragleave', () => { el.style.borderColor = 'var(--border2)'; });
        el.addEventListener('drop', e => {
          e.preventDefault();
          el.style.borderColor = 'var(--border2)';
          const fromPos = parseInt(e.dataTransfer.getData('text/plain'));
          const toPos = parseInt(el.dataset.pos);
          if (fromPos === toPos) return;
          const tmp = orderIndices[fromPos];
          orderIndices.splice(fromPos, 1);
          orderIndices.splice(toPos, 0, tmp);
          buildCards();
        });
        cardRow.appendChild(el);
      });
    };
    buildCards();

    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = 'Confirm Order';
    confirmBtn.style.cssText = `
      background:var(--accent);color:#000;border:none;font-family:var(--font);
      font-size:9px;padding:10px 24px;cursor:pointer;border-radius:4px;`;
    confirmBtn.addEventListener('click', () => {
      overlay.remove();
      // Apply new order to deck top
      const reordered = orderIndices.map(i => topCards[i]);
      for (let i = 0; i < n; i++) deck[i] = reordered[i];
      addLog(`Prophecy: P${player} rearranged the top ${n} cards of P${targetPlayer}'s deck.`, true);
      resolve();
    });

    overlay.appendChild(title);
    overlay.appendChild(sub);
    overlay.appendChild(cardRow);
    overlay.appendChild(confirmBtn);
    document.body.appendChild(overlay);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENTRY POINT — called from performAttack() after damage is applied
// Returns true if the attack should NOT call endTurn (it handled it internally),
// false/undefined if normal endTurn should proceed.
// Parameters:
//   player      — attacking player number (1 or 2)
//   atk         — attack object { name, text, damage, ... }
//   dmgDealt    — actual damage dealt to opponent (after W/R/modifiers), 0 if none
//   myActive    — attacking card object
//   oppActive   — defending card object (snapshot; may be null if KO'd)
// ─────────────────────────────────────────────────────────────────────────────
async function applyMoveEffects(player, atk, dmgDealt, myActive, oppActive) {
  const opp = player === 1 ? 2 : 1;
  const text = atk.text || '';
  const name = atk.name || '';

  // ── DREAM EATER — checked BEFORE damage in performAttack, but guard here too ──
  // (handled via pre-check in performAttack; nothing extra needed here)

  // ── QUICK ATTACK (Flareon/Jolteon/Vaporeon/Eevee) ──────────────────────────
  // Handled by resolveCoinFlipDamage Pattern 4 ("if heads, 10 more damage") ✓

  // ── STOMP (Rapidash/Tauros) ─────────────────────────────────────────────────
  // Handled by resolveCoinFlipDamage Pattern 4 ✓

  // ── THRASH (Nidoking) ───────────────────────────────────────────────────────
  // Handled by resolveCoinFlipDamage Pattern 4 + Pattern 6 ✓

  // ── LEEK SLAP (Farfetch'd) ──────────────────────────────────────────────────
  if (/can't use this attack again as long as/i.test(text)) {
    myActive.leekSlapUsed = true;
    addLog(`${name}: ${myActive.name} can't use ${name} again while it's in play!`, true);
  }

  // ── HORN HAZARD / DIVE BOMB — coin-flip "does nothing" ──────────────────────
  // Handled by resolveCoinFlipDamage Pattern 3 ✓

  // ── CLAMP (Cloyster) — coin: heads=paralyze, tails=no damage ────────────────
  // Damage is handled by resolveCoinFlipDamage (tails=0). Paralysis handled by
  // parseStatusEffects. But Clamp's tails also cancels paralysis — so we track
  // whether damage was actually done.
  // (parseStatusEffects already correctly requires heads for the paralysis.)

  // ── KARATE CHOP (Machoke) ───────────────────────────────────────────────────
  // Handled inline in performAttack via the damage scaling section below (see note).
  // Actually NOT handled — we need to compute this specially.
  if (/does 50 damage minus 10 damage for each damage counter on/i.test(text)) {
    // dmgDealt was already computed with wrong base; we patched this in performAttack
    // (see KARATE_CHOP_HANDLED note). No additional effect needed here.
  }

  // ── FLAIL / RAGE / RAMPAGE — self-counter scaling ───────────────────────────
  // Handled in performAttack via pre-attack dmg override. Nothing extra here.

  // ── RAMPAGE post-attack confusion ──────────────────────────────────────────
  if (/if tails.*is now confused.*after doing damage/i.test(text) && myActive) {
    const heads = await flipCoin(`${name}: Tails = ${myActive.name} becomes Confused!`);
    if (!heads) {
      tryApplyStatus(myActive, 'confused');
      addLog(`${name}: TAILS — ${myActive.name} is now Confused!`, true);
    } else {
      addLog(`${name}: HEADS — no confusion.`);
    }
  }

  // ── SUPER FANG (Raticate) ───────────────────────────────────────────────────
  // Handled in performAttack pre-damage section. Nothing extra needed.

  // ── BOYFRIENDS (Nidoqueen) ──────────────────────────────────────────────────
  // Handled in performAttack pre-damage section. Nothing extra needed.

  // ── DO THE WAVE (Wigglytuff) ────────────────────────────────────────────────
  // Handled in performAttack pre-damage section. Nothing extra needed.

  // ── SONICBOOM (Magneton) ────────────────────────────────────────────────────
  // Handled in performAttack — skip W/R. Nothing extra needed.

  // ── MEGA DRAIN / ABSORB (drain = half damage dealt) ────────────────────────
  if (/remove a number of damage counters.*equal to half the damage done/i.test(text) && myActive && dmgDealt > 0) {
    const heal = roundUp10(dmgDealt / 2);
    myActive.damage = Math.max(0, (myActive.damage || 0) - heal);
    addLog(`${name}: ${myActive.name} drained ${heal} damage (healed ${heal}hp)!`, true);
  }

  // ── LEECH LIFE (drain = full damage dealt) ─────────────────────────────────
  if (/remove a number of damage counters from .+ equal to the damage done to the defending/i.test(text) && myActive && dmgDealt > 0) {
    const heal = dmgDealt;
    myActive.damage = Math.max(0, (myActive.damage || 0) - heal);
    addLog(`${name}: ${myActive.name} leeched ${heal} damage!`, true);
  }

  // ── LEECH SEED (Bulbasaur/Exeggcute) — optional 1 counter heal if dmg>0 ────
  if (/unless all damage from this attack is prevented.*remove 1 damage counter/i.test(text) && myActive && dmgDealt > 0) {
    myActive.damage = Math.max(0, (myActive.damage || 0) - 10);
    addLog(`${name}: ${myActive.name} removed 1 damage counter via Leech Seed!`, true);
  }

  // ── SPACING OUT (Slowpoke) — coin flip, heads = remove 1 counter from self ──
  if (/flip a coin.*if heads.*remove a damage counter from/i.test(text) && myActive) {
    if ((myActive.damage || 0) <= 0) {
      addLog(`${name}: ${myActive.name} has no damage counters — no effect.`);
    } else {
      const heads = await flipCoin(`${name}: Heads = remove 1 damage counter from ${myActive.name}`);
      if (heads) {
        myActive.damage = Math.max(0, (myActive.damage || 0) - 10);
        addLog(`${name}: HEADS — removed 1 damage counter from ${myActive.name}!`, true);
      } else {
        addLog(`${name}: TAILS — no healing.`);
      }
    }
  }

  // ── LURE (Ninetales/Victreebel) — attacker chooses opp's bench → active ─────
  if (/if your opponent has any bench.*choose 1 of them and switch it with his or her active/i.test(text)) {
    const oppBench = G.players[opp].bench.map((s, i) => ({ s, i })).filter(x => x.s !== null);
    if (!oppBench.length) {
      addLog(`${name}: opponent has no Benched Pokémon to switch.`);
    } else {
      await forceOpponentSwitch(opp, true, name);
    }
  }

  // ── WHIRLWIND (Pidgeotto/Pidgey/Butterfree) — defending player chooses ──────
  if (/if your opponent has any bench.*he or she chooses 1 of them and switches it with the defending/i.test(text)) {
    const oppBench = G.players[opp].bench.map((s, i) => ({ s, i })).filter(x => x.s !== null);
    if (!oppBench.length) {
      addLog(`${name}: opponent has no Benched Pokémon to switch.`);
    } else {
      await forceOpponentSwitch(opp, false, name);
    }
  }

  // ── TERROR STRIKE (Arbok) — coin, heads = Whirlwind effect ─────────────────
  if (/flip a coin.*if heads and if your opponent has any bench.*switches it with the defending/i.test(text)) {
    const heads = await flipCoin(`${name}: Heads = force opponent to switch!`);
    if (heads) {
      const oppBench = G.players[opp].bench.map((s, i) => ({ s, i })).filter(x => x.s !== null);
      if (oppBench.length) {
        await forceOpponentSwitch(opp, false, name);
      } else {
        addLog(`${name}: HEADS, but opponent has no bench Pokémon.`);
      }
    } else {
      addLog(`${name}: TAILS — no switch.`);
    }
  }

  // ── RAM (Rhydon) — switch happens before recoil KO check (handled in performAttack) ──
  // The switch itself is triggered in performAttack before self-damage KO resolution.

  // ── TELEPORT (Exeggutor) — switch self with own bench ──────────────────────
  if (/switch exeggutor with 1 of your bench/i.test(text)) {
    const myP = G.players[player];
    const myBench = myP.bench.map((s, i) => ({ s, i })).filter(x => x.s !== null);
    if (!myBench.length) {
      addLog(`${name}: no Benched Pokémon to switch with.`);
    } else if (myBench.length === 1) {
      const { s, i } = myBench[0];
      const old = myP.active;
      myP.active = s; myP.bench[i] = old;
      addLog(`${name}: switched ${old?.name} with ${s.name}.`, true);
    } else {
      const picked = await openCardPicker({
        title: `${name} — Switch Self`,
        subtitle: 'Choose a bench Pokémon to switch to Active',
        cards: myBench.map(x => x.s),
        maxSelect: 1
      });
      if (picked && picked.length) {
        const { s, i } = myBench[picked[0]];
        const old = myP.active;
        myP.active = s; myP.bench[i] = old;
        addLog(`${name}: switched ${old?.name} with ${s.name}.`, true);
      }
    }
  }

  // ── HURRICANE (Pidgeot) — return defending Pokémon + attachments to hand ────
  if (/unless this attack knocks out the defending pok/i.test(text)) {
    // Only triggers if opponent is still alive
    const currentOppActive = G.players[opp].active;
    if (currentOppActive) {
      // Return Pokémon, all attached energy, and pre-evolutions from discard
      const oppP = G.players[opp];
      const returnedCard = currentOppActive;
      oppP.active = null;

      // Cards to return to hand: the active card + its attached energy
      const toHand = [returnedCard, ...(returnedCard.attachedEnergy || [])];
      returnedCard.attachedEnergy = [];
      returnedCard.damage = 0;
      returnedCard.status = null;

      // Also return pre-evolutions from discard (chain: evolvesFrom)
      let evoName = returnedCard.evolvesFrom;
      while (evoName) {
        const preEvoIdx = oppP.discard.findIndex(c => c.name === evoName && c.supertype === 'Pokémon');
        if (preEvoIdx !== -1) {
          const preEvo = oppP.discard.splice(preEvoIdx, 1)[0];
          preEvo.damage = 0; preEvo.attachedEnergy = []; preEvo.status = null;
          toHand.push(preEvo);
          evoName = preEvo.evolvesFrom;
        } else break;
      }

      oppP.hand.push(...toHand);
      addLog(`${name}: ${returnedCard.name} and all attached cards returned to P${opp}'s hand!`, true);

      // Opponent must promote
      const benchLeft = oppP.bench.filter(s => s !== null);
      if (benchLeft.length === 0) {
        G.started = false;
        showWinScreen(player, 'OPPONENT HAS NO POKÉMON LEFT');
        renderAll(); return true;
      } else if (benchLeft.length === 1) {
        const idx = oppP.bench.findIndex(s => s !== null);
        oppP.active = oppP.bench[idx]; oppP.bench[idx] = null;
        addLog(`${oppP.active.name} was automatically promoted to Active.`, true);
      } else {
        // Opponent must choose
        await forceOpponentSwitch(opp, false, `${name} (promote)`);
        // If still no active (edge case), auto-promote first
        if (!G.players[opp].active) {
          const idx = G.players[opp].bench.findIndex(s => s !== null);
          if (idx !== -1) { G.players[opp].active = G.players[opp].bench[idx]; G.players[opp].bench[idx] = null; }
        }
      }
    }
  }

  // ── SPARK / DARK MIND (Pikachu, Gengar, Hypno) — 10 to chosen bench ─────────
  if (/choose 1 of them and this attack does 10 damage to it/i.test(text)) {
    const oppBench = G.players[opp].bench.map((s, i) => ({ s, i })).filter(x => x.s !== null);
    if (oppBench.length) {
      let targetIdx = 0;
      if (oppBench.length > 1) {
        const picked = await openCardPicker({
          title: `${name} — Bench Damage`,
          subtitle: `Choose 1 of P${opp}'s benched Pokémon to deal 10 damage`,
          cards: oppBench.map(x => x.s),
          maxSelect: 1
        });
        if (picked && picked.length) targetIdx = picked[0];
      }
      const { s, i } = oppBench[targetIdx];
      s.damage = (s.damage || 0) + 10;
      addLog(`${name}: dealt 10 damage to P${opp}'s benched ${s.name}! (${s.damage}/${s.hp})`, true);
      const bHp = parseInt(s.hp) || 0;
      if (bHp > 0 && s.damage >= bHp) {
        addLog(`${s.name} was knocked out!`, true);
        G.players[opp].discard.push(s);
        G.players[opp].bench[i] = null;
      }
    }
  }

  // ── STRETCH KICK (Hitmonlee) — 20 to chosen bench ───────────────────────────
  if (/choose 1 of them and this attack does 20 damage to it/i.test(text)) {
    const oppBench = G.players[opp].bench.map((s, i) => ({ s, i })).filter(x => x.s !== null);
    if (!oppBench.length) {
      addLog(`${name}: no opponent bench Pokémon to target.`);
    } else {
      let targetIdx = 0;
      if (oppBench.length > 1) {
        const picked = await openCardPicker({
          title: `${name} — Bench Damage`,
          subtitle: `Choose 1 of P${opp}'s benched Pokémon to deal 20 damage`,
          cards: oppBench.map(x => x.s),
          maxSelect: 1
        });
        if (picked && picked.length) targetIdx = picked[0];
      }
      const { s, i } = oppBench[targetIdx];
      s.damage = (s.damage || 0) + 20;
      addLog(`${name}: dealt 20 damage to P${opp}'s benched ${s.name}! (${s.damage}/${s.hp})`, true);
      const bHp = parseInt(s.hp) || 0;
      if (bHp > 0 && s.damage >= bHp) {
        addLog(`${s.name} was knocked out!`, true);
        G.players[opp].discard.push(s); G.players[opp].bench[i] = null;
      }
    }
  }

  // ── GIGASHOCK (Raichu) — 10 to up to 3 opp bench ───────────────────────────
  if (/choose 3 of your opponent.s bench.*10 damage to each/i.test(text)) {
    const oppBench = G.players[opp].bench.map((s, i) => ({ s, i })).filter(x => x.s !== null);
    if (!oppBench.length) {
      addLog(`${name}: no opponent bench Pokémon to target.`);
    } else {
      let targets = oppBench;
      if (oppBench.length > 3) {
        const picked = await openCardPicker({
          title: `${name} — Choose up to 3`,
          subtitle: `Deal 10 damage to each chosen Pokémon`,
          cards: oppBench.map(x => x.s),
          maxSelect: 3
        });
        if (picked && picked.length) targets = picked.map(pi => oppBench[pi]);
      }
      targets.forEach(({ s, i }) => {
        s.damage = (s.damage || 0) + 10;
        addLog(`${name}: 10 damage to P${opp}'s benched ${s.name}! (${s.damage}/${s.hp})`);
        const bHp = parseInt(s.hp) || 0;
        if (bHp > 0 && s.damage >= bHp) {
          addLog(`${s.name} was knocked out!`, true);
          G.players[opp].discard.push(s); G.players[opp].bench[i] = null;
        }
      });
    }
  }

  // ── CHAIN LIGHTNING (Electrode) — 10 to all bench of same type ──────────────
  if (/if the defending pok.*isn.t colorless.*10 damage to each bench.*of the same type/i.test(text)) {
    const defTypes = (oppActive?.types || []);
    if (!defTypes.length || defTypes.some(t => /colorless/i.test(t))) {
      addLog(`${name}: Defending Pokémon is Colorless — no Chain Lightning splash.`);
    } else {
      const matchType = defTypes[0];
      for (const pNum of [1, 2]) {
        const bench = G.players[pNum].bench;
        bench.forEach((c, i) => {
          if (!c) return;
          const isMatch = (c.types || []).some(t => t.toLowerCase() === matchType.toLowerCase());
          if (isMatch) {
            c.damage = (c.damage || 0) + 10;
            addLog(`${name}: 10 damage to P${pNum}'s ${c.name} (${matchType} type)!`);
            const bHp = parseInt(c.hp) || 0;
            if (bHp > 0 && c.damage >= bHp) {
              addLog(`${c.name} was knocked out!`, true);
              G.players[pNum].discard.push(c); bench[i] = null;
            }
          }
        });
      }
    }
  }

  // ── EARTHQUAKE (Dugtrio) — 10 to each of OWN bench ─────────────────────────
  if (/does 10 damage to each of your own bench/i.test(text)) {
    const myP = G.players[player];
    myP.bench.forEach((c, i) => {
      if (!c) return;
      c.damage = (c.damage || 0) + 10;
      addLog(`${name}: 10 damage to own bench ${c.name}! (${c.damage}/${c.hp})`);
      const bHp = parseInt(c.hp) || 0;
      if (bHp > 0 && c.damage >= bHp) {
        addLog(`${c.name} was knocked out by Earthquake!`, true);
        myP.discard.push(c); myP.bench[i] = null;
      }
    });
  }

  // ── BLIZZARD (Articuno) — coin: heads=10 to opp bench, tails=10 to own bench ─
  if (/flip a coin.*if heads.*10 damage to each of your opponent.s bench/i.test(text)) {
    const heads = await flipCoin(`${name}: Heads = 10 to opp bench | Tails = 10 to your bench`);
    const targetPlayer = heads ? opp : player;
    const bench = G.players[targetPlayer].bench;
    bench.forEach((c, i) => {
      if (!c) return;
      c.damage = (c.damage || 0) + 10;
      addLog(`${name}: 10 damage to P${targetPlayer}'s benched ${c.name}!`);
      const bHp = parseInt(c.hp) || 0;
      if (bHp > 0 && c.damage >= bHp) {
        addLog(`${c.name} was knocked out!`, true);
        G.players[targetPlayer].discard.push(c); bench[i] = null;
      }
    });
    addLog(`${name}: ${heads ? 'HEADS — opponent' : 'TAILS — your own'} bench took 10 damage each!`, true);
  }

  // ── THUNDERSTORM (Zapdos) — flip per opp bench, heads=20 to it; tails=10 to self ──
  if (/for each of your opponent.s bench.*flip a coin.*if heads.*20 damage/i.test(text)) {
    const oppBench = G.players[opp].bench.map((s, i) => ({ s, i })).filter(x => x.s !== null);
    if (!oppBench.length) {
      addLog(`${name}: opponent has no bench Pokémon.`);
    } else {
      let tails = 0;
      for (const { s, i } of oppBench) {
        const heads = await flipCoin(`${name}: Flip for ${s.name} — Heads = 20 damage to it`);
        if (heads) {
          s.damage = (s.damage || 0) + 20;
          addLog(`${name}: HEADS — 20 damage to ${s.name}! (${s.damage}/${s.hp})`);
          const bHp = parseInt(s.hp) || 0;
          if (bHp > 0 && s.damage >= bHp) {
            addLog(`${s.name} was knocked out!`, true);
            G.players[opp].discard.push(s); G.players[opp].bench[i] = null;
          }
        } else {
          tails++;
          addLog(`${name}: TAILS for ${s.name}.`);
        }
      }
      if (tails > 0 && myActive) {
        const selfDmg = tails * 10;
        myActive.damage = (myActive.damage || 0) + selfDmg;
        addLog(`${name}: ${tails} tails — ${myActive.name} takes ${selfDmg} damage! (${myActive.damage}/${myActive.hp})`, true);
        const myHp = parseInt(myActive.hp) || 0;
        if (myHp > 0 && myActive.damage >= myHp) {
          addLog(`${myActive.name} was knocked out by Thunderstorm recoil!`, true);
          G.players[player].discard.push(myActive); G.players[player].active = null;
          // Handle attacker KO
          const myBench = G.players[player].bench.filter(s => s !== null);
          if (!myBench.length) { G.started = false; showWinScreen(opp, 'ZAPDOS KO\'D ITSELF'); renderAll(); return true; }
        }
      }
    }
  }

  // ── BARRIER (Mewtwo) — full protection next turn (energy cost handled in discardCost block) ──
  if (/discard 1 psychic energy.*prevent all effects of attacks.*done to mewtwo during/i.test(text) && myActive) {
    myActive.defender = true;
    myActive.defenderFull = true;
    addLog(`${name}: Mewtwo is fully protected from all attack effects next turn!`, true);
  }

  // ── TAIL WAG / LEER — coin, heads = opp can't attack this Pokémon next turn ──
  if (/flip a coin.*if heads.*the defending pok.*can.t attack/i.test(text) && myActive) {
    const heads = await flipCoin(`${name}: Heads = opponent can't attack next turn!`);
    if (heads) {
      // Store on myActive as a "protected from attack" flag (similar to cantRetreat)
      myActive.immuneToAttack = true;
      addLog(`${name}: HEADS — opponent cannot attack ${myActive.name} next turn!`, true);
    } else {
      addLog(`${name}: TAILS — no effect.`);
    }
  }

  // ── FOUL ODOR (Gloom) — both self and opponent become Confused ───────────────
  if (/both the defending pok.*and gloom are now confused/i.test(text)) {
    if (myActive) { tryApplyStatus(myActive, 'confused'); addLog(`${name}: ${myActive.name} is now Confused!`, true); }
    // oppActive might already be confused from parseStatusEffects; that's fine
  }

  // ── DREAM EATER (Haunter) — guard: can only be used if opp is Asleep ─────────
  // This is enforced in performAttack pre-check (see DREAM_EATER_CHECK)

  // ── TOXIC (Nidoking) — heavy poison (20/turn instead of 10) ──────────────────
  if (/the defending pok.*is now poisoned.*takes 20 poison damage/i.test(text) && oppActive) {
    // Override whatever status was just applied to use the toxic variant
    oppActive.status = 'poisoned-toxic';
    addLog(`${name}: ${oppActive.name} is now Badly Poisoned (20 damage/turn)!`, true);
  }

  // ── CONVERSION 1 (Porygon) — change opp weakness type ───────────────────────
  if (/if the defending pok.*has a weakness.*change it to a type/i.test(text)) {
    const currentOppActive = G.players[opp].active;
    if (!currentOppActive) return;
    if (!(currentOppActive.weaknesses || []).length) {
      addLog(`${name}: ${currentOppActive.name} has no Weakness to change.`);
    } else {
      const chosen = await pickType(`${name} — Choose new Weakness type for ${currentOppActive.name}`);
      if (chosen && chosen !== 'Colorless') {
        currentOppActive.weaknesses = [{ type: chosen, value: '×2' }];
        currentOppActive.conversionWeakness = chosen;
        addLog(`${name}: ${currentOppActive.name}'s Weakness changed to ${chosen}!`, true);
        renderAll();
      }
    }
  }

  // ── CONVERSION 2 (Porygon) — change own resistance type ─────────────────────
  if (/change porygon.s resistance to a type of your choice/i.test(text) && myActive) {
    const chosen = await pickType(`${name} — Choose new Resistance type for ${myActive.name}`);
    if (chosen && chosen !== 'Colorless') {
      myActive.resistances = [{ type: chosen, value: '-30' }];
      myActive.conversionResistance = chosen;
      addLog(`${name}: ${myActive.name}'s Resistance changed to ${chosen}!`, true);
      renderAll();
    }
  }

  // ── SWORDS DANCE (Scyther) — next Slash does 60 instead of 30 ────────────────
  if (/scyther.s slash attack.s base damage is 60 instead of 30/i.test(text) && myActive) {
    myActive.swordsDanceActive = true;
    addLog(`${name}: ${myActive.name}'s next Slash will do 60 damage!`, true);
  }

  // ── METRONOME (Clefairy/Clefable attack, not power) ─────────────────────────
  if (/metronome copies that attack/i.test(text)) {
    const currentOppActive = G.players[opp].active;
    if (!currentOppActive || !(currentOppActive.attacks || []).length) {
      addLog(`${name}: opponent has no attacks to copy!`);
    } else {
      let chosenAtk;
      if (currentOppActive.attacks.length === 1) {
        chosenAtk = currentOppActive.attacks[0];
      } else {
        const picked = await openCardPicker({
          title: `${name} — Copy Attack`,
          subtitle: `Choose an attack from ${currentOppActive.name}`,
          cards: currentOppActive.attacks.map(a => ({ name: a.name, images: currentOppActive.images })),
          maxSelect: 1
        });
        if (picked && picked.length) chosenAtk = currentOppActive.attacks[picked[0]];
      }
      if (chosenAtk) {
        addLog(`${name}: copying ${currentOppActive.name}'s ${chosenAtk.name}!`, true);
        // Execute the copied attack — pass it through performAttack logic
        // We call applyMoveEffects recursively with the copied attack and
        // recalculate its damage inline.
        const copiedDmg = await resolveCopiedAttackDamage(player, chosenAtk, myActive, currentOppActive);
        if (copiedDmg > 0) {
          const currentOpp = G.players[opp].active;
          if (currentOpp) {
            currentOpp.damage = (currentOpp.damage || 0) + copiedDmg;
            addLog(`${name} (${chosenAtk.name}): ${copiedDmg} damage to ${currentOpp.name}!`, true);
            const koResult = checkKO(player, opp, currentOpp, false);
            if (koResult === 'win') { renderAll(); return true; }
            if (koResult === 'promote') { renderAll(); return false; }
          }
        }
        // Apply the copied attack's non-damage effects
        const currentOppNew = G.players[opp].active;
        await applyMoveEffects(player, chosenAtk, copiedDmg, myActive, currentOppNew);
      }
    }
  }

  // ── MIRROR MOVE (Pidgeotto/Spearow) ─────────────────────────────────────────
  if (/if.*was attacked last turn.*do the final result of that attack/i.test(text)) {
    const lastAtk = G.lastAttackOnPlayer?.[player];
    if (!lastAtk) {
      addLog(`${name}: ${myActive?.name} was not attacked last turn — no effect.`);
    } else {
      addLog(`${name}: reflecting ${lastAtk.attackName} back!`, true);
      const mirrorDmg = lastAtk.damage || 0;
      if (mirrorDmg > 0) {
        const currentOpp = G.players[opp].active;
        if (currentOpp) {
          currentOpp.damage = (currentOpp.damage || 0) + mirrorDmg;
          addLog(`Mirror Move: ${mirrorDmg} damage to ${currentOpp.name}!`, true);
          const koResult = checkKO(player, opp, currentOpp, false);
          if (koResult === 'win') { renderAll(); return true; }
        }
      }
    }
  }

  // ── DESTINY BOND (Gastly) — mark self; if KO'd next turn, KO attacker ────────
  if (/if a pok.*knocks out gastly during your opponent.s next turn.*knock out that pok/i.test(text) && myActive) {
    myActive.destinyBond = true;
    addLog(`${name}: ${myActive.name} is ready to take its attacker down with it!`, true);
  }

  // ── POUNCE (Persian) — if attacked next turn, reduce that damage by 10 ───────
  if (/if the defending pok.*attacks persian.*(?:any )?damage done.*is reduced by 10/i.test(text) && myActive) {
    myActive.pounceActive = true;
    addLog(`${name}: ${myActive.name} is poised — incoming attack next turn does 10 less damage!`, true);
  }

  // ── WHIRLPOOL / HYPER BEAM — discard 1 energy from opponent ─────────────────
  if (/if the defending pok.*has any energy.*choose 1 of them and discard it/i.test(text)) {
    const currentOpp = G.players[opp].active;
    if (currentOpp && (currentOpp.attachedEnergy || []).length > 0) {
      let discardIdx = 0;
      if (currentOpp.attachedEnergy.length > 1) {
        const picked = await openCardPicker({
          title: `${name} — Discard Energy`,
          subtitle: `Choose 1 energy to discard from ${currentOpp.name}`,
          cards: currentOpp.attachedEnergy,
          maxSelect: 1
        });
        if (picked && picked.length) discardIdx = picked[0];
      }
      const discarded = currentOpp.attachedEnergy.splice(discardIdx, 1)[0];
      G.players[opp].discard.push(discarded);
      addLog(`${name}: discarded ${discarded.name} from ${currentOpp.name}!`, true);
    } else {
      addLog(`${name}: ${currentOpp?.name || 'opponent'} has no energy to discard.`);
    }
  }

  // ── ENERGY CONVERSION (Gastly) — take up to 2 energy from own discard ────────
  if (/put up to 2 energy cards from your discard pile into your hand.*gastly does 10 damage to itself/i.test(text)) {
    const myP = G.players[player];
    const energyInDiscard = myP.discard.filter(c => c.supertype === 'Energy');
    if (!energyInDiscard.length) {
      addLog(`${name}: no energy in discard pile.`);
    } else {
      const n = Math.min(2, energyInDiscard.length);
      const picked = await openCardPicker({
        title: `${name} — Retrieve Energy`,
        subtitle: `Choose up to 2 energy cards from your discard pile`,
        cards: energyInDiscard,
        maxSelect: 2
      });
      if (picked && picked.length) {
        picked.forEach(pi => {
          const card = energyInDiscard[pi];
          const di = myP.discard.findIndex(c => c === card);
          if (di !== -1) myP.hand.push(...myP.discard.splice(di, 1));
        });
        addLog(`${name}: retrieved ${picked.length} energy card(s) to hand.`, true);
      }
    }
    // Self-damage is handled in the self-recoil section of performAttack
  }

  // ── WILDFIRE (Moltres) — discard own fire energy, mill opponent's deck ────────
  if (/discard any number of fire energy.*discard that many cards from the top/i.test(text) && myActive) {
    const myP = G.players[player];
    const fireEnergy = (myActive.attachedEnergy || []).filter(e => /fire/i.test(e.name));
    if (!fireEnergy.length) {
      addLog(`${name}: no Fire Energy attached to discard.`);
    } else {
      const picked = await openCardPicker({
        title: `${name} — Choose Fire Energy to Discard`,
        subtitle: `Each discarded energy mills 1 card from opponent's deck`,
        cards: fireEnergy,
        maxSelect: fireEnergy.length
      });
      if (picked && picked.length) {
        // Discard the selected fire energy from myActive
        picked.sort((a, b) => b - a).forEach(pi => {
          const card = fireEnergy[pi];
          const ei = myActive.attachedEnergy.findIndex(e => e === card);
          if (ei !== -1) {
            const removed = myActive.attachedEnergy.splice(ei, 1)[0];
            myP.discard.push(removed);
          }
        });
        // Mill that many cards from opponent's deck
        const millCount = picked.length;
        const oppP = G.players[opp];
        const milled = oppP.deck.splice(0, millCount);
        oppP.discard.push(...milled);
        addLog(`${name}: discarded ${millCount} Fire Energy — milled ${milled.length} card(s) from P${opp}'s deck!`, true);
        if (!oppP.deck.length) {
          addLog(`P${opp}'s deck is empty — they lose!`, true);
          G.started = false;
          showWinScreen(player, "OPPONENT'S DECK EMPTY");
          renderAll(); return true;
        }
      }
    }
  }

  // ── HEADACHE (Psyduck) — opponent can't play Trainer cards next turn ──────────
  if (/your opponent can.t play trainer cards/i.test(text)) {
    G.players[opp].trainerBlocked = true;
    addLog(`${name}: P${opp} cannot play Trainer cards next turn!`, true);
  }

  // ── PROPHECY (Hypno) — look at top 3 of either deck, rearrange ───────────────
  if (/look at up to 3 cards from the top of either player.s deck.*rearrange/i.test(text)) {
    // Player chooses whose deck
    const deckChoice = await new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:900;
        display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;`;
      overlay.innerHTML = `
        <div style="font-family:var(--font);font-size:10px;color:var(--accent)">Prophecy — Choose Deck</div>
        <div style="display:flex;gap:12px;">
          <button onclick="this.closest('div[style]').remove();window._prophecyChoice=${player}"
            style="font-family:var(--font);font-size:9px;padding:10px 18px;background:var(--surface2);
            border:1px solid var(--p1color);color:var(--p1color);cursor:pointer;border-radius:4px;">Your Deck (P${player})</button>
          <button onclick="this.closest('div[style]').remove();window._prophecyChoice=${opp}"
            style="font-family:var(--font);font-size:9px;padding:10px 18px;background:var(--surface2);
            border:1px solid var(--p2color);color:var(--p2color);cursor:pointer;border-radius:4px;">Opponent's Deck (P${opp})</button>
        </div>`;
      document.body.appendChild(overlay);
      const check = setInterval(() => {
        if (window._prophecyChoice !== undefined) {
          clearInterval(check);
          const v = window._prophecyChoice;
          window._prophecyChoice = undefined;
          resolve(v);
        }
      }, 100);
    });
    await prophecyModal(player, deckChoice, 3);
  }

  // ── SCAVENGE (Slowpoke) — retrieve Trainer from own discard ──────────────────
  if (/put a trainer card from your discard pile into your hand/i.test(text)) {
    const myP = G.players[player];
    const trainers = myP.discard.filter(c => c.supertype === 'Trainer');
    if (!trainers.length) {
      addLog(`${name}: no Trainer cards in discard pile.`);
    } else {
      const picked = await openCardPicker({
        title: `${name} — Retrieve Trainer`,
        subtitle: 'Choose a Trainer card to put in your hand',
        cards: trainers,
        maxSelect: 1
      });
      if (picked && picked.length) {
        const card = trainers[picked[0]];
        const di = myP.discard.findIndex(c => c === card);
        if (di !== -1) myP.hand.push(...myP.discard.splice(di, 1));
        addLog(`${name}: retrieved ${card.name} to hand.`, true);
      }
    }
  }

  // ── CALL FOR FAMILY (Bellsprout/Nidoran/Oddish/Krabby) ───────────────────────
  // Search deck for specific named basic Pokémon, put on bench
  if (/search your deck for a basic pok.*named.*put it onto your bench/i.test(text)) {
    const myP = G.players[player];
    const freeSlot = myP.bench.findIndex(s => s === null);
    if (freeSlot === -1) {
      addLog(`${name}: bench is full!`);
    } else {
      // Extract the target name(s) from the text
      const nameMatch = text.match(/named\s+([^.]+?)(?:\s+or\s+([^.]+?))?\s*(?:and put|put)/i);
      let candidates = [];
      if (nameMatch) {
        const n1 = nameMatch[1].trim();
        const n2 = nameMatch[2]?.trim();
        candidates = myP.deck.filter(c =>
          c.supertype === 'Pokémon' &&
          (c.name === n1 || (n2 && c.name === n2))
        );
      }
      if (!candidates.length) {
        addLog(`${name}: no matching Basic Pokémon in deck.`);
      } else {
        const chosen = candidates[0]; // auto-take first match
        const di = myP.deck.findIndex(c => c === chosen);
        if (di !== -1) {
          chosen.damage = 0; chosen.attachedEnergy = []; chosen.status = null;
          myP.bench[freeSlot] = chosen;
          myP.deck.splice(di, 1);
          myP.deck = shuffle(myP.deck);
          addLog(`${name}: ${chosen.name} moved from deck to bench!`, true);
        }
      }
    }
  }

  // ── CALL FOR FRIEND (Marowak) — any Fighting Basic ───────────────────────────
  if (/search your deck for a fighting basic pok.*put it onto your bench/i.test(text)) {
    const myP = G.players[player];
    const freeSlot = myP.bench.findIndex(s => s === null);
    if (freeSlot === -1) {
      addLog(`${name}: bench is full!`);
    } else {
      const candidates = myP.deck.filter(c =>
        c.supertype === 'Pokémon' &&
        !(c.subtypes || []).some(s => ['Stage 1','Stage 2'].includes(s)) &&
        (c.types || []).some(t => /fighting/i.test(t))
      );
      if (!candidates.length) {
        addLog(`${name}: no Fighting Basic Pokémon in deck.`);
      } else {
        let chosen;
        if (candidates.length === 1) {
          chosen = candidates[0];
        } else {
          const picked = await openCardPicker({
            title: `${name} — Call for Friend`,
            subtitle: 'Choose a Fighting Basic Pokémon to bench',
            cards: candidates,
            maxSelect: 1
          });
          if (picked && picked.length) chosen = candidates[picked[0]];
        }
        if (chosen) {
          const di = myP.deck.findIndex(c => c === chosen);
          if (di !== -1) {
            chosen.damage = 0; chosen.attachedEnergy = []; chosen.status = null;
            myP.bench[freeSlot] = chosen;
            myP.deck.splice(di, 1);
            myP.deck = shuffle(myP.deck);
            addLog(`${name}: ${chosen.name} moved from deck to bench!`, true);
          }
        }
      }
    }
  }

  renderAll();
}

// ─────────────────────────────────────────────────────────────────────────────
// METRONOME helper — compute damage for a copied attack (no energy discard)
// ─────────────────────────────────────────────────────────────────────────────
async function resolveCopiedAttackDamage(player, atk, myActive, oppActive) {
  const opp = player === 1 ? 2 : 1;
  const energyCount = (myActive?.attachedEnergy || []).length;
  const coinDmg = await resolveCoinFlipDamage(atk, energyCount, myActive, player);
  let dmg = coinDmg !== null ? coinDmg : (parseInt((atk.damage || '0').replace(/[^0-9]/g,'')) || 0);

  // Scaling: damage counters on defender (Meditate, Rage, etc.)
  if (/plus 10 more damage for each damage counter on the defending/i.test(atk.text || '')) {
    const counters = Math.floor((oppActive?.damage || 0) / 10);
    dmg += counters * 10;
  }
  // Scaling: counters on self (Flail, Rage self)
  if (/10 damage times the number of damage counters on/i.test(atk.text || '')) {
    const counters = Math.floor((myActive?.damage || 0) / 10);
    dmg = counters * 10;
  }

  // Apply W/R
  const attackerTypes = myActive?.types || [];
  for (const w of (oppActive?.weaknesses || [])) {
    if (attackerTypes.some(t => t.toLowerCase() === w.type.toLowerCase())) { dmg *= 2; break; }
  }
  for (const r of (oppActive?.resistances || [])) {
    if (attackerTypes.some(t => t.toLowerCase() === r.type.toLowerCase())) { dmg = Math.max(0, dmg - 30); break; }
  }
  return dmg;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRE-ATTACK HOOKS — call these at the START of performAttack, before damage
// Returns 'block' if the attack should be cancelled entirely, otherwise null.
// ─────────────────────────────────────────────────────────────────────────────
async function preAttackChecks(player, atk, myActive, oppActive) {
  const text = atk.text || '';
  const name = atk.name || '';

  // ── DREAM EATER — only usable if opponent is Asleep ──────────────────────────
  if (/you can.t use this attack unless the defending pok.*is asleep/i.test(text)) {
    if (oppActive?.status !== 'asleep') {
      showToast(`${name} can only be used when opponent is Asleep!`, true);
      addLog(`${name}: ${oppActive?.name || 'opponent'} is not Asleep — attack failed!`, true);
      return 'block';
    }
  }

  // ── LEEK SLAP — can only be used once per time Farfetch'd is in play ─────────
  if (/can.t use this attack again as long as/i.test(text)) {
    if (myActive.leekSlapUsed) {
      showToast(`${name} can only be used once while ${myActive.name} is in play!`, true);
      addLog(`${name}: already used — cannot be used again!`, true);
      return 'block';
    }
  }

  // ── SMOKESCREEN CHECK on attacker ────────────────────────────────────────────
  if (myActive?.smokescreened) {
    addLog(`${myActive.name} is Smokescreened — flipping coin to attack...`);
    const heads = await flipCoin(`${myActive.name} is Smokescreened!\nHeads = attack lands, Tails = attack fails`);
    if (!heads) {
      addLog(`${name}: TAILS — Smokescreen caused the attack to fail!`, true);
      return 'block';
    }
    addLog(`${name}: HEADS — attack gets through Smokescreen!`);
  }

  // ── TAIL WAG / LEER immunity check ───────────────────────────────────────────
  if (oppActive?.immuneToAttack) {
    addLog(`${oppActive.name} is protected — ${myActive?.name}'s attack is blocked!`, true);
    showToast(`${oppActive.name} can't be attacked this turn!`, true);
    return 'block';
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRE-DAMAGE HOOKS — modify the base damage before it's applied
// Returns the modified damage value.
// ─────────────────────────────────────────────────────────────────────────────
function preDamageModify(player, atk, baseDmg, myActive, oppActive) {
  const text = atk.text || '';
  const opp = player === 1 ? 2 : 1;
  let dmg = baseDmg;

  // ── SONICBOOM — skip W/R (flag on atk object for performAttack to read) ──────
  if (/don.t apply weakness and resistance for this attack/i.test(text)) {
    atk._skipWR = true;
  }

  // ── KARATE CHOP — 50 minus 10 per damage counter on self ─────────────────────
  if (/does 50 damage minus 10 damage for each damage counter on/i.test(text)) {
    const counters = Math.floor((myActive?.damage || 0) / 10);
    dmg = Math.max(0, 50 - counters * 10);
  }

  // ── FLAIL (Magikarp/Kingler) — 10 × own damage counters ─────────────────────
  if (/does 10 damage times the number of damage counters on/i.test(text)) {
    const counters = Math.floor((myActive?.damage || 0) / 10);
    dmg = counters * 10;
  }

  // ── RAGE / DODRIO / CUBONE — 10 + 10 per own counter ────────────────────────
  if (/does 10 damage plus 10 more damage for each damage counter on(?! the defending)/i.test(text)) {
    const counters = Math.floor((myActive?.damage || 0) / 10);
    dmg = 10 + counters * 10;
  }

  // ── RAMPAGE (Tauros) — 20 + 10 per own counter ───────────────────────────────
  if (/does 20 damage plus 10 more damage for each damage counter on tauros/i.test(text)) {
    const counters = Math.floor((myActive?.damage || 0) / 10);
    dmg = 20 + counters * 10;
  }

  // ── MEDITATE (Jynx/Mr. Mime) — 10/20 + 10 per defender counter ───────────────
  if (/plus 10 more damage for each damage counter on the defending/i.test(text)) {
    const counters = Math.floor((oppActive?.damage || 0) / 10);
    const base = parseInt((atk.damage || '0').replace(/[^0-9]/g,'')) || 0;
    dmg = base + counters * 10;
  }

  // ── SUPER FANG (Raticate) — half remaining HP ─────────────────────────────────
  if (/equal to half the defending pok.*remaining hp/i.test(text) && oppActive) {
    const hp = parseInt(oppActive.hp) || 0;
    const remaining = Math.max(0, hp - (oppActive.damage || 0));
    dmg = roundUp10(remaining / 2);
  }

  // ── BOYFRIENDS (Nidoqueen) — 20 + 20 per Nidoking on own bench/active ────────
  if (/plus 20 more damage for each nidoking/i.test(text)) {
    const myP = G.players[player];
    const allMine = [myP.active, ...myP.bench].filter(Boolean);
    const nidokings = allMine.filter(c => c.name === 'Nidoking' && c !== myActive).length;
    dmg = 20 + nidokings * 20;
  }

  // ── DO THE WAVE (Wigglytuff) — 10 + 10 per own bench Pokémon ─────────────────
  if (/plus 10 more damage for each of your bench/i.test(text)) {
    const bench = G.players[player].bench.filter(Boolean).length;
    dmg = 10 + bench * 10;
  }

  // ── SWORDS DANCE boost (Scyther's Slash) ─────────────────────────────────────
  if (atk.name === 'Slash' && myActive?.swordsDanceActive) {
    dmg = 60;
    myActive.swordsDanceActive = false;
    addLog(`Swords Dance: Slash boosted to 60 damage!`, true);
  }

  // ── POUNCE (Persian) incoming damage reduction on attacker ───────────────────
  // (Applied in performAttack's damage pipeline on the defender side)

  return dmg;
}

// ─────────────────────────────────────────────────────────────────────────────
// BETWEEN-TURN CLEANUP — call from endTurn() for new-turn state resets
// ─────────────────────────────────────────────────────────────────────────────
function endTurnEffectsCleanup(prevPlayer, newPlayer) {
  // Clear Tail Wag / Leer immunity on the player who just defended
  // (it only lasts one attack turn — cleared when the prev attacker's turn ends)
  const prevOppActive = G.players[prevPlayer].active;
  if (prevOppActive?.immuneToAttack) {
    prevOppActive.immuneToAttack = false;
  }

  // Clear pounce (Persian) — lasts one turn
  for (const pNum of [1, 2]) {
    const a = G.players[pNum].active;
    if (a?.pounceActive) a.pounceActive = false;
  }

  // Clear Headache (Psyduck) — clear trainer block after the opponent's turn
  // newPlayer is the one who was blocked; their turn starts now, unblock them
  if (G.players[newPlayer].trainerBlocked) {
    G.players[newPlayer].trainerBlocked = false;
    addLog(`P${newPlayer} can play Trainer cards again.`);
  }

  // Clear conversionWeakness / conversionResistance? (These persist — they're permanent changes)
  // Nothing to clear.
}

// ─────────────────────────────────────────────────────────────────────────────
// DESTINY BOND — check if a KO'd defender had Destiny Bond active
// Call from checkKO after a pokemon is confirmed KO'd.
// ─────────────────────────────────────────────────────────────────────────────
function checkDestinyBond(koedCard, attackingPlayer) {
  if (!koedCard?.destinyBond) return;
  const attacker = G.players[attackingPlayer].active;
  if (!attacker) return;
  addLog(`Destiny Bond! ${attacker.name} is also knocked out!`, true);
  attacker.damage = parseInt(attacker.hp) || 999; // force KO
  G.players[attackingPlayer].discard.push(attacker);
  G.players[attackingPlayer].active = null;
  koedCard.destinyBond = false;

  // Award prize to defending player for the attacker KO
  const defPlayer = attackingPlayer === 1 ? 2 : 1;
  const prizeIdx = G.players[defPlayer].prizes.findIndex(p => p);
  if (prizeIdx !== -1) {
    const prizeCard = G.players[defPlayer].prizes[prizeIdx];
    G.players[defPlayer].hand.push(prizeCard.card);
    G.players[defPlayer].prizes[prizeIdx] = null;
    const remaining = G.players[defPlayer].prizes.filter(p => p).length;
    addLog(`P${defPlayer} took a prize from Destiny Bond KO! (${remaining} remaining)`, true);
    if (remaining === 0) {
      G.started = false;
      showWinScreen(defPlayer, 'ALL 6 PRIZES TAKEN');
      return;
    }
  }

  // Handle attacker needing promotion
  const myBench = G.players[attackingPlayer].bench.filter(s => s !== null);
  if (!myBench.length) {
    G.started = false;
    showWinScreen(defPlayer, 'DESTINY BOND — ATTACKER HAS NO POKÉMON LEFT');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LAST ATTACK TRACKING — for Mirror Move
// Call from performAttack after damage is resolved, passing what was done.
// ─────────────────────────────────────────────────────────────────────────────
function recordLastAttack(attackingPlayer, atkName, dmgDealt) {
  if (!G.lastAttackOnPlayer) G.lastAttackOnPlayer = {};
  const defendingPlayer = attackingPlayer === 1 ? 2 : 1;
  G.lastAttackOnPlayer[defendingPlayer] = { attackName: atkName, damage: dmgDealt };
}

// Clear Mirror Move history on retreat or KO (the pokemon that was attacked changed)
function clearLastAttack(playerWhoseActiveChanged) {
  if (!G.lastAttackOnPlayer) return;
  G.lastAttackOnPlayer[playerWhoseActiveChanged] = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// BADGE RENDERING helpers — for Conversion 1/2 type indicators
// Returns extra badge HTML to inject into card-badges for a given card.
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// TRAINER BLOCK — guard to call inside Trainer card handler
// ─────────────────────────────────────────────────────────────────────────────
function isTrainerBlocked(player) {
  return !!G.players[player].trainerBlocked;
}
