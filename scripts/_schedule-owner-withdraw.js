// Schedule a 50 STT owner-withdraw from Casino. 24h timelock starts NOW -
// if we end up redeploying with REVEAL_DELAY=1, we can claim the funds
// back to deployer and top up the new casino.
//
// Safe to run even if we don't end up redeploying - just sits there as
// a pending intent until claimOwnerWithdraw() is called.
const { ethers } = require("hardhat");
const path = require("path");
const dep = require(path.join(__dirname, "..", "deployments", "somniaTestnet.json"));

const AMOUNT_STT = process.env.AMOUNT_STT || "50";

async function main() {
  const [signer] = await ethers.getSigners();
  const casino = await ethers.getContractAt("Casino", dep.addresses.casino, signer);
  const free = await casino.freeBankroll();
  const amt = ethers.parseEther(AMOUNT_STT);
  console.log(`[schedule] freeBankroll=${ethers.formatEther(free)} STT, scheduling ${AMOUNT_STT} STT`);
  if (amt > free) { console.log("[schedule] amount > free - aborting"); return; }

  const existing = await casino.ownerWithdrawal();
  if (existing.amount > 0n) {
    console.log(`[schedule] existing pending: ${ethers.formatEther(existing.amount)} STT, readyAt=${existing.readyAt}`);
    console.log(`[schedule] new schedule will OVERWRITE the existing one.`);
  }

  const tx = await casino.scheduleOwnerWithdraw(amt);
  const rc = await tx.wait();
  const after = await casino.ownerWithdrawal();
  const now = Math.floor(Date.now() / 1000);
  const hoursLeft = (Number(after.readyAt) - now) / 3600;
  console.log(`[schedule] tx=${tx.hash}  gas=${rc.gasUsed}`);
  console.log(`[schedule] scheduled ${ethers.formatEther(after.amount)} STT  ready in ${hoursLeft.toFixed(1)} hours`);
  console.log(`[schedule] claim with:  npx hardhat run scripts/_claim-owner-withdraw.js --network somniaTestnet`);
}
main().catch(e => { console.error(e); process.exit(1); });
