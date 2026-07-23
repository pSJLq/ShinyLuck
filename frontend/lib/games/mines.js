// Mines integration on top of _base.js — HIDDEN-LAYOUT v14.
//
// The mine layout is never on-chain and never sent to the client during play
// (the old flow leaked the whole board via MinesSeedRevealed → anyone could
// read it and never bust). Flow now:
//   1. placeMinesBet(mineCount, clientSeed)
//   2. coordinator commits the layout's Merkle ROOT (minesState.layoutRoot set)
//   3. player PICKS a cell → pickMinesCell(idx)  [cheap on-chain intent]
//   4. coordinator resolves it → MinesCellOpened (safe) or MinesBust (mine)
//   5. cash out any time → MinesCashout
// The board stays hidden: only picked cells reveal, and the full layout only
// appears at finalize (MinesLayout) for provably-fair verification.

import { ethers } from "/vendor/ethers.bundle.js";
import { SL, connect } from "../wallet.js";
import {
  $, $$, setText, fmtSTTfromString, readStakeStr, injectKeyframes,
  setStagePill, setResultBanner, clearResultBanner, clearFairServer,
  populateFairPanel, refreshFairFromPlayer, refreshRecentEvents,
  fmtSTT, casinoRO, SETTLE_POLL_MS, SETTLE_TIMEOUT_MS,
  friendlyError, refreshEV,
} from "./_base.js";
import { validateStake } from "../errors.js";
import { clampStakeStr, applyMaxToInput } from "../casino-limits.js";

const MINES = 3;
const TOTAL_CELLS = 25;

let activeBetId = null;
let activeStakeWei = 0n;
let mineCount = 5;
let openedBitmap = 0n;
let cellsOpened = 0;
// One pick may be in flight at a time (the contract enforces this too).
let cellPending = false;

// Single source of truth for the two action buttons. During an active round
// ONLY the cashout button shows (disabled until ≥1 cell is open); with no
// active round ONLY the start button shows. This replaced scattered
// display-toggles that could leave the cashout hidden or the start button
// wedged (the "no cashout button / start does nothing" report).
function renderButtons() {
  const placeBtn = $("[data-sl-place]");
  const cashoutBtn = $("[data-sl-cashout]");
  const active = activeBetId !== null;
  if (placeBtn) {
    placeBtn.style.display = active ? "none" : "block";
    if (!active) {
      placeBtn.disabled = false;
      delete placeBtn.dataset.locked;      // never leave it wedged between rounds
      if (placeBtn.textContent === "Arming mines…" || placeBtn.textContent === "round in progress") placeBtn.textContent = "Start round";
    }
  }
  if (cashoutBtn) {
    cashoutBtn.style.display = active ? "block" : "none";
    if (cashoutBtn.dataset.refund === "1") { cashoutBtn.disabled = false; cashoutBtn.textContent = "Cancel & refund"; return; }
    const canCash = active && cellsOpened > 0 && !cellPending;
    cashoutBtn.disabled = !canCash;
    cashoutBtn.textContent = cellsOpened > 0 ? `Cash out · ${cellsOpened} open` : "Pick a cell…";
  }
}

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
    placeBtn.textContent = `Start round · ${fmtSTTfromString(stake)} STT`;
  }
  setText("[data-sl-minecount-display]", String(mineCount));
  refreshEV(MINES).catch(() => {});
}

