// Admin panel - owner-only. Renders treasury, bonus mode, per-game controls,
// HM reasoning log, player-agent leaderboard, and aggregate stats.
//
// All writes route through the casino owner key (the connected wallet must
// equal casino.owner()); reads are public. If you connect with a non-owner
// wallet, the panel is hidden and an "ACCESS DENIED" splash is shown.

import { ethers } from "/vendor/ethers.bundle.js";
import { SL, connect, shortAddr } from "./wallet.js";
import { CONFIG } from "./config.js";
import { provider, fetchLogs, fetchRecentLogs, fetchDeploymentBlock } from "./rpc.js";
import { POKER_CONFIG } from "/poker/poker-config.js";

// Poker rake + tournament fees live on contracts owned by the POKER deployer
// key (a different account than the casino owner), so the console gates on
// "either owner" and each card checks its own.
const ROOM_ADMIN_ABI = [
  "function owner() view returns (address)",
  "function rakeCollected() view returns (uint256)",
  "function withdrawRake(address to, uint256 amount) external",
];
const TRN_ADMIN_ABI = [
  "function owner() view returns (address)",
  "function feeCollected() view returns (uint256)",
  "function withdrawFees(address to, uint256 amount) external",
];
let _room = null, _trn = null;
function room() { return _room || (_room = new ethers.Contract(POKER_CONFIG.pokerRoom, ROOM_ADMIN_ABI, provider())); }
function trn() { return _trn || (_trn = new ethers.Contract(POKER_CONFIG.pokerTournament, TRN_ADMIN_ABI, provider())); }
let pokerOwner = null;
let isPokerOwner = false;

const GAME_NAMES = ["DICE","CRASH","VAULT.7","MINES","PLINKO","ROULETTE","SUGAR.LAB"];
const ZERO = "0x0000000000000000000000000000000000000000";
const LOOKBACK = 20_000;

const ADMIN_ABI = [
  "function owner() view returns (address)",
  "function freeBankroll() view returns (uint256)",
  "function lockedReserve() view returns (uint256)",
  "function totalPendingWithdrawals() view returns (uint256)",
  "function bonusModeActive() view returns (bool)",
  "function bonusModeUntil() view returns (uint256)",
  "function ownerWithdrawal() view returns (uint128 amount,uint64 readyAt)",
  "function gameMaxBet(uint8) view returns (uint256)",
  "function gamePaused(uint8) view returns (bool)",
  "function pauseGame(uint8) external",
  "function unpauseGame(uint8) external",
  "function setGameMaxBet(uint8,uint256) external",
  "function rouletteBetWindow() view returns (uint256)",
  "function crashBetWindow() view returns (uint256)",
  "function setRouletteBetWindow(uint256) external",
  "function setCrashBetWindow(uint256) external",
  "function activateBonusMode(uint256 durationMinutes,string reasoning) external",
  "function scheduleOwnerWithdraw(uint256 amount) external",
  "function executeOwnerWithdraw() external",
  "function cancelOwnerWithdraw() external",
  "function depositBankroll() payable",
  "event BetPlaced(uint256 indexed betId,address indexed player,uint8 indexed game,uint256 amount,bytes32 clientSeed,uint256 commitBlock,uint256 seedIdx,bytes params)",
  "event BetSettled(uint256 indexed betId,address indexed player,uint8 indexed game,bool won,uint256 payout,bytes32 randomness,bytes32 serverSeed,bytes32 clientSeed,bytes32 blockHash,uint256 nonce,bytes resultData)",
  "event ReasoningLog(string thought,uint256 timestamp)",
  "event AgentRegistered(address indexed player,address indexed vault,bytes32 strategyHash,uint256 dailyLimit,uint256 totalLimit,uint8 allowedGamesMask)",
];

const REGISTRY_ABI = [
  "function getPermission(address) view returns (tuple(address player,address vault,bytes32 strategyHash,uint256 dailyLimit,uint256 totalLimit,uint8 allowedGamesMask,bool active,uint256 spentToday,uint256 spentTotal,uint64 lastResetDay))",
  "event AgentRegistered(address indexed player,address indexed vault,bytes32 strategyHash,uint256 dailyLimit,uint256 totalLimit,uint8 allowedGamesMask)",
];

