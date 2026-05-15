const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { mineN, deployCasino, provisionSeeds, REVEAL_DELAY } = require("./helpers");

describe("AgentQuorumVerifier", function () {
  async function setup() {
    const [owner, hm, alice] = await ethers.getSigners();
    const casino = await deployCasino(hm, ethers.parseEther("100"));
    await casino.connect(owner).setHouseManager(hm.address);
    const Mock = await ethers.getContractFactory("MockAgentPlatform");
    const platform = await Mock.deploy();
    await platform.waitForDeployment();
    const Verifier = await ethers.getContractFactory("AgentQuorumVerifier");
    const verifier = await Verifier.deploy(
      await casino.getAddress(),
      await platform.getAddress(),
      128472938475610293844n
    );
    await verifier.waitForDeployment();
    // make a settled bet
    const { seeds } = await provisionSeeds(casino, hm, 1);
    const cs = ethers.hexlify(ethers.randomBytes(32));
    await casino.connect(alice).placeDiceBet(50, true, cs, { value: ethers.parseEther("0.1") });
    await mineN(REVEAL_DELAY + 1n);
    await casino.connect(alice).revealAndSettle(0, seeds[0]);
    return { owner, alice, casino, platform, verifier };
  }

  async function fireCallbackAndGetEvent(verifier, platform) {
    const tx = await platform.triggerCallback(1);
    const r = await tx.wait();
    for (const log of r.logs) {
      try {
        const parsed = verifier.interface.parseLog(log);
        if (parsed && parsed.name === "QuorumResult") return parsed.args;
      } catch (_) {}
    }
    throw new Error("QuorumResult not emitted");
  }

  it("level=2 (ok) when 4/4 workers match on-chain randomness", async function () {
    const { alice, casino, platform, verifier } = await loadFixture(setup);
    const bet = await casino.getBet(0);
    await platform.setNextResponse(bet.randomness.slice(2));
    const price = await verifier.quotePrice();
    await verifier.connect(alice).requestVerification(0, { value: price });
    const args = await fireCallbackAndGetEvent(verifier, platform);
    expect(args.signers).to.equal(4);
    expect(args.totalWorkers).to.equal(4);
    expect(args.level).to.equal(2);
  });

  it("level=0 (critical) when no workers match", async function () {
    const { alice, platform, verifier } = await loadFixture(setup);
    await platform.setNextResponse("00".repeat(32));
    const price = await verifier.quotePrice();
    await verifier.connect(alice).requestVerification(0, { value: price });
    const args = await fireCallbackAndGetEvent(verifier, platform);
    expect(args.signers).to.equal(0);
    expect(args.level).to.equal(0);
  });

  it("accepts response with 0x prefix", async function () {
    const { alice, casino, platform, verifier } = await loadFixture(setup);
    const bet = await casino.getBet(0);
    await platform.setNextResponse(bet.randomness);
    const price = await verifier.quotePrice();
    await verifier.connect(alice).requestVerification(0, { value: price });
    const args = await fireCallbackAndGetEvent(verifier, platform);
    expect(args.signers).to.equal(4);
    expect(args.level).to.equal(2);
  });

  it("level=0 when status != SUCCESS regardless of agreement", async function () {
    const { alice, casino, platform, verifier } = await loadFixture(setup);
    const bet = await casino.getBet(0);
    await platform.setNextResponse(bet.randomness);
    await platform.setNextStatus(2); // FAILED_CONSENSUS
    const price = await verifier.quotePrice();
    await verifier.connect(alice).requestVerification(0, { value: price });
    const args = await fireCallbackAndGetEvent(verifier, platform);
    expect(args.level).to.equal(0);
    expect(Number(args.status)).to.equal(2);
  });

  it("rejects when bet not yet settled", async function () {
    const { alice, casino, verifier } = await loadFixture(setup);
    const [, hm] = await ethers.getSigners();
    await provisionSeeds(casino, hm, 1);
    const cs = ethers.hexlify(ethers.randomBytes(32));
    await casino.connect(alice).placeDiceBet(50, true, cs, { value: ethers.parseEther("0.1") });
    const price = await verifier.quotePrice();
    await expect(verifier.connect(alice).requestVerification(1, { value: price }))
      .to.be.revertedWithCustomError(verifier, "BetNotSettled");
  });

  it("rejects callback from non-platform", async function () {
    const { alice, verifier } = await loadFixture(setup);
    await expect(verifier.connect(alice).handleResponse(
      999,
      [],
      1,
      {
        agentId: 0,
        callbackAddress: ethers.ZeroAddress,
        callbackSelector: "0x00000000",
        payload: "0x",
        subcommitteeSize: 0,
        threshold: 0,
        consensusType: 0,
        timeout: 0,
        deposit: 0,
      }
    )).to.be.revertedWithCustomError(verifier, "WrongCaller");
  });

  it("refunds overpay", async function () {
    const { alice, casino, platform, verifier } = await loadFixture(setup);
    const bet = await casino.getBet(0);
    await platform.setNextResponse(bet.randomness);
    const price = await verifier.quotePrice();
    const overpay = ethers.parseEther("0.5");
    const balBefore = await ethers.provider.getBalance(alice.address);
    const tx = await verifier.connect(alice).requestVerification(0, { value: price + overpay });
    const r = await tx.wait();
    const gas = r.gasUsed * r.gasPrice;
    const balAfter = await ethers.provider.getBalance(alice.address);
    expect(balBefore - balAfter - gas).to.equal(price);
  });
});
