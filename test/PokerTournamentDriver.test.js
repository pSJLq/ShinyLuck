const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { tickTournament } = require("../scripts/lib/poker-tournament-driver");

const ALLIN = 5;
const E = (n) => ethers.parseEther(String(n));
const R = { "2": 0, "3": 1, "4": 2, "5": 3, "6": 4, "7": 5, "8": 6, "9": 7, T: 8, J: 9, Q: 10, K: 11, A: 12 };
const S = { c: 0, d: 1, h: 2, s: 3 };
const card = (str) => R[str[0]] * 4 + S[str[1]];

describe("Tournament driver — auto-start, bust reporting, level-ups", function () {
  async function setup() {
    const [owner, operator, alice, bob] = await ethers.getSigners();
    const Room = await ethers.getContractFactory("PokerRoom");
    const room = await Room.deploy(owner.address);
    await room.waitForDeployment();
    const Dealer = await ethers.getContractFactory("MockPokerDealer");
    const dealer = await Dealer.deploy();
    await dealer.waitForDeployment();
    const Trn = await ethers.getContractFactory("PokerTournament");
    const trn = await Trn.deploy(owner.address, await room.getAddress());
    await trn.waitForDeployment();
    await room.connect(owner).setDealer(await dealer.getAddress());
    await room.connect(owner).setDealerOperator(operator.address);
    await room.connect(owner).setTournamentFactory(await trn.getAddress());
    await trn.connect(owner).setOperator(operator.address);
    // driver acts as the operator; use chain time so time.increase works
    const opts = { now: () => 0 }; // patched per-test
    return { owner, operator, alice, bob, room, dealer, trn, opts };
  }

  async function chainNow() { return (await ethers.provider.getBlock("latest")).timestamp; }

  it("auto-starts when full, reports the bust, finishes and pays", async function () {
    const { operator, alice, bob, room, dealer, trn } = await loadFixture(setup);
    const opTrn = trn.connect(operator);
    const opts = { now: () => 0 }; // level never due in this test

    await trn.connect(alice).createTournament(E(1), 0, 2, 1000, 10, 20, 600, [10000]);
    await trn.connect(alice).register(0, { value: E(1) });
    expect(await tickTournament(opTrn, room.connect(operator), 0, opts)).to.equal("idle"); // 1/2 — wait
    await trn.connect(bob).register(0, { value: E(1) });
    expect(await tickTournament(opTrn, room.connect(operator), 0, opts)).to.equal("started"); // 2/2 — go

    const t = Number((await trn.info(0)).tableId);
    // play one decisive all-in hand (alice AA > bob junk)
    await room.connect(operator).startHand(t);
    await room.connect(alice).act(t, ALLIN, 0);
    await room.connect(bob).act(t, ALLIN, 0);
    const dealId = (await room.getHand(t)).dealId;
    await dealer.setBoard(dealId, ["2c", "7d", "9h", "Js", "Ks"].map(card));
    await dealer.setHole(dealId, 0, card("Ac"), card("Ad"));
    await dealer.setHole(dealId, 1, card("3d"), card("4h"));
    await dealer.setReady(dealId, true);
    await room.resolveShowdown(t);

    // driver spots the busted seat and reports it → tournament finishes
    expect(await tickTournament(opTrn, room.connect(operator), 0, opts)).to.equal("bust:1");
    expect((await trn.info(0)).status).to.equal(2); // FINISHED
    expect(await room.balance(alice.address)).to.equal(E(2)); // whole pool
    expect(await tickTournament(opTrn, room.connect(operator), 0, opts)).to.equal("idle"); // no-op after finish
  });

  it("levels up the blinds when the clock is due (and not before)", async function () {
    const { operator, alice, bob, room, trn } = await loadFixture(setup);
    const opTrn = trn.connect(operator);
    const opRoom = room.connect(operator);
    const opts = { now: () => 0 };

    await trn.connect(alice).createTournament(0, 0, 2, 1000, 10, 20, 60, [10000]);
    await trn.connect(alice).register(0);
    await trn.connect(bob).register(0);
    expect(await tickTournament(opTrn, opRoom, 0, opts)).to.equal("started");
    const t = Number((await trn.info(0)).tableId);

    // not due yet → idle
    opts.now = () => 0;
    expect(await tickTournament(opTrn, opRoom, 0, { now: async () => 0, ...opts })).to.equal("idle");

    // jump past level 1's duration → driver raises the blinds (10/20 → 20/40)
    await time.increase(61);
    const nowTs = await chainNow();
    expect(await tickTournament(opTrn, opRoom, 0, { now: () => nowTs })).to.equal("level:1");
    const cfg = await room.getTable(t);
    expect(cfg.smallBlind).to.equal(20n);
    expect(cfg.bigBlind).to.equal(40n);
  });
});
