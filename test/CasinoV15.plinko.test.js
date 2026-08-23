const { expect } = require("chai");
const { ethers, network } = require("hardhat");

function deriveRandomness(serverSeed, clientSeed, futureHash, nonce) {
  return ethers.keccak256(
    ethers.solidityPacked(
      ["bytes32", "bytes32", "bytes32", "uint256"],
      [serverSeed, clientSeed, futureHash, nonce]
    )
  );
}
const RISK0 = [1600n,900n,200n,140n,140n,120n,110n,100n,50n,100n,110n,120n,140n,140n,200n,900n,1600n];
function popcount16(x) { let c = 0n; for (let i = 0n; i < 16n; i++) if ((x >> i) & 1n) c++; return c; }

describe("CasinoVault v15 — Plinko", () => {
  let vault, plinko, owner, player;
  const serverSeed = ethers.id("plinko-server");
  const seedHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [serverSeed]));
  const clientSeed = ethers.id("plinko-client");

  beforeEach(async () => {
    [owner, player] = await ethers.getSigners();
    vault = await (await ethers.getContractFactory("CasinoVault")).deploy();
    plinko = await (await ethers.getContractFactory("PlinkoModule")).deploy(await vault.getAddress());
    await vault.registerGame(4, await plinko.getAddress(), ethers.parseEther("1000"));
    await vault.depositBankroll({ value: ethers.parseEther("100") });
    await vault.provisionSeedHashes([seedHash]);
  });

  it("settles a plinko drop with v14-identical tables", async () => {
    const stake = ethers.parseEther("0.1");
    const params = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [0]); // risk 0
    await vault.connect(player).placeBet(4, clientSeed, params, { value: stake });
    const bet0 = await vault.getBet(0);
    await network.provider.send("evm_mine");
    const futureHash = (await ethers.provider.getBlock(Number(bet0.commitBlock) + 1)).hash;
    await vault.revealAndSettle(0, serverSeed);

    const randomness = deriveRandomness(serverSeed, clientSeed, futureHash, bet0.nonce);
    const slot = popcount16(BigInt(randomness) & 0xFFFFn);
    const payX100 = RISK0[Number(slot)];
    const expectedPayout = (stake * payX100) / 100n;

    const bet = await vault.getBet(0);
    expect(bet.status).to.equal(1);
    expect(bet.payout).to.equal(expectedPayout);
    expect(bet.won).to.equal(expectedPayout >= stake && expectedPayout > 0n);
  });

  it("rejects invalid risk via the module quote", async () => {
    const stake = ethers.parseEther("0.1");
    const params = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [5]); // invalid
    await expect(
      vault.connect(player).placeBet(4, clientSeed, params, { value: stake })
    ).to.be.reverted; // module quote require("risk") bubbles up through the vault
  });
});
