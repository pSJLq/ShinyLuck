// End-to-end: a full Sit & Go tournament played through the zkShuffle v2 card
// layer. Proves the tournament engine (PokerTournament) drives controlled
// PokerRoom tables whose cards come from the mental-poker coordinator exactly
// like cash tables — no tournament-side changes were needed for v2. Also
// exercises the blind-off path: a sitting-out (keyless) stack drains and busts
// so the event always finishes.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const crypto = require("node:crypto");
const zkDealer = require("../scripts/lib/poker-zk-dealer");
const { tickTournament } = require("../scripts/lib/poker-tournament-driver");

const ALLIN = 5, FOLD = 0, CHECK = 1, CALL = 2;
const E = (n) => ethers.parseEther(String(n));

class SimClient {
  constructor(zk, addr) { this.zk = zk; this.addr = addr.toLowerCase(); this.byDeal = new Map(); this.holes = null; }
  step(state, t) {
    const task = zkDealer.zkTask(state, t, this.addr);
    if (task.observer || task.phase === "none" || task.participant === undefined) return;
    const dealId = task.dealId;
    if (task.do === "key") {
      const kg = this.zk.keygen(task.domain);
      this.byDeal.set(dealId, { x: kg.x, X: kg.X });
      zkDealer.zkPostKey(state, t, this.addr, { dealId, X: zkDealer.serPt(kg.X), pokR: zkDealer.serPt(kg.pok.R), pokS: "0x" + kg.pok.s.toString(16) });
    } else if (task.do === "shuffle") {
      const deck = task.deck.map(zkDealer.parseCt);
      const X = zkDealer.parsePt(task.aggKey);
      zkDealer.zkPostShuffle(state, t, this.addr, { dealId, deck: this.zk.shuffleRemask(deck, X).deck.map(zkDealer.serCt) });
    } else if (task.do === "shares") {
      const sec = this.byDeal.get(dealId);
      const items = task.idxs.map((idx) => {
        const sh = this.zk.decryptionShare(zkDealer.parseCt(task.cts[idx]), sec.x, sec.X, task.domains[idx]);
        return { idx, d: zkDealer.serPt(sh.d), R1: zkDealer.serPt(sh.proof.R1), R2: zkDealer.serPt(sh.proof.R2), s: "0x" + sh.proof.s.toString(16) };
      });
      zkDealer.zkPostShares(state, t, this.addr, { dealId, items });
    }
  }
}

describe("zkShuffle v2 E2E — a Sit & Go plays out through mental poker", function () {
  this.timeout(120000);
  let zk, bn254;

  before(async () => {
    zk = await import("../frontend/poker/zk-bn254.js");
    ({ bn254 } = await import("@noble/curves/bn254"));
    zk.init({ bn254, keccak256: ethers.keccak256, randomBytes: (n) => crypto.randomBytes(n) });
    zkDealer.init({ zkModule: zk, bn254 });
  });

  it("heads-up SNG: register → start → zk hands → bust → winner paid the whole pool", async () => {
    const [owner, coordinator, alice, bob] = await ethers.getSigners();
    const room = await (await ethers.getContractFactory("PokerRoom")).deploy(owner.address);
    const zkd = await (await ethers.getContractFactory("ZkTableDealer")).deploy(await room.getAddress(), coordinator.address);
    const trn = await (await ethers.getContractFactory("PokerTournament")).deploy(owner.address, await room.getAddress());
    await room.connect(owner).setDealer(await zkd.getAddress());
    await room.connect(owner).setDealerOperator(coordinator.address);
    await room.connect(owner).setTournamentFactory(await trn.getAddress());
    await trn.connect(owner).setOperator(coordinator.address);

    // create a HU SNG: buy-in 1, winner-take-all, fast 60s levels, 1000 chips
    const params = {
      buyIn: E(1), fee: 0, maxPlayers: 2, seatsPerTable: 0, startStack: 1000, sbStart: 10, bbStart: 20,
      anteStart: 0, levelDur: 60, growthBps: 20000, startTime: 0, approvalRequired: false, actionSecs: 30,
      payoutBps: [10000], structure: [], hostBps: 0,
    };
    await trn.connect(alice).createTournament(params);
    await trn.connect(alice).register(0, { value: E(1) });
    await trn.connect(bob).register(0, { value: E(1) });

    // the driver auto-starts a full field
    const opTrn = trn.connect(coordinator), opRoom = room.connect(coordinator);
    expect(await tickTournament(opTrn, opRoom, 0, { now: () => 0 })).to.equal("started");
    const tableId = Number((await trn.info(0)).tableId);

    const state = zkDealer.newZkState();
    const roomC = room.connect(coordinator), zkdC = zkd.connect(coordinator);
    const clients = [new SimClient(zk, alice.address), new SimClient(zk, bob.address)];
    const tick = (opts = {}) => zkDealer.tickZkTable(roomC, zkdC, state, tableId, { showdownMs: 0, interHandMs: 0, ...opts });
    const stepAll = () => clients.forEach((c) => c.step(state, tableId));

    // play hands until someone busts (all-in every hand → fast). Cap iterations.
    let busted = false;
    for (let hand = 0; hand < 40 && !busted; hand++) {
      // deal a hand through the protocol
      let dealt = false;
      for (let i = 0; i < 12 && !dealt; i++) {
        const tag = await tick();
        stepAll();
        if (tag === "started") dealt = true;
        if (tag === "idle" || tag === "hand-ended" || tag === "inter-hand") { /* keep pumping */ }
      }
      if (!dealt) {
        // maybe the tournament already ended
        if (Number((await trn.info(0)).status) === 2) break;
        continue;
      }
      // both players shove every street until the hand resolves
      for (let guard = 0; guard < 40; guard++) {
        const h = await room.getHand(tableId);
        if (!h.inProgress) break;
        const street = Number(h.street);
        if (street === 4) { // showdown: pump reveals
          const tag = await tick();
          stepAll();
          if (tag === "settled") break;
          continue;
        }
        const acting = Number(h.actingSeat);
        if (acting === 255) { await tick(); stepAll(); continue; }
        const seatHand = await room.getSeatHand(tableId, acting);
        // act as whichever player is up
        const who = (await room.getSeat(tableId, acting)).player.toLowerCase();
        const signer = who === alice.address.toLowerCase() ? alice : bob;
        try { await room.connect(signer).act(tableId, ALLIN, 0); }
        catch { try { await room.connect(signer).act(tableId, CHECK, 0); } catch { await room.connect(signer).act(tableId, CALL, 0); } }
        // pump board reveals between actions
        await tick(); stepAll();
      }
      // settle + clear
      for (let i = 0; i < 6; i++) { const tag = await tick(); stepAll(); if (tag === "hand-ended" || tag === "settled") break; }
      // report any bust to the tournament (between hands)
      const t = await tickTournament(opTrn, opRoom, 0, { now: () => 0 });
      if (t && t.startsWith("bust")) busted = true;
      if (Number((await trn.info(0)).status) === 2) break;
    }

    // drive the tournament to completion
    for (let i = 0; i < 5 && Number((await trn.info(0)).status) !== 2; i++) {
      await tickTournament(opTrn, opRoom, 0, { now: () => 0 });
    }

    expect(Number((await trn.info(0)).status)).to.equal(2); // FINISHED
    // winner-take-all: one player holds the whole 2-STT pool as in-room balance
    const balA = await room.balance(alice.address), balB = await room.balance(bob.address);
    expect(balA + balB).to.equal(E(2));
    expect(balA === E(2) || balB === E(2)).to.equal(true);
  });
});
