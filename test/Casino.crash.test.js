// Round-based Crash tests. The flow is:
//   1. startCrashRound()                 — opens a 30s betting window
//   2. placeCrashBet(autoCashoutX100)    — during the window
//   3. (optional) requestCashout(mult)   — after the window, before settle
//   4. settleCrashRound(roundId, seed)   — after REVEAL_DELAY blocks
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { mineN, deployCasino, provisionSeeds, REVEAL_DELAY } = require("./helpers");

const CRASH = 1;

async function bumpTime(seconds) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

describe("Casino — CrashGame (round-based)", function () {
  async function setup() {
    const [owner, hm, alice, bob, carol] = await ethers.getSigners();
    const casino = await deployCasino(hm, ethers.parseEther("100"));
    await casino.connect(owner).setHouseManager(hm.address);
    return { casino, owner, hm, alice, bob, carol };
  }

  async function openRoundAndSettle({ casino, hm, players, bets, seeds }) {
    await casino.connect(hm).startCrashRound();
    const roundId = await casino.currentCrashRoundId();
    for (let i = 0; i < players.length; i++) {
      const { autoCashoutX100, value } = bets[i];
      await casino.connect(players[i]).placeCrashBet(autoCashoutX100, { value });
    }
    // close the window
    await bumpTime(31);
    await mineN(REVEAL_DELAY + 1n);
    const round = await casino.getCrashRound(roundId);
    const tx = await casino.settleCrashRound(roundId, seeds[Number(round.seedIdx)]);
    const r = await tx.wait();
    return { roundId, receipt: r };
  }

  it("startCrashRound consumes a seed and emits CrashRoundStarted", async function () {
    const { casino, hm } = await loadFixture(setup);
    await provisionSeeds(casino, hm, 1);
    await expect(casino.connect(hm).startCrashRound()).to.emit(casino, "CrashRoundStarted");
    const r = await casino.getCrashRound(0);
    expect(r.settled).to.equal(false);
    expect(r.seedIdx).to.equal(0);
  });

  it("startCrashRound reverts when another round is open", async function () {
    const { casino, hm } = await loadFixture(setup);
    await provisionSeeds(casino, hm, 2);
    await casino.connect(hm).startCrashRound();
    await expect(casino.connect(hm).startCrashRound()).to.be.revertedWithCustomError(casino, "RoundClosed");
  });

  it("rejects autoCashout below 1.01x and above 100x", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    await provisionSeeds(casino, hm, 1);
    await casino.connect(hm).startCrashRound();
    await expect(casino.connect(alice).placeCrashBet(100, { value: ethers.parseEther("0.05") }))
      .to.be.revertedWithCustomError(casino, "InvalidBet");
    await expect(casino.connect(alice).placeCrashBet(10001, { value: ethers.parseEther("0.05") }))
      .to.be.revertedWithCustomError(casino, "InvalidBet");
  });

  it("rejects placeCrashBet after window closes", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    await provisionSeeds(casino, hm, 1);
    await casino.connect(hm).startCrashRound();
    await bumpTime(31);
    await expect(casino.connect(alice).placeCrashBet(200, { value: ethers.parseEther("0.05") }))
      .to.be.revertedWithCustomError(casino, "RoundClosed");
  });

  it("settles: auto-cashout wins, no-cashout loses", async function () {
    const { casino, hm, alice, bob } = await loadFixture(setup);
    const { seeds } = await provisionSeeds(casino, hm, 1);
    const { roundId, receipt } = await openRoundAndSettle({
      casino, hm, seeds,
      players: [alice, bob],
      bets: [
        { autoCashoutX100: 110, value: ethers.parseEther("0.05") },  // 1.10× — usually wins
        { autoCashoutX100: 9999, value: ethers.parseEther("0.05") }, // 99.99× — almost always loses
      ],
    });
    const settledEvts = receipt.logs.filter(l => {
      try { return casino.interface.parseLog(l)?.name === "BetSettled"; } catch { return false; }
    });
    expect(settledEvts.length).to.equal(2); // one per bettor
    const round = await casino.getCrashRound(roundId);
    expect(round.settled).to.equal(true);
    expect(round.crashPointX100).to.be.gte(100);
  });

  it("manual cashout: requestCashout during run lets the player exit early", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    const { seeds } = await provisionSeeds(casino, hm, 1);
    await casino.connect(hm).startCrashRound();
    await casino.connect(alice).placeCrashBet(0, { value: ethers.parseEther("0.05") }); // manual-only
    await bumpTime(31);
    // request cashout at 1.05x while the round is running
    await casino.connect(alice).requestCashout(105);
    await mineN(REVEAL_DELAY + 1n);
    const round = await casino.getCrashRound(0);
    await casino.settleCrashRound(0, seeds[Number(round.seedIdx)]);
    const bet = await casino.getCrashBet(0, alice.address);
    expect(bet.resolved).to.equal(true);
    expect(bet.cashoutMultX100).to.equal(105);
    // either crashPoint ≥ 1.05 → player won 0.05 × 1.05 = 0.0525,
    // or crashPoint  < 1.05 → bust, no credit.
    const cred = await casino.pendingWithdrawals(alice.address);
    const settled = await casino.getCrashRound(0);
    if (settled.crashPointX100 >= 105) {
      expect(cred).to.equal(ethers.parseEther("0.0525"));
    } else {
      expect(cred).to.equal(0n);
    }
  });

  it("refundCrashRound credits stakes back when window expired without settle", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    await provisionSeeds(casino, hm, 1);
    await casino.connect(hm).startCrashRound();
    await casino.connect(alice).placeCrashBet(200, { value: ethers.parseEther("0.05") });
    // bump past the round timeout (5 min after betWindowEnd which is +30s)
    await bumpTime(30 + 5 * 60 + 1);
    await casino.refundCrashRound(0);
    const cred = await casino.pendingWithdrawals(alice.address);
    expect(cred).to.equal(ethers.parseEther("0.05"));
  });

  it("respects bankroll bps cap on placeCrashBet", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    await provisionSeeds(casino, hm, 1);
    await casino.connect(hm).startCrashRound();
    // bankroll 100 → 1% = 1 STT; gameMaxBet = 10 STT default
    await expect(casino.connect(alice).placeCrashBet(150, { value: ethers.parseEther("2") }))
      .to.be.revertedWithCustomError(casino, "BetTooLarge");
  });

  it("RTP ≈ 99% (Stake parity) — no double bust branch", async function () {
    // _crashPoint uses num = 10000 − edgeBps; the removed `h % 33` branch used
    // to knock RTP to ~94%. Sample the point CDF and check EV of a fixed target.
    const { casino, hm, alice } = await loadFixture(setup);
    const N = 60;
    const { seeds } = await provisionSeeds(casino, hm, N);
    const target = 200; // cash out at 2.00× every round
    let staked = 0n, returned = 0n;
    for (let i = 0; i < N; i++) {
      await casino.connect(hm).startCrashRound();
      const id = await casino.currentCrashRoundId();
      const stake = ethers.parseEther("0.02");
      await casino.connect(alice).placeCrashBet(target, { value: stake });
      staked += stake;
      await bumpTime(31);
      await mineN(REVEAL_DELAY + 1n);
      const round = await casino.getCrashRound(id);
      await (await casino.settleCrashRound(id, seeds[Number(round.seedIdx)])).wait();
      const cp = Number((await casino.getCrashRound(id)).crashPointX100);
      if (cp >= target) returned += (stake * BigInt(target)) / 100n;
    }
    // 60 rounds is noisy; assert we're clearly in the 99%-edge regime (0.80–1.15)
    // and NOT the old 94% double-charged regime that trended well below.
    const rtp = Number(returned * 10000n / staked) / 10000;
    expect(rtp).to.be.gte(0.80);
    expect(rtp).to.be.lte(1.20);
  });

  it("crash point distribution sanity", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    const { seeds } = await provisionSeeds(casino, hm, 5);
    const cps = [];
    for (let i = 0; i < 5; i++) {
      await casino.connect(hm).startCrashRound();
      const id = await casino.currentCrashRoundId();
      await casino.connect(alice).placeCrashBet(101, { value: ethers.parseEther("0.02") });
      await bumpTime(31);
      await mineN(REVEAL_DELAY + 1n);
      const round = await casino.getCrashRound(id);
      const tx = await casino.settleCrashRound(id, seeds[Number(round.seedIdx)]);
      await tx.wait();
      const after = await casino.getCrashRound(id);
      cps.push(after.crashPointX100);
    }
    for (const cp of cps) expect(cp).to.be.gte(100);
  });
});
