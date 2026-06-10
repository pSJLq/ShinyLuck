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
async function ensureSeeds(dealer, masterKey, minRemaining = 25, batch = 60) {
  const remaining = Number(await dealer.seedsRemaining());
  if (remaining >= minRemaining) return 0;
  const nextIdx = Number(await dealer.nextHashIndex());
  const provisioned = remaining + nextIdx; // total ever pushed
  const hashes = [];
  for (let i = 0; i < batch; i++) hashes.push(hashSeed(deriveSeed(masterKey, provisioned + i)));
  await (await dealer.provisionSeedHashes(hashes)).wait();
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
  const cfg = await room.getTable(tableId);
  const maxSeats = Number(cfg.maxSeats);
  const h = await room.getHand(tableId);

  // No hand running: open one if there are enough players.
  if (!h.inProgress) {
    // Brief pause between hands so the winner glow / win banner is visible.
    const prev = state.get(tableId);
    if (prev && prev.dealId && !prev.endedAt) { prev.endedAt = Date.now(); return "hand-ended"; }
    if (prev && prev.endedAt && Date.now() - prev.endedAt < (opts.interHandMs ?? 2500)) return "inter-hand";
    if ((await countEligible(room, tableId, maxSeats)) < 2) return "idle";
    await ensureSeeds(dealer, masterKey);
    const seedIdx = Number(await dealer.nextHashIndex());
    try {
      await (await room.startHand(tableId)).wait();
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

  // 1. Lock the future-blockhash entropy, then compute the deck + hole cards.
  if (!st.entropyLocked) {
    try {
      await (await dealer.lockEntropy(dealId)).wait();
    } catch (e) {
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
    await (await dealer.revealBoard(dealId, want, padded)).wait();
    st.boardRevealed = want;
    return "board:" + want;
  }

  // 3. Fold/check a player whose clock has expired.
  if (Number(h.street) <= STREET.RIVER) {
    const now = Math.floor(Date.now() / 1000);
    if (now > Number(h.actingDeadline) + (opts.timeoutGrace ?? 2)) {
      try {
        await (await room.timeoutAct(tableId)).wait();
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
      await (await dealer.revealSeed(dealId, st.seed)).wait();
      st.seedRevealed = true;
      st.showdownAt = Date.now();
      return "showdown-reveal";
    }
    if (Date.now() - (st.showdownAt || 0) < (opts.showdownMs ?? 4000)) return "showdown-wait";
    await (await room.resolveShowdown(tableId)).wait();
    return "settled";
  }

  return "wait";
}

module.exports = { tickTable, ensureSeeds, countEligible, recoverState, newState, boardCountForStreet, STREET };
