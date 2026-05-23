// One-off: drain the OLD HouseManager (paired with the OLD Casino) to zero.
// We don't need the old HM anymore - the new stack uses a new HM. Then
// forward most of the recovered STT to the NEW Casino's bankroll, leaving
// a small gas reserve on the deployer.
//
// Hardcoded addresses pull from the OLD deploy (we already overwrote the
// deployments manifest with the NEW addresses, so we cannot rely on it).
const { ethers } = require("hardhat");
const path = require("path");
const dep = require(path.join(__dirname, "..", "deployments", "somniaTestnet.json"));

const OLD_HM = "0x8864e2B29D1dd1A9969d6182095776Ab0D26DC4A";
const GAS_RESERVE = ethers.parseEther("2.3"); // leave this on the deployer

async function main() {
  const [signer] = await ethers.getSigners();
  const hm = await ethers.getContractAt("HouseManager", OLD_HM, signer);
  const hmBal = await ethers.provider.getBalance(OLD_HM);
  const depBefore = await ethers.provider.getBalance(signer.address);
  console.log(`[drain-old-hm] OLD HM=${ethers.formatEther(hmBal)} STT, deployer=${ethers.formatEther(depBefore)} STT`);
  if (hmBal === 0n) { console.log("[drain-old-hm] OLD HM already empty"); }
  else {
    console.log(`[drain-old-hm] withdrawing ${ethers.formatEther(hmBal)} STT (full balance) → deployer`);
    const tx = await hm.withdrawTo(signer.address, hmBal);
    const rc = await tx.wait();
    console.log(`[drain-old-hm] tx=${tx.hash}  gas=${rc.gasUsed}`);
  }

  const depAfter = await ethers.provider.getBalance(signer.address);
  console.log(`[drain-old-hm] deployer after drain: ${ethers.formatEther(depAfter)} STT`);

  // Forward (deployerNow - GAS_RESERVE) to NEW Casino bankroll.
  const newCasino = dep.addresses.casino;
  if (depAfter <= GAS_RESERVE) {
    console.log(`[drain-old-hm] not enough above gas reserve (${ethers.formatEther(GAS_RESERVE)} STT), skipping topup`);
    return;
  }
  const sendAmt = depAfter - GAS_RESERVE;
  console.log(`[drain-old-hm] topping up NEW casino ${newCasino} with ${ethers.formatEther(sendAmt)} STT`);
  const tx2 = await signer.sendTransaction({ to: newCasino, value: sendAmt });
  const rc2 = await tx2.wait();
  console.log(`[drain-old-hm] tx=${tx2.hash}  gas=${rc2.gasUsed}`);

  const finalDep = await ethers.provider.getBalance(signer.address);
  const finalCasino = await ethers.provider.getBalance(newCasino);
  const casino = await ethers.getContractAt("Casino", newCasino);
  const fb = await casino.freeBankroll();
  console.log(`[drain-old-hm] final deployer:        ${ethers.formatEther(finalDep)} STT`);
  console.log(`[drain-old-hm] final new casino bal:  ${ethers.formatEther(finalCasino)} STT`);
  console.log(`[drain-old-hm] new casino freeBankroll: ${ethers.formatEther(fb)} STT`);
}
main().catch(e => { console.error(e); process.exit(1); });
