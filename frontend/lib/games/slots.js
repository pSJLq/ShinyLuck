// Slots integration on top of _base.js — 5 reels × 3 rows, 20 paylines,
// wild + scatter, scatter-bonus instead of free spins (single-shot reveal).
//
// Symbol encoding (matches Casino + SlotsLib):
//   0..4 = low fruits, 5..6 = mid bonus, 7 = HIGH/jackpot, 8 = WILD, 9 = SCATTER
//
// Result `resultData` is abi.encode(uint8[15] grid, uint256 lineMultSum, uint256 scatterBonusX100).

import { ethers } from "https://esm.sh/ethers@6.13.2";
import { SL, connect } from "../wallet.js";
import {
  $, $$, setText, fmtSTTfromString, readStakeStr, injectKeyframes,
  setStagePill, setResultBanner, clearResultBanner, clearFairServer,
  populateFairPanel, refreshFairFromPlayer, refreshRecentEvents,
  pollForSettle, fmtSTT, friendlyError, refreshEV,
} from "./_base.js";
import { validateStake } from "../errors.js";
import { provider } from "../rpc.js";
import { CONFIG } from "../config.js";

const SLOTS = 2;
let lastBetId = null;

// Default symbol set (overridden by getSlotsTheme + augmented for wild/scatter).
const SYMBOLS = ["🍒", "🍋", "🔔", "💎", "⭐", "🍉", "7️⃣", "👑", "✨", "🎰"];
//                  0     1     2     3     4     5     6     7   wild   scatter

const PAYLINES = [
  [1,1,1,1,1], [0,0,0,0,0], [2,2,2,2,2],
  [0,1,2,1,0], [2,1,0,1,2],
  [1,0,0,0,1], [1,2,2,2,1],
  [0,0,1,2,2], [2,2,1,0,0],
  [1,2,1,0,1], [1,0,1,2,1],
  [0,1,0,1,0], [2,1,2,1,2],
  [1,1,0,1,1], [1,1,2,1,1],
  [0,0,1,0,0], [2,2,1,2,2],
  [0,1,1,1,0], [2,1,1,1,2],
  [0,1,2,2,2],
];

function recalcSummary() {
  const stake = readStakeStr();
  const stakeNum = parseFloat(stake) || 0;
  const placeBtn = $("[data-sl-place]");
  if (placeBtn && !placeBtn.dataset.locked) placeBtn.textContent = `Spin — ${fmtSTTfromString(stake)} STT`;
  $$("[data-sl-profit]").forEach((el) => {
    el.textContent = stakeNum > 0 ? `up to + ${(stakeNum * 499).toFixed(4)} STT` : "—";
  });
  refreshEV(SLOTS).catch(() => {});
}

function decodeSlots(resultData) {
  try {
    // VAULT.7 resultData layout:
    //   (uint8[15] grid, uint256 lineMultSumX100, uint8 scatterCount,
    //    uint256 scatterPayX100, bool wasFreeSpin)
    const [grid, lineMult, scatterCount, scatterPay, wasFreeSpin] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["uint8[15]", "uint256", "uint8", "uint256", "bool"], resultData);
    return {
      grid: grid.map(Number),
      lineMult: Number(lineMult),
      scatterCount: Number(scatterCount),
      scatterBonus: Number(scatterPay),
      wasFreeSpin: Boolean(wasFreeSpin),
    };
  } catch {
    return { grid: Array(15).fill(0), lineMult: 0, scatterCount: 0, scatterBonus: 0, wasFreeSpin: false };
  }
}

function tryFetchTheme() {
  const abi = ["function getSlotsTheme() view returns (string,string[5],uint256)"];
  if (!CONFIG.casino || CONFIG.casino === "0x0000000000000000000000000000000000000000") return;
  const c = new ethers.Contract(CONFIG.casino, abi, provider());
  return c.getSlotsTheme().then(([name, symbols]) => {
    if (name) setText("[data-sl-theme-name]", name);
    if (symbols && symbols.length === 5) {
      // Use the 5 themed symbols for index 0..4 (low fruits). Keep mid/high/wild/scatter fixed.
      for (let i = 0; i < 5; i++) if (symbols[i]) SYMBOLS[i] = symbols[i];
      drawGrid(null);
    }
  }).catch(() => {});
}

