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
import { vaultAddress, moduleOf } from "./casino-sources.js";

const VAULT_ADDR = vaultAddress();

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

// Predictions runs on its own deployer key (a third account) - same "each card
// enforces its own owner" rule as the poker cards.
const PRED_MARKET = "0x8AA8E7D6D89b4D6a9C9a43C0f4Fa5a547a7974E5";
const PRED_ABI = [
  "function owner() view returns (address)",
  "function platformAccrued() view returns (uint256)",
  "function platformFeeBps() view returns (uint16)",
  "function creatorFeeBps() view returns (uint16)",
  "function curatedMode() view returns (bool)",
  "function allowedCreators(address) view returns (bool)",
  "function pendingFunds(address) view returns (uint256)",
  "function marketCount() view returns (uint256)",
  "function withdrawPlatform(address to, uint256 amount) external",
  "function claimFunds() external",
  "function setAllowedCreator(address who, bool ok) external",
  "function setCuratedMode(bool on) external",
];
let _pred = null;
function pred() { return _pred || (_pred = new ethers.Contract(PRED_MARKET, PRED_ABI, provider())); }
let predOwner = null;
let isPredOwner = false;

// setAllowedCreator emits no event, so the panel keeps the roster locally and
// shows each entry's LIVE on-chain flag - the chain stays the source of truth.
const PRED_ROSTER_KEY = "shinyluck.pred.creators";
const roster = () => { try { return JSON.parse(localStorage.getItem(PRED_ROSTER_KEY)) || []; } catch (_) { return []; } };
const rosterSave = (l) => { try { localStorage.setItem(PRED_ROSTER_KEY, JSON.stringify([...new Set(l.map((a) => a.toLowerCase()))])); } catch (_) {} };

const GAME_NAMES = ["DICE","CRASH","VAULT.7","MINES","PLINKO","ROULETTE","SUGAR.LAB"];
const ZERO = "0x0000000000000000000000000000000000000000";
const LOOKBACK = 20_000;

// v15 CasinoVault. The v14 monolith is frozen, and its owner is a DIFFERENT
// key — gating this panel on it locked the real owner out with ACCESS DENIED
// while every control pointed at a contract nobody plays on.
//
// Gone in v15 (agent layer dropped, per-game logic moved into modules):
//   lockedReserve, bonusMode*, gamePaused/pauseGame/unpauseGame,
//   {roulette,crash}BetWindow  (bet windows now live on their own modules).
// New here: per-game active flag + per-game budget (the blast-radius cap), and
// the seed pool, which stops every game when it runs dry.
const ADMIN_ABI = [
  "function owner() view returns (address)",
  "function freeBankroll() view returns (uint256)",
  "function totalPendingWithdrawals() view returns (uint256)",
  "function ownerWithdrawal() view returns (uint128 amount,uint64 readyAt)",
  "function paused() view returns (bool)",
  "function maxBetBps() view returns (uint256)",
  "function maxExposureBps() view returns (uint256)",
  "function gameMaxBet(uint16) view returns (uint256)",
  "function gameActive(uint16) view returns (bool)",
  "function gameBudget(uint16) view returns (uint256)",
  "function gameNet(uint16) view returns (int256)",
  "function seedPoolStatus() view returns (uint256 total,uint256 consumed,uint256 available)",
  "function setGameActive(uint16,bool) external",
  "function setGameMaxBet(uint16,uint256) external",
  "function setGameBudget(uint16,uint256) external",
  "function setMaxBetBps(uint256) external",
  "function setMaxExposureBps(uint256) external",
  "function pauseAll() external",
  "function unpauseAll() external",
  "function provisionSeedHashes(bytes32[] hashes) external",
  "function scheduleOwnerWithdraw(uint256 amount) external",
  "function executeOwnerWithdraw() external",
  "function cancelOwnerWithdraw() external",
  "function depositBankroll() payable",
  "event BetPlaced(uint256 indexed betId,address indexed player,uint16 indexed gameId,uint256 amount,bytes32 clientSeed,uint256 commitBlock,uint256 seedIdx,bytes params)",
  "event BetSettled(uint256 indexed betId,address indexed player,uint16 indexed gameId,bool won,uint256 payout,bytes32 randomness,bytes32 serverSeed,bytes32 clientSeed,bytes32 blockHash,uint256 nonce,bytes resultData)",
  "event PayoutClamped(uint256 indexed betId,uint256 requested,uint256 credited,string reason)",
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
  if (!casinoRO) casinoRO = new ethers.Contract(VAULT_ADDR, ADMIN_ABI, provider());
  return casinoRO;
}
function registry() {
  if (!registryRO && CONFIG.registry && CONFIG.registry !== ZERO) {
    registryRO = new ethers.Contract(CONFIG.registry, REGISTRY_ABI, provider());
  }
  return registryRO;
}

