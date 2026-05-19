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
import { clampStakeStr, applyMaxToInput } from "../casino-limits.js";

const CRASH = 1;
// Was 1000ms — caused 1 RPC/s contract reads even when the round hadn't
// changed. WS subscriptions below catch real state changes instantly; this
// poll is just a fallback for missed events. 3s gives smooth UX without
// hammering RPC + freeing the main thread for cursor / animations.
const POLL_MS = 3000;

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
  // NaN-safe: round-clock used to render "NaN:NaN" while metadata loaded.
  if (!Number.isFinite(s) || s < 0) s = 0;
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
  // Defensive: a missing roundStartSec (e.g. round between phases on cold
  // load) used to yield NaN downstream and pollute the SVG with "NaN"
  // attribute values. Caller now also guards, but keep this honest at the
  // source: never return non-finite or ≤0.
  if (!Number.isFinite(roundStartSec) || !Number.isFinite(nowSec)) return 1;
  const t = Math.max(0, nowSec - roundStartSec);
  const m = Math.exp(0.06 * t);
  if (!Number.isFinite(m) || m < 1) return 1;
  return Math.min(100, m);
}

/// Convert the cashout multiplier (≥ 1.00) into the visual "growth" multiplier
/// that starts at 0.00× at round start and climbs as the curve rises. Display
/// semantics: "1.50×" on screen ≡ 2.50× actual cashout payout (the bet returns
/// stake + 1.50× stake). Auto-cashout input is still entered as the actual
/// cashout multiplier — the slider label conversion happens at render time.
function toDisplayMult(actualMult) {
  return Math.max(0, actualMult - 1);
}

/// Update the SVG curve + glowing dot to reflect the live multiplier.
/// The viewBox is 800×420 with the round x-axis spanning 0..760 (we reserve
/// the right strip for the multiplier label). y=400 is the 0× floor and the
/// curve climbs logarithmically toward y=20 (the 50× ceiling).
function _updateCrashSvg(elapsedSec, actualMult) {
  // Guard against NaN / negative / zero inputs. predictedMultiplier can yield
  // 0 or NaN if a round is between phases or roundStartSec is bogus — without
  // this guard, Math.log(0)=-Infinity → y=NaN → SVG d-string contains "NaN"
  // and the browser logs an attribute-parse warning every animation frame.
  if (!Number.isFinite(elapsedSec) || elapsedSec < 0) return;
  if (!Number.isFinite(actualMult) || actualMult <= 0) return;
  const svg = document.querySelector(".crash-stage svg");
  if (!svg) return;
  const linePath = svg.querySelector("path[stroke^='url']");
  const areaPath = svg.querySelector("path[fill^='url']");
  const dot      = svg.querySelector("circle");
  if (!linePath || !areaPath || !dot) return;

  // The initial CSS animation set stroke-dasharray=1200/dashoffset=1200, which
  // leaves the line invisible after the first round if we never reset. Clear
  // both so updateSvg's `setAttribute('d', …)` actually paints.
  if (linePath.hasAttribute("stroke-dasharray")) {
    linePath.removeAttribute("stroke-dasharray");
    linePath.removeAttribute("stroke-dashoffset");
    linePath.style.strokeDasharray = "none";
    linePath.style.strokeDashoffset = "0";
    linePath.style.animation = "none";
    areaPath.style.animation = "none";
  }

  // x: linear growth from 0 to 760 over the round window (≈30s typical).
  const xCap = 760, yTop = 20, yBot = 400;
  const x = Math.min(xCap, (elapsedSec / 30) * xCap);
  // y: log-scaled climb from the bottom toward the top.
  // log(actualMult) / log(50) maps actualMult=1 → 0 (bottom), actualMult=50 → 1 (top).
  const logProg = Math.log(actualMult) / Math.log(50);
  const y = Math.max(yTop, yBot - logProg * (yBot - yTop));
  // Smooth cubic bezier curve from (0, yBot) to (x, y).
  const cx1 = x * 0.4, cy1 = yBot;
  const cx2 = x * 0.75, cy2 = yBot - (yBot - y) * 0.55;
  const d = `M0,${yBot} C${cx1},${cy1} ${cx2},${cy2} ${x},${y}`;
  linePath.setAttribute("d", d);
  areaPath.setAttribute("d", d + ` L${x},${yBot} Z`);
  dot.setAttribute("cx", x);
  dot.setAttribute("cy", y);
}

