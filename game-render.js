// ══════════════════════════════════════════════════════════════════════════════
// GAME-RENDER.JS — All rendering and UI display functions
//
// Depends on globals: G, myRole, vsComputer, CARD_DATA, addLog, flipCoin,
//   showActionMenu, closeActionMenu, cancelAction, performAttack, playTrainer,
//   attachEnergy, evolve, playAsActive, startBenchPlay, attemptRetreat,
//   showFieldActionMenu, handleBenchClick, onActiveClick, selectHandCard,
//   doneSetup, endTurn, handleEndTurnBtn, isPowerActive, hasPower,
//   isMukActive, prehistoricPowerActive, hasThickSkin, hasInvisibleWall,
//   retreatCostReduction, rainDanceActive, energyTransActive,
//   damageSwapActive, doDamageSwap, doEnergyTrans, doCurse, doBuzzap,
//   doMetronome, dittoAttacks, getDittoTransformStats, isMyTurn,
//   applyRoleVisibility, escapeHtml, escapeAttr, shuffle
// ══════════════════════════════════════════════════════════════════════════════

function renderAll() {
  document.body.dataset.phase = G.phase || 'SETUP';
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
  // Wire drag-and-drop onto freshly rendered hand cards
  initDragDrop();
  // Networked: push state and apply role-based visibility
  if (myRole !== null && G.started && !vsComputer) {
    pushGameState();
    applyRoleVisibility();
  } else if (vsComputer) {
    applyRoleVisibility();
  }
}

function updatePerspectiveLabels() {
  if (myRole !== 2) return;
  // For P2: top zone shows P1 (opponent), bottom zone shows P2 (self)
  const oppLabel = document.getElementById('opp-label');
  if (oppLabel) oppLabel.textContent = 'PLAYER 1';
  const activeLabel = document.querySelector('.active-label');
  if (activeLabel) activeLabel.style.color = 'var(--p2color)';
  const deckBorder = document.querySelector('.player-deck-slot');
  if (deckBorder) deckBorder.style.borderColor = 'var(--p2color)';
  const deckCount = document.getElementById('deck-count-p1');
  if (deckCount) deckCount.style.color = 'var(--p2color)';
  // Flip active border color
  const activeP1El = document.getElementById('active-p1');
  if (activeP1El) { activeP1El.style.borderColor = 'var(--p2color)'; activeP1El.style.boxShadow = '0 4px 16px rgba(245,101,101,.15)'; }
}

function renderField(player) {
  // In networked mode as P2, swap the display zones:
  // P2's cards go in the "bottom" (p1) slots, P1's cards go in the "top" (p2) slots
  const isP2Perspective = (myRole === 2);
  const bottomPlayer = isP2Perspective ? 2 : 1;  // who renders in bottom zone
  const topPlayer    = isP2Perspective ? 1 : 2;  // who renders in top zone

  const p = G.players[player];

  if (player === bottomPlayer) {
    // Render in the bottom "player" zone
    const activeEl = document.getElementById('active-p1');
    renderSlotP1(activeEl, p.active);
    for (let i = 0; i < 5; i++) {
      const slotEl = document.getElementById(`bench-p1-${i}`);
      if (slotEl) renderSlotP1(slotEl, p.bench[i]);
    }
    const discardEl = document.getElementById('discard-p1');
    if (p.discard.length > 0) {
      const top = p.discard[p.discard.length - 1];
      discardEl.innerHTML = `<img src="${top.images?.small || ''}" alt="${top.name}">`;
    } else {
      discardEl.innerHTML = `<span style="font-size:6px">DISCARD</span>`;
    }
    // Bottom hand label color
    const label1 = document.getElementById('hand-label-p1');
    if (label1) label1.style.color = isP2Perspective ? 'var(--p2color)' : 'var(--p1color)';
  } else {
    // Render in the top "opponent" zone
    // During SETUP in networked mode: show face-down placeholders so opponent's choices are hidden
    const setupHide = G.phase === 'SETUP' && myRole !== null;
    // Clairvoyance (Omanyte): opponent's hand is revealed face-up
    G._clairvoyanceActive = typeof isPowerActive === 'function' &&
      [G.players[topPlayer].active, ...G.players[topPlayer].bench].some(c => isPowerActive(c, 'Clairvoyance'));
    const activeEl = document.getElementById('active-p2');
    activeEl.classList.remove('status-asleep','status-paralyzed','status-poisoned','status-confused','status-burned');
    if (p.active) {
      if (setupHide) {
        activeEl.innerHTML = `<div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px">
          <div style="font-size:18px">🂠</div>
          <div style="font-size:6px;color:var(--muted)">PLACED</div>
        </div>`;
      } else {
        const card = p.active;
        if (card.status) activeEl.classList.add(`status-${card.status.replace('-toxic','')}`);
        const energyPips = (card.attachedEnergy || []).flatMap(e => /double colorless/i.test(e.name) ? [energyIcon('Colorless Energy', 26), energyIcon('Colorless Energy', 26)] : [energyIcon(e.name, 26)]).join('');
        const dmg = damageCounters(card.damage, true);
        const status = card.status ? `<div class="status-overlay">${statusEmoji(card.status)}</div>` : '';
        const oppPower1 = getPower(card);
        const oppPowerSup1 = oppPower1 && isMukActive() && oppPower1.name !== 'Toxic Gas';
        const badgeParts1 = [
          card.defender  ? `<div class="card-badge defender">DEF</div>` : '',
          card.plusPower ? `<div class="card-badge pluspower">+10</div>` : '',
          oppPower1 ? `<div class="card-badge" style="background:rgba(180,100,220,.9);color:#fff;${oppPowerSup1 ? 'opacity:.4;text-decoration:line-through' : ''}">${oppPower1.name.substring(0,8)}</div>` : '',
          typeof conversionBadges === 'function' ? conversionBadges(card) : '',
        ].filter(Boolean);
        const badges = badgeParts1.length ? `<div class="card-badges">${badgeParts1.join('')}</div>` : '';
        activeEl.innerHTML = `<img src="${card.images?.small || ''}" alt="${card.name}">
          <div class="energy-overlay" style="max-height:168px">${energyPips}</div>${dmg}${status}${badges}`;
      }
    } else {
      activeEl.innerHTML = `<span class="slot-label">ACTIVE</span>`;
    }
    // Opponent bench
    for (let i = 0; i < 5; i++) {
      const slotEl = document.getElementById(`bench-p2-${i}`);
      if (!slotEl) continue;
      const wasHighlighted = slotEl.classList.contains('highlight');
      slotEl.classList.remove('status-asleep','status-paralyzed','status-poisoned','status-confused','status-burned');
      const card = p.bench[i];
      if (card) {
        if (setupHide) {
          slotEl.innerHTML = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:16px;">🂠</div>`;
          slotEl.classList.remove('empty');
        } else {
          if (card.status) slotEl.classList.add(`status-${card.status.replace('-toxic','')}`);
          const status = card.status ? `<div class="status-overlay">${statusEmoji(card.status)}</div>` : '';
          const benchPower = getPower(card);
          const benchPowerSup = benchPower && isMukActive() && benchPower.name !== 'Toxic Gas';
          const badgeParts2 = [
            card.defender  ? `<div class="card-badge defender">DEF</div>` : '',
            card.plusPower ? `<div class="card-badge pluspower">+10</div>` : '',
            benchPower ? `<div class="card-badge" style="background:rgba(180,100,220,.9);color:#fff;${benchPowerSup ? 'opacity:.4;text-decoration:line-through' : ''}">${benchPower.name.substring(0,8)}</div>` : '',
            typeof conversionBadges === 'function' ? conversionBadges(card) : '',
          ].filter(Boolean);
          const badges = badgeParts2.length ? `<div class="card-badges">${badgeParts2.join('')}</div>` : '';
          const benchDmg = damageCounters(card.damage);
          const oppBenchW = slotEl.clientWidth || 64;
          const oppBenchH = slotEl.clientHeight || 56;
          const oppIconSize = Math.min(18, Math.max(10, Math.round(oppBenchW * 0.28)));
          const oppIconPlusgap = oppIconSize + 3;
          const benchEnergyPips = (card.attachedEnergy || []).flatMap(e => /double colorless/i.test(e.name) ? [energyIcon('Colorless Energy', oppIconSize), energyIcon('Colorless Energy', oppIconSize)] : [energyIcon(e.name, oppIconSize)]).join('');
          const oppBenchEnergyStyle = `max-height:${oppBenchH}px;max-width:none`;
          slotEl.innerHTML = `<img src="${card.images?.small || ''}" alt="${card.name}">
            <div class="energy-overlay-bench" style="${oppBenchEnergyStyle}">${benchEnergyPips}</div>${benchDmg}${status}${badges}`;
          slotEl.classList.remove('empty');
          // Push next bench card right to avoid overlap
          const oppEnergyCount = (card.attachedEnergy || []).length;
          if (oppEnergyCount > 0) {
            const iconsPerCol = Math.max(1, Math.floor(oppBenchH / oppIconPlusgap));
            const cols = Math.ceil(oppEnergyCount / iconsPerCol);
            slotEl.style.marginRight = (cols * oppIconPlusgap + 2) + 'px';
          } else {
            slotEl.style.marginRight = '';
          }
        }
      } else {
        slotEl.innerHTML = '';
        slotEl.style.marginRight = '';
        slotEl.classList.add('empty');
      }
      if (wasHighlighted) slotEl.classList.add('highlight');
    }
    // Opponent discard
    const discardEl = document.getElementById('discard-p2');
    if (p.discard.length > 0) {
      const top = p.discard[p.discard.length - 1];
      discardEl.innerHTML = `<img src="${top.images?.small || ''}" alt="${top.name}">`;
    } else {
      discardEl.innerHTML = `<span style="font-size:6px">DISC</span>`;
    }
  }
}

