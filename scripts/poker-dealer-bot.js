// ShinyPoker off-chain dealer bot (standalone Node service, à la agent-service).
//
// Responsibilities (all driven through scripts/lib/poker-dealer.js):
//   - keep the on-chain dealer stocked with server-seed commitments
//   - open a hand whenever a table has >=2 seated players and none is running
//   - lock the future-blockhash entropy, derive the deck, and reveal the board
//     in lockstep with the betting streets
//   - fold/check players whose action clock has expired
//   - reveal the seed at showdown (deck verified on-chain) and settle
//   - serve each player THEIR two hole cards over an authenticated endpoint
//     (the player signs a message; the bot checks it matches the seat owner)
//
// The provably-fair guarantee does not depend on this service being honest:
// every deal's seed is committed up front and the full deck is re-derived and
// checked on-chain at showdown. The bot is a convenience + liveness driver.
//
// Run:  node scripts/poker-dealer-bot.js
// Env:  RPC_URL, DEALER_KEY (or PRIVATE_KEY), POKER_ROOM, POKER_DEALER,
//       POKER_SEED_MASTER_KEY (or SEED_MASTER_KEY), POLL_MS, POKER_DEALER_PORT

const fs = require("fs");
const path = require("path");
const http = require("http");
const { ethers } = require("ethers");
const { tickTable, newState } = require("./lib/poker-dealer");
const { tickTournaments } = require("./lib/poker-tournament-driver");
const { cardStr } = require("./lib/poker-deck");
const zkDrv = require("./lib/poker-zk-dealer");

require("dotenv").config();

// Never let a transient RPC hiccup kill the dealer — log and keep polling.
process.on("unhandledRejection", (e) => console.error("[poker-bot] unhandledRejection:", e?.shortMessage || e?.message || e));
process.on("uncaughtException", (e) => console.error("[poker-bot] uncaughtException:", e?.shortMessage || e?.message || e));

const NET = process.env.NETWORK_NAME || "somniaTestnet";
const RPC_URL = process.env.RPC_URL || process.env.RPC_TESTNET || "https://api.infra.testnet.somnia.network";
const KEY = process.env.DEALER_KEY || process.env.POKER_DEPLOYER_KEY || process.env.PRIVATE_KEY;
const MASTER = process.env.POKER_SEED_MASTER_KEY || process.env.SEED_MASTER_KEY;
const POLL_MS = parseInt(process.env.POLL_MS || "1500", 10);
const PORT = parseInt(process.env.POKER_DEALER_PORT || "3002", 10);
// owner's main wallet — profits above the gas reserve auto-forward here
const PROFIT_WALLET = process.env.PROFIT_WALLET || "0x85b7D75cf35efC7E636FbDf3E82C92c6ceB5AC9D";

function loadAbi(name) {
  const p = path.join(__dirname, "..", "artifacts", "contracts", "poker", `${name}.sol`, `${name}.json`);
  return JSON.parse(fs.readFileSync(p, "utf8")).abi;
}

function loadAddresses() {
  const fromEnv = { room: process.env.POKER_ROOM, dealer: process.env.POKER_DEALER, tournament: process.env.POKER_TOURNAMENT, zk: process.env.POKER_ZK_DEALER };
  if (fromEnv.room && (fromEnv.dealer || fromEnv.zk)) return fromEnv;
  const f = path.join(__dirname, "..", "deployments", `poker-${NET}.json`);
  if (fs.existsSync(f)) {
    const m = JSON.parse(fs.readFileSync(f, "utf8"));
    return {
      room: m.addresses.pokerRoom, dealer: m.addresses.commitRevealDealer, tournament: m.addresses.pokerTournament,
      zk: m.addresses.zkTableDealer, deployBlock: m.deploymentBlock || 0,
    };
  }
  throw new Error("set POKER_ROOM + POKER_DEALER or deploy first (deployments/poker-*.json)");
}

