// Refill the live casino seed pool (drained to 0 → NoSeedAvailable on every
// bet/round). Provisions correctly-derived seed hashes (verified against the
// live master key) so the casino unfreezes and the reveal-bot (same key) can
// still reveal/settle them.
//
// Does NOT pause anything. Uses on-chain pool length as the source of truth:
// after each provision it polls until the length grows, then read-back-verifies
// the stored hashes match our derivation before continuing. Any mismatch aborts.
//
//   npx hardhat run scripts/_recover-seeds.js --network somniaTestnet
require("dotenv").config();
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const TARGET_ADD = parseInt(process.env.SEED_ADD || "6000", 10); // ~50h roulette runway
const CHUNK = 200;
const masterKey = process.env.SEED_MASTER_KEY;
const deriveSeed = (mk, idx) => ethers.keccak256(ethers.solidityPacked(["bytes32", "uint256"], [mk, BigInt(idx)]));
const hashSeed = (s) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [s]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!/^0x[0-9a-fA-F]{64}$/.test(masterKey || "")) throw new Error("SEED_MASTER_KEY invalid");
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somniaTestnet.json"), "utf8"));
  const casino = await ethers.getContractAt("Casino", m.addresses.casino, (await ethers.getSigners())[0]);
  const signer = await casino.runner.getAddress();
  if ((await casino.owner()).toLowerCase() !== signer.toLowerCase()) throw new Error("signer != owner");
  if ((await casino.seedHashes(0)).toLowerCase() !== hashSeed(deriveSeed(masterKey, 0)).toLowerCase()) throw new Error("master key mismatch");
  console.log("owner + derivation key verified ✓ (no pause — provisioning only)");

  const before = await casino.seedPoolStatus();
  console.log(`pool BEFORE: total=${Number(before[0])} consumed=${Number(before[1])} available=${Number(before[2])}`);

  let added = 0;
  while (added < TARGET_ADD) {
    const total = Number((await casino.seedPoolStatus())[0]);
    const n = Math.min(CHUNK, TARGET_ADD - added);
    const hashes = [];
    for (let i = 0; i < n; i++) hashes.push(hashSeed(deriveSeed(masterKey, total + i)));

    // send; if the broadcast itself collides, retry the SEND only
    let broadcast = false;
    for (let attempt = 0; attempt < 6 && !broadcast; attempt++) {
      try { await casino.provisionSeedHashes(hashes); broadcast = true; }
      catch (e) {
        const msg = e.shortMessage || e.message || "";
        if (/nonce|replacement|already known|underpriced|mempool/i.test(msg)) { await sleep(1500 + Math.random() * 1500); }
        else throw e;
      }
    }

    // wait for the on-chain length to actually grow (truth, not tx.wait)
    let landed = false;
    for (let waited = 0; waited < 60 && !landed; waited += 2) {
      await sleep(2000);
      if (Number((await casino.seedPoolStatus())[0]) >= total + n) landed = true;
    }
    if (!landed) { console.log(`  chunk at ${total} not yet landed — retrying same indices`); continue; }

    const first = await casino.seedHashes(total);
    const last = await casino.seedHashes(total + n - 1);
    if (first.toLowerCase() !== hashes[0].toLowerCase() || last.toLowerCase() !== hashes[n - 1].toLowerCase())
      throw new Error(`read-back mismatch at index ${total} — aborting (no further provisioning)`);
    added += n;
    if (added % 1000 === 0 || added === TARGET_ADD) console.log(`  +${added}/${TARGET_ADD} verified (up to idx ${total + n - 1})`);
  }

  const after = await casino.seedPoolStatus();
  console.log(`pool AFTER: total=${Number(after[0])} consumed=${Number(after[1])} available=${Number(after[2])}`);
  console.log("✅ casino seed pool refilled — NoSeedAvailable cleared");
}
main().catch((e) => { console.error("RECOVERY FAILED:", e.message); process.exit(1); });
