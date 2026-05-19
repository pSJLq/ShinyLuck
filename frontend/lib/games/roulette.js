// Roulette — round-based + multi-bet (up to 5 bets per player per round).
//
// American wheel: 38 outcomes — 0, 1..36, 00 (encoded on-chain as 37).
// House edge 5.26% (vs European 2.70%).
//
// Workflow:
//   1. Player clicks bet zones on the felt (built by buildFelt()) → basket.
//   2. Click "Place bets" → SL.placeRoulette([{kind, number, amountSTT}, …]).
//   3. After r.betWindowEnd + 4 blocks, reveal-bot calls settleRouletteRound.
//   4. spinWheel() animates the wheel with smooth accel + decel, lands on the
//      result segment under the pointer, then stays there until next round.

import { ethers } from "https://esm.sh/ethers@6.13.2";
import { SL, connect } from "../wallet.js";
import { CONFIG } from "../config.js";
import { provider, fetchRecentLogs } from "../rpc.js";
import {
  $, $$, setText, fmtSTTfromString, readStakeStr, injectKeyframes,
  setStagePill, setResultBanner, clearResultBanner, clearFairServer,
  populateFairPanel, friendlyError, fmtSTT, refreshEV,
} from "./_base.js";
import { validateStake } from "../errors.js";
import { readMaxBet } from "../casino-limits.js";

const ROULETTE = 5;
// Was 1000ms — see crash.js note. WS push handles real state changes; the
// poll is a fallback. 3s prevents main-thread spam and cursor lag.
const POLL_MS = 3000;

const KINDS = {
  STRAIGHT: 0, RED: 1, BLACK: 2, EVEN: 3, ODD: 4,
  LOW: 5, HIGH: 6, DOZEN_1: 7, DOZEN_2: 8, DOZEN_3: 9,
};

// American wheel order, clockwise from the top (12 o'clock = pocket 0).
// 00 is encoded as 37 in the chain protocol.
const AMERICAN_ORDER = [
  0, 28, 9, 26, 30, 11, 7, 20, 32, 17, 5, 22, 34, 15, 3, 24, 36, 13, 1,
  37, 27, 10, 25, 29, 12, 8, 19, 31, 18, 6, 21, 33, 16, 4, 23, 35, 14, 2,
];
const REDS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const N_SEGMENTS = AMERICAN_ORDER.length; // 38

function displayNumber(num) {
  return num === 37 ? "00" : String(num);
}
function pocketFill(num) {
  if (num === 0 || num === 37) return "#15803d";  // green
  return REDS.has(num) ? "#dc2626" : "#0a0a0c";
}

let casinoRO = null;
function casino() {
  if (!casinoRO) {
    const abi = [
      "function currentRouletteRoundId() view returns (uint256)",
      "function totalRouletteRounds() view returns (uint256)",
      "function getRouletteRound(uint256) view returns (uint64,uint64,uint64,uint32,bool,uint8,bytes32,uint256)",
      "function getRouletteBets(uint256,address) view returns (tuple(uint8 kind,uint8 number,uint96 amount)[])",
      "event RouletteRoundStarted(uint256 indexed roundId,uint256 betWindowEnd,uint256 commitBlock,uint256 seedIdx)",
      "event RouletteRoundSettled(uint256 indexed roundId,uint8 resultNumber,bytes32 serverSeed,bytes32 randomness)",
      "event RouletteBetPlaced(uint256 indexed roundId,address indexed player,uint8 kind,uint8 number,uint256 amount)",
    ];
    casinoRO = new ethers.Contract(CONFIG.casino, abi, provider());
  }
  return casinoRO;
}

let activeRound = null;
let basket = [];
let countdownHandle = null;
const animatedRounds = new Set();
let lastRenderedRoundId = -1;