let casinoRO = null;
let registryRO = null;
let casinoOwner = null;
let isOwner = false;

function $(s) { return document.querySelector(s); }
function $$(s) { return document.querySelectorAll(s); }
function fmtSTT(wei) {
  if (typeof wei !== "bigint") wei = BigInt(wei);
  const eth = Number(ethers.formatEther(wei));
  if (eth >= 1000) return eth.toFixed(0);
  if (eth >= 1) return eth.toFixed(2);
  if (eth >= 0.01) return eth.toFixed(3);
  return eth.toFixed(4);
}

function casino() {
  if (!casinoRO) casinoRO = new ethers.Contract(CONFIG.casino, ADMIN_ABI, provider());
  return casinoRO;
}
function registry() {
  if (!registryRO && CONFIG.registry && CONFIG.registry !== ZERO) {
    registryRO = new ethers.Contract(CONFIG.registry, REGISTRY_ABI, provider());
  }
  return registryRO;
}

function withSigner(c) {
  return SL.signer ? c.connect(SL.signer) : c;
}

async function gateAccess() {
  if (!CONFIG.casino || CONFIG.casino === ZERO) return;
  if (!casinoOwner) {
    try { casinoOwner = (await casino().owner()).toLowerCase(); }
    catch (e) { console.warn("[admin] owner read:", e.message); return; }
  }
  if (!pokerOwner && POKER_CONFIG.pokerRoom) {
    try { pokerOwner = (await room().owner()).toLowerCase(); } catch (_) {}
  }
  $("[data-sl-adm-owner]").textContent = shortAddr(casinoOwner) + (pokerOwner && pokerOwner !== casinoOwner ? " · poker " + shortAddr(pokerOwner) : "");
  if (SL.address) {
    $("[data-sl-adm-connected]").textContent = shortAddr(SL.address);
    isOwner = SL.address.toLowerCase() === casinoOwner;
    isPokerOwner = !!pokerOwner && SL.address.toLowerCase() === pokerOwner;
  } else {
    $("[data-sl-adm-connected]").textContent = "-";
    isOwner = false;
    isPokerOwner = false;
  }
  // Either key opens the console; each card still enforces its own owner.
  const allowed = isOwner || isPokerOwner;
  $("[data-sl-adm-denied]").style.display = allowed ? "none" : "block";
  $("[data-sl-adm-main]").classList.toggle("on", allowed);
}

async function refreshTreasury() {
  if (!isOwner) return;
  const c = casino();
  try {
    const [bankroll, reserve, pending, contractBal, pw] = await Promise.all([
      c.freeBankroll(),
      c.lockedReserve(),
      c.totalPendingWithdrawals(),
      provider().getBalance(CONFIG.casino),
      c.ownerWithdrawal(),
    ]);
    $("[data-sl-adm-bankroll]").textContent = fmtSTT(bankroll);
    $("[data-sl-adm-reserve]").textContent  = fmtSTT(reserve);
    $("[data-sl-adm-pending]").textContent  = fmtSTT(pending);
    $("[data-sl-adm-balance]").textContent  = fmtSTT(contractBal);
    if (pw.amount > 0n) {
      const ready = Number(pw.readyAt) * 1000;
      const left = ready - Date.now();
      $("[data-sl-adm-owner-pending]").textContent = `${fmtSTT(pw.amount)} STT · ready ${left > 0 ? new Date(ready).toLocaleString() : "NOW"}`;
    } else {
      $("[data-sl-adm-owner-pending]").textContent = "none scheduled";
    }
  } catch (e) { console.warn("[admin] treasury:", e.message); }
}

