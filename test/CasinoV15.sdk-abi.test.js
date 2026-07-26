// Guards the frontend SDK against contract drift: every function/event the SDK
// declares must exist on the compiled contract with the SAME selector/topic.
// Without this, a renamed param or reordered struct field breaks the site
// silently at runtime.
const { expect } = require("chai");
const { ethers, artifacts } = require("hardhat");
const fs = require("fs");
const path = require("path");

const SDK = fs.readFileSync(
  path.join(__dirname, "..", "frontend", "lib", "shinyluck-sdk-v15.js"),
  "utf8"
);

/** Pull a `const NAME_ABI = [ "...", ... ];` block out of the SDK source. */
function abiBlock(name) {
  const m = SDK.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
  if (!m) throw new Error(`ABI block ${name} not found in the SDK`);
  return [...m[1].matchAll(/"((?:function|event)[^"]+)"/g)].map((x) => x[1]);
}

function selectorsOf(iface) {
  const fns = new Set(), evs = new Set();
  iface.forEachFunction((f) => fns.add(f.selector));
  iface.forEachEvent((e) => evs.add(e.topicHash));
  return { fns, evs };
}

async function checkAgainst(contractName, fragments) {
  const art = await artifacts.readArtifact(contractName);
  const real = selectorsOf(new ethers.Interface(art.abi));
  const missing = [];
  for (const frag of fragments) {
    const one = new ethers.Interface([frag]);
    one.forEachFunction((f) => { if (!real.fns.has(f.selector)) missing.push(`fn  ${frag}`); });
    one.forEachEvent((e) => { if (!real.evs.has(e.topicHash)) missing.push(`ev  ${frag}`); });
  }
  return missing;
}

describe("CasinoVault v15 — SDK ABI matches the contracts", () => {
  const cases = [
    ["VAULT_ABI", "CasinoVault"],
    ["SLOT_ABI", "Vault7Module"],
    ["CLUSTER_EXTRA_ABI", "ClusterModule"],
    ["MINES_ABI", "MinesModule"],
    ["CRASH_ABI", "CrashModule"],
    ["ROULETTE_ABI", "RouletteModule"],
    ["LOYALTY_ABI", "SlotLoyalty"],
  ];

  for (const [block, contract] of cases) {
    it(`${block} ⊆ ${contract}`, async () => {
      const missing = await checkAgainst(contract, abiBlock(block));
      expect(missing, `not on ${contract}:\n  ${missing.join("\n  ")}`).to.deep.equal([]);
    });
  }

  it("SLOT_ABI also matches ClusterModule (both slots share the base)", async () => {
    const missing = await checkAgainst("ClusterModule", abiBlock("SLOT_ABI"));
    expect(missing, missing.join("\n")).to.deep.equal([]);
  });

  it("the gameId constants match each module's on-chain GAME_ID", async () => {
    const expected = { DiceModule: 0, CrashModule: 1, Vault7Module: 2, MinesModule: 3, PlinkoModule: 4, RouletteModule: 5, ClusterModule: 6 };
    const m = SDK.match(/export const GAME = \{([^}]+)\}/);
    const sdkIds = Object.fromEntries(
      [...m[1].matchAll(/(\w+):\s*(\d+)/g)].map((x) => [x[1], Number(x[2])])
    );
    const byName = { DICE: "DiceModule", CRASH: "CrashModule", SLOTS: "Vault7Module", MINES: "MinesModule", PLINKO: "PlinkoModule", ROULETTE: "RouletteModule", CLUSTER: "ClusterModule" };
    for (const [key, id] of Object.entries(sdkIds)) {
      expect(id, `SDK GAME.${key}`).to.equal(expected[byName[key]]);
    }
  });
});
