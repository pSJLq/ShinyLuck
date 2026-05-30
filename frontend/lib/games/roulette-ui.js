/* ============================================================================
   ShinyLuck - On-chain American Roulette  ·  roulette.js
   Self-contained ES module. Vanilla JS, no framework, no runtime deps.
   Art via Canvas2D (wheel/ball) + DOM/CSS (board). Sound via WebAudio.

   The class owns ALL rendering / animation / state. It NEVER talks to the
   chain directly - the host wires it via constructor hooks and pushes the
   authoritative outcome in through resolveRound(resultNumber).

     import { RouletteGame } from './roulette.js';
     const game = new RouletteGame(rootEl, { mode:'demo', chipDenoms:[...], ...});

   Hard rule: resolveRound(n) is the ONLY source of an outcome. The wheel
   lands on EXACTLY that number. No client RNG in production mode.
   ============================================================================ */

/* ---------------------------------------------------------------------------
   1. ROULETTE TRUTH TABLES  (American wheel - 38 pockets)
   --------------------------------------------------------------------------- */

// Canonical American wheel sequence (clockwise). '00' represented as the
// string "00"; everything else is a Number. Index = physical pocket order.
export const WHEEL_SEQUENCE = [
  0, 28, 9, 26, 30, 11, 7, 20, 32, 17, 5, 22, 34, 15, 3, 24, 36, 13, 1, "00",
  27, 10, 25, 29, 12, 8, 19, 31, 18, 6, 21, 33, 16, 4, 23, 35, 14, 2,
];

const RED_NUMBERS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);

/** Color of a roulette value: 'red' | 'black' | 'green'. */
export function colorOf(n) {
  if (n === 0 || n === "00") return "green";
  return RED_NUMBERS.has(Number(n)) ? "red" : "black";
}

// Payout multipliers (X:1) - what you win ON TOP of the stake.
const PAYOUT = {
  straight: 35, split: 17, street: 11, corner: 8, line: 5,
  dozen: 2, column: 2, red: 1, black: 1, odd: 1, even: 1, low: 1, high: 1,
};

/* ---------------------------------------------------------------------------
   2. SMALL UTILITIES
   --------------------------------------------------------------------------- */
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutQuart = (t) => 1 - Math.pow(1 - t, 4);
const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);
const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;
const rnd = (a, b) => a + Math.random() * (b - a);
const fmt = (n, d = 2) => {
  const v = Number(n);
  if (!isFinite(v)) return "0";
  return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
};
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const shortAddr = () => {
  const hex = "0123456789abcdef";
  let s = "0x";
  for (let i = 0; i < 4; i++) s += hex[(Math.random() * 16) | 0];
  s += "\u2026";
  for (let i = 0; i < 2; i++) s += hex[(Math.random() * 16) | 0];
  return s;
};

// wei <-> STT helpers (18 decimals). Kept dependency-free with BigInt.
const WEI = 1000000000000000000n;
function sttToWei(stt) {
  const [i, f = ""] = String(stt).split(".");
  const frac = (f + "0".repeat(18)).slice(0, 18);
  return BigInt(i || "0") * WEI + BigInt(frac || "0");
}
function weiToStt(wei) {
  try {
    const b = typeof wei === "bigint" ? wei : BigInt(String(wei).split(".")[0] || "0");
    const whole = b / WEI;
    const frac = (b % WEI).toString().padStart(18, "0").slice(0, 2);
    return Number(whole.toString() + "." + frac);
  } catch { return Number(wei) || 0; }
}

/* ---------------------------------------------------------------------------
   3. AUDIO ENGINE  (WebAudio, gesture-gated, fully muteable)
   --------------------------------------------------------------------------- */
class Audio {
  constructor() {
    this.ctx = null; this.muted = false; this.ready = false;
    this._ball = null; this._ballGain = null;
  }
  unlock() {
    if (this.ready) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      this.ready = true;
    } catch (e) { /* no audio */ }
  }
  _env(type, freq, dur, gain = 0.3, sweep = null) {
    if (!this.ready || this.muted) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (sweep) o.frequency.exponentialRampToValueAtTime(sweep, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }
  chip()  { this._env("square", 880, 0.05, 0.12, 1200); this._env("triangle", 440, 0.06, 0.08); }
  click() { this._env("sine", 520, 0.04, 0.07); }
  deny()  { this._env("sawtooth", 140, 0.18, 0.1, 90); }
  lock()  { this._env("sawtooth", 220, 0.4, 0.14, 60); }
  fret()  { this._env("square", rnd(900,1500), 0.03, 0.08, 600); }
  // ball-on-track rumble loop, pitch follows speed (0..1)
  ballStart() {
    if (!this.ready || this.muted || this._ball) return;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const o2 = this.ctx.createOscillator();
    o.type = "sawtooth"; o2.type = "sine";
    o.frequency.value = 320; o2.frequency.value = 90;
    g.gain.value = 0.0001;
    g.gain.exponentialRampToValueAtTime(0.06, this.ctx.currentTime + 0.1);
    o.connect(g); o2.connect(g); g.connect(this.master);
    o.start(); o2.start();
    this._ball = [o, o2]; this._ballGain = g;
  }
  ballSpeed(v) {
    if (!this._ball) return;
    const t = this.ctx.currentTime;
    this._ball[0].frequency.setTargetAtTime(220 + v * 520, t, 0.1);
    this._ball[1].frequency.setTargetAtTime(70 + v * 120, t, 0.1);
  }
  ballStop() {
    if (!this._ball) return;
    const t = this.ctx.currentTime;
    this._ballGain.gain.setTargetAtTime(0.0001, t, 0.08);
    const b = this._ball;
    setTimeout(() => b.forEach(o => { try { o.stop(); } catch {} }), 400);
    this._ball = null;
  }
  win(mult = 1) {
    if (!this.ready || this.muted) return;
    const base = [523, 659, 784, 1047];
    base.forEach((f, i) => setTimeout(() => this._env("triangle", f, 0.3, 0.18), i * 70));
    if (mult >= 10) base.forEach((f, i) => setTimeout(() => this._env("sine", f * 2, 0.4, 0.1), 300 + i * 60));
  }
  lose() { this._env("sine", 300, 0.25, 0.06, 180); }
}

/* ---------------------------------------------------------------------------
   4. WHEEL  - Canvas2D rotor + ball physics. Lands EXACTLY on target index.
   --------------------------------------------------------------------------- */
class Wheel {
  constructor(canvas, audio, opts) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.audio = audio;
    this.opts = opts;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.rotor = 0;            // rotor base angle (rad)
    this.idleSpeed = 0.18;     // rad/s slow idle
    this.spinning = false;
    this.spin = null;          // active spin descriptor
    this.ball = { angle: -Math.PI / 2, radius: 0, locked: false, lockIndex: 0 };
    this.spotlightIndex = -1;
    this.spotlightT = 0;
    this.pushIn = 0;           // camera push-in 0..1 during anticipation
    this.bonus = false;

    this._lastFret = 0;
    this._t = performance.now();
    this.resize();
    // keep canvas buffer in sync with its box once layout settles / changes
    if (typeof ResizeObserver !== "undefined") {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(this.cv);
    }
    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    const cssW = Math.max(40, r.width), cssH = Math.max(40, r.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cv.width = Math.round(cssW * this.dpr);
    this.cv.height = Math.round(cssH * this.dpr);
    this.cssW = cssW; this.cssH = cssH;
    const size = Math.min(cssW, cssH);
    this.size = size;
    this.R = size / 2 * 0.96;
    this.trackR = this.R * 0.90;   // ball orbit on outer track
    this.pocketOuter = this.R * 0.86;
    this.pocketCenterR = this.R * 0.745; // resting radius of ball in pocket
    this.pocketInner = this.R * 0.60;
    this.hubR = this.R * 0.45;
    if (!this.ball.locked) this.ball.radius = this.trackR;
  }

  indexOfNumber(num) {
    const key = num === "00" ? "00" : Number(num);
    return WHEEL_SEQUENCE.findIndex(v => (v === "00" ? "00" : v) === key);
  }

