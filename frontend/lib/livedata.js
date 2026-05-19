// Site-wide live-data wiring. Replaces every hardcoded number on the static
// pages with values read from on-chain contracts (when CONFIG.casino is set).
//
// Real-time strategy:
//   - On boot:  one parallel pass with Promise.all (stats, feed, agents, quorum)
//               populates the page within the cold-start budget (~3s).
//   - WS path:  if the gateway accepts the upgrade, subscribe to `newHeads`
//               (block ticker) and to BetSettled/BetRefunded logs (feed) —
//               new rows slide in immediately.
//   - Polling:  fallback when WS isn't available — block ticker @ 1s, feed
//               @ 1.5s, stats @ 12s. Each fetch is incremental: livedata
//               tracks the last-seen block per stream so we only scan new
//               ranges, not the full 200k window on every tick.
//
// DOM hooks the static HTML uses are documented inline next to each renderer.

import { ethers } from "https://esm.sh/ethers@6.13.2";
import { CONFIG } from "./config.js";
import {
  provider, wsProvider, fetchLogs, fetchRecentLogs, fetchDeploymentBlock,
  cacheGet, cacheSet,
} from "./rpc.js";

const GAME_BY_NAME = { dice: 0, crash: 1, slots: 2, mines: 3, plinko: 4, roulette: 5, cluster: 6 };
const GAME_NAMES = ["DICE","CRASH","VAULT.7","MINES","PLINKO","ROULETTE","SUGAR.LAB"];
const ZERO = "0x0000000000000000000000000000000000000000";

const AGENT_IDS = {
  json: "131742929374160097713",
  llm: "128472938475610293844",
  parse: "128754011420709690852",
  hm: "119284756103948572617",
};

// 20_000 blocks ≈ 7 hours on Somnia (1.2s/block). Old enough to catch a
// fresh deploy's history without scanning a 67-hour window every cold-start.
// effectiveLookback() further clamps this to the contract's age.
const FEED_LOOKBACK_BLOCKS = 20_000;
const FEED_ROW_CAP = 30;

function effectiveLookback(maxLookback) {
  if (_deploymentBlock <= 0) return maxLookback;
  // never scan further back than the contract existed
  return maxLookback;
}

let _casino = null;
let _verifier = null;
let _deploymentBlock = 0;
let _lastFeedBlock = 0;
let _feedRows = [];                  // most-recent-first; capped to FEED_ROW_CAP
let _stakeByBet = new Map();         // betId(string) → wei BigInt
let _blockTimestamps = [];           // [{n, t}] rolling window for finality calc

function deployed() { return CONFIG.casino && CONFIG.casino !== ZERO; }

function casino() {
  if (!_casino) {
    const abi = [
      "function freeBankroll() view returns (uint256)",
      "function gameMaxBet(uint8) view returns (uint256)",
      "function gamePaused(uint8) view returns (bool)",
      "function houseEdgeBps(uint8) view returns (uint256)",
      "function bonusModeActive() view returns (bool)",
      "function bonusModeUntil() view returns (uint256)",
      "function totalBets() view returns (uint256)",
      "function totalPendingWithdrawals() view returns (uint256)",
      "event BetPlaced(uint256 indexed betId,address indexed player,uint8 indexed game,uint256 amount,bytes32 clientSeed,uint256 commitBlock,uint256 seedIdx,bytes params)",
      "event BetSettled(uint256 indexed betId,address indexed player,uint8 indexed game,bool won,uint256 payout,bytes32 randomness,bytes32 serverSeed,bytes32 clientSeed,bytes32 blockHash,uint256 nonce,bytes resultData)",
      "event BetRefunded(uint256 indexed betId,address indexed player,uint256 amount,string reason)",
      "event ReasoningLog(string thought,uint256 timestamp)",
      "event BonusModeActivated(uint256 until,string reasoning)",
      "event GameMaxBetSet(uint8 indexed game,uint256 amount)",
    ];
    _casino = new ethers.Contract(CONFIG.casino, abi, provider());
  }
  return _casino;
}

function verifier() {
  if (!_verifier && CONFIG.agentVerifier && CONFIG.agentVerifier !== ZERO) {
    const abi = [
      "event QuorumResult(uint256 indexed betId,uint256 indexed requestId,bytes32 expected,uint8 signers,uint8 totalWorkers,uint8 level,uint8 status,string sampleResponse)",
    ];
    _verifier = new ethers.Contract(CONFIG.agentVerifier, abi, provider());
  }
  return _verifier;
}

