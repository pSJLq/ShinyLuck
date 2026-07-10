// Multi-worker throughput load test for the zkShuffle v2 dealer.
// Run:  npx hardhat run scripts/_zk-load-test.js
//
// What it proves: the reason the coordinator runs N worker keys (each a room
// operator + dealer coordinator with its OWN serial nonce queue, tables sharded
// t%N) is to beat the single-key ~10-hot-table ceiling. This harness runs the
// REAL tickZkTable loop over M concurrent tables on the hardhat network, but
// wraps each worker's runTx with a modeled BLOCK_MS confirmation latency (the
// hardhat node mines instantly, so without this there is no queue backpressure
// to measure). It then compares W=1 vs W=3: hands completed, per-worker tx
// distribution, max per-table dealer-loop age, and nonce-collision count.
//
// The client-side Wikstrom shuffle proof is STUBBED here (proveShuffle/
// verifyShuffle) — that crypto runs in each player's browser IN PARALLEL in
// production (300 browsers, one ~1s proof each), so counting it once-per-deal on
// the single test CPU would measure the harness, not the bot's tx dispatch.
// Shuffle-proof correctness is covered by test/ZkShuffleProof.test.js and the
// live E2E. On-chain reveals still carry REAL decryption shares (cheap, and
// verified on-chain), so the tx path exercised here is the true production one.

const hre = require("hardhat");
const { ethers } = hre;
const crypto = require("node:crypto");
const zkDrv = require("./lib/poker-zk-dealer");

