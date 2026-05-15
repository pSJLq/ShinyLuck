// Quick utility — sends STT from the deployer key to the casino bankroll via
// a plain native transfer (Casino's receive() emits BankrollDeposited). Run:
//   AMOUNT_STT=5 npx hardhat run scripts/fund-bankroll.js --network somniaTestnet

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const amount = process.env.AMOUNT_STT || "5";
  const manifestPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const casinoAddr = manifest.addresses.casino;
  const [signer] = await ethers.getSigners();
  const before = await ethers.provider.getBalance(casinoAddr);
  console.log(`[fund] casino=${casinoAddr} balance before: ${ethers.formatEther(before)} STT`);
  const tx = await signer.sendTransaction({
    to: casinoAddr,
    value: ethers.parseEther(amount),
    gasLimit: 100000,
  });
  console.log(`[fund] tx submitted ${tx.hash} — sending ${amount} STT`);
  await tx.wait();
  const after = await ethers.provider.getBalance(casinoAddr);
  console.log(`[fund] balance after:  ${ethers.formatEther(after)} STT`);
}

main().catch((e) => { console.error(e); process.exit(1); });
