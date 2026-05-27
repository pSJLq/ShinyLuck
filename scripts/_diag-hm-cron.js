// Quick diagnostic - is the HM hourly cron actually firing on gen-9?
// Reads subscription IDs, last tick timestamp, and counts how many
// RtpAnalysisRequested events have fired since deployment.
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"));
  const hmAddr = m.addresses.houseManager;
  const hm = await ethers.getContractAt("HouseManager", hmAddr);
  const provider = ethers.provider;
  const head = await provider.getBlockNumber();
  const dep = m.deploymentBlock;

  console.log(`HM: ${hmAddr}`);
  console.log(`Head block: ${head}, deployed at: ${dep}, blocks since deploy: ${head - dep}`);
  console.log(`HM balance: ${ethers.formatEther(await provider.getBalance(hmAddr))} STT`);
  console.log("");

  const hourlySubId = await hm.hourlyCronSubId();
  const betSubId = await hm.betSettledSubId();
  const lastTickTs = await hm.lastHourlyTickTs();
  console.log(`hourlyCronSubId: ${hourlySubId}`);
  console.log(`betSettledSubId: ${betSubId}`);
  console.log(`lastHourlyTickTs: ${lastTickTs} (= ${lastTickTs > 0n ? new Date(Number(lastTickTs) * 1000).toISOString() : "NEVER FIRED"})`);
  console.log("");

  // Count events between deploy and now via fetched chunks
  const CHUNK = 900;
  const topics = {
    ReactiveHourlyTick: hm.interface.getEvent("ReactiveHourlyTick").topicHash,
    RtpAnalysisRequested: hm.interface.getEvent("RtpAnalysisRequested").topicHash,
    RtpAnalysisResolved: hm.interface.getEvent("RtpAnalysisResolved").topicHash,
    PlayerDecisionRequested: hm.interface.getEvent("PlayerDecisionRequested").topicHash,
    AgentRequestSkipped: hm.interface.getEvent("AgentRequestSkipped").topicHash,
  };
  const counts = {};
  for (const [name, topic] of Object.entries(topics)) counts[name] = 0;

  for (let from = dep; from <= head; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, head);
    for (const [name, topic] of Object.entries(topics)) {
      try {
        const logs = await provider.send("eth_getLogs", [{
          address: hmAddr, topics: [topic],
          fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16),
        }]);
        counts[name] += logs.length;
      } catch (e) { /* ignore range error */ }
    }
  }
  console.log("Event counts since deploy:");
  for (const [name, n] of Object.entries(counts)) console.log(`  ${name}: ${n}`);
}
main().catch(e => { console.error(e); process.exit(1); });
