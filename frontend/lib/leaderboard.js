// Aggregates BetPlaced + BetSettled events into a per-player leaderboard
// (wagered, P&L, bet count, favourite game). Pure on-chain - no DB.
//
// Uses raw eth_getLogs (lib/rpc.js) so it survives Somnia's missing
// `removed` field on log records.

import { ethers } from "/vendor/ethers.bundle.js";
import { CONFIG } from "./config.js";
import { provider, fetchLogs, fetchDeploymentBlock } from "./rpc.js";
import { scanPlaced, scanSettled, deploymentBlock as v15DeployBlock } from "./casino-sources.js";

const GAME_NAMES = ["DICE","CRASH","VAULT.7","MINES","PLINKO","ROULETTE","SUGAR.LAB"];
const ZERO = "0x0000000000000000000000000000000000000000";
// 20k blocks ≈ 7 hours on Somnia - same as feed. fetchDeploymentBlock
// further clamps to contract-age so cold-start scan stays under ~2s.
const LOOKBACK = 20_000;

let sortBy = "wagered";
let aggregate = [];
let myAddr = null;

// Pagination - 20 rows per page across all three sort modes.
const LB_PAGE_SIZE = 20;
let _lbPage = 0;

function mountLbPager(totalRows, pageIdx, onChange) {
  const root = document.querySelector("[data-sl-lb-table]");
  if (!root) return;
  let pager = root.parentElement.querySelector(".sl-pager[data-sl-lb-pager]");
  if (!pager) {
    pager = document.createElement("div");
    pager.className = "sl-pager";
    pager.setAttribute("data-sl-lb-pager", "1");
    root.parentElement.insertBefore(pager, root.nextSibling);
  }
  const totalPages = Math.max(1, Math.ceil(totalRows / LB_PAGE_SIZE));
  const safeIdx = Math.min(pageIdx, totalPages - 1);
  if (totalRows <= LB_PAGE_SIZE) { pager.style.display = "none"; return; }
  pager.style.display = "flex";
  pager.innerHTML = `
    <button data-pg-prev ${safeIdx <= 0 ? "disabled" : ""}>← PREV</button>
    <span>PAGE ${safeIdx + 1} / ${totalPages} · ${totalRows} players</span>
    <button data-pg-next ${safeIdx >= totalPages - 1 ? "disabled" : ""}>NEXT →</button>
  `;
  pager.querySelector("[data-pg-prev]").onclick = () => onChange(Math.max(0, safeIdx - 1));
  pager.querySelector("[data-pg-next]").onclick = () => onChange(Math.min(totalPages - 1, safeIdx + 1));
}

function fmtSTT(wei) {
  if (typeof wei !== "bigint") wei = BigInt(wei);
  const eth = Number(ethers.formatEther(wei));
  if (eth >= 1000) return eth.toFixed(0);
  if (eth >= 1) return eth.toFixed(2);
  if (eth >= 0.01) return eth.toFixed(3);
  return eth.toFixed(4);
}
function fmtAddr(a) { return `${a.slice(0,6)}…${a.slice(-4)}`; }

async function loadEvents() {
  const abi = [
    "event BetPlaced(uint256 indexed betId,address indexed player,uint8 indexed game,uint256 amount,bytes32 clientSeed,uint256 commitBlock,uint256 seedIdx,bytes params)",
    "event BetSettled(uint256 indexed betId,address indexed player,uint8 indexed game,bool won,uint256 payout,bytes32 randomness,bytes32 serverSeed,bytes32 clientSeed,bytes32 blockHash,uint256 nonce,bytes resultData)",
  ];
  const head = await provider().getBlockNumber();

  // Aggregate across every historical casino so the leaderboard reflects
  // lifetime activity, not just the latest redeploy's window. Each contract
  // gets one Shannon Explorer call per event type (parallel via Promise.all)
  // scoped to that contract's lifetime range.
  // NOTE: these are the FROZEN monoliths (v14 and older). The live casino is
  // v15, which spreads settlements over six contracts with a different event
  // signature (`uint16 indexed gameId` vs `uint8 indexed game` = different
  // topic0), so it is scanned separately below and merged.
  const list = Array.isArray(CONFIG.historicalCasinos) ? CONFIG.historicalCasinos : [];
  const withCurrent = [...list];
  if (CONFIG.casino && CONFIG.casino !== ZERO
      && !list.some((e) => e.address.toLowerCase() === CONFIG.casino.toLowerCase())) {
    withCurrent.push({ address: CONFIG.casino, deploymentBlock: 0 });
  }
  withCurrent.sort((a, b) => a.deploymentBlock - b.deploymentBlock);

  const aggPlaced = [], aggSettled = [];
  const fetches = [];
  const frozenAt = v15DeployBlock() ? v15DeployBlock() - 1 : head;
  withCurrent.forEach((entry, i) => {
    const c = new ethers.Contract(entry.address, abi, provider());
    const from = entry.deploymentBlock || 0;
    const to = (i + 1 < withCurrent.length) ? withCurrent[i + 1].deploymentBlock - 1 : frozenAt;
    fetches.push(
      fetchLogs(c, "BetPlaced",  from, to).then((evs) => {
        // Tag each event with its source contract so aggregateEvents can
        // build collision-free stake/game maps (betId space is per-contract).
        for (const ev of evs) ev.__addr = entry.address.toLowerCase();
        aggPlaced.push(...evs);
      }).catch(() => {}),
      fetchLogs(c, "BetSettled", from, to).then((evs) => {
        for (const ev of evs) ev.__addr = entry.address.toLowerCase();
        aggSettled.push(...evs);
      }).catch(() => {}),
    );
  });
  const [, v15Placed, v15Settled] = await Promise.all([
    Promise.all(fetches),
    scanPlaced(v15DeployBlock(), head),
    scanSettled(v15DeployBlock(), head, { onlyWins: false }),
  ]);
  return { placed: aggPlaced, settled: aggSettled, v15Placed, v15Settled };
}

