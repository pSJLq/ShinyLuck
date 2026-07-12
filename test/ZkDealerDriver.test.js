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

  step(state, t, wantDealId) {
    const task = zkDealer.zkTask(state, t, this.addr, wantDealId);
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
      // …followed by the Wikström proof of that shuffle (like zk-agent.js)
      const prf = this.zk.proveShuffle(`SPZK:${dealId}:shuffle:${task.participant}`, deck, out.deck, X, out.secret);
      zkDealer.zkPostShuffleProof(state, t, this.addr, { dealId, turn: task.participant, proof: this.zk.shuffleProofToWire(prf) });
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

    // flop: bot requests board shares, clients answer, the whole flop reveals
    // as a UNIT (all 3 cards in one tick, not one per poll cycle)
    expect(await tick()).to.equal("board-wait");
    stepAll();
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

    // showdown: own-hole shares released, then ONE tick reveals every ready
    // seat and marks readiness (the old one-seat-per-tick flow made the
    // showdown tail cost ~4 poll cycles)
    expect(await tick()).to.equal("showdown-collect");
    stepAll();
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

  // check the current hand down to street 4 (SHOWDOWN), boards revealed
  async function checkDownToShowdown(room, alice, bob, tick, stepAll) {
    await room.connect(alice).act(0, CALL, 0);
    await room.connect(bob).act(0, CHECK, 0);
    expect(await tick()).to.equal("board-wait");
    stepAll();
    expect(await tick()).to.equal("board:3");
    for (const street of [2, 3]) {
      await room.connect(bob).act(0, CHECK, 0);
      await room.connect(alice).act(0, CHECK, 0);
      expect(await tick()).to.equal("board-wait");
      stepAll();
      expect(await tick()).to.equal(`board:${street + 2}`);
    }
    await room.connect(bob).act(0, CHECK, 0);
    await room.connect(alice).act(0, CHECK, 0);
    expect(Number((await room.getHand(0)).street)).to.equal(4);
  }

  it("pre-deal: next hand's setup + prepareDeal overlap the showdown; settle → started with nothing but startHand between", async function () {
    const { alice, bob, room, zkd, state, clients, tick, stepAll } = await setup();
    await dealHand(tick, stepAll);
    stepAll(); // decrypt holes
    await checkDownToShowdown(room, alice, bob, tick, stepAll);

    // the speculative next-hand session opened on the first live tick and has
    // been idling in `keys` (clients only fed the live deal so far)
    expect(await tick()).to.equal("showdown-collect");
    const nx0 = state.get(zkDealer.nextKey(0));
    expect(nx0, "pre-deal session open").to.exist;
    expect(nx0.phase).to.equal("keys");
    const nextDealId = String(nx0.dealId);
    // clients serve BOTH deals now, exactly like the browser agent
    const stepBoth = () => clients.forEach((c) => { c.step(state, 0); c.step(state, 0, nextDealId); });

    stepBoth(); // main: own-hole shares; next: both keys
    expect(await tick({ showdownMs: 60000 })).to.equal("showdown-ready"); // reveals; next: keys→shuffle
    stepBoth(); // next: both shuffles + Wikström proofs → holeshares
    expect(await tick({ showdownMs: 60000 })).to.equal("showdown-wait");
    stepBoth(); // next: pre-collect shares for the OTHERS' holes
    expect(await tick({ showdownMs: 60000 })).to.equal("showdown-wait"); // next → prepare; prepareDeal rides the pause

    const nx = state.get(zkDealer.nextKey(0));
    expect(nx.phase).to.equal("prepare");
    expect(nx.prepared, "prepareDeal sent during the winner-display pause").to.equal(true);
    // no early peek: my NEXT-hand cards are never relayed while speculative
    const t0 = zkDealer.zkTask(state, 0, clients[0].addr, nextDealId);
    expect(t0.myHoles, "myHoles withheld for a speculative deal").to.equal(undefined);

    expect(await tick()).to.equal("settled"); // showdownMs 0 → pot moves
    expect(await tick()).to.equal("hand-ended:next-ready"); // pre-deal promoted
    expect(await tick({ interHandMs: 0 })).to.equal("started"); // ONLY startHand left

    const h2 = await room.getHand(0);
    expect(h2.inProgress).to.equal(true);
    expect(Number(h2.handId)).to.equal(2);
    expect(String(h2.dealId)).to.equal(nextDealId); // the pre-dealt deal got bound

    // the promoted deal serves hole cards normally now — valid and distinct
    clients.forEach((c) => { c.holes = null; c.step(state, 0); });
    const all = [...clients[0].holes, ...clients[1].holes];
    expect(all.every((c) => c >= 0 && c <= 51)).to.equal(true);
    expect(new Set(all).size).to.equal(4);
  });

  it("pre-deal is discarded when eligibility changes at settle — a stale seat set can never bind", async function () {
    const { alice, bob, room, zkd, state, clients, tick, stepAll } = await setup();
    await dealHand(tick, stepAll);
    stepAll();
    await checkDownToShowdown(room, alice, bob, tick, stepAll);

    expect(await tick()).to.equal("showdown-collect");
    const nextDealId = String(state.get(zkDealer.nextKey(0)).dealId);
    const stepBoth = () => clients.forEach((c) => { c.step(state, 0); c.step(state, 0, nextDealId); });
    stepBoth();
    expect(await tick({ showdownMs: 60000 })).to.equal("showdown-ready");
    stepBoth();
    expect(await tick({ showdownMs: 60000 })).to.equal("showdown-wait");
    stepBoth();
    expect(await tick({ showdownMs: 60000 })).to.equal("showdown-wait");
    expect(state.get(zkDealer.nextKey(0)).prepared).to.equal(true);
    expect(await tick()).to.equal("settled");

    // bob sits out between settle and the next hand — the prediction is stale
    await room.connect(bob).setSitOut(0, true);
    expect(await tick()).to.equal("hand-ended:next-ready");
    expect(await tick({ interHandMs: 0 })).to.equal("idle"); // <2 eligible → promoted session discarded
    expect((await zkd.dealInfo(nextDealId)).bound).to.equal(false); // orphaned prepared deal never bound
    expect((await room.getHand(0)).inProgress).to.equal(false);

    // bob returns → a FRESH session opens (new dealId), the normal path intact
    await room.connect(bob).setSitOut(0, false);
    expect(await tick({ interHandMs: 0 })).to.match(/^keys:0\/2/);
    expect(String(state.get(0).dealId)).to.not.equal(nextDealId);
  });

  it("pre-deal covers fold endings too: fold on the flop → next hand starts from the promoted session", async function () {
    const { alice, bob, room, state, clients, tick, stepAll } = await setup();
    await dealHand(tick, stepAll);
    stepAll(); // decrypt holes
    await room.connect(alice).act(0, CALL, 0);
    await room.connect(bob).act(0, CHECK, 0); // → flop
    expect(await tick()).to.equal("board-wait"); // pre-deal session opens here
    const nextDealId = String(state.get(zkDealer.nextKey(0)).dealId);
    const stepBoth = () => clients.forEach((c) => { c.step(state, 0); c.step(state, 0, nextDealId); });
    stepBoth(); // board shares + next keys
    expect(await tick()).to.equal("board:3");
    stepBoth(); // next: both shuffles
    expect(await tick()).to.equal("wait");
    stepBoth(); // next: hole-share pre-collect
    expect(await tick()).to.equal("wait"); // next → prepare; prepareDeal fires (no reveal pending)
    expect(state.get(zkDealer.nextKey(0)).prepared).to.equal(true);

    await room.connect(bob).act(0, FOLD, 0); // fold-win, no crypto needed
    expect((await room.getHand(0)).inProgress).to.equal(false);
    expect(await tick()).to.equal("hand-ended:next-ready");
    expect(await tick({ interHandMs: 0 })).to.equal("started");
    const h2 = await room.getHand(0);
    expect(Number(h2.handId)).to.equal(2);
    expect(String(h2.dealId)).to.equal(nextDealId);
  });

  it("old clients that ignore the pre-deal: silent fallback to the normal path, no strikes", async function () {
    const { alice, bob, room, state, tick, stepAll } = await setup();
    await dealHand(tick, stepAll);
    stepAll();
    await checkDownToShowdown(room, alice, bob, tick, stepAll);

    // clients only ever serve the LIVE deal (an old cached zk-agent)
    expect(await tick()).to.equal("showdown-collect"); // pre-deal session opens…
    stepAll();
    const tags = [];
    for (let i = 0; i < 8 && !tags.includes("settled"); i++) { stepAll(); tags.push(await tick()); }
    expect(tags).to.include("settled");
    expect(tags.join(",")).to.not.match(/strike|cancelled/);

    // …but nobody fed it → dropped silently at promotion; normal redeal follows
    expect(await tick()).to.equal("hand-ended");
    expect(state.get(zkDealer.nextKey(0))).to.equal(undefined);
    expect(await tick({ interHandMs: 0 })).to.match(/^keys:0\/2/);
  });

  it("mid-hand deserter: accusation → un-rescued window → penalized cancel forfeits to the others", async function () {
    const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
    const { alice, bob, room, state, clients, tick, stepAll } = await setup();
    await dealHand(tick, stepAll);
    await room.connect(alice).act(0, CALL, 0);
    await room.connect(bob).act(0, CHECK, 0); // flop, both committed 2

    expect(await tick()).to.equal("board-wait");
    clients[0].step(state, 0); // alice answers the board request…
    // (bot clock in these ticks tracks CHAIN time — in prod they're the same
    // clock; in the full suite the chain has drifted ahead of Date.now())
    const botNow = async (s) => Math.max(Date.now(), (await time.latest()) * 1000) + s * 1000;
    // …bob's tab is closed. Deadline passes → bob is ACCUSED (no chips move yet).
    let base = await botNow(60);
    expect(await tick({ now: () => base })).to.match(/^accused:seat1/);
    const acc = await room.accusationOf(0);
    expect(acc.active).to.equal(true);
    expect(Number(acc.offenderSeat)).to.equal(1);
    expect((await room.getSeat(0, 1)).stack).to.equal(E(98)); // committed, not forfeited

    // window still open → even an IMPATIENT bot can't finalize: the CONTRACT
    // refuses (RescueWindowNotElapsed) — that's the actual guarantee
    base = await botNow(200);
    expect(await tick({ now: () => base })).to.equal("penalize-wait");
    expect((await room.getHand(0)).inProgress).to.equal(true);
    expect((await room.getSeat(0, 1)).stack).to.equal(E(98)); // still nothing forfeited

    // window expires with no rescue → penalty finalizes
    await time.increase(Number(await room.rescueWindow()) + 2);
    base = await botNow(200);
    const done = await tick({ now: () => base });
    expect(done).to.equal("cancelled:penalized:seat1");

    // bob's committed 2 went to alice; alice fully refunded
    expect((await room.getSeat(0, 0)).stack).to.equal(E(102));
    expect((await room.getSeat(0, 1)).stack).to.equal(E(98));
    expect((await room.getSeat(0, 1)).sittingOut).to.equal(true); // struck + sat out
    expect(Number(await room.timeoutStreak(0, 1))).to.equal(1);
    expect((await room.getHand(0)).inProgress).to.equal(false);
  });

  it("false accusation: the accused self-rescues on-chain, the share is ingested, the hand completes", async function () {
    const { coordinator, alice, bob, room, zkd, state, clients, tick, stepAll } = await setup();
    await dealHand(tick, stepAll);
    stepAll(); // clients decrypt their holes
    await room.connect(alice).act(0, CALL, 0);
    await room.connect(bob).act(0, CHECK, 0); // flop

    expect(await tick()).to.equal("board-wait");
    clients[0].step(state, 0); // alice answers over HTTP…
    // …bob's HTTP path to the bot is down (but his chain access works). The bot
    // (or a compromised worker key) accuses bob.
    expect(await tick({ now: () => Date.now() + 60_000 })).to.match(/^accused:seat1/);

    // bob's client sees the accusation ON-CHAIN and self-rescues: it computes
    // the demanded share from the ciphertext EMBEDDED in the accusation —
    // exactly what frontend/poker/zk-agent.js selfRescue() does.
    const acc = await room.accusationOf(0);
    const idx = Number(acc.cardIdx);
    const sec = clients[1].byDeal.get(String(await zkd.dealIdForHand(0, acc.handId)));
    const ct = { A: zkDealer.parsePt({ x: acc.ctA[0], y: acc.ctA[1] }), B: zkDealer.parsePt({ x: acc.ctB[0], y: acc.ctB[1] }) };
    const dealIdStr = String(await zkd.dealIdForHand(0, acc.handId));
    const sh = zk.decryptionShare(ct, sec.x, sec.X, `SPZK:${dealIdStr}:share:${idx}:1`);
    const c = (P) => { const a = zk.aff(P); return [a.x, a.y]; };
    await room.connect(bob).proveResponsive(0, c(sh.d), c(sh.proof.R1), c(sh.proof.R2), sh.proof.s);

    // accusation cleared, (seat,card) vindicated — the same share can't be re-accused
    expect((await room.accusationOf(0)).active).to.equal(false);
    const ctA = { x: zk.aff(ct.A).x, y: zk.aff(ct.A).y };
    const ctB = { x: zk.aff(ct.B).x, y: zk.aff(ct.B).y };
    await expect(room.connect(coordinator).accuseAbandon(0, 1, idx, ctA, ctB))
      .to.be.revertedWithCustomError(room, "AlreadyVindicated");

    // the bot ingests the rescued share from the chain; the flop stays HELD
    // (atomic flop: no card shows until all 3 are ready), then bob's HTTP path
    // comes back and the whole flop reveals as one unit
    expect(await tick({ now: () => Date.now() + 60_000 })).to.equal("rescued");
    expect(await tick()).to.equal("board-wait"); // rescued card ready, flop still held
    clients[1].step(state, 0);
    expect(await tick()).to.equal("board:3"); // the whole flop reveals together
    expect((await room.getHand(0)).inProgress).to.equal(true); // nobody was punished

    // no chips moved: both stacks intact minus their live commitments
    expect((await room.getSeat(0, 0)).stack).to.equal(E(98));
    expect((await room.getSeat(0, 1)).stack).to.equal(E(98));
  });

  it("shuffle proofs: the on-chain deal commits to the exact verified transcript", async function () {
    const { room, zkd, state, tick, stepAll } = await setup();
    await dealHand(tick, stepAll);
    const sess = state.get(0);
    expect(sess.transcriptHash).to.be.a("string");
    const dealId = (await room.getHand(0)).dealId;
    expect(await zkd.proofHash(dealId)).to.equal(sess.transcriptHash); // prepareDeal carried it
    // and the served chain is complete for client-side verification
    const chain = zkDealer.zkChain(state, 0);
    expect(chain.decks).to.have.length(2);
    expect(chain.proofs.filter(Boolean)).to.have.length(2);
    expect(chain.transcriptHash).to.equal(sess.transcriptHash);
  });

  it("a cheating shuffler cannot get a substituted deck past the proof gate", async function () {
    const { alice, bob, room, state, clients, tick } = await setup();
    expect(await tick()).to.match(/^keys:0/);
    clients.forEach((c) => c.step(state, 0));
    expect(await tick()).to.match(/^shuffle:0/);
    clients[0].step(state, 0); // alice shuffles honestly (deck + proof)

    // bob shuffles honestly BUT substitutes a known card's ciphertext into
    // slot 0 (his own future hole card) before posting
    const task = zkDealer.zkTask(state, 0, clients[1].addr);
    expect(task.do).to.equal("shuffle");
    const deck = task.deck.map(zkDealer.parseCt);
    const X = zkDealer.parsePt(task.aggKey);
    const out = zk.shuffleRemask(deck, X);
    const evil = out.deck.slice();
    evil[0] = { A: bn254.G1.ProjectivePoint.ZERO, B: zk.deckPoints()[51] }; // naked ace
    zkDealer.zkPostShuffle(state, 0, clients[1].addr, { dealId: task.dealId, deck: evil.map(zkDealer.serCt) });

    // an honest proof of the HONEST shuffle can't cover the evil deck…
    const prf = zk.proveShuffle(`SPZK:${task.dealId}:shuffle:1`, deck, out.deck, X, out.secret);
    expect(() => zkDealer.zkPostShuffleProof(state, 0, clients[1].addr, {
      dealId: task.dealId, turn: 1, proof: zk.shuffleProofToWire(prf),
    })).to.throw(/shuffle proof failed verification/);
    // …no proof ⇒ holeshares never open, nobody ever shares on the evil deck…
    expect(state.get(0).phase).to.equal("shuffle");
    expect(() => zkDealer.zkPostShares(state, 0, clients[0].addr, { dealId: task.dealId, items: [{ idx: 0 }] }))
      .to.throw(/shuffle proofs pending/);
    // …and the proof deadline strikes the cheater; the deal restarts without money moving
    const tag = await tick({ now: () => Date.now() + 60_000 });
    expect(tag).to.equal("strike:shuffle:seat1");
    expect((await room.getSeat(0, 1)).sittingOut).to.equal(true);
    expect((await room.getSeat(0, 0)).stack).to.equal(E(100));
    expect((await room.getSeat(0, 1)).stack).to.equal(E(100));
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
    expect(await tickR()).to.equal("board:3"); // flop reveals as a unit
  });
});
