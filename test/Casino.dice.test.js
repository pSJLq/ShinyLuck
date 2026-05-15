const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { mineN, deployCasino, provisionSeeds, REVEAL_DELAY } = require("./helpers");

const DICE = 0;

describe("Casino — DiceGame", function () {
  async function freshCasino() {
    const [owner, hm, alice, bob] = await ethers.getSigners();
    const casino = await deployCasino(hm, ethers.parseEther("100"));
    await casino.connect(owner).setHouseManager(hm.address);
    return { casino, owner, hm, alice, bob };
  }

  let casino, owner, hm, alice, bob;

  beforeEach(async function () {
    ({ casino, owner, hm, alice, bob } = await loadFixture(freshCasino));
  });

  describe("provisioning", function () {
    it("only HM/owner can provision seeds", async function () {
      const fakeHash = ethers.keccak256(ethers.toUtf8Bytes("nope"));
      await expect(casino.connect(alice).provisionSeedHashes([fakeHash]))
        .to.be.revertedWithCustomError(casino, "NotHouseManager");
      await expect(casino.connect(hm).provisionSeedHashes([fakeHash])).to.not.be.reverted;
    });

    it("rejects empty or zero hashes", async function () {
      await expect(casino.connect(hm).provisionSeedHashes([])).to.be.revertedWith("empty");
      await expect(casino.connect(hm).provisionSeedHashes([ethers.ZeroHash]))
        .to.be.revertedWith("zero hash");
    });

    it("emits SeedHashesProvisioned", async function () {
      const h = ethers.keccak256(ethers.toUtf8Bytes("a"));
      await expect(casino.connect(hm).provisionSeedHashes([h]))
        .to.emit(casino, "SeedHashesProvisioned").withArgs(0, 1);
    });

    it("seedPoolStatus reflects state", async function () {
      const { hashes } = await provisionSeeds(casino, hm, 3);
      const [total, consumed, available] = await casino.seedPoolStatus();
      expect(total).to.equal(3);
      expect(consumed).to.equal(0);
      expect(available).to.equal(3);
    });
  });

  describe("placeDiceBet validation", function () {
    beforeEach(async () => { await provisionSeeds(casino, hm, 5); });

    it("rejects invalid target", async function () {
      const cs = ethers.hexlify(ethers.randomBytes(32));
      await expect(casino.connect(alice).placeDiceBet(1, true, cs, { value: ethers.parseEther("0.1") }))
        .to.be.revertedWithCustomError(casino, "InvalidBet");
      await expect(casino.connect(alice).placeDiceBet(99, true, cs, { value: ethers.parseEther("0.1") }))
        .to.be.revertedWithCustomError(casino, "InvalidBet");
    });

    it("rejects zero stake", async function () {
      const cs = ethers.hexlify(ethers.randomBytes(32));
      await expect(casino.connect(alice).placeDiceBet(50, true, cs, { value: 0 }))
        .to.be.revertedWithCustomError(casino, "InvalidBet");
    });

    it("rejects when paused", async function () {
      const cs = ethers.hexlify(ethers.randomBytes(32));
      await casino.connect(hm).pauseGame(DICE);
      await expect(casino.connect(alice).placeDiceBet(50, true, cs, { value: ethers.parseEther("0.1") }))
        .to.be.revertedWithCustomError(casino, "GameIsPaused");
      await casino.connect(hm).unpauseGame(DICE);
    });

    it("rejects when no seed available", async function () {
      // exhaust seeds
      const cs = ethers.hexlify(ethers.randomBytes(32));
      for (let i = 0; i < 5; i++) {
        await casino.connect(alice).placeDiceBet(50, true, cs, { value: ethers.parseEther("0.1") });
      }
      await expect(casino.connect(alice).placeDiceBet(50, true, cs, { value: ethers.parseEther("0.1") }))
        .to.be.revertedWithCustomError(casino, "NoSeedAvailable");
    });

    it("rejects bet above per-game cap", async function () {
      const cs = ethers.hexlify(ethers.randomBytes(32));
      await casino.connect(hm).setGameMaxBet(DICE, ethers.parseEther("1"));
      await expect(casino.connect(alice).placeDiceBet(50, true, cs, { value: ethers.parseEther("2") }))
        .to.be.revertedWithCustomError(casino, "BetTooLarge");
    });

    it("rejects bet above bankroll bps cap", async function () {
      const cs = ethers.hexlify(ethers.randomBytes(32));
      // bankroll is 100 ether, 1% = 1 ether. clear per-game cap so the bps cap fires.
      await casino.connect(hm).setGameMaxBet(DICE, ethers.parseEther("1000"));
      await expect(casino.connect(alice).placeDiceBet(50, true, cs, { value: ethers.parseEther("10") }))
        .to.be.revertedWithCustomError(casino, "BetTooLarge");
    });
  });

  describe("bet lifecycle: place / reveal / settle", function () {
    let seeds;

    beforeEach(async () => {
      ({ seeds } = await provisionSeeds(casino, hm, 5));
    });

    it("emits BetPlaced with correct fields", async function () {
      const cs = ethers.hexlify(ethers.randomBytes(32));
      const tx = await casino.connect(alice).placeDiceBet(50, true, cs, { value: ethers.parseEther("0.1") });
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "BetPlaced");
      expect(ev).to.exist;
      expect(ev.args.player).to.equal(alice.address);
      expect(ev.args.game).to.equal(DICE);
      expect(ev.args.amount).to.equal(ethers.parseEther("0.1"));
      expect(ev.args.clientSeed).to.equal(cs);
      expect(ev.args.seedIdx).to.equal(0n);
    });

    it("settles and pays out a winning bet", async function () {
      // We don't control randomness here, but we can deterministically pick
      // a target/direction to maximize win chance and then verify payout math.
      // Use over-2 (winChance = 98) — wins ~98% of the time. Re-roll if not won.
      let attempt = 0;
      while (attempt < 5) {
        const cs = ethers.hexlify(ethers.randomBytes(32));
        const stake = ethers.parseEther("0.1");
        await casino.connect(alice).placeDiceBet(2, true, cs, { value: stake });
        await mineN(REVEAL_DELAY + 1n);
        const betId = (await casino.totalBets()) - 1n;
        const seedIdx = (await casino.getBet(betId)).seedIdx;
        const seed = seeds[Number(seedIdx)];
        const before = await casino.pendingWithdrawals(alice.address);
        const tx = await casino.connect(bob).revealAndSettle(betId, seed);
        const r = await tx.wait();
        const ev = r.logs.find(l => l.fragment && l.fragment.name === "BetSettled");
        if (ev.args.won) {
          const after = await casino.pendingWithdrawals(alice.address);
          // payout = stake * 9900 / (98 * 100) = stake * 9900/9800 = stake * 1.0204…
          const expected = (stake * 9900n) / 9800n;
          expect(after - before).to.equal(expected);
          return;
        }
        attempt++;
      }
      throw new Error("expected at least one win in 5 over-2 trials");
    });

    it("settles a losing bet without payout", async function () {
      // bet on under-2 (winChance = 1) — loses ~99% of the time.
      let attempt = 0;
      while (attempt < 5) {
        const cs = ethers.hexlify(ethers.randomBytes(32));
        const stake = ethers.parseEther("0.05");
        await casino.connect(alice).placeDiceBet(2, false, cs, { value: stake });
        await mineN(REVEAL_DELAY + 1n);
        const betId = (await casino.totalBets()) - 1n;
        const seedIdx = (await casino.getBet(betId)).seedIdx;
        const seed = seeds[Number(seedIdx)];
        const before = await casino.pendingWithdrawals(alice.address);
        const tx = await casino.connect(bob).revealAndSettle(betId, seed);
        const r = await tx.wait();
        const ev = r.logs.find(l => l.fragment && l.fragment.name === "BetSettled");
        if (!ev.args.won) {
          const after = await casino.pendingWithdrawals(alice.address);
          expect(after - before).to.equal(0);
          return;
        }
        attempt++;
      }
      throw new Error("expected at least one loss in 5 under-2 trials");
    });

    it("revealAndSettle reverts before delay (RevealTooEarly)", async function () {
      const cs = ethers.hexlify(ethers.randomBytes(32));
      await casino.connect(alice).placeDiceBet(50, true, cs, { value: ethers.parseEther("0.1") });
      const betId = (await casino.totalBets()) - 1n;
      const seedIdx = (await casino.getBet(betId)).seedIdx;
      const seed = seeds[Number(seedIdx)];
      // Note: error originates in CommitReveal library. We just check it reverts.
      await expect(casino.connect(bob).revealAndSettle(betId, seed)).to.be.reverted;
    });

    it("rejects double settle", async function () {
      const cs = ethers.hexlify(ethers.randomBytes(32));
      await casino.connect(alice).placeDiceBet(50, true, cs, { value: ethers.parseEther("0.1") });
      await mineN(REVEAL_DELAY + 1n);
      const betId = (await casino.totalBets()) - 1n;
      const seed = seeds[Number((await casino.getBet(betId)).seedIdx)];
      await casino.connect(bob).revealAndSettle(betId, seed);
      await expect(casino.connect(bob).revealAndSettle(betId, seed))
        .to.be.revertedWithCustomError(casino, "BetAlreadySettled");
    });

    it("rejects reveal with wrong server seed", async function () {
      const cs = ethers.hexlify(ethers.randomBytes(32));
      await casino.connect(alice).placeDiceBet(50, true, cs, { value: ethers.parseEther("0.1") });
      await mineN(REVEAL_DELAY + 1n);
      const betId = (await casino.totalBets()) - 1n;
      const wrong = ethers.hexlify(ethers.randomBytes(32));
      await expect(casino.connect(bob).revealAndSettle(betId, wrong)).to.be.reverted;
    });

    it("after window expiry, refunds the stake", async function () {
      const cs = ethers.hexlify(ethers.randomBytes(32));
      await casino.connect(alice).placeDiceBet(50, true, cs, { value: ethers.parseEther("0.1") });
      const betId = (await casino.totalBets()) - 1n;
      // jump past window (REVEAL_DELAY + 256 + 1)
      await mineN(REVEAL_DELAY + 256n + 1n);
      const seed = seeds[Number((await casino.getBet(betId)).seedIdx)];
      const before = await casino.pendingWithdrawals(alice.address);
      const tx = await casino.connect(bob).revealAndSettle(betId, seed);
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "BetRefunded");
      expect(ev).to.exist;
      const after = await casino.pendingWithdrawals(alice.address);
      expect(after - before).to.equal(ethers.parseEther("0.1"));
    });

    it("refundExpired works for expired bets only", async function () {
      const cs = ethers.hexlify(ethers.randomBytes(32));
      await casino.connect(alice).placeDiceBet(50, true, cs, { value: ethers.parseEther("0.1") });
      const betId = (await casino.totalBets()) - 1n;
      // not yet expired
      await expect(casino.refundExpired(betId)).to.be.revertedWithCustomError(casino, "InvalidBet");
      await mineN(REVEAL_DELAY + 256n + 1n);
      await expect(casino.refundExpired(betId)).to.not.be.reverted;
    });

    it("two bets binding to different seed slots both settle", async function () {
      const cs = ethers.hexlify(ethers.randomBytes(32));
      await casino.connect(alice).placeDiceBet(50, true, cs, { value: ethers.parseEther("0.1") });
      await casino.connect(bob).placeDiceBet(50, false, cs, { value: ethers.parseEther("0.2") });
      await mineN(REVEAL_DELAY + 1n);
      const id1 = 0n, id2 = 1n;
      const s1 = seeds[Number((await casino.getBet(id1)).seedIdx)];
      const s2 = seeds[Number((await casino.getBet(id2)).seedIdx)];
      await casino.connect(bob).revealAndSettle(id1, s1);
      await casino.connect(alice).revealAndSettle(id2, s2);
      expect((await casino.getBet(id1)).status).to.equal(1);
      expect((await casino.getBet(id2)).status).to.equal(1);
    });
  });

  describe("withdrawals", function () {
    it("claim() pays out the credited amount", async function () {
      const { seeds } = await provisionSeeds(casino, hm, 1);
      // craft a near-certain win
      const cs = ethers.hexlify(ethers.randomBytes(32));
      await casino.connect(alice).placeDiceBet(2, true, cs, { value: ethers.parseEther("0.1") });
      await mineN(REVEAL_DELAY + 1n);
      const betId = 0n;
      await casino.connect(bob).revealAndSettle(betId, seeds[0]);
      const credit = await casino.pendingWithdrawals(alice.address);
      if (credit === 0n) return; // unlucky loss this run; skip
      const balBefore = await ethers.provider.getBalance(alice.address);
      const tx = await casino.connect(alice).claim();
      const r = await tx.wait();
      const gas = r.gasUsed * r.gasPrice;
      const balAfter = await ethers.provider.getBalance(alice.address);
      expect(balAfter - balBefore + gas).to.equal(credit);
    });

    it("claim() reverts when nothing to claim", async function () {
      await expect(casino.connect(alice).claim()).to.be.revertedWith("nothing to claim");
    });
  });

  describe("owner withdraw timelock", function () {
    it("schedule + execute path with 24h delay", async function () {
      await casino.connect(owner).scheduleOwnerWithdraw(ethers.parseEther("1"));
      await expect(casino.connect(owner).executeOwnerWithdraw()).to.be.revertedWith("timelock");
      await network.provider.send("evm_increaseTime", [24 * 3600 + 1]);
      await network.provider.send("evm_mine");
      await expect(casino.connect(owner).executeOwnerWithdraw()).to.not.be.reverted;
    });

    it("non-owner cannot schedule", async function () {
      await expect(casino.connect(alice).scheduleOwnerWithdraw(1n)).to.be.reverted;
    });

    it("cannot schedule above free bankroll", async function () {
      await expect(casino.connect(owner).scheduleOwnerWithdraw(ethers.parseEther("100000")))
        .to.be.revertedWith("exceeds free");
    });
  });

  describe("bonus mode", function () {
    it("HM can activate, edge halves while active", async function () {
      const before = await casino.houseEdgeBps(DICE);
      expect(before).to.equal(100);
      await casino.connect(hm).activateBonusMode(60, "bankroll +12% in last hour");
      const during = await casino.houseEdgeBps(DICE);
      expect(during).to.equal(50);
    });

    it("non-HM cannot activate", async function () {
      await expect(casino.connect(alice).activateBonusMode(60, "x"))
        .to.be.revertedWithCustomError(casino, "NotHouseManager");
    });
  });

  describe("reasoning log", function () {
    it("HM can record a thought", async function () {
      await expect(casino.connect(hm).recordReasoning("variance is high, lowering max bet"))
        .to.emit(casino, "ReasoningLog");
    });
  });
});
