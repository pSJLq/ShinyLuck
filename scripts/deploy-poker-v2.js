// Deploy the ShinyPoker zkShuffle v2 stack: PokerRoom v3 (worker operators,
// penalized cancel, blind-off) + ZkTableDealer (the mental-poker card layer)
// + PokerTournament, wire them, register the coordinator worker keys, open the
// cash-table tiers, and write the manifest (+ frontend config unless skipped).
//
// Used for BOTH the local E2E (npx hardhat run … --network localhost) and the
// production testnet deploy (--network somniaTestnet with POKER_DEPLOYER_KEY).
//
// Env:
//   POKER_DEPLOYER_KEY   funded deployer/owner key (testnet; localhost uses signer 0)
//   POKER_SEED_MASTER_KEY  32-byte hex — worker keys derive from it (bot uses the same)
//   ZK_WORKERS           number of coordinator worker keys (default 3)
//   POKER_PLAYER_PROFILE / POKER_AVATAR_STORE   reuse existing deployments (testnet)
//   POKER_DEALER_API_URL  frontend dealer API url (default per-network)
//   WRITE_CONFIG=0       skip rewriting frontend/poker/poker-config.js (E2E)

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const E = (n) => ethers.parseEther(String(n));

// The live cash tiers (rake 10%, generous cap — same as v1 prod).
const TABLES = [
  { maxSeats: 6, smallBlind: E("0.01"), bigBlind: E("0.02"), ante: 0, minBuyIn: E("0.4"), maxBuyIn: E("2"), rakeBps: 1000, rakeCap: E("1000"), actionTimeout: 45, active: true },
  { maxSeats: 6, smallBlind: E("0.05"), bigBlind: E("0.1"), ante: 0, minBuyIn: E("1"), maxBuyIn: E("5"), rakeBps: 1000, rakeCap: E("1000"), actionTimeout: 45, active: true },
  { maxSeats: 6, smallBlind: E("0.01"), bigBlind: E("0.02"), ante: 0, minBuyIn: E("0.4"), maxBuyIn: E("2"), rakeBps: 1000, rakeCap: E("1000"), actionTimeout: 45, active: true },
  { maxSeats: 2, smallBlind: E("0.01"), bigBlind: E("0.02"), ante: 0, minBuyIn: E("0.4"), maxBuyIn: E("2"), rakeBps: 1000, rakeCap: E("1000"), actionTimeout: 45, active: true },
  { maxSeats: 9, smallBlind: E("0.1"), bigBlind: E("0.2"), ante: 0, minBuyIn: E("4"), maxBuyIn: E("20"), rakeBps: 1000, rakeCap: E("1000"), actionTimeout: 45, active: true },
];