async function refreshBonus() {
  if (!isOwner) return;
  try {
    const c = casino();
    const [active, until] = await Promise.all([c.bonusModeActive(), c.bonusModeUntil()]);
    $("[data-sl-adm-bonus-status]").textContent = active ? "ACTIVE" : "OFF";
    $("[data-sl-adm-bonus-status]").style.color = active ? "var(--green)" : "var(--fg-mute)";
    $("[data-sl-adm-bonus-until]").textContent = Number(until) > 0 ? new Date(Number(until) * 1000).toLocaleString() : "-";
  } catch (_) {}
}

async function refreshGames() {
  if (!isOwner) return;
  const root = $("[data-sl-adm-games]");
  if (!root) return;
  try {
    const c = casino();
    const maxBets = await Promise.all([0,1,2,3,4,5].map((g) => c.gameMaxBet(g)));
    const paused  = await Promise.all([0,1,2,3,4,5].map((g) => c.gamePaused(g)));
    root.innerHTML = "";
    for (let g = 0; g < 6; g++) {
      const row = document.createElement("div");
      row.className = "adm-game-row";
      row.innerHTML =
        `<b style="color:var(--purple-2);">${GAME_NAMES[g]}</b>` +
        `<span style="color:${paused[g] ? "var(--red)" : "var(--green)"};">${paused[g] ? "PAUSED" : "LIVE"}</span>` +
        `<input class="adm-input" value="${fmtSTT(maxBets[g])}" data-sl-adm-mb="${g}" />` +
        `<span style="display:flex; gap:6px;">` +
          `<button class="adm-btn" data-sl-adm-setmb="${g}">save max</button>` +
          `<button class="adm-btn ${paused[g] ? '' : 'danger'}" data-sl-adm-togp="${g}">${paused[g] ? 'UNPAUSE' : 'PAUSE'}</button>` +
        `</span>`;
      root.appendChild(row);
    }
    root.querySelectorAll("button[data-sl-adm-setmb]").forEach((b) => {
      b.addEventListener("click", async () => {
        const g = parseInt(b.dataset.slAdmSetmb, 10);
        const v = root.querySelector(`input[data-sl-adm-mb="${g}"]`).value;
        try {
          b.disabled = true; b.textContent = "…";
          const tx = await withSigner(casino()).setGameMaxBet(g, ethers.parseEther(v));
          await tx.wait();
          await refreshGames();
        } catch (e) { import("./ui.js").then(({ toast }) => toast(e.shortMessage || e.message, { kind: "error", ttl: 6000 })); }
        finally { b.disabled = false; }
      });
    });
    root.querySelectorAll("button[data-sl-adm-togp]").forEach((b) => {
      b.addEventListener("click", async () => {
        const g = parseInt(b.dataset.slAdmTogp, 10);
        const isPaused = b.textContent.includes("UNPAUSE");
        try {
          b.disabled = true;
          const c = withSigner(casino());
          const tx = isPaused ? await c.unpauseGame(g) : await c.pauseGame(g);
          await tx.wait();
          await refreshGames();
        } catch (e) { import("./ui.js").then(({ toast }) => toast(e.shortMessage || e.message, { kind: "error", ttl: 6000 })); }
        finally { b.disabled = false; }
      });
    });
  } catch (e) { console.warn("[admin] games:", e.message); }
}

async function refreshReasoning() {
  if (!isOwner) return;
  const root = $("[data-sl-adm-reasoning]");
  if (!root) return;
  try {
    const events = await fetchRecentLogs(casino(), "ReasoningLog", { minCount: 20, maxLookback: 100_000 });
    if (events.length === 0) {
      root.innerHTML = `<div class="m" style="opacity:.4;">no reasoning yet - start hm-cron</div>`;
      return;
    }
    root.innerHTML = "";
    for (const ev of events.slice(0, 20)) {
      const dt = new Date(Number(ev.args.timestamp) * 1000).toISOString().slice(0, 19).replace("T", " ");
      const div = document.createElement("div");
      div.style.cssText = "padding: 6px 0; border-bottom: 1px dashed var(--line-2);";
      div.innerHTML = `<span style="color: var(--cyan);">${dt}</span><br/><span>${ev.args.thought}</span>`;
      root.appendChild(div);
    }
  } catch (e) { console.warn("[admin] reasoning:", e.message); }
}

