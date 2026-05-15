// Iterates active strategies, places bets via the registry's executeBet(),
// and reconciles outcomes from BetSettled events into per-strategy P&L state.
//
// Game support:
//   - DICE  / SLOTS / PLINKO  — per-bet placeXBet(...).
//   - CRASH / ROULETTE        — round-based; the executor first checks that
//                                a round is open + within the betting window
//                                before attempting placement.
// Mines is excluded (requires multi-step interactive flow).

const { ethers } = require("ethers");
const db = require("../db");

function clientSeed() {
  return ethers.hexlify(ethers.randomBytes(32));
}

const ROULETTE_KINDS = {
  STRAIGHT: 0, RED: 1, BLACK: 2, EVEN: 3, ODD: 4,
  LOW: 5, HIGH: 6, DOZEN_1: 7, DOZEN_2: 8, DOZEN_3: 9,
};

/// Returns calldata + value for the placement call appropriate for the strategy.
async function buildCall(strategy, ctx) {
  const { casino, casinoAbi } = ctx;
  const iface = new ethers.Interface(casinoAbi);
  const valueWei = ethers.parseEther(String(strategy.betSTT));
  switch (strategy.gameId) {
    case 0: { // DICE
      const cs = clientSeed();
      const data = iface.encodeFunctionData("placeDiceBet", [
        strategy.target, strategy.direction === "over", cs,
      ]);
      return { data, value: valueWei };
    }
    case 2: { // SLOTS — VAULT.7
      const cs = clientSeed();
      // useFreeSpin = false; agents don't try to redeem loyalty free spins
      // because doing so would require msg.value=0 (no relayer cost) and
      // some out-of-band coordination. v1: paid spins only.
      return { data: iface.encodeFunctionData("placeSlotsBet", [cs, false]), value: valueWei };
    }
    case 6: { // CLUSTER — SUGAR.LAB
      const cs = clientSeed();
      return { data: iface.encodeFunctionData("placeClusterBet", [cs, false]), value: valueWei };
    }
    case 4: { // PLINKO
      const cs = clientSeed();
      return { data: iface.encodeFunctionData("placeplinkoBet", [strategy.risk, cs]), value: valueWei };
    }
    case 1: { // CRASH (round-based)
      const round = await fetchCrashRound(casino);
      if (!round.open) throw new Error(`crash: no open round (${round.reason})`);
      const ac = Math.round((strategy.autoCashout || 1.5) * 100);
      return { data: iface.encodeFunctionData("placeCrashBet", [ac]), value: valueWei };
    }
    case 5: { // ROULETTE (round-based + multi-bet)
      const round = await fetchRouletteRound(casino);
      if (!round.open) throw new Error(`roulette: no open round (${round.reason})`);
      const kind = ROULETTE_KINDS[strategy.rouletteKind] ?? ROULETTE_KINDS.RED;
      const data = iface.encodeFunctionData("placeRouletteBets", [
        [{ kind, number: 0, amount: valueWei }],
      ]);
      return { data, value: valueWei };
    }
    default:
      throw new Error(`game ${strategy.gameId} not supported by executor v1`);
  }
}

async function fetchCrashRound(casino) {
  try {
    const total = await casino.totalCrashRounds();
    if (total === 0n) return { open: false, reason: "no rounds yet" };
    const id = await casino.currentCrashRoundId();
    const r = await casino.getCrashRound(id);
    const now = Math.floor(Date.now() / 1000);
    if (r.settled)                       return { open: false, reason: "settled" };
    if (Number(r.betWindowEnd) <= now)   return { open: false, reason: "window closed" };
    return { open: true, roundId: id };
  } catch (e) { return { open: false, reason: e.message }; }
}
async function fetchRouletteRound(casino) {
  try {
    const total = await casino.totalRouletteRounds();
    if (total === 0n) return { open: false, reason: "no rounds yet" };
    const id = await casino.currentRouletteRoundId();
    const r = await casino.getRouletteRound(id);
    const now = Math.floor(Date.now() / 1000);
    if (r.settled)                       return { open: false, reason: "settled" };
    if (Number(r.betWindowEnd) <= now)   return { open: false, reason: "window closed" };
    return { open: true, roundId: id };
  } catch (e) { return { open: false, reason: e.message }; }
}

function shouldStop(strategy) {
  if (strategy.stopWins > 0 && strategy.consecutiveWins >= strategy.stopWins) return "stopWins";
  if (strategy.stopLossSTT > 0 && strategy.lossesTodaySTT >= strategy.stopLossSTT) return "stopLoss";
  return null;
}

async function tickPlayer(strategy, ctx) {
  const { registry } = ctx;
  if (!strategy.active) return { skipped: "inactive" };
  const stop = shouldStop(strategy);
  if (stop) {
    db.setActive(strategy.player, false);
    db.appendLog({ player: strategy.player, kind: "auto-pause", reason: stop });
    return { skipped: stop };
  }
  let call;
  try { call = await buildCall(strategy, ctx); }
  catch (e) {
    db.appendLog({ player: strategy.player, kind: "skip", reason: e.message });
    return { skipped: e.message };
  }
  try {
    const tx = await registry.executeBet(strategy.player, strategy.gameId, call.value, call.data);
    const r = await tx.wait();
    const evt = r.logs
      .map((l) => { try { return registry.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === "BetExecuted");
    const betId = evt ? evt.args.betId.toString() : null;
    db.appendLog({
      player: strategy.player,
      kind: "bet-placed",
      game: strategy.game,
      betId,
      amountSTT: strategy.betSTT,
      txHash: tx.hash,
    });
    return { betId, txHash: tx.hash };
  } catch (e) {
    db.appendLog({ player: strategy.player, kind: "bet-failed", reason: e.shortMessage || e.message });
    return { error: e.shortMessage || e.message };
  }
}

/// Pull recent BetSettled events and roll P&L counters into strategy state.
/// We match by `bet.player === vault address` because that's how Casino
/// records the vault as the on-chain player.
async function reconcileSettlements(ctx) {
  const { casino } = ctx;
  let filter, latest, fromBlock, events;
  try {
    filter = casino.filters.BetSettled();
    latest = await casino.runner.provider.getBlockNumber();
    fromBlock = Math.max(0, latest - 1024);
    events = await casino.queryFilter(filter, fromBlock);
  } catch (e) {
    // Somnia logs lack `removed`; ethers v6 throws BAD_DATA on queryFilter.
    // We fall through quietly — the on-chain BetSettled events still drive
    // the frontend P&L; executor reconcile is best-effort.
    return;
  }
  for (const ev of events) {
    const vaultLower = ev.args.player.toLowerCase();
    const strat = db.listStrategies().find((s) => s.vault && s.vault.toLowerCase() === vaultLower);
    if (!strat) continue;
    const won = ev.args.won;
    if (won) {
      strat.consecutiveWins = (strat.consecutiveWins || 0) + 1;
    } else {
      strat.consecutiveWins = 0;
      strat.lossesTodaySTT = (strat.lossesTodaySTT || 0) + Number(strat.betSTT);
    }
    db.upsertStrategy(strat.player, strat);
  }
}

async function tick(ctx) {
  for (const s of db.listStrategies()) {
    if (!s.active) continue;
    await tickPlayer(s, ctx);
  }
  try { await reconcileSettlements(ctx); } catch (_) {}
}

module.exports = { tick, buildCall, tickPlayer };
