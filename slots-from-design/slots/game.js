/* ==========================================================
 * VAULT.7 — UI / animation controller
 * ========================================================== */

const $ = (q, el=document) => el.querySelector(q);
const $$ = (q, el=document) => Array.from(el.querySelectorAll(q));

const engine = new SlotEngine();

// ---------- DOM refs ----------
const reelsEl    = $('#reels');
const paylineSvg = $('#paylineSvg');
const balanceEl  = $('#balance');
const lastWinEl  = $('#lastWin');
const winCounter = $('#winCounter');
const winCounterAmt = $('#winCounterAmt');
const stakeValEl = $('#stakeVal');
const stakeFiatEl= $('#stakeFiat');
const totalBetEl = $('#totalBet');
const linesEl    = $('#linesVal');
const stakeUpBtn = $('#stakeUp');
const stakeDnBtn = $('#stakeDn');
const spinBtn    = $('#spinBtn');
const autoBtn    = $('#autoBtn');
const turboBtn   = $('#turboBtn');
const buyBonusBtn= $('#buyBonus');
const buyBonusPrice = $('#buyBonusPrice');
const freeSpinsBadge = $('#freeSpinsBadge');
const freeSpinsCount = $('#freeSpinsCount');
const reelsFrame = $('#reelsFrame');
const bigwinOv   = $('#bigwinOv');
const fsIntro    = $('#fsIntro');
const tickerList = $('#tickerList');
const fairClient = $('#fairClient');
const fairServer = $('#fairServer');
const fairNonce  = $('#fairNonce');
const statSpins  = $('#statSpins');
const statWagered= $('#statWagered');
const statWon    = $('#statWon');
const stagePill  = $('#stagePill');

// ---------- state ----------
let isSpinning = false;
let autoRemaining = 0;
let turbo = false;
let totalSpinsSession = 0;
let totalWagered = 0;
let totalWon = 0;

// ---------- helpers ----------
const fmt = (n) => {
  const s = Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return s;
};
const symMeta = (id) => SYMBOLS[id];

function cellHTML(symId, animKey='') {
  const s = symMeta(symId);
  return `<div class="cell kind-${s.kind}" data-sym="${symId}" data-anim="${animKey}">
    <div class="glyph">
      <span class="sym sym-${symId === 'A'||symId==='F'||symId==='D'||symId==='E' ? symId : s.id}">${s.glyph}</span>
    </div>
  </div>`;
}

// build initial reels (5 cols × 3 visible cells)
function buildReels() {
  reelsEl.innerHTML = '';
  for (let c = 0; c < 5; c++) {
    const reel = document.createElement('div');
    reel.className = 'reel';
    reel.dataset.col = c;
    const strip = document.createElement('div');
    strip.className = 'reel-strip';
    strip.dataset.col = c;
    const initSeq = [
      ['DIAM','BOLT','A'],
      ['CRYS','COIN','F'],
      ['WILD','DIAM','D'],
      ['BOLT','E','CRYS'],
      ['COIN','A','DIAM'],
    ][c];
    for (const s of initSeq) {
      const wrap = document.createElement('div');
      wrap.innerHTML = cellHTML(s);
      strip.appendChild(wrap.firstElementChild);
    }
    reel.appendChild(strip);
    reelsEl.appendChild(reel);
  }
  sizeReels();
}

// Lock reel heights to (cellW * 3). Called once on load + on resize.
function sizeReels() {
  const reels = $$('.reel');
  if (!reels.length) return;
  const w = reels[0].clientWidth;
  const cellH = Math.round(w); // square cells
  for (const r of reels) {
    r.style.height = (cellH * 3) + 'px';
    // size all current cells
    $$('.cell', r).forEach(c => c.style.height = cellH + 'px');
  }
}

window.addEventListener('resize', () => {
  if (isSpinning) return;
  sizeReels();
});

