/* ============================================================================
 * vault7/api.js — PUBLIC API. Exports class Vault7Slot.
 * Same shape as SugarSlot but for VAULT.7 (5×3 classic).
 * ============================================================================ */

import { Vault7Animator } from './animation.js';
import { SFX } from './sound.js';
import { generateSpin as engineGenerateSpin, generateBuyBonusSpin as engineGenerateBuyBonusSpin, ENGINE_META } from './engine.js';

const WEI_PER_STT = 1_000_000_000_000_000_000n;
const fmtStt = (wei, d=2) => (Number(BigInt(wei)) / 1e18).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const STAKE_STEPS_WEI = [
  10n  * WEI_PER_STT / 100n,
  25n  * WEI_PER_STT / 100n,
  50n  * WEI_PER_STT / 100n,
  100n * WEI_PER_STT / 100n,
  250n * WEI_PER_STT / 100n,
  500n * WEI_PER_STT / 100n,
  1000n * WEI_PER_STT / 100n,
  2500n * WEI_PER_STT / 100n,
  5000n * WEI_PER_STT / 100n,
];

export class Vault7Slot {
  constructor(container, options = {}) {
    if (!container) throw new Error('Vault7Slot: container required');
    this.container = container;
    this.opts = options;
    this.mode = options.mode || 'demo';

    this.balance = options.initialBalance ?? 1000n * WEI_PER_STT;
    this.stakeIdx = 3;
    this.minStake = options.minStake ?? STAKE_STEPS_WEI[0];
    this.maxStake = options.maxStake ?? STAKE_STEPS_WEI[STAKE_STEPS_WEI.length - 1];
    this.freeSpinsRemaining = 0;
    this.turbo = false;
    this.autoRemaining = 0;
    this.busy = false;
    this._nonce = 0;
    this._clientSeed = randSeed();
    this._serverSeed = randSeed(64);

    this._render();
    this.animator = new Vault7Animator($('[data-anim-mount]', container), {
      onFsIntro: (n) => this._fsIntro(n),
    });
    this._wireControls();
    this._updateUI();
    this._fakeTicker();
    this._jackpotDrift();
  }

  updateBalance(b) { this.balance = BigInt(b); this._updateUI(); }
  destroy() { this.container.innerHTML = ''; clearInterval(this._jpInt); clearTimeout(this._tickerTimer); }

  get stakeWei() { return STAKE_STEPS_WEI[this.stakeIdx]; }
  get stakeStt() { return Number(this.stakeWei) / 1e18; }