async function main() {
  const net = network.name;
  const local = net === "localhost" || net === "hardhat";
  const master = process.env.POKER_SEED_MASTER_KEY || process.env.SEED_MASTER_KEY;
  if (!master || !/^0x[0-9a-fA-F]{64}$/.test(master)) throw new Error("set POKER_SEED_MASTER_KEY (32-byte hex; the bot must use the same)");

  let deployer;
  if (!local && process.env.POKER_DEPLOYER_KEY) {
    deployer = new ethers.Wallet(process.env.POKER_DEPLOYER_KEY, ethers.provider);
  } else {
    [deployer] = await ethers.getSigners();
  }
  const gasBal = await ethers.provider.getBalance(deployer.address);
  console.log(`[v2] net=${net} deployer=${deployer.address} balance=${ethers.formatEther(gasBal)}`);

  const W = Math.max(1, parseInt(process.env.ZK_WORKERS || "3", 10));
  const workers = Array.from({ length: W }, (_, i) =>
    new ethers.Wallet(ethers.keccak256(ethers.solidityPacked(["bytes32", "string"], [master, `zk-worker-${i}`])), ethers.provider));

  // 1. contracts
  const Room = await ethers.getContractFactory("PokerRoom", deployer);
  const room = await Room.deploy(deployer.address);
  await room.waitForDeployment();
  const roomAddr = await room.getAddress();

  const Zkd = await ethers.getContractFactory("ZkTableDealer", deployer);
  const zkd = await Zkd.deploy(roomAddr, deployer.address);
  await zkd.waitForDeployment();
  const zkdAddr = await zkd.getAddress();

  const Trn = await ethers.getContractFactory("PokerTournament", deployer);
  const trn = await Trn.deploy(deployer.address, roomAddr);
  await trn.waitForDeployment();
  const trnAddr = await trn.getAddress();

  let ppAddr = process.env.POKER_PLAYER_PROFILE || "";
  if (!ppAddr) {
    const PP = await ethers.getContractFactory("PlayerProfile", deployer);
    const pp = await PP.deploy();
    await pp.waitForDeployment();
    ppAddr = await pp.getAddress();
  }
  const avAddr = process.env.POKER_AVATAR_STORE || "";
  console.log(`[v2] PokerRoom=${roomAddr}\n[v2] ZkTableDealer=${zkdAddr}\n[v2] PokerTournament=${trnAddr}\n[v2] PlayerProfile=${ppAddr}${avAddr ? `\n[v2] AvatarStore=${avAddr} (reused)` : ""}`);

  // 2. wiring
  await (await room.setDealer(zkdAddr)).wait();
  await (await room.setDealerOperator(deployer.address)).wait();
  await (await room.setTournamentFactory(trnAddr)).wait();
  await (await trn.setOperator(deployer.address)).wait();
  for (const w of workers) {
    await (await room.setOperator(w.address, true)).wait();
    await (await zkd.setCoordinator(w.address, true)).wait();
  }
  console.log(`[v2] wired; ${W} worker keys registered: ${workers.map((w) => w.address.slice(0, 10)).join(", ")}`);

  // 3. fund the workers (they pay prepare/reveal gas on their tables)
  const target = local ? E("100") : E("2");
  for (const w of workers) {
    const have = await ethers.provider.getBalance(w.address);
    if (have >= target) continue;
    const value = target - have;
    const est = await ethers.provider.estimateGas({ from: deployer.address, to: w.address, value }).catch(() => 300000n);
    await (await deployer.sendTransaction({ to: w.address, value, gasLimit: (est * 13n) / 10n })).wait();
  }
  console.log(`[v2] workers funded to ${ethers.formatEther(target)} each`);

  // 4. cash tables
  for (const cfg of TABLES) await (await room.createTable(cfg)).wait();
  console.log(`[v2] created ${TABLES.length} cash tables (rake 10%)`);

  // 5. manifest (no commitRevealDealer → the bot runs in zk mode)
  const block = await ethers.provider.getBlockNumber();
  const manifest = {
    network: net,
    chainId: String((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    operator: deployer.address,
    workers: workers.map((w) => w.address),
    deploymentBlock: block,
    cardLayer: "zk",
    addresses: { pokerRoom: roomAddr, zkTableDealer: zkdAddr, pokerTournament: trnAddr, playerProfile: ppAddr, ...(avAddr ? { avatarStore: avAddr } : {}) },
    v1: {
      // archived commit-reveal stack (kept on-chain; balances migrated at cutover)
      pokerRoom: "0x7E1387FCE14522B981C07bca921e857CfeD636e3",
      commitRevealDealer: "0x551C3ee9352199Ad0b100D7deD0fD13637B30E79",
      pokerTournament: "0xB4808411903Fb8e2Eee23bceB9f274943EDAf766",
    },
    deployedAt: new Date().toISOString(),
  };
  const depDir = path.join(__dirname, "..", "deployments");
  fs.writeFileSync(path.join(depDir, `poker-${net}.json`), JSON.stringify(manifest, null, 2));
  const feDepDir = path.join(__dirname, "..", "frontend", "deployments");
  if (fs.existsSync(feDepDir) && !local) fs.writeFileSync(path.join(feDepDir, `poker-${net}.json`), JSON.stringify(manifest, null, 2));
  console.log(`[v2] manifest → deployments/poker-${net}.json`);

  // 6. frontend config (skipped for local E2E unless forced)
  if (process.env.WRITE_CONFIG !== "0" && (!local || process.env.WRITE_CONFIG === "1")) {
    const apiUrl = process.env.POKER_DEALER_API_URL || (local ? "http://localhost:3102" : "https://shinia.mom/dealer");
    const p = path.join(__dirname, "..", "frontend", "poker", "poker-config.js");
    let src = fs.readFileSync(p, "utf8");
    src = src.replace(/network:\s*"[^"]*"/, `network: "${net}"`);
    src = src.replace(/pokerRoom:\s*"[^"]*"/, `pokerRoom: "${roomAddr}"`);
    src = src.replace(/commitRevealDealer:\s*"[^"]*"/, `commitRevealDealer: ""`);
    src = src.replace(/pokerTournament:\s*"[^"]*"/, `pokerTournament: "${trnAddr}"`);
    src = src.replace(/playerProfile:\s*"[^"]*"/, `playerProfile: "${ppAddr}"`);
    if (avAddr) src = src.replace(/avatarStore:\s*"[^"]*"/, `avatarStore: "${avAddr}"`);
    src = src.replace(/zkTableDealer:\s*"[^"]*"/, `zkTableDealer: "${zkdAddr}"`);
    src = src.replace(/cardLayer:\s*"[^"]*"/, `cardLayer: "zk"`);
    src = src.replace(/dealerApiUrl:\s*"[^"]*"/, `dealerApiUrl: "${apiUrl}"`);
    fs.writeFileSync(p, src);
    console.log(`[v2] wrote frontend/poker/poker-config.js (cardLayer=zk)`);
  }

  console.log(`\n[v2] DONE. Bot: NETWORK_NAME=${net} node scripts/poker-dealer-bot.js (same POKER_SEED_MASTER_KEY, ZK_WORKERS=${W})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
