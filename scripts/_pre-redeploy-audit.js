// Snapshot of every STT we can recover before the third redeploy.
// Reports: balances, both casinos' ownerWithdrawal timer state, HM bonds.
const { ethers } = require("hardhat");

const OLD_CASINO = "0x0d397E36215Fb534F0dE4E279f505dEC3F63E4B6";
const OLD_HM     = "0x8864e2B29D1dd1A9969d6182095776Ab0D26DC4A";
const CUR_CASINO = "0x46d37cd00F1eB308eb8a7eE864BC73774A029311";
const CUR_HM     = "0xb4ec8Ee60a0EC68a44335E666AdD41F409D8f1Ed";

async function inspectCasino(addr, label) {
  const c = await ethers.getContractAt("Casino", addr);
  const bal = await ethers.provider.getBalance(addr);
  const free = await c.freeBankroll();
  const lr = await c.lockedReserve();
  const pendW = await c.totalPendingWithdrawals();
  const pw = await c.ownerWithdrawal();
  const now = Math.floor(Date.now() / 1000);
  let ownerLine;
  if (pw.amount > 0n) {
    const left = Number(pw.readyAt) - now;
    ownerLine = left > 0
      ? `${ethers.formatEther(pw.amount)} STT, ready in ${(left/3600).toFixed(2)}h`
      : `${ethers.formatEther(pw.amount)} STT, READY NOW (${Math.abs(left)}s past)`;
  } else {
    ownerLine = "(none scheduled)";
  }
  console.log(`\n[${label}] ${addr}`);
  console.log(`  balance:           ${ethers.formatEther(bal)} STT`);
  console.log(`  free bankroll:     ${ethers.formatEther(free)} STT`);
  console.log(`  locked reserve:    ${ethers.formatEther(lr)} STT`);
  console.log(`  pending withdraw:  ${ethers.formatEther(pendW)} STT`);
  console.log(`  owner-withdraw:    ${ownerLine}`);
}

async function main() {
  const [signer] = await ethers.getSigners();
  const depBal = await ethers.provider.getBalance(signer.address);
  console.log(`deployer ${signer.address}: ${ethers.formatEther(depBal)} STT`);
  await inspectCasino(OLD_CASINO, "OLD casino");
  await inspectCasino(CUR_CASINO, "CUR casino");
  for (const [label, addr] of [["OLD HM", OLD_HM], ["CUR HM", CUR_HM]]) {
    const bal = await ethers.provider.getBalance(addr);
    console.log(`\n[${label}] ${addr}\n  balance: ${ethers.formatEther(bal)} STT`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
