// Execute the previously-scheduled owner withdraw on the OLD Casino. Reads
// the manifest from the prior deployment OR the env var OLD_CASINO. After
// running, balance of the OLD Casino drops by ~10.86 STT, deployer rises
// by the same.
//
//   OLD_CASINO=0xCE988061033A94fCaBeE1bcB91D811d80D2431B1 \
//     npx hardhat run scripts/_execute-old-casino-withdraw.js --network somniaTestnet

const { ethers } = require("hardhat");

const OLD_CASINO = process.env.OLD_CASINO || "0xCE988061033A94fCaBeE1bcB91D811d80D2431B1";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`[exec-old-withdraw] signer=${deployer.address} oldCasino=${OLD_CASINO}`);
  const before = await ethers.provider.getBalance(deployer.address);
  console.log(`[exec-old-withdraw] deployer before: ${ethers.formatEther(before)} STT`);

  const old = await ethers.getContractAt("Casino", OLD_CASINO);
  const pending = await old.ownerWithdrawal();
  console.log(`[exec-old-withdraw] pending amount=${ethers.formatEther(pending.amount)} STT readyAt=${new Date(Number(pending.readyAt) * 1000).toISOString()}`);
  if (pending.amount === 0n) { console.log("[exec-old-withdraw] nothing scheduled, exiting"); return; }
  if (BigInt(pending.readyAt) > BigInt(Math.floor(Date.now() / 1000))) {
    console.error("[exec-old-withdraw] not yet unlocked, ready at " + new Date(Number(pending.readyAt) * 1000).toISOString());
    process.exit(2);
  }

  const tx = await old.executeOwnerWithdraw();
  console.log(`[exec-old-withdraw] tx=${tx.hash}`);
  await tx.wait();

  const after = await ethers.provider.getBalance(deployer.address);
  console.log(`[exec-old-withdraw] deployer after:  ${ethers.formatEther(after)} STT`);
  console.log(`[exec-old-withdraw] gained: ${ethers.formatEther(after - before)} STT (incl tx gas)`);
}
main().catch(e => { console.error(e); process.exit(1); });
