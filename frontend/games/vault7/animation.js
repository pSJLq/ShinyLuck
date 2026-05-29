/* ============================================================================
 * vault7/animation.js - data-driven reel-stop animation. NO RNG. NO MATH.
 * Consumes Vault7ResultData and animates reels/paylines.
 * ============================================================================ */

import { SFX } from './sound.js';
import { REEL_STRIPS, PAYLINES } from './engine.js';

const COLS = 5, ROWS = 3;
const SYM = ['WILD','DIAM','CRYS','BOLT','COIN','A','F','D','E','SCAT'];
const SYM_GLYPH = { WILD:'∞', DIAM:'◆', CRYS:'⬢', BOLT:'⚡', COIN:'⬣', A:'A', F:'F', D:'D', E:'E', SCAT:'✦' };

const $ = (q, el) => (el || document).querySelector(q);
const $$ = (q, el) => Array.from((el || document).querySelectorAll(q));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmtStt = (wei, d=2) => (Number(BigInt(wei)) / 1e18).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

export class Vault7Animator {
  constructor(rootEl, hooks = {}) {
    this.root = rootEl;
    this.hooks = hooks;
    this.turbo = false;
    this._build();
  }

  _build() {
    if ($('[data-vault-built]', this.root)) return;
    this.root.setAttribute('data-vault-built', '1');
    this.root.insertAdjacentHTML('beforeend', `
      <div class="reels-frame" data-reels-frame>
        <div class="glow-rim"></div>
        <div class="reels" data-reels></div>
        <svg class="payline-svg" data-payline-svg></svg>
        <canvas class="particle-canvas" data-particle-canvas></canvas>
        <div class="win-counter" data-win-counter>
          <span class="lbl">WIN</span>
          <span data-win-amt>0.00</span>
        </div>
      </div>
    `);
    this.frameEl = $('[data-reels-frame]', this.root);
    this.reelsEl = $('[data-reels]', this.root);
    this.paylineSvg = $('[data-payline-svg]', this.root);
    this.winCounter = $('[data-win-counter]', this.root);
    this.winAmtEl = $('[data-win-amt]', this.root);

    for (let c = 0; c < COLS; c++) {
      const reel = document.createElement('div');
      reel.className = 'reel'; reel.dataset.col = c;
      const strip = document.createElement('div');
      strip.className = 'reel-strip'; strip.dataset.col = c;
      // Belt-and-suspenders: explicitly pin the strip at translateY(0) with
      // no transition. If any prior session's CSS or animation engine
      // somehow leaks a translate value into the new instance, this resets
      // it before the first paint.
      strip.style.transform = 'translateY(0)';
      strip.style.transition = 'none';
      const initSeq = [
        ['DIAM','BOLT','A'],
        ['CRYS','COIN','F'],
        ['WILD','DIAM','D'],
        ['BOLT','E','CRYS'],
        ['COIN','A','DIAM'],
      ][c];
      for (const s of initSeq) strip.appendChild(this._makeCellEl(s));
      reel.appendChild(strip);
      this.reelsEl.appendChild(reel);
    }
    this._sizeReels();
    new ResizeObserver(() => this._sizeReels()).observe(this.reelsEl);
  }

  _sizeReels() {
    // Layout is now owned ENTIRELY by CSS (.reel { aspect-ratio: 1/3 } +
    // .cell { aspect-ratio: 1 }). We no longer write inline pixel heights
    // here - that JS-measurement path was the root of the "only one column
    // / giant cells / reels fly off" bugs (a bad clientWidth reading during
    // the async wallet-gated mount poisoned every reel's height and the
    // ResizeObserver on the container never re-fired to correct it).
    //
    // All this does now is strip any stale inline heights a previously
    // cached build may have left on the resting cells, so they fall back
    // to the CSS aspect-ratio box. Skipped mid-spin so we never disturb the
    // transform-driven strip that _spinToGrid manages.
    if (this.frameEl && this.frameEl.classList.contains('spinning')) return;
    const reels = $$('.reel', this.reelsEl);
    for (const r of reels) {
      if (r.style.height) r.style.height = '';
      const strip = $('.reel-strip', r);
      if (strip) $$('.cell', strip).forEach(c => { if (c.style.height) c.style.height = ''; });
    }
  }