function updateUI() {
  balanceEl.textContent = fmt(engine.balance);
  stakeValEl.textContent = engine.stake.toFixed(2);
  stakeFiatEl.textContent = '≈ $' + (engine.stake * 1.00).toFixed(2);
  totalBetEl.textContent = engine.stake.toFixed(2);
  buyBonusPrice.textContent = (engine.stake * 75).toFixed(2);
  fairClient.textContent = engine.clientSeed;
  fairServer.textContent = engine.serverSeed.slice(0,8) + '…' + engine.serverSeed.slice(-6) + ' (hashed)';
  fairNonce.textContent  = engine.nonce.toString().padStart(6, '0');
  statSpins.textContent  = totalSpinsSession;
  statWagered.textContent= fmt(totalWagered);
  statWon.textContent    = fmt(totalWon);
  if (engine.freeSpins > 0) {
    freeSpinsBadge.classList.add('show');
    freeSpinsCount.textContent = engine.freeSpins;
    reelsFrame.classList.add('bonus-mode');
    spinBtn.classList.add('bonus');
    stagePill.classList.add('bonus');
    stagePill.querySelector('span:last-child').textContent = 'FREE SPINS · ×' + engine.freeSpinMult;
  } else {
    freeSpinsBadge.classList.remove('show');
    reelsFrame.classList.remove('bonus-mode');
    spinBtn.classList.remove('bonus');
    stagePill.classList.remove('bonus');
    stagePill.querySelector('span:last-child').textContent = isSpinning ? 'SPINNING' : 'READY';
  }
}

// ---------- spin animation ----------
async function spinAnimation(finalGrid, scatterCount) {
  const reels = $$('.reel');
  const strips = reels.map(r => $('.reel-strip', r));
  const finalSeq = finalGrid; // [col][row]

  // Each reel's viewport is exactly 3*cellW tall (set by sizeReels()).
  // Cell height = reel width.
  const cellH = reels[0].clientWidth;
  const SCROLL_CELLS = 24;

  // Build for each column a strip whose LAST 3 cells are the final result.
  // Total cells = SCROLL_CELLS + 3.
  // Start position translates strip so the FIRST 3 fake cells are visible (translateY(0)).
  // End position translates by -(SCROLL_CELLS * cellH) so the LAST 3 (final) are visible.
  for (let c = 0; c < 5; c++) {
    const strip = strips[c];
    strip.style.transition = 'none';
    strip.innerHTML = '';
    const total = SCROLL_CELLS + 3;
    for (let i = 0; i < total; i++) {
      const isFinal = i >= SCROLL_CELLS;
      const s = isFinal
        ? finalSeq[c][i - SCROLL_CELLS]
        : REEL_STRIPS[c][Math.floor(Math.random() * REEL_STRIPS[c].length)];
      const wrap = document.createElement('div');
      wrap.innerHTML = cellHTML(s);
      const cell = wrap.firstElementChild;
      cell.style.height = cellH + 'px';
      strip.appendChild(cell);
    }
    strip.style.transform = `translateY(0px)`;
    void strip.offsetHeight; // force layout
  }

  return new Promise((resolve) => {
    const baseDelay = turbo ? 60 : 130;
    const baseDur = turbo ? 420 : 950;
    let stopped = 0;
    const endY = -(SCROLL_CELLS * cellH);

    for (let c = 0; c < 5; c++) {
      const strip = strips[c];
      const dur = baseDur + c * (turbo ? 90 : 220);
      const delay = c * baseDelay;
      setTimeout(() => {
        // 1) main scroll with overshoot via cubic-bezier
        strip.style.transition = `transform ${dur}ms cubic-bezier(.25, .1, .25, 1.18)`;
        strip.style.transform = `translateY(${endY - cellH * 0.18}px)`; // overshoot down

        if (c >= 2) {
          const scatSoFar = finalSeq.slice(0, c + 1).reduce((acc, col) => acc + col.filter(s => s === 'SCAT').length, 0);
          if (scatSoFar === 2 && c < 4) {
            const nextReel = reels[c + 1];
            setTimeout(() => nextReel.classList.add('anticipating'), Math.max(0, dur - 250));
          }
        }

        // 2) settle bounce back to exact position
        setTimeout(() => {
          strip.style.transition = `transform 220ms cubic-bezier(.34, 1.56, .64, 1)`;
          strip.style.transform = `translateY(${endY}px)`;
        }, dur);

        // 3) done
        setTimeout(() => {
          strip.style.transition = 'none';
          reels[c].classList.remove('anticipating');
          stopped++;
          if (stopped === 5) resolve();
        }, dur + 230);
      }, delay);
    }
  });
}

// ---------- win highlight ----------
function clearWinFX() {
  $$('.cell.winning').forEach(el => el.classList.remove('winning', 'scatter-win'));
  $$('.cell.dim').forEach(el => el.classList.remove('dim'));
  paylineSvg.innerHTML = '';
  winCounter.classList.remove('show');
}

function getVisibleCells() {
  // last 3 cells of each strip are visible
  const cols = $$('.reel-strip').map(s => Array.from(s.children).slice(-3));
  return cols; // [col][row]
}

