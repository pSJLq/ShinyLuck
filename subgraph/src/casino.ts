// AssemblyScript mappings for the ShinyLuck Casino contract.
//
// Indexes per-bet/per-round events into a shape the leaderboard / account
// pages can query via GraphQL. Live (sub-second) UI updates come from the
// off-chain Reactivity SDK in the frontend; this subgraph is the source of
// truth for historical aggregations (weekly leaderboards, P&L charts).

import { BigInt, Bytes, Address } from "@graphprotocol/graph-ts";
import {
  BetPlaced,
  BetSettled,
  BetRefunded,
  CrashRoundStarted,
  CrashRoundSettled,
  RouletteRoundStarted,
  RouletteRoundSettled,
  ReasoningLog as ReasoningLogEvent,
  BonusModeActivated,
  RtpAdjusted,
} from "../generated/Casino/Casino";
import {
  Player,
  Bet,
  CrashRound,
  RouletteRound,
  ReasoningLog,
  BonusModeEvent,
  RtpAdjustment,
  DailyStats,
} from "../generated/schema";

function getOrCreatePlayer(address: Address, timestamp: BigInt): Player {
  let id = address as Bytes;
  let p = Player.load(id);
  if (p == null) {
    p = new Player(id);
    p.totalBetsPlaced = BigInt.zero();
    p.totalWagered = BigInt.zero();
    p.totalPaid = BigInt.zero();
    p.netProfit = BigInt.zero();
    p.winsCount = BigInt.zero();
    p.bestSingleWin = BigInt.zero();
    p.freeSpinsEarned = BigInt.zero();
    p.freeSpinsUsed = BigInt.zero();
    p.firstSeenAt = timestamp;
  }
  p.lastSeenAt = timestamp;
  return p as Player;
}

function dailyId(timestamp: BigInt): string {
  // YYYY-MM-DD bucket. Approximate via seconds-per-day; subgraph runs in UTC.
  let day = timestamp.toI32() / 86400;
  return day.toString();
}

function bumpDaily(timestamp: BigInt, wagered: BigInt, paid: BigInt, win: BigInt, player: Bytes): void {
  let id = dailyId(timestamp);
  let d = DailyStats.load(id);
  if (d == null) {
    d = new DailyStats(id);
    d.date = id;
    d.betsCount = BigInt.zero();
    d.wagered = BigInt.zero();
    d.paid = BigInt.zero();
    d.uniquePlayers = BigInt.zero();
    d.topWin = BigInt.zero();
  }
  d.betsCount = d.betsCount.plus(BigInt.fromI32(1));
  d.wagered = d.wagered.plus(wagered);
  d.paid = d.paid.plus(paid);
  if (win.gt(d.topWin)) d.topWin = win;
  d.save();
}

export function handleBetPlaced(event: BetPlaced): void {
  let player = getOrCreatePlayer(event.params.player, event.block.timestamp);
  player.totalBetsPlaced = player.totalBetsPlaced.plus(BigInt.fromI32(1));
  player.totalWagered = player.totalWagered.plus(event.params.amount);
  player.save();

  let bet = new Bet(event.params.betId.toString());
  bet.player = player.id;
  bet.game = event.params.game;
  bet.amount = event.params.amount;
  bet.payout = BigInt.zero();
  bet.won = false;
  bet.placedAt = event.block.timestamp;
  bet.clientSeed = event.params.clientSeed;
  bet.nonce = event.params.seedIdx;
  bet.txHashPlace = event.transaction.hash;
  bet.save();
}

