// Deploy AvatarStore (fully on-chain player avatars) to Somnia testnet.
// USES THE DEPLOYER KEY — pm2 poker MUST be stopped while this runs.
// Also tops up load-1 for a live write-path test and updates the local
// manifest + poker-config.js.
//   node scripts/_deploy-avatar-store.js
require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const RPC = process.env.RPC_TESTNET || "https://api.infra.testnet.somnia.network";

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  provider.pollingInterval = 500;
  const dep = new ethers.Wallet(process.env.POKER_DEPLOYER_KEY, provider);
  const gasPrice = (await provider.getFeeData()).gasPrice;
  console.log(`[avatar] deployer ${dep.address} bal ${ethers.formatEther(await provider.getBalance(dep.address))} STT`);

  const art = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", "poker", "AvatarStore.sol", "AvatarStore.json"), "utf8"));
  const factory = new ethers.ContractFactory(art.abi, art.bytecode, dep);
  const c = await factory.deploy({ gasPrice, type: 0, gasLimit: 2500000 });
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log(`[avatar] AvatarStore deployed at ${addr}`);

  // test budget for the write-path check (load-1 script wallet)
  const master = process.env.POKER_SEED_MASTER_KEY;
  const load1 = new ethers.Wallet(ethers.keccak256(ethers.solidityPacked(["bytes32", "string"], [master, "load-1"])), provider);
  await (await dep.sendTransaction({ to: load1.address, value: ethers.parseEther("0.08"), gasPrice, type: 0, gasLimit: 21000 })).wait();
  console.log(`[avatar] load-1 topped up for the write test`);

  // manifest
  const mf = path.join(__dirname, "..", "deployments", "poker-somniaTestnet.json");
  const m = JSON.parse(fs.readFileSync(mf, "utf8"));
  m.addresses.avatarStore = addr;
  m.avatarStoreDeployedAt = new Date().toISOString();
  fs.writeFileSync(mf, JSON.stringify(m, null, 2) + "\n");

  // poker-config.js (LOCAL repo copy; the VPS copy is patched via sed remotely)
  const cf = path.join(__dirname, "..", "frontend", "poker", "poker-config.js");
  let cfg = fs.readFileSync(cf, "utf8");
  if (!cfg.includes("avatarStore")) {
    cfg = cfg.replace(/(playerProfile:\s*"[^"]*",[^\n]*\n)/, `$1  avatarStore: "${addr}", // on-chain uploaded avatars (AvatarStore.sol)\n`);
    fs.writeFileSync(cf, cfg);
  }
  console.log("[avatar] manifest + poker-config.js updated. RESTART pm2 poker now.");
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
