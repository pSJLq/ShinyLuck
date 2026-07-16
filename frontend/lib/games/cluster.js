// SUGAR.LAB · on-chain cluster-pays slot frontend.
//
// resultData (from Casino + ClusterLib):
//   abi.encode(uint8[49] finalGrid, uint256 totalPayoutX100,
//              uint8 scatterCount, uint8 cascadeDepth, bool isFreeSpin)
//
//   Symbol IDs:
//     0=L2, 1=L1, 2=M3, 3=M2, 4=M1, 5=H3, 6=H2, 7=H1, 8=WILD, 9=SCAT
//
// The contract does all the cascade math; this file is responsible for
// visualising "initial → final" with a quick tumble-style animation. A full
// per-cascade replay (each step animated) needs the contract randomness
// re-played in JS · that's a follow-up; for now the result lands with a
// satisfying tumble + cluster-highlight pass.

import { ethers } from "/vendor/ethers.bundle.js";
import { SL, connect } from "../wallet.js";
import { CONFIG } from "../config.js";
import { provider, fetchRecentLogs } from "../rpc.js";
import {
  $, $$, setText, populateFairPanel, clearFairServer, friendlyError,
  pollForSettle, fmtSTT,
} from "./_base.js";
import { validateStake } from "../errors.js";

const CLUSTER = 6;
const SIZE = 7;

const SYM = {
  0: { glyph: "◯", color: "#8fb3d0", kind: "low"  },  // L2
  1: { glyph: "✕", color: "#7f8aa5", kind: "low"  },  // L1
  2: { glyph: "◼", color: "#ff9a3c", kind: "mid"  },  // M3
  3: { glyph: "▲", color: "#4ade80", kind: "mid"  },  // M2
  4: { glyph: "●", color: "#ffc847", kind: "mid"  },  // M1
  5: { glyph: "⬡", color: "#b794ff", kind: "high" },  // H3
  6: { glyph: "◆", color: "#4ee3ff", kind: "high" },  // H2
  7: { glyph: "♥", color: "#ff5e8a", kind: "high" },  // H1
  8: { glyph: "✦", color: "#ffffff", kind: "wild" },  // WILD
  9: { glyph: "✺", color: "#ffc847", kind: "scat" },  // SCAT
};

const STAKE_PRESETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5];
let stakeIdx = 3;
let isSpinning = false;
let useFreeSpinNext = false;
let lastFreeSpinsAvailable = 0;
let autoRemaining = 0;
let totalWon = 0;

const fmt = (n) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------- grid render ----------

function buildGrid() {
  const root = $("#grid");
  root.innerHTML = "";
  root.style.cssText = "display:grid; grid-template-columns: repeat(7, 1fr); gap: 4px; padding: 12px; width: 100%;";
  for (let i = 0; i < 49; i++) {
    const cell = document.createElement("div");
    cell.dataset.idx = String(i);
    cell.style.cssText = "aspect-ratio: 1; display:flex; align-items:center; justify-content:center; font-size: 26px; font-weight: 800; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; transition: all 0.3s; position: relative;";
    // initial placeholder
    const placeholderSym = (i * 13 + 7) % 8;
    cell.textContent = SYM[placeholderSym].glyph;
    cell.style.color = SYM[placeholderSym].color;
    root.appendChild(cell);
  }
}

function setGrid(symbolIds, animate = false) {
  const root = $("#grid");
  for (let i = 0; i < 49; i++) {
    const cell = root.children[i];
    if (!cell) continue;
    const symId = Number(symbolIds[i]);
    const s = SYM[symId];
    if (!s) continue;
    cell.textContent = s.glyph;
    cell.style.color = s.color;
    cell.dataset.sym = symId;
    cell.classList.remove("winning");
    cell.style.background = "rgba(255,255,255,0.04)";
    cell.style.boxShadow = "";
    if (animate) {
      const delay = (Math.floor(i / 7) * 40) + (i % 7) * 20;
      cell.style.transform = "translateY(-12px) scale(0.92)";
      cell.style.opacity = "0";
      setTimeout(() => {
        cell.style.transition = "transform 0.35s cubic-bezier(.34, 1.56, .64, 1), opacity 0.35s";
        cell.style.transform = "translateY(0) scale(1)";
        cell.style.opacity = "1";
      }, delay);
    }
  }
}