const FOLD = 0, CHECK = 1, CALL = 2;
const E = (n) => ethers.parseEther(String(n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TABLES = Number(process.env.LT_TABLES || 8);
const DURATION_MS = Number(process.env.LT_DURATION || 25000);
const BLOCK_MS = Number(process.env.LT_BLOCK_MS || 250); // modeled per-tx confirmation latency
const LOOP_MS = Number(process.env.LT_LOOP_MS || 40); // per-table loop cadence
const INTERHAND_MS = Number(process.env.LT_INTERHAND || 300); // between-hands pause
const WSET = (process.env.LT_WORKERS || "1,3").split(",").map(Number);

class SimClient {
  constructor(zk, addr) { this.zk = zk; this.addr = addr.toLowerCase(); this.byDeal = new Map(); this.holes = new Map(); }
  step(zk, state, t) {
    const task = zkDrv.zkTask(state, t, this.addr);
    if (task.observer || task.phase === "none" || task.participant === undefined) return;
    const dealId = task.dealId;
    if (task.do === "key") {
      const kg = zk.keygen(task.domain);
      this.byDeal.set(dealId, { x: kg.x, X: kg.X });
      zkDrv.zkPostKey(state, t, this.addr, { dealId, X: zkDrv.serPt(kg.X), pokR: zkDrv.serPt(kg.pok.R), pokS: "0x" + kg.pok.s.toString(16) });
    } else if (task.do === "shuffle") {
      const deck = task.deck.map(zkDrv.parseCt);
      const X = zkDrv.parsePt(task.aggKey);
      const out = zk.shuffleRemask(deck, X);
      zkDrv.zkPostShuffle(state, t, this.addr, { dealId, deck: out.deck.map(zkDrv.serCt) });
      // stubbed proof (see header) — proveShuffle/verifyShuffle are no-ops here
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

async function deployStack(owner) {
  const Room = await ethers.getContractFactory("PokerRoom", owner);
  const room = await Room.deploy(owner.address);
  const Zkd = await ethers.getContractFactory("ZkTableDealer", owner);
  const zkd = await Zkd.deploy(await room.getAddress(), owner.address);
  await room.setDealer(await zkd.getAddress());
  return { room, zkd };
}

async function runScenario(W, zk, owner, funder) {
  const { room, zkd } = await deployStack(owner);
  // W workers: fresh funded wallets, each a room operator + dealer coordinator
  const workers = [];
  for (let i = 0; i < W; i++) {
    const w = ethers.Wallet.createRandom().connect(ethers.provider);
    await funder.sendTransaction({ to: w.address, value: E(20) }); // gas only
    await room.setOperator(w.address, true);
    await zkd.setCoordinator(w.address, true);
    // runTx: serial nonce queue + MODELED confirmation latency
    let chain = Promise.resolve();
    let txCount = 0, nonceErrs = 0;
    const runTx = (fn) => {
      const done = chain.then(async () => {
        try { const r = await fn(); await sleep(BLOCK_MS); txCount++; return await r.wait(); }
        catch (e) { if (/nonce|replacement|already known/i.test(e.message || "")) nonceErrs++; throw e; }
      });
      chain = done.then(() => {}, () => {});
      return done;
    };
    workers.push({
      wallet: w, runTx, stats: () => ({ txCount, nonceErrs }),
      room: room.connect(w), zkd: zkd.connect(w),
    });
  }

  // M tables, 2 players each, funded + seated
  const cfg = { maxSeats: 2, smallBlind: E(1), bigBlind: E(2), ante: 0, minBuyIn: E(40), maxBuyIn: E(200), rakeBps: 0, rakeCap: 0, actionTimeout: 300, active: true };
  const clients = [];
  for (let t = 0; t < TABLES; t++) {
    await room.createTable(cfg);
    const tClients = [];
    for (let s = 0; s < 2; s++) {
      const pl = ethers.Wallet.createRandom().connect(ethers.provider);
      await funder.sendTransaction({ to: pl.address, value: E(120) }); // 100 buy-in + gas
      await room.connect(pl).deposit({ value: E(100) });
      await room.connect(pl).sitDown(t, s, E(100));
      tClients.push({ wallet: pl, sim: new SimClient(zk, pl.address) });
    }
    clients.push(tClients);
  }

  const state = zkDrv.newZkState();
  const lastAdvance = new Array(TABLES).fill(Date.now());
  let maxLoopAge = 0;
  const t0 = Date.now();

  // concurrent dealer loop: each table advanced by its sharded worker; tables
  // run in parallel (a slow table never blocks another — the prod model)
  async function driveTable(t) {
    const worker = workers[t % W];
    while (Date.now() - t0 < DURATION_MS) {
      try {
        const tag = await zkDrv.tickZkTable(worker.room, worker.zkd, state, t, { tx: worker.runTx, persistDir: null, interHandMs: INTERHAND_MS });
        if (tag !== "wait" && tag !== "inter-hand" && !String(tag).endsWith("-wait")) lastAdvance[t] = Date.now();
      } catch (_) {}
      for (const c of clients[t]) { try { c.sim.step(zk, state, t); } catch (_) {} }
      // bet the hand down (both check/call to showdown)
      try {
        const h = await worker.room.getHand(t);
        if (h.inProgress && Number(h.street) <= 3) {
          const seat = Number(h.actingSeat);
          const sh = await worker.room.getSeatHand(t, seat);
          const toCall = h.currentBet > sh.committedStreet;
          const actor = clients[t][seat].wallet;
          await room.connect(actor).act(t, toCall ? CALL : CHECK, 0).then((x) => x.wait());
        }
      } catch (_) {}
      const age = Date.now() - lastAdvance[t];
      if (age > maxLoopAge) maxLoopAge = age;
      await sleep(LOOP_MS);
    }
  }
  await Promise.all(Array.from({ length: TABLES }, (_, t) => driveTable(t)));

  let hands = 0n;
  for (let t = 0; t < TABLES; t++) hands += await room.handCounter(t);
  const perWorker = workers.map((w) => w.stats());
  return {
    W, hands: Number(hands), txTotal: perWorker.reduce((a, s) => a + s.txCount, 0),
    perWorker: perWorker.map((s) => s.txCount), nonceErrs: perWorker.reduce((a, s) => a + s.nonceErrs, 0),
    maxLoopAgeMs: maxLoopAge, elapsedS: (Date.now() - t0) / 1000,
  };
}

// Pure tx-dispatch scaling: the real integration run above serializes client
// crypto on one CPU (parallel across 300 browsers in prod), which masks the
// worker scaling. This isolates JUST the coordinator's job — draining M tables'
// worth of on-chain txns through W sharded, latency-modeled nonce queues — with
// zero crypto. It answers the architectural question the worker design makes:
// do independent nonce queues turn the single-key serial ceiling into N×?
async function dispatchBenchmark(funder) {
  const TXS_PER_HAND = 11; // prepareDeal, startHand, 5 board, 2 hole, markReady, resolveShowdown
  const HANDS = 6;
  console.log(`\n[load] ===== pure tx-dispatch scaling (${TABLES} tables × ${HANDS} hands × ${TXS_PER_HAND} tx, modeled ${BLOCK_MS}ms/tx) =====`);
  const rows = [];
  for (const W of [1, 3, 6]) {
    const workers = [];
    for (let i = 0; i < W; i++) {
      const w = ethers.Wallet.createRandom().connect(ethers.provider);
      await funder.sendTransaction({ to: w.address, value: E(50) });
      let chain = Promise.resolve(); let n = 0, errs = 0;
      const runTx = (fn) => { const d = chain.then(async () => { try { const r = await fn(); await sleep(BLOCK_MS); n++; return r.wait(); } catch (e) { if (/nonce|replacement/i.test(e.message)) errs++; throw e; } }); chain = d.then(() => {}, () => {}); return d; };
      workers.push({ w, runTx, stat: () => ({ n, errs }) });
    }
    const t0 = Date.now();
    // every table fires its whole hand-tx stream concurrently; each worker's
    // serial queue drains its shard (a real nonce-consuming self-transfer/tx)
    await Promise.all(Array.from({ length: TABLES }, async (_, t) => {
      const wk = workers[t % W];
      for (let hand = 0; hand < HANDS; hand++) {
        for (let x = 0; x < TXS_PER_HAND; x++) {
          await wk.runTx(() => wk.w.sendTransaction({ to: wk.w.address, value: 0 })).catch(() => {});
        }
      }
    }));
    const secs = (Date.now() - t0) / 1000;
    const totalTx = TABLES * HANDS * TXS_PER_HAND;
    const errs = workers.reduce((a, w) => a + w.stat().errs, 0);
    rows.push({ W, secs, tps: totalTx / secs, errs, dist: workers.map((w) => w.stat().n) });
    console.log(`[load] W=${W}: ${totalTx} tx in ${secs.toFixed(1)}s = ${(totalTx / secs).toFixed(1)} tx/s, perWorker=[${workers.map((w) => w.stat().n)}], nonceErrs=${errs}`);
  }
  const base = rows[0];
  console.log("[load] scaling vs 1 worker:");
  for (const r of rows) console.log(`[load]   W=${r.W}: ${(base.secs / r.secs).toFixed(2)}× faster  (${r.tps.toFixed(1)} tx/s)`);
  return rows;
}

async function main() {
  const mod = await import("../frontend/poker/zk-bn254.js");
  const { bn254 } = await import("@noble/curves/bn254");
  mod.init({ bn254, keccak256: ethers.keccak256, randomBytes: (n) => crypto.randomBytes(n) });
  // ESM namespaces are frozen, so wrap in a MUTABLE copy and STUB the shuffle
  // proof there (tx-throughput isolation — see header). Everything else (keygen,
  // shuffleRemask, decryptionShare, verifyShare) keeps its real implementation.
  const zk = Object.assign({}, mod);
  zk.proveShuffle = () => ({ stub: true });
  zk.verifyShuffle = () => true;
  zk.shuffleProofToWire = () => ({ stub: true });
  zk.shuffleProofFromWire = () => ({ stub: true });
  zk.shuffleTranscriptHash = () => ethers.ZeroHash;
  zkDrv.init({ zkModule: zk, bn254 });

  const [owner, funder] = await ethers.getSigners();
  console.log(`[load] ${TABLES} tables, ${DURATION_MS / 1000}s, modeled block=${BLOCK_MS}ms, workers=${WSET.join("/")}`);
  const results = [];
  for (const W of WSET) {
    console.log(`\n[load] --- scenario: ${W} worker(s) ---`);
    const r = await runScenario(W, zk, owner, funder);
    results.push(r);
    console.log(`[load] W=${W}: hands=${r.hands} tx=${r.txTotal} (${(r.txTotal / r.elapsedS).toFixed(1)} tx/s) perWorker=[${r.perWorker}] nonceErrs=${r.nonceErrs} maxLoopAge=${r.maxLoopAgeMs}ms`);
  }

  console.log(`\n[load] ===== SUMMARY (${TABLES} tables, modeled ${BLOCK_MS}ms/tx) =====`);
  const base = results[0];
  for (const r of results) {
    const speedup = (r.hands / Math.max(1, base.hands)).toFixed(2);
    console.log(`[load] W=${r.W}: ${r.hands} hands, ${r.txTotal} tx, maxLoopAge=${r.maxLoopAgeMs}ms, nonceErrs=${r.nonceErrs}  ${r.W === base.W ? "(baseline)" : `→ ${speedup}× the 1-worker hands`}`);
  }
  const multi = results.find((r) => r.W > 1);
  const integrationOk = multi && multi.nonceErrs === 0 && multi.txTotal > base.txTotal;
  console.log(`[load] integration: ${integrationOk ? "✅ real tickZkTable path — concurrent, zero nonce collisions, more workers → more tx" : "⚠️ inspect"}`);
  console.log("[load] (hands are gated by client crypto, serialized on ONE test CPU here but PARALLEL across browsers in prod — see the isolated dispatch scaling below)");

  const disp = await dispatchBenchmark(funder);
  const dispBase = disp[0], disp6 = disp.find((r) => r.W === 6);
  const dispOk = disp.every((r) => r.errs === 0) && disp6 && (dispBase.secs / disp6.secs) > 3;
  console.log(`[load] dispatch: ${dispOk ? "✅ sharded nonce queues scale ~linearly with workers (single-key ceiling broken)" : "⚠️ inspect"}`);

  const ok = integrationOk && dispOk;
  console.log(`\n[load] ${ok ? "✅✅ LOAD TEST PASSED — multi-worker architecture validated" : "⚠️ inspect results above"}`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("[load] FATAL", e); process.exit(1); });
