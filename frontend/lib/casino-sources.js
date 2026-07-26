/* ============================================================================
   Casino v15 event sources — the single place that knows WHERE a settled bet
   can come from.

   In the v14 monolith every game emitted `BetSettled` from one address, so any
   consumer (wins feed, live stats, leaderboard, fairness page) pointed a single
   contract at a single ABI. v15 split the casino into a Vault plus one contract
   per game, and a win now surfaces in SIX different places:

     Vault          BetSettled     dice, plinko          (single-shot)
     Vault7Module   SpinSettled    VAULT.7              (slot)
     ClusterModule  SpinSettled    SUGAR.LAB            (slot)
     CrashModule    PlayerSettled  crash                (round, per player)
     RouletteModule PlayerSettled  roulette             (round, per player)
     MinesModule    MinesCashout   mines                (multi-step)

   TRAP that makes this file worth having: v14 emitted
     BetSettled(..., uint8  indexed game,   ...)
   and v15 emits
     BetSettled(..., uint16 indexed gameId, ...)
   Those hash to DIFFERENT topic0, so pointing the old ABI at the new contract
   returns zero logs — silently, with no error. Every consumer that still
   declared the v14 signature was quietly showing an empty casino.

   Consumers use `sources()` for the descriptor list and `scanSettled()` when
   they just want normalised rows and do not care which contract they came from.
   ========================================================================== */

import { ethers } from "/vendor/ethers.bundle.js";
import { provider, fetchLogs, DEFAULT_CHUNK_SIZE } from "./rpc.js";
import { CONFIG_V15 } from "./config-v15.js";

export const GAME_ID = { DICE: 0, CRASH: 1, SLOTS: 2, MINES: 3, PLINKO: 4, ROULETTE: 5, CLUSTER: 6 };

export const GAME_META = {
  0: { name: "Dice", art: "/assets/games/dice.png" },
  1: { name: "Crash", art: "/assets/games/crash.png" },
  2: { name: "VAULT.7", art: "/assets/games/vault7.png" },
  3: { name: "Mines", art: "/assets/games/mines.png" },
  4: { name: "Plinko", art: "/assets/games/plinko.png" },
  5: { name: "Roulette", art: "/assets/games/roulette.png" },
  6: { name: "SUGAR.LAB", art: "/assets/games/sugarlab.png" },
};

export const V15_VAULT_ABI = [
  "event BetPlaced(uint256 indexed betId,address indexed player,uint16 indexed gameId,uint256 amount,bytes32 clientSeed,uint256 commitBlock,uint256 seedIdx,bytes params)",
  "event BetSettled(uint256 indexed betId,address indexed player,uint16 indexed gameId,bool won,uint256 payout,bytes32 randomness,bytes32 serverSeed,bytes32 clientSeed,bytes32 blockHash,uint256 nonce,bytes resultData)",
  "event BetRefunded(uint256 indexed betId,address indexed player,uint256 amount,string reason)",
];
export const V15_SLOT_ABI = [
  "event SpinPlaced(uint256 indexed betId,address indexed player,uint256 amount,bool freeSpin,bool buyBonus)",
  "event SpinSettled(uint256 indexed betId,address indexed player,bool won,uint256 payout,bytes32 randomness,bytes32 serverSeed,bytes resultData)",
];
export const V15_CRASH_ABI = [
  "event BetPlaced(uint256 indexed roundId,address indexed player,uint256 amount,uint256 autoCashoutX100)",
  "event PlayerSettled(uint256 indexed roundId,address indexed player,bool won,uint256 payout,uint256 effectiveMultX100)",
];
export const V15_ROULETTE_ABI = [
  "event PlayerSettled(uint256 indexed roundId,address indexed player,bool won,uint256 totalStake,uint256 payout)",
];
export const V15_MINES_ABI = [
  "event MinesPlaced(uint256 indexed betId,address indexed player,uint256 amount,uint8 mineCount)",
  "event MinesCashout(uint256 indexed betId,uint8 cellsOpened,uint256 payout,uint256 multiplierX100)",
];

export const vaultAddress = () => CONFIG_V15.addresses?.vault || null;
export const moduleOf = (name) => (CONFIG_V15.games || []).find((g) => g.name === name)?.module || null;
export const deploymentBlock = () => Number(CONFIG_V15.deploymentBlock || 0);

let _srcs = null;

