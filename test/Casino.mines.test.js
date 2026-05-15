const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { mineN, deployCasino, provisionSeeds, REVEAL_DELAY } = require("./helpers");

const MINES = 3;

describe("Casino — MinesGame", function () {
  async function setup() {
    const [owner, hm, alice, bob] = await ethers.getSigners();
    const casino = await deployCasino(hm, ethers.parseEther("100"));
    await casino.connect(owner).setHouseManager(hm.address);
    return { casino, owner, hm, alice, bob };
  }

  async function placeAndReveal(casino, hm, alice, mineCount = 5, stake = ethers.parseEther("0.1")) {
    const { seeds } = await provisionSeeds(casino, hm, 1);
    const cs = ethers.hexlify(ethers.randomBytes(32));
    await casino.connect(alice).placeMinesBet(mineCount, cs, { value: stake });
    await mineN(REVEAL_DELAY + 1n);
    const betId = (await casino.totalBets()) - 1n;
    await casino.connect(alice).revealMinesSeed(betId, seeds[0]);
    return betId;
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

  it("revealMinesSeed locks in mines bitmap", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    const betId = await placeAndReveal(casino, hm, alice, 5);
    const ms = await casino.minesState(betId);
    expect(ms.seedRevealed).to.equal(true);
    // popcount of minesBitmap == 5
    let bits = ms.minesBitmap;
    let count = 0;
    while (bits > 0n) { if (bits & 1n) count++; bits >>= 1n; }
    expect(count).to.equal(5);
  });

  it("openMinesCell either opens safely or busts", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    const betId = await placeAndReveal(casino, hm, alice, 5);
    const ms = await casino.minesState(betId);
    // find first safe cell
    const minesBitmap = ms.minesBitmap;
    let safeCell = -1;
    for (let i = 0; i < 25; i++) {
      if (((minesBitmap >> BigInt(i)) & 1n) === 0n) { safeCell = i; break; }
    }
    expect(safeCell).to.not.equal(-1);
    await expect(casino.connect(alice).openMinesCell(betId, safeCell))
      .to.emit(casino, "MinesCellOpened");

    // open a mine cell -> bust
    let mineCell = -1;
    for (let i = 0; i < 25; i++) {
      if (((minesBitmap >> BigInt(i)) & 1n) === 1n) { mineCell = i; break; }
    }
    expect(mineCell).to.not.equal(-1);
    await expect(casino.connect(alice).openMinesCell(betId, mineCell))
      .to.emit(casino, "MinesBust");

    const bet = await casino.getBet(betId);
    expect(bet.status).to.equal(1);
    expect(bet.won).to.equal(false);
    expect(bet.payout).to.equal(0);
  });

  it("cashoutMines pays the running multiplier", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    const stake = ethers.parseEther("0.1");
    const betId = await placeAndReveal(casino, hm, alice, 5, stake);
    const ms = await casino.minesState(betId);
    // open 3 safe cells
    let opened = 0;
    for (let i = 0; i < 25 && opened < 3; i++) {
      if (((ms.minesBitmap >> BigInt(i)) & 1n) === 0n) {
        await casino.connect(alice).openMinesCell(betId, i);
        opened++;
      }
    }
    // multiplier_x100 for k=3, mines=5, edge=1.2%:
    // num = 25*24*23 = 13800; den = 20*19*18 = 6840
    // raw = 13800/6840 ≈ 2.018 → x100 = 201
    // with edge: 201 * 0.988 = 198.6 → floor 198 (depending on order)
    // Actually computed: (num * 9880 * 100) / (den * 10000) = (13800 * 988000) / (6840 * 10000)
    //                  = 13634400000 / 68400000 = 199.33 → 199
    // After GCD reductions intermediate, but final should match.
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

  it("cannot open same cell twice", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    const betId = await placeAndReveal(casino, hm, alice, 5);
    const ms = await casino.minesState(betId);
    let safe = -1;
    for (let i = 0; i < 25; i++) {
      if (((ms.minesBitmap >> BigInt(i)) & 1n) === 0n) { safe = i; break; }
    }
    await casino.connect(alice).openMinesCell(betId, safe);
    await expect(casino.connect(alice).openMinesCell(betId, safe))
      .to.be.revertedWithCustomError(casino, "InvalidBet");
  });

  it("only player can open / cashout", async function () {
    const { casino, hm, alice, bob } = await loadFixture(setup);
    const betId = await placeAndReveal(casino, hm, alice, 5);
    await expect(casino.connect(bob).openMinesCell(betId, 0))
      .to.be.revertedWithCustomError(casino, "InvalidBet");
    await expect(casino.connect(bob).cashoutMines(betId))
      .to.be.revertedWithCustomError(casino, "InvalidBet");
  });

  it("cannot cashout with 0 cells opened", async function () {
    const { casino, hm, alice } = await loadFixture(setup);
    const betId = await placeAndReveal(casino, hm, alice, 5);
    await expect(casino.connect(alice).cashoutMines(betId))
      .to.be.revertedWithCustomError(casino, "InvalidBet");
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
    const stake = ethers.parseEther("0.05");
    const betId = await placeAndReveal(casino, hm, alice, 3, stake);
    const ms = await casino.minesState(betId);
    let prev = 100n;
    let opened = 0;
    for (let i = 0; i < 25 && opened < 5; i++) {
      if (((ms.minesBitmap >> BigInt(i)) & 1n) === 0n) {
        const tx = await casino.connect(alice).openMinesCell(betId, i);
        const r = await tx.wait();
        const ev = r.logs.find(l => l.fragment && l.fragment.name === "MinesCellOpened");
        expect(ev.args.multiplierX100).to.be.gt(prev);
        prev = ev.args.multiplierX100;
        opened++;
      }
    }
  });
});