function predictNextMultX100(k) {
  // Closed-form mirror of Casino._minesMultiplierX100 (edge 120 bps; 60 in
  // bonus mode — we assume 120 for the preview).
  const edge = 120;
  let num = 1n, den = 1n;
  for (let i = 0; i < k; i++) {
    num *= BigInt(25 - i);
    den *= BigInt(25 - mineCount - i);
  }
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

// Poll minesState until the coordinator commits the layout root (was
// seedRevealed in v1). Short-circuits on a refund.
async function waitForRootCommit(betId) {
  const c = casinoRO();
  const start = Date.now();
  while (Date.now() - start < SETTLE_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
    try {
      const ms = await c.minesState(betId);
      if (ms.layoutRoot && ms.layoutRoot !== ethers.ZeroHash) return { ok: true };
    } catch (e) { console.warn("[mines] minesState read:", e.message); }
    try {
      const b = await c.getBet(betId);
      if (Number(b.status) === 2) return { refunded: true };
    } catch (_) {}
  }
  return null;
}

async function onPlaceBet() {
  const placeBtn = $("[data-sl-place]");
  if (!placeBtn) return;
  if (placeBtn.dataset.locked === "1") return;
  // Never get wedged: if a previous round is still "active" locally (a pick
  // that never resolved, an abandoned board), starting a new round drops it.
  // Its stake is recoverable on-chain (cashout/cancel) independently.
  if (activeBetId !== null) { activeBetId = null; cellPending = false; }
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

  clearResultBanner(); clearFairServer(); clearGrid();
  cellsOpened = 0; openedBitmap = 0n;
  setStagePill("live", "ARMING");
  placeBtn.textContent = "Arming mines…";
  placeBtn.disabled = true;
  setMinesStatus(`arming ${mineCount} mines…`);

  try {
    await connect();
    const finalStake = await clampStakeStr(stake, "mines");
    if (finalStake == null) {
      setStagePill("ready", "READY");
      placeBtn.textContent = "Place bet";
      placeBtn.disabled = false;
      delete placeBtn.dataset.locked;
      setMinesStatus("waiting for stake");
      return;
    }
    const { betId, txHash, clientSeed } = await SL.placeMines(mineCount, finalStake);
    activeBetId = betId;
    activeStakeWei = ethers.parseEther(finalStake);
    populateFairPanel({ clientSeed, betId, nonce: betId, serverSeed: ethers.ZeroHash, txHash });

    const committed = await waitForRootCommit(betId);
    if (!committed) {
      setStagePill(null, "TIMED OUT");
      placeBtn.textContent = "Refresh to retry";
      activeBetId = null;
      return;
    }
    if (committed.refunded) {
      setStagePill(null, "REFUNDED");
      setResultBanner({ won: false, txt: `<b>REFUNDED</b> · stake returned`, accent: "#facc15" });
      activeBetId = null;
      renderButtons();
      return;
    }
    setStagePill("live", "ROUND ACTIVE");
    setMinesStatus(`${mineCount} mines hidden · pick a cell`);
    renderButtons();
    updateLiveMultiplier();
  } catch (e) {
    const msg = friendlyError(e);
    if (/rejected|user cancelled/i.test(msg)) {
      setStagePill("ready", "READY");
      setMinesStatus("");
    } else {
      setStagePill(null, "ERROR");
      setMinesStatus(msg);
      setResultBanner({ won: false, txt: `<b>FAILED</b> · ${msg}`, accent: "#facc15" });
      console.error("[mines] place failed:", e);
    }
    activeBetId = null;
  } finally {
    delete placeBtn.dataset.locked;
    renderButtons();
  }
}

function endRoundUI() {
  activeBetId = null;
  cellPending = false;
  const cashoutBtn = $("[data-sl-cashout]");
  if (cashoutBtn) delete cashoutBtn.dataset.refund;
  renderButtons();
  refreshRecent();
}

// After a bust, reveal the rest of the board once the coordinator finalizes
// (MinesLayout carries the full bitmap). Best-effort, non-blocking.
async function revealFullLayout(betId, clickedIdx) {
  const c = casinoRO();
  const start = Date.now();
  while (Date.now() - start < 12_000) {
    try {
      const logs = await c.queryFilter(c.filters.MinesLayout(betId), -5000);
      if (logs.length) {
        const bm = BigInt(logs[logs.length - 1].args.minesBitmap);
        for (let i = 0; i < TOTAL_CELLS; i++) if (bm & (1n << BigInt(i)) && i !== clickedIdx) showCell(i, "bomb", false);
        return;
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 1200));
  }
}

// Wait for the coordinator to resolve the pending pick. Returns
// { safe, multX100 } | { bust } | { timeout }.
async function waitForResolve(betId, idx) {
  const c = casinoRO();
  const start = Date.now();
  while (Date.now() - start < 25_000) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const ms = await c.minesState(betId);
      if (ms.busted) return { bust: true };
      const mask = 1n << BigInt(idx);
      if (BigInt(ms.openedBitmap) & mask) {
        const k = (() => { let n = 0, x = BigInt(ms.openedBitmap); while (x > 0n) { if (x & 1n) n++; x >>= 1n; } return n; })();
        return { safe: true, opened: k };
      }
      // pendingCell cleared but neither opened nor busted → bet settled/refunded
      if (Number(ms.pendingCell) === 0) {
        const b = await c.getBet(betId);
        if (Number(b.status) !== 0) return { bust: ms.busted };
      }
    } catch (e) { console.warn("[mines] resolve poll:", e.message); }
  }
  return { timeout: true };
}

