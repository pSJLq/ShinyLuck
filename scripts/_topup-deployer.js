// Top up deployer with the slack between current HM balance and the
// 32 STT Reactivity floor. Deployer runs out of gas after a few hours of
// reveal-bot operation because every revealAndSettle costs ~0.0001 STT.
// HM accrues from the Reactivity subscription owner deposit so it's the
// natural reservoir.
const { ethers } = require("hardhat");
const dep = require("../deployments/somniaTestnet.json");

const HM_FLOOR = ethers.parseEther("32"); // SomniaExtensions.SUBSCRIPTION_OWNER_MINIMUM_BALANCE
const KEEP_MARGIN = ethers.parseEther("0.1"); // small buffer above the floor

async function main() {
  const [signer] = await ethers.getSigners();
  const hm = await ethers.getContractAt("HouseManager", dep.addresses.houseManager, signer);
  const hmBal = await ethers.provider.getBalance(dep.addresses.houseManager);
  const depBal = await ethers.provider.getBalance(signer.address);
  console.log(`HM=${ethers.formatEther(hmBal)} STT  deployer=${ethers.formatEther(depBal)} STT`);
  const safeFloor = HM_FLOOR + KEEP_MARGIN;
  if (hmBal <= safeFloor) {
    console.log(`HM at/below safe floor (${ethers.formatEther(safeFloor)} STT) - nothing to drain.`);
    return;
  }
  const amt = hmBal - safeFloor;
  console.log(`Withdrawing ${ethers.formatEther(amt)} STT from HM → deployer`);
  const tx = await hm.withdrawTo(signer.address, amt);
  await tx.wait();
  const after = await ethers.provider.getBalance(signer.address);
  console.log(`deployer now: ${ethers.formatEther(after)} STT`);
}
main().catch(e => { console.error(e); process.exit(1); });
