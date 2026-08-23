// Concurrency stress test: how does felt latency degrade as online grows?
// Run:  npx hardhat run scripts/_zk-stress.js
//
// Question: max concurrent online before the game lags. User's bar: >1s per
// action = unpleasant, >5s = unplayable.
//
// Two latency sources, measured separately (honest breakdown):
//  1. PER-ACTION FLOOR — a player's own act() tx confirmation. This is set by
//     the CHAIN, load-independent, and measured live at ~1.7s median on Somnia
//     testnet (see the calibration run). Already past the >1s "unpleasant" bar
//     before any load — nothing in our architecture changes it.
//  2. DEALER-LAG — under load the N coordinator workers fall behind on the
//     ~11 txns/hand (deal, board reveals, showdown, settle), so hand PROGRESSION
//     (whose turn / reveal / pot) stalls on top of the floor. THIS is what the
//     multi-worker design controls, and what this harness sweeps.
//
// Method: run the REAL tickZkTable loop over M concurrent tables with each
// worker's tx wrapped in the measured BLOCK_MS (default 1700 = real Somnia),
// W=3 (prod). Sample every table's "age since last on-chain advance" each loop
// tick; report p50/p95/p99 of that stall per M. Client shuffle-proof crypto is
// stubbed (parallel across browsers in prod; per-ACTION latency has no crypto).

const hre = require("hardhat");
const { ethers } = hre;
const crypto = require("node:crypto");
const zkDrv = require("./lib/poker-zk-dealer");

