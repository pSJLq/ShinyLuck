// Off-chain dealer driving logic for ShinyPoker. Pure of any process/RPC setup
// so it can be unit-driven in tests: each `tickTable` advances one table by one
// step (start hand → lock entropy → reveal board per street → timeout-fold →
// reveal seed + settle showdown). The runner (poker-dealer-bot.js) just calls
// these on a poll loop against live contracts.

const { ethers } = require("ethers");
const { deriveDeck, dealHand, hashSeed, deriveSeed } = require("./poker-deck");

const STREET = { PREFLOP: 0, FLOP: 1, TURN: 2, RIVER: 3, SHOWDOWN: 4, IDLE: 255 };

function boardCountForStreet(s) {
  if (s === STREET.FLOP) return 3;
  if (s === STREET.TURN) return 4;
  if (s === STREET.RIVER || s === STREET.SHOWDOWN) return 5;
  return 0;
}

function newState() {
  return new Map();
}

/// Keep the dealer stocked with server-seed commitments, derived deterministically
/// from the master key so the bot is stateless across restarts.
async function ensureSeeds(dealer, masterKey, minRemaining = 12, batch = 24, send = (fn) => fn().then((r) => r.wait())) {
  // Small batches on purpose: pushing 60 hashes costs ~18.7M gas (~0.22 STT) —
  // one oversized provision drained the operator to the point of a full stall.
  const remaining = Number(await dealer.seedsRemaining());
  if (remaining >= minRemaining) return 0;
  const nextIdx = Number(await dealer.nextHashIndex());
  const provisioned = remaining + nextIdx; // total ever pushed
  const hashes = [];
  for (let i = 0; i < batch; i++) hashes.push(hashSeed(deriveSeed(masterKey, provisioned + i)));
  await send(() => dealer.provisionSeedHashes(hashes));
  return batch;
}

async function countEligible(room, tableId, maxSeats) {
  let n = 0;
  for (let s = 0; s < maxSeats; s++) {
    const seat = await room.getSeat(tableId, s);
    if (seat.occupied && !seat.sittingOut && seat.stack > 0n) n++;
  }
  return n;
}

/// Recover deal state from chain (used when the bot (re)starts mid-hand). Finds
/// the seed index whose commitment matches the deal, then rebuilds hole cards if
/// entropy is already locked.
async function recoverState(dealer, masterKey, dealId) {
  const info = await dealer.dealInfo(dealId);
  const nextIdx = Number(await dealer.nextHashIndex());
  let seed = null;
  for (let idx = nextIdx - 1; idx >= 0 && idx >= nextIdx - 400; idx--) {
    if (hashSeed(deriveSeed(masterKey, idx)) === info.seedHash) {
      seed = deriveSeed(masterKey, idx);
      break;
    }
  }
  const st = {
    dealId,
    seed,
    entropyLocked: info.entropy !== ethers.ZeroHash,
    boardRevealed: Number(await dealer.boardRevealedCount(dealId)),
    seedRevealed: await dealer.isShowdownReady(dealId),
    holes: null,
  };
  if (st.entropyLocked && seed) {
    const deck = deriveDeck(seed, info.entropy, info.handId, info.tableId);
    st.holes = dealHand(deck, info.seats.map(Number));
  }
  return st;
}

