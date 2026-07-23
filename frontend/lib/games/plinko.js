// Plinko integration on top of _base.js.
//
// Animation: the ball's path is encoded in the lower 16 bits of `randomness`
// emitted by Casino · bit k indicates which way the ball bounced off row k
// (0 = left, 1 = right). The contract already enforces this mapping, so we
// can replay it deterministically on the frontend and watch the ball drop.

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
    el.textContent = stakeNum > 0 ? `up to + ${(stakeNum * (maxPay - 1)).toFixed(2)} STT` : "-";
  });
  const placeBtn = $("[data-sl-place]");
  if (placeBtn && !placeBtn.dataset.locked) {
    placeBtn.textContent = `Drop ball · ${fmtSTTfromString(stake)} STT`;
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
// Canvas animation · pegs in a triangle, ball drops, bounces left/right
// per encoded path. ~3s total. requestAnimationFrame loop, no deps.
// ---------------------------------------------------------------------

// Logical drawing size (CSS px); the backing store is scaled by DPR for crisp
// pegs/text on any display. W×H is the coordinate system drawScene() uses.
const PW = 520, PH = 560;

function ensureCanvas() {
  let canvas = $("[data-sl-plinko-canvas]");
  if (canvas) return canvas;
  const host = $("[data-sl-plinko-stage]") || $(".stage-body");
  if (!host) return null;
  canvas = document.createElement("canvas");
  canvas.setAttribute("data-sl-plinko-canvas", "");
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = PW * dpr;
  canvas.height = PH * dpr;
  canvas.style.cssText = "width:100%; max-width:520px; height:auto; display:block; margin:0 auto;";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in logical PW×PH units
  host.appendChild(canvas);
  return canvas;
}

// Colour a multiplier by tier: <1 loss (red), 1–2 hold (soft), ≥2 win (gold),
// big (bright gold). Kept consistent between buckets and the ball's landing.
function slotColor(mult) {
  if (mult >= 10) return "#ffd76a";
  if (mult >= 2)  return "#e8c15a";
  if (mult < 1)   return "#c8503e";
  return "#8a8674";
}

function pegLayout() {
  const topY = 74, bottomY = PH - 96;
  const rowSpacing = (bottomY - topY) / ROWS;
  const pegs = [];
  // Row k has k+3 pegs centred (bottom row = 18 pegs → 17 slots). Keep a
  // side margin so the outer pegs + widest buckets aren't clipped.
  for (let row = 0; row < ROWS; row++) {
    const count = row + 3;
    const usableW = PW - 44;
    const spacing = usableW / (count + 1);
    const x0 = (PW - usableW) / 2;
    for (let i = 0; i < count; i++) {
      pegs.push({ row, x: x0 + spacing * (i + 1), y: topY + row * rowSpacing, r: 3.2 });
    }
  }
  return { pegs, rowSpacing, topY, bottomY };
}

function drawScene(ctx, layout, highlightSlot = -1) {
  ctx.clearRect(0, 0, PW, PH);

  // felt panel · matte black with a faint gold vignette + hairline border
  const bg = ctx.createRadialGradient(PW / 2, layout.topY, 20, PW / 2, PH / 2, PH * 0.8);
  bg.addColorStop(0, "#141118");
  bg.addColorStop(1, "#0a0a0c");
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(1, 1, PW - 2, PH - 2, 18); ctx.fillStyle = bg; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = "rgba(217,185,112,.18)"; ctx.stroke(); }
  else { ctx.fillStyle = bg; ctx.fillRect(0, 0, PW, PH); }

  // pegs · soft gold orbs with a highlight dot
  for (const p of layout.pegs) {
    const g = ctx.createRadialGradient(p.x - 1, p.y - 1, 0, p.x, p.y, p.r * 2.4);
    g.addColorStop(0, "rgba(246,241,231,.95)");
    g.addColorStop(0.4, "rgba(217,185,112,.85)");
    g.addColorStop(1, "rgba(217,185,112,.12)");
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
  }

  // slot buckets
  const table = PAYOUT_TABLES[risk] || PAYOUT_TABLES[0];
  const usableW = PW - 44, x0 = (PW - usableW) / 2, slotW = usableW / SLOTS;
  for (let i = 0; i < SLOTS; i++) {
    const mult = table[i] / 100;
    const active = i === highlightSlot;
    const col = slotColor(mult);
    const x = x0 + i * slotW + 2, y = layout.bottomY + 12, w = slotW - 4, h = 46;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, 6); else ctx.rect(x, y, w, h);
    const gg = ctx.createLinearGradient(0, y, 0, y + h);
    gg.addColorStop(0, active ? col : hexA(col, 0.32));
    gg.addColorStop(1, active ? hexA(col, 0.5) : hexA(col, 0.10));
    ctx.fillStyle = gg; ctx.fill();
    if (active) { ctx.lineWidth = 1.5; ctx.strokeStyle = col; ctx.stroke(); }
    ctx.fillStyle = active ? "#0a0a0c" : col;
    ctx.font = `600 ${mult >= 100 ? 8.5 : 9.5}px "JetBrains Mono", monospace`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText((mult >= 100 ? mult.toFixed(0) : mult.toFixed(2)) + "×", x + w / 2, y + h / 2);
  }
  ctx.textBaseline = "alphabetic";
}

