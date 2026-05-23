// Un-pause every game. Use after the circuit breaker tripped or after a
// manual pause sweep. Only the contract owner or the HM agent can call
// unpauseGame; the deployer wallet from .env is the owner so this works
// out of the box.
const { ethers } = require("hardhat");
const path = require("path");
const dep = require(path.join(__dirname, "..", "deployments", "somniaTestnet.json"));

const NAMES = ["DICE", "CRASH", "SLOTS", "MINES", "PLINKO", "ROULETTE", "CLUSTER"];

async function main() {
  const [signer] = await ethers.getSigners();
  const casino = await ethers.getContractAt("Casino", dep.addresses.casino, signer);
  console.log(`[unpause] signer=${signer.address}`);
  for (let i = 0; i < 7; i++) {
    const paused = await casino.gamePaused(i);
    if (!paused) { console.log(`  ${NAMES[i]}: already live`); continue; }
    try {
      const tx = await casino.unpauseGame(i);
      await tx.wait();
      console.log(`  ${NAMES[i]}: UNPAUSED  tx=${tx.hash}`);
    } catch (e) {
      console.error(`  ${NAMES[i]}: failed - ${e.shortMessage || e.message}`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
