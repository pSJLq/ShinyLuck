// One-shot: schedule an owner withdraw of the free bankroll on the OLD Casino.
// Useful right before redeploying so the 24h delay starts ticking; the new
// contract can be deployed in parallel and the funds reclaimed a day later.
//
//   OLD_CASINO=0x... npx hardhat run scripts/_schedule-old-casino-withdraw.js --network somniaTestnet
//
// After 24h, run executeOldCasinoWithdraw (or simply call executeOwnerWithdraw()
// from the Casino interface in any tool).

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const OLD_CASINO = process.env.OLD_CASINO || (() => {
  const m = require(path.join(__dirname, "..", "deployments", `${network.name}.json`));
  return m.addresses.casino;
})();

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`[schedule-owner-withdraw] oldCasino=${OLD_CASINO} signer=${deployer.address}`);
  const casino = await ethers.getContractAt("Casino", OLD_CASINO);
  const free = await casino.freeBankroll();
  console.log(`[schedule-owner-withdraw] free bankroll: ${ethers.formatEther(free)} STT`);
  if (free === 0n) { console.log("[schedule-owner-withdraw] nothing to schedule, done."); return; }
  // Leave 1 wei dust to avoid edge case
  const amt = free - 1n;
  // Some contracts may revert if pending already exists; cancel first (best-effort).
  try { await (await casino.cancelOwnerWithdraw()).wait(); } catch (_) {}
  const tx = await casino.scheduleOwnerWithdraw(amt);
  await tx.wait();
  console.log(`[schedule-owner-withdraw] scheduled ${ethers.formatEther(amt)} STT, ready at + 24h. tx=${tx.hash}`);
  const pending = await casino.ownerWithdrawal();
  console.log(`[schedule-owner-withdraw] readyAt = ${new Date(Number(pending.readyAt) * 1000).toISOString()}`);
}
main().catch(e => { console.error(e); process.exit(1); });
