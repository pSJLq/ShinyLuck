// Align the HouseManager's RTP clamp [minRtpBps,maxRtpBps] to the band the
// Casino's adjustSlotRTP actually accepts ([9000,9400]). They were mismatched
// (HM 8500..9700 vs casino 9000..9400), so any agent RAISE that computed >9400
// (e.g. 9350 -> 9500) was rejected by the casino with InvalidBet("rtp out of
// band") -> emit AgentRequestSkipped("rtp-analysis","casino-rejected") -> RTP
// stuck flat at 93.5%. Owner-only setter, no redeploy.
//
//   npx hardhat run scripts/_fix-rtp-bounds.js --network somniaTestnet
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [signer] = await ethers.getSigners();
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"));
  const hm = await ethers.getContractAt("HouseManager", manifest.addresses.houseManager);
  console.log(`signer=${signer.address} HM=${manifest.addresses.houseManager}`);
  console.log(`before: min=${Number(await hm.minRtpBps()) / 100}% max=${Number(await hm.maxRtpBps()) / 100}%`);
  const tx = await hm.setRtpBounds(9000, 9400);
  console.log(`setRtpBounds(9000,9400) tx=${tx.hash}`);
  await tx.wait();
  console.log(`after:  min=${Number(await hm.minRtpBps()) / 100}% max=${Number(await hm.maxRtpBps()) / 100}%  ✓ now matches casino band`);
}
main().catch((e) => { console.error(e); process.exit(1); });
