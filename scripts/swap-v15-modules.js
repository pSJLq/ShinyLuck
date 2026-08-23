#!/usr/bin/env node
/**
 * Replace v15 game modules in place — the thing the modular architecture was
 * built to make routine: deploy the new contract, point the registry at it,
 * done. The Vault is not redeployed and the bankroll never moves.
 *
 * Plain ethers on purpose (no hardhat): this runs on the VPS, where the owner
 * key lives and hardhat is only a shim. It reads compiled artifacts straight
 * off disk.
 *
 * Env:
 *   V15_OWNER_KEY   vault owner (also deploys the new modules)
 *   RPC_URL         defaults to the Somnia public endpoint
 *   MODULES         comma-separated subset; default: all module-entry games
 *   DRY=1           print the plan and exit
 *
 * What it preserves (a fresh module starts at contract defaults, which are NOT
 * what production runs):
 *   - slots: payBoostX100 is re-applied from the OLD module, or RTP silently
 *     moves by several points;
 *   - crash/roulette: betWindow;
 *   - mines: ownership goes to the mines cashier, since commitRoot/resolveCell
 *     are owner-gated and that wallet drives the game loop.
 */
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const ROOT = process.env.ROOT || path.join(__dirname, "..");
const MANIFEST = path.join(ROOT, "deployments", "somniaTestnet-v15.json");
const ART = (name, sub = "games") =>
  path.join(ROOT, "artifacts", "contracts", "v15", sub, `${name}.sol`, `${name}.json`);

const RPC = process.env.RPC_URL || "https://api.infra.testnet.somnia.network";
const DRY = process.env.DRY === "1";

// gameId + artifact + what has to be carried over from the outgoing module.
const PLAN = {
  // Single-shot games enter through vault.placeBet, so they need no carried
  // state — the Vault holds it all.
  dice:     { id: 0, artifact: "DiceModule",     ctor: ["vault"],            carry: null },
  plinko:   { id: 4, artifact: "PlinkoModule",   ctor: ["vault"],            carry: null },
  vault7:   { id: 2, artifact: "Vault7Module",   ctor: ["vault", "loyalty"], carry: "payBoost" },
  cluster:  { id: 6, artifact: "ClusterModule",  ctor: ["vault", "loyalty"], carry: "payBoost" },
  mines:    { id: 3, artifact: "MinesModule",    ctor: ["vault"],            carry: "ownerToCashier" },
  crash:    { id: 1, artifact: "CrashModule",    ctor: ["vault"],            carry: "betWindow" },
  roulette: { id: 5, artifact: "RouletteModule", ctor: ["vault"],            carry: "betWindow" },
};

const VAULT_ABI = [
  "function owner() view returns (address)",
  "function registerGame(uint16 id, address module, uint256 budget) external",
  "function gameModule(uint16) view returns (address)",
  "function gameBudget(uint16) view returns (uint256)",
  "function gameActive(uint16) view returns (bool)",
  "function moduleGameIdPlus1(address) view returns (uint16)",
];
const LOYALTY_ABI = [
  "function owner() view returns (address)",
  "function setModule(address module, bool allowed) external",
];
const SLOT_ABI = [
  "function payBoostX100() view returns (uint256)",
  "function setPayBoost(uint256 boostX100) external",
  "function totalSpins() view returns (uint256)",
];
const ROUND_ABI = [
  "function betWindow() view returns (uint256)",
  "function setBetWindow(uint256 secs) external",
  "function hasOpenRound() view returns (bool)",
];
const OWNABLE_ABI = ["function transferOwnership(address) external", "function owner() view returns (address)"];