/// Best-effort cluster highlight on the final grid. Replays the BFS used in
/// ClusterLib so the player sees which cells contributed to the payout.
function highlightClusters(symbolIds) {
  const ids = symbolIds.map(Number);
  const seen = new Array(49).fill(false);
  for (let i = 0; i < 49; i++) {
    if (seen[i]) continue;
    const sym = ids[i];
    if (sym === 9 || sym === 8 || sym >= 10) { seen[i] = true; continue; }
    const stack = [i];
    const cluster = [];
    seen[i] = true;
    while (stack.length) {
      const cur = stack.pop();
      cluster.push(cur);
      const row = Math.floor(cur / 7), col = cur % 7;
      const neighbours = [];
      if (row > 0) neighbours.push(cur - 7);
      if (row < 6) neighbours.push(cur + 7);
      if (col > 0) neighbours.push(cur - 1);
      if (col < 6) neighbours.push(cur + 1);
      for (const n of neighbours) {
        if (seen[n]) continue;
        if (ids[n] === sym || ids[n] === 8) { seen[n] = true; stack.push(n); }
      }
    }
    if (cluster.length >= 5) {
      const root = $("#grid");
      const color = SYM[sym].color;
      for (const idx of cluster) {
        const cell = root.children[idx];
        if (!cell) continue;
        cell.style.background = `${color}22`;
        cell.style.boxShadow = `0 0 16px ${color}66, inset 0 0 8px ${color}33`;
        cell.classList.add("winning");
      }
    }
  }
}

// ---------- on-chain ----------

let _casinoRO = null;
function casinoRO() {
  if (!_casinoRO) {
    const abi = [
      "function freeSpinsAvailable(address) view returns (uint256)",
      "function getPlayerSlotState(address) view returns (uint64 total,uint64 earned,uint64 used,uint256 toNext)",
      "function gameMaxBet(uint8) view returns (uint256)",
      "event BetSettled(uint256 indexed betId,address indexed player,uint8 indexed game,bool won,uint256 payout,bytes32 randomness,bytes32 serverSeed,bytes32 clientSeed,bytes32 blockHash,uint256 nonce,bytes resultData)",
    ];
    _casinoRO = new ethers.Contract(CONFIG.casino, abi, provider());
  }
  return _casinoRO;
}

async function refreshLoyalty() {
  if (!SL.address) {
    setText("#loyaltyRemain", "150"); setText("#loyaltyDisp", "0/150");
    $("#loyaltyBar").style.width = "0%";
    setText("#freeSpinsCount", "0");
    return;
  }
  try {
    const c = casinoRO();
    const [free, [tot, earned, used, toNext]] = await Promise.all([
      c.freeSpinsAvailable(SL.address),
      c.getPlayerSlotState(SL.address),
    ]);
    lastFreeSpinsAvailable = Number(free);
    setText("#freeSpinsCount", String(lastFreeSpinsAvailable));
    const totalSpins = Number(tot);
    const inWindow = totalSpins % 150;
    setText("#loyaltyDisp", `${inWindow}/150`);
    $("#loyaltyBar").style.width = ((inWindow / 150) * 100).toFixed(1) + "%";
    setText("#loyaltyRemain", String(Number(toNext)));
    $("#freeSpinsBadge").classList.toggle("show", lastFreeSpinsAvailable > 0);
    const fsBtn = $("#turboBtn");
    if (fsBtn) fsBtn.classList.toggle("active", lastFreeSpinsAvailable > 0);
  } catch (e) { console.warn("[cluster] loyalty:", e.message); }
}

async function refreshGameMeta() {
  try {
    const c = casinoRO();
    const maxBet = await c.gameMaxBet(CLUSTER);
    setText(`[data-sl="maxBet"][data-game="cluster"]`, fmtSTT(maxBet) + " STT");
  } catch (_) {}
}

async function refreshBalance() {
  if (!SL.address) { setText("#balance", "-"); return; }
  try {
    const bal = await provider().getBalance(SL.address);
    setText("#balance", fmtSTT(bal));
  } catch (_) {}
}