function drawGrid(grid, opts = {}) {
  // Render a 5x3 grid into [data-sl-slots-grid]. grid is row-major (row*5+reel).
  const host = $("[data-sl-slots-grid]");
  if (!host) return;
  host.innerHTML = "";
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 5; c++) {
      const idx = r * 5 + c;
      const sym = grid ? grid[idx] : (idx % 10);
      const cell = document.createElement("div");
      cell.className = "slot-cell";
      cell.dataset.idx = String(idx);
      cell.style.cssText = "border:1px solid var(--line); padding: 14px 0; text-align:center; font-size: 30px; background: var(--bg-1); position: relative;";
      cell.textContent = SYMBOLS[sym] || "?";
      if (opts.scattersHighlight && sym === 9) cell.style.background = "rgba(34, 211, 238, 0.18)";
      host.appendChild(cell);
    }
  }
}

function highlightPaylines(grid) {
  // For each line with run >= 3, paint matching cells. Done after draw.
  const host = $("[data-sl-slots-grid]");
  if (!host) return;
  for (let line = 0; line < PAYLINES.length; line++) {
    const rows = PAYLINES[line];
    const anchor = grid[rows[0] * 5 + 0];
    let ref = anchor;
    if (ref === 8) {
      for (let r = 1; r < 5; r++) {
        const s = grid[rows[r] * 5 + r];
        if (s !== 8 && s !== 9) { ref = s; break; }
      }
      if (ref === 8) ref = 7;
    }
    if (ref === 9) continue;
    let run = 0;
    for (let r = 0; r < 5; r++) {
      const s = grid[rows[r] * 5 + r];
      if (s === ref || s === 8) run++; else break;
    }
    if (run >= 3) {
      for (let r = 0; r < run; r++) {
        const idx = rows[r] * 5 + r;
        const cell = host.children[idx];
        if (cell) cell.style.background = "rgba(139, 92, 246, 0.20)";
      }
    }
  }
}

function spinAnim(start) {
  const host = $("[data-sl-slots-grid]");
  if (!host) return;
  if (!start) {
    [...host.children].forEach((c) => { c.style.animation = ""; });
    return;
  }
  // Sequential per-reel stop: reel 0 spins 1.0s, reel 1 1.5s, … reel 4 3.0s.
  // We achieve this by giving each cell a CSS shake whose duration matches
  // its reel column; the cell visibly "settles" when its animation ends.
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 5; c++) {
      const idx = r * 5 + c;
      const cell = host.children[idx];
      if (!cell) continue;
      const dur = 1.0 + c * 0.5;          // 1.0s … 3.0s per reel column
      cell.style.animation = `dice-shake 0.18s linear ${dur}s forwards,
                              dice-shake 0.18s linear infinite`;
      // After `dur` seconds, swap the symbol to its final value (handled
      // in onSettle via drawGrid). Until then, keep cycling random faces:
      cell.dataset.spinUntil = String(Date.now() + dur * 1000);
    }
  }
  // Cycle random symbols while the reel is still spinning. ~70ms ticker.
  const ticker = setInterval(() => {
    let stillSpinning = false;
    for (const cell of host.children) {
      const until = Number(cell.dataset.spinUntil || 0);
      if (Date.now() < until) {
        stillSpinning = true;
        const rnd = Math.floor(Math.random() * 8); // any non-WILD, non-SCATTER
        cell.textContent = SYMBOLS[rnd] || "?";
      }
    }
    if (!stillSpinning) clearInterval(ticker);
  }, 70);
  spinAnim._ticker = ticker;
}