/**
 * The six settled-event sources, each carrying the accessors a consumer needs
 * to read a log without knowing which contract produced it.
 *
 *   settled / placed  event names on that contract (placed = null when the
 *                     settled event already carries the stake)
 *   game(ev)          numeric game id
 *   player(ev)        winner, or null when the settled event omits it (mines)
 *   payout(ev)        wei paid out
 *   key(ev)           stable identity, unique ACROSS sources (module bet ids
 *                     are local, so a bare id collides between games)
 *   stakeOf/stakeKey  how to read + index the stake from the placed event
 *   stakeDirect       stake straight off the settled event (roulette)
 *   playerByKey       winner comes from the paired placed event (mines)
 */
export function sources() {
  if (_srcs) return _srcs;
  const mk = (addr, abi) => (addr ? new ethers.Contract(addr, abi, provider()) : null);
  _srcs = [];

  // A module can be REPLACED without touching the Vault — that is the point of
  // the architecture. But the old contract keeps the events it emitted, and
  // reading only the current address would blank every win that happened before
  // the swap. So each game contributes its retired addresses too, tagged with
  // the same shape as the live one.
  const retired = (name) =>
    (CONFIG_V15.previousModules || []).filter((m) => m.name === name).map((m) => m.module);

  const vault = mk(vaultAddress(), V15_VAULT_ABI);
  if (vault) _srcs.push({
    id: "vault", c: vault, settled: "BetSettled", placed: "BetPlaced",
    game: (ev) => Number(ev.args.gameId), payout: (ev) => ev.args.payout,
    player: (ev) => ev.args.player, key: (ev) => "v:" + ev.args.betId.toString(),
    stakeOf: (ev) => ev.args.amount, stakeKey: (ev) => "v:" + ev.args.betId.toString(),
  });

  for (const [name, gid] of [["vault7", GAME_ID.SLOTS], ["cluster", GAME_ID.CLUSTER]]) {
    for (const [addr, tag] of [[moduleOf(name), name], ...retired(name).map((a, i) => [a, `${name}~${i}`])]) {
      const c = mk(addr, V15_SLOT_ABI);
      if (!c) continue;
      _srcs.push({
        id: tag, c, settled: "SpinSettled", placed: "SpinPlaced",
        game: () => gid, payout: (ev) => ev.args.payout,
        player: (ev) => ev.args.player, key: (ev) => tag + ":" + ev.args.betId.toString(),
        stakeOf: (ev) => ev.args.amount, stakeKey: (ev) => tag + ":" + ev.args.betId.toString(),
      });
    }
  }

  for (const [addr, tag] of [[moduleOf("crash"), "crash"], ...retired("crash").map((a, i) => [a, `crash~${i}`])]) {
    const c = mk(addr, V15_CRASH_ABI);
    if (!c) continue;
    _srcs.push({
      id: tag, c, settled: "PlayerSettled", placed: "BetPlaced",
      game: () => GAME_ID.CRASH, payout: (ev) => ev.args.payout, player: (ev) => ev.args.player,
      // A round pays many players, so the round id alone is not unique.
      key: (ev) => tag + ":" + ev.args.roundId.toString() + ":" + ev.args.player,
      stakeOf: (ev) => ev.args.amount,
      stakeKey: (ev) => tag + ":" + ev.args.roundId.toString() + ":" + ev.args.player,
    });
  }

  for (const [addr, tag] of [[moduleOf("roulette"), "roul"], ...retired("roulette").map((a, i) => [a, `roul~${i}`])]) {
    const c = mk(addr, V15_ROULETTE_ABI);
    if (!c) continue;
    _srcs.push({
      id: tag, c, settled: "PlayerSettled", placed: null,
      game: () => GAME_ID.ROULETTE, payout: (ev) => ev.args.payout, player: (ev) => ev.args.player,
      key: (ev) => tag + ":" + ev.args.roundId.toString() + ":" + ev.args.player,
      stakeDirect: (ev) => ev.args.totalStake,
    });
  }

  for (const [addr, tag] of [[moduleOf("mines"), "mines"], ...retired("mines").map((a, i) => [a, `mines~${i}`])]) {
    const c = mk(addr, V15_MINES_ABI);
    if (!c) continue;
    _srcs.push({
      id: tag, c, settled: "MinesCashout", placed: "MinesPlaced",
      game: () => GAME_ID.MINES, payout: (ev) => ev.args.payout,
      // MinesCashout does not carry the player — it is taken from MinesPlaced.
      player: () => null, playerByKey: true,
      key: (ev) => tag + ":" + ev.args.betId.toString(),
      stakeOf: (ev) => ev.args.amount, stakeKey: (ev) => tag + ":" + ev.args.betId.toString(),
    });
  }

  return _srcs;
}