// ---------------------------------------------------------------------------
// formatting / DOM helpers
// ---------------------------------------------------------------------------

function fmtSTT(wei) {
  if (typeof wei !== "bigint") wei = BigInt(wei);
  const eth = Number(ethers.formatEther(wei));
  if (eth >= 1000) return eth.toFixed(0);
  if (eth >= 1) return eth.toFixed(2);
  if (eth >= 0.01) return eth.toFixed(3);
  return eth.toFixed(4);
}
function fmtNum(n) { return Number(n).toLocaleString("en-US").replace(/,/g, " "); }
function fmtAddr(a) { return `${a.slice(0,6)}…${a.slice(-4)}`; }
function setText(el, v) {
  if (!el) return;
  const b = el.querySelector ? el.querySelector("b") : null;
  (b || el).textContent = v;
}

// ---------------------------------------------------------------------------
// initial reset — wipe every hardcoded value to "—" before any network I/O
// ---------------------------------------------------------------------------

function resetPlaceholders() {
  document.querySelectorAll('[data-sl]').forEach((el) => setText(el, "—"));
  document.querySelectorAll('[data-count]').forEach((el) => {
    const role = el.dataset.slRole;
    if (role) el.textContent = "—";
  });
  const fb = document.querySelector("#feed-body");
  if (fb) fb.innerHTML = `<tr><td class="dim" colspan="5">loading on-chain feed…</td></tr>`;
  document.querySelectorAll("[data-sl-feed]").forEach((el) => {
    el.innerHTML = '<div class="feed-row" style="opacity:.4;">loading on-chain feed…</div>';
  });
  document.querySelectorAll("[data-sl-recent-mults]").forEach((el) => {
    el.innerHTML = '<span class="m" style="opacity:.4;">—</span>';
  });
  const fc = document.querySelector("#feed-count");
  if (fc) fc.textContent = "—";
  // Inject slide-in keyframes once.
  if (!document.getElementById("sl-feed-kf")) {
    const s = document.createElement("style");
    s.id = "sl-feed-kf";
    s.textContent = `
      @keyframes sl-feed-slide-in {
        0%   { transform: translateY(-12px); opacity: 0; background: rgba(34,211,238,0.10); }
        60%  { background: rgba(34,211,238,0.10); }
        100% { transform: translateY(0); opacity: 1; background: transparent; }
      }
      .sl-feed-new td { animation: sl-feed-slide-in 0.55s cubic-bezier(.22,.61,.36,1); }
    `;
    document.head.appendChild(s);
  }
}

// ---------------------------------------------------------------------------
// hero stats / per-game stats
// ---------------------------------------------------------------------------

export async function refreshLiveStats() {
  if (!deployed()) return;
  try {
    const c = casino();
    const [bankroll, bonusActive, blockNumber] = await Promise.all([
      c.freeBankroll(),
      c.bonusModeActive(),
      provider().getBlockNumber(),
    ]);

    // NOTE: `totalBets` (settled count) is owned by the feed-events path now —
    // see renderFeed(). We removed the c.totalBets() poll so the two paths
    // don't fight (and so the "BETS SETTLED" label is honestly derived from
    // BetSettled events, not from c.totalBets() which includes unsettled bets).
    document.querySelectorAll('[data-sl="bankroll"]').forEach((el) => setText(el, fmtSTT(bankroll) + " STT"));
    document.querySelectorAll('[data-sl="bonusMode"]').forEach((el) =>
      setText(el, bonusActive ? "ACTIVE" : "—")
    );
    document.querySelectorAll('[data-sl="blockNumber"]').forEach((el) => setText(el, fmtNum(blockNumber)));

    document.querySelectorAll('[data-count]').forEach((el) => {
      const role = el.dataset.slRole;
      if (role === "bankroll") el.textContent = fmtSTT(bankroll) + " STT";
    });

    for (const [name, id] of Object.entries(GAME_BY_NAME)) {
      try {
        const [maxBet, edge, paused] = await Promise.all([
          c.gameMaxBet(id),
          c.houseEdgeBps(id),
          c.gamePaused(id),
        ]);
        document.querySelectorAll(`[data-sl="maxBet"][data-game="${name}"]`)
          .forEach((el) => setText(el, fmtSTT(maxBet) + " STT"));
        document.querySelectorAll(`[data-sl="houseEdge"][data-game="${name}"]`)
          .forEach((el) => setText(el, (Number(edge) / 100).toFixed(2) + "%"));
        document.querySelectorAll(`[data-sl="status"][data-game="${name}"]`)
          .forEach((el) => setText(el, paused ? "PAUSED" : "LIVE"));
      } catch (e) {
        // Game ID may not exist on the deployed contract (e.g. CLUSTER on an
        // old deployment). Skip quietly.
      }
    }
  } catch (e) {
    console.warn("[livedata] refreshLiveStats:", e.message);
  }
}

