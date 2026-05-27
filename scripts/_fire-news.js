const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somniaTestnet.json"), "utf8"));
  const hm = await ethers.getContractAt("HouseManager", m.addresses.houseManager);
  const [signer] = await ethers.getSigners();
  console.log(`Firing requestNewsHeadline() from ${signer.address}`);
  console.log(`HM balance: ${ethers.formatEther(await ethers.provider.getBalance(m.addresses.houseManager))} STT`);
  console.log(`Parse cost: ${ethers.formatEther(await hm.quoteParseCost())} STT`);
  try {
    const tx = await hm.requestNewsHeadline();
    console.log(`tx=${tx.hash}`);
    await tx.wait();
    console.log("OK - watch for NewsHeadlineRequested then NewsHeadlineResolved then NewsBonusDecisionRequested then NewsBonusDecisionResolved events");
  } catch (e) { console.error(e.shortMessage || e.message); }
}
main().catch(e=>{console.error(e);process.exit(1);});