// #rrggbb + alpha → rgba() string
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function animateBall({ pathBits, finalSlot }) {
  return new Promise((resolve) => {
    const canvas = ensureCanvas();
    if (!canvas) return resolve();
    const ctx = canvas.getContext("2d");
    const layout = pegLayout();
    const usableW = PW - 44, x0 = (PW - usableW) / 2;

    // pathBits → left(0)/right(1) per row (same mapping the contract counts).
    const decisions = [];
    for (let i = 0; i < ROWS; i++) decisions.push((pathBits >> i) & 1);

    // Replay the column walk so the ball lands over the contract's slot.
    let col = ROWS / 2;
    const stops = [{ x: PW / 2, y: layout.topY - 18 }];
    for (let row = 0; row < ROWS; row++) {
      col = col + (decisions[row] === 1 ? 0.5 : -0.5);
      const rowPegCount = row + 3;
      const spacing = usableW / (rowPegCount + 1);
      const xMid = x0 + spacing * (Math.max(0, Math.min(rowPegCount - 1, Math.floor(col))) + 1);
      stops.push({ x: xMid + (decisions[row] === 1 ? spacing / 2 : -spacing / 2), y: layout.topY + row * layout.rowSpacing + 16 });
    }
    const slotW = usableW / SLOTS;
    stops.push({ x: x0 + slotW * finalSlot + slotW / 2, y: layout.bottomY + 34 });

    const totalDuration = 2600;
    const start = performance.now();
    function frame(now) {
      const t = Math.min(1, (now - start) / totalDuration);
      const segCount = stops.length - 1;
      const segIdx = Math.min(segCount - 1, Math.floor(t * segCount));
      const segT = (t * segCount) - segIdx;
      const a = stops[segIdx], b = stops[segIdx + 1];
      const x = a.x + (b.x - a.x) * segT;
      const dip = Math.sin(segT * Math.PI) * 7; // fake gravity between rows
      const y = a.y + (b.y - a.y) * segT + dip;
      drawScene(ctx, layout, t > 0.95 ? finalSlot : -1);
      ctx.beginPath();
      ctx.fillStyle = "#F6F1E7";
      ctx.shadowColor = "rgba(217,185,112,.85)";
      ctx.shadowBlur = 16;
      ctx.arc(x, y, 6.5, 0, Math.PI * 2);
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
  drawScene(canvas.getContext("2d"), pegLayout(), -1);
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
  // background. When chain reveals the path, the ball animation plays · the
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

    // Direct status poll (via the RPC proxy) instead of the WS/log path, which
    // could hang for minutes on a missed subscription — the bug behind the
    // "stuck on Dropping…" report. getBet carries everything: status, won,
    // payout and randomness. The ball path/slot are derived from randomness
    // exactly as the contract computes them, so no event decode is needed.
    let bet = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      await new Promise((r) => setTimeout(r, 800));
      try { const b = await SL.casino.getBet(betId); if (Number(b.status) !== 0) { bet = b; break; } } catch (_) {}
    }
    if (!bet) { setStagePill(null, "TIMED OUT"); placeBtn.textContent = "Refresh to retry"; return; }
    if (Number(bet.status) === 2) {
      setStagePill(null, "REFUNDED");
      setResultBanner({ won: false, txt: `<b>REFUNDED</b> · stake returned`, accent: "#facc15" });
      return;
    }
    const path = Number(BigInt(bet.randomness) & 0xFFFFn);
    let slot = 0; for (let i = 0; i < 16; i++) if ((path >> i) & 1) slot++;
    const payX100 = (PAYOUT_TABLES[risk] || PAYOUT_TABLES[0])[slot];
    await animateBall({ pathBits: path, finalSlot: slot });
    const multX = payX100 / 100;
    populateFairPanel({ clientSeed: bet.clientSeed, betId, nonce: betId, serverSeed: bet.randomness, txHash });
    setStagePill(bet.won ? "won" : "lost", bet.won ? "WON" : "LOSS");
    const stakeWei = ethers.parseEther(finalStake);
    if (bet.won) {
      const profit = BigInt(bet.payout) - stakeWei;
      setResultBanner({ won: true, txt: `<b>WON</b> · ${multX.toFixed(2)}× · + ${fmtSTT(profit)} STT`, txHash });
    } else {
      setResultBanner({ won: false, txt: `<b>LOSS</b> · ${multX.toFixed(2)}×` });
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