function renderSlotP1(el, card) {
  if (!el) return;
  const wasHighlighted = el.classList.contains('highlight');
  // Clear status classes
  el.classList.remove('status-asleep','status-paralyzed','status-poisoned','status-confused','status-burned');
  if (!card) {
    el.classList.remove('occupied');
    el.innerHTML = `<div class="zone-slot-empty">${el.id.includes('active') ? 'Active<br>Pokémon' : 'bench'}</div>`;
    el.style.marginRight = ''; // clear any energy-pushed margin
    if (wasHighlighted) el.classList.add('highlight');
    return;
  }
  el.classList.add('occupied');
  if (card.status) el.classList.add(`status-${card.status.replace('-toxic','')}`);

  const isActive = el.id.includes('active');
  const energyClass = isActive ? 'energy-overlay' : 'energy-overlay-bench';
  const dmg = damageCounters(card.damage, isActive);
  const status = card.status ? `<div class="status-overlay">${statusEmoji(card.status)}</div>` : '';
  const power = getPower(card);
  const powerSuppressed = power && isMukActive() && power.name !== 'Toxic Gas';
  const badgeParts3 = [
    card.defender  ? `<div class="card-badge defender">DEF</div>` : '',
    card.plusPower ? `<div class="card-badge pluspower">+10</div>` : '',
    power ? `<div class="card-badge" style="background:rgba(180,100,220,.9);color:#fff;${powerSuppressed ? 'opacity:.4;text-decoration:line-through' : ''}">${power.name.substring(0,8)}</div>` : '',
    typeof conversionBadges === 'function' ? conversionBadges(card) : '',
  ].filter(Boolean);
  const badges = badgeParts3.length ? `<div class="card-badges">${badgeParts3.join('')}</div>` : '';
  const imgSrc = card.images?.small || '';

  const slotH = el.clientHeight || (isActive ? 200 : 90);
  const slotW = el.clientWidth  || (isActive ? 130 : 64);

  // Scale icon size proportionally to slot width — caps at 26px (active) / 18px (bench)
  const iconSize = isActive
    ? Math.min(26, Math.max(14, Math.round(slotW * 0.20)))
    : Math.min(18, Math.max(10, Math.round(slotW * 0.28)));
  const iconPlusgap = iconSize + 3;

  const energyPips = (card.attachedEnergy || []).flatMap(e => /double colorless/i.test(e.name) ? [energyIcon('Colorless Energy', iconSize), energyIcon('Colorless Energy', iconSize)] : [energyIcon(e.name, iconSize)]).join('');
  const energyStyle = `max-height:${slotH}px;max-width:none`;
  el.innerHTML = `<img src="${imgSrc}" alt="${card.name}">
    <div class="${energyClass}" style="${energyStyle}">${energyPips}</div>${dmg}${status}${badges}`;

  // Reserve right margin for energy columns so the next bench card is pushed right
  if (!isActive) {
    const energyCount = (card.attachedEnergy || []).reduce((s,e) => s + (/double colorless/i.test(e.name||'')?2:1), 0);
    if (energyCount > 0) {
      const iconsPerCol = Math.max(1, Math.floor(slotH / iconPlusgap));
      const cols = Math.ceil(energyCount / iconsPerCol);
      el.style.marginRight = (cols * iconPlusgap + 2) + 'px';
    } else {
      el.style.marginRight = '';
    }
  } else {
    el.style.marginRight = '';
  }

  if (wasHighlighted) el.classList.add('highlight');
}

function renderHands() {
  const p1 = G.players[1];
  const p2 = G.players[2];

  // Bottom bar always shows the local player's hand
  // localPlayer: P1 if myRole=1, P2 if myRole=2
  const localPlayer = (myRole === 2) ? 2 : 1;
  const localHand = G.players[localPlayer].hand;
  const container1 = document.getElementById('hand-p1');
  const label1 = document.getElementById('hand-label-p1');
  label1.textContent = `P${localPlayer} HAND (${localHand.length})`;
  label1.style.color = localPlayer === 2 ? 'var(--p2color)' : 'var(--p1color)';

  if (!localHand.length) {
    container1.innerHTML = `<div style="font-size:8px;color:var(--muted);padding:8px">No cards</div>`;
  } else {
    container1.innerHTML = localHand.map((card, i) => {
      const imgSrc = card.images?.small || '';
      const largeSrc = card.images?.large || imgSrc;
      let pipHtml = '';
      if (card.supertype === 'Pokémon') {
        const typeColor = energyColor((card.types || [])[0] || '');
        pipHtml = `<span class="hand-card-type-pip" style="background:${typeColor}"></span>`;
      } else if (card.supertype === 'Energy') {
        const typeColor = energyColor(card.name);
        pipHtml = `<span class="hand-card-type-pip" style="background:${typeColor}"></span>`;
      }
      const subText = card.supertype === 'Pokémon'
        ? `${pipHtml}${(card.subtypes || []).join(' ')} · ${card.hp || '?'}HP`
        : `${pipHtml}${card.supertype || ''}`;
      return `<div class="hand-card" id="hand-card-${localPlayer}-${i}"
        onclick="event.stopPropagation();selectHandCard(${localPlayer},${i},event)">
        <img class="hand-card-img" src="${imgSrc}" alt="${card.name}">
        <div class="hand-card-info">
          <div class="hand-card-name">${card.name}</div>
          <div class="hand-card-sub">${subText}</div>
        </div>
      </div>`;
    }).join('');
  }

  // Opponent hand count badge (top zone)
  const label2 = document.getElementById('hand-label-p2');
  if (label2) label2.textContent = (localPlayer === 1 ? p2 : p1).hand.length;

  // Sidebar P2 HAND tab — in networked mode P1 sees opponent's hand count only (face down)
  if (document.getElementById('tab-hand2')?.classList.contains('active')) {
    renderSidebarP2Hand();
  }
}