function aggregateEvents({ placed, settled, v15Placed = [], v15Settled = [] }) {
  const stakeByBet = new Map();
  const gameByBet = new Map();
  // Namespace by source contract address (stored on ev.__addr by loadEvents)
  // so the same betId from different historical casinos doesn't collide.
  for (const ev of placed) {
    const key = `${ev.__addr || ""}::${ev.args.betId.toString()}`;
    stakeByBet.set(key, ev.args.amount);
    gameByBet.set(key, Number(ev.args.game));
  }
  const byPlayer = new Map();
  for (const ev of settled) {
    const player = ev.args.player.toLowerCase();
    const key = `${ev.__addr || ""}::${ev.args.betId.toString()}`;
    const stake = stakeByBet.get(key) || 0n;
    const payout = ev.args.payout;
    const game = gameByBet.get(key) ?? Number(ev.args.game);
    let p = byPlayer.get(player);
    if (!p) {
      p = { addr: ev.args.player, wagered: 0n, payout: 0n, bets: 0, byGame: new Map() };
      byPlayer.set(player, p);
    }
    p.wagered += stake;
    p.payout += BigInt(payout);
    p.bets += 1;
    p.byGame.set(game, (p.byGame.get(game) || 0) + 1);
  }
  // ── v15: wagers come from the placed scan, payouts from the settled scan ──
  // Keeping them separate matters because a busted mines game settles with no
  // cashout event at all — folding on settlements alone would lose that wager.
  const ent = (addr) => {
    const k = addr.toLowerCase();
    let p = byPlayer.get(k);
    if (!p) { p = { addr, wagered: 0n, payout: 0n, bets: 0, byGame: new Map() }; byPlayer.set(k, p); }
    return p;
  };
  for (const r of v15Placed) {
    if (!r.player) continue;
    const p = ent(r.player);
    p.wagered += BigInt(r.stake || 0n);
    p.bets += 1;
    p.byGame.set(r.gameId, (p.byGame.get(r.gameId) || 0) + 1);
  }
  for (const r of v15Settled) {
    if (!r.player) continue;
    ent(r.player).payout += BigInt(r.payout || 0n);
  }

  const list = [];
  for (const p of byPlayer.values()) {
    let fav = -1, max = 0;
    for (const [g, n] of p.byGame) { if (n > max) { max = n; fav = g; } }
    list.push({
      addr: p.addr,
      wagered: p.wagered,
      pnl: p.payout - p.wagered,
      bets: p.bets,
      favourite: fav >= 0 ? GAME_NAMES[fav] : "-",
    });
  }
  return list;
}

function sortList(list) {
  if (sortBy === "wagered") return [...list].sort((a, b) => (b.wagered > a.wagered ? 1 : b.wagered < a.wagered ? -1 : 0));
  if (sortBy === "pnl")     return [...list].sort((a, b) => (b.pnl > a.pnl ? 1 : b.pnl < a.pnl ? -1 : 0));
  if (sortBy === "bets")    return [...list].sort((a, b) => b.bets - a.bets);
  return list;
}

