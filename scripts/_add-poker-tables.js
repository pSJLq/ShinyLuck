// Add a few more cash tables (varied stakes/sizes) so the lobby shows variety.
// Run:  npx hardhat run scripts/_add-poker-tables.js --network somniaTestnet
// (stop the dealer bot first — shares the POKER_DEPLOYER_KEY nonce)
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
const E = (n) => ethers.parseEther(String(n));

const TABLES = [
  { maxSeats: 6, smallBlind: E("0.02"), bigBlind: E("0.05"), ante: 0, minBuyIn: E("1"), maxBuyIn: E("5"), rakeBps: 250, rakeCap: E("0.1"), actionTimeout: 45, active: true },
  { maxSeats: 2, smallBlind: E("0.01"), bigBlind: E("0.02"), ante: 0, minBuyIn: E("0.4"), maxBuyIn: E("2"), rakeBps: 250, rakeCap: E("0.05"), actionTimeout: 45, active: true },
  { maxSeats: 9, smallBlind: E("0.01"), bigBlind: E("0.02"), ante: 0, minBuyIn: E("0.4"), maxBuyIn: E("2"), rakeBps: 250, rakeCap: E("0.05"), actionTimeout: 45, active: true },
  { maxSeats: 6, smallBlind: E("0.1"), bigBlind: E("0.2"), ante: 0, minBuyIn: E("4"), maxBuyIn: E("20"), rakeBps: 250, rakeCap: E("0.5"), actionTimeout: 45, active: true },
];

async function main() {
  const net = network.name;
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `poker-${net}.json`), "utf8"));
  const deployer = process.env.POKER_DEPLOYER_KEY ? new ethers.Wallet(process.env.POKER_DEPLOYER_KEY, ethers.provider) : (await ethers.getSigners())[0];
  const room = await ethers.getContractAt("PokerRoom", m.addresses.pokerRoom, deployer);
  const before = Number(await room.tableCount());
  for (const t of TABLES) { await (await room.createTable(t)).wait(); console.log(`+ ${t.maxSeats}-max ${ethers.formatEther(t.smallBlind)}/${ethers.formatEther(t.bigBlind)}`); }
  console.log(`tables: ${before} → ${Number(await room.tableCount())}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