async function onCellClick(ev) {
  if (activeBetId === null || cellPending) return; // one pick at a time
  const cell = ev.currentTarget;
  const betId = activeBetId;
  const idx = parseInt(cell.dataset.idx, 10);
  const mask = 1n << BigInt(idx);
  if (openedBitmap & mask) return;

  cellPending = true;
  cell.disabled = true;
  setMinesStatus(`opening cell ${idx}…`);
  renderButtons(); // cashout disabled while a pick is resolving
  try {
    // 1) commit the pick on-chain (cheap, proof-less)
    await SL.pickMines(betId, idx);
    // 2) coordinator resolves it; poll for the outcome
    const res = await waitForResolve(betId, idx);
    if (res.bust) {
      showCell(idx, "bomb");
      const board = document.querySelector("#mines-board");
      if (board) { board.classList.remove("mines-anim-shake"); void board.offsetWidth; board.classList.add("mines-anim-shake"); }
      setStagePill("lost", "BUSTED");
      setMinesStatus(`bet #${betId} · BUSTED at cell ${idx}`);
      setResultBanner({ won: false, txt: `<b>BUSTED</b> at cell ${idx} · − ${fmtSTT(activeStakeWei)} STT` });
      cellPending = false;
      endRoundUI();
      revealFullLayout(betId, idx).catch(() => {});
      return;
    } else if (res.safe) {
      showCell(idx, "safe");
      openedBitmap |= mask;
      cellsOpened = res.opened;
      const x100 = predictNextMultX100(cellsOpened);
      setText("[data-sl-mines-mult]", (Number(x100) / 100).toFixed(2) + "×");
      setText("[data-sl-mines-opened]", String(cellsOpened));
      setText("[data-sl-mines-cashout-amount]", fmtSTT((activeStakeWei * x100) / 100n) + " STT");
      setMinesStatus(`${cellsOpened} open · pick another or cash out`);
    } else {
      // coordinator stalled — offer the refund path on the cashout button
      cell.disabled = false;
      setMinesStatus(`no response · you can cancel for a refund`);
      const cashoutBtn = $("[data-sl-cashout]");
      if (cashoutBtn) cashoutBtn.dataset.refund = "1";
    }
  } catch (e) {
    cell.disabled = false;
    console.error("[mines] pick:", e);
    setMinesStatus(`pick failed: ${friendlyError(e)}`);
  } finally {
    cellPending = false;
    renderButtons();
  }
}

