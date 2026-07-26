// Dice integration on top of _base.js.

import { ethers } from "/vendor/ethers.bundle.js";
import { SL, connect } from "../wallet.js";
import {
  $, $$, setText, fmtSTTfromString, readStakeStr, injectKeyframes,
  setStagePill, setResultBanner, clearResultBanner, clearFairServer,
  populateFairPanel, refreshFairFromPlayer, refreshRecentEvents,
  pollForSettle, fmtSTT, friendlyError, refreshEV,
} from "./_base.js";
import { validateStake } from "../errors.js";
import { clampStakeStr, applyMaxToInput } from "../casino-limits.js";

const DICE = 0;
let direction = "over";
let target = 50;   // percent, hundredths allowed (0.01 .. 99.99)

/// Trim the trailing zeros so a whole target reads "50", not "50.00".
const fmtTarget = (v) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2))));

/// Clamp to a target that actually has winning space in this direction.
function clampTarget(v, dir) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 50;
  const lo = dir === "over" ? 0.01 : 0.02;
  const hi = dir === "over" ? 99.98 : 99.99;
  return Math.min(hi, Math.max(lo, Math.round(n * 100) / 100));
}
let lastBetId = null;

function recalcSummary() {
  // Hundredths, exactly as the module counts them: outcomes are 1..10000, and
  // the target itself never wins.
  const bps = Math.round(target * 100);
  const winCount = direction === "over" ? (10000 - bps) : (bps - 1);
  const winChance = winCount / 100;
  const winChancePct = winChance > 0 ? winChance.toFixed(2) : "0.00";
  const payoutMultiplier = winChance > 0 ? 99 / winChance : 0;
  const stakeStr = readStakeStr();
  const stakeNum = parseFloat(stakeStr) || 0;
  const profit = stakeNum > 0 && winChance > 0 ? stakeNum * payoutMultiplier - stakeNum : 0;

  setText("[data-sl-target]", fmtTarget(target));
  setText("[data-sl-winchance]", winChancePct + "%");
  setText("[data-sl-payout]", (payoutMultiplier >= 1000 ? Math.round(payoutMultiplier).toLocaleString("en-US") : payoutMultiplier.toFixed(2)) + "×");
  setText("[data-sl-winchance-right]", winChancePct + " %");
  $$("[data-sl-profit]").forEach((el) => {
    el.textContent = (profit >= 0 ? "+ " : "− ") + fmtSTTfromString(String(Math.abs(profit))) + " STT";
  });

  const placeBtn = $("[data-sl-place]");
  if (placeBtn && !placeBtn.dataset.locked) {
    placeBtn.textContent = `Place bet · ${fmtSTTfromString(stakeStr)} STT`;
  }
  refreshEV(DICE).catch(() => {});
}

function decodeDiceResult(resultData) {
  try {
    // The module emits a bare roll on the legacy percent shape and
    // (roll, scale) on the hundredths one — 32 vs 64 bytes.
    const dec = ethers.AbiCoder.defaultAbiCoder();
    const bytes = ethers.getBytes(resultData).length;
    if (bytes > 32) {
      const [roll, scale] = dec.decode(["uint256", "uint256"], resultData);
      // Report it on the percent scale so "37.42" lines up with the target.
      return Number(roll) / (Number(scale) / 100);
    }
    const [roll] = dec.decode(["uint256"], resultData);
    return Number(roll);
  } catch { return null; }
}

function diceAnimStart() {
  const el = $("[data-sl-dice-big]");
  if (!el) return;
  el.style.animation = "dice-shake 0.6s ease-in-out infinite";
  // During roll, blank the number out so the user knows it's resolving.
  const numEl = el.querySelector(".dice-num");
  if (numEl) numEl.textContent = "?";
}
function diceAnimStop(roll) {
  const el = $("[data-sl-dice-big]");
  if (!el) return;
  el.style.animation = "";
  // Render the actual roll as a big number in the centre of the dice. The
  // old pip-pattern path (roll % 6) was visually misleading: a player who
  // rolled 57 would see 3 pips, which doesn't match the banner.
  const numEl = el.querySelector(".dice-num");
  if (numEl) numEl.textContent = (roll != null ? fmtTarget(roll) : "?");
}

async function refreshRecent() {
  return refreshRecentEvents({
    containerSelector: "[data-sl-dice-recent]",
    gameId: DICE,
    decode: (ev) => {
      const roll = decodeDiceResult(ev.args.resultData);
      return { label: roll != null ? fmtTarget(roll) : "?", won: ev.args.won };
    },
    emptyLabel: "no recent rolls",
    latestBetId: lastBetId,
  });
}