function render(list) {
  const root = document.querySelector("[data-sl-lb-table]");
  if (!root) return;
  const head = root.querySelector(".lb-row.head");
  root.innerHTML = "";
  if (head) root.appendChild(head);

  // Paginate the sorted board. 20 rows per page = compact, no scrolling.
  // Pager state is module-level so flipping sort buttons doesn't reset
  // the user's position unless they navigate away.
  const sortedFull = sortList(list);
  const totalPages = Math.max(1, Math.ceil(sortedFull.length / LB_PAGE_SIZE));
  if (_lbPage >= totalPages) _lbPage = 0;
  const startIdx = _lbPage * LB_PAGE_SIZE;
  const sorted = sortedFull.slice(startIdx, startIdx + LB_PAGE_SIZE);
  if (sorted.length === 0) {
    const empty = document.createElement("div");
    empty.className = "lb-row";
    empty.style.opacity = ".4";
    empty.innerHTML = `<div class="rk">-</div><div class="pl">no settled bets in window</div><div class="fv">-</div><div class="wg">-</div><div class="pl-v">-</div><div class="st">-</div>`;
    root.appendChild(empty);
    return;
  }
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    const row = document.createElement("div");
    row.className = "lb-row";
    const isMe = myAddr && e.addr.toLowerCase() === myAddr.toLowerCase();
    if (isMe) row.classList.add("you");
    const pnlSign = e.pnl >= 0n ? "green" : "red";
    const pnlText = (e.pnl >= 0n ? "+ " : "− ") + fmtSTT(e.pnl < 0n ? -e.pnl : e.pnl);
    // Find game index from favourite name for the per-game color tag.
    const favIdx = GAME_NAMES.indexOf(e.favourite);
    const favCls = favIdx >= 0 ? `g-${favIdx}` : "";
    row.innerHTML =
      `<div class="rk${isMe ? " cyan" : ""}">#${i + 1 + startIdx}</div>` +
      `<div class="pl tbl-dim">${isMe ? "you · " : ""}${fmtAddr(e.addr)}</div>` +
      `<div class="fv"><span class="game-tag ${favCls}">${e.favourite}</span></div>` +
      `<div class="wg tbl-dim">${fmtSTT(e.wagered)} STT</div>` +
      `<div class="pl-v"><span class="${pnlSign}">${pnlText}</span></div>` +
      `<div class="st tbl-dim">${e.bets}</div>`;
    root.appendChild(row);
  }
  const selfRow = document.querySelector("[data-sl-lb-self]");
  if (selfRow && myAddr) {
    const me = list.find((e) => e.addr.toLowerCase() === myAddr.toLowerCase());
    if (me) {
      const myRank = sortList(list).findIndex((e) => e.addr.toLowerCase() === myAddr.toLowerCase()) + 1;
      selfRow.style.display = "";
      document.querySelector("[data-sl-self-rank]").textContent = "#" + myRank;
      document.querySelector("[data-sl-self-addr]").textContent = "you · " + fmtAddr(me.addr);
      document.querySelector("[data-sl-self-fav]").textContent = me.favourite;
      document.querySelector("[data-sl-self-wagered]").textContent = fmtSTT(me.wagered) + " STT";
      const pnl = document.querySelector("[data-sl-self-pnl]");
      pnl.textContent = (me.pnl >= 0n ? "+ " : "− ") + fmtSTT(me.pnl < 0n ? -me.pnl : me.pnl);
      pnl.className = "pl-v " + (me.pnl >= 0n ? "green" : "red");
      document.querySelector("[data-sl-self-bets]").textContent = me.bets;
    }
  }
  document.querySelectorAll("[data-sl-lb-count]").forEach((el) => el.textContent = list.length.toString());
  document.querySelectorAll("[data-sl-lb-footer]").forEach((el) => el.textContent =
    `Showing ${startIdx + 1}-${startIdx + sorted.length} of ${sortedFull.length} · window ${LOOKBACK} blocks · sort: ${sortBy}`);

  mountLbPager(sortedFull.length, _lbPage, (idx) => {
    _lbPage = idx;
    render(aggregate);
  });
}

async function refresh() {
  const events = await loadEvents();
  if (!events) return;
  aggregate = aggregateEvents(events);
  render(aggregate);
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-sl-lb-sort]").forEach((btn) => {
    btn.addEventListener("click", () => {
      sortBy = btn.dataset.slLbSort;
      document.querySelectorAll("[data-sl-lb-sort]").forEach((b) => b.classList.toggle("on", b === btn));
      _lbPage = 0;                          // jump back to page 1 on sort change
      render(aggregate);
    });
  });
  document.addEventListener("shinyluck:connected", (e) => {
    myAddr = e.detail.address;
    render(aggregate);
  });
  if (window.ethereum && window.ethereum.selectedAddress) {
    myAddr = window.ethereum.selectedAddress;
  }
  // Loading gate: hide page-shell + splash holds until first refresh lands.
  document.body.dataset.loading = "1";
  refresh()
    .catch((e) => console.warn("[lb] refresh:", e.message))
    .finally(() => {
      delete document.body.dataset.loading;
      document.dispatchEvent(new CustomEvent("shinyluck:ready"));
    });
  setInterval(() => refresh().catch(() => {}), 20_000);
});
