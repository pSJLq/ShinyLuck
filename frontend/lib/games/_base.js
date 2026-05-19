// Shared utilities for the per-game integration modules.
// Every game (dice, crash, slots, mines, plinko, roulette) reuses:
//   - pollForSettle(betId)            : raw eth_getLogs polling for BetSettled / BetRefunded
//   - setStagePill(state, label)      : top-of-stage status pill
//   - setResultBanner({won, ...})     : right-panel coloured banner with explorer tx-link
//   - clearResultBanner / clearFairServer
//   - populateFairPanel(...)          : bet id, client/server seed, explorer link
//   - refreshFairFromPlayer(gameId)   : pre-fill provably-fair from player's last settled bet
//   - refreshRecentEvents({...})      : last 9 events for the current game, custom decoder per call
//   - explorerTxUrl / explorerAddrUrl
//   - DOM helpers ($, $$, setText)

import { ethers } from "https://esm.sh/ethers@6.13.2";
import { SL } from "../wallet.js";
import { CONFIG } from "../config.js";
import { CHAINS } from "../shinyluck-sdk.js";
import { provider, wsProvider, fetchRecentLogs } from "../rpc.js";
import { friendlyError } from "../errors.js";

export { friendlyError };

export const ZERO = "0x0000000000000000000000000000000000000000";
// Drop poll cadence — fast settle was bottlenecked here, not on-chain.
// Frontend now subscribes to WS first; this fallback fires every 750ms.
export const SETTLE_POLL_MS = 750;
export const SETTLE_TIMEOUT_MS = 5 * 60 * 1000;

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => root.querySelectorAll(sel);

export function fmtSTT(wei, dp) {
  if (typeof wei !== "bigint") wei = BigInt(wei);
  const eth = Number(ethers.formatEther(wei));
  if (dp != null) return eth.toFixed(dp);
  if (eth >= 1000) return eth.toFixed(0);
  if (eth >= 1) return eth.toFixed(2);
  if (eth >= 0.01) return eth.toFixed(3);
  return eth.toFixed(4);
}
export function fmtSTTfromString(stt) {
  const n = parseFloat(stt);
  if (Number.isNaN(n) || n <= 0) return "0";
  return n.toFixed(n >= 1 ? 2 : 4);
}
export function setText(sel, value) {
  $$(sel).forEach((el) => { el.textContent = value; });
}
export function explorerTxUrl(hash) {
  const net = CHAINS[CONFIG.network] || CHAINS.somniaTestnet;
  const base = net.blockExplorerUrls[0].replace(/\/$/, "");
  return `${base}/tx/${hash}`;
}

export function casinoRO() {
  if (casinoRO._c) return casinoRO._c;
  const abi = [
    "event BetPlaced(uint256 indexed betId,address indexed player,uint8 indexed game,uint256 amount,bytes32 clientSeed,uint256 commitBlock,uint256 seedIdx,bytes params)",
    "event BetSettled(uint256 indexed betId,address indexed player,uint8 indexed game,bool won,uint256 payout,bytes32 randomness,bytes32 serverSeed,bytes32 clientSeed,bytes32 blockHash,uint256 nonce,bytes resultData)",
    "event BetRefunded(uint256 indexed betId,address indexed player,uint256 amount,string reason)",
    "event MinesCellOpened(uint256 indexed betId,uint8 cellIdx,uint32 openedBitmap,uint256 multiplierX100)",
    "event MinesBust(uint256 indexed betId,uint8 cellIdx,uint32 minesBitmap)",
    "event MinesCashout(uint256 indexed betId,uint8 cellsOpened,uint256 payout,uint256 multiplierX100)",
    "event MinesSeedRevealed(uint256 indexed betId,uint32 minesBitmap)",
    "function minesState(uint256) view returns (uint8 mineCount,uint32 openedBitmap,uint32 minesBitmap,bool seedRevealed,bool busted)",
  ];
  casinoRO._c = new ethers.Contract(CONFIG.casino, abi, provider());
  return casinoRO._c;
}

// ---------------------------------------------------------------------
// stage pill / result banner
// ---------------------------------------------------------------------

