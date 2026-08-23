// v1 → v2 balance migration for the production cutover. Reads the LIVE v1 room
// (manifest.v1.pokerRoom), enumerates every real user's owed funds (idle balance
// + seated stacks, via Deposited/DepositedFor/PlayerSeated logs), and re-credits
// them on the NEW v2 room (manifest.addresses.pokerRoom) via depositFor from the
// deployer. Script/test wallets are skipped.
//
// DEFAULT = PREVIEW ONLY (no funds move). Pass --execute to actually migrate.
// Run: npx hardhat run scripts/_cutover-migrate.js --network somniaTestnet
//   (preview)  ... then ...  MIGRATE_EXECUTE=1 npx hardhat run ... (execute)

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function findDeployBlock(provider, addr, latest) {
  // binary search for the earliest block where the contract has code
  if (await provider.getCode(addr, latest) === "0x") throw new Error("no code at " + addr);
  let lo = 0, hi = latest;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const code = await provider.getCode(addr, mid).catch(() => "0x");
    if (code === "0x") lo = mid + 1; else hi = mid;
  }
  return lo;
}

async function main() {
  const execute = process.env.MIGRATE_EXECUTE === "1";
  const net = network.name;
  const manifestPath = path.join(__dirname, "..", "deployments", `poker-${net}.json`);
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const provider = ethers.provider;
  const deployer = new ethers.Wallet(process.env.POKER_DEPLOYER_KEY, provider);

  const v1Addr = m.v1 && m.v1.pokerRoom;
  const newAddr = m.addresses.pokerRoom;
  if (!v1Addr || !newAddr) throw new Error("manifest missing v1.pokerRoom or addresses.pokerRoom");
  console.log(`MODE: ${execute ? "⚠️  EXECUTE (funds WILL move)" : "PREVIEW (read-only)"}`);
  console.log(`v1 (source) = ${v1Addr}`);
  console.log(`v2 (dest)   = ${newAddr}`);
  console.log(`deployer    = ${deployer.address}  bal=${ethers.formatEther(await provider.getBalance(deployer.address))} STT\n`);

  const oldRoom = await ethers.getContractAt("PokerRoom", v1Addr, deployer);
  const newRoom = await ethers.getContractAt("PokerRoom", newAddr, deployer);

  // skip set: deployer + all known derived script/test wallets
  const master = process.env.POKER_SEED_MASTER_KEY;
  const skip = new Set([deployer.address.toLowerCase()]);
  const tags = [
    ...Array.from({ length: 8 }, (_, i) => `zk-worker-${i}`),
    ...Array.from({ length: 16 }, (_, i) => `load-${i + 1}`),
    "e2e-player-1", "e2e-player-2", "zk-e2e-player-0", "zk-e2e-player-1",
  ];
  for (const t of tags) skip.add(new ethers.Wallet(ethers.keccak256(ethers.solidityPacked(["bytes32", "string"], [master, t]))).address.toLowerCase());

  const owed = new Map();
  const credit = (addr, wei) => {
    const k = addr.toLowerCase();
    if (wei === 0n || skip.has(k)) return;
    const cur = owed.get(k) || { addr, wei: 0n };
    cur.wei += wei; owed.set(k, cur);
  };

  // ---- enumerate depositors via logs (from the v1 room's deploy block) ----
  const latest = await provider.getBlockNumber();
  console.log("locating v1 deploy block (binary search)...");
  const from = await findDeployBlock(provider, v1Addr, latest);
  console.log(`v1 deployed at block ${from}; scanning ${from}..${latest} (${latest - from} blocks)`);
  const iface = oldRoom.interface;
  const topics = ["Deposited", "DepositedFor", "PlayerSeated"].map((e) => iface.getEvent(e).topicHash);
  const getLogs = (f, t) => provider.send("eth_getLogs", [{ address: v1Addr, fromBlock: "0x" + f.toString(16), toBlock: "0x" + t.toString(16), topics: [topics] }]);
  let logs = [];
  try { logs = await getLogs(from, latest); }
  catch (_) {
    console.log("large range refused — chunking 200k...");
    for (let f = from; f <= latest; f += 200000) logs.push(...await getLogs(f, Math.min(f + 199999, latest)).catch(() => []));
  }
  const cands = new Set();
  for (const lg of logs) { try { const p = iface.parseLog({ topics: lg.topics, data: lg.data }); cands.add((p.args.user || p.args.player).toLowerCase()); } catch (_) {} }
  console.log(`candidate addresses from ${logs.length} logs: ${cands.size}`);
  for (const a of cands) { if (!skip.has(a)) credit(ethers.getAddress(a), await oldRoom.balance(a)); }

  // ---- seated stacks on the v1 room ----
  const nT = Number(await oldRoom.tableCount());
  for (let t = 0; t < nT; t++) {
    const cfg = await oldRoom.getTable(t).catch(() => null);
    if (!cfg) continue;
    for (let s = 0; s < Number(cfg.maxSeats); s++) {
      const seat = await oldRoom.getSeat(t, s);
      if (seat.occupied && seat.player !== ethers.ZeroAddress) credit(seat.player, seat.stack);
    }
  }

  // ---- report ----
  let total = 0n;
  const rows = [...owed.values()].sort((a, b) => (b.wei > a.wei ? 1 : -1));
  console.log(`\n===== MIGRATION PREVIEW (${rows.length} users) =====`);
  for (const { addr, wei } of rows) { total += wei; console.log(`  ${addr}  ${ethers.formatEther(wei)} STT`); }
  console.log(`  ----`);
  console.log(`  TOTAL TO MIGRATE: ${ethers.formatEther(total)} STT`);
  const already = await newRoom.balance ? 0n : 0n;
  console.log(`  v1 room total ETH balance: ${ethers.formatEther(await provider.getBalance(v1Addr))} STT (rest = rake + defunct)`);
  console.log(`  deployer will front: ${ethers.formatEther(total)} STT`);

  if (!execute) {
    console.log(`\nPREVIEW ONLY — no funds moved. Re-run with MIGRATE_EXECUTE=1 to migrate.`);
    return;
  }

  // ---- EXECUTE: idempotent depositFor (skip anyone already credited) ----
  console.log(`\n⚠️  EXECUTING migration...`);
  for (const { addr, wei } of rows) {
    const have = await newRoom.balance(addr);
    if (have >= wei) { console.log(`  skip ${addr} (already has ${ethers.formatEther(have)})`); continue; }
    const topUp = wei - have;
    await (await newRoom.depositFor(addr, { value: topUp })).wait();
    console.log(`  credited ${addr} += ${ethers.formatEther(topUp)} STT`);
  }
  console.log(`\nDONE. Migrated ${ethers.formatEther(total)} STT to ${newAddr}.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