// Crash and Roulette own their own bet window in v15 (it left the monolith
// along with the rest of each game's logic).
const ROUND_ADMIN_ABI = [
  "function betWindow() view returns (uint256)",
  "function setBetWindow(uint256 secs) external",
];
const _roundMods = {};
function roundModule(name) {
  if (!_roundMods[name]) {
    const addr = moduleOf(name);
    if (!addr) throw new Error(`v15 module not configured: ${name}`);
    _roundMods[name] = new ethers.Contract(addr, ROUND_ADMIN_ABI, provider());
  }
  return _roundMods[name];
}

function withSigner(c) {
  return SL.signer ? c.connect(SL.signer) : c;
}

async function gateAccess() {
  if (!VAULT_ADDR || VAULT_ADDR === ZERO) return;
  if (!casinoOwner) {
    try { casinoOwner = (await casino().owner()).toLowerCase(); }
    catch (e) { console.warn("[admin] owner read:", e.message); return; }
  }
  if (!pokerOwner && POKER_CONFIG.pokerRoom) {
    try { pokerOwner = (await room().owner()).toLowerCase(); } catch (_) {}
  }
  $("[data-sl-adm-owner]").textContent = shortAddr(casinoOwner) + (pokerOwner && pokerOwner !== casinoOwner ? " · poker " + shortAddr(pokerOwner) : "");
  if (!predOwner) {
    try { predOwner = (await pred().owner()).toLowerCase(); } catch (_) {}
  }
  if (SL.address) {
    $("[data-sl-adm-connected]").textContent = shortAddr(SL.address);
    isOwner = SL.address.toLowerCase() === casinoOwner;
    isPokerOwner = !!pokerOwner && SL.address.toLowerCase() === pokerOwner;
    isPredOwner = !!predOwner && SL.address.toLowerCase() === predOwner;
  } else {
    $("[data-sl-adm-connected]").textContent = "-";
    isOwner = false;
    isPokerOwner = false;
    isPredOwner = false;
  }
  // Any of the three keys opens the console; each card still enforces its own owner.
  const allowed = isOwner || isPokerOwner || isPredOwner;
  $("[data-sl-adm-denied]").style.display = allowed ? "none" : "block";
  $("[data-sl-adm-main]").classList.toggle("on", allowed);
}

