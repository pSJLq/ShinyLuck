// Roulette — round-based + multi-bet (up to 5 bets per player per round).
//
// Workflow:
//   1. Player clicks bet zones on the felt to build a basket (right panel).
//   2. Click "Place bets" → SL.placeRoulette([{kind, number, amountSTT}, …])
//      pushes the basket on-chain (one tx).
//   3. After r.betWindowEnd + 4 blocks, reveal-bot calls settleRouletteRound.
//      The wheel animation lands on the result number; winners get a banner.

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

const ROULETTE = 5;
const POLL_MS = 1000;

const KINDS = {
  STRAIGHT: 0, RED: 1, BLACK: 2, EVEN: 3, ODD: 4,
  LOW: 5, HIGH: 6, DOZEN_1: 7, DOZEN_2: 8, DOZEN_3: 9,
};

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
let basket = [];     // [{ kind, number, amountSTT, label }]
let countdownHandle = null;
const animatedRounds = new Set();  // roundIds we've already animated, so the
                                   // 1-second poll doesn't restart the spin
let lastRenderedRoundId = -1;       // change-detection so we don't repaint the
                                    // pill / countdown on every tick

function fmtCountdown(s) {
  if (s < 0) s = 0;
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

function bindBetZones() {
  $$("[data-sl-rkind]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const kind = parseInt(btn.dataset.value, 10);
      let label = btn.textContent.trim();
      if (kind === KINDS.STRAIGHT) {
        const ni = $("[data-sl-rnumber]");
        const num = ni ? parseInt(ni.value, 10) || 0 : 0;
        if (num < 0 || num > 36) { import("../ui.js").then(({ toast }) => toast("Number must be 0–36", { kind: "warn" })); return; }
        label = `STRAIGHT ${num}`;
        addToBasket(kind, num, label);
      } else {
        addToBasket(kind, 0, label);
      }
    });
  });
  $("[data-sl-roulette-clear]")?.addEventListener("click", () => { basket = []; renderBasket(); });
  buildFelt();
}

/// GTA-style visual betting felt — 0 spans the left, 1..36 in 3 rows × 12 cols,
/// dozens band on top, halves / red-black / even-odd band below. Clicking any
/// number adds a straight bet for that number; outside bets share their kind.
function buildFelt() {
  const root = $("[data-sl-roulette-felt]");
  if (!root) return;
  const REDS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
  const isRed = (n) => REDS.has(n);
  root.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:grid; grid-template-columns: 60px repeat(12, 1fr); gap: 2px; font-family: var(--mono); font-size: 11px;";
  // Zero — spans 3 rows on the left
  const zero = document.createElement("button");
  zero.textContent = "0";
  zero.style.cssText = "grid-row: span 3; background: #15803d; color: #fff; border: 1px solid #16a34a; cursor: pointer; font-size: 18px; font-weight: 600;";
  zero.dataset.straight = "0";
  wrap.appendChild(zero);
  // 3 rows of numbers in column-major fashion (top row = highest of each column).
  // Order matches a standard roulette felt: row0 = 3,6,…,36; row1 = 2,5,…,35; row2 = 1,4,…,34.
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
      addToBasket(KINDS.STRAIGHT, num, `STRAIGHT ${num}`);
    });
  });
  root.appendChild(wrap);
  // Outside bets band — dozens
  const dozens = document.createElement("div");
  dozens.style.cssText = "display:grid; grid-template-columns: 60px repeat(3, 1fr); gap: 2px; margin-top: 2px; font-family: var(--mono);";
  dozens.innerHTML = `<div></div>` +
    `<button data-kind="7" style="padding: 6px 0; background:#1f1f23; color:#fff; border:1px solid var(--line); cursor:pointer;">1st 12</button>` +
    `<button data-kind="8" style="padding: 6px 0; background:#1f1f23; color:#fff; border:1px solid var(--line); cursor:pointer;">2nd 12</button>` +
    `<button data-kind="9" style="padding: 6px 0; background:#1f1f23; color:#fff; border:1px solid var(--line); cursor:pointer;">3rd 12</button>`;
  root.appendChild(dozens);
  const halves = document.createElement("div");
  halves.style.cssText = "display:grid; grid-template-columns: 60px repeat(6, 1fr); gap: 2px; margin-top: 2px; font-family: var(--mono);";
  halves.innerHTML = `<div></div>` +
    `<button data-kind="5" style="padding: 6px 0; background:#1f1f23; color:#fff; border:1px solid var(--line); cursor:pointer;">1-18</button>` +
    `<button data-kind="3" style="padding: 6px 0; background:#1f1f23; color:#fff; border:1px solid var(--line); cursor:pointer;">EVEN</button>` +
    `<button data-kind="1" style="padding: 6px 0; background:#7f1d1d; color:#fff; border:1px solid var(--line); cursor:pointer;">RED</button>` +
    `<button data-kind="2" style="padding: 6px 0; background:#18181b; color:#fff; border:1px solid var(--line); cursor:pointer;">BLACK</button>` +
    `<button data-kind="4" style="padding: 6px 0; background:#1f1f23; color:#fff; border:1px solid var(--line); cursor:pointer;">ODD</button>` +
    `<button data-kind="6" style="padding: 6px 0; background:#1f1f23; color:#fff; border:1px solid var(--line); cursor:pointer;">19-36</button>`;
  root.appendChild(halves);
  // Wire outside-bet clicks.
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

