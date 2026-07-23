const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { mineN, deployCasino, provisionSeeds, REVEAL_DELAY } = require("./helpers");

const MINES = 3;
const coder = ethers.AbiCoder.defaultAbiCoder();

// ---- JS replica of the coordinator (must mirror Casino.sol exactly) --------
function selectMines(randomness, mineCount) {
  let bits = 0n;
  const cells = [...Array(25).keys()];
  let remaining = 25;
  let r = randomness;
  for (let i = 0; i < mineCount; i++) {
    r = ethers.keccak256(coder.encode(["bytes32", "uint8"], [r, i]));
    const idx = Number(BigInt(r) % BigInt(remaining));
    bits |= 1n << BigInt(cells[idx]);
    cells[idx] = cells[remaining - 1];
    remaining--;
  }
  return bits;
}
const salt = (serverSeed, betId, i) =>
  ethers.keccak256(coder.encode(["bytes32", "uint256", "uint256"], [serverSeed, betId, i]));
const realLeaf = (betId, i, isMine, s) =>
  ethers.keccak256(coder.encode(["uint256", "uint256", "bool", "bytes32"], [betId, i, isMine, s]));
const padLeaf = (betId, i) =>
  ethers.keccak256(coder.encode(["uint256", "uint256"], [betId, i]));

function buildTree(betId, bitmap, serverSeed) {
  const leaves = [];
  for (let i = 0; i < 25; i++) {
    const isMine = (bitmap >> BigInt(i)) & 1n ? true : false;
    leaves.push(realLeaf(betId, i, isMine, salt(serverSeed, betId, i)));
  }
  for (let i = 25; i < 32; i++) leaves.push(padLeaf(betId, i));
  const levels = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const prev = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2)
      next.push(ethers.keccak256(ethers.concat([prev[i], prev[i + 1]])));
    levels.push(next);
  }
  return { root: levels[levels.length - 1][0], levels };
}
function proofFor(levels, index) {
  const proof = [];
  let idx = index;
  for (let lvl = 0; lvl < 5; lvl++) {
    proof.push(levels[lvl][idx ^ 1]);
    idx >>= 1;
  }
  return proof;
}

// Full coordinator step: derive randomness the way finalizeMines will,
// build the (honest or rigged) tree, commit its root on-chain.
async function coordinate(casino, hm, betId, serverSeed, mineCount, { rig } = {}) {
  const bet = await casino.getBet(betId);
  const blk = await ethers.provider.getBlock(Number(bet.commitBlock) + Number(REVEAL_DELAY));
  const randomness = ethers.keccak256(ethers.solidityPacked(
    ["bytes32", "bytes32", "bytes32", "uint256"],
    [serverSeed, bet.clientSeed, blk.hash, bet.nonce]));
  const honestBitmap = selectMines(randomness, mineCount);
  const bitmap = rig ? rig(honestBitmap) : honestBitmap; // dishonest coordinator for the fraud test
  const tree = buildTree(betId, bitmap, serverSeed);
  await casino.connect(hm).commitMinesRoot(betId, tree.root);
  return { bitmap, honestBitmap, tree };
}

