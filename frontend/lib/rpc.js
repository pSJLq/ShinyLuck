// Shared RPC helpers for the frontend modules. Wraps ethers.JsonRpcProvider
// with a raw `eth_getLogs` path that bypasses ethers v6's auto-validation.
//
// Why: Somnia's RPC returns logs without the `removed` field. ethers v6
// `queryFilter` and `provider.on(filter, ...)` validate every log via
// `value.removed must be boolean` and throw `BAD_DATA` on undefined.
// Raw eth_getLogs + manual `interface.parseLog(...)` is unaffected.

import { ethers } from "/vendor/ethers.bundle.js";
import { CHAINS } from "./shinyluck-sdk.js";
import { CONFIG } from "./config.js";

let _provider = null;
export function provider() {
  if (!_provider) {
    const net = CHAINS[CONFIG.network] || CHAINS.somniaTestnet;
    // batchMaxCount:1 disables ethers v6 JSON-RPC request batching. Somnia's
    // public RPC rejects batched eth_getLogs payloads, which silently broke
    // the chunked historical fetch in account.js / livedata.js / fair.js on
    // the deployed site (recent bets, incl. VAULT.7, never loaded). One HTTP
    // request per call is a touch chattier but actually works. staticNetwork
    // skips a redundant eth_chainId round-trip on every call.
    _provider = new ethers.JsonRpcProvider(net.rpcUrls[0], undefined, {
      batchMaxCount: 1,
      staticNetwork: true,
    });
  }
  return _provider;
}

// ---------------------------------------------------------------------------
// WebSocket provider - self-healing.
//
// Somnia's gateway drops idle WS connections, and a stale socket made every
// `.on(...)` / unsubscribe throw "WebSocket is already in CLOSING or CLOSED
// state" and forced waitForSettle onto the ~1s-slower HTTP poll. We now treat
// the socket as disposable: detect close/error, tear it down, and lazily
// rebuild on the next wsProvider() call (debounced so a flapping gateway can't
// spin up a socket per call). A 25s keepalive ping stops idle disconnects.
// Anything failing => returns null => callers fall back to HTTP (old behaviour).
// ---------------------------------------------------------------------------

let _wsProvider = null;
let _wsKeepalive = null;
let _wsRebuiltAt = 0;

function _wsUrl() {
  const net = CHAINS[CONFIG.network] || CHAINS.somniaTestnet;
  const url = (net.wsUrls && net.wsUrls[0]) || (net.rpcUrls[0] || "").replace(/^http/, "ws");
  return url && url.startsWith("ws") ? url : null;
}

function _wsAlive() {
  try {
    const sock = _wsProvider && _wsProvider.websocket;
    // readyState: 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED
    return !!sock && (sock.readyState === 0 || sock.readyState === 1);
  } catch (_) { return false; }
}

function _teardownWs() {
  if (_wsKeepalive) { clearInterval(_wsKeepalive); _wsKeepalive = null; }
  const old = _wsProvider;
  _wsProvider = null;
  if (old) { try { old.destroy(); } catch (_) {} }
}

/// Returns a live WebSocketProvider if Somnia's gateway accepts the upgrade,
/// else null. Callers should subscribe via `.on(...)` and fall back to polling
/// when this is null. Safe to call every time you need the socket - it
/// rebuilds a dropped connection transparently.
export function wsProvider() {
  provider(); // ensure config/network resolved
  if (_wsAlive()) return _wsProvider;

  // Socket is missing or CLOSING/CLOSED - clean up and (debounced) rebuild.
  if (_wsProvider) _teardownWs();
  const now = Date.now();
  if (now - _wsRebuiltAt < 1500) return null; // just tried; let callers use HTTP
  _wsRebuiltAt = now;

  const url = _wsUrl();
  if (!url) return null;
  try {
    const wsp = new ethers.WebSocketProvider(url);
    _wsProvider = wsp;
    const sock = wsp.websocket;
    if (sock && sock.addEventListener) {
      // Null ourselves out when the socket drops so the next call rebuilds.
      // addEventListener (not onclose=) so ethers' own handler survives.
      sock.addEventListener("close", () => { if (_wsProvider === wsp) _teardownWs(); });
      sock.addEventListener("error", () => { if (_wsProvider === wsp) _teardownWs(); });
    }
    // Keepalive: a cheap call keeps the gateway from closing an idle socket.
    _wsKeepalive = setInterval(() => {
      if (_wsProvider !== wsp || !_wsAlive()) { if (_wsProvider === wsp) _teardownWs(); return; }
      wsp.send("eth_blockNumber", []).catch(() => { if (_wsProvider === wsp) _teardownWs(); });
    }, 25_000);
  } catch (_) {
    _wsProvider = null;
  }
  return _wsProvider;
}

// ---------------------------------------------------------------------------
// retry wrapper - exponential backoff on transient RPC failures
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

