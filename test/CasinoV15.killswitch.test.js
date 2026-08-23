// The Vault advertises two emergency controls: `setGameActive(id,false)` to
// kill one game and `pauseAll()` to stop the casino. Both were enforced ONLY in
// `vault.placeBet` — the entry path of single-shot games. Slots, Mines, Crash
// and Roulette are entered at their own module and reach the Vault through
// `escrowStake`, which has neither check, so five of seven games kept taking
// bets through a "kill". These tests pin the door check on every entry point.
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("CasinoVault v15 — kill switch reaches every game", () => {
  let vault, loyalty, dice, plinko, vault7, cluster, mines, crash, roulette;
  let owner, p1;
  const serverSeed = ethers.id("kill-server");
  const seedHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [serverSeed]));
  const stake = ethers.parseEther("0.01");   // small: this suite tests the gate, not the risk caps
  const diceParams = ethers.AbiCoder.defaultAbiCoder().encode(["uint8", "bool"], [50, true]);
  const plinkoParams = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [0]);

  beforeEach(async () => {
    [owner, p1] = await ethers.getSigners();
    const D = (n, ...a) => ethers.getContractFactory(n).then((f) => f.deploy(...a));
    vault = await D("CasinoVault");
    const v = await vault.getAddress();
    loyalty = await D("SlotLoyalty");
    const l = await loyalty.getAddress();

    dice = await D("DiceModule", v);
    plinko = await D("PlinkoModule", v);
    vault7 = await D("Vault7Module", v, l);
    cluster = await D("ClusterModule", v, l);
    mines = await D("MinesModule", v);
    crash = await D("CrashModule", v);
    roulette = await D("RouletteModule", v);

    const budget = ethers.parseEther("100");
    await vault.registerGame(0, await dice.getAddress(), budget);
    await vault.registerGame(1, await crash.getAddress(), budget);
    await vault.registerGame(2, await vault7.getAddress(), budget);
    await vault.registerGame(3, await mines.getAddress(), budget);
    await vault.registerGame(4, await plinko.getAddress(), budget);
    await vault.registerGame(5, await roulette.getAddress(), budget);
    await vault.registerGame(6, await cluster.getAddress(), budget);
    await loyalty.setModule(await vault7.getAddress(), true);
    await loyalty.setModule(await cluster.getAddress(), true);

    await vault.depositBankroll({ value: ethers.parseEther("60") });
    await vault.provisionSeedHashes(new Array(20).fill(seedHash));
  });

  /** Every way a player can put money in, one per game. */
  function entryPoints() {
    const cs = ethers.id("client");
    return [
      ["dice", () => vault.connect(p1).placeBet(0, cs, diceParams, { value: stake })],
      ["plinko", () => vault.connect(p1).placeBet(4, cs, plinkoParams, { value: stake })],
      ["vault7 spin", () => vault7.connect(p1).placeSpin(cs, false, { value: stake })],
      ["vault7 buyBonus", () => vault7.connect(p1).buyBonus(cs, { value: stake })],
      ["cluster spin", () => cluster.connect(p1).placeSpin(cs, false, { value: stake })],
      ["mines", () => mines.connect(p1).placeMinesBet(3, cs, { value: stake })],
      ["crash startRound", () => crash.connect(p1).startRound()],
      ["roulette startRound", () => roulette.connect(p1).startRound()],
    ];
  }

  it("every entry point works while the casino is open", async () => {
    for (const [name, call] of entryPoints()) {
      await expect(call(), `${name} should be open`).to.not.be.reverted;
    }
  });

  it("pauseAll() stops EVERY game, not just the single-shot ones", async () => {
    await vault.pauseAll();
    for (const [name, call] of entryPoints()) {
      await expect(call(), `${name} still accepted a bet while paused`).to.be.reverted;
    }
  });

  it("setGameActive(id,false) stops that game at its own entry point", async () => {
    const cases = [
      [2, () => vault7.connect(p1).placeSpin(ethers.id("c"), false, { value: stake }), "vault7"],
      [6, () => cluster.connect(p1).placeSpin(ethers.id("c"), false, { value: stake }), "cluster"],
      [3, () => mines.connect(p1).placeMinesBet(3, ethers.id("c"), { value: stake }), "mines"],
      [1, () => crash.connect(p1).startRound(), "crash"],
      [5, () => roulette.connect(p1).startRound(), "roulette"],
    ];
    for (const [id, call, name] of cases) {
      await vault.setGameActive(id, false);
      await expect(call(), `${name} still accepted a bet while deactivated`).to.be.reverted;
      await vault.setGameActive(id, true);
      await expect(call(), `${name} did not come back after reactivation`).to.not.be.reverted;
    }
  });

  it("a de-registered module stops taking bets even though its id stays active", async () => {
    // Replacing a module leaves gameActive[id] true for the NEW one; the OLD
    // contract must not keep escrowing against the bankroll.
    const replacement = await (await ethers.getContractFactory("MinesModule")).deploy(await vault.getAddress());
    await vault.registerGame(3, await replacement.getAddress(), ethers.parseEther("100"));

    expect(await vault.gameActive(3)).to.equal(true);
    await expect(
      mines.connect(p1).placeMinesBet(3, ethers.id("c"), { value: stake }),
      "the replaced module still took a bet",
    ).to.be.reverted;
    await expect(replacement.connect(p1).placeMinesBet(3, ethers.id("c"), { value: stake })).to.not.be.reverted;
  });

  it("pausing stops NEW bets but never strands money already staked", async () => {
    await crash.startRound();
    await crash.connect(p1).placeBet(150, { value: stake });
    await vault.pauseAll();

    // The player's stake is in the Vault. Settling and refunding must still run,
    // otherwise a pause becomes a freeze on other people's money.
    await ethers.provider.send("evm_increaseTime", [20]);
    await ethers.provider.send("evm_mine");
    await expect(crash.settleRound(0, serverSeed)).to.not.be.reverted;
  });
});
