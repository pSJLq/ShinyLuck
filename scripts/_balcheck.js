// Quick balance snapshot — deployer + every contract address we know about.
// Run: npx hardhat run scripts/_balcheck.js --network somniaTestnet
const { ethers } = require("hardhat");
const dep = require("../deployments/somniaTestnet.json");

async function main() {
  const [s] = await ethers.getSigners();
  const a = await s.getAddress();
  const targets = {
    deployer: a,
    casino: dep.addresses.casino,
    houseManager: dep.addresses.houseManager,
    playerAgentRegistry: dep.addresses.playerAgentRegistry,
    agentQuorumVerifier: dep.addresses.agentQuorumVerifier,
  };
  let total = 0n;
  for (const [k, addr] of Object.entries(targets)) {
    const b = await ethers.provider.getBalance(addr);
    total += b;
    console.log(`  ${k.padEnd(22)} ${addr}  ${ethers.formatEther(b)} STT`);
  }
  console.log(`  ${"TOTAL".padEnd(22)} (across listed addresses)        ${ethers.formatEther(total)} STT`);

  // Also: pendingWithdrawals & lockedReserve & freeBankroll on the casino
  try {
    const casino = await ethers.getContractAt("Casino", dep.addresses.casino);
    const lr = await casino.lockedReserve();
    const tpw = await casino.totalPendingWithdrawals();
    const fb = await casino.freeBankroll();
    console.log(`  casino.lockedReserve         ${ethers.formatEther(lr)} STT`);
    console.log(`  casino.totalPendingWithdraw  ${ethers.formatEther(tpw)} STT`);
    console.log(`  casino.freeBankroll          ${ethers.formatEther(fb)} STT`);
  } catch (e) { console.warn("casino read failed:", e.shortMessage || e.message); }
}
main().catch((e) => { console.error(e); process.exit(1); });