async function refreshTreasury() {
  if (!isOwner) return;
  const c = casino();
  try {
    const [bankroll, seeds, pending, contractBal, pw] = await Promise.all([
      c.freeBankroll(),
      c.seedPoolStatus(),
      c.totalPendingWithdrawals(),
      provider().getBalance(VAULT_ADDR),
      c.ownerWithdrawal(),
    ]);
    $("[data-sl-adm-bankroll]").textContent = fmtSTT(bankroll);
    // v15 has no lockedReserve. The seed pool is the number that actually
    // stops the casino, so it takes that slot: bets revert once it hits 0.
    $("[data-sl-adm-reserve]").textContent  = `${seeds.available} seeds`;
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
    // v15 dropped bonus mode along with the agent layer.
    const [active, until] = [false, 0n];
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
    const maxBets = await Promise.all([0,1,2,3,4,5,6].map((g) => c.gameMaxBet(g)));
    // v15 gates a game with an ACTIVE flag, not a paused flag.
    const active  = await Promise.all([0,1,2,3,4,5,6].map((g) => c.gameActive(g)));
    const paused  = active.map((a) => !a);
    root.innerHTML = "";
    for (let g = 0; g < 7; g++) {
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
          const tx = await c.setGameActive(g, isPaused);
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
    for (let g = 0; g < 7; g++) {
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

  // ---- predictions ----
  const ptoast = (m, kind = "error") => import("./ui.js").then(({ toast: t }) => t(m, { kind, ttl: 6000 }));
  $("[data-sl-adm-pred-withdraw]")?.addEventListener("click", async () => {
    if (!isPredOwner) return ptoast("Connect the PREDICTIONS deployer account", "warn");
    await connect();
    const dest = ($("[data-sl-adm-pred-to]")?.value || "").trim() || SL.address;
    if (!ethers.isAddress(dest)) return ptoast("Enter a valid destination address", "warn");
    try {
      const amount = await pred().platformAccrued();
      if (!(amount > 0n)) return ptoast("Nothing to withdraw", "warn");
      const tx = await pred().connect(SL.signer).withdrawPlatform(dest, amount);
      await tx.wait();
      ptoast(`Sent ${ethers.formatEther(amount)} STT to ${shortAddr(dest)}`, "success");
      refreshPredictions();
    } catch (e) { ptoast(e.shortMessage || e.message); }
  });
  $("[data-sl-adm-pred-claim]")?.addEventListener("click", async () => {
    await connect();
    try {
      const tx = await pred().connect(SL.signer).claimFunds();
      await tx.wait();
      ptoast("Creator fees + bonds claimed", "success");
      refreshPredictions();
    } catch (e) { ptoast(e.shortMessage || e.message); }
  });
  $("[data-sl-adm-pred-add]")?.addEventListener("click", () => {
    const a = ($("[data-sl-adm-pred-creator]")?.value || "").trim();
    setCreator(a, true);
  });
  $("[data-sl-adm-pred-check]")?.addEventListener("click", async () => {
    const a = ($("[data-sl-adm-pred-creator]")?.value || "").trim();
    if (!ethers.isAddress(a)) return ptoast("Invalid address", "warn");
    try {
      const on = await pred().allowedCreators(a);
      const l = roster(); if (!l.includes(a.toLowerCase())) { l.push(a.toLowerCase()); rosterSave(l); }
      ptoast(`${shortAddr(a)} is ${on ? "ALLOWED" : "not allowed"}`, on ? "success" : "warn");
      refreshPredictions();
    } catch (e) { ptoast(e.shortMessage || e.message); }
  });
  // ---- InfoFi tracked accounts -------------------------------------------
  // These are plain text files the daily collector reads, not chain state, so
  // the edit is a SIGNED REQUEST rather than a transaction: no gas, instant.
  // The service re-derives the owner set from chain and accepts any of the same
  // three keys that open this console.
  //
  // Guarded: bindActions() is called before refreshAll() and before the 15s
  // refresh interval is armed, so ANYTHING that throws in here takes the whole
  // console down with it - the gate never runs and every owner sees ACCESS
  // DENIED with both addresses blank. That is exactly what happened once.
  try { bindInfofi(); } catch (e) { console.warn("[admin] infofi card:", e.message); }

  $("[data-sl-adm-pred-curated-toggle]")?.addEventListener("click", async () => {
    if (!isPredOwner) return ptoast("Connect the PREDICTIONS deployer account", "warn");
    await connect();
    try {
      const cur = await pred().curatedMode();
      const tx = await pred().connect(SL.signer).setCuratedMode(!cur);
      await tx.wait();
      ptoast(`Curated mode ${!cur ? "ON" : "OFF"}`, "success");
      refreshPredictions();
    } catch (e) { ptoast(e.shortMessage || e.message); }
  });
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
      // v15 dropped bonus mode with the agent layer. Say so instead of
      // sending a call that can only revert.
      void m; void reason;
      import("./ui.js").then(({ toast }) => toast("Bonus mode was removed in casino v15", { kind: "warn", ttl: 5000 }));
      return;
    } catch (e) { import("./ui.js").then(({ toast }) => toast(e.shortMessage || e.message, { kind: "error", ttl: 6000 })); }
  });
  $("[data-sl-adm-roul-window-set]")?.addEventListener("click", async () => {
    if (!isOwner) return;
    await connect();
    const secs = parseInt($("[data-sl-adm-roul-window-amt]").value, 10);
    if (!(secs >= 5 && secs <= 22)) { import("./ui.js").then(({ toast }) => toast("Window must be 5-22s", { kind: "warn" })); return; }
    try {
      const tx = await withSigner(roundModule("roulette")).setBetWindow(secs);
      await tx.wait(); refreshWindows();
    } catch (e) { import("./ui.js").then(({ toast }) => toast(e.shortMessage || e.message, { kind: "error", ttl: 6000 })); }
  });
  $("[data-sl-adm-crash-window-set]")?.addEventListener("click", async () => {
    if (!isOwner) return;
    await connect();
    const secs = parseInt($("[data-sl-adm-crash-window-amt]").value, 10);
    if (!(secs >= 5 && secs <= 22)) { import("./ui.js").then(({ toast }) => toast("Window must be 5-22s", { kind: "warn" })); return; }
    try {
      const tx = await withSigner(roundModule("crash")).setBetWindow(secs);
      await tx.wait(); refreshWindows();
    } catch (e) { import("./ui.js").then(({ toast }) => toast(e.shortMessage || e.message, { kind: "error", ttl: 6000 })); }
  });
}

