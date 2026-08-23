// Swap the LIVE card layer (ZkTableDealer) for a freshly deployed one.
//
// Why a swap and not a redeploy of the room: PokerRoom holds the money — every
// player's cashier balance lives there — so it must keep its address. The card
// layer holds no funds, and the room points at it through `setDealer`, so it is
// replaceable with one owner tx. Nothing migrates: finished deals stay readable
// in the old contract, and new hands are prepared in the new one.
//
// PRE-FLIGHT: no hand may be in flight. A deal is bound to the dealer that
// prepared it, so switching mid-hand would leave the room asking the new
// contract about a deal it has never seen. The script refuses unless every
// table is idle.
//
//   node scripts/_swap-zk-dealer.js            # dry run: reports, changes nothing
//   APPLY=1 node scripts/_swap-zk-dealer.js    # deploy + rewire + write configs
//
// Env: POKER_DEPLOYER_KEY (owner of room and dealer), POKER_SEED_MASTER_KEY
// (only to DERIVE the worker addresses — never printed).
require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const APPLY = process.env.APPLY === "1";
const RPC = process.env.RPC_URL || "https://api.infra.testnet.somnia.network";
const ZK_WORKERS = Math.max(1, parseInt(process.env.ZK_WORKERS || "3", 10));
const root = path.join(__dirname, "..");
const manPath = path.join(root, "deployments", "poker-somniaTestnet.json");
const cfgPath = path.join(root, "frontend", "poker", "poker-config.js");

const art = (f) => JSON.parse(fs.readFileSync(path.join(root, "artifacts", "contracts", "poker", f), "utf8"));

(async () => {
  const man = JSON.parse(fs.readFileSync(manPath, "utf8"));
  const provider = new ethers.JsonRpcProvider(RPC);
  const key = process.env.POKER_DEPLOYER_KEY;
  if (!key) throw new Error("POKER_DEPLOYER_KEY missing");
  const owner = new ethers.Wallet(key, provider);

  const roomAbi = art("PokerRoom.sol/PokerRoom.json").abi;
  const zkArt = art("ZkTableDealer.sol/ZkTableDealer.json");
  const room = new ethers.Contract(man.addresses.pokerRoom, roomAbi, owner);
  const oldZk = new ethers.Contract(man.addresses.zkTableDealer, zkArt.abi, provider);

  console.log("room          ", man.addresses.pokerRoom);
  console.log("dealer (old)  ", man.addresses.zkTableDealer);
  console.log("owner         ", owner.address, ethers.formatEther(await provider.getBalance(owner.address)), "STT");

  const onChainOwner = await room.owner();
  if (onChainOwner.toLowerCase() !== owner.address.toLowerCase()) {
    throw new Error(`signer is not the room owner (${onChainOwner})`);
  }

  // ---- pre-flight: every table idle -------------------------------------
  const nTables = Number(await room.tableCount());
  const busy = [];
  for (let t = 0; t < nTables; t++) {
    const h = await room.getHand(t);
    if (h.inProgress) busy.push(t);
  }
  console.log(`tables        ${nTables} · in-hand now: ${busy.length ? busy.join(",") : "none"}`);
  if (busy.length) throw new Error("hands in flight — a bound deal cannot survive the swap; retry when idle");

  // ---- worker addresses (derived, never the keys) ------------------------
  const MASTER = process.env.POKER_SEED_MASTER_KEY || process.env.SEED_MASTER_KEY;
  if (!MASTER) throw new Error("POKER_SEED_MASTER_KEY missing — worker keys cannot be derived");
  const workers = [];
  for (let i = 0; i < ZK_WORKERS; i++) {
    workers.push(new ethers.Wallet(
      ethers.keccak256(ethers.solidityPacked(["bytes32", "string"], [MASTER, `zk-worker-${i}`])),
    ).address);
  }
  console.log("workers       ", workers.join(", "));
  for (const w of workers) {
    if (!(await oldZk.isCoordinator(w))) console.log(`  ! ${w} is NOT a coordinator on the old dealer — check ZK_WORKERS`);
  }

  if (!APPLY) {
    console.log("\nDRY RUN — nothing sent. Re-run with APPLY=1 to deploy and rewire.");
    return;
  }

  // ---- deploy + rewire ---------------------------------------------------
  console.log("\ndeploying ZkTableDealer…");
  const factory = new ethers.ContractFactory(zkArt.abi, zkArt.bytecode, owner);
  const zk = await factory.deploy(man.addresses.pokerRoom, workers[0]);
  await zk.waitForDeployment();
  const addr = await zk.getAddress();
  console.log("dealer (new)  ", addr);

  for (const w of workers.slice(1)) {
    await (await zk.setCoordinator(w, true)).wait();
    console.log("  coordinator +", w);
  }
  await (await room.setDealer(addr)).wait();
  console.log("room.setDealer→", addr);

  // ---- verify on chain ---------------------------------------------------
  const live = new ethers.Contract(addr, zkArt.abi, provider);
  const checks = {
    "room points at the new dealer": (await room.dealer()).toLowerCase() === addr.toLowerCase(),
    "new dealer points at the room": (await live.room()).toLowerCase() === man.addresses.pokerRoom.toLowerCase(),
    "owner retained": (await live.owner()).toLowerCase() === owner.address.toLowerCase(),
  };
  for (const w of workers) checks[`worker ${w.slice(0, 10)} can coordinate`] = await live.isCoordinator(w);
  let ok = true;
  for (const [k, v] of Object.entries(checks)) { console.log(v ? "  ok  " : "  FAIL", k); if (!v) ok = false; }
  if (!ok) throw new Error("post-swap verification failed — room still settles through the OLD dealer address above");

  // ---- write configs -----------------------------------------------------
  man.addresses.zkTableDealerPrevious = man.addresses.zkTableDealer;
  man.addresses.zkTableDealer = addr;
  fs.writeFileSync(manPath, JSON.stringify(man, null, 2) + "\n");
  const cfg = fs.readFileSync(cfgPath, "utf8");
  const next = cfg.replace(/(zkTableDealer:\s*")0x[0-9a-fA-F]{40}(")/, `$1${addr}$2`);
  if (next === cfg) throw new Error("poker-config.js: zkTableDealer line not found — update it by hand");
  fs.writeFileSync(cfgPath, next);
  console.log("\nwrote deployments/poker-somniaTestnet.json + frontend/poker/poker-config.js");
  console.log("NEXT: ship poker-config.js, the manifest and scripts/lib/poker-zk-dealer.js, then restart pm2 `poker`.");
  console.log(`ROLLBACK: room.setDealer("${man.addresses.zkTableDealerPrevious}") and revert the two files.`);
})();
