const { ethers } = require("hardhat");
const path = require("path");
const dep = require(path.join(__dirname, "..", "deployments", "somniaTestnet.json"));

async function main() {
  const casino = await ethers.getContractAt("Casino", dep.addresses.casino);
  const paused = await casino.paused();
  console.log("Casino.paused() (global):", paused);
  const names = ["DICE","CRASH","SLOTS","MINES","PLINKO","ROULETTE","CLUSTER"];
  for (let i = 0; i < 7; i++) {
    const p = await casino.gamePaused(i);
    console.log(`gamePaused[${names[i]}] = ${p}`);
  }
  // circuit breaker state
  try {
    const hourStartTs = await casino.hourStartTimestamp();
    const hourStartBr = await casino.hourStartBankroll();
    const now = BigInt(Math.floor(Date.now() / 1000));
    const free = await casino.freeBankroll();
    console.log(`\nhourStartTimestamp = ${hourStartTs}`);
    console.log(`hourStartBankroll  = ${ethers.formatEther(hourStartBr)} STT`);
    console.log(`freeBankroll now   = ${ethers.formatEther(free)} STT`);
    if (hourStartBr > 0n) {
      const lossBps = hourStartBr > free ? (hourStartBr - free) * 10000n / hourStartBr : 0n;
      console.log(`hour loss bps      = ${lossBps} (trip at 2000)`);
    }
    console.log(`age (s)            = ${now - hourStartTs}`);
  } catch (e) { console.warn("breaker state read failed:", e.message); }
}
main().catch(e => { console.error(e); process.exit(1); });