async function showWins(result) {
  const cols = getVisibleCells();
  const winningSet = new Set();
  for (const w of result.wins) for (const [c, r] of w.cells) winningSet.add(c+','+r);
  for (const [c, r] of result.scatterCells) if (result.scatterCount >= 3) winningSet.add(c+','+r);

  if (winningSet.size === 0) return;

  // dim non-winning
  for (let c = 0; c < 5; c++) for (let r = 0; r < 3; r++) {
    if (!winningSet.has(c+','+r)) cols[c][r].classList.add('dim');
  }
  // highlight wins
  for (const w of result.wins) for (const [c, r] of w.cells) cols[c][r].classList.add('winning');
  if (result.scatterCount >= 3) for (const [c, r] of result.scatterCells) {
    cols[c][r].classList.add('winning', 'scatter-win');
  }

  // draw paylines on SVG
  const frame = reelsEl.getBoundingClientRect();
  paylineSvg.setAttribute('viewBox', `0 0 ${frame.width} ${frame.height}`);
  paylineSvg.innerHTML = '';
  // each line svg fires its own animation; we space them apart
  for (let i = 0; i < result.wins.length; i++) {
    const w = result.wins[i];
    const pl = PAYLINES[w.line];
    const pts = [];
    for (let c = 0; c < w.count; c++) {
      const cell = cols[c][pl[c]];
      const r = cell.getBoundingClientRect();
      const cx = r.left + r.width/2 - frame.left;
      const cy = r.top + r.height/2 - frame.top;
      pts.push([cx, cy]);
    }
    const d = pts.map((p, i) => (i === 0 ? `M${p[0]} ${p[1]}` : `L${p[0]} ${p[1]}`)).join(' ');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.style.animationDelay = (i * 0.12) + 's';
    // color by symbol kind
    const k = SYMBOLS[w.sym].kind;
    path.style.stroke = k === 'wild' ? '#fff' : (k === 'high' ? 'var(--cyan)' : (k === 'mid' ? 'var(--gold)' : 'var(--purple)'));
    paylineSvg.appendChild(path);
  }

  // win counter
  const target = result.total;
  if (target > 0) {
    winCounter.classList.add('show');
    let v = 0;
    const step = Math.max(target / (turbo ? 25 : 50), 0.01);
    const tick = () => {
      v = Math.min(target, v + step);
      winCounterAmt.textContent = fmt(v);
      if (v < target) requestAnimationFrame(tick);
    };
    tick();
  }
}

// ---------- big win popup ----------
function tier(amount, stake) {
  const x = amount / stake;
  if (x >= 50) return 'EPIC';
  if (x >= 25) return 'MEGA';
  if (x >= 10) return 'BIG';
  return null;
}