export function handleBetSettled(event: BetSettled): void {
  let bet = Bet.load(event.params.betId.toString());
  if (bet == null) return;        // settle without prior place — defensive
  bet.payout = event.params.payout;
  bet.won = event.params.won;
  bet.settledAt = event.block.timestamp;
  bet.serverSeed = event.params.serverSeed;
  bet.randomness = event.params.randomness;
  bet.blockHash = event.params.blockHash;
  bet.nonce = event.params.nonce;
  bet.resultData = event.params.resultData;
  bet.txHashSettle = event.transaction.hash;
  bet.save();

  let player = getOrCreatePlayer(event.params.player, event.block.timestamp);
  player.totalPaid = player.totalPaid.plus(event.params.payout);
  player.netProfit = player.totalPaid.minus(player.totalWagered);
  if (event.params.won) {
    player.winsCount = player.winsCount.plus(BigInt.fromI32(1));
    if (event.params.payout.gt(player.bestSingleWin)) {
      player.bestSingleWin = event.params.payout;
    }
  }
  player.save();

  bumpDaily(event.block.timestamp, BigInt.zero(), event.params.payout, event.params.payout, player.id);
}

export function handleBetRefunded(event: BetRefunded): void {
  let bet = Bet.load(event.params.betId.toString());
  if (bet == null) return;
  bet.payout = event.params.amount;
  bet.won = false;
  bet.settledAt = event.block.timestamp;
  bet.txHashSettle = event.transaction.hash;
  bet.save();
}

export function handleCrashRoundStarted(event: CrashRoundStarted): void {
  let r = new CrashRound(event.params.roundId.toString());
  r.betWindowEnd = event.params.betWindowEnd;
  r.commitBlock = event.params.commitBlock;
  r.settled = false;
  r.bettorCount = 0;
  r.totalWagered = BigInt.zero();
  r.totalPaid = BigInt.zero();
  r.startedAt = event.block.timestamp;
  r.save();
}

export function handleCrashRoundSettled(event: CrashRoundSettled): void {
  let r = CrashRound.load(event.params.roundId.toString());
  if (r == null) return;
  r.crashPointX100 = event.params.crashPointX100.toI32();
  r.serverSeed = event.params.serverSeed;
  r.settled = true;
  r.settledAt = event.block.timestamp;
  r.save();
}

export function handleRouletteRoundStarted(event: RouletteRoundStarted): void {
  let r = new RouletteRound(event.params.roundId.toString());
  r.betWindowEnd = event.params.betWindowEnd;
  r.commitBlock = event.params.commitBlock;
  r.settled = false;
  r.bettorCount = 0;
  r.totalWagered = BigInt.zero();
  r.totalPaid = BigInt.zero();
  r.startedAt = event.block.timestamp;
  r.save();
}

export function handleRouletteRoundSettled(event: RouletteRoundSettled): void {
  let r = RouletteRound.load(event.params.roundId.toString());
  if (r == null) return;
  r.resultNumber = event.params.resultNumber;
  r.serverSeed = event.params.serverSeed;
  r.settled = true;
  r.settledAt = event.block.timestamp;
  r.save();
}

export function handleReasoningLog(event: ReasoningLogEvent): void {
  let id = event.transaction.hash.toHex() + "-" + event.logIndex.toString();
  let r = new ReasoningLog(id);
  r.action = "manual";
  r.changeBps = BigInt.zero();
  r.freeBankroll = BigInt.zero();
  r.timestamp = event.params.timestamp;
  r.txHash = event.transaction.hash;
  r.save();
}

export function handleBonusModeActivated(event: BonusModeActivated): void {
  let id = event.transaction.hash.toHex() + "-" + event.logIndex.toString();
  let b = new BonusModeEvent(id);
  b.activeUntil = event.params.until;
  b.reasoning = event.params.reasoning;
  b.timestamp = event.block.timestamp;
  b.txHash = event.transaction.hash;
  b.save();
}

export function handleRtpAdjusted(event: RtpAdjusted): void {
  let id = event.transaction.hash.toHex() + "-" + event.logIndex.toString();
  let r = new RtpAdjustment(id);
  r.game = event.params.game;
  r.oldRtpBps = event.params.oldRtpBps;
  r.newRtpBps = event.params.newRtpBps;
  r.reasoning = event.params.reasoning;
  r.timestamp = event.block.timestamp;
  r.txHash = event.transaction.hash;
  r.save();
}
