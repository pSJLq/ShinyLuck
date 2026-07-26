// Crash pays at ONE exit point per bet. A player can arm an auto-cashout when
// betting and can also click out manually mid-flight; both are multipliers on
// the same rising curve, so the one that fires is whichever comes FIRST — the
// smaller of the two.
//
// The module used to take the LARGER, which paid people multiples they never
// reached and, worse, walked past the Vault's per-bet exposure cap: `placeBet`
// escrows exposure from `autoCashoutX100` alone, so a bet armed at 1.01x
// reserved 1.01x of risk while a later manual request could still claim 100x.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");

function crashPoint(randomness) {
  const e = 1n << 52n;
  const h = BigInt(randomness) % e;
  const cp = ((10000n - 100n) * e) / (100n * (e - h));
  return cp < 100n ? 100n : cp;
}
const warp = async (s) => {
  await network.provider.send("evm_increaseTime", [s]);
  await network.provider.send("evm_mine");
};

describe("CasinoVault v15 — crash cashout resolution", () => {
  let vault, crash, owner, p1, p2;
  const serverSeed = ethers.id("crash-cashout-server");
  const seedHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [serverSeed]));
  const stake = ethers.parseEther("0.1");

  beforeEach(async () => {
    [owner, p1, p2] = await ethers.getSigners();
    vault = await (await ethers.getContractFactory("CasinoVault")).deploy();
    crash = await (await ethers.getContractFactory("CrashModule")).deploy(await vault.getAddress());
    await vault.registerGame(1, await crash.getAddress(), ethers.parseEther("100"));
    await vault.depositBankroll({ value: ethers.parseEther("60") });
    await vault.provisionSeedHashes(new Array(120).fill(seedHash));
  });

  /** Run one round and report the crash point + what each player was paid. */
  async function playRound(bets) {
    await crash.startRound();
    const roundId = Number((await crash.totalRounds()) - 1n);
    for (const b of bets) await crash.connect(b.who).placeBet(b.auto, { value: stake });

    const r = await crash.getRound(roundId);
    await warp(Number(r.betWindowEnd) - (await ethers.provider.getBlock("latest")).timestamp + 1);
    for (const b of bets) {
      if (b.manual) await crash.connect(b.who).requestCashout(b.manual);
    }
    await warp(1);
    await crash.settleRound(roundId, serverSeed);

    const settled = await crash.getRound(roundId);
    const blockHash = (await ethers.provider.getBlock(Number(r.commitBlock) + 1)).hash;
    const randomness = ethers.keccak256(ethers.solidityPacked(
      ["bytes32", "bytes32", "bytes32", "uint256"],
      [serverSeed, ethers.ZeroHash, blockHash, roundId],
    ));
    return { roundId, cp: BigInt(settled.crashPointX100), randomness };
  }

  /**
   * Play rounds until one survives past `minCp`, then report it.
   *
   * This matters: if the round crashes below BOTH exit points the player gets
   * nothing either way, and an assertion written around that is vacuous — it
   * passes just as happily against the broken max() logic. The discriminating
   * case needs a crash point ABOVE both exits, where taking the larger and
   * taking the smaller pay visibly different amounts.
   */
  async function roundAbove(minCp, bets, maxTries = 40) {
    for (let i = 0; i < maxTries; i++) {
      const before = await vault.pendingWithdrawals(bets[0].who.address);
      const { cp } = await playRound(bets);
      if (cp >= minCp) return { cp, owed: (await vault.pendingWithdrawals(bets[0].who.address)) - before };
    }
    throw new Error(`no round crashed above ${minCp}x in ${maxTries} tries`);
  }

  it("pays the FIRST exit: a manual click below the auto wins the manual multiple", async () => {
    // Armed at 9x, clicked out at 1.5x, round survives past 9x. The player left
    // the ride at 1.5x — paying the 9x auto would be paying for a ride they
    // were not on.
    const { owed } = await roundAbove(900n, [{ who: p1, auto: 900, manual: 150 }]);
    expect(owed).to.equal((stake * 150n) / 100n);
  });

  it("pays the FIRST exit: an auto below a manual request wins the auto multiple", async () => {
    const { owed } = await roundAbove(900n, [{ who: p1, auto: 150, manual: 900 }]);
    expect(owed).to.equal((stake * 150n) / 100n);
  });

  it("a manual request can never exceed the exposure the bet escrowed", async () => {
    // The exploit shape: arm at the minimum so the Vault reserves almost no
    // exposure, then ask for more once the round is in flight.
    //
    // The round has to survive past the MANUAL figure for the two behaviours to
    // differ — below it both pay the auto. 5x is reached often enough to test
    // against (~20% of rounds); asking for the 100x ceiling here would need a
    // 1-in-100 round and the assertion would go vacuous most runs.
    const escrowedCap = (stake * 101n) / 100n; // what placeBet actually reserved
    const { owed } = await roundAbove(500n, [{ who: p1, auto: 101, manual: 500 }]);
    expect(owed).to.equal(escrowedCap);
  });

  it("rejects a manual request above the module's ceiling instead of truncating it", async () => {
    // The value is stored in a uint16, so an unchecked 70000 would silently
    // become 4464 — a completely different bet.
    await crash.startRound();
    await crash.connect(p1).placeBet(0, { value: stake });
    const r = await crash.getRound(0);
    await warp(Number(r.betWindowEnd) - (await ethers.provider.getBlock("latest")).timestamp + 1);
    await expect(crash.connect(p1).requestCashout(70000)).to.be.reverted;
    await expect(crash.connect(p1).requestCashout(10001)).to.be.reverted;
    await expect(crash.connect(p1).requestCashout(10000)).to.not.be.reverted;
  });

  it("with no auto armed, a manual exit still pays and stays inside the ceiling", async () => {
    const { cp } = await playRound([{ who: p1, auto: 0, manual: 200 }]);
    const owed = await vault.pendingWithdrawals(p1.address);
    if (cp >= 200n) expect(owed).to.equal((stake * 200n) / 100n);
    else expect(owed).to.equal(0n);
  });

  it("no exit at all pays nothing", async () => {
    await playRound([{ who: p2, auto: 0 }]);
    expect(await vault.pendingWithdrawals(p2.address)).to.equal(0n);
  });
});
