// Player-agent management page wiring.
//
// Two-step register flow:
//   1. "Get quote" → POST /quote with the NL strategy. agent-service routes it
//      to the Somnia LLM Inference Agent (if SOMNIA_LLM_URL is set) for a
//      complexity rating + suggested daily cap + reasoning text. The price
//      (in STT) is paid as part of registerAgent.
//   2. "Accept & register" → on-chain registerAgent + signed POST /strategies
//      to the service so the executor begins ticking.
//
// Active agent dashboard:
//   - state (ACTIVE / PAUSED), vault address + balance, daily/total spent
//   - recent bets executed FROM the vault (events with player == vault)
//   - cumulative P&L across the vault's BetSettled events
//   - controls: pause / resume / fund vault / withdraw vault

import { ethers } from "https://esm.sh/ethers@6.13.2";
import { SL, connect, shortAddr } from "./wallet.js";
import { CONFIG } from "./config.js";
import { provider, fetchRecentLogs } from "./rpc.js";

let _serviceOnline = null;
let _offlineLogged = false;
async function probeService() {
  if (_serviceOnline !== null) return _serviceOnline;
  if (!CONFIG.agentServiceUrl) { _serviceOnline = false; return false; }
  try {
    const r = await fetch(`${CONFIG.agentServiceUrl}/health`, { method: "GET" });
    _serviceOnline = r.ok;
  } catch (_) { _serviceOnline = false; }
  if (!_serviceOnline && !_offlineLogged) {
    console.info(`[agent] service at ${CONFIG.agentServiceUrl} is offline.`);
    _offlineLogged = true;
  }
  return _serviceOnline;
}
async function agentFetch(path, init) {
  const ok = await probeService();
  if (!ok) return null;
  try { return await fetch(`${CONFIG.agentServiceUrl}${path}`, init); }
  catch (_) {
    _serviceOnline = false;
    if (!_offlineLogged) { console.info(`[agent] service went offline mid-session.`); _offlineLogged = true; }
    return null;
  }
}

const VAULT_ABI = [
  "function balance() view returns (uint256)",
  "function withdrawAll() external",
  "function withdrawToPlayer(uint256 amount) external",
];
const CASINO_EVENTS_ABI = [
  "event BetPlaced(uint256 indexed betId,address indexed player,uint8 indexed game,uint256 amount,bytes32 clientSeed,uint256 commitBlock,uint256 seedIdx,bytes params)",
  "event BetSettled(uint256 indexed betId,address indexed player,uint8 indexed game,bool won,uint256 payout,bytes32 randomness,bytes32 serverSeed,bytes32 clientSeed,bytes32 blockHash,uint256 nonce,bytes resultData)",
];

let vaultAddr = null;
let pendingQuote = null;     // { priceSTT, reasoning, complexity }

const GAME_NAMES = ["DICE","CRASH","SLOTS","MINES","PLINKO","ROULETTE"];

function val(sel) { return document.querySelector(sel)?.value || ""; }
function $(sel) { return document.querySelector(sel); }

function gameMaskFromCheckboxes() {
  let m = 0;
  document.querySelectorAll('[data-sl-game]:checked').forEach((cb) => {
    m |= 1 << parseInt(cb.value, 10);
  });
  return m;
}

async function refreshAgentState() {
  const statusEl = $("[data-sl-agent-status]");
  const summaryEl = $("[data-sl-agent-summary]");
  if (!SL.address) {
    statusEl.textContent = "WALLET NOT CONNECTED";
    if (summaryEl) summaryEl.textContent = "Connect wallet to manage your agent";
    return;
  }
  try {
    const perm = await SL.registry.getPermission(SL.address);
    if (perm.player === "0x0000000000000000000000000000000000000000") {
      statusEl.textContent = "NOT REGISTERED";
      $("[data-sl-agent-vault]").textContent = "—";
      $("[data-sl-agent-today]").textContent = "—";
      $("[data-sl-agent-total]").textContent = "—";
      if (summaryEl) summaryEl.textContent = `Connected as ${SL.address.slice(0,6)}…${SL.address.slice(-4)} — register an agent to begin`;
      return;
    }
    vaultAddr = perm.vault;
    statusEl.textContent = perm.active ? "ACTIVE" : "PAUSED";
    statusEl.style.color = perm.active ? "var(--green)" : "var(--amber)";
    if (summaryEl) summaryEl.textContent = `Agent ${perm.active ? "running" : "paused"} · vault ${perm.vault.slice(0,6)}…${perm.vault.slice(-4)}`;
    $("[data-sl-agent-vault]").textContent = shortAddr(perm.vault);
    $("[data-sl-agent-today]").textContent =
      ethers.formatEther(perm.spentToday) + " / " + ethers.formatEther(perm.dailyLimit) + " STT";
    $("[data-sl-agent-total]").textContent =
      ethers.formatEther(perm.spentTotal) + " / " + ethers.formatEther(perm.totalLimit) + " STT";
    const vault = new ethers.Contract(perm.vault, VAULT_ABI, provider());
    const bal = await vault.balance();
    $("[data-sl-vault-balance]").textContent = ethers.formatEther(bal) + " STT";
    refreshVaultBets(perm.vault).catch(() => {});
  } catch (e) {
    console.error("[agent] state refresh failed:", e);
  }
}

