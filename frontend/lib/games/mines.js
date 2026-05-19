// Mines integration on top of _base.js.
//
// Multi-step game flow:
//   1. placeMinesBet(mineCount, clientSeed)
//   2. Wait for reveal-bot to call revealMinesSeed(betId)
//      → MinesSeedRevealed event fires with the full minesBitmap
//   3. Player clicks cells one by one:
//      - safe → MinesCellOpened event with new multiplierX100
//      - mine → MinesBust event, game over
//   4. Cashout at any time → MinesCashout event with payout.

import { ethers } from "https://esm.sh/ethers@6.13.2";
import { SL, connect } from "../wallet.js";
import {
  $, $$, setText, fmtSTTfromString, readStakeStr, injectKeyframes,
  setStagePill, setResultBanner, clearResultBanner, clearFairServer,
  populateFairPanel, refreshFairFromPlayer, refreshRecentEvents,
  pollForSettle, fmtSTT, casinoRO, SETTLE_POLL_MS, SETTLE_TIMEOUT_MS,
  friendlyError, refreshEV,
} from "./_base.js";
import { validateStake } from "../errors.js";
import { provider, fetchRecentLogs } from "../rpc.js";

const MINES = 3;
const TOTAL_CELLS = 25;

let activeBetId = null;
let activeStakeWei = 0n;
let mineCount = 5;
let minesBitmap = 0n;
let openedBitmap = 0n;
let cellsOpened = 0;

function clearGrid() {
  $$("[data-sl-cell]").forEach((el) => {
    el.textContent = "";
    el.classList.remove("safe", "revealed", "bomb", "open");
    el.style.background = "";
    el.disabled = false;
  });
}
function showCell(idx, kind, animate = true) {
  const el = document.querySelector(`[data-sl-cell][data-idx="${idx}"]`);
  if (!el) return;
  el.classList.add(kind, "revealed");
  if (kind === "safe") { el.textContent = "✓"; el.style.background = "rgba(34, 211, 238, 0.18)"; }
  else if (kind === "bomb") { el.textContent = "💣"; el.style.background = "rgba(220, 38, 38, 0.18)"; }
  el.disabled = true;
  if (animate) {
    const cls = kind === "bomb" ? "tile-anim-bomb" : "tile-anim-safe";
    el.classList.remove(cls);
    void el.offsetWidth; // force reflow so the animation restarts
    el.classList.add(cls);
  }
}

function recalcSummary() {
  const mcEl = $("[data-sl-minecount]");
  if (mcEl) mineCount = parseInt(mcEl.value, 10) || 5;
  const stake = readStakeStr();
  const placeBtn = $("[data-sl-place]");
  if (placeBtn && !placeBtn.dataset.locked && activeBetId === null) {
    placeBtn.textContent = `Start round — ${fmtSTTfromString(stake)} STT`;
  }
  setText("[data-sl-minecount-display]", String(mineCount));
  refreshEV(MINES).catch(() => {});
}

function predictNextMultX100(k) {
  // Closed-form mirror of Casino._minesMultiplierX100. House edge bps = 120
  // (or 60 if bonus). We assume 120 here as an approximation.
  const edge = 120;
  let num = 1n, den = 1n;
  for (let i = 0; i < k; i++) {
    num *= BigInt(25 - i);
    den *= BigInt(25 - mineCount - i);
  }
  // multX100 = (num * (10000-edge) * 100) / (den * 10000)
  const multX100 = (num * BigInt(10000 - edge) * 100n) / (den * 10000n);
  return multX100 < 100n ? 100n : (multX100 > 10000n ? 10000n : multX100);
}

function updateLiveMultiplier() {
  const x100 = predictNextMultX100(cellsOpened);
  const mult = Number(x100) / 100;
  setText("[data-sl-mines-mult]", mult.toFixed(2) + "×");
  setText("[data-sl-mines-opened]", String(cellsOpened));
  if (activeStakeWei > 0n) {
    const cashout = (activeStakeWei * x100) / 100n;
    setText("[data-sl-mines-cashout-amount]", fmtSTT(cashout) + " STT");
  }
}