async function bigWinSequence(amount, stake) {
  const t = tier(amount, stake);
  if (!t) return;
  // screen shake
  document.body.classList.add(t === 'EPIC' ? 'shake-3' : t === 'MEGA' ? 'shake-2' : 'shake-1');
  setTimeout(() => document.body.classList.remove('shake-1', 'shake-2', 'shake-3'), 800);

  bigwinOv.querySelector('.tier').textContent = t === 'BIG' ? 'BIG WIN' : t === 'MEGA' ? 'MEGA WIN' : 'EPIC WIN';
  bigwinOv.querySelector('.tier').className = 'tier ' + (t === 'MEGA' ? 'mega' : t === 'EPIC' ? 'epic' : '');
  const amtEl = bigwinOv.querySelector('.amount');
  bigwinOv.classList.add('show');
  burstParticles(t === 'EPIC' ? 220 : t === 'MEGA' ? 140 : 80);
  let v = 0;
  const dur = t === 'EPIC' ? 3200 : t === 'MEGA' ? 2400 : 1500;
  const start = performance.now();
  await new Promise((resolve) => {
    const tick = (now) => {
      const p = Math.min(1, (now - start) / dur);
      v = amount * (1 - Math.pow(1 - p, 3));
      amtEl.textContent = '+' + fmt(v);
      if (p < 1) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
  await sleep(t === 'EPIC' ? 1200 : 800);
  bigwinOv.classList.remove('show');
}

// ---------- particle burst ----------
function burstParticles(n) {
  const canvas = $('#particleCanvas');
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const parts = [];
  const colors = ['#ffc847', '#ff9a3c', '#4ee3ff', '#b794ff', '#fff'];
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = 4 + Math.random() * 9;
    parts.push({
      x: w/2, y: h/2,
      vx: Math.cos(a) * v, vy: Math.sin(a) * v - 4,
      life: 1, size: 2 + Math.random()*4,
      color: colors[Math.floor(Math.random()*colors.length)]
    });
  }
  let raf;
  const tick = () => {
    ctx.clearRect(0,0,w,h);
    let alive = false;
    for (const p of parts) {
      if (p.life <= 0) continue;
      alive = true;
      p.vy += 0.18; p.x += p.vx; p.y += p.vy; p.life -= 0.012;
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI*2); ctx.fill();
    }
    if (alive) raf = requestAnimationFrame(tick); else ctx.clearRect(0,0,w,h);
  };
  tick();
}

// ---------- bonus intro screen ----------
async function showFreeSpinIntro(spins, mult) {
  fsIntro.querySelector('.num').textContent = spins;
  fsIntro.querySelector('.mult b').textContent = '×' + mult;
  fsIntro.classList.add('show');
  burstParticles(180);
  document.body.classList.add('shake-2');
  setTimeout(() => document.body.classList.remove('shake-2'), 600);
  await sleep(3200);
  fsIntro.classList.remove('show');
}

// ---------- ticker ----------
const FAKE_NAMES = ['k1ng_3lite','m00n_x','nyx7','vaultrunner','silv3r','akira_z','crypt0duck','wyrm','0xprism','glimmr','helio.eth','rust_3','noctis','quasar','draco_x','venn','obsidian','arcaeo','sk1mmer','frost42','solare','prizm_','axiom','tessera'];
const TICKER_MAX = 12;
function pushTicker(row) {
  const div = document.createElement('div');
  div.className = 'ticker-row ' + (row.fresh ? 'fresh ' : '') + (row.mega ? 'mega' : '');
  div.innerHTML = `
    <div class="who">${row.who}<small>${row.game}</small></div>
    <div class="amt">+${fmt(row.amount)}<small>STT</small></div>`;
  tickerList.prepend(div);
  while (tickerList.children.length > TICKER_MAX) tickerList.lastElementChild.remove();
  if (row.fresh) setTimeout(() => div.classList.remove('fresh'), 800);
}

function fakeTickerLoop() {
  // background drip — other "players" winning
  const tick = () => {
    const isMega = Math.random() < 0.18;
    const amount = isMega ? 50 + Math.random()*1200 : 1 + Math.random()*40;
    pushTicker({
      who: FAKE_NAMES[Math.floor(Math.random()*FAKE_NAMES.length)],
      game: 'VAULT.7',
      amount,
      mega: isMega
    });
    setTimeout(tick, 1800 + Math.random()*4200);
  };
  setTimeout(tick, 1200);
}

// ---------- core spin ----------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function doSpin(buyBonus=false) {
  if (isSpinning) return;
  clearWinFX();
  const result = engine.spin(buyBonus);
  if (result?.error === 'insufficient') {
    flashErr();
    return;
  }
  if (!result?.isFree && !buyBonus) {
    totalSpinsSession++;
    totalWagered += engine.stake;
  } else if (buyBonus) {
    totalSpinsSession++;
    totalWagered += engine.stake * 75;
  }
  isSpinning = true;
  spinBtn.classList.add('spinning');
  spinBtn.disabled = true;
  stagePill.querySelector('span:last-child').textContent = 'SPINNING';
  updateUI();

  await spinAnimation(result.grid, result.scatterCount);

  // resolve wins
  totalWon += result.total;
  if (result.total > 0) {
    lastWinEl.textContent = '+' + fmt(result.total) + ' STT';
    lastWinEl.classList.remove('zero');
    await showWins(result);
    // own win in ticker
    if (result.total / engine.stake >= 5) {
      pushTicker({ who: 'YOU', game: 'VAULT.7', amount: result.total, fresh: true, mega: result.total / engine.stake >= 25 });
    }
  } else {
    lastWinEl.textContent = '— no win';
    lastWinEl.classList.add('zero');
  }

  // bonus triggers
  if (result.triggeredBonus && !buyBonus) {
    await sleep(700);
    await showFreeSpinIntro(result.freeSpinsAwarded, 2);
  }

  isSpinning = false;
  spinBtn.classList.remove('spinning');
  spinBtn.disabled = false;
  updateUI();

  // big win popup AFTER count-up (only for non-bonus-intro spins)
  if (result.total > 0 && tier(result.total, engine.stake)) {
    await sleep(400);
    await bigWinSequence(result.total, engine.stake);
  }

  // free spin chain
  if (engine.freeSpins > 0) {
    await sleep(turbo ? 250 : 700);
    doSpin(false);
    return;
  }

  // bonus end summary
  if (engine.totalWonInBonus > 0 && engine.freeSpins === 0 && !buyBonus) {
    const won = engine.totalWonInBonus;
    engine.totalWonInBonus = 0;
    if (won / engine.stake >= 5) {
      await sleep(300);
      await bigWinSequence(won, engine.stake);
    }
  }

  // autospin chain
  if (autoRemaining > 0) {
    autoRemaining--;
    if (autoRemaining > 0) updateAutoLabel();
    if (autoRemaining > 0 && engine.balance >= engine.stake) {
      setTimeout(() => doSpin(false), turbo ? 250 : 600);
    } else {
      autoRemaining = 0;
      autoBtn.classList.remove('active');
      autoBtn.querySelector('.lbl').textContent = 'AUTO';
    }
  }
}

