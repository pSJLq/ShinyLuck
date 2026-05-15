/* ==========================================================
 * Synthesized audio — no external assets.
 * Web Audio API. Lazy-inits on first user gesture.
 * ========================================================== */

(function () {
  let ctx = null;
  let master = null;
  let enabled = true;
  let inited = false;

  function init() {
    if (inited) return;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 0.35;
      master.connect(ctx.destination);
      inited = true;
    } catch (e) { /* no audio */ }
  }

  function ensure() {
    if (!inited) init();
    if (ctx && ctx.state === 'suspended') ctx.resume();
    return inited && enabled;
  }

  // -------- tone helpers
  function tone({ freq=440, type='sine', dur=0.15, vol=0.3, attack=0.005, decay=0.08, sustain=0, release=0.08, detune=0, dest=null }) {
    if (!ensure()) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type; o.frequency.value = freq; o.detune.value = detune;
    o.connect(g); g.connect(dest || master);
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.linearRampToValueAtTime(vol * sustain, t + attack + decay);
    g.gain.linearRampToValueAtTime(0, t + attack + decay + dur + release);
    o.start(t);
    o.stop(t + attack + decay + dur + release + 0.02);
  }

  function noiseBurst({ dur=0.18, vol=0.22, freq=1200, q=4, lowpass=true }) {
    if (!ensure()) return;
    const bufSize = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / bufSize);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = lowpass ? 'lowpass' : 'highpass';
    filt.frequency.value = freq; filt.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(filt); filt.connect(g); g.connect(master);
    src.start();
    src.stop(ctx.currentTime + dur + 0.05);
  }

  // -------- effects
  let reelLoopNodes = null;
  function startReelLoop() {
    if (!ensure()) return;
    stopReelLoop();
    const src = ctx.createBufferSource();
    const bufSize = ctx.sampleRate * 1.0;
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) d[i] = (Math.random() * 2 - 1);
    src.buffer = buf; src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 700; bp.Q.value = 3;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 0.08);
    src.connect(bp); bp.connect(g); g.connect(master);
    src.start();
    reelLoopNodes = { src, g };
  }
  function stopReelLoop() {
    if (!reelLoopNodes) return;
    const { src, g } = reelLoopNodes;
    g.gain.cancelScheduledValues(ctx.currentTime);
    g.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.08);
    setTimeout(() => { try { src.stop(); } catch {} }, 120);
    reelLoopNodes = null;
  }

  function click() { tone({ freq: 220, type: 'square', dur: 0.04, vol: 0.18, attack: 0.001, decay: 0.02, release: 0.03 }); }
  function reelStop(i = 0) {
    const pitch = 180 + i * 30;
    tone({ freq: pitch, type: 'square', dur: 0.06, vol: 0.18, attack: 0.001, decay: 0.04, release: 0.06 });
    noiseBurst({ dur: 0.09, vol: 0.1, freq: 800, q: 6 });
  }
  function symbolPop(i = 0) {
    const scale = [523.25, 587.33, 659.25, 698.46, 783.99, 880, 987.77]; // C maj
    const f = scale[i % scale.length] * 2;
    tone({ freq: f, type: 'triangle', dur: 0.08, vol: 0.16, attack: 0.002, decay: 0.06, release: 0.08 });
    tone({ freq: f * 2, type: 'sine', dur: 0.08, vol: 0.08, attack: 0.002, decay: 0.04, release: 0.08 });
  }
  function cascadeChime(step = 0) {
    const base = 440;
    const scale = [1, 1.2, 1.4, 1.6, 1.8, 2.0, 2.4, 2.8, 3.2];
    const m = scale[Math.min(step, scale.length - 1)];
    tone({ freq: base * m, type: 'sine', dur: 0.16, vol: 0.22, attack: 0.005, decay: 0.1, release: 0.18 });
    tone({ freq: base * m * 1.5, type: 'triangle', dur: 0.18, vol: 0.12, attack: 0.005, decay: 0.1, release: 0.18 });
  }
  function winChime() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => setTimeout(() => {
      tone({ freq: f, type: 'triangle', dur: 0.2, vol: 0.2, attack: 0.005, decay: 0.12, release: 0.2 });
    }, i * 70));
  }
  function bigWin(tier = 'BIG') {
    const seq = tier === 'EPIC'
      ? [261.63, 329.63, 392, 523.25, 659.25, 783.99, 1046.5, 1318.5, 1568, 2093]
      : tier === 'MEGA'
        ? [261.63, 329.63, 392, 523.25, 659.25, 783.99, 1046.5]
        : [392, 523.25, 659.25, 783.99, 1046.5];
    seq.forEach((f, i) => setTimeout(() => {
      tone({ freq: f, type: 'triangle', dur: 0.22, vol: 0.26, attack: 0.005, decay: 0.14, release: 0.2 });
      tone({ freq: f * 0.5, type: 'sine', dur: 0.22, vol: 0.14, attack: 0.005, decay: 0.14, release: 0.2 });
    }, i * 110));
    // bass thump
    setTimeout(() => tone({ freq: 65, type: 'sine', dur: 0.4, vol: 0.4, attack: 0.005, decay: 0.3, release: 0.3 }), 0);
  }
  function scatterLand(i = 0) {
    const f = 1200 + i * 200;
    tone({ freq: f, type: 'sine', dur: 0.25, vol: 0.22, attack: 0.005, decay: 0.18, release: 0.2 });
    tone({ freq: f * 1.5, type: 'triangle', dur: 0.25, vol: 0.14, attack: 0.005, decay: 0.18, release: 0.2 });
    noiseBurst({ dur: 0.3, vol: 0.12, freq: 4000, q: 1, lowpass: false });
  }
  function multiplierLand(mult = 2) {
    const f = 300 + Math.log2(mult) * 80;
    tone({ freq: f, type: 'sawtooth', dur: 0.15, vol: 0.25, attack: 0.003, decay: 0.1, release: 0.15 });
    tone({ freq: f * 2, type: 'sine', dur: 0.15, vol: 0.15, attack: 0.003, decay: 0.1, release: 0.15 });
  }
  function bonusTrigger() {
    [261.63, 329.63, 392, 523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => setTimeout(() => {
      tone({ freq: f, type: 'triangle', dur: 0.16, vol: 0.24, attack: 0.005, decay: 0.1, release: 0.16 });
    }, i * 80));
    setTimeout(() => tone({ freq: 65, type: 'sine', dur: 0.5, vol: 0.4, attack: 0.005, decay: 0.4, release: 0.3 }), 0);
  }
  function coinDrop(i = 0) {
    const f = 800 + Math.random() * 600;
    tone({ freq: f, type: 'triangle', dur: 0.06, vol: 0.08, attack: 0.001, decay: 0.04, release: 0.06 });
    tone({ freq: f * 1.5, type: 'sine', dur: 0.06, vol: 0.06, attack: 0.001, decay: 0.04, release: 0.06 });
  }
  function hover() { tone({ freq: 660, type: 'sine', dur: 0.03, vol: 0.04, attack: 0.001, decay: 0.02, release: 0.02 }); }
  function setEnabled(on) { enabled = !!on; if (!on) stopReelLoop(); }
  function isEnabled() { return enabled; }

  document.addEventListener('click', () => init(), { once: true });
  document.addEventListener('keydown', () => init(), { once: true });

  window.SFX = {
    init, click, reelStop, symbolPop, cascadeChime, winChime, bigWin,
    scatterLand, multiplierLand, bonusTrigger, coinDrop, hover,
    startReelLoop, stopReelLoop,
    setEnabled, isEnabled,
  };
})();