const CHECK = 1, CALL = 2;
const E = (n) => ethers.parseEther(String(n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ACTION_FLOOR_MS = Number(process.env.ST_FLOOR || 1700); // measured Somnia per-tx confirm
const BLOCK_MS = Number(process.env.ST_BLOCK || 1700);        // modeled dealer tx confirmation latency (parallel)
const SEND_MS = Number(process.env.ST_SEND || 70);            // modeled per-tx BROADCAST cost (serialized per worker)
const PIPELINE = process.env.ST_PIPELINE !== "0";             // pipelined dispatch on by default
const WORKERS = Number(process.env.ST_WORKERS || 3);
const DURATION_MS = Number(process.env.ST_DURATION || 30000);
const SWEEP = (process.env.ST_SWEEP || "6,12,24,48").split(",").map(Number);

function pct(arr, q) { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }

class SimClient {
  constructor(zk, addr) { this.zk = zk; this.addr = addr.toLowerCase(); this.byDeal = new Map(); }
  step(zk, state, t) {
    const task = zkDrv.zkTask(state, t, this.addr);
    if (task.observer || task.phase === "none" || task.participant === undefined) return;
    const dealId = task.dealId;
    if (task.do === "key") {
      const kg = zk.keygen(task.domain);
      this.byDeal.set(dealId, { x: kg.x, X: kg.X });
      zkDrv.zkPostKey(state, t, this.addr, { dealId, X: zkDrv.serPt(kg.X), pokR: zkDrv.serPt(kg.pok.R), pokS: "0x" + kg.pok.s.toString(16) });
    } else if (task.do === "shuffle") {
      const deck = task.deck.map(zkDrv.parseCt); const X = zkDrv.parsePt(task.aggKey);
      const out = zk.shuffleRemask(deck, X);
      zkDrv.zkPostShuffle(state, t, this.addr, { dealId, deck: out.deck.map(zkDrv.serCt) });
      const prf = zk.proveShuffle(`SPZK:${dealId}:shuffle:${task.participant}`, deck, out.deck, X, out.secret);
      zkDrv.zkPostShuffleProof(state, t, this.addr, { dealId, turn: task.participant, proof: zk.shuffleProofToWire(prf) });
    } else if (task.do === "shares") {
      const sec = this.byDeal.get(dealId);
      const items = task.idxs.map((idx) => {
        const sh = zk.decryptionShare(zkDrv.parseCt(task.cts[idx]), sec.x, sec.X, task.domains[idx]);
        return { idx, d: zkDrv.serPt(sh.d), R1: zkDrv.serPt(sh.proof.R1), R2: zkDrv.serPt(sh.proof.R2), s: "0x" + sh.proof.s.toString(16) };
      });
      if (items.length) zkDrv.zkPostShares(state, t, this.addr, { dealId, items });
    }
  }
}

async function scenario(M, W, zk, owner, funder) {
  const Room = await ethers.getContractFactory("PokerRoom", owner);
  const room = await Room.deploy(owner.address);
  const Zkd = await ethers.getContractFactory("ZkTableDealer", owner);
  const zkd = await Zkd.deploy(await room.getAddress(), owner.address);
  await room.setDealer(await zkd.getAddress());

  const workers = [];
  for (let i = 0; i < W; i++) {
    const w = ethers.Wallet.createRandom().connect(ethers.provider);
    await funder.sendTransaction({ to: w.address, value: E(50) });
    await room.setOperator(w.address, true); await zkd.setCoordinator(w.address, true);
    let sendChain = Promise.resolve();
    // PIPELINED dispatch (the fix): serialize only the BROADCAST (keeps nonces
    // contiguous, ~SEND_MS each), then confirm IN PARALLEL (BLOCK_MS overlaps
    // across in-flight txns) — exactly what measurement [B]/[C] proved the chain
    // supports. vs the old model that awaited each confirmation before the next
    // send (1 tx / BLOCK_MS per worker). Set ST_PIPELINE=0 to A/B the old way.
    const runTx = PIPELINE
      ? (fn) => {
          const sent = sendChain.then(async () => { const r = await fn(); await sleep(SEND_MS); return r; });
          sendChain = sent.then(() => {}, () => {});
          return sent.then(async (r) => { await sleep(BLOCK_MS); return r.wait(); });
        }
      : (fn) => { const d = sendChain.then(async () => { const r = await fn(); await sleep(BLOCK_MS); return r.wait(); }); sendChain = d.then(() => {}, () => {}); return d; };
    workers.push({ runTx, room: room.connect(w), zkd: zkd.connect(w) });
  }

  const cfg = { maxSeats: 2, smallBlind: E(1), bigBlind: E(2), ante: 0, minBuyIn: E(40), maxBuyIn: E(200), rakeBps: 0, rakeCap: 0, actionTimeout: 3000, active: true };
  const clients = [];
  for (let t = 0; t < M; t++) {
    await room.createTable(cfg);
    const tc = [];
    for (let s = 0; s < 2; s++) {
      const pl = ethers.Wallet.createRandom().connect(ethers.provider);
      await funder.sendTransaction({ to: pl.address, value: E(41) }); // 40 min buy-in + gas (fits 200 players / funder)
      await room.connect(pl).deposit({ value: E(40) });
      await room.connect(pl).sitDown(t, s, E(40));
      tc.push(pl);
    }
    clients.push(tc.map((pl) => ({ wallet: pl, sim: new SimClient(zk, pl.address) })));
  }

  const state = zkDrv.newZkState();
  const lastAdvance = new Array(M).fill(Date.now());
  const stalls = []; // sampled "age since last advance" across all tables (ms)
  const t0 = Date.now();
  async function drive(t) {
    const wk = workers[t % W];
    while (Date.now() - t0 < DURATION_MS) {
      try {
        const tag = await zkDrv.tickZkTable(wk.room, wk.zkd, state, t, { tx: wk.runTx, persistDir: null, interHandMs: 200 });
        if (tag !== "wait" && tag !== "inter-hand" && !String(tag).endsWith("-wait")) lastAdvance[t] = Date.now();
      } catch (_) {}
      for (const c of clients[t]) { try { c.sim.step(zk, state, t); } catch (_) {} }
      try {
        const h = await wk.room.getHand(t);
        if (h.inProgress && Number(h.street) <= 3) {
          const seat = Number(h.actingSeat);
          const sh = await wk.room.getSeatHand(t, seat);
          const toCall = h.currentBet > sh.committedStreet;
          await room.connect(clients[t][seat].wallet).act(t, toCall ? CALL : CHECK, 0).then((x) => x.wait());
        }
      } catch (_) {}
      stalls.push(Date.now() - lastAdvance[t]);
      await sleep(30);
    }
  }
  await Promise.all(Array.from({ length: M }, (_, t) => drive(t)));

  let hands = 0n; for (let t = 0; t < M; t++) hands += await room.handCounter(t);
  // felt latency to "the game moved after my action" ≈ per-action floor + dealer stall
  return { M, W, players: M * 2, hands: Number(hands), stallP50: pct(stalls, 0.5), stallP95: pct(stalls, 0.95), stallP99: pct(stalls, 0.99) };
}

async function main() {
  const mod = await import("../frontend/poker/zk-bn254.js");
  const { bn254 } = await import("@noble/curves/bn254");
  mod.init({ bn254, keccak256: ethers.keccak256, randomBytes: (n) => crypto.randomBytes(n) });
  const zk = Object.assign({}, mod); // ESM namespace is frozen — stub on a copy
  zk.proveShuffle = () => ({ stub: true }); zk.verifyShuffle = () => true;
  zk.shuffleProofToWire = () => ({ stub: true }); zk.shuffleProofFromWire = () => ({ stub: true });
  zk.shuffleTranscriptHash = () => ethers.ZeroHash;
  zkDrv.init({ zkModule: zk, bn254 });

  const signers = await ethers.getSigners();
  const owner = signers[0];
  console.log(`[stress] W=${WORKERS} workers, dispatch=${PIPELINE ? "PIPELINED" : "serial"}, confirm=${BLOCK_MS}ms(parallel) broadcast=${SEND_MS}ms, per-action floor=${ACTION_FLOOR_MS}ms`);
  console.log(`[stress] sweeping tables: ${SWEEP.join(", ")} (players = tables×2)\n`);
  const rows = [];
  for (let i = 0; i < SWEEP.length; i++) {
    const M = SWEEP[i];
    const funder = signers[1 + i]; // fresh 10000-ETH funder per level (no cross-level drain)
    const r = await scenario(M, WORKERS, zk, owner, funder);
    const feltP50 = ACTION_FLOOR_MS + r.stallP50, feltP95 = ACTION_FLOOR_MS + r.stallP95;
    rows.push({ ...r, feltP50, feltP95 });
    console.log(`[stress] ${r.players} online (${M} tables): dealer-stall p50=${r.stallP50}ms p95=${r.stallP95}ms p99=${r.stallP99}ms → FELT p50≈${(feltP50/1000).toFixed(1)}s p95≈${(feltP95/1000).toFixed(1)}s  (${r.hands} hands)`);
  }

  console.log(`\n[stress] ===== VERDICT (felt = ${ACTION_FLOOR_MS}ms chain floor + dealer stall) =====`);
  const playable = rows.filter((r) => r.feltP95 <= 5000);
  const pleasant = rows.filter((r) => r.feltP95 <= 1000);
  console.log(`[stress] per-action FLOOR alone = ${(ACTION_FLOOR_MS/1000).toFixed(1)}s → already > 1s "unpleasant" bar at ANY online (chain-bound, not our code)`);
  const maxPlayable = playable.length ? Math.max(...playable.map((r) => r.players)) : 0;
  console.log(`[stress] max online with p95 felt ≤ 5s (playable): ${maxPlayable >= Math.max(...SWEEP)*2 ? "≥" : ""}${maxPlayable} players @ W=${WORKERS}`);
  console.log(`[stress] "pleasant" (≤1s): ${pleasant.length ? pleasant.map(r=>r.players).join("/") : "NONE — the 1.7s chain floor forbids it regardless of scaling"}`);
  console.log(`[stress] to push the playable ceiling higher: add workers (throughput scales ~linearly, see _zk-load-test) — but the ~1.7s per-action floor is immovable without a faster chain / stronger optimistic UI`);
  process.exit(0);
}
main().catch((e) => { console.error("[stress] FATAL", e); process.exit(1); });
