// Pre-redeploy STT recovery. Three claims into the deployer wallet:
//   1. OLD casino owner-withdraw (50 STT, timer expired hours ago)
//   2. CUR casino owner-withdraw (freeBankroll, OWNER_WITHDRAW_DELAY=0 → instant)
//   3. CUR HM full balance (~32 STT, no longer used after redeploy)
//
// Final deployer balance should be enough to deploy + top-up new stack.

const { ethers } = require("hardhat");

// Each redeploy these rotate: previous CURRENT becomes OLD, the freshly
// deployed pair takes over. Lift them from frontend/lib/config.js's
// historicalCasinos (oldest entry minus latest) before running.
const OLD_CASINO = "0x400Aa6cc87B13e4f5203C4DD37ea300Fdcb61CdF"; // gen-12 (drained)
const CUR_CASINO = "0xDD9Bf933A1C6E98B559427881201d06DF77BAf3d"; // gen-13 (current, to drain)
const CUR_HM     = "0x23F580E31ba1d2fe1b173c9C9E170F801d457e65"; // gen-13 HM (to drain)

async function main() {
  const [signer] = await ethers.getSigners();
  console.log(`deployer: ${signer.address}`);
  const startBal = await ethers.provider.getBalance(signer.address);
  console.log(`start balance: ${ethers.formatEther(startBal)} STT\n`);

  // ── 1. OLD casino: executeOwnerWithdraw (already scheduled + timer up) ──
  try {
    const old = await ethers.getContractAt("Casino", OLD_CASINO, signer);
    const pw = await old.ownerWithdrawal();
    if (pw.amount > 0n) {
      console.log(`[1/3] OLD casino executeOwnerWithdraw (${ethers.formatEther(pw.amount)} STT)…`);
      const tx = await old.executeOwnerWithdraw();
      await tx.wait();
      console.log(`      tx=${tx.hash}  done`);
    } else {
      console.log("[1/3] OLD casino: nothing scheduled, skipping");
    }
  } catch (e) { console.warn("[1/3] OLD casino failed:", e.shortMessage || e.message); }

  // ── 2. CUR casino: schedule + execute (OWNER_WITHDRAW_DELAY = 0) ──
  try {
    const cur = await ethers.getContractAt("Casino", CUR_CASINO, signer);
    const free = await cur.freeBankroll();
    if (free > 0n) {
      // Leave a wei or two to avoid edge-case "exceeds free now" race.
      const amt = free - ethers.parseEther("0.001");
      console.log(`\n[2/3] CUR casino schedule + execute (${ethers.formatEther(amt)} STT)…`);
      const tx1 = await cur.scheduleOwnerWithdraw(amt);
      await tx1.wait();
      console.log(`      schedule tx=${tx1.hash}`);
      const tx2 = await cur.executeOwnerWithdraw();
      await tx2.wait();
      console.log(`      execute  tx=${tx2.hash}  done`);
    } else {
      console.log("[2/3] CUR casino: no free bankroll, skipping");
    }
  } catch (e) { console.warn("[2/3] CUR casino failed:", e.shortMessage || e.message); }

  // ── 3. CUR HM: full drain (deprecated post-redeploy) ──
  try {
    const hm = await ethers.getContractAt("HouseManager", CUR_HM, signer);
    const bal = await ethers.provider.getBalance(CUR_HM);
    if (bal > 0n) {
      console.log(`\n[3/3] CUR HM withdrawTo deployer (${ethers.formatEther(bal)} STT)…`);
      const tx = await hm.withdrawTo(signer.address, bal);
      await tx.wait();
      console.log(`      tx=${tx.hash}  done`);
    } else {
      console.log("[3/3] CUR HM: empty, skipping");
    }
  } catch (e) { console.warn("[3/3] CUR HM failed:", e.shortMessage || e.message); }

  const endBal = await ethers.provider.getBalance(signer.address);
  const delta = endBal - startBal;
  console.log(`\nrecovered: +${ethers.formatEther(delta)} STT`);
  console.log(`deployer end balance: ${ethers.formatEther(endBal)} STT`);
}

main().catch(e => { console.error(e); process.exit(1); });
