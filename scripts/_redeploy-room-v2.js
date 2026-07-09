// Full-stack redeploy for the anti-AFK kick: NEW PokerRoom (timeoutStreak +
// kickIdle) + NEW PokerTournament wired to it. CommitRevealDealer and
// PlayerProfile are REUSED (dealer.setRoom). Real users' funds on the old room
// (idle balances + seated stacks) are re-credited on the new room via
// depositFor from the deployer — script wallets must be evacuated first
// (_evacuate-script-wallets.js).
//
// SAFETY: STOP the VPS `poker` pm2 process before running (shared key).
// Run: npx hardhat run scripts/_redeploy-room-v2.js --network somniaTestnet

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const net = network.name;
  const manifestPath = path.join(__dirname, "..", "deployments", `poker-${net}.json`);
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const deployer = new ethers.Wallet(process.env.POKER_DEPLOYER_KEY, ethers.provider);
  const operator = process.env.POKER_OPERATOR || deployer.address;
  console.log(`net=${net} deployer=${deployer.address} bal=${ethers.formatEther(await ethers.provider.getBalance(deployer.address))}`);

  const oldRoom = await ethers.getContractAt("PokerRoom", m.addresses.pokerRoom, deployer);
  const dealer = await ethers.getContractAt("CommitRevealDealer", m.addresses.commitRevealDealer, deployer);
  const oldTrnAddr = m.addresses.pokerTournament;

  // script wallets — already evacuated, never migrated
  const master = process.env.POKER_SEED_MASTER_KEY;
  const skip = new Set([deployer.address.toLowerCase()]);
  for (const tag of [...Array.from({ length: 12 }, (_, i) => `load-${i + 1}`), "e2e-player-1", "e2e-player-2"]) {
    skip.add(new ethers.Wallet(ethers.keccak256(ethers.solidityPacked(["bytes32", "string"], [master, tag]))).address.toLowerCase());
  }

  // ---- collect real-user funds on the old room ----
  const owed = new Map(); // addrLower -> { addr, wei }
  const credit = (addr, wei) => {
    const k = addr.toLowerCase();
    if (wei === 0n || skip.has(k)) return;
    const cur = owed.get(k) || { addr, wei: 0n };
    cur.wei += wei;
    owed.set(k, cur);
  };
  // depositors via logs (one big range; fall back to 200k chunks)
  const iface = oldRoom.interface;
  const topics = ["Deposited", "DepositedFor", "PlayerSeated"].map((e) => iface.getEvent(e).topicHash);
  const latest = await ethers.provider.getBlockNumber();
  const from = m.deploymentBlock || 0;
  let logs = [];
  async function getLogs(f, t) {
    return ethers.provider.send("eth_getLogs", [{ address: m.addresses.pokerRoom, fromBlock: "0x" + f.toString(16), toBlock: "0x" + t.toString(16), topics: [topics] }]);
  }
  try { logs = await getLogs(from, latest); }
  catch (_) {
    console.log("large-range getLogs refused — chunking by 200k blocks");
    for (let f = from; f <= latest; f += 200000) logs.push(...await getLogs(f, Math.min(f + 199999, latest)).catch(() => []));
  }
  const cands = new Set();
  for (const lg of logs) {
    try { const p = iface.parseLog({ topics: lg.topics, data: lg.data }); cands.add((p.args.user || p.args.player).toLowerCase()); } catch (_) {}
  }
  console.log(`candidates from ${logs.length} logs: ${cands.size}`);
  for (const a of cands) { if (!skip.has(a)) credit(ethers.getAddress(a), await oldRoom.balance(a)); }
  // seated stacks
  const nT = Number(await oldRoom.tableCount());
  for (let t = 0; t < nT; t++) {
    const cfg = await oldRoom.getTable(t).catch(() => null);
    if (!cfg) continue;
    for (let s = 0; s < Number(cfg.maxSeats); s++) {
      const seat = await oldRoom.getSeat(t, s);
      if (seat.occupied && seat.player !== ethers.ZeroAddress) credit(seat.player, seat.stack);
    }
  }
  let totalOwed = 0n;
  for (const { addr, wei } of owed.values()) { totalOwed += wei; console.log(`  migrate ${addr}: ${ethers.formatEther(wei)} STT`); }
  console.log(`total to migrate: ${ethers.formatEther(totalOwed)} STT`);

  // ---- cancel any open events on the old tournament (refunds) ----
  if (oldTrnAddr && (await ethers.provider.getCode(oldTrnAddr)) !== "0x") {
    const old = await ethers.getContractAt("PokerTournament", oldTrnAddr, deployer);
    const n = Number(await old.count());
    for (let id = 0; id < n; id++) {
      try {
        const i = await old.info(id);
        if (Number(i.status) === 0) { console.log(`old trn #${id}: cancelling (refunds)`); await (await old.cancel(id)).wait(); }
      } catch (e) { console.log(`old trn #${id}: skip (${e.shortMessage || e.message})`); }
    }
  }

  // ---- deploy + wire the new stack ----
  const Room = await ethers.getContractFactory("PokerRoom", deployer);
  const room = await Room.deploy(deployer.address);
  await room.waitForDeployment();
  const roomAddr = await room.getAddress();
  console.log(`PokerRoom(v2, anti-AFK) = ${roomAddr}`);

  await (await room.setDealer(m.addresses.commitRevealDealer)).wait();
  await (await room.setDealerOperator(operator)).wait();
  await (await dealer.setRoom(roomAddr)).wait();
  console.log("wired: room.setDealer + dealer.setRoom + operator");

  const Trn = await ethers.getContractFactory("PokerTournament", deployer);
  const trn = await Trn.deploy(deployer.address, roomAddr);
  await trn.waitForDeployment();
  const trnAddr = await trn.getAddress();
  await (await room.setTournamentFactory(trnAddr)).wait();
  await (await trn.setOperator(operator)).wait();
  console.log(`PokerTournament(v3 code, new room) = ${trnAddr}`);

  // ---- recreate the 5 core cash tables from the old configs ----
  for (let t = 0; t < Math.min(5, nT); t++) {
    const c = await oldRoom.getTable(t);
    await (await room.createTable({
      maxSeats: c.maxSeats, smallBlind: c.smallBlind, bigBlind: c.bigBlind, ante: c.ante,
      minBuyIn: c.minBuyIn, maxBuyIn: c.maxBuyIn, rakeBps: c.rakeBps, rakeCap: c.rakeCap,
      actionTimeout: c.actionTimeout, active: true,
    })).wait();
    console.log(`table ${t} recreated (${c.maxSeats}-max ${ethers.formatEther(c.smallBlind)}/${ethers.formatEther(c.bigBlind)})`);
  }

  // ---- migrate real users' funds ----
  for (const { addr, wei } of owed.values()) {
    await (await room.depositFor(addr, { value: wei })).wait();
    console.log(`credited ${addr} with ${ethers.formatEther(wei)} STT on the new room`);
  }

  // ---- demo SNG ----
  await (await trn.createTournament({
    buyIn: ethers.parseEther("0.05"), fee: ethers.parseEther("0.005"), maxPlayers: 6, seatsPerTable: 0,
    startStack: 1500n, sbStart: 10n, bbStart: 20n, anteStart: 0n, levelDur: 300n,
    growthBps: 15000, startTime: 0n, approvalRequired: false, actionSecs: 0,
    payoutBps: [6500, 3500], structure: [], hostBps: 0,
  }, { value: 0 })).wait();
  console.log("demo SNG created");

  // ---- manifest + frontend config ----
  m.addresses.pokerRoom = roomAddr;
  m.addresses.pokerTournament = trnAddr;
  m.deploymentBlock = latest; // history indexer starts from the new room's era
  m.roomRedeployedAt = new Date().toISOString();
  fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
  const feDep = path.join(__dirname, "..", "frontend", "deployments", `poker-${net}.json`);
  if (fs.existsSync(path.dirname(feDep))) fs.writeFileSync(feDep, JSON.stringify(m, null, 2));
  const cfgPath = path.join(__dirname, "..", "frontend", "poker", "poker-config.js");
  let src = fs.readFileSync(cfgPath, "utf8");
  src = src.replace(/pokerRoom:\s*"[^"]*"/, `pokerRoom: "${roomAddr}"`);
  src = src.replace(/pokerTournament:\s*"[^"]*"/, `pokerTournament: "${trnAddr}"`);
  fs.writeFileSync(cfgPath, src);

  console.log("\nDONE.");
  console.log(`  pokerRoom (NEW)       = ${roomAddr}`);
  console.log(`  pokerTournament (NEW) = ${trnAddr}`);
  console.log(`  dealer (reused)       = ${m.addresses.commitRevealDealer}`);
  console.log("  Next: update_bot.py, deploy frontend, e2e.");
}
main().catch((e) => { console.error(e); process.exit(1); });
