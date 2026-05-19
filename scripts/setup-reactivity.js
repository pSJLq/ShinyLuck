// Sets up the on-chain reactivity subscriptions for HouseManager:
//   1. Funds HM with >= 32 STT (precompile owner-balance check).
//   2. Calls hm.bootstrapReactivity() — schedules the first hourly cron tick.
//      The HM handler re-schedules itself every fire, so this is one-shot.
//   3. Calls hm.subscribeToBetSettled(casino, topic0) — registers an event
//      subscription so that every BetSettled emission from Casino triggers
//      HM._onEvent on the same block via the reactivity precompile (0x0100).
//
// Run AFTER scripts/deploy.js. Reads addresses from the manifest written by
// deploy. Re-runnable: if HM is already bootstrapped / subscribed, the
// corresponding step is skipped.
//
//   npx hardhat run scripts/setup-reactivity.js --network somniaTestnet
//
// Funds & gas:
//   • 32 STT topped up to HM (one-time deposit, returns on cancelSubscription)
//   • ~0.5 STT in gas for the two subscribe txs
//   • Each reactive callback consumes from HM's balance (default gas budget
//     10M, max fee 20 gwei → ~0.0002 STT per fire)

const { ethers, network } = require("hardhat");
const fs  = require("fs");
const path = require("path");

const MIN_OWNER_BALANCE = ethers.parseEther("32"); // SomniaExtensions.SUBSCRIPTION_OWNER_MINIMUM_BALANCE

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = network.name;
  console.log(`[setup-reactivity] network=${net} signer=${deployer.address}`);

  const manifestPath = path.join(__dirname, "..", "deployments", `${net}.json`);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No deployment manifest at ${manifestPath}. Run scripts/deploy.js first.`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const casinoAddr = manifest.addresses.casino;
  const hmAddr     = manifest.addresses.houseManager;
  console.log(`[setup-reactivity] casino=${casinoAddr} hm=${hmAddr}`);

  const hm     = await ethers.getContractAt("HouseManager", hmAddr);
  const casino = await ethers.getContractAt("Casino", casinoAddr);

  // ── 1. FUND HM ─────────────────────────────────────────────────────────
  const hmBalance = await ethers.provider.getBalance(hmAddr);
  console.log(`[setup-reactivity] HM balance = ${ethers.formatEther(hmBalance)} STT`);
  if (hmBalance < MIN_OWNER_BALANCE) {
    const topUp = MIN_OWNER_BALANCE - hmBalance + ethers.parseEther("0.5"); // 0.5 STT margin
    const deployerBalance = await ethers.provider.getBalance(deployer.address);
    if (deployerBalance < topUp + ethers.parseEther("1")) {
      throw new Error(`Deployer balance ${ethers.formatEther(deployerBalance)} STT too low to top up HM by ${ethers.formatEther(topUp)} STT`);
    }
    const fundTx = await deployer.sendTransaction({ to: hmAddr, value: topUp });
    console.log(`[setup-reactivity] funding HM with ${ethers.formatEther(topUp)} STT (tx: ${fundTx.hash})…`);
    await fundTx.wait();
    const newBal = await ethers.provider.getBalance(hmAddr);
    console.log(`[setup-reactivity] HM balance now = ${ethers.formatEther(newBal)} STT`);
  }

  // ── 2. BOOTSTRAP HOURLY CRON ───────────────────────────────────────────
  const existingHourly = await hm.hourlyCronSubId();
  if (existingHourly !== 0n) {
    console.log(`[setup-reactivity] hourly cron already bootstrapped: subId=${existingHourly}`);
  } else {
    console.log("[setup-reactivity] calling hm.bootstrapReactivity()…");
    try {
      const tx = await hm.bootstrapReactivity();
      const receipt = await tx.wait();
      const subId = await hm.hourlyCronSubId();
      console.log(`[setup-reactivity] hourly cron scheduled: subId=${subId}, tx=${receipt.hash}`);
    } catch (e) {
      console.error(`[setup-reactivity] bootstrapReactivity failed:`, e.shortMessage || e.message);
      // Don't crash — let event-sub still try to register.
    }
  }

  // ── 3. SUBSCRIBE TO BetSettled ─────────────────────────────────────────
  const existingEventSub = await hm.betSettledSubId();
  if (existingEventSub !== 0n) {
    console.log(`[setup-reactivity] BetSettled subscription already exists: subId=${existingEventSub}`);
  } else {
    // Compute topic0 from the live ABI to avoid signature drift.
    const betSettledFragment = casino.interface.getEvent("BetSettled");
    const topic0 = betSettledFragment.topicHash;
    console.log(`[setup-reactivity] BetSettled topic0 = ${topic0}`);

    try {
      const tx = await hm.subscribeToBetSettled(casinoAddr, topic0);
      const receipt = await tx.wait();
      const subId = await hm.betSettledSubId();
      console.log(`[setup-reactivity] BetSettled subscription created: subId=${subId}, tx=${receipt.hash}`);
    } catch (e) {
      console.error(`[setup-reactivity] subscribeToBetSettled failed:`, e.shortMessage || e.message);
    }
  }

  // ── 4. SUMMARY ─────────────────────────────────────────────────────────
  const finalHourly = await hm.hourlyCronSubId();
  const finalEvent  = await hm.betSettledSubId();
  const finalBal    = await ethers.provider.getBalance(hmAddr);
  console.log("──────────────────────────────────────────");
  console.log(`[setup-reactivity] HM balance:         ${ethers.formatEther(finalBal)} STT`);
  console.log(`[setup-reactivity] hourly cron subId:  ${finalHourly}`);
  console.log(`[setup-reactivity] BetSettled subId:   ${finalEvent}`);
  console.log("[setup-reactivity] done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
