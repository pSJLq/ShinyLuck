const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { mineN, deployCasino, provisionSeeds, REVEAL_DELAY } = require("./helpers");

const PLINKO = 4;

describe("Casino — PlinkoGame", function () {
  async function setup() {
    const [owner, hm, alice, bob] = await ethers.getSigners();
    const casino = await deployCasino(hm, ethers.parseEther("100"));
    await casino.connect(owner).setHouseManager(hm.address);
    return { casino, owner, hm, alice, bob };
  }

  it("rejects invalid risk", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    await provisionSeeds(casino, hm, 1);
    const cs = ethers.hexlify(ethers.randomBytes(32));
    await expect(casino.connect(alice).placeplinkoBet(3, cs, { value: ethers.parseEther("0.01") }))
      .to.be.revertedWithCustomError(casino, "InvalidBet");
  });

  it("settles each risk level and slot index in [0,16]", async function () {
    const { casino, hm, alice, bob } = await loadFixture(setup);
    const { seeds } = await provisionSeeds(casino, hm, 3);
    const stake = ethers.parseEther("0.005");
    for (const risk of [0, 1, 2]) {
      const cs = ethers.hexlify(ethers.randomBytes(32));
      await casino.connect(alice).placeplinkoBet(risk, cs, { value: stake });
    }
    await mineN(REVEAL_DELAY + 1n);
    for (let i = 0; i < 3; i++) {
      const tx = await casino.connect(bob).revealAndSettle(i, seeds[i]);
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "BetSettled");
      const [path, slot, payX100] = ethers.AbiCoder.defaultAbiCoder().decode(
        ["uint16", "uint8", "uint32"], ev.args.resultData);
      expect(slot).to.be.lte(16);
      expect(payX100).to.be.gt(0n);
      expect(ev.args.payout).to.equal((stake * BigInt(payX100)) / 100n);
    }
  });

  it("payout table consistency: low risk slot 8 = 50 (centerpiece)", async function () {
    // We can't easily force a specific slot, but we can verify the table by
    // running enough rounds and checking that each emitted (slot, payX100) pair
    // matches what _plinkoPayoutAt would return.
    const { casino, hm, alice, bob } = await loadFixture(setup);
    const N = 10;
    const { seeds } = await provisionSeeds(casino, hm, N);
    const stake = ethers.parseEther("0.005");
    const lowTable = [1600, 900, 200, 140, 140, 120, 110, 100, 50, 100, 110, 120, 140, 140, 200, 900, 1600];
    for (let i = 0; i < N; i++) {
      const cs = ethers.hexlify(ethers.randomBytes(32));
      await casino.connect(alice).placeplinkoBet(0, cs, { value: stake });
    }
    await mineN(REVEAL_DELAY + 1n);
    for (let i = 0; i < N; i++) {
      const tx = await casino.connect(bob).revealAndSettle(i, seeds[i]);
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "BetSettled");
      const [, slot, payX100] = ethers.AbiCoder.defaultAbiCoder().decode(
        ["uint16", "uint8", "uint32"], ev.args.resultData);
      expect(payX100).to.equal(BigInt(lowTable[Number(slot)]));
    }
  });

  it("respects bankroll headroom for high-risk", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    await provisionSeeds(casino, hm, 1);
    const cs = ethers.hexlify(ethers.randomBytes(32));
    // Exposure model: a 1 ETH high-risk plinko bet has maxPayout ≈ 999 ETH,
    // far above maxExposureBps (20%) of the 100 ETH pool, so the per-bet
    // exposure cap rejects it (BetTooLarge).
    await expect(casino.connect(alice).placeplinkoBet(2, cs, { value: ethers.parseEther("1") }))
      .to.be.revertedWithCustomError(casino, "BetTooLarge");
  });
});
