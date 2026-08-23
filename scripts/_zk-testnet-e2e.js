// Live zkShuffle v2 E2E on Somnia testnet: plays a full heads-up hand against
// the REAL deployed contracts — keys → shuffle + Wikström proof → hole-shares →
// prepareDeal(+proofHash) → startHand → board reveals → hole reveals →
// resolveShowdown — with real STT gas and real block latency. The coordinator is
// worker-0; two script players are funded from the deployer. Proves the on-chain
// transaction path the hardhat tests exercise in-memory actually works on Somnia.
//
// Run:  node scripts/_zk-testnet-e2e.js
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("node:crypto");
const { ethers } = require("ethers");
const zkDrv = require("./lib/poker-zk-dealer");

const FOLD = 0, CHECK = 1, CALL = 2;
const loadAbi = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", "poker", `${name}.sol`, `${name}.json`), "utf8")).abi;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In-process "browser": local crypto, posts to the shared zkState via the driver
// functions (the HTTP relay is validated separately in test/ZkHttpE2E.test.js).
class SimClient {
  constructor(zk, addr) { this.zk = zk; this.addr = addr.toLowerCase(); this.byDeal = new Map(); this.holes = null; }
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
    if (task.myHoles && !this.holes) {
      const sec = this.byDeal.get(dealId);
      const pubkeys = (task.pubkeys || []).map(zkDrv.parsePt);
      this.holes = Object.entries(task.myHoles).map(([idx, h]) => {
        const ct = zkDrv.parseCt(h.ct);
        const others = h.shares.filter(Boolean).map((s) => {
          const d = zkDrv.parsePt(s.d);
          const share = { d, proof: { R1: zkDrv.parsePt(s.proof.R1), R2: zkDrv.parsePt(s.proof.R2), s: BigInt(s.proof.s) } };
          if (!zk.verifyShare(ct, pubkeys[s.i], share, `SPZK:${dealId}:share:${idx}:${s.i}`)) throw new Error("relayed share bad");
          return d;
        });
        return zk.pointToCard(zk.decryptWithShares(ct, others, sec.x), zk.deckPoints());
      });
    }
  }
}

