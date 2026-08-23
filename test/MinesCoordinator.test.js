// Pins the off-chain mines coordinator (scripts/lib/mines-coordinator.js) to
// the on-chain math. If Casino.sol's layout/proof/randomness ever drift from
// the coordinator, this fails — the whole hidden-layout scheme depends on the
// two agreeing byte-for-byte.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { mineN, deployCasino, provisionSeeds, REVEAL_DELAY } = require("./helpers");
const coord = require("../scripts/lib/mines-coordinator");

const coder = ethers.AbiCoder.defaultAbiCoder();
const CTX = {
  keccak256: ethers.keccak256,
  encode: (types, vals) => coder.encode(types, vals),
  concat: (arr) => ethers.concat(arr),
  solidityPacked: (types, vals) => ethers.solidityPacked(types, vals),
};

describe("MinesCoordinator (off-chain lib ↔ Casino.sol)", function () {
  async function setup() {
    const [owner, hm, alice] = await ethers.getSigners();
    const casino = await deployCasino(hm, ethers.parseEther("100"));
    await casino.connect(owner).setHouseManager(hm.address);
    return { casino, owner, hm, alice };
  }

  it("coordinator root is accepted; every cell proof verifies on-chain", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    const { seeds } = await provisionSeeds(casino, hm, 1);
    const mineCount = 5;
    const cs = ethers.hexlify(ethers.randomBytes(32));
    await casino.connect(alice).placeMinesBet(mineCount, cs, { value: ethers.parseEther("0.1") });
    await mineN(REVEAL_DELAY + 1n);
    const betId = (await casino.totalBets()) - 1n;
    const bet = await casino.getBet(betId);
    const blk = await ethers.provider.getBlock(Number(bet.commitBlock) + Number(REVEAL_DELAY));

    const { bitmap, tree } = coord.layoutFor(CTX, {
      betId, serverSeed: seeds[0], clientSeed: bet.clientSeed,
      entropyHash: blk.hash, nonce: bet.nonce, mineCount,
    });
    // commit the coordinator's root
    await casino.connect(hm).commitMinesRoot(betId, tree.root);

    // play every cell: player picks (intent), coordinator resolves with the
    // per-cell disclosure. Safe → opened, mine → bust ends the game.
    let busted = false;
    for (let i = 0; i < 25 && !busted; i++) {
      const cp = coord.cellProof(CTX, { betId, serverSeed: seeds[0], bitmap, tree, idx: i });
      await casino.connect(alice).pickMinesCell(betId, i);
      if (cp.isMine) {
        await expect(casino.connect(hm).resolveMinesCell(betId, cp.isMine, cp.salt, cp.proof))
          .to.emit(casino, "MinesBust");
        busted = true;
      } else {
        await expect(casino.connect(hm).resolveMinesCell(betId, cp.isMine, cp.salt, cp.proof))
          .to.emit(casino, "MinesCellOpened");
      }
    }

    // finalize with the same seed → the on-chain rebuild must match the
    // committed root exactly (no fraud event).
    await expect(casino.finalizeMines(betId, seeds[0]))
      .to.emit(casino, "MinesLayout").withArgs(betId, bitmap, seeds[0])
      .and.to.not.emit(casino, "MinesFraud");
  });

  it("bitmap popcount equals the mine count for many seeds", async function () {
    for (let t = 0; t < 8; t++) {
      const randomness = ethers.keccak256(ethers.toUtf8Bytes("seed-" + t));
      for (const mc of [1, 3, 5, 12, 24]) {
        const bm = coord.selectMines(ethers.keccak256, CTX.encode, randomness, mc);
        let count = 0, x = bm;
        while (x > 0n) { if (x & 1n) count++; x >>= 1n; }
        expect(count).to.equal(mc);
      }
    }
  });
});
