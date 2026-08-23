// Dice on the basis-point scale: win chances down to 0.01% paying up to 9900x,
// with the house edge held at exactly 100 bps everywhere — a long-odds bet must
// be a longer shot, never a worse deal.
//
// The percent shape stays byte-identical: both shapes encode to the same 64
// bytes when naive, so `target = 50` from a cached page must keep meaning 50%
// and not silently become 0.50%.
const { expect } = require("chai");
const { ethers } = require("hardhat");

const enc = ethers.AbiCoder.defaultAbiCoder();
const legacyParams = (target, over) => enc.encode(["uint8", "bool"], [target, over]);
const bpsParams = (targetBps, over) => enc.encode(["uint32", "bool", "uint8"], [targetBps, over, 1]);

describe("CasinoVault v15 — dice precision (hundredths)", () => {
  let vault, dice, owner, player;
  const serverSeed = ethers.id("dice-precision");
  const seedHash = ethers.keccak256(enc.encode(["bytes32"], [serverSeed]));
  const stake = ethers.parseEther("0.001");

  beforeEach(async () => {
    [owner, player] = await ethers.getSigners();
    vault = await (await ethers.getContractFactory("CasinoVault")).deploy();
    dice = await (await ethers.getContractFactory("DiceModule")).deploy(await vault.getAddress());
    await vault.registerGame(0, await dice.getAddress(), ethers.parseEther("100"));
    await vault.depositBankroll({ value: ethers.parseEther("60") });
    await vault.provisionSeedHashes(new Array(30).fill(seedHash));
  });

  it("quotes 9900x at the longest odds and 1.0002x at the shortest", async () => {
    // 0.01% chance (under 0.02) — the moonshot pays stake x 9900.
    expect(await dice.quote(player.address, stake, bpsParams(2, false))).to.equal(stake * 9900n);
    // 99.98% chance (over 0.01) — nearly certain, nearly no profit.
    expect(await dice.quote(player.address, stake, bpsParams(1, true))).to.equal(
      (stake * 9900n * 10000n) / (9999n * 10000n),
    );
  });

  it("holds the house edge at 100 bps across the whole range", async () => {
    // EV = P(win) x payout must be 99% of the stake at every chance level.
    for (const [targetBps, over] of [[2, false], [100, false], [5000, false], [9000, false], [1, true], [5000, true], [9999, true]]) {
      const payout = await dice.quote(player.address, stake, bpsParams(targetBps, over));
      const winCount = BigInt(over ? 10000 - targetBps : targetBps - 1);
      // ev = payout * winCount / 10000, compared against 0.99 * stake.
      const ev = (payout * winCount) / 10000n;
      const target = (stake * 9900n) / 10000n;
      // Integer division loses at most a wei per unit of winCount.
      const drift = ev > target ? ev - target : target - ev;
      expect(drift, `edge drifted at target=${targetBps} over=${over}`).to.be.lte(winCount + 1n);
    }
  });

  it("the percent shape is untouched — 50 still means 50%, not 0.50%", async () => {
    const legacy = await dice.quote(player.address, stake, legacyParams(50, false));
    // 49% win chance at 99% RTP → 2.0204x
    expect(legacy).to.equal((stake * 9900n) / 4900n);
    // The same number on the new scale is a 0.49% chance — a wildly bigger quote.
    const asBps = await dice.quote(player.address, stake, bpsParams(50, false));
    expect(asBps).to.be.gt(legacy * 100n);
  });

  it("rejects targets with no winning space and wrong versions", async () => {
    await expect(dice.quote(player.address, stake, bpsParams(1, false))).to.be.reverted;      // under 0.01 can never win
    await expect(dice.quote(player.address, stake, bpsParams(10000, true))).to.be.reverted;   // over 100.00 can never win
    await expect(
      dice.quote(player.address, stake, enc.encode(["uint32", "bool", "uint8"], [5000, false, 2])),
    ).to.be.reverted;                                                                          // unknown params version
  });

  it("settles a hundredths bet end to end and states the roll's scale", async () => {
    const clientSeed = ethers.id("c");
    const params = bpsParams(9000, false);            // under 90.00% — 89.99% chance
    await vault.connect(player).placeBet(0, clientSeed, params, { value: stake });
    const betId = Number((await vault.totalBets()) - 1n);
    await ethers.provider.send("evm_mine");
    await vault.revealAndSettle(betId, serverSeed);

    const bet = await vault.getBet(betId);
    expect(Number(bet.status)).to.equal(1);

    // Recompute the roll the way a verifier would.
    const blockHash = (await ethers.provider.getBlock(Number(bet.commitBlock) + 1)).hash;
    const randomness = ethers.keccak256(ethers.solidityPacked(
      ["bytes32", "bytes32", "bytes32", "uint256"], [serverSeed, clientSeed, blockHash, bet.nonce],
    ));
    const roll = (BigInt(randomness) % 10000n) + 1n;
    expect(bet.won).to.equal(roll < 9000n);
    if (bet.won) expect(bet.payout).to.equal((stake * 9900n * 10000n) / (8999n * 10000n));
  });

  it("a 0.01% bet really can pay 9900x", async () => {
    // Drive the module directly: waiting for a 1-in-10000 roll on chain would
    // make the test flaky. `resolve` is pure, so feed it a winning randomness.
    const params = bpsParams(2, false);
    // roll = randomness % 10000 + 1 == 1  →  randomness % 10000 == 0
    const winning = ethers.zeroPadValue(ethers.toBeHex(10000n * 7n), 32);
    const [payout, won] = await dice.resolve.staticCall(0, stake, winning, params);
    expect(won).to.equal(true);
    expect(payout).to.equal(stake * 9900n);
  });
});
