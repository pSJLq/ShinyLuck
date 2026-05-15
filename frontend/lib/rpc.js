// Shared RPC helpers for the frontend modules. Wraps ethers.JsonRpcProvider
// with a raw `eth_getLogs` path that bypasses ethers v6's auto-validation.
//
// Why: Somnia's RPC returns logs without the `removed` field. ethers v6
// `queryFilter` and `provider.on(filter, ...)` validate every log via
// `value.removed must be boolean` and throw `BAD_DATA` on undefined.
// Raw eth_getLogs + manual `interface.parseLog(...)` is unaffected.

import { ethers } from "https://esm.sh/ethers@6.13.2";
import { CHAINS } from "./shinyluck-sdk.js";
import { CONFIG } from "./config.js";

let _provider = null;
export function provider() {
  if (!_provider) {
    const net = CHAINS[CONFIG.network] || CHAINS.somniaTestnet;
    _provider = new ethers.JsonRpcProvider(net.rpcUrls[0]);
    // Best-effort: try the WS endpoint for push subscriptions (block ticker,
    // live feed). Falls back silently to the JSON-RPC provider if the gateway
    // doesn't speak websockets.
    try {
      const wsUrl = (net.wsUrls && net.wsUrls[0])
        || (net.rpcUrls[0] || "").replace(/^http/, "ws");
      if (wsUrl && wsUrl.startsWith("ws")) {
        _wsProvider = new ethers.WebSocketProvider(wsUrl);
      }
    } catch (_) { _wsProvider = null; }
  }
  return _provider;
}

let _wsProvider = null;
/// Returns a WebSocketProvider if Somnia's gateway accepts the upgrade, else
/// null. Callers should subscribe via `.on(...)` and fall back to polling.
export function wsProvider() {
  // touch provider() so we attempt the WS handshake exactly once
  provider();
  return _wsProvider;
}

// ---------------------------------------------------------------------------
// retry wrapper — exponential backoff on transient RPC failures
// ---------------------------------------------------------------------------

function isRetryable(err) {
  const m = ((err && (err.message || err.shortMessage)) || "") + "";
  return /timeout|fetch failed|network|connect|temporarily|rate limit|ECONNRESET|ETIMEDOUT|UND_ERR/i.test(m);
}

