const { expect } = require("chai");
const { ethers, network } = require("hardhat");

describe("CasinoVault v15 — slots (VAULT.7 + SUGAR.LAB)", () => {
  let vault, loyalty, v7, cluster, owner, player;
  const seeds = [];
  const clientSeed = ethers.id("slot-client");

  beforeEach(async () => {
    [owner, player] = await ethers.getSigners();
    vault = await (await ethers.getContractFactory("CasinoVault")).deploy();
    loyalty = await (await ethers.getContractFactory("SlotLoyalty")).deploy();
    v7 = await (await ethers.getContractFactory("Vault7Module")).deploy(await vault.getAddress(), await loyalty.getAddress());
    cluster = await (await ethers.getContractFactory("ClusterModule")).deploy(await vault.getAddress(), await loyalty.getAddress());

    await vault.registerGame(2, await v7.getAddress(), ethers.parseEther("10000"));
    await vault.registerGame(6, await cluster.getAddress(), ethers.parseEther("10000"));
    await loyalty.setModule(await v7.getAddress(), true);
    await loyalty.setModule(await cluster.getAddress(), true);
    await vault.depositBankroll({ value: ethers.parseEther("200") });

    // plenty of seeds
    const hashes = [];
    for (let i = 0; i < 200; i++) {
      const s = ethers.id("slot-seed-" + i);
      seeds.push(s);
      hashes.push(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [s])));
    }
    await vault.provisionSeedHashes(hashes);
  });

  async function spinAndSettle(mod, stake, useFree = false) {
    const before = await mod.totalSpins();
    const betId = Number(before);
    await mod.connect(player).placeSpin(clientSeed, useFree, { value: useFree ? 0 : stake });
    await network.provider.send("evm_mine");
    const s = await mod.getSpin(betId);
    await mod.settleSpin(betId, seeds[Number(s.seedIdx)]);
    return await mod.getSpin(betId);
  }

  it("VAULT.7: a paid spin settles and pays within the cap", async () => {
    const stake = ethers.parseEther("0.1");
    const s = await spinAndSettle(v7, stake);
    expect(s.status).to.equal(1);
    const cap = (stake * 30000n) / 100n;
    expect(s.payout).to.be.lte(cap);
    expect(await vault.pendingWithdrawals(player.address)).to.equal(s.payout);
  });

  it("SUGAR.LAB: a paid spin settles and bumps the charge meter", async () => {
    const stake = ethers.parseEther("0.1");
    const s = await spinAndSettle(cluster, stake);
    expect(s.status).to.equal(1);
    const cm = await cluster.getChargeMeter(player.address);
    // either the meter advanced, or it triggered and reset with a reward
    expect(cm.current > 0n || cm.pendingReward > 0n).to.equal(true);
    expect(cm.threshold).to.be.gte(18000n);
    expect(cm.threshold).to.be.lte(30000n);
  });

  it("loyalty: 150 paid spins earn 5 free spins, shared across both slots", async () => {
    const stake = ethers.parseEther("0.001"); // == LOYALTY_MIN_STAKE
    // 75 spins on each game → 150 total on the SHARED counter
    for (let i = 0; i < 75; i++) {
      await v7.connect(player).placeSpin(clientSeed, false, { value: stake });
      await cluster.connect(player).placeSpin(clientSeed, false, { value: stake });
    }
    const st = await loyalty.getPlayerSlotState(player.address);
    expect(st.total).to.equal(150n);
    expect(st.earned).to.equal(5n);
    expect(await loyalty.available(player.address)).to.equal(5n);
  });

  it("free spin: takes no value, consumes a credit, can still pay", async () => {
    const stake = ethers.parseEther("0.001");
    for (let i = 0; i < 150; i++) {
      await v7.connect(player).placeSpin(clientSeed, false, { value: stake });
    }
    expect(await loyalty.available(player.address)).to.equal(5n);

    // a free spin must reject value
    await expect(
      v7.connect(player).placeSpin(clientSeed, true, { value: 1n })
    ).to.be.revertedWithCustomError(v7, "InvalidBet");

    const s = await spinAndSettle(v7, 0n, true);
    expect(s.freeSpin).to.equal(true);
    expect(s.amount).to.equal(ethers.parseEther("0.001")); // notional
    expect(await loyalty.available(player.address)).to.equal(4n);
    expect(s.status).to.equal(1);
  });

  it("free spin without a credit reverts", async () => {
    await expect(
      v7.connect(player).placeSpin(clientSeed, true)
    ).to.be.revertedWithCustomError(loyalty, "NoFreeSpins");
  });

  it("only authorized modules can touch loyalty state", async () => {
    await expect(
      loyalty.connect(player).recordSpin(player.address, ethers.parseEther("1"))
    ).to.be.revertedWithCustomError(loyalty, "NotAuthorized");
  });

  it("RTP boost is bounded so the house edge can never go negative", async () => {
    await expect(v7.setPayBoost(609)).to.be.reverted;      // over hard cap
    await expect(cluster.setPayBoost(357)).to.be.reverted;  // over hard cap
    await v7.setPayBoost(560);
    expect(await v7.reportedRtpBps()).to.equal(9107);
  });
});