  _makeCellEl(symId, cellH = null) {
    const idx = typeof symId === 'number' ? symId : SYM.indexOf(symId);
    const name = SYM[idx];
    const el = document.createElement('div');
    el.className = 'cell';
    el.dataset.sym = name;
    const glyph = document.createElement('div');
    glyph.className = 'glyph';
    glyph.innerHTML = `<span class="sym">${SYM_GLYPH[name]}</span>`;
    el.appendChild(glyph);
    if (cellH) el.style.height = cellH + 'px';
    return el;
  }

  setTurbo(v) { this.turbo = !!v; }

  // Optimistic-spin marker: only flip on .spinning so the rim glow
  // brightens. Reels stay STILL until _spinToGrid() takes over with the
  // real reel scroll - user explicitly wants no pre-spin animation. The
  // glow-rim opacity bump is the only visual cue during the on-chain wait.
  startSpinning() {
    if (!this.frameEl) return;
    this.frameEl.classList.add('spinning');
  }
  stopSpinning() {
    // Clear any blur/transform that might have been applied by an older
    // build still cached in someone's browser. No-op for fresh loads.
    const reels = $$('.reel', this.reelsEl);
    for (const r of reels) {
      if (r.style.filter) r.style.filter = '';
      const strip = $('.reel-strip', r);
      if (strip && strip.style.transform) strip.style.transform = '';
    }
  }

  /** Play one Vault7ResultData: base spin + optional FS chain.
   *  Hard guard against being invoked from anywhere other than spin(): if
   *  no user-initiated spin is in flight, refuse and log a stack trace so
   *  whatever is calling us can be identified. This is the design
   *  fix for "reels animate on page load" reports. */
  async play(result) {
    if (!this._userInitiated) {
      console.warn('[Vault7] play() called outside of a user-initiated spin - ignored.');
      console.trace('[Vault7] play() unauthorized call');
      return;
    }
    this.stopSpinning();
    this.frameEl.classList.add('spinning');
    this.winCounter.classList.remove('show');
    this.paylineSvg.innerHTML = '';
    this._clearDim();

    // base spin
    SFX.startReelLoop();
    await this._spinToGrid(result.grid, result.scatterCount);
    SFX.stopReelLoop();
    if (result.scatterCount >= 3) {
      SFX.scatterLand(result.scatterCount);
      document.body.classList.add('shake-1');
      setTimeout(()=> document.body.classList.remove('shake-1'), 400);
    }

    if (result.winningLines.length > 0 || result.scatterCount >= 3) {
      await this._showWins(result, 1);
    }

    let runningTotal = result.winningLines.reduce((a, w) => a + BigInt(w.payout), 0n) + BigInt(result.scatterPayout);

    if (result.freeSpinsTriggered > 0) {
      await sleep(500);
      SFX.bonusTrigger();
      this.hooks.onFsIntro?.(result.freeSpinsTriggered);
      await sleep(this.turbo ? 1400 : 2400);
      this.frameEl.classList.add('bonus-mode');

      let n = 0;
      for (const fs of result.freeSpins) {
        n++;
        this.hooks.onFsSpinStart?.(n, result.freeSpins.length);
        await this._spinToGrid(fs.grid, fs.scatterCount);
        if (fs.scatterCount >= 3) SFX.scatterLand(fs.scatterCount);
        if (fs.winningLines.length > 0 || fs.scatterCount >= 3) {
          await this._showWins({
            winningLines: fs.winningLines,
            scatterCount: fs.scatterCount,
            scatterPositions: fs.scatterPositions,
            scatterPayout: fs.scatterPayout,
          }, 2);
        }
        runningTotal += BigInt(fs.payoutWithMultiplier);
        // brief pause between FS
        await sleep(this.turbo ? 200 : 500);
        this._clearDim();
        this.paylineSvg.innerHTML = '';
        this.winCounter.classList.remove('show');
      }
      this.frameEl.classList.remove('bonus-mode');
    }

    this.frameEl.classList.remove('spinning');
    this.hooks.onSpinDone?.(result, runningTotal);
  }

