// Roulette - production wiring for the canvas RouletteGame component.
//
// The visual component (./roulette-ui.js) owns ALL rendering / animation /
// state and NEVER touches the chain. This module is the host glue:
//   - getRound()       : read the live on-chain round → open it in the UI
//   - onPlaceBets(norm): map UI bets → Casino.placeRouletteBets (one tx)
//   - RouletteRoundSettled → resolveRound(n): spin the wheel onto the EXACT
//     chain-drawn number (the only source of an outcome - no client RNG)
//   - RouletteRoundStarted → setRound(): roll the UI to the next open round
//
// Round lifecycle is driven entirely by the reveal-bot (ROUND_KEEPALIVE):
// it keeps one roulette round open at all times and settles each once its
// bet window + REVEAL_DELAY blocks have passed. So the wheel is continuous
// and synchronized for everyone - this page just observes + bets.

import { ethers } from "/vendor/ethers.bundle.js";
import { RouletteGame } from "./roulette-ui.js";
import { SL, connect } from "../wallet.js";
import { CONFIG } from "../config.js";
import { CHAINS } from "../shinyluck-sdk.js";
import { provider, fetchRecentLogs } from "../rpc.js";

// Shannon Explorer base for verify-links (same source the per-bet games use).
function explorerTxUrl(hash) {
  try {
    const net = CHAINS[CONFIG.network] || CHAINS.somniaTestnet;
    const base = (net.blockExplorerUrls[0] || "").replace(/\/$/, "");
    return hash ? `${base}/tx/${hash}` : base;
  } catch (_) { return "#"; }
}

// Casino.RouletteBetKind enum - MUST match the contract.
const KIND = {
  STRAIGHT: 0, RED: 1, BLACK: 2, EVEN: 3, ODD: 4,
  LOW: 5, HIGH: 6, DOZEN_1: 7, DOZEN_2: 8, DOZEN_3: 9,
};
// Human label per kind for the live feed.
const KIND_LABEL = ["STRAIGHT", "RED", "BLACK", "EVEN", "ODD", "LOW", "HIGH", "DOZEN", "DOZEN", "DOZEN"];

const ABI = [
  "function currentRouletteRoundId() view returns (uint256)",
  "function totalRouletteRounds() view returns (uint256)",
  "function getRouletteRound(uint256) view returns (uint64 id,uint64 betWindowEnd,uint64 commitBlock,uint32 seedIdx,bool settled,uint8 resultNumber,bytes32 serverSeed,uint256 bettorCount)",
  "event RouletteRoundStarted(uint256 indexed roundId,uint256 betWindowEnd,uint256 commitBlock,uint256 seedIdx)",
  "event RouletteRoundSettled(uint256 indexed roundId,uint8 resultNumber,bytes32 serverSeed,bytes32 randomness)",
  "event RouletteBetPlaced(uint256 indexed roundId,address indexed player,uint8 kind,uint8 number,uint256 amount)",
];

let ro = null;
function casino() {
  if (!ro) ro = new ethers.Contract(CONFIG.casino, ABI, provider());
  return ro;
}

// chain encodes "00" as 37; the component wants 0 | 1..36 | "00".
function displayResult(n) { n = Number(n); return n === 37 ? "00" : n; }

async function toast(msg, opts) {
  try { const { toast } = await import("../ui.js"); toast(msg, opts); } catch (_) {}
}

// Map a component bet ({type, numbers, amount}) → contract {kind, number, amountSTT}.
// The component encodes a "00" straight as numbers:[-1].
function mapBet(b) {
  const amountSTT = String(b.amount);
  const first = (b.numbers && b.numbers.length) ? Number(b.numbers[0]) : 0;
  switch (b.type) {
    case "straight": return { kind: KIND.STRAIGHT, number: first === -1 ? 37 : first, amountSTT };
    case "red":      return { kind: KIND.RED,   number: 0, amountSTT };
    case "black":    return { kind: KIND.BLACK, number: 0, amountSTT };
    case "even":     return { kind: KIND.EVEN,  number: 0, amountSTT };
    case "odd":      return { kind: KIND.ODD,   number: 0, amountSTT };
    case "low":      return { kind: KIND.LOW,   number: 0, amountSTT };
    case "high":     return { kind: KIND.HIGH,  number: 0, amountSTT };
    case "dozen":    return { kind: first <= 12 ? KIND.DOZEN_1 : (first <= 24 ? KIND.DOZEN_2 : KIND.DOZEN_3), number: 0, amountSTT };
    default: throw new Error("Unsupported bet type: " + b.type);
  }
}

