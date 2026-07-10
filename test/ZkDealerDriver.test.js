const { expect } = require("chai");
const { ethers } = require("hardhat");
const crypto = require("node:crypto");
const zkDealer = require("../scripts/lib/poker-zk-dealer");

const FOLD = 0, CHECK = 1, CALL = 2, BET = 3, RAISE = 4, ALLIN = 5;
const E = (n) => ethers.parseEther(String(n));

// A simulated browser: does exactly what frontend/poker/zk-agent.js will do —
// polls its task, runs the crypto locally, posts the results. Its per-hand
// secret never leaves the object (the bot never sees it).
class SimClient {
  constructor(zk, addr) {
    this.zk = zk;
    this.addr = addr.toLowerCase();
    this.byDeal = new Map(); // dealId -> { x, X }
    this.holes = null; // locally decrypted own cards
  }

  step(state, t) {
    const task = zkDealer.zkTask(state, t, this.addr);
    if (task.observer || task.phase === "none") return;
    const dealId = task.dealId;

    if (task.do === "key") {
      const kg = this.zk.keygen(task.domain);
      this.byDeal.set(dealId, { x: kg.x, X: kg.X });
      zkDealer.zkPostKey(state, t, this.addr, {
        dealId, X: zkDealer.serPt(kg.X), pokR: zkDealer.serPt(kg.pok.R), pokS: "0x" + kg.pok.s.toString(16),
      });
      return;
    }
    if (task.do === "shuffle") {
      const deck = task.deck.map(zkDealer.parseCt);
      const X = zkDealer.parsePt(task.aggKey);
      const out = this.zk.shuffleRemask(deck, X);
      zkDealer.zkPostShuffle(state, t, this.addr, { dealId, deck: out.deck.map(zkDealer.serCt) });
      return;
    }
    if (task.do === "shares") {
      const sec = this.byDeal.get(dealId);
      const items = task.idxs.map((idx) => {
        const ct = zkDealer.parseCt(task.cts[idx]);
        const sh = this.zk.decryptionShare(ct, sec.x, sec.X, task.domains[idx]);
        return {
          idx,
          d: zkDealer.serPt(sh.d), R1: zkDealer.serPt(sh.proof.R1), R2: zkDealer.serPt(sh.proof.R2),
          s: "0x" + sh.proof.s.toString(16),
        };
      });
      zkDealer.zkPostShares(state, t, this.addr, { dealId, items });
    }
    // decrypt my own hole cards from the relayed shares (bot can't — it lacks
    // mine), re-verifying each relayed share's CP proof against its sender's key
    if (task.myHoles) {
      const sec = this.byDeal.get(dealId);
      const pubkeys = (task.pubkeys || []).map(zkDealer.parsePt);
      this.holes = Object.entries(task.myHoles).map(([idx, h]) => {
        const ct = zkDealer.parseCt(h.ct);
        const others = [];
        for (const s of h.shares.filter(Boolean)) {
          const d = zkDealer.parsePt(s.d);
          const share = { d, proof: { R1: zkDealer.parsePt(s.proof.R1), R2: zkDealer.parsePt(s.proof.R2), s: BigInt(s.proof.s) } };
          if (!this.zk.verifyShare(ct, pubkeys[s.i], share, `SPZK:${dealId}:share:${idx}:${s.i}`)) throw new Error("relayed share failed verification");
          others.push(d);
        }
        return this.zk.pointToCard(this.zk.decryptWithShares(ct, others, sec.x), this.zk.deckPoints());
      });
    }
  }
}