function setMinesStatus(text) { setText("[data-sl-mines-status]", text); }

async function waitForSeedReveal(betId) {
  // Poll minesState until seedRevealed === true; also short-circuit on
  // MinesSeedRevealed events or BetRefunded.
  const c = casinoRO();
  const start = Date.now();
  while (Date.now() - start < SETTLE_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
    try {
      const ms = await c.minesState(betId);
      if (ms.seedRevealed) return { bitmap: BigInt(ms.minesBitmap) };
    } catch (e) {
      console.warn("[mines] minesState read:", e.message);
    }
    try {
      const refunds = await fetchRecentLogs(c, "BetRefunded", {
        minCount: 1,
        maxLookback: 1000,
        filter: (ev) => ev.args.betId.toString() === betId.toString(),
      });
      if (refunds.length > 0) return { refunded: true, args: refunds[0].args, transactionHash: refunds[0].transactionHash };
    } catch (_) {}
  }
  return null;
}

async function onPlaceBet() {
  const placeBtn = $("[data-sl-place]");
  const cashoutBtn = $("[data-sl-cashout]");
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
  if (mineCount < 1 || mineCount > 24) {
    const { toast } = await import("../ui.js");
    toast("Mines count must be 1..24", { kind: "warn" });
    delete placeBtn.dataset.locked;
    return;
  }

  // INSTANT UX: clear the board and start a subtle "arming" animation
  // immediately. Chain placement + seed reveal happen silently behind the
  // UI; once the seed lands, the cells become tappable. No "Connecting" /
  // "Placing bet…" / "Awaiting reveal…" spam.
  clearResultBanner(); clearFairServer(); clearGrid();
  cellsOpened = 0; openedBitmap = 0n;
  setStagePill("live", "ARMING");
  placeBtn.textContent = "Arming mines…";
  placeBtn.disabled = true;
  setMinesStatus(`arming ${mineCount} mines…`);

  try {
    await connect();
    const { betId, txHash, clientSeed } = await SL.placeMines(mineCount, stake);
    activeBetId = betId;
    activeStakeWei = ethers.parseEther(stake);
    populateFairPanel({ clientSeed, betId, nonce: betId, serverSeed: ethers.ZeroHash, txHash });

    const revealed = await waitForSeedReveal(betId);
    if (!revealed) {
      setStagePill(null, "TIMED OUT");
      placeBtn.textContent = "Refresh to retry";
      activeBetId = null;
      return;
    }
    if (revealed.refunded) {
      setStagePill(null, "REFUNDED");
      setResultBanner({ won: false, txt: `<b>REFUNDED</b> · ${revealed.args.reason}`, accent: "#facc15" });
      activeBetId = null;
      return;
    }
    minesBitmap = revealed.bitmap;
    setStagePill("live", "ROUND ACTIVE");
    setMinesStatus(`${mineCount} mines locked · pick a cell`);
    placeBtn.textContent = "round in progress";
    if (cashoutBtn) cashoutBtn.style.display = "block";
    updateLiveMultiplier();
  } catch (e) {
    const msg = friendlyError(e);
    if (/rejected|user cancelled/i.test(msg)) {
      setStagePill("ready", "READY");
      setMinesStatus("");
      placeBtn.textContent = "Start round";
      placeBtn.disabled = false;
    } else {
      setStagePill(null, "ERROR");
      setMinesStatus(msg);
      setResultBanner({ won: false, txt: `<b>FAILED</b> · ${msg}`, accent: "#facc15" });
      console.error("[mines] place failed:", e);
    }
    activeBetId = null;
  } finally {
    delete placeBtn.dataset.locked;
  }
}

