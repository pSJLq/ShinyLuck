const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const FOLD = 0, CHECK = 1, CALL = 2, BET = 3, RAISE = 4, ALLIN = 5;
const E = (n) => ethers.parseEther(String(n));
const R = { "2": 0, "3": 1, "4": 2, "5": 3, "6": 4, "7": 5, "8": 6, "9": 7, T: 8, J: 9, Q: 10, K: 11, A: 12 };
const S = { c: 0, d: 1, h: 2, s: 3 };
const card = (str) => R[str[0]] * 4 + S[str[1]];

function tableCfg(over = {}) {
  return {
    maxSeats: over.maxSeats ?? 6,
    smallBlind: E(1),
    bigBlind: E(2),
    ante: 0,
    minBuyIn: over.minBuyIn ?? E(40),
    maxBuyIn: E(200),
    rakeBps: over.rakeBps ?? 250,
    rakeCap: over.rakeCap ?? E(3),
    actionTimeout: 30,
    active: true,
  };
}

describe("PokerRoom — showdown distribution", function () {
  async function setup() {
    const [owner, operator, alice, bob, carol] = await ethers.getSigners();
    const Room = await ethers.getContractFactory("PokerRoom");
    const poker = await Room.deploy(owner.address);
    await poker.waitForDeployment();
    const Dealer = await ethers.getContractFactory("MockPokerDealer");
    const dealer = await Dealer.deploy();
    await dealer.waitForDeployment();
    await poker.connect(owner).setDealer(await dealer.getAddress());
    await poker.connect(owner).setDealerOperator(operator.address);
    return { owner, operator, alice, bob, carol, poker, dealer };
  }

  async function makeTable(poker, owner, cfg) {
    await poker.connect(owner).createTable(cfg);
    return Number((await poker.tableCount()) - 1n);
  }
  async function buyIn(poker, signer, t, seat, amount) {
    await poker.connect(signer).deposit({ value: amount });
    await poker.connect(signer).sitDown(t, seat, amount);
  }
  const actingSeat = async (poker, t) => Number((await poker.getHand(t)).actingSeat);
  const stack = async (poker, t, s) => (await poker.getSeat(t, s)).stack;

  async function reveal(dealer, dealId, board, holes) {
    await dealer.setBoard(dealId, board.map(card));
    for (const [seat, cs] of Object.entries(holes)) {
      await dealer.setHole(dealId, seat, card(cs[0]), card(cs[1]));
    }
    await dealer.setReady(dealId, true);
  }

  it("heads-up: better hand wins the pot minus rake", async function () {
    const { owner, operator, alice, bob, poker, dealer } = await loadFixture(setup);
    const t = await makeTable(poker, owner, tableCfg({ maxSeats: 2 }));
    await buyIn(poker, alice, t, 0, E(100));
    await buyIn(poker, bob, t, 1, E(100));
    await poker.connect(operator).startHand(t);
    const dealId = (await poker.getHand(t)).dealId;
    const sgn = [alice, bob];

    // preflop: alice (SB/button) calls, bob (BB) checks
    await poker.connect(alice).act(t, CALL, 0);
    await poker.connect(bob).act(t, CHECK, 0);
    // flop/turn/river: check it down
    for (let street = 0; street < 3; street++) {
      for (let i = 0; i < 2; i++) {
        const s = await actingSeat(poker, t);
        await poker.connect(sgn[s]).act(t, CHECK, 0);
      }
    }
    expect(Number((await poker.getHand(t)).street)).to.equal(4); // SHOWDOWN, pot 4

    // alice pair of aces beats bob's high card
    await reveal(dealer, dealId, ["2c", "7d", "9h", "Js", "Ks"], { 0: ["Ac", "Ad"], 1: ["3c", "4d"] });
    const tx = await poker.resolveShowdown(t);
    await expect(tx).to.emit(poker, "PotWinner").withArgs(t, 1, 0, 0, E("3.9"));
    await expect(tx).to.emit(poker, "ShowdownSettled").withArgs(t, 1, E("0.1"));

    expect(await stack(poker, t, 0)).to.equal(E("101.9")); // 100 - 2 + 3.9
    expect(await stack(poker, t, 1)).to.equal(E(98)); // 100 - 2
    expect(await poker.rakeCollected()).to.equal(E("0.1"));
    expect((await poker.getHand(t)).inProgress).to.equal(false);
  });

  it("three-way all-in builds correct main/side pots and an uncalled overlay", async function () {
    const { owner, operator, alice, bob, carol, poker, dealer } = await loadFixture(setup);
    // allow small stacks so we get layered all-ins
    const t = await makeTable(poker, owner, tableCfg({ minBuyIn: E(10) }));
    await buyIn(poker, alice, t, 0, E(100));
    await buyIn(poker, bob, t, 1, E(40));
    await buyIn(poker, carol, t, 2, E(20));
    await poker.connect(operator).startHand(t);
    const dealId = (await poker.getHand(t)).dealId;

    // seat0 (button) shoves 100; seat1 (SB,40) and seat2 (BB,20) call all-in short
    await poker.connect(alice).act(t, ALLIN, 0);
    await poker.connect(bob).act(t, ALLIN, 0);
    await poker.connect(carol).act(t, ALLIN, 0);
    expect(Number((await poker.getHand(t)).street)).to.equal(4); // ran out to SHOWDOWN

    // Ranking carol(AA) > alice(KK) > bob(high) on board 2c 7d 9h Js Ks:
    //   main pot (all three, 60)        -> carol
    //   side pot (alice & bob, 40)      -> alice
    //   overlay (alice only, 60)        -> returned to alice, unraked
    await reveal(dealer, dealId, ["2c", "7d", "9h", "Js", "Ks"], {
      0: ["Kc", "Qc"], // alice: pair of kings (Ks on board)
      1: ["3d", "4h"], // bob: high card
      2: ["Ac", "Ah"], // carol: pair of aces
    });
    await poker.resolveShowdown(t);

    // rake: main 60*2.5%=1.5, side 40*2.5%=1.0, overlay unraked → total 2.5
    expect(await poker.rakeCollected()).to.equal(E("2.5"));
    // carol: main 60 - 1.5 = 58.5 ; alice: side 39 + overlay 60 = 99 ; bob: 0
    expect(await stack(poker, t, 0)).to.equal(E("99"));
    expect(await stack(poker, t, 1)).to.equal(E("0"));
    expect(await stack(poker, t, 2)).to.equal(E("58.5"));
  });

  it("splits a tied pot, with the odd chip going left of the button", async function () {
    const { owner, operator, alice, bob, poker, dealer } = await loadFixture(setup);
    const t = await makeTable(poker, owner, tableCfg({ maxSeats: 2, rakeBps: 0, rakeCap: 0 }));
    await buyIn(poker, alice, t, 0, E(100));
    await buyIn(poker, bob, t, 1, E(100));
    await poker.connect(operator).startHand(t);
    const dealId = (await poker.getHand(t)).dealId;
    const sgn = [alice, bob];

    await poker.connect(alice).act(t, CALL, 0);
    await poker.connect(bob).act(t, CHECK, 0);
    for (let street = 0; street < 3; street++) {
      for (let i = 0; i < 2; i++) {
        const s = await actingSeat(poker, t);
        await poker.connect(sgn[s]).act(t, CHECK, 0);
      }
    }
    // both play the board (royal flush) → chop pot of 4, no rake
    await reveal(dealer, dealId, ["As", "Ks", "Qs", "Js", "Ts"], { 0: ["2c", "3d"], 1: ["4c", "5d"] });
    await poker.resolveShowdown(t);
    expect(await stack(poker, t, 0)).to.equal(E("100")); // 98 + 2
    expect(await stack(poker, t, 1)).to.equal(E("100")); // 98 + 2
    expect(await poker.rakeCollected()).to.equal(0);
  });
});
