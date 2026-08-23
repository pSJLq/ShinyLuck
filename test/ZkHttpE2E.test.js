const { expect } = require("chai");
const { ethers } = require("hardhat");
const crypto = require("node:crypto");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const zkDrv = require("../scripts/lib/poker-zk-dealer");
const { startCardServer } = require("../scripts/poker-dealer-bot");

const E = (n) => ethers.parseEther(String(n));
const FOLD = 0, CHECK = 1, CALL = 2, RAISE = 4, ALLIN = 5;

// A faithful HTTP-level "browser": talks to the REAL bot card server over
// fetch() with REAL signed requests, exactly as frontend/poker/zk-agent.js does
// — exercising the signature auth (resolveSigner), JSON-over-the-wire encoding,
// and endpoint routing that the direct-call driver tests bypass. Its per-hand
// secret never leaves the object.
class HttpBrowser {
  constructor(zk, G1, base, signer, room, zkd, tableId) {
    this.zk = zk; this.G1 = G1; this.base = base; this.signer = signer;
    this.room = room; this.zkd = zkd; this.t = tableId;
    this.addr = null; this.byDeal = new Map(); this.holes = new Map();
    this.pins = new Map(); this.chainOk = new Map(); this.sigs = new Map();
    this.alive = true;
  }
  async init() { this.addr = (await this.signer.getAddress()).toLowerCase(); }
  hex(b) { return "0x" + b.toString(16); }
  async sign(dealId) {
    const k = `${this.t}:${dealId}`;
    if (!this.sigs.has(k)) this.sigs.set(k, await this.signer.signMessage(`ShinyPoker:zk:${this.t}:${dealId}`));
    return this.sigs.get(k);
  }
  async post(path, body) {
    const r = await fetch(`${this.base}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `${path} ${r.status}`);
    return out;
  }
  secretFor(dealId) {
    if (!this.byDeal.has(dealId)) { const kg = this.zk.keygen(""); this.byDeal.set(dealId, { x: kg.x, X: kg.X }); }
    return this.byDeal.get(dealId);
  }
  deckHash(wireDeck) { return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(wireDeck))); }
  mayRelease(idx, k, part, street) {
    if (idx < 2 * k) { const o = Math.floor(idx / 2); return o === part ? street === 4 : true; }
    const slot = idx - 2 * k; const due = street >= 3 ? 5 : street === 2 ? 4 : street === 1 ? 3 : 0;
    return slot < due;
  }
  async verifyChain(dealId, sig, myTurn, myX) {
    if (this.chainOk.has(dealId)) return this.chainOk.get(dealId);
    const ch = await this.post("/zk/chain", { tableId: this.t, dealId, signature: sig });
    if (!ch || !Array.isArray(ch.decks) || ch.decks.length !== ch.k || !Array.isArray(ch.proofs) ||
        ch.proofs.some((p) => !p) || !Array.isArray(ch.pubkeys) || ch.pubkeys.some((p) => !p)) return { ok: false };
    const pubkeys = ch.pubkeys.map(zkDrv.parsePt);
    let X = this.G1.ZERO; for (const P of pubkeys) X = X.add(P);
    if (myX && !pubkeys[myTurn].equals(myX)) return this._bad(dealId);
    const pin = this.pins.get(dealId);
    if (pin && !pin.aggKey.equals(X)) return this._bad(dealId);
    for (let i = 0; i < ch.k; i++) {
      const seat = Number(ch.seats[i]); const a = this.zk.aff(pubkeys[i]);
      const msg = `ShinyPoker:zk-key:${this.t}:${dealId}:${seat}:0x${a.x.toString(16)}:0x${a.y.toString(16)}`;
      let rec; try { rec = ethers.verifyMessage(msg, ch.keySigs[i]).toLowerCase(); } catch { return this._bad(dealId); }
      const occ = await this.room.getSeat(this.t, seat);
      const player = occ.player.toLowerCase();
      const sk = (await this.room.sessionKeyOf(occ.player)).toLowerCase();
      if (rec !== player && rec !== sk) return this._bad(dealId);
    }
    const decks = [this.zk.initialDeck(this.zk.deckPoints()), ...ch.decks.map((d) => d.map(zkDrv.parseCt))];
    const proofs = ch.proofs.map((w) => this.zk.shuffleProofFromWire(w, zkDrv.parsePt));
    if (pin && this.deckHash(ch.decks[myTurn]) !== pin.outHash) return this._bad(dealId);
    for (let i = 0; i < ch.k; i++) {
      if (!this.zk.verifyShuffle(`SPZK:${dealId}:shuffle:${i}`, decks[i], decks[i + 1], X, proofs[i])) return this._bad(dealId);
    }
    const v = { ok: true }; this.chainOk.set(dealId, v); return v;
  }
  _bad(dealId) { const v = { ok: false, bad: true }; this.chainOk.set(dealId, v); return v; }

  // one poll+act cycle, mirroring zk-agent.iteration(). `dealId` is the public
  // deal id the /snapshot zk fragment would carry (fed by the harness here so
  // this test can focus on the /zk/* protocol + auth without the snapshot cache).
  async step(dealId) {
    if (!this.alive || !dealId) return "no-deal";
    const sig = await this.sign(dealId);
    let task; try { task = await this.post("/zk/task", { tableId: this.t, dealId, signature: sig }); } catch { return "task-err"; }
    if (task.observer || task.phase === "none" || task.participant === undefined) return task.phase;

    if (task.do === "key") {
      const sec = this.secretFor(dealId);
      const kg = this.zk.keygen(task.domain);
      // re-key from the fresh keygen so the PoK matches
      this.byDeal.set(dealId, { x: kg.x, X: kg.X });
      const a = this.zk.aff(kg.X);
      const keySig = await this.signer.signMessage(`ShinyPoker:zk-key:${this.t}:${dealId}:${task.mySeat}:0x${a.x.toString(16)}:0x${a.y.toString(16)}`);
      await this.post("/zk/key", { tableId: this.t, dealId, signature: sig, X: zkDrv.serPt(kg.X), pokR: zkDrv.serPt(kg.pok.R), pokS: this.hex(kg.pok.s), keySig });
      return "key";
    }
    if (task.do === "shuffle") {
      const deck = task.deck.map(zkDrv.parseCt);
      const X = zkDrv.parsePt(task.aggKey);
      const out = this.zk.shuffleRemask(deck, X);
      const wireDeck = out.deck.map(zkDrv.serCt);
      this.pins.set(dealId, { outHash: this.deckHash(wireDeck), aggKey: X });
      await this.post("/zk/shuffle", { tableId: this.t, dealId, signature: sig, deck: wireDeck });
      const prf = this.zk.proveShuffle(`SPZK:${dealId}:shuffle:${task.participant}`, deck, out.deck, X, out.secret);
      await this.post("/zk/shuffleproof", { tableId: this.t, dealId, signature: sig, turn: task.participant, proof: this.zk.shuffleProofToWire(prf) });
      return "shuffle";
    }
    if (task.do === "shares") {
      const sec = this.secretFor(dealId);
      const verdict = await this.verifyChain(dealId, sig, task.participant, sec.X);
      if (!verdict.ok) return "chain-wait";
      const hand = await this.room.getHand(this.t);
      const street = (hand.inProgress && String(hand.dealId) === String(dealId)) ? Number(hand.street) : -1;
      const items = [];
      for (const idx of task.idxs) {
        if (!this.mayRelease(idx, task.k, task.participant, street)) continue;
        const ct = zkDrv.parseCt(task.cts[idx]);
        const sh = this.zk.decryptionShare(ct, sec.x, this.G1.BASE.multiply(sec.x), task.domains[idx]);
        items.push({ idx, d: zkDrv.serPt(sh.d), R1: zkDrv.serPt(sh.proof.R1), R2: zkDrv.serPt(sh.proof.R2), s: this.hex(sh.proof.s) });
      }
      if (items.length) await this.post("/zk/shares", { tableId: this.t, dealId, signature: sig, items });
    }
    if (task.myHoles && !this.holes.has(dealId)) {
      const sec = this.secretFor(dealId);
      const pubkeys = (task.pubkeys || []).map(zkDrv.parsePt);
      const cards = [];
      for (const idx of Object.keys(task.myHoles).map(Number).sort((a, b) => a - b)) {
        const h = task.myHoles[idx]; const ct = zkDrv.parseCt(h.ct);
        // verify against on-chain commitment
        const a = this.zk.aff(ct.A), b = this.zk.aff(ct.B);
        const packed = ethers.concat([ethers.toBeHex(a.x, 32), ethers.toBeHex(a.y, 32), ethers.toBeHex(b.x, 32), ethers.toBeHex(b.y, 32)]);
        expect(ethers.keccak256(packed)).to.equal(await this.zkd.ctHash(dealId, idx));
        const ds = [];
        for (const s of h.shares) {
          if (!s) continue;
          const d = zkDrv.parsePt(s.d);
          const share = { d, proof: { R1: zkDrv.parsePt(s.proof.R1), R2: zkDrv.parsePt(s.proof.R2), s: BigInt(s.proof.s) } };
          expect(this.zk.verifyShare(ct, pubkeys[s.i], share, `SPZK:${dealId}:share:${idx}:${s.i}`)).to.equal(true);
          ds.push(d);
        }
        const M = this.zk.decryptWithShares(ct, ds, sec.x);
        const card = this.zk.pointToCard(M, this.zk.deckPoints());
        expect(card).to.be.gte(0);
        cards.push(card);
      }
      this.holes.set(dealId, cards);
    }
    return task.phase;
  }
}

describe("zkShuffle v2 — HTTP-level E2E (real /zk/* server, signed fetch)", function () {
  this.timeout(180000);
  let zk, bn254, G1, server, base;

  before(async () => {
    zk = await import("../frontend/poker/zk-bn254.js");
    ({ bn254 } = await import("@noble/curves/bn254"));
    zk.init({ bn254, keccak256: ethers.keccak256, randomBytes: (n) => crypto.randomBytes(n) });
    zkDrv.init({ zkModule: zk, bn254 });
    G1 = bn254.G1.ProjectivePoint;
  });
  afterEach(() => { if (server) { server.close(); server = null; } });

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
    for (const [p, s] of [[alice, 0], [bob, 1]]) { await room.connect(p).deposit({ value: E(100) }); await room.connect(p).sitDown(0, s, E(100)); }
    const zkState = zkDrv.newZkState();
    const port = 3900 + Math.floor(Math.random() * 500);
    server = startCardServer(room.connect(coordinator), zkState, { zkState, ZK_MODE: true, port });
    base = `http://127.0.0.1:${port}`;
    const tick = (opts = {}) => zkDrv.tickZkTable(room.connect(coordinator), zkd.connect(coordinator), zkState, 0, { showdownMs: 0, ...opts });
    const dealId = () => { const s = zkDrv.zkSnapshot(zkState, 0); return s ? s.dealId : null; };
    const browsers = [new HttpBrowser(zk, G1, base, alice, room, zkd, 0), new HttpBrowser(zk, G1, base, bob, room, zkd, 0)];
    for (const b of browsers) await b.init();
    return { owner, coordinator, alice, bob, room, zkd, zkState, tick, dealId, browsers, port };
  }

  it("plays a full hand over HTTP: signed keys → shuffle+proof → holeshares → deal → board → showdown → settle", async function () {
    const { room, coordinator, alice, bob, zkState, tick, dealId, browsers } = await setup();
    // interleave: advance the bot, let each browser act, until the hand settles
    let settled = false;
    for (let i = 0; i < 80 && !settled; i++) {
      const tag = await tick();
      for (const b of browsers) { try { await b.step(dealId()); } catch (e) { /* transient phase races */ } }
      if (tag === "settled" || tag === "hand-ended") settled = true;
      // once the hand is live, run it down: both check to showdown
      const h = await room.getHand(0);
      if (h.inProgress && Number(h.street) <= 3) {
        try {
          const actor = Number(h.actingSeat) === 0 ? alice : bob;
          const sh = await room.getSeatHand(0, Number(h.actingSeat));
          const toCall = h.currentBet > sh.committedStreet;
          await room.connect(actor).act(0, toCall ? CALL : CHECK, 0);
        } catch (_) {}
      }
    }
    // both browsers decrypted their own two cards, and they're distinct valid cards
    const aCards = [...browsers[0].holes.values()][0];
    const bCards = [...browsers[1].holes.values()][0];
    expect(aCards).to.have.length(2);
    expect(bCards).to.have.length(2);
    const all = new Set([...aCards, ...bCards]);
    expect(all.size).to.equal(4); // 4 distinct hole cards
    // the hand settled and chips are conserved
    expect((await room.getHand(0)).inProgress).to.equal(false);
    const s0 = (await room.getSeat(0, 0)).stack, s1 = (await room.getSeat(0, 1)).stack;
    expect(s0 + s1).to.equal(E(200));
  });

  it("HTTP browser goes silent mid-hand → accuse → un-rescued window → penalized cancel", async function () {
    const { room, alice, bob, zkState, tick, dealId, browsers } = await setup();
    // deal a hand: run the interleave until it's live, both players in
    let live = false;
    for (let i = 0; i < 40 && !live; i++) {
      const tag = await tick();
      for (const b of browsers) { try { await b.step(dealId()); } catch (_) {} }
      const h = await room.getHand(0);
      if (h.inProgress && tag === "started") live = true;
    }
    expect(live).to.equal(true);
    // preflop: alice (SB/button) calls, bob checks → flop, both committed 2
    let h = await room.getHand(0);
    const first = Number(h.actingSeat) === 0 ? alice : bob;
    await room.connect(first).act(0, CALL, 0);
    h = await room.getHand(0);
    const second = Number(h.actingSeat) === 0 ? alice : bob;
    await room.connect(second).act(0, CHECK, 0);
    expect(Number((await room.getHand(0)).street)).to.equal(1); // flop

    // BOB's tab closes. Alice keeps answering board-share requests over HTTP;
    // the board needs both, so it stalls on bob.
    browsers[1].alive = false;
    const before1 = (await room.getSeat(0, 1)).stack;

    // virtual clock advances each iteration so the board-share deadline the bot
    // arms on the first tick is exceeded on a later one (alice answers first, so
    // the offender the bot names is bob, not her). Based on the CHAIN clock: in
    // the full suite prior time.increase calls push block.timestamp ahead of
    // Date.now(), and the finalize check compares against the on-chain deadline.
    let vnow = Math.max(Date.now(), (await time.latest()) * 1000) + 60_000;
    let accusedTag = null;
    for (let i = 0; i < 25 && !accusedTag; i++) {
      const tag = await tick({ now: () => vnow });
      if (/^accused:seat1/.test(tag)) { accusedTag = tag; break; }
      await browsers[0].step(dealId()); // alice answers her board share
      vnow += 15_000;
    }
    expect(accusedTag).to.match(/^accused:seat1/);
    expect((await room.accusationOf(0)).active).to.equal(true);
    expect((await room.getSeat(0, 1)).stack).to.equal(before1); // nothing forfeited yet

    // bob never self-rescues (tab closed); window expires → penalty finalizes
    await time.increase(Number(await room.rescueWindow()) + 2);
    vnow = Math.max(vnow, (await time.latest()) * 1000) + 200_000;
    let done = null;
    for (let i = 0; i < 10 && !done; i++) {
      const tag = await tick({ now: () => vnow });
      if (/^cancelled:penalized:seat1/.test(tag)) done = tag;
      vnow += 5_000;
    }
    expect(done).to.match(/^cancelled:penalized:seat1/);
    // bob's committed 2 went to alice; hand over; chips conserved
    expect((await room.getSeat(0, 0)).stack).to.equal(E(102));
    expect((await room.getSeat(0, 1)).stack).to.equal(E(98));
    expect((await room.getSeat(0, 1)).sittingOut).to.equal(true);
    expect((await room.getHand(0)).inProgress).to.equal(false);
  });

  it("rejects an unsigned/missigned /zk/task (auth is enforced at the HTTP layer)", async function () {
    const { tick } = await setup();
    await tick(); // open the session
    // a request signed for the WRONG dealId resolves to a non-participant → observer/none
    const r = await fetch(`${base}/zk/task`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tableId: 0, dealId: "999", signature: "0x" + "11".repeat(65) }),
    });
    // a malformed signature is a 400 from ethers.verifyMessage inside resolveSigner
    expect(r.status).to.equal(400);
  });
});
