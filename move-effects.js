// ══════════════════════════════════════════════════════════════════════════════
// MOVE-EFFECTS.JS — Name-keyed dispatch table for Pokémon TCG special attacks
//
// Each entry in MOVE_EFFECTS maps an attack name (exactly as in cards.json) to
// an object with up to three optional hooks:
//
//   preAttack(ctx)      — runs BEFORE damage. Return 'block' to cancel attack.
//   modifyDamage(ctx)   — runs AFTER coin-flip damage, BEFORE W/R. Return new dmg.
//   postAttack(ctx)     — runs AFTER damage + KO check. Return true to skip endTurn.
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
  postAttack: async ({ oppActive, atk }) => {
    if (!oppActive) return;
    tryApplyStatus(oppActive, status);
    addLog(`${atk.name}: ${oppActive.name} is now ${status}!`, true);
  }
});

// Flip → heads = status on opponent
const _statusOppFlip = (status) => ({
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
      myActive.defender = true; myActive.defenderFull = true;
      addLog(`${atk.name}: HEADS — ${myActive.name} fully protected next turn!`, true);
    } else {
      addLog(`${atk.name}: TAILS — no protection.`);
    }
  }
});

// Choose 1 opp bench → 10 damage to it (Spark/Dark Mind style)
const _benchDamage10 = () => ({
  postAttack: async ({ opp, atk }) => {
    const bench = G.players[opp].bench.map((s, i) => ({ s, i })).filter(x => x.s !== null);
    if (!bench.length) return;
    let target = bench[0];
    if (bench.length > 1) {
      const picked = await openCardPicker({
        title: `${atk.name} — Bench Damage`,
        subtitle: `Choose 1 of opponent's Benched Pokémon for 10 damage`,
        cards: bench.map(x => x.s), maxSelect: 1
      });
      if (picked && picked.length) target = bench[picked[0]];
    }
    target.s.damage = (target.s.damage || 0) + 10;
    addLog(`${atk.name}: 10 damage to ${target.s.name}! (${target.s.damage}/${target.s.hp})`, true);
    const hp = parseInt(target.s.hp) || 0;
    if (hp > 0 && target.s.damage >= hp) {
      addLog(`${target.s.name} was knocked out!`, true);
      G.players[opp].discard.push(target.s); G.players[opp].bench[target.i] = null;
    }
    renderAll();
  }
});

