const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const ALLIN = 5;
const E = (n) => ethers.parseEther(String(n));
const R = { "2": 0, "3": 1, "4": 2, "5": 3, "6": 4, "7": 5, "8": 6, "9": 7, T: 8, J: 9, Q: 10, K: 11, A: 12 };
const S = { c: 0, d: 1, h: 2, s: 3 };
const card = (str) => R[str[0]] * 4 + S[str[1]];

describe("PokerTournament — buy-in + sponsored pool, custom split", function () {
  async function setup() {
    const [owner, operator, alice, bob, carol] = await ethers.getSigners();
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
    return { owner, operator, alice, bob, carol, room, dealer, trn };
  }

  it("runs a heads-up SNG end-to-end and pays the winner from the pool", async function () {
    const { operator, alice, bob, carol, room, dealer, trn } = await loadFixture(setup);

    // carol creates a tournament and SPONSORS 100 (one person funds part of the pool);
    // players also buy in 10 (+1 fee). Winner-take-all split.
    await trn.connect(carol).createTournament(E(10), E(1), 2, 1000, 10, 20, 60, [10000], { value: E(100) });
    const id = 0;
    await trn.connect(alice).register(id, { value: E(11) });
    await trn.connect(bob).register(id, { value: E(11) });

    let info = await trn.info(id);
    expect(info.pool).to.equal(E(120)); // 100 sponsored + 10 + 10
    expect(await trn.feeCollected()).to.equal(E(2));
    expect(info.registered).to.equal(2);

    // start → controlled table created, both seated with 1000 chips
    await trn.connect(operator).start(id);
    const t = Number((await trn.info(id)).tableId);
    expect((await room.getSeat(t, 0)).stack).to.equal(1000n);
    expect((await room.getSeat(t, 1)).stack).to.equal(1000n);
    expect(await room.tableController(t)).to.equal(await trn.getAddress());
    // cash actions are blocked on a tournament table
    await expect(room.connect(carol).sitDown(t, 0, E(1))).to.be.revertedWithCustomError(room, "ControlledTable");

    // play one all-in hand; alice (AA) beats bob → bob busts
    await room.connect(operator).startHand(t);
    await room.connect(alice).act(t, ALLIN, 0); // seat0 = button/SB acts first HU
    await room.connect(bob).act(t, ALLIN, 0);
    const dealId = (await room.getHand(t)).dealId;
    await dealer.setBoard(dealId, ["2c", "7d", "9h", "Js", "Ks"].map(card));
    await dealer.setHole(dealId, 0, card("Ac"), card("Ad")); // alice: pair of aces
    await dealer.setHole(dealId, 1, card("3d"), card("4h")); // bob: high card
    await dealer.setReady(dealId, true);
    await room.resolveShowdown(t);

    expect((await room.getSeat(t, 1)).stack).to.equal(0n); // bob busted
    expect((await room.getSeat(t, 0)).stack).to.equal(2000n); // alice has all chips

    // report bob's bust → he's 2nd (no payout), alice wins the whole pool
    const tx = await trn.connect(operator).reportBust(id, 1);
    await expect(tx).to.emit(trn, "Finished").withArgs(id, alice.address, E(120));
    expect(await room.balance(alice.address)).to.equal(E(120)); // prize credited to in-room balance
    expect((await trn.info(id)).status).to.equal(2); // FINISHED
  });

  it("splits the pool per the creator's payout structure (rejects bad splits)", async function () {
    const { carol, trn } = await loadFixture(setup);
    // split must sum to 10000
    await expect(trn.connect(carol).createTournament(E(1), 0, 3, 1000, 10, 20, 60, [6000, 3000])).to.be.revertedWithCustomError(trn, "BadParams");
    // valid 65/35 split
    await trn.connect(carol).createTournament(E(1), 0, 3, 1000, 10, 20, 60, [6500, 3500]);
    const info = await trn.info(0);
    expect(info.payoutBps.map(Number)).to.deep.equal([6500, 3500]);
  });

  it("refunds buy-in + sponsor on cancel", async function () {
    const { alice, carol, trn } = await loadFixture(setup);
    await trn.connect(carol).createTournament(E(5), E(0.5), 4, 1000, 10, 20, 60, [10000], { value: E(50) });
    await trn.connect(alice).register(0, { value: E(5.5) });
    const aliceBefore = await ethers.provider.getBalance(alice.address);
    await trn.connect(carol).cancel(0);
    // alice refunded buy-in + fee
    expect((await ethers.provider.getBalance(alice.address)) - aliceBefore).to.equal(E(5.5));
    expect((await trn.info(0)).status).to.equal(3); // CANCELLED
  });
});
