const { ethers } = require("hardhat");
async function main() {
  const txs = [
    "0x7d30bf2e87720d4e5f5fd68510851669a7eab0f53b2c5e479ce5baaa7b72664b",
    "0xcbdefdfe3927204ddea6eb26e2da71a8f1a35be56e9c3e5572206d46e4b88227",
    "0x824f87e19b01e9de28adcff6b90aa23fb14b93976ae79862e74751463c37442d",
    "0xd1aecd3c3515487f3f0d7b160cfad8403ae0f93e016cb66604ac13a66f403435",
    "0xea3164bbec25b284ac4cc9559590f7f1506f4b638ec4e3b0329176d95f427fdf",
  ];
  for (const h of txs) {
    const r = await ethers.provider.getTransactionReceipt(h);
    console.log(`tx=${h.slice(0,20)} status=${r?.status} block=${r?.blockNumber} logs=${r?.logs?.length || 0}`);
  }
  const head = await ethers.provider.getBlockNumber();
  console.log(`head=${head}, txs were at blocks ${txs.length} above`);
  
  // Check a known tx's logs
  console.log("\nLogs of first tx (RtpAnalysisRequested):");
  const r = await ethers.provider.getTransactionReceipt(txs[0]);
  if (r?.logs) {
    for (const log of r.logs) {
      console.log(`  topic0=${log.topics[0]} addr=${log.address}`);
    }
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
