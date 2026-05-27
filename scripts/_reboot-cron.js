const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somniaTestnet.json"), "utf8"));
  const hm = await ethers.getContractAt("HouseManager", m.addresses.houseManager);
  const [signer] = await ethers.getSigners();
  console.log(`Signer: ${signer.address}, owner: ${await hm.owner()}`);
  console.log(`Before: hourlyCronSubId=${await hm.hourlyCronSubId()}, lastTick=${await hm.lastHourlyTickTs()}`);
  console.log(`Calling rebootHourlyTick()...`);
  const tx = await hm.rebootHourlyTick();
  console.log(`tx=${tx.hash}`);
  await tx.wait();
  console.log(`After: hourlyCronSubId=${await hm.hourlyCronSubId()}`);
  console.log(`Next tick in ~1 hour from now.`);
}
main().catch(e=>{console.error(e);process.exit(1);});