async function readCurrentRound() {
  const c = casino();
  const total = Number(await c.totalRouletteRounds());
  if (total === 0) return null;
  const id = Number(await c.currentRouletteRoundId());
  const r = await c.getRouletteRound(id);
  return {
    id,
    betWindowEnd: Number(r.betWindowEnd ?? r[1]),
    settled: Boolean(r.settled ?? r[4]),
    resultNumber: Number(r.resultNumber ?? r[5]),
    bettorCount: Number(r.bettorCount ?? r[7]),
  };
}

async function fetchRecent(limit = 15) {
  try {
    const evs = await fetchRecentLogs(casino(), "RouletteRoundSettled", { minCount: limit, maxLookback: 20_000 });
    // fetchRecentLogs returns newest-first; the component wants oldest-first.
    return evs.slice(0, limit).reverse().map((e) => ({
      roundId: Number(e.args.roundId), number: displayResult(e.args.resultNumber),
    }));
  } catch (_) { return []; }
}

// ---------------------------------------------------------------------------
// mount + reconciler
// ---------------------------------------------------------------------------
let game = null;
let uiRoundId = -1;            // round currently shown OPEN in the UI
let resolving = false;         // true while a settle spin animation is playing
const resolvedRounds = new Set();
const placedRounds = new Set();// rounds where the local player placed a bet

function setGate(connected) {
  const g = document.getElementById("roulette-gate");
  if (g) g.style.display = connected ? "none" : "flex";
}

async function refreshBalance() {
  try {
    if (game && SL.address && SL.provider) game.setBalance(await SL.provider.getBalance(SL.address));
  } catch (_) {}
}

// After a round the local player bet on settles, pull any winnings out of
// pendingWithdrawals so the native balance reflects the win, then refresh.
async function claimAndRefresh() {
  try {
    if (SL.address && SL.casino) { const tx = await SL.casino.claim(); await tx.wait(); }
  } catch (_) { /* nothing to claim → estimateGas reverts, harmless */ }
  refreshBalance();
}

async function onSettled(id, resultNumber, fair) {
  if (!game || resolvedRounds.has(id)) return;
  resolvedRounds.add(id);
  resolving = true;
  try { await game.resolveRound(displayResult(resultNumber)); } catch (_) {}
  resolving = false;
  // Provably-fair: show the REAL revealed server seed + randomness from the
  // RouletteRoundSettled event, with a Shannon Explorer link to verify.
  try {
    game.setFair({
      roundId: id,
      result: displayResult(resultNumber),
      serverSeed: fair && fair.serverSeed,
      randomness: fair && fair.randomness,
      explorerUrl: fair && fair.txHash ? explorerTxUrl(fair.txHash) : explorerTxUrl(),
    });
  } catch (_) {}
  if (placedRounds.has(id)) { placedRounds.delete(id); claimAndRefresh(); }
  tick();
}

// Pull serverSeed + randomness for a settled round from its event log so the
// fair panel can be populated even when settle was detected via the poll path
// (which only reads the round struct, not the event's randomness field).
async function fetchFair(roundId) {
  try {
    const evs = await fetchRecentLogs(casino(), "RouletteRoundSettled", {
      minCount: 1, maxLookback: 50_000,
      filter: (e) => Number(e.args.roundId) === Number(roundId),
    });
    if (evs.length) {
      return { serverSeed: evs[0].args.serverSeed, randomness: evs[0].args.randomness, txHash: evs[0].transactionHash };
    }
  } catch (_) {}
  return null;
}

