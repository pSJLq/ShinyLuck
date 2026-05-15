// Crash — round-based integration.
//
// Round phases:
//   PHASE 1 (BETTING)   block.timestamp < r.betWindowEnd
//                       → players may placeCrashBet(autoCashout, msg.value)
//   PHASE 2 (RUNNING)   betWindowEnd ≤ now < settle
//                       → kurve climbs visually; players may requestCashout
//   PHASE 3 (SETTLED)   reveal-bot called settleCrashRound
//                       → crashPoint revealed, payouts credited
//
// All round state lives on-chain; this file just polls/subscribes.

import { ethers } from "https://esm.sh/ethers@6.13.2";
import { SL, connect } from "../wallet.js";
import { CONFIG } from "../config.js";
import { provider, fetchRecentLogs } from "../rpc.js";
import {
  $, $$, setText, fmtSTTfromString, readStakeStr, injectKeyframes,
  setStagePill, setResultBanner, clearResultBanner, clearFairServer,
  populateFairPanel, friendlyError, fmtSTT, refreshEV,
} from "./_base.js";
import { validateStake, validateAutoCashout } from "../errors.js";

const CRASH = 1;
const POLL_MS = 1000;

let casinoRO = null;
function casino() {
  if (!casinoRO) {
    const abi = [
      "function currentCrashRoundId() view returns (uint256)",
      "function totalCrashRounds() view returns (uint256)",
      "function getCrashRound(uint256) view returns (uint64 id,uint64 betWindowEnd,uint64 commitBlock,uint32 seedIdx,bool settled,uint16 crashPointX100,bytes32 serverSeed,uint256 bettorCount)",
      "function getCrashBettors(uint256) view returns (address[])",
      "function getCrashBet(uint256,address) view returns (tuple(uint96 amount,uint16 autoCashoutX100,uint16 cashoutMultX100,bool resolved))",
      "event CrashRoundStarted(uint256 indexed roundId,uint256 betWindowEnd,uint256 commitBlock,uint256 seedIdx)",
      "event CrashRoundSettled(uint256 indexed roundId,uint256 crashPointX100,bytes32 serverSeed,bytes32 randomness,bytes32 blockHash)",
      "event CrashRoundRefunded(uint256 indexed roundId,string reason)",
      "event CrashBetPlaced(uint256 indexed roundId,address indexed player,uint256 amount,uint256 autoCashoutX100)",
      "event CrashCashoutRequested(uint256 indexed roundId,address indexed player,uint256 multX100)",
    ];
    casinoRO = new ethers.Contract(CONFIG.casino, abi, provider());
  }
  return casinoRO;
}

let activeRound = null;     // { id, betWindowEnd, commitBlock, settled, crashPointX100 }
let myBet = null;           // { roundId, amount, autoCashoutX100, cashoutMultX100, resolved }
let multTickerHandle = null;
let countdownHandle = null;

function autoCashoutX() {
  const el = $("[data-sl-autocashout]");
  return el ? parseFloat(el.value) || 2 : 2;
}

function recalcSummary() {
  const ac = autoCashoutX();
  const stake = readStakeStr();
  const stakeNum = parseFloat(stake) || 0;
  const profit = stakeNum > 0 && ac > 1 ? stakeNum * (ac - 1) : 0;
  const winProbPct = ac >= 1.01 ? Math.min(99, (97 / ac) * (32 / 33) * 100) : 0;
  $$("[data-sl-profit]").forEach((el) => {
    el.textContent = (profit >= 0 ? "+ " : "− ") + fmtSTTfromString(String(Math.abs(profit))) + " STT";
  });
  setText("[data-sl-autocashout-display]", ac.toFixed(2) + "×");
  setText("[data-sl-winchance]", winProbPct.toFixed(2) + "%");
  refreshEV(CRASH).catch(() => {});
}