// ---------------------------------------------------------------------------
// live feed (BetSettled). Caches its rows + last-seen block so the cold
// boot reads ≤ FEED_LOOKBACK_BLOCKS once, then only scans the small
// (head - last_seen_block) delta on subsequent ticks. On hot reload the
// cache fills the table in <50ms; the network call only adds new rows.
// ---------------------------------------------------------------------------

const CACHE_KEY = "feed.v2";

function renderFeed() {
  // Push the *settled-events count* and unique-players count to all matching
  // labels REGARDLESS of whether the feed body element exists on this page
  // (sugar/vault7/dice game pages don't render the feed table but still show
  // these counters in their header / footer).
  const settledCount = _feedRows.length;
  document.querySelectorAll('[data-sl="totalBets"]').forEach((el) => setText(el, fmtNum(settledCount)));
  document.querySelectorAll('[data-count][data-sl-role="totalBets"]').forEach((el) => {
    el.textContent = fmtNum(settledCount);
  });
  const players = new Set(_feedRows.map((r) => r.player.toLowerCase()));
  document.querySelectorAll('[data-sl="playersOnline"]').forEach((el) => setText(el, fmtNum(players.size)));
  document.querySelectorAll('[data-count][data-sl-role="playersOnline"]').forEach((el) => {
    el.textContent = fmtNum(players.size);
  });

  const body = document.querySelector("#feed-body");
  if (!body) return;
  if (_feedRows.length === 0) {
    body.innerHTML = `<tr><td class="dim" colspan="5">no settled bets in window</td></tr>`;
    return;
  }
  body.innerHTML = "";
  for (const ev of _feedRows.slice(0, FEED_ROW_CAP)) appendFeedRow(body, ev, false);
}

function appendFeedRow(body, ev, animate) {
  const gameName = GAME_NAMES[ev.game] || "?";
  const stakeWei = ev.stake || 0n;
  const stakeText = stakeWei > 0n ? fmtSTT(stakeWei) + " STT" : "—";
  let multText = "—";
  if (stakeWei > 0n && ev.payout > 0n) {
    const x100 = (ev.payout * 100n) / stakeWei;
    multText = (Number(x100) / 100).toFixed(2) + "×";
  }
  let pnlText, pnlCls;
  if (ev.won) {
    const pnl = stakeWei > 0n ? ev.payout - stakeWei : ev.payout;
    pnlText = "+ " + fmtSTT(pnl) + " STT";
    pnlCls = "pnl pnl-win";
  } else if (stakeWei > 0n) {
    pnlText = "− " + fmtSTT(stakeWei) + " STT";
    pnlCls = "pnl pnl-loss";
  } else { pnlText = "—"; pnlCls = "pnl dim"; }
  const tr = document.createElement("tr");
  if (animate) tr.className = "sl-feed-new";
  // Game tag gets per-game color (g-0..g-6); player / stake / mult are
  // muted so the eye lands on game + P&L (the row's primary signal).
  tr.innerHTML =
    `<td><span class="game-tag g-${ev.game}">${gameName}</span></td>` +
    `<td class="feed-dim"><a href="${accountUrlFor(ev.player)}" data-link style="color:inherit;">${fmtAddr(ev.player)}</a></td>` +
    `<td class="feed-dim">${stakeText}</td>` +
    `<td class="feed-dim">${multText}</td>` +
    `<td class="${pnlCls}">${pnlText}</td>`;
  if (animate) body.prepend(tr); else body.appendChild(tr);
}

function accountUrlFor(addr) {
  const inGames = location.pathname.includes("/games/");
  const prefix = inGames ? "../" : "";
  return `${prefix}account.html?address=${addr.toLowerCase()}`;
}

