// Casino load simulation: N concurrent players spinning VAULT.7 / SUGAR.LAB
// and rolling dice, exactly the way a browser does it — place the bet tx, then
// wait for the house reveal bot to settle it.
//
// What it measures (the things that actually break):
//   • spin→result latency (place tx mined → BetSettled), p50/p90/max
//   • backlog: bets placed but not yet settled, sampled over time
//   • EXPIRIES: bets that crossed the 256-block blockhash window unsettled and
//     had to be refunded with no result — the failure a player sees as
//     "ставка отменена", and the thing the settle bot's throughput decides
//   • realised settle throughput of the bot (settles/sec)
//
// Run against the local rig (see scripts/_casino-sim-run.md) or any RPC:
//   SIM_RPC=http://127.0.0.1:8546 PLAYERS=50 MINUTES=3 node scripts/_casino-load-test.js
//
// Player wallets come from the hardhat dev mnemonic by default (local rig).
// Against a real network set PLAYER_MASTER_KEY to derive funded wallets.
try { require("dotenv").config(); } catch (_) { /* env passed inline is fine */ }
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const RPC = process.env.SIM_RPC || "http://127.0.0.1:8546";
const PLAYERS = parseInt(process.env.PLAYERS || "50", 10);
const MINUTES = parseFloat(process.env.MINUTES || "3");
const STAKE = process.env.STAKE || "0.01";
// Time a player spends looking at the result before spinning again. Slot reels
// animate ~2.5-4s; a fast player clicks again right after. 4s mean is a
// realistic-to-slightly-aggressive casino cadence.
const THINK_MS = parseInt(process.env.THINK_MS || "4000", 10);
const MANIFEST = process.env.SIM_MANIFEST || "localhost";
// mix of games the swarm plays: v=vault7 slots, s=sugar cluster, d=dice
const MIX = (process.env.MIX || "v,s,d").split(",").map((x) => x.trim());

const E = (n) => ethers.parseEther(String(n));
const F = (w) => Number(ethers.formatEther(w));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };

const ABI = [
  "function placeDiceBet(uint8 target, bool over, bytes32 clientSeed) payable returns (uint256)",
  "function placeSlotsBet(bytes32 clientSeed, bool useFreeSpin) payable returns (uint256)",
  "function placeClusterBet(bytes32 clientSeed, bool useFreeSpin) payable returns (uint256)",
  "function freeBankroll() view returns (uint256)",
  "function seedPoolStatus() view returns (uint256 total, uint256 consumed, uint256 available)",
  "event BetPlaced(uint256 indexed betId, address indexed player, uint8 indexed game, uint256 amount, bytes32 clientSeed, uint256 commitBlock, uint256 seedIdx, bytes params)",
  "event BetSettled(uint256 indexed betId, address indexed player, uint8 indexed game, bool won, uint256 payout, bytes32 randomness, bytes32 serverSeed, bytes32 clientSeed, bytes32 blockHash, uint256 nonce, bytes resultData)",
  "event BetRefunded(uint256 indexed betId, address indexed player, uint256 amount, string reason)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
  provider.pollingInterval = 250;
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${MANIFEST}.json`), "utf8"));
  const casinoAddr = manifest.addresses.casino;
  const read = new ethers.Contract(casinoAddr, ABI, provider);

  // ── wallets ───────────────────────────────────────────────────────────────
  let wallets;
  if (process.env.PLAYER_MASTER_KEY) {
    wallets = Array.from({ length: PLAYERS }, (_, i) =>
      new ethers.Wallet(ethers.keccak256(ethers.solidityPacked(["bytes32", "string"], [process.env.PLAYER_MASTER_KEY, `casino-load-${i + 1}`])), provider));
  } else {
    const mnemonic = "test test test test test test test test test test test junk";
    // index 0 is the deployer / bot signer on the local rig — players start at 1
    wallets = Array.from({ length: PLAYERS }, (_, i) =>
      ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${i + 1}`).connect(provider));
  }
  console.log(`[sim] casino=${casinoAddr} players=${PLAYERS} stake=${STAKE} STT think=${THINK_MS}ms mix=${MIX} rpc=${RPC}`);
  const bal0 = await provider.getBalance(wallets[0].address);
  console.log(`[sim] player[0]=${wallets[0].address} balance=${F(bal0).toFixed(3)} STT`);
  if (bal0 < E(STAKE) * 5n) throw new Error("players are not funded on this RPC");

  // ── shared settle watcher ────────────────────────────────────────────────
  // One log poller for the whole swarm instead of 50 pollers: what we are
  // measuring is the bot's settle throughput, and 50 read-pollers would just
  // add noise. Real browsers poll their own bet, which is read load, not tx load.
  const waiters = new Map();          // betId -> resolve
  const placedAt = new Map();         // betId -> ms when the place tx was mined
  const settledLat = [], refunded = [];
  let settles = 0, refunds = 0, placeFails = 0, placed = 0;
  const placeFailReasons = new Map();
  const backlogSamples = [];
  let stop = false;

  const topicSettled = read.interface.getEvent("BetSettled").topicHash;
  const topicRefunded = read.interface.getEvent("BetRefunded").topicHash;
  let fromBlock = await provider.getBlockNumber();

  (async function watch() {
    while (!stop) {
      try {
        const head = await provider.getBlockNumber();
        if (head >= fromBlock) {
          const logs = await provider.send("eth_getLogs", [{
            address: casinoAddr,
            topics: [[topicSettled, topicRefunded]],
            fromBlock: "0x" + fromBlock.toString(16),
            toBlock: "0x" + head.toString(16),
          }]);
          for (const l of logs) {
            const topics = l.topics.filter((t) => t != null);
            let ev; try { ev = read.interface.parseLog({ topics, data: l.data }); } catch (_) { continue; }
            if (!ev) continue;
            const id = String(ev.args.betId);
            const t0 = placedAt.get(id);
            if (t0 == null) continue;
            placedAt.delete(id);
            if (ev.name === "BetSettled") { settles++; settledLat.push(Date.now() - t0); }
            else { refunds++; refunded.push(Date.now() - t0); }
            const w = waiters.get(id); if (w) { waiters.delete(id); w(ev.name); }
          }
          fromBlock = head + 1;
        }
      } catch (_) {}
      await sleep(300);
    }
  })();

  // backlog sampler
  (async function sampler() {
    while (!stop) { backlogSamples.push({ t: Date.now(), n: placedAt.size }); await sleep(1000); }
  })();

  // ── one player ───────────────────────────────────────────────────────────
  const started = Date.now();
  const deadline = started + MINUTES * 60_000;

  async function runPlayer(w, idx) {
    const c = new ethers.Contract(casinoAddr, ABI, w);
    await sleep(Math.random() * 1500);              // players don't arrive in lockstep
    let nonce = await provider.getTransactionCount(w.address, "pending");
    while (Date.now() < deadline) {
      const game = MIX[Math.floor(Math.random() * MIX.length)];
      const seed = ethers.hexlify(ethers.randomBytes(32));
      let tx;
      try {
        const opts = { value: E(STAKE), nonce: nonce++ };
        tx = game === "d" ? await c.placeDiceBet(50, true, seed, opts)
          : game === "s" ? await c.placeClusterBet(seed, false, opts)
          : await c.placeSlotsBet(seed, false, opts);
      } catch (e) {
        placeFails++;
        const why = (e.shortMessage || e.message || "?").slice(0, 90);
        placeFailReasons.set(why, (placeFailReasons.get(why) || 0) + 1);
        nonce = await provider.getTransactionCount(w.address, "pending");
        await sleep(1000); continue;
      }
      let rc;
      try { rc = await tx.wait(); } catch (_) { placeFails++; await sleep(500); continue; }
      // betId from our own BetPlaced log
      let betId = null;
      for (const l of rc.logs) {
        const topics = l.topics.filter((t) => t != null);
        let ev; try { ev = read.interface.parseLog({ topics, data: l.data }); } catch (_) { continue; }
        if (ev && ev.name === "BetPlaced") { betId = String(ev.args.betId); break; }
      }
      if (betId == null) { placeFails++; continue; }
      placed++;
      placedAt.set(betId, Date.now());
      // wait for the house to reveal, like the game UI does (it spins the reels
      // until the result lands). 40s is past the 26s blockhash window — beyond
      // it the bet can only end as a refund.
      await new Promise((res) => {
        waiters.set(betId, res);
        setTimeout(() => { if (waiters.delete(betId)) res("timeout"); }, 40000);
      });
      await sleep(THINK_MS * (0.6 + Math.random() * 0.8));
    }
  }

  await Promise.all(wallets.map((w, i) => runPlayer(w, i).catch((e) => console.log(`[p${i}] fatal ${e.shortMessage || e.message}`))));
  await sleep(3000);
  stop = true;

  // ── report ───────────────────────────────────────────────────────────────
  const mins = (Date.now() - started) / 60000;
  const unresolved = placedAt.size;
  console.log(`\n[sim] ================ RESULTS ================`);
  console.log(`[sim] ${PLAYERS} players, ${mins.toFixed(1)} min, stake ${STAKE} STT, think ${THINK_MS}ms`);
  console.log(`[sim] spins placed: ${placed}  (${(placed / mins / 60).toFixed(2)}/s demanded)`);
  console.log(`[sim] settled: ${settles}  (${(settles / mins / 60).toFixed(2)}/s delivered)`);
  console.log(`[sim] REFUNDED (expired, no result): ${refunds}   still unresolved at end: ${unresolved}`);
  console.log(`[sim] place-tx failures: ${placeFails}`);
  for (const [why, n] of [...placeFailReasons].sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`[sim]    ${n} x ${why}`);
  if (settledLat.length) {
    console.log(`[sim] spin->result ms: p50=${pct(settledLat, 50)} p90=${pct(settledLat, 90)} p99=${pct(settledLat, 99)} max=${pct(settledLat, 100)}`);
    const over5 = settledLat.filter((x) => x > 5000).length;
    console.log(`[sim] results slower than 5s: ${over5}/${settledLat.length} (${(100 * over5 / settledLat.length).toFixed(0)}%)`);
  }
  if (refunded.length) console.log(`[sim] refund latency ms: p50=${pct(refunded, 50)} max=${pct(refunded, 100)}`);
  if (backlogSamples.length) {
    const ns = backlogSamples.map((s) => s.n);
    console.log(`[sim] unsettled backlog: median=${pct(ns, 50)} p90=${pct(ns, 90)} max=${pct(ns, 100)}`);
    const line = backlogSamples.filter((_, i) => i % Math.max(1, Math.floor(backlogSamples.length / 30)) === 0).map((s) => s.n).join(" ");
    console.log(`[sim] backlog over time: ${line}`);
  }
  try {
    const [, , avail] = await read.seedPoolStatus();
    console.log(`[sim] seed pool available at end: ${avail}`);
  } catch (_) {}
  console.log(`[sim] free bankroll at end: ${F(await read.freeBankroll()).toFixed(3)} STT`);
}

main().catch((e) => { console.error("[sim] fatal:", e); process.exit(1); });
