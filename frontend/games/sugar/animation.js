/* ============================================================================
 * sugar/animation.js — data-driven renderer. NO RNG. NO MATH.
 * Consumes ResultData (from engine OR contract) and animates the DOM.
 * Exports class SugarAnimator.
 * ============================================================================ */

import { SFX } from './sound.js';

const GRID_SIZE = 7;
const SYM = ['WILD','H1','H2','H3','M1','M2','M3','L1','L2','SCAT'];
const SYM_GLYPH = { WILD:'✦', H1:'♥', H2:'◆', H3:'⬡', M1:'●', M2:'▲', M3:'◼', L1:'✕', L2:'◯', SCAT:'✺' };

const $ = (q, el) => (el || document).querySelector(q);
const $$ = (q, el) => Array.from((el || document).querySelectorAll(q));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const weiToStt = (wei) => Number(wei) / 1e18;
const fmtStt = (wei, d=2) => weiToStt(BigInt(wei)).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

export class SugarAnimator {
  constructor(rootEl, hooks = {}) {
    this.root = rootEl;
    this.hooks = hooks; // { onCascadeDone, onSpinDone, onBalanceTick(payoutWei), onFsSpinStart(n,total) }
    this.turbo = false;
    this.activeOrbs = new Map(); // key "r,c" → DOM
    this._buildSkeleton();
  }

  // ---------- skeleton DOM (idempotent) ----------
  _buildSkeleton() {
    if ($('[data-sugar-built]', this.root)) return;
    this.root.setAttribute('data-sugar-built', '1');
    const html = `
      <div class="grid-frame" data-grid-frame>
        <div class="glow-rim"></div>
        <div class="grid" data-grid></div>
        <div class="coin-layer" data-coin-layer></div>
        <div class="combo-badge" data-combo></div>
        <div class="win-hud" data-win-hud>
          <span class="chain">CHAIN <b data-chain>0</b></span>
          <span class="sep"></span>
          <span class="amount" data-win-amount>+0.00</span>
          <span class="x-mult" data-mult></span>
        </div>
      </div>`;
    this.root.insertAdjacentHTML('beforeend', html);
    this.gridEl = $('[data-grid]', this.root);
    this.frameEl = $('[data-grid-frame]', this.root);
    this.coinLayer = $('[data-coin-layer]', this.root);
    this.comboEl = $('[data-combo]', this.root);
    this.hudEl = $('[data-win-hud]', this.root);
    this.chainEl = $('[data-chain]', this.root);
    this.amtEl = $('[data-win-amount]', this.root);
    this.multEl = $('[data-mult]', this.root);
    for (let r = 0; r < GRID_SIZE; r++) for (let c = 0; c < GRID_SIZE; c++) {
      const slot = document.createElement('div');
      slot.className = 'slot'; slot.dataset.r = r; slot.dataset.c = c;
      slot.id = `s-${r}-${c}`;
      this.gridEl.appendChild(slot);
    }
  }

  setTurbo(v) { this.turbo = !!v; }

  // ---------- optimistic-spin marker: only flip on .spinning so the rim
  // glow brightens. The user wants the symbols to STAY STILL until the
  // real cascade animation begins — no more glyph shuffle during the
  // 3.6s on-chain reveal. The rim-glow is enough of a "waiting" signal.
  startSpinning() {
    if (!this.frameEl) return;
    this.frameEl.classList.add('spinning');
  }
  stopSpinning() {
    // .spinning class is kept while play(result) is running; only cleared
    // by play() at the end or by the api.js error handler explicitly.
  }

  // ---------- initial idle fill (called once) ----------
  renderIdleGrid(grid) {
    for (let r = 0; r < GRID_SIZE; r++) for (let c = 0; c < GRID_SIZE; c++) {
      const slot = $(`#s-${r}-${c}`, this.root);
      slot.innerHTML = '';
      const sym = this._makeSym(grid[r][c]);
      sym.classList.add('idle');
      slot.appendChild(sym);
    }
  }