  async spin(buyBonus = false) {
    if (this.busy) return;
    const cost = buyBonus ? this.stakeWei * 75n : this.stakeWei;
    const isFree = this.freeSpinsRemaining > 0;
    if (!isFree && this.balance < cost) { this._flashErr(); return; }
    if (this.freeSpinsRemaining > 0 && buyBonus) return;

    this.busy = true;
    SFX.click();
    $('[data-spin]', this.container).classList.add('spinning');
    // OPTIMISTIC: reels start moving instantly; play(result) takes over once
    // the chain settles.
    if (this.animator.startSpinning) this.animator.startSpinning();

    if (this.mode === 'demo' && !isFree) this.balance -= cost;
    this.opts.onSpinStarted?.(this.stakeWei);

    let result;
    try {
      if (this.mode === 'production') {
        const fn = buyBonus ? this.opts.onBuyBonusRequest : this.opts.onSpinRequest;
        if (!fn) throw new Error('production mode requires on' + (buyBonus ? 'BuyBonus' : 'Spin') + 'Request');
        if (buyBonus) this.opts.onBuyBonusTriggered?.(this.stakeWei);
        result = await fn(this.stakeWei);
      } else {
        this._nonce++;
        const seed = this._serverSeed + ':' + this._clientSeed + ':' + this._nonce;
        result = buyBonus
          ? engineGenerateBuyBonusSpin(this.stakeWei, seed)
          : engineGenerateSpin(this.stakeWei, seed);
        if (buyBonus) this.opts.onBuyBonusTriggered?.(this.stakeWei);
      }
    } catch (e) {
      // CRITICAL: stopSpinning() must be called or the optimistic anim leaves
      // the reels blurred/frozen forever. Also remove the .spinning class
      // from the SPIN button so it stops pulsing.
      console.error('[Vault7] spin error', e);
      try { this.animator.stopSpinning?.(); this.animator.frameEl?.classList.remove('spinning'); } catch (_) {}
      this.busy = false;
      $('[data-spin]', this.container).classList.remove('spinning');
      // Surface the most common contract reverts to the user. The full
      // mapping (custom-error selector → human msg) lives in api.js's caller
      // wrapper; here we just translate a couple of high-frequency ones.
      const msg = String(e?.message || e);
      if (/0x61bc0a1e|GameIsPaused/i.test(msg)) {
        this.opts.onError?.({ kind: 'paused', message: 'VAULT.7 is temporarily paused — try again in a few seconds.' });
      } else if (/BankrollInsufficient|0x8f523bc4/i.test(msg)) {
        this.opts.onError?.({ kind: 'bankroll', message: 'Casino bankroll low — try a smaller stake.' });
      } else {
        this.opts.onError?.({ kind: 'revert', message: e?.shortMessage || msg.slice(0, 200) });
      }
      return;
    }

    this.freeSpinsRemaining = result.freeSpinsTriggered || 0;
    this._updateUI();

    // Mark this play() as user-initiated. The animator's play() refuses
    // to run otherwise — protects against rogue callers on mount.
    this.animator._userInitiated = true;
    try { await this.animator.play(result); }
    finally { this.animator._userInitiated = false; }

    if (this.mode === 'demo' && result.totalPayout > 0n) this.balance += BigInt(result.totalPayout);

    const lw = $('[data-last-win]', this.container);
    if (result.totalPayout > 0n) {
      lw.textContent = '+' + fmtStt(result.totalPayout) + ' STT'; lw.classList.remove('zero');
      this._pushTicker({ who: 'YOU', amountWei: result.totalPayout, fresh: true, mega: Number(result.totalPayout) / Number(this.stakeWei) >= 25 });
    } else { lw.textContent = '— no win'; lw.classList.add('zero'); }

    // bonus end summary
    if (result.freeSpins?.length > 0) {
      const fsTotal = result.freeSpins.reduce((a, fs) => a + BigInt(fs.payoutWithMultiplier), 0n);
      await sleep(400);
      await this._bonusEnd(fsTotal);
      this.freeSpinsRemaining = 0;
    }

    // BIG WIN tier
    if (result.totalPayout > 0n) {
      const x = Number(result.totalPayout) / Number(this.stakeWei);
      const tier = x >= 100 ? 'EPIC' : x >= 50 ? 'MEGA' : x >= 20 ? 'BIG' : null;
      if (tier) { await sleep(300); await this._bigWin(result.totalPayout, tier); }
    }

    $('[data-spin]', this.container).classList.remove('spinning');
    this.busy = false;
    this.opts.onSpinCompleted?.(result);
    this._updateUI();

    if (this.autoRemaining > 0) {
      this.autoRemaining--; this._updateAutoLbl();
      if (this.autoRemaining > 0 && this.balance >= this.stakeWei) {
        setTimeout(() => this.spin(false), this.turbo ? 240 : 600);
      } else {
        this.autoRemaining = 0;
        $('[data-auto]', this.container).classList.remove('active');
        this._updateAutoLbl();
      }
    }
  }