async function refreshVaultBets(vault) {
  const root = $("[data-sl-agent-bets]");
  if (!root) return;
  try {
    const casino = new ethers.Contract(CONFIG.casino, CASINO_EVENTS_ABI, provider());
    const settled = await fetchRecentLogs(casino, "BetSettled", {
      minCount: 15, maxLookback: 100_000,
      filter: (ev) => ev.args.player.toLowerCase() === vault.toLowerCase(),
    });
    if (settled.length === 0) {
      root.innerHTML = `<div class="m" style="opacity:.4;">no bets yet</div>`;
      $("[data-sl-agent-pnl]").textContent = "0 STT";
      return;
    }
    // Pull placed events to get stakes (parallel to BetSettled).
    const placed = await fetchRecentLogs(casino, "BetPlaced", {
      minCount: 15, maxLookback: 100_000,
      filter: (ev) => ev.args.player.toLowerCase() === vault.toLowerCase(),
    });
    const stakeByBet = new Map();
    for (const ev of placed) stakeByBet.set(ev.args.betId.toString(), ev.args.amount);
    let pnl = 0n;
    root.innerHTML = "";
    for (const ev of settled.slice(0, 15)) {
      const game = GAME_NAMES[Number(ev.args.game)] || "?";
      const stake = BigInt(stakeByBet.get(ev.args.betId.toString()) || 0n);
      const payout = BigInt(ev.args.payout);
      pnl += ev.args.won ? (payout - stake) : -stake;
      const row = document.createElement("div");
      row.style.cssText = "display:flex; justify-content:space-between; font-size:11px; font-family: var(--mono); padding: 3px 0;";
      const sign = ev.args.won ? "+" : "−";
      const color = ev.args.won ? "var(--green)" : "var(--red)";
      const delta = ev.args.won ? (payout - stake) : stake;
      row.innerHTML = `<span>#${ev.args.betId} ${game}</span><span>${ethers.formatEther(stake)} STT</span><span style="color:${color};">${sign} ${ethers.formatEther(delta)}</span>`;
      root.appendChild(row);
    }
    $("[data-sl-agent-pnl]").textContent =
      (pnl >= 0n ? "+ " : "− ") + ethers.formatEther(pnl < 0n ? -pnl : pnl) + " STT";
    $("[data-sl-agent-pnl]").style.color = pnl >= 0n ? "var(--green)" : "var(--red)";
  } catch (e) { console.warn("[agent] vault bets:", e.message); }
}

