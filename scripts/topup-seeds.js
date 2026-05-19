// Generate a fresh batch of server seeds, push their commit-hashes into the
// Casino seed pool, and append the unrevealed seeds into the pool file the
// reveal-bot watches (deployments/seeds/<network>-pool.json).
//
//   COUNT=1000 npx hardhat run scripts/topup-seeds.js --network somniaTestnet

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const COUNT = parseInt(process.env.COUNT, 10) || 500;

function genSeed() { return "0x" + crypto.randomBytes(32).toString("hex"); }
function hashSeed(seed) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [seed]));
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"));
  const casino = await ethers.getContractAt("Casino", manifest.addresses.casino);

  // Probe the contract for its current seed cursor — new hashes land at
  // indices [nextHashIndex, nextHashIndex + COUNT). We must persist seeds
  // keyed by their ABSOLUTE on-chain index, otherwise the reveal-bot can't
  // map seedIdx=500 → pool[500] (shape-1 contiguous arrays start at 0).
  const startIdx = Number(await casino.nextHashIndex());
  console.log(`[topup-seeds] casino=${manifest.addresses.casino} nextHashIndex=${startIdx}`);
  console.log(`[topup-seeds] generating ${COUNT} new seeds → will live at indices ${startIdx}..${startIdx + COUNT - 1}`);

  const seeds = [], hashes = [];
  for (let i = 0; i < COUNT; i++) {
    const s = genSeed();
    seeds.push(s); hashes.push(hashSeed(s));
  }

  // Chunk on-chain provision into 200-seed batches to keep tx gas reasonable.
  const CHUNK = 200;
  for (let i = 0; i < hashes.length; i += CHUNK) {
    const slice = hashes.slice(i, i + CHUNK);
    const tx = await casino.provisionSeedHashes(slice);
    console.log(`[topup-seeds] chunk ${i}..${i + slice.length} tx=${tx.hash}`);
    await tx.wait();
  }

  // Write/merge into the sparse-map shape of the pool file (shape 2 in
  // reveal-bot.js). Sparse map lets us key by absolute on-chain index so
  // reveal-bot picks the right seed regardless of how many were burned
  // before this top-up.
  const poolPath = path.join(__dirname, "..", "deployments", "seeds", `${network.name}-pool.json`);
  let pool = {};
  if (fs.existsSync(poolPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(poolPath, "utf8"));
      if (Array.isArray(raw.seeds)) {
        // Legacy shape 1 — convert to sparse map (assumes indices 0..N).
        raw.seeds.forEach((s, i) => { if (s) pool[String(i)] = s; });
      } else if (raw && typeof raw === "object") {
        pool = raw;
      }
    } catch (_) { /* start fresh on parse error */ }
  }
  for (let i = 0; i < seeds.length; i++) {
    pool[String(startIdx + i)] = seeds[i];
  }
  fs.writeFileSync(poolPath, JSON.stringify(pool, null, 2));
  const count = Object.keys(pool).length;
  console.log(`[topup-seeds] pool file now indexes ${count} seeds (sparse map)`);
  console.log(`[topup-seeds] done.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