describe("Casino — MinesGame (hidden-layout v14)", function () {
  async function setup() {
    const [owner, hm, alice, bob] = await ethers.getSigners();
    const casino = await deployCasino(hm, ethers.parseEther("100"));
    await casino.connect(owner).setHouseManager(hm.address);
    return { casino, owner, hm, alice, bob };
  }

  async function placeAndCommit(casino, hm, alice, mineCount = 5, stake = ethers.parseEther("0.1"), opts) {
    const { seeds } = await provisionSeeds(casino, hm, 1);
    const cs = ethers.hexlify(ethers.randomBytes(32));
    await casino.connect(alice).placeMinesBet(mineCount, cs, { value: stake });
    await mineN(REVEAL_DELAY + 1n);
    const betId = (await casino.totalBets()) - 1n;
    const { bitmap, honestBitmap, tree } = await coordinate(casino, hm, betId, seeds[0], mineCount, opts);
    return { betId, bitmap, honestBitmap, tree, serverSeed: seeds[0] };
  }

  it("rejects mineCount out of range", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    await provisionSeeds(casino, hm, 1);
    const cs = ethers.hexlify(ethers.randomBytes(32));
    await expect(casino.connect(alice).placeMinesBet(0, cs, { value: ethers.parseEther("0.1") }))
      .to.be.revertedWithCustomError(casino, "InvalidBet");
    await expect(casino.connect(alice).placeMinesBet(25, cs, { value: ethers.parseEther("0.1") }))
      .to.be.revertedWithCustomError(casino, "InvalidBet");
  });

  it("commitMinesRoot is coordinator-only and stores the root", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    await provisionSeeds(casino, hm, 1);
    const cs = ethers.hexlify(ethers.randomBytes(32));
    await casino.connect(alice).placeMinesBet(5, cs, { value: ethers.parseEther("0.1") });
    await mineN(REVEAL_DELAY + 1n);
    const betId = (await casino.totalBets()) - 1n;
    const fakeRoot = ethers.hexlify(ethers.randomBytes(32));
    await expect(casino.connect(alice).commitMinesRoot(betId, fakeRoot))
      .to.be.revertedWithCustomError(casino, "NotHouseManager");
    await expect(casino.connect(hm).commitMinesRoot(betId, fakeRoot))
      .to.emit(casino, "MinesRootCommitted").withArgs(betId, fakeRoot);
    const ms = await casino.minesState(betId);
    expect(ms.layoutRoot).to.equal(fakeRoot);
    expect(ms.entropyHash).to.not.equal(ethers.ZeroHash);
    await expect(casino.connect(hm).commitMinesRoot(betId, fakeRoot))
      .to.be.revertedWithCustomError(casino, "InvalidBet"); // root already set
  });

  it("EXPLOIT REGRESSION: on-chain state hides the layout; guessed opens revert", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    const { betId, tree } = await placeAndCommit(casino, hm, alice, 24); // 24 mines: only 1 safe cell
    // The struct no longer carries minesBitmap at all — nothing to read.
    const ms = await casino.minesState(betId);
    expect(ms.layoutRoot).to.not.equal(ethers.ZeroHash);
    // A player claiming "this cell is safe" without the coordinator's proof
    // (bogus salt/proof) must be rejected — chain data alone wins nothing.
    const garbage = Array(5).fill(ethers.ZeroHash);
    await expect(casino.connect(alice).openMinesCell(betId, 0, false, ethers.ZeroHash, garbage))
      .to.be.revertedWithCustomError(casino, "InvalidBet");
    // And a REAL leaf with the isMine bit flipped fails too (proof pins the bit).
    const flipped = proofFor(tree.levels, 3);
    await expect(casino.connect(alice).openMinesCell(betId, 3, false, ethers.ZeroHash, flipped))
      .to.be.revertedWithCustomError(casino, "InvalidBet");
  });

  it("opens safely and busts via coordinator proofs", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    const { betId, bitmap, tree, serverSeed } = await placeAndCommit(casino, hm, alice, 5);
    let safe = -1, mine = -1;
    for (let i = 0; i < 25; i++) {
      if (((bitmap >> BigInt(i)) & 1n) === 0n && safe < 0) safe = i;
      if (((bitmap >> BigInt(i)) & 1n) === 1n && mine < 0) mine = i;
    }
    await expect(casino.connect(alice).openMinesCell(
      betId, safe, false, salt(serverSeed, betId, safe), proofFor(tree.levels, safe)))
      .to.emit(casino, "MinesCellOpened");
    await expect(casino.connect(alice).openMinesCell(
      betId, mine, true, salt(serverSeed, betId, mine), proofFor(tree.levels, mine)))
      .to.emit(casino, "MinesBust").withArgs(betId, mine);
    const bet = await casino.getBet(betId);
    expect(bet.status).to.equal(1);
    expect(bet.won).to.equal(false);
    expect(bet.payout).to.equal(0);
  });

  it("cashoutMines pays the running multiplier", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    const stake = ethers.parseEther("0.1");
    const { betId, bitmap, tree, serverSeed } = await placeAndCommit(casino, hm, alice, 5, stake);
    let opened = 0;
    for (let i = 0; i < 25 && opened < 3; i++) {
      if (((bitmap >> BigInt(i)) & 1n) === 0n) {
        await casino.connect(alice).openMinesCell(betId, i, false, salt(serverSeed, betId, i), proofFor(tree.levels, i));
        opened++;
      }
    }
    const txC = await casino.connect(alice).cashoutMines(betId);
    const r = await txC.wait();
    const ev = r.logs.find(l => l.fragment && l.fragment.name === "MinesCashout");
    expect(ev.args.cellsOpened).to.equal(3);
    expect(ev.args.payout).to.equal((stake * BigInt(ev.args.multiplierX100)) / 100n);
    expect(ev.args.multiplierX100).to.be.gte(100n);
    const bet = await casino.getBet(betId);
    expect(bet.won).to.equal(true);
    expect(bet.payout).to.equal(ev.args.payout);
  });

  it("finalizeMines: honest root → layout published, no fraud, no credit", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    const { betId, bitmap, tree, serverSeed } = await placeAndCommit(casino, hm, alice, 5);
    // play: open one safe cell, cash out
    let safe = -1;
    for (let i = 0; i < 25; i++) if (((bitmap >> BigInt(i)) & 1n) === 0n) { safe = i; break; }
    await casino.connect(alice).openMinesCell(betId, safe, false, salt(serverSeed, betId, safe), proofFor(tree.levels, safe));
    await casino.connect(alice).cashoutMines(betId);

    const before = await casino.pendingWithdrawals(alice.address);
    await expect(casino.finalizeMines(betId, serverSeed))
      .to.emit(casino, "MinesLayout").withArgs(betId, bitmap, serverSeed)
      .and.to.not.emit(casino, "MinesFraud");
    expect(await casino.pendingWithdrawals(alice.address)).to.equal(before);
    await expect(casino.finalizeMines(betId, serverSeed))
      .to.be.revertedWithCustomError(casino, "InvalidBet"); // finalized once
  });

  it("finalizeMines: RIGGED root → fraud event + stake made whole", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    const stake = ethers.parseEther("0.1");
    // dishonest coordinator commits a layout with an EXTRA mine planted
    const rig = (bm) => {
      for (let i = 0; i < 25; i++) if (((bm >> BigInt(i)) & 1n) === 0n) return bm | (1n << BigInt(i));
      return bm;
    };
    const { betId, bitmap, honestBitmap, tree, serverSeed } = await placeAndCommit(casino, hm, alice, 5, stake, { rig });
    // player opens the planted mine (coordinator serves its rigged proof) → bust
    let planted = -1;
    for (let i = 0; i < 25; i++) {
      if (((bitmap >> BigInt(i)) & 1n) === 1n && ((honestBitmap >> BigInt(i)) & 1n) === 0n) { planted = i; break; }
    }
    expect(planted).to.be.gte(0);
    await casino.connect(alice).openMinesCell(betId, planted, true, salt(serverSeed, betId, planted), proofFor(tree.levels, planted));

    const before = await casino.pendingWithdrawals(alice.address);
    await expect(casino.finalizeMines(betId, serverSeed)).to.emit(casino, "MinesFraud");
    expect(await casino.pendingWithdrawals(alice.address)).to.equal(before + stake);
  });

  it("cannot open same cell twice / only player / no empty cashout", async function () {
    const { casino, hm, alice, bob } = await loadFixture(setup);
    const { betId, bitmap, tree, serverSeed } = await placeAndCommit(casino, hm, alice, 5);
    let safe = -1;
    for (let i = 0; i < 25; i++) if (((bitmap >> BigInt(i)) & 1n) === 0n) { safe = i; break; }
    await expect(casino.connect(alice).cashoutMines(betId))
      .to.be.revertedWithCustomError(casino, "InvalidBet"); // nothing opened yet
    const args = [betId, safe, false, salt(serverSeed, betId, safe), proofFor(tree.levels, safe)];
    await expect(casino.connect(bob).openMinesCell(...args))
      .to.be.revertedWithCustomError(casino, "InvalidBet"); // not player
    await casino.connect(alice).openMinesCell(...args);
    await expect(casino.connect(alice).openMinesCell(...args))
      .to.be.revertedWithCustomError(casino, "InvalidBet"); // already opened
    await expect(casino.connect(bob).cashoutMines(betId))
      .to.be.revertedWithCustomError(casino, "InvalidBet"); // not player
  });

  it("revealAndSettle rejects MINES bets", async function () {
    const { casino, hm, alice, bob } = await loadFixture(setup);
    const { seeds } = await provisionSeeds(casino, hm, 1);
    const cs = ethers.hexlify(ethers.randomBytes(32));
    await casino.connect(alice).placeMinesBet(5, cs, { value: ethers.parseEther("0.1") });
    await mineN(REVEAL_DELAY + 1n);
    await expect(casino.connect(bob).revealAndSettle(0, seeds[0]))
      .to.be.revertedWithCustomError(casino, "InvalidGame");
  });

  it("multiplier increases monotonically with k", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    const { betId, bitmap, tree, serverSeed } = await placeAndCommit(casino, hm, alice, 3, ethers.parseEther("0.05"));
    let prev = 100n, opened = 0;
    for (let i = 0; i < 25 && opened < 5; i++) {
      if (((bitmap >> BigInt(i)) & 1n) === 0n) {
        const tx = await casino.connect(alice).openMinesCell(
          betId, i, false, salt(serverSeed, betId, i), proofFor(tree.levels, i));
        const r = await tx.wait();
        const ev = r.logs.find(l => l.fragment && l.fragment.name === "MinesCellOpened");
        expect(ev.args.multiplierX100).to.be.gt(prev);
        prev = ev.args.multiplierX100;
        opened++;
      }
    }
  });
});
