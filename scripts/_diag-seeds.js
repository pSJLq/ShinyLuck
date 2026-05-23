// Quick visibility into seed-pool state and outstanding pending bets.
// Helps debug "STT stuck in locked reserve" - usually that means either
//   (a) reveal-bot is dead/paused, or
//   (b) seeds were exhausted (nextHashIndex >= seedHashes.length) and the
//       bets that DID get placed before exhaustion are now waiting for an
//       agent reveal that will never come.
const { ethers } = require("hardhat");
const path = require("path");
const fs = require("fs");
const dep = require(path.join(__dirname, "..", "deployments", "somniaTestnet.json"));

async function main() {
  const casino = await ethers.getContractAt("Casino", dep.addresses.casino);

  const total = await casino.seedHashes.length ? await casino.seedHashes(0).then(() => true).catch(() => false) : false;
  // ↑ that's awkward; just use the public counter:
  const consumed = await casino.nextHashIndex();
  // Length isn't directly exposed, so iterate seeds until we get a revert.
  // Faster approach: read provisioned-length from the latest seeds file
  // (which is what was uploaded to the contract).
  const seedsDir = path.join(__dirname, "..", "deployments", "seeds");
  const files = fs.readdirSync(seedsDir)
    .filter(f => f.startsWith("somniaTestnet-") && /\d/.test(f) && !f.endsWith("-pool.json") && f.endsWith(".json"))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(seedsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  console.log(`[seeds] nextHashIndex (consumed on-chain) = ${consumed}`);
  console.log(`[seeds] latest seeds file (local):`);
  for (const f of files.slice(0, 5)) {
    const data = JSON.parse(fs.readFileSync(path.join(seedsDir, f.name), "utf8"));
    const n = Array.isArray(data.seeds) ? data.seeds.length : (Array.isArray(data) ? data.length : 0);
    console.log(`   ${f.name}  (${n} seeds)`);
  }

  // Casino financial snapshot
  const free = await casino.freeBankroll();
  const lr = await casino.lockedReserve();
  const heldRaw = await ethers.provider.getBalance(dep.addresses.casino);
  console.log(`\n[bank] casino-held         ${ethers.formatEther(heldRaw)} STT`);
  console.log(`[bank] freeBankroll        ${ethers.formatEther(free)} STT`);
  console.log(`[bank] lockedReserve       ${ethers.formatEther(lr)} STT`);

  // Count outstanding pending bets by walking BetPlaced minus BetSettled events.
  // 1000 blocks ≈ 20 min - long enough to see active demo-bot betting if any.
  const blocksBack = 1000;
  const cur = await ethers.provider.getBlockNumber();
  const from = Math.max(0, cur - blocksBack);
  console.log(`\n[scan] window ${from}..${cur} (~${(blocksBack * 1.2 / 60).toFixed(0)} min)`);

  const placedTopic = casino.interface.getEvent("BetPlaced").topicHash;
  const settledTopic = casino.interface.getEvent("BetSettled").topicHash;

  const CHUNK = 1000;
  let placedCount = 0, settledCount = 0;
  const placed = new Map(); // betId -> { game, block }
  const settled = new Set();
  for (let start = from; start <= cur; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, cur);
    const [placedLogs, settledLogs] = await Promise.all([
      ethers.provider.getLogs({ address: dep.addresses.casino, topics: [placedTopic], fromBlock: start, toBlock: end }),
      ethers.provider.getLogs({ address: dep.addresses.casino, topics: [settledTopic], fromBlock: start, toBlock: end }),
    ]);
    for (const l of placedLogs) {
      try {
        const p = casino.interface.parseLog(l);
        placed.set(p.args.betId.toString(), { game: Number(p.args.game), block: l.blockNumber });
        placedCount++;
      } catch (_) {}
    }
    for (const l of settledLogs) {
      try {
        const p = casino.interface.parseLog(l);
        settled.add(p.args.betId.toString());
        settledCount++;
      } catch (_) {}
    }
  }
  const pendingIds = [...placed.keys()].filter(id => !settled.has(id));
  console.log(`[scan] BetPlaced events:   ${placedCount}`);
  console.log(`[scan] BetSettled events:  ${settledCount}`);
  console.log(`[scan] still pending:      ${pendingIds.length}`);
  if (pendingIds.length > 0) {
    console.log(`\n[pending] first 10 unresolved bets (betId | game | block):`);
    const GAMES = ["DICE","CRASH","SLOTS","MINES","PLINKO","ROULETTE","CLUSTER"];
    for (const id of pendingIds.slice(0, 10)) {
      const p = placed.get(id);
      const age = cur - p.block;
      console.log(`   ${id.padStart(6)} | ${GAMES[p.game].padEnd(8)} | block ${p.block} (${age} blocks old, ~${(age * 1.2 / 60).toFixed(1)} min)`);
    }
    if (pendingIds.length > 10) console.log(`   ...and ${pendingIds.length - 10} more`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