  _clearDim() {
    $$('.cell.dim, .cell.winning, .cell.scatter-win', this.root).forEach(el => el.classList.remove('dim','winning','scatter-win'));
  }

  /** Animate reels to land on `targetGrid` (column-major: grid[col][row]).
      `scatterCount` triggers anticipation slowdown on later reels. */
  async _spinToGrid(targetGrid, scatterCount = 0) {
    // Defense-in-depth: even though only play() calls this, refuse if a
    // user-initiated spin isn't active. Same rationale as the play()
    // guard - a rogue caller would otherwise wipe strips and visually
    // animate without any user input.
    if (!this._userInitiated) {
      console.warn('[Vault7] _spinToGrid called outside a spin - ignored.');
      console.trace('[Vault7] _spinToGrid unauthorized call');
      return;
    }
    const reels = $$('.reel', this.reelsEl);
    const strips = reels.map(r => $('.reel-strip', r));
    // Wait for a real layout before measuring cellH. Without this, an
    // unlucky early call sets cell heights to 0 and the entire grid
    // disappears for the rest of the session.
    let cellH = reels[0].clientWidth;
    if (cellH < 10) {
      this._sizeReels();
      // give the browser one frame to reflow
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      cellH = reels[0].clientWidth;
      if (cellH < 10) cellH = 80; // last-resort fallback so the math doesn't NaN
    }
    const SCROLL = 24;
    for (let c = 0; c < COLS; c++) {
      const strip = strips[c];
      // FORCE the reel to a definite 3-cell box at spin time. This is the
      // single reliable moment (the user clicked SPIN, the frame is on
      // screen, clientWidth is valid). Combined with `.reels{align-items:
      // start}` so the grid can't stretch it back, this guarantees
      // overflow:hidden clips the 27-cell strip to exactly the 3 visible
      // rows - no more symbols spilling below the frame.
      reels[c].style.height = (cellH * ROWS) + 'px';
      strip.style.transition = 'none';
      strip.innerHTML = '';
      for (let i = 0; i < SCROLL + ROWS; i++) {
        const isFinal = i >= SCROLL;
        let s;
        if (isFinal) s = targetGrid[c][i - SCROLL];
        else { const strip0 = REEL_STRIPS[c]; s = strip0[Math.floor(Math.random() * strip0.length)]; }
        const cell = this._makeCellEl(s, cellH);
        strip.appendChild(cell);
      }
      strip.style.transform = 'translateY(0)';
      void strip.offsetHeight;
    }

    return new Promise((resolve) => {
      const endY = -(SCROLL * cellH);
      const baseDelay = this.turbo ? 60 : 130;
      const baseDur   = this.turbo ? 420 : 950;
      let stopped = 0;
      for (let c = 0; c < COLS; c++) {
        const strip = strips[c];
        let dur = baseDur + c * (this.turbo ? 90 : 220);
        // anticipation: if already 2 scatters in earlier reels and this reel has scatter, slow it
        if (c >= 2 && scatterCount >= 3) {
          const earlier = targetGrid.slice(0, c).flat().filter(s => s === 9).length;
          if (earlier === 2) {
            dur += this.turbo ? 250 : 600;
            setTimeout(()=> reels[c].classList.add('anticipating'), Math.max(0, dur - 800));
          }
        }
        const delay = c * baseDelay;
        setTimeout(() => {
          strip.style.transition = `transform ${dur}ms cubic-bezier(.25,.1,.25,1.18)`;
          strip.style.transform = `translateY(${endY - cellH * 0.18}px)`;
          setTimeout(() => {
            strip.style.transition = `transform 220ms cubic-bezier(.34,1.56,.64,1)`;
            strip.style.transform = `translateY(${endY}px)`;
          }, dur);
          setTimeout(() => {
            strip.style.transition = '';
            reels[c].classList.remove('anticipating');
            SFX.reelStop(c);
            stopped++;
            if (stopped === COLS) resolve();
          }, dur + 230);
        }, delay);
      }
    });
  }