/// Advance one table by at most one action. `room`/`dealer` must be connected to
/// the dealer-bot wallet (the registered operator). Returns a short status tag.
async function tickTable(room, dealer, masterKey, state, tableId, opts = {}) {
  // How a state-changing tx is executed. Default: send + await mining (the
  // original sequential behaviour, used by the unit tests). The live bot passes
  // a mutex-guarded runner so many tables can be read concurrently while their
  // writes stay strictly one-at-a-time (no shared-nonce gaps → never wedges).
  const send = opts.tx || ((fn) => fn().then((r) => r.wait()));
  const cfg = await room.getTable(tableId);
  const maxSeats = Number(cfg.maxSeats);
  const h = await room.getHand(tableId);

  // No hand running: open one if there are enough players.
  if (!h.inProgress) {
    // Brief pause between hands so the winner glow / win banner is visible.
    const prev = state.get(tableId);
    if (prev && prev.dealId && !prev.endedAt) { prev.endedAt = Date.now(); return "hand-ended"; }
    // Inter-hand pause: just enough for the winner banner to register. Kept
    // short — every idle second between hands is dead table time. (was 2500)
    if (prev && prev.endedAt && Date.now() - prev.endedAt < (opts.interHandMs ?? 1200)) return "inter-hand";
    // tournament level-up pending → don't START a new hand (let the table drain
    // to idle so the contract's all-tables-idle levelUp can finally fire).
    if (opts.noNewHands) return "hold";
    if ((await countEligible(room, tableId, maxSeats)) < 2) return "idle";
    await ensureSeeds(dealer, masterKey, 12, 24, send);
    const seedIdx = Number(await dealer.nextHashIndex());
    try {
      await send(() => room.startHand(tableId));
    } catch (e) {
      return "start-skip"; // e.g. NotEnoughPlayers race
    }
    const h2 = await room.getHand(tableId);
    state.set(tableId, {
      dealId: Number(h2.dealId),
      seed: deriveSeed(masterKey, seedIdx),
      entropyLocked: false,
      boardRevealed: 0,
      seedRevealed: false,
      holes: null,
    });
    return "started";
  }

  const dealId = Number(h.dealId);
  let st = state.get(tableId);
  if (!st || st.dealId !== dealId) {
    st = await recoverState(dealer, masterKey, dealId);
    state.set(tableId, st);
  }

  // Unservable hand (seed unknown after a restart) → abort + refund everyone
  // via cancelHand instead of leaving the table stuck in this hand forever.
  if (!st.seed) {
    await send(() => room.cancelHand(tableId));
    state.delete(tableId);
    return "cancelled:no-seed";
  }

  // 1. Lock the future-blockhash entropy, then compute the deck + hole cards.
  if (!st.entropyLocked) {
    try {
      await send(() => dealer.lockEntropy(dealId));
    } catch (e) {
      // If the 256-block blockhash window has passed, the deck can never be
      // derived — abort + refund rather than retrying forever.
      try {
        const info = await dealer.dealInfo(dealId);
        const bn = await dealer.runner.provider.getBlockNumber();
        if (bn > Number(info.commitBlock) + 257) {
          await send(() => room.cancelHand(tableId));
          state.delete(tableId);
          return "cancelled:entropy-expired";
        }
      } catch (_) {}
      return "lock-wait"; // TooEarly — retry next tick
    }
    const info = await dealer.dealInfo(dealId);
    const deck = deriveDeck(st.seed, info.entropy, info.handId, info.tableId);
    st.holes = dealHand(deck, info.seats.map(Number));
    st.entropyLocked = true;
    return "locked";
  }

  // 2. Reveal the board in lockstep with the betting streets.
  const want = boardCountForStreet(Number(h.street));
  if (want > st.boardRevealed && st.holes) {
    const b = st.holes.board;
    const padded = [0, 1, 2, 3, 4].map((i) => (b[i] === undefined ? 0 : b[i]));
    await send(() => dealer.revealBoard(dealId, want, padded));
    st.boardRevealed = want;
    return "board:" + want;
  }

  // 3. Fold/check a player whose clock has expired.
  if (Number(h.street) <= STREET.RIVER) {
    const now = Math.floor(Date.now() / 1000);
    if (now > Number(h.actingDeadline) + (opts.timeoutGrace ?? 2)) {
      try {
        await send(() => room.timeoutAct(tableId));
        return "timeout";
      } catch (_) {
        /* not actually expired on-chain yet */
      }
    }
  }

  // 4. Showdown: reveal the seed (deck verified on-chain), let players SEE the
  //    revealed cards for a few seconds, then settle.
  if (Number(h.street) === STREET.SHOWDOWN) {
    if (!st.seedRevealed) {
      try {
        await send(() => dealer.revealSeed(dealId, st.seed));
      } catch (e) {
        // A showdown whose seed can't be revealed on-chain (e.g. a board posted
        // by an earlier bot instance no longer matching the recovered deck after
        // a restart) would wedge the table forever. If the DEALER actually
        // reverted, void the hand + refund; a transient RPC error is retried.
        const reverted = /execution reverted|CALL_EXCEPTION|BoardMismatch|BadSeed|require/i.test((e && (e.shortMessage || e.info?.error?.message || e.message)) || "");
        if (!reverted) throw e;
        await send(() => room.cancelHand(tableId));
        state.delete(tableId);
        return "cancelled:reveal-failed";
      }
      st.seedRevealed = true;
      st.showdownAt = Date.now();
      return "showdown-reveal";
    }
    // Hold the revealed cards briefly so players see the showdown, then settle.
    // Kept tight — the frontend already announces the winner from the reveals
    // the instant they land (sdWin), so this is just the on-felt card display.
    // (was 4000)
    if (Date.now() - (st.showdownAt || 0) < (opts.showdownMs ?? 1800)) return "showdown-wait";
    await send(() => room.resolveShowdown(tableId));
    return "settled";
  }

  return "wait";
}

module.exports = { tickTable, ensureSeeds, countEligible, recoverState, newState, boardCountForStreet, STREET };