function renderSidebarP2Hand() {
  const content = document.getElementById('sidebar-content');

  // Only available in VS Computer mode
  if (!vsComputer) {
    content.innerHTML = `<div style="font-size:8px;color:var(--muted);text-align:center;padding:20px">Only available in VS Computer mode.</div>`;
    return;
  }

  const sidePlayer = (myRole === 2) ? 1 : 2;
  const sideHand = G.players[sidePlayer].hand;
  const sideColor = sidePlayer === 1 ? 'var(--p1color)' : 'var(--p2color)';
  const label = myRole === 2 ? 'P1 HAND' : 'P2 HAND';

  // Show gate screen until player explicitly reveals
  if (!renderSidebarP2Hand._revealed) {
    content.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;padding:16px 10px;gap:12px;text-align:center">
        <div style="font-size:9px;color:var(--muted);line-height:1.5;max-width:160px">
          This will show the computer player's hand.<br><br>
          Technically cheating unless you're trying to debug something.
        </div>
        <button onclick="renderSidebarP2Hand._revealed=true;renderSidebarP2Hand();"
          style="font-size:9px;padding:6px 12px;background:var(--surface2);color:var(--text);
                 border:1px solid var(--border);border-radius:4px;cursor:pointer;letter-spacing:0.05em">
          SHOW COMPUTER HAND
        </button>
        <img src="https://images.pokemontcg.io/base1/69.png" alt="Weedle"
          style="width:72px;image-rendering:pixelated;opacity:0.85;margin-top:4px"
          title="Weedle judges you">
      </div>`;
    return;
  }

  if (!sideHand.length) {
    content.innerHTML = `<div style="font-size:8px;color:var(--muted);text-align:center;padding:20px">${label}: no cards</div>`;
    return;
  }

  content.innerHTML = `<div style="font-size:8px;color:${sideColor};margin-bottom:8px">${label} (${sideHand.length})</div>
    <div id="hand-p2">` +
    sideHand.map((card, i) => {
      const imgSrc = card.images?.small || '';
      return `<div class="hand-card" id="hand-card-${sidePlayer}-${i}">
        <img class="hand-card-img" src="${imgSrc}" alt="${card.name}">
        <div class="hand-card-info">
          <div class="hand-card-name">${card.name}</div>
          <div class="hand-card-sub">${card.supertype || ''}</div>
        </div>
      </div>`;
    }).join('') + `</div>`;
}

function renderPrizes(player) {
  const prizes = G.players[player].prizes;
  // In P2 perspective: P2's prizes go in the bottom (prizes-p1), P1's in the top (prizes-p2)
  const isP2Persp = (myRole === 2);
  const bottomPlayer = isP2Persp ? 2 : 1;

  if (player === bottomPlayer) {
    // Bottom zone — full prize grid (local player's prizes)
    const container = document.getElementById('prizes-p1');
    container.innerHTML = prizes.map((p, i) => {
      if (!p) return `<div class="prize-slot gone"></div>`;
      if (p.revealed) return `<div class="prize-slot"><img src="${p.card.images?.small || ''}" alt="${p.card.name}"></div>`;
      return `<div class="prize-slot face-down" title="Prize ${i+1}"></div>`;
    }).join('');
  } else {
    // Top zone — small pips (opponent's prizes)
    const container = document.getElementById('prizes-p2');
    container.innerHTML = prizes.map((p) => {
      if (!p) return `<div class="opp-prize-pip gone"></div>`;
      return `<div class="opp-prize-pip"></div>`;
    }).join('');
  }
}

// Sidebar prizes tab
function renderPrizesTab() {
  const content = document.getElementById('sidebar-content');
  const p1prizes = G.players[1].prizes;
  const p2prizes = G.players[2].prizes;
  const myPrizes  = myRole === 2 ? p2prizes : p1prizes;
  const oppPrizes = myRole === 2 ? p1prizes : p2prizes;
  const myLabel   = myRole === 2 ? 'YOUR PRIZES' : 'P1 PRIZES';
  const oppLabel  = myRole === 2 ? 'OPP PRIZES'  : 'P2 PRIZES';
  const myColor   = myRole === 2 ? 'var(--p2color)' : 'var(--p1color)';
  const oppColor  = myRole === 2 ? 'var(--p1color)' : 'var(--p2color)';
  content.innerHTML = `
    <div style="font-size:8px;color:${myColor};margin-bottom:6px">${myLabel} (${myPrizes.filter(p=>p).length} left)</div>
    <div style="display:grid;grid-template-columns:repeat(3,48px);gap:4px;margin-bottom:12px">
      ${myPrizes.map(p => !p
        ? `<div style="width:48px;height:66px;border:1px solid var(--border);border-radius:3px;opacity:.15"></div>`
        : `<div style="width:48px;height:66px;border:1px solid var(--border);border-radius:3px;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:9px;color:var(--muted)">?</div>`
      ).join('')}
    </div>
    <div style="font-size:8px;color:${oppColor};margin-bottom:6px">${oppLabel} (${oppPrizes.filter(p=>p).length} left)</div>
    <div style="display:grid;grid-template-columns:repeat(3,48px);gap:4px">
      ${oppPrizes.map(p => !p
        ? `<div style="width:48px;height:66px;border:1px solid var(--border);border-radius:3px;opacity:.15"></div>`
        : `<div style="width:48px;height:66px;border:1px solid var(--border);border-radius:3px;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:9px;color:var(--muted)">?</div>`
      ).join('')}
    </div>`;
}

function updateDeckCounts() {
  const isP2Persp = (myRole === 2);
  const bottomPlayer = isP2Persp ? 2 : 1;
  const topPlayer    = isP2Persp ? 1 : 2;
  const bp = G.players[bottomPlayer];
  const tp = G.players[topPlayer];
  // P1: deck count to left of deck pile
  const el1 = document.getElementById('deck-count-p1-label');
  if (el1) el1.innerHTML = `${bp.deck.length}<small>deck</small>`;
  // P1: discard count to left of discard pile
  const el1d = document.getElementById('discard-count-p1-label');
  if (el1d) el1d.innerHTML = `${bp.discard.length}<small>disc</small>`;
  // P2: deck count below deck pile
  const el2 = document.getElementById('deck-count-p2');
  if (el2) el2.innerHTML = `${tp.deck.length}<small>deck</small>`;
  // P2: discard count below discard pile
  const el2d = document.getElementById('discard-count-p2');
  if (el2d) el2d.innerHTML = `${tp.discard.length}<small>disc</small>`;
}

function updatePhase() {
  document.getElementById('phase-badge').textContent = G.phase;
}

function updateTurnBadge() {
  const badge = document.getElementById('turn-badge');
  if (G.phase === 'SETUP') {
    badge.textContent = 'SETUP';
    badge.className = 'turn-badge';
    badge.style.color = 'var(--accent)';
    badge.style.borderColor = 'var(--accent)';
  } else {
    badge.style.color = '';
    badge.style.borderColor = '';
    if (G.phase === 'PROMOTE' && G.pendingPromotion) {
      const promoter = G.pendingPromotion;
      badge.className = `turn-badge p${promoter}`;
      badge.textContent = myRole === null ? `P${promoter} PROMOTE` : (promoter === myRole ? 'YOUR TURN' : 'OPP TURN');
    } else if (myRole === null) {
      badge.textContent = `P${G.turn} TURN`;
      badge.className = `turn-badge p${G.turn}`;
    } else {
      const isMyTurnNow = G.turn === myRole;
      badge.textContent = isMyTurnNow ? 'YOUR TURN' : 'OPP TURN';
      badge.className = `turn-badge p${G.turn}`;
    }
  }
}

function setMidline(text) {
  const isMobile = window.innerWidth <= 600;
  const defaultMsg = G.phase === 'SETUP'
    ? (isMobile ? 'Place your Active Pokémon' : 'Both players: place your Active (and optionally bench basics), then click DONE SETUP')
    : (isMobile ? 'Tap a card to play it' : 'Click a card in your hand to play it');
  document.getElementById('midline-info').textContent = text || defaultMsg;
}

function clearHighlights() {
  document.querySelectorAll('.highlight').forEach(el => el.classList.remove('highlight'));
  setMidline('Click a card in your hand to play it');
}

// ══════════════════════════════════════════════════
// LOG
// ══════════════════════════════════════════════════
function addLog(msg, important = false) {
  G.log.unshift({ msg, important, turn: G.turnNum });
  // Re-render only if sidebar is open and log tab is active
  const board = document.getElementById('game-board');
  const logTabActive = document.getElementById('tab-log')?.classList.contains('active');
  const sidebarOpen = board?.classList.contains('sidebar-open');
  if (logTabActive && sidebarOpen) renderLog();
}

function renderLog() {
  const container = document.getElementById('sidebar-content');
  if (!G.log || G.log.length === 0) {
    container.innerHTML = '<div style="font-size:11px;color:var(--muted);text-align:center;padding:20px">No actions logged yet.</div>';
    return;
  }
  let html = '<div class="game-log">';
  let lastTurn = null;
  G.log.forEach(e => {
    if (e.turn !== lastTurn) {
      html += `<div class="log-turn-header">— Turn ${e.turn} —</div>`;
      lastTurn = e.turn;
    }
    html += `<div class="log-entry${e.important ? ' important' : ''}">${e.msg}</div>`;
  });
  html += '</div>';
  container.innerHTML = html;
}

// ══════════════════════════════════════════════════
// SIDEBAR TABS
// ══════════════════════════════════════════════════
function showTab(tab) {
  document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`tab-${tab}`)?.classList.add('active');
  // On desktop the sidebar starts collapsed (0px). Auto-open it when user clicks a tab.
  const board = document.getElementById('game-board');
  const btn = document.getElementById('sidebar-toggle-btn');
  if (board && !board.classList.contains('sidebar-open')) {
    board.classList.add('sidebar-open');
    if (btn) btn.textContent = 'LOG ◂';
  }
  if (tab === 'log') renderLog();
  else if (tab === 'hand2') renderSidebarP2Hand();
  else if (tab === 'prizes') renderPrizesTab();
}

// ══════════════════════════════════════════════════
// ACTION MENU
// ══════════════════════════════════════════════════
function showActionMenu(title, actions, anchorEvent) {
  const menu = document.getElementById('action-menu');
  document.getElementById('action-menu-title').textContent = title;
  menu.querySelectorAll('.action-btn').forEach(b => b.remove());
  actions.forEach(a => {
    const btn = document.createElement('button');
    btn.className = 'action-btn' + (a.danger ? ' danger' : '') + (a.disabled ? ' disabled' : '');
    // Build label: attack buttons get a sub-line for cost/damage details
    if (a.sub) {
      btn.innerHTML = `${escapeHtml(a.label)}<span class="action-btn-sub">${escapeHtml(a.sub)}</span>`;
    } else {
      btn.textContent = a.label + (a.tooltip ? ` — ${a.tooltip}` : '');
    }
    if (a.disabled) {
      btn.style.opacity = '0.35';
      btn.style.cursor = 'not-allowed';
      btn.onclick = e => e.stopPropagation();
    } else {
      btn.onclick = e => { e.stopPropagation(); a.fn(); };
    }
    menu.appendChild(btn);
  });
  const cancel = document.createElement('button');
  cancel.className = 'action-btn';
  cancel.textContent = 'Cancel';
  cancel.style.color = 'var(--muted)';
  cancel.style.marginTop = '2px';
  cancel.onclick = e => { e.stopPropagation(); closeActionMenu(); cancelAction(); };
  menu.appendChild(cancel);

  // Smart positioning: bottom sheet on mobile, anchored near click on desktop
  menu.classList.add('show');

  const isMobile = window.innerWidth <= 600;
  if (isMobile) {
    // Bottom sheet — CSS handles positioning via media query
    menu.style.left = '';
    menu.style.top = '';
    menu.style.right = '';
    menu.style.bottom = '';
    return;
  }

  menu.style.left = '0';
  menu.style.top = '0';
  menu.style.transform = 'none';

  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let cx, cy;
  if (anchorEvent) {
    cx = anchorEvent.clientX;
    cy = anchorEvent.clientY;
  } else {
    cx = vw / 2;
    cy = vh / 2;
  }

  // Prefer opening to the right and below; flip if it would clip
  let left = cx + 12;
  let top  = cy - 20;
  if (left + mw > vw - 10) left = cx - mw - 12;
  if (top + mh > vh - 10) top = vh - mh - 10;
  if (top < 10) top = 10;
  if (left < 10) left = 10;

  menu.style.left = left + 'px';
  menu.style.top  = top + 'px';
}

function closeActionMenu() {
  document.getElementById('action-menu').classList.remove('show');
  document.querySelectorAll('.hand-card').forEach(el => el.classList.remove('selected'));
}

function showCardDetail(imgSrc) {
  if (!imgSrc) return;
  document.getElementById('card-detail-img').src = imgSrc;
  document.getElementById('card-detail').classList.add('show');
}
function hideCardDetail() {
  document.getElementById('card-detail').classList.remove('show');
}

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
  if (e.target === e.currentTarget) cancelCardPick();
});

// ══════════════════════════════════════════════════
// TOAST
// ══════════════════════════════════════════════════
let toastTimer;
function showToast(msg, isErr = false, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : type ? ` ${type}` : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.className = 'toast', 2400);
}

// ══════════════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════════════
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function energyColor(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('fire')) return '#ff6b35';
  if (n.includes('water')) return '#4fc3f7';
  if (n.includes('grass') || n.includes('leaf')) return '#66bb6a';
  if (n.includes('lightning') || n.includes('electric')) return '#ffd54f';
  if (n.includes('psychic')) return '#ce93d8';
  if (n.includes('fighting')) return '#a1887f';
  if (n.includes('darkness') || n.includes('dark')) return '#7986cb';
  if (n.includes('metal') || n.includes('steel')) return '#b0bec5';
  return '#90a4ae';
}

// Maps an energy card name to the key used in ENERGY_ICONS
function energyTypeKey(energyName) {
  const n = (energyName || '').toLowerCase();
  if (n.includes('fire'))                          return 'fire';
  if (n.includes('water'))                         return 'water';
  if (n.includes('grass') || n.includes('leaf'))   return 'grass';
  if (n.includes('lightning') || n.includes('electric')) return 'lightning';
  if (n.includes('psychic'))                       return 'psychic';
  if (n.includes('fighting'))                      return 'fighting';
  if (n.includes('darkness') || n.includes('dark')) return 'darkness';
  if (n.includes('metal') || n.includes('steel'))  return 'metal';
  return 'colorless';
}

// Returns an <img> of the official TCG energy card art, or an SVG fallback.
// size = rendered pixel size (the image is square-cropped to show just the symbol area).
function energyIcon(energyName, size = 16) {
  const key = energyTypeKey(energyName);
  const url = ENERGY_ICONS[key];
  const s = size;

  if (url) {
    // Icon PNGs are transparent-background symbol images — render at size directly, no cropping.
    return `<img src="${url}" alt="${key}" style="width:${s}px;height:${s}px;object-fit:contain;flex-shrink:0;filter:drop-shadow(0 1px 2px rgba(0,0,0,.6));vertical-align:middle">`;
  }

  // ── SVG fallbacks (used if energy-icons.json not loaded) ──
  const c = { fire:'#e8400c', water:'#2980ef', grass:'#3aaa3a', lightning:'#f0cc00',
               psychic:'#d43ea0', fighting:'#b84010', darkness:'#3c3080',
               metal:'#8090a0', colorless:'#a8b0c0' }[key] || '#a8b0c0';
  return `<svg width="${s}" height="${s}" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><circle cx="16" cy="16" r="15" fill="${c}" stroke="rgba(0,0,0,.4)" stroke-width="1.5"/><text x="16" y="21" text-anchor="middle" font-size="14" fill="white" font-family="sans-serif" font-weight="bold">${key[0].toUpperCase()}</text></svg>`;
}


// Returns HTML for damage counter dots — one black dot per 10 damage
function damageCounters(damage, isActive = false) {
  if (!damage || damage <= 0) return '';
  const dots = Math.floor(damage / 10);
  if (dots === 0) return '';
  const cls = isActive ? 'damage-counters active-dmg' : 'damage-counters';
  return `<div class="${cls}">${'<div class="dmg-dot"></div>'.repeat(dots)}</div>`;
}

function statusEmoji(s) {
  if (s === 'poisoned-toxic') return '☠️☠️';
  return { asleep:'😴', confused:'😵', paralyzed:'⚡', poisoned:'☠️', burned:'🔥' }[s] || '❓';
}

// ══════════════════════════════════════════════════
// CARD DATA LOOKUP (loaded once from cards.json)
// ══════════════════════════════════════════════════
let CARD_DATA = {};
(async () => {
  try {
    const resp = await fetch('cards.json');
    const cards = await resp.json();
    cards.forEach(c => { CARD_DATA[c.id] = c; });
  } catch(e) { console.warn('cards.json not loaded:', e); }
})();

let ENERGY_ICONS = {};
(async () => {
  try {
    const resp = await fetch('energy-icons.json');
    ENERGY_ICONS = await resp.json();
  } catch(e) { console.warn('energy-icons.json not loaded — using SVG fallbacks:', e); }
})();

// GAME_STATE_DEFAULTS — mutable per-card fields that must survive every Firebase
// round-trip and enrichCard merge. Add new fields HERE only; enrichCard picks
// them up automatically in both code paths.
const GAME_STATE_DEFAULTS = {
  status:               null,
  damage:               0,
  defender:             false,
  defenderFull:         false,
  defenderFullEffects:  false,
  defenderThreshold:    0,
  defenderReduction:    0,
  plusPower:            0,
  nextAttackDouble:     false,
  smokescreened:        false,
  immuneToAttack:       false,
  disabledAttack:       null,
  cantRetreat:          false,
  destinyBond:          false,
  leekSlapUsed:         false,
  pounceActive:         false,
  pounceReduction:      0,
  swordsDanceActive:    false,
  attackReduction:      0,
  conversionWeakness:   null,
  conversionResistance: null,
  trainerBlocked:       false,
};

function enrichCard(card) {
  if (!card) return card;
  const full = CARD_DATA[card.id];
  // Always ensure array fields are arrays (Firebase can return null for empty arrays)
  const safeSubtypes = Array.isArray(card.subtypes) ? card.subtypes :
    (full?.subtypes || []);
  const safeAttacks = Array.isArray(card.attacks) && card.attacks.length ? card.attacks :
    (full?.attacks || []);
  // Always merge attack text/cost from CARD_DATA so Firebase round-trips don't drop them
  const mergedAttacks = safeAttacks.map((atk, i) => {
    const fullAtk = full?.attacks?.[i] || {};
    return { ...fullAtk, ...atk, text: atk.text || fullAtk.text || '', cost: atk.cost || fullAtk.cost || [] };
  });

  // Pick live game-state values off `card`, falling back to defaults.
  // Both return paths share this so new fields in GAME_STATE_DEFAULTS are
  // automatically covered — no need to edit two places.
  const gameState = {};
  for (const [k, def] of Object.entries(GAME_STATE_DEFAULTS)) {
    gameState[k] = card[k] ?? def;
  }

  if (!full) {
    return {
      ...card,
      types: Array.isArray(card.types) ? card.types : [],
      subtypes: safeSubtypes,
      attacks: mergedAttacks,
      abilities: Array.isArray(card.abilities) ? card.abilities : [],
      weaknesses: Array.isArray(card.weaknesses) ? card.weaknesses : [],
      resistances: Array.isArray(card.resistances) ? card.resistances : [],
      retreatCost: Array.isArray(card.retreatCost) ? card.retreatCost : [],
      convertedRetreatCost: card.convertedRetreatCost || 0,
      attachedEnergy: Array.isArray(card.attachedEnergy) ? card.attachedEnergy : [],
      ...gameState,
    };
  }
  return {
    ...card,
    types: (Array.isArray(card.types) && card.types.length) ? card.types : (full.types || card.types || []),
    subtypes: safeSubtypes.length ? safeSubtypes : (full.subtypes || []),
    evolvesFrom: full.evolvesFrom || card.evolvesFrom || null,
    rules: full.rules || card.rules || [],
    abilities: full.abilities || card.abilities || [],
    attacks: mergedAttacks,
    hp: (card.hp && card.hp !== '0') ? card.hp : (full.hp || card.hp || '0'),
    weaknesses: full.weaknesses || [],
    resistances: full.resistances || [],
    retreatCost: full.retreatCost || [],
    convertedRetreatCost: full.convertedRetreatCost || 0,
    attachedEnergy: Array.isArray(card.attachedEnergy) ? card.attachedEnergy : [],
    // Game-state fields — applied from GAME_STATE_DEFAULTS above
    ...gameState,
  };
}

// ══════════════════════════════════════════════════
// TURN CHANGE FLASH
// ══════════════════════════════════════════════════
function showPromoteBanner(playerNum) {
  const banner = document.getElementById('promote-banner');
  const text = document.getElementById('promote-banner-text');
  const sub = document.getElementById('promote-banner-sub');
  const isMe = myRole === null || myRole === playerNum;
  text.textContent = isMe
    ? `⚠ CHOOSE YOUR NEXT POKÉMON`
    : `⚠ PLAYER ${playerNum} IS CHOOSING THEIR NEXT POKÉMON`;
  sub.textContent = isMe
    ? 'Click a highlighted bench slot to promote to Active'
    : 'Waiting for opponent...';
  text.style.color = playerNum === 1 ? 'var(--p1color)' : 'var(--p2color)';
  banner.style.borderBottomColor = playerNum === 1 ? 'var(--p1color)' : 'var(--p2color)';
  banner.classList.add('show');
}

function hidePromoteBanner() {
  document.getElementById('promote-banner').classList.remove('show');
}

// ── Flash queue ───────────────────────────────────────────────────────────────
// All flashes and deferred renders go through a single queue so they never overlap
// and board state changes are visible at the same time as the flash that explains them.
const _flashQueue = [];
let _flashBusy = false;

function _runFlashQueue() {
  if (_flashBusy || _flashQueue.length === 0) return;
  _flashBusy = true;
  const { fn, duration } = _flashQueue.shift();
  fn();
  setTimeout(() => { _flashBusy = false; _runFlashQueue(); }, duration + 80);
}

function _queueFlash(fn, duration) {
  // Drop stale flashes if queue backs up — keep at most 3 pending
  if (_flashQueue.length > 3) _flashQueue.splice(0, _flashQueue.length - 3);
  _flashQueue.push({ fn, duration });
  _runFlashQueue();
}

// Queue a renderAll() to fire after all currently-pending flashes have played.
// Use this instead of renderAll() anywhere you want the board to update
// in sync with the flash that explains the state change.
function renderWhenIdle() {
  _flashQueue.push({ fn: () => renderAll(), duration: 0 });
  _runFlashQueue();
}

function showTurnFlash(player) {
  _queueFlash(() => {
    const el = document.getElementById('turn-flash');
    const inner = document.getElementById('turn-flash-inner');
    const label = (vsComputer && player === 1) ? 'YOUR TURN'
                : (vsComputer && player === 2) ? '🤖 COMPUTER\'S TURN'
                : `PLAYER ${player}'S TURN`;
    inner.textContent = label;
    inner.className = `p${player}`;
    el.classList.add('show');
    inner.style.animation = 'none';
    void inner.offsetWidth;
    inner.style.animation = '';
    setTimeout(() => el.classList.remove('show'), 1300);
  }, 1300);
}

