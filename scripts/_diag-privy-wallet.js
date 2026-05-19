// Inspect the user's Privy embedded wallet state on chain.
const { ethers } = require("hardhat");
const PRIVY_ADDR = "0x9368eCAC488c58CcAb4a0a8C75B86c2f990ED4B2";

async function main() {
  const bal = await ethers.provider.getBalance(PRIVY_ADDR);
  const nonce = await ethers.provider.getTransactionCount(PRIVY_ADDR);
  const code = await ethers.provider.getCode(PRIVY_ADDR);
  console.log(`addr     : ${PRIVY_ADDR}`);
  console.log(`balance  : ${ethers.formatEther(bal)} STT`);
  console.log(`nonce    : ${nonce}`);
  console.log(`hasCode  : ${code !== "0x"}  (${code.length-2} bytes)`);
}
main().catch(e => { console.error(e); process.exit(1); });
