// End-to-end integration test.
//
// Walks the full ShinyLuck flow against a fresh hardhat network, mirroring
// the production stack:
//   1. Deploy Casino + HouseManager + AgentQuorumVerifier + PlayerAgentRegistry
//   2. Fund bankroll, provision seed batch
//   3. Player places a Dice bet
//   4. After 4 blocks, house service calls revealAndSettle
//   5. Player claims (if won)
//   6. Player registers an agent, funds vault, relayer executes a bet
//   7. Reveal + reconcile P&L
//   8. Mines: place → reveal seed → open safe cell → cashout
//   9. HouseManager activates Bonus Mode, edge halves
//  10. Owner schedules + executes the timelocked withdrawal

const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { mineN, genServerSeed, hashServerSeed, REVEAL_DELAY } = require("./helpers");

describe("E2E", function () {
  let owner, hmAgent, alice, bob, relayer;
  let casino, hm, registry, verifier, mockPlatform;
  const seeds = [];

  before(async function () {
    [owner, hmAgent, alice, bob, relayer] = await ethers.getSigners();

    const Casino = await ethers.getContractFactory("Casino");
    casino = await Casino.deploy(owner.address);
    await casino.waitForDeployment();

    const HM = await ethers.getContractFactory("HouseManager");
    hm = await HM.deploy(await casino.getAddress(), hmAgent.address);
    await hm.waitForDeployment();

    const Reg = await ethers.getContractFactory("PlayerAgentRegistry");
    registry = await Reg.deploy(await casino.getAddress(), relayer.address);
    await registry.waitForDeployment();

    const Mock = await ethers.getContractFactory("MockAgentPlatform");
    mockPlatform = await Mock.deploy();
    await mockPlatform.waitForDeployment();

    const Verifier = await ethers.getContractFactory("AgentQuorumVerifier");
    verifier = await Verifier.deploy(
      await casino.getAddress(),
      await mockPlatform.getAddress(),
      128472938475610293844n
    );
    await verifier.waitForDeployment();

    // Wire HM into Casino
    await casino.connect(owner).setHouseManager(await hm.getAddress());

    // Fund bankroll
    await owner.sendTransaction({ to: await casino.getAddress(), value: ethers.parseEther("100") });

    // Provision seeds via owner-fallback path (HM Agent EOA could also do it).
    const hashes = [];
    for (let i = 0; i < 50; i++) {
      const s = genServerSeed();
      seeds.push(s);
      hashes.push(hashServerSeed(s));
    }
    await casino.connect(owner).provisionSeedHashes(hashes);
  });

  it("[1] direct dice bet — place → reveal → settle → claim", async function () {
    const cs = ethers.hexlify(ethers.randomBytes(32));
    await casino.connect(alice).placeDiceBet(2, true, cs, { value: ethers.parseEther("0.1") });
    const betId = (await casino.totalBets()) - 1n;
    await mineN(REVEAL_DELAY + 1n);
    const seedIdx = (await casino.getBet(betId)).seedIdx;
    await casino.connect(bob).revealAndSettle(betId, seeds[Number(seedIdx)]);
    const bet = await casino.getBet(betId);
    expect(bet.status).to.equal(1);
    if (bet.won) {
      const credit = await casino.pendingWithdrawals(alice.address);
      expect(credit).to.equal(bet.payout);
      const balBefore = await ethers.provider.getBalance(alice.address);
      const tx = await casino.connect(alice).claim();
      const r = await tx.wait();
      const gas = r.gasUsed * r.gasPrice;
      const balAfter = await ethers.provider.getBalance(alice.address);
      expect(balAfter - balBefore + gas).to.equal(credit);
    }
  });

  it("[2] HM agent activates Bonus Mode — edge halves", async function () {
    const before = await casino.houseEdgeBps(0);
    await hm.connect(hmAgent).activateBonusMode(60, "bankroll +12%");
    expect(await casino.houseEdgeBps(0)).to.equal(before / 2n);
  });

  it("[3] HM agent records reasoning", async function () {
    await expect(hm.connect(hmAgent).recordReasoning("variance up; max bet 0.5 STT"))
      .to.emit(casino, "ReasoningLog");
  });

  it("[4] player registers agent + relayer places bet from vault", async function () {
    await registry.connect(alice).registerAgent(
      ethers.keccak256(ethers.toUtf8Bytes("dice over 60")),
      ethers.parseEther("1"),
      ethers.parseEther("10"),
      1 << 0 // DICE
    );
    const perm = await registry.getPermission(alice.address);
    await alice.sendTransaction({ to: perm.vault, value: ethers.parseEther("1") });

    const casinoIface = new ethers.Interface(
      require("../artifacts/contracts/Casino.sol/Casino.json").abi
    );
    const cs = ethers.hexlify(ethers.randomBytes(32));
    const data = casinoIface.encodeFunctionData("placeDiceBet", [2, true, cs]);
    const tx = await registry.connect(relayer).executeBet(
      alice.address, 0, ethers.parseEther("0.1"), data
    );
    const r = await tx.wait();
    const ev = r.logs.find((l) => {
      try { return registry.interface.parseLog(l)?.name === "BetExecuted"; } catch { return false; }
    });
    expect(ev).to.exist;
    const parsed = registry.interface.parseLog(ev);
    const betId = parsed.args.betId;
    await mineN(REVEAL_DELAY + 1n);
    const idx = (await casino.getBet(betId)).seedIdx;
    await casino.connect(bob).revealAndSettle(betId, seeds[Number(idx)]);
    const settled = await casino.getBet(betId);
    expect(settled.status).to.equal(1);
    expect(settled.player).to.equal(perm.vault);
  });

  it("[5] mines: place → commit hidden root → open safe cell → cashout → finalize", async function () {
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const selectMines = (randomness, mineCount) => {
      let bits = 0n; const cells = [...Array(25).keys()]; let remaining = 25; let r = randomness;
      for (let i = 0; i < mineCount; i++) {
        r = ethers.keccak256(coder.encode(["bytes32", "uint8"], [r, i]));
        const idx = Number(BigInt(r) % BigInt(remaining));
        bits |= 1n << BigInt(cells[idx]); cells[idx] = cells[remaining - 1]; remaining--;
      }
      return bits;
    };
    const salt = (ss, id, i) => ethers.keccak256(coder.encode(["bytes32", "uint256", "uint256"], [ss, id, i]));
    const buildTree = (id, bm, ss) => {
      const leaves = [];
      for (let i = 0; i < 25; i++)
        leaves.push(ethers.keccak256(coder.encode(["uint256", "uint256", "bool", "bytes32"],
          [id, i, ((bm >> BigInt(i)) & 1n) === 1n, salt(ss, id, i)])));
      for (let i = 25; i < 32; i++) leaves.push(ethers.keccak256(coder.encode(["uint256", "uint256"], [id, i])));
      const levels = [leaves];
      while (levels[levels.length - 1].length > 1) {
        const prev = levels[levels.length - 1]; const next = [];
        for (let i = 0; i < prev.length; i += 2) next.push(ethers.keccak256(ethers.concat([prev[i], prev[i + 1]])));
        levels.push(next);
      }
      return { root: levels[levels.length - 1][0], levels };
    };
    const proofFor = (levels, index) => {
      const p = []; let idx = index;
      for (let l = 0; l < 5; l++) { p.push(levels[l][idx ^ 1]); idx >>= 1; }
      return p;
    };

    const cs = ethers.hexlify(ethers.randomBytes(32));
    await casino.connect(alice).placeMinesBet(5, cs, { value: ethers.parseEther("0.1") });
    const betId = (await casino.totalBets()) - 1n;
    await mineN(REVEAL_DELAY + 1n);
    const bet = await casino.getBet(betId);
    const ss = seeds[Number(bet.seedIdx)];
    const blk = await ethers.provider.getBlock(Number(bet.commitBlock) + Number(REVEAL_DELAY));
    const randomness = ethers.keccak256(ethers.solidityPacked(
      ["bytes32", "bytes32", "bytes32", "uint256"], [ss, bet.clientSeed, blk.hash, bet.nonce]));
    const bitmap = selectMines(randomness, 5);
    const tree = buildTree(betId, bitmap, ss);
    // owner is an allowed coordinator (owner() || houseManager)
    await casino.connect(owner).commitMinesRoot(betId, tree.root);
    let safe = -1;
    for (let i = 0; i < 25; i++) if (((bitmap >> BigInt(i)) & 1n) === 0n) { safe = i; break; }
    await casino.connect(alice).openMinesCell(betId, safe, false, salt(ss, betId, safe), proofFor(tree.levels, safe));
    await casino.connect(alice).cashoutMines(betId);
    expect((await casino.getBet(betId)).won).to.equal(true);
    // post-game transparency: honest root → no fraud
    await expect(casino.finalizeMines(betId, ss)).to.emit(casino, "MinesLayout");
  });

  it("[6] agent quorum verifier — match → QuorumOk", async function () {
    // Pull last settled non-mines bet from alice/vault
    const total = await casino.totalBets();
    let target = -1n;
    for (let i = total - 1n; i >= 0n; i--) {
      const b = await casino.getBet(i);
      if (b.status === 1n && Number(b.game) !== 3) { target = i; break; }
    }
    const bet = await casino.getBet(target);
    await mockPlatform.setNextResponse(bet.randomness);
    const price = await verifier.quotePrice();
    await verifier.connect(alice).requestVerification(target, { value: price });
    const tx = await mockPlatform.triggerCallback(1);
    const r = await tx.wait();
    const evt = r.logs.map((l) => { try { return verifier.interface.parseLog(l); } catch { return null; } })
                      .find((p) => p && p.name === "QuorumResult");
    expect(evt).to.exist;
    expect(evt.args.level).to.equal(2); // ok
    expect(evt.args.signers).to.equal(4);
  });

  it("[7] HM provisions more seeds + per-game pause path works", async function () {
    const newHashes = [];
    for (let i = 0; i < 5; i++) newHashes.push(hashServerSeed(genServerSeed()));
    await hm.connect(hmAgent).provisionSeedHashes(newHashes);
    await hm.connect(hmAgent).pauseGame(0);
    const cs = ethers.hexlify(ethers.randomBytes(32));
    await expect(casino.connect(alice).placeDiceBet(50, true, cs, { value: ethers.parseEther("0.05") }))
      .to.be.revertedWithCustomError(casino, "GameIsPaused");
    await hm.connect(hmAgent).unpauseGame(0);
  });

  it("[8] owner timelocked withdrawal", async function () {
    // OWNER_WITHDRAW_DELAY is 0 on the testnet build, 24h on mainnet — read it.
    const delay = await casino.OWNER_WITHDRAW_DELAY();
    await casino.connect(owner).scheduleOwnerWithdraw(ethers.parseEther("0.5"));
    if (delay > 0n) {
      await expect(casino.connect(owner).executeOwnerWithdraw()).to.be.revertedWith("timelock");
      await network.provider.send("evm_increaseTime", [Number(delay) + 1]);
      await network.provider.send("evm_mine");
    }
    await casino.connect(owner).executeOwnerWithdraw();
  });

  it("[9] expired bet path — refund instead of settle", async function () {
    const cs = ethers.hexlify(ethers.randomBytes(32));
    await casino.connect(alice).placeDiceBet(50, true, cs, { value: ethers.parseEther("0.05") });
    const betId = (await casino.totalBets()) - 1n;
    await mineN(REVEAL_DELAY + 256n + 1n);
    const tx = await casino.connect(bob).revealAndSettle(betId, ethers.ZeroHash);
    const r = await tx.wait();
    const refunded = r.logs.some((l) => {
      try { return casino.interface.parseLog(l)?.name === "BetRefunded"; } catch { return false; }
    });
    expect(refunded).to.equal(true);
  });

  it("[10] frontend SDK helper — verifyRandomness reproduces on-chain hash", async function () {
    // Pull a settled non-mines bet
    const total = await casino.totalBets();
    let target = -1n;
    for (let i = total - 1n; i >= 0n; i--) {
      const b = await casino.getBet(i);
      if (b.status === 1n && Number(b.game) !== 3 && b.randomness !== ethers.ZeroHash) { target = i; break; }
    }
    const bet = await casino.getBet(target);
    const evFilter = casino.filters.BetSettled(target);
    const events = await casino.queryFilter(evFilter);
    const ev = events[0];
    const expected = ethers.solidityPackedKeccak256(
      ["bytes32", "bytes32", "bytes32", "uint256"],
      [ev.args.serverSeed, ev.args.clientSeed, ev.args.blockHash, ev.args.nonce]
    );
    expect(expected).to.equal(bet.randomness);
  });
});