  // Rotor angle during a spin. Decomposed as a constant idle drift PLUS an
  // eased "extra" rotation whose ANGULAR VELOCITY decays to zero at p=1 - so
  // at the end the rotor is moving at exactly the idle speed and the idle
  // branch picks up seamlessly (no velocity jump = no abrupt stop).
  rotorAt(now) {
    const s = this.spin;
    if (!s) return this.rotor;
    const dt = (now - s.t0) / 1000;
    const p = clamp(dt / s.Dsec, 0, 1);
    return s.rotor0 + this.idleSpeed * dt + s.extraRevs * easeOutQuint(p);
  }

  /** Kick off the landing animation onto `targetIndex`. Returns a Promise that
   *  resolves when the ball has fully settled. */
  spinTo(targetIndex, durationMs, turbo = false) {
    const now = performance.now();
    const D = durationMs;
    const Dsec = D / 1000;
    const t0 = now;
    const rotor0 = this.rotor;
    // extra eased rotation on top of idle drift. easeOutQuint => velocity
    // tapers to ~idle, so the wheel keeps gliding slowly instead of snapping.
    const extraRevs = (turbo ? 7 : 12) * TAU;

    const step = TAU / WHEEL_SEQUENCE.length;
    // deterministic final rotor angle (idle drift over the whole spin + extra)
    const rotorEnd = rotor0 + this.idleSpeed * Dsec + extraRevs;
    // ball rests at pocket center: screen angle = rotorEnd + index*step
    const settle = rotorEnd + targetIndex * step;
    // ball orbits OPPOSITE direction (decreasing). Many turns of drama.
    const turns = turbo ? 5 : 8;
    const start = settle + TAU * turns;

    this.spin = {
      t0, D, Dsec, rotor0, extraRevs, targetIndex,
      settle, start, turbo, resolve: null,
    };
    this.spinning = true;
    this.ball.locked = false;
    this.spotlightIndex = -1;
    this.pushIn = 0;
    this._lastFret = -1;
    this.audio.ballStart();

    return new Promise((resolve) => { this.spin.resolve = resolve; });
  }

  _settleBall(idx) {
    this.spin = null;
    this.spinning = false;
    this.ball.locked = true;
    this.ball.lockIndex = idx;
    this.ball.radius = this.pocketCenterR;
    this.spotlightIndex = idx;
    this.spotlightT = performance.now();
    this.audio.ballStop();
  }

  _update(now) {
    if (this.spin) {
      const s = this.spin;
      const step = TAU / WHEEL_SEQUENCE.length;
      const dt = (now - s.t0) / 1000;
      const p = clamp(dt / s.Dsec, 0, 1);

      // rotor glides down to idle velocity (no snap at the end)
      this.rotor = s.rotor0 + this.idleSpeed * dt + s.extraRevs * easeOutQuint(p);

      // ball angular travel - long eased creep, opposite direction
      const eBall = easeOutQuint(p);
      let ang = s.settle + (s.start - s.settle) * (1 - eBall);

      // radius: ride the track, then ease down into the pocket ring
      let rad;
      const dropStart = 0.58;
      if (p < dropStart) {
        rad = this.trackR - Math.sin(p / dropStart * Math.PI) * this.R * 0.012; // tiny float
      } else {
        const dp = (p - dropStart) / (1 - dropStart);
        rad = lerp(this.trackR, this.pocketCenterR, easeOutCubic(dp));
      }

      // rattle: damped bounces across frets, fully faded by ~p=0.92
      if (p > 0.66 && p < 0.94) {
        const rp = (p - 0.66) / (0.94 - 0.66);          // 0..1
        const decay = Math.pow(1 - rp, 2.2);
        const osc = Math.sin(rp * Math.PI * 6);
        ang += osc * decay * 0.045;                     // angular rattle (rad)
        rad += Math.abs(osc) * decay * this.R * 0.028;  // little hops
        const bounceN = Math.floor(rp * 6);
        if (bounceN !== this._lastFret && rp < 0.9) { this.audio.fret(); this._lastFret = bounceN; }
      }

      // capture: in the final stretch blend the ball onto the LIVE pocket so it
      // rides WITH the wheel - finishes at idle speed, never a dead stop.
      if (p > 0.9) {
        const bp = easeInOutSine(clamp((p - 0.9) / 0.1, 0, 1));
        const live = this.rotor + s.targetIndex * step; // current pocket position
        ang = lerp(ang, live, bp);
        rad = lerp(rad, this.pocketCenterR, bp);
      }

      this.ball.angle = ang;
      this.ball.radius = rad;

      // anticipation camera push-in builds through the slow tail
      this.pushIn = clamp((p - 0.7) / 0.3, 0, 1);

      // ball sound speed follows angular velocity (long tail)
      this.audio.ballSpeed(clamp(Math.pow(1 - p, 0.6), 0, 1));

      if (p >= 1) {
        const idx = s.targetIndex;
        const res = s.resolve;
        this._settleBall(idx);
        if (res) res();
      }
    } else {
      // idle rotor drift - keeps gliding at the same idle speed the spin ended on
      this.rotor += this.idleSpeed * ((now - this._t) / 1000);
      this.pushIn *= 0.9; // ease the anticipation zoom back out smoothly
      if (this.pushIn < 0.002) this.pushIn = 0;
      if (this.ball.locked) {
        const step = TAU / WHEEL_SEQUENCE.length;
        this.ball.angle = this.rotor + this.ball.lockIndex * step;
        this.ball.radius = this.pocketCenterR;
      } else {
        // ball teases on the track, slowly, opposite direction
        this.ball.angle -= 0.6 * ((now - this._t) / 1000);
        this.ball.radius = this.trackR;
      }
    }
    this._t = now;
  }

  _loop(now) {
    this._update(now);
    this._draw(now);
    this._raf = requestAnimationFrame(this._loop);
  }

