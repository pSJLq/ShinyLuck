// Crash · round-based integration.
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

import { ethers } from "/vendor/ethers.bundle.js";
import { SL, connect } from "../wallet.js";
import { CONFIG } from "../config.js";
import { CONFIG_V15 } from "../config-v15.js";
import { provider, fetchRecentLogs } from "../rpc.js";
import {
  $, $$, setText, fmtSTTfromString, readStakeStr, injectKeyframes,
  setStagePill, setResultBanner, clearResultBanner, clearFairServer,
  populateFairPanel, friendlyError, fmtSTT, refreshEV,
} from "./_base.js";
import { validateStake, validateAutoCashout } from "../errors.js";
import { clampStakeStr, applyMaxToInput } from "../casino-limits.js";

const CRASH = 1;
// Was 1000ms · caused 1 RPC/s contract reads even when the round hadn't
// changed. WS subscriptions below catch real state changes instantly; this
// poll is just a fallback for missed events. 3s gives smooth UX without
// hammering RPC + freeing the main thread for cursor / animations.
const POLL_MS = 3000;

/// v15: crash is its own module contract, not the monolith.
const CRASH_ADDR = (CONFIG_V15.games || []).find((g) => g.name === "crash")?.module;

let casinoRO = null;
function casino() {
  if (!casinoRO) {
    const abi = [
      "function currentRoundId() view returns (uint256)",
      "function totalRounds() view returns (uint256)",
      "function getRound(uint256) view returns (uint64 id,uint64 betWindowEnd,uint64 commitBlock,uint32 seedIdx,bool settled,uint16 crashPointX100,bytes32 serverSeed,uint256 bettorCount)",
      "function getBettors(uint256) view returns (address[])",
      "function getBet(uint256,address) view returns (tuple(uint96 amount,uint16 autoCashoutX100,uint16 cashoutMultX100,bool resolved))",
      "event RoundStarted(uint256 indexed roundId,uint256 betWindowEnd,uint256 commitBlock,uint256 seedIdx)",
      "event RoundSettled(uint256 indexed roundId,uint256 crashPointX100,bytes32 serverSeed,bytes32 randomness,bytes32 blockHash)",
      "event RoundRefunded(uint256 indexed roundId,string reason)",
      "event BetPlaced(uint256 indexed roundId,address indexed player,uint256 amount,uint256 autoCashoutX100)",
      "event CashoutRequested(uint256 indexed roundId,address indexed player,uint256 multX100)",
    ];
    casinoRO = new ethers.Contract(CRASH_ADDR, abi, provider());
  }
  return casinoRO;
}

let activeRound = null;     // { id, betWindowEnd, commitBlock, settled, crashPointX100 }
let myBet = null;           // { roundId, amount, autoCashoutX100, cashoutMultX100, resolved }
let multTickerHandle = null;
let countdownHandle = null;
// Rounds whose crash-point climb we've already replayed (guards the poll + WS
// both firing onRoundSettled for the same round).
const replayedRounds = new Set();

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

/// The number on screen IS the cashout multiplier — 1.00× at launch, climbing,
/// and the crash point is where it stops.
///
/// This used to render "growth" (multiplier − 1), so a round that crashed at
/// 2.71× showed 1.71× on the curve while the history, the auto-cashout input
/// and the payout all spoke in 2.71×. Players read that as a bug or a swindle,
/// and it is a convention no other crash game uses.
function toDisplayMult(actualMult) {
  return Math.max(1, actualMult);
}