function fmtCountdown(s) {
  // Defensive: a NaN (e.g. on first paint before round metadata loads) would
  // produce a "NaN:NaN" string in the round-clock element. Treat anything
  // non-finite as 0:00.
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

function renderBasket() {
  const root = $("[data-sl-roulette-basket]");
  if (!root) return;
  root.innerHTML = "";
  if (basket.length === 0) {
    root.innerHTML = `<div class="m" style="opacity:.4;">click a bet zone to add to basket</div>`;
  } else {
    for (let i = 0; i < basket.length; i++) {
      const b = basket[i];
      const row = document.createElement("div");
      row.className = "m";
      row.style.cssText = "display:flex; justify-content:space-between; gap:6px; font-size:11px; padding: 4px 0;";
      row.innerHTML = `<span>${b.label}</span><span>${b.amountSTT} STT</span><button data-rm="${i}" style="background:none; border:1px solid var(--line); color:var(--fg-mute); padding:0 6px; cursor:pointer;">×</button>`;
      root.appendChild(row);
    }
    root.querySelectorAll("button[data-rm]").forEach((b) => {
      b.addEventListener("click", () => {
        const idx = parseInt(b.dataset.rm, 10);
        basket.splice(idx, 1);
        renderBasket();
      });
    });
  }
  const total = basket.reduce((s, b) => s + parseFloat(b.amountSTT), 0);
  setText("[data-sl-roulette-total]", total.toFixed(4) + " STT");
  const placeBtn = $("[data-sl-place]");
  if (placeBtn) {
    placeBtn.disabled = basket.length === 0;
    placeBtn.textContent = basket.length === 0 ? "Add at least one bet" : `Place ${basket.length} bet${basket.length>1?"s":""} — ${total.toFixed(4)} STT`;
  }
  refreshEV(ROULETTE).catch(() => {});
}

async function addToBasket(kind, number, label) {
  const { toast } = await import("../ui.js");
  if (basket.length >= 5) { toast("Max 5 bets per round", { kind: "warn" }); return; }
  const stake = readStakeStr() || "0.05";
  const stakeErr = validateStake(stake); if (stakeErr) { toast(stakeErr, { kind: "warn" }); return; }
  basket.push({ kind, number, amountSTT: stake, label });
  renderBasket();
}

/// Build the American-wheel SVG: 38 segments + numbers in AMERICAN_ORDER,
/// pocket 0 at the top (12 o'clock), 00 on the opposite side (6 o'clock).
function buildWheel() {
  const wheel = document.querySelector("#rsegments");
  if (!wheel) return;
  wheel.innerHTML = "";
  const R = 150, r = 115;
  for (let i = 0; i < N_SEGMENTS; i++) {
    const num = AMERICAN_ORDER[i];
    const a1 = (i / N_SEGMENTS) * Math.PI * 2 - Math.PI / 2;
    const a2 = ((i + 1) / N_SEGMENTS) * Math.PI * 2 - Math.PI / 2;
    const x1 = Math.cos(a1)*R, y1 = Math.sin(a1)*R;
    const x2 = Math.cos(a2)*R, y2 = Math.sin(a2)*R;
    const x3 = Math.cos(a2)*r, y3 = Math.sin(a2)*r;
    const x4 = Math.cos(a1)*r, y4 = Math.sin(a1)*r;
    const seg = document.createElementNS("http://www.w3.org/2000/svg", "path");
    seg.setAttribute("d", `M${x1},${y1} A${R},${R} 0 0 1 ${x2},${y2} L${x3},${y3} A${r},${r} 0 0 0 ${x4},${y4} Z`);
    seg.setAttribute("fill", pocketFill(num));
    seg.setAttribute("stroke", "#27272d");
    seg.setAttribute("stroke-width", "0.5");
    wheel.appendChild(seg);
    const am = (a1 + a2) / 2;
    const tx = Math.cos(am) * (R - 15);
    const ty = Math.sin(am) * (R - 15);
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("x", tx); t.setAttribute("y", ty);
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("dominant-baseline", "middle");
    t.setAttribute("font-family", "JetBrains Mono"); t.setAttribute("font-size", "9");
    t.setAttribute("fill", "#fff");
    t.setAttribute("transform", `rotate(${(am * 180/Math.PI) + 90}, ${tx}, ${ty})`);
    t.textContent = displayNumber(num);
    wheel.appendChild(t);
  }
}

function bindBetZones() {
  $$("[data-sl-rkind]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const kind = parseInt(btn.dataset.value, 10);
      let label = btn.textContent.trim();
      if (kind === KINDS.STRAIGHT) {
        const ni = $("[data-sl-rnumber]");
        const raw = ni ? ni.value.trim() : "";
        // Accept "00" as the only string form, else integer 0..36
        const num = raw === "00" ? 37 : parseInt(raw, 10);
        if (isNaN(num) || num < 0 || num > 37) {
          import("../ui.js").then(({ toast }) => toast("Number must be 0–36 or 00", { kind: "warn" }));
          return;
        }
        label = `STRAIGHT ${displayNumber(num)}`;
        addToBasket(kind, num, label);
      } else {
        addToBasket(kind, 0, label);
      }
    });
  });
  $("[data-sl-roulette-clear]")?.addEventListener("click", () => { basket = []; renderBasket(); });
  buildFelt();
}

