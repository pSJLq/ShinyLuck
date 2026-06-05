// Pre-gen-15 STT recovery: drains the CURRENT (gen-14) Casino freeBankroll +
// HouseManager balance into the deployer, so the funds can be migrated into the
// fresh gen-15 stack. Reads addresses from the live manifest (NOT hardcoded),
// so it must run BEFORE deploy.js overwrites deployments/<net>.json.
//   npx hardhat run scripts/_recover-gen14.js --network somniaTestnet
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [signer] = await ethers.getSigners();
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"));
  const casinoAddr = m.addresses.casino, hmAddr = m.addresses.houseManager;
  const startBal = await ethers.provider.getBalance(signer.address);
  console.log(`deployer ${signer.address}  start ${ethers.formatEther(startBal)} STT`);
  console.log(`draining casino ${casinoAddr} + HM ${hmAddr}`);

  // Casino: schedule + execute owner withdraw (timelock removed → instant).
  try {
    const cur = await ethers.getContractAt("Casino", casinoAddr, signer);
    const free = await cur.freeBankroll();
    console.log(`casino freeBankroll = ${ethers.formatEther(free)} STT`);
    if (free > ethers.parseEther("0.002")) {
      const amt = free - ethers.parseEther("0.001");
      let tx = await cur.scheduleOwnerWithdraw(amt); await tx.wait();
      console.log(`  scheduled ${ethers.formatEther(amt)} (tx=${tx.hash})`);
      tx = await cur.executeOwnerWithdraw(); await tx.wait();
      console.log(`  executed (tx=${tx.hash})`);
    } else console.log("  casino: nothing to drain");
  } catch (e) { console.warn("  casino drain FAILED:", e.shortMessage || e.message); }

  // HouseManager: withdraw full balance to deployer.
  try {
    const hm = await ethers.getContractAt("HouseManager", hmAddr, signer);
    const bal = await ethers.provider.getBalance(hmAddr);
    console.log(`HM balance = ${ethers.formatEther(bal)} STT`);
    if (bal > ethers.parseEther("0.001")) {
      const tx = await hm.withdrawTo(signer.address, bal); await tx.wait();
      console.log(`  HM drained (tx=${tx.hash})`);
    } else console.log("  HM: nothing to drain");
  } catch (e) { console.warn("  HM drain FAILED:", e.shortMessage || e.message); }

  const endBal = await ethers.provider.getBalance(signer.address);
  console.log(`\nrecovered +${ethers.formatEther(endBal - startBal)} STT  →  deployer end ${ethers.formatEther(endBal)} STT`);
}
main().catch((e) => { console.error(e); process.exit(1); });