  _render() {
    this.container.innerHTML = `
<div class="vault-shell">
  <div class="ambient">
    <div class="ambient-stars"></div>
    <div class="ambient-orb o1"></div>
    <div class="ambient-orb o2"></div>
    <div class="ambient-orb o3"></div>
  </div>

  <!-- Slot's own nav-bar hidden — partials.js provides shared site nav.
       We keep the data-sound button (wired by _wireControls + 'M' shortcut)
       and data-balance-mini in the DOM tree, just invisible. -->
  <div class="nav-bar" style="display:none">
    <div class="brand">SHINY·LUCK</div>
    <div class="right">
      <div class="bal"><b data-balance-mini>0.00</b> STT</div>
      <button class="sound-tog" data-sound>
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06A9 9 0 0 0 14 3.23z"/></svg>
      </button>
    </div>
  </div>

  <div class="game-hero">
    <div>
      <h1>V<span class="grad">a</span>ult<span class="grad">.</span>7</h1>
      <p class="lede">Five reels, twenty paylines, ×2 free-spin multiplier. Wilds substitute, scatters pay anywhere. Every reel position signed by the contract.</p>
    </div>
    <div class="hero-meta">
      <div class="m">RTP<b class="cyan">92.00%</b></div>
      <div class="m">Volatility<b class="purple">HIGH</b></div>
      <div class="m">Max Win<b class="gold">10,000×</b></div>
      <div class="m">Mechanic<b class="purple">20 LINES · CLASSIC</b></div>
    </div>
  </div>

  <div class="cl-layout">
    <div class="cab">
      <div class="machine-head">
        <span class="title">VAULT.7</span>
        <span class="pill" data-pill><span class="dot"></span><span>READY</span></span>
        <div class="right">
          <div class="stat">LINES<b>20</b></div>
          <div class="stat">MULT<b class="cyan" data-pill-mult>×1</b></div>
        </div>
      </div>

      <div data-anim-mount>
        <div class="free-spins-badge" data-fs-badge>
          <div class="ttl">FREE SPINS</div>
          <div class="count" data-fs-count>0</div>
          <div class="mult">REMAINING · <b>×2</b></div>
        </div>
        <button class="buy-bonus" data-buy>
          <div class="ttl">BUY BONUS</div>
          <div class="price"><span data-buy-price>75.00</span><small>STT</small></div>
          <div class="sub">→ 10 FREE SPINS · ×2</div>
        </button>
      </div>

      <div class="paytable-strip">
        <div class="pt"><span class="ico-WILD">∞</span><b style="color:var(--cyan)">WILD ×800</b></div>
        <div class="pt"><span class="ico-DIAM">◆</span><b>×400</b></div>
        <div class="pt"><span class="ico-CRYS">⬢</span><b>×200</b></div>
        <div class="pt"><span class="ico-BOLT">⚡</span><b>×100</b></div>
        <div class="pt"><span class="ico-COIN">⬣</span><b>×60</b></div>
        <div class="pt"><span class="ico-SCAT">✦</span><b style="color:var(--gold)">SCATTER → FS</b></div>
      </div>

      <div class="control-bar">
        <div class="bet-block">
          <div>
            <div class="kbd-label">STAKE</div>
            <div class="bet-stepper">
              <button data-stake-dn>−</button>
              <div class="val"><span data-stake>1.00</span><small data-stake-fiat>≈ $1.00</small></div>
              <button data-stake-up>+</button>
            </div>
          </div>
          <div class="bet-side"><span>TOTAL BET</span><span class="v cyan"><span data-total-bet>1.00</span> STT</span></div>
          <div class="bet-side"><span>LINE BET</span><span class="v"><span data-line-bet>0.05</span> STT</span></div>
          <div class="bet-side"><span>EV</span><span class="v ev" data-ev>−0.0800 STT</span></div>
        </div>

        <div class="spin-cluster">
          <button class="mini" data-auto><span class="lbl">AUTO</span></button>
          <button class="spin-btn" data-spin><span>SPIN</span></button>
          <button class="mini" data-turbo>
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/></svg>
          </button>
        </div>

        <div class="balance-block">
          <div class="lbl">BALANCE</div>
          <div class="balance"><span class="cur">STT</span><span data-balance>1,000.00</span></div>
          <div class="last-win zero" data-last-win>— no win yet</div>
          <div class="ev-note">Honest 92% RTP — published from contract</div>
        </div>
      </div>
    </div>

    <aside class="aside-stack">
      <div class="panel">
        <h3><span class="pip"></span>Live wins · feed</h3>
        <div class="ticker"><div class="ticker-list" data-ticker></div></div>
      </div>
      <div class="panel">
        <h3><span class="pip" style="background:var(--gold);box-shadow:0 0 8px var(--gold)"></span>Paytable</h3>
        <div class="pt-list">
          ${this._paytableHtml()}
        </div>
      </div>
      <div class="panel">
        <h3><span class="pip" style="background:var(--violet);box-shadow:0 0 8px var(--violet)"></span>Provably fair</h3>
        <div class="fair">
          <div class="l">CLIENT SEED</div><div class="v cyan" data-fair-client>${this._clientSeed}</div>
          <div class="l">SERVER SEED · HASH</div><div class="v purple" data-fair-server>${this._serverSeed.slice(0,8)}…${this._serverSeed.slice(-6)}</div>
          <div class="l">NONCE / BET ID</div><div class="v" data-fair-nonce>000000</div>
        </div>
      </div>
    </aside>
  </div>
</div>

<div class="bigwin-ov" data-bigwin>
  <canvas data-bigwin-canvas></canvas>
  <div class="bigwin-card">
    <div class="tier">BIG WIN</div>
    <div class="amount">+0.00 STT</div>
    <div class="sub">VAULT.7 · CLASSIC SLOT</div>
    <div class="dismiss">CLICK ANYWHERE TO DISMISS</div>
  </div>
</div>
<div class="fs-intro-ov" data-fs-intro>
  <div class="card">
    <div class="ttl">VAULT CRACKED</div>
    <div class="num">10</div>
    <div class="lbl">FREE SPINS</div>
    <div class="mult">WITH <b>×2</b> MULTIPLIER</div>
    <div class="hint">CLICK ANYWHERE TO CONTINUE</div>
  </div>
</div>
    `;
  }

