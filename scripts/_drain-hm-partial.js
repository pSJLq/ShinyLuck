// Withdraw a small slice of HM bond back to deployer when deployer is too
// low on gas to operate. HM keeps at least 32 STT (precompile minimum); we
// leave a small safety margin above that.
const { ethers } = require("hardhat");
const path = require("path");
const dep = require(path.join(__dirname, "..", "deployments", "somniaTestnet.json"));

const MIN_HM_BALANCE = ethers.parseEther("30");  // never go below this
const TARGET_DEP    = ethers.parseEther("8");    // pull until deployer ≥ 8 STT

async function main() {
  const [signer] = await ethers.getSigners();
  const hm = await ethers.getContractAt("HouseManager", dep.addresses.houseManager, signer);
  const hmBal = await ethers.provider.getBalance(dep.addresses.houseManager);
  const depBal = await ethers.provider.getBalance(signer.address);
  console.log(`[drain-hm-partial] HM=${ethers.formatEther(hmBal)} STT  deployer=${ethers.formatEther(depBal)} STT`);
  if (depBal >= TARGET_DEP) { console.log("[drain-hm-partial] deployer already ≥8 STT, nothing to do"); return; }
  const need = TARGET_DEP - depBal;
  const room = hmBal > MIN_HM_BALANCE ? (hmBal - MIN_HM_BALANCE) : 0n;
  const amt  = need < room ? need : room;
  if (amt === 0n) { console.log("[drain-hm-partial] HM at floor, cannot withdraw"); return; }
  console.log(`[drain-hm-partial] withdrawing ${ethers.formatEther(amt)} STT from HM → deployer`);
  const tx = await hm.withdrawTo(signer.address, amt);
  await tx.wait();
  console.log(`[drain-hm-partial] tx=${tx.hash}`);
  const after = await ethers.provider.getBalance(signer.address);
  console.log(`[drain-hm-partial] deployer now: ${ethers.formatEther(after)} STT`);
}
main().catch(e => { console.error(e); process.exit(1); });