/// American-style felt: 0 on the LEFT (spans 3 rows), 00 right next to 0
/// (also spans 3 rows), 1..36 in 3 rows × 12 cols, outside bets below.
function buildFelt() {
  const root = $("[data-sl-roulette-felt]");
  if (!root) return;
  const isRed = (n) => REDS.has(n);
  root.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:grid; grid-template-columns: 48px 48px repeat(12, 1fr); gap: 2px; font-family: var(--mono); font-size: 11px;";

  // 0 — spans 3 rows, green
  const zero = document.createElement("button");
  zero.textContent = "0";
  zero.style.cssText = "grid-row: span 3; background: #15803d; color: #fff; border: 1px solid #16a34a; cursor: pointer; font-size: 18px; font-weight: 600;";
  zero.dataset.straight = "0";
  wrap.appendChild(zero);

  // 00 — also spans 3 rows, on the opposite side of the wheel but on the
  // felt it sits right after 0 (standard American felt layout).
  const doubleZero = document.createElement("button");
  doubleZero.textContent = "00";
  doubleZero.style.cssText = "grid-row: span 3; background: #15803d; color: #fff; border: 1px solid #16a34a; cursor: pointer; font-size: 18px; font-weight: 600;";
  doubleZero.dataset.straight = "37";
  wrap.appendChild(doubleZero);

  // 3 rows × 12 cols of numbers 1..36.
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 12; col++) {
      const n = (col * 3) + (3 - row);
      const cell = document.createElement("button");
      cell.textContent = String(n);
      const bg = isRed(n) ? "#7f1d1d" : "#18181b";
      const hover = isRed(n) ? "#991b1b" : "#27272a";
      cell.style.cssText = `background:${bg}; color:#fff; border: 1px solid #27272a; cursor:pointer; padding: 8px 0; font-size: 12px;`;
      cell.dataset.straight = String(n);
      cell.addEventListener("mouseover", () => cell.style.background = hover);
      cell.addEventListener("mouseout",  () => cell.style.background = bg);
      wrap.appendChild(cell);
    }
  }
  wrap.querySelectorAll("button[data-straight]").forEach((b) => {
    b.addEventListener("click", () => {
      const num = parseInt(b.dataset.straight, 10);
      addToBasket(KINDS.STRAIGHT, num, `STRAIGHT ${displayNumber(num)}`);
    });
  });
  root.appendChild(wrap);

  // Dozens band
  const dozens = document.createElement("div");
  dozens.style.cssText = "display:grid; grid-template-columns: 96px repeat(3, 1fr); gap: 2px; margin-top: 2px; font-family: var(--mono);";
  dozens.innerHTML = `<div></div>` +
    `<button data-kind="7" style="padding: 6px 0; background:#1f1f23; color:#fff; border:1px solid var(--line); cursor:pointer;">1st 12</button>` +
    `<button data-kind="8" style="padding: 6px 0; background:#1f1f23; color:#fff; border:1px solid var(--line); cursor:pointer;">2nd 12</button>` +
    `<button data-kind="9" style="padding: 6px 0; background:#1f1f23; color:#fff; border:1px solid var(--line); cursor:pointer;">3rd 12</button>`;
  root.appendChild(dozens);

  const halves = document.createElement("div");
  halves.style.cssText = "display:grid; grid-template-columns: 96px repeat(6, 1fr); gap: 2px; margin-top: 2px; font-family: var(--mono);";
  halves.innerHTML = `<div></div>` +
    `<button data-kind="5" style="padding: 6px 0; background:#1f1f23; color:#fff; border:1px solid var(--line); cursor:pointer;">1-18</button>` +
    `<button data-kind="3" style="padding: 6px 0; background:#1f1f23; color:#fff; border:1px solid var(--line); cursor:pointer;">EVEN</button>` +
    `<button data-kind="1" style="padding: 6px 0; background:#7f1d1d; color:#fff; border:1px solid var(--line); cursor:pointer;">RED</button>` +
    `<button data-kind="2" style="padding: 6px 0; background:#18181b; color:#fff; border:1px solid var(--line); cursor:pointer;">BLACK</button>` +
    `<button data-kind="4" style="padding: 6px 0; background:#1f1f23; color:#fff; border:1px solid var(--line); cursor:pointer;">ODD</button>` +
    `<button data-kind="6" style="padding: 6px 0; background:#1f1f23; color:#fff; border:1px solid var(--line); cursor:pointer;">19-36</button>`;
  root.appendChild(halves);

  root.querySelectorAll("button[data-kind]").forEach((b) => {
    b.addEventListener("click", () => {
      const kind = parseInt(b.dataset.kind, 10);
      addToBasket(kind, 0, b.textContent.trim());
    });
  });
}