export function setStagePill(state, label, root = document) {
  const pill = root.querySelector("[data-sl-stage-pill]");
  if (!pill) return;
  pill.classList.remove("ready", "live", "won", "lost");
  if (state) pill.classList.add(state);
  pill.innerHTML = `<span class="dot"></span> ${label}`;
}

export function setResultBanner({ won, txt, txHash, accent }) {
  const el = $("[data-sl-result-banner]");
  if (!el) return;
  el.style.display = "block";
  const color = accent || (won ? "#16a34a" : "#dc2626");
  el.style.borderLeftColor = color;
  el.style.color = color;
  const link = txHash
    ? ` · <a href="${explorerTxUrl(txHash)}" target="_blank" rel="noopener" style="color:inherit; text-decoration:underline;">view tx ↗</a>`
    : "";
  el.innerHTML = txt + link;
}

export function clearResultBanner() {
  const el = $("[data-sl-result-banner]");
  if (el) { el.style.display = "none"; el.innerHTML = ""; }
}

// ---------------------------------------------------------------------
// provably fair panel
// ---------------------------------------------------------------------

export function populateFairPanel({ clientSeed, betId, nonce, serverSeed, txHash }) {
  if (clientSeed) setText("[data-sl-fairclient]", clientSeed);
  if (betId !== undefined && nonce !== undefined) {
    setText("[data-sl-fairnonce]", `betId ${betId} · nonce ${nonce}`);
  }
  if (serverSeed && serverSeed !== ethers.ZeroHash) {
    setText("[data-sl-fairserver]", serverSeed);
  }
  if (txHash) {
    const link = $("[data-sl-explorer-link]");
    if (link) {
      link.href = explorerTxUrl(txHash);
      link.style.display = "block";
    }
  }
}

export function clearFairServer() {
  setText("[data-sl-fairserver]", "—");
  const link = $("[data-sl-explorer-link]");
  if (link) link.style.display = "none";
}

/// Pre-fill the fair panel from the player's last settled bet for `gameId`.
export async function refreshFairFromPlayer(gameId) {
  if (!SL.address || CONFIG.casino === ZERO) return;
  const c = casinoRO();
  const events = await fetchRecentLogs(c, "BetSettled", {
    minCount: 1,
    filter: (ev) => ev.args.player.toLowerCase() === SL.address.toLowerCase()
                 && Number(ev.args.game) === gameId,
  });
  if (events.length === 0) return;
  const ev = events[0];
  populateFairPanel({
    clientSeed: ev.args.clientSeed,
    betId: ev.args.betId,
    nonce: ev.args.nonce,
    serverSeed: ev.args.serverSeed,
    txHash: ev.transactionHash,
  });
}

// ---------------------------------------------------------------------
// Settle polling — waits for BetSettled or BetRefunded for `betId`.
// ---------------------------------------------------------------------

