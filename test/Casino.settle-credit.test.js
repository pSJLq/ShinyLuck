const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { mineN, deployCasino, provisionSeeds, REVEAL_DELAY } = require("./helpers");

/* Regression for the won-flag credit bug (found 2026-07-18 on testnet).
 *
 * Slots/plinko mark `won = payout >= stake` - a DISPLAY notion (did the spin
 * profit). The settle used to gate the credit on that flag, so every payout
 * BELOW the stake (an ordinary sub-1x line hit) was published in BetSettled,
 * shown as "+X" by the game UI, and then simply kept by the house: nothing
 * reached pendingWithdrawals. Measured on the live casino before the fix:
 * 77 of 300 settles shorted, 3.55 STT withheld.
 *
 * The invariant this file pins down: EVERY settled payout > 0 credits
 * pendingWithdrawals by exactly that amount, whatever `won` says. */
describe("Casino — settle credits every payout (won is display-only)", function () {
  async function setup() {
    const [owner, hm, alice, bob] = await ethers.getSigners();
    const casino = await deployCasino(hm, ethers.parseEther("100"));
    await casino.connect(owner).setHouseManager(hm.address);
    return { casino, owner, hm, alice, bob };
  }

  it("slots: every payout lands in pendingWithdrawals, including sub-stake ones", async function () {
    const { casino, hm, alice, bob } = await loadFixture(setup);
    const N = 40;
    const { seeds } = await provisionSeeds(casino, hm, N);
    const stake = ethers.parseEther("0.05");

    let subStakeSeen = 0, paidSeen = 0;
    for (let i = 0; i < N; i++) {
      const cs = ethers.hexlify(ethers.randomBytes(32));
      await casino.connect(alice).placeSlotsBet(cs, false, { value: stake });
      await mineN(REVEAL_DELAY + 1n);

      const before = await casino.pendingWithdrawals(alice.address);
      const r = await (await casino.connect(bob).revealAndSettle(i, seeds[i])).wait();
      const ev = r.logs.find((l) => l.fragment && l.fragment.name === "BetSettled");
      const after = await casino.pendingWithdrawals(alice.address);

      // the pinned invariant: credit == published payout, always
      expect(after - before).to.equal(ev.args.payout);

      if (ev.args.payout > 0n) {
        paidSeen++;
        if (ev.args.payout < stake) {
          subStakeSeen++;
          // the exact scenario the bug swallowed: paid, below stake, won=false
          expect(ev.args.won).to.equal(false);
        }
      }
    }

    // The run must actually exercise the regression path. Sub-1x hits make up
    // roughly a quarter of real settles - 40 spins virtually guarantee one.
    expect(paidSeen, "no paying spins in the run - raise N").to.be.gte(1);
    expect(subStakeSeen, "no sub-stake payout in the run - raise N").to.be.gte(1);
  });

  it("free spin: zero-stake payout still credits", async function () {
    const { casino, hm, alice, bob } = await loadFixture(setup);
    const N = 30;
    const { seeds } = await provisionSeeds(casino, hm, N);
    const stake = ethers.parseEther("0.05");

    // earn free spins by spinning (every FREE_SPIN_EVERY-th spin grants some)
    for (let i = 0; i < N - 1; i++) {
      const cs = ethers.hexlify(ethers.randomBytes(32));
      await casino.connect(alice).placeSlotsBet(cs, false, { value: stake });
      await mineN(REVEAL_DELAY + 1n);
      await casino.connect(bob).revealAndSettle(i, seeds[i]);
      if ((await casino.freeSpinsAvailable(alice.address)) > 0n) break;
    }
    if ((await casino.freeSpinsAvailable(alice.address)) === 0n) this.skip();

    const id = Number(await casino.totalBets());
    const cs = ethers.hexlify(ethers.randomBytes(32));
    await casino.connect(alice).placeSlotsBet(cs, true, { value: 0 });
    await mineN(REVEAL_DELAY + 1n);
    const before = await casino.pendingWithdrawals(alice.address);
    const r = await (await casino.connect(bob).revealAndSettle(id, seeds[id])).wait();
    const ev = r.logs.find((l) => l.fragment && l.fragment.name === "BetSettled");
    const after = await casino.pendingWithdrawals(alice.address);
    expect(after - before).to.equal(ev.args.payout);
  });
});
