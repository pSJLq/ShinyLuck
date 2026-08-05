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

import { ethers } from "/vendor/ethers.bundle.js";
import { SL } from "../wallet.js";
import { CONFIG } from "../config.js";
import { normalizeAmount } from "../amount.js";
import { CONFIG_V15 } from "../config-v15.js";
import { CHAINS } from "../shinyluck-sdk.js";
import { provider, wsProvider, fetchRecentLogs } from "../rpc.js";
import { friendlyError } from "../errors.js";

export { friendlyError };

export const ZERO = "0x0000000000000000000000000000000000000000";

/// v15 money lives in the Vault; this replaces the old single-casino address.
export const VAULT_ADDR = CONFIG_V15.addresses.vault;
// Drop poll cadence · fast settle was bottlenecked here, not on-chain.
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
  // v15: the Vault holds money + the single-shot bet registry. Note gameId is
  // uint16 here (was uint8 on the v14 monolith) — decoding with the old ABI
  // silently mis-reads every settled event.
  const abi = [
    "event BetPlaced(uint256 indexed betId,address indexed player,uint16 indexed gameId,uint256 amount,bytes32 clientSeed,uint256 commitBlock,uint256 seedIdx,bytes params)",
    "event BetSettled(uint256 indexed betId,address indexed player,uint16 indexed gameId,bool won,uint256 payout,bytes32 randomness,bytes32 serverSeed,bytes32 clientSeed,bytes32 blockHash,uint256 nonce,bytes resultData)",
    "event BetRefunded(uint256 indexed betId,address indexed player,uint256 amount,string reason)",
    "function getBet(uint256) view returns (tuple(address player,uint96 amount,uint16 gameId,uint8 status,uint64 commitBlock,uint64 nonce,uint256 seedIdx,bytes32 clientSeed,bytes params,bytes32 randomness,uint128 payout,bool won))",
    "function getPlayerBets(address) view returns (uint256[])",
    "function pendingWithdrawals(address) view returns (uint256)",
    "function freeBankroll() view returns (uint256)",
    "function claim()",
  ];
  casinoRO._c = new ethers.Contract(VAULT_ADDR, abi, provider());
  return casinoRO._c;
}

/// Mines lives in its own module contract in v15, so its state and events are
/// read from there rather than from the Vault.
export function minesRO() {
  if (minesRO._c) return minesRO._c;
  const g = (CONFIG_V15.games || []).find((x) => x.name === "mines");
  if (!g) return null;
  const abi = [
    "event MinesRootCommitted(uint256 indexed betId,bytes32 root)",
    "event MinesCellOpened(uint256 indexed betId,uint8 cellIdx,uint32 openedBitmap,uint256 multiplierX100)",
    "event MinesBust(uint256 indexed betId,uint8 cellIdx)",
    "event MinesCashout(uint256 indexed betId,uint8 cellsOpened,uint256 payout,uint256 multiplierX100)",
    "event MinesLayout(uint256 indexed betId,uint32 minesBitmap,bytes32 serverSeed)",
    "function getGame(uint256) view returns (tuple(address player,uint96 amount,uint8 status,uint8 mineCount,uint8 pendingCell,bool busted,bool finalized,uint32 openedBitmap,uint64 commitBlock,uint64 pickBlock,uint64 nonce,uint256 seedIdx,bytes32 clientSeed,bytes32 layoutRoot,bytes32 entropyHash,bytes32 randomness))",
    "function totalGames() view returns (uint256)",
  ];
  minesRO._c = new ethers.Contract(g.module, abi, provider());
  return minesRO._c;
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
  setText("[data-sl-fairserver]", "-");
  const link = $("[data-sl-explorer-link]");
  if (link) link.style.display = "none";
}