function showMoveFlash(attackingPlayer, attackerName, moveName, dmg, targetName, suffix) {
  // Store for opponent to see — only set on the attacker's client
  if (myRole === null || attackingPlayer === myRole) {
    G.lastMoveFlash = { attackingPlayer, attackerName, moveName, dmg, targetName, suffix, ts: Date.now() };
    G.coinFlipLog = []; // fresh log for this attack — only reset on attacker's side
  }
  const DURATION = 3000;
  _queueFlash(() => {
    const el = document.getElementById('move-flash');
    const whoEl = document.getElementById('move-flash-who');
    const attackerEl = document.getElementById('move-flash-attacker');
    const moveEl = document.getElementById('move-flash-move');
    const dmgEl = document.getElementById('move-flash-dmg');

    const isOwnAttack = myRole !== null && attackingPlayer === myRole;
    whoEl.textContent = isOwnAttack ? 'YOUR ATTACK'
      : (vsComputer ? '🤖 COMPUTER ATTACKS' : `PLAYER ${attackingPlayer} ATTACKS`);
    attackerEl.textContent = attackerName.toUpperCase();
    moveEl.textContent = moveName.toUpperCase();
    dmgEl.textContent = dmg > 0
      ? `${dmg} damage → ${targetName}${suffix ? '  ' + suffix : ''}`
      : (suffix ? suffix : `→ ${targetName}`);

    el.className = `show p${attackingPlayer}`;
    const inner = document.getElementById('move-flash-inner');
    inner.style.animation = 'none';
    void inner.offsetWidth;
    inner.style.animation = '';

    el._moveFlashUntil = Date.now() + DURATION;
    clearTimeout(el._flashTimer);
    el._flashTimer = setTimeout(() => { el.classList.remove('show'); el._moveFlashUntil = 0; }, DURATION);
  }, DURATION);
}

