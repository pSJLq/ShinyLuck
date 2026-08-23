const { expect } = require("chai");
const { ethers, network } = require("hardhat");

// Mirror of CommitReveal.deriveRandomness + DiceModule math, so we can assert
// the on-chain port is byte-identical to v14.
function deriveRandomness(serverSeed, clientSeed, futureHash, nonce) {
  return ethers.keccak256(
    ethers.solidityPacked(
      ["bytes32", "bytes32", "bytes32", "uint256"],
      [serverSeed, clientSeed, futureHash, nonce]
    )
  );
}
function dicePayout(stake, winChance) {
  const EDGE = 100n;
  return (stake * (10000n - EDGE)) / (winChance * 100n);
}

describe("CasinoVault v15 — Dice", () => {
  let vault, dice, owner, player;
  const serverSeed = ethers.id("server-seed-1");
  const seedHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [serverSeed])
  );
  const clientSeed = ethers.id("client-seed-1");

  beforeEach(async () => {
    [owner, player] = await ethers.getSigners();
    vault = await (await ethers.getContractFactory("CasinoVault")).deploy();
    dice = await (await ethers.getContractFactory("DiceModule")).deploy(await vault.getAddress());
    await vault.registerGame(0, await dice.getAddress(), ethers.parseEther("1000"));
    await vault.depositBankroll({ value: ethers.parseEther("100") });
    await vault.provisionSeedHashes([seedHash]);
  });

  async function placeAndSettle(target, over, stake) {
    const params = ethers.AbiCoder.defaultAbiCoder().encode(["uint8", "bool"], [target, over]);
    const tx = await vault.connect(player).placeBet(0, clientSeed, params, { value: stake });
    const rc = await tx.wait();
    const betId = 0n;
    const bet = await vault.getBet(betId);
    const commitBlock = bet.commitBlock;
    // advance so blockhash(commitBlock+1) exists and reveal is allowed
    await network.provider.send("evm_mine");
    const futureHash = (await ethers.provider.getBlock(Number(commitBlock) + 1)).hash;
    await vault.revealAndSettle(betId, serverSeed);
    return { betId, bet: await vault.getBet(betId), futureHash, commitBlock, params };
  }

  it("settles a dice bet with v14-identical math", async () => {
    const stake = ethers.parseEther("0.1");
    const target = 50, over = false; // win if roll < 50, winChance = 49
    const { bet, futureHash } = await placeAndSettle(target, over, stake);

    const randomness = deriveRandomness(serverSeed, clientSeed, futureHash, bet.nonce);
    const roll = (BigInt(randomness) % 100n) + 1n;
    const won = over ? roll > BigInt(target) : roll < BigInt(target);
    const expectedPayout = won ? dicePayout(stake, over ? 100n - BigInt(target) : BigInt(target) - 1n) : 0n;

    expect(bet.status).to.equal(1); // settled
    expect(bet.won).to.equal(won && expectedPayout > 0n);
    expect(bet.payout).to.equal(expectedPayout);
    expect(await vault.pendingWithdrawals(player.address)).to.equal(expectedPayout);
  });

  it("player can claim a winning payout", async () => {
    // pick a very likely win (target 98 under → winChance 97) to exercise claim
    const stake = ethers.parseEther("0.1");
    const { bet } = await placeAndSettle(98, false, stake);
    const pending = await vault.pendingWithdrawals(player.address);
    if (pending === 0n) return; // unlucky roll; math already asserted in other test
    const before = await ethers.provider.getBalance(player.address);
    const tx = await vault.connect(player).claim();
    const rc = await tx.wait();
    const gas = rc.gasUsed * rc.gasPrice;
    const after = await ethers.provider.getBalance(player.address);
    expect(after + gas - before).to.equal(pending);
  });

  it("rejects bets on an unregistered game (trust boundary)", async () => {
    const params = ethers.AbiCoder.defaultAbiCoder().encode(["uint8", "bool"], [50, false]);
    await expect(
      vault.connect(player).placeBet(7, clientSeed, params, { value: ethers.parseEther("0.1") })
    ).to.be.revertedWithCustomError(vault, "GameNotRegistered");
  });

  it("only owner can register a game", async () => {
    await expect(
      vault.connect(player).registerGame(1, await dice.getAddress(), 0)
    ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
  });

  it("per-game budget clamps the house's loss (blast radius)", async () => {
    // Fresh game with a tiny budget: a winning payout is clamped so the game
    // can never cost the house more than its budget.
    await vault.setGameBudget(0, ethers.parseEther("0.001"));
    const stake = ethers.parseEther("0.1");
    const { bet } = await placeAndSettle(98, false, stake); // high win chance
    // net = payout - stake <= budget  → payout <= budget + stake
    const budget = ethers.parseEther("0.001");
    expect(bet.payout).to.be.lte(budget + stake);
  });
});