export async function pollForSettle(betId) {
  const c = casinoRO();
  const wantId = betId.toString();
  let resolved = null;

  // Fast path: WebSocket subscription. Pushes a notification within ~100ms
  // of the settle tx being mined. Polling fallback below catches missed
  // events if the WS silently drops.
  const ws = wsProvider();
  let wsSettled = null, wsRefunded = null;
  if (ws) {
    try {
      const settledTopic = c.interface.getEvent("BetSettled").topicHash;
      const refundedTopic = c.interface.getEvent("BetRefunded").topicHash;
      const onSettled = (log) => {
        try {
          const p = c.interface.parseLog(log);
          if (p.args.betId.toString() === wantId) {
            wsSettled = { name: "BetSettled", args: p.args, transactionHash: log.transactionHash, blockNumber: log.blockNumber };
            resolved = wsSettled;
          }
        } catch (_) {}
      };
      const onRefunded = (log) => {
        try {
          const p = c.interface.parseLog(log);
          if (p.args.betId.toString() === wantId) {
            wsRefunded = { refunded: true, args: p.args, transactionHash: log.transactionHash };
            resolved = wsRefunded;
          }
        } catch (_) {}
      };
      ws.on({ address: CONFIG.casino, topics: [settledTopic] },  onSettled);
      ws.on({ address: CONFIG.casino, topics: [refundedTopic] }, onRefunded);
      // schedule a tear-down hook on a Promise we race
      var unsubscribeWs = () => {
        try { ws.off({ address: CONFIG.casino, topics: [settledTopic] },  onSettled); } catch (_) {}
        try { ws.off({ address: CONFIG.casino, topics: [refundedTopic] }, onRefunded); } catch (_) {}
      };
    } catch (e) {
      console.warn("[base] settle WS subscribe failed, polling only:", e.message);
    }
  }

  const start = Date.now();
  // Tight initial polling — first check immediately (no startup delay), then
  // every SETTLE_POLL_MS (750ms) so total reveal-to-UI latency stays under
  // ~1s once the reveal-bot lands its settle tx.
  let scanFrom = await provider().getBlockNumber();
  // Initial check before sleeping — in case settle already happened during
  // the placement round-trip (Sequence + chain mining).
  try {
    const back = await fetchRecentLogs(c, "BetSettled", {
      minCount: 1, maxLookback: 30,
      filter: (ev) => ev.args.betId.toString() === wantId,
    });
    if (back.length > 0) { if (unsubscribeWs) unsubscribeWs(); return back[0]; }
  } catch (_) {}

  while (Date.now() - start < SETTLE_TIMEOUT_MS) {
    if (resolved) { if (unsubscribeWs) unsubscribeWs(); return resolved; }
    await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
    if (resolved) { if (unsubscribeWs) unsubscribeWs(); return resolved; }
    let head;
    try { head = await provider().getBlockNumber(); } catch { continue; }
    if (head < scanFrom) continue;
    try {
      const settled = await fetchRecentLogs(c, "BetSettled", {
        minCount: 1,
        maxLookback: head - scanFrom + 2,
        filter: (ev) => ev.args.betId.toString() === wantId,
      });
      if (settled.length > 0) { if (unsubscribeWs) unsubscribeWs(); return settled[0]; }
    } catch (e) {
      console.warn("[base] settle poll BetSettled:", e.message);
    }
    try {
      const refunds = await fetchRecentLogs(c, "BetRefunded", {
        minCount: 1,
        maxLookback: head - scanFrom + 2,
        filter: (ev) => ev.args.betId.toString() === wantId,
      });
      if (refunds.length > 0) {
        if (unsubscribeWs) unsubscribeWs();
        return { refunded: true, args: refunds[0].args, transactionHash: refunds[0].transactionHash };
      }
    } catch (_) {}
    scanFrom = head + 1;
  }
  if (unsubscribeWs) unsubscribeWs();
  return null;
}

// ---------------------------------------------------------------------
// Recent events strip (last N for a given game) — caller provides the
// label/className decoder for each event.
// ---------------------------------------------------------------------

export async function refreshRecentEvents({
  containerSelector,
  gameId,
  limit = 9,
  decode,                       // (ev) → { label, won, isLatest } where ev.args has BetSettled fields
  emptyLabel = "no recent",
  latestBetId = null,
  // 20k blocks ≈ 7 hours on Somnia. Was 200k → cold-start scan 30s+.
  maxLookback = 20_000,
}) {
  const root = document.querySelector(containerSelector);
  if (!root) return;
  if (CONFIG.casino === ZERO) return;
  const c = casinoRO();
  const events = await fetchRecentLogs(c, "BetSettled", {
    minCount: limit,
    maxLookback,
    filter: (ev) => Number(ev.args.game) === gameId,
  });
  root.innerHTML = "";
  if (events.length === 0) {
    root.innerHTML = `<span class="m" style="opacity:.4;">${emptyLabel}</span>`;
    return;
  }
  for (const ev of events.slice(0, limit)) {
    const isLatest = latestBetId !== null && ev.args.betId.toString() === latestBetId.toString();
    const decoded = decode(ev);
    const span = document.createElement("span");
    span.className = "m " + (decoded.won ? "win" : "bust") + (isLatest ? " huge" : "");
    span.textContent = decoded.label;
    if (isLatest) {
      span.style.outline = "1px solid var(--cyan)";
      span.style.outlineOffset = "1px";
    }
    root.appendChild(span);
  }
}

export function readStakeStr() {
  const el = $("[data-sl-stake]");
  if (!el) return "0";
  return (el.value || el.textContent || "0").replace(/[^\d.]/g, "");
}