function startCountdown(betWindowEnd) {
  if (countdownHandle) clearInterval(countdownHandle);
  const upd = () => {
    const left = betWindowEnd - Math.floor(Date.now() / 1000);
    setText("[data-sl-roulette-countdown]", fmtCountdown(left));
    if (left <= 0) { clearInterval(countdownHandle); countdownHandle = null; }
  };
  upd();
  countdownHandle = setInterval(upd, 250);
}

/// Continuous-rotation spin. We maintain `_wheelTotalDeg` as a strictly
/// increasing rotation counter — every new spin extends the rotation forward
/// (never resets to 0), so the wheel never visibly snaps back between rounds.
/// During the BETTING phase the wheel just sits at the previous result.
let _wheelTotalDeg = 0;
function spinWheel(result, roundId) {
  if (animatedRounds.has(roundId)) return;
  animatedRounds.add(roundId);
  const wheel = document.querySelector("svg.roulette-wheel, .roulette-big svg");
  if (!wheel) return;

  const segIdx = AMERICAN_ORDER.indexOf(result);
  if (segIdx < 0) return;                                  // unknown result
  const segAngle = 360 / N_SEGMENTS;

  // Current rotation modulo 360 — figure out the delta needed to bring segIdx
  // under the top pointer. Pointer is at the wheel's 12 o'clock (the rendered
  // SVG's local "up", i.e. transform: rotate(0) origin). Segment segIdx sits
  // at angular position (segIdx * segAngle) clockwise from the top. Rotating
  // the wheel CW by Δ moves segment segIdx to position (segIdx*segAngle + Δ).
  // For segIdx to be at the top (position ≡ 0 mod 360) we need
  // Δ ≡ -(segIdx * segAngle) (mod 360).
  const wantOffsetMod = ((360 - (segIdx * segAngle)) % 360 + 360) % 360;
  const curMod = ((_wheelTotalDeg % 360) + 360) % 360;
  // Always rotate FORWARD (clockwise). Add ≥ 6 full extra revolutions for a
  // satisfying long spin. The base delta is the smallest positive value that
  // takes us from curMod to wantOffsetMod.
  const baseDelta = ((wantOffsetMod - curMod) % 360 + 360) % 360;
  const extraSpins = 6 + Math.floor(Math.random() * 2); // 6 or 7 full revolutions
  const delta = baseDelta + extraSpins * 360;
  _wheelTotalDeg += delta;

  // 8 seconds total — long enough that the user can watch the deceleration.
  // Symmetric ease-in-out so it starts gently, peaks mid-spin, eases to a stop.
  requestAnimationFrame(() => {
    wheel.style.transition = "transform 8s cubic-bezier(0.22, 0.04, 0.18, 1)";
    wheel.style.transform = `rotate(${_wheelTotalDeg}deg)`;
  });

  // Result banner after the animation finishes.
  setTimeout(() => {
    setResultBanner({
      won: false,
      txt: `<b>RESULT</b> · <span style="color:${pocketFill(result) === "#dc2626" ? "#fca5a5" : (pocketFill(result) === "#15803d" ? "#86efac" : "#fff")}; font-size: 18px;">${displayNumber(result)}</span>`,
      accent: pocketFill(result),
    });
  }, 8100);
}

