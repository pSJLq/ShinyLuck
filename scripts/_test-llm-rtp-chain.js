// E2E test of the HouseManager ↔ Somnia JSON API Agent ↔ LLM Inference
// Agent ↔ Casino.adjustSlotRTP chain. Verifies REAL competitor-RTP fetch
// (not BTC). Run AFTER a fresh redeploy + setup-reactivity.
//
//   npx hardhat run scripts/_test-llm-rtp-chain.js --network somniaTestnet

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [signer] = await ethers.getSigners();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"),
  );
  const hmAddr     = manifest.addresses.houseManager;
  const casinoAddr = manifest.addresses.casino;
  const hm     = await ethers.getContractAt("HouseManager", hmAddr, signer);
  const casino = await ethers.getContractAt("Casino", casinoAddr, signer);
  const SLOTS = 2;

  const [bal, llmCost, jsonCost, llmId, jsonId, plat, feedUrl] = await Promise.all([
    ethers.provider.getBalance(hmAddr),
    hm.quoteLlmCost(),
    hm.quoteJsonCost(),
    hm.llmAgentId(),
    hm.jsonAgentId(),
    hm.agentPlatform(),
    hm.competitorFeedUrl(),
  ]);
  console.log(`HM balance:        ${ethers.formatEther(bal)} STT`);
  console.log(`LLM cost/call:     ${ethers.formatEther(llmCost)} STT`);
  console.log(`JSON cost/call:    ${ethers.formatEther(jsonCost)} STT`);
  console.log(`llmAgentId:        ${llmId}`);
  console.log(`jsonAgentId:       ${jsonId}`);
  console.log(`agentPlatform:     ${plat}`);
  console.log(`competitorFeedUrl: ${feedUrl}\n`);

  // STAGE 1: JSON API Agent - fetch REAL competitor RTP for SLOTS
  console.log("──── STAGE 1: requestCompetitorRtp(SLOTS) (JSON API Agent → research feed) ────");
  const tx1 = await hm.requestCompetitorRtp(SLOTS);
  const r1 = await tx1.wait();
  console.log(`  tx=${tx1.hash} @ block ${r1.blockNumber}`);
  let compReqId = null;
  for (const log of r1.logs) {
    try {
      const p = hm.interface.parseLog(log);
      if (!p) continue;
      if (p.name === "CompetitorRtpRequested") { compReqId = p.args.requestId.toString(); console.log(`  → CompetitorRtpRequested: requestId=${compReqId}, url=${p.args.url}`); }
      if (p.name === "AgentRequestSkipped") console.log(`  ⚠ Skipped: ${p.args.kind} → ${p.args.reason}`);
    } catch (_) {}
  }

  // STAGE 2: LLM Inference Agent - pick decision (will use lastCompetitorRtp)
  console.log("\n──── STAGE 2: requestRtpAnalysis(SLOTS) (LLM Inference Agent) ────");
  const tx2 = await hm.requestRtpAnalysis(SLOTS);
  const r2 = await tx2.wait();
  console.log(`  tx=${tx2.hash} @ block ${r2.blockNumber}`);
  let llmReqId = null;
  for (const log of r2.logs) {
    try {
      const p = hm.interface.parseLog(log);
      if (!p) continue;
      if (p.name === "RtpAnalysisRequested") {
        llmReqId = p.args.requestId.toString();
        console.log(`  → RtpAnalysisRequested: requestId=${llmReqId}, ourRtp=${p.args.ourRtpBps}bps, competitorRtp=${p.args.competitorRtpBps}bps (${(Number(p.args.competitorRtpBps)/100).toFixed(2)}%)`);
      }
      if (p.name === "AgentRequestSkipped") console.log(`  ⚠ Skipped: ${p.args.kind} → ${p.args.reason}`);
    } catch (_) {}
  }

  if (!compReqId && !llmReqId) {
    console.error("\n❌ Neither request fired.");
    return;
  }

  console.log("\nPolling for callbacks (up to 5 min)…");
  const startMs = Date.now();
  const startBlock = r1.blockNumber;
  let compResolved = false, llmResolved = false;
  while (Date.now() - startMs < 300_000 && !(compResolved && llmResolved)) {
    const head = await ethers.provider.getBlockNumber();
    let from = startBlock;
    while (from <= head && !(compResolved && llmResolved)) {
      const to = Math.min(from + 900, head);
      const logs = await ethers.provider.send("eth_getLogs", [{
        address: hmAddr,
        fromBlock: "0x" + from.toString(16),
        toBlock: "0x" + to.toString(16),
      }]);
      for (const raw of logs) {
        try {
          const p = hm.interface.parseLog({ topics: raw.topics, data: raw.data });
          if (p.name === "CompetitorRtpResolved" && p.args.requestId.toString() === compReqId) {
            compResolved = true;
            console.log(`  ✅ CompetitorRtpResolved: requestId=${compReqId}, game=${p.args.game}, rtpBps=${p.args.rtpBps} (${(Number(p.args.rtpBps)/100).toFixed(2)}%)`);
          }
          if (p.name === "RtpAnalysisResolved" && p.args.requestId.toString() === llmReqId) {
            llmResolved = true;
            console.log(`  ✅ RtpAnalysisResolved: requestId=${llmReqId}, ${p.args.oldRtpBps}→${p.args.newRtpBps} bps, decision="${p.args.decision}"`);
          }
          if (p.name === "AgentRequestSkipped") {
            console.log(`  ⚠ AgentRequestSkipped: ${p.args.kind} → ${p.args.reason}`);
          }
        } catch (_) {}
      }
      from = to + 1;
    }
    if (!(compResolved && llmResolved)) {
      process.stdout.write(".");
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
  console.log();
  if (compResolved && llmResolved) {
    const newRtp = await casino.getReportedRTP(SLOTS);
    const competitorRtp = await hm.lastCompetitorRtpBps(SLOTS);
    console.log(`\n🎉 FULL COMPETITOR-DRIVEN AGENT CHAIN VERIFIED.`);
    console.log(`   Our SLOTS RTP:        ${newRtp} bps (${(Number(newRtp)/100).toFixed(2)}%)`);
    console.log(`   Competitor avg RTP:   ${competitorRtp} bps (${(Number(competitorRtp)/100).toFixed(2)}%)`);
    console.log(`   Source: ${manifest.addresses.houseManager}`);
  } else {
    console.warn(`\n⏱ Timed out: competitor=${compResolved}, llm=${llmResolved}.`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
