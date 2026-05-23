/* ============================================================================
 * sugar/sound.js - synthesized audio (Web Audio, no external assets)
 * ES module. Lazy init on first user gesture.
 * ============================================================================ */

let ctx = null;
let master = null;
let enabled = true;
let inited = false;
let userGestured = false; // becomes true after first click/keydown
let reelLoopNodes = null;

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
  if (!enabled || !inited || !ctx) return false;
  // CRITICAL: AudioContext.resume() WITHOUT a user gesture spams the
  // console with `AudioContext was not allowed to start` and silently
  // stays suspended anyway. Hovers fire many times before the user
  // clicks anywhere → 14 warnings on page load. Skip until we've seen
  // an actual gesture. After the first click/keydown we resume once
  // and stay running.
  if (ctx.state === 'suspended') {
    if (!userGestured) return false;
    ctx.resume().catch(() => {});
  }
  return true;
}
function tone({ freq=440, type='sine', dur=0.15, vol=0.3, attack=0.005, decay=0.08, sustain=0, release=0.08, detune=0 }) {
  if (!ensure()) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type; o.frequency.value = freq; o.detune.value = detune;
  o.connect(g); g.connect(master);
  const t = ctx.currentTime;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + attack);
  g.gain.linearRampToValueAtTime(vol * sustain, t + attack + decay);
  g.gain.linearRampToValueAtTime(0, t + attack + decay + dur + release);
  o.start(t); o.stop(t + attack + decay + dur + release + 0.02);
}
function noiseBurst({ dur=0.18, vol=0.22, freq=1200, q=4, lowpass=true }) {
  if (!ensure()) return;
  const bs = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, bs, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < bs; i++) d[i] = (Math.random()*2 - 1) * (1 - i/bs);
  const src = ctx.createBufferSource(); src.buffer = buf;
  const f = ctx.createBiquadFilter(); f.type = lowpass ? 'lowpass' : 'highpass'; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain(); g.gain.value = vol;
  src.connect(f); f.connect(g); g.connect(master);
  src.start(); src.stop(ctx.currentTime + dur + 0.05);
}

export const SFX = {
  init, setEnabled(v){ enabled = !!v; if(!v) stopReelLoop(); }, isEnabled(){ return enabled; },
  click() { tone({ freq:220, type:'square', dur:0.04, vol:0.18, attack:.001, decay:.02, release:.03 }); },
  hover() { tone({ freq:660, type:'sine', dur:0.03, vol:0.04, attack:.001, decay:.02, release:.02 }); },
  reelStop(i=0) {
    tone({ freq:180+i*30, type:'square', dur:0.06, vol:0.18, attack:.001, decay:.04, release:.06 });
    noiseBurst({ dur:0.09, vol:0.1, freq:800, q:6 });
  },
  symbolPop(i=0) {
    const scale = [523.25,587.33,659.25,698.46,783.99,880,987.77];
    const f = scale[i % scale.length] * 2;
    tone({ freq:f, type:'triangle', dur:0.08, vol:0.16, attack:.002, decay:.06, release:.08 });
    tone({ freq:f*2, type:'sine', dur:0.08, vol:0.08, attack:.002, decay:.04, release:.08 });
  },
  cascadeChime(step=0) {
    const base = 440;
    const scale = [1,1.2,1.4,1.6,1.8,2.0,2.4,2.8,3.2];
    const m = scale[Math.min(step, scale.length-1)];
    tone({ freq:base*m,   type:'sine',     dur:0.16, vol:0.22, attack:.005, decay:.1, release:.18 });
    tone({ freq:base*m*1.5, type:'triangle', dur:0.18, vol:0.12, attack:.005, decay:.1, release:.18 });
  },
  bigWin(tier='BIG') {
    const seq = tier==='EPIC' ? [261.63,329.63,392,523.25,659.25,783.99,1046.5,1318.5,1568,2093]
              : tier==='MEGA' ? [261.63,329.63,392,523.25,659.25,783.99,1046.5]
              : [392,523.25,659.25,783.99,1046.5];
    seq.forEach((f,i) => setTimeout(()=>{
      tone({ freq:f,    type:'triangle', dur:0.22, vol:0.26, attack:.005, decay:.14, release:.2 });
      tone({ freq:f*.5, type:'sine',     dur:0.22, vol:0.14, attack:.005, decay:.14, release:.2 });
    }, i*110));
    setTimeout(()=> tone({ freq:65, type:'sine', dur:0.4, vol:0.4, attack:.005, decay:.3, release:.3 }), 0);
  },
  scatterLand(i=0) {
    const f = 1200 + i*200;
    tone({ freq:f,    type:'sine',     dur:0.25, vol:0.22, attack:.005, decay:.18, release:.2 });
    tone({ freq:f*1.5,type:'triangle', dur:0.25, vol:0.14, attack:.005, decay:.18, release:.2 });
    noiseBurst({ dur:0.3, vol:0.12, freq:4000, q:1, lowpass:false });
  },
  multiplierLand(mult=2) {
    const f = 300 + Math.log2(mult)*80;
    tone({ freq:f,   type:'sawtooth', dur:0.15, vol:0.25, attack:.003, decay:.1, release:.15 });
    tone({ freq:f*2, type:'sine',     dur:0.15, vol:0.15, attack:.003, decay:.1, release:.15 });
  },
  bonusTrigger() {
    [261.63,329.63,392,523.25,659.25,783.99,1046.5,1318.5].forEach((f,i) => setTimeout(()=>{
      tone({ freq:f, type:'triangle', dur:0.16, vol:0.24, attack:.005, decay:.1, release:.16 });
    }, i*80));
    setTimeout(()=> tone({ freq:65, type:'sine', dur:0.5, vol:0.4, attack:.005, decay:.4, release:.3 }), 0);
  },
  coinDrop() {
    const f = 800 + Math.random()*600;
    tone({ freq:f,    type:'triangle', dur:0.06, vol:0.08, attack:.001, decay:.04, release:.06 });
    tone({ freq:f*1.5, type:'sine',    dur:0.06, vol:0.06, attack:.001, decay:.04, release:.06 });
  },
  startReelLoop() {
    if (!ensure()) return;
    stopReelLoop();
    const src = ctx.createBufferSource();
    const bs = ctx.sampleRate * 1.0;
    const buf = ctx.createBuffer(1, bs, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < bs; i++) d[i] = (Math.random()*2 - 1);
    src.buffer = buf; src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=700; bp.Q.value=3;
    const g = ctx.createGain(); g.gain.value = 0; g.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 0.08);
    src.connect(bp); bp.connect(g); g.connect(master);
    src.start();
    reelLoopNodes = { src, g };
  },
  stopReelLoop,
};

function stopReelLoop() {
  if (!reelLoopNodes || !ctx) return;
  const { src, g } = reelLoopNodes;
  g.gain.cancelScheduledValues(ctx.currentTime);
  g.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.08);
  setTimeout(()=>{ try { src.stop(); } catch {} }, 120);
  reelLoopNodes = null;
}

function onFirstGesture() {
  userGestured = true;
  init();
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
}
document.addEventListener('click',       onFirstGesture, { once: true });
document.addEventListener('keydown',     onFirstGesture, { once: true });
document.addEventListener('pointerdown', onFirstGesture, { once: true });