/// Pre-fill the fair panel from the player's last settled bet for `gameId`.
export async function refreshFairFromPlayer(gameId) {
  if (!SL.address || !VAULT_ADDR) return;
  const c = casinoRO();
  const events = await fetchRecentLogs(c, "BetSettled", {
    minCount: 1,
    filter: (ev) => ev.args.player.toLowerCase() === SL.address.toLowerCase()
                 && Number(ev.args.gameId) === gameId,
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
// Settle polling · waits for BetSettled or BetRefunded for `betId`.
// ---------------------------------------------------------------------

export async function pollForSettle(betId) {
  return pollSettleOn(casinoRO(), VAULT_ADDR, "BetSettled", "BetRefunded", betId);
}

/// Wait for a slot spin to settle. Slots live in their own module contract in
/// v15, so they emit SpinSettled/SpinRefunded there rather than on the Vault.
/// Returns the SAME shape as pollForSettle so game code is unchanged.
export async function pollForSpinSettle(name, betId) {
  const c = slotRO(name);
  if (!c) return null;
  return pollSettleOn(c, c.target, "SpinSettled", "SpinRefunded", betId);
}

/// Read-only slot module (VAULT.7 / SUGAR.LAB).
export function slotRO(name) {
  slotRO._c = slotRO._c || {};
  if (slotRO._c[name]) return slotRO._c[name];
  const g = (CONFIG_V15.games || []).find((x) => x.name === name);
  if (!g) return null;
  const abi = [
    "event SpinPlaced(uint256 indexed betId,address indexed player,uint256 amount,bool freeSpin,bool buyBonus)",
    "event SpinSettled(uint256 indexed betId,address indexed player,bool won,uint256 payout,bytes32 randomness,bytes32 serverSeed,bytes resultData)",
    "event SpinRefunded(uint256 indexed betId,string reason)",
    "function getSpin(uint256) view returns (tuple(address player,uint96 amount,uint8 status,bool freeSpin,bool buyBonus,uint64 commitBlock,uint64 nonce,uint256 seedIdx,bytes32 clientSeed,bytes32 randomness,uint128 payout))",
    "function totalSpins() view returns (uint256)",
    "function reportedRtpBps() view returns (uint16)",
  ];
  slotRO._c[name] = new ethers.Contract(g.module, abi, provider());
  return slotRO._c[name];
}

async function pollSettleOn(c, addr, settledName, refundedName, betId) {
  const wantId = betId.toString();
  let resolved = null;

  // Fast path: WebSocket subscription. Pushes a notification within ~100ms
  // of the settle tx being mined. Polling fallback below catches missed
  // events if the WS silently drops.
  const ws = wsProvider();
  let wsSettled = null, wsRefunded = null;
  if (ws) {
    try {
      const settledTopic = c.interface.getEvent(settledName).topicHash;
      const refundedTopic = c.interface.getEvent(refundedName).topicHash;
      const onSettled = (log) => {
        try {
          const p = c.interface.parseLog(log);
          if (p.args.betId.toString() === wantId) {
            wsSettled = { name: settledName, args: p.args, transactionHash: log.transactionHash, blockNumber: log.blockNumber };
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
      ws.on({ address: addr, topics: [settledTopic] },  onSettled);
      ws.on({ address: addr, topics: [refundedTopic] }, onRefunded);
      // schedule a tear-down hook on a Promise we race
      var unsubscribeWs = () => {
        try { ws.off({ address: addr, topics: [settledTopic] },  onSettled); } catch (_) {}
        try { ws.off({ address: addr, topics: [refundedTopic] }, onRefunded); } catch (_) {}
      };
    } catch (e) {
      console.warn("[base] settle WS subscribe failed, polling only:", e.message);
    }
  }

  const start = Date.now();
  // Tight initial polling · first check immediately (no startup delay), then
  // every SETTLE_POLL_MS (750ms) so total reveal-to-UI latency stays under
  // ~1s once the reveal-bot lands its settle tx.
  let scanFrom = await provider().getBlockNumber();
  // Initial check before sleeping · in case settle already happened during
  // the placement round-trip (Sequence + chain mining).
  try {
    const back = await fetchRecentLogs(c, settledName, {
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
      const settled = await fetchRecentLogs(c, settledName, {
        minCount: 1,
        maxLookback: head - scanFrom + 2,
        filter: (ev) => ev.args.betId.toString() === wantId,
      });
      if (settled.length > 0) { if (unsubscribeWs) unsubscribeWs(); return settled[0]; }
    } catch (e) {
      console.warn("[base] settle poll " + settledName + ":", e.message);
    }
    try {
      const refunds = await fetchRecentLogs(c, refundedName, {
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
// Recent events strip (last N for a given game) · caller provides the
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
  if (!VAULT_ADDR) return;
  const c = casinoRO();
  const events = await fetchRecentLogs(c, "BetSettled", {
    minCount: limit,
    maxLookback,
    filter: (ev) => Number(ev.args.gameId) === gameId,
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

/// The typed stake, as a string ethers can parse.
///
/// This used to strip every non-digit, which turned a phone keyboard's "0,2"
/// into "02": the player asked for 0.2 STT and the contract was told TWO. Ten
/// times the bet, silently, phones only. The separator is handled before
/// anything is stripped now — one implementation, in lib/amount.js.
export function readStakeStr() {
  const el = $("[data-sl-stake]");
  if (!el) return "0";
  return normalizeAmount(el.value || el.textContent || "0");
}

// ---------------------------------------------------------------------
// Expected-value row helper (Section 6)
//
// Casino is transparent about its math: every game page renders the
// per-bet expected value alongside the upside in STT + %. Most casinos
// hide this · we surface it as a feature.
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
  if (!VAULT_ADDR) return HOUSE_EDGE_DEFAULT_BPS[gameId];
  try {
    // v15: the edge is declared by each game's own module, not the Vault.
    const NAME_BY_ID = { 0: "dice", 1: "crash", 2: "vault7", 3: "mines", 4: "plinko", 5: "roulette", 6: "cluster" };
    const g = (CONFIG_V15.games || []).find((x) => x.name === NAME_BY_ID[gameId]);
    if (!g) return HOUSE_EDGE_DEFAULT_BPS[gameId];
    const c = new ethers.Contract(g.module, ["function houseEdgeBps() view returns (uint16)"], provider());
    const bps = await c.houseEdgeBps();
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

// CSS keyframes used by all game pages · injected once.
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