// ---------------------------------------------------------------------
// Expected-value row helper (Section 6)
//
// Casino is transparent about its math: every game page renders the
// per-bet expected value alongside the upside in STT + %. Most casinos
// hide this — we surface it as a feature.
//
//   ev_per_bet = − stake × houseEdge
//
// `houseEdgeBps` is read once from the contract on connect/boot; until
// then we use the labelled defaults (Dice 1%, Crash 3%, Slots 5.3%,
// Mines 1.2%, Plinko 1.5%, Roulette 2.7%).
// ---------------------------------------------------------------------

const HOUSE_EDGE_DEFAULT_BPS = [100, 300, 530, 120, 150, 270];

let _houseEdgeCache = null;
async function getHouseEdgeBps(gameId) {
  if (!_houseEdgeCache) _houseEdgeCache = new Map();
  if (_houseEdgeCache.has(gameId)) return _houseEdgeCache.get(gameId);
  if (CONFIG.casino === ZERO) return HOUSE_EDGE_DEFAULT_BPS[gameId];
  try {
    const abi = ["function houseEdgeBps(uint8) view returns (uint256)"];
    const c = new ethers.Contract(CONFIG.casino, abi, provider());
    const bps = await c.houseEdgeBps(gameId);
    const n = Number(bps);
    _houseEdgeCache.set(gameId, n);
    return n;
  } catch (_) {
    return HOUSE_EDGE_DEFAULT_BPS[gameId];
  }
}

export async function refreshEV(gameId) {
  const stakeNum = parseFloat(readStakeStr()) || 0;
  const bps = await getHouseEdgeBps(gameId);
  const evSTT = -stakeNum * (bps / 10000);
  const pct = bps / 100;
  const text = (evSTT === 0 ? "0.0000" : evSTT.toFixed(4)) + " STT (−" + pct.toFixed(2) + "%)";
  document.querySelectorAll("[data-sl-ev]").forEach((el) => { el.textContent = text; });
  document.querySelectorAll("[data-sl-ev-pct]").forEach((el) => { el.textContent = "−" + pct.toFixed(2) + "%"; });
  return { evSTT, bps };
}

// CSS keyframes used by all game pages — injected once.
export function injectKeyframes() {
  if (document.getElementById("sl-game-kf")) return;
  const s = document.createElement("style");
  s.id = "sl-game-kf";
  s.textContent = `
    @keyframes dice-shake {
      0%   { transform: rotate(0) translateX(0); }
      25%  { transform: rotate(-6deg) translateX(-2px); }
      50%  { transform: rotate(0) translateY(-3px); }
      75%  { transform: rotate(6deg) translateX(2px); }
      100% { transform: rotate(0) translateX(0); }
    }
    @keyframes reel-spin {
      0%   { transform: translateY(0); }
      100% { transform: translateY(-200%); }
    }
    @keyframes wheel-spin {
      0%   { transform: rotate(0deg); }
      100% { transform: rotate(720deg); }
    }
    @keyframes tile-flash-safe {
      0%   { transform: scale(1); background: rgba(34,211,238, 0.45); }
      50%  { transform: scale(1.10); background: rgba(34,211,238, 0.25); }
      100% { transform: scale(1); background: rgba(34,211,238, 0.18); }
    }
    @keyframes tile-flash-bomb {
      0%   { transform: scale(1) rotate(0); background: rgba(220,38,38, 0.55); }
      25%  { transform: scale(1.18) rotate(-6deg); }
      50%  { transform: scale(1) rotate(6deg); background: rgba(220,38,38, 0.30); }
      75%  { transform: scale(1.05) rotate(-3deg); }
      100% { transform: scale(1) rotate(0); background: rgba(220,38,38, 0.18); }
    }
    @keyframes mines-shake {
      0%, 100% { transform: translateX(0); }
      20%      { transform: translateX(-6px); }
      40%      { transform: translateX(6px); }
      60%      { transform: translateX(-4px); }
      80%      { transform: translateX(4px); }
    }
    .tile-anim-safe { animation: tile-flash-safe 0.45s ease-out; }
    .tile-anim-bomb { animation: tile-flash-bomb 0.6s ease-out; }
    .mines-anim-shake { animation: mines-shake 0.55s ease-out; }
  `;
  document.head.appendChild(s);
}