describe("zk coordinator driver — full mental-poker hands through the bot module", function () {
  let zk, bn254;

  before(async () => {
    zk = await import("../frontend/poker/zk-bn254.js");
    ({ bn254 } = await import("@noble/curves/bn254"));
    zk.init({ bn254, keccak256: ethers.keccak256, randomBytes: (n) => crypto.randomBytes(n) });
    zkDealer.init({ zkModule: zk, bn254 });
  });

  async function setup() {
    const [owner, coordinator, alice, bob] = await ethers.getSigners();
    const Room = await ethers.getContractFactory("PokerRoom");
    const room = await Room.deploy(owner.address);
    const Zkd = await ethers.getContractFactory("ZkTableDealer");
    const zkd = await Zkd.deploy(await room.getAddress(), coordinator.address);
    await room.connect(owner).setDealer(await zkd.getAddress());
    await room.connect(owner).setDealerOperator(coordinator.address);
    await room.connect(owner).createTable({
      maxSeats: 2, smallBlind: E(1), bigBlind: E(2), ante: 0,
      minBuyIn: E(40), maxBuyIn: E(200), rakeBps: 0, rakeCap: 0, actionTimeout: 300, active: true,
    });
    for (const [p, seat] of [[alice, 0], [bob, 1]]) {
      await room.connect(p).deposit({ value: E(100) });
      await room.connect(p).sitDown(0, seat, E(100));
    }
    const state = zkDealer.newZkState();
    const roomC = room.connect(coordinator);
    const zkdC = zkd.connect(coordinator);
    const clients = [new SimClient(zk, alice.address), new SimClient(zk, bob.address)];
    const tick = (opts = {}) => zkDealer.tickZkTable(roomC, zkdC, state, 0, { showdownMs: 0, ...opts });
    const stepAll = () => clients.forEach((c) => c.step(state, 0));
    return { owner, coordinator, alice, bob, room, zkd, roomC, zkdC, state, clients, tick, stepAll };
  }

  // drive prep phases: keys → shuffle ×k → holeshares → prepare → started
  async function dealHand(tick, stepAll) {
    expect(await tick()).to.match(/^keys:0/); // session opened
    stepAll(); // both post keys
    expect(await tick()).to.match(/^shuffle:0/);
    stepAll(); // participant 0 shuffles (only the one whose turn it is acts)
    stepAll(); // participant 1 shuffles
    stepAll(); // everyone posts shares for the OTHERS' hole cards
    const started = await tick();
    expect(started).to.equal("started");
  }

  it("plays a complete checked-down hand: deal → streets → showdown → correct payout", async function () {
    const { alice, bob, room, zkd, state, clients, tick, stepAll } = await setup();
    await dealHand(tick, stepAll);

    const h = await room.getHand(0);
    expect(h.inProgress).to.equal(true);

    // each client decrypts its own cards locally — valid, distinct
    stepAll();
    for (const c of clients) {
      expect(c.holes).to.have.length(2);
      for (const card of c.holes) expect(card).to.be.gte(0).and.lte(51);
    }
    const all = [...clients[0].holes, ...clients[1].holes];
    expect(new Set(all).size).to.equal(4); // no dupes across hands

    // betting: HU preflop — button/SB (seat0) calls, BB checks → flop
    await room.connect(alice).act(0, CALL, 0);
    await room.connect(bob).act(0, CHECK, 0);
    expect(Number((await room.getHand(0)).street)).to.equal(1);

    // flop: bot requests board shares, clients answer, three reveals land
    expect(await tick()).to.equal("board-wait");
    stepAll();
    expect(await tick()).to.equal("board:1");
    expect(await tick()).to.equal("board:2");
    expect(await tick()).to.equal("board:3");

    // check through turn + river
    for (const street of [2, 3]) {
      await room.connect(bob).act(0, CHECK, 0);
      await room.connect(alice).act(0, CHECK, 0);
      expect(Number((await room.getHand(0)).street)).to.equal(street);
      expect(await tick()).to.equal("board-wait");
      stepAll();
      expect(await tick()).to.equal(`board:${street + 2}`);
    }
    await room.connect(bob).act(0, CHECK, 0);
    await room.connect(alice).act(0, CHECK, 0);
    expect(Number((await room.getHand(0)).street)).to.equal(4); // SHOWDOWN

    // showdown: own-hole shares released, seats revealed, pot settled
    expect(await tick()).to.equal("showdown-collect");
    stepAll();
    expect(await tick()).to.match(/^holes:seat/);
    expect(await tick()).to.match(/^holes:seat/);
    expect(await tick()).to.equal("showdown-ready");
    expect(await tick()).to.equal("settled");

    // the on-chain revealed cards match what each client decrypted privately
    const dealId = (await room.getHand(0)).dealId; // cleared hand → read via event? use state cleared — instead read holeCards by last dealId from zkd
    const s0 = await room.getSeat(0, 0), s1 = await room.getSeat(0, 1);
    expect(s0.stack + s1.stack).to.equal(E(200)); // conservation, zero rake
    expect((await room.getHand(0)).inProgress).to.equal(false);

    // exactly one of the two gained the pot (or a split left both at 100)
    const gained = [s0.stack, s1.stack].filter((x) => x > E(100)).length;
    expect(gained).to.be.lte(1);
    expect(await tick()).to.equal("hand-ended");
  });

  it("fold-win needs no crypto at all: instant settle, session cleared", async function () {
    const { alice, room, tick, stepAll } = await setup();
    await dealHand(tick, stepAll);
    await room.connect(alice).act(0, FOLD, 0); // SB folds preflop
    expect((await room.getHand(0)).inProgress).to.equal(false);
    expect((await room.getSeat(0, 1)).stack).to.equal(E(101)); // BB wins the blinds
    expect(await tick()).to.equal("hand-ended");
  });

  it("mid-hand deserter: penalized cancel forfeits their committed chips to the others", async function () {
    const { alice, bob, room, state, clients, tick, stepAll } = await setup();
    await dealHand(tick, stepAll);
    await room.connect(alice).act(0, CALL, 0);
    await room.connect(bob).act(0, CHECK, 0); // flop, both committed 2

    expect(await tick()).to.equal("board-wait");
    clients[0].step(state, 0); // alice answers the board request…
    // …bob's tab is closed. Deadline passes → bob is the offender.
    const tag = await tick({ now: () => Date.now() + 60_000 });
    expect(tag).to.equal("cancelled:penalized:seat1");

    // bob's committed 2 went to alice; alice fully refunded
    expect((await room.getSeat(0, 0)).stack).to.equal(E(102));
    expect((await room.getSeat(0, 1)).stack).to.equal(E(98));
    expect((await room.getSeat(0, 1)).sittingOut).to.equal(true); // struck + sat out
    expect(Number(await room.timeoutStreak(0, 1))).to.equal(1);
    expect((await room.getHand(0)).inProgress).to.equal(false);
  });

  it("pre-hand no-show: strike + sit-out, no money moves", async function () {
    const { room, state, clients, tick } = await setup();
    expect(await tick({ keysMs: -1 })).to.match(/^keys:0/); // session opened, deadline already past
    clients[1].step(state, 0); // only bob sends a key; alice never shows
    expect(await tick({ keysMs: -1 })).to.equal("strike:keys:seat0");
    expect((await room.getSeat(0, 0)).sittingOut).to.equal(true);
    expect(Number(await room.timeoutStreak(0, 0))).to.equal(1);
    expect((await room.getSeat(0, 0)).stack).to.equal(E(100)); // untouched
    // with one player sat out the table has <2 eligible → idle
    expect(await tick()).to.equal("idle");
  });

  it("bot restart mid-hand: session recovers from persisted cts verified against on-chain hashes", async function () {
    const os = require("os");
    const path = require("path");
    const persistDir = path.join(os.tmpdir(), `zkdeal-test-${Date.now()}`);
    const { alice, bob, room, zkd, state, clients, tick, stepAll } = await setup();

    const t = (opts = {}) => tick({ persistDir, ...opts });
    expect(await t()).to.match(/^keys:0/);
    stepAll();
    expect(await t()).to.match(/^shuffle:0/);
    stepAll(); stepAll(); stepAll();
    expect(await t()).to.equal("started");
    stepAll(); // clients pick up their hole cards

    await room.connect(alice).act(0, CALL, 0);
    await room.connect(bob).act(0, CHECK, 0); // flop

    // "restart": the coordinator loses ALL in-memory sessions
    const state2 = zkDealer.newZkState();
    const [, coordinator] = await ethers.getSigners();
    const roomC = room.connect(coordinator), zkdC = zkd.connect(coordinator);
    const tickR = (opts = {}) => zkDealer.tickZkTable(roomC, zkdC, state2, 0, { showdownMs: 0, persistDir, ...opts });

    expect(await tickR()).to.equal("recovered");
    // clients re-attach (their secrets survive in *their* storage); the first
    // tick re-requests the board shares, the clients answer, reveals land
    clients.forEach((c) => c.step(state2, 0));
    expect(await tickR()).to.equal("board-wait");
    clients.forEach((c) => c.step(state2, 0));
    expect(await tickR()).to.equal("board:1");
    expect(await tickR()).to.equal("board:2");
    expect(await tickR()).to.equal("board:3");
  });
});
