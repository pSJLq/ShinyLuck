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
const salt = (ss, betId, i) => coord.cellSalt(ethers.keccak256, CTX.encode, ss, betId, i);
const proofFor = (levels, i) => coord.proofFor(levels, i);

describe("Casino — MinesGame (hidden-layout v14, pick/resolve)", function () {
  async function setup() {
    const [owner, hm, alice, bob] = await ethers.getSigners();
    const casino = await deployCasino(hm, ethers.parseEther("100"));
    await casino.connect(owner).setHouseManager(hm.address);
    return { casino, owner, hm, alice, bob };
  }

  // Places a bet, waits REVEAL_DELAY, derives the honest (or rigged) layout the
  // way finalizeMines will, and commits its root — returns everything needed to
  // drive the game.
  async function placeAndCommit(casino, hm, alice, mineCount = 5, stake = ethers.parseEther("0.1"), { rig } = {}) {
    const { seeds } = await provisionSeeds(casino, hm, 1);
    const cs = ethers.hexlify(ethers.randomBytes(32));
    await casino.connect(alice).placeMinesBet(mineCount, cs, { value: stake });
    await mineN(REVEAL_DELAY + 1n);
    const betId = (await casino.totalBets()) - 1n;
    const bet = await casino.getBet(betId);
    const blk = await ethers.provider.getBlock(Number(bet.commitBlock) + Number(REVEAL_DELAY));
    const { bitmap, tree } = coord.layoutFor(CTX, {
      betId, serverSeed: seeds[0], clientSeed: bet.clientSeed, entropyHash: blk.hash, nonce: bet.nonce, mineCount,
    });
    const honestBitmap = bitmap;
    const useBitmap = rig ? rig(bitmap) : bitmap;
    const tree2 = rig ? coord.buildTree(ethers.keccak256, CTX.encode, CTX.concat, betId, useBitmap, seeds[0]) : tree;
    await casino.connect(hm).commitMinesRoot(betId, tree2.root);
    return { betId, bitmap: useBitmap, honestBitmap, tree: tree2, serverSeed: seeds[0] };
  }

  // player picks (cheap intent) → coordinator resolves with proof
  async function play(casino, hm, alice, betId, bitmap, serverSeed, tree, i) {
    await casino.connect(alice).pickMinesCell(betId, i);
    const isMine = ((bitmap >> BigInt(i)) & 1n) === 1n;
    return casino.connect(hm).resolveMinesCell(betId, isMine, salt(serverSeed, betId, i), proofFor(tree.levels, i));
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

  it("commitMinesRoot is coordinator-only and stores root + entropy", async function () {
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

  it("EXPLOIT REGRESSION: layout is not on-chain and can't be peeked", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    const { betId } = await placeAndCommit(casino, hm, alice, 24); // 24 mines, 1 safe
    const ms = await casino.minesState(betId);
    expect(ms.layoutRoot).to.not.equal(ethers.ZeroHash);
    // struct no longer carries a mine bitmap — there is nothing to read.
    expect(ms.pendingCell).to.equal(0);
    // a resolve without the player first committing a pick reverts.
    await expect(casino.connect(hm).resolveMinesCell(betId, false, ethers.ZeroHash, Array(5).fill(ethers.ZeroHash)))
      .to.be.revertedWithCustomError(casino, "InvalidBet");
  });

  it("pick/resolve: safe opens, then a mine busts", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    const { betId, bitmap, tree, serverSeed } = await placeAndCommit(casino, hm, alice, 5);
    let safe = -1, mine = -1;
    for (let i = 0; i < 25; i++) {
      if (((bitmap >> BigInt(i)) & 1n) === 0n && safe < 0) safe = i;
      if (((bitmap >> BigInt(i)) & 1n) === 1n && mine < 0) mine = i;
    }
    await expect(play(casino, hm, alice, betId, bitmap, serverSeed, tree, safe)).to.emit(casino, "MinesCellOpened");
    await expect(play(casino, hm, alice, betId, bitmap, serverSeed, tree, mine))
      .to.emit(casino, "MinesBust").withArgs(betId, mine);
    const bet = await casino.getBet(betId);
    expect(bet.status).to.equal(1);
    expect(bet.won).to.equal(false);
    expect(bet.payout).to.equal(0);
  });

  it("a proof for the WRONG cell is rejected", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    const { betId, bitmap, tree, serverSeed } = await placeAndCommit(casino, hm, alice, 5);
    // pick cell 0, but hand the coordinator's resolver a proof for cell 1
    await casino.connect(alice).pickMinesCell(betId, 0);
    const isMine1 = ((bitmap >> 1n) & 1n) === 1n;
    await expect(casino.connect(hm).resolveMinesCell(betId, isMine1, salt(serverSeed, betId, 1), proofFor(tree.levels, 1)))
      .to.be.revertedWithCustomError(casino, "InvalidBet"); // proof for idx 1 won't match pending idx 0
  });

  it("cannot pick while a pick is pending, nor cash out mid-pick", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    const { betId } = await placeAndCommit(casino, hm, alice, 5);
    await casino.connect(alice).pickMinesCell(betId, 0);
    await expect(casino.connect(alice).pickMinesCell(betId, 1))
      .to.be.revertedWithCustomError(casino, "InvalidBet"); // pick pending
    await expect(casino.connect(alice).cashoutMines(betId))
      .to.be.revertedWithCustomError(casino, "InvalidBet"); // resolve first
  });

  it("cancelMinesPick refunds the stake after the timeout (stalling coordinator)", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    const stake = ethers.parseEther("0.1");
    const { betId } = await placeAndCommit(casino, hm, alice, 5, stake);
    await casino.connect(alice).pickMinesCell(betId, 0);
    // before timeout: cannot cancel
    await expect(casino.connect(alice).cancelMinesPick(betId))
      .to.be.revertedWithCustomError(casino, "InvalidBet");
    await mineN(41n); // MINES_PICK_TIMEOUT = 40
    const before = await casino.pendingWithdrawals(alice.address);
    await casino.connect(alice).cancelMinesPick(betId);
    expect(await casino.pendingWithdrawals(alice.address)).to.equal(before + stake);
    expect((await casino.getBet(betId)).status).to.equal(2); // refunded
  });

  it("cashoutMines pays the running multiplier", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    const stake = ethers.parseEther("0.1");
    const { betId, bitmap, tree, serverSeed } = await placeAndCommit(casino, hm, alice, 5, stake);
    let opened = 0;
    for (let i = 0; i < 25 && opened < 3; i++) {
      if (((bitmap >> BigInt(i)) & 1n) === 0n) { await play(casino, hm, alice, betId, bitmap, serverSeed, tree, i); opened++; }
    }
    const r = await (await casino.connect(alice).cashoutMines(betId)).wait();
    const ev = r.logs.find((l) => l.fragment && l.fragment.name === "MinesCashout");
    expect(ev.args.cellsOpened).to.equal(3);
    expect(ev.args.payout).to.equal((stake * BigInt(ev.args.multiplierX100)) / 100n);
    expect((await casino.getBet(betId)).won).to.equal(true);
  });

  it("finalizeMines: honest root → layout published, no fraud, no credit", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    const { betId, bitmap, tree, serverSeed } = await placeAndCommit(casino, hm, alice, 5);
    let safe = -1;
    for (let i = 0; i < 25; i++) if (((bitmap >> BigInt(i)) & 1n) === 0n) { safe = i; break; }
    await play(casino, hm, alice, betId, bitmap, serverSeed, tree, safe);
    await casino.connect(alice).cashoutMines(betId);
    const before = await casino.pendingWithdrawals(alice.address);
    await expect(casino.finalizeMines(betId, serverSeed))
      .to.emit(casino, "MinesLayout").withArgs(betId, bitmap, serverSeed)
      .and.to.not.emit(casino, "MinesFraud");
    expect(await casino.pendingWithdrawals(alice.address)).to.equal(before);
    await expect(casino.finalizeMines(betId, serverSeed)).to.be.revertedWithCustomError(casino, "InvalidBet");
  });

  it("finalizeMines: RIGGED root → fraud event + stake made whole", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    const stake = ethers.parseEther("0.1");
    const rig = (bm) => { for (let i = 0; i < 25; i++) if (((bm >> BigInt(i)) & 1n) === 0n) return bm | (1n << BigInt(i)); return bm; };
    const { betId, bitmap, honestBitmap, tree, serverSeed } = await placeAndCommit(casino, hm, alice, 5, stake, { rig });
    // player picks the planted mine (not a mine in the honest layout) → bust
    let planted = -1;
    for (let i = 0; i < 25; i++) if (((bitmap >> BigInt(i)) & 1n) === 1n && ((honestBitmap >> BigInt(i)) & 1n) === 0n) { planted = i; break; }
    expect(planted).to.be.gte(0);
    await play(casino, hm, alice, betId, bitmap, serverSeed, tree, planted);
    const before = await casino.pendingWithdrawals(alice.address);
    await expect(casino.finalizeMines(betId, serverSeed)).to.emit(casino, "MinesFraud");
    expect(await casino.pendingWithdrawals(alice.address)).to.equal(before + stake);
  });

  it("only the player can pick / cash out", async function () {
    const { casino, hm, alice, bob } = await loadFixture(setup);
    const { betId } = await placeAndCommit(casino, hm, alice, 5);
    await expect(casino.connect(bob).pickMinesCell(betId, 0)).to.be.revertedWithCustomError(casino, "InvalidBet");
    await expect(casino.connect(bob).cashoutMines(betId)).to.be.revertedWithCustomError(casino, "InvalidBet");
  });

  it("resolveMinesCell is coordinator-only", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    const { betId, bitmap, tree, serverSeed } = await placeAndCommit(casino, hm, alice, 5);
    await casino.connect(alice).pickMinesCell(betId, 0);
    const isMine = ((bitmap >> 0n) & 1n) === 1n;
    await expect(casino.connect(alice).resolveMinesCell(betId, isMine, salt(serverSeed, betId, 0), proofFor(tree.levels, 0)))
      .to.be.revertedWithCustomError(casino, "NotHouseManager");
  });

  it("multiplier increases monotonically with k", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    const { betId, bitmap, tree, serverSeed } = await placeAndCommit(casino, hm, alice, 3, ethers.parseEther("0.05"));
    let prev = 100n, opened = 0;
    for (let i = 0; i < 25 && opened < 5; i++) {
      if (((bitmap >> BigInt(i)) & 1n) === 0n) {
        const r = await (await play(casino, hm, alice, betId, bitmap, serverSeed, tree, i)).wait();
        const ev = r.logs.find((l) => l.fragment && l.fragment.name === "MinesCellOpened");
        expect(ev.args.multiplierX100).to.be.gt(prev);
        prev = ev.args.multiplierX100;
        opened++;
      }
    }
  });
});
