const { expect } = require("chai");
const { ethers, network } = require("hardhat");

function crashPoint(randomness) {
  const e = 1n << 52n;
  const h = BigInt(randomness) % e;
  const cp = ((10000n - 100n) * e) / (100n * (e - h));
  return cp < 100n ? 100n : cp;
}
async function mineAndWarp(seconds) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

describe("CasinoVault v15 — round games", () => {
  let vault, crash, roulette, owner, p1, p2, p3;
  const serverSeed = ethers.id("round-server");
  const seedHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [serverSeed]));

  beforeEach(async () => {
    [owner, p1, p2, p3] = await ethers.getSigners();
    vault = await (await ethers.getContractFactory("CasinoVault")).deploy();
    crash = await (await ethers.getContractFactory("CrashModule")).deploy(await vault.getAddress());
    roulette = await (await ethers.getContractFactory("RouletteModule")).deploy(await vault.getAddress());
    await vault.registerGame(1, await crash.getAddress(), ethers.parseEther("1000"));
    await vault.registerGame(5, await roulette.getAddress(), ethers.parseEther("1000"));
    await vault.depositBankroll({ value: ethers.parseEther("500") });
    await vault.provisionSeedHashes([seedHash, seedHash]);
  });

  describe("Crash", () => {
    it("ONE settle serves every player in the round (scalability)", async () => {
      await crash.startRound();
      const stake = ethers.parseEther("0.1");
      // three players, different auto-cashout targets
      await crash.connect(p1).placeBet(150, { value: stake }); // 1.5x
      await crash.connect(p2).placeBet(500, { value: stake }); // 5x
      await crash.connect(p3).placeBet(0, { value: stake });   // manual only, never cashes
      const r = await crash.getRound(0);
      expect(r.bettorCount).to.equal(3);

      await mineAndWarp(20);
      const blockHash = (await ethers.provider.getBlock(Number(r.commitBlock) + 1)).hash;
      // single settle call for all three
      await crash.settleRound(0, serverSeed);

      // roundId is uint64 in the struct → packs as 8 bytes, not 32.
      const randomness = ethers.keccak256(
        ethers.solidityPacked(["bytes32", "bytes32", "uint64"], [serverSeed, blockHash, 0n])
      );
      const cp = crashPoint(randomness);

      for (const [p, target] of [[p1, 150n], [p2, 500n], [p3, 0n]]) {
        const expected = target > 0n && target <= cp ? (stake * target) / 100n : 0n;
        expect(await vault.pendingWithdrawals(p.address)).to.equal(expected);
      }
      const settled = await crash.getRound(0);
      expect(settled.settled).to.equal(true);
      expect(settled.crashPointX100).to.equal(cp > 65535n ? 65535n : cp);
    });

    it("refunds every bettor if the round times out", async () => {
      await crash.startRound();
      const stake = ethers.parseEther("0.1");
      await crash.connect(p1).placeBet(200, { value: stake });
      await crash.connect(p2).placeBet(200, { value: stake });
      await mineAndWarp(6 * 60); // past ROUND_TIMEOUT
      await crash.refundRound(0);
      expect(await vault.pendingWithdrawals(p1.address)).to.equal(stake);
      expect(await vault.pendingWithdrawals(p2.address)).to.equal(stake);
    });

    it("rejects a second bet from the same player in one round", async () => {
      await crash.startRound();
      const stake = ethers.parseEther("0.1");
      await crash.connect(p1).placeBet(200, { value: stake });
      await expect(crash.connect(p1).placeBet(300, { value: stake }))
        .to.be.revertedWithCustomError(crash, "InvalidBet");
    });
  });

  describe("Roulette", () => {
    it("settles a multi-bet round with v14-identical wheel math", async () => {
      await roulette.startRound();
      const stake = ethers.parseEther("0.05");
      // p1 covers RED + EVEN; p2 takes a straight-up number
      await roulette.connect(p1).placeBets(
        [{ kind: 1, number: 0, amount: stake }, { kind: 3, number: 0, amount: stake }],
        { value: stake * 2n }
      );
      await roulette.connect(p2).placeBets(
        [{ kind: 0, number: 17, amount: stake }],
        { value: stake }
      );

      const r = await roulette.getRound(0);
      await mineAndWarp(20);
      const blockHash = (await ethers.provider.getBlock(Number(r.commitBlock) + 1)).hash;
      await roulette.settleRound(0, serverSeed);

      const randomness = ethers.keccak256(
        ethers.solidityPacked(["bytes32", "bytes32", "uint64"], [serverSeed, blockHash, 0n])
      );
      const result = Number(BigInt(randomness) % 38n);

      const RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
      const outside = result !== 0 && result !== 37;
      let p1Expected = 0n;
      if (outside && RED.has(result)) p1Expected += stake * 2n;      // RED pays 2x
      if (outside && result % 2 === 0) p1Expected += stake * 2n;      // EVEN pays 2x
      const p2Expected = result === 17 ? stake * 36n : 0n;            // STRAIGHT pays 36x

      expect(await vault.pendingWithdrawals(p1.address)).to.equal(p1Expected);
      expect(await vault.pendingWithdrawals(p2.address)).to.equal(p2Expected);
      expect((await roulette.getRound(0)).resultNumber).to.equal(result);
    });

    it("enforces the 5-bet-per-player cap and value sum", async () => {
      await roulette.startRound();
      const stake = ethers.parseEther("0.01");
      const six = Array.from({ length: 6 }, () => ({ kind: 1, number: 0, amount: stake }));
      await expect(roulette.connect(p1).placeBets(six, { value: stake * 6n }))
        .to.be.revertedWithCustomError(roulette, "TooManyBets");
      await expect(
        roulette.connect(p1).placeBets([{ kind: 1, number: 0, amount: stake }], { value: stake * 2n })
      ).to.be.revertedWithCustomError(roulette, "InvalidBet");
    });
  });
});