/// Shannon Explorer indexer endpoint. It's an Etherscan-compatible REST API
/// that pre-indexes every log on Somnia, so one HTTP call returns thousands
/// of events in ~200-500ms - versus 700+ chunked eth_getLogs RPC calls.
/// This is the Somnia "data streams" path; we fall back to chunked RPC if
/// the explorer rate-limits or returns an error shape.
const EXPLORER_BASE = "https://shannon-explorer.somnia.network/api";

async function explorerLogs(address, topic0, fromBlock, toBlock) {
  // Etherscan-style getLogs. Supports up to 1000 logs per page - for the
  // common case (a single user's events over a few days) one page is enough.
  // For >1000 we'd need to paginate; not needed for current UI scale.
  const url = `${EXPLORER_BASE}?module=logs&action=getLogs`
    + `&address=${address}`
    + `&fromBlock=${fromBlock}&toBlock=${toBlock}`
    + `&topic0=${topic0}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`explorer HTTP ${resp.status}`);
  const j = await resp.json();
  // Shannon Explorer responses:
  //   success:    { status: "1", message: "OK",            result: [...] }
  //   empty:      { status: "0", message: "No logs found", result: [] }
  //   also empty: { status: "0", message: "No records found", result: [] }
  //   error:      { status: "0", message: "<rate-limit / param error / ...>" }
  // Treat any "no <X> found" message as a legitimately-empty response, not
  // an error to fall back from. Otherwise event-types with zero logs (e.g.
  // QuorumResult on a brand-new deploy) spam fallback warnings + force the
  // slow RPC path even though the explorer answered correctly in 200ms.
  const emptyMessage = /^No\s+(logs|records)\s+found$/i;
  if (j.status !== "1" && !(j.message && emptyMessage.test(j.message))) {
    throw new Error(`explorer: ${j.message || "unknown"}`);
  }
  // Each entry: { address, topics: [...], data, blockNumber: "0x...", ... }
  return Array.isArray(j.result) ? j.result : [];
}

/// Returns parsed events from a contract over [fromBlock, toBlock].
/// PRIMARY path: Shannon Explorer REST indexer (one HTTP call, ~300ms).
/// FALLBACK: chunked + parallel eth_getLogs via the RPC provider.
const PARALLEL_CHUNKS = 24;
export async function fetchLogs(contract, eventName, fromBlock, toBlock, chunkSize = DEFAULT_CHUNK_SIZE) {
  const topic0 = contract.interface.getEvent(eventName).topicHash;
  // ── PRIMARY: Shannon Explorer ──
  try {
    const raws = await withRetry(
      () => explorerLogs(contract.target, topic0, fromBlock, toBlock),
      { attempts: 2, baseDelayMs: 400 },
    );
    const out = [];
    for (const r of raws) {
      try {
        const parsed = contract.interface.parseLog({ topics: r.topics, data: r.data });
        out.push({
          name: parsed.name,
          args: parsed.args,
          blockNumber: parseInt(r.blockNumber, 16),
          transactionHash: r.transactionHash,
          logIndex: parseInt(r.logIndex, 16),
        });
      } catch (_) { /* unparseable log; skip */ }
    }
    out.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    return out;
  } catch (e) {
    console.warn(`[rpc] explorer fetch ${eventName} failed (${e.message}), falling back to RPC chunks`);
  }

  // ── FALLBACK: chunked eth_getLogs in parallel ──
  const ranges = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    ranges.push([start, end]);
  }
  const collected = [];
  for (let i = 0; i < ranges.length; i += PARALLEL_CHUNKS) {
    const batch = ranges.slice(i, i + PARALLEL_CHUNKS);
    const results = await Promise.all(batch.map(async ([s, e]) => {
      try {
        return await getLogsRange(contract.target, topic0, s, e);
      } catch (err) {
        console.warn(`[rpc] eth_getLogs ${eventName} ${s}..${e}: ${err.message || err.shortMessage}`);
        return [];
      }
    }));
    for (const raw of results) {
      for (const r of raw) {
        try {
          const parsed = contract.interface.parseLog({ topics: r.topics, data: r.data });
          collected.push({
            name: parsed.name,
            args: parsed.args,
            blockNumber: parseInt(r.blockNumber, 16),
            transactionHash: r.transactionHash,
            logIndex: parseInt(r.logIndex, 16),
          });
        } catch (_) {}
      }
    }
  }
  collected.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  return collected;
}

/// Convenience: latest N parsed events ending at the current head, with a
/// configurable lookback (in blocks). Forward scan - used for full-window
/// aggregations (leaderboard, account P&L) where we need every event.
export async function recentLogs(contract, eventName, lookbackBlocks = 100_000, chunkSize = DEFAULT_CHUNK_SIZE) {
  const head = await provider().getBlockNumber();
  const from = Math.max(0, head - lookbackBlocks);
  return fetchLogs(contract, eventName, from, head, chunkSize);
}

/// Backwards-scan with early exit - for "give me the last N events" cases
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
// localStorage event cache - TTL-bounded, used by livedata.js for cold-start.
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
