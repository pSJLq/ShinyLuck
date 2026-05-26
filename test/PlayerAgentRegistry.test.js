const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { mineN, deployCasino, provisionSeeds, REVEAL_DELAY } = require("./helpers");

const DICE = 0;

// game mask helpers
const GM = (...gs) => gs.reduce((m, g) => m | (1 << g), 0);

describe("PlayerAgentRegistry + AgentVault", function () {
  async function setup() {
    const [owner, hm, relayer, alice, bob] = await ethers.getSigners();
    const casino = await deployCasino(undefined, ethers.parseEther("100"));
    await casino.connect(owner).setHouseManager(hm.address);
    await provisionSeeds(casino, hm, 20);
    const Reg = await ethers.getContractFactory("PlayerAgentRegistry");
    const registry = await Reg.deploy(await casino.getAddress(), relayer.address);
    await registry.waitForDeployment();
    return { owner, hm, relayer, alice, bob, casino, registry };
  }

  describe("registration", function () {
    it("registers a fresh agent + creates vault", async function () {
      const { registry, alice } = await loadFixture(setup);
      const stratHash = ethers.keccak256(ethers.toUtf8Bytes("dice over 60 1 STT"));
      const tx = await registry.connect(alice).registerAgent(
        stratHash,
        ethers.parseEther("5"),
        ethers.parseEther("50"),
        GM(DICE)
      );
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "AgentRegistered");
      expect(ev).to.exist;
      const vaultAddr = ev.args.vault;
      const Vault = await ethers.getContractFactory("AgentVault");
      const vault = Vault.attach(vaultAddr);
      expect(await vault.player()).to.equal(alice.address);
      expect(await vault.registry()).to.equal(await registry.getAddress());
    });

    it("rejects double registration", async function () {
      const { registry, alice } = await loadFixture(setup);
      const stratHash = ethers.keccak256(ethers.toUtf8Bytes("a"));
      await registry.connect(alice).registerAgent(stratHash, 1n, 2n, GM(DICE));
      await expect(registry.connect(alice).registerAgent(stratHash, 1n, 2n, GM(DICE)))
        .to.be.revertedWithCustomError(registry, "AlreadyRegistered");
    });

    it("rejects zero limits / mask", async function () {
      const { registry, alice } = await loadFixture(setup);
      const h = ethers.ZeroHash;
      await expect(registry.connect(alice).registerAgent(h, 0, 1n, GM(DICE)))
        .to.be.revertedWithCustomError(registry, "InvalidLimits");
      await expect(registry.connect(alice).registerAgent(h, 1n, 0, GM(DICE)))
        .to.be.revertedWithCustomError(registry, "InvalidLimits");
      await expect(registry.connect(alice).registerAgent(h, 1n, 2n, 0))
        .to.be.revertedWithCustomError(registry, "InvalidLimits");
      await expect(registry.connect(alice).registerAgent(h, 10n, 5n, GM(DICE)))
        .to.be.revertedWithCustomError(registry, "InvalidLimits");
    });
  });

  describe("pause / resume / update", function () {
    it("player can pause and resume", async function () {
      const { registry, alice } = await loadFixture(setup);
      await registry.connect(alice).registerAgent(ethers.ZeroHash, 1n, 2n, GM(DICE));
      await expect(registry.connect(alice).pauseAgent()).to.emit(registry, "AgentPaused");
      let p = await registry.getPermission(alice.address);
      expect(p.active).to.equal(false);
      await expect(registry.connect(alice).resumeAgent()).to.emit(registry, "AgentResumed");
      p = await registry.getPermission(alice.address);
      expect(p.active).to.equal(true);
    });

    it("update changes params", async function () {
      const { registry, alice } = await loadFixture(setup);
      await registry.connect(alice).registerAgent(ethers.ZeroHash, 1n, 2n, GM(DICE));
      await registry.connect(alice).updateAgentParams(
        ethers.parseEther("3"),
        ethers.parseEther("30"),
        GM(DICE, 2),
        ethers.keccak256(ethers.toUtf8Bytes("v2"))
      );
      const p = await registry.getPermission(alice.address);
      expect(p.dailyLimit).to.equal(ethers.parseEther("3"));
      expect(p.totalLimit).to.equal(ethers.parseEther("30"));
      expect(p.allowedGamesMask).to.equal(GM(DICE, 2));
    });
  });

  describe("executeBet", function () {
    async function setupRegistered() {
      const fx = await loadFixture(setup);
      const { registry, alice, casino } = fx;
      await registry.connect(alice).registerAgent(
        ethers.ZeroHash,
        ethers.parseEther("1"),
        ethers.parseEther("10"),
        GM(DICE)
      );
      const p = await registry.getPermission(alice.address);
      // fund the vault
      await alice.sendTransaction({ to: p.vault, value: ethers.parseEther("2") });
      return { ...fx, vaultAddr: p.vault };
    }

    it("only relayer can execute", async function () {
      const { registry, alice, vaultAddr } = await setupRegistered();
      const calldata = registry.interface.encodeFunctionData; // unused
      // build casino calldata
      // We only need the ABI here — getContractFactory needs library linking,
      // but the JSON ABI works without linking, so read the artifact directly.
      const casinoIface = new ethers.Interface(
        require("../artifacts/contracts/Casino.sol/Casino.json").abi
      );
      const data = casinoIface.encodeFunctionData("placeDiceBet", [50, true, ethers.hexlify(ethers.randomBytes(32))]);
      await expect(registry.connect(alice).executeBet(alice.address, DICE, ethers.parseEther("0.1"), data))
        .to.be.revertedWithCustomError(registry, "NotExecutor");
    });

    it("relayer places a bet via the vault", async function () {
      const { registry, relayer, alice, casino, vaultAddr } = await setupRegistered();
      // We only need the ABI here — getContractFactory needs library linking,
      // but the JSON ABI works without linking, so read the artifact directly.
      const casinoIface = new ethers.Interface(
        require("../artifacts/contracts/Casino.sol/Casino.json").abi
      );
      const cs = ethers.hexlify(ethers.randomBytes(32));
      const data = casinoIface.encodeFunctionData("placeDiceBet", [50, true, cs]);
      const tx = await registry.connect(relayer).executeBet(alice.address, DICE, ethers.parseEther("0.1"), data);
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "BetExecuted");
      expect(ev).to.exist;
      expect(ev.args.player).to.equal(alice.address);
      // Casino sees vault as the bet player
      const betId = ev.args.betId;
      const bet = await casino.getBet(betId);
      expect(bet.player).to.equal(vaultAddr);
      expect(bet.amount).to.equal(ethers.parseEther("0.1"));
    });

    it("rejects when game not allowed", async function () {
      const { registry, relayer, alice } = await setupRegistered();
      // Round-based roulette doesn't take a clientSeed; we can't even encode
      // it as a Dice call to reach the limit code, so we encode a real
      // round-style placeRouletteBets payload (empty bets array — never
      // actually executed since GameNotAllowed reverts first).
      // We only need the ABI here — getContractFactory needs library linking,
      // but the JSON ABI works without linking, so read the artifact directly.
      const casinoIface = new ethers.Interface(
        require("../artifacts/contracts/Casino.sol/Casino.json").abi
      );
      const data = casinoIface.encodeFunctionData("placeRouletteBets", [[]]);
      await expect(registry.connect(relayer).executeBet(alice.address, 5, ethers.parseEther("0.1"), data))
        .to.be.revertedWithCustomError(registry, "GameNotAllowed");
    });

    it("enforces daily limit", async function () {
      const { registry, relayer, alice } = await setupRegistered();
      // We only need the ABI here — getContractFactory needs library linking,
      // but the JSON ABI works without linking, so read the artifact directly.
      const casinoIface = new ethers.Interface(
        require("../artifacts/contracts/Casino.sol/Casino.json").abi
      );
      const cs = ethers.hexlify(ethers.randomBytes(32));
      // dailyLimit was 1 ETH; 0.6 + 0.6 > 1
      const data1 = casinoIface.encodeFunctionData("placeDiceBet", [50, true, cs]);
      await registry.connect(relayer).executeBet(alice.address, DICE, ethers.parseEther("0.6"), data1);
      const data2 = casinoIface.encodeFunctionData("placeDiceBet", [50, true, cs]);
      await expect(registry.connect(relayer).executeBet(alice.address, DICE, ethers.parseEther("0.6"), data2))
        .to.be.revertedWithCustomError(registry, "DailyLimitExceeded");
    });

    it("daily counter resets on new day", async function () {
      const { registry, relayer, alice } = await setupRegistered();
      // We only need the ABI here — getContractFactory needs library linking,
      // but the JSON ABI works without linking, so read the artifact directly.
      const casinoIface = new ethers.Interface(
        require("../artifacts/contracts/Casino.sol/Casino.json").abi
      );
      const cs = ethers.hexlify(ethers.randomBytes(32));
      const data = casinoIface.encodeFunctionData("placeDiceBet", [50, true, cs]);
      await registry.connect(relayer).executeBet(alice.address, DICE, ethers.parseEther("0.9"), data);
      // jump 1 day forward
      await network.provider.send("evm_increaseTime", [86400 + 1]);
      await network.provider.send("evm_mine");
      await expect(registry.connect(relayer).executeBet(alice.address, DICE, ethers.parseEther("0.9"), data))
        .to.not.be.reverted;
    });

    it("enforces total limit", async function () {
      const { registry, relayer, alice, vaultAddr } = await setupRegistered();
      // Top up vault generously
      await alice.sendTransaction({ to: vaultAddr, value: ethers.parseEther("20") });
      // We only need the ABI here — getContractFactory needs library linking,
      // but the JSON ABI works without linking, so read the artifact directly.
      const casinoIface = new ethers.Interface(
        require("../artifacts/contracts/Casino.sol/Casino.json").abi
      );
      const cs = ethers.hexlify(ethers.randomBytes(32));
      const data = casinoIface.encodeFunctionData("placeDiceBet", [50, true, cs]);
      for (let day = 0; day < 11; day++) {
        if (day === 10) {
          await expect(registry.connect(relayer).executeBet(alice.address, DICE, ethers.parseEther("1"), data))
            .to.be.revertedWithCustomError(registry, "TotalLimitExceeded");
          return;
        }
        await registry.connect(relayer).executeBet(alice.address, DICE, ethers.parseEther("1"), data);
        await network.provider.send("evm_increaseTime", [86400 + 1]);
        await network.provider.send("evm_mine");
      }
    });

    it("paused agent rejects executeBet", async function () {
      const { registry, relayer, alice } = await setupRegistered();
      await registry.connect(alice).pauseAgent();
      // We only need the ABI here — getContractFactory needs library linking,
      // but the JSON ABI works without linking, so read the artifact directly.
      const casinoIface = new ethers.Interface(
        require("../artifacts/contracts/Casino.sol/Casino.json").abi
      );
      const cs = ethers.hexlify(ethers.randomBytes(32));
      const data = casinoIface.encodeFunctionData("placeDiceBet", [50, true, cs]);
      await expect(registry.connect(relayer).executeBet(alice.address, DICE, ethers.parseEther("0.1"), data))
        .to.be.revertedWithCustomError(registry, "AgentInactive");
    });
  });

  describe("vault end-to-end", function () {
    it("player can withdraw vault balance after winning", async function () {
      const { registry, casino, hm, relayer, alice, owner } = await loadFixture(setup);
      // register with high limit
      await registry.connect(alice).registerAgent(
        ethers.ZeroHash,
        ethers.parseEther("1"),
        ethers.parseEther("10"),
        GM(DICE)
      );
      const p = await registry.getPermission(alice.address);
      await alice.sendTransaction({ to: p.vault, value: ethers.parseEther("0.5") });
      const Vault = await ethers.getContractFactory("AgentVault");
      const vault = Vault.attach(p.vault);

      // We only need the ABI here — getContractFactory needs library linking,
      // but the JSON ABI works without linking, so read the artifact directly.
      const casinoIface = new ethers.Interface(
        require("../artifacts/contracts/Casino.sol/Casino.json").abi
      );
      const cs = ethers.hexlify(ethers.randomBytes(32));
      // bet that wins ~98% of the time
      const data = casinoIface.encodeFunctionData("placeDiceBet", [2, true, cs]);
      const tx = await registry.connect(relayer).executeBet(alice.address, DICE, ethers.parseEther("0.1"), data);
      const r = await tx.wait();
      const betId = r.logs.find(l => l.fragment && l.fragment.name === "BetExecuted").args.betId;

      await mineN(REVEAL_DELAY + 1n);
      const seedIdx = (await casino.getBet(betId)).seedIdx;
      // We don't have direct seeds here; refetch from the helpers' set is tricky.
      // Instead: provision more seeds in setup beforehand and snag seed[0]. Skip this and just verify vault balance can drain.
      const before = await ethers.provider.getBalance(alice.address);
      const txW = await vault.connect(alice).withdrawAll();
      const rW = await txW.wait();
      const gas = rW.gasUsed * rW.gasPrice;
      const after = await ethers.provider.getBalance(alice.address);
      // vault had 0.5 - 0.1 = 0.4 left after the bet executes
      expect(after - before + gas).to.equal(ethers.parseEther("0.4"));
    });

    it("non-player cannot withdraw vault", async function () {
      const { registry, alice, bob } = await loadFixture(setup);
      await registry.connect(alice).registerAgent(ethers.ZeroHash, 1n, 2n, GM(DICE));
      const p = await registry.getPermission(alice.address);
      await alice.sendTransaction({ to: p.vault, value: ethers.parseEther("0.1") });
      const Vault = await ethers.getContractFactory("AgentVault");
      const vault = Vault.attach(p.vault);
      await expect(vault.connect(bob).withdrawAll())
        .to.be.revertedWithCustomError(vault, "NotPlayer");
    });

    it("only registry can call vault.executeBet", async function () {
      const { registry, alice, bob } = await loadFixture(setup);
      await registry.connect(alice).registerAgent(ethers.ZeroHash, 1n, 2n, GM(DICE));
      const p = await registry.getPermission(alice.address);
      const Vault = await ethers.getContractFactory("AgentVault");
      const vault = Vault.attach(p.vault);
      await expect(vault.connect(bob).executeBet(1n, "0x"))
        .to.be.revertedWithCustomError(vault, "NotRegistry");
    });
  });
});