async function onPlaceBet() {
  const placeBtn = $("[data-sl-place]");
  if (!placeBtn) return;
  if (placeBtn.dataset.locked === "1") return;
  placeBtn.dataset.locked = "1";

  const stake = readStakeStr() || "0.1";
  const stakeErr = validateStake(stake);
  if (stakeErr) {
    const { toast } = await import("../ui.js");
    toast(stakeErr, { kind: "warn" });
    delete placeBtn.dataset.locked;
    return;
  }
  const t = clampTarget(target, direction);

  // INSTANT UX: dice starts shaking the moment user clicks · the chain
  // tx happens silently in the background. Whether Sequence (~27s) or
  // MetaMask (~3s), the user sees a continuous rolling animation, not a
  // "submitting…" spinner. Result fades in when the chain reveals it.
  clearResultBanner();
  clearFairServer();
  setStagePill("live", "ROLLING");
  placeBtn.textContent = "Rolling…";
  placeBtn.disabled = true;
  diceAnimStart();

  try {
    // Connect silently if needed · no UI for "Connecting".
    await connect();
    // Clamp stake to live maxBet (defense in depth · Casino will revert with
    // BetTooLarge if bankroll drops further between this read and submit).
    // Long odds pay up to 9900x, so the binding limit is the Vault's max
    // PAYOUT, not its max stake. Tell the limiter this bet's ceiling.
    const winCount = direction === "over" ? (10000 - Math.round(t * 100)) : (Math.round(t * 100) - 1);
    const capX100 = winCount > 0 ? BigInt(Math.ceil((9900 * 10000) / winCount)) : null;
    const finalStake = await clampStakeStr(stake, "dice", capX100 ? { capX100 } : {});
    if (finalStake == null) {
      diceAnimStop(null);
      setStagePill("ready", "READY");
      placeBtn.textContent = "Place bet";
      placeBtn.disabled = false;
      delete placeBtn.dataset.locked;
      return;
    }
    const { betId, txHash, clientSeed } = await SL.placeDice(t, direction === "over", finalStake);
    lastBetId = betId;
    populateFairPanel({ clientSeed, betId, nonce: betId, serverSeed: ethers.ZeroHash, txHash });

    const settled = await pollForSettle(betId);
    SL.autoClaim?.().catch(() => {});   // winnings straight to the wallet
    const roll = settled && !settled.refunded ? decodeDiceResult(settled.args.resultData) : null;
    diceAnimStop(roll || 0);

    if (!settled) {
      setStagePill(null, "TIMED OUT");
      placeBtn.textContent = "Refresh to retry";
      return;
    }
    if (settled.refunded) {
      setStagePill(null, "REFUNDED");
      setResultBanner({ won: false, txt: `<b>REFUNDED</b> · ${settled.args.reason}`, accent: "#facc15" });
      return;
    }

    setText("[data-sl-result]", `${settled.args.won ? "WON" : "LOST"} · roll ${roll}`);
    populateFairPanel({
      clientSeed: settled.args.clientSeed,
      betId: settled.args.betId,
      nonce: settled.args.nonce,
      serverSeed: settled.args.serverSeed,
      txHash: settled.transactionHash,
    });
    setStagePill(settled.args.won ? "won" : "lost", settled.args.won ? "WON" : "LOST");
    const stakeWei = ethers.parseEther(stake);
    if (settled.args.won) {
      const profit = BigInt(settled.args.payout) - stakeWei;
      setResultBanner({ won: true, txt: `<b>WON</b> · roll ${roll} · + ${fmtSTT(profit)} STT`, txHash: settled.transactionHash });
    } else {
      setResultBanner({ won: false, txt: `<b>LOST</b> · roll ${roll} · − ${fmtSTT(stakeWei)} STT`, txHash: settled.transactionHash });
    }
    refreshRecent();
  } catch (e) {
    diceAnimStop(null);
    const msg = friendlyError(e);
    // User rejected the tx? Quiet error · no scary banner.
    if (/rejected|user cancelled/i.test(msg)) {
      setStagePill("ready", "READY");
    } else {
      setStagePill(null, "ERROR");
      setResultBanner({ won: false, txt: `<b>FAILED</b> · ${msg}`, accent: "#facc15" });
      console.error("[dice] place failed:", e);
    }
  } finally {
    setTimeout(() => { delete placeBtn.dataset.locked; placeBtn.disabled = false; recalcSummary(); }, 800);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  injectKeyframes();
  $$("[data-sl-direction]").forEach((btn) => {
    btn.addEventListener("click", () => {
      direction = btn.dataset.value === "under" ? "under" : "over";
      $$("[data-sl-direction]").forEach((b) => b.classList.toggle("active", b === btn));
      recalcSummary();
    });
  });
  const slider = $("[data-sl-targetinput]");
  if (slider) {
    target = clampTarget(parseFloat(slider.value), direction);
    slider.addEventListener("input", () => {
      target = clampTarget(parseFloat(slider.value), direction);
      recalcSummary();
    });
  }
  const stakeEl = $("[data-sl-stake]");
  if (stakeEl) {
    stakeEl.addEventListener("input", recalcSummary);
    stakeEl.addEventListener("change", recalcSummary);
    // Pin the input's max= attr to the live casino cap, refreshed every 10s.
    applyMaxToInput(stakeEl, "dice").catch(() => {});
    setInterval(() => applyMaxToInput(stakeEl, "dice").catch(() => {}), 10_000);
  }
  $$(".preset[onclick]").forEach((btn) => {
    const oldHandler = btn.onclick;
    btn.onclick = function (...args) { if (oldHandler) oldHandler.apply(this, args); recalcSummary(); };
  });
  $("[data-sl-place]")?.addEventListener("click", onPlaceBet);

  recalcSummary();
  setStagePill("ready", "READY");
  refreshRecent().catch((e) => console.warn("[dice] recent:", e.message));
  document.addEventListener("shinyluck:connected", () => {
    refreshFairFromPlayer(DICE).catch((e) => console.warn("[dice] fair:", e.message));
  });
  setInterval(() => refreshRecent().catch(() => {}), 12_000);
});
