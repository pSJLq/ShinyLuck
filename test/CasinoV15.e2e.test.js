const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { createBot, deriveSeed, deriveCashier } = require("../scripts/reveal-bot-v15");

const SEED_MASTER = "0x" + "11".repeat(32);
const CASHIER_MASTER = "0x" + "22".repeat(32);

const GAMES = [
  { id: 0, name: "dice",     contract: "DiceModule",     kind: "single-shot" },
  { id: 1, name: "crash",    contract: "CrashModule",    kind: "round" },
  { id: 2, name: "vault7",   contract: "Vault7Module",   kind: "slot" },
  { id: 3, name: "mines",    contract: "MinesModule",    kind: "multi-step" },
  { id: 4, name: "plinko",   contract: "PlinkoModule",   kind: "single-shot" },
  { id: 5, name: "roulette", contract: "RouletteModule", kind: "round" },
  { id: 6, name: "cluster",  contract: "ClusterModule",  kind: "slot" },
];

describe("CasinoVault v15 — end-to-end with the settlement bot", () => {
  let vault, loyalty, mods, manifest, bot, owner, player;

  before(async () => {
    [owner, player] = await ethers.getSigners();
    vault = await (await ethers.getContractFactory("CasinoVault")).deploy();
    loyalty = await (await ethers.getContractFactory("SlotLoyalty")).deploy();
    const vaultAddr = await vault.getAddress();
    const loyaltyAddr = await loyalty.getAddress();

    mods = {};
    for (const g of GAMES) {
      const args = g.kind === "slot" ? [vaultAddr, loyaltyAddr] : [vaultAddr];
      const m = await (await ethers.getContractFactory(g.contract)).deploy(...args);
      mods[g.name] = m;
      await vault.registerGame(g.id, await m.getAddress(), ethers.parseEther("500"));
    }
    await loyalty.setModule(await mods.vault7.getAddress(), true);
    await loyalty.setModule(await mods.cluster.getAddress(), true);
    await vault.depositBankroll({ value: ethers.parseEther("300") });

    // seeds, deterministic from the master key (same derivation as the bot)
    const hashes = [];
    for (let i = 0; i < 100; i++) {
      hashes.push(ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [deriveSeed(SEED_MASTER, i)])
      ));
    }
    await vault.provisionSeedHashes(hashes);

    // fund the per-game cashiers and hand mines to its own lane
    for (const g of GAMES) {
      const addr = new ethers.Wallet(deriveCashier(CASHIER_MASTER, g.name)).address;
      await owner.sendTransaction({ to: addr, value: ethers.parseEther("5") });
    }
    await mods.mines.transferOwnership(
      new ethers.Wallet(deriveCashier(CASHIER_MASTER, "mines")).address
    );

    manifest = {
      addresses: { vault: vaultAddr, loyalty: loyaltyAddr },
      games: await Promise.all(GAMES.map(async (g) => ({
        ...g, module: await mods[g.name].getAddress(),
      }))),
    };
    bot = await createBot({
      manifest, seedMasterKey: SEED_MASTER, cashierMasterKey: CASHIER_MASTER,
      log: () => {},
    });
  });

  it("each game gets its OWN cashier lane (isolation)", async () => {
    const addrs = GAMES.map((g) => bot.lanes[g.name].address);
    expect(new Set(addrs).size).to.equal(GAMES.length); // all distinct
  });

  it("bot settles a dice bet", async () => {
    const params = ethers.AbiCoder.defaultAbiCoder().encode(["uint8", "bool"], [50, false]);
    const before = Number(await vault.totalBets());
    await vault.connect(player).placeBet(0, ethers.id("c1"), params, { value: ethers.parseEther("0.1") });
    await network.provider.send("evm_mine");
    await bot.tick();
    expect((await vault.getBet(before)).status).to.equal(1);
  });

  it("bot settles a plinko bet", async () => {
    const params = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [0]);
    const before = Number(await vault.totalBets());
    await vault.connect(player).placeBet(4, ethers.id("c2"), params, { value: ethers.parseEther("0.1") });
    await network.provider.send("evm_mine");
    await bot.tick();
    expect((await vault.getBet(before)).status).to.equal(1);
  });

  it("bot settles slot spins on both slot games", async () => {
    await mods.vault7.connect(player).placeSpin(ethers.id("c3"), false, { value: ethers.parseEther("0.05") });
    await mods.cluster.connect(player).placeSpin(ethers.id("c4"), false, { value: ethers.parseEther("0.05") });
    await network.provider.send("evm_mine");
    await bot.tick();
    expect((await mods.vault7.getSpin(0)).status).to.equal(1);
    expect((await mods.cluster.getSpin(0)).status).to.equal(1);
  });

  it("bot drives a full mines game: commit → resolve pick → finalize", async () => {
    await mods.mines.connect(player).placeMinesBet(3, ethers.id("c5"), { value: ethers.parseEther("0.1") });
    await network.provider.send("evm_mine");
    await bot.tick();                       // commits the layout root
    const g1 = await mods.mines.getGame(0);
    expect(g1.layoutRoot).to.not.equal(ethers.ZeroHash);

    await mods.mines.connect(player).pickCell(0, 12);
    await bot.tick();                       // resolves the pick with its proof
    const g2 = await mods.mines.getGame(0);
    expect(Number(g2.pendingCell)).to.equal(0);   // resolved
    const opened = Number(g2.openedBitmap) !== 0;
    expect(opened || g2.busted).to.equal(true);

    if (!g2.busted) await mods.mines.connect(player).cashout(0);
    await bot.tick();                       // finalizes + publishes the layout
    expect((await mods.mines.getGame(0)).finalized).to.equal(true);
  });

  it("bot settles crash and roulette rounds (one settle serves all players)", async () => {
    await mods.crash.startRound();
    await mods.crash.connect(player).placeBet(200, { value: ethers.parseEther("0.1") });
    await mods.crash.connect(owner).placeBet(150, { value: ethers.parseEther("0.1") });

    await mods.roulette.startRound();
    await mods.roulette.connect(player).placeBets(
      [{ kind: 1, number: 0, amount: ethers.parseEther("0.05") }],
      { value: ethers.parseEther("0.05") }
    );

    await network.provider.send("evm_increaseTime", [25]);
    await network.provider.send("evm_mine");
    await bot.tick();

    expect((await mods.crash.getRound(0)).settled).to.equal(true);
    expect((await mods.roulette.getRound(0)).settled).to.equal(true);
  });

  it("a failing game does not block the others (lane isolation)", async () => {
    // Take the mines lane down entirely: every send from it throws. The other
    // games must still settle in the same tick.
    bot.lanes.mines.send = async () => { throw new Error("lane down"); };

    await mods.mines.connect(player).placeMinesBet(3, ethers.id("c6"), { value: ethers.parseEther("0.05") });
    const diceBefore = Number(await vault.totalBets());
    const params = ethers.AbiCoder.defaultAbiCoder().encode(["uint8", "bool"], [50, false]);
    await vault.connect(player).placeBet(0, ethers.id("c7"), params, { value: ethers.parseEther("0.1") });
    await network.provider.send("evm_mine");

    await bot.tick();
    // dice settled despite mines failing
    expect((await vault.getBet(diceBefore)).status).to.equal(1);
    expect((await mods.mines.getGame(1)).layoutRoot).to.equal(ethers.ZeroHash);
  });
});