// One reconcile pass: (1) if the round we're showing has settled, spin it;
// (2) otherwise roll the UI to the latest open round. Event-triggered AND
// polled so we never miss a settle even if the WS/poll drops one.
async function tick() {
  if (!game || resolving) return;
  try {
    if (uiRoundId >= 0 && !resolvedRounds.has(uiRoundId)) {
      const r = await casino().getRouletteRound(uiRoundId);
      if (Boolean(r.settled ?? r[4])) {
        const fair = await fetchFair(uiRoundId);
        await onSettled(uiRoundId, Number(r.resultNumber ?? r[5]), fair || { serverSeed: r.serverSeed ?? r[6] });
        return;
      }
    }
    const cur = await readCurrentRound();
    if (!cur) return;
    const now = Math.floor(Date.now() / 1000);
    if (!cur.settled && cur.id !== uiRoundId && now < cur.betWindowEnd) {
      uiRoundId = cur.id;
      game.setRound({ roundId: cur.id, betWindowEndMs: cur.betWindowEnd * 1000, isOpen: true, bettorCount: cur.bettorCount });
    }
  } catch (_) {}
}

function mount() {
  const root = document.getElementById("roulette-root");
  if (!root || game) return;

  game = new RouletteGame(root, {
    mode: "production",
    chipDenoms: [0.01, 0.05, 0.1, 0.5],
    spinMs: 4200, turboSpinMs: 2200, payMs: 3000,
    startBalance: 0,
    currency: "STT",

    // Called once on construction; subsequent rounds arrive via events/tick.
    getRound: async () => {
      const [cur, recentResults] = await Promise.all([readCurrentRound(), fetchRecent(15)]);
      const now = Math.floor(Date.now() / 1000);
      if (cur && !cur.settled && now < cur.betWindowEnd) {
        uiRoundId = cur.id;
        return { roundId: cur.id, betWindowEndMs: cur.betWindowEnd * 1000, isOpen: true, bettorCount: cur.bettorCount, recentResults };
      }
      // No open round yet (between settle + next open) - seed history only and
      // sit in the idle "waiting for round" state. RouletteRoundStarted (or the
      // poll in tick()) opens the next one. Returning WITHOUT roundId/
      // betWindowEndMs makes setRound show "waiting" instead of a fake lock.
      return { recentResults };
    },

    // One tx for the whole basket. Contract enforces <= 5 bets/player/round.
    onPlaceBets: async (norm) => {
      if (!norm || norm.length === 0) throw new Error("no bets");
      if (norm.length > 5) { toast("Max 5 bets per round", { kind: "warn" }); throw new Error("max 5 bets per round"); }
      await connect();
      const bets = norm.map(mapBet);
      const res = await SL.placeRoulette(bets);   // { roundId, txHash, blockNumber }
      if (uiRoundId >= 0) placedRounds.add(uiRoundId);
      return res;
    },

    onError: (e) => { if (e && e.message) toast(e.message, { kind: "warn" }); },
  });

  window.rouletteGame = game;

  // connection gate + initial balance
  setGate(Boolean(SL.address));
  if (SL.address) refreshBalance();

  // live chain subscriptions (read-only provider). tick() reconciles state.
  try {
    const c = casino();
    c.on("RouletteRoundSettled", (roundId, resultNumber, serverSeed, randomness, ev) => {
      const txHash = ev && (ev.log ? ev.log.transactionHash : ev.transactionHash);
      onSettled(Number(roundId), Number(resultNumber), { serverSeed, randomness, txHash });
    });
    c.on("RouletteRoundStarted", () => { tick(); });
    c.on("RouletteBetPlaced", (roundId, player, kind, number, amount) => {
      // Surface OTHER players' bets in the live feed (our own already show).
      try {
        if (SL.address && player && player.toLowerCase() === SL.address.toLowerCase()) return;
        game.pushCommunityBet({ type: KIND_LABEL[Number(kind)] || "BET", amount: Number(ethers.formatEther(amount)) });
      } catch (_) {}
    });
  } catch (_) {}

  // Poll fallback - keeps the wheel honest if a push is dropped.
  setInterval(tick, 3000);
  tick();
}

document.addEventListener("shinyluck:connected", () => { setGate(true); refreshBalance(); });
document.addEventListener("DOMContentLoaded", mount);
// Module scripts can load after DOMContentLoaded already fired.
if (document.readyState !== "loading") mount();