  // ---------- main: play a full ResultData ----------
  async play(result) {
    // Hard guard (per claude-design recommendation): play() must only run
    // when api.js's spin() asked for it. If anything else calls in — a
    // stray promise resolution, a stale wallet event, a duplicate
    // page-script — refuse and log a trace so we can find the caller.
    if (!this._userInitiated) {
      console.warn('[SugarSlot] play() called outside of a user-initiated spin — ignored.');
      console.trace('[SugarSlot] play() unauthorized call');
      return;
    }
    this.stopSpinning();
    this.frameEl.classList.add('spinning');
    this.hudEl.classList.remove('show');

    // shake & dim before spin — kept very short in turbo. Each ms here is
    // dead time before the first cell drops in.
    $$('.sym', this.root).forEach(s => { s.classList.remove('idle'); s.style.transform = 'scale(.92)'; });
    SFX.startReelLoop();
    await sleep(this.turbo ? 50 : 140);

    // drop in initial grid
    await this._dropInGrid(result.initialGrid);
    SFX.stopReelLoop();
    if (this._countScats(result.initialGrid) >= 3) {
      SFX.scatterLand(this._countScats(result.initialGrid));
      document.body.classList.add('shake-1');
      setTimeout(()=> document.body.classList.remove('shake-1'), 400);
    }

    let chain = 0;
    let runningWin = 0n;
    let workingGrid = result.initialGrid.map(r => r.slice());

    // base cascades
    for (const cas of result.baseCascades) {
      chain++;
      runningWin += this._sumClusters(cas.clusters);
      this._showHud(chain, runningWin, 0);
      if (chain >= 2) this._showCombo(chain);
      SFX.cascadeChime(chain);
      // fly +amount per cluster
      for (const cl of cas.clusters) this._floatAmount(cl.payout, cl.positions, cl.size >= 10 ? 'cyan' : '');
      const allCells = cas.clusters.flatMap(cl => cl.positions);
      await this._popCells(allCells);
      // tumble in new
      await this._tumbleTo(workingGrid, cas.gridAfter);
      workingGrid = cas.gridAfter.map(r => r.slice());
      this.hooks.onCascadeDone?.(runningWin);
    }

    // free spins triggered → intro then play each spin's cascades
    if (result.freeSpinsTriggered > 0) {
      // Was fixed 500ms regardless of turbo. Turbo-aware now.
      await sleep(this.turbo ? 200 : 400);
      SFX.bonusTrigger();
      this.hooks.onFsIntro?.(result.freeSpinsTriggered);
      await sleep(this.turbo ? 1100 : 2200);
      this.activeOrbs.clear();
      this.frameEl.classList.add('bonus-mode');

      let fsN = 0;
      const total = result.freeSpins.length;
      for (const fs of result.freeSpins) {
        fsN++;
        this.hooks.onFsSpinStart?.(fs.spinNumber, total);
        // clear and drop new initial
        this._clearOrbs();
        // re-place sticky orbs that survived from previous FS spin
        // (engine emits cumulative activeStickyOrbs at end of each spin;
        //  for this spin's start, we should have orbs from the prev spin)
        if (fsN > 1) {
          const prev = result.freeSpins[fsN - 2];
          for (const o of prev.activeStickyOrbs) this._placeOrb(o.position[0], o.position[1], o.value);
        }
        await this._dropInGrid(fs.initialGrid);
        if (this._countScats(fs.initialGrid) >= 3) {
          SFX.scatterLand(3);
          document.body.classList.add('shake-1');
          setTimeout(()=> document.body.classList.remove('shake-1'), 400);
        }
        let chain2 = 0;
        let working2 = fs.initialGrid.map(r => r.slice());
        for (const cas of fs.cascades) {
          chain2++;
          const stepSum = this._sumClusters(cas.clusters);
          runningWin += stepSum;
          // detect multiplier was applied (any appliedMultipliers > 0)
          let multSum = 0;
          for (const cl of cas.clusters) for (const m of (cl.appliedMultipliers || [])) multSum += m;
          this._showHud(chain2, runningWin, multSum);
          if (chain2 >= 2) this._showCombo(chain2);
          SFX.cascadeChime(chain2);
          // fire orb visuals
          if (multSum > 0) {
            for (const cl of cas.clusters) {
              if ((cl.appliedMultipliers || []).length === 0) continue;
              for (const [r, c] of cl.positions) {
                const k = r + ',' + c;
                if (this.activeOrbs.has(k)) {
                  const el = this.activeOrbs.get(k);
                  el.classList.add('firing');
                  setTimeout(()=> el.classList.remove('firing'), 600);
                }
              }
            }
          }
          for (const cl of cas.clusters) this._floatAmount(cl.payout, cl.positions, multSum > 0 ? 'pink' : (cl.size >= 10 ? 'cyan' : ''));
          const allCells = cas.clusters.flatMap(cl => cl.positions);
          await this._popCells(allCells);
          await this._tumbleTo(working2, cas.gridAfter);
          working2 = cas.gridAfter.map(r => r.slice());
          // drop new orbs from this cascade
          for (const orb of (cas.newStickyOrbs || [])) {
            this._placeOrb(orb.position[0], orb.position[1], orb.value);
            SFX.multiplierLand(orb.value);
          }
        }
        await sleep(this.turbo ? 300 : 600);
      }
      this.frameEl.classList.remove('bonus-mode');
      this._clearOrbs();
    }

    // hide hud
    this.hudEl.classList.remove('show');

    // hold the final result on screen briefly so user can register it
    await sleep(this.turbo ? 180 : 420);

    // big-win celebration (UI is owned by api.js; we just emit hook)
    this.hooks.onSpinDone?.(result, runningWin);

    // idle pulse back
    setTimeout(()=> $$('.sym', this.root).forEach(s => s.classList.add('idle')), 200);
    this.frameEl.classList.remove('spinning');
  }

