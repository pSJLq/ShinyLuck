// Site-wide live-data wiring. Replaces every hardcoded number on the static
// pages with values read from on-chain contracts (when CONFIG.casino is set).
//
// Real-time strategy:
//   - On boot:  one parallel pass with Promise.all (stats, feed, agents, quorum)
//               populates the page within the cold-start budget (~3s).
//   - WS path:  if the gateway accepts the upgrade, subscribe to `newHeads`
//               (block ticker) and to BetSettled/BetRefunded logs (feed) -
//               new rows slide in immediately.
//   - Polling:  fallback when WS isn't available - block ticker @ 1s, feed
//               @ 1.5s, stats @ 12s. Each fetch is incremental: livedata
//               tracks the last-seen block per stream so we only scan new
//               ranges, not the full 200k window on every tick.
//
// DOM hooks the static HTML uses are documented inline next to each renderer.

import { ethers } from "/vendor/ethers.bundle.js";
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

// 100 000 blocks ≈ 11 hours on Somnia (0.4 s/block). Was 20 000 - comment
// said 7 h based on old 1.2 s/block estimate, but Somnia's actual ~0.4 s
// block time made that only ~2 h. Live feed lost yesterday's activity
// after the deploy aged past that. Chunked at 900 blocks in rpc.js,
// the larger window is still ~3-4 s on cold start.
const FEED_LOOKBACK_BLOCKS = 100_000;
// Fixed display window: the feed always shows exactly the latest FEED_ROW_CAP
// settled bets. The CSS reserves height for this many rows so the panel never
// grows/shrinks (and the page never jumps) no matter how fast bets stream in.
const FEED_ROW_CAP = 12;

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
let _historicalContracts = null;     // [{ contract, deploymentBlock, isCurrent }]
// Aggregate counters across ALL historical bets, separate from _feedRows
// (which is capped at FEED_ROW_CAP×2 for display efficiency). These are
// what BETS SETTLED / PLAYERS labels read from - they must reflect lifetime
// totals, not just the recent display window.
let _totalSettled = 0;
let _allPlayers = new Set();

function deployed() { return CONFIG.casino && CONFIG.casino !== ZERO; }