  /** Show winning lines & dim non-winning cells.
      Counts up the total payout in the centre badge. */
  async _showWins(ev, multiplier = 1) {
    const winningSet = new Set();
    for (const w of ev.winningLines) {
      const pl = PAYLINES[w.lineIndex];
      for (let c = 0; c < w.matchCount; c++) winningSet.add(c + ',' + pl[c]);
    }
    if (ev.scatterCount >= 3 && ev.scatterPositions) {
      for (const [c, r] of ev.scatterPositions) winningSet.add(c + ',' + r);
    }
    if (winningSet.size === 0) return;

    const cols = this._getVisibleCells();
    for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
      if (!winningSet.has(c + ',' + r)) cols[c][r].classList.add('dim');
    }
    for (const w of ev.winningLines) {
      const pl = PAYLINES[w.lineIndex];
      for (let c = 0; c < w.matchCount; c++) cols[c][pl[c]].classList.add('winning');
    }
    if (ev.scatterCount >= 3) for (const [c, r] of ev.scatterPositions) {
      cols[c][r].classList.add('winning', 'scatter-win');
    }

    // draw paylines
    const frame = this.reelsEl.getBoundingClientRect();
    this.paylineSvg.setAttribute('viewBox', `0 0 ${frame.width} ${frame.height}`);
    this.paylineSvg.style.width = frame.width + 'px';
    this.paylineSvg.style.height = frame.height + 'px';
    this.paylineSvg.innerHTML = '';
    let i = 0;
    for (const w of ev.winningLines) {
      const pl = PAYLINES[w.lineIndex];
      const pts = [];
      for (let c = 0; c < w.matchCount; c++) {
        const cell = cols[c][pl[c]];
        const r2 = cell.getBoundingClientRect();
        pts.push([r2.left + r2.width/2 - frame.left, r2.top + r2.height/2 - frame.top]);
      }
      const d = pts.map((p, idx) => (idx === 0 ? 'M' : 'L') + p[0] + ' ' + p[1]).join(' ');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.style.animationDelay = (i * 0.12) + 's';
      const sym = SYM[w.symbolIndex];
      const stroke = sym === 'WILD' ? '#fff'
                  : (sym === 'DIAM' || sym === 'CRYS') ? 'var(--cyan)'
                  : (sym === 'BOLT' || sym === 'COIN') ? 'var(--gold)'
                  : 'var(--purple)';
      path.style.stroke = stroke;
      this.paylineSvg.appendChild(path);
      i++;
    }

    // win counter count-up
    let target = ev.winningLines.reduce((a, w) => a + BigInt(w.payout), 0n) + BigInt(ev.scatterPayout || 0);
    if (target > 0n) {
      this.winCounter.classList.add('show');
      const targetN = Number(target);
      let v = 0;
      const dur = this.turbo ? 600 : 1200;
      const start = performance.now();
      await new Promise(resolve => {
        const tick = (now) => {
          const p = Math.min(1, (now - start) / dur);
          v = targetN * (1 - Math.pow(1 - p, 3));
          this.winAmtEl.textContent = (v / 1e18).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
          if (p < 1) requestAnimationFrame(tick); else resolve();
        };
        requestAnimationFrame(tick);
      });
      // brief hold
      await sleep(this.turbo ? 400 : 800);
    }
  }

  _getVisibleCells() {
    // last ROWS cells of each strip are visible
    return $$('.reel-strip', this.reelsEl).map(s => Array.from(s.children).slice(-ROWS));
  }
}