export async function withRetry(fn, { attempts = 3, baseDelayMs = 1000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (!isRetryable(e)) throw e;
      if (i === attempts - 1) break;
      const delay = baseDelayMs * Math.pow(2, i); // 1s / 2s / 4s
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

function toHex(n) { return "0x" + BigInt(n).toString(16); }

/// Default chunk size for eth_getLogs. Somnia testnet caps individual
/// requests at 1000 blocks → 900 with 100-block headroom. Override via the
/// `chunkSize` argument or DEFAULT_CHUNK_SIZE export.
export const DEFAULT_CHUNK_SIZE = 900;

function isRangeError(e) {
  const m = (e && (e.message || e.shortMessage || "")) + (e && e.error ? (" " + e.error.message || "") : "");
  return /block range/i.test(m) || /exceeds/i.test(m) || /too large/i.test(m);
}

/// Single eth_getLogs call with halving-retry on range-exceeded errors.
/// Recursively splits the [start, end] window until each piece succeeds
/// (or until start > end, which is a no-op).
async function getLogsRange(address, topic0, start, end) {
  if (start > end) return [];
  try {
    return await withRetry(() => provider().send("eth_getLogs", [{
      address,
      topics: [topic0],
      fromBlock: toHex(start),
      toBlock: toHex(end),
    }]));
  } catch (e) {
    if (isRangeError(e) && end > start) {
      const mid = start + Math.floor((end - start) / 2);
      const [left, right] = await Promise.all([
        getLogsRange(address, topic0, start, mid),
        getLogsRange(address, topic0, mid + 1, end),
      ]);
      return [...left, ...right];
    }
    throw e;
  }
}

/// Returns parsed events from a contract over [fromBlock, toBlock]. Chunked
/// to keep individual eth_getLogs calls inside the RPC's range cap.
export async function fetchLogs(contract, eventName, fromBlock, toBlock, chunkSize = DEFAULT_CHUNK_SIZE) {
  const topic0 = contract.interface.getEvent(eventName).topicHash;
  const out = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    let raw;
    try {
      raw = await getLogsRange(contract.target, topic0, start, end);
    } catch (e) {
      console.warn(`[rpc] eth_getLogs ${eventName} ${start}..${end}: ${e.message || e.shortMessage}`);
      continue;
    }
    for (const r of raw) {
      try {
        const parsed = contract.interface.parseLog({ topics: r.topics, data: r.data });
        out.push({
          name: parsed.name,
          args: parsed.args,
          blockNumber: parseInt(r.blockNumber, 16),
          transactionHash: r.transactionHash,
          logIndex: parseInt(r.logIndex, 16),
        });
      } catch (e) {
        // skip unparseable logs (e.g. reorg artefact, mismatched ABI)
      }
    }
  }
  return out;
}

/// Convenience: latest N parsed events ending at the current head, with a
/// configurable lookback (in blocks). Forward scan — used for full-window
/// aggregations (leaderboard, account P&L) where we need every event.
export async function recentLogs(contract, eventName, lookbackBlocks = 100_000, chunkSize = DEFAULT_CHUNK_SIZE) {
  const head = await provider().getBlockNumber();
  const from = Math.max(0, head - lookbackBlocks);
  return fetchLogs(contract, eventName, from, head, chunkSize);
}

/// Backwards-scan with early exit — for "give me the last N events" cases
/// (live feed, recent rolls per game, last-settled per player). Walks
/// chunks from `head` toward `head - maxLookback`, stopping as soon as
/// `predicate(events)` is satisfied (default: collected ≥ minCount events).
///
/// Optional `filter(parsedEvent)` lets callers narrow to a single game or
/// a specific player without paying for a second pass.
///
/// Returns events sorted newest-first.
export async function fetchRecentLogs(contract, eventName, opts = {}) {
  const {
    minCount = 30,
    maxLookback = 200_000,
    chunkSize = DEFAULT_CHUNK_SIZE,
    filter = null,
  } = opts;
  const topic0 = contract.interface.getEvent(eventName).topicHash;
  const head = await provider().getBlockNumber();
  const floor = Math.max(0, head - maxLookback);
  const collected = [];

  for (let end = head; end >= floor; end -= chunkSize) {
    const start = Math.max(floor, end - chunkSize + 1);
    let raw;
    try {
      raw = await getLogsRange(contract.target, topic0, start, end);
    } catch (e) {
      console.warn(`[rpc] recent ${eventName} ${start}..${end}: ${e.message || e.shortMessage}`);
      if (start === floor) break;
      continue;
    }
    // Newest first within the chunk.
    raw.sort((a, b) => parseInt(b.blockNumber, 16) - parseInt(a.blockNumber, 16)
                    || parseInt(b.logIndex, 16) - parseInt(a.logIndex, 16));
    for (const r of raw) {
      let parsed;
      try {
        parsed = contract.interface.parseLog({ topics: r.topics, data: r.data });
      } catch (_) { continue; }
      const ev = {
        name: parsed.name,
        args: parsed.args,
        blockNumber: parseInt(r.blockNumber, 16),
        transactionHash: r.transactionHash,
        logIndex: parseInt(r.logIndex, 16),
      };
      if (filter && !filter(ev)) continue;
      collected.push(ev);
      if (collected.length >= minCount) return collected;
    }
    if (start === floor) break;
  }
  return collected;
}

// ---------------------------------------------------------------------------
// localStorage event cache — TTL-bounded, used by livedata.js for cold-start.
// ---------------------------------------------------------------------------

const CACHE_PREFIX = "shinyluck.cache.v1.";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function cacheGet(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object" || !o.t) return null;
    if (Date.now() - o.t > CACHE_TTL_MS) return null;
    return o;
  } catch (_) { return null; }
}
export function cacheSet(key, value, extra = {}) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), value, ...extra }));
  } catch (_) {}
}

/// Fetches the deployment block from a static manifest. Best-effort; may
/// return null if served from a different origin.
let _deploymentBlockCache = null;
export async function fetchDeploymentBlock() {
  if (_deploymentBlockCache !== null) return _deploymentBlockCache;
  try {
    const r = await fetch(`/deployments/${CONFIG.network}.json`).catch(() => null);
    if (r && r.ok) {
      const m = await r.json();
      if (m.deploymentBlock) {
        _deploymentBlockCache = Number(m.deploymentBlock);
        return _deploymentBlockCache;
      }
    }
  } catch (_) {}
  _deploymentBlockCache = 0;
  return 0;
}
