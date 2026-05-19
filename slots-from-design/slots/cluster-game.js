/* ==========================================================
 * SUGAR.LAB — UI controller for cluster slot
 * ========================================================== */
const $ = (q, el=document) => el.querySelector(q);
const $$ = (q, el=document) => Array.from(el.querySelectorAll(q));
const engine = new ClusterEngine();

const gridEl     = $('#grid');
const gridFrame  = $('#gridFrame');
const balanceEl  = $('#balance');
const lastWinEl  = $('#lastWin');
const stakeValEl = $('#stakeVal');
const stakeFiatEl= $('#stakeFiat');
const totalBetEl = $('#totalBet');
const stakeUpBtn = $('#stakeUp');
const stakeDnBtn = $('#stakeDn');
const spinBtn    = $('#spinBtn');
const autoBtn    = $('#autoBtn');
const turboBtn   = $('#turboBtn');
const buyBonusBtn= $('#buyBonus');
const buyBonusPrice = $('#buyBonusPrice');
const freeSpinsBadge = $('#freeSpinsBadge');
const freeSpinsCount = $('#freeSpinsCount');
const bigwinOv   = $('#bigwinOv');
const fsIntro    = $('#fsIntro');
const tickerList = $('#tickerList');
const fairClient = $('#fairClient');
const fairServer = $('#fairServer');
const fairNonce  = $('#fairNonce');
const winHud     = $('#winHud');
const winHudChain= $('#winHudChain');
const winHudAmt  = $('#winHudAmt');
const winHudMult = $('#winHudMult');
const heatFill   = $('#heatFill');
const heatVal    = $('#heatVal');
const jpVal      = $('#jpVal');
const soundTog   = $('#soundTog');
const chargeFill = $('#chargeFill');
const chargeBar  = $('#chargeBar');
const chargeCycle= $('#chargeCycle');
const chargePop  = $('#chargePop');
const chargeLabel= $('#chargeLabel');
const chargePrize= $('#chargePrize');
const comboBadge = $('#comboBadge');

let isSpinning = false;
let autoRemaining = 0;
let turbo = false;
let totalSpins = 0;
let totalWagered = 0;
let heat = 0; // 0..100
let jackpot = 142_318.42;