  _draw(now) {
    const ctx = this.ctx, dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    const cx = this.cssW / 2, cy = this.cssH / 2;
    const squash = 0.86;                 // 3/4 perspective
    const zoom = 1 + this.pushIn * 0.06; // anticipation push-in

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(zoom, zoom * squash);

    const accent = this.bonus ? "#ff3df0" : "#7c20f0";
    const accent2 = this.bonus ? "#ff7a3d" : "#6e6eed";

    // outer ambient glow
    const ng = ctx.createRadialGradient(0, 0, this.R * 0.5, 0, 0, this.R * 1.15);
    ng.addColorStop(0, "rgba(0,0,0,0)");
    ng.addColorStop(0.8, this.bonus ? "rgba(255,61,240,0.10)" : "rgba(124,32,240,0.10)");
    ng.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = ng;
    ctx.beginPath(); ctx.arc(0, 0, this.R * 1.15, 0, TAU); ctx.fill();

    // wooden/metal outer bowl rim
    this._ring(ctx, this.R * 0.995, this.R * 0.90, [
      [0, "#2a2a32"], [0.5, "#14141a"], [1, "#05050a"],
    ]);
    // subtle accent rim line
    ctx.lineWidth = Math.max(1.2, this.R * 0.006);
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.55;
    ctx.beginPath(); ctx.arc(0, 0, this.R * 0.905, 0, TAU); ctx.stroke();
    ctx.globalAlpha = 1;

    // ---- the ball track (where ball orbits) ----
    this._ring(ctx, this.R * 0.90, this.R * 0.80, [
      [0, "#0c0c12"], [0.5, "#17171f"], [1, "#0a0a10"],
    ]);
    // diamonds / deflectors (frets on the track) - 8 of them
    const dia = 8;
    for (let i = 0; i < dia; i++) {
      const a = (i / dia) * TAU + this.rotor * 0.0; // fixed (part of bowl, not rotor)
      const dr = this.R * 0.835;
      const dx = Math.cos(a) * dr, dy = Math.sin(a) * dr;
      ctx.save(); ctx.translate(dx, dy); ctx.rotate(a + Math.PI / 2);
      const dg = ctx.createLinearGradient(0, -this.R * 0.03, 0, this.R * 0.03);
      dg.addColorStop(0, "#dfe2ea"); dg.addColorStop(0.5, "#8b8f9c"); dg.addColorStop(1, "#3a3d47");
      ctx.fillStyle = dg;
      const d = this.R * 0.028;
      ctx.beginPath(); ctx.moveTo(0, -d); ctx.lineTo(d, 0); ctx.lineTo(0, d); ctx.lineTo(-d, 0); ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // ---- rotor (spins): pockets ----
    ctx.save();
    ctx.rotate(this.rotor);
    const step = TAU / WHEEL_SEQUENCE.length;
    const oR = this.R * 0.795, iR = this.R * 0.56;
    for (let i = 0; i < WHEEL_SEQUENCE.length; i++) {
      const v = WHEEL_SEQUENCE[i];
      const a0 = i * step - step / 2, a1 = i * step + step / 2;
      const col = colorOf(v);
      let fill;
      if (col === "green") fill = this.bonus ? "#7a1f5e" : "#00653e";
      else if (col === "red") fill = "#d43800";
      else fill = "#141418";

      ctx.beginPath();
      ctx.arc(0, 0, oR, a0, a1);
      ctx.arc(0, 0, iR, a1, a0, true);
      ctx.closePath();
      // radial shading per pocket
      const pg = ctx.createRadialGradient(0, 0, iR, 0, 0, oR);
      pg.addColorStop(0, fill);
      pg.addColorStop(1, col === "black" ? "#0c0c10" : (col === "red" ? "#8f2400" : "#003a23"));
      ctx.fillStyle = pg;
      ctx.fill();

      // fret separators (metallic)
      ctx.strokeStyle = "rgba(190,194,205,0.6)";
      ctx.lineWidth = Math.max(0.6, this.R * 0.004);
      ctx.beginPath();
      ctx.moveTo(Math.cos(a0) * iR, Math.sin(a0) * iR);
      ctx.lineTo(Math.cos(a0) * oR, Math.sin(a0) * oR);
      ctx.stroke();

      // number text
      ctx.save();
      const am = i * step;
      ctx.rotate(am);
      ctx.translate((oR + iR) / 2, 0);
      ctx.rotate(Math.PI / 2);
      ctx.fillStyle = "#fff";
      ctx.font = `700 ${Math.max(8, this.R * 0.052)}px "Source Code Pro", monospace`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(v), 0, 0);
      ctx.restore();
    }

    // spotlight on winning pocket (after settle)
    if (this.spotlightIndex >= 0) {
      const age = (now - this.spotlightT) / 1000;
      const pulse = 0.5 + 0.5 * Math.sin(age * 5);
      const a = this.spotlightIndex * step;
      ctx.save();
      ctx.rotate(a);
      ctx.beginPath();
      ctx.arc(0, 0, oR, -step / 2, step / 2);
      ctx.arc(0, 0, iR, step / 2, -step / 2, true);
      ctx.closePath();
      ctx.strokeStyle = "#ffd54a";
      ctx.lineWidth = Math.max(1.5, this.R * 0.012);
      ctx.globalAlpha = 0.6 + 0.4 * pulse;
      ctx.shadowColor = "#ffd54a"; ctx.shadowBlur = 20 + pulse * 20;
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore(); // end rotor

    // ---- inner hub (turret) ----
    this._ring(ctx, this.R * 0.56, this.R * 0.46, [[0,"#23232c"],[0.5,"#101016"],[1,"#05050a"]]);
    // cone
    const cg = ctx.createRadialGradient(-this.R*0.08, -this.R*0.08, this.R*0.02, 0, 0, this.R * 0.46);
    cg.addColorStop(0, "#3a3a46"); cg.addColorStop(0.5, "#1a1a22"); cg.addColorStop(1, "#0a0a10");
    ctx.fillStyle = cg;
    ctx.beginPath(); ctx.arc(0, 0, this.R * 0.46, 0, TAU); ctx.fill();
    // spokes
    ctx.save(); ctx.rotate(this.rotor * 1.0);
    for (let i = 0; i < 8; i++) {
      ctx.rotate(TAU / 8);
      const sg = ctx.createLinearGradient(0, 0, this.R * 0.44, 0);
      sg.addColorStop(0, "rgba(220,224,235,0.5)"); sg.addColorStop(1, "rgba(120,124,140,0)");
      ctx.strokeStyle = sg; ctx.lineWidth = Math.max(1, this.R * 0.012);
      ctx.beginPath(); ctx.moveTo(this.R * 0.08, 0); ctx.lineTo(this.R * 0.44, 0); ctx.stroke();
    }
    ctx.restore();
    // center cap with accent glow + {s}
    const capR = this.R * 0.14;
    const capg = ctx.createRadialGradient(-capR*0.4, -capR*0.4, 1, 0, 0, capR);
    capg.addColorStop(0, accent2); capg.addColorStop(0.6, accent); capg.addColorStop(1, "#1a0a30");
    ctx.fillStyle = capg;
    ctx.shadowColor = accent; ctx.shadowBlur = 24;
    ctx.beginPath(); ctx.arc(0, 0, capR, 0, TAU); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#fff";
    ctx.font = `700 ${capR * 0.95}px "Source Code Pro", monospace`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("s", 0, capR * 0.04);

    // ---- the ball ----
    const bx = Math.cos(this.ball.angle) * this.ball.radius;
    const by = Math.sin(this.ball.angle) * this.ball.radius;
    const br = Math.max(3, this.R * 0.034);
    // shadow
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.beginPath(); ctx.ellipse(bx, by + br * 0.5, br * 1.05, br * 0.7, 0, 0, TAU); ctx.fill();
    // ball body
    const bg = ctx.createRadialGradient(bx - br * 0.4, by - br * 0.45, br * 0.1, bx, by, br);
    bg.addColorStop(0, "#ffffff"); bg.addColorStop(0.5, "#e6e8ef"); bg.addColorStop(1, "#9aa0b0");
    ctx.fillStyle = bg;
    ctx.shadowColor = "rgba(255,255,255,0.5)"; ctx.shadowBlur = this.spinning ? 10 : 4;
    ctx.beginPath(); ctx.arc(bx, by, br, 0, TAU); ctx.fill();
    ctx.shadowBlur = 0;
    // specular
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.beginPath(); ctx.arc(bx - br * 0.35, by - br * 0.38, br * 0.28, 0, TAU); ctx.fill();

    ctx.restore(); // end perspective
  }

  _ring(ctx, rOut, rIn, stops) {
    const g = ctx.createRadialGradient(0, 0, rIn, 0, 0, rOut);
    stops.forEach(([s, c]) => g.addColorStop(s, c));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, rOut, 0, TAU);
    ctx.arc(0, 0, rIn, 0, TAU, true);
    ctx.fill("evenodd");
  }

  setBonus(b) { this.bonus = b; }

  destroy() { cancelAnimationFrame(this._raf); if (this._ro) this._ro.disconnect(); this.audio.ballStop(); }
}

/* ---------------------------------------------------------------------------
   5. BET MODEL  - covered numbers for each outside/column/dozen bet
   --------------------------------------------------------------------------- */
function coveredNumbers(type, n) {
  switch (type) {
    case "straight": return [n];
    case "red":   return [...RED_NUMBERS];
    case "black": return [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36].filter(x => !RED_NUMBERS.has(x));
    case "odd":   return Array.from({length:36},(_,i)=>i+1).filter(x=>x%2===1);
    case "even":  return Array.from({length:36},(_,i)=>i+1).filter(x=>x%2===0);
    case "low":   return Array.from({length:18},(_,i)=>i+1);
    case "high":  return Array.from({length:18},(_,i)=>i+19);
    case "dozen": return Array.from({length:12},(_,i)=>i+1+n*12); // n = dozen idx 0..2
    case "column":return [n+1, n+4, n+7, n+10, n+13, n+16, n+19, n+22, n+25, n+28, n+31, n+34]; // n = col idx 0..2
    default: return [];
  }
}

/* ---------------------------------------------------------------------------
   6. THE GAME  - orchestrates wheel, board, loop, hooks, fx
   --------------------------------------------------------------------------- */