async function refreshWindows() {
  try {
    const [roul, crash] = await Promise.all([
      roundModule("roulette").betWindow().catch(() => null),
      roundModule("crash").betWindow().catch(() => null),
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

async function refreshPredictions() {
  const c = pred();
  try {
    const [accrued, pf, cf, curated, count] = await Promise.all([
      c.platformAccrued(), c.platformFeeBps(), c.creatorFeeBps(), c.curatedMode(), c.marketCount(),
    ]);
    $("[data-sl-adm-pred-accrued]").textContent = fmtSTT(accrued);
    $("[data-sl-adm-pred-fees]").textContent = `${Number(pf) / 100}% platform + ${Number(cf) / 100}% creator`;
    $("[data-sl-adm-pred-markets]").textContent = count.toString();
    const cur = $("[data-sl-adm-pred-curated]");
    if (cur) { cur.textContent = curated ? "ON · whitelist only" : "OFF · anyone can create"; cur.className = "v " + (curated ? "amber" : "cyan"); }
    const btn = $("[data-sl-adm-pred-curated-toggle]");
    if (btn) btn.textContent = curated ? "Open to everyone" : "Restrict to whitelist";
  } catch (_) {}
  if (SL.address) {
    try { $("[data-sl-adm-pred-pending]").textContent = fmtSTT(await c.pendingFunds(SL.address)); } catch (_) {}
  }
  // roster with live on-chain status
  const root = $("[data-sl-adm-pred-creators]");
  if (!root) return;
  const list = roster();
  if (!list.length) { root.innerHTML = `<div class="m" style="opacity:.45">no creators added yet</div>`; return; }
  const flags = await Promise.all(list.map((a) => c.allowedCreators(a).catch(() => null)));
  root.innerHTML = "";
  list.forEach((addr, i) => {
    const on = flags[i];
    const row = document.createElement("div");
    row.className = "adm-row";
    row.innerHTML = `<span class="l" style="font-family:var(--mono);font-size:11px">${shortAddr(addr)}</span>
      <span class="v ${on ? "cyan" : ""}" style="opacity:${on ? 1 : .45}">${on === null ? "?" : on ? "ALLOWED" : "revoked"}</span>`;
    const b = document.createElement("button");
    b.className = "adm-btn" + (on ? " danger" : "");
    b.textContent = on ? "Revoke" : "Allow";
    b.onclick = () => setCreator(addr, !on);
    row.appendChild(b);
    root.appendChild(row);
  });
}

async function setCreator(addr, allow) {
  const toast = (m, kind = "error") => import("./ui.js").then(({ toast: t }) => t(m, { kind, ttl: 6000 }));
  if (!isPredOwner) return toast("Connect the PREDICTIONS deployer account", "warn");
  if (!ethers.isAddress(addr)) return toast("Invalid address", "warn");
  try {
    await connect();
    const tx = await pred().connect(SL.signer).setAllowedCreator(addr, allow);
    await tx.wait();
    const l = roster(); if (!l.includes(addr.toLowerCase())) l.push(addr.toLowerCase());
    rosterSave(l);
    toast(`${allow ? "Allowed" : "Revoked"} ${shortAddr(addr)}`, "success");
    refreshPredictions();
  } catch (e) { toast(e.shortMessage || e.message); }
}

/* ---------------- InfoFi tracked accounts ----------------
 * The mindshare board is driven by three text files on the box. Editing them
 * is an owner-signed HTTP request, not a transaction - there is nothing on
 * chain to change, and making the owner pay gas to add a handle would be silly.
 * The signature covers the exact action, so it cannot be replayed as another. */
const IF_API = "/infofi-admin";
const IF_LABEL = { projects: "Projects", voices: "Voices", tags: "Context tags" };
let ifList = "projects";
let ifCache = null;

function ifStatus(msg, kind) {
  const el = $("[data-sl-adm-if-status]");
  if (!el) return;
  el.textContent = msg || "";
  el.style.color = kind === "error" ? "var(--red)" : kind === "success" ? "var(--green)" : "var(--fg-faint)";
}

function ifPaint() {
  document.querySelectorAll("[data-sl-adm-if-list]").forEach((b) => {
    const on = b.getAttribute("data-sl-adm-if-list") === ifList;
    b.style.borderColor = on ? "var(--gold-dark)" : "";
    b.style.color = on ? "var(--gold-hi)" : "";
  });
  const box = $("[data-sl-adm-if-rows]");
  if (!box) return;
  const items = (ifCache && ifCache[ifList]) || [];
  box.innerHTML = items.length
    ? `<div style="display:flex;flex-wrap:wrap;gap:6px">` + items.map((h) =>
        `<span data-no-i18n style="font:500 11px var(--mono);color:var(--fg-dim);border:1px solid var(--bd);border-radius:999px;padding:3px 9px">@${String(h).replace(/[&<>"]/g, "")}</span>`
      ).join("") + `</div>`
    : `<span class="dim" style="font-size:11px">${ifCache ? "empty" : "loading…"}</span>`;
}

async function refreshInfofi() {
  try {
    const r = await fetch(IF_API + "/lists", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    ifCache = await r.json();
  } catch (_) {
    ifCache = null;   // service down: show "loading" rather than a wrong empty
  }
  ifPaint();
  ifRefreshStatus();
}

/* A collection walks every tracked timeline on X and takes 15-25 minutes, so the
 * button starts it and this polls. Polling only tightens WHILE a run is live -
 * the rest of the time the 15s console refresh is plenty. */
let ifPoll = null;
async function ifRefreshStatus() {
  let st;
  try {
    const r = await fetch(IF_API + "/status", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    st = await r.json();
  } catch (_) {
    const el = $("[data-sl-adm-if-run]");
    if (el) el.textContent = "";
    return;
  }

  const snap = $("[data-sl-adm-if-snapshot]");
  if (snap) {
    snap.textContent = st.snapshot
      ? `${st.snapshot.accounts} accounts · ${st.snapshot.withAvatar} with avatar · ${new Date(st.snapshot.generated).toLocaleString()}`
      : "none published yet";
  }

  const el = $("[data-sl-adm-if-run]");
  const btn = $("[data-sl-adm-if-collect]");
  if (btn) btn.disabled = !!st.running;
  if (el) {
    if (st.running) {
      // Past ~40 min the run is not on the normal ~20 min path any more, which
      // almost always means an account is rate-limited or banned. Say so rather
      // than let the counter tick up silently.
      const mins = st.elapsedSec == null ? null : Math.floor(st.elapsedSec / 60);
      const late = mins != null && mins > 40;
      el.textContent = mins == null
        ? "collecting… · safe to close the page"
        : `collecting… ${mins}m` + (late
          ? " · longer than usual, an X account is probably throttled"
          : " of ~20m · safe to close the page");
      el.style.color = late ? "var(--red)" : "var(--gold-mid)";
      el.style.color = "var(--gold-mid)";
    } else {
      el.textContent = "";
    }
  }

  clearTimeout(ifPoll);
  if (st.running) ifPoll = setTimeout(ifRefreshStatus, 5000);
}

function bindInfofi() {
  // Own toast: the one in bindActions is scoped INSIDE pokerWithdraw, so
  // reaching for it from here is a ReferenceError.
  const toast = (m, kind = "error") => import("./ui.js").then(({ toast: t }) => t(m, { kind, ttl: 6000 }));
  if (!$("[data-sl-adm-if-list]")) return;
  document.querySelectorAll("[data-sl-adm-if-list]").forEach((b) => {
    b.addEventListener("click", () => {
      ifList = b.getAttribute("data-sl-adm-if-list");
      ifStatus("");
      ifPaint();
    });
  });
  const run = async (action) => {
    const handle = ($("[data-sl-adm-if-handle]")?.value || "").trim().replace(/^@/, "");
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
      return ifStatus("handle must be 1-15 of A-Z a-z 0-9 _", "error");
    }
    try {
      await connect();
      if (!SL.signer) return ifStatus("connect a wallet first", "error");
      const ts = Math.floor(Date.now() / 1000);
      // Must match scripts/infofi-admin.js signMessage() byte for byte.
      const message = [
        "ShinyLuck InfoFi admin",
        `action: ${action}`,
        `list: ${ifList}`,
        `handle: ${handle}`,
        `ts: ${ts}`,
      ].join("\n");
      ifStatus("sign the request in your wallet…");
      const signature = await SL.signer.signMessage(message);
      const r = await fetch(IF_API + "/edit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, list: ifList, handle, ts, signature }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        ifStatus(body.error || `HTTP ${r.status}`, "error");
        return;
      }
      if (body.lists) ifCache = { ...(ifCache || {}), ...body.lists };
      ifPaint();
      if (body.changed) {
        ifStatus(`@${handle} ${action === "add" ? "added to" : "removed from"} ${IF_LABEL[ifList]}`, "success");
        toast(`@${handle} ${action === "add" ? "added" : "removed"} · applies on the next daily collection`, "success");
      } else {
        ifStatus(body.reason || "no change", "warn");
      }
    } catch (e) {
      // A user closing the signature prompt is not an error worth shouting about.
      const m = e.shortMessage || e.message || String(e);
      ifStatus(/reject|denied|4001/i.test(m) ? "signature cancelled" : m, /reject|denied|4001/i.test(m) ? "warn" : "error");
    }
  };
  $("[data-sl-adm-if-add]")?.addEventListener("click", () => run("add"));
  $("[data-sl-adm-if-remove]")?.addEventListener("click", () => run("remove"));

  $("[data-sl-adm-if-collect]")?.addEventListener("click", async () => {
    try {
      await connect();
      if (!SL.signer) return ifStatus("connect a wallet first", "error");
      const ts = Math.floor(Date.now() / 1000);
      // Same five-line shape as an edit, with placeholders in the unused slots,
      // so a collect signature can never be replayed as a list change.
      const message = [
        "ShinyLuck InfoFi admin",
        "action: collect",
        "list: -",
        "handle: -",
        `ts: ${ts}`,
      ].join("\n");
      ifStatus("sign the request in your wallet…");
      const signature = await SL.signer.signMessage(message);
      const r = await fetch(IF_API + "/collect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ts, signature }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.status === 409) ifStatus("a collection is already running", "warn");
      else if (!r.ok) ifStatus(body.error || `HTTP ${r.status}`, "error");
      else {
        ifStatus("collection started", "success");
        toast("Collection started · 15-25 min, the board updates when it finishes", "success");
      }
      ifRefreshStatus();
    } catch (e) {
      const m = e.shortMessage || e.message || String(e);
      const cancelled = /reject|denied|4001/i.test(m);
      ifStatus(cancelled ? "signature cancelled" : m, cancelled ? "warn" : "error");
    }
  });

  refreshInfofi();
}

async function refreshAll() {
  await gateAccess();
  if (!isOwner && !isPokerOwner && !isPredOwner) return;
  await Promise.all([refreshPoker().catch(() => {}), refreshPredictions().catch(() => {})].concat(
    isOwner ? [refreshTreasury(), refreshBonus(), refreshGames(), refreshWindows(), refreshReasoning(), refreshAgents(), refreshStats()] : [],
  ));
}

document.addEventListener("DOMContentLoaded", () => {
  bindActions();
  refreshAll().catch((e) => console.warn("[admin] init:", e.message));
  document.addEventListener("shinyluck:connected", () => refreshAll().catch(() => {}));
  setInterval(() => refreshAll().catch(() => {}), 15_000);
});
