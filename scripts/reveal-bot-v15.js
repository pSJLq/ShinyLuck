// ShinyLuck Casino v15 settlement bot — per-game cashier lanes.
//
// Every game settles from its OWN wallet, so a stuck or reverting settle in one
// game can never block another game's nonce queue (see docs §3c). Each lane
// allocates nonces locally and broadcasts up to SETTLE_CONCURRENCY at a time.
//
// Game kinds and how each settles:
//   single-shot (dice, plinko) → vault.revealAndSettle(betId, seed)
//   slot        (vault7, cluster) → module.settleSpin(betId, seed)
//   multi-step  (mines)  → module.commitRoot(betId, root) on place,
//                          module.resolveCell(...) on each pick,
//                          module.finalize(betId, seed) once settled
//   round       (crash, roulette) → module.settleRound(roundId, seed) when the
//                          bet window closes; refundRound if it expired
//
// Env: SEED_MASTER_KEY (required), CASHIER_MASTER_KEY (per-game lanes; without
//      it every game shares the default signer), SETTLE_CONCURRENCY, POLL_MS.
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
const minesCoord = require("./lib/mines-coordinator");

const MC_CTX = {
  keccak256: ethers.keccak256,
  encode: (t, v) => ethers.AbiCoder.defaultAbiCoder().encode(t, v),
  concat: (a) => ethers.concat(a),
  solidityPacked: (t, v) => ethers.solidityPacked(t, v),
};

const REVEAL_DELAY = 1n;
const BLOCKHASH_WINDOW = 256n;

const deriveSeed = (master, idx) =>
  ethers.keccak256(ethers.solidityPacked(["bytes32", "uint256"], [master, BigInt(idx)]));
const deriveCashier = (master, name) =>
  ethers.keccak256(ethers.solidityPacked(["bytes32", "string"], [master, `cashier:${name}`]));

/// A single cashier wallet with its own nonce lane. Nonce handout is serialised
/// through a promise chain: without it, concurrent workers all read the same
/// pending count and collide ("nonce too low" / "replacement underpriced").
function makeLane(wallet, provider, label) {
  let nonce = null;
  let lock = Promise.resolve();
  const withLock = (fn) => { const r = lock.then(fn, fn); lock = r.then(() => {}, () => {}); return r; };
  const alloc = () => withLock(async () => {
    if (nonce == null) nonce = await provider.getTransactionCount(wallet.address, "pending");
    return nonce++;
  });
  // Resync must be able to move the counter DOWN: a broadcast that failed
  // outright never consumed its nonce, and a permanent gap wedges the lane.
  const resync = () => withLock(async () => {
    nonce = await provider.getTransactionCount(wallet.address, "pending");
  });
  return {
    label,
    address: wallet.address,
    wallet,
    async send(contract, method, args = [], extra = {}) {
      const n = await alloc();
      try {
        return await contract.connect(wallet)[method](...args, { nonce: n, ...extra });
      } catch (e) {
        await resync();
        throw e;
      }
    },
    resync,
  };
}

async function dispatchPool(jobs, limit) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (i < jobs.length) await jobs[i++]();
  });
  await Promise.all(workers);
}

