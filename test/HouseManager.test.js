const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployCasino, hashServerSeed, genServerSeed } = require("./helpers");

describe("HouseManager", function () {
  async function setup() {
    const [owner, hmAgent, alice] = await ethers.getSigners();
    const casino = await deployCasino(undefined, ethers.parseEther("100"));
    const HM = await ethers.getContractFactory("HouseManager");
    const hm = await HM.deploy(await casino.getAddress(), hmAgent.address);
    await hm.waitForDeployment();
    await casino.connect(owner).setHouseManager(await hm.getAddress());
    return { owner, hmAgent, alice, casino, hm };
  }

  it("only agent can call admin actions", async function () {
    const { hm, alice } = await loadFixture(setup);
    await expect(hm.connect(alice).pauseGame(0))
      .to.be.revertedWithCustomError(hm, "NotHmAgent");
    await expect(hm.connect(alice).setGameMaxBet(0, 1))
      .to.be.revertedWithCustomError(hm, "NotHmAgent");
    await expect(hm.connect(alice).activateBonusMode(60, "x"))
      .to.be.revertedWithCustomError(hm, "NotHmAgent");
    await expect(hm.connect(alice).recordReasoning("x"))
      .to.be.revertedWithCustomError(hm, "NotHmAgent");
  });

  it("agent forwards pauseGame / unpauseGame to Casino", async function () {
    const { hm, hmAgent, casino } = await loadFixture(setup);
    await hm.connect(hmAgent).pauseGame(0);
    expect(await casino.gamePaused(0)).to.equal(true);
    await hm.connect(hmAgent).unpauseGame(0);
    expect(await casino.gamePaused(0)).to.equal(false);
  });

  it("agent forwards setGameMaxBet (capped to 1% of free bankroll)", async function () {
    const { hm, hmAgent, casino } = await loadFixture(setup);
    // freeBankroll = 100 STT, so the on-chain cap is 1 STT regardless of
    // what HM requests. setGameMaxBet snaps the requested value down to
    // that cap rather than reverting — this is the safety rail the prompt
    // asked for (Section 10: "maxBet 10 STT при bankroll 9.94 STT" bug).
    await hm.connect(hmAgent).setGameMaxBet(0, ethers.parseEther("3"));
    expect(await casino.gameMaxBet(0)).to.equal(ethers.parseEther("1"));
    // Requesting below the cap goes through unchanged.
    await hm.connect(hmAgent).setGameMaxBet(0, ethers.parseEther("0.5"));
    expect(await casino.gameMaxBet(0)).to.equal(ethers.parseEther("0.5"));
  });

  it("agent forwards activateBonusMode + reasoning event", async function () {
    const { hm, hmAgent, casino } = await loadFixture(setup);
    await expect(hm.connect(hmAgent).activateBonusMode(60, "bankroll +12%"))
      .to.emit(casino, "BonusModeActivated");
    expect(await casino.bonusModeActive()).to.equal(true);
  });

  it("agent forwards recordReasoning", async function () {
    const { hm, hmAgent, casino } = await loadFixture(setup);
    await expect(hm.connect(hmAgent).recordReasoning("variance is high"))
      .to.emit(casino, "ReasoningLog");
  });

  it("agent provisions seeds via HM", async function () {
    const { hm, hmAgent, casino } = await loadFixture(setup);
    const hashes = [hashServerSeed(genServerSeed()), hashServerSeed(genServerSeed())];
    await hm.connect(hmAgent).provisionSeedHashes(hashes);
    const [total] = await casino.seedPoolStatus();
    expect(total).to.equal(2n);
  });

  it("owner can rotate agent key", async function () {
    const { hm, owner, alice } = await loadFixture(setup);
    await expect(hm.connect(owner).setHmAgent(alice.address))
      .to.emit(hm, "HmAgentUpdated");
    expect(await hm.hmAgent()).to.equal(alice.address);
  });

  it("non-owner cannot rotate agent key", async function () {
    const { hm, alice } = await loadFixture(setup);
    await expect(hm.connect(alice).setHmAgent(alice.address)).to.be.reverted;
  });

  it("snapshot exposes casino health", async function () {
    const { hm } = await loadFixture(setup);
    const s = await hm.snapshot();
    expect(s.freeBankroll).to.equal(ethers.parseEther("100"));
    expect(s.totalBets).to.equal(0n);
    expect(s.paused.length).to.equal(6);
    expect(s.maxBets.length).to.equal(6);
  });

  it("triggerThemeRotation forwards", async function () {
    const { hm, hmAgent, casino } = await loadFixture(setup);
    const symbols = ["a", "b", "c", "d", "e"];
    await hm.connect(hmAgent).triggerThemeRotation("Theme1", symbols);
    const [name] = await casino.getSlotsTheme();
    expect(name).to.equal("Theme1");
  });
});