function eventsToRows(settled, stakeMap) {
  return settled.map((ev) => ({
    betId: ev.args.betId.toString(),
    player: ev.args.player,
    game: Number(ev.args.game),
    won: ev.args.won,
    payout: BigInt(ev.args.payout),
    stake: BigInt(stakeMap.get(ev.args.betId.toString()) || 0n),
    blockNumber: ev.blockNumber,
    logIndex: ev.logIndex,
    transactionHash: ev.transactionHash,
  }));
}

function mergeFeedRows(newRows) {
  const seen = new Set(_feedRows.map((r) => r.betId));
  let added = false;
  for (const r of newRows) {
    if (seen.has(r.betId)) continue;
    _feedRows.push(r); seen.add(r.betId); added = true;
  }
  if (!added) return false;
  _feedRows.sort((a, b) => (b.blockNumber - a.blockNumber) || (b.logIndex - a.logIndex));
  if (_feedRows.length > FEED_ROW_CAP * 2) _feedRows = _feedRows.slice(0, FEED_ROW_CAP * 2);
  return true;
}

function hydrateFromCache() {
  const cached = cacheGet(CACHE_KEY);
  if (!cached || !Array.isArray(cached.value)) return false;
  try {
    _feedRows = cached.value.map((r) => ({
      ...r,
      payout: BigInt(r.payout),
      stake: BigInt(r.stake),
    }));
    _lastFeedBlock = Number(cached.lastBlock) || 0;
    renderFeed();
    return true;
  } catch (_) { return false; }
}

function persistCache() {
  try {
    const payload = _feedRows.slice(0, FEED_ROW_CAP).map((r) => ({
      ...r, payout: r.payout.toString(), stake: r.stake.toString(),
    }));
    cacheSet(CACHE_KEY, payload, { lastBlock: _lastFeedBlock });
  } catch (_) {}
}

export async function refreshLiveFeed() {
  if (!deployed()) return;
  try {
    const c = casino();
    const head = await provider().getBlockNumber();
    // Cold boot: scan backwards from head with early-exit at FEED_ROW_CAP rows.
    // Subsequent ticks: only fetch the (last_seen_block, head] delta.
    let settled, placed;
    if (_lastFeedBlock === 0) {
      // Clamp the backward scan to the contract's age — scanning blocks
      // before deploymentBlock is pure waste.
      const minScan = _deploymentBlock > 0
        ? Math.min(FEED_LOOKBACK_BLOCKS, head - _deploymentBlock + 5)
        : FEED_LOOKBACK_BLOCKS;
      settled = await fetchRecentLogs(c, "BetSettled", { minCount: FEED_ROW_CAP, maxLookback: minScan });
      if (settled.length === 0) {
        const body = document.querySelector("#feed-body");
        if (body && _feedRows.length === 0) body.innerHTML = `<tr><td class="dim" colspan="5">no settled bets yet — be the first</td></tr>`;
        _lastFeedBlock = head;
        return;
      }
      const minBlock = settled[settled.length - 1].blockNumber;
      placed = await fetchLogs(c, "BetPlaced", minBlock, head);
    } else if (head > _lastFeedBlock) {
      const fromBlock = _lastFeedBlock + 1;
      settled = await fetchLogs(c, "BetSettled", fromBlock, head);
      placed = await fetchLogs(c, "BetPlaced", fromBlock, head);
    } else {
      return;
    }
    for (const ev of placed) _stakeByBet.set(ev.args.betId.toString(), ev.args.amount);
    if (settled.length === 0) { _lastFeedBlock = head; return; }
    const newRows = eventsToRows(settled, _stakeByBet);
    const animate = _lastFeedBlock > 0; // first cold load: no animation, just render
    const added = mergeFeedRows(newRows);
    _lastFeedBlock = head;
    if (added) {
      if (animate) {
        const body = document.querySelector("#feed-body");
        if (body) {
          // Animate only the brand-new ones at the top; keep the existing
          // rendered rows in place.
          const fresh = newRows.filter((r) => _feedRows.slice(0, FEED_ROW_CAP).some((x) => x.betId === r.betId))
                               .sort((a, b) => (b.blockNumber - a.blockNumber) || (b.logIndex - a.logIndex));
          if (body.querySelector("td.dim")) body.innerHTML = "";
          for (const r of fresh) appendFeedRow(body, r, true);
          // Trim to cap.
          while (body.children.length > FEED_ROW_CAP) body.removeChild(body.lastChild);
        }
      } else {
        renderFeed();
      }
      persistCache();
    }
    document.querySelectorAll("[data-sl-feed]").forEach((el) => { el.style.display = "none"; });

    // recent multipliers per game (legacy hook).
    for (const [name, id] of Object.entries(GAME_BY_NAME)) {
      const containers = document.querySelectorAll(`[data-sl-recent-mults="${name}"]`);
      if (containers.length === 0) continue;
      const slice = _feedRows.filter((r) => r.game === id).slice(0, 9);
      containers.forEach((root) => {
        root.innerHTML = "";
        if (slice.length === 0) {
          root.innerHTML = '<span class="m" style="opacity:.4;">no recent</span>';
          return;
        }
        for (const r of slice) {
          const m = document.createElement("span");
          let label = "0×";
          if (r.won && r.stake > 0n) {
            const x100 = (r.payout * 100n) / r.stake;
            label = (Number(x100) / 100).toFixed(2) + "×";
          }
          m.className = "m " + (r.won ? "win" : "bust");
          m.textContent = label;
          root.appendChild(m);
        }
      });
    }
  } catch (e) {
    console.warn("[livedata] refreshLiveFeed:", e.message);
  }
}