export class RouletteGame {
  constructor(root, options = {}) {
    this.root = root;
    this.o = Object.assign({
      mode: "demo",
      chipDenoms: [0.05, 0.1, 0.5, 1],
      betWindowMs: 18000,
      lockMs: 2600,
      spinMs: 5200,
      turboSpinMs: 2500,
      payMs: 4200,
      startBalance: 25,           // STT (demo)
      currency: "STT",
      getRound: null,
      onPlaceBets: null,
      onError: null,
    }, options);

    this.audio = new Audio();
    this.denom = this.o.chipDenoms[Math.min(1, this.o.chipDenoms.length - 1)];
    this.bets = new Map();         // cellId -> { type, numbers, n, amount, payout }
    this.placedHistory = [];       // undo stack of cellIds
    this.lastRoundBets = null;     // for rebet
    this.balanceWei = sttToWei(this.o.startBalance);
    this.lockedBets = null;        // bets committed for the current round
    this.phase = "open";
    this.roundId = 1;
    this.recent = [];              // [{roundId, number}]
    this.bettorCount = 0;
    this.turbo = false;
    this.bonus = false;
    this._countEnd = 0;
    this._timers = [];
    this._feedTimer = null;
    this._destroyed = false;

    this._build();
    this._wheel = new Wheel(this.$wheelCanvas, this.audio, this.o);
    this._bindGlobal();
    this._fxInit();

    this.setBalance(this.balanceWei);
    this._renderHistory();
    this._renderStats();

    if (this.o.mode === "demo") this._demoStart();
    else this._engineOpenFromHost();
  }

  /* ---------------------- DOM construction ---------------------- */
  _build() {
    this.root.classList.add("rl-root");
    this.root.dataset.phase = this.phase;
    const C = this.o.currency;
    this.root.innerHTML = `
      <div class="rl-glowfield"></div>
      <div class="rl-grid"></div>
      <div class="rl-scan"></div>
      <div class="rl-grain"></div>
      <div class="rl-app">
        <div class="rl-topbar">
          <div class="rl-chain-pill"><span class="rl-dot"></span> Somnia L1 · on-chain</div>
          <div class="rl-spacer"></div>
          <div class="rl-stat"><span class="rl-k">Round</span><span class="rl-v" data-round>#${this.roundId}</span></div>
          <div class="rl-vsep"></div>
          <div class="rl-stat"><span class="rl-k">Players</span><span class="rl-v" data-players>0</span></div>
          <div class="rl-vsep"></div>
          <div class="rl-stat rl-accent-stat"><span class="rl-k">Balance</span><span class="rl-v" data-balance>0.00 <small>${C}</small></span></div>
        </div>

        <div class="rl-main">
          <div class="rl-stage">
            <div class="rl-wheel-wrap">
              <div class="rl-phase"><span class="rl-phase-led"></span><span class="rl-phase-label" data-phaselabel>OPEN</span></div>
              <button class="rl-iconbtn rl-sound-float" data-sound title="Sound">${ICONS.sound}</button>
              <canvas class="rl-wheel-canvas" data-wheel></canvas>
              <div class="rl-result-badge" data-result></div>
              <div class="rl-nobets" data-nobets><span>No More Bets</span></div>
            </div>
            <div class="rl-timerbox">
              <div class="rl-ring-wrap">
                ${RING_SVG}
                <div class="rl-ring-center">
                  <div class="rl-ring-num" data-countdown>18</div>
                  <div class="rl-ring-cap" data-countcap>betting open</div>
                </div>
              </div>
              <div class="rl-mini-stats">
                <div class="rl-mini"><div class="rl-k">Last result</div><div class="rl-v" data-last>-</div></div>
                <div class="rl-mini"><div class="rl-k">Since last 0</div><div class="rl-v" data-sincezero>0</div></div>
                <div class="rl-mini"><div class="rl-k">Red / Black</div><div class="rl-v"><span class="red" data-redc>0</span> / <span data-blackc>0</span></div></div>
                <div class="rl-mini"><div class="rl-k">Odd / Even</div><div class="rl-v" data-oddeven>0 / 0</div></div>
              </div>
            </div>
          </div>

          <div class="rl-boardpanel">
            <div class="rl-board-head">
              <div class="rl-board-title">Betting Board</div>
              <div class="rl-readouts">
                <div class="rl-readout"><div class="rl-k">Total Bet</div><div class="rl-v" data-totalbet>0.00 ${C}</div></div>
                <div class="rl-readout max"><div class="rl-k">Potential Max Payout</div><div class="rl-v" data-maxpay>0.00 ${C}</div></div>
              </div>
            </div>
            <div class="rl-felt" data-felt></div>
            <div class="rl-controls">
              <div class="rl-chips" data-chips></div>
              <div class="rl-btns">
                <button class="rl-btn" data-undo>Undo</button>
                <button class="rl-btn" data-clear>Clear</button>
                <button class="rl-btn" data-rebet>Rebet</button>
                <button class="rl-btn" data-double>Double</button>
                <button class="rl-btn primary" data-place>Place Bets</button>
              </div>
            </div>
          </div>
        </div>

        <div class="rl-rail">
          <div class="rl-card">
            <div class="rl-card-head"><span class="rl-k">recent results</span><span class="rl-more">last 15</span></div>
            <div class="rl-history" data-history></div>
          </div>
          <div class="rl-card">
            <div class="rl-card-head"><span class="rl-k">table stats</span></div>
            <div class="rl-statgrid">
              <div class="rl-srow"><span class="rl-k">red / black</span><div class="rl-bar" data-rbbar></div><div class="rl-sval" data-rbval><span>0</span><span>0</span></div></div>
              <div class="rl-srow"><span class="rl-k">odd / even</span><div class="rl-bar" data-oebar></div><div class="rl-sval" data-oeval><span>0</span><span>0</span></div></div>
            </div>
            <div class="rl-hotcold">
              <div class="rl-hc hot"><span class="rl-k">hot</span><div class="rl-hc-nums" data-hot></div></div>
              <div class="rl-hc cold"><span class="rl-k">cold</span><div class="rl-hc-nums" data-cold></div></div>
            </div>
          </div>
          <div class="rl-card rl-feed-card" style="flex:1">
            <div class="rl-card-head"><span class="rl-k">live table</span><span class="rl-more" data-feedcount>0 online</span></div>
            <div class="rl-feed" data-feed></div>
          </div>
        </div>
      </div>
      <div class="rl-toast-wrap" data-toasts></div>
      <canvas class="rl-fx" data-fx></canvas>
    `;

    const q = (s) => this.root.querySelector(s);
    this.$ = {
      round: q("[data-round]"), players: q("[data-players]"), balance: q("[data-balance]"),
      sound: q("[data-sound]"),
      wheelCanvas: q("[data-wheel]"), phaseLabel: q("[data-phaselabel]"),
      result: q("[data-result]"), nobets: q("[data-nobets]"),
      countdown: q("[data-countdown]"), countcap: q("[data-countcap]"), ringProg: q(".rl-ring-prog"),
      last: q("[data-last]"), sinceZero: q("[data-sincezero]"), redc: q("[data-redc]"), blackc: q("[data-blackc]"), oddeven: q("[data-oddeven]"),
      totalbet: q("[data-totalbet]"), maxpay: q("[data-maxpay]"),
      felt: q("[data-felt]"), chips: q("[data-chips]"),
      undo: q("[data-undo]"), clear: q("[data-clear]"), rebet: q("[data-rebet]"), double: q("[data-double]"), place: q("[data-place]"),
      history: q("[data-history]"),
      rbbar: q("[data-rbbar]"), oebar: q("[data-oebar]"), rbval: q("[data-rbval]"), oeval: q("[data-oeval]"),
      hot: q("[data-hot]"), cold: q("[data-cold]"),
      feed: q("[data-feed]"), feedcount: q("[data-feedcount]"),
      toasts: q("[data-toasts]"), fx: q("[data-fx]"),
    };
    this.$wheelCanvas = this.$.wheelCanvas;

    this._buildBoard();
    this._buildChips();
    this._bindControls();
  }