  // ---------- internals ----------
  _sumClusters(clusters) {
    let sum = 0n;
    for (const cl of clusters) sum += BigInt(cl.payout);
    return sum;
  }
  _countScats(grid) {
    let n = 0; for (const r of grid) for (const v of r) if (v === 9) n++; return n;
  }
  _showHud(chain, winWei, multApplied) {
    this.hudEl.classList.add('show');
    this.chainEl.textContent = chain;
    this.amtEl.textContent = '+' + fmtStt(winWei) + ' STT';
    if (multApplied > 0) { this.multEl.style.display = ''; this.multEl.textContent = '×' + multApplied; }
    else { this.multEl.style.display = 'none'; }
  }
  _showCombo(n) {
    const label = n === 2 ? '×2 CHAIN' : n === 3 ? '×3 SUPER' : n === 4 ? '×4 ULTRA' : n === 5 ? '×5 MEGA' : '×' + n + ' EPIC';
    this.comboEl.classList.remove('show');
    void this.comboEl.offsetHeight;
    this.comboEl.textContent = label;
    this.comboEl.classList.add('show');
  }

  _makeSym(idx) {
    const name = SYM[idx];
    const el = document.createElement('div');
    el.className = 'sym';
    el.dataset.sym = name;
    el.textContent = SYM_GLYPH[name];
    return el;
  }