// ---------------------------------------------------------------------------
// agent IDs / contract addresses
// ---------------------------------------------------------------------------

export function refreshAgentIds() {
  document.querySelectorAll('[data-sl-agent-id]').forEach((el) => {
    const role = el.dataset.slAgentId;
    if (AGENT_IDS[role]) setText(el, AGENT_IDS[role]);
  });
  const map = {
    casino: CONFIG.casino,
    registry: CONFIG.registry,
    hm: CONFIG.houseManager,
    verifier: CONFIG.agentVerifier,
  };
  document.querySelectorAll('[data-sl-contract]').forEach((el) => {
    const role = el.dataset.slContract;
    if (map[role] && map[role] !== ZERO) setText(el, map[role]);
  });
  const isMainnet = CONFIG.network === "somniaMainnet";
  const label = isMainnet ? "MAINNET" : "TESTNET";
  document.querySelectorAll('[data-sl-network-badge]').forEach((el) => {
    el.textContent = label;
    el.classList.toggle("is-testnet", !isMainnet);
    el.classList.toggle("is-mainnet", isMainnet);
  });
}

// ---------------------------------------------------------------------------
// HM agent stats from ReasoningLog count
// ---------------------------------------------------------------------------

export async function refreshAgentStats() {
  if (!deployed()) return;
  try {
    const c = casino();
    const head = await provider().getBlockNumber();
    const from = Math.max(_deploymentBlock || head - 100_000, head - 100_000);
    const reasonings = await fetchLogs(c, "ReasoningLog", from, head);
    document.querySelectorAll('[data-sl-agent-stats="hm"] .v').forEach((el, i) => {
      if (i === 0) el.textContent = fmtNum(reasonings.length);
    });
  } catch (e) {
    console.warn("[livedata] refreshAgentStats:", e.message);
  }
}

// ---------------------------------------------------------------------------
// quorum status
// ---------------------------------------------------------------------------

export async function refreshQuorum() {
  const v = verifier();
  if (!v) return;
  try {
    const head = await provider().getBlockNumber();
    const from = Math.max(_deploymentBlock || head - FEED_LOOKBACK_BLOCKS, head - FEED_LOOKBACK_BLOCKS);
    const events = await fetchLogs(v, "QuorumResult", from, head);
    if (events.length === 0) {
      document.querySelectorAll("[data-sl-quorum]").forEach((el) => setText(el, "no events yet"));
      document.querySelectorAll("[data-sl-quorum-latest]").forEach((el) => setText(el, "no events"));
      return;
    }
    const last = events.sort((a, b) => b.blockNumber - a.blockNumber)[0];
    const COLORS = { 0: "#dc2626", 1: "#facc15", 2: "#16a34a" };
    const LABELS = { 0: "CRITICAL", 1: "WARNING", 2: "OK" };
    const lvl = Number(last.args.level);
    document.querySelectorAll("[data-sl-quorum]").forEach((el) => {
      el.textContent = `${last.args.signers}/${last.args.totalWorkers} signed (${LABELS[lvl]})`;
      el.style.color = COLORS[lvl];
    });
    document.querySelectorAll("[data-sl-quorum-latest]").forEach((el) => {
      el.textContent = `${last.args.signers}/${last.args.totalWorkers} ✓`;
      el.style.color = COLORS[lvl];
    });
  } catch (e) {
    console.warn("[livedata] refreshQuorum:", e.message);
  }
}