/** Drop memoised contracts (used when the provider is rebuilt). */
export function resetSources() { _srcs = null; }

/**
 * Scan every source over a block range and return normalised rows, newest
 * first. A row is `{ key, srcId, gameId, gameName, art, player, stake, payout,
 * net, block, txHash }`; `stake` is null when the paired placed event fell
 * outside the scanned range.
 *
 * `onlyWins` keeps rows that actually paid — the default, since a feed of
 * zero-payout losses is noise.
 */
export async function scanSettled(fromBlock, toBlock, { onlyWins = true, chunkSize = DEFAULT_CHUNK_SIZE } = {}) {
  const from = Math.max(0, fromBlock);
  const out = [];

  await Promise.all(sources().map(async (s) => {
    let settled = [];
    try {
      settled = await fetchLogs(s.c, s.settled, from, toBlock, chunkSize);
    } catch (e) {
      console.warn(`[sources] ${s.id}/${s.settled} scan failed:`, e.shortMessage || e.message);
      return;
    }
    if (!settled.length) return;

    // Pair with the placed event only when this source needs it (for the stake,
    // or — for mines — for the player itself).
    const stakes = new Map();
    const players = new Map();
    if (s.placed) {
      try {
        for (const ev of await fetchLogs(s.c, s.placed, from, toBlock, chunkSize)) {
          stakes.set(s.stakeKey(ev), s.stakeOf(ev));
          if (s.playerByKey) players.set(s.stakeKey(ev), ev.args.player);
        }
      } catch (_) { /* stake stays null; the row is still worth showing */ }
    }

    for (const ev of settled) {
      const payout = s.payout(ev);
      if (onlyWins && (!payout || payout === 0n)) continue;
      const key = s.key(ev);
      const gameId = s.game(ev);
      const stake = s.stakeDirect ? s.stakeDirect(ev) : (stakes.get(key) ?? null);
      const player = s.player(ev) ?? players.get(key) ?? null;
      out.push({
        key, srcId: s.id, gameId,
        gameName: GAME_META[gameId]?.name || "Casino",
        art: GAME_META[gameId]?.art || null,
        player, stake, payout,
        net: stake == null ? null : payout - stake,
        block: ev.blockNumber, txHash: ev.transactionHash,
      });
    }
  }));

  out.sort((a, b) => b.block - a.block);
  return out;
}

/**
 * Scan every source's PLACED event — what a player actually wagered.
 *
 * Settled events alone under-count: a busted mines game emits `MinesBust` and
 * never `MinesCashout`, so a leaderboard built only on settlements would credit
 * that player with no wager at all. Rows are
 * `{ key, srcId, gameId, player, stake, block }`.
 */
export async function scanPlaced(fromBlock, toBlock, { chunkSize = DEFAULT_CHUNK_SIZE } = {}) {
  const from = Math.max(0, fromBlock);
  const out = [];

  await Promise.all(sources().map(async (s) => {
    if (!s.placed) return;   // roulette carries its stake on the settled event
    let evs = [];
    try {
      evs = await fetchLogs(s.c, s.placed, from, toBlock, chunkSize);
    } catch (e) {
      console.warn(`[sources] ${s.id}/${s.placed} scan failed:`, e.shortMessage || e.message);
      return;
    }
    for (const ev of evs) {
      out.push({
        key: s.stakeKey(ev), srcId: s.id,
        gameId: s.game(ev), player: ev.args.player,
        stake: s.stakeOf(ev), block: ev.blockNumber,
      });
    }
  }));

  // Sources with no usable placed event (roulette: its per-bet BetPlaced fires
  // once per leg) carry the wager on the settled event instead. Found by that
  // property rather than by name, so a retired module contributes too.
  for (const s of sources().filter((x) => !x.placed && x.stakeDirect)) {
    try {
      for (const ev of await fetchLogs(s.c, s.settled, from, toBlock, chunkSize)) {
        out.push({
          key: s.key(ev), srcId: s.id, gameId: s.game(ev),
          player: ev.args.player, stake: s.stakeDirect(ev), block: ev.blockNumber,
        });
      }
    } catch (_) {}
  }

  out.sort((a, b) => b.block - a.block);
  return out;
}
