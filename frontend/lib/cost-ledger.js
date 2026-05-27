// Cost ledger widget for the lobby [03] agent section.
//
// Aggregates the last 24 hours of *Requested events emitted by HouseManager
// and AgentQuorumVerifier, prices each one using the live quoteLlmCost /
// quoteJsonCost values from HouseManager, and renders a single panel with:
//
//   - total STT spent on agent calls (sum of all per-request deposits)
//   - total number of calls
//   - average cost per call
//   - HM runway (= HM balance / per-day spend rate)
//   - breakdown row per category with a proportional bar
//
// Every aggregated row is a clickable link into the public Somnia agent
// platform receipts explorer. Live updates flow in via the same WS
// subscription used by agent-activity.js (BetSettled etc), so the widget
// updates within ~1s of each new agent invocation.

import { ethers } from "/vendor/ethers.bundle.js";
import { CONFIG } from "./config.js";
import { provider, wsProvider, fetchLogs, fetchDeploymentBlock } from "./rpc.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
// On Somnia testnet, blocks are ~0.4s. 24h ≈ 216,000 blocks. We use a slightly
// padded floor so re-org noise near "now - 24h" doesn't drop events.
const ONE_DAY_BLOCKS = 220_000n;

// Per-event cost categories. The Somnia Agent Platform charges
//   pricePerWorker × subSize + reserve   per createRequest call.
// We read the active config from HouseManager via quoteLlmCost / quoteJsonCost
// in fetchPricing() so this stays accurate even if the operator tunes pricing.
const PRICING_DEFAULTS = {
  llm:  ethers.parseEther("0.24"), // 0.07 × 3 workers + 0.03 reserve
  json: ethers.parseEther("0.12"), // 0.03 × 3 workers + 0.03 reserve
};

// Event → category. Matches the four ways our contracts spend on agent calls:
//   - HM RtpAnalysisRequested        → LLM Inference Agent (the showpiece)
//   - HM CompetitorRtpRequested      → JSON API Agent
//   - HM PlayerDecisionRequested     → LLM Inference Agent (per-user dispatch)
//   - AgentQuorumVerifier quorum req → LLM Inference Agent (3-of-4 redundancy)
const CATEGORIES = {
  rtp:      { label: "RTP analysis · LLM",      cls: "r-llm",    agent: "llm" },
  comp:     { label: "Competitor RTP · JSON",   cls: "r-json",   agent: "json" },
  player:   { label: "Player Agents · LLM",     cls: "r-player", agent: "llm" },
  quorum:   { label: "Quorum verify · LLM",     cls: "r-quorum", agent: "llm" },
};

const HM_ABI = [
  "event RtpAnalysisRequested(uint256 indexed requestId, uint8 indexed game, uint16 currentRtpBps, int256 bankrollChangeBps)",
  "event CompetitorRtpRequested(uint256 indexed requestId, uint8 indexed game, string url)",
  "event PlayerDecisionRequested(uint256 indexed requestId, address indexed player, uint256 vaultBalance, uint256 spentTodayWei, uint256 dailyLimitWei)",
  "function quoteLlmCost() view returns (uint256)",
  "function quoteJsonCost() view returns (uint256)",
];
const VERIFIER_ABI = [
  "event QuorumRequested(uint256 indexed betId, uint256 indexed requestId, address indexed requester)",
];

const state = {
  pricing: { ...PRICING_DEFAULTS },
  // requestId (string) → { kind: 'rtp'|'comp'|'player'|'quorum', tsMs, requestId }
  events: new Map(),
  hmBalance: 0n,
};

const $ = (sel) => document.querySelector(sel);

function fmtSttBig(wei, decimals = 2) {
  try {
    const v = Number(ethers.formatEther(wei));
    if (v >= 1000) return v.toFixed(0);
    if (v >= 100)  return v.toFixed(1);
    return v.toFixed(decimals);
  } catch { return "-"; }
}

function receiptHref(requestId) {
  return `https://agents.testnet.somnia.network/receipts/${requestId}`;
}

function categoryFor(eventName) {
  if (eventName === "RtpAnalysisRequested")      return "rtp";
  if (eventName === "CompetitorRtpRequested")    return "comp";
  if (eventName === "PlayerDecisionRequested")   return "player";
  if (eventName === "QuorumRequested")           return "quorum";
  return null;
}

function costFor(cat) {
  const meta = CATEGORIES[cat];
  if (!meta) return 0n;
  return state.pricing[meta.agent] || 0n;
}

async function fetchPricing() {
  if (!CONFIG.houseManager || CONFIG.houseManager === ZERO) return;
  try {
    const hm = new ethers.Contract(CONFIG.houseManager, HM_ABI, provider());
    const [llm, json] = await Promise.all([
      hm.quoteLlmCost().catch(() => 0n),
      hm.quoteJsonCost().catch(() => 0n),
    ]);
    if (llm > 0n)  state.pricing.llm  = llm;
    if (json > 0n) state.pricing.json = json;
  } catch (e) { /* fall back to defaults */ }
}

