// Claim the previously-scheduled owner withdraw once the 24h timelock
// has elapsed. Pulls the STT from Casino back to deployer.
const { ethers } = require("hardhat");
const path = require("path");
const dep = require(path.join(__dirname, "..", "deployments", "somniaTestnet.json"));

async function main() {
  const [signer] = await ethers.getSigners();
  const casino = await ethers.getContractAt("Casino", dep.addresses.casino, signer);
  const pw = await casino.ownerWithdrawal();
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (pw.amount === 0n) { console.log("[claim] no pending owner withdrawal"); return; }
  if (now < pw.readyAt) {
    const wait = (Number(pw.readyAt) - Number(now)) / 3600;
    console.log(`[claim] not ready — ${ethers.formatEther(pw.amount)} STT, ready in ${wait.toFixed(1)} hours`);
    return;
  }
  const before = await ethers.provider.getBalance(signer.address);
  const tx = await casino.claimOwnerWithdraw();
  const rc = await tx.wait();
  const after = await ethers.provider.getBalance(signer.address);
  console.log(`[claim] tx=${tx.hash}  gas=${rc.gasUsed}`);
  console.log(`[claim] deployer: ${ethers.formatEther(before)} → ${ethers.formatEther(after)} STT (+${ethers.formatEther(after - before + rc.gasUsed * rc.gasPrice)} net)`);
}
main().catch(e => { console.error(e); process.exit(1); });