/// Update the SVG curve + glowing dot to reflect the live multiplier.
/// The viewBox is 800×420 with the round x-axis spanning 0..760 (we reserve
/// the right strip for the multiplier label). y=400 is the 0× floor and the
/// curve climbs logarithmically toward y=20 (the 50× ceiling).
function _updateCrashSvg(elapsedSec, actualMult) {
  // Guard against NaN / negative / zero inputs. predictedMultiplier can yield
  // 0 or NaN if a round is between phases or roundStartSec is bogus · without
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
  // 1.00× the moment the round goes live (vs lingering on the previous
  // round's crash point).
  _updateCrashSvg(0, 1);
  const el = $("[data-sl-crash-mult]");
  if (el) {
    el.textContent = "1.00";
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
  // The crash point as everyone else states it: 2.71x reads 2.71x.
  const v = toDisplayMult(Number(cpX));
  el.textContent = Number.isFinite(v) ? v.toFixed(2) : "1.00";
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
    const total = Number(await c.totalRounds());
    if (total === 0) {
      renderPhasePill("BETTING");
      setText("[data-sl-crash-countdown]", "waiting for first round…");
      return;
    }
    const id = Number(await c.currentRoundId());
    const r = await c.getRound(id);
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
      // also reset the SVG curve to the bottom-left during BETTING phase so
      // the previous round's crash point isn't lingering.
      _updateCrashSvg(0, 1);
    } else if (!r.settled) {
      // Window closed → the bot is about to reveal the crash point. The visible
      // climb is a deterministic REPLAY (onRoundSettled) once that reveal lands,
      // not a wall-clock ticker: the round settles ~1s after the window and the
      // ~26s blockhash budget leaves no room for a real-time flight. So here we
      // just signal the reveal is imminent.
      renderPhasePill("RUNNING");
      stopTicker();
      setText("[data-sl-crash-countdown]", "revealing…");
    } else {
      renderPhasePill("SETTLED");
      stopTicker();
      setText("[data-sl-crash-countdown]", "round closed");
      onRoundSettled(id).catch(() => {});
    }
    if (SL.address) {
      const b = await c.getBet(id, SL.address);
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
    const addrs = await c.getBettors(roundId);
    if (addrs.length === 0) {
      list.innerHTML = `<div class="m" style="opacity:.4;">no players yet</div>`;
      return;
    }
    list.innerHTML = "";
    for (const a of addrs.slice(0, 30)) {
      const b = await c.getBet(roundId, a);
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
  // Auto-cashout ONLY: the real running window is ~1s (the bot settles right
  // after the bet window, bounded by the ~26s blockhash budget), so a live
  // manual cash-out button would almost never land. The player picks a target
  // multiplier up front and the climb replay shows whether the rocket reached
  // it. Keep the manual button permanently hidden.
  const co = $("[data-sl-cashout]");
  if (co) co.style.display = "none";
  if (!myBet || myBet.amount === 0n) { setText("[data-sl-crash-mybet]", "-"); return; }
  const ac = myBet.autoCashoutX100 > 0 ? `target ${(myBet.autoCashoutX100/100).toFixed(2)}×` : "no target (rides to crash)";
  setText("[data-sl-crash-mybet]", `${ethers.formatEther(myBet.amount)} STT · ${ac}`);
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
    // Crash is round-based: randomness = keccak(serverSeed, commit blockhash,
    // roundId) shared by everyone in the round — there is no per-player client
    // seed. The server seed is revealed at settle (onRoundSettled fills it in).
    populateFairPanel({ clientSeed: "round-based · shared server seed", betId: activeRound.id, nonce: activeRound.id, txHash: result.txHash });
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
    const events = await fetchRecentLogs(c, "RoundSettled", { minCount: 20, maxLookback: 20_000 });
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

// ---------------------------------------------------------------------------
// On-demand round opener (parity with roulette, 2026-07-24). The house bot no
// longer chains crash rounds after an EMPTY one (ROUND_ON_DEMAND=crash), so it
// idles gas-free when nobody's playing. A CONNECTED player watching the table
// opens the next round themselves once the current one has settled and none is
// open. startRound() is permissionless; races between two players are
// harmless (one lands, the loser reverts and we reconcile on the next tick).
// If crash is paused on-chain the call reverts before broadcast → costs nothing.
// ---------------------------------------------------------------------------
let startingRound = false;
let lastStartAttempt = 0;
async function maybeStartRound() {
  if (!SL.address || !SL.signer) return;   // only a signed-in player opens rounds
  if (document.hidden) return;             // and only while actually watching
  if (startingRound || Date.now() - lastStartAttempt < 12_000) return;
  // Only open when NO round is live: the current one is settled (or none
  // exists). Never during BETTING (open) or RUNNING (climbing, awaiting settle)
  // — that round is still live and the bot will settle it.
  const nowSec = Math.floor(Date.now() / 1000);
  if (activeRound && !activeRound.settled) return; // BETTING or RUNNING → live
  startingRound = true;
  try {
    lastStartAttempt = Date.now();
    const c = new ethers.Contract(CRASH_ADDR, ["function startRound()"], SL.signer);
    const tx = await c.startRound();
    await tx.wait();
    await loadActiveRound();
  } catch (_) { /* lost the race / paused · reconcile on the next tick */ }
  finally { startingRound = false; }
}

// Deterministic climb replay: animate the multiplier from 1.00× up to the
// revealed crash point over a duration that scales with the height, marking the
// player's target on the way up. This is the "growth" the player watches — the
// outcome is already fixed on-chain (they set the target before the round), so
// the tension is purely "did the rocket reach my number before it blew".
function animateCrashClimb(cpX100, myTargetX100) {
  return new Promise((resolve) => {
    stopTicker();
    const cp = Math.max(1, cpX100 / 100);
    const target = myTargetX100 > 0 ? myTargetX100 / 100 : 0;
    const el = $("[data-sl-crash-mult]");
    const dur = Math.min(6500, 1500 + Math.log(cp) * 2200);
    const startT = performance.now();
    let flashed = false;
    function frame(now) {
      const t = Math.min(1, (now - startT) / dur);
      const cur = 1 + (cp - 1) * (1 - Math.pow(1 - t, 2)); // ease-out → decelerates into the crash
      const reached = target > 0 && cur >= target;
      if (el) { el.textContent = toDisplayMult(cur).toFixed(2); el.style.color = reached ? "var(--green)" : "var(--cyan)"; }
      _updateCrashSvg(t * 30, cur);
      if (reached && !flashed) { flashed = true; setStagePill("won", `TARGET ${target.toFixed(2)}× HIT`); }
      else if (!reached) setStagePill("live", `FLYING · ${toDisplayMult(cur).toFixed(2)}×`);
      if (t < 1) requestAnimationFrame(frame);
      else { paintMultiplierFinal(cp, target > 0 && cp >= target); resolve(); }
    }
    requestAnimationFrame(frame);
  });
}

// Fired once per round when the crash point is revealed. Replays the climb for
// the player's own bet and reveals the result; also fills the provably-fair
// panel with the now-revealed server seed. Spectator rounds (no personal bet)
// just reset the stage to idle.
async function onRoundSettled(roundId) {
  if (replayedRounds.has(roundId)) return;
  replayedRounds.add(roundId);
  const c = casino();
  let r;
  try { r = await c.getRound(roundId); } catch (_) { return; }
  const cpX100 = Number(r.crashPointX100 ?? r[5]);
  const serverSeed = r.serverSeed ?? r[6];
  const cp = cpX100 / 100;

  // provably-fair: the server seed is public now.
  populateFairPanel({ betId: roundId, nonce: roundId, serverSeed });

  // Did the player have a bet in THIS round? Compute their effective payout the
  // exact way the contract does (max of target/manual that is ≤ crash point).
  let target = 0, stakeWei = 0n, hadBet = false;
  if (SL.address) {
    try {
      const b = await c.getBet(roundId, SL.address);
      if (BigInt(b.amount) > 0n) {
        hadBet = true; stakeWei = BigInt(b.amount);
        const auto = Number(b.autoCashoutX100), manual = Number(b.cashoutMultX100);
        if (auto > 0 && auto <= cpX100) target = auto;
        if (manual > 0 && manual <= cpX100 && manual > target) target = manual;
      }
    } catch (_) {}
  }

  if (!hadBet) {
    stopTicker();
    setText("[data-sl-crash-mult]", "1.00");
    _updateCrashSvg(0, 1);
    return;
  }

  await animateCrashClimb(cpX100, target);
  if (target > 0) {
    const payout = (stakeWei * BigInt(target)) / 100n;
    const profit = payout - stakeWei;
    setStagePill("won", `CASHED @ ${(target / 100).toFixed(2)}×`);
    setResultBanner({ won: true, txt: `<b>WON</b> · ${(target / 100).toFixed(2)}× · + ${fmtSTT(profit)} STT` });
  } else {
    setStagePill("lost", `CRASHED @ ${cp.toFixed(2)}×`);
    setResultBanner({ won: false, txt: `<b>CRASHED</b> at ${cp.toFixed(2)}× · − ${fmtSTT(stakeWei)} STT` });
  }
}

function bindWS() {
  // Subscribe to RoundStarted/Settled so the UI flips instantly.
  const c = casino();
  c.on("RoundStarted", () => loadActiveRound().catch(() => {}));
  c.on("RoundSettled", (roundId) => { onRoundSettled(Number(roundId)).catch(() => {}).then(() => maybeStartRound().catch(() => {})); refreshHistory().catch(() => {}); });
  c.on("BetPlaced",    () => loadActiveRound().catch(() => {}));
  c.on("CashoutRequested", () => loadActiveRound().catch(() => {}));
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
  loadActiveRound().then(() => maybeStartRound().catch(() => {})).catch(() => {});
  refreshHistory().catch(() => {});
  try { bindWS(); } catch (_) {}
  setInterval(() => loadActiveRound().then(() => maybeStartRound().catch(() => {})).catch(() => {}), POLL_MS);
  setInterval(() => refreshHistory().catch(() => {}), 12_000);
});