function fmtCountdown(s) {
  if (s < 0) s = 0;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

function renderPhasePill(phase) {
  const pill = $("[data-sl-stage-pill]");
  if (!pill) return;
  pill.classList.remove("ready", "live", "won", "lost");
  if (phase === "BETTING")  { pill.classList.add("live"); pill.innerHTML = `<span class="dot"></span> BETTING OPEN`; }
  else if (phase === "RUNNING") { pill.classList.add("live"); pill.innerHTML = `<span class="dot"></span> ROUND RUNNING`; }
  else if (phase === "SETTLED") { pill.classList.add("won");  pill.innerHTML = `<span class="dot"></span> SETTLED`; }
  else if (phase === "REFUNDED"){ pill.classList.add("lost"); pill.innerHTML = `<span class="dot"></span> REFUNDED`; }
}

function predictedMultiplier(roundStartSec, nowSec) {
  // multiplier(t) = exp(0.06 * t) (clamped at 100×); matches the visual model.
  const t = Math.max(0, nowSec - roundStartSec);
  const m = Math.exp(0.06 * t);
  return Math.min(100, m);
}

function startTicker(roundStartSec) {
  stopTicker();
  multTickerHandle = setInterval(() => {
    const now = Date.now() / 1000;
    const m = predictedMultiplier(roundStartSec, now);
    const el = $("[data-sl-crash-mult]");
    if (el) {
      el.textContent = m.toFixed(2);
      el.style.color = "var(--cyan)";
    }
  }, 60);
}
function stopTicker() {
  if (multTickerHandle) { clearInterval(multTickerHandle); multTickerHandle = null; }
}
function paintMultiplierFinal(cpX, won) {
  const el = $("[data-sl-crash-mult]");
  if (!el) return;
  el.textContent = cpX.toFixed(2);
  el.style.color = won ? "var(--green)" : "var(--red)";
}

function startCountdown(betWindowEnd) {
  if (countdownHandle) clearInterval(countdownHandle);
  const update = () => {
    const left = betWindowEnd - Math.floor(Date.now() / 1000);
    setText("[data-sl-crash-countdown]", fmtCountdown(left));
    if (left <= 0) { clearInterval(countdownHandle); countdownHandle = null; }
  };
  update();
  countdownHandle = setInterval(update, 250);
}

async function loadActiveRound() {
  try {
    const c = casino();
    const total = Number(await c.totalCrashRounds());
    if (total === 0) {
      renderPhasePill("BETTING");
      setText("[data-sl-crash-countdown]", "waiting for first round…");
      return;
    }
    const id = Number(await c.currentCrashRoundId());
    const r = await c.getCrashRound(id);
    activeRound = {
      id,
      betWindowEnd: Number(r.betWindowEnd),
      commitBlock: Number(r.commitBlock),
      settled: r.settled,
      crashPointX100: Number(r.crashPointX100),
    };
    setText("[data-sl-round-info]", `round #${id}`);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!r.settled && nowSec < activeRound.betWindowEnd) {
      renderPhasePill("BETTING");
      startCountdown(activeRound.betWindowEnd);
      stopTicker();
      setText("[data-sl-crash-mult]", "1.00");
    } else if (!r.settled) {
      renderPhasePill("RUNNING");
      startTicker(activeRound.betWindowEnd);
      setText("[data-sl-crash-countdown]", "settling…");
    } else {
      renderPhasePill("SETTLED");
      stopTicker();
      paintMultiplierFinal(activeRound.crashPointX100 / 100, false);
      setText("[data-sl-crash-countdown]", "round closed");
    }
    if (SL.address) {
      const b = await c.getCrashBet(id, SL.address);
      myBet = {
        roundId: id,
        amount: BigInt(b.amount),
        autoCashoutX100: Number(b.autoCashoutX100),
        cashoutMultX100: Number(b.cashoutMultX100),
        resolved: b.resolved,
      };
      renderMyBet();
    }
    renderBettors(id).catch(() => {});
  } catch (e) {
    console.warn("[crash] loadActiveRound:", e.message);
  }
}

async function renderBettors(roundId) {
  const c = casino();
  const list = $("[data-sl-crash-bettors]");
  if (!list) return;
  try {
    const addrs = await c.getCrashBettors(roundId);
    if (addrs.length === 0) {
      list.innerHTML = `<div class="m" style="opacity:.4;">no players yet</div>`;
      return;
    }
    list.innerHTML = "";
    for (const a of addrs.slice(0, 30)) {
      const b = await c.getCrashBet(roundId, a);
      const status = b.resolved
        ? (b.cashoutMultX100 > 0 ? `cashed @ ${(Number(b.cashoutMultX100)/100).toFixed(2)}×`
                                 : (b.autoCashoutX100 > 0 ? `auto @ ${(Number(b.autoCashoutX100)/100).toFixed(2)}×` : "busted"))
        : "active";
      const row = document.createElement("div");
      row.className = "m";
      row.style.cssText = "display:flex; justify-content:space-between; gap:8px; font-size:11px;";
      row.innerHTML = `<span>${a.slice(0,6)}…${a.slice(-4)}</span><span>${ethers.formatEther(b.amount)} STT</span><span style="color:var(--cyan);">${status}</span>`;
      list.appendChild(row);
    }
  } catch (e) { console.warn("[crash] bettors:", e.message); }
}

function renderMyBet() {
  if (!myBet || myBet.amount === 0n) {
    setText("[data-sl-crash-mybet]", "—");
    const co = $("[data-sl-cashout]");
    if (co) co.style.display = "none";
    return;
  }
  const ac = myBet.autoCashoutX100 > 0 ? `auto @ ${(myBet.autoCashoutX100/100).toFixed(2)}×` : "manual";
  setText("[data-sl-crash-mybet]", `${ethers.formatEther(myBet.amount)} STT · ${ac}`);
  const co = $("[data-sl-cashout]");
  if (co) {
    const showCO = !myBet.resolved && myBet.cashoutMultX100 === 0 && activeRound && !activeRound.settled
                   && Math.floor(Date.now() / 1000) >= activeRound.betWindowEnd;
    co.style.display = showCO ? "block" : "none";
  }
}