async function refreshAgents() {
  if (!isOwner) return;
  const root = $("[data-sl-adm-agents]");
  if (!root) return;
  const reg = registry();
  if (!reg) { root.innerHTML = `<div class="m" style="opacity:.4;">no registry configured</div>`; return; }
  try {
    const head = await provider().getBlockNumber();
    const dep = await fetchDeploymentBlock();
    const events = await fetchLogs(reg, "AgentRegistered", Math.max(dep || head - LOOKBACK, head - LOOKBACK), head);
    if (events.length === 0) { root.innerHTML = `<div class="m" style="opacity:.4;">no agents registered</div>`; return; }
    const c = casino();
    // For each agent, pull permissions + casino BetSettled events for vault → P&L.
    const rows = [];
    for (const ev of events) {
      const player = ev.args.player;
      const vault = ev.args.vault;
      let perm; try { perm = await reg.getPermission(player); } catch { continue; }
      // P&L from vault's BetSettled events
      let pnl = 0n;
      try {
        const placed = await fetchRecentLogs(c, "BetPlaced", {
          minCount: 100, maxLookback: 100_000,
          filter: (e) => e.args.player.toLowerCase() === vault.toLowerCase(),
        });
        const settled = await fetchRecentLogs(c, "BetSettled", {
          minCount: 100, maxLookback: 100_000,
          filter: (e) => e.args.player.toLowerCase() === vault.toLowerCase(),
        });
        const stakeByBet = new Map();
        for (const p of placed) stakeByBet.set(p.args.betId.toString(), p.args.amount);
        for (const s of settled) {
          const stake = BigInt(stakeByBet.get(s.args.betId.toString()) || 0n);
          pnl += s.args.won ? (BigInt(s.args.payout) - stake) : -stake;
        }
      } catch (_) {}
      rows.push({ player, vault, active: perm.active, spentTotal: perm.spentTotal, pnl });
    }
    rows.sort((a, b) => (b.pnl - a.pnl > 0n ? 1 : -1));
    root.innerHTML = "";
    const t = document.createElement("table");
    t.className = "adm-table";
    t.innerHTML = `<thead><tr><th>Player</th><th>Vault</th><th>Status</th><th>Spent</th><th>P&amp;L</th></tr></thead><tbody></tbody>`;
    const tbody = t.querySelector("tbody");
    for (const r of rows) {
      const tr = document.createElement("tr");
      const pnlColor = r.pnl >= 0n ? "var(--green)" : "var(--red)";
      tr.innerHTML =
        `<td><a href="/u/${r.player.toLowerCase()}">${shortAddr(r.player)}</a></td>` +
        `<td>${shortAddr(r.vault)}</td>` +
        `<td style="color:${r.active ? 'var(--green)' : 'var(--amber)'};">${r.active ? "ACTIVE" : "PAUSED"}</td>` +
        `<td>${fmtSTT(r.spentTotal)} STT</td>` +
        `<td style="color:${pnlColor};">${r.pnl >= 0n ? "+" : "−"} ${fmtSTT(r.pnl < 0n ? -r.pnl : r.pnl)} STT</td>`;
      tbody.appendChild(tr);
    }
    root.appendChild(t);
  } catch (e) { console.warn("[admin] agents:", e.message); }
}