// Show a move flash specifically for blocked/thwarted attacks
function showBlockedFlash(attackingPlayer, attackerName, moveName, reason) {
  showMoveFlash(attackingPlayer, attackerName, moveName, 0, '', `🚫 ${reason}`);
}

// General action flash (retreat, trainer, evolve, etc.)
function showActionFlash(player, verb, subject, detail) {
  const DURATION = 2000;
  _queueFlash(() => {
    const el = document.getElementById('action-flash');
    const isOwnAction = myRole !== null && player === myRole;
    // verb is stored as third-person (PLAYS, BENCHES, EVOLVES…)
    // For "YOU" we want base form: strip trailing S (PLAYS→PLAY, BENCHES→BENCH, RETREATS→RETREAT)
    const baseVerb = verb.replace(/ES$/i, '').replace(/S$/i, '');
    const displayVerb = isOwnAction ? baseVerb : verb;
    const who = isOwnAction ? `YOU ${displayVerb}` : (vsComputer ? `🤖 COMPUTER ${displayVerb}` : `PLAYER ${player} ${displayVerb}`);
    document.getElementById('action-flash-who').textContent = who;
    document.getElementById('action-flash-subject').textContent = (subject || '').toUpperCase();
    document.getElementById('action-flash-detail').textContent = detail || '';

    el.className = 'show';
    const inner = document.getElementById('action-flash-inner');
    inner.style.animation = 'none';
    void inner.offsetWidth;
    inner.style.animation = '';

    clearTimeout(el._flashTimer);
    el._flashTimer = setTimeout(() => el.classList.remove('show'), DURATION);
  }, DURATION);
}