async function onCellClick(ev) {
  if (activeBetId === null) return;
  const idx = parseInt(ev.currentTarget.dataset.idx, 10);
  const mask = 1n << BigInt(idx);
  if (openedBitmap & mask) return; // already opened locally

  // optimistic: gray out
  ev.currentTarget.disabled = true;
  try {
    const tx = await SL.casino.openMinesCell(activeBetId, idx);
    const r = await tx.wait();
    const events = (r.logs || []).map((l) => { try { return SL.casino.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
    const bust = events.find((p) => p.name === "MinesBust");
    const opened = events.find((p) => p.name === "MinesCellOpened");
    if (bust) {
      // shake the board, then reveal every mine.
      const board = document.querySelector("#mines-board");
      if (board) {
        board.classList.remove("mines-anim-shake");
        void board.offsetWidth;
        board.classList.add("mines-anim-shake");
      }
      for (let i = 0; i < TOTAL_CELLS; i++) {
        const m = 1n << BigInt(i);
        if (minesBitmap & m) showCell(i, "bomb");
      }
      setStagePill("lost", "BUSTED");
      setMinesStatus(`bet #${activeBetId} · BUSTED at cell ${idx}`);
      setResultBanner({ won: false, txt: `<b>BUSTED</b> at cell ${idx} · − ${fmtSTT(activeStakeWei)} STT`, txHash: tx.hash });
      // grab settled event for fair-panel server-seed
      const settled = events.find((p) => p.name === "BetSettled");
      if (settled) populateFairPanel({
        clientSeed: settled.args.clientSeed,
        betId: settled.args.betId, nonce: settled.args.nonce,
        serverSeed: settled.args.serverSeed, txHash: tx.hash,
      });
      activeBetId = null;
      const cashoutBtn = $("[data-sl-cashout]");
      if (cashoutBtn) cashoutBtn.style.display = "none";
      const placeBtn = $("[data-sl-place]");
      placeBtn.disabled = false;
      placeBtn.textContent = "Start new round";
      refreshRecent();
      return;
    }
    if (opened) {
      showCell(idx, "safe");
      openedBitmap |= mask;
      cellsOpened++;
      const multX100 = Number(opened.args.multiplierX100);
      setText("[data-sl-mines-mult]", (multX100 / 100).toFixed(2) + "×");
      setText("[data-sl-mines-opened]", String(cellsOpened));
      const cashout = (activeStakeWei * BigInt(multX100)) / 100n;
      setText("[data-sl-mines-cashout-amount]", fmtSTT(cashout) + " STT");
    }
  } catch (e) {
    ev.currentTarget.disabled = false;
    console.error("[mines] open cell:", e);
    setMinesStatus(`open cell failed: ${friendlyError(e)}`);
  }
}

async function onCashout() {
  if (activeBetId === null) return;
  if (cellsOpened === 0) { import("../ui.js").then(({ toast }) => toast("Open at least one cell first", { kind: "warn" })); return; }
  const cashoutBtn = $("[data-sl-cashout]");
  cashoutBtn.disabled = true;
  cashoutBtn.textContent = "Cashing out…";
  try {
    const tx = await SL.casino.cashoutMines(activeBetId);
    const r = await tx.wait();
    const events = (r.logs || []).map((l) => { try { return SL.casino.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
    const cash = events.find((p) => p.name === "MinesCashout");
    const settled = events.find((p) => p.name === "BetSettled");
    setStagePill("won", "CASHED OUT");
    const payout = cash ? BigInt(cash.args.payout) : 0n;
    const profit = payout - activeStakeWei;
    setMinesStatus(`bet #${activeBetId} · cashed out @ ${(Number(cash?.args.multiplierX100 || 0n) / 100).toFixed(2)}×`);
    setResultBanner({ won: true, txt: `<b>CASHED OUT</b> · + ${fmtSTT(profit)} STT`, txHash: tx.hash });
    if (settled) populateFairPanel({
      clientSeed: settled.args.clientSeed,
      betId: settled.args.betId, nonce: settled.args.nonce,
      serverSeed: settled.args.serverSeed, txHash: tx.hash,
    });
    activeBetId = null;
    cashoutBtn.style.display = "none";
    cashoutBtn.disabled = false;
    cashoutBtn.textContent = "Cash out";
    const placeBtn = $("[data-sl-place]");
    placeBtn.disabled = false;
    placeBtn.textContent = "Start new round";
    refreshRecent();
  } catch (e) {
    cashoutBtn.disabled = false;
    cashoutBtn.textContent = "Cash out";
    console.error("[mines] cashout:", e);
    setMinesStatus(`cashout failed: ${friendlyError(e)}`);
  }
}

async function refreshRecent() {
  return refreshRecentEvents({
    containerSelector: "[data-sl-mines-recent]",
    gameId: MINES,
    decode: (ev) => {
      const stake = ev.args.payout > 0n && ev.args.won
        ? "+" + fmtSTT(BigInt(ev.args.payout)) + " STT"
        : (ev.args.won ? "WIN" : "BUST");
      return { label: stake, won: ev.args.won };
    },
    emptyLabel: "no recent rounds",
  });
}

async function tryRestoreActiveRound() {
  // After a page refresh, walk the player's last few bets and resume any
  // mines round that is mid-flight (seedRevealed && !busted && status==0).
  if (!SL.address || activeBetId !== null) return;
  try {
    const ids = await SL.casino.getPlayerBets(SL.address);
    const tail = ids.slice(-10).reverse();
    for (const idStr of tail) {
      const id = BigInt(idStr);
      const b = await SL.casino.getBet(id);
      if (Number(b.game) !== MINES) continue;
      if (Number(b.status) !== 0) continue;
      const ms = await SL.casino.minesState(id);
      if (!ms.seedRevealed || ms.busted) continue;
      // Resume: rebuild local state from bitmaps
      activeBetId = id;
      activeStakeWei = BigInt(b.amount);
      mineCount = Number(ms.mineCount);
      minesBitmap = BigInt(ms.minesBitmap);
      openedBitmap = BigInt(ms.openedBitmap);
      cellsOpened = 0;
      for (let i = 0; i < TOTAL_CELLS; i++) {
        if (openedBitmap & (1n << BigInt(i))) {
          showCell(i, "safe");
          cellsOpened++;
        }
      }
      setStagePill("live", "ROUND ACTIVE");
      setMinesStatus(`resumed bet #${id} · ${cellsOpened} cells open · pick another or cashout`);
      const placeBtn = $("[data-sl-place]");
      if (placeBtn) { placeBtn.disabled = true; placeBtn.textContent = "round in progress"; }
      const cashoutBtn = $("[data-sl-cashout]");
      if (cashoutBtn) cashoutBtn.style.display = "block";
      updateLiveMultiplier();
      populateFairPanel({
        clientSeed: b.clientSeed, betId: id, nonce: id,
        serverSeed: b.randomness !== "0x0000000000000000000000000000000000000000000000000000000000000000"
          ? b.randomness : "0x0000000000000000000000000000000000000000000000000000000000000000",
      });
      return;
    }
  } catch (e) {
    console.warn("[mines] restore active:", e.message);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  injectKeyframes();
  const mc = $("[data-sl-minecount]");
  if (mc) {
    mineCount = parseInt(mc.value, 10) || 5;
    mc.addEventListener("input", () => { mineCount = parseInt(mc.value, 10) || 5; setText("[data-sl-minecount-display]", String(mineCount)); recalcSummary(); });
  }
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
  $("[data-sl-cashout]")?.addEventListener("click", onCashout);
  $$("[data-sl-cell]").forEach((cell) => cell.addEventListener("click", onCellClick));

  recalcSummary();
  setStagePill("ready", "READY");
  refreshRecent().catch((e) => console.warn("[mines] recent:", e.message));
  document.addEventListener("shinyluck:connected", () => {
    refreshFairFromPlayer(MINES).catch((e) => console.warn("[mines] fair:", e.message));
    tryRestoreActiveRound().catch((e) => console.warn("[mines] restore:", e.message));
  });
  setInterval(() => refreshRecent().catch(() => {}), 12_000);
});