async function fetchLogs() {
  if (!SL.address) return;
  const r = await agentFetch(`/logs/${SL.address}?limit=50`);
  const root = $("[data-sl-agent-log]");
  if (!root) return;
  if (!r) {
    root.innerHTML = '<div style="opacity:.4;">// agent service offline — start it locally: <code>cd agent-service && npm run api</code></div>';
    return;
  }
  if (!r.ok) return;
  const logs = await r.json();
  root.innerHTML = logs.length === 0
    ? '<div style="opacity:.4;">// no entries yet</div>'
    : logs.map((l) => {
        const dt = new Date(l.ts).toISOString().slice(11, 19);
        const meta = Object.entries(l).filter(([k]) => !["ts","kind","player"].includes(k))
          .map(([k,v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(" ");
        return `<div>${dt} <span style="color:var(--cyan);">${l.kind}</span> <span style="color:var(--fg-mute);">${meta}</span></div>`;
      }).join("");
}

async function onGetQuote() {
  const btn = $("[data-sl-quote]");
  if (!btn) return;
  btn.disabled = true; btn.textContent = "Asking agents…";
  try {
    const raw = val("[data-sl-strategy]").trim();
    if (!raw) throw new Error("strategy text is empty");
    const r = await agentFetch(`/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    if (!r) {
      // service offline → synthesize a local quote so the user can still register
      pendingQuote = { priceSTT: "0", complexity: 1, reasoning: "agent-service offline; registering at zero fee (local fallback)." };
    } else if (!r.ok) {
      throw new Error(await r.text());
    } else {
      pendingQuote = await r.json();
    }
    const box = $("[data-sl-quote-box]");
    if (box) {
      box.style.display = "block";
      box.innerHTML = `
        <div style="color:var(--cyan); margin-bottom:4px;">QUOTE</div>
        <div>price: <b>${pendingQuote.priceSTT} STT</b> · complexity: <b>${pendingQuote.complexity}/5</b></div>
        <div style="color:var(--fg-mute); font-size:11px; margin-top:6px;">${pendingQuote.reasoning || ""}</div>
      `;
    }
    btn.textContent = "Refresh quote";
    const reg = $("[data-sl-register]");
    if (reg) { reg.disabled = false; reg.textContent = "Accept & register"; }
  } catch (e) {
    btn.textContent = "Error: " + (e.message || e);
    pendingQuote = null;
  } finally {
    btn.disabled = false;
  }
}

async function onRegister() {
  const btn = $("[data-sl-register]");
  if (!btn) return;
  try {
    btn.disabled = true; btn.textContent = "Connecting…";
    await connect();
    if (!pendingQuote) { btn.textContent = "Get a quote first"; return; }
    const raw = val("[data-sl-strategy]").trim();
    const daily = ethers.parseEther(val("[data-sl-daily]") || "0");
    const total = ethers.parseEther(val("[data-sl-total]") || "0");
    const mask = gameMaskFromCheckboxes();
    if (mask === 0) throw new Error("pick at least one game");
    btn.textContent = "Hashing strategy…";
    const stratHash = ethers.keccak256(ethers.toUtf8Bytes(raw));
    btn.textContent = "On-chain register…";
    const value = ethers.parseEther(String(pendingQuote.priceSTT || "0"));
    const tx = await SL.registry.registerAgent(stratHash, daily, total, mask, { value });
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => { try { return SL.registry.interface.parseLog(l); } catch { return null; } })
                     .find((p) => p && p.name === "AgentRegistered");
    const vault = ev?.args?.vault;
    vaultAddr = vault;
    btn.textContent = "Saving strategy…";
    const message = JSON.stringify({ raw, vault });
    const signature = await SL.signer.signMessage(message);
    await agentFetch(`/strategies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ player: SL.address, vault, raw, signature }),
    });
    btn.textContent = "Registered";
    pendingQuote = null;
    const box = $("[data-sl-quote-box]"); if (box) box.style.display = "none";
    refreshAgentState();
  } catch (e) {
    btn.textContent = "Error: " + (e.shortMessage || e.message);
  } finally {
    setTimeout(() => { btn.disabled = false; if (btn.textContent.startsWith("Error")) return; btn.textContent = "Accept & register"; }, 2500);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  // Initial paint — refreshAgentState renders the "connect wallet" state if
  // not yet connected, and the real dashboard if we already got an auto-connect
  // from wallet.js (whose event we might miss due to listener-ordering).
  refreshAgentState().catch(() => {});
  fetchLogs().catch(() => {});
  document.addEventListener("shinyluck:connected", () => { refreshAgentState(); fetchLogs(); });
  setInterval(() => { refreshAgentState().catch(() => {}); fetchLogs().catch(() => {}); }, 15_000);

  $("[data-sl-quote]")?.addEventListener("click", onGetQuote);
  $("[data-sl-register]")?.addEventListener("click", onRegister);

  $("[data-sl-pause]")?.addEventListener("click", async () => {
    await connect();
    const tx = await SL.registry.pauseAgent(); await tx.wait();
    await agentFetch(`/strategies/${SL.address}/pause`, { method: "POST" });
    refreshAgentState();
  });
  $("[data-sl-resume]")?.addEventListener("click", async () => {
    await connect();
    const tx = await SL.registry.resumeAgent(); await tx.wait();
    await agentFetch(`/strategies/${SL.address}/resume`, { method: "POST" });
    refreshAgentState();
  });
  $("[data-sl-fund-vault]")?.addEventListener("click", async () => {
    const { promptDialog, toast } = await import("./ui.js");
    await connect();
    if (!vaultAddr) { toast("Register your agent first", { kind: "warn" }); return; }
    const amt = await promptDialog("Send STT into your agent's vault — the agent can spend up to your daily limit.", {
      title: "Fund vault", initial: "0.5", placeholder: "0.0",
    });
    if (!amt) return;
    try {
      const tx = await SL.signer.sendTransaction({ to: vaultAddr, value: ethers.parseEther(amt) });
      toast(`Funding tx submitted (${tx.hash.slice(0,10)}…)`, { kind: "info" });
      await tx.wait();
      toast(`Vault funded with ${amt} STT`, { kind: "success" });
      refreshAgentState();
    } catch (e) { toast(e.shortMessage || e.message, { kind: "error", ttl: 6000 }); }
  });
  $("[data-sl-withdraw-vault]")?.addEventListener("click", async () => {
    const { toast } = await import("./ui.js");
    await connect();
    if (!vaultAddr) { toast("No vault to withdraw from", { kind: "warn" }); return; }
    try {
      const vault = new ethers.Contract(vaultAddr, VAULT_ABI, SL.signer);
      const tx = await vault.withdrawAll();
      toast(`Withdraw tx submitted`, { kind: "info" });
      await tx.wait();
      toast(`Vault withdrawn to your wallet`, { kind: "success" });
      refreshAgentState();
    } catch (e) { toast(e.shortMessage || e.message, { kind: "error", ttl: 6000 }); }
  });
});