  /* ---------------------- board (felt grid) ---------------------- */
  _buildBoard() {
    const felt = this.$.felt;
    felt.innerHTML = "";
    const cells = [];
    const mk = (id, opts) => {
      const c = el("div", "rl-cell " + (opts.cls || ""));
      c.dataset.cell = id;
      c.dataset.type = opts.type;
      if (opts.n != null) c.dataset.n = opts.n;
      c.style.gridArea = opts.area;
      const label = el("span", "lbl", opts.label);
      c.appendChild(label);
      if (opts.pay) { const p = el("span", "pay-tag", opts.pay); c.appendChild(p); }
      felt.appendChild(c);
      cells.push(c);
      return c;
    };

    // grid: rows 1..3 numbers, row4 dozens, row5 outside. col1 zeros, col2..13 nums, col14 columns(2:1)
    // zeros span the 3 number rows in column 1
    mk("s0", { type: "straight", n: 0, cls: "num zero", label: "0", pay: "35:1", area: "1 / 1 / 3 / 2" });
    mk("s00", { type: "straight", n: "00", cls: "num zero", label: "00", pay: "35:1", area: "3 / 1 / 5 / 2" });

    // numbers: top row 3,6,..36 ; mid 2,5..35 ; bottom 1,4..34
    for (let col = 0; col < 12; col++) {
      for (let row = 0; row < 3; row++) {
        const num = col * 3 + (3 - row); // row0->3..., row1->2..., row2->1...
        const c = mk("s" + num, {
          type: "straight", n: num,
          cls: "num " + colorOf(num),
          label: String(num),
          area: `${row + 1} / ${col + 2} / ${row + 2} / ${col + 3}`,
        });
      }
    }

    // NOTE: column bets (the far-right 2:1 column) are intentionally omitted -
    // the on-chain Casino.RouletteBetKind enum exposes straight / dozens /
    // red-black / odd-even / low-high but NOT columns, so we never surface a
    // bet the contract can't settle. Every remaining zone maps 1:1 to a chain
    // bet kind.

    // dozens row (row 4)
    ["1st 12", "2nd 12", "3rd 12"].forEach((lbl, i) => {
      mk("dz" + i, { type: "dozen", n: i, cls: "outside", label: lbl, pay: "2:1",
        area: `4 / ${2 + i * 4} / 5 / ${2 + i * 4 + 4}` });
    });

    // outside row (row 5): 1-18 | EVEN | RED | BLACK | ODD | 19-36
    const outs = [
      { id: "low", type: "low", label: "1-18" },
      { id: "even", type: "even", label: "Even" },
      { id: "red", type: "red", label: "Red", swatch: "red" },
      { id: "black", type: "black", label: "Black", swatch: "black" },
      { id: "odd", type: "odd", label: "Odd" },
      { id: "high", type: "high", label: "19-36" },
    ];
    outs.forEach((o, i) => {
      const c = mk(o.id, { type: o.type, cls: "outside" + (o.swatch ? " sw-" + o.swatch : ""), label: o.label,
        area: `5 / ${2 + i * 2} / 6 / ${2 + i * 2 + 2}` });
      if (o.swatch) {
        c.style.borderColor = o.swatch === "red" ? "var(--rl-red)" : "#3a3a45";
      }
    });

    this._cells = cells;

    // interactions
    felt.addEventListener("click", (e) => {
      const c = e.target.closest(".rl-cell"); if (!c) return;
      this._onCellClick(c);
    });
    felt.addEventListener("contextmenu", (e) => {
      const c = e.target.closest(".rl-cell"); if (!c) return;
      e.preventDefault(); this._removeChip(c.dataset.cell);
    });
    // hover highlight covered numbers + payout
    felt.addEventListener("mouseover", (e) => {
      const c = e.target.closest(".rl-cell"); if (!c) return;
      this._highlightCover(c, true);
    });
    felt.addEventListener("mouseout", (e) => {
      const c = e.target.closest(".rl-cell"); if (!c) return;
      this._highlightCover(c, false);
    });
    // long-press remove (touch)
    let lp;
    felt.addEventListener("touchstart", (e) => {
      const c = e.target.closest(".rl-cell"); if (!c) return;
      lp = setTimeout(() => this._removeChip(c.dataset.cell), 500);
    }, { passive: true });
    felt.addEventListener("touchend", () => clearTimeout(lp));
  }

  _buildChips() {
    const wrap = this.$.chips; wrap.innerHTML = "";
    const colors = ["#3a8bff", "#7c20f0", "#d43800", "#00a866", "#ffd54a", "#ff3df0"];
    this.o.chipDenoms.forEach((d, i) => {
      const c = el("div", "rl-denom" + (d === this.denom ? " sel" : ""));
      c.style.setProperty("--chip", colors[i % colors.length]);
      c.dataset.denom = d;
      c.innerHTML = `${d}<small>${this.o.currency}</small>`;
      c.addEventListener("click", () => {
        this.denom = d; this.audio.unlock(); this.audio.click();
        wrap.querySelectorAll(".rl-denom").forEach(x => x.classList.toggle("sel", x === c));
      });
      wrap.appendChild(c);
    });
    this._chipColors = colors;
  }

  _chipColorFor(denom) {
    const i = this.o.chipDenoms.indexOf(denom);
    return this._chipColors[(i < 0 ? 0 : i) % this._chipColors.length];
  }

  /* ---------------------- controls ---------------------- */
  _bindControls() {
    this.$.undo.onclick = () => this._undo();
    this.$.clear.onclick = () => this._clearBets();
    this.$.rebet.onclick = () => this._rebet();
    this.$.double.onclick = () => this._double();
    this.$.place.onclick = () => this._placeBets();
    if (this.$.sound) this.$.sound.onclick = () => this._toggleSound();
  }

  _toggleSound() {
    this.audio.unlock();
    this.audio.muted = !this.audio.muted;
    this.$.sound.innerHTML = this.audio.muted ? ICONS.muted : ICONS.sound;
    this.$.sound.style.color = this.audio.muted ? "var(--rl-muted)" : "";
  }

  _bindGlobal() {
    this._onResize = () => { this._wheel.resize(); this._fxResize(); };
    window.addEventListener("resize", this._onResize);
    // first-gesture audio unlock
    this._unlockOnce = () => { this.audio.unlock(); window.removeEventListener("pointerdown", this._unlockOnce); };
    window.addEventListener("pointerdown", this._unlockOnce);
  }

  /* ---------------------- betting ---------------------- */
  _canBet() { return this.phase === "open"; }

  _onCellClick(c) {
    this.audio.unlock();
    if (!this._canBet()) { this.audio.deny(); this._toast("Betting is closed", "err"); return; }
    const id = c.dataset.cell;
    const type = c.dataset.type;
    const n = c.dataset.n != null ? (c.dataset.n === "00" ? "00" : Number(c.dataset.n)) : null;
    const amount = this.denom;

    // balance guard
    if (weiToStt(this.balanceWei) < this._totalBet() + amount) {
      this.audio.deny(); this._toast("Insufficient balance", "err"); return;
    }

    let bet = this.bets.get(id);
    if (!bet) {
      const numbers = coveredNumbers(type, n);
      bet = { type, n, numbers, amount: 0, denoms: [] };
      this.bets.set(id, bet);
    }
    bet.amount = +(bet.amount + amount).toFixed(2);
    bet.denoms.push(amount);
    bet.lastDenom = amount;
    this.placedHistory.push(id);
    this.audio.chip();
    this._renderChip(c, bet, true);
    this._updateReadouts();
  }

  _removeChip(id) {
    const bet = this.bets.get(id); if (!bet) return;
    const d = bet.denoms.pop();
    bet.amount = +(bet.amount - (d || bet.lastDenom)).toFixed(2);
    const idx = this.placedHistory.lastIndexOf(id);
    if (idx >= 0) this.placedHistory.splice(idx, 1);
    this.audio.click();
    if (bet.amount <= 0.0001) { this.bets.delete(id); }
    const c = this.root.querySelector(`[data-cell="${CSS.escape(id)}"]`);
    this._renderChip(c, this.bets.get(id), false);
    this._updateReadouts();
  }

  _undo() {
    const id = this.placedHistory.pop(); if (!id) return;
    const bet = this.bets.get(id); if (!bet) return;
    const d = bet.denoms.pop();
    bet.amount = +(bet.amount - (d || 0)).toFixed(2);
    this.audio.click();
    if (bet.amount <= 0.0001) this.bets.delete(id);
    const c = this.root.querySelector(`[data-cell="${CSS.escape(id)}"]`);
    this._renderChip(c, this.bets.get(id), false);
    this._updateReadouts();
  }

  _clearBets() {
    if (!this.bets.size) return;
    this.bets.clear(); this.placedHistory = [];
    this.audio.click();
    this._cells.forEach(c => this._renderChip(c, null, false));
    this._updateReadouts();
  }

