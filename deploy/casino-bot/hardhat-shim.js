// Minimal hardhat shim so scripts/reveal-bot-v15.js can run standalone on the
// VPS without installing hardhat (which pulls ~400 MB and a solc toolchain the
// bot never uses).
//
// Provides exactly the surface the bot touches: { ethers, network } where
// ethers is real ethers v6 plus the hardhat-ethers helpers, backed by artifact
// JSON on disk and a single Wallet signer. Also loads ../.env so pm2 needs no
// env plumbing.
//
// Deployed to /root/casino-bot/node_modules/hardhat/index.js.
// NOTE: `npm install` in the bot dir DELETES this (npm prunes it as an
// extraneous package). Re-run deploy/README.md step "casino bot" afterwards.
//
// Artifacts are resolved by SEARCH, not by a hardcoded name->path map. The old
// shim carried a map and every new contract silently threw "no artifact
// mapping" until someone remembered to edit it; v15 added eight modules at
// once. Searching costs one directory walk at boot and cannot go stale.
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..", "..");

// dotenv-lite: KEY=VALUE lines, no expansion. A value already in process.env
// wins, so `FOO=1 pm2 restart` still overrides the file.
const envPath = path.join(ROOT, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
    }
  }
}

const realEthers = require(path.join(ROOT, "node_modules", "ethers"));
const E = realEthers.ethers ?? realEthers;

const RPC = process.env.RPC_TESTNET || "https://api.infra.testnet.somnia.network";
if (!process.env.PRIVATE_KEY) throw new Error("[hardhat-shim] PRIVATE_KEY not set");

const provider = new E.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
const wallet = new E.Wallet(process.env.PRIVATE_KEY, provider);

// name -> absolute path of artifacts/**/<Name>.sol/<Name>.json
const INDEX = new Map();
(function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile() && e.name.endsWith(".json") && !e.name.endsWith(".dbg.json")) {
      const name = e.name.slice(0, -5);
      // First hit wins; artifacts/ has no duplicate contract names today, and a
      // shadowing build dir should not silently replace the real one.
      if (!INDEX.has(name)) INDEX.set(name, p);
    }
  }
})(path.join(ROOT, "artifacts", "contracts"));

function abiOf(name) {
  const p = INDEX.get(name);
  if (!p) {
    throw new Error(
      `[hardhat-shim] no artifact for "${name}" under artifacts/contracts ` +
      `(indexed ${INDEX.size}). Upload the compiled artifact and restart.`
    );
  }
  return JSON.parse(fs.readFileSync(p, "utf8")).abi;
}

const ethers = Object.create(E);
ethers.provider = provider;
ethers.getSigners = async () => [wallet];
ethers.getContractFactory = async (name) => ({
  attach: (addr) => new E.Contract(addr, abiOf(name), wallet),
});
ethers.getContractAt = async (name, addr, signer) =>
  new E.Contract(addr, abiOf(name), signer || wallet);

module.exports = { ethers, network: { name: process.env.NETWORK_NAME || "somniaTestnet" } };