async function refreshRecent() {
  return refreshRecentEvents({
    containerSelector: "[data-sl-slots-recent]",
    gameId: SLOTS,
    decode: (ev) => {
      const { lineMult } = decodeSlots(ev.args.resultData);
      const label = lineMult > 0 ? (lineMult / 100).toFixed(2) + "×" : "—";
      return { label, won: ev.args.won };
    },
    emptyLabel: "no recent spins",
    latestBetId: lastBetId,
  });
}

async function onPlaceBet() {
  const placeBtn = $("[data-sl-place]");
  if (!placeBtn) return;
  placeBtn.dataset.locked = "1";
  try {
    setStagePill("live", "CONNECTING");
    placeBtn.textContent = "Connecting…"; placeBtn.disabled = true;
    await connect();

    const stake = readStakeStr() || "0.05";
    const stakeErr = validateStake(stake); if (stakeErr) throw new Error(stakeErr);
    setStagePill("live", "PLACING BET");
    placeBtn.textContent = "Placing bet…";
    clearResultBanner(); clearFairServer();

    const { betId, txHash, clientSeed } = await SL.placeSlots(stake);
    lastBetId = betId;
    populateFairPanel({ clientSeed, betId, nonce: betId, serverSeed: ethers.ZeroHash, txHash });

    setStagePill("live", "SPINNING");
    placeBtn.textContent = "Spinning…";
    spinAnim(true);

    const settled = await pollForSettle(betId);
    spinAnim(false);

    if (!settled) { setStagePill(null, "TIMED OUT"); placeBtn.textContent = "Timed out"; return; }
    if (settled.refunded) {
      setStagePill(null, "REFUNDED");
      setResultBanner({ won: false, txt: `<b>REFUNDED</b> · ${settled.args.reason}`, accent: "#facc15" });
      return;
    }
    const decoded = decodeSlots(settled.args.resultData);
    drawGrid(decoded.grid, { scattersHighlight: decoded.scatterBonus > 0 });
    setTimeout(() => highlightPaylines(decoded.grid), 100);

    populateFairPanel({
      clientSeed: settled.args.clientSeed,
      betId: settled.args.betId, nonce: settled.args.nonce,
      serverSeed: settled.args.serverSeed, txHash: settled.transactionHash,
    });
    setStagePill(settled.args.won ? "won" : "lost", settled.args.won ? "WON" : "MISS");
    const stakeWei = ethers.parseEther(stake);
    if (settled.args.won) {
      const profit = BigInt(settled.args.payout) - stakeWei;
      const mult = Number((BigInt(settled.args.payout) * 100n) / stakeWei) / 100;
      const scatterLabel = decoded.scatterBonus > 0 ? ` · SCATTER BONUS +${decoded.scatterBonus / 100}×` : "";
      setResultBanner({
        won: true,
        txt: `<b>WON</b> ${mult.toFixed(2)}× · + ${fmtSTT(profit)} STT${scatterLabel}`,
        txHash: settled.transactionHash,
      });
    } else {
      setResultBanner({ won: false, txt: `<b>MISS</b> · − ${fmtSTT(stakeWei)} STT`, txHash: settled.transactionHash });
    }
    refreshRecent();
  } catch (e) {
    spinAnim(false);
    setStagePill(null, "ERROR");
    const msg = friendlyError(e);
    placeBtn.textContent = "Error: " + msg;
    setResultBanner({ won: false, txt: `<b>FAILED</b> · ${msg}`, accent: "#facc15" });
    console.error("[slots] place failed:", e);
  } finally {
    setTimeout(() => { delete placeBtn.dataset.locked; placeBtn.disabled = false; recalcSummary(); }, 1500);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  injectKeyframes();
  drawGrid(null);
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

  recalcSummary();
  setStagePill("ready", "READY");
  tryFetchTheme();
  refreshRecent().catch((e) => console.warn("[slots] recent:", e.message));
  document.addEventListener("shinyluck:connected", () => {
    refreshFairFromPlayer(SLOTS).catch((e) => console.warn("[slots] fair:", e.message));
  });
  setInterval(() => refreshRecent().catch(() => {}), 12_000);
});
