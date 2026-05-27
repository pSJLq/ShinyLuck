// One-shot: fire each agent-request type once so the cost ledger has real
// data + receipt links light up immediately (instead of waiting 1h for cron).
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somniaTestnet.json"), "utf8"));
  const hm = await ethers.getContractAt("HouseManager", m.addresses.houseManager);
  const [signer] = await ethers.getSigners();
  console.log(`Signer: ${signer.address}`);
  console.log(`HM balance: ${ethers.formatEther(await ethers.provider.getBalance(m.addresses.houseManager))} STT`);

  console.log("\n[1/4] Fire RtpAnalysisRequested for SLOTS...");
  try {
    const tx = await hm.requestRtpAnalysis(2); // SLOTS = 2
    console.log(`  tx=${tx.hash}`);
    await tx.wait();
  } catch (e) { console.warn(`  fail: ${e.shortMessage || e.message}`); }

  console.log("\n[2/4] Fire RtpAnalysisRequested for CLUSTER...");
  try {
    const tx = await hm.requestRtpAnalysis(6); // CLUSTER = 6
    console.log(`  tx=${tx.hash}`);
    await tx.wait();
  } catch (e) { console.warn(`  fail: ${e.shortMessage || e.message}`); }

  console.log("\n[3/4] Fire CompetitorRtpRequested for SLOTS...");
  try {
    const tx = await hm.requestCompetitorRtp(2);
    console.log(`  tx=${tx.hash}`);
    await tx.wait();
  } catch (e) { console.warn(`  fail: ${e.shortMessage || e.message}`); }

  console.log("\n[4/4] Fire CompetitorRtpRequested for CLUSTER...");
  try {
    const tx = await hm.requestCompetitorRtp(6);
    console.log(`  tx=${tx.hash}`);
    await tx.wait();
  } catch (e) { console.warn(`  fail: ${e.shortMessage || e.message}`); }

  // Try a player decision for the registered agent (deployer)
  console.log("\n[bonus] Fire PlayerDecisionRequested for signer...");
  try {
    const tx = await hm.requestPlayerDecision(signer.address);
    console.log(`  tx=${tx.hash}`);
    await tx.wait();
  } catch (e) { console.warn(`  fail: ${e.shortMessage || e.message}`); }

  console.log("\nDone. Cost ledger widget should pick these up within ~30s.");
}
main().catch(e=>{console.error(e);process.exit(1);});
