const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, mine } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const CHECK = 1, CALL = 2;
const E = (n) => ethers.parseEther(String(n));
const seedHash = (seed) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [seed]));

function tableCfg() {
  return {
    maxSeats: 2,
    smallBlind: E(1),
    bigBlind: E(2),
    ante: 0,
    minBuyIn: E(40),
    maxBuyIn: E(200),
    rakeBps: 250,
    rakeCap: E(3),
    actionTimeout: 30,
    active: true,
  };
}

describe("CommitRevealDealer — provably-fair deal, integrated with the engine", function () {
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

    // Provision a batch of server-seed commitments (as the bot would, in advance).
    const seeds = Array.from({ length: 5 }, () => ethers.hexlify(ethers.randomBytes(32)));
    await dealer.connect(owner).provisionSeedHashes(seeds.map(seedHash));
    return { owner, operator, alice, bob, poker, dealer, seeds };
  }

  it("derives a valid 52-card deck and the board/holes match it; chips conserved", async function () {
    const { owner, operator, alice, bob, poker, dealer, seeds } = await loadFixture(setup);
    await poker.connect(owner).createTable(tableCfg());
    const t = 0;
    for (const [s, sgn] of [[0, alice], [1, bob]]) {
      await poker.connect(sgn).deposit({ value: E(100) });
      await poker.connect(sgn).sitDown(t, s, E(100));
    }

    await poker.connect(operator).startHand(t);
    const dealId = (await poker.getHand(t)).dealId;
    expect(dealId).to.equal(1n);

    // bot locks the future-blockhash entropy right after the hand starts
    await mine(2);
    await dealer.connect(operator).lockEntropy(dealId);

    // play it down to showdown (players act mechanically here)
    const sgn = [alice, bob];
    await poker.connect(alice).act(t, CALL, 0);
    await poker.connect(bob).act(t, CHECK, 0);
    for (let street = 0; street < 3; street++) {
      for (let i = 0; i < 2; i++) {
        const s = Number((await poker.getHand(t)).actingSeat);
        await poker.connect(sgn[s]).act(t, CHECK, 0);
      }
    }
    expect(Number((await poker.getHand(t)).street)).to.equal(4); // SHOWDOWN

    // reveal the seed → on-chain deck derivation
    await dealer.connect(operator).revealSeed(dealId, seeds[0]);
    expect(await dealer.isShowdownReady(dealId)).to.equal(true);

    // recompute the deck off the revealed metadata and cross-check exposed cards
    const info = await dealer.dealInfo(dealId);
    const deck = (await dealer.recomputeDeck(seeds[0], info.entropy, info.handId, info.tableId)).map(Number);
    // valid permutation of 0..51
    expect(new Set(deck).size).to.equal(52);
    expect(Math.min(...deck)).to.equal(0);
    expect(Math.max(...deck)).to.equal(51);

    const k = 2;
    const [h0a, h0b] = (await dealer.holeCards(dealId, 0)).map(Number);
    const [h1a, h1b] = (await dealer.holeCards(dealId, 1)).map(Number);
    expect([h0a, h0b]).to.deep.equal([deck[0], deck[k + 0]]);
    expect([h1a, h1b]).to.deep.equal([deck[1], deck[k + 1]]);
    const board = (await dealer.boardCards(dealId)).map(Number);
    expect(board).to.deep.equal(deck.slice(2 * k, 2 * k + 5));

    // settle and verify chip conservation: nothing created or destroyed
    await poker.resolveShowdown(t);
    const s0 = await (await poker.getSeat(t, 0)).stack;
    const s1 = await (await poker.getSeat(t, 1)).stack;
    const rake = await poker.rakeCollected();
    expect(s0 + s1 + rake).to.equal(E(200));
    expect((await poker.getHand(t)).inProgress).to.equal(false);
  });

  it("rejects a tampered board at reveal", async function () {
    const { owner, operator, alice, bob, poker, dealer, seeds } = await loadFixture(setup);
    await poker.connect(owner).createTable(tableCfg());
    const t = 0;
    for (const [s, sgn] of [[0, alice], [1, bob]]) {
      await poker.connect(sgn).deposit({ value: E(100) });
      await poker.connect(sgn).sitDown(t, s, E(100));
    }
    await poker.connect(operator).startHand(t);
    const dealId = (await poker.getHand(t)).dealId;
    await mine(2);
    await dealer.connect(operator).lockEntropy(dealId);

    // bot posts a bogus flop (all aces-ish nonsense) then tries to reveal
    await dealer.connect(operator).revealBoard(dealId, 3, [0, 1, 2, 0, 0]);
    await expect(dealer.connect(operator).revealSeed(dealId, seeds[0])).to.be.revertedWithCustomError(
      dealer,
      "BoardMismatch"
    );
  });
});