async function onCashout() {
  if (activeBetId === null) return;
  const cashoutBtn = $("[data-sl-cashout]");
  // If a pick stalled, this button became "Cancel & refund".
  if (cashoutBtn && cashoutBtn.dataset.refund === "1") {
    cashoutBtn.disabled = true;
    try {
      await SL.cancelMinesPick(activeBetId);
      setStagePill(null, "REFUNDED");
      setResultBanner({ won: false, txt: `<b>REFUNDED</b> · stake returned`, accent: "#facc15" });
    } catch (e) {
      setMinesStatus(`refund not ready yet: ${friendlyError(e)}`);
      cashoutBtn.disabled = false;
      return;
    }
    delete cashoutBtn.dataset.refund;
    endRoundUI();
    return;
  }
  if (cellsOpened === 0) { import("../ui.js").then(({ toast }) => toast("Open at least one cell first", { kind: "warn" })); return; }
  cashoutBtn.disabled = true;
  cashoutBtn.textContent = "Cashing out…";
  try {
    const tx = await SL.casino.cashoutMines(activeBetId);
    const r = await tx.wait();
    const events = (r.logs || []).map((l) => { try { return SL.casino.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
    const cash = events.find((p) => p.name === "MinesCashout");
    setStagePill("won", "CASHED OUT");
    const payout = cash ? BigInt(cash.args.payout) : 0n;
    const profit = payout - activeStakeWei;
    setMinesStatus(`bet #${activeBetId} · cashed out @ ${(Number(cash?.args.multiplierX100 || 0n) / 100).toFixed(2)}×`);
    setResultBanner({ won: true, txt: `<b>CASHED OUT</b> · + ${fmtSTT(profit)} STT`, txHash: tx.hash });
    endRoundUI();
  } catch (e) {
    console.error("[mines] cashout:", e);
    setMinesStatus(`cashout failed: ${friendlyError(e)}`);
    renderButtons();
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
  // After a refresh, resume a mines round that's mid-flight (root committed,
  // not busted, still pending). The layout stays hidden — we only know which
  // cells were already opened (openedBitmap).
  if (!SL.address || activeBetId !== null) return;
  try {
    const ids = await SL.casino.getPlayerBets(SL.address);
    const tail = Array.from(ids).slice(-10).reverse();
    for (const idStr of tail) {
      const id = BigInt(idStr);
      const b = await SL.casino.getBet(id);
      if (Number(b.game) !== MINES) continue;
      if (Number(b.status) !== 0) continue;
      const ms = await SL.casino.minesState(id);
      if (!ms.layoutRoot || ms.layoutRoot === ethers.ZeroHash || ms.busted) continue;
      activeBetId = id;
      activeStakeWei = BigInt(b.amount);
      mineCount = Number(ms.mineCount);
      openedBitmap = BigInt(ms.openedBitmap);
      cellsOpened = 0;
      for (let i = 0; i < TOTAL_CELLS; i++) {
        if (openedBitmap & (1n << BigInt(i))) { showCell(i, "safe", false); cellsOpened++; }
      }
      setStagePill("live", "ROUND ACTIVE");
      updateLiveMultiplier();
      populateFairPanel({ clientSeed: b.clientSeed, betId: id, nonce: id, serverSeed: ethers.ZeroHash });
      // A pick left pending across a reload: wait for the coordinator to
      // resolve it (its sweep will), and if it never does, offer cancel-refund
      // so the player is never trapped on a stuck bet.
      if (Number(ms.pendingCell) !== 0) {
        const idx = Number(ms.pendingCell) - 1;
        setMinesStatus(`resuming bet #${id} · finishing your pick on cell ${idx}…`);
        cellPending = true; renderButtons();
        waitForResolve(id, idx).then((res) => {
          cellPending = false;
          if (res.bust) { showCell(idx, "bomb"); setStagePill("lost", "BUSTED"); setMinesStatus(`bet #${id} · BUSTED`); endRoundUI(); revealFullLayout(id, idx).catch(() => {}); }
          else if (res.safe) { showCell(idx, "safe"); openedBitmap |= 1n << BigInt(idx); cellsOpened = res.opened; updateLiveMultiplier(); setMinesStatus(`${cellsOpened} open · pick another or cash out`); renderButtons(); }
          else { const cb = $("[data-sl-cashout]"); if (cb) cb.dataset.refund = "1"; setMinesStatus(`pick didn't resolve · you can cancel for a refund`); renderButtons(); }
        });
      } else {
        setMinesStatus(`resumed bet #${id} · ${cellsOpened} cells open · pick another or cashout`);
        renderButtons();
      }
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
    applyMaxToInput(stakeEl, "mines").catch(() => {});
    setInterval(() => applyMaxToInput(stakeEl, "mines").catch(() => {}), 10_000);
  }
  $$(".preset[onclick]").forEach((btn) => {
    const oldHandler = btn.onclick;
    btn.onclick = function (...args) { if (oldHandler) oldHandler.apply(this, args); recalcSummary(); };
  });
  $("[data-sl-place]")?.addEventListener("click", onPlaceBet);
  $("[data-sl-cashout]")?.addEventListener("click", onCashout);
  $$("[data-sl-cell]").forEach((cell) => cell.addEventListener("click", onCellClick));

  recalcSummary();
  renderButtons();
  setStagePill("ready", "READY");
  refreshRecent().catch((e) => console.warn("[mines] recent:", e.message));
  document.addEventListener("shinyluck:connected", () => {
    refreshFairFromPlayer(MINES).catch((e) => console.warn("[mines] fair:", e.message));
    tryRestoreActiveRound().catch((e) => console.warn("[mines] restore:", e.message));
  });
  setInterval(() => refreshRecent().catch(() => {}), 12_000);
});
