// Walk recent bets backward and call refundExpired() on each unsettled bet
// whose commitBlock fell out of BLOCKHASH_WINDOW (256 blocks ≈ 5 min).
// Recovers the lockedReserve they were holding back into freeBankroll.
//
// Use after a long stretch where reveal-bot was down - those bets can never
// settle (the EVM no longer has the blockhash to verify the seed), they're
// just sitting on the casino books burning bankroll.
const { ethers } = require("hardhat");
const path = require("path");
const dep = require(path.join(__dirname, "..", "deployments", "somniaTestnet.json"));

const SCAN_LAST_N = Number(process.env.SCAN_LAST_N || 600);

async function main() {
  const [signer] = await ethers.getSigners();
  const casino = await ethers.getContractAt("Casino", dep.addresses.casino, signer);
  const total = await casino.totalBets();
  const cur = BigInt(await ethers.provider.getBlockNumber());
  const from = total > BigInt(SCAN_LAST_N) ? total - BigInt(SCAN_LAST_N) : 0n;
  console.log(`[refund] totalBets=${total} scanning ${from}..${total - 1n} (last ${total - from})`);
  console.log(`[refund] currentBlock=${cur} BLOCKHASH_WINDOW=256`);

  const free0 = await casino.freeBankroll();
  const lr0   = await casino.lockedReserve();
  console.log(`[refund] BEFORE  free=${ethers.formatEther(free0)} STT  locked=${ethers.formatEther(lr0)} STT`);

  // Pass 1: gather candidates without spending gas
  const candidates = [];
  for (let i = from; i < total; i++) {
    try {
      const b = await casino.getBet(i);
      // b.status: 0=Pending, 1=Settled, 2=Refunded (see Casino.sol)
      if (Number(b.status) !== 0) continue;
      const commitBlk = BigInt(b.commitBlock);
      // Expired iff currentBlock - commitBlock > 256
      if (cur - commitBlk > 256n) {
        candidates.push({ id: i, amount: b.amount, ageBlocks: Number(cur - commitBlk) });
      }
    } catch (_) {}
  }
  console.log(`[refund] expired-unsettled candidates: ${candidates.length}`);
  if (candidates.length === 0) {
    console.log(`[refund] nothing to do - either all settled, or the expired window doesn't apply.`);
    return;
  }
  const totalAmt = candidates.reduce((a, c) => a + BigInt(c.amount), 0n);
  console.log(`[refund] total stake locked in these:  ${ethers.formatEther(totalAmt)} STT`);
  console.log(`[refund] reserves freed will be ~stake × cap_multiplier per bet.`);

  // Pass 2: refund each one
  let okCount = 0, failCount = 0;
  for (const c of candidates) {
    try {
      const tx = await casino.refundExpired(c.id);
      const rc = await tx.wait();
      okCount++;
      if (okCount % 25 === 0) console.log(`  [${okCount}/${candidates.length}] refunded betId=${c.id} (gas=${rc.gasUsed})`);
    } catch (e) {
      failCount++;
      if (failCount <= 5) console.warn(`  [fail] betId=${c.id}: ${e.shortMessage || e.message}`);
    }
  }
  console.log(`[refund] done. ok=${okCount} fail=${failCount}`);

  const free1 = await casino.freeBankroll();
  const lr1   = await casino.lockedReserve();
  console.log(`[refund] AFTER   free=${ethers.formatEther(free1)} STT  locked=${ethers.formatEther(lr1)} STT`);
  console.log(`[refund] delta:  free +${ethers.formatEther(free1 - free0)}  locked ${ethers.formatEther(lr1 - lr0)}`);
}
main().catch(e => { console.error(e); process.exit(1); });