(async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const provider = new ethers.JsonRpcProvider(RPC, { chainId: Number(manifest.chainId), name: "somniaTestnet" });
  const owner = new ethers.Wallet(process.env.V15_OWNER_KEY, provider);

  const vault = new ethers.Contract(manifest.addresses.vault, VAULT_ABI, owner);
  const onChainOwner = await vault.owner();
  if (onChainOwner.toLowerCase() !== owner.address.toLowerCase()) {
    throw new Error(`V15_OWNER_KEY (${owner.address}) is not the vault owner (${onChainOwner})`);
  }

  const DEFAULT_MODULES = ["vault7", "cluster", "mines", "crash", "roulette"];
  const names = (process.env.MODULES || DEFAULT_MODULES.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  console.log(`vault ${manifest.addresses.vault}  owner ${owner.address}`);
  console.log(`balance ${ethers.formatEther(await provider.getBalance(owner.address))} STT`);
  console.log(`swapping: ${names.join(", ")}${DRY ? "  (DRY RUN)" : ""}\n`);

  // ── refuse to swap anything mid-game ────────────────────────────────────
  for (const name of names) {
    const g = manifest.games.find((x) => x.name === name);
    if (!g) throw new Error(`not in manifest: ${name}`);
    if (PLAN[name].carry === "betWindow") {
      const open = await new ethers.Contract(g.module, ROUND_ABI, provider).hasOpenRound();
      if (open) throw new Error(`${name} has an OPEN round — settle it before swapping`);
    }
  }

  const results = [];
  for (const name of names) {
    const spec = PLAN[name];
    const g = manifest.games.find((x) => x.name === name);
    const oldAddr = g.module;
    const art = JSON.parse(fs.readFileSync(ART(spec.artifact), "utf8"));

    const args = spec.ctor.map((k) => manifest.addresses[k]);
    console.log(`[${name}] old ${oldAddr}`);
    if (DRY) { console.log(`  would deploy ${spec.artifact}(${args.join(", ")})\n`); continue; }

    const factory = new ethers.ContractFactory(art.abi, art.bytecode, owner);
    const c = await factory.deploy(...args);
    await c.waitForDeployment();
    const addr = await c.getAddress();
    console.log(`  deployed -> ${addr}`);

    // Carry state the contract defaults would otherwise silently change.
    if (spec.carry === "payBoost") {
      const boost = await new ethers.Contract(oldAddr, SLOT_ABI, provider).payBoostX100();
      await (await new ethers.Contract(addr, SLOT_ABI, owner).setPayBoost(boost)).wait();
      console.log(`  payBoostX100 -> ${boost} (carried; contract default would have changed RTP)`);
    }
    if (spec.carry === "betWindow") {
      const w = await new ethers.Contract(oldAddr, ROUND_ABI, provider).betWindow();
      const cur = await new ethers.Contract(addr, ROUND_ABI, provider).betWindow();
      if (w !== cur) {
        await (await new ethers.Contract(addr, ROUND_ABI, owner).setBetWindow(w)).wait();
        console.log(`  betWindow -> ${w}s (carried)`);
      } else {
        console.log(`  betWindow ${w}s (already the default)`);
      }
    }

    // Slots must be authorised on the shared loyalty contract, and the old one
    // de-authorised so a stale contract cannot still burn free spins.
    if (spec.ctor.includes("loyalty")) {
      const loy = new ethers.Contract(manifest.addresses.loyalty, LOYALTY_ABI, owner);
      await (await loy.setModule(addr, true)).wait();
      await (await loy.setModule(oldAddr, false)).wait();
      console.log(`  loyalty: authorised new, revoked old`);
    }

    // Point the registry at the new module. This also revokes the old one's
    // access to the Vault's money primitives.
    const budget = await vault.gameBudget(spec.id);
    await (await vault.registerGame(spec.id, addr, budget)).wait();
    console.log(`  registered as game ${spec.id} (budget ${ethers.formatEther(budget)} STT)`);

    // Mines is driven by an owner-gated coordinator loop, so its cashier owns it.
    if (spec.carry === "ownerToCashier") {
      await (await new ethers.Contract(addr, OWNABLE_ABI, owner).transferOwnership(g.cashier)).wait();
      console.log(`  ownership -> mines cashier ${g.cashier}`);
    }

    results.push({ name, id: spec.id, old: oldAddr, next: addr });
    console.log("");
  }

  if (DRY) return;

  // ── verify the registry really points at the new contracts ──────────────
  console.log("verification:");
  for (const r of results) {
    const live = await vault.gameModule(r.id);
    const oldStillModule = (await vault.moduleGameIdPlus1(r.old)) !== 0n;
    console.log(
      `  ${r.name.padEnd(9)} registry=${live === r.next ? "NEW ok" : "MISMATCH " + live}` +
      `  oldRevoked=${!oldStillModule}  active=${await vault.gameActive(r.id)}`,
    );
  }

  // ── write the manifest + the frontend config ────────────────────────────
  for (const r of results) {
    manifest.games.find((g) => g.name === r.name).module = r.next;
  }
  manifest.moduleSwaps = manifest.moduleSwaps || [];
  manifest.moduleSwaps.push({ at: process.env.SWAP_STAMP || null, swapped: results });
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\nmanifest updated: ${MANIFEST}`);
  console.log(JSON.stringify(results.map((r) => ({ [r.name]: r.next })), null, 2));
})().catch((e) => { console.error("FAILED:", e.shortMessage || e.message); process.exit(1); });