function showTrainerFlash(player, cardName) {
  showActionFlash(player, 'PLAYS', cardName, 'TRAINER');
}

// ══════════════════════════════════════════════════
// WIN SCREEN
// ══════════════════════════════════════════════════
function showWinScreen(winnerNum, reason) {
  const p = G.players[winnerNum];
  let displayName;
  if (vsComputer) {
    displayName = winnerNum === 1 ? '🏆 YOU WIN!' : '🤖 COMPUTER WINS';
  } else {
    displayName = p.name || `PLAYER ${winnerNum}`;
  }

  // Record win/loss — only in networked games, only if we know our role
  if (!vsComputer && myRole !== null) {
    recordResult(winnerNum === myRole);
  }

  const nameEl   = document.getElementById('win-player-name');
  const reasonEl = document.getElementById('win-reason');

  nameEl.textContent = displayName;
  nameEl.className = `p${winnerNum}`;
  reasonEl.textContent = reason || '';

  document.getElementById('win-screen').classList.add('show');
  spawnConfetti(winnerNum);
}

function playAgain() {
  document.getElementById('win-screen').classList.remove('show');
  // Clean up confetti
  document.querySelectorAll('.confetti-piece').forEach(el => el.remove());
  // Delete the room from Firebase, detach listener, reset
  if (gameRef) {
    gameRef.remove().catch(() => {}); // delete room node — no await, best-effort
    gameRef.off();
    gameRef = null;
  }
  roomCode = null; myRole = null; vsComputer = false; aiThinking = false;
  // Reset G
  G = {
    started: false, turn: 1, phase: 'SETUP', turnNum: 0,
    energyPlayedThisTurn: false, plusPowerActive: false,
    pendingAction: null, pendingPromotion: null, pendingExtraDraws: 0,
    players: {
      1: { name:'Player 1', deck:[], hand:[], active:null, bench:[null,null,null,null,null], prizes:[], discard:[], deckData:null, mulligans:0 },
      2: { name:'Player 2', deck:[], hand:[], active:null, bench:[null,null,null,null,null], prizes:[], discard:[], deckData:null, mulligans:0 }
    },
    log: []
  };
  // Show setup screen / lobby
  document.getElementById('setup-screen').style.display = '';
  showPanel('lobby-panel');
  setMidline('Load decks and press Start Game');
}