  _paytableHtml() {
    const rows = [
      ['WILD','∞','×800','5-of-a-kind'],
      ['DIAM','◆','×400','5-of-a-kind'],
      ['CRYS','⬢','×200','5-of-a-kind'],
      ['BOLT','⚡','×100','5-of-a-kind'],
      ['COIN','⬣','×60','5-of-a-kind'],
      ['A','A','×40','5-of-a-kind'],
      ['F','F','×24','5-of-a-kind'],
      ['D','D','×16','5-of-a-kind'],
      ['E','E','×12','5-of-a-kind'],
      ['SCAT','✦','3 → 10 FS','anywhere'],
    ];
    return rows.map(([id, gly, px, sub]) => `
      <div class="pt">
        <div class="gly ico-${id}">${gly}</div>
        <div class="info"><div class="nm">${id}</div><div class="px"><b>${px}</b> <span style="color:var(--ink-3)">${sub}</span></div></div>
      </div>`).join('');
  }

  _wireControls() {
    const c = this.container;
    $('[data-spin]', c).addEventListener('click', () => {
      if (this.autoRemaining > 0) { this.autoRemaining = 0; $('[data-auto]', c).classList.remove('active'); this._updateAutoLbl(); return; }
      this.spin(false);
    });
    $('[data-stake-up]', c).addEventListener('click', () => { if (this.busy) return; this.stakeIdx = Math.min(STAKE_STEPS_WEI.length - 1, this.stakeIdx + 1); SFX.click(); this._updateUI(); });
    $('[data-stake-dn]', c).addEventListener('click', () => { if (this.busy) return; this.stakeIdx = Math.max(0, this.stakeIdx - 1); SFX.click(); this._updateUI(); });
    $('[data-buy]', c).addEventListener('click', () => {
      if (this.busy || this.freeSpinsRemaining > 0) return;
      if (this.balance < this.stakeWei * 75n) { this._flashErr(); return; }
      this.spin(true);
    });
    $('[data-auto]', c).addEventListener('click', () => {
      if (this.autoRemaining > 0) { this.autoRemaining = 0; $('[data-auto]', c).classList.remove('active'); this._updateAutoLbl(); return; }
      this.autoRemaining = 25; $('[data-auto]', c).classList.add('active'); this._updateAutoLbl();
      if (!this.busy) this.spin(false);
    });
    $('[data-turbo]', c).addEventListener('click', () => { this.turbo = !this.turbo; this.animator.setTurbo(this.turbo); $('[data-turbo]', c).classList.toggle('active', this.turbo); SFX.click(); });
    $('[data-sound]', c).addEventListener('click', () => { const on = !SFX.isEnabled(); SFX.setEnabled(on); $('[data-sound]', c).classList.toggle('muted', !on); });
    $('[data-bigwin]', c).addEventListener('click', () => $('[data-bigwin]', c).classList.remove('show'));
    $('[data-fs-intro]', c).addEventListener('click', () => $('[data-fs-intro]', c).classList.remove('show'));
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.repeat) { e.preventDefault(); $('[data-spin]', c).click(); }
      if (e.code === 'ArrowUp')   { e.preventDefault(); $('[data-stake-up]', c).click(); }
      if (e.code === 'ArrowDown') { e.preventDefault(); $('[data-stake-dn]', c).click(); }
      if (e.key === 't' || e.key === 'T') $('[data-turbo]', c).click();
      if (e.key === 'm' || e.key === 'M') $('[data-sound]', c).click();
    });
    c.querySelectorAll('.spin-btn,.buy-bonus,.bet-stepper button,.mini').forEach(el => el.addEventListener('mouseenter', () => SFX.hover()));
  }

  _updateUI() {
    const c = this.container;
    $('[data-balance]', c).textContent = fmtStt(this.balance);
    $('[data-balance-mini]', c).textContent = fmtStt(this.balance);
    $('[data-stake]', c).textContent = this.stakeStt.toFixed(2);
    $('[data-stake-fiat]', c).textContent = '≈ $' + this.stakeStt.toFixed(2);
    $('[data-total-bet]', c).textContent = this.stakeStt.toFixed(2);
    $('[data-line-bet]', c).textContent = (this.stakeStt / 20).toFixed(4);
    $('[data-buy-price]', c).textContent = (this.stakeStt * 75).toFixed(2);
    $('[data-fair-nonce]', c).textContent = String(this._nonce).padStart(6, '0');
    const evWei = -(this.stakeWei * 800n) / 10000n;
    $('[data-ev]', c).textContent = fmtStt(evWei, 4) + ' STT (−8.00%)';
    const fsBadge = $('[data-fs-badge]', c);
    if (this.freeSpinsRemaining > 0) {
      fsBadge.classList.add('show'); $('[data-fs-count]', c).textContent = this.freeSpinsRemaining;
      $('[data-pill]', c).classList.add('bonus');
      $('[data-pill-mult]', c).textContent = '×2';
    } else {
      fsBadge.classList.remove('show');
      $('[data-pill]', c).classList.remove('bonus');
      $('[data-pill-mult]', c).textContent = '×1';
    }
  }

  _updateAutoLbl() { $('[data-auto] .lbl', this.container).textContent = this.autoRemaining > 0 ? this.autoRemaining : 'AUTO'; }
  _flashErr() { SFX.click(); $('[data-spin]', this.container).animate([{filter:'hue-rotate(0)'},{filter:'hue-rotate(-90deg)'},{filter:'hue-rotate(0)'}], { duration:400, iterations:2 }); }

  async _bigWin(amountWei, tier) {
    const ov = $('[data-bigwin]', this.container);
    ov.querySelector('.tier').textContent = tier + ' WIN';
    ov.querySelector('.tier').className = 'tier ' + (tier === 'MEGA' ? 'mega' : tier === 'EPIC' ? 'epic' : '');
    const amtEl = ov.querySelector('.amount');
    ov.classList.add('show');
    document.body.classList.add(tier === 'EPIC' ? 'shake-3' : tier === 'MEGA' ? 'shake-2' : 'shake-1');
    setTimeout(()=> document.body.classList.remove('shake-1','shake-2','shake-3'), 900);
    SFX.bigWin(tier);
    burstParticles($('[data-bigwin-canvas]', this.container), tier === 'EPIC' ? 240 : tier === 'MEGA' ? 160 : 90);
    const target = Number(amountWei);
    const dur = tier === 'EPIC' ? 3000 : tier === 'MEGA' ? 2200 : 1400;
    const start = performance.now();
    await new Promise(resolve => {
      const tick = (now) => {
        const p = Math.min(1, (now - start) / dur);
        const v = target * (1 - Math.pow(1 - p, 3));
        amtEl.textContent = '+' + (v / 1e18).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 }) + ' STT';
        if (p < 1) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });
    await sleep(tier === 'EPIC' ? 1200 : 800);
    ov.classList.remove('show');
  }
  async _bonusEnd(total) {
    const ov = $('[data-bigwin]', this.container);
    ov.querySelector('.tier').textContent = 'BONUS COMPLETE';
    ov.querySelector('.tier').className = 'tier mega';
    ov.querySelector('.amount').textContent = '+' + fmtStt(total) + ' STT';
    ov.classList.add('show');
    SFX.bigWin('MEGA');
    burstParticles($('[data-bigwin-canvas]', this.container), 220);
    document.body.classList.add('shake-2');
    setTimeout(()=> document.body.classList.remove('shake-2'), 700);
    await sleep(2400);
    ov.classList.remove('show');
  }
  async _fsIntro(n) {
    const ov = $('[data-fs-intro]', this.container);
    ov.querySelector('.num').textContent = n;
    ov.classList.add('show');
    SFX.bonusTrigger();
    burstParticles(null, 180);
    document.body.classList.add('shake-2');
    setTimeout(()=> document.body.classList.remove('shake-2'), 600);
    await sleep(2400);
    ov.classList.remove('show');
  }

  _pushTicker({ who, amountWei, fresh, mega, label='VAULT.7' }) {
    const list = $('[data-ticker]', this.container);
    const div = document.createElement('div');
    div.className = 'ticker-row ' + (fresh ? 'fresh ' : '') + (mega ? 'mega' : '');
    div.innerHTML = `<div class="who">${who}<small>${label}</small></div><div class="amt">+${fmtStt(amountWei)}<small>STT</small></div>`;
    list.prepend(div);
    while (list.children.length > 12) list.lastElementChild.remove();
    if (fresh) setTimeout(()=> div.classList.remove('fresh'), 800);
  }
  _fakeTicker() {
    const list = $('[data-ticker]', this.container);
    if (list) {
      list.innerHTML = `<div class="ticker-row" style="opacity:.45"><div class="who" style="color:var(--fg-mute,#b6b0c8)">No spins yet<small>VAULT.7</small></div><div class="amt" style="color:var(--fg-mute,#b6b0c8)">be the first<small></small></div></div>`;
    }
  }
  _jackpotDrift() { /* P0: removed setInterval (cursor lag) */ }
}