async function refreshStats() {
  if (!isOwner) return;
  const root = $("[data-sl-adm-stats]");
  if (!root) return;
  try {
    const c = casino();
    const head = await provider().getBlockNumber();
    const dep = await fetchDeploymentBlock();
    const from = Math.max(dep || head - LOOKBACK, head - LOOKBACK);
    const [placed, settled] = await Promise.all([
      fetchLogs(c, "BetPlaced", from, head),
      fetchLogs(c, "BetSettled", from, head),
    ]);
    const stakeByBet = new Map();
    for (const p of placed) stakeByBet.set(p.args.betId.toString(), p.args.amount);
    const byGame = Array.from({ length: 6 }, () => ({ bets: 0, wagered: 0n, paid: 0n }));
    for (const s of settled) {
      const g = Number(s.args.game);
      const stake = BigInt(stakeByBet.get(s.args.betId.toString()) || 0n);
      byGame[g].bets++;
      byGame[g].wagered += stake;
      byGame[g].paid += BigInt(s.args.payout);
    }
    root.innerHTML = "";
    for (let g = 0; g < 6; g++) {
      const row = byGame[g];
      if (row.bets === 0) continue;
      const margin = row.wagered > 0n
        ? Number((row.wagered - row.paid) * 10000n / row.wagered) / 100
        : 0;
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td><b style="color: var(--purple-2);">${GAME_NAMES[g]}</b></td>` +
        `<td>${row.bets}</td>` +
        `<td>${fmtSTT(row.wagered)} STT</td>` +
        `<td>${fmtSTT(row.paid)} STT</td>` +
        `<td style="color:${margin >= 0 ? 'var(--green)' : 'var(--red)'};">${margin.toFixed(2)}%</td>`;
      root.appendChild(tr);
    }
    if (!root.children.length) root.innerHTML = `<tr><td colspan="5" class="dim">no settled bets in window</td></tr>`;
  } catch (e) { console.warn("[admin] stats:", e.message); }
}

function bindActions() {
  const pokerWithdraw = async (which) => {
    const toast = (m, kind = "error") => import("./ui.js").then(({ toast: t }) => t(m, { kind, ttl: 6000 }));
    if (!isPokerOwner) return toast("Connect the POKER deployer account to withdraw poker funds", "warn");
    await connect();
    const dest = ($("[data-sl-adm-poker-to]")?.value || "").trim() || SL.address;
    if (!ethers.isAddress(dest)) return toast("Enter a valid destination address", "warn");
    try {
      const c = which === "rake" ? room() : trn();
      const amount = which === "rake" ? await c.rakeCollected() : await c.feeCollected();
      if (!(amount > 0n)) return toast("Nothing to withdraw", "warn");
      const w = c.connect(SL.signer);
      const tx = which === "rake" ? await w.withdrawRake(dest, amount) : await w.withdrawFees(dest, amount);
      await tx.wait();
      toast(`Sent ${ethers.formatEther(amount)} STT to ${shortAddr(dest)}`, "success");
      refreshPoker();
    } catch (e) { toast(e.shortMessage || e.message); }
  };
  $("[data-sl-adm-rake-withdraw]")?.addEventListener("click", () => pokerWithdraw("rake"));
  $("[data-sl-adm-trnfees-withdraw]")?.addEventListener("click", () => pokerWithdraw("fees"));
  $("[data-sl-adm-schedule]")?.addEventListener("click", async () => {
    if (!isOwner) return;
    await connect();
    const amt = $("[data-sl-adm-withdraw-amt]").value;
    try {
      const tx = await withSigner(casino()).scheduleOwnerWithdraw(ethers.parseEther(amt));
      await tx.wait(); refreshTreasury();
    } catch (e) { import("./ui.js").then(({ toast }) => toast(e.shortMessage || e.message, { kind: "error", ttl: 6000 })); }
  });
  $("[data-sl-adm-execute]")?.addEventListener("click", async () => {
    if (!isOwner) return;
    await connect();
    try {
      const tx = await withSigner(casino()).executeOwnerWithdraw();
      await tx.wait(); refreshTreasury();
    } catch (e) { import("./ui.js").then(({ toast }) => toast(e.shortMessage || e.message, { kind: "error", ttl: 6000 })); }
  });
  $("[data-sl-adm-cancel]")?.addEventListener("click", async () => {
    if (!isOwner) return;
    await connect();
    try {
      const tx = await withSigner(casino()).cancelOwnerWithdraw();
      await tx.wait(); refreshTreasury();
    } catch (e) { import("./ui.js").then(({ toast }) => toast(e.shortMessage || e.message, { kind: "error", ttl: 6000 })); }
  });
  $("[data-sl-adm-deposit]")?.addEventListener("click", async () => {
    if (!isOwner) return;
    await connect();
    const amt = $("[data-sl-adm-deposit-amt]").value;
    try {
      const tx = await withSigner(casino()).depositBankroll({ value: ethers.parseEther(amt) });
      await tx.wait(); refreshTreasury();
    } catch (e) { import("./ui.js").then(({ toast }) => toast(e.shortMessage || e.message, { kind: "error", ttl: 6000 })); }
  });
  $("[data-sl-adm-bonus-activate]")?.addEventListener("click", async () => {
    if (!isOwner) return;
    await connect();
    const m = parseInt($("[data-sl-adm-bonus-mins]").value, 10) || 60;
    const reason = $("[data-sl-adm-bonus-reason]").value || "manual";
    try {
      const tx = await withSigner(casino()).activateBonusMode(m, reason);
      await tx.wait(); refreshBonus();
    } catch (e) { import("./ui.js").then(({ toast }) => toast(e.shortMessage || e.message, { kind: "error", ttl: 6000 })); }
  });
  $("[data-sl-adm-roul-window-set]")?.addEventListener("click", async () => {
    if (!isOwner) return;
    await connect();
    const secs = parseInt($("[data-sl-adm-roul-window-amt]").value, 10);
    if (!(secs >= 5 && secs <= 22)) { import("./ui.js").then(({ toast }) => toast("Window must be 5-22s", { kind: "warn" })); return; }
    try {
      const tx = await withSigner(casino()).setRouletteBetWindow(secs);
      await tx.wait(); refreshWindows();
    } catch (e) { import("./ui.js").then(({ toast }) => toast(e.shortMessage || e.message, { kind: "error", ttl: 6000 })); }
  });
  $("[data-sl-adm-crash-window-set]")?.addEventListener("click", async () => {
    if (!isOwner) return;
    await connect();
    const secs = parseInt($("[data-sl-adm-crash-window-amt]").value, 10);
    if (!(secs >= 5 && secs <= 22)) { import("./ui.js").then(({ toast }) => toast("Window must be 5-22s", { kind: "warn" })); return; }
    try {
      const tx = await withSigner(casino()).setCrashBetWindow(secs);
      await tx.wait(); refreshWindows();
    } catch (e) { import("./ui.js").then(({ toast }) => toast(e.shortMessage || e.message, { kind: "error", ttl: 6000 })); }
  });
}

async function refreshWindows() {
  try {
    const c = casinoRO || (casinoRO = new ethers.Contract(CONFIG.casino, ADMIN_ABI, provider()));
    const [roul, crash] = await Promise.all([
      c.rouletteBetWindow().catch(() => null),
      c.crashBetWindow().catch(() => null),
    ]);
    const rEl = $("[data-sl-adm-roul-window]"); if (rEl && roul != null) rEl.textContent = roul.toString();
    const cEl = $("[data-sl-adm-crash-window]"); if (cEl && crash != null) cEl.textContent = crash.toString();
  } catch (e) { console.warn("[admin] windows:", e.message); }
}

async function refreshPoker() {
  const fmt = (v) => Number(ethers.formatEther(v)).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  try { $("[data-sl-adm-rake]").textContent = fmt(await room().rakeCollected()); } catch (_) {}
  try { $("[data-sl-adm-trnfees]").textContent = fmt(await trn().feeCollected()); } catch (_) {}
}

async function refreshAll() {
  await gateAccess();
  if (!isOwner && !isPokerOwner) return;
  await Promise.all([refreshPoker().catch(() => {})].concat(
    isOwner ? [refreshTreasury(), refreshBonus(), refreshGames(), refreshWindows(), refreshReasoning(), refreshAgents(), refreshStats()] : [],
  ));
}

document.addEventListener("DOMContentLoaded", () => {
  bindActions();
  refreshAll().catch((e) => console.warn("[admin] init:", e.message));
  document.addEventListener("shinyluck:connected", () => refreshAll().catch(() => {}));
  setInterval(() => refreshAll().catch(() => {}), 15_000);
});
