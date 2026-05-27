// Verify the topic0 hash for our event signatures matches what the contract
// would emit. If mismatch -> ABI is wrong somewhere.
const { ethers } = require("hardhat");
async function main() {
  const events = [
    "RtpAnalysisRequested(uint256,uint8,uint16,int256,uint256)",
    "CompetitorRtpRequested(uint256,uint8,string)",
    "PlayerDecisionRequested(uint256,address,uint256,uint256,uint256)",
    "QuorumRequested(uint256,uint256,address)",
  ];
  for (const sig of events) {
    console.log(`${sig.padEnd(70)} → topic0 = ${ethers.id(sig)}`);
  }
  
  // Now via contract ABI like cost-ledger.js does:
  console.log("\nVia HM contract interface:");
  const m = JSON.parse(require("fs").readFileSync("deployments/somniaTestnet.json", "utf8"));
  const hm = await ethers.getContractAt("HouseManager", m.addresses.houseManager);
  for (const name of ["RtpAnalysisRequested", "CompetitorRtpRequested", "PlayerDecisionRequested"]) {
    const ev = hm.interface.getEvent(name);
    console.log(`  ${name.padEnd(28)} topic = ${ev.topicHash}`);
  }
  
  // Now directly via raw eth_getLogs for last 1000 blocks
  const head = await ethers.provider.getBlockNumber();
  const from = head - 1000;
  console.log(`\nRaw eth_getLogs for HM, last 1000 blocks (${from}..${head}):`);
  for (const name of ["RtpAnalysisRequested", "CompetitorRtpRequested", "PlayerDecisionRequested"]) {
    const topic = hm.interface.getEvent(name).topicHash;
    const logs = await ethers.provider.send("eth_getLogs", [{
      address: m.addresses.houseManager,
      topics: [topic],
      fromBlock: "0x" + from.toString(16),
      toBlock: "0x" + head.toString(16),
    }]);
    console.log(`  ${name.padEnd(28)} found ${logs.length} logs in last 1000 blocks`);
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
