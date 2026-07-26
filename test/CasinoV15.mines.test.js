const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const minesCoord = require("../scripts/lib/mines-coordinator");

const MC = {
  keccak256: ethers.keccak256,
  encode: (t, v) => ethers.AbiCoder.defaultAbiCoder().encode(t, v),
  concat: (a) => ethers.concat(a),
  solidityPacked: (t, v) => ethers.solidityPacked(t, v),
};
function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }
function multiplierX100(k, mines) {
  if (k === 0) return 100n;
  let num = 1n, den = 1n;
  for (let i = 0n; i < BigInt(k); i++) {
    num *= (25n - i);
    den *= (25n - BigInt(mines) - i);
    const g = gcd(num, den); num /= g; den /= g;
  }
  let m = (num * (10000n - 120n) * 100n) / (den * 10000n);
  if (m > 10000n) m = 10000n;
  if (m < 100n) m = 100n;
  return m;
}

describe("CasinoVault v15 — Mines", () => {
  let vault, mines, owner, player;
  const serverSeed = ethers.id("mines-server");
  const seedHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [serverSeed]));
  const clientSeed = ethers.id("mines-client");
  const mineCount = 3;

  beforeEach(async () => {
    [owner, player] = await ethers.getSigners();
    vault = await (await ethers.getContractFactory("CasinoVault")).deploy();
    mines = await (await ethers.getContractFactory("MinesModule")).deploy(await vault.getAddress());
    await vault.registerGame(3, await mines.getAddress(), ethers.parseEther("1000"));
    await vault.depositBankroll({ value: ethers.parseEther("100") });
    await vault.provisionSeedHashes([seedHash]);
  });

  // Place a bet and commit the layout root; returns {betId, bitmap, tree}.
  async function placeAndCommit(stake) {
    await mines.connect(player).placeMinesBet(mineCount, clientSeed, { value: stake });
    const betId = 0;
    const g = await mines.getGame(betId);
    await network.provider.send("evm_mine");
    const entropyHash = (await ethers.provider.getBlock(Number(g.commitBlock) + 1)).hash;
    const { bitmap, tree } = minesCoord.layoutFor(MC, {
      betId, serverSeed, clientSeed, entropyHash, nonce: g.nonce, mineCount,
    });
    await mines.connect(owner).commitRoot(betId, tree.root);
    return { betId, bitmap, tree, entropyHash };
  }

  function findCell(bitmap, wantMine) {
    for (let i = 0; i < 25; i++) {
      const isMine = (bitmap & (1n << BigInt(i))) !== 0n;
      if (isMine === wantMine) return i;
    }
    throw new Error("no such cell");
  }

  it("full happy path: open a safe cell, cashout, finalize clean", async () => {
    const stake = ethers.parseEther("0.1");
    const { betId, bitmap, tree } = await placeAndCommit(stake);

    const safe = findCell(bitmap, false);
    await mines.connect(player).pickCell(betId, safe);
    const cp = minesCoord.cellProof(MC, { betId, serverSeed, bitmap, tree, idx: safe });
    expect(cp.isMine).to.equal(false);
    await mines.connect(owner).resolveCell(betId, cp.isMine, cp.salt, cp.proof);

    await mines.connect(player).cashout(betId);

    const expectedMult = multiplierX100(1, mineCount);
    const expectedPayout = (stake * expectedMult) / 100n;
    expect(await vault.pendingWithdrawals(player.address)).to.equal(expectedPayout);

    // finalize: derived root matches committed → no fraud, no extra refund
    await mines.connect(player).finalize(betId, serverSeed);
    expect(await vault.pendingWithdrawals(player.address)).to.equal(expectedPayout);
    const g = await mines.getGame(betId);
    expect(g.finalized).to.equal(true);
  });

  it("hitting a mine busts: settled, no credit", async () => {
    const stake = ethers.parseEther("0.1");
    const { betId, bitmap, tree } = await placeAndCommit(stake);

    const mine = findCell(bitmap, true);
    await mines.connect(player).pickCell(betId, mine);
    const cp = minesCoord.cellProof(MC, { betId, serverSeed, bitmap, tree, idx: mine });
    expect(cp.isMine).to.equal(true);
    await mines.connect(owner).resolveCell(betId, cp.isMine, cp.salt, cp.proof);

    const g = await mines.getGame(betId);
    expect(g.busted).to.equal(true);
    expect(g.status).to.equal(1);
    expect(await vault.pendingWithdrawals(player.address)).to.equal(0);
  });

  it("bad proof is rejected (anti-cheat)", async () => {
    const stake = ethers.parseEther("0.1");
    const { betId, bitmap, tree } = await placeAndCommit(stake);
    const safe = findCell(bitmap, false);
    await mines.connect(player).pickCell(betId, safe);
    const cp = minesCoord.cellProof(MC, { betId, serverSeed, bitmap, tree, idx: safe });
    // claim it's a mine with the safe cell's (non-matching) proof → bad proof
    await expect(
      mines.connect(owner).resolveCell(betId, true, cp.salt, cp.proof)
    ).to.be.revertedWithCustomError(mines, "InvalidBet");
  });

  it("only the coordinator (owner) can commit/resolve", async () => {
    const stake = ethers.parseEther("0.1");
    await mines.connect(player).placeMinesBet(mineCount, clientSeed, { value: stake });
    await expect(
      mines.connect(player).commitRoot(0, ethers.id("x"))
    ).to.be.revertedWithCustomError(mines, "OwnableUnauthorizedAccount");
  });

  it("vault module-primitives reject non-module callers (trust boundary)", async () => {
    await expect(
      vault.connect(player).creditFromModule(player.address, 0, ethers.parseEther("1"))
    ).to.be.revertedWithCustomError(vault, "NotModule");
    await expect(
      vault.connect(player).escrowStake(player.address, 0, { value: ethers.parseEther("0.1") })
    ).to.be.revertedWithCustomError(vault, "NotModule");
  });
});