function startTicker(roundStartSec) {
  stopTicker();
  // First-frame update so the curve resets to (0, bottom) and the number to
  // 0.00× the moment the round goes live (vs lingering on the previous
  // round's crash point).
  _updateCrashSvg(0, 1);
  const el = $("[data-sl-crash-mult]");
  if (el) {
    el.textContent = "0.00";
    el.style.color = "var(--cyan)";
  }
  multTickerHandle = setInterval(() => {
    const now = Date.now() / 1000;
    const elapsed = Math.max(0, now - roundStartSec);
    const actual = predictedMultiplier(roundStartSec, now);
    // Belt+suspenders: predictedMultiplier may produce NaN if roundStartSec is
    // bogus (round between phases). Don't paint "NaN×" or feed NaN into SVG.
    if (!Number.isFinite(actual) || actual <= 0) return;
    const display = toDisplayMult(actual);
    if (el && Number.isFinite(display)) el.textContent = display.toFixed(2);
    _updateCrashSvg(elapsed, actual);
  }, 60);
}
function stopTicker() {
  if (multTickerHandle) { clearInterval(multTickerHandle); multTickerHandle = null; }
}
function paintMultiplierFinal(cpX, won) {
  const el = $("[data-sl-crash-mult]");
  if (!el) return;
  // Display the growth multiplier (cashpoint − 1) consistent with the live
  // ticker. cpX is the actual cashout floor (e.g. 1.34); we show 0.34.
  const v = toDisplayMult(Number(cpX));
  el.textContent = Number.isFinite(v) ? v.toFixed(2) : "0.00";
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
      setText("[data-sl-crash-mult]", "0.00");
      // also reset the SVG curve to the bottom-left during BETTING phase so
      // the previous round's crash point isn't lingering.
      _updateCrashSvg(0, 1);
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
  if (placeBtn.dataset.locked === "1") return;
  placeBtn.dataset.locked = "1";

  const stake = readStakeStr() || "0.1";
  const stakeErr = validateStake(stake);
  if (stakeErr) {
    const { toast } = await import("../ui.js"); toast(stakeErr, { kind: "warn" });
    delete placeBtn.dataset.locked; return;
  }
  const ac = autoCashoutX();
  const acErr = validateAutoCashout(ac);
  if (acErr) {
    const { toast } = await import("../ui.js"); toast(acErr, { kind: "warn" });
    delete placeBtn.dataset.locked; return;
  }
  if (!activeRound || activeRound.settled) {
    const { toast } = await import("../ui.js"); toast("Waiting for the next round to open…", { kind: "warn" });
    delete placeBtn.dataset.locked; return;
  }
  if (Math.floor(Date.now() / 1000) >= activeRound.betWindowEnd) {
    const { toast } = await import("../ui.js"); toast("Betting window closed", { kind: "warn" });
    delete placeBtn.dataset.locked; return;
  }

  // INSTANT UX: button becomes "Joining round…" right away; the crash
  // multiplier ticker keeps animating in the background as if nothing
  // changed. No "Connecting" / "Placing bet…" interruption.
  clearResultBanner(); clearFairServer();
  placeBtn.textContent = "Joining round…";
  placeBtn.disabled = true;

  try {
    await connect();
    const finalStake = await clampStakeStr(stake, "crash");
    if (finalStake == null) {
      setStagePill("ready", "READY");
      placeBtn.textContent = "Place bet";
      placeBtn.disabled = false;
      delete placeBtn.dataset.locked;
      return;
    }
    const result = await SL.placeCrash(ac, finalStake);
    populateFairPanel({ clientSeed: ethers.ZeroHash, betId: activeRound.id, nonce: activeRound.id, serverSeed: ethers.ZeroHash, txHash: result.txHash });
    placeBtn.textContent = `In round #${activeRound.id}`;
    await loadActiveRound();
  } catch (e) {
    const msg = friendlyError(e);
    if (/rejected|user cancelled/i.test(msg)) {
      setStagePill("ready", "READY");
      placeBtn.textContent = "Place bet";
    } else {
      setStagePill(null, "ERROR");
      setResultBanner({ won: false, txt: `<b>FAILED</b> · ${msg}`, accent: "#facc15" });
    }
  } finally {
    setTimeout(() => { delete placeBtn.dataset.locked; placeBtn.disabled = false; recalcSummary(); }, 800);
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
    const events = await fetchRecentLogs(c, "CrashRoundSettled", { minCount: 20, maxLookback: 20_000 });
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
    applyMaxToInput(stakeEl, "crash").catch(() => {});
    setInterval(() => applyMaxToInput(stakeEl, "crash").catch(() => {}), 10_000);
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