async function fetchHmBalance() {
  if (!CONFIG.houseManager || CONFIG.houseManager === ZERO) return;
  try {
    state.hmBalance = await provider().getBalance(CONFIG.houseManager);
  } catch (_) { state.hmBalance = 0n; }
}

async function backfill24h() {
  if (!CONFIG.houseManager || CONFIG.houseManager === ZERO) return;
  const p = provider();
  let head;
  try { head = await p.getBlockNumber(); } catch { return; }
  // Anchor scan to deploymentBlock so a freshly-rotated casino doesn't try
  // to read pre-genesis history. Falls back to head - 220k if no manifest.
  let floor = head - Number(ONE_DAY_BLOCKS);
  try {
    const dep = await fetchDeploymentBlock();
    if (dep && dep > floor) floor = dep;
  } catch (_) {}
  if (floor < 0) floor = 0;

  const hm = new ethers.Contract(CONFIG.houseManager, HM_ABI, p);
  const tasks = [
    fetchLogs(hm, "RtpAnalysisRequested",    floor, head).catch(() => []),
    fetchLogs(hm, "CompetitorRtpRequested",  floor, head).catch(() => []),
    fetchLogs(hm, "PlayerDecisionRequested", floor, head).catch(() => []),
  ];
  if (CONFIG.agentVerifier && CONFIG.agentVerifier !== ZERO) {
    const ver = new ethers.Contract(CONFIG.agentVerifier, VERIFIER_ABI, p);
    tasks.push(fetchLogs(ver, "QuorumRequested", floor, head).catch(() => []));
  }
  const results = await Promise.all(tasks);

  // Resolve block timestamps in batch so we can filter to the last 24h
  // precisely (vs the 220k-block approximation).
  const allLogs = results.flat();
  const blockNums = [...new Set(allLogs.map((l) => l.blockNumber))];
  const blockTs = new Map();
  await Promise.all(blockNums.map(async (bn) => {
    try {
      const b = await p.getBlock(bn);
      if (b) blockTs.set(bn, Number(b.timestamp) * 1000);
    } catch (_) {}
  }));

  const cutoff = Date.now() - ONE_DAY_MS;
  for (const log of allLogs) {
    const tsMs = blockTs.get(log.blockNumber);
    if (!tsMs || tsMs < cutoff) continue;
    // fetchLogs returns shape { name, args, blockNumber, transactionHash, logIndex }
    // - the event name is at `log.name`, not log.fragment.name.
    const cat = categoryFor(log.name);
    if (!cat) continue;
    const rid = (log.args && log.args.requestId) ? log.args.requestId.toString() : `${log.transactionHash}-${log.logIndex}`;
    state.events.set(rid, { kind: cat, tsMs, requestId: rid });
  }
}

function pushLive(eventName, args, tsMs) {
  const cat = categoryFor(eventName);
  if (!cat) return;
  const rid = (args && args.requestId) ? args.requestId.toString() : null;
  if (!rid) return;
  if (state.events.has(rid)) return;
  state.events.set(rid, { kind: cat, tsMs: tsMs || Date.now(), requestId: rid });
  render();
}

function pruneOlderThan24h() {
  const cutoff = Date.now() - ONE_DAY_MS;
  for (const [k, v] of state.events) if (v.tsMs < cutoff) state.events.delete(k);
}

