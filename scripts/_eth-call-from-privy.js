// Simulate the exact placeDiceBet tx from the user's Privy embedded wallet
// to extract the real revert reason that ethers swallowed during estimateGas.
const { ethers } = require("hardhat");
const path = require("path");
const dep = require(path.join(__dirname, "..", "deployments", "somniaTestnet.json"));

const PRIVY_ADDR = "0x9368eCAC488c58CcAb4a0a8C75B86c2f990ED4B2";

async function main() {
  const casino = await ethers.getContractAt("Casino", dep.addresses.casino);
  console.log(`simulating placeDiceBet(50, true, 0xRANDOM) from ${PRIVY_ADDR}`);

  const balance = await ethers.provider.getBalance(PRIVY_ADDR);
  console.log(`Privy wallet balance: ${ethers.formatEther(balance)} STT`);

  const data = casino.interface.encodeFunctionData("placeDiceBet", [50, true, "0x" + "11".repeat(32)]);
  try {
    const result = await ethers.provider.call({
      to: dep.addresses.casino,
      from: PRIVY_ADDR,
      data,
      value: ethers.parseEther("0.001"),
    });
    console.log("eth_call OK, returned:", result);
  } catch (e) {
    console.error("eth_call reverted:");
    console.error("  message:", e.shortMessage || e.message);
    console.error("  data   :", e.data || e.error?.data || "no data");
    console.error("  info   :", JSON.stringify(e.info || {}, null, 2).slice(0, 400));
    // Try to decode the revert data against Casino's error ABI
    if (e.data || e.error?.data) {
      const rd = e.data || e.error.data;
      try {
        const parsed = casino.interface.parseError(rd);
        console.error("  decoded:", parsed.name, parsed.args);
      } catch (de) {
        console.error("  not a Casino error selector. raw:", rd);
      }
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