// ---------------------------------------------------------------------------
// Block ticker — every second, refresh the block number + median finality.
// Uses WS subscription when available (push), otherwise polls.
// ---------------------------------------------------------------------------

function recordBlockTimestamp(n, _blockTs) {
  // We intentionally use wall-clock arrival time, not block.timestamp:
  // Somnia blocks are sub-second but block.timestamp is Unix-second granularity,
  // so consecutive blocks frequently share a timestamp → finality computed as 0.00s.
  // Wall-clock delta reflects the user's perceived latency, which is the
  // more useful number to show anyway.
  const t = Date.now() / 1000;
  if (_blockTimestamps.length && _blockTimestamps[_blockTimestamps.length - 1].n === n) return;
  _blockTimestamps.push({ n, t });
  if (_blockTimestamps.length > 12) _blockTimestamps.shift();
}

function medianFinality() {
  if (_blockTimestamps.length < 2) return null;
  const deltas = [];
  for (let i = 1; i < _blockTimestamps.length; i++) {
    const d = _blockTimestamps[i].t - _blockTimestamps[i - 1].t;
    if (d > 0) deltas.push(d);          // skip same-tick duplicates
  }
  if (deltas.length === 0) return null;
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)];
}

function fmtFinality(s) {
  // Sub-second → show in ms so "0.00s" never appears.
  // Somnia ships ~1.2s blocks; mid-second values get 2 decimals.
  if (s < 1) return Math.round(s * 1000) + "ms";
  return s.toFixed(2) + "s";
}

function renderBlockTicker(blockNumber) {
  document.querySelectorAll('[data-sl="blockNumber"]').forEach((el) => setText(el, fmtNum(blockNumber)));
  const finality = medianFinality();
  if (finality !== null) {
    document.querySelectorAll('[data-sl="finality"]').forEach((el) => setText(el, fmtFinality(finality)));
  }
}