function must(cond, msg) {
  if (!cond) {
    console.error("[poker-bot]", msg);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Table chat: in-memory ring buffer per table. Player messages are signature-
// gated (seat owner or their session key); the bot itself posts dealer lines.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Hand-history indexer: one backfill from the deployment block, then small
// incremental scans. The frontend reads it instantly via GET /history?t=N
// (scanning ~0.2s-block Somnia history from the browser is hopeless).
// ---------------------------------------------------------------------------
const HIST = new Map(); // tableId -> [{handId, seat, amount, kind}]
function histPush(t, item) {
  const list = HIST.get(t) || [];
  list.push(item);
  while (list.length > 100) list.shift();
  HIST.set(t, list);
}

async function startHistoryIndexer(provider, room, fromBlock) {
  const iface = room.interface;
  const addr = await room.getAddress();
  const defs = [
    ["HandSettled", (a) => ({ handId: Number(a.handId), seat: Number(a.winnerSeat), amount: a.amountWon.toString(), kind: "fold-win" })],
    ["PotWinner", (a) => ({ handId: Number(a.handId), seat: Number(a.seat), amount: a.amount.toString(), kind: "showdown" })],
  ];
  let cursor = fromBlock;
  let scanning = false;
  async function scan() {
    if (scanning) return;
    scanning = true;
    try {
      const latest = await provider.getBlockNumber();
      while (cursor <= latest) {
        const batch = [];
        for (let i = 0; i < 8 && cursor <= latest; i++) {
          const to = Math.min(cursor + 899, latest);
          for (const [ev, map] of defs) {
            const topic = iface.getEvent(ev).topicHash;
            batch.push(provider.send("eth_getLogs", [{ address: addr, topics: [topic], fromBlock: "0x" + cursor.toString(16), toBlock: "0x" + to.toString(16) }])
              .then((logs) => logs.map((lg) => ({ t: Number(iface.parseLog({ topics: lg.topics, data: lg.data }).args.tableId), item: map(iface.parseLog({ topics: lg.topics, data: lg.data }).args) })))
              .catch(() => []));
          }
          cursor = to + 1;
        }
        for (const found of await Promise.all(batch)) for (const { t, item } of found) histPush(t, item);
      }
    } catch (_) {} finally { scanning = false; }
  }
  await scan();
  console.log(`[poker-bot] history indexer caught up to block ${cursor - 1}`);
  setInterval(scan, 8000);
}

// ---------------------------------------------------------------------------
// Tournament-results indexer: finishing places, prizes and rebalance moves live
// ONLY in events (Busted/Finished/PlayerMoved — no on-chain view), so the bot
// indexes them the same way as hand history. Served via GET /trnhist?id=N;
// the frontend builds the bust screen / final standings from this.
// ---------------------------------------------------------------------------
const TRNHIST = new Map(); // trnId -> { busts:[{player,place,prize}], winner, moves:[{player,from,to,ts}] }
function trnRec(id) {
  if (!TRNHIST.has(id)) TRNHIST.set(id, { busts: [], winner: null, moves: [] });
  return TRNHIST.get(id);
}

async function startTournamentIndexer(provider, trn, fromBlock) {
  const iface = trn.interface;
  const addr = await trn.getAddress();
  const defs = [
    ["Busted", (a) => {
      const r = trnRec(Number(a.id));
      if (!r.busts.some((b) => b.player.toLowerCase() === a.player.toLowerCase()))
        r.busts.push({ player: a.player, place: Number(a.place), prize: a.prize.toString() });
    }],
    ["Finished", (a) => { trnRec(Number(a.id)).winner = { player: a.winner, prize: a.prize.toString() }; }],
    ["PlayerMoved", (a) => {
      const r = trnRec(Number(a.id));
      r.moves.push({ player: a.player, from: Number(a.fromTable), to: Number(a.toTable), ts: Date.now() });
      while (r.moves.length > 60) r.moves.shift();
    }],
  ];
  let cursor = fromBlock;
  let scanning = false;
  async function scan() {
    if (scanning) return;
    scanning = true;
    try {
      const latest = await provider.getBlockNumber();
      while (cursor <= latest) {
        const batch = [];
        for (let i = 0; i < 8 && cursor <= latest; i++) {
          const to = Math.min(cursor + 899, latest);
          for (const [ev, apply] of defs) {
            const topic = iface.getEvent(ev).topicHash;
            batch.push(provider.send("eth_getLogs", [{ address: addr, topics: [topic], fromBlock: "0x" + cursor.toString(16), toBlock: "0x" + to.toString(16) }])
              .then((logs) => logs.map((lg) => ({ apply, args: iface.parseLog({ topics: lg.topics, data: lg.data }).args })))
              .catch(() => []));
          }
          cursor = to + 1;
        }
        for (const found of await Promise.all(batch)) for (const { apply, args } of found) apply(args);
      }
    } catch (_) {} finally { scanning = false; }
  }
  await scan();
  console.log(`[poker-bot] tournament indexer caught up to block ${cursor - 1}`);
  setInterval(scan, 5000);
}

const CHATS = new Map(); // tableId -> [{ id, who, text, dealer, ts }]
let chatSeq = 1;
function pushChat(tableId, who, text, dealer = false) {
  const list = CHATS.get(Number(tableId)) || [];
  list.push({ id: chatSeq++, who, text: String(text).slice(0, 240), dealer, ts: Date.now() });
  while (list.length > 60) list.shift();
  CHATS.set(Number(tableId), list);
}

// ---------------------------------------------------------------------------
// Snapshot cache. The frontend used to read cfg/hand/seats/board straight from
// the public RPC — ~14 eth_calls per client per 1.5s, which melts down long
// before "hundreds of players". The bot builds each table's snapshot ONCE and
// serves it to every watcher over plain HTTP (GET /snapshot?t=N, GET /lobby).
// BigInts are serialized as strings; the SDK rehydrates them.
// ---------------------------------------------------------------------------
const SNAPS = new Map(); // tableId -> snapshot object (ts inside)
const WATCHED = new Map(); // tableId -> last /snapshot request ts (watched tables refresh hot)
const LOBBY = { ts: 0, obj: null };
const CTL = new Map(); // tableId -> controller address (immutable after creation)
const STATUS = { startedAt: Date.now(), lastLoopEndAt: 0, gasWei: "0", tables: 0, spawned: 0, snapErrors: 0 };
const jsonBig = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

async function controllerOf(room, t) {
  if (!CTL.has(t)) CTL.set(t, (await room.tableController(t)).toLowerCase());
  return CTL.get(t);
}

function startSnapshotCache(provider, room, dealerC, trn, zkCtx = {}) {
  async function buildTable(t) {
    const [cfg, hand, ctl] = await Promise.all([room.getTable(t), room.getHand(t), controllerOf(room, t)]);
    const n = Number(cfg.maxSeats);
    const seats = await Promise.all(Array.from({ length: n }, async (_, s) => {
      const [seat, sh] = await Promise.all([room.getSeat(t, s), room.getSeatHand(t, s)]);
      return {
        index: s, player: seat.player, occupied: seat.occupied, sittingOut: seat.sittingOut,
        sitOutSince: Number(seat.sitOutSince ?? 0),
        stack: seat.stack, inHand: sh.inHand, folded: sh.folded, allIn: sh.allIn, committedStreet: sh.committedStreet,
      };
    }));
    let board = [];
    if (hand.inProgress && hand.dealId !== 0n) {
      const bn = Number(await dealerC.boardRevealedCount(hand.dealId));
      if (bn > 0) board = (await dealerC.boardCards(hand.dealId)).map(Number).slice(0, bn);
    }
    return {
      ts: Date.now(), tableId: t, controller: ctl,
      zk: zkCtx.ZK_MODE ? require("./lib/poker-zk-dealer").zkSnapshot(zkCtx.zkState, t) : null,
      cfg: {
        maxSeats: n, smallBlind: cfg.smallBlind, bigBlind: cfg.bigBlind, ante: cfg.ante,
        minBuyIn: cfg.minBuyIn, maxBuyIn: cfg.maxBuyIn, rakeBps: Number(cfg.rakeBps),
        rakeCap: cfg.rakeCap, actionTimeout: Number(cfg.actionTimeout), active: cfg.active,
      },
      hand: {
        handId: Number(hand.handId), street: Number(hand.street), button: Number(hand.button),
        actingSeat: Number(hand.actingSeat), numInHand: Number(hand.numInHand), currentBet: hand.currentBet,
        minRaise: hand.minRaise, pot: hand.pot, actingDeadline: Number(hand.actingDeadline),
        dealId: hand.dealId, inProgress: hand.inProgress,
      },
      seats, board,
    };
  }

  let busy = false;
  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const count = Number(await room.tableCount());
      STATUS.tables = count;
      // Build every DUE table CONCURRENTLY — reads have no nonce ordering, so a
      // parallel refresh keeps the served snapshot fresh (~one buildTable of
      // latency) even with many hot tables, instead of N×buildTable serially.
      // This is the display-latency fix: under multi-table load the cache no
      // longer lags seconds behind the chain.
      const due = [];
      for (let t = 0; t < count; t++) {
        const prev = SNAPS.get(t);
        const active = prev && (prev.hand.inProgress || prev.seats.some((s) => s.occupied));
        const watched = Date.now() - (WATCHED.get(t) || 0) < 30_000; // someone's page is open
        if (prev && !active && !watched && Date.now() - prev.ts < 8000) continue;
        due.push(t);
      }
      await Promise.all(due.map((t) => buildTable(t).then((s) => SNAPS.set(t, s)).catch(() => { STATUS.snapErrors++; })));
      await refreshLobby();
    } catch (_) { STATUS.snapErrors++; }
    finally { busy = false; }
  }

  const doneTrnCache = new Map(); // finished/cancelled tournaments never change
  async function refreshLobby() {
    if (Date.now() - LOBBY.ts < 3000) return;
    const tables = [];
    for (const [t, s] of [...SNAPS.entries()].sort((a, b) => a[0] - b[0])) {
      tables.push({
        id: t, controller: s.controller, maxSeats: s.cfg.maxSeats,
        smallBlind: s.cfg.smallBlind, bigBlind: s.cfg.bigBlind, rakeBps: s.cfg.rakeBps, rakeCap: s.cfg.rakeCap,
        seated: s.seats.filter((x) => x.player !== "0x0000000000000000000000000000000000000000").length,
        pot: s.hand.pot, inHand: s.hand.inProgress,
      });
    }
    const tournaments = [];
    if (trn) {
      try {
        const n = Number(await trn.count());
        for (let id = 0; id < n; id++) {
          if (doneTrnCache.has(id)) { tournaments.push(doneTrnCache.get(id)); continue; }
          const [i, hostBps] = await Promise.all([trn.info(id), trn.hostBpsOf(id).catch(() => 0)]);
          const row = {
            id, creator: i.creator, buyIn: i.buyIn, fee: i.fee, startStack: i.startStack, pool: i.pool,
            maxPlayers: Number(i.maxPlayers), registered: Number(i.registered), status: Number(i.status),
            remaining: Number(i.remaining), tableId: Number(i.tableId), payoutBps: i.payoutBps.map(Number),
            approvalRequired: i.approvalRequired, pendingCount: Number(i.pendingCount), hostBps: Number(hostBps),
          };
          if (row.status >= 2) doneTrnCache.set(id, row);
          tournaments.push(row);
        }
      } catch (_) {}
    }
    LOBBY.ts = Date.now();
    LOBBY.obj = { ts: LOBBY.ts, tables, tournaments };
  }

  refresh();
  setInterval(refresh, 900); // fresher served state; parallel build keeps a pass cheap
}

