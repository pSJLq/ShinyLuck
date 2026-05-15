// Aggregates BetPlaced + BetSettled events into a per-player leaderboard
// (wagered, P&L, bet count, favourite game). Pure on-chain — no DB.
//
// Uses raw eth_getLogs (lib/rpc.js) so it survives Somnia's missing
// `removed` field on log records.

import { ethers } from "https://esm.sh/ethers@6.13.2";
import { CONFIG } from "./config.js";
import { provider, fetchLogs, fetchDeploymentBlock } from "./rpc.js";

const GAME_NAMES = ["DICE","CRASH","SLOTS","MINES","PLINKO","ROULETTE"];
const ZERO = "0x0000000000000000000000000000000000000000";
const LOOKBACK = 200_000; // ~3 days on Somnia

let sortBy = "wagered";
let aggregate = [];
let myAddr = null;

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
  if (CONFIG.casino === ZERO) return null;
  const abi = [
    "event BetPlaced(uint256 indexed betId,address indexed player,uint8 indexed game,uint256 amount,bytes32 clientSeed,uint256 commitBlock,uint256 seedIdx,bytes params)",
    "event BetSettled(uint256 indexed betId,address indexed player,uint8 indexed game,bool won,uint256 payout,bytes32 randomness,bytes32 serverSeed,bytes32 clientSeed,bytes32 blockHash,uint256 nonce,bytes resultData)",
  ];
  const c = new ethers.Contract(CONFIG.casino, abi, provider());
  const dep = await fetchDeploymentBlock();
  const head = await provider().getBlockNumber();
  const from = Math.max(dep || head - LOOKBACK, head - LOOKBACK);
  const placed = await fetchLogs(c, "BetPlaced", from, head);
  const settled = await fetchLogs(c, "BetSettled", from, head);
  return { placed, settled };
}

function aggregateEvents({ placed, settled }) {
  const stakeByBet = new Map();
  const gameByBet = new Map();
  for (const ev of placed) {
    stakeByBet.set(ev.args.betId.toString(), ev.args.amount);
    gameByBet.set(ev.args.betId.toString(), Number(ev.args.game));
  }
  const byPlayer = new Map();
  for (const ev of settled) {
    const player = ev.args.player.toLowerCase();
    const betId = ev.args.betId.toString();
    const stake = stakeByBet.get(betId) || 0n;
    const payout = ev.args.payout;
    const game = gameByBet.get(betId) ?? Number(ev.args.game);
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
  const list = [];
  for (const p of byPlayer.values()) {
    let fav = -1, max = 0;
    for (const [g, n] of p.byGame) { if (n > max) { max = n; fav = g; } }
    list.push({
      addr: p.addr,
      wagered: p.wagered,
      pnl: p.payout - p.wagered,
      bets: p.bets,
      favourite: fav >= 0 ? GAME_NAMES[fav] : "—",
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

  const sorted = sortList(list).slice(0, 50);
  if (sorted.length === 0) {
    const empty = document.createElement("div");
    empty.className = "lb-row";
    empty.style.opacity = ".4";
    empty.innerHTML = `<div class="rk">—</div><div class="pl">no settled bets in window</div><div class="fv">—</div><div class="wg">—</div><div class="pl-v">—</div><div class="st">—</div>`;
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
    row.innerHTML =
      `<div class="rk${isMe ? " cyan" : ""}">#${i + 1}</div>` +
      `<div class="pl">${isMe ? "you · " : ""}${fmtAddr(e.addr)}</div>` +
      `<div class="fv"><span class="game-tag">${e.favourite}</span></div>` +
      `<div class="wg">${fmtSTT(e.wagered)} STT</div>` +
      `<div class="pl-v"><span class="${pnlSign}">${pnlText}</span></div>` +
      `<div class="st">${e.bets}</div>`;
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
    `Showing 1–${sorted.length} of ${list.length} · window ${LOOKBACK} blocks · sort: ${sortBy}`);
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
  refresh().catch((e) => console.warn("[lb] refresh:", e.message));
  setInterval(() => refresh().catch(() => {}), 20_000);
});