async function startBlockTicker() {
  // ALWAYS run the 1-second poll — it's our source of truth. WS is only an
  // accelerator that can skip the poll on its tick when a push arrives.
  // (Somnia's WS endpoint sometimes accepts the upgrade but never delivers
  // a `block` event; the silent-fail mode bit us in v0.8 — hence belt &
  // braces here.)
  let lastSeen = -1;
  async function pull() {
    try {
      const blk = await provider().getBlock("latest");
      if (!blk) return;
      if (blk.number === lastSeen) return;
      lastSeen = blk.number;
      recordBlockTimestamp(blk.number, blk.timestamp);
      renderBlockTicker(blk.number);
    } catch (e) {
      // Transient — withRetry() inside rpc.js already smooths most. Just skip.
    }
  }
  pull(); // immediate first paint
  // Block poll dropped from 1s → 3s. With WS subscribed below, new blocks
  // still surface in <100ms via push; the poll is just a safety net so the
  // ticker still updates when WS silently drops. At 1s we were burning RPC
  // budget and causing visible main-thread stalls (the cursor "teleported"
  // every time the JSON-RPC response parser ran). 3s × 60 = 20 polls/min,
  // well within Somnia testnet RPS limits even with crash/roulette running.
  setInterval(pull, 3000);

  const ws = wsProvider();
  if (ws) {
    try {
      ws.on("block", async (n) => {
        if (n === lastSeen) return;
        lastSeen = n;
        try {
          const blk = await ws.getBlock(n);
          if (blk) recordBlockTimestamp(blk.number, blk.timestamp);
        } catch (_) {}
        renderBlockTicker(n);
      });
    } catch (e) {
      console.warn("[livedata] WS block subscribe failed (polling still active):", e.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Live feed WS subscription. Falls back to polling at 1.5s.
// ---------------------------------------------------------------------------

async function startFeedRealtime() {
  const ws = wsProvider();
  if (ws) {
    try {
      const c = casino();
      const wsContract = new ethers.Contract(CONFIG.casino, c.interface.fragments, ws);
      const settledTopic = c.interface.getEvent("BetSettled").topicHash;
      const placedTopic  = c.interface.getEvent("BetPlaced").topicHash;
      ws.on({ address: CONFIG.casino, topics: [placedTopic] }, (log) => {
        try {
          const parsed = c.interface.parseLog(log);
          _stakeByBet.set(parsed.args.betId.toString(), parsed.args.amount);
        } catch (_) {}
      });
      ws.on({ address: CONFIG.casino, topics: [settledTopic] }, (log) => {
        try {
          const parsed = c.interface.parseLog(log);
          const row = {
            betId: parsed.args.betId.toString(),
            player: parsed.args.player,
            game: Number(parsed.args.game),
            won: parsed.args.won,
            payout: BigInt(parsed.args.payout),
            stake: BigInt(_stakeByBet.get(parsed.args.betId.toString()) || 0n),
            blockNumber: log.blockNumber,
            logIndex: log.logIndex,
            transactionHash: log.transactionHash,
          };
          const added = mergeFeedRows([row]);
          if (added) {
            const body = document.querySelector("#feed-body");
            if (body) {
              if (body.querySelector("td.dim")) body.innerHTML = "";
              appendFeedRow(body, row, true);
              // Fade-out bottom rows that exceed the cap rather than yank
              // them — gentler eye candy, takes ~600ms.
              while (body.children.length > FEED_ROW_CAP) {
                const last = body.lastChild;
                last.style.transition = "opacity 0.6s ease, transform 0.6s ease";
                last.style.opacity = "0";
                last.style.transform = "translateY(8px)";
                setTimeout(() => last.remove(), 650);
                // bail after one row to avoid stacking removals — fade is async
                break;
              }
            }
            persistCache();
            // bump totalBets counter optimistically
            document.querySelectorAll('[data-sl="totalBets"]').forEach((el) => {
              const cur = Number((el.textContent || "0").replace(/\s/g, "")) || 0;
              setText(el, fmtNum(cur + 1));
            });
          }
        } catch (e) { console.warn("[livedata] ws settled parse:", e.message); }
      });
      return;
    } catch (e) {
      console.warn("[livedata] WS log subscribe failed, falling back to poll:", e.message);
    }
  }
  // Was 1500ms; bumped to 5000ms. WS push delivers the actual real-time
  // update; this poll is only a fallback when WS silently drops, so 5s is
  // plenty and saves ~3 RPC/s of main-thread parsing → kills the cursor lag.
  setInterval(refreshLiveFeed, 5000);
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

async function boot() {
  resetPlaceholders();
  refreshAgentIds();
  setTimeout(refreshAgentIds, 50);
  setTimeout(refreshAgentIds, 250);

  // Hydrate from cache first — gives an instant first paint.
  if (deployed()) {
    hydrateFromCache();
  }

  if (!deployed()) return;

  // Start the block-ticker poll FIRST so the header keeps moving even if
  // the cold-start log scans below take a while (or hang on a flaky RPC).
  // The ticker is the single most visible "is anything alive" signal, and
  // it's cheap — one eth_getBlockByNumber per 3s.
  startBlockTicker();
  startFeedRealtime();

  // Cold-start: kick the heavy reads in parallel, then fire `shinyluck:ready`
  // when the user-visible stuff (stats + feed) has landed. partials.js's
  // splash holds at 90% until this event arrives, so the user never sees
  // the splash fade into a "loading…" placeholder.
  fetchDeploymentBlock().then((b) => { _deploymentBlock = b; }).catch(() => {});
  refreshAgentStats().catch(() => {});
  refreshQuorum().catch(() => {});

  Promise.allSettled([
    refreshLiveStats(),
    refreshLiveFeed(),
  ]).finally(() => {
    document.dispatchEvent(new CustomEvent("shinyluck:ready"));
  });

  setInterval(() => { refreshLiveStats().catch(() => {}); refreshAgentIds(); }, 12_000);
  setInterval(() => refreshAgentStats().catch(() => {}), 60_000);
  setInterval(() => refreshQuorum().catch(() => {}), 12_000);
}

document.addEventListener("DOMContentLoaded", () => { boot().catch((e) => console.warn(e)); });

export { fmtSTT, fmtNum, fmtAddr, GAME_NAMES, AGENT_IDS };
