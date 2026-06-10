const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, mine } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { tickTable, newState } = require("../scripts/lib/poker-dealer");

const CHECK = 1, CALL = 2;
const E = (n) => ethers.parseEther(String(n));
const MASTER = ethers.id("poker-test-master");

describe("Dealer bot — drives a full hand autonomously", function () {
  async function setup() {
    const [owner, operator, alice, bob] = await ethers.getSigners();
    const Room = await ethers.getContractFactory("PokerRoom");
    const poker = await Room.deploy(owner.address);
    await poker.waitForDeployment();
    const Dealer = await ethers.getContractFactory("CommitRevealDealer");
    const dealer = await Dealer.deploy(owner.address);
    await dealer.waitForDeployment();
    await dealer.connect(owner).setRoom(await poker.getAddress());
    await dealer.connect(owner).setDealerBot(operator.address);
    await poker.connect(owner).setDealer(await dealer.getAddress());
    await poker.connect(owner).setDealerOperator(operator.address);
    await poker.connect(owner).createTable({
      maxSeats: 2, smallBlind: E(1), bigBlind: E(2), ante: 0,
      minBuyIn: E(40), maxBuyIn: E(200), rakeBps: 250, rakeCap: E(3), actionTimeout: 30, active: true,
    });
    for (const [s, sgn] of [[0, alice], [1, bob]]) {
      await poker.connect(sgn).deposit({ value: E(100) });
      await poker.connect(sgn).sitDown(0, s, E(100));
    }
    return { owner, operator, alice, bob, poker, dealer };
  }

  it("starts, locks entropy, reveals the board, and settles showdown", async function () {
    const { operator, alice, bob, poker, dealer } = await loadFixture(setup);
    const t = 0;
    const botRoom = poker.connect(operator);
    const botDealer = dealer.connect(operator);
    const state = newState();
    const sgn = [alice, bob];

    let settled = false;
    let sawHand = false;
    for (let iter = 0; iter < 60 && !settled; iter++) {
      const tag = await tickTable(botRoom, botDealer, MASTER, state, t, { timeoutGrace: 99999, showdownMs: 0 });
      const h = await poker.getHand(t);
      if (h.inProgress) {
        sawHand = true;
        if (Number(h.street) <= 3) {
          // it's a player's turn — call if they owe, else check
          const seat = Number(h.actingSeat);
          const sh = await poker.getSeatHand(t, seat);
          const owe = h.currentBet > sh.committedStreet;
          await poker.connect(sgn[seat]).act(t, owe ? CALL : CHECK, 0);
        }
      } else if (sawHand) {
        settled = tag === "settled" || true; // hand cleared
      }
      await mine(1);
    }

    expect(sawHand).to.equal(true);
    expect((await poker.getHand(t)).inProgress).to.equal(false);
    // the dealer revealed all five board cards and proved the deck
    expect(await dealer.boardRevealedCount(1)).to.equal(5);
    expect(await dealer.isShowdownReady(1)).to.equal(true);
    // chips conserved: both stacks + rake == total bought in
    const s0 = (await poker.getSeat(t, 0)).stack;
    const s1 = (await poker.getSeat(t, 1)).stack;
    expect(s0 + s1 + (await poker.rakeCollected())).to.equal(E(200));
  });
});