// Leave the current game and return to lobby WITHOUT deleting the Firebase room.
// The game stays alive and can be rejoined via MATCHES.
function returnToLobby() {
  // Detach listener but keep the room in Firebase
  if (gameRef) {
    gameRef.off();
    gameRef = null;
  }
  roomCode = null; myRole = null; vsComputer = false; aiThinking = false;
  G = {
    started: false, turn: 1, phase: 'SETUP', turnNum: 0,
    energyPlayedThisTurn: false, plusPowerActive: false,
    pendingAction: null, pendingPromotion: null, pendingExtraDraws: 0,
    players: {
      1: { name:'Player 1', deck:[], hand:[], active:null, bench:[null,null,null,null,null], prizes:[], discard:[], deckData:null, mulligans:0 },
      2: { name:'Player 2', deck:[], hand:[], active:null, bench:[null,null,null,null,null], prizes:[], discard:[], deckData:null, mulligans:0 }
    },
    log: []
  };
  document.getElementById('win-screen').classList.remove('show');
  document.querySelectorAll('.confetti-piece').forEach(el => el.remove());
  document.getElementById('setup-screen').style.display = '';
  showLobby();
  setMidline('Load decks and press Start Game');
}

function viewBoard() {
  // Just close the overlay so they can see the final board state
  document.getElementById('win-screen').classList.remove('show');
  document.querySelectorAll('.confetti-piece').forEach(el => el.remove());
}

function spawnConfetti(winnerNum) {
  const colors = winnerNum === 1
    ? ['#5b9cf6','#a8d0ff','#ffffff','#e8c84a']
    : ['#f56565','#ffb3b3','#ffffff','#e8c84a'];
  const count = 80;
  for (let i = 0; i < count; i++) {
    setTimeout(() => {
      const el = document.createElement('div');
      el.className = 'confetti-piece';
      el.style.left = Math.random() * 100 + 'vw';
      el.style.top  = -10 + 'px';
      el.style.background = colors[Math.floor(Math.random() * colors.length)];
      el.style.width  = (6 + Math.random() * 8) + 'px';
      el.style.height = (8 + Math.random() * 10) + 'px';
      const dur = 1.8 + Math.random() * 2.2;
      el.style.animationDuration = dur + 's';
      el.style.animationDelay   = '0s';
      document.body.appendChild(el);
      setTimeout(() => el.remove(), dur * 1000 + 100);
    }, i * 30);
  }
}

// ══════════════════════════════════════════════════
// CARD PICKER MODAL
// ══════════════════════════════════════════════════
let _cardPickerResolve = null;
let _cardPickerSelected = [];
let _cardPickerMax = 1;
let _cardPickerCards = []; // cards array for energy value calculation

async function openCardPicker({ title, subtitle, cards, maxSelect = 1, showDone = false } = {}) {
  // In VS Computer mode, if it's the AI's turn, auto-pick the first valid card
  if (vsComputer && G.turn === 2) {
    if (!cards || !cards.length) return Promise.resolve(null);
    return Promise.resolve([0]); // AI always picks first option
  }
  // Wait a frame so any previously-closing modal/overlay fully hides before we show
  await new Promise(r => requestAnimationFrame(r));

  return new Promise(resolve => {
    _cardPickerResolve = resolve;
    const options = { showDone };
    _cardPickerSelected = [];
    _cardPickerMax = maxSelect;
    _cardPickerCards = cards;

    document.getElementById('card-picker-title').textContent = title;
    document.getElementById('card-picker-subtitle').textContent = subtitle || '';
    document.getElementById('card-picker-confirm').disabled = maxSelect > 0;

    const grid = document.getElementById('card-picker-grid');
    // Use fewer columns for large lists (e.g. Computer Search showing full deck)
    // so cards aren't too narrow to read
    const cols = cards.length > 10 ? 3 : cards.length > 4 ? 4 : Math.max(1, cards.length);
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    // Narrow the modal based on card count and type
    const box = document.querySelector('#card-picker-modal .modal-box');
    if (box) {
      const allEnergy = cards.every(c => c.supertype === 'Energy');
      const cardW = allEnergy ? 100 : 130; // energy cards display narrower
      const minW  = allEnergy ? 180 : 280; // tighter minimum for energy pickers
      const padding = 56; // modal padding + border
      const idealW = Math.min(460, Math.max(minW, cols * cardW + padding));
      box.style.width = idealW + 'px';
    }
    grid.innerHTML = cards.map((card, i) => {
      const energy = (card.attachedEnergy || []);
      const energyHtml = energy.length
        ? `<div class="picker-card-meta">${energy.flatMap(e => /double colorless/i.test(e.name) ? [energyIcon('Colorless Energy', 12), energyIcon('Colorless Energy', 12)] : [energyIcon(e.name, 12)]).join('')}</div>`
        : '';
      const dmg = card.damage ? `<div class="picker-card-meta">${damageCounters(card.damage)}</div>` : '';
      const status = card.status ? `<div class="picker-card-meta" style="color:var(--accent)">${statusEmoji(card.status)} ${card.status}</div>` : '';
      const isEnergy = card.supertype === 'Energy';
      return `
        <div class="picker-card${isEnergy ? ' is-energy' : ''}" id="picker-card-${i}"
          onclick="event.stopPropagation();togglePickerCard(${i})">
          <img src="${card.images?.small || ''}" alt="${card.name}">
          <div class="picker-card-name">${card.name}</div>
          ${energyHtml}${dmg}${status}
          <div class="sel-badge">✓</div>
        </div>
      `;
    }).join('');

    // Show/hide DONE button based on caller's preference
    const doneBtn = document.getElementById('card-picker-done');
    if (doneBtn) doneBtn.style.display = options.showDone ? '' : 'none';
    document.getElementById('card-picker-modal').classList.add('show');
  });
}