function render() {
  pruneOlderThan24h();

  // Sum costs per category.
  const totals = { rtp: 0n, comp: 0n, player: 0n, quorum: 0n };
  const counts = { rtp: 0,  comp: 0,  player: 0,  quorum: 0 };
  let grandTotal = 0n;
  let grandCount = 0;
  for (const e of state.events.values()) {
    const c = costFor(e.kind);
    totals[e.kind]  = (totals[e.kind] || 0n) + c;
    counts[e.kind] += 1;
    grandTotal += c;
    grandCount += 1;
  }

  // Header tiles.
  const totalEl   = $("[data-sl-cost-total]");
  const countEl   = $("[data-sl-cost-count]");
  const avgEl     = $("[data-sl-cost-avg]");
  const runwayEl  = $("[data-sl-cost-runway]");
  const runwayDet = $("[data-sl-cost-runway-detail]");
  const totalUsd  = $("[data-sl-cost-total-usd]");

  if (totalEl)   totalEl.textContent = `${fmtSttBig(grandTotal, 3)} STT`;
  if (countEl)   countEl.textContent = String(grandCount);
  if (avgEl) {
    const avg = grandCount > 0 ? grandTotal / BigInt(grandCount) : 0n;
    avgEl.textContent = `${fmtSttBig(avg, 3)} STT`;
  }
  if (totalUsd) totalUsd.textContent = grandCount > 0
    ? `${grandCount} on-chain receipts ↗`
    : "no events yet";

  // Runway = HM balance / daily-burn rate.
  if (runwayEl) {
    if (grandTotal === 0n || state.hmBalance === 0n) {
      runwayEl.textContent = "-";
      if (runwayDet) runwayDet.textContent = state.hmBalance > 0n
        ? `${fmtSttBig(state.hmBalance, 1)} STT balance`
        : "HM balance unknown";
    } else {
      // grandTotal is the last 24h spend. Days remaining at current rate:
      //   balance / spend24h
      // Float arithmetic via Number is fine here (we're showing one decimal).
      const balNum = Number(ethers.formatEther(state.hmBalance));
      const spendNum = Number(ethers.formatEther(grandTotal));
      const days = spendNum > 0 ? balNum / spendNum : 999;
      const txt = days >= 99 ? "∞" : days >= 10 ? `${days.toFixed(0)} d` : `${days.toFixed(1)} d`;
      runwayEl.textContent = txt;
      if (runwayDet) runwayDet.textContent = `${fmtSttBig(state.hmBalance, 1)} STT balance / ${spendNum.toFixed(2)} STT per day`;
    }
  }

  // Breakdown rows.
  const breakdownEl = $("[data-sl-cost-breakdown]");
  if (!breakdownEl) return;
  if (grandCount === 0) {
    breakdownEl.innerHTML = `<div class="cost-empty">awaiting first 24h of events… check back in a few minutes once the hourly cron fires</div>`;
    return;
  }
  const maxTotal = Object.values(totals).reduce((a, b) => a > b ? a : b, 0n);
  const rows = Object.entries(CATEGORIES).map(([cat, meta]) => {
    const total = totals[cat] || 0n;
    const count = counts[cat] || 0;
    const pct = maxTotal > 0n
      ? Number(total * 1000n / maxTotal) / 10
      : 0;
    // Find the latest requestId for this category - that's what the row's
    // [receipt ↗] anchor deep-links to. Picks the freshest event so a click
    // gives users the most recent receipt (rather than a stale one).
    let latestId = null;
    let latestTs = 0;
    for (const e of state.events.values()) {
      if (e.kind !== cat) continue;
      if (e.tsMs > latestTs) { latestTs = e.tsMs; latestId = e.requestId; }
    }
    const receiptCell = latestId
      ? `<a class="sl-receipt-link" href="${receiptHref(latestId)}" target="_blank" rel="noopener" title="latest ${meta.label} receipt on Somnia explorer">[receipt ↗]</a>`
      : `<span style="opacity:.4; font-size:10px;">no events</span>`;
    return `
      <div class="cost-row ${meta.cls}">
        <div class="cost-row-label">${meta.label}</div>
        <div class="cost-row-bar"><div class="cost-row-bar-fill" style="width:${pct}%"></div></div>
        <div class="cost-row-count">${count} ${count === 1 ? "call" : "calls"}</div>
        <div class="cost-row-amount">${fmtSttBig(total, 2)} STT ${receiptCell}</div>
      </div>
    `;
  }).filter(Boolean).join("");
  breakdownEl.innerHTML = rows;
}

let subscribed = false;
function subscribeLive() {
  if (subscribed) return;
  const ws = wsProvider();
  if (!ws) return;
  if (CONFIG.houseManager && CONFIG.houseManager !== ZERO) {
    const hm = new ethers.Contract(CONFIG.houseManager, HM_ABI, ws);
    const wire = (name) => {
      try {
        hm.on(name, (...args) => {
          const ev = args[args.length - 1];
          const parsedArgs = ev.args || hm.interface.parseLog(ev.log || ev).args;
          pushLive(name, parsedArgs, Date.now());
        });
      } catch (_) {}
    };
    ["RtpAnalysisRequested", "CompetitorRtpRequested", "PlayerDecisionRequested"].forEach(wire);
  }
  if (CONFIG.agentVerifier && CONFIG.agentVerifier !== ZERO) {
    try {
      const ver = new ethers.Contract(CONFIG.agentVerifier, VERIFIER_ABI, ws);
      ver.on("QuorumRequested", (...args) => {
        const ev = args[args.length - 1];
        const parsedArgs = ev.args || ver.interface.parseLog(ev.log || ev).args;
        pushLive("QuorumRequested", parsedArgs, Date.now());
      });
    } catch (_) {}
  }
  subscribed = true;
}

async function boot() {
  const host = $("[data-sl-cost-breakdown]");
  if (!host) return; // widget not on this page

  await Promise.all([fetchPricing(), fetchHmBalance()]);
  await backfill24h();
  render();
  subscribeLive();

  // Refresh HM balance + pricing every 60s so the runway tile stays current
  // even if no new events fire (e.g. quiet hours).
  setInterval(async () => {
    await Promise.all([fetchPricing(), fetchHmBalance()]);
    render();
  }, 60_000);
}

document.addEventListener("DOMContentLoaded", () => {
  // Defer init slightly so the rest of the lobby paint completes first.
  setTimeout(() => boot().catch((e) => console.warn("[cost-ledger] boot:", e.message)), 400);
});