async function createBot(opts = {}) {
  const net = opts.network || network.name;
  const provider = opts.provider || ethers.provider;
  const manifest = opts.manifest || JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", `${net}-v15.json`), "utf8")
  );
  const seedMaster = opts.seedMasterKey || process.env.SEED_MASTER_KEY;
  if (!seedMaster || !/^0x[0-9a-fA-F]{64}$/.test(seedMaster)) {
    throw new Error("SEED_MASTER_KEY must be a 32-byte 0x-prefixed hex string");
  }
  const cashierMaster = opts.cashierMasterKey || process.env.CASHIER_MASTER_KEY || null;
  const CONCURRENCY = parseInt(process.env.SETTLE_CONCURRENCY || "48", 10);
  const log = opts.log || ((...a) => console.log("[v15-bot]", ...a));

  const vault = await ethers.getContractAt("CasinoVault", manifest.addresses.vault);
  const [defaultSigner] = await ethers.getSigners();

  // One lane per game (falls back to the default signer if no cashier master).
  const lanes = {};
  const mods = {};
  for (const g of manifest.games) {
    const w = cashierMaster
      ? new ethers.Wallet(deriveCashier(cashierMaster, g.name), provider)
      : defaultSigner;
    lanes[g.name] = makeLane(w, provider, g.name);
    const cname = {
      dice: "DiceModule", crash: "CrashModule", vault7: "Vault7Module",
      mines: "MinesModule", plinko: "PlinkoModule", roulette: "RouletteModule",
      cluster: "ClusterModule",
    }[g.name];
    mods[g.name] = await ethers.getContractAt(cname, g.module);
  }
  log(`lanes: ${manifest.games.map((g) => `${g.name}=${lanes[g.name].address.slice(0, 10)}`).join(" ")}`);

  const seedFor = (idx) => deriveSeed(seedMaster, idx);
  const inflight = new Set();
  // Cursor + pending-set per game. Re-reading the last N ids every tick meant
  // hundreds of RPC calls per second once volume built up, which throttled the
  // node ("could not coalesce error") and pushed settle latency from 0.1s to
  // ~26s. Now each tick only looks at ids we have not yet seen, plus the few
  // still awaiting settlement.
  const cursor = new Map();    // key -> next id to discover
  const pending = new Map();   // key -> Set of ids still open
  const pend = (k) => { if (!pending.has(k)) pending.set(k, new Set()); return pending.get(k); };
  /// Ids to examine this tick: everything newly created since last time, plus
  /// whatever is still open.
  function due(key, total) {
    const from = cursor.get(key) ?? Math.max(0, total - 50);
    for (let id = from; id < total; id++) pend(key).add(id);
    cursor.set(key, total);
    return [...pend(key)];
  }
  const done = (key, id) => pend(key).delete(id);
  const minesGames = new Map(); // betId → {bitmap, tree}

  const isExpired = (commitBlock, head) => head > BigInt(commitBlock) + REVEAL_DELAY + BLOCKHASH_WINDOW;
  // The contract requires block.number > commitBlock + REVEAL_DELAY *at
  // execution*. Our tx lands at least one block after `head`, so it is safe to
  // broadcast as soon as the entropy block itself exists (head >= commit+DELAY).
  // Waiting for head to pass that would cost a whole extra block per spin.
  const isRevealable = (commitBlock, head) =>
    head >= BigInt(commitBlock) + REVEAL_DELAY && !isExpired(commitBlock, head);

  // ── single-shot games settle through the Vault ──────────────────────────
  async function tickSingleShot(g, head) {
    const total = Number(await vault.totalBets());
    const K = `bet:${g.id}`;
    const jobs = [];
    for (const id of due(K, total)) {
      const key = `${K}:${id}`;
      if (inflight.has(key)) continue;
      jobs.push(async () => {
        inflight.add(key);
        try {
          const bet = await vault.getBet(id);
          if (Number(bet.gameId) !== g.id) { done(K, id); return; }
          if (Number(bet.status) !== 0) { done(K, id); return; }
          if (isExpired(bet.commitBlock, head)) {
            await (await lanes[g.name].send(vault, "refundExpired", [id])).wait();
            done(K, id); return;
          }
          if (!isRevealable(bet.commitBlock, head)) return;
          const tx = await lanes[g.name].send(vault, "revealAndSettle", [id, seedFor(bet.seedIdx)]);
          await tx.wait();
          done(K, id);
          log(`${g.name} settled bet ${id}`);
        } catch (e) {
          const m = e.shortMessage || e.message;
          if (/AlreadySettled|BetNotFound/i.test(m)) done(K, id);
          else log(`${g.name} bet ${id}: ${m}`);
        } finally { inflight.delete(key); }
      });
    }
    if (jobs.length) await dispatchPool(jobs, CONCURRENCY);
  }

  // ── slots settle on their own module ────────────────────────────────────
  async function tickSlot(g, head) {
    const mod = mods[g.name];
    const total = Number(await mod.totalSpins());
    const K = `spin:${g.name}`;
    const jobs = [];
    for (const id of due(K, total)) {
      const key = `${K}:${id}`;
      if (inflight.has(key)) continue;
      jobs.push(async () => {
        inflight.add(key);
        try {
          const s = await mod.getSpin(id);
          if (Number(s.status) !== 0) { done(K, id); return; }
          if (isExpired(s.commitBlock, head)) {
            await (await lanes[g.name].send(mod, "refundExpired", [id])).wait();
            done(K, id); return;
          }
          if (!isRevealable(s.commitBlock, head)) return;
          const tx = await lanes[g.name].send(mod, "settleSpin", [id, seedFor(s.seedIdx)]);
          await tx.wait();
          done(K, id);
          log(`${g.name} settled spin ${id}`);
        } catch (e) {
          const m = e.shortMessage || e.message;
          if (/AlreadySettled|BetNotFound/i.test(m)) done(K, id);
          else log(`${g.name} spin ${id}: ${m}`);
        } finally { inflight.delete(key); }
      });
    }
    if (jobs.length) await dispatchPool(jobs, CONCURRENCY);
  }

  // ── mines: commit root → resolve each pick → finalize ───────────────────
  async function tickMines(g, head) {
    const mod = mods[g.name];
    const lane = lanes[g.name];
    const total = Number(await mod.totalGames());
    const K = "mines";
    for (const id of due(K, total)) {
      try {
        const game = await mod.getGame(id);
        // 1. Commit the layout root once the entropy block exists.
        if (game.layoutRoot === ethers.ZeroHash && Number(game.status) === 0) {
          if (isExpired(game.commitBlock, head)) {
            // The module refunds an expired game — but only INSIDE commitRoot,
            // which is owner-gated. Skipping here (what this used to do) left
            // the stake escrowed with nobody able to release it: `cancelPick`
            // needs a pending pick, and the player never got a board to click.
            // Any non-zero root reaches the refund branch; send the real one.
            const stale = ethers.keccak256(ethers.toUtf8Bytes(`expired:${id}`));
            await (await lane.send(mod, "commitRoot", [id, stale])).wait();
            log(`mines ${id} expired before the root — refunded the player`);
            continue;
          }
          if (!isRevealable(game.commitBlock, head)) continue;
          const entropyHash = (await provider.getBlock(Number(game.commitBlock) + Number(REVEAL_DELAY)))?.hash;
          const seed = seedFor(game.seedIdx);
          const { bitmap, tree } = minesCoord.layoutFor(MC_CTX, {
            betId: id, serverSeed: seed, clientSeed: game.clientSeed,
            entropyHash, nonce: game.nonce, mineCount: Number(game.mineCount),
          });
          minesGames.set(id, { bitmap, tree, seed });
          await (await lane.send(mod, "commitRoot", [id, tree.root])).wait();
          log(`mines committed root for ${id}`);
          continue;
        }
        // 2. Resolve a pending pick with its Merkle proof.
        if (Number(game.pendingCell) !== 0 && Number(game.status) === 0) {
          let g2 = minesGames.get(id);
          if (!g2) {
            // Recovery after a restart: rebuild the layout from chain state.
            const seed = seedFor(game.seedIdx);
            const { bitmap, tree } = minesCoord.layoutFor(MC_CTX, {
              betId: id, serverSeed: seed, clientSeed: game.clientSeed,
              entropyHash: game.entropyHash, nonce: game.nonce, mineCount: Number(game.mineCount),
            });
            if (tree.root !== game.layoutRoot) { log(`mines ${id}: root mismatch on recovery`); continue; }
            g2 = { bitmap, tree, seed };
            minesGames.set(id, g2);
          }
          const idx = Number(game.pendingCell) - 1;
          const cp = minesCoord.cellProof(MC_CTX, {
            betId: id, serverSeed: g2.seed, bitmap: g2.bitmap, tree: g2.tree, idx,
          });
          await (await lane.send(mod, "resolveCell", [id, cp.isMine, cp.salt, cp.proof])).wait();
          log(`mines resolved cell ${idx} for ${id} (mine=${cp.isMine})`);
          continue;
        }
        // 3. Publish the layout once the game is over (fraud tripwire).
        if (Number(game.status) !== 0 && !game.finalized && game.layoutRoot !== ethers.ZeroHash) {
          await (await lane.send(mod, "finalize", [id, seedFor(game.seedIdx)])).wait();
          log(`mines finalized ${id}`);
          minesGames.delete(id);
          done(K, id);
        }
      } catch (e) {
        const m = e.shortMessage || e.message;
        if (!/AlreadySettled|finalized|no pending/i.test(m)) log(`mines ${id}: ${m}`);
      }
    }
  }

  // ── round games: settle when the window closes, refund when expired ─────
  async function tickRound(g, head, nowSec) {
    const mod = mods[g.name];
    const lane = lanes[g.name];
    const total = Number(await mod.totalRounds());
    const K = `round:${g.name}`;
    for (const id of due(K, total)) {
      const key = `${K}:${id}`;
      if (inflight.has(key)) continue;
      inflight.add(key);
      try {
        const r = await mod.getRound(id);
        if (r.settled) { done(K, id); continue; }
        if (nowSec < Number(r.betWindowEnd)) continue; // still taking bets
        if (isExpired(r.commitBlock, head)) {
          await (await lane.send(mod, "refundRound", [id])).wait();
          done(K, id);
          log(`${g.name} refunded expired round ${id}`);
          continue;
        }
        if (!isRevealable(r.commitBlock, head)) continue;
        await (await lane.send(mod, "settleRound", [id, seedFor(r.seedIdx)])).wait();
        done(K, id);
        log(`${g.name} settled round ${id}`);
      } catch (e) {
        const m = e.shortMessage || e.message;
        if (/AlreadySettled/i.test(m)) done(K, id);
        else log(`${g.name} round ${id}: ${m}`);
      } finally { inflight.delete(key); }
    }
  }

  // ── keep the lanes fuelled ───────────────────────────────────────────────
  // Somnia meters these settles at ~3M gas, and ethers reserves
  // gasLimit x maxFeePerGas up front, so a lane burns ~0.036 STT per tx. A lane
  // that runs dry fails with a bare "insufficient balance" that ethers reports
  // as "could not coalesce error" — it looks like an RPC fault, but the bot
  // just cannot pay. That took settle latency from 0.15s to 22s in production.
  const REFUEL_BELOW = ethers.parseEther(process.env.CASHIER_MIN || "0.5");
  const REFUEL_TO    = ethers.parseEther(process.env.CASHIER_TOPUP || "2");
  const ownerKey = process.env.V15_OWNER_KEY || null;
  const ownerWallet = ownerKey ? new ethers.Wallet(ownerKey, provider) : null;
  async function refuelLanes() {
    if (!ownerWallet) return;
    for (const g of manifest.games) {
      const lane = lanes[g.name];
      try {
        const bal = await provider.getBalance(lane.address);
        if (bal >= REFUEL_BELOW) continue;
        const ownerBal = await provider.getBalance(ownerWallet.address);
        const need = REFUEL_TO - bal;
        if (ownerBal < need + ethers.parseEther("0.5")) {
          log(`refuel skipped for ${g.name} — owner low (${ethers.formatEther(ownerBal)} STT)`);
          return;
        }
        const tx = await ownerWallet.sendTransaction({ to: lane.address, value: need });
        await tx.wait();
        log(`refuelled ${g.name} +${ethers.formatEther(need)} STT`);
      } catch (e) { log(`refuel ${g.name}: ${e.shortMessage || e.message}`); }
    }
  }
  // ── keep the seed pool stocked ───────────────────────────────────────────
  // The pool is a fixed array provisioned at deploy time, and EVERY bet, spin
  // and round consumes one entry. When it empties, `placeBet`/`reserveSeed`
  // revert with NoSeedAvailable — that is not one game degrading, it is the
  // whole casino refusing bets, with nothing in the bot's log to explain it.
  // v14 had a top-up loop for exactly this reason; v15 shipped without one.
  //
  // Seeds are `keccak256(master, idx)`, so extending the pool is just hashing
  // the next indices and committing them — no state to migrate.
  const SEED_LOW   = parseInt(process.env.SEED_TOPUP_BELOW || "150", 10);
  const SEED_BATCH = parseInt(process.env.SEED_TOPUP_BATCH || "400", 10);
  let seedTopupBusy = false;
  async function topUpSeeds() {
    if (!ownerWallet || seedTopupBusy) return;
    seedTopupBusy = true;
    try {
      const [total, , available] = await vault.seedPoolStatus();
      if (Number(available) > SEED_LOW) return;
      const start = Number(total);
      const hashes = [];
      for (let i = start; i < start + SEED_BATCH; i++) {
        hashes.push(ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [seedFor(i)]),
        ));
      }
      // Chunked so a big batch never brushes the block gas limit.
      const v = vault.connect(ownerWallet);
      for (let i = 0; i < hashes.length; i += 200) {
        await (await v.provisionSeedHashes(hashes.slice(i, i + 200))).wait();
      }
      log(`seed pool topped up +${SEED_BATCH} (was ${available} left, now ${start + SEED_BATCH} total)`);
    } catch (e) {
      log(`seed top-up: ${e.shortMessage || e.message}`);
    } finally { seedTopupBusy = false; }
  }

  if (ownerWallet) {
    setTimeout(() => refuelLanes().catch(() => {}), 3_000);
    setInterval(() => refuelLanes().catch(() => {}), 60_000);
    setTimeout(() => topUpSeeds().catch(() => {}), 5_000);
    setInterval(() => topUpSeeds().catch(() => {}), 60_000);
    log(`auto-refuel on (below ${ethers.formatEther(REFUEL_BELOW)} -> ${ethers.formatEther(REFUEL_TO)} STT)`);
    log(`seed auto-top-up on (below ${SEED_LOW} -> +${SEED_BATCH})`);
  } else {
    log("auto-refuel + seed top-up OFF (set V15_OWNER_KEY) — lanes and seeds must be managed manually");
  }

  /// One pass over every game. Games are independent — a failure in one is
  /// caught here and never blocks the others.
  async function tick() {
    const blk = await provider.getBlock("latest");
    const head = BigInt(blk.number);
    const nowSec = Number(blk.timestamp);
    await Promise.all(manifest.games.map(async (g) => {
      try {
        if (g.kind === "single-shot") await tickSingleShot(g, head);
        else if (g.kind === "slot")   await tickSlot(g, head);
        else if (g.kind === "multi-step") await tickMines(g, head);
        else if (g.kind === "round")  await tickRound(g, head, nowSec);
      } catch (e) {
        log(`${g.name} tick: ${e.shortMessage || e.message}`);
      }
    }));
  }

  return { tick, lanes, mods, vault, manifest, seedFor };
}

async function main() {
  // v15 MUST use its own seed master: seeds are keccak(master, idx), so sharing
  // v14's master would mean a seed revealed by a v14 settle also predicts the
  // v15 bet sitting at the same index. The *_V15 vars keep the two separate
  // even though both bots read the same .env.
  const bot = await createBot({
    seedMasterKey: process.env.SEED_MASTER_KEY_V15 || process.env.SEED_MASTER_KEY,
    cashierMasterKey: process.env.CASHIER_MASTER_KEY_V15 || process.env.CASHIER_MASTER_KEY || null,
  });
  const POLL_MS = parseInt(process.env.POLL_MS || "400", 10);
  console.log(`[v15-bot] running (poll=${POLL_MS}ms, concurrency=${process.env.SETTLE_CONCURRENCY || 48})`);
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try { await bot.tick(); } catch (e) { console.warn("[v15-bot] tick:", e.message); }
    finally { running = false; }
  }, POLL_MS);
}

module.exports = { createBot, deriveSeed, deriveCashier, makeLane };

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
