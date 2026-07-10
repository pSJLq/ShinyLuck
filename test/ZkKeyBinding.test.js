const { expect } = require("chai");
const { ethers } = require("hardhat");
const crypto = require("node:crypto");
const zkDealer = require("../scripts/lib/poker-zk-dealer");

const E = (n) => ethers.parseEther(String(n));

// The anti-key-substitution defence. Each per-hand pubkey carries a signature
// from its seat's occupant; every client verifies all bindings (mirrored here
// exactly as frontend/poker/zk-agent.js verifyChain does) against the seat's
// ON-CHAIN occupant before contributing any decryption share. Without it a
// malicious coordinator could plant its own key for a seat and decrypt that
// seat's hole cards — the exact thing v2 promises it cannot do.
describe("zkShuffle v2 — per-hand key ↔ seat binding (anti key-substitution)", function () {
  this.timeout(120000);
  let zk, bn254, G1;

  before(async () => {
    zk = await import("../frontend/poker/zk-bn254.js");
    ({ bn254 } = await import("@noble/curves/bn254"));
    zk.init({ bn254, keccak256: ethers.keccak256, randomBytes: (n) => crypto.randomBytes(n) });
    zkDealer.init({ zkModule: zk, bn254 });
    G1 = bn254.G1.ProjectivePoint;
  });

  // the verification a client runs before sharing — byte-identical message + the
  // same on-chain occupant check as zk-agent.js
  async function verifyBindings(room, t, dealId, chain) {
    const pubkeys = chain.pubkeys.map(zkDealer.parsePt);
    for (let i = 0; i < chain.k; i++) {
      const seat = Number(chain.seats[i]);
      const a = zk.aff(pubkeys[i]);
      const msg = `ShinyPoker:zk-key:${t}:${dealId}:${seat}:0x${a.x.toString(16)}:0x${a.y.toString(16)}`;
      let recovered;
      try { recovered = ethers.verifyMessage(msg, chain.keySigs[i]).toLowerCase(); }
      catch (_) { return { ok: false, i }; }
      const occ = await room.getSeat(t, seat);
      const player = occ.player.toLowerCase();
      if (player === ethers.ZeroAddress) return { ok: false, i };
      const sk = (await room.sessionKeyOf(occ.player)).toLowerCase();
      if (recovered !== player && recovered !== sk) return { ok: false, i };
    }
    return { ok: true };
  }

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
    const tick = (opts = {}) => zkDealer.tickZkTable(room.connect(coordinator), zkd.connect(coordinator), state, 0, opts);
    return { owner, coordinator, alice, bob, room, zkd, state, tick };
  }

  // players post keys WITH a seat-binding signature, then the deck is shuffled so
  // the session reaches a state where /zk/chain serves pubkeys + keySigs + seats
  async function toChain(state, tick, room, players) {
    expect(await tick()).to.match(/^keys:0/);
    const sess = state.get(0);
    const dealId = String(sess.dealId);
    for (const { signer, addr, seat } of players) {
      const kg = zk.keygen(zkDealer.keyDomain(dealId, seat === 0 ? 0 : 1));
      const a = zk.aff(kg.X);
      const msg = `ShinyPoker:zk-key:0:${dealId}:${seat}:0x${a.x.toString(16)}:0x${a.y.toString(16)}`;
      const keySig = await signer.signMessage(msg);
      zkDealer.zkPostKey(state, 0, addr.toLowerCase(), {
        dealId, X: zkDealer.serPt(kg.X), pokR: zkDealer.serPt(kg.pok.R), pokS: "0x" + kg.pok.s.toString(16), keySig,
      });
    }
    // keys → shuffle so aggKey/pubkeys/keySigs surface on /zk/chain
    await tick();
    return dealId;
  }

  it("accepts honest bindings signed by each seat's occupant", async function () {
    const { alice, bob, room, state, tick } = await setup();
    await toChain(state, tick, room, [
      { signer: alice, addr: alice.address, seat: 0 },
      { signer: bob, addr: bob.address, seat: 1 },
    ]);
    const chain = zkDealer.zkChain(state, 0);
    expect(chain.pubkeys.filter(Boolean)).to.have.length(2);
    expect(chain.keySigs.filter(Boolean)).to.have.length(2);
    expect((await verifyBindings(room, 0, chain.dealId, chain)).ok).to.equal(true);
  });

  it("rejects a coordinator-substituted key (bot's own key planted for a seat)", async function () {
    const { coordinator, alice, bob, room, state, tick } = await setup();
    const dealId = await toChain(state, tick, room, [
      { signer: alice, addr: alice.address, seat: 0 },
      { signer: bob, addr: bob.address, seat: 1 },
    ]);
    const chain = zkDealer.zkChain(state, 0);

    // the coordinator swaps in a key IT controls for bob's seat, and signs the
    // binding with its OWN key (it can't sign as bob) — verification must reject
    const evil = zk.keygen(zkDealer.keyDomain(dealId, 1));
    const a = zk.aff(evil.X);
    const msg = `ShinyPoker:zk-key:0:${dealId}:1:0x${a.x.toString(16)}:0x${a.y.toString(16)}`;
    chain.pubkeys[1] = zkDealer.serPt(evil.X);
    chain.keySigs[1] = await coordinator.signMessage(msg);
    const res = await verifyBindings(room, 0, dealId, chain);
    expect(res.ok).to.equal(false);
    expect(res.i).to.equal(1);
  });

  it("rejects a substituted key that REUSES the honest signature (message no longer matches)", async function () {
    const { alice, bob, room, state, tick } = await setup();
    const dealId = await toChain(state, tick, room, [
      { signer: alice, addr: alice.address, seat: 0 },
      { signer: bob, addr: bob.address, seat: 1 },
    ]);
    const chain = zkDealer.zkChain(state, 0);
    // keep bob's original signature but swap the pubkey → verifyMessage recovers
    // a different address than bob → rejected
    const evil = zk.keygen(zkDealer.keyDomain(dealId, 1));
    chain.pubkeys[1] = zkDealer.serPt(evil.X);
    const res = await verifyBindings(room, 0, dealId, chain);
    expect(res.ok).to.equal(false);
    expect(res.i).to.equal(1);
  });

  it("accepts a binding signed by the seat's authorized SESSION KEY", async function () {
    const { alice, bob, room, state, tick } = await setup();
    // bob authorizes a session key; it (not bob's wallet) signs the binding
    const sk = ethers.Wallet.createRandom();
    await room.connect(bob).setSessionKey(sk.address);
    const dealId = await toChain(state, tick, room, [
      { signer: alice, addr: alice.address, seat: 0 },
      { signer: sk, addr: bob.address, seat: 1 }, // signed by session key, posted as bob
    ]);
    const chain = zkDealer.zkChain(state, 0);
    expect((await verifyBindings(room, 0, dealId, chain)).ok).to.equal(true);
  });
});
