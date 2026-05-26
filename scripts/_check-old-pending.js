// Quick check before running _recover-stt-before-redeploy.js: print
// current state of the OLD (gen-7) casino so we know whether
// executeOwnerWithdraw is callable or whether we need to schedule first.
const { ethers } = require("hardhat");
async function main() {
  const OLD = "0x6771De2cB1f1356a41Fb424F235C0d5896B35B9a";
  const old = await ethers.getContractAt("Casino", OLD);
  const bal = await ethers.provider.getBalance(OLD);
  console.log("old casino balance:", ethers.formatEther(bal), "STT");
  console.log("old casino free:", ethers.formatEther(await old.freeBankroll()), "STT");
  const pw = await old.ownerWithdrawal();
  console.log("old casino pending owner-withdraw:", ethers.formatEther(pw.amount), "STT, unlockAt:", pw.unlockAt.toString(), "now:", Math.floor(Date.now()/1000));
}
main().catch(e=>{console.error(e);process.exit(1);});