async function main() {
  const zk = await import("../frontend/poker/zk-bn254.js");
  const { bn254 } = await import("@noble/curves/bn254");
  zk.init({ bn254, keccak256: ethers.keccak256, randomBytes: (n) => crypto.randomBytes(n) });
  zkDrv.init({ zkModule: zk, bn254 });

  const p = new ethers.JsonRpcProvider(process.env.RPC_TESTNET || "https://api.infra.testnet.somnia.network");
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "poker-somniaTestnet.json"), "utf8"));
  const master = process.env.POKER_SEED_MASTER_KEY || process.env.SEED_MASTER_KEY;
  const deployer = new ethers.Wallet(process.env.POKER_DEPLOYER_KEY, p);
  const worker = new ethers.Wallet(ethers.keccak256(ethers.solidityPacked(["bytes32", "string"], [master, "zk-worker-0"])), p);

  const room = new ethers.Contract(m.addresses.pokerRoom, loadAbi("PokerRoom"), worker);
  const zkd = new ethers.Contract(m.addresses.zkTableDealer, loadAbi("ZkTableDealer"), worker);
  const rakeBefore = await room.rakeCollected();

  // two reproducible players, funded from the deployer
  const players = [0, 1].map((i) => new ethers.Wallet(ethers.keccak256(ethers.solidityPacked(["bytes32", "string"], [master, `zk-e2e-player-${i}`])), p));
  console.log(`[e2e] deployer=${deployer.address} worker=${worker.address}`);
  console.log(`[e2e] players: ${players.map((w) => w.address).join(", ")}`);

  const TABLE = 3; // the heads-up 0.01/0.02 table (maxSeats 2)
  const cfg = await room.getTable(TABLE);
  const buyIn = cfg.minBuyIn; // 0.4 STT
  for (const pl of players) {
    const need = buyIn + ethers.parseEther("0.15"); // buy-in + gas headroom
    const have = await p.getBalance(pl.address);
    if (have < need) {
      const tx = await deployer.sendTransaction({ to: pl.address, value: need - have });
      await tx.wait();
      console.log(`[e2e] funded ${pl.address.slice(0, 10)} with ${ethers.formatEther(need - have)} STT`);
    }
  }

  // seat both players (deposit → sitDown), skipping if already seated
  for (let i = 0; i < 2; i++) {
    const pl = players[i];
    const seatNow = Number(await room.seatOf(TABLE, pl.address));
    if (seatNow !== 255) { console.log(`[e2e] ${pl.address.slice(0, 10)} already at seat ${seatNow}`); continue; }
    const roomAsP = room.connect(pl);
    await (await roomAsP.deposit({ value: buyIn })).wait();
    await (await roomAsP.sitDown(TABLE, i, buyIn)).wait();
    console.log(`[e2e] seated ${pl.address.slice(0, 10)} at seat ${i} (buy-in ${ethers.formatEther(buyIn)})`);
  }

  const stack0 = (await room.getSeat(TABLE, 0)).stack, stack1 = (await room.getSeat(TABLE, 1)).stack;
  console.log(`[e2e] pre-hand stacks: seat0=${ethers.formatEther(stack0)} seat1=${ethers.formatEther(stack1)}`);

  const state = zkDrv.newZkState();
  const clients = [new SimClient(zk, players[0].address), new SimClient(zk, players[1].address)];
  const runTx = (fn) => fn().then((r) => r.wait());
  let lastTag = "", settled = false;

  // drive: tick the coordinator, let clients act locally, run the betting down
  for (let i = 0; i < 120 && !settled; i++) {
    let tag;
    try {
      tag = await zkDrv.tickZkTable(room, zkd, state, TABLE, { tx: runTx, persistDir: null });
    } catch (e) { tag = "tick-err:" + (e.shortMessage || e.message || "").slice(0, 60); }
    if (tag !== lastTag) { console.log(`[e2e] tick → ${tag}`); lastTag = tag; }
    for (const c of clients) { try { c.step(zk, state, TABLE); } catch (e) { console.log("[e2e] client:", e.message); } }

    // check the hand down to showdown (both players just check/call)
    try {
      const h = await room.getHand(TABLE);
      if (h.inProgress && Number(h.street) <= 3) {
        const seat = Number(h.actingSeat);
        const actor = players[seat];
        const sh = await room.getSeatHand(TABLE, seat);
        const toCall = h.currentBet > sh.committedStreet;
        await (await room.connect(actor).act(TABLE, toCall ? CALL : CHECK, 0)).wait();
        console.log(`[e2e]   seat${seat} ${toCall ? "CALL" : "CHECK"}`);
      }
    } catch (_) {}

    if (tag === "settled" || tag === "hand-ended") settled = true;
    await sleep(400);
  }

  // results
  const s0 = (await room.getSeat(TABLE, 0)).stack, s1 = (await room.getSeat(TABLE, 1)).stack;
  const h = await room.getHand(TABLE);
  const rake = (await room.rakeCollected()) - rakeBefore; // house's 10% cut of the pot
  console.log("\n[e2e] ===== RESULT =====");
  console.log(`[e2e] hand inProgress: ${h.inProgress}`);
  console.log(`[e2e] seat0 cards (local decrypt): ${clients[0].holes} | seat1: ${clients[1].holes}`);
  console.log(`[e2e] post-hand stacks: seat0=${ethers.formatEther(s0)} seat1=${ethers.formatEther(s1)}  rake=${ethers.formatEther(rake)}`);
  // conservation must include the rake the house collected from the pot
  console.log(`[e2e] players+rake: ${ethers.formatEther(s0 + s1 + rake)} (was ${ethers.formatEther(stack0 + stack1)})`);
  const ok = !h.inProgress && clients[0].holes && clients[1].holes && (s0 + s1 + rake === stack0 + stack1);
  console.log(`[e2e] ${ok ? "✅ LIVE HAND SETTLED CORRECTLY ON SOMNIA (chips conserved incl. rake)" : "❌ something off — inspect above"}`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("[e2e] FATAL", e); process.exit(1); });