async function loadActiveRound() {
  try {
    const c = casino();
    const total = Number(await c.totalRouletteRounds());
    if (total === 0) { setText("[data-sl-roulette-countdown]", "waiting for first round…"); return; }
    const id = Number(await c.currentRouletteRoundId());
    const r = await c.getRouletteRound(id);
    activeRound = {
      id,
      betWindowEnd: Number(r[1]),
      commitBlock: Number(r[2]),
      settled: r[4],
      resultNumber: Number(r[5]),
    };
    const now = Math.floor(Date.now() / 1000);
    const phaseKey = id * 10 + (r[4] ? 2 : (now < activeRound.betWindowEnd ? 0 : 1));
    if (lastRenderedRoundId !== phaseKey) {
      lastRenderedRoundId = phaseKey;
      setText("[data-sl-round-info]", `round #${id}`);
      const pill = $("[data-sl-stage-pill]");
      if (pill) {
        pill.classList.remove("ready","live","won","lost");
        if (!r[4] && now < activeRound.betWindowEnd) {
          pill.classList.add("live"); pill.innerHTML = `<span class="dot"></span> BETTING OPEN`;
          startCountdown(activeRound.betWindowEnd);
        } else if (!r[4]) {
          pill.classList.add("live"); pill.innerHTML = `<span class="dot"></span> SPINNING`;
          setText("[data-sl-roulette-countdown]", "settling…");
        } else {
          pill.classList.add("won"); pill.innerHTML = `<span class="dot"></span> RESULT · ${displayNumber(activeRound.resultNumber)}`;
          setText("[data-sl-roulette-countdown]", "round closed");
        }
      }
    }
    if (r[4]) spinWheel(activeRound.resultNumber, id);
  } catch (e) { console.warn("[roulette] loadActiveRound:", e.message); }
}

