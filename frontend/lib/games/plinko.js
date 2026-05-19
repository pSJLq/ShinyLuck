// Plinko integration on top of _base.js.
//
// Animation: the ball's path is encoded in the lower 16 bits of `randomness`
// emitted by Casino — bit k indicates which way the ball bounced off row k
// (0 = left, 1 = right). The contract already enforces this mapping, so we
// can replay it deterministically on the frontend and watch the ball drop.

import { ethers } from "https://esm.sh/ethers@6.13.2";
import { SL, connect } from "../wallet.js";
import {
  $, $$, setText, fmtSTTfromString, readStakeStr, injectKeyframes,
  setStagePill, setResultBanner, clearResultBanner, clearFairServer,
  populateFairPanel, refreshFairFromPlayer, refreshRecentEvents,
  pollForSettle, fmtSTT, friendlyError, refreshEV,
} from "./_base.js";
import { validateStake } from "../errors.js";
import { clampStakeStr, applyMaxToInput } from "../casino-limits.js";

const PLINKO = 4;
const ROWS = 16;
const SLOTS = 17;

let risk = 0;
let lastBetId = null;

const PAYOUT_TABLES = {
  0: [1600, 900, 200, 140, 140, 120, 110, 100, 50, 100, 110, 120, 140, 140, 200, 900, 1600],
  1: [11000, 4100, 1000, 500, 300, 150, 100, 50, 30, 50, 100, 150, 300, 500, 1000, 4100, 11000],
  2: [100000, 13000, 2600, 900, 400, 200, 20, 20, 20, 20, 20, 200, 400, 900, 2600, 13000, 100000],
};

function recalcSummary() {
  const stake = readStakeStr();
  const stakeNum = parseFloat(stake) || 0;
  const table = PAYOUT_TABLES[risk] || PAYOUT_TABLES[0];
  const maxPay = Math.max(...table) / 100;
  $$("[data-sl-profit]").forEach((el) => {
    el.textContent = stakeNum > 0 ? `up to + ${(stakeNum * (maxPay - 1)).toFixed(2)} STT` : "—";
  });
  const placeBtn = $("[data-sl-place]");
  if (placeBtn && !placeBtn.dataset.locked) {
    placeBtn.textContent = `Drop ball — ${fmtSTTfromString(stake)} STT`;
  }
  refreshEV(PLINKO).catch(() => {});
}

function decodePlinko(resultData) {
  try {
    const [path, slot, payX100] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["uint16", "uint8", "uint32"], resultData);
    return { path: Number(path), slot: Number(slot), payX100: Number(payX100) };
  } catch { return { path: 0, slot: 0, payX100: 0 }; }
}

// ---------------------------------------------------------------------
// Canvas animation — pegs in a triangle, ball drops, bounces left/right
// per encoded path. ~3s total. requestAnimationFrame loop, no deps.
// ---------------------------------------------------------------------

function ensureCanvas() {
  let canvas = $("[data-sl-plinko-canvas]");
  if (canvas) return canvas;
  const host = $("[data-sl-plinko-stage]") || $(".stage-body");
  if (!host) return null;
  canvas = document.createElement("canvas");
  canvas.setAttribute("data-sl-plinko-canvas", "");
  canvas.width = 520;
  canvas.height = 540;
  canvas.style.cssText = "width:100%; max-width:520px; height:auto; display:block; margin:0 auto;";
  host.appendChild(canvas);
  return canvas;
}

function pegLayout(canvas) {
  const w = canvas.width, h = canvas.height;
  const topY = 60;
  const bottomY = h - 80;
  const rowSpacing = (bottomY - topY) / ROWS;
  const pegRadius = 4;
  // Row k has k+3 pegs centred on the canvas (so SLOTS = ROWS + 1 = 17).
  const pegs = [];
  for (let row = 0; row < ROWS; row++) {
    const count = row + 3;
    const spacing = w / (count + 1);
    for (let i = 0; i < count; i++) {
      pegs.push({ row, col: i, x: spacing * (i + 1), y: topY + row * rowSpacing, r: pegRadius });
    }
  }
  return { pegs, rowSpacing, topY, bottomY };
}