const fmt = (n, d=2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ===== render =====
function makeSlot(r, c) {
  const slot = document.createElement('div');
  slot.className = 'slot';
  slot.dataset.r = r; slot.dataset.c = c;
  slot.id = `s-${r}-${c}`;
  return slot;
}
function makeSym(symId) {
  const s = C_SYMBOLS[symId];
  const el = document.createElement('div');
  el.className = 'sym';
  el.dataset.sym = symId;
  el.textContent = s.glyph;
  return el;
}
function placeSymInSlot(symId, r, c, opts = {}) {
  const slot = $(`#s-${r}-${c}`);
  if (!slot) return null;
  // remove existing sym children (NOT orbs)
  $$('.sym', slot).forEach(el => el.remove());
  const el = makeSym(symId);
  if (opts.bouncing) el.classList.add('bouncing');
  slot.appendChild(el);
  if (opts.idle) setTimeout(() => el.classList.add('idle'), 600);
  return el;
}

function clearAllSyms() {
  $$('.sym').forEach(el => el.remove());
}

function buildGrid() {
  gridEl.innerHTML = '';
  for (let r = 0; r < C_SIZE; r++) for (let c = 0; c < C_SIZE; c++) {
    gridEl.appendChild(makeSlot(r, c));
  }
  // initial random symbols
  for (let r = 0; r < C_SIZE; r++) for (let c = 0; c < C_SIZE; c++) {
    const pool = ['L1','L2','M1','M2','M3','H1','H2','H3'];
    placeSymInSlot(pool[Math.floor(Math.random() * pool.length)], r, c, { idle: true });
  }
  buildPaytable();
}

function buildPaytable() {
  const list = $('#paytableList');
  list.innerHTML = '';
  const order = ['WILD','H1','H2','H3','M1','M2','M3','L1','L2','SCAT'];
  for (const id of order) {
    const s = C_SYMBOLS[id];
    const row = document.createElement('div');
    row.className = 'pt';
    const px = id === 'SCAT' ? '4+ → BONUS' : `5+ <b>×${s.pay5}</b> · 15+ <b>×${s.pay15}</b>`;
    const tmp = document.createElement('div');
    tmp.innerHTML = `<div class="gly" data-sym="${id}"></div><div class="info"><div class="nm">${id}</div><div class="px">${px}</div></div>`;
    // copy classes from sym style for gly preview
    row.innerHTML = '';
    // build gly div with same css var binding
    const gly = document.createElement('div');
    gly.className = 'gly';
    gly.textContent = s.glyph;
    // hack: apply style via class .sym binding by copying the per-sym vars manually:
    const v = {
      WILD: ['linear-gradient(135deg,#0e1421,#1b2238)', '#fff',     'rgba(78,227,255,.85)'],
      H1:   ['linear-gradient(135deg,#2a1018,#421a2a)', '#ff8aac', 'rgba(255,94,138,.6)'],
      H2:   ['linear-gradient(135deg,#06262e,#0a3845)', '#6cf2ff', 'rgba(78,227,255,.6)'],
      H3:   ['linear-gradient(135deg,#1c1230,#2a1c4a)', '#c8a8ff', 'rgba(183,148,255,.55)'],
      M1:   ['linear-gradient(135deg,#2c2008,#443110)', '#ffd870', 'rgba(255,200,71,.55)'],
      M2:   ['linear-gradient(135deg,#082416,#0d3a23)', '#82e6a4', 'rgba(74,222,128,.5)'],
      M3:   ['linear-gradient(135deg,#2c1608,#422010)', '#ffb070', 'rgba(255,154,60,.5)'],
      L1:   ['linear-gradient(135deg,#14161e,#1c1f2c)', '#b0bccf', 'rgba(127,138,165,.35)'],
      L2:   ['linear-gradient(135deg,#0e1620,#182230)', '#b6d4ec', 'rgba(143,179,208,.35)'],
      SCAT: ['radial-gradient(circle,#4a2a08,#1c0f02)', '#ffd870', 'rgba(255,210,85,.95)'],
    }[id];
    gly.style.cssText = `--bg:${v[0]};--col:${v[1]};--glow:${v[2]};background:${v[0]};color:${v[1]};text-shadow:0 0 8px ${v[2]}`;
    row.appendChild(gly);
    const info = document.createElement('div');
    info.className = 'info';
    info.innerHTML = `<div class="nm">${id}</div><div class="px">${px}</div>`;
    row.appendChild(info);
    list.appendChild(row);
  }
}

function updateUI() {
  balanceEl.textContent = fmt(engine.balance);
  stakeValEl.textContent = engine.stake.toFixed(2);
  stakeFiatEl.textContent = '≈ $' + (engine.stake).toFixed(2);
  totalBetEl.textContent = engine.stake.toFixed(2);
  buyBonusPrice.textContent = (engine.stake * 100).toFixed(2);
  fairClient.textContent = engine.clientSeed;
  fairServer.textContent = engine.serverSeed.slice(0,8) + '…' + engine.serverSeed.slice(-6);
  fairNonce.textContent = engine.nonce.toString().padStart(6, '0');
  heatFill.style.width = heat + '%';
  heatVal.textContent = Math.round(heat) + '%';
  // charge meter
  const fill = engine.visibleFill();
  chargeFill.style.right = (100 - fill * 100) + '%';
  chargeBar.classList.toggle('hot', fill > 0.78);
  chargeCycle.textContent = engine.chargeCycle;
  if (engine.freeSpins > 0) {
    freeSpinsBadge.classList.add('show');
    freeSpinsCount.textContent = engine.freeSpins;
    gridFrame.classList.add('bonus-mode');
    spinBtn.classList.add('bonus');
  } else {
    freeSpinsBadge.classList.remove('show');
    gridFrame.classList.remove('bonus-mode');
    spinBtn.classList.remove('bonus');
  }
}

// ===== animation primitives =====
async function popSlots(cells) {
  // cells: array of [r,c]
  // pre-shake before explode
  cells.forEach(([r, c]) => {
    const slot = $(`#s-${r}-${c}`);
    if (!slot) return;
    const sym = $('.sym', slot);
    if (sym) { sym.classList.remove('idle'); sym.classList.add('shaking'); }
  });
  await sleep(turbo ? 220 : 340);

  cells.forEach(([r, c], i) => {
    const slot = $(`#s-${r}-${c}`);
    if (!slot) return;
    const sym = $('.sym', slot);
    if (sym) { sym.classList.remove('shaking'); sym.classList.add('popping'); }
    // shockwave
    const shock = document.createElement('div');
    shock.className = 'shock';
    slot.appendChild(shock);
    setTimeout(() => shock.remove(), 600);
    // coin shower
    spawnCoinsFromSlot(slot);
    if (i < 6) SFX.symbolPop(i);
  });
  await sleep(turbo ? 240 : 380);
  // remove popped syms
  cells.forEach(([r, c]) => {
    const slot = $(`#s-${r}-${c}`);
    if (!slot) return;
    $$('.sym', slot).forEach(el => el.remove());
  });
}

// floating +amount text from a cluster centroid
function floatNumber(text, cells, color='') {
  if (!cells.length) return;
  const overlay = $('#coinOverlay');
  if (!overlay) return;
  // average centroid of cells
  let sx = 0, sy = 0;
  const ovR = overlay.getBoundingClientRect();
  for (const [r, c] of cells) {
    const slot = $(`#s-${r}-${c}`);
    if (!slot) continue;
    const sl = slot.getBoundingClientRect();
    sx += sl.left + sl.width / 2 - ovR.left;
    sy += sl.top + sl.height / 2 - ovR.top;
  }
  sx /= cells.length; sy /= cells.length;
  const el = document.createElement('div');
  el.className = 'float-num ' + color;
  el.textContent = text;
  el.style.left = sx + 'px';
  el.style.top = sy + 'px';
  overlay.appendChild(el);
  setTimeout(() => el.remove(), 1200);
}

// chain combo badge "×N CHAIN!"
function showCombo(n) {
  comboBadge.classList.remove('show');
  void comboBadge.offsetHeight;
  const label = n === 2 ? '×2 CHAIN' : n === 3 ? '×3 SUPER' : n === 4 ? '×4 ULTRA' : n === 5 ? '×5 MEGA' : '×' + n + ' EPIC';
  comboBadge.textContent = label;
  comboBadge.classList.add('show');
}

async function tumbleDrop(beforeGrid, afterGrid, removed) {
  // For each column, figure out which existing symbols slide down to which new row,
  // and which new symbols fall in from above. Use top:% positioning to animate.
  const removedSet = new Set(removed.map(([r,c]) => r+','+c));
  for (let c = 0; c < C_SIZE; c++) {
    // collect surviving syms from bottom up; their DOM lives in their old slot;
    // we'll move them into new slot.
    const survivorIds = [];
    for (let r = C_SIZE - 1; r >= 0; r--) {
      if (!removedSet.has(r+','+c)) survivorIds.push(r);
    }
    // For new rows from bottom: rows C_SIZE-1, C_SIZE-2,...
    // survivors fill from bottom; rest are new symbols from top.
    const newSlotsCount = C_SIZE - survivorIds.length;
    // 1. survivors: each old row r -> new row index
    let bottom = C_SIZE - 1;
    for (const oldR of survivorIds) {
      const newR = bottom--;
      if (oldR === newR) continue;
      const oldSlot = $(`#s-${oldR}-${c}`);
      const newSlot = $(`#s-${newR}-${c}`);
      const sym = $('.sym', oldSlot);
      if (sym) {
        // We move element via DOM transplant + animate via top offset
        const oldRect = oldSlot.getBoundingClientRect();
        const newRect = newSlot.getBoundingClientRect();
        const dy = newRect.top - oldRect.top;
        sym.style.transition = 'none';
        newSlot.appendChild(sym);
        sym.style.transform = `translateY(${-dy}px)`;
        void sym.offsetHeight;
        sym.style.transition = `transform ${turbo ? 220 : 360}ms cubic-bezier(.55, .085, .68, .53)`;
        sym.style.transform = 'translateY(0)';
        setTimeout(() => { sym.style.transition = ''; }, turbo ? 240 : 380);
      }
    }
    // 2. new symbols fall from above (rows 0..newSlotsCount-1)
    for (let nr = 0; nr < newSlotsCount; nr++) {
      const targetRow = nr;
      const slot = $(`#s-${targetRow}-${c}`);
      // sym id from afterGrid
      const id = afterGrid[targetRow][c];
      // ensure prior children gone
      $$('.sym', slot).forEach(el => el.remove());
      const sym = makeSym(id);
      slot.appendChild(sym);
      const dist = (newSlotsCount - nr) * (slot.clientHeight + 6) + 100;
      sym.style.transition = 'none';
      sym.style.transform = `translateY(${-dist}px) scale(.9)`;
      void sym.offsetHeight;
      sym.style.transition = `transform ${turbo ? 320 : 480}ms cubic-bezier(.34, 1.32, .64, 1)`;
      sym.style.transform = 'translateY(0) scale(1)';
      setTimeout(() => { sym.style.transition = ''; }, turbo ? 360 : 520);
    }
  }
  await sleep(turbo ? 360 : 520);
}

function spawnCoinsFromSlot(slot, n = 4) {
  const overlay = $('#coinOverlay');
  if (!overlay) return;
  const r = slot.getBoundingClientRect();
  const ovR = overlay.getBoundingClientRect();
  const x0 = r.left + r.width / 2 - ovR.left;
  const y0 = r.top + r.height / 2 - ovR.top;
  for (let i = 0; i < n; i++) {
    const c = document.createElement('div');
    c.className = 'coin-fly';
    c.style.cssText = `position:absolute;left:${x0}px;top:${y0}px;width:14px;height:14px;border-radius:50%;background:radial-gradient(circle at 30% 30%,#fff,#ffd255 50%,#b07c10);box-shadow:0 0 12px rgba(255,210,85,.8);pointer-events:none;`;
    overlay.appendChild(c);
    const ang = Math.random() * Math.PI * 2;
    const vx = Math.cos(ang) * (60 + Math.random() * 90);
    const vy = -160 - Math.random() * 100;
    const dur = 700 + Math.random() * 400;
    const dx = vx * dur / 1000;
    const dy = vy * dur / 1000 + 0.5 * 600 * (dur/1000) ** 2;
    c.animate(
      [
        { transform: 'translate(0,0) scale(1)', opacity: 1 },
        { transform: `translate(${dx}px,${dy}px) scale(.7)`, opacity: 0 },
      ],
      { duration: dur, easing: 'cubic-bezier(.4,.1,.7,.5)' }
    ).onfinish = () => c.remove();
    if (i === 0) SFX.coinDrop(i);
  }
}

// ===== sticky multiplier orbs =====
function placeMultOrb(row, col, value) {
  const slot = $(`#s-${row}-${col}`);
  if (!slot) return;
  // already has orb?
  if ($('.mult-orb', slot)) return;
  const orb = document.createElement('div');
  orb.className = 'mult-orb';
  orb.dataset.row = row; orb.dataset.col = col; orb.dataset.value = value;
  orb.textContent = '×' + value;
  // color by tier
  const palette =
    value >= 100 ? ['#ff5e8a','#b794ff','rgba(255,94,138,.8)'] :
    value >= 25  ? ['#ffc847','#ff5ec8','rgba(255,200,71,.8)'] :
    value >= 10  ? ['#4ee3ff','#8b5cf6','rgba(78,227,255,.8)'] :
                   ['#4ade80','#4ee3ff','rgba(74,222,128,.7)'];
  orb.style.setProperty('--orb-c1', palette[0]);
  orb.style.setProperty('--orb-c2', palette[1]);
  orb.style.setProperty('--orb-glow', palette[2]);
  slot.appendChild(orb);
  SFX.multiplierLand(value);
}
function clearAllOrbs() { $$('.mult-orb').forEach(el => el.remove()); }
function fireOrbs(orbs) {
  for (const m of orbs) {
    const slot = $(`#s-${m.row}-${m.col}`);
    if (!slot) continue;
    const orb = $('.mult-orb', slot);
    if (orb) {
      orb.classList.add('firing');
      setTimeout(() => orb.classList.remove('firing'), 600);
    }
  }
}

// ===== spin sequence =====
async function doSpin(buyBonus = false) {
  if (isSpinning) return;
  SFX.click();

  if (engine.freeSpins === 0 && !buyBonus) {
    if (engine.balance < engine.stake) { flashErr(); return; }
  } else if (buyBonus) {
    if (engine.balance < engine.stake * 100) { flashErr(); return; }
  }

  isSpinning = true;
  spinBtn.disabled = true;
  spinBtn.classList.add('spinning');
  gridFrame.classList.add('spinning');
  winHud.classList.remove('show');

  if (!engine.freeSpins) clearAllOrbs();

  // ---- pre-spin "shuffle" animation ----
  SFX.startReelLoop();
  // shake all syms slightly
  $$('.sym').forEach(s => { s.classList.remove('idle'); s.style.transform = 'scale(.92)'; });
  await sleep(turbo ? 140 : 280);

  // engine generates final
  const result = engine.spin(buyBonus);
  if (result?.error) {
    SFX.stopReelLoop();
    isSpinning = false;
    spinBtn.disabled = false;
    spinBtn.classList.remove('spinning');
    gridFrame.classList.remove('spinning');
    flashErr();
    return;
  }
  totalSpins++;
  totalWagered += (buyBonus ? engine.stake * 100 : (result.isFree ? 0 : engine.stake));

  // ---- initial drop ----
  // remove all current syms, drop in initial grid from top
  clearAllSyms();
  const initial = result.steps[0].grid;
  for (let c = 0; c < C_SIZE; c++) {
    for (let r = 0; r < C_SIZE; r++) {
      const slot = $(`#s-${r}-${c}`);
      const sym = makeSym(initial[r][c]);
      slot.appendChild(sym);
      const dist = (C_SIZE - r) * (slot.clientHeight + 6) + 80;
      sym.style.transition = 'none';
      sym.style.transform = `translateY(${-dist}px)`;
      void sym.offsetHeight;
      const delay = c * (turbo ? 22 : 45) + r * (turbo ? 16 : 32);
      sym.style.transition = `transform ${turbo ? 380 : 600}ms cubic-bezier(.34, 1.32, .64, 1) ${delay}ms`;
      sym.style.transform = 'translateY(0)';
    }
  }
  // last reel-stop click
  for (let i = 0; i < 7; i++) {
    setTimeout(() => SFX.reelStop(i), i * (turbo ? 22 : 45) + 200);
  }
  await sleep(turbo ? 600 : 900);
  SFX.stopReelLoop();

  // scatter accent
  if (result.scatters >= 3) {
    SFX.scatterLand(result.scatters);
    document.body.classList.add('shake-1');
    setTimeout(() => document.body.classList.remove('shake-1'), 400);
  }

  // ---- cascade chain ----
  let grid = initial.map(r => r.slice());
  let chainCount = 0;
  let runningWin = 0;
  let i = 1;
  while (i < result.steps.length) {
    const step = result.steps[i];
    if (step.type === 'cascade') {
      chainCount++;
      runningWin += step.stepWin;

      // fire any orbs that contributed
      if (step.multApplied > 0) {
        // find orbs in winning cells
        const wc = new Set(step.winningCells);
        const fired = engine.stickyMults.filter(m => wc.has(m.row + ',' + m.col));
        fireOrbs(fired);
      }

      // show HUD
      winHud.classList.add('show');
      winHudChain.textContent = chainCount;
      winHudAmt.textContent = '+' + fmt(runningWin);
      if (step.multApplied > 0) {
        winHudMult.textContent = '×' + step.multApplied;
        winHudMult.style.display = '';
      } else {
        winHudMult.style.display = 'none';
      }

      SFX.cascadeChime(chainCount);

      // float "+amount" per cluster
      for (const cl of step.clusters) {
        const mult = step.multApplied || 1;
        const amt = cl.payout * mult;
        floatNumber('+' + fmt(amt), cl.cells, mult > 1 ? 'pink' : (cl.size >= 10 ? 'cyan' : ''));
      }

      // chain combo badge from 2nd cascade onward
      if (chainCount >= 2) showCombo(chainCount);

      // pop animation
      const cells = step.winningCells.map(s => s.split(',').map(Number));
      await popSlots(cells);
    } else if (step.type === 'tumble') {
      // figure removed cells from preceding cascade step
      const prev = result.steps[i - 1];
      const removed = prev.winningCells.map(s => s.split(',').map(Number));
      // drop in new
      await tumbleDrop(grid, step.grid, removed);
      grid = step.grid.map(r => r.slice());
      // place new orbs (if free spins) after drop
      for (const m of step.newMults) placeMultOrb(m.row, m.col, m.value);
    }
    i++;
  }

  // win finalize
  if (result.totalWin > 0) {
    lastWinEl.textContent = '+' + fmt(result.totalWin) + ' STT';
    lastWinEl.classList.remove('zero');
    heat = Math.max(0, heat - 30); // wins cool the meter
    if (result.totalWin / engine.stake >= 5) {
      pushTicker({ who: 'YOU', amount: result.totalWin, fresh: true, mega: result.totalWin / engine.stake >= 25 });
    }
  } else {
    lastWinEl.textContent = '— no win';
    lastWinEl.classList.add('zero');
    heat = Math.min(100, heat + 9); // misses heat up
  }

  // give idle animation back
  setTimeout(() => $$('.sym').forEach(s => s.classList.add('idle')), 400);

  // hide HUD after short delay
  setTimeout(() => winHud.classList.remove('show'), 1800);

  // bonus triggered?
  if (result.triggered) {
    await sleep(500);
    SFX.bonusTrigger();
    await showFsIntro(result.freeSpinsAwarded);
  }

  // big win popup
  if (result.totalWin > 0) {
    const t = tier(result.totalWin, engine.stake);
    if (t) {
      await sleep(400);
      await bigWinSequence(result.totalWin, t);
    }
  }

  // bonus ended summary
  if (result.bonusEnded) {
    await sleep(400);
    await bonusEndSummary(result.bonusEndedTotal);
  }

  // CHARGE METER: animate the meter to its new value (handled by updateUI later),
  // and fire the reward popup if one came in.
  if (result.chargeReward) {
    await sleep(450);
    await chargeRewardSequence(result.chargeReward);
  }

  updateUI();
  isSpinning = false;
  spinBtn.disabled = false;
  spinBtn.classList.remove('spinning');
  gridFrame.classList.remove('spinning');

  // chain free spins
  if (engine.freeSpins > 0) {
    await sleep(turbo ? 260 : 700);
    doSpin(false);
    return;
  }

  // autospin
  if (autoRemaining > 0) {
    autoRemaining--;
    updateAutoLabel();
    if (autoRemaining > 0 && engine.balance >= engine.stake) {
      setTimeout(() => doSpin(false), turbo ? 260 : 600);
    } else {
      autoRemaining = 0;
      autoBtn.classList.remove('active');
      autoBtn.querySelector('.lbl').textContent = 'AUTO';
    }
  }
}

function tier(amount, stake) {
  const x = amount / stake;
  if (x >= 100) return 'EPIC';
  if (x >= 50)  return 'MEGA';
  if (x >= 20)  return 'BIG';
  return null;
}

async function bigWinSequence(amount, t) {
  const ov = bigwinOv;
  ov.querySelector('.tier').textContent = t === 'BIG' ? 'BIG WIN' : t === 'MEGA' ? 'MEGA WIN' : 'EPIC WIN';
  ov.querySelector('.tier').className = 'tier ' + (t === 'MEGA' ? 'mega' : t === 'EPIC' ? 'epic' : '');
  const amtEl = ov.querySelector('.amount');
  ov.classList.add('show');
  document.body.classList.add(t === 'EPIC' ? 'shake-3' : t === 'MEGA' ? 'shake-2' : 'shake-1');
  setTimeout(() => document.body.classList.remove('shake-1','shake-2','shake-3'), 900);
  SFX.bigWin(t);
  burstParticles(t === 'EPIC' ? 240 : t === 'MEGA' ? 160 : 90);
  let v = 0;
  const dur = t === 'EPIC' ? 3000 : t === 'MEGA' ? 2200 : 1400;
  const start = performance.now();
  await new Promise((resolve) => {
    const tick = (now) => {
      const p = Math.min(1, (now - start) / dur);
      v = amount * (1 - Math.pow(1 - p, 3));
      amtEl.textContent = '+' + fmt(v) + ' STT';
      if (p < 1) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
  await sleep(t === 'EPIC' ? 1200 : 800);
  ov.classList.remove('show');
}

async function bonusEndSummary(total) {
  bigwinOv.querySelector('.tier').textContent = 'BONUS COMPLETE';
  bigwinOv.querySelector('.tier').className = 'tier mega';
  bigwinOv.querySelector('.amount').textContent = '+' + fmt(total) + ' STT';
  bigwinOv.classList.add('show');
  SFX.bigWin('MEGA');
  burstParticles(220);
  document.body.classList.add('shake-2');
  setTimeout(() => document.body.classList.remove('shake-2'), 700);
  await sleep(2400);
  bigwinOv.classList.remove('show');
}

// ===== charge reward popup =====
async function chargeRewardSequence(reward) {
  // pre-flash: meter "completes" then explodes
  chargeFill.style.right = '0%';
  chargeBar.classList.add('hot');
  await sleep(500);

  chargeLabel.textContent = reward.label.replace('×', '× ' + (reward.multValue || ''));
  if (reward.kind === 'cash') {
    chargePrize.textContent = '+' + fmt(reward.amount) + ' STT';
    chargePrize.style.color = 'var(--gold)';
  } else if (reward.kind === 'freespin') {
    chargePrize.textContent = '+' + reward.count + ' FREE SPINS';
    chargePrize.style.color = 'var(--cyan)';
  } else if (reward.kind === 'multorb') {
    chargePrize.textContent = '×' + reward.multValue + ' MEGA MULT';
    chargePrize.style.color = 'var(--magenta)';
    chargeLabel.textContent = 'MYSTERY MULTIPLIER';
  } else if (reward.kind === 'wilds') {
    chargePrize.textContent = 'WILDS NEXT SPIN';
    chargePrize.style.color = 'var(--cyan)';
  }
  chargePop.classList.add('show');
  document.body.classList.add('shake-2');
  setTimeout(() => document.body.classList.remove('shake-2'), 700);
  burstParticles(140);
  SFX.bonusTrigger();

  // ticker
  pushTicker({
    who: 'YOU',
    amount: reward.amount || 0,
    fresh: true,
    mega: true,
    game: 'CHARGE'
  });

  await sleep(2400);
  chargePop.classList.remove('show');
  // reset bar visually
  chargeBar.classList.remove('hot');
  chargeFill.style.right = '100%';
}

async function showFsIntro(spins) {
  fsIntro.querySelector('.num').textContent = spins;
  fsIntro.classList.add('show');
  burstParticles(180);
  document.body.classList.add('shake-2');
  setTimeout(() => document.body.classList.remove('shake-2'), 600);
  await sleep(2800);
  fsIntro.classList.remove('show');
}

// particles inside bigwin overlay canvas
function burstParticles(n) {
  const canvas = $('#bigwinCanvas');
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const parts = [];
  const colors = ['#ffd255','#ff9a3c','#4ee3ff','#ff5ec8','#b794ff','#fff'];
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = 4 + Math.random() * 10;
    parts.push({
      x: w/2, y: h/2,
      vx: Math.cos(a) * v, vy: Math.sin(a) * v - 4,
      life: 1, size: 2 + Math.random()*5,
      color: colors[Math.floor(Math.random()*colors.length)],
      rot: Math.random()*Math.PI*2, vr: (Math.random()-.5)*.3,
    });
  }
  const tick = () => {
    ctx.clearRect(0,0,w,h);
    let alive = false;
    for (const p of parts) {
      if (p.life <= 0) continue;
      alive = true;
      p.vy += 0.18; p.x += p.vx; p.y += p.vy; p.life -= 0.012; p.rot += p.vr;
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI*2); ctx.fill();
    }
    if (alive) requestAnimationFrame(tick); else ctx.clearRect(0,0,w,h);
  };
  tick();
}

function flashErr() {
  SFX.click();
  spinBtn.animate(
    [{ filter: 'hue-rotate(0)' }, { filter: 'hue-rotate(-90deg)' }, { filter: 'hue-rotate(0)' }],
    { duration: 400, iterations: 2 }
  );
}

function updateAutoLabel() {
  autoBtn.querySelector('.lbl').textContent = autoRemaining > 0 ? autoRemaining : 'AUTO';
}

// ticker
const FAKE = ['k1ng_3lite','m00n_x','nyx7','vaultrunner','silv3r','akira_z','crypt0duck','wyrm','0xprism','glimmr','helio.eth','rust_3','noctis','quasar','draco_x','venn','obsidian','arcaeo','sk1mmer','frost42','solare','prizm_','axiom','tessera'];
function pushTicker({ who, amount, fresh, mega, game = 'SUGAR.LAB' }) {
  const div = document.createElement('div');
  div.className = 'ticker-row ' + (fresh ? 'fresh ' : '') + (mega ? 'mega' : '');
  div.innerHTML = `<div class="who">${who}<small>${game}</small></div><div class="amt">+${fmt(amount)}<small>STT</small></div>`;
  tickerList.prepend(div);
  while (tickerList.children.length > 12) tickerList.lastElementChild.remove();
  if (fresh) setTimeout(() => div.classList.remove('fresh'), 800);
}
function fakeTicker() {
  const tick = () => {
    const mega = Math.random() < 0.18;
    pushTicker({
      who: FAKE[Math.floor(Math.random()*FAKE.length)],
      amount: mega ? 50 + Math.random()*1400 : 1 + Math.random()*50,
      mega,
      game: Math.random() < 0.5 ? 'SUGAR.LAB' : 'VAULT.7',
    });
    setTimeout(tick, 1500 + Math.random()*3800);
  };
  setTimeout(tick, 800);
}

// jackpot ambient drift
function jackpotDrift() {
  setInterval(() => {
    jackpot += Math.random() * 1.5 + .1;
    jpVal.textContent = '$' + fmt(jackpot);
  }, 600);
}

// ====== init ======
function init() {
  buildGrid();
  updateUI();
  fakeTicker();
  jackpotDrift();
  jpVal.textContent = '$' + fmt(jackpot);

  spinBtn.addEventListener('click', () => {
    if (autoRemaining > 0) { autoRemaining = 0; autoBtn.classList.remove('active'); updateAutoLabel(); return; }
    doSpin(false);
  });
  stakeUpBtn.addEventListener('click', () => { if (!isSpinning) { engine.setStake(engine.stakeIdx + 1); SFX.click(); updateUI(); }});
  stakeDnBtn.addEventListener('click', () => { if (!isSpinning) { engine.setStake(engine.stakeIdx - 1); SFX.click(); updateUI(); }});
  buyBonusBtn.addEventListener('click', () => {
    if (isSpinning || engine.freeSpins > 0) return;
    if (engine.balance < engine.stake * 100) { flashErr(); return; }
    doSpin(true);
  });
  autoBtn.addEventListener('click', () => {
    if (autoRemaining > 0) { autoRemaining = 0; autoBtn.classList.remove('active'); updateAutoLabel(); return; }
    autoRemaining = 25; autoBtn.classList.add('active'); updateAutoLabel();
    if (!isSpinning) doSpin(false);
  });
  turboBtn.addEventListener('click', () => { turbo = !turbo; turboBtn.classList.toggle('active', turbo); SFX.click(); });
  bigwinOv.addEventListener('click', () => bigwinOv.classList.remove('show'));
  fsIntro.addEventListener('click', () => fsIntro.classList.remove('show'));
  chargePop.addEventListener('click', () => chargePop.classList.remove('show'));
  soundTog.addEventListener('click', () => {
    const on = !SFX.isEnabled();
    SFX.setEnabled(on);
    soundTog.classList.toggle('muted', !on);
  });
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.repeat) { e.preventDefault(); spinBtn.click(); }
    if (e.code === 'ArrowUp')   { e.preventDefault(); stakeUpBtn.click(); }
    if (e.code === 'ArrowDown') { e.preventDefault(); stakeDnBtn.click(); }
    if (e.key === 't' || e.key === 'T') turboBtn.click();
    if (e.key === 'm' || e.key === 'M') soundTog.click();
  });

  // hover sounds
  document.querySelectorAll('.spin-btn, .buy-bonus, .bet-stepper button, .mini').forEach(el => {
    el.addEventListener('mouseenter', () => SFX.hover());
  });
}

document.addEventListener('DOMContentLoaded', init);
