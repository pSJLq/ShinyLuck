const { ethers, network } = require("hardhat");

// Mirror CommitReveal.REVEAL_DELAY (contract constant). Trimmed 3 -> 1 in
// gen-15 to shave block-time off the spin loop; keep this in sync.
const REVEAL_DELAY = 1n;

async function mineN(n) {
  for (let i = 0; i < Number(n); i++) await network.provider.send("evm_mine");
}

function genServerSeed() {
  return ethers.hexlify(ethers.randomBytes(32));
}

function hashServerSeed(seed) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [seed])
  );
}

async function deployCasino(houseManager, fund = ethers.parseEther("1000")) {
  // Both Vault7Lib and ClusterLib use only `internal` functions, so Solidity
  // inlines them into Casino — no separate library deployment / linking
  // step is needed.
  const Casino = await ethers.getContractFactory("Casino");
  const casino = await Casino.deploy(houseManager?.address ?? ethers.ZeroAddress);
  await casino.waitForDeployment();
  if (fund > 0n) {
    const [owner] = await ethers.getSigners();
    await owner.sendTransaction({ to: await casino.getAddress(), value: fund });
  }
  return casino;
}

/// Provision a batch of seeds and return the seeds (for later reveal) and hashes.
async function provisionSeeds(casino, signer, count) {
  const seeds = [];
  const hashes = [];
  for (let i = 0; i < count; i++) {
    const s = genServerSeed();
    seeds.push(s);
    hashes.push(hashServerSeed(s));
  }
  await casino.connect(signer).provisionSeedHashes(hashes);
  return { seeds, hashes };
}

module.exports = {
  REVEAL_DELAY,
  mineN,
  genServerSeed,
  hashServerSeed,
  deployCasino,
  provisionSeeds,
};