function spinWheel(result, roundId) {
  if (animatedRounds.has(roundId)) return;       // already played this spin
  animatedRounds.add(roundId);
  const wheel = document.querySelector("svg.roulette-wheel, .roulette-big svg");
  if (!wheel) return;
  // Reset transform first (without transition) so animations from previous
  // rounds don't compound — otherwise the wheel "dances" every tick.
  wheel.style.transition = "none";
  wheel.style.transform = "rotate(0deg)";
  // Force browser to flush the reset before the new spin animation.
  // (Reading offsetHeight is the standard reflow trick.)
  void wheel.offsetHeight;
  const order = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
  const segIdx = order.indexOf(result);
  const N = order.length;
  const segAngle = 360 / N;
  const target = -(segIdx * segAngle) + 270;
  const finalDeg = 360 * 5 + target;
  // Apply animation on the next frame to ensure the reset took effect.
  requestAnimationFrame(() => {
    wheel.style.transition = "transform 3.2s cubic-bezier(0.16, 0.84, 0.44, 1)";
    wheel.style.transform = `rotate(${finalDeg}deg)`;
  });
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
    // Only repaint static bits (round id, pill, countdown re-arm) when the
    // *phase* changes — otherwise every 1-second poll triggers a flicker.
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
          pill.classList.add("won"); pill.innerHTML = `<span class="dot"></span> RESULT · ${activeRound.resultNumber}`;
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
  placeBtn.dataset.locked = "1";
  try {
    setStagePill("live", "CONNECTING");
    placeBtn.textContent = "Connecting…"; placeBtn.disabled = true;
    await connect();
    if (!activeRound || activeRound.settled) throw new Error("no open round");
    if (Math.floor(Date.now() / 1000) >= activeRound.betWindowEnd) throw new Error("betting window closed");

    clearResultBanner(); clearFairServer();
    placeBtn.textContent = "Placing bets…";
    const { txHash } = await SL.placeRoulette(basket);
    populateFairPanel({ clientSeed: ethers.ZeroHash, betId: activeRound.id, nonce: activeRound.id, serverSeed: ethers.ZeroHash, txHash });
    basket = [];
    renderBasket();
    await loadActiveRound();
  } catch (e) {
    setStagePill(null, "ERROR");
    const msg = friendlyError(e);
    placeBtn.textContent = "Error: " + msg;
    setResultBanner({ won: false, txt: `<b>FAILED</b> · ${msg}`, accent: "#facc15" });
  } finally {
    setTimeout(() => { delete placeBtn.dataset.locked; placeBtn.disabled = false; renderBasket(); }, 1500);
  }
}

async function refreshHistory() {
  const root = $("[data-sl-roulette-recent]");
  if (!root) return;
  try {
    const c = casino();
    const events = await fetchRecentLogs(c, "RouletteRoundSettled", { minCount: 30, maxLookback: 100_000 });
    root.innerHTML = "";
    if (events.length === 0) { root.innerHTML = `<span class="m" style="opacity:.4;">no recent</span>`; return; }
    const reds = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
    for (const ev of events.slice(0, 30)) {
      const n = Number(ev.args.resultNumber);
      const m = document.createElement("span");
      m.className = "m";
      m.style.background = n === 0 ? "#16a34a" : (reds.has(n) ? "#dc2626" : "#27272a");
      m.style.color = "#fff";
      m.style.padding = "4px 8px";
      m.style.minWidth = "26px";
      m.style.textAlign = "center";
      m.textContent = String(n);
      root.appendChild(m);
    }
  } catch (e) { console.warn("[roulette] history:", e.message); }
}

document.addEventListener("DOMContentLoaded", () => {
  injectKeyframes();
  bindBetZones();
  // Ensure the straight number input is always visible (we always allow STRAIGHT).
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