function drawScene(ctx, canvas, layout, highlightSlot = -1) {
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  // Pegs
  ctx.fillStyle = "#3f3f46";
  for (const p of layout.pegs) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Slot lanes at the bottom
  const table = PAYOUT_TABLES[risk] || PAYOUT_TABLES[0];
  const slotW = w / SLOTS;
  for (let i = 0; i < SLOTS; i++) {
    const mult = table[i] / 100;
    const active = i === highlightSlot;
    ctx.fillStyle = active ? "rgba(34, 211, 238, 0.18)" : "rgba(20, 20, 24, 0.6)";
    ctx.fillRect(i * slotW + 2, layout.bottomY + 6, slotW - 4, 60);
    ctx.fillStyle = active ? "#22d3ee" : (mult >= 2 ? "#a3e635" : (mult < 1 ? "#dc2626" : "#facc15"));
    ctx.font = "10px JetBrains Mono, monospace";
    ctx.textAlign = "center";
    ctx.fillText(mult.toFixed(2) + "×", i * slotW + slotW / 2, layout.bottomY + 36);
  }
}

function animateBall({ pathBits, finalSlot }) {
  return new Promise((resolve) => {
    const canvas = ensureCanvas();
    if (!canvas) return resolve();
    const ctx = canvas.getContext("2d");
    const layout = pegLayout(canvas);

    // Convert pathBits → list of left(0) / right(1) decisions length=ROWS.
    const decisions = [];
    for (let i = 0; i < ROWS; i++) decisions.push((pathBits >> i) & 1);

    // Replay the same column-walk as Casino's bit-count → slot logic so the
    // visual final-column matches the contract's payout slot.
    let col = ROWS / 2;
    const stops = [{ x: canvas.width / 2, y: layout.topY - 16 }];
    for (let row = 0; row < ROWS; row++) {
      col = col + (decisions[row] === 1 ? 0.5 : -0.5);
      const rowPegCount = row + 3;
      const spacing = canvas.width / (rowPegCount + 1);
      const xMid = spacing * (Math.max(0, Math.min(rowPegCount - 1, Math.floor(col))) + 1);
      stops.push({ x: xMid + (decisions[row] === 1 ? spacing / 2 : -spacing / 2), y: layout.topY + row * layout.rowSpacing + 16 });
    }
    // Final resting position over the computed slot.
    const slotW = canvas.width / SLOTS;
    stops.push({ x: slotW * finalSlot + slotW / 2, y: layout.bottomY + 30 });

    const totalDuration = 2800;
    const start = performance.now();
    function frame(now) {
      const t = Math.min(1, (now - start) / totalDuration);
      // Walk linearly through stops based on t.
      const segCount = stops.length - 1;
      const segIdx = Math.min(segCount - 1, Math.floor(t * segCount));
      const segT = (t * segCount) - segIdx;
      const a = stops[segIdx], b = stops[segIdx + 1];
      const x = a.x + (b.x - a.x) * segT;
      // Add a parabolic dip to fake gravity between pegs.
      const yLerp = a.y + (b.y - a.y) * segT;
      const dip = Math.sin(segT * Math.PI) * 6;
      const y = yLerp + dip;
      drawScene(ctx, canvas, layout, t > 0.96 ? finalSlot : -1);
      ctx.beginPath();
      ctx.fillStyle = "#22d3ee";
      ctx.shadowColor = "rgba(34, 211, 238, 0.7)";
      ctx.shadowBlur = 14;
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
}

function drawIdle() {
  const canvas = ensureCanvas();
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  drawScene(ctx, canvas, pegLayout(canvas), -1);
}

async function refreshRecent() {
  return refreshRecentEvents({
    containerSelector: "[data-sl-plinko-recent]",
    gameId: PLINKO,
    decode: (ev) => {
      const { payX100 } = decodePlinko(ev.args.resultData);
      const label = payX100 > 0 ? (payX100 / 100).toFixed(2) + "×" : "0×";
      return { label, won: ev.args.won };
    },
    emptyLabel: "no recent drops",
    latestBetId: lastBetId,
  });
}

async function onPlaceBet() {
  const placeBtn = $("[data-sl-place]");
  if (!placeBtn) return;
  if (placeBtn.dataset.locked === "1") return;
  placeBtn.dataset.locked = "1";

  const stake = readStakeStr() || "0.05";
  const stakeErr = validateStake(stake);
  if (stakeErr) {
    const { toast } = await import("../ui.js");
    toast(stakeErr, { kind: "warn" });
    delete placeBtn.dataset.locked;
    return;
  }

  // INSTANT UX: button says "Dropping…", chain tx happens silently in the
  // background. When chain reveals the path, the ball animation plays — the
  // user sees a continuous "drop" visual, not a "submitting…" wait.
  clearResultBanner();
  clearFairServer();
  setStagePill("live", "DROPPING");
  placeBtn.textContent = "Dropping…";
  placeBtn.disabled = true;

  try {
    await connect();
    const finalStake = await clampStakeStr(stake, "plinko");
    if (finalStake == null) {
      setStagePill("ready", "READY");
      placeBtn.textContent = "Drop ball";
      placeBtn.disabled = false;
      delete placeBtn.dataset.locked;
      return;
    }
    const { betId, txHash, clientSeed } = await SL.placePlinko(risk, finalStake);
    lastBetId = betId;
    populateFairPanel({ clientSeed, betId, nonce: betId, serverSeed: ethers.ZeroHash, txHash });

    const settled = await pollForSettle(betId);
    if (!settled) { setStagePill(null, "TIMED OUT"); placeBtn.textContent = "Refresh to retry"; return; }
    if (settled.refunded) {
      setStagePill(null, "REFUNDED");
      setResultBanner({ won: false, txt: `<b>REFUNDED</b> · ${settled.args.reason}`, accent: "#facc15" });
      return;
    }
    const { path, slot, payX100 } = decodePlinko(settled.args.resultData);
    await animateBall({ pathBits: path, finalSlot: slot });
    const multX = payX100 / 100;
    populateFairPanel({
      clientSeed: settled.args.clientSeed,
      betId: settled.args.betId, nonce: settled.args.nonce,
      serverSeed: settled.args.serverSeed, txHash: settled.transactionHash,
    });
    setStagePill(settled.args.won ? "won" : "lost", settled.args.won ? "WON" : "LOSS");
    const stakeWei = ethers.parseEther(stake);
    if (settled.args.won) {
      const profit = BigInt(settled.args.payout) - stakeWei;
      setResultBanner({ won: true, txt: `<b>WON</b> · slot ${slot} · ${multX.toFixed(2)}× · + ${fmtSTT(profit)} STT`, txHash: settled.transactionHash });
    } else {
      setResultBanner({ won: false, txt: `<b>LOSS</b> · slot ${slot} · ${multX.toFixed(2)}×`, txHash: settled.transactionHash });
    }
    refreshRecent();
  } catch (e) {
    const msg = friendlyError(e);
    if (/rejected|user cancelled/i.test(msg)) {
      setStagePill("ready", "READY");
    } else {
      setStagePill(null, "ERROR");
      setResultBanner({ won: false, txt: `<b>FAILED</b> · ${msg}`, accent: "#facc15" });
      console.error("[plinko] place failed:", e);
    }
  } finally {
    setTimeout(() => { delete placeBtn.dataset.locked; placeBtn.disabled = false; recalcSummary(); }, 800);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  injectKeyframes();
  $$("[data-sl-risk]").forEach((btn) => {
    btn.addEventListener("click", () => {
      risk = parseInt(btn.dataset.value, 10) || 0;
      $$("[data-sl-risk]").forEach((b) => b.classList.toggle("active", b === btn));
      recalcSummary();
      drawIdle();
    });
  });
  const stakeEl = $("[data-sl-stake]");
  if (stakeEl) {
    stakeEl.addEventListener("input", recalcSummary);
    stakeEl.addEventListener("change", recalcSummary);
    applyMaxToInput(stakeEl, "plinko").catch(() => {});
    setInterval(() => applyMaxToInput(stakeEl, "plinko").catch(() => {}), 10_000);
  }
  $$(".preset[onclick]").forEach((btn) => {
    const oldHandler = btn.onclick;
    btn.onclick = function (...args) { if (oldHandler) oldHandler.apply(this, args); recalcSummary(); };
  });
  $("[data-sl-place]")?.addEventListener("click", onPlaceBet);

  recalcSummary();
  setStagePill("ready", "READY");
  drawIdle();
  refreshRecent().catch((e) => console.warn("[plinko] recent:", e.message));
  document.addEventListener("shinyluck:connected", () => {
    refreshFairFromPlayer(PLINKO).catch((e) => console.warn("[plinko] fair:", e.message));
  });
  setInterval(() => refreshRecent().catch(() => {}), 12_000);
});