async function onPlaceBet() {
  const placeBtn = $("[data-sl-place]");
  if (!placeBtn) return;
  placeBtn.dataset.locked = "1";
  try {
    setStagePill("live", "CONNECTING");
    placeBtn.textContent = "Connecting…"; placeBtn.disabled = true;
    await connect();
    if (!activeRound || activeRound.settled) {
      throw new Error("no open round — wait for the next one");
    }
    if (Math.floor(Date.now() / 1000) >= activeRound.betWindowEnd) {
      throw new Error("betting window closed");
    }
    const stake = readStakeStr() || "0.1";
    const stakeErr = validateStake(stake); if (stakeErr) throw new Error(stakeErr);
    const ac = autoCashoutX();
    const acErr = validateAutoCashout(ac); if (acErr) throw new Error(acErr);

    clearResultBanner(); clearFairServer();
    placeBtn.textContent = "Placing bet…";
    const result = await SL.placeCrash(ac, stake);
    populateFairPanel({ clientSeed: ethers.ZeroHash, betId: activeRound.id, nonce: activeRound.id, serverSeed: ethers.ZeroHash, txHash: result.txHash });
    placeBtn.textContent = `Bet in round #${activeRound.id}`;
    await loadActiveRound();
  } catch (e) {
    setStagePill(null, "ERROR");
    const msg = friendlyError(e);
    placeBtn.textContent = "Error: " + msg;
    setResultBanner({ won: false, txt: `<b>FAILED</b> · ${msg}`, accent: "#facc15" });
  } finally {
    setTimeout(() => { delete placeBtn.dataset.locked; placeBtn.disabled = false; recalcSummary(); }, 1500);
  }
}

async function onManualCashout() {
  if (!activeRound || activeRound.settled) return;
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec < activeRound.betWindowEnd) return;
  const m = predictedMultiplier(activeRound.betWindowEnd, nowSec);
  try {
    await connect();
    await SL.requestCrashCashout(m);
    setStagePill("live", `CASHED @ ${m.toFixed(2)}×`);
    await loadActiveRound();
  } catch (e) {
    import("../ui.js").then(({ toast }) => toast(friendlyError(e), { kind: "error", ttl: 6000 }));
  }
}

async function refreshHistory() {
  const list = $("[data-sl-crash-recent]");
  if (!list) return;
  try {
    const c = casino();
    const events = await fetchRecentLogs(c, "CrashRoundSettled", { minCount: 20, maxLookback: 100_000 });
    list.innerHTML = "";
    if (events.length === 0) {
      list.innerHTML = `<span class="m" style="opacity:.4;">no recent rounds</span>`;
      return;
    }
    for (const ev of events.slice(0, 20)) {
      const cp = Number(ev.args.crashPointX100) / 100;
      const m = document.createElement("span");
      m.className = "m " + (cp >= 2 ? "win" : (cp < 1.5 ? "bust" : ""));
      m.textContent = cp.toFixed(2) + "×";
      list.appendChild(m);
    }
  } catch (e) { console.warn("[crash] history:", e.message); }
}

function bindWS() {
  // Subscribe to CrashRoundStarted/Settled so the UI flips instantly.
  const c = casino();
  c.on("CrashRoundStarted", () => loadActiveRound().catch(() => {}));
  c.on("CrashRoundSettled", () => { loadActiveRound().catch(() => {}); refreshHistory().catch(() => {}); });
  c.on("CrashBetPlaced",    () => loadActiveRound().catch(() => {}));
  c.on("CrashCashoutRequested", () => loadActiveRound().catch(() => {}));
}

document.addEventListener("DOMContentLoaded", () => {
  injectKeyframes();
  const ac = $("[data-sl-autocashout]");
  if (ac) ac.addEventListener("input", recalcSummary);
  const stakeEl = $("[data-sl-stake]");
  if (stakeEl) {
    stakeEl.addEventListener("input", recalcSummary);
    stakeEl.addEventListener("change", recalcSummary);
  }
  $$(".preset[onclick]").forEach((btn) => {
    const oldHandler = btn.onclick;
    btn.onclick = function (...args) { if (oldHandler) oldHandler.apply(this, args); recalcSummary(); };
  });
  $("[data-sl-place]")?.addEventListener("click", onPlaceBet);
  $("[data-sl-cashout]")?.addEventListener("click", onManualCashout);

  recalcSummary();
  setStagePill("ready", "READY");
  loadActiveRound().catch(() => {});
  refreshHistory().catch(() => {});
  try { bindWS(); } catch (_) {}
  setInterval(() => loadActiveRound().catch(() => {}), POLL_MS);
  setInterval(() => refreshHistory().catch(() => {}), 12_000);
});