// ---------------------------------------------------------------------------
// Anti-AFK: kick every seat whose consecutive-timeout streak hit the contract
// threshold (3). Runs right after a hand ends, so the seat is kickable (no
// live-hand participation). Their stack returns to their in-room bankroll.
// ---------------------------------------------------------------------------
async function kickIdlers(room, t, send = (fn) => fn().then((r) => r.wait())) {
  // Tournament tables: seats belong to the tournament (kickIdle reverts with
  // ControlledTable) — timeouts there end in a bust, not a kick. Skip entirely.
  if ((await controllerOf(room, t)) !== "0x0000000000000000000000000000000000000000") return;
  if ((await room.getHand(t)).inProgress) return; // next hand already dealt — catch them next settle
  const snap = SNAPS.get(t);
  const n = snap ? snap.cfg.maxSeats : Number((await room.getTable(t)).maxSeats);
  for (let s = 0; s < n; s++) {
    const seat = await room.getSeat(t, s);
    if (!seat.occupied) continue;
    const streak = Number(await room.timeoutStreak(t, s));
    // kick basis: 3 strikes, or parked sitting-out for 10+ min (contract-enforced)
    const parked = seat.sittingOut && Number(seat.sitOutSince ?? 0) > 0 && Date.now() / 1000 > Number(seat.sitOutSince) + 605;
    if (streak < 3 && !parked) continue;
    try {
      await send(() => room.kickIdle(t, s));
      console.log(`[poker-bot] table ${t}: KICKED idle seat ${s} (${seat.player.slice(0, 8)}…, ${streak} straight timeouts)`);
      pushChat(t, "dealer", `Seat ${s} removed — idle for ${streak} hands. Chips returned to their bankroll.`, true);
    } catch (e) {
      if (!/NotIdle|InHand|NotSeated|ControlledTable/.test(e.message || "")) console.error(`[poker-bot] kickIdle t${t}s${s}:`, e.shortMessage || e.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Auto-spawn: when every cash table of a config (blinds+size) is nearly full,
// clone one more so newcomers always find a seat. Runs INSIDE the main loop
// (sequential with dealing txs — same wallet, no nonce races). Owner-only
// createTable, and the bot key IS the room owner.
// ---------------------------------------------------------------------------
const SPAWN_CAP = 24; // hard ceiling on total tables
async function maybeSpawnTables(room) {
  const groups = new Map(); // "sb|bb|seats" -> { free, cfg }
  let total = 0;
  for (const [t, s] of SNAPS.entries()) {
    total = Math.max(total, t + 1);
    if (s.controller !== "0x0000000000000000000000000000000000000000") continue; // tournament tables don't count
    if (!s.cfg.active) continue;
    const key = `${s.cfg.smallBlind}|${s.cfg.bigBlind}|${s.cfg.maxSeats}`;
    const seated = s.seats.filter((x) => x.player !== "0x0000000000000000000000000000000000000000").length;
    const g = groups.get(key) || { free: 0, cfg: s.cfg };
    g.free += s.cfg.maxSeats - seated;
    groups.set(key, g);
  }
  if (total === 0 || total >= SPAWN_CAP) return;
  for (const [key, g] of groups.entries()) {
    if (g.free >= 2) continue; // still room somewhere in this group
    const cfg = {
      maxSeats: g.cfg.maxSeats, smallBlind: g.cfg.smallBlind, bigBlind: g.cfg.bigBlind, ante: g.cfg.ante,
      minBuyIn: g.cfg.minBuyIn, maxBuyIn: g.cfg.maxBuyIn, rakeBps: g.cfg.rakeBps, rakeCap: g.cfg.rakeCap,
      actionTimeout: g.cfg.actionTimeout, active: true,
    };
    await (await room.createTable(cfg)).wait();
    STATUS.spawned++;
    console.log(`[poker-bot] AUTO-SPAWNED a new table (config ${key}) — group was full`);
    return; // one spawn per pass is plenty
  }
}

async function main() {
  must(KEY, "missing DEALER_KEY / PRIVATE_KEY");
  must(MASTER && /^0x[0-9a-fA-F]{64}$/.test(MASTER), "missing/invalid POKER_SEED_MASTER_KEY (need 32-byte hex)");
  const { room: roomAddr, dealer: dealerAddr, tournament: trnAddr, zk: zkAddr, deployBlock } = loadAddresses();

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  // ethers v6 defaults pollingInterval to 4000ms → every tx.wait() waits up to
  // 4s for the next poll AFTER it mines. That, times N serial writes, was the
  // bulk of the multi-table lag. 400ms makes each confirmation near-instant.
  provider.pollingInterval = 400;
  const wallet = new ethers.Wallet(KEY, provider);
  // Throughput model: tables are advanced CONCURRENTLY (their reads run in
  // parallel), but every state-changing tx is funnelled through `runTx`, a
  // strict serial queue — so nonces are always contiguous (a reverting tx just
  // frees the queue, never a gap → never the hang the naive NonceManager caused).
  let txChain = Promise.resolve();
  const runTx = (fn) => {
    const done = txChain.then(() => fn().then((r) => r.wait()));
    txChain = done.then(() => {}, () => {}); // keep the queue alive through reverts
    return done;
  };
  const room = new ethers.Contract(roomAddr, loadAbi("PokerRoom"), wallet);
  const dealer = dealerAddr ? new ethers.Contract(dealerAddr, loadAbi("CommitRevealDealer"), wallet) : null;
  const trn = trnAddr ? new ethers.Contract(trnAddr, loadAbi("PokerTournament"), wallet) : null;
  const state = newState();
  // Tables held between hands while a tournament level-up drains them to idle
  // (see the driver's freeze logic) — the bot won't start new hands on these.
  const freeze = new Set();

  // ---- zkShuffle v2 mode: manifest carries a ZkTableDealer → the mental-poker
  // coordinator replaces the v1 seed dealer. Several WORKER keys (each a room
  // operator + dealer coordinator, funded at deploy) advance tables in
  // parallel — independent nonce spaces, no shared serial queue.
  const ZK_MODE = !!zkAddr;
  const zkState = zkDrv.newZkState();
  const PERSIST_DIR = path.join(__dirname, "..", "deployments", "zk-active");
  const WORKERS = [];
  if (ZK_MODE) {
    const zkModule = await import("../frontend/poker/zk-bn254.js");
    const { bn254 } = await import("@noble/curves/bn254");
    const nodeCrypto = require("node:crypto");
    zkModule.init({ bn254, keccak256: ethers.keccak256, randomBytes: (n) => nodeCrypto.randomBytes(n) });
    zkDrv.init({ zkModule, bn254 });
    const W = Math.max(1, parseInt(process.env.ZK_WORKERS || "3", 10));
    for (let i = 0; i < W; i++) {
      const w = new ethers.Wallet(ethers.keccak256(ethers.solidityPacked(["bytes32", "string"], [MASTER, `zk-worker-${i}`])), provider);
      let chain = Promise.resolve();
      const run = (fn) => {
        const done = chain.then(() => fn().then((r) => r.wait()));
        chain = done.then(() => {}, () => {});
        return done;
      };
      WORKERS.push({
        wallet: w, runTx: run,
        room: new ethers.Contract(roomAddr, loadAbi("PokerRoom"), w),
        zkd: new ethers.Contract(zkAddr, loadAbi("ZkTableDealer"), w),
      });
    }
    console.log(`[poker-bot] zk mode ON: dealer=${zkAddr} workers=${WORKERS.map((w) => w.wallet.address.slice(0, 8)).join(",")}`);
  }

  console.log(`[poker-bot] net=${NET} room=${roomAddr} dealer=${dealerAddr || "(v2)"} tournament=${trnAddr || "(none)"} wallet=${wallet.address}`);

  // --- hole-card API: a player proves wallet ownership, gets only their cards.
  //     In zk mode the same server also relays the mental-poker protocol.
  startCardServer(room, state, { zkState, ZK_MODE });

  // --- snapshot cache: one chain read per table serves every watcher over HTTP.
  //     Card views (board etc.) come from whichever dealer the room runs on —
  //     the IPokerDealer interface is identical for v1 and v2.
  const cardView = ZK_MODE ? new ethers.Contract(zkAddr, loadAbi("ZkTableDealer"), provider) : dealer;
  startSnapshotCache(provider, room, cardView, trn, { zkState, ZK_MODE });

  // --- hand-history indexer (backfills in the background, then stays current)
  startHistoryIndexer(provider, room, deployBlock || 0).catch((e) => console.error("[poker-bot] indexer:", e.message));

  // --- tournament-results indexer (places/prizes/moves — event-only data)
  if (trn) startTournamentIndexer(provider, trn, deployBlock || 0).catch((e) => console.error("[poker-bot] trn indexer:", e.message));

  // --- main poll loop: tournaments first (busts/level-ups land in the
  //     inter-hand window), then deal every table.
  const foreignTable = new Map(); // tableId -> true (controlled by a contract we don't drive)
  const tableBackoffUntil = new Map(); // tableId -> ts (skip until; error / abandoned-table cool-down)
  const timeoutStreak = new Map(); // tableId -> consecutive timeout-fold count
  let lastGasWarnAt = 0;

  async function loop() {
    // Low-gas alarm: every action costs gas; below ~0.5 STT dealing starts failing.
    try {
      if (Date.now() - lastGasWarnAt > 60_000) {
        const balWei = await provider.getBalance(wallet.address);
        STATUS.gasWei = balWei.toString();
        // SELF-REFUEL: the bot key IS the room/tournament owner, so the house's
        // own take (cash rake + tournament fees) tops the gas tank up before
        // dealing can stall — no manual STT top-ups needed.
        if (balWei < 3000000000000000000n) { // < 3 STT
          try {
            const rake = await room.rakeCollected();
            if (rake > 0n) {
              await (await room.withdrawRake(wallet.address, rake)).wait();
              console.log(`[poker-bot] SELF-REFUEL: +${ethers.formatEther(rake)} STT from cash rake → gas tank`);
            }
          } catch (e) { console.error("[poker-bot] refuel(rake):", e.shortMessage || e.message); }
          try {
            const fees = trn ? await trn.feeCollected() : 0n;
            if (fees > 0n) {
              await (await trn.withdrawFees(wallet.address, fees)).wait();
              console.log(`[poker-bot] SELF-REFUEL: +${ethers.formatEther(fees)} STT from tournament fees → gas tank`);
            }
          } catch (e) { console.error("[poker-bot] refuel(fees):", e.shortMessage || e.message); }
        }
        // PROFIT SWEEP: rake + tournament fees land on this wallet (self-refuel
        // above); everything over the 50 STT gas reserve auto-forwards to the
        // owner's main wallet. Swept only when the excess is ≥ 5 STT so we
        // don't spam dust transfers.
        const RESERVE = 50n * 10n ** 18n;
        if (balWei > RESERVE + 5n * 10n ** 18n) {
          const excess = balWei - RESERVE;
          try {
            await (await wallet.sendTransaction({ to: PROFIT_WALLET, value: excess })).wait();
            console.log(`[poker-bot] PROFIT SWEEP: ${ethers.formatEther(excess)} STT → ${PROFIT_WALLET}`);
          } catch (e) { console.error("[poker-bot] sweep:", e.shortMessage || e.message); }
        }
        if (balWei < 500000000000000000n) {
          console.error(`[poker-bot] LOW GAS: operator ${wallet.address} has ${ethers.formatEther(balWei)} STT — top up or dealing will stall`);
          lastGasWarnAt = Date.now();
        }
        // zk worker keys refuel from the main wallet (which self-refuels from
        // the rake above) — each worker pays prepare/reveal gas on its tables.
        if (ZK_MODE) {
          for (const w of WORKERS) {
            try {
              const wb = await provider.getBalance(w.wallet.address);
              if (wb < 1000000000000000000n && balWei > 4000000000000000000n) { // worker <1 STT, main >4
                await (await wallet.sendTransaction({ to: w.wallet.address, value: 2000000000000000000n })).wait();
                console.log(`[poker-bot] worker refuel: 2 STT → ${w.wallet.address.slice(0, 10)}…`);
              }
            } catch (e) { console.error("[poker-bot] worker refuel:", e.shortMessage || e.message); }
          }
        }
      }
    } catch (_) {}

    if (trn) {
      const tags = await tickTournaments(trn, room, { freeze });
      for (const tag of tags) console.log(`[poker-bot] ${tag}`);
    }
    let tableCount;
    try {
      tableCount = Number(await room.tableCount());
    } catch (e) {
      console.error("[poker-bot] tableCount failed:", e.shortMessage || e.message);
      return;
    }
    const trnAddrLc = trn ? (await trn.getAddress()).toLowerCase() : null;

    // Advance each playable table, one awaited tx at a time (see the sequential
    // note where the wallet is created).
    async function processTable(t) {
      try {
        // Tables controlled by an ORPHANED tournament contract (pre-redeploy)
        // must not be dealt — we can't report their busts, so hands would burn
        // gas forever without the event ever finishing.
        if (!foreignTable.has(t)) {
          const ctl = (await room.tableController(t)).toLowerCase();
          const foreign = ctl !== "0x0000000000000000000000000000000000000000" && ctl !== trnAddrLc;
          foreignTable.set(t, foreign);
          if (foreign) { console.log(`[poker-bot] table ${t}: controlled by foreign/orphaned ${ctl} — skipping permanently`); return; }
        }
        const worker = ZK_MODE ? WORKERS[t % WORKERS.length] : null;
        const tag = ZK_MODE
          ? await zkDrv.tickZkTable(worker.room, worker.zkd, zkState, t, { tx: worker.runTx, noNewHands: freeze.has(t), persistDir: PERSIST_DIR })
          : await tickTable(room, dealer, MASTER, state, t, { tx: runTx, noNewHands: freeze.has(t) });
        if (tag && tag !== "idle" && tag !== "wait" && !/^(keys:|shuffle:|holeshares|board-wait|showdown-collect|showdown-wait|prep|inter-hand|hold)/.test(tag)) {
          console.log(`[poker-bot] table ${t}: ${tag}`);
        }
        if (tag === "timeout") {
          const n = (timeoutStreak.get(t) || 0) + 1;
          timeoutStreak.set(t, n);
          if (n >= 6) { tableBackoffUntil.set(t, Date.now() + 30_000); }
        }
        if (tag === "settled" || (tag && tag.startsWith("cancelled"))) {
          if ((timeoutStreak.get(t) || 0) >= 6) tableBackoffUntil.set(t, Date.now() + 30_000);
          else timeoutStreak.set(t, 0);
        }
        // anti-AFK: once a hand settles, stand up any seat with 3+ straight timeouts
        if (tag === "settled" || tag === "hand-ended" || tag === "timeout") {
          try { await kickIdlers(room, t, runTx); } catch (e) { console.error(`[poker-bot] kick t${t}:`, e.shortMessage || e.message); }
        }
        if (tag === "started") pushChat(t, "dealer", ZK_MODE ? "New hand — deck mentally shuffled by the players, verified on-chain." : "New hand — deck commitment sealed on-chain.", true);
        else if (tag === "showdown-reveal" || tag === "showdown-ready") pushChat(t, "dealer", "Showdown — cards revealed & proven on-chain.", true);
        else if (tag === "settled") pushChat(t, "dealer", "Pot settled on-chain.", true);
        else if (tag === "timeout") pushChat(t, "dealer", "Player timed out — auto-folded.", true);
        else if (tag && tag.startsWith("cancelled:penalized")) pushChat(t, "dealer", "Hand cancelled — a player abandoned the deal; their chips in the pot were forfeited to the table.", true);
        else if (tag && tag.startsWith("cancelled")) pushChat(t, "dealer", "Hand cancelled — all contributions refunded.", true);
        else if (tag && tag.startsWith("strike:")) pushChat(t, "dealer", "A seat didn't respond to the deal and was sat out.", true);
      } catch (e) {
        console.error(`[poker-bot] table ${t} error:`, e.shortMessage || e.message);
        tableBackoffUntil.set(t, Date.now() + 30_000); // don't spam a failing table every tick
      }
    }

    // Advance all due tables CONCURRENTLY — reads run in parallel, writes stay
    // serialized by runTx. A slow/idle table no longer blocks the others.
    const due = [];
    for (let t = 0; t < tableCount; t++) {
      if (foreignTable.get(t)) continue;
      if ((tableBackoffUntil.get(t) || 0) > Date.now()) continue;
      due.push(t);
    }
    await Promise.all(due.map(processTable));
  }

  // simple non-overlapping interval
  let running = false;
  let loopN = 0;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await loop();
      // auto-spawn check every ~30s, sequential with dealing (same wallet nonce)
      if (++loopN % 20 === 0) await maybeSpawnTables(room).catch((e) => console.error("[poker-bot] spawn:", e.shortMessage || e.message));
    } finally {
      running = false;
      STATUS.lastLoopEndAt = Date.now();
    }
  }, POLL_MS);

  // Watchdog: if the loop wedges (an await that never resolves ate the
  // `running` flag — the exact failure mode behind past multi-hour stalls),
  // die loudly and let pm2 bring up a fresh process.
  setInterval(() => {
    const age = Date.now() - (STATUS.lastLoopEndAt || STATUS.startedAt);
    if (age > 180_000) {
      console.error(`[poker-bot] WATCHDOG: main loop silent for ${Math.round(age / 1000)}s — exiting for a clean pm2 restart`);
      process.exit(1);
    }
  }, 30_000);
}

// ---------------------------------------------------------------------------
// Hole-card delivery. Pre-showdown the deck seed is secret, so a player learns
// only their own two cards, and only after proving they own the seat. (The full
// deck becomes public + verifiable at showdown via the seed reveal.)
// In zk mode the same server relays the v2 protocol: /zk/task (poll: what
// should my browser compute now + the shares I need to decrypt MY cards),
// /zk/key, /zk/shuffle, /zk/shares. All sig-gated to the seat owner.
// ---------------------------------------------------------------------------
function startCardServer(room, state, zkCtx = {}) {
  // signature → effective player address (session keys resolve to their owner)
  async function resolveSigner(message, signature) {
    const signer = ethers.verifyMessage(message, signature);
    let effective = signer;
    try {
      const owner = await room.sessionOwnerOf(signer);
      if (owner && owner !== "0x0000000000000000000000000000000000000000") effective = owner;
    } catch (_) {}
    return effective.toLowerCase();
  }
  const readBody = (req) => new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1_500_000) { reject(new Error("body too large")); req.destroy(); } });
    req.on("end", () => resolve(body));
  });

  const server = http.createServer(async (req, res) => {
    // ---- zkShuffle v2 protocol relay --------------------------------------
    if (zkCtx.ZK_MODE && req.method === "POST" && req.url.startsWith("/zk/")) {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const t = Number(body.tableId);
        const addr = await resolveSigner(`ShinyPoker:zk:${t}:${body.dealId}`, body.signature);
        let out;
        if (req.url.startsWith("/zk/task")) out = zkDrv.zkTask(zkCtx.zkState, t, addr);
        else if (req.url.startsWith("/zk/key")) out = zkDrv.zkPostKey(zkCtx.zkState, t, addr, body);
        else if (req.url.startsWith("/zk/shuffle")) out = zkDrv.zkPostShuffle(zkCtx.zkState, t, addr, body);
        else if (req.url.startsWith("/zk/shares")) out = zkDrv.zkPostShares(zkCtx.zkState, t, addr, body);
        else { res.writeHead(404).end(); return; }
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        return res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }
    handleV1(req, res);
  });

  function handleV1(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    if (req.method === "GET" && req.url.startsWith("/health")) {
      const now = Date.now();
      const loopAge = now - (STATUS.lastLoopEndAt || STATUS.startedAt);
      const body = {
        ok: loopAge < 60_000,
        uptimeSec: Math.round((now - STATUS.startedAt) / 1000),
        loopAgeMs: loopAge,
        gasSTT: Number(STATUS.gasWei) / 1e18,
        tables: STATUS.tables,
        spawned: STATUS.spawned,
        snapErrors: STATUS.snapErrors,
        snapshots: [...SNAPS.entries()].map(([t, s]) => ({ t, ageMs: now - s.ts, inHand: s.hand.inProgress })),
      };
      res.writeHead(body.ok ? 200 : 503, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(body));
    }
    if (req.method === "GET" && req.url.startsWith("/snapshot")) {
      const u = new URL(req.url, "http://x");
      const t = Number(u.searchParams.get("t") || 0);
      WATCHED.set(t, Date.now()); // keep watched tables on the hot refresh path
      const s = SNAPS.get(t);
      if (!s || Date.now() - s.ts > 15_000) { res.writeHead(503, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "snapshot not ready" })); }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(jsonBig(s));
    }
    if (req.method === "GET" && req.url.startsWith("/lobby")) {
      if (!LOBBY.obj || Date.now() - LOBBY.ts > 20_000) { res.writeHead(503, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "lobby not ready" })); }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(jsonBig(LOBBY.obj));
    }
    if (req.method === "GET" && req.url.startsWith("/history")) {
      const u = new URL(req.url, "http://x");
      const t = Number(u.searchParams.get("t") || 0);
      const list = (HIST.get(t) || []).slice(-40).reverse();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ hands: list }));
    }
    if (req.method === "GET" && req.url.startsWith("/trnhist")) {
      const u = new URL(req.url, "http://x");
      const id = Number(u.searchParams.get("id") || 0);
      const r = TRNHIST.get(id) || { busts: [], winner: null, moves: [] };
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(r));
    }
    if (req.method === "GET" && req.url.startsWith("/chat")) {
      const u = new URL(req.url, "http://x");
      const t = Number(u.searchParams.get("t") || 0);
      const since = Number(u.searchParams.get("since") || 0);
      const list = (CHATS.get(t) || []).filter((m) => m.id > since);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ messages: list }));
    }
    if (req.method === "POST" && req.url.startsWith("/chat")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const { tableId, text, signature } = JSON.parse(body || "{}");
          if (!text || !String(text).trim()) throw new Error("empty message");
          const message = `ShinyPoker:chat:${tableId}:${text}`;
          const signer = ethers.verifyMessage(message, signature);
          let effective = signer;
          try {
            const owner = await room.sessionOwnerOf(signer);
            if (owner && owner !== "0x0000000000000000000000000000000000000000") effective = owner;
          } catch (_) {}
          // only seated players may talk
          const seatIdx = Number(await room.seatOf(tableId, effective));
          if (seatIdx === 255) throw new Error("not seated at this table");
          const who = effective.slice(0, 6) + "…" + effective.slice(-4);
          pushChat(tableId, who, String(text).trim());
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    if (req.method !== "POST" || !req.url.startsWith("/holes")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { tableId, dealId, signature } = JSON.parse(body || "{}");
        const message = `ShinyPoker:holes:${tableId}:${Number(dealId)}`;
        const signer = ethers.verifyMessage(message, signature);
        const st = state.get(Number(tableId));
        if (!st || st.dealId !== Number(dealId) || !st.holes) {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "no active deal / cards not ready" }));
        }
        // The signer may be the seat owner OR their authorized session key.
        let effective = signer;
        try {
          const owner = await room.sessionOwnerOf(signer);
          if (owner && owner !== "0x0000000000000000000000000000000000000000") effective = owner;
        } catch (_) {}
        const cfg = await room.getTable(tableId);
        let mySeat = -1;
        for (let s = 0; s < Number(cfg.maxSeats); s++) {
          const seat = await room.getSeat(tableId, s);
          if (seat.player.toLowerCase() === effective.toLowerCase()) {
            mySeat = s;
            break;
          }
        }
        const cards = mySeat >= 0 ? st.holes.holesBySeat[mySeat] : null;
        if (!cards) {
          res.writeHead(403, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "not seated in this deal" }));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ seat: mySeat, cards, cardsStr: cards.map(cardStr) }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  }
  const port = zkCtx.port || PORT;
  server.listen(port, () => console.log(`[poker-bot] hole-card API on :${port}`));
  return server;
}

// Exported so an E2E harness can mount the SAME relay/hole-card server in-process
// (the live entrypoint still runs main() when executed directly).
module.exports = { startCardServer, startSnapshotCache };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
