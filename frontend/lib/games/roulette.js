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
// Round lifecycle (on-demand since 2026-07-14): the wheel no longer burns gas
// while empty. startRouletteRound() is permissionless, so when a CONNECTED
// player is at the table and no round is open, this page opens the next one
// itself (maybeStartRound below). While rounds keep receiving bets the house
// bot chains them (ROUND_ON_DEMAND) and settles every round as before.

import { ethers } from "/vendor/ethers.bundle.js";
import { RouletteGame } from "./roulette-ui.js";
import { SL, connect } from "../wallet.js";
import { CONFIG } from "../config.js";
import { CHAINS } from "../shinyluck-sdk.js";
import { provider, fetchRecentLogs } from "../rpc.js";
import { whenAuthSettled } from "../auth-gate.js";

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
  "function bonusModeActive() view returns (bool)",
  "event RouletteRoundStarted(uint256 indexed roundId,uint256 betWindowEnd,uint256 commitBlock,uint256 seedIdx)",
  "event RouletteRoundSettled(uint256 indexed roundId,uint8 resultNumber,bytes32 serverSeed,bytes32 randomness)",
  "event RouletteBetPlaced(uint256 indexed roundId,address indexed player,uint8 kind,uint8 number,uint256 amount)",
  "event BonusModeActivated(uint256 until,string reasoning)",
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

// Chain clock vs browser clock skew. The contract closes the bet window when
// block.timestamp >= betWindowEnd, but the UI counts down against Date.now().
// On Somnia the browser wall-clock can run several seconds AHEAD of chain
// time, so a bet placed at "UI 3s left" hits a window the chain already
// closed -> RoundClosed revert. We measure the skew from the latest block and
// translate every on-chain deadline into the equivalent wall-clock instant, so
// the countdown and the place-guard both track REAL chain time.
let chainSkewMs = 0; // wallNow_ms - chainNow_ms  (positive => browser ahead)
async function refreshChainSkew() {
  try {
    const blk = await provider().getBlock("latest");
    if (blk && blk.timestamp) chainSkewMs = Date.now() - blk.timestamp * 1000;
  } catch (_) {}
}
// Convert an on-chain betWindowEnd (seconds) to the wall-clock ms instant the
// window actually closes on-chain.
function endMsFromChain(betWindowEndSec) {
  return betWindowEndSec * 1000 + chainSkewMs;
}

