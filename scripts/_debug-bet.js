// Place a tiny dice bet directly to capture the revert reason in cleartext.
const { ethers } = require("hardhat");
const path = require("path");
const dep = require(path.join(__dirname, "..", "deployments", "somniaTestnet.json"));

async function main() {
  const [s] = await ethers.getSigners();
  const casino = await ethers.getContractAt("Casino", dep.addresses.casino, s);
  const cs = ethers.hexlify(ethers.randomBytes(32));
  console.log("placing 0.003 STT dice target=50 over=true");
  try {
    const tx = await casino.placeDiceBet(50, true, cs, { value: ethers.parseEther("0.003") });
    const r = await tx.wait();
    console.log("OK, betId from logs:", r.logs[0]?.topics?.[1]);
  } catch (e) {
    console.error("place failed:");
    console.error("  shortMessage:", e.shortMessage);
    console.error("  reason     :", e.reason);
    console.error("  errorName  :", e.errorName);
    console.error("  errorArgs  :", e.errorArgs);
    console.error("  raw error  :", e.error?.data || e.data || JSON.stringify(e).slice(0, 500));
    console.error("  full       :", e.message);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
