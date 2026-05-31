const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployCasino, provisionSeeds } = require("./helpers");

// Verifies the agent-native Player Agent path: HouseManager fires an
// inferToolsChat request, the (mocked) agent yields a placeBet(uint8,uint96)
// on-chain tool call, HM decodes it, routes it through registry.executeBet
// (which spends from the player's vault under their limits), and fires a
// resume request. This proves the state machine WITHOUT the live platform.
describe("HouseManager — inferToolsChat Player Agent", function () {
  const DICE = 0;

  async function setup() {
    const [owner, hmAgent, alice] = await ethers.getSigners();
    const casino = await deployCasino(undefined, ethers.parseEther("100"));
    // Provision seeds so place*Bet works (deployCasino doesn't seed).
    await provisionSeeds(casino, owner, 20);

    const HM = await ethers.getContractFactory("HouseManager");
    const hm = await HM.deploy(await casino.getAddress(), hmAgent.address);
    await hm.waitForDeployment();
    await casino.connect(owner).setHouseManager(await hm.getAddress());

    const Reg = await ethers.getContractFactory("PlayerAgentRegistry");
    const registry = await Reg.deploy(await casino.getAddress(), owner.address);
    await registry.waitForDeployment();
    // HM must be an executor so it can collectAgentFee + executeBet.
    await registry.connect(owner).addExecutor(await hm.getAddress());
    await hm.connect(owner).setPlayerRegistry(await registry.getAddress());

    const Mock = await ethers.getContractFactory("MockAgentPlatform");
    const platform = await Mock.deploy();
    await platform.waitForDeployment();
    await hm.connect(owner).setAgentPlatform(await platform.getAddress(), 12847293847561029384n);

    // Fund HM above the Reactivity floor so quoteLlmCost checks pass.
    await owner.sendTransaction({ to: await hm.getAddress(), value: ethers.parseEther("40") });

    // Alice registers an agent with a strategy + DICE allowed, then funds vault.
    const GM = (g) => 1 << g;
    await registry.connect(alice).registerAgent("be aggressive, prefer dice", ethers.parseEther("1"), ethers.parseEther("5"), GM(DICE));
    const perm = await registry.permissions(alice.address);
    await owner.sendTransaction({ to: perm.vault, value: ethers.parseEther("2") });

    return { owner, hmAgent, alice, casino, hm, registry, platform, vault: perm.vault };
  }

  it("stores the player's natural-language strategy on-chain", async function () {
    const { registry, alice } = await loadFixture(setup);
    expect(await registry.getStrategy(alice.address)).to.equal("be aggressive, prefer dice");
  });

  it("agent yields placeBet tool call -> HM executes it from the vault + resumes", async function () {
    const { hmAgent, alice, casino, hm, platform } = await loadFixture(setup);

    // 1. Fire the per-player decision (hmAgent-authorised). This creates the
    //    first inferToolsChat request (id 1) on the mock platform.
    await hm.connect(hmAgent).requestPlayerDecision(alice.address);

    // 2. Craft a canned inferToolsChat 6-tuple result: finishReason
    //    "tool_calls", with one pending call = placeBet(0, 0.1 ether).
    const iface = new ethers.Interface(["function placeBet(uint8 game, uint96 stakeWei)"]);
    const toolCalldata = iface.encodeFunctionData("placeBet", [DICE, ethers.parseEther("0.1")]);
    const raw = ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "string", "string[]", "string[]", "string[]", "bytes[]"],
      [
        "tool_calls",
        "",
        ["system", "user", "assistant"],
        ["sys", "usr", "calling placeBet"],
        ["call_1"],
        [toolCalldata],
      ]
    );
    await platform.setNextRawResult(raw);

    // 3. Deliver the callback. HM should decode the tool call, place a dice
    //    bet from Alice's vault (emitting BetPlaced on the casino), emit
    //    PlayerAgentToolCall(placed=true), and fire a resume request (id 2).
    await expect(platform.triggerCallback(1))
      .to.emit(hm, "PlayerAgentToolCall")
      .and.to.emit(casino, "BetPlaced");

    // 4. The resume request was created (nextRequestId advanced to 3).
    expect(await platform.nextRequestId()).to.equal(3n);

    // 5. Deliver a "stop" to close the resume cleanly.
    const stopRaw = ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "string", "string[]", "string[]", "string[]", "bytes[]"],
      ["stop", "done for this tick", [], [], [], []]
    );
    await platform.setNextRawResult(stopRaw);
    await expect(platform.triggerCallback(2))
      .to.emit(hm, "PlayerDecisionResolved");
  });

  it("agent replies 'stop' (no bet) -> SKIP, no vault spend", async function () {
    const { hmAgent, alice, hm, platform, registry } = await loadFixture(setup);
    await hm.connect(hmAgent).requestPlayerDecision(alice.address);
    const stopRaw = ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "string", "string[]", "string[]", "string[]", "bytes[]"],
      ["stop", "waiting", [], [], [], []]
    );
    await platform.setNextRawResult(stopRaw);
    await expect(platform.triggerCallback(1)).to.emit(hm, "PlayerDecisionResolved");
    // No bet placed -> spentTotal stays 0.
    const perm = await registry.permissions(alice.address);
    expect(perm.spentTotal).to.equal(0n);
  });

  it("agentManifest returns live casino state for external agents", async function () {
    const { hm, casino } = await loadFixture(setup);
    const m = await hm.agentManifest();
    expect(m.casino).to.equal(await casino.getAddress());
    expect(m.games.length).to.equal(7);
    expect(m.freeBankrollWei).to.be.greaterThan(0n);
  });
});
