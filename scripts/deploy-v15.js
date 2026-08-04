// ShinyLuck Casino v15 deployer — modular vault + per-game modules.
//
// Deploys the permanent CasinoVault, every game module, registers each game
// with its own budget, and derives a PER-GAME CASHIER wallet map so each game
// settles on its own nonce lane (one game stalling can never stall another).
//
// Env:
//   INITIAL_BANKROLL_ETH   bankroll to fund (default 1)
//   SEED_BATCH_SIZE        commit-reveal seeds to provision (default 400)
//   SEED_MASTER_KEY        32-byte hex; seeds derived deterministically so the
//                          bot can settle without shipping a seeds file
//   CASHIER_MASTER_KEY     32-byte hex; per-game cashiers derived from it
//   TIMELOCK_DELAY         seconds; if >0 deploy CasinoTimelock and hand the
//                          Vault to it (MAINNET: set this, e.g. 172800 = 48h)
//   TIMELOCK_PROPOSER      multisig address that may propose (required if
//                          TIMELOCK_DELAY > 0)
//   GAME_BUDGET_ETH        default per-game budget (default = bankroll)
//
// Run: npx hardhat run scripts/deploy-v15.js --network somniaTestnet
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const INITIAL_BANKROLL_ETH = process.env.INITIAL_BANKROLL_ETH || "1";
const SEED_BATCH_SIZE = parseInt(process.env.SEED_BATCH_SIZE || "400", 10);
const TIMELOCK_DELAY = parseInt(process.env.TIMELOCK_DELAY || "0", 10);

// gameId → { name, contract, kind }. `kind` tells the bot how to settle it.
const GAMES = [
  { id: 0, name: "dice",     contract: "DiceModule",     kind: "single-shot" },
  { id: 1, name: "crash",    contract: "CrashModule",    kind: "round"       },
  { id: 2, name: "vault7",   contract: "Vault7Module",   kind: "slot"        },
  { id: 3, name: "mines",    contract: "MinesModule",    kind: "multi-step"  },
  { id: 4, name: "plinko",   contract: "PlinkoModule",   kind: "single-shot" },
  { id: 5, name: "roulette", contract: "RouletteModule", kind: "round"       },
  { id: 6, name: "cluster",  contract: "ClusterModule",  kind: "slot"        },
];

function deriveFrom(master, label) {
  return ethers.keccak256(ethers.solidityPacked(["bytes32", "string"], [master, label]));
}