function togglePickerCard(idx) {
  const el = document.getElementById(`picker-card-${idx}`);
  const alreadySelected = _cardPickerSelected.includes(idx);

  if (alreadySelected) {
    _cardPickerSelected = _cardPickerSelected.filter(i => i !== idx);
    el.classList.remove('selected');
  } else {
    if (_cardPickerSelected.length >= _cardPickerMax) {
      // Deselect oldest if at max
      const oldest = _cardPickerSelected.shift();
      document.getElementById(`picker-card-${oldest}`)?.classList.remove('selected');
    }
    _cardPickerSelected.push(idx);
    el.classList.add('selected');
  }

  const confirmBtn = document.getElementById('card-picker-confirm');
  confirmBtn.disabled = _cardPickerSelected.length === 0;

  // Update subtitle with selection count — use energy value if cards are energy
  const sub = document.getElementById('card-picker-subtitle');
  if (_cardPickerMax > 1) {
    const allEnergy = _cardPickerCards.every(c => c.supertype === 'Energy');
    if (allEnergy && typeof energyValue === 'function') {
      const selectedCards = _cardPickerSelected.map(i => _cardPickerCards[i]);
      const val = energyValue(selectedCards);
      sub.textContent = `Selected: ${val} / ${_cardPickerMax} energy`;
    } else {
      sub.textContent = `Selected: ${_cardPickerSelected.length} / ${_cardPickerMax}`;
    }
  }
}

function confirmCardPick() {
  if (_cardPickerSelected.length === 0) return;
  document.getElementById('card-picker-modal').classList.remove('show');
  hideCardDetail();
  const result = [..._cardPickerSelected];
  _cardPickerSelected = [];
  if (_cardPickerResolve) { _cardPickerResolve(result); _cardPickerResolve = null; }
}

function cancelCardPick() {
  document.getElementById('card-picker-modal').classList.remove('show');
  hideCardDetail();
  if (_cardPickerResolve) { _cardPickerResolve(null); _cardPickerResolve = null; }
  G.pendingAction = null;
  renderAll();
}

// Resolves with sentinel 'done' — used by repeatable pickers (e.g. Damage Swap)
// to signal "finished" without cancelling the whole action
function doneCardPick() {
  document.getElementById('card-picker-modal').classList.remove('show');
  hideCardDetail();
  if (_cardPickerResolve) { _cardPickerResolve('done'); _cardPickerResolve = null; }
}

// ══════════════════════════════════════════════════
// LASS REVEAL
// ══════════════════════════════════════════════════
function showLassModal(snapshots, lassCaster) {
  const playerColor = n => n === 1 ? 'var(--p1color)' : 'var(--p2color)';
  const playerName  = n => G.players[n].name || `Player ${n}`;

  for (const pNum of [1, 2]) {
    const label = document.getElementById(`lass-p${pNum}-label`);
    const grid  = document.getElementById(`lass-p${pNum}-cards`);
    if (!label || !grid) continue;

    label.textContent = playerName(pNum) + ' HAND';
    label.style.color = playerColor(pNum);

    const cards = snapshots[pNum] || [];
    if (!cards.length) {
      grid.innerHTML = `<div style="font-size:7px;color:var(--muted);padding:8px">Empty hand</div>`;
    } else {
      grid.innerHTML = cards.map(c => `
        <div class="lass-card">
          <img src="${c.img}" alt="${c.name}" class="${c.isTrainer ? 'trainer-highlight' : ''}">
          <div class="lass-card-name">${c.name}${c.isTrainer ? ' ✕' : ''}</div>
        </div>`).join('');
    }
  }

  document.getElementById('lass-modal').classList.add('show');
}

function dismissLass() {
  document.getElementById('lass-modal').classList.remove('show');
  // Clear the pendingLass flag and push so opponent also knows it's done
  if (G.pendingLass) {
    G.pendingLass = null;
    if (myRole !== null && G.started) pushGameState();
  }
}

// ══════════════════════════════════════════════════
// POKéDEX
// ══════════════════════════════════════════════════
let _dexResolve = null;
let _dexCards = [];   // working copy, gets reordered
let _dexDragSrc = null;

function openPokedex(player) {
  return new Promise(resolve => {
    _dexResolve = resolve;
    const p = G.players[player];
    _dexCards = p.deck.slice(0, Math.min(5, p.deck.length)).map((c, i) => ({ ...c, _dexIdx: i }));
    renderDexCards();
    document.getElementById('pokedex-modal').classList.add('show');
  });
}

function renderDexCards() {
  const container = document.getElementById('pokedex-cards');
  container.innerHTML = '';
  _dexCards.forEach((card, pos) => {
    const wrap = document.createElement('div');
    wrap.className = 'dex-card-wrap';
    wrap.draggable = true;
    wrap.dataset.pos = pos;

    const imgSrc = card.images?.small || '';
    const largeSrc = card.images?.large || imgSrc;

    wrap.innerHTML = `
      <div class="dex-card-pos">${pos + 1}</div>
      <img class="dex-card-img" src="${imgSrc}" alt="${card.name}"
        onclick="event.stopPropagation();showCardDetail('${largeSrc}')">
      <div class="dex-card-label">${card.name}</div>
      <div class="dex-card-arrows">
        <button class="dex-arrow-btn" onclick="dexMove(${pos},-1)" ${pos === 0 ? 'disabled' : ''}>◀</button>
        <button class="dex-arrow-btn" onclick="dexMove(${pos},1)" ${pos === _dexCards.length - 1 ? 'disabled' : ''}>▶</button>
      </div>`;

    // Drag events
    wrap.addEventListener('dragstart', e => {
      _dexDragSrc = pos;
      wrap.classList.add('dex-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    wrap.addEventListener('dragend', () => {
      wrap.classList.remove('dex-dragging');
      document.querySelectorAll('.dex-card-wrap').forEach(w => w.classList.remove('dex-over'));
    });
    wrap.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.dex-card-wrap').forEach(w => w.classList.remove('dex-over'));
      wrap.classList.add('dex-over');
    });
    wrap.addEventListener('drop', e => {
      e.preventDefault();
      if (_dexDragSrc === null || _dexDragSrc === pos) return;
      const moved = _dexCards.splice(_dexDragSrc, 1)[0];
      _dexCards.splice(pos, 0, moved);
      _dexDragSrc = null;
      renderDexCards();
    });

    container.appendChild(wrap);
  });
}

function dexMove(pos, dir) {
  const target = pos + dir;
  if (target < 0 || target >= _dexCards.length) return;
  [_dexCards[pos], _dexCards[target]] = [_dexCards[target], _dexCards[pos]];
  renderDexCards();
}

function confirmPokedex() {
  // Find which player owns this deck call
  // We need to put _dexCards back as the top N cards of the deck
  // Determine player from whose turn it is
  const player = G.turn;
  const p = G.players[player];
  const n = _dexCards.length;
  // Replace top n cards with reordered set
  p.deck.splice(0, n, ..._dexCards);
  addLog(`P${player} used Pokédex — rearranged top ${n} card(s) of their deck.`, true);
  document.getElementById('pokedex-modal').classList.remove('show');
  if (_dexResolve) { _dexResolve(); _dexResolve = null; }
}

function cancelPokedex() {
  // Cards go back in original order (we didn't touch the real deck yet)
  const player = G.turn;
  addLog(`P${player} used Pokédex — viewed top cards but kept original order.`, true);
  document.getElementById('pokedex-modal').classList.remove('show');
  if (_dexResolve) { _dexResolve(); _dexResolve = null; }
}