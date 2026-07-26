/* ============================================================================
   Unified wins feed for the lobby · casino (BetSettled) + poker pots
   (HandSettled fold-wins + PotWinner showdown pots), straight from chain.

   Data path:
     · cold start  · Shannon Explorer indexer (one HTTP per event type)
     · live        · WebSocket push (instant) + a raw eth_getLogs tail poll as
                     the safety net · the explorer indexer lags a few seconds,
                     which is why it is NOT used for the live tail.

   Memory is bounded (see CAP_RECENT / CAP_BEST / CAP_SEATS): the feed can run
   for days without growing · recent rows are trimmed by block, while the
   all-time best payouts are kept separately so the "All Time" tab survives
   trimming.

   Mounts (rendered only when present):
     [data-wins-strip]   · "Latest wins" cards (casino + poker)
     [data-top-players]  · Daily Champion / Weekly Legend
     [data-biggest-wins] · tabbed table, 10 rows/page + pagination

   Poker winner attribution: pot events carry only (tableId, seat), so the
   winner is the latest PlayerSeated/TournamentSeated(tableId, seat) at or
   before the win block · exact, since a pot only pays an occupied seat.
   ========================================================================== */

import { ethers } from "/vendor/ethers.bundle.js";
import { CONFIG } from "./config.js";
import { provider, wsProvider, fetchLogs } from "./rpc.js";
import { resolveProfiles, DEFAULT_AVATAR } from "./profiles.js";
import { POKER_CONFIG } from "/poker/poker-config.js";
import { sources, deploymentBlock as v15DeployBlock } from "./casino-sources.js";

const CAP_RECENT = 1200; // rows kept by recency (covers Latest + 24h/7d/30d)
const CAP_BEST = 60;     // biggest payouts ever · survive recent-trimming
const CAP_SEATS = 12;    // seating events kept per table:seat

const CASINO_ABI = [
  "event BetPlaced(uint256 indexed betId,address indexed player,uint8 indexed game,uint256 amount,bytes32 clientSeed,uint256 commitBlock,uint256 seedIdx,bytes params)",
  "event BetSettled(uint256 indexed betId,address indexed player,uint8 indexed game,bool won,uint256 payout,bytes32 randomness,bytes32 serverSeed,bytes32 clientSeed,bytes32 blockHash,uint256 nonce,bytes resultData)",
];
const ROOM_ABI = [
  "event HandSettled(uint256 indexed tableId, uint64 indexed handId, uint8 winnerSeat, uint128 amountWon, uint128 rake)",
  "event PotWinner(uint256 indexed tableId, uint64 indexed handId, uint8 potIndex, uint8 seat, uint128 amount)",
  "event PlayerSeated(uint256 indexed tableId, uint8 indexed seat, address indexed player, uint128 buyIn)",
  "event TournamentSeated(uint256 indexed tableId, uint8 indexed seat, address indexed player, uint128 chips)",
];

const GAME_META = {
  0: { name: "Dice", art: "/assets/games/dice.png" },
  1: { name: "Crash", art: "/assets/games/crash.png" },
  2: { name: "VAULT.7", art: "/assets/games/vault7.png" },
  3: { name: "Mines", art: "/assets/games/mines.png" },
  4: { name: "Plinko", art: "/assets/games/plinko.png" },
  5: { name: "Roulette", art: "/assets/games/roulette.png" },
  6: { name: "SUGAR.LAB", art: "/assets/games/sugarlab.png" },
};

const $ = (s, r = document) => r.querySelector(s);

let room = null;
function contracts() {
  if (!room && POKER_CONFIG.pokerRoom) room = new ethers.Contract(POKER_CONFIG.pokerRoom, ROOM_ABI, provider());
  return { room };
}

// ---------------------------------------------------------------------------
// block → wall-clock estimate (Somnia sub-second blocks)
// ---------------------------------------------------------------------------
let _head = 0, _headTs = 0, _secPerBlock = 0.9;
async function calibrateClock() {
  const p = provider();
  const head = await p.getBlockNumber();
  const [a, b] = await Promise.all([p.getBlock(head), p.getBlock(Math.max(1, head - 500_000))]);
  _head = head;
  _headTs = a.timestamp;
  if (b && a.number > b.number) _secPerBlock = (a.timestamp - b.timestamp) / (a.number - b.number);
}
const blockTs = (bn) => (_headTs - (_head - bn) * _secPerBlock) * 1000;
const blocksAgo = (ms) => Math.max(0, Math.round(ms / 1000 / _secPerBlock));

function fmtTime(ms) {
  const d = new Date(ms);
  const mo = d.toLocaleString("en-US", { month: "short" });
  let h = d.getHours(); const ap = h >= 12 ? "pm" : "am"; h = h % 12 || 12;
  return `${mo} ${d.getDate()}, ${h}:${String(d.getMinutes()).padStart(2, "0")}${ap}`;
}
function fmtAgo(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return "JUST NOW";
  if (s < 5400) return Math.round(s / 60) + "M AGO";
  if (s < 129600) return Math.round(s / 3600) + "H AGO";
  return Math.round(s / 86400) + "D AGO";
}
const fmtSTT = (wei) => {
  const n = Number(ethers.formatEther(wei));
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 1) return n.toFixed(2).replace(/\.00$/, "");
  return n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
};

// ---------------------------------------------------------------------------
// bounded stores
// ---------------------------------------------------------------------------
// row: { key, src, gameName, art, player, stake|null, payout, net|null, block }
let rows = [];       // recent, block-desc, capped CAP_RECENT
let best = [];       // biggest payouts ever, payout-desc, capped CAP_BEST
const seen = new Set();
let lastBlock = 0;
const stakeBy = new Map(); // betId → stake (pruned with rows)

function trim() {
  rows.sort((a, b) => b.block - a.block);
  if (rows.length > CAP_RECENT) {
    for (const r of rows.slice(CAP_RECENT)) seen.delete(r.key);
    rows = rows.slice(0, CAP_RECENT);
  }
  best.sort((a, b) => (b.payout > a.payout ? 1 : b.payout < a.payout ? -1 : b.block - a.block));
  if (best.length > CAP_BEST) best = best.slice(0, CAP_BEST);
  if (stakeBy.size > CAP_RECENT * 2) {
    const keep = new Set(rows.map((r) => r.betId).filter(Boolean));
    for (const k of stakeBy.keys()) if (!keep.has(k)) stakeBy.delete(k);
  }
}

function pushRow(r) {
  if (seen.has(r.key)) return false;
  seen.add(r.key);
  rows.push(r);
  const isWin = r.payout > 0n && (r.net == null || r.net > 0n);
  if (isWin && !best.some((b) => b.key === r.key)) best.push(r);
  return true;
}

/// Build a feed row from ANY v15 source. `src` knows how to read its own event
/// shape (the six game contracts emit different events).
function rowFromSrc(src, ev, stake) {
  const g = GAME_META[src.game(ev)] || { name: "?", art: null };
  const payout = src.payout(ev);
  const player = (src.player(ev) || stakePlayer.get(src.key(ev)) || "0x").toLowerCase();
  const st = src.stakeDirect ? src.stakeDirect(ev) : stake;
  return {
    key: "c:" + ev.transactionHash + ":" + src.key(ev),
    betId: src.key(ev),
    src: "casino", gameName: g.name, art: g.art,
    player,
    stake: st ?? null,
    payout,
    net: st != null ? payout - st : null,
    block: ev.blockNumber,
  };
}
const stakePlayer = new Map();   // bid -> player, for events that omit it (mines)

function casinoRow(ev, stake) {
  const g = GAME_META[Number(ev.args.game)] || { name: "?", art: null };
  const payout = ev.args.payout;
  return {
    // Content key, identical however the log arrived (WS / poll / cold
    // start). tx+betId also stays unique when one roulette settle tx
    // emits many BetSettled logs. ev.logIndex was a trap: raw logs have
    // it, ethers-v6 WS Logs call it .index -> "NaN" keys -> duplicates.
    key: "c:" + ev.transactionHash + ":" + ev.args.betId.toString(),
    betId: ev.args.betId.toString(),
    src: "casino", gameName: g.name, art: g.art,
    player: ev.args.player.toLowerCase(),
    stake: stake ?? null,
    payout,
    net: stake != null ? payout - stake : null,
    block: ev.blockNumber,
  };
}

// tableId:seat → [{block, player}] (bounded)
const seatHistory = new Map();
const seatKey = (t, s) => t + ":" + s;
function recordSeat(tableId, seat, player, block) {
  const k = seatKey(tableId, seat);
  const list = seatHistory.get(k) || [];
  if (list.some((e) => e.block === block && e.player === player)) return;
  list.push({ block, player: player.toLowerCase() });
  list.sort((a, b) => a.block - b.block);
  while (list.length > CAP_SEATS) list.shift();
  seatHistory.set(k, list);
}
function seatOwnerAt(tableId, seat, block) {
  const list = seatHistory.get(seatKey(tableId, seat));
  if (!list) return null;
  let owner = null;
  for (const e of list) { if (e.block <= block) owner = e.player; else break; }
  return owner;
}
function pokerRow(ev, seat, amount) {
  const player = seatOwnerAt(Number(ev.args.tableId), seat, ev.blockNumber);
  if (!player) return null; // seating unknown · skip rather than misattribute
  return {
    key: "p:" + ev.transactionHash + ":" + ev.name + ":" + seat,
    src: "poker", gameName: "Poker", art: null,
    player, stake: null, payout: amount, net: amount,
    block: ev.blockNumber,
  };
}

// ---------------------------------------------------------------------------
// cold start (explorer indexer) + tail poll (raw RPC · no indexer lag)
// ---------------------------------------------------------------------------
async function backfill() {
  const { room: r } = contracts();
  const head = await provider().getBlockNumber();
  const from = Math.max(0, v15DeployBlock() - 10);

  for (const src of sources()) {
    if (src.placed) {
      const placed = await fetchLogs(src.c, src.placed, from, head).catch(() => []);
      for (const ev of placed) {
        stakeBy.set(src.stakeKey(ev), src.stakeOf(ev));
        if (ev.args.player) stakePlayer.set(src.stakeKey(ev), ev.args.player);
      }
    }
    const settled = await fetchLogs(src.c, src.settled, from, head).catch(() => []);
    for (const ev of settled) pushRow(rowFromSrc(src, ev, stakeBy.get(src.key(ev))));
  }

  if (r) {
    const [seated, trnSeated, folds, pots] = await Promise.all([
      fetchLogs(r, "PlayerSeated", 0, head).catch(() => []),
      fetchLogs(r, "TournamentSeated", 0, head).catch(() => []),
      fetchLogs(r, "HandSettled", 0, head).catch(() => []),
      fetchLogs(r, "PotWinner", 0, head).catch(() => []),
    ]);
    for (const ev of [...seated, ...trnSeated]) recordSeat(Number(ev.args.tableId), Number(ev.args.seat), ev.args.player, ev.blockNumber);
    for (const ev of folds) { if (ev.args.amountWon > 0n) { const row = pokerRow(ev, Number(ev.args.winnerSeat), ev.args.amountWon); if (row) pushRow(row); } }
    for (const ev of pots) { if (ev.args.amount > 0n) { const row = pokerRow(ev, Number(ev.args.seat), ev.args.amount); if (row) pushRow(row); } }
  }
  lastBlock = head;
  trim();
}

/// Raw eth_getLogs tail · the explorer indexer lags, this does not.
async function pollTail() {
  const p = provider();
  const head = await p.getBlockNumber();
  if (head <= lastBlock) return 0;
  // Somnia caps eth_getLogs at a 1000-block range.
  const from = Math.max(lastBlock + 1, head - 900);
  const { room: r } = contracts();
  const grab = async (contract, evName) => {
    const topic = contract.interface.getEvent(evName).topicHash;
    const logs = await p.send("eth_getLogs", [{
      address: contract.target, topics: [topic],
      fromBlock: "0x" + from.toString(16), toBlock: "0x" + head.toString(16),
    }]).catch(() => []);
    return logs.map((lg) => {
      try {
        const parsed = contract.interface.parseLog({ topics: lg.topics, data: lg.data });
        return { name: parsed.name, args: parsed.args, blockNumber: parseInt(lg.blockNumber, 16), transactionHash: lg.transactionHash, logIndex: parseInt(lg.logIndex, 16) };
      } catch (_) { return null; }
    }).filter(Boolean);
  };

  let added = 0;
  for (const src of sources()) {
    if (src.placed) {
      for (const ev of await grab(src.c, src.placed)) {
        stakeBy.set(src.stakeKey(ev), src.stakeOf(ev));
        if (ev.args.player) stakePlayer.set(src.stakeKey(ev), ev.args.player);
      }
    }
    for (const ev of await grab(src.c, src.settled)) {
      if (pushRow(rowFromSrc(src, ev, stakeBy.get(src.key(ev))))) added++;
    }
  }

  if (r) {
    const [seated, trnSeated, folds, pots] = await Promise.all([
      grab(r, "PlayerSeated"), grab(r, "TournamentSeated"), grab(r, "HandSettled"), grab(r, "PotWinner"),
    ]);
    for (const ev of [...seated, ...trnSeated]) recordSeat(Number(ev.args.tableId), Number(ev.args.seat), ev.args.player, ev.blockNumber);
    for (const ev of folds) if (ev.args.amountWon > 0n) { const row = pokerRow(ev, Number(ev.args.winnerSeat), ev.args.amountWon); if (row && pushRow(row)) added++; }
    for (const ev of pots) if (ev.args.amount > 0n) { const row = pokerRow(ev, Number(ev.args.seat), ev.args.amount); if (row && pushRow(row)) added++; }
  }
  lastBlock = head;
  if (added) trim();
  return added;
}

// ---------------------------------------------------------------------------
// live push (WebSocket) · a win lands in the UI ~instantly
// ---------------------------------------------------------------------------
// A profile edit (avatar/nickname) must reach rows already on screen · the row
// data is unchanged, only its rendering is stale.
if (typeof window !== "undefined") {
  window.addEventListener("shinyluck:profile-changed", () => queueRender());
}

let renderQueued = false;
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => { renderQueued = false; renderAll(); }, 120); // coalesce bursts
}

// The socket is disposable (rpc.js rebuilds dropped ones), so remember WHICH
// socket we attached to · re-subscribing to the same one would stack duplicate
// listeners on every poll tick.
let _subbedTo = null;
function subscribeLive() {
  const ws = wsProvider();
  if (!ws || ws === _subbedTo) return !!ws;
  _subbedTo = ws;
  const { room: r } = contracts();
  const on = (contract, evName, handler) => {
    try {
      const topic = contract.interface.getEvent(evName).topicHash;
      ws.on({ address: contract.target, topics: [topic] }, (log) => {
        try {
          const parsed = contract.interface.parseLog({ topics: log.topics, data: log.data });
          const ev = { name: parsed.name, args: parsed.args, blockNumber: Number(log.blockNumber), transactionHash: log.transactionHash, logIndex: Number(log.logIndex ?? log.index) };
          if (handler(ev)) { trim(); queueRender(); }
        } catch (_) {}
      });
    } catch (_) {}
  };

  for (const src of sources()) {
    if (src.placed) on(src.c, src.placed, (ev) => {
      stakeBy.set(src.stakeKey(ev), src.stakeOf(ev));
      if (ev.args.player) stakePlayer.set(src.stakeKey(ev), ev.args.player);
      return false;
    });
    on(src.c, src.settled, (ev) => pushRow(rowFromSrc(src, ev, stakeBy.get(src.key(ev)))));
  }
  if (r) {
    on(r, "PlayerSeated", (ev) => { recordSeat(Number(ev.args.tableId), Number(ev.args.seat), ev.args.player, ev.blockNumber); return false; });
    on(r, "TournamentSeated", (ev) => { recordSeat(Number(ev.args.tableId), Number(ev.args.seat), ev.args.player, ev.blockNumber); return false; });
    on(r, "HandSettled", (ev) => { if (!(ev.args.amountWon > 0n)) return false; const row = pokerRow(ev, Number(ev.args.winnerSeat), ev.args.amountWon); return row ? pushRow(row) : false; });
    on(r, "PotWinner", (ev) => { if (!(ev.args.amount > 0n)) return false; const row = pokerRow(ev, Number(ev.args.seat), ev.args.amount); return row ? pushRow(row) : false; });
  }
  return true;
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------
const PAGE = 10;
let tab = "24h";
let page = 0;

function windowRows(kind) {
  if (kind === "latest") return rows.slice();
  const wins = rows.filter((r) => r.payout > 0n && (r.net == null || r.net > 0n));
  const byPayout = (x, y) => (y.payout > x.payout ? 1 : y.payout < x.payout ? -1 : y.block - x.block);
  if (kind === "all") {
    const merged = [...best];
    for (const r of wins) if (!merged.some((m) => m.key === r.key)) merged.push(r);
    return merged.sort(byPayout);
  }
  const cut = { "24h": 86400e3, "7d": 7 * 86400e3, "30d": 30 * 86400e3 }[kind];
  const minBlock = _head - blocksAgo(cut);
  return wins.filter((r) => r.block >= minBlock).sort(byPayout);
}

const artCell = (r) => r.art
  ? `<img src="${r.art}" alt="" style="width:30px;height:30px;border-radius:8px;object-fit:cover;flex:none">`
  : `<span style="display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;background:radial-gradient(120% 120% at 50% 20%,#17130B,#050506 80%);border:1px solid #24242C;color:var(--gold);font-size:15px;flex:none">♠</span>`;

const avaCell = (p, size = 22) =>
  `<img src="${p.avatar}" alt="" style="width:${size}px;height:${size}px;border-radius:999px;object-fit:cover;flex:none;border:1px solid #24242C;background:#0E0E11">`;

// Rows that were already on screen must not replay an entry animation when a
// re-render rebuilds the DOM around them - only genuinely NEW wins slide in.
// The first paint after a cold start marks everything seen without animating.
const _seenRowKeys = new Set();
let _feedsPainted = false;
const _rowKey = (r) => r.key;
function _freshClass(r) {
  if (!_feedsPainted || _seenRowKeys.has(_rowKey(r))) return "";
  return " sl-win-new";
}
function _markSeen(list) {
  for (const r of list) _seenRowKeys.add(_rowKey(r));
  _feedsPainted = true;
  if (_seenRowKeys.size > 4000) _seenRowKeys.clear(); // unbounded-set guard; worst case one replayed animation
}

async function renderStrip() {
  const mount = $("[data-wins-strip]");
  if (!mount) return;
  const list = rows.filter((r) => r.payout > 0n && (r.net == null || r.net > 0n)).slice(0, 12);
  if (!list.length) { mount.innerHTML = `<span style="font:400 11px var(--mono);color:var(--fg-ghost);padding:8px 2px">no wins yet · be the first</span>`; return; }
  const profs = await resolveProfiles(list.map((r) => r.player));
  mount.innerHTML = list.map((r) => {
    const p = profs.get(r.player) || { name: r.player.slice(0, 8), avatar: DEFAULT_AVATAR };
    const bgArt = r.art ? `url('${r.art}') center/cover` : `radial-gradient(120% 150% at 50% -20%,#2a2313,#0B0A08 75%)`;
    return `
    <div style="flex:none;width:150px;border:1px solid #1C1C22;background:#0E0E11;border-radius:14px;overflow:hidden" class="hv-cardline${_freshClass(r)}">
      <div style="position:relative;height:78px;background:${bgArt}">
        ${r.art ? "" : `<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--gold);font-size:30px;opacity:.85">♠</span>`}
        <span style="position:absolute;left:0;right:0;bottom:0;height:40px;background:linear-gradient(180deg,transparent,rgba(5,5,6,.9))"></span>
        <span style="position:absolute;left:9px;bottom:6px;font:600 12px var(--mono);color:var(--green);text-shadow:0 1px 8px rgba(0,0,0,.9)">+${fmtSTT(r.payout)} STT</span>
        <span style="position:absolute;right:8px;top:7px;font:600 7.5px var(--mono);letter-spacing:.14em;color:#F2EEE6;background:rgba(5,5,6,.65);border:1px solid #24242C;border-radius:6px;padding:2.5px 6px">${r.gameName.toUpperCase()}</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;padding:8px 10px">
        ${avaCell(p, 18)}
        <span data-no-i18n style="font:500 9.5px var(--mono);color:#C8C6BE;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.name}</span>
      </div>
    </div>`;
  }).join("");
}

async function renderTopPlayers() {
  const wrap = $("[data-top-players]");
  if (!wrap) return;
  const mount = $("[data-top-players-body]", wrap) || wrap;
  const day = windowRows("24h")[0] || null;
  const week = windowRows("7d")[0] || null;
  if (!day && !week) { wrap.style.display = "none"; return; }
  wrap.style.display = "";
  const profs = await resolveProfiles([day?.player, week?.player].filter(Boolean));
  const card = (r, label, color) => {
    if (!r) return `<div class="card2" style="padding:22px;display:flex;align-items:center;justify-content:center;font:400 12px var(--mono);color:var(--fg-ghost)">no wins in this window yet</div>`;
    const p = profs.get(r.player) || { name: r.player.slice(0, 8), avatar: DEFAULT_AVATAR };
    const mult = r.stake && r.stake > 0n ? (Number(r.payout * 100n / r.stake) / 100).toFixed(2) + "x" : null;
    return `
    <div class="card2" style="padding:22px 24px;display:flex;flex-direction:column;gap:14px">
      <div style="display:flex;align-items:center;gap:13px">
        ${avaCell(p, 52)}
        <div style="min-width:0">
          <div data-no-i18n style="font:700 17px var(--sans);color:var(--fg-strong);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.name}</div>
          <div style="font:600 12px var(--sans);color:${color};margin-top:2px">${label}</div>
          <div style="font:600 8.5px var(--mono);letter-spacing:.16em;color:var(--fg-ghost);margin-top:3px">${fmtAgo(blockTs(r.block))}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <span style="font:700 42px/1 var(--sans);letter-spacing:-.02em;color:var(--fg-strong)">${fmtSTT(r.payout)} STT</span>
        ${mult ? `<span style="font:600 11px var(--mono);color:${color};border:1px solid ${color}55;border-radius:8px;padding:4px 8px">${mult}</span>` : ""}
      </div>
      <div style="font:400 13px var(--sans);color:var(--fg-mute)">Win <b style="color:var(--fg)">${r.gameName}</b></div>
    </div>`;
  };
  mount.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px" data-r-grid-m1>
      ${card(day, "Daily Champion", "var(--green)")}
      ${card(week, "Weekly Legend", "var(--gold-mid)")}
    </div>`;
}

async function renderBiggest() {
  const mount = $("[data-biggest-wins]");
  if (!mount) return;
  const body = $("[data-bw-body]", mount);
  const pager = $("[data-bw-pager]", mount);
  if (!body) return;
  const list = windowRows(tab);
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  if (page >= pages) page = pages - 1;
  const slice = list.slice(page * PAGE, page * PAGE + PAGE);
  if (!slice.length) {
    body.innerHTML = `<tr><td colspan="5" style="padding:20px;font:400 11px var(--mono);color:var(--fg-ghost)">nothing here yet</td></tr>`;
  } else {
    const profs = await resolveProfiles(slice.map((r) => r.player));
    body.innerHTML = slice.map((r) => {
      const p = profs.get(r.player) || { name: r.player.slice(0, 8), avatar: DEFAULT_AVATAR };
      const win = r.net == null ? r.payout > 0n : r.net > 0n;
      return `<tr class="${_freshClass(r).trim()}">
        <td><span style="display:inline-flex;align-items:center;gap:9px">${artCell(r)}<span style="font:500 12px var(--sans);color:var(--fg)">${r.gameName}</span></span></td>
        <td style="font:500 11.5px var(--mono);color:var(--fg-mute)">${r.stake != null ? fmtSTT(r.stake) + " STT" : "-"}</td>
        <td style="font:600 12px var(--mono);color:${win ? "var(--green)" : "var(--fg-mute)"}">${fmtSTT(r.payout)} STT</td>
        <td><span style="display:inline-flex;align-items:center;gap:8px">${avaCell(p)}<span data-no-i18n style="font:500 11.5px var(--mono);color:#C8C6BE">${p.name}</span></span></td>
        <td style="text-align:right;font:400 11px var(--mono);color:var(--fg-faint)">${fmtTime(blockTs(r.block))}</td>
      </tr>`;
    }).join("");
  }
  if (pager) {
    pager.innerHTML = `
      <button data-bw-prev class="bw-pgbtn" ${page === 0 ? "disabled" : ""}>‹ Previous</button>
      <span style="flex:1;text-align:center;font:500 11px var(--mono);color:var(--fg-faint)">Page ${page + 1} of ${pages}</span>
      <button data-bw-next class="bw-pgbtn" ${page >= pages - 1 ? "disabled" : ""}>Next ›</button>`;
  }
}

function renderAll() {
  setTimeout(() => _markSeen(rows), 0); // after this pass painted
  renderStrip().catch(() => {});
  renderTopPlayers().catch(() => {});
  renderBiggest().catch(() => {});
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
export async function initWins() {
  const mount = $("[data-biggest-wins]");
  if (mount) {
    mount.addEventListener("click", (e) => {
      const t = e.target.closest("[data-bw-tab]");
      if (t) {
        tab = t.dataset.bwTab;
        page = 0;
        mount.querySelectorAll("[data-bw-tab]").forEach((b) => b.classList.toggle("on", b === t));
        renderBiggest().catch(() => {});
        return;
      }
      if (e.target.closest("[data-bw-prev]") && page > 0) { page--; renderBiggest().catch(() => {}); }
      if (e.target.closest("[data-bw-next]")) { page++; renderBiggest().catch(() => {}); }
    });
  }
  try { await calibrateClock(); } catch (_) {}
  try { await backfill(); } catch (e) { console.warn("[wins] backfill:", e.message); }
  renderAll();

  subscribeLive();
  // Safety net: WS can drop silently · a raw tail poll catches anything missed
  // and keeps the block→time mapping honest. Re-arms the WS if it died.
  setInterval(async () => {
    if (document.hidden) return;
    try {
      const blk = await provider().getBlock("latest");
      _head = blk.number; _headTs = blk.timestamp;
      const added = await pollTail();
      if (added > 0) queueRender();
      subscribeLive();
    } catch (_) {}
  }, 5_000);
}