async function main() {
  const net = network.name;
  const [deployer] = await ethers.getSigners();
  console.log(`[v15] network=${net} deployer=${deployer.address}`);
  console.log(`[v15] balance=${ethers.formatEther(await ethers.provider.getBalance(deployer.address))}`);

  // ── 1. Per-game cashiers ────────────────────────────────────────────────
  // Each game settles from its OWN wallet = its own nonce lane. A stuck or
  // reverting settle in one game cannot block any other game's queue. Measured
  // ceiling per wallet is ~81 tx/s, so one lane per game is ample headroom.
  const cashierMaster = process.env.CASHIER_MASTER_KEY || null;
  if (cashierMaster && !/^0x[0-9a-fA-F]{64}$/.test(cashierMaster)) {
    throw new Error("CASHIER_MASTER_KEY must be a 32-byte 0x-prefixed hex string");
  }
  const cashiers = {};
  if (cashierMaster) {
    for (const g of GAMES) {
      const pk = deriveFrom(cashierMaster, `cashier:${g.name}`);
      cashiers[g.name] = new ethers.Wallet(pk).address;
    }
    console.log("[v15] per-game cashiers (fund each with gas):");
    for (const [n, a] of Object.entries(cashiers)) console.log(`         ${n.padEnd(9)} ${a}`);
  } else {
    console.log("[v15] CASHIER_MASTER_KEY not set — bot will fall back to a single signer");
  }

  // ── 2. Vault ────────────────────────────────────────────────────────────
  const Vault = await ethers.getContractFactory("CasinoVault");
  const vault = await Vault.deploy();
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  const deploymentBlock = (await ethers.provider.getTransactionReceipt(
    vault.deploymentTransaction().hash
  )).blockNumber;
  console.log(`[v15] CasinoVault → ${vaultAddr} (block ${deploymentBlock})`);

  // ── 3. Shared slot loyalty ──────────────────────────────────────────────
  const loyalty = await (await ethers.getContractFactory("SlotLoyalty")).deploy();
  await loyalty.waitForDeployment();
  const loyaltyAddr = await loyalty.getAddress();
  console.log(`[v15] SlotLoyalty → ${loyaltyAddr}`);

  // ── 4. Game modules ─────────────────────────────────────────────────────
  const bankroll = ethers.parseEther(INITIAL_BANKROLL_ETH);
  const defaultBudget = process.env.GAME_BUDGET_ETH
    ? ethers.parseEther(process.env.GAME_BUDGET_ETH)
    : bankroll;

  const modules = {};
  for (const g of GAMES) {
    const F = await ethers.getContractFactory(g.contract);
    const args = g.kind === "slot" ? [vaultAddr, loyaltyAddr] : [vaultAddr];
    const m = await F.deploy(...args);
    await m.waitForDeployment();
    modules[g.name] = await m.getAddress();
    console.log(`[v15] ${g.contract} (id ${g.id}) → ${modules[g.name]}`);
  }

  // ── 5. Register games + authorize slot modules ──────────────────────────
  for (const g of GAMES) {
    const tx = await vault.registerGame(g.id, modules[g.name], defaultBudget);
    await tx.wait();
    console.log(`[v15] registered ${g.name} budget=${ethers.formatEther(defaultBudget)}`);
  }
  for (const g of GAMES.filter((x) => x.kind === "slot")) {
    await (await loyalty.setModule(modules[g.name], true)).wait();
    console.log(`[v15] loyalty authorized ${g.name}`);
  }

  // ── 6. Mines coordinator = its own cashier ──────────────────────────────
  // commitRoot/resolveCell are owner-gated on the module; the wallet that runs
  // that game's settle loop must own it.
  if (cashiers.mines) {
    const mines = await ethers.getContractAt("MinesModule", modules.mines);
    await (await mines.transferOwnership(cashiers.mines)).wait();
    console.log(`[v15] MinesModule owner → mines cashier ${cashiers.mines}`);
  }

  // ── 7. Fund bankroll ────────────────────────────────────────────────────
  if (Number(INITIAL_BANKROLL_ETH) > 0) {
    await (await vault.depositBankroll({ value: bankroll })).wait();
    console.log(`[v15] bankroll funded: ${INITIAL_BANKROLL_ETH}`);
  }

  // ── 8. Provision commit-reveal seeds ────────────────────────────────────
  const seedMaster = process.env.SEED_MASTER_KEY || null;
  if (seedMaster && !/^0x[0-9a-fA-F]{64}$/.test(seedMaster)) {
    throw new Error("SEED_MASTER_KEY must be a 32-byte 0x-prefixed hex string");
  }
  const seeds = [], hashes = [];
  for (let i = 0; i < SEED_BATCH_SIZE; i++) {
    const s = seedMaster
      ? ethers.keccak256(ethers.solidityPacked(["bytes32", "uint256"], [seedMaster, BigInt(i)]))
      : ethers.hexlify(ethers.randomBytes(32));
    seeds.push(s);
    hashes.push(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [s])));
  }
  // Chunk so a big batch never blows the block gas limit.
  for (let i = 0; i < hashes.length; i += 200) {
    await (await vault.provisionSeedHashes(hashes.slice(i, i + 200))).wait();
  }
  console.log(`[v15] provisioned ${SEED_BATCH_SIZE} seed hashes${seedMaster ? " (deterministic)" : " (random — keep the seeds file!)"}`);

  // ── 9. Timelock (mainnet posture) ───────────────────────────────────────
  let timelockAddr = null;
  if (TIMELOCK_DELAY > 0) {
    const proposer = process.env.TIMELOCK_PROPOSER;
    if (!proposer) throw new Error("TIMELOCK_PROPOSER required when TIMELOCK_DELAY > 0");
    const tl = await (await ethers.getContractFactory("CasinoTimelock")).deploy(
      TIMELOCK_DELAY, [proposer], [ethers.ZeroAddress], ethers.ZeroAddress
    );
    await tl.waitForDeployment();
    timelockAddr = await tl.getAddress();
    await (await vault.transferOwnership(timelockAddr)).wait();
    console.log(`[v15] CasinoTimelock → ${timelockAddr} (delay ${TIMELOCK_DELAY}s), Vault ownership transferred`);
  } else {
    console.log("[v15] no timelock (TIMELOCK_DELAY=0) — acceptable on testnet, REQUIRED on mainnet");
  }

  // ── 10. Manifest ────────────────────────────────────────────────────────
  const out = {
    version: "v15",
    network: net,
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    deployer: deployer.address,
    deploymentBlock,
    addresses: { vault: vaultAddr, loyalty: loyaltyAddr, timelock: timelockAddr },
    games: GAMES.map((g) => ({
      id: g.id, name: g.name, kind: g.kind,
      module: modules[g.name],
      cashier: cashiers[g.name] || null,
      budget: defaultBudget.toString(),
    })),
    seedBatch: { size: SEED_BATCH_SIZE, firstHashIdx: 0, deterministic: Boolean(seedMaster) },
    deployedAt: new Date().toISOString(),
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${net}-v15.json`);
  fs.writeFileSync(p, JSON.stringify(out, null, 2));
  console.log("[v15] manifest →", p);

  const feDir = path.join(__dirname, "..", "frontend", "deployments");
  if (fs.existsSync(feDir)) {
    fs.copyFileSync(p, path.join(feDir, `${net}-v15.json`));
    console.log("[v15] manifest (frontend copy) written");
  }

  // Frontend config module: the SDK reads addresses from here, so a game added
  // later only needs this file regenerated — no SDK edit.
  const cfg = `// Auto-written by scripts/deploy-v15.js — do not edit by hand.
export const CONFIG_V15 = ${JSON.stringify({
    network: net,
    chainId: out.chainId,
    addresses: out.addresses,
    games: out.games.map(({ id, name, kind, module }) => ({ id, name, kind, module })),
    deploymentBlock,
  }, null, 2)};
// partials.js is a classic script and cannot import this module, but it needs
// the Vault address for the footer's Contracts column. Publish it so the shell
// uses the deployed value instead of its hard-coded fallback.
if (typeof window !== "undefined") window.SL_V15 = CONFIG_V15;
export default CONFIG_V15;
`;
  fs.writeFileSync(path.join(__dirname, "..", "frontend", "lib", "config-v15.js"), cfg);
  console.log("[v15] frontend/lib/config-v15.js written");

  if (!seedMaster) {
    const sdir = path.join(dir, "seeds");
    fs.mkdirSync(sdir, { recursive: true });
    const sp = path.join(sdir, `${net}-v15-${Date.now()}.json`);
    fs.writeFileSync(sp, JSON.stringify({ seeds, hashes }, null, 2));
    console.log("[v15] seeds preimages →", sp, "(KEEP SECRET)");
  }

  console.log("\n[v15] done. Next: fund each per-game cashier with gas, point the bot at the manifest.");
}

main().catch((e) => { console.error(e); process.exit(1); });