  _double() {
    if (!this._canBet() || !this.bets.size) { this.audio.deny(); return; }
    const total = this._totalBet();
    if (weiToStt(this.balanceWei) < total * 2) { this.audio.deny(); this._toast("Insufficient balance to double", "err"); return; }
    this.bets.forEach((bet, id) => {
      bet.amount = +(bet.amount * 2).toFixed(2);
      bet.denoms = [...bet.denoms, ...bet.denoms];
      bet.denoms.forEach(() => this.placedHistory.push(id));
      const c = this.root.querySelector(`[data-cell="${CSS.escape(id)}"]`);
      this._renderChip(c, bet, true);
    });
    this.audio.chip();
    this._updateReadouts();
  }

  _rebet() {
    if (!this._canBet() || !this.lastRoundBets) { this.audio.deny(); return; }
    this._clearBets();
    let total = 0;
    this.lastRoundBets.forEach(b => total += b.amount);
    if (weiToStt(this.balanceWei) < total) { this.audio.deny(); this._toast("Insufficient balance to rebet", "err"); return; }
    this.lastRoundBets.forEach(b => {
      const numbers = coveredNumbers(b.type, b.n);
      const bet = { type: b.type, n: b.n, numbers, amount: b.amount, denoms: b.denoms ? [...b.denoms] : [b.amount], lastDenom: b.lastDenom || b.amount };
      this.bets.set(b.id, bet);
      bet.denoms.forEach(() => this.placedHistory.push(b.id));
      const c = this.root.querySelector(`[data-cell="${CSS.escape(b.id)}"]`);
      this._renderChip(c, bet, true);
    });
    this.audio.chip();
    this._updateReadouts();
  }

  _renderChip(cell, bet, pop) {
    if (!cell) return;
    let stack = cell.querySelector(".rl-chipstack");
    let total = cell.querySelector(".rl-cell-total");
    if (!bet || bet.amount <= 0) {
      if (stack) stack.remove();
      if (total) total.remove();
      cell.classList.remove("has-bet");
      return;
    }
    if (!stack) { stack = el("div", "rl-chipstack"); cell.appendChild(stack); }
    if (!total) { total = el("div", "rl-cell-total"); cell.appendChild(total); }
    const color = this._chipColorFor(bet.lastDenom || this.denom);
    stack.innerHTML = `<div class="rl-chip-disc" style="--chip:${color}">${bet.lastDenom || ""}<span class="rl-chip-cnt">${bet.denoms.length}</span></div>`;
    total.textContent = fmt(bet.amount);
    cell.classList.add("has-bet");
    if (pop) { stack.classList.remove("pop"); void stack.offsetWidth; stack.classList.add("pop"); }
  }

  _totalBet() { let t = 0; this.bets.forEach(b => t += b.amount); return +t.toFixed(2); }

  _maxPayout() {
    // for each possible result, sum payouts; return the max (incl. returned stake)
    const outcomes = [0, "00", ...Array.from({ length: 36 }, (_, i) => i + 1)];
    let max = 0;
    for (const res of outcomes) {
      let win = 0;
      this.bets.forEach(b => {
        const hit = b.numbers.some(x => (x === "00" ? "00" : x) === (res === "00" ? "00" : res));
        if (hit) win += b.amount * (PAYOUT[b.type] + 1); // stake + winnings
      });
      if (win > max) max = win;
    }
    return +max.toFixed(2);
  }

  _updateReadouts() {
    this.$.totalbet.textContent = fmt(this._totalBet()) + " " + this.o.currency;
    this.$.maxpay.textContent = fmt(this._maxPayout()) + " " + this.o.currency;
    const hasBets = this.bets.size > 0;
    this.$.place.disabled = !hasBets || !this._canBet();
    this.$.double.disabled = !hasBets || !this._canBet();
    this.$.undo.disabled = !this.placedHistory.length || !this._canBet();
    this.$.clear.disabled = !hasBets || !this._canBet();
    this.$.rebet.disabled = !this.lastRoundBets || !this._canBet();
  }

  _highlightCover(cell, on) {
    const type = cell.dataset.type;
    const n = cell.dataset.n != null ? (cell.dataset.n === "00" ? "00" : Number(cell.dataset.n)) : null;
    const nums = coveredNumbers(type, n);
    nums.forEach(num => {
      const c = this.root.querySelector(`[data-cell="s${num}"]`);
      if (c) c.classList.toggle("hl", on);
    });
    if (type !== "straight") cell.classList.toggle("hl", on);
  }

  async _placeBets() {
    if (!this._canBet() || !this.bets.size) { this.audio.deny(); return; }
    // build normalized array for host
    const norm = [];
    const snapshot = [];
    this.bets.forEach((b, id) => {
      norm.push({ type: b.type, numbers: b.numbers.map(x => (x === "00" ? -1 : x)), amount: String(b.amount.toFixed(2)) });
      snapshot.push({ id, type: b.type, n: b.n, amount: b.amount, denoms: [...b.denoms], lastDenom: b.lastDenom });
    });

    this.$.place.disabled = true;
    try {
      if (this.o.mode === "production" && typeof this.o.onPlaceBets === "function") {
        await this.o.onPlaceBets(norm);
      }
      // commit
      const total = this._totalBet();
      this.balanceWei -= sttToWei(total.toFixed(2));
      this.setBalance(this.balanceWei);
      this.lockedBets = snapshot;
      this.lastRoundBets = snapshot.map(s => ({ ...s }));
      this.audio.chip();
      this._toast(`Bet placed · ${fmt(total)} ${this.o.currency}`, "win");
      // also drop into feed as "you"
      this.pushCommunityBet({ addr: "you", type: "TOTAL", amount: total, you: true });
    } catch (err) {
      this._error({ kind: "place", message: err?.message || "Transaction failed" });
      this.$.place.disabled = false;
    }
  }

  /* ---------------------- round lifecycle / phases ---------------------- */
  _setPhase(p) {
    this.phase = p;
    this.root.dataset.phase = p;
    const labels = { open: "OPEN", lock: "LOCK", spin: "SPIN", pay: "PAYOUT" };
    this.$.phaseLabel.textContent = labels[p] || p;
    this._updateReadouts();
  }