// Choose 1 opp bench → 20 damage to it (Stretch Kick style)
const _benchDamage20 = () => ({
  postAttack: async ({ opp, atk }) => {
    const bench = G.players[opp].bench.map((s, i) => ({ s, i })).filter(x => x.s !== null);
    if (!bench.length) { addLog(`${atk.name}: no opponent bench to target.`); return; }
    let target = bench[0];
    if (bench.length > 1) {
      const picked = await openCardPicker({
        title: `${atk.name} — Bench Damage`,
        subtitle: `Choose 1 of opponent's Benched Pokémon for 20 damage`,
        cards: bench.map(x => x.s), maxSelect: 1
      });
      if (picked && picked.length) target = bench[picked[0]];
    }
    target.s.damage = (target.s.damage || 0) + 20;
    addLog(`${atk.name}: 20 damage to ${target.s.name}! (${target.s.damage}/${target.s.hp})`, true);
    const hp = parseInt(target.s.hp) || 0;
    if (hp > 0 && target.s.damage >= hp) {
      addLog(`${target.s.name} was knocked out!`, true);
      G.players[opp].discard.push(target.s); G.players[opp].bench[target.i] = null;
    }
    renderAll();
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
  postAttack: async ({ opp, oppActive, atk }) => {
    // oppActive is the snapshot passed from performAttack. Fall back to current
    // active only if the snapshot is somehow missing.
    const target = oppActive || G.players[opp].active;
    if (!target || !(target.attachedEnergy || []).length) {
      addLog(`${atk.name}: opponent has no energy to discard.`); return;
    }
    let idx = 0;
    if (target.attachedEnergy.length > 1) {
      const picked = await openCardPicker({
        title: `${atk.name} — Discard Energy`,
        subtitle: `Choose 1 energy to discard from ${target.name}`,
        cards: target.attachedEnergy, maxSelect: 1
      });
      if (picked && picked.length) idx = picked[0];
    }
    const removed = target.attachedEnergy.splice(idx, 1)[0];
    G.players[opp].discard.push(removed);
    addLog(`${atk.name}: discarded ${removed.name} from ${target.name}!`, true);
    renderAll();
  }
});

// Smokescreen / Sand-attack: opponent must flip to attack next turn (tails = does nothing)
const _smokescreen = () => ({
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
const _callForFamily = (targetName) => ({
  postAttack: async ({ player, atk }) => {
    const myP = G.players[player];
    const slot = myP.bench.findIndex(s => s === null);
    if (slot === -1) { addLog(`${atk.name}: bench is full!`); return; }
    const names = Array.isArray(targetName) ? targetName : [targetName];
    const candidates = myP.deck.filter(c =>
      c.supertype === 'Pokémon' && c.subtypes?.includes('Basic') && names.some(n => c.name === n)
    );
    if (!candidates.length) { addLog(`${atk.name}: no matching Basic in deck.`); return; }
    const chosen = candidates[0];
    const di = myP.deck.findIndex(c => c === chosen);
    if (di !== -1) {
      chosen.damage = 0; chosen.attachedEnergy = []; chosen.status = null;
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
    oppP.active = entry.s; oppP.bench[idx] = old;
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

  // Absorb (Kabutops): drain half damage dealt
  'Absorb': _drain(0.5),

  // Acid (Victreebel): flip — heads = can't retreat next turn
  'Acid': {
    postAttack: async ({ oppActive, atk }) => {
      if (!oppActive) return;
      const heads = await flipCoin(`${atk.name}: Heads = ${oppActive.name} can't retreat next turn!`);
      if (heads) { oppActive.cantRetreat = true; addLog(`${atk.name}: HEADS — ${oppActive.name} can't retreat!`, true); }
      else addLog(`${atk.name}: TAILS — no effect.`);
    }
  },

  // Agility (Raichu/Fearow/Rapidash/Seadra): flip → immune to all attack effects
  'Agility': _agilityFlip(),

  // Amnesia (Poliwhirl): choose 1 of opp's attacks — disable it next turn
  'Amnesia': {
    postAttack: async ({ oppActive, atk }) => {
      if (!oppActive?.attacks?.length) return;
      let atkName;
      if (oppActive.attacks.length === 1) {
        atkName = oppActive.attacks[0].name;
      } else {
        const picked = await openCardPicker({
          title: `${atk.name} — Disable Attack`,
          subtitle: `Choose an attack to disable on ${oppActive.name}`,
          cards: oppActive.attacks.map(a => ({ name: a.name, images: oppActive.images })),
          maxSelect: 1
        });
        if (picked && picked.length) atkName = oppActive.attacks[picked[0]].name;
      }
      if (atkName) { oppActive.disabledAttack = atkName; addLog(`${atk.name}: ${oppActive.name}'s ${atkName} disabled next turn!`, true); }
    }
  },

  // Barrier (Mewtwo): full protection next turn (energy discard handled elsewhere)
  'Barrier': {
    postAttack: async ({ myActive, atk }) => {
      if (!myActive) return;
      myActive.defender = true; myActive.defenderFull = true;
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
  'Clamp': {
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
  'Irongrip':    _statusOppFlip('paralyzed'),
  'Lick':        _statusOppFlip('paralyzed'),
  'Nasty Goo':   _statusOppFlip('paralyzed'),
  'Psyshock':    _statusOppFlip('paralyzed'),
  'Star Freeze': _statusOppFlip('paralyzed'),
  'String Shot': _statusOppFlip('paralyzed'),
  'Stun Spore':  _statusOppFlip('paralyzed'),
  'Thunder Wave':_statusOppFlip('paralyzed'),
  'Tongue Wrap': _statusOppFlip('paralyzed'),
  'Wrap':        _statusOppFlip('paralyzed'),

  // Blizzard (Articuno): flip — heads=10 to opp bench, tails=10 to own bench
  'Blizzard': {
    postAttack: async ({ player, opp, atk }) => {
      const heads = await flipCoin(`${atk.name}: Heads=10 to opp bench | Tails=10 to your bench`);
      const target = heads ? opp : player;
      G.players[target].bench.forEach((c, i) => {
        if (!c) return;
        c.damage = (c.damage || 0) + 10;
        addLog(`${atk.name}: 10 damage to P${target}'s ${c.name}! (${c.damage}/${c.hp})`);
        const hp = parseInt(c.hp) || 0;
        if (hp > 0 && c.damage >= hp) {
          addLog(`${c.name} knocked out!`, true);
          G.players[target].discard.push(c); G.players[target].bench[i] = null;
        }
      });
      addLog(`${atk.name}: ${heads ? "HEADS — opp" : "TAILS — own"} bench took 10 each!`, true);
      renderAll();
    }
  },

  // Call for Family (Bellsprout/Nidoran♀/Krabby): search deck for named Basic
  'Call for Family': _callForFamily(['Bellsprout', 'Nidoran ♀', 'Krabby']),

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
        chosen.damage = 0; chosen.attachedEnergy = []; chosen.status = null;
        myP.bench[slot] = myP.deck.splice(di, 1)[0];
        myP.deck = shuffle(myP.deck);
        addLog(`${atk.name}: ${chosen.name} placed on bench!`, true);
        renderAll();
      }
    }
  },

  // Chain Lightning (Electrode): 10 to all bench of same type as defender
  'Chain Lightning': {
    postAttack: async ({ oppActive, atk }) => {
      const defTypes = (oppActive?.types || []);
      if (!defTypes.length || defTypes.some(t => /colorless/i.test(t))) {
        addLog(`${atk.name}: Defending Pokémon is Colorless — no splash.`); return;
      }
      const matchType = defTypes[0];
      for (const pNum of [1, 2]) {
        G.players[pNum].bench.forEach((c, i) => {
          if (!c) return;
          if ((c.types || []).some(t => t.toLowerCase() === matchType.toLowerCase())) {
            c.damage = (c.damage || 0) + 10;
            addLog(`${atk.name}: 10 to P${pNum}'s ${c.name} (${matchType})!`);
            const hp = parseInt(c.hp) || 0;
            if (hp > 0 && c.damage >= hp) {
              addLog(`${c.name} knocked out!`, true);
              G.players[pNum].discard.push(c); G.players[pNum].bench[i] = null;
            }
          }
        });
      }
      renderAll();
    }
  },

  // Confuse Ray (Alakazam/Drowzee/Vulpix/Lapras): flip → confused
  'Confuse Ray': _statusOppFlip('confused'),

  // Conversion 1 (Porygon): change opp's weakness type — preAttack so cancel blocks the turn
  'Conversion 1': {
    preAttack: async ({ opp, atk }) => {
      const oppActive = G.players[opp].active;
      if (!oppActive) return 'block';
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
        G.players[opp].discard.push(target);
        G.players[opp].bench[slotIdx] = null;
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
      if (oppActive?.status !== 'asleep') {
        showToast(`${atk.name}: opponent must be Asleep!`, true);
        addLog(`${atk.name}: ${oppActive?.name} is not Asleep — failed!`, true);
        return 'block';
      }
    }
  },

  // Earthquake (Dugtrio): 10 to each of own bench
  'Earthquake': {
    postAttack: async ({ player, atk }) => {
      G.players[player].bench.forEach((c, i) => {
        if (!c) return;
        c.damage = (c.damage || 0) + 10;
        addLog(`${atk.name}: 10 to own ${c.name}! (${c.damage}/${c.hp})`);
        const hp = parseInt(c.hp) || 0;
        if (hp > 0 && c.damage >= hp) { addLog(`${c.name} knocked out!`, true); G.players[player].discard.push(c); G.players[player].bench[i] = null; }
      });
      renderAll();
    }
  },

  // Energy Conversion (Gastly): retrieve up to 2 energy from own discard
  'Energy Conversion': {
    postAttack: async ({ player, atk }) => {
      const myP = G.players[player];
      const energy = myP.discard.filter(c => c.supertype === 'Energy');
      if (!energy.length) { addLog(`${atk.name}: no energy in discard.`); return; }
      const picked = await openCardPicker({ title: `${atk.name}`, subtitle: 'Choose up to 2 energy from your discard', cards: energy, maxSelect: 2 });
      if (picked && picked.length) {
        picked.forEach(pi => { const di = myP.discard.findIndex(c => c === energy[pi]); if (di !== -1) myP.hand.push(...myP.discard.splice(di, 1)); });
        addLog(`${atk.name}: retrieved ${picked.length} energy to hand.`, true);
        renderAll();
      }
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
    postAttack: async ({ oppActive, atk }) => {
      if (!oppActive) return;
      const heads = await flipCoin(`${atk.name}: Heads=Poisoned | Tails=Confused`);
      const status = heads ? 'poisoned' : 'confused';
      tryApplyStatus(oppActive, status);
      addLog(`${atk.name}: ${heads ? 'HEADS' : 'TAILS'} — ${oppActive.name} is now ${status}!`, true);
    }
  },

  // Foul Odor (Gloom): both self and opp Confused
  'Foul Odor': {
    postAttack: async ({ myActive, oppActive, atk }) => {
      if (myActive)  { tryApplyStatus(myActive, 'confused');  addLog(`${atk.name}: ${myActive.name} is now Confused!`, true); }
      if (oppActive) { tryApplyStatus(oppActive, 'confused'); addLog(`${atk.name}: ${oppActive.name} is now Confused!`, true); }
    }
  },

  // Gigashock (Raichu): 10 to up to 3 opp bench
  'Gigashock': {
    postAttack: async ({ opp, atk }) => {
      const bench = G.players[opp].bench.map((s, i) => ({ s, i })).filter(x => x.s !== null);
      if (!bench.length) { addLog(`${atk.name}: no bench to target.`); return; }
      let targets = bench;
      if (bench.length > 3) {
        const picked = await openCardPicker({ title: `${atk.name}`, subtitle: 'Choose up to 3 Benched Pokémon (10 each)', cards: bench.map(x => x.s), maxSelect: 3 });
        if (picked && picked.length) targets = picked.map(pi => bench[pi]);
      }
      targets.forEach(({ s, i }) => {
        s.damage = (s.damage || 0) + 10;
        addLog(`${atk.name}: 10 to ${s.name}! (${s.damage}/${s.hp})`);
        const hp = parseInt(s.hp) || 0;
        if (hp > 0 && s.damage >= hp) { addLog(`${s.name} knocked out!`, true); G.players[opp].discard.push(s); G.players[opp].bench[i] = null; }
      });
      renderAll();
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
    postAttack: async ({ opp, player, atk }) => {
      const oppP = G.players[opp];
      const oppActive = oppP.active;
      if (!oppActive) return; // already KO'd — no return effect
      const toHand = [oppActive, ...(oppActive.attachedEnergy || [])];
      oppActive.attachedEnergy = []; oppActive.damage = 0; oppActive.status = null;
      let evoName = oppActive.evolvesFrom;
      while (evoName) {
        const idx = oppP.discard.findIndex(c => c.name === evoName && c.supertype === 'Pokémon');
        if (idx !== -1) { const pre = oppP.discard.splice(idx, 1)[0]; pre.damage = 0; pre.attachedEnergy = []; pre.status = null; toHand.push(pre); evoName = pre.evolvesFrom; }
        else break;
      }
      oppP.active = null; oppP.hand.push(...toHand);
      addLog(`${atk.name}: ${oppActive.name} + attachments returned to P${opp}'s hand!`, true);
      const benchLeft = oppP.bench.filter(s => s !== null);
      if (!benchLeft.length) { G.started = false; showWinScreen(player, 'OPPONENT HAS NO POKÉMON LEFT'); renderAll(); return true; }
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

  // Leek Slap (Farfetch'd): once-only per Farfetch'd instance
  'Leek Slap': {
    preAttack: ({ myActive, atk }) => {
      if (myActive?.leekSlapUsed) {
        showToast(`${atk.name}: already used — can't use again!`, true);
        addLog(`${atk.name}: already used — blocked!`, true);
        return 'block';
      }
    },
    postAttack: async ({ myActive, atk }) => {
      if (myActive) { myActive.leekSlapUsed = true; addLog(`${atk.name}: can't use again while Farfetch'd is in play!`, true); }
    }
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

  // Meditate (Jynx/Mr. Mime): 10 + 10 per damage counter on defender
  'Meditate': {
    modifyDamage: ({ oppActive }) => 10 + Math.floor((oppActive?.damage || 0) / 10) * 10
  },

  // Mega Drain (Butterfree): heal half damage dealt
  'Mega Drain': _drain(0.5),

  // Metronome (Clefairy/Clefable): copy opp's attack including its effects
  'Metronome': {
    postAttack: async ({ player, opp, myActive, atk }) => {
      const oppActive = G.players[opp].active;
      if (!oppActive?.attacks?.length) { addLog(`${atk.name}: opponent has no attacks to copy!`); return; }
      let chosenAtk;
      if (oppActive.attacks.length === 1) { chosenAtk = oppActive.attacks[0]; }
      else {
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
      addLog(`${atk.name}: copying ${oppActive.name}'s ${chosenAtk.name}!`, true);
      const energyCount = (myActive?.attachedEnergy || []).length;
      const coinDmg = await resolveCoinFlipDamage(chosenAtk, energyCount, myActive, player);
      let dmg = coinDmg !== null ? coinDmg : (parseInt((chosenAtk.damage || '0').replace(/[^0-9]/g,'')) || 0);
      // Apply damage scaling from dispatch table
      const copyEffect = MOVE_EFFECTS[chosenAtk.name];
      if (copyEffect?.modifyDamage) dmg = copyEffect.modifyDamage({ player, opp, atk: chosenAtk, dmg, myActive, oppActive }) ?? dmg;
      if (dmg > 0) {
        const currentOpp = G.players[opp].active;
        if (currentOpp) {
          currentOpp.damage = (currentOpp.damage || 0) + dmg;
          addLog(`${atk.name} (${chosenAtk.name}): ${dmg} damage to ${currentOpp.name}!`, true);
          const koResult = checkKO(player, opp, currentOpp, false);
          if (koResult === 'win') { renderAll(); return true; }
        }
      }
      // Apply copied attack's post effects
      if (copyEffect?.postAttack) {
        const currentOpp2 = G.players[opp].active;
        await copyEffect.postAttack({ player, opp, atk: chosenAtk, dmgDealt: dmg, myActive, oppActive: currentOpp2 });
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
  'Mirror Move': {
    postAttack: async ({ player, opp, myActive, atk }) => {
      const lastAtk = G.lastAttackOnPlayer?.[player];
      if (!lastAtk) { addLog(`${atk.name}: ${myActive?.name} was not attacked last turn.`); return; }
      addLog(`${atk.name}: reflecting ${lastAtk.attackName} back!`, true);
      if (lastAtk.damage > 0) {
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

  // Poisonpowder (Ivysaur/Kakuna/Tangela/Gloom/Weepinbell): opp Poisoned (no flip)
  'Poisonpowder': _statusOpp('poisoned'),

  // Pounce (Persian): incoming attack next turn does 10 less damage
  'Pounce': {
    postAttack: async ({ myActive, atk }) => {
      if (!myActive) return;
      myActive.pounceActive = true;
      addLog(`${atk.name}: incoming attack next turn does 10 less damage!`, true);
    }
  },

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

  // Slash (Scyther): boosted to 60 if Swords Dance was used this turn
  'Slash': {
    modifyDamage: ({ myActive }) => {
      if (myActive?.swordsDanceActive) {
        myActive.swordsDanceActive = false;
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

  // Swords Dance (Scyther): flag next Slash to do 60 instead of 30
  'Swords Dance': {
    postAttack: async ({ myActive, atk }) => {
      if (!myActive) return;
      myActive.swordsDanceActive = true;
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
      const old = myP.active; myP.active = target.s; myP.bench[target.i] = old;
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

  // Thunderstorm (Zapdos): flip per opp bench — heads=20 to it, tails=10 to self
  'Thunderstorm': {
    postAttack: async ({ player, opp, myActive, atk }) => {
      const bench = G.players[opp].bench.map((s, i) => ({ s, i })).filter(x => x.s !== null);
      if (!bench.length) { addLog(`${atk.name}: opponent has no bench.`); return; }
      let tails = 0;
      const total = bench.length;
      for (let fi = 0; fi < bench.length; fi++) {
        const { s, i } = bench[fi];
        const heads = await flipCoin(
          `${atk.name}: Flip for ${s.name} — Heads=20 damage, Tails=10 recoil`,
          { persistent: fi < total - 1, flipNum: fi + 1, totalFlips: total }
        );
        if (fi === total - 1) closeCoinOverlay();
        if (heads) {
          s.damage = (s.damage || 0) + 20;
          addLog(`${atk.name}: HEADS — 20 to ${s.name}! (${s.damage}/${s.hp})`);
          const hp = parseInt(s.hp) || 0;
          if (hp > 0 && s.damage >= hp) { addLog(`${s.name} knocked out!`, true); G.players[opp].discard.push(s); G.players[opp].bench[i] = null; }
        } else { tails++; addLog(`${atk.name}: TAILS for ${s.name}.`); }
      }
      if (tails > 0 && myActive) {
        const selfDmg = tails * 10;
        myActive.damage = (myActive.damage || 0) + selfDmg;
        addLog(`${atk.name}: ${tails} tails — ${myActive.name} takes ${selfDmg} recoil!`, true);
        const hp = parseInt(myActive.hp) || 0;
        if (hp > 0 && myActive.damage >= hp) {
          addLog(`${myActive.name} KO'd by recoil!`, true);
          G.players[player].discard.push(myActive); G.players[player].active = null;
          if (!G.players[player].bench.filter(s => s !== null).length) { G.started = false; showWinScreen(opp, "ZAPDOS KO'D ITSELF"); renderAll(); return true; }
        }
      }
      renderAll();
    }
  },

  // Toxic (Nidoking): heavy poison — 20 damage per turn instead of 10
  'Toxic': {
    postAttack: async ({ oppActive, atk }) => {
      if (!oppActive) return;
      oppActive.status = 'poisoned-toxic';
      addLog(`${atk.name}: ${oppActive.name} is now Badly Poisoned (20/turn)!`, true);
    }
  },

  // Venom Powder (Venomoth): flip — heads = Confused AND Poisoned
  'Venom Powder': {
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
        if (!G.players[opp].deck.length) { G.started = false; showWinScreen(player, "OPPONENT'S DECK EMPTY"); renderAll(); return true; }
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

function preAttackChecks(player, atk, myActive, oppActive) {
  const effect = MOVE_EFFECTS[atk.name];
  if (!effect?.preAttack) return null;
  return effect.preAttack({ player, opp: player === 1 ? 2 : 1, atk, myActive, oppActive });
}

async function preDamageModify(player, atk, dmg, myActive, oppActive) {
  const effect = MOVE_EFFECTS[atk.name];
  if (!effect?.modifyDamage) return dmg;
  const result = await effect.modifyDamage({ player, opp: player === 1 ? 2 : 1, atk, dmg, myActive, oppActive });
  return (result !== null && result !== undefined) ? result : dmg;
}

async function applyMoveEffects(player, atk, dmgDealt, myActive, oppActive) {
  const effect = MOVE_EFFECTS[atk.name];
  if (!effect?.postAttack) return;
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
    if (remaining === 0) { G.started = false; showWinScreen(defPlayer, 'ALL 6 PRIZES TAKEN'); return; }
  }
  if (!G.players[attackingPlayer].bench.filter(s => s !== null).length) {
    G.started = false; showWinScreen(defPlayer, 'DESTINY BOND — ATTACKER HAS NO POKÉMON LEFT');
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
  // Pounce: clears after one turn
  for (const pNum of [1, 2]) {
    const a = G.players[pNum].active;
    if (a?.pounceActive) { a.pounceActive = false; a.pounceReduction = 0; }
  }
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