async function onPlaceBet() {
  if (basket.length === 0) return;
  const placeBtn = $("[data-sl-place]");
  if (placeBtn.dataset.locked === "1") return;
  placeBtn.dataset.locked = "1";

  if (!activeRound || activeRound.settled) {
    const { toast } = await import("../ui.js"); toast("Waiting for the next round to open…", { kind: "warn" });
    delete placeBtn.dataset.locked; return;
  }
  if (Math.floor(Date.now() / 1000) >= activeRound.betWindowEnd) {
    const { toast } = await import("../ui.js"); toast("Betting window closed for this round", { kind: "warn" });
    delete placeBtn.dataset.locked; return;
  }

  // INSTANT UX: the basket items get whisked away while the chain tx fires.
  // No "Connecting" / "Placing bets…" spam — just a quiet "On the table"
  // state until the round settles and the wheel spin starts.
  clearResultBanner(); clearFairServer();
  placeBtn.textContent = "Sliding chips onto table…";
  placeBtn.disabled = true;

  try {
    await connect();
    // Defense in depth: read live maxBet and refuse if total exceeds it.
    // (Roulette has multi-bet semantics — instead of auto-scaling each chip
    // we tell the user to remove some — that's more honest.)
    const totalWei = basket.reduce((acc, b) => acc + ethers.parseEther(String(b.amountSTT)), 0n);
    const maxBet = await readMaxBet("roulette");
    const cap = (maxBet * 95n) / 100n;
    if (totalWei > cap) {
      const { toast } = await import("../ui.js");
      const human = (Number(cap) / 1e18).toFixed(4);
      toast(`Total ${(Number(totalWei) / 1e18).toFixed(4)} STT exceeds casino max ${human} STT — remove some bets.`, { kind: "warn", ttl: 5000 });
      setStagePill("ready", "READY");
      placeBtn.textContent = "Place bets";
      placeBtn.disabled = false;
      delete placeBtn.dataset.locked;
      return;
    }
    const { txHash } = await SL.placeRoulette(basket);
    populateFairPanel({ clientSeed: ethers.ZeroHash, betId: activeRound.id, nonce: activeRound.id, serverSeed: ethers.ZeroHash, txHash });
    basket = [];
    renderBasket();
    await loadActiveRound();
    placeBtn.textContent = "Chips on the table · waiting for spin";
  } catch (e) {
    const msg = friendlyError(e);
    if (/rejected|user cancelled/i.test(msg)) {
      setStagePill("ready", "READY");
      placeBtn.textContent = "Add chips to basket";
    } else {
      setStagePill(null, "ERROR");
      setResultBanner({ won: false, txt: `<b>FAILED</b> · ${msg}`, accent: "#facc15" });
    }
  } finally {
    setTimeout(() => { delete placeBtn.dataset.locked; placeBtn.disabled = false; renderBasket(); }, 800);
  }
}

async function refreshHistory() {
  const root = $("[data-sl-roulette-recent]");
  if (!root) return;
  try {
    const c = casino();
    const events = await fetchRecentLogs(c, "RouletteRoundSettled", { minCount: 30, maxLookback: 20_000 });
    root.innerHTML = "";
    if (events.length === 0) { root.innerHTML = `<span class="m" style="opacity:.4;">no recent</span>`; return; }
    for (const ev of events.slice(0, 30)) {
      const n = Number(ev.args.resultNumber);
      const m = document.createElement("span");
      m.className = "m";
      m.style.background = pocketFill(n);
      m.style.color = "#fff";
      m.style.padding = "4px 8px";
      m.style.minWidth = "26px";
      m.style.textAlign = "center";
      m.textContent = displayNumber(n);
      root.appendChild(m);
    }
  } catch (e) { console.warn("[roulette] history:", e.message); }
}

document.addEventListener("DOMContentLoaded", () => {
  injectKeyframes();
  // The HTML's inline <script> built the European wheel — rebuild as American
  // (38 segments incl. 00) on top of it. Safe to do at DOMContentLoaded since
  // the inline script also runs before this module's handler.
  buildWheel();
  bindBetZones();
  const straightRow = document.querySelector("#straight-row");
  if (straightRow) straightRow.style.display = "block";
  $("[data-sl-place]")?.addEventListener("click", onPlaceBet);
  renderBasket();
  setStagePill("ready", "READY");
  loadActiveRound().catch(() => {});
  refreshHistory().catch(() => {});
  try {
    const c = casino();
    c.on("RouletteRoundSettled", () => { loadActiveRound().catch(() => {}); refreshHistory().catch(() => {}); });
    c.on("RouletteRoundStarted", () => loadActiveRound().catch(() => {}));
    c.on("RouletteBetPlaced",    () => loadActiveRound().catch(() => {}));
  } catch (_) {}
  setInterval(() => loadActiveRound().catch(() => {}), POLL_MS);
  setInterval(() => refreshHistory().catch(() => {}), 12_000);
});
