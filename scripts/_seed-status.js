const { ethers } = require("hardhat");
const dep = require("../deployments/somniaTestnet.json");

async function main() {
  const casino = await ethers.getContractAt("Casino", dep.addresses.casino);
  const status = await casino.seedPoolStatus();
  console.log(`total=${status[0]}  consumed=${status[1]}  next=${status[2]}`);
  console.log(`available = ${Number(status[0]) - Number(status[1])}`);
}
main().catch(e => { console.error(e); process.exit(1); });
