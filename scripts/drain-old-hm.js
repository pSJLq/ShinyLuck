// One-shot recovery script: cancel any active reactivity subscriptions on a
// PREVIOUS HouseManager deployment, then drain its STT balance back to the
// deployer. Run after a redeploy so the 32+ STT subscription bond isn't
// permanently stranded on the abandoned contract.
//
//   OLD_HM=0x... npx hardhat run scripts/drain-old-hm.js --network somniaTestnet

const { ethers, network } = require("hardhat");

const OLD_HM = process.env.OLD_HM || "0xe0239a63E82AcC371b3C620D5f68dc89a2078347";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`[drain] network=${network.name} deployer=${deployer.address} oldHM=${OLD_HM}`);
  const hm = await ethers.getContractAt("HouseManager", OLD_HM);

  // Try to cancel known subscriptions. Best-effort: if a sub doesn't exist or
  // was already cancelled, the precompile reverts which we swallow.
  const eventSubId  = await hm.betSettledSubId().catch(() => 0n);
  const hourlySubId = await hm.hourlyCronSubId().catch(() => 0n);
  console.log(`[drain] eventSubId=${eventSubId} hourlyCronSubId=${hourlySubId}`);

  if (eventSubId !== 0n) {
    try {
      const tx = await hm.cancelSubscription(eventSubId);
      console.log(`[drain] cancelled BetSettled sub ${eventSubId} tx=${tx.hash}`);
      await tx.wait();
    } catch (e) { console.warn(`[drain] cancel BetSettled failed: ${e.shortMessage || e.message}`); }
  }
  if (hourlySubId !== 0n) {
    try {
      const tx = await hm.cancelSubscription(hourlySubId);
      console.log(`[drain] cancelled hourly cron sub ${hourlySubId} tx=${tx.hash}`);
      await tx.wait();
    } catch (e) { console.warn(`[drain] cancel hourly failed: ${e.shortMessage || e.message}`); }
  }

  const bal = await ethers.provider.getBalance(OLD_HM);
  console.log(`[drain] old HM balance: ${ethers.formatEther(bal)} STT`);
  if (bal === 0n) { console.log(`[drain] nothing to drain.`); return; }

  // Leave a tiny dust amount to avoid edge-case revert if other internal
  // accounting differs by 1 wei. 1 wei rounding is fine.
  const withdraw = bal - 1n;
  const tx = await hm.withdrawTo(deployer.address, withdraw);
  console.log(`[drain] withdrawing ${ethers.formatEther(withdraw)} STT → ${deployer.address} tx=${tx.hash}`);
  await tx.wait();
  const newBal = await ethers.provider.getBalance(OLD_HM);
  const newDeployer = await ethers.provider.getBalance(deployer.address);
  console.log(`[drain] old HM now: ${ethers.formatEther(newBal)} STT`);
  console.log(`[drain] deployer now: ${ethers.formatEther(newDeployer)} STT`);
}

main().catch((e) => { console.error(e); process.exit(1); });