async function loadTicker() {
  const list = $("#tickerList");
  if (!list) return;
  try {
    const events = await fetchRecentLogs(casinoRO(), "BetSettled", {
      minCount: 12, maxLookback: 100_000,
      filter: (ev) => Number(ev.args.game) === CLUSTER && ev.args.won,
    });
    list.innerHTML = "";
    for (const ev of events.slice(0, 12)) {
      const addr = ev.args.player;
      const who = addr.slice(0, 6) + "…" + addr.slice(-4);
      const amount = Number(ethers.formatEther(ev.args.payout));
      const div = document.createElement("div");
      div.className = "ticker-row";
      div.innerHTML = `<div class="who">${who}<small>SUGAR.LAB</small></div>
                       <div class="amt">+${fmt(amount)}<small>STT</small></div>`;
      list.appendChild(div);
    }
  } catch (e) { console.warn("[cluster] ticker:", e.message); }
}

function buildPaytable() {
  const list = $("#paytableList");
  if (!list) return;
  const order = [
    [7,"H1","×20"],[6,"H2","×15"],[5,"H3","×12"],
    [4,"M1","×8"],[3,"M2","×7"],[2,"M3","×6"],
    [1,"L1","×3"],[0,"L2","×2"],
    [8,"WILD","×25"],
  ];
  list.innerHTML = "";
  for (const [id, name, pay] of order) {
    const s = SYM[id];
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div class="gly" style="color:${s.color}">${s.glyph}</div>
      <div class="info"><div class="nm">${name}</div><div class="px">${pay} <span style="color:var(--ink-3)">15+ cluster</span></div></div>`;
    list.appendChild(row);
  }
}

// ---------- spin ----------

function decodeResult(resultData) {
  try {
    const [grid, totalX100, scatCount, cascadeDepth, isFree] =
      ethers.AbiCoder.defaultAbiCoder().decode(
        ["uint8[49]","uint256","uint8","uint8","bool"], resultData);
    return { grid: grid.map(Number), totalX100: Number(totalX100), scatCount: Number(scatCount), cascadeDepth: Number(cascadeDepth), isFree };
  } catch (e) { console.warn("[cluster] decode:", e.message); return null; }
}

function updateUI() {
  const stake = STAKE_PRESETS[stakeIdx];
  setText("#stakeVal", stake.toFixed(2));
  setText("#totalBet", stake.toFixed(2));
  const spinBtn = $("#spinBtn");
  if (useFreeSpinNext && lastFreeSpinsAvailable > 0) {
    spinBtn.querySelector("span").textContent = "FREE SPIN";
  } else {
    spinBtn.querySelector("span").textContent = isSpinning ? "SPINNING…" : "SPIN";
  }
}

async function doSpin() {
  if (isSpinning) return;
  const stake = STAKE_PRESETS[stakeIdx];
  const wantFree = useFreeSpinNext && lastFreeSpinsAvailable > 0;
  isSpinning = true;
  $("#spinBtn").disabled = true;
  updateUI();
  try {
    await connect();
    const cs = ethers.hexlify(ethers.randomBytes(32));
    const tx = wantFree
      ? await SL.casino.placeClusterBet(cs, true, { value: 0 })
      : await SL.casino.placeClusterBet(cs, false, { value: ethers.parseEther(stake.toFixed(6)) });
    const rcpt = await tx.wait();
    let betId;
    for (const log of rcpt.logs) {
      try {
        const p = SL.casino.interface.parseLog(log);
        if (p && p.name === "BetPlaced") { betId = p.args.betId; break; }
      } catch (_) {}
    }
    populateFairPanel({ clientSeed: cs, betId, nonce: betId, serverSeed: ethers.ZeroHash, txHash: tx.hash });

    // Quick "spinning" animation: shuffle the grid randomly while we wait.
    const shuffleHandle = setInterval(() => {
      const placeholder = Array.from({ length: 49 }, () => Math.floor(Math.random() * 8));
      setGrid(placeholder);
    }, 100);

    const settled = await pollForSettle(betId);
    clearInterval(shuffleHandle);
    if (!settled || settled.refunded) {
      setText("#lastWin", settled?.refunded ? "- refunded" : "- timed out");
      $("#lastWin").classList.add("zero");
      return;
    }
    const decoded = decodeResult(settled.args.resultData);
    if (!decoded) return;

    // Animate "settling" · tumble grid down, then highlight clusters.
    setGrid(decoded.grid, true);
    await sleep(700);
    highlightClusters(decoded.grid);

    const payoutWei = BigInt(settled.args.payout);
    const payoutSTT = Number(ethers.formatEther(payoutWei));
    totalWon += payoutSTT;
    if (settled.args.won) {
      setText("#winHudAmt", "+" + fmt(payoutSTT));
      setText("#winHudChain", String(decoded.cascadeDepth));
      $("#winHud").style.display = "flex";
      setText("#lastWin", "+" + fmt(payoutSTT) + " STT");
      $("#lastWin").classList.remove("zero");
      setTimeout(() => { $("#winHud").style.display = "none"; }, 3500);
    } else {
      setText("#lastWin", "- no cluster");
      $("#lastWin").classList.add("zero");
    }
    populateFairPanel({
      clientSeed: settled.args.clientSeed,
      betId: settled.args.betId, nonce: settled.args.nonce,
      serverSeed: settled.args.serverSeed, txHash: settled.transactionHash,
    });
  } catch (e) {
    console.error("[cluster] spin failed:", e);
    setText("#lastWin", "× " + friendlyError(e));
    $("#lastWin").classList.add("zero");
  } finally {
    isSpinning = false;
    $("#spinBtn").disabled = false;
    useFreeSpinNext = false;
    await Promise.all([refreshBalance(), refreshLoyalty()]);
    updateUI();
    if (autoRemaining > 0) {
      autoRemaining--;
      $("#autoBtn").querySelector(".lbl").textContent = autoRemaining > 0 ? String(autoRemaining) : "AUTO";
      if (autoRemaining > 0) setTimeout(() => doSpin(), 1500);
      else $("#autoBtn").classList.remove("active");
    }
  }
}

function init() {
  buildGrid();
  buildPaytable();
  updateUI();
  $("#spinBtn").addEventListener("click", () => {
    if (autoRemaining > 0) {
      autoRemaining = 0;
      $("#autoBtn").classList.remove("active");
      $("#autoBtn").querySelector(".lbl").textContent = "AUTO";
      return;
    }
    doSpin();
  });
  $("#stakeUp").addEventListener("click", () => { if (!isSpinning) { stakeIdx = Math.min(STAKE_PRESETS.length - 1, stakeIdx + 1); updateUI(); }});
  $("#stakeDn").addEventListener("click", () => { if (!isSpinning) { stakeIdx = Math.max(0, stakeIdx - 1); updateUI(); }});
  $("#turboBtn").addEventListener("click", () => {
    if (lastFreeSpinsAvailable === 0) return;
    useFreeSpinNext = !useFreeSpinNext;
    updateUI();
  });
  $("#autoBtn").addEventListener("click", () => {
    if (autoRemaining > 0) {
      autoRemaining = 0;
      $("#autoBtn").classList.remove("active");
      $("#autoBtn").querySelector(".lbl").textContent = "AUTO";
      return;
    }
    autoRemaining = 5;
    $("#autoBtn").classList.add("active");
    $("#autoBtn").querySelector(".lbl").textContent = "5";
    if (!isSpinning) doSpin();
  });
  $("#bigwinOv").addEventListener("click", () => $("#bigwinOv").classList.remove("show"));
  $("#fsIntro").addEventListener("click", () => $("#fsIntro").classList.remove("show"));
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !e.repeat) { e.preventDefault(); $("#spinBtn").click(); }
    if (e.code === "ArrowUp") { e.preventDefault(); $("#stakeUp").click(); }
    if (e.code === "ArrowDown") { e.preventDefault(); $("#stakeDn").click(); }
    if (e.key === "f" || e.key === "F") $("#turboBtn").click();
  });

  refreshGameMeta();
  refreshBalance();
  refreshLoyalty();
  loadTicker();
  setInterval(() => { refreshBalance(); refreshLoyalty(); }, 12_000);
  setInterval(loadTicker, 20_000);
  document.addEventListener("shinyluck:connected", () => { refreshBalance(); refreshLoyalty(); });
}

document.addEventListener("DOMContentLoaded", init);