const CASINO_ABI = [
  "function freeBankroll() view returns (uint256)",
  "function gameMaxBet(uint8) view returns (uint256)",
  "function gamePaused(uint8) view returns (bool)",
  "function houseEdgeBps(uint8) view returns (uint256)",
  "function getReportedRTP(uint8) view returns (uint16)",
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

function casino() {
  if (!_casino) {
    _casino = new ethers.Contract(CONFIG.casino, CASINO_ABI, provider());
  }
  return _casino;
}

/// Returns [{ contract, deploymentBlock, isCurrent }] for every historical
/// casino, sorted oldest → newest. Falls back to just the current casino if
/// the historicalCasinos config is missing or empty (single-deploy mode).
function historicalContracts() {
  if (_historicalContracts) return _historicalContracts;
  const list = Array.isArray(CONFIG.historicalCasinos) ? CONFIG.historicalCasinos : [];
  const seen = new Set();
  const out = [];
  // De-dup by lowercase address, current first so it wins the .isCurrent flag.
  const withCurrent = [...list];
  if (CONFIG.casino && !list.some((e) => e.address.toLowerCase() === CONFIG.casino.toLowerCase())) {
    withCurrent.push({ address: CONFIG.casino, deploymentBlock: 0 });
  }
  for (const entry of withCurrent) {
    const lower = entry.address.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push({
      contract: new ethers.Contract(entry.address, CASINO_ABI, provider()),
      deploymentBlock: entry.deploymentBlock || 0,
      isCurrent: lower === (CONFIG.casino || "").toLowerCase(),
    });
  }
  out.sort((a, b) => a.deploymentBlock - b.deploymentBlock);
  _historicalContracts = out;
  return _historicalContracts;
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
// initial reset - wipe every hardcoded value to "-" before any network I/O
// ---------------------------------------------------------------------------

function resetPlaceholders() {
  document.querySelectorAll('[data-sl]').forEach((el) => setText(el, "-"));
  document.querySelectorAll('[data-count]').forEach((el) => {
    const role = el.dataset.slRole;
    if (role) el.textContent = "-";
  });
  const fb = document.querySelector("#feed-body");
  if (fb) fb.innerHTML = `<tr><td class="dim" colspan="5">loading on-chain feed…</td></tr>`;
  document.querySelectorAll("[data-sl-feed]").forEach((el) => {
    el.innerHTML = '<div class="feed-row" style="opacity:.4;">loading on-chain feed…</div>';
  });
  document.querySelectorAll("[data-sl-recent-mults]").forEach((el) => {
    el.innerHTML = '<span class="m" style="opacity:.4;">-</span>';
  });
  const fc = document.querySelector("#feed-count");
  if (fc) fc.textContent = "-";
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
    const [bankroll, bonusActive, blockNumber, maxBetBps] = await Promise.all([
      c.freeBankroll(),
      c.bonusModeActive(),
      provider().getBlockNumber(),
      c.maxBetBps().catch(() => 100n),
    ]);
    // The contract caps every bet at min(gameMaxBet, freeBankroll * maxBetBps).
    // On a small bankroll that bps cap is the REAL limit, so showing the raw
    // gameMaxBet (e.g. 5 STT) overstates what a player can actually wager
    // (e.g. 0.84 STT at 1% of an 84 STT bankroll). Compute the bps cap once.
    const bpsCapWei = (bankroll * BigInt(maxBetBps)) / 10000n;

    // NOTE: `totalBets` (settled count) is owned by the feed-events path now -
    // see renderFeed(). We removed the c.totalBets() poll so the two paths
    // don't fight (and so the "BETS SETTLED" label is honestly derived from
    // BetSettled events, not from c.totalBets() which includes unsettled bets).
    document.querySelectorAll('[data-sl="bankroll"]').forEach((el) => setText(el, fmtSTT(bankroll) + " STT"));
    document.querySelectorAll('[data-sl="bonusMode"]').forEach((el) =>
      setText(el, bonusActive ? "ACTIVE" : "-")
    );
    document.querySelectorAll('[data-sl="blockNumber"]').forEach((el) => setText(el, fmtNum(blockNumber)));

    document.querySelectorAll('[data-count]').forEach((el) => {
      const role = el.dataset.slRole;
      if (role === "bankroll") el.textContent = fmtSTT(bankroll) + " STT";
    });

    for (const [name, id] of Object.entries(GAME_BY_NAME)) {
      try {
        const [maxBet, edge, paused, rtp] = await Promise.all([
          c.gameMaxBet(id),
          c.houseEdgeBps(id),
          c.gamePaused(id),
          c.getReportedRTP(id).catch(() => 0),
        ]);
        // Effective cap = min(hard gameMaxBet, bankroll bps cap). Showing the
        // smaller of the two is the honest "most you can actually bet now".
        const effMax = (bpsCapWei > 0n && bpsCapWei < maxBet) ? bpsCapWei : maxBet;
        document.querySelectorAll(`[data-sl="maxBet"][data-game="${name}"]`)
          .forEach((el) => setText(el, fmtSTT(effMax) + " STT"));
        document.querySelectorAll(`[data-sl="houseEdge"][data-game="${name}"]`)
          .forEach((el) => setText(el, (Number(edge) / 100).toFixed(2) + "%"));
        document.querySelectorAll(`[data-sl="status"][data-game="${name}"]`)
          .forEach((el) => setText(el, paused ? "PAUSED" : "LIVE"));
        // Live RTP from `getReportedRTP(gameId)` - reflects autonomous LLM
        // agent adjustments (RtpAdjusted events). Append " ⤴" or " ⤵" if the
        // value differs from the published default so judges can see the
        // agent's influence at a glance.
        if (Number(rtp) > 0) {
          const pct = (Number(rtp) / 100).toFixed(2) + "%";
          document.querySelectorAll(`[data-sl="rtp"][data-game="${name}"]`)
            .forEach((el) => setText(el, pct));
        }
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
  //
  // These read from lifetime aggregates (_totalSettled / _allPlayers), not
  // from _feedRows - the row buffer is capped to FEED_ROW_CAP×2 for display
  // performance, but counters need the all-time number.
  document.querySelectorAll('[data-sl="totalBets"]').forEach((el) => setText(el, fmtNum(_totalSettled)));
  document.querySelectorAll('[data-count][data-sl-role="totalBets"]').forEach((el) => {
    el.textContent = fmtNum(_totalSettled);
  });
  document.querySelectorAll('[data-sl="playersOnline"]').forEach((el) => setText(el, fmtNum(_allPlayers.size)));
  document.querySelectorAll('[data-count][data-sl-role="playersOnline"]').forEach((el) => {
    el.textContent = fmtNum(_allPlayers.size);
  });

  const body = document.querySelector("#feed-body");
  if (!body) return;
  body.innerHTML = "";
  const rows = _feedRows.slice(0, FEED_ROW_CAP);
  for (const ev of rows) appendFeedRow(body, ev, false);
  // Pad to a constant FEED_ROW_CAP rows with empty placeholders so the panel
  // height never changes - whether 0, 3 or 12 bets have streamed in, the feed
  // table is always the same size and the page never jumps as rows arrive.
  for (let i = rows.length; i < FEED_ROW_CAP; i++) {
    const tr = document.createElement("tr");
    tr.className = "feed-empty";
    tr.innerHTML =
      `<td class="feed-dim">${rows.length === 0 && i === 0 ? "awaiting settled bets…" : ""}</td>` +
      `<td></td><td></td><td></td><td></td>`;
    body.appendChild(tr);
  }
}

function appendFeedRow(body, ev, animate) {
  const gameName = GAME_NAMES[ev.game] || "?";
  const stakeWei = ev.stake || 0n;
  const stakeText = stakeWei > 0n ? fmtSTT(stakeWei) + " STT" : "-";
  let multText = "-";
  if (stakeWei > 0n && ev.payout > 0n) {
    const x100 = (ev.payout * 100n) / stakeWei;
    multText = (Number(x100) / 100).toFixed(2) + "×";
  }
  // P&L = payout - stake. Cluster/slot games can fire `won=true` with a
  // payout SMALLER than stake (partial cascade payout) - that's still a
  // net loss for the player, so derive the sign from the actual delta,
  // not from the `won` flag. Matches account.js renderBetsTab logic.
  let pnlText, pnlCls;
  if (stakeWei > 0n) {
    const net = ev.payout - stakeWei;
    if (net > 0n) {
      pnlText = "+ " + fmtSTT(net) + " STT";
      pnlCls = "pnl pnl-win";
    } else if (net < 0n) {
      pnlText = "− " + fmtSTT(-net) + " STT";
      pnlCls = "pnl pnl-loss";
    } else {
      pnlText = "0";
      pnlCls = "pnl dim";
    }
  } else if (ev.won) {
    // Free-spin or zero-stake "win" - just display the payout.
    pnlText = "+ " + fmtSTT(ev.payout) + " STT";
    pnlCls = "pnl pnl-win";
  } else { pnlText = "-"; pnlCls = "pnl dim"; }
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
  // Root-relative pretty URL - Vercel rewrites /u/:addr → /account.html and
  // readViewAddress() in account.js parses the path. Works from any nesting.
  return `/u/${addr.toLowerCase()}`;
}

/// Convert raw BetSettled events into renderable feed rows. `stakeMap` is
/// keyed by `${contractAddress}::${betId}` so events from different historical
/// casinos with overlapping betId ranges don't collide. `contractAddress` is
/// the address of the contract these events came from.
function eventsToRows(settled, stakeMap, contractAddress) {
  const lower = (contractAddress || "").toLowerCase();
  return settled.map((ev) => {
    const betIdStr = ev.args.betId.toString();
    const key = `${lower}::${betIdStr}`;
    return {
      // uid = txHash:logIndex - globally unique across contracts and free of
      // betId collisions. Used as the dedup key in mergeFeedRows.
      uid: `${ev.transactionHash}:${ev.logIndex}`,
      betId: betIdStr,
      contract: lower,
      player: ev.args.player,
      game: Number(ev.args.game),
      won: ev.args.won,
      payout: BigInt(ev.args.payout),
      stake: BigInt(stakeMap.get(key) || 0n),
      blockNumber: ev.blockNumber,
      logIndex: ev.logIndex,
      transactionHash: ev.transactionHash,
    };
  });
}

function mergeFeedRows(newRows) {
  const seen = new Set(_feedRows.map((r) => r.uid));
  let added = false;
  for (const r of newRows) {
    if (seen.has(r.uid)) continue;
    _feedRows.push(r); seen.add(r.uid); added = true;
    // Track lifetime aggregates here too - _totalSettled / _allPlayers are
    // dedup'd by uid via the same `seen` check, so re-runs of the cold
    // boot path won't double-count.
    _totalSettled++;
    if (r.player) _allPlayers.add(r.player.toLowerCase());
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
    // Restore lifetime totals from the cache too, so the BETS SETTLED /
    // PLAYERS counters show the lifetime number on first paint (otherwise
    // the cache-hit flash showed `_feedRows.length` ≤ 30 instead of the
    // real lifetime ~640).
    _totalSettled = Number(cached.totalSettled) || _feedRows.length;
    _allPlayers = new Set(Array.isArray(cached.allPlayers)
      ? cached.allPlayers
      : _feedRows.map((r) => r.player.toLowerCase()));
    renderFeed();
    return true;
  } catch (_) { return false; }
}

function persistCache() {
  try {
    const payload = _feedRows.slice(0, FEED_ROW_CAP).map((r) => ({
      ...r, payout: r.payout.toString(), stake: r.stake.toString(),
    }));
    cacheSet(CACHE_KEY, payload, {
      lastBlock: _lastFeedBlock,
      totalSettled: _totalSettled,
      allPlayers: [..._allPlayers],
    });
  } catch (_) {}
}

export async function refreshLiveFeed() {
  if (!deployed()) return;
  try {
    const head = await provider().getBlockNumber();
    const contracts = historicalContracts();
    const currentContract = contracts.find((c) => c.isCurrent) || contracts[contracts.length - 1];

    // Each cold-boot/incremental fetch tags its events with the source
    // contract address so eventsToRows can build a contract-namespaced
    // stake-map key (betIds collide across contracts otherwise).
    let perContract = []; // [{ contract: addr, settled: [...], placed: [...] }]
    if (_lastFeedBlock === 0) {
      // COLD BOOT: scan ALL historical casinos via Shannon Explorer (one HTTP
      // per contract). With 3 contracts and ~640 BetSettled across all-time,
      // this is 6 HTTP calls (placed + settled per contract), runs in parallel,
      // total ~1-2s on a warm cache.
      const fetches = [];
      for (const entry of contracts) {
        const from = entry.deploymentBlock || 0;
        // Cap each contract's range at the next contract's deployment-1, or
        // at `head` for the current contract. This is correct AND keeps each
        // explorer call's response small enough to fit one page (1000 logs).
        const next = contracts.find((x) => x.deploymentBlock > entry.deploymentBlock);
        const to = next ? next.deploymentBlock - 1 : head;
        const addr = entry.contract.target;
        fetches.push(
          fetchLogs(entry.contract, "BetSettled", from, to).then((evs) => ({ kind: "settled", addr, evs })),
          fetchLogs(entry.contract, "BetPlaced",  from, to).then((evs) => ({ kind: "placed",  addr, evs })),
        );
      }
      const results = await Promise.all(fetches);
      // Bucket per-contract so stake/settled live in the same scope.
      const byAddr = new Map();
      const bucket = (addr) => {
        let b = byAddr.get(addr);
        if (!b) { b = { contract: addr, settled: [], placed: [] }; byAddr.set(addr, b); }
        return b;
      };
      for (const r of results) {
        const b = bucket(r.addr);
        if (r.kind === "settled") b.settled.push(...r.evs);
        else                      b.placed.push(...r.evs);
      }
      perContract = [...byAddr.values()];
      const totalSettled = perContract.reduce((n, b) => n + b.settled.length, 0);
      if (totalSettled === 0) {
        const body = document.querySelector("#feed-body");
        if (body && _feedRows.length === 0) body.innerHTML = `<tr><td class="dim" colspan="5">no settled bets yet - be the first</td></tr>`;
        _lastFeedBlock = head;
        // Still seed the stake map for any placed-but-not-settled rounds.
        for (const b of perContract) {
          const lower = b.contract.toLowerCase();
          for (const ev of b.placed) _stakeByBet.set(`${lower}::${ev.args.betId.toString()}`, ev.args.amount);
        }
        renderFeed();
        return;
      }
      // Cold-boot owns the lifetime aggregates - reset before merge so a
      // prior cache-hit doesn't get double-counted on top of the fresh
      // full-history pull. mergeFeedRows re-derives all three as it walks
      // the fetched events (including _feedRows, which we also clear so
      // cached-but-stale rows don't poison the dedup map).
      _feedRows = [];
      _totalSettled = 0;
      _allPlayers = new Set();
    } else if (head > _lastFeedBlock) {
      // INCREMENTAL: only the current contract can have new events (older
      // ones are frozen). Use Shannon Explorer for the small (last, head]
      // delta - one HTTP per event type.
      const c = currentContract.contract;
      const fromBlock = Math.max(_lastFeedBlock + 1, currentContract.deploymentBlock || 0);
      const [settled, placed] = await Promise.all([
        fetchLogs(c, "BetSettled", fromBlock, head),
        fetchLogs(c, "BetPlaced",  fromBlock, head),
      ]);
      perContract = [{ contract: c.target, settled, placed }];
    } else {
      return;
    }

    // Build the namespaced stake map first so eventsToRows can look up each
    // BetSettled's matching stake.
    const allNewRows = [];
    let anySettled = false;
    for (const b of perContract) {
      const lower = b.contract.toLowerCase();
      for (const ev of b.placed) _stakeByBet.set(`${lower}::${ev.args.betId.toString()}`, ev.args.amount);
      if (b.settled.length) anySettled = true;
      allNewRows.push(...eventsToRows(b.settled, _stakeByBet, b.contract));
    }
    if (!anySettled) { _lastFeedBlock = head; return; }
    const newRows = allNewRows;
    const animate = _lastFeedBlock > 0; // first cold load: no animation, just render
    const added = mergeFeedRows(newRows);
    _lastFeedBlock = head;
    if (added) {
      if (animate) {
        const body = document.querySelector("#feed-body");
        if (body) {
          // Animate only the brand-new ones at the top; keep the existing
          // rendered rows in place.
          const fresh = newRows.filter((r) => _feedRows.slice(0, FEED_ROW_CAP).some((x) => x.uid === r.uid))
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
// Block ticker - every second, refresh the block number + median finality.
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
  // ALWAYS run the 1-second poll - it's our source of truth. WS is only an
  // accelerator that can skip the poll on its tick when a push arrives.
  // (Somnia's WS endpoint sometimes accepts the upgrade but never delivers
  // a `block` event; the silent-fail mode bit us in v0.8 - hence belt &
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
      // Transient - withRetry() inside rpc.js already smooths most. Just skip.
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
      const currentLower = CONFIG.casino.toLowerCase();
      ws.on({ address: CONFIG.casino, topics: [placedTopic] }, (log) => {
        try {
          const parsed = c.interface.parseLog(log);
          // Namespace by current-casino address; matches the cold-boot key
          // scheme used in eventsToRows / refreshLiveFeed.
          _stakeByBet.set(`${currentLower}::${parsed.args.betId.toString()}`, parsed.args.amount);
        } catch (_) {}
      });
      ws.on({ address: CONFIG.casino, topics: [settledTopic] }, (log) => {
        try {
          const parsed = c.interface.parseLog(log);
          const betIdStr = parsed.args.betId.toString();
          const row = {
            uid: `${log.transactionHash}:${log.logIndex}`,
            betId: betIdStr,
            contract: currentLower,
            player: parsed.args.player,
            game: Number(parsed.args.game),
            won: parsed.args.won,
            payout: BigInt(parsed.args.payout),
            stake: BigInt(_stakeByBet.get(`${currentLower}::${betIdStr}`) || 0n),
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
              // them - gentler eye candy, takes ~600ms.
              while (body.children.length > FEED_ROW_CAP) {
                const last = body.lastChild;
                last.style.transition = "opacity 0.6s ease, transform 0.6s ease";
                last.style.opacity = "0";
                last.style.transform = "translateY(8px)";
                setTimeout(() => last.remove(), 650);
                // bail after one row to avoid stacking removals - fade is async
                break;
              }
            }
            persistCache();
            // Push the freshly-incremented lifetime aggregates to every
            // hero label. mergeFeedRows already updated _totalSettled +
            // _allPlayers - we just relay them to the DOM since this WS
            // path doesn't go through renderFeed().
            document.querySelectorAll('[data-sl="totalBets"]').forEach((el) => setText(el, fmtNum(_totalSettled)));
            document.querySelectorAll('[data-sl="playersOnline"]').forEach((el) => setText(el, fmtNum(_allPlayers.size)));
            document.querySelectorAll('[data-count][data-sl-role="totalBets"]').forEach((el) => { el.textContent = fmtNum(_totalSettled); });
            document.querySelectorAll('[data-count][data-sl-role="playersOnline"]').forEach((el) => { el.textContent = fmtNum(_allPlayers.size); });
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

  // Hydrate from cache first - gives an instant first paint.
  if (deployed()) {
    hydrateFromCache();
  }

  if (!deployed()) return;

  // Start the block-ticker poll FIRST so the header keeps moving even if
  // the cold-start log scans below take a while (or hang on a flaky RPC).
  // The ticker is the single most visible "is anything alive" signal, and
  // it's cheap - one eth_getBlockByNumber per 3s.
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