function $(q, el) { return (el || document).querySelector(q); }
function randSeed(len = 24) {
  const a = 'abcdef0123456789'; let s = '';
  for (let i = 0; i < len; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}
function burstParticles(canvasEl, n) {
  let canvas = canvasEl;
  let temp = false;
  if (!canvas) { canvas = document.createElement('canvas'); canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999'; document.body.appendChild(canvas); temp = true; }
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const parts = [];
  const colors = ['#ffd255','#ff9a3c','#4ee3ff','#ff5ec8','#b794ff','#fff'];
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2; const v = 4 + Math.random() * 10;
    parts.push({ x:w/2, y:h/2, vx: Math.cos(a)*v, vy: Math.sin(a)*v - 4, life:1, size: 2+Math.random()*5, color: colors[Math.floor(Math.random()*colors.length)] });
  }
  const tick = () => {
    ctx.clearRect(0,0,w,h);
    let alive = false;
    for (const p of parts) {
      if (p.life <= 0) continue;
      alive = true;
      p.vy += 0.18; p.x += p.vx; p.y += p.vy; p.life -= 0.012;
      ctx.globalAlpha = Math.max(0, p.life); ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI*2); ctx.fill();
    }
    if (alive) requestAnimationFrame(tick); else if (temp) canvas.remove();
  };
  tick();
}