  async _dropInGrid(grid) {
    // remove all existing syms (NOT orbs)
    $$('.sym', this.root).forEach(s => s.remove());
    // Turbo timings tightened: per-cell delays cut by ~30% and drop
    // duration trimmed. Total dropInGrid in turbo now ~290ms vs ~440ms.
    const colDelay = this.turbo ? 10 : 22;
    const rowDelay = this.turbo ? 7 : 16;
    const dur = this.turbo ? 240 : 400;
    for (let c = 0; c < GRID_SIZE; c++) {
      for (let r = 0; r < GRID_SIZE; r++) {
        const slot = $(`#s-${r}-${c}`, this.root);
        const sym = this._makeSym(grid[r][c]);
        slot.appendChild(sym);
        const dist = (GRID_SIZE - r) * (slot.clientHeight + 6) + 60;
        sym.style.transition = 'none';
        sym.style.transform = `translateY(${-dist}px)`;
        void sym.offsetHeight;
        const delay = c * colDelay + r * rowDelay;
        sym.style.transition = `transform ${dur}ms cubic-bezier(.34, 1.32, .64, 1) ${delay}ms`;
        sym.style.transform = 'translateY(0)';
      }
    }
    for (let i = 0; i < 7; i++) setTimeout(()=> SFX.reelStop(i), i * (this.turbo ? 14 : 26) + 120);
    // wait for the LAST cell to finish: max delay + dur + safety
    const maxDelay = (GRID_SIZE - 1) * colDelay + (GRID_SIZE - 1) * rowDelay;
    await sleep(maxDelay + dur + 40);
  }

  async _popCells(cells) {
    // Tightened: turbo path now 80+120=200ms total (was 140+200=340ms),
    // shaves ~700ms off a 5-cascade chain.
    const shakeDur = this.turbo ? 80 : 180;
    cells.forEach(([r, c]) => {
      const slot = $(`#s-${r}-${c}`, this.root);
      const sym = $('.sym', slot);
      if (sym) { sym.classList.remove('idle'); sym.classList.add('shaking'); }
    });
    await sleep(shakeDur);
    cells.forEach(([r, c], i) => {
      const slot = $(`#s-${r}-${c}`, this.root);
      if (!slot) return;
      const sym = $('.sym', slot);
      if (sym) { sym.classList.remove('shaking'); sym.classList.add('popping'); }
      const sh = document.createElement('div'); sh.className = 'shock'; slot.appendChild(sh);
      setTimeout(()=> sh.remove(), 600);
      this._spawnCoins(slot);
      if (i < 6) SFX.symbolPop(i);
    });
    await sleep(this.turbo ? 120 : 240);
    cells.forEach(([r, c]) => {
      const slot = $(`#s-${r}-${c}`, this.root);
      if (slot) $$('.sym', slot).forEach(e => e.remove());
    });
  }

  async _tumbleTo(beforeGrid, afterGrid) {
    // Tightened: 130ms turbo (was 180), shaves another ~250ms on 5 chains.
    const dur = this.turbo ? 130 : 280;
    const removedSet = new Set();
    for (let r = 0; r < GRID_SIZE; r++) for (let c = 0; c < GRID_SIZE; c++) {
      const slot = $(`#s-${r}-${c}`, this.root);
      if (!$('.sym', slot)) removedSet.add(r + ',' + c);
    }
    for (let c = 0; c < GRID_SIZE; c++) {
      const survivorIds = [];
      for (let r = GRID_SIZE - 1; r >= 0; r--) if (!removedSet.has(r + ',' + c)) survivorIds.push(r);
      let bottom = GRID_SIZE - 1;
      for (const oldR of survivorIds) {
        const newR = bottom--;
        if (oldR === newR) continue;
        const oldSlot = $(`#s-${oldR}-${c}`, this.root);
        const newSlot = $(`#s-${newR}-${c}`, this.root);
        const sym = $('.sym', oldSlot);
        if (sym) {
          const dy = newSlot.getBoundingClientRect().top - oldSlot.getBoundingClientRect().top;
          sym.style.transition = 'none';
          newSlot.appendChild(sym);
          sym.style.transform = `translateY(${-dy}px)`;
          void sym.offsetHeight;
          sym.style.transition = `transform ${dur}ms cubic-bezier(.55, .085, .68, .53)`;
          sym.style.transform = 'translateY(0)';
          setTimeout(()=> sym.style.transition = '', dur + 40);
        }
      }
      const newCount = GRID_SIZE - survivorIds.length;
      for (let nr = 0; nr < newCount; nr++) {
        const slot = $(`#s-${nr}-${c}`, this.root);
        $$('.sym', slot).forEach(e => e.remove());
        const sym = this._makeSym(afterGrid[nr][c]);
        slot.appendChild(sym);
        const dist = (newCount - nr) * (slot.clientHeight + 6) + 60;
        sym.style.transition = 'none';
        sym.style.transform = `translateY(${-dist}px) scale(.92)`;
        void sym.offsetHeight;
        sym.style.transition = `transform ${dur + 80}ms cubic-bezier(.34, 1.32, .64, 1)`;
        sym.style.transform = 'translateY(0) scale(1)';
        setTimeout(()=> sym.style.transition = '', dur + 120);
      }
    }
    await sleep(dur + 80);
  }

