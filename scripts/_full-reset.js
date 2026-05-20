// Recovery: top up casino, unpause every game, reset hourStartBankroll
// reference. Use after a circuit-breaker trip + bankroll drain.
const { ethers } = require("hardhat");
const path = require("path");
const dep = require(path.join(__dirname, "..", "deployments", "somniaTestnet.json"));

const NAMES = ["DICE", "CRASH", "SLOTS", "MINES", "PLINKO", "ROULETTE", "CLUSTER"];
const TOPUP_STT = process.env.TOPUP_STT || "0";

async function main() {
  const [signer] = await ethers.getSigners();
  const casino = await ethers.getContractAt("Casino", dep.addresses.casino, signer);
  console.log(`[reset] signer=${signer.address}`);
  console.log(`[reset] deployer balance: ${ethers.formatEther(await ethers.provider.getBalance(signer.address))} STT`);

  if (Number(TOPUP_STT) > 0) {
    const amt = ethers.parseEther(String(TOPUP_STT));
    const tx = await casino.depositBankroll({ value: amt });
    await tx.wait();
    console.log(`[reset] deposited ${TOPUP_STT} STT  tx=${tx.hash}`);
  }

  for (let i = 0; i < 7; i++) {
    const paused = await casino.gamePaused(i);
    if (!paused) { console.log(`  ${NAMES[i]}: already live`); continue; }
    try {
      const tx = await casino.unpauseGame(i);
      await tx.wait();
      console.log(`  ${NAMES[i]}: UNPAUSED`);
    } catch (e) {
      console.error(`  ${NAMES[i]}: ${e.shortMessage || e.message}`);
    }
  }

  const free = await casino.freeBankroll();
  const lr = await casino.lockedReserve();
  console.log(`[reset] freeBankroll: ${ethers.formatEther(free)} STT`);
  console.log(`[reset] lockedReserve: ${ethers.formatEther(lr)} STT`);
  console.log(`[reset] effective max cluster stake: ${ethers.formatEther(free / 2500n)} STT`);
}
main().catch(e => { console.error(e); process.exit(1); });