function flashErr() {
  spinBtn.animate(
    [{ borderColor: 'var(--cyan)' }, { borderColor: 'var(--red)' }, { borderColor: 'var(--cyan)' }],
    { duration: 600, iterations: 2 }
  );
}

function updateAutoLabel() {
  autoBtn.querySelector('.lbl').textContent = autoRemaining > 0 ? autoRemaining : 'AUTO';
}

// ---------- wire up ----------
function init() {
  buildReels();
  buildPaytable();
  updateUI();
  fakeTickerLoop();

  spinBtn.addEventListener('click', () => {
    if (autoRemaining > 0) {
      autoRemaining = 0;
      autoBtn.classList.remove('active');
      autoBtn.querySelector('.lbl').textContent = 'AUTO';
      return;
    }
    doSpin(false);
  });

  stakeUpBtn.addEventListener('click', () => { if (!isSpinning) { engine.setStake(engine.stakeIdx + 1); updateUI(); }});
  stakeDnBtn.addEventListener('click', () => { if (!isSpinning) { engine.setStake(engine.stakeIdx - 1); updateUI(); }});

  buyBonusBtn.addEventListener('click', () => {
    if (isSpinning || engine.freeSpins > 0) return;
    if (engine.balance < engine.stake * 75) { flashErr(); return; }
    doSpin(true);
  });

  autoBtn.addEventListener('click', () => {
    if (autoRemaining > 0) {
      autoRemaining = 0;
      autoBtn.classList.remove('active');
      autoBtn.querySelector('.lbl').textContent = 'AUTO';
      return;
    }
    autoRemaining = 25;
    autoBtn.classList.add('active');
    updateAutoLabel();
    if (!isSpinning) doSpin(false);
  });

  turboBtn.addEventListener('click', () => {
    turbo = !turbo;
    turboBtn.classList.toggle('active', turbo);
  });

  bigwinOv.addEventListener('click', () => bigwinOv.classList.remove('show'));
  fsIntro.addEventListener('click', () => fsIntro.classList.remove('show'));

  // keyboard
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.repeat) { e.preventDefault(); spinBtn.click(); }
    if (e.code === 'ArrowUp')   { e.preventDefault(); stakeUpBtn.click(); }
    if (e.code === 'ArrowDown') { e.preventDefault(); stakeDnBtn.click(); }
    if (e.key === 't' || e.key === 'T') turboBtn.click();
  });
}

// build the paytable in the sidebar
function buildPaytable() {
  const order = ['WILD','DIAM','CRYS','BOLT','COIN','A','F','D','E'];
  const list = $('#paytableList');
  list.innerHTML = '';
  for (const id of order) {
    const s = SYMBOLS[id];
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <div class="gly sym-${id}" style="">${s.glyph}</div>
      <div class="info">
        <div class="nm">${s.label}</div>
        <div class="px">×${s.pay[4]} <span style="color:var(--fg-mute)">5-of-a-kind</span></div>
      </div>`;
    list.appendChild(row);
  }
  // scatter row
  const r = document.createElement('div');
  r.className = 'row';
  r.style.gridColumn = '1 / -1';
  r.innerHTML = `
    <div class="gly sym-SCAT">✦</div>
    <div class="info">
      <div class="nm">SCATTER · anywhere</div>
      <div class="px">3 → 10 FS · 4 → 15 FS · 5 → 20 FS <span style="color:var(--fg-mute)">×2 mult</span></div>
    </div>`;
  list.appendChild(r);
}

document.addEventListener('DOMContentLoaded', init);