// The instant the UI must STOP accepting bets. It is PLACE_CUTOFF_MS *before*
// the on-chain window closes, because a bet tx needs time to sign + mine and
// the contract reverts RoundClosed once block.timestamp >= betWindowEnd. We
// feed THIS to the component as its countdown/lock deadline so the visible "0"
// and the board-lock coincide exactly with when placing actually closes - no
// more "BETTING OPEN" ticking 3,2,1 while every bet bounces.
function bettingDeadlineMs(betWindowEndSec) {
  return endMsFromChain(betWindowEndSec) - PLACE_CUTOFF_MS;
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
let uiRoundEndMs = 0;          // betWindowEnd (ms) of the round shown OPEN
let resolving = false;         // true while a settle spin animation is playing
// True from the moment the shown round's betting window closes until its result
// has been resolved (spun). The chain opens the NEXT round the instant the
// current one's window closes - BEFORE the current round settles - so without
// this guard the UI would roll forward to round N+1's fresh countdown while it
// still owes the player the spin for round N. That produced the broken order
// "countdown -> drawing winning number -> a SECOND countdown -> spin". While
// awaiting, we hold on the locked round so the sequence is simply
// "countdown -> drawing -> spin -> next countdown".
let awaitingResult = false;
const resolvedRounds = new Set();
const placedRounds = new Set();// rounds where the local player placed a bet

// A bet tx needs a moment to sign + mine; if the on-chain window closes
// before it lands the contract reverts RoundClosed (the CALL_EXCEPTION users
// hit). Refuse to submit when under this many ms remain, and tell the user to
// catch the next round instead of firing a doomed tx.
const PLACE_CUTOFF_MS = 3000;

// The gate must never FLASH at a signed-in player while Privy restores the
// session · it only appears once auth has actually settled as signed-out.
let gateArmed = false;
function setGate(connected) {
  const g = document.getElementById("roulette-gate");
  if (!g) return;
  if (connected) { g.style.display = "none"; return; }
  if (gateArmed) g.style.display = "flex";
}
whenAuthSettled().then((authed) => {
  gateArmed = true;
  setGate(authed || Boolean(SL.address));
});

async function refreshBalance() {
  try {
    if (game && SL.address && SL.provider) game.setBalance(await SL.provider.getBalance(SL.address));
  } catch (_) {}
}

// Reflect the agent-triggered Bonus Mode on the wheel: when active, roulette
// pays ROULETTE_BONUS_BOOST_X100 extra on wins (contract-side) and the
// component shows its hotter bonus reskin. Driven by the same on-chain
// bonusModeActive() the slots use, so the news/bankroll agents reach roulette.
let bonusShown = false;
async function refreshBonus() {
  try {
    const on = await casino().bonusModeActive();
    if (on !== bonusShown) { bonusShown = on; if (game) game.setBonusMode(on); }
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
  awaitingResult = false;       // result is in; the spin now plays
  try { await game.resolveRound(displayResult(resultNumber)); } catch (_) {}
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
  // Hold the landed result on screen briefly so the winning number is readable
  // (resolving stays true so the RoundStarted handler defers), then release +
  // reconcile to the latest OPEN round. Kept short (1.2s): the full UI cycle
  // (this hold + lock + 4.2s spin + the chain's 1-4s settle lag) must fit
  // inside the ~18s on-chain round cadence, else each next countdown starts
  // mid-window and the visible timer shrinks round over round. tick() always
  // syncs to the freshest chain round + its REAL remaining window, so a short
  // hold keeps the UI locked to the chain instead of drifting behind it.
  setTimeout(() => { resolving = false; tick(); }, 800);
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

// ---------------------------------------------------------------------------
// On-demand round opener: with the house bot no longer idling the wheel, a
// connected player at the table opens the next round when none is open. The
// tx is tiny; races between two players are harmless (one lands, the other
// reverts RoundClosed and we just reconcile).
// ---------------------------------------------------------------------------
let startingRound = false;
let lastStartAttempt = 0;
async function maybeStartRound() {
  if (!game || resolving || awaitingResult) return;
  if (!SL.address || !SL.signer) return;       // only a signed-in player can open
  if (document.hidden) return;                 // and only while actually watching
  if (startingRound || Date.now() - lastStartAttempt < 12_000) return;
  startingRound = true;
  try {
    const cur = await readCurrentRound();
    const stillOpen = cur && !cur.settled && Date.now() < bettingDeadlineMs(cur.betWindowEnd);
    if (!stillOpen) {
      lastStartAttempt = Date.now();
      const c = new ethers.Contract(CONFIG.casino, ["function startRouletteRound()"], SL.signer);
      const tx = await c.startRouletteRound();
      await tx.wait();
      tick();
    }
  } catch (_) { /* lost the open race / game paused · reconcile on next tick */ }
  finally { startingRound = false; }
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
      // Shown round's window has closed but it hasn't settled yet -> we are
      // waiting for its result. Latch awaitingResult so we DON'T roll forward
      // to the next open round (which the chain has already started). The
      // component is showing "drawing winning number"; the next tick that sees
      // settled=true will spin it. This is what keeps the order correct.
      const closed = Date.now() >= bettingDeadlineMs(Number(r.betWindowEnd ?? r[1]));
      if (closed) { awaitingResult = true; return; }
    }
    // Not awaiting a result -> safe to advance to the latest open round.
    awaitingResult = false;
    const cur = await readCurrentRound();
    if (!cur) return;
    const endMs = endMsFromChain(cur.betWindowEnd);
    const deadlineMs = bettingDeadlineMs(cur.betWindowEnd);
    // Only show it OPEN if there is still real room to place a bet (past the
    // cutoff there is no point - the contract would reject it).
    if (!cur.settled && cur.id !== uiRoundId && Date.now() < deadlineMs) {
      uiRoundEndMs = endMs;
      uiRoundId = cur.id;
      game.setRound({ roundId: cur.id, betWindowEndMs: deadlineMs, isOpen: true, bettorCount: cur.bettorCount });
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
      await refreshChainSkew();
      const [cur, recentResults] = await Promise.all([readCurrentRound(), fetchRecent(15)]);
      const endMs = cur ? endMsFromChain(cur.betWindowEnd) : 0;
      const deadlineMs = cur ? bettingDeadlineMs(cur.betWindowEnd) : 0;
      if (cur && !cur.settled && Date.now() < deadlineMs) {
        uiRoundEndMs = endMs;
        uiRoundId = cur.id;
        return { roundId: cur.id, betWindowEndMs: deadlineMs, isOpen: true, bettorCount: cur.bettorCount, recentResults };
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
      // Window guard: if the round is about to close, the tx can't land in
      // time and the contract reverts RoundClosed. Bounce it with a friendly
      // message instead of the raw CALL_EXCEPTION and let the player catch the
      // next round (a fresh one opens within a few seconds).
      const msLeft = uiRoundEndMs - Date.now();
      if (uiRoundEndMs && msLeft < PLACE_CUTOFF_MS) {
        // Thrown message surfaces via the component's onError toast (single
        // toast, no duplicate). Bets stay in the basket for the next round.
        throw new Error("Bets just closed - catch the next round (opens in a few seconds)");
      }
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
    // Open the round the INSTANT it starts, straight from the event payload -
    // no RPC round-trip. This is what gives players the full window instead of
    // whatever was left by the time a poll noticed. BUT never open a new round
    // while the previous round's spin animation is still playing (resolving) -
    // that reset the countdown to "10 / BETTING OPEN" on top of the PAYOUT
    // wheel and froze the timer. If we're mid-spin, just let onSettled's
    // trailing tick() open the next round once the animation finishes.
    c.on("RouletteRoundStarted", (roundId, betWindowEnd, commitBlock, seedIdx, ev) => {
      try {
        // Hold while a spin is playing OR while we still owe the shown round its
        // result. The chain opens this next round the instant the current
        // window closes, well before the current round settles - rolling the UI
        // forward now would show a phantom second countdown before the spin.
        if (resolving || awaitingResult) return;
        const id = Number(roundId);
        if (resolvedRounds.has(id) || id === uiRoundId) return;
        const endMs = endMsFromChain(Number(betWindowEnd));
        const deadlineMs = bettingDeadlineMs(Number(betWindowEnd));
        if (Date.now() < deadlineMs) {
          uiRoundEndMs = endMs;
          uiRoundId = id;
          game.setRound({ roundId: id, betWindowEndMs: deadlineMs, isOpen: true, bettorCount: 0 });
        }
      } catch (_) {}
      if (!resolving && !awaitingResult) tick();
    });
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
  // On-demand opener: kicks the wheel awake while a connected player watches.
  setInterval(() => { maybeStartRound().catch(() => {}); }, 5000);
  // Keep the chain-clock skew fresh (clocks drift); cheap one-block read.
  refreshChainSkew();
  setInterval(refreshChainSkew, 15000);
  // Agent-driven Bonus Mode reskin + payout boost reflection.
  refreshBonus();
  setInterval(refreshBonus, 12000);
  try { casino().on("BonusModeActivated", () => refreshBonus()); } catch (_) {}
  tick();
}

document.addEventListener("shinyluck:connected", () => { setGate(true); refreshBalance(); });
document.addEventListener("DOMContentLoaded", mount);
// Module scripts can load after DOMContentLoaded already fired.
if (document.readyState !== "loading") mount();