  _spawnCoins(slot, n = 4) {
    const overlay = this.coinLayer;
    const r = slot.getBoundingClientRect();
    const ovR = overlay.getBoundingClientRect();
    const x0 = r.left + r.width/2 - ovR.left;
    const y0 = r.top + r.height/2 - ovR.top;
    for (let i = 0; i < n; i++) {
      const c = document.createElement('div');
      c.className = 'coin-fly';
      c.style.cssText = `left:${x0}px;top:${y0}px;`;
      overlay.appendChild(c);
      const ang = Math.random() * Math.PI * 2;
      const vx = Math.cos(ang) * (60 + Math.random()*90);
      const vy = -160 - Math.random()*100;
      const dur = 700 + Math.random()*400;
      const dx = vx*dur/1000, dy = vy*dur/1000 + 0.5*600*(dur/1000)**2;
      c.animate(
        [{ transform:'translate(0,0) scale(1)', opacity:1 }, { transform:`translate(${dx}px,${dy}px) scale(.7)`, opacity:0 }],
        { duration: dur, easing: 'cubic-bezier(.4,.1,.7,.5)' }
      ).onfinish = () => c.remove();
      if (i === 0) SFX.coinDrop();
    }
  }

  _floatAmount(payoutWei, cells, color='') {
    if (!cells.length) return;
    let sx = 0, sy = 0;
    const ovR = this.coinLayer.getBoundingClientRect();
    for (const [r, c] of cells) {
      const sl = $(`#s-${r}-${c}`, this.root).getBoundingClientRect();
      sx += sl.left + sl.width/2 - ovR.left;
      sy += sl.top + sl.height/2 - ovR.top;
    }
    sx /= cells.length; sy /= cells.length;
    const el = document.createElement('div');
    el.className = 'float-num ' + color;
    el.textContent = '+' + fmtStt(payoutWei);
    el.style.left = sx + 'px'; el.style.top = sy + 'px';
    this.coinLayer.appendChild(el);
    setTimeout(()=> el.remove(), 1200);
  }

  _placeOrb(r, c, value) {
    const slot = $(`#s-${r}-${c}`, this.root);
    if (!slot) return;
    if ($('.mult-orb', slot)) return; // already
    const orb = document.createElement('div');
    orb.className = 'mult-orb';
    orb.dataset.row = r; orb.dataset.col = c; orb.dataset.value = value;
    orb.textContent = '×' + value;
    const pal = value >= 50 ? ['#ff5e8a','#b794ff','rgba(255,94,138,.8)']
              : value >= 15 ? ['#ffc847','#ff5ec8','rgba(255,200,71,.8)']
              : value >= 5  ? ['#4ee3ff','#8b5cf6','rgba(78,227,255,.8)']
                            : ['#4ade80','#4ee3ff','rgba(74,222,128,.7)'];
    orb.style.setProperty('--orb-c1', pal[0]);
    orb.style.setProperty('--orb-c2', pal[1]);
    orb.style.setProperty('--orb-glow', pal[2]);
    slot.appendChild(orb);
    this.activeOrbs.set(r + ',' + c, orb);
  }
  _clearOrbs() {
    $$('.mult-orb', this.root).forEach(e => e.remove());
    this.activeOrbs.clear();
  }
}
