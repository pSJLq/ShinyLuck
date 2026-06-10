// Deploy ShinyPoker (PokerRoom + CommitRevealDealer) to Somnia, wire them,
// open a default cash table, provision server-seed commitments, and write the
// manifest + frontend config + bot env.
//
// SAFETY: by default this uses the same deployer key as the casino, which the
// Railway reveal-bot also signs with → nonce collisions. To keep the live
// casino (Agentathon submission) untouched, set POKER_DEPLOYER_KEY to a
// SEPARATE funded key; this script then deploys + owns poker entirely from it.
//
// Run:  npx hardhat run scripts/deploy-poker.js --network somniaTestnet
// Env:  POKER_DEPLOYER_KEY (optional, recommended), POKER_OPERATOR (address,
//       defaults to deployer), POKER_SEED_MASTER_KEY (required; the bot MUST
//       use the same value), POKER_DEALER_API_URL (optional), SEED_BATCH (opt).

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { hashSeed, deriveSeed } = require("./lib/poker-deck");

const E = (n) => ethers.parseEther(String(n));

// Default 6-max testnet cash table — deliberately tiny stakes so a full play
// test costs almost no STT (blinds 0.01 / 0.02, buy-in 0.4–2).
const DEFAULT_TABLE = {
  maxSeats: 6,
  smallBlind: E("0.01"),
  bigBlind: E("0.02"),
  ante: 0,
  minBuyIn: E("0.4"), // 20 bb
  maxBuyIn: E("2"), // 100 bb
  rakeBps: 250, // 2.5%
  rakeCap: E("0.05"),
  actionTimeout: 45,
  active: true,
};

async function main() {
  const net = network.name;
  const master = process.env.POKER_SEED_MASTER_KEY || process.env.SEED_MASTER_KEY;
  if (!master || !/^0x[0-9a-fA-F]{64}$/.test(master)) {
    throw new Error("set POKER_SEED_MASTER_KEY to a 32-byte hex value (the bot must use the same one)");
  }
  const seedBatch = parseInt(process.env.SEED_BATCH || "120", 10);

  // Deployer: a separate poker key if provided (recommended), else the default signer.
  let deployer;
  if (process.env.POKER_DEPLOYER_KEY) {
    deployer = new ethers.Wallet(process.env.POKER_DEPLOYER_KEY, ethers.provider);
    console.log(`[deploy-poker] using dedicated POKER_DEPLOYER_KEY`);
  } else {
    [deployer] = await ethers.getSigners();
    console.log(`[deploy-poker] WARNING: using the default (casino) deployer key — stop the Railway reveal-bot first to avoid nonce collisions`);
  }
  const operator = process.env.POKER_OPERATOR || deployer.address;
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`[deploy-poker] net=${net} deployer=${deployer.address} balance=${ethers.formatEther(bal)} operator=${operator}`);

  // 1. Deploy
  const Room = await ethers.getContractFactory("PokerRoom", deployer);
  const room = await Room.deploy(deployer.address);
  await room.waitForDeployment();
  const roomAddr = await room.getAddress();

  const Dealer = await ethers.getContractFactory("CommitRevealDealer", deployer);
  const dealer = await Dealer.deploy(deployer.address);
  await dealer.waitForDeployment();
  const dealerAddr = await dealer.getAddress();

  const Trn = await ethers.getContractFactory("PokerTournament", deployer);
  const trn = await Trn.deploy(deployer.address, roomAddr);
  await trn.waitForDeployment();
  const trnAddr = await trn.getAddress();
  console.log(`[deploy-poker] PokerRoom=${roomAddr}  CommitRevealDealer=${dealerAddr}  PokerTournament=${trnAddr}`);

  // 2. Wire
  await (await dealer.setRoom(roomAddr)).wait();
  await (await dealer.setDealerBot(operator)).wait();
  await (await room.setDealer(dealerAddr)).wait();
  await (await room.setDealerOperator(operator)).wait();
  await (await room.setTournamentFactory(trnAddr)).wait();
  await (await trn.setOperator(operator)).wait();
  console.log(`[deploy-poker] wired room⇄dealer⇄tournament, operator set`);

  // 3. Default table
  await (await room.createTable(DEFAULT_TABLE)).wait();
  console.log(`[deploy-poker] created table 0 (6-max, blinds 0.1/0.2)`);

  // 4. Provision seed commitments (deterministic from the master key)
  const hashes = [];
  for (let i = 0; i < seedBatch; i++) hashes.push(hashSeed(deriveSeed(master, i)));
  await (await dealer.provisionSeedHashes(hashes)).wait();
  console.log(`[deploy-poker] provisioned ${seedBatch} seed commitments`);

  // 5. Manifest
  const block = await ethers.provider.getBlockNumber();
  const manifest = {
    network: net,
    chainId: String((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    operator,
    deploymentBlock: block,
    addresses: { pokerRoom: roomAddr, commitRevealDealer: dealerAddr, pokerTournament: trnAddr },
    defaultTable: {
      maxSeats: DEFAULT_TABLE.maxSeats,
      smallBlind: DEFAULT_TABLE.smallBlind.toString(),
      bigBlind: DEFAULT_TABLE.bigBlind.toString(),
      minBuyIn: DEFAULT_TABLE.minBuyIn.toString(),
      maxBuyIn: DEFAULT_TABLE.maxBuyIn.toString(),
    },
    seedBatch,
    deployedAt: new Date().toISOString(),
  };
  const depDir = path.join(__dirname, "..", "deployments");
  fs.writeFileSync(path.join(depDir, `poker-${net}.json`), JSON.stringify(manifest, null, 2));
  const feDepDir = path.join(__dirname, "..", "frontend", "deployments");
  if (fs.existsSync(feDepDir)) fs.writeFileSync(path.join(feDepDir, `poker-${net}.json`), JSON.stringify(manifest, null, 2));

  // 6. Frontend config
  const apiUrl = process.env.POKER_DEALER_API_URL || "http://localhost:3002";
  writeFrontendConfig(net, roomAddr, dealerAddr, trnAddr, apiUrl);

  console.log(`\n[deploy-poker] DONE.`);
  console.log(`  Next: run the dealer bot with the SAME master key:`);
  console.log(`    POKER_ROOM=${roomAddr} POKER_DEALER=${dealerAddr} POKER_SEED_MASTER_KEY=<same> DEALER_KEY=<operator key> node scripts/poker-dealer-bot.js`);
}

function writeFrontendConfig(net, roomAddr, dealerAddr, trnAddr, apiUrl) {
  const p = path.join(__dirname, "..", "frontend", "poker", "poker-config.js");
  let src = fs.readFileSync(p, "utf8");
  src = src.replace(/network:\s*"[^"]*"/, `network: "${net}"`);
  src = src.replace(/pokerRoom:\s*"[^"]*"/, `pokerRoom: "${roomAddr}"`);
  src = src.replace(/commitRevealDealer:\s*"[^"]*"/, `commitRevealDealer: "${dealerAddr}"`);
  src = src.replace(/pokerTournament:\s*"[^"]*"/, `pokerTournament: "${trnAddr}"`);
  src = src.replace(/dealerApiUrl:\s*"[^"]*"/, `dealerApiUrl: "${apiUrl}"`);
  fs.writeFileSync(p, src);
  console.log(`[deploy-poker] wrote frontend/poker/poker-config.js`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