  _startCountdown(durationMs) {
    this._countEnd = performance.now() + durationMs;
    this._countTotal = durationMs;
    cancelAnimationFrame(this._countRaf);
    const tick = () => {
      const rem = Math.max(0, this._countEnd - performance.now());
      const secs = Math.ceil(rem / 1000);
      this.$.countdown.textContent = secs;
      const frac = this._countTotal ? rem / this._countTotal : 0;
      const C = 2 * Math.PI * 80;
      if (this.$.ringProg) {
        this.$.ringProg.style.strokeDasharray = C;
        this.$.ringProg.style.strokeDashoffset = C * (1 - frac);
        this.$.ringProg.style.stroke = secs <= 5 ? "var(--rl-red-2)" : "var(--rl-accent)";
      }
      // tension ticks in last 5s
      if (this.phase === "open" && secs <= 5 && secs !== this._lastTick && rem > 0) {
        this._lastTick = secs; this.audio.click();
      }
      if (rem > 0 && this.phase === "open") this._countRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  // ---- DEMO engine: full local loop with client RNG ----
  _demoStart() {
    this.bettorCount = 80 + ((Math.random() * 120) | 0);
    this.$.players.textContent = this.bettorCount;
    this.$.feedcount.textContent = this.bettorCount + " online";
    this._startFeed();
    this._demoOpen();
  }

  _demoOpen() {
    this.roundId++;
    this._beginOpenRound(this.roundId, this.o.betWindowMs, this.bettorCount);
    this._after(this.o.betWindowMs, () => this._demoLock());
  }

  _demoLock() {
    this._enterLock();
    this._after(this.o.lockMs, () => {
      // client RNG result (DEMO ONLY)
      const pick = WHEEL_SEQUENCE[(Math.random() * WHEEL_SEQUENCE.length) | 0];
      this.resolveRound(pick);
    });
  }

  _beginOpenRound(roundId, windowMs, bettors) {
    this.roundId = roundId;
    this.$.round.textContent = "#" + roundId;
    this.bettorCount = bettors || this.bettorCount;
    this.$.players.textContent = this.bettorCount;
    this.lockedBets = null;
    this._clearWinStates();
    this._setPhase("open");
    this.$.countcap.textContent = "betting open";
    this.$.felt.classList.remove("locked");
    this.$.result.classList.remove("show");
    this._startCountdown(windowMs);
    this._updateReadouts();
  }

  _enterLock() {
    this._setPhase("lock");
    this.$.countcap.textContent = "no more bets";
    this.$.countdown.textContent = "0";
    this.$.felt.classList.add("locked");
    this.$.felt.classList.add("sweep");
    this._after(1100, () => this.$.felt.classList.remove("sweep"));
    const nb = this.$.nobets; nb.classList.remove("show"); void nb.offsetWidth; nb.classList.add("show");
    this._after(1700, () => nb.classList.remove("show"));
    this.audio.lock();
    this._updateReadouts();
  }

  _engineOpenFromHost() {
    // production: wait for host setRound; show idle open state meanwhile
    this._setPhase("open");
    this.$.countcap.textContent = "waiting for round";
    if (typeof this.o.getRound === "function") {
      this.o.getRound().then(r => r && this.setRound(r)).catch(() => {});
    }
    this._startFeed();
  }

  /* ====================== PUBLIC HOST API ====================== */

  /** Host pushes a new open round + countdown sync. */
  setRound(round = {}) {
    const { roundId, betWindowEndMs, isOpen = true, bettorCount, recentResults } = round;
    if (Array.isArray(recentResults) && recentResults.length) {
      this.recent = recentResults.slice(-15);
      this._renderHistory(); this._renderStats();
    }
    // No open round to show yet (between settle and the next open) - sit in a
    // calm "waiting" state instead of faking a locked round, which used to
    // freeze the countdown on its template value and show "no more bets".
    if (roundId == null && betWindowEndMs == null) {
      clearTimeout(this._lockTimer);
      this._setPhase("open");
      this.$.countcap.textContent = "waiting for round";
      this.$.countdown.textContent = "--";
      this.$.felt.classList.remove("locked");
      this.$.result.classList.remove("show");
      return;
    }
    const dur = betWindowEndMs ? Math.max(0, betWindowEndMs - Date.now()) : this.o.betWindowMs;
    this._beginOpenRound(roundId ?? this.roundId + 1, dur, bettorCount);
    if (!isOpen) {
      this._enterLock();
    } else if (betWindowEndMs) {
      // Lock the board exactly when the on-chain bet window closes so the
      // player can't place a bet the contract would reject (RoundClosed).
      clearTimeout(this._lockTimer);
      this._lockTimer = this._after(Math.max(0, betWindowEndMs - Date.now()), () => {
        if (this.phase === "open") this._enterLock();
      });
    }
  }

  /** THE authoritative outcome. Drives spin → lands ball EXACTLY on resultNumber. */
  async resolveRound(resultNumber) {
    const idx = this._wheel.indexOfNumber(resultNumber);
    if (idx < 0) { this._error({ kind: "resolve", message: "Unknown result number: " + resultNumber }); return; }

    if (this.phase === "open") this._enterLock();
    await this._wait(this.phase === "lock" ? 300 : 0);

    this._setPhase("spin");
    this.$.countcap.textContent = "spinning";
    const dur = this.turbo ? this.o.turboSpinMs : this.o.spinMs;

    await this._wheel.spinTo(idx, dur, this.turbo);

    // landed
    this._setPhase("pay");
    this._showResult(resultNumber);
    this._settle(resultNumber);

    // record history
    this.recent.push({ roundId: this.roundId, number: resultNumber });
    if (this.recent.length > 30) this.recent.shift();
    this._renderHistory();
    this._renderStats();

    // next round
    if (this.o.mode === "demo") {
      this._after(this.o.payMs, () => this._demoOpen());
    }
  }

  setBalance(wei) {
    this.balanceWei = typeof wei === "bigint" ? wei : (String(wei).includes(".") ? sttToWei(wei) : BigInt(wei));
    this.$.balance.innerHTML = `${fmt(weiToStt(this.balanceWei))} <small>${this.o.currency}</small>`;
    this.$.balance.dataset.wei = this.balanceWei.toString();
  }

  setBonusMode(on) {
    this.bonus = !!on;
    this.root.classList.toggle("rl-bonus", this.bonus);
    this._wheel.setBonus(this.bonus);
    if (on) this._toast("⚡ BONUS MODE ACTIVATED", "win");
  }

  pushCommunityBet({ addr, type, amount, you = false } = {}) {
    const feed = this.$.feed;
    const label = (type || "RED").toUpperCase();
    const tagColor = ({ RED: "var(--rl-red)", BLACK: "#2a2a32", ODD: "var(--rl-blue)", EVEN: "var(--rl-cyan)",
      TOTAL: "var(--rl-accent)", STRAIGHT: "var(--rl-purple)" })[label] || "var(--rl-accent)";
    const row = el("div", "rl-feed-row" + (you ? " you" : ""));
    row.innerHTML = `
      <span class="rl-feed-addr">${you ? "you" : (addr || shortAddr())}</span>
      <span class="rl-feed-mid">bet</span>
      <span class="rl-feed-tag" style="background:${tagColor}">${label}</span>
      <span class="rl-feed-amt">${fmt(amount || 0)} ${this.o.currency}</span>`;
    feed.prepend(row);
    while (feed.children.length > 9) feed.lastChild.remove();
    // ghost chip on board for straight/outside bets during open phase
    if (!you && this._canBet() && Math.random() < 0.5) this._ghostChip(type);
  }

  destroy() {
    this._destroyed = true;
    this._timers.forEach(t => clearTimeout(t));
    cancelAnimationFrame(this._countRaf);
    cancelAnimationFrame(this._fxRaf);
    clearInterval(this._feedTimer);
    window.removeEventListener("resize", this._onResize);
    window.removeEventListener("pointerdown", this._unlockOnce);
    this._wheel.destroy();
    this.audio.ballStop();
    this.root.innerHTML = "";
    this.root.classList.remove("rl-root", "rl-bonus");
  }

  /* ====================== settle / payouts ====================== */
  _settle(resultNumber) {
    const winNum = resultNumber === "00" ? "00" : Number(resultNumber);
    let totalReturn = 0, totalStake = 0, anyWin = false, bestMult = 0;
    const bets = this.lockedBets || [];

    // mark winning straight cell
    const winCell = this.root.querySelector(`[data-cell="s${resultNumber}"]`);
    if (winCell) winCell.classList.add("win");

    bets.forEach(b => {
      totalStake += b.amount;
      const numbers = coveredNumbers(b.type, b.n);
      const hit = numbers.some(x => (x === "00" ? "00" : x) === winNum);
      const cell = this.root.querySelector(`[data-cell="${CSS.escape(b.id)}"]`);
      if (hit) {
        anyWin = true;
        const mult = PAYOUT[b.type] + 1;
        bestMult = Math.max(bestMult, PAYOUT[b.type]);
        totalReturn += b.amount * mult;
        if (cell) cell.classList.add("win");
      } else {
        if (cell) cell.classList.add("lose");
      }
    });

    if (anyWin) {
      this.balanceWei += sttToWei(totalReturn.toFixed(2));
      this.setBalance(this.balanceWei);
      this._countUp(totalReturn);
      this.audio.win(bestMult);
      this._burst(bestMult);
      this._toast(`WIN +${fmt(totalReturn)} ${this.o.currency}`, "win");
    } else if (bets.length) {
      this.audio.lose();
      // near-miss check: any straight bet adjacent on the wheel?
      const near = bets.some(b => b.type === "straight" && this._isAdjacent(b.n, winNum));
      this._toast(near ? "So close…" : `Result ${resultNumber}`, near ? "err" : "");
    }
  }

  _isAdjacent(a, b) {
    const ia = this._wheel.indexOfNumber(a), ib = this._wheel.indexOfNumber(b);
    if (ia < 0 || ib < 0) return false;
    const n = WHEEL_SEQUENCE.length;
    const d = Math.abs(ia - ib);
    return d === 1 || d === n - 1;
  }

  _clearWinStates() {
    this._cells.forEach(c => c.classList.remove("win", "lose", "hl"));
    this.bets.clear(); this.placedHistory = [];
    this._cells.forEach(c => this._renderChip(c, null, false));
  }

  _showResult(num) {
    const badge = this.$.result;
    const col = colorOf(num);
    const bg = col === "red" ? "#d43800" : col === "green" ? "#00653e" : "#16161a";
    badge.style.background = bg;
    badge.style.color = col === "red" ? "#ff5a2a" : col === "green" ? "#00a866" : "#6e6eed";
    badge.textContent = num;
    badge.classList.remove("show"); void badge.offsetWidth; badge.classList.add("show");
    this.$.last.textContent = num;
    this.$.last.style.color = col === "red" ? "var(--rl-red-2)" : col === "green" ? "var(--rl-green-2)" : "var(--rl-ink)";
  }

  _countUp(target) {
    const node = this.$.maxpay;
    const start = performance.now(); const dur = 900;
    const tick = (t) => {
      const p = clamp((t - start) / dur, 0, 1);
      node.textContent = fmt(target * easeOutCubic(p)) + " " + this.o.currency;
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /* ====================== history / stats ====================== */
  _renderHistory() {
    const h = this.$.history; h.innerHTML = "";
    const list = this.recent.slice(-15).reverse();
    list.forEach(r => {
      const col = colorOf(r.number);
      const p = el("div", "rl-pill " + col); p.textContent = r.number;
      h.appendChild(p);
    });
    if (!list.length) h.innerHTML = `<span style="color:var(--rl-faint);font-size:12px">no rounds yet</span>`;
  }

  _renderStats() {
    const nums = this.recent.map(r => r.number);
    let red = 0, black = 0, odd = 0, even = 0, sinceZero = 0;
    let seenZero = false;
    for (let i = nums.length - 1; i >= 0; i--) {
      if (!seenZero) { if (nums[i] === 0 || nums[i] === "00") seenZero = true; else sinceZero++; }
    }
    nums.forEach(n => {
      const c = colorOf(n);
      if (c === "red") red++; else if (c === "black") black++;
      if (n !== 0 && n !== "00") { if (Number(n) % 2) odd++; else even++; }
    });
    const rbTot = red + black || 1, oeTot = odd + even || 1;
    this.$.rbbar.innerHTML = `<i class="red" style="width:${red/rbTot*100}%"></i><i class="black" style="width:${black/rbTot*100}%"></i>`;
    this.$.oebar.innerHTML = `<i class="odd" style="width:${odd/oeTot*100}%"></i><i class="even" style="width:${even/oeTot*100}%"></i>`;
    this.$.rbval.innerHTML = `<span style="color:var(--rl-red-2)">${red} red</span><span>${black} black</span>`;
    this.$.oeval.innerHTML = `<span style="color:var(--rl-blue)">${odd} odd</span><span style="color:var(--rl-cyan)">${even} even</span>`;
    this.$.redc.textContent = red; this.$.blackc.textContent = black;
    this.$.oddeven.textContent = `${odd} / ${even}`;
    this.$.sinceZero.textContent = sinceZero;

    // hot / cold over recent
    const freq = new Map();
    nums.forEach(n => freq.set(n, (freq.get(n) || 0) + 1));
    const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
    const hot = sorted.slice(0, 3).map(e => e[0]);
    const cold = sorted.slice(-3).reverse().map(e => e[0]);
    const renderNums = (node, arr) => {
      node.innerHTML = "";
      arr.forEach(n => { const c = el("div", "rl-hc-num " + colorOf(n)); c.textContent = n; node.appendChild(c); });
      if (!arr.length) node.innerHTML = `<span style="color:var(--rl-faint);font-size:11px">-</span>`;
    };
    renderNums(this.$.hot, hot);
    renderNums(this.$.cold, nums.length >= 6 ? cold : []);
  }

  /* ====================== community feed (demo) ====================== */
  _startFeed() {
    if (this._feedTimer) return;
    const types = ["red", "black", "odd", "even", "straight", "low", "high", "dozen"];
    const amts = [...this.o.chipDenoms, 0.25, 0.75, 1.5, 2, 0.2];
    const tick = () => {
      if (this._destroyed) return;
      const type = types[(Math.random() * types.length) | 0];
      const amount = amts[(Math.random() * amts.length) | 0];
      this.pushCommunityBet({ addr: shortAddr(), type, amount });
      // occasional player count drift
      if (Math.random() < 0.3) {
        this.bettorCount = clamp(this.bettorCount + ((Math.random() * 7 - 3) | 0), 60, 260);
        this.$.players.textContent = this.bettorCount;
        this.$.feedcount.textContent = this.bettorCount + " online";
      }
      this._feedTimer = setTimeout(tick, rnd(700, 2100));
    };
    this._feedTimer = setTimeout(tick, 600);
  }

  _ghostChip(type) {
    // drop a transient chip on a plausible cell
    let sel;
    if (type === "straight") sel = `[data-cell="s${1 + ((Math.random() * 36) | 0)}"]`;
    else sel = `[data-cell="${["red","black","odd","even","low","high"][(Math.random()*6)|0]}"]`;
    const c = this.root.querySelector(sel); if (!c) return;
    const g = el("div", "rl-ghost-chip");
    g.style.left = (20 + Math.random() * 50) + "%";
    g.style.top = "20%";
    c.appendChild(g);
    setTimeout(() => g.remove(), 1200);
  }

  /* ====================== fx (win particles) ====================== */
  _fxInit() {
    this.fxCtx = this.$.fx.getContext("2d");
    this.parts = [];
    this._fxResize();
    const loop = () => {
      this._fxStep();
      this._fxRaf = requestAnimationFrame(loop);
    };
    this._fxRaf = requestAnimationFrame(loop);
  }
  _fxResize() {
    const r = this.root.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.$.fx.width = r.width * dpr; this.$.fx.height = r.height * dpr;
    this.fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._fxW = r.width; this._fxH = r.height;
  }
  _burst(mult) {
    // origin near the wheel center
    const wr = this.$.wheelCanvas.getBoundingClientRect();
    const rr = this.root.getBoundingClientRect();
    const ox = wr.left - rr.left + wr.width / 2;
    const oy = wr.top - rr.top + wr.height / 2;
    const n = clamp(40 + mult * 4, 40, 220);
    const colors = this.bonus ? ["#ff3df0", "#ff7a3d", "#ffd54a"] : ["#7c20f0", "#6e6eed", "#ffd54a", "#25e8d6"];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, sp = rnd(2, 9) * (1 + mult / 35);
      this.parts.push({
        x: ox, y: oy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - rnd(0, 3),
        life: 1, decay: rnd(0.008, 0.02), size: rnd(2, 5),
        color: colors[(Math.random() * colors.length) | 0],
      });
    }
  }
  _fxStep() {
    const ctx = this.fxCtx;
    ctx.clearRect(0, 0, this._fxW, this._fxH);
    if (!this.parts.length) return;
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.vy += 0.18; p.vx *= 0.99;
      p.x += p.vx; p.y += p.vy; p.life -= p.decay;
      if (p.life <= 0 || p.y > this._fxH + 20) { this.parts.splice(i, 1); continue; }
      ctx.globalAlpha = clamp(p.life, 0, 1);
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color; ctx.shadowBlur = 8;
      ctx.fillRect(p.x, p.y, p.size, p.size);
    }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  }

  /* ====================== helpers ====================== */
  _toast(msg, kind = "") {
    const t = el("div", "rl-toast " + kind, msg);
    this.$.toasts.appendChild(t);
    setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; setTimeout(() => t.remove(), 300); }, 2200);
  }
  _error(e) {
    this._toast(e.message || "Error", "err");
    if (typeof this.o.onError === "function") this.o.onError(e);
  }
  _after(ms, fn) { const id = setTimeout(() => { if (!this._destroyed) fn(); }, ms); this._timers.push(id); return id; }
  _wait(ms) { return new Promise(r => this._after(ms, r)); }
}

/* ---------------------------------------------------------------------------
   7. INLINE ASSETS (icons + ring svg)
   --------------------------------------------------------------------------- */
const ICONS = {
  sound: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`,
  muted: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`,
  turbo: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
};

const RING_SVG = `
  <svg class="rl-ring" width="180" height="180" viewBox="0 0 180 180">
    <circle class="rl-ring-track" cx="90" cy="90" r="80"></circle>
    <circle class="rl-ring-prog" cx="90" cy="90" r="80" stroke-dasharray="502" stroke-dashoffset="0"></circle>
  </svg>`;

export default RouletteGame;
