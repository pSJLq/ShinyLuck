// Check seed pool status on the live Casino.
const { ethers } = require("hardhat");
const path = require("path");
const dep = require(path.join(__dirname, "..", "deployments", "somniaTestnet.json"));

async function main() {
  const casino = await ethers.getContractAt("Casino", dep.addresses.casino);
  const nextIdx = await casino.nextHashIndex();
  const totalBets = await casino.totalBets();
  // seedHashes is an array; we can't read length without a getter - try anyway
  let len = -1n;
  try {
    // seedHashes is public array - we can read it by index until it reverts
    // but that's slow. Instead, try to fetch the last seed by index via probing.
    // Casino exposes `seedHashesLength()` if it has one.
    len = await casino.seedHashesLength();
  } catch (_) {
    try {
      const fn = casino.interface.fragments.find(f => f.name === "seedHashes");
      if (fn) {
        // Binary search-ish: try indices 0, 100, 200, etc.
        for (const i of [0, 50, 100, 150, 199, 200, 300, 500, 700, 999]) {
          try { await casino.seedHashes(i); len = BigInt(i + 1); }
          catch { break; }
        }
      }
    } catch (_) {}
  }
  console.log("seedHashes.length (probed):", len);
  console.log("nextHashIndex:            ", nextIdx);
  console.log("totalBets:                ", totalBets);
  console.log("seeds remaining:          ", len > 0n ? (len - nextIdx) : "unknown");
}
main().catch(e => { console.error(e); process.exit(1); });
