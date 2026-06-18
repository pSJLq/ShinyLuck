// House settlement bot for Somnia testnet/mainnet.
//
// Three responsibilities:
//   1. Per-bet games (Dice/Slots/Plinko): scan BetPlaced → reveal+settle
//      once the future blockhash is available.
//   2. Mines: scan BetPlaced for game=3 → revealMinesSeed (no settle -
//      the player drives cell-by-cell, then cashouts/busts).
//   3. Round-based games (Crash/Roulette):
//        - keep one round open at all times (startCrashRound/
//          startRouletteRound when the chain has no open round)
//        - settle each round once its betWindowEnd has passed +
//          REVEAL_DELAY+1 blocks elapsed since round commitBlock
//        - refund rounds that crossed the blockhash window without settle
//
// Polls via raw eth_getLogs to dodge ethers v6's BAD_DATA on Somnia logs
// (those lack the `removed` field, which ethers' validator requires).
//
// Run:
//   $env:SEEDS_FILE="deployments/seeds/somniaTestnet-XXXX.json"
//   npx hardhat run scripts/reveal-bot.js --network somniaTestnet

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

// POLL_MS pushed to 100ms (was 5000 default, then 300, then 100). On Somnia
// (~0.4s/block), 100ms poll gives avg detection latency of ~50ms vs 150ms
// at 300ms. Practical click→settle floor is now poll + reveal-delay +
// RPC roundtrip ≈ 0.1 + 0.8 + 0.3 = ~1.2s. Going below 100ms risks burning
// RPC budget without commensurate gain.
const POLL_MS = parseInt(process.env.POLL_MS || "100", 10);
// MUST match CommitReveal.sol REVEAL_DELAY exactly. We trimmed the on-chain
// constant from 3 → 1 to shave ~0.8s off the spin wait; the bot has to
// match or it sits idle waiting for an unnecessary 2 extra blocks before
// calling revealAndSettle.
const REVEAL_DELAY = 1n;
const BLOCKHASH_WINDOW = 256n;
const COLD_START_LOOKBACK = parseInt(process.env.COLD_START_LOOKBACK || "200000", 10);
const SCAN_CHUNK = parseInt(process.env.SCAN_CHUNK || "900", 10);   // Somnia RPC caps eth_getLogs at 1000-block ranges
const ROUND_KEEPALIVE = process.env.ROUND_KEEPALIVE !== "0";  // start new rounds automatically
const ROUND_TIMEOUT_S = 5 * 60;                               // matches contract constant

function toHexBlock(n) { return "0x" + BigInt(n).toString(16); }

async function rawGetLogs(provider, address, topic0, fromBlock, toBlock) {
  return await provider.send("eth_getLogs", [{
    address, topics: [topic0],
    fromBlock: toHexBlock(fromBlock), toBlock: toHexBlock(toBlock),
  }]);
}

// Seed accessor: combines the original SEEDS_FILE (indexed array from deploy
// time), the shared HM-cron pool file (sparse { idx: seed } map), AND an
// optional deterministic derivation fallback keyed by SEED_MASTER_KEY.
//
// Resolution order on get(idx):
//   1. pool file (latest topup, sparse map)
//   2. initial deploy seeds file (legacy, indices 0..199)
//   3. deterministic deriveSeed(masterKey, idx) - infinite supply, no state
//
// The deterministic branch is what makes the bot survive container restarts
// AND removes the manual-topup burden: as long as SEED_MASTER_KEY is set in
// the env, the bot can produce seed[i] for any i, and the auto-topup loop
// in main() will provision matching hash[i] = keccak256(abi.encode(seed[i]))
// on-chain whenever the pool runs low.
function deriveSeed(masterKey, idx) {
  // Match Casino.requireSeedMatches: hash = keccak256(abi.encode(bytes32 seed)).
  // For seed itself, any 32-byte derivation keyed by masterKey is fine - we
  // use solidityPacked(["bytes32","uint256"], [master, idx]) which is the
  // shortest unambiguous encoding (no struct padding).
  return ethers.keccak256(
    ethers.solidityPacked(["bytes32", "uint256"], [masterKey, BigInt(idx)]),
  );
}

function hashSeed(seed) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [seed]),
  );
}

// Round-based games (crash=GameType 1, roulette=5) the bot keeps cycling AND
// keeps unpaused via circuit-recovery. They auto-open a round every ~18s and
// EACH settle costs gas even with zero players, so on a scarce-STT testnet we
// run NONE by default (idle round-settle gas was draining the relayer in
// hours). Set ROUND_GAMES=crash,roulette on mainnet to enable them. Player
// games (dice/slots/mines/plinko/cluster) are unaffected — they only consume
// seeds/gas when someone actually bets.
const ROUND_GAMES = new Set(
  (process.env.ROUND_GAMES ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
);
function roundGameDisabled(gid) {
  return (gid === 1 && !ROUND_GAMES.has("crash")) || (gid === 5 && !ROUND_GAMES.has("roulette"));
}

function makeSeedStore({ initialSeedsFile, poolFile, masterKey }) {
  const initial = initialSeedsFile && fs.existsSync(initialSeedsFile)
    ? JSON.parse(fs.readFileSync(initialSeedsFile, "utf8")).seeds || []
    : [];
  console.log(`[reveal-bot] loaded ${initial.length} initial seeds from ${initialSeedsFile}`);
  if (poolFile) console.log(`[reveal-bot] watching pool file: ${poolFile}`);
  if (masterKey) console.log(`[reveal-bot] deterministic fallback active (SEED_MASTER_KEY set)`);
  else           console.log(`[reveal-bot] no SEED_MASTER_KEY - seeds limited to file+pool, manual topup required`);

  // Pool format supports both shapes:
  //   1. { seeds: [...], hashes: [...] }  - written by deploy.js / topup-seeds.js
  //   2. { "0": "0x...", "37": "0x...", ... }  - sparse map written by hm-cron.js
  // We normalise to an indexed array for fast .get(idx).
  let poolArray = [];
  let poolMtime = 0;
  function refreshPool() {
    if (!poolFile || !fs.existsSync(poolFile)) return;
    try {
      const st = fs.statSync(poolFile);
      if (st.mtimeMs === poolMtime) return;
      poolMtime = st.mtimeMs;
      const raw = JSON.parse(fs.readFileSync(poolFile, "utf8"));
      if (Array.isArray(raw.seeds)) {
        // shape 1: contiguous array starting at index 0
        poolArray = raw.seeds.slice();
      } else if (raw && typeof raw === "object") {
        // shape 2: sparse map of stringified indices → seed
        const max = Math.max(...Object.keys(raw).map(Number).filter(Number.isFinite), -1);
        poolArray = new Array(max + 1);
        for (const k of Object.keys(raw)) poolArray[Number(k)] = raw[k];
      } else {
        poolArray = [];
      }
      console.log(`[reveal-bot] pool reloaded: ${poolArray.filter(Boolean).length} seeds available`);
    } catch (e) { console.warn(`[reveal-bot] pool reload: ${e.message}`); }
  }
  return {
    get(idx) {
      const i = Number(idx);
      // When a master key is set, ALWAYS derive deterministically. Seeds are
      // keccak(masterKey, idx), so this is correct for ANY deploy and immune to
      // a stale initial/pool seeds file left on the host from a PREVIOUS deploy
      // (which would otherwise shadow indices 0..N with the wrong seeds and make
      // every fresh-deploy settle revert → bets expire). This is what lets a
      // redeploy "just work" with no Railway seeds-env update.
      if (masterKey) return deriveSeed(masterKey, i);
      refreshPool();
      if (poolArray[i]) return poolArray[i];
      if (i < initial.length) return initial[i];
      return null;
    },
    refresh: refreshPool,
    hasMaster: !!masterKey,
  };
}

async function main() {
  const seedsFile = process.env.SEEDS_FILE;
  const poolFile = path.join(__dirname, "..", "deployments", "seeds", `${network.name}-pool.json`);
  // Optional deterministic-fallback master key. When present, the bot can
  // produce seed[i] for any i without storing it - and the auto-topup loop
  // will commit matching hashes on-chain when the pool runs low. Must be
  // a 32-byte 0x-prefixed hex string. Generate once with
  //   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  // and pin it as SEED_MASTER_KEY in the deploy env - changing it later
  // breaks all unrevealed bets that point at hashes derived from the old key.
  const masterKey = process.env.SEED_MASTER_KEY || null;
  if (masterKey && !/^0x[0-9a-fA-F]{64}$/.test(masterKey)) {
    throw new Error(`SEED_MASTER_KEY must be a 32-byte 0x-prefixed hex string (got length ${masterKey.length})`);
  }
  const seedStore = makeSeedStore({ initialSeedsFile: seedsFile, poolFile, masterKey });

  const manifestPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const casinoAddr = manifest.addresses.casino;

  const Casino = await ethers.getContractFactory("Casino");
  const casino = Casino.attach(casinoAddr);
  const [signer] = await ethers.getSigners();
  const provider = ethers.provider;
  console.log(`[reveal-bot] signer=${signer.address} casino=${casinoAddr} network=${network.name}`);

  // QUORUM VERIFIER activation: every Nth settled bet, ask the independent
  // 3-of-4 LLM committee (AgentQuorumVerifier) to re-derive the bet's keccak256
  // randomness on-chain (defence-in-depth on the RNG). Fully fire-and-forget so
  // it can NEVER block or slow settlement; the signer pays the small quote and
  // the gas-autopilot keeps it funded. Disable with QUORUM_EVERY=0.
  const verifier = manifest.addresses.agentQuorumVerifier
    ? await ethers.getContractAt("AgentQuorumVerifier", manifest.addresses.agentQuorumVerifier, signer)
    : null;
  const QUORUM_EVERY = parseInt(process.env.QUORUM_EVERY || "8", 10);
  let _settleCount = 0;
  async function maybeFireQuorum(betId) {
    if (!verifier || QUORUM_EVERY <= 0) return;
    _settleCount++;
    if (_settleCount % QUORUM_EVERY !== 0) return;
    try {
      const price = await verifier.quotePrice();
      const tx = await verifier.requestVerification(betId, { value: price });
      await tx.wait();
      console.log(`[reveal-bot] quorum verification fired for bet ${betId} (tx=${tx.hash.slice(0, 12)}…)`);
    } catch (e) { /* defence-in-depth only - never disrupt settlement */ }
  }

  const topics = {
    betPlaced:           casino.interface.getEvent("BetPlaced").topicHash,
    crashRoundStarted:   casino.interface.getEvent("CrashRoundStarted").topicHash,
    rouletteRoundStarted:casino.interface.getEvent("RouletteRoundStarted").topicHash,
  };

  // ────────────────────── AUTO-TOPUP (deterministic seeds) ──────────────────
  // When SEED_MASTER_KEY is set, the bot can produce seed[i] for any i. To
  // keep the on-chain pool from running dry, it watches seedPoolStatus and
  // pre-commits the next batch of hashes whenever available drops below
  // SEED_TOPUP_THRESHOLD. Each hash is keccak256(abi.encode(deriveSeed(i)))
  // - the exact same construction Casino.requireSeedMatches expects.
  //
  // The reveal-bot signer here is the deployer (Casino owner), so
  // provisionSeedHashes is allowed by the `msg.sender == houseManager ||
  // msg.sender == owner()` gate.
  // Threshold raised 100 -> 400 and batch 500 -> 1000. Round-based games burn
  // a seed every 30s (2/min), so a 100-seed floor left only ~50 min of runway
  // and, worse, after a container restart the topup loop could lose the race
  // to consumption and the pool hit zero (startRound reverts NoSeedAvailable,
  // wheel freezes). A 400 floor = ~13 min of slack before refill even at the
  // fastest cadence, and 1000/batch means topups are rare.
  const SEED_TOPUP_THRESHOLD = parseInt(process.env.SEED_TOPUP_THRESHOLD || "400", 10);
  const SEED_TOPUP_BATCH     = parseInt(process.env.SEED_TOPUP_BATCH     || "1000", 10);
  const SEED_TOPUP_CHECK_MS  = parseInt(process.env.SEED_TOPUP_CHECK_MS  || "30000", 10);
  // Chunk on-chain provision so a single tx doesn't blow the block gas limit.
  const SEED_TOPUP_CHUNK     = 200;
  // When the pool empties, the round-opener must STOP hammering startRound: that
  // retry storm churns the shared owner nonce and starves the seed-topup tx, so
  // the pool can never refill (root cause of the 2026-06-12 NoSeedAvailable
  // freeze). On an empty-pool revert we back off this long AND kick a topup.
  const SEED_EMPTY_BACKOFF_S = parseInt(process.env.SEED_EMPTY_BACKOFF_S || "30", 10);
  let seedEmptyBackoffUntil = 0;
  let lastSeedEmptyLog = 0;
  let seedTopupBusy = false;
  async function maybeAutoTopupSeeds() {
    if (seedTopupBusy) return;
    if (!seedStore.hasMaster) return; // no master key → no auto-topup
    seedTopupBusy = true;
    try {
      const [total, consumed] = await casino.seedPoolStatus();
      const available = Number(total - consumed);
      if (available >= SEED_TOPUP_THRESHOLD) return;
      console.log(`[reveal-bot] seed auto-topup: available=${available} < threshold=${SEED_TOPUP_THRESHOLD}, provisioning ${SEED_TOPUP_BATCH} seeds`);
      const napMs = (ms) => new Promise((r) => setTimeout(r, ms));
      let added = 0;
      while (added < SEED_TOPUP_BATCH) {
        // Re-read the on-chain length each chunk so hashes are derived for the
        // EXACT positions they'll occupy (immune to a concurrent append).
        const curTotal = Number((await casino.seedPoolStatus())[0]);
        const n = Math.min(SEED_TOPUP_CHUNK, SEED_TOPUP_BATCH - added);
        const slice = new Array(n);
        for (let j = 0; j < n; j++) slice[j] = hashSeed(deriveSeed(masterKey, curTotal + j));
        // The settle / round-open loops share this signer, so a chunk can hit
        // "nonce too low". Retry the SEND on transient nonce errors (this is the
        // bug that left the pool stuck at 3/5 chunks → drained to 0 → froze).
        let broadcast = false;
        for (let attempt = 0; attempt < 6 && !broadcast; attempt++) {
          try { await casino.provisionSeedHashes(slice); broadcast = true; }
          catch (e) {
            const msg = e.shortMessage || e.message || "";
            if (/nonce|replacement|already known|underpriced|mempool/i.test(msg)) await napMs(1200 + Math.random() * 1200);
            else throw e;
          }
        }
        if (!broadcast) throw new Error("provision kept colliding");
        // Confirm via on-chain length (truth), so a slow/dropped tx is never
        // double-provisioned (which would misalign hashes vs derivation).
        let landed = false;
        for (let w = 0; w < 45 && !landed; w += 3) {
          await napMs(3000);
          if (Number((await casino.seedPoolStatus())[0]) >= curTotal + n) landed = true;
        }
        if (!landed) { console.warn(`[reveal-bot] topup chunk at ${curTotal} not landed — retrying`); continue; }
        added += n;
      }
      console.log(`[reveal-bot] seed auto-topup done (+${added} seeds, pool ~${available + added})`);
    } catch (e) {
      console.warn(`[reveal-bot] seed auto-topup failed: ${e.shortMessage || e.message}`);
    } finally {
      seedTopupBusy = false;
    }
  }
  // Run once on startup so a freshly-deployed casino with low pool gets
  // backfilled before the first user spin. Then periodically.
  maybeAutoTopupSeeds().catch(() => {});
  setInterval(() => { maybeAutoTopupSeeds().catch(() => {}); }, SEED_TOPUP_CHECK_MS);

  // ─────────────────────── AGENT WATCHDOG (keeper) ──────────────────────────
  // The HouseManager runs a self-rescheduling Reactivity cron (precompile
  // 0x0100) - that's the autonomous mechanism. But on Somnia testnet the
  // scheduled-subscription delivery is flaky: validators occasionally drop
  // the re-schedule, so the cron silently stops firing after a tick or two.
  // Since this reveal-bot already runs 24/7 (and its signer is the casino
  // owner), it doubles as a watchdog: if the last hourly tick is stale, it
  // (a) reboots the cron and (b) directly fires the agent chain so the
  // lobby's agent cards + cost ledger keep showing fresh on-chain activity
  // through the demo window. Disable with AGENT_WATCHDOG=0.
  const AGENT_WATCHDOG       = process.env.AGENT_WATCHDOG !== "0";
  const WATCHDOG_CHECK_MS    = parseInt(process.env.AGENT_WATCHDOG_CHECK_MS || "600000", 10); // 10 min
  // The Somnia native Reactivity cron is (a) testnet-only - it does NOT exist on
  // mainnet - and (b) flaky on testnet: validators drop the re-schedule, so it
  // stops firing after a tick or two. So THIS BOT is the real, sole agent
  // driver. The full agent chain costs ~0.8-0.9 STT per run, so we must NOT fire
  // it every check (the old code did - when the native cron was permanently
  // "stale" it fired every 10 min ≈ 115 STT/day and drained the HM in hours).
  // Instead we fire on a budgeted cadence (default 3h => ~8 runs/day => ~6 days
  // runway on a ~40 STT HM), tracked IN-MEMORY because our direct fires don't
  // bump the on-chain lastHourlyTickTs. We no longer reboot the native cron at
  // all, so spend is single-sourced and predictable (no surprise double-fires
  // if a stray scheduled callback ever lands).
  const AGENT_FIRE_INTERVAL_MS = parseInt(process.env.AGENT_FIRE_INTERVAL_MS || "10800000", 10); // 3h
  const MIN_HM_BAL           = ethers.parseEther("33"); // 32 precompile floor + headroom for one chain
  let watchdogBusy = false;
  let lastChainFireMs = 0; // 0 => fire once shortly after boot, then every AGENT_FIRE_INTERVAL_MS
  async function agentWatchdog() {
    if (!AGENT_WATCHDOG || watchdogBusy) return;
    if (Date.now() - lastChainFireMs < AGENT_FIRE_INTERVAL_MS) return; // budgeted cadence
    watchdogBusy = true;
    // Safety net: if ANY await below hangs forever (hung RPC read, or a tx
    // stuck behind a nonce gap so tx.wait() never settles), force-release the
    // busy flag after 5 min so the agent loop can fire on a later check.
    // Without this, finally{} never runs and the flag wedges the agent chain
    // until the next redeploy — exactly what silenced the agent feed for 23h
    // on 2026-06-11/12 while the settle loops kept running fine.
    const unstick = setTimeout(() => { watchdogBusy = false; }, 300_000);
    try {
      const hm = await ethers.getContractAt("HouseManager", manifest.addresses.houseManager, signer);
      const bal = await provider.getBalance(manifest.addresses.houseManager);
      if (bal < MIN_HM_BAL) { console.log(`[reveal-bot] agent-watchdog: HM ${ethers.formatEther(bal)} STT below floor - skipping chain`); return; }
      // Reserve the slot up-front so a mid-run crash can't double-fire next check.
      lastChainFireMs = Date.now();
      console.log(`[reveal-bot] agent-watchdog: firing agent chain (HM ${ethers.formatEther(bal)} STT, next in ${(AGENT_FIRE_INTERVAL_MS/3600000).toFixed(1)}h)`);
      // Each is try/catch'd so a single failure (e.g. smart-skip) doesn't abort.
      // Competitor (cheap JSON fetch) first so the LLM RTP analysis reads the
      // freshest competitor benchmark from storage.
      const fire = async (label, fn) => {
        // wait(confirms, timeoutMs): never block forever on a stuck tx.
        try { const tx = await fn(); await tx.wait(1, 120_000); console.log(`[reveal-bot] watchdog fired ${label} (${tx.hash.slice(0,12)}...)`); }
        catch (e) { console.warn(`[reveal-bot] watchdog ${label}: ${e.shortMessage || e.message}`); }
      };
      // ONE call runs the full on-chain hourly tick: sample the bankroll ring,
      // compute the LIVE 1-tick Δ, run the circuit check, and fire the whole
      // agent chain (competitor×2 + news + rtp×2 + player decisions). Doing it
      // via pokeHourlyTick (instead of the individual request fns) keeps the
      // bankroll ring FRESH, so the RTP agent reads a real delta instead of a
      // stale baseline frozen at deploy time.
      await fire("hourly-tick", () => hm.pokeHourlyTick());
    } catch (e) {
      console.warn(`[reveal-bot] agent-watchdog: ${e.shortMessage || e.message}`);
    } finally {
      clearTimeout(unstick);
      watchdogBusy = false;
    }
  }
  // First fire 90s after boot, then re-check every 10 min (only actually fires
  // once the budgeted AGENT_FIRE_INTERVAL_MS has elapsed).
  setTimeout(() => { agentWatchdog().catch(() => {}); }, 90_000);
  setInterval(() => { agentWatchdog().catch(() => {}); }, WATCHDOG_CHECK_MS);

  // ───────────────── PLAYER-AGENT TICKER ─────────────────
  // The HouseManager's on-chain hourly cron iterates active players and fires
  // requestPlayerDecision per player - but Somnia testnet's scheduled-sub
  // delivery is flaky, so a demo can't rely on it firing reliably. The bot's
  // signer is the casino owner (authorised on requestPlayerDecision), so it
  // also pokes each registered+active player on a tight interval. Each call
  // pulls the user's LLM-fee share from THEIR vault (spam-safe: empty vault =>
  // skipped), so this never spends the house's money. Set PLAYER_TICK_MS=0 to
  // disable. This is what makes registered player-agents visibly bet during a
  // demo instead of waiting up to an hour for the cron.
  const PLAYER_TICK_MS = parseInt(process.env.PLAYER_TICK_MS || "180000", 10); // 3 min
  let playerTickBusy = false;
  async function playerAgentTick() {
    if (PLAYER_TICK_MS === 0 || playerTickBusy) return;
    playerTickBusy = true;
    try {
      const regAddr = manifest.addresses.playerAgentRegistry;
      if (!regAddr) return;
      const reg = new ethers.Contract(regAddr,
        ["function getActivePlayers(uint256,uint256) view returns (address[])"], signer);
      const hm = await ethers.getContractAt("HouseManager", manifest.addresses.houseManager, signer);
      // HM must hold the casino-share + Reactivity floor to fire (same gate the
      // contract checks); skip quietly if underfunded.
      const hmBal = await provider.getBalance(manifest.addresses.houseManager);
      if (hmBal < MIN_HM_BAL) return;
      let players = [];
      try { players = await reg.getActivePlayers(0, 10); } catch (_) { return; }
      for (const p of players) {
        try {
          const tx = await hm.requestPlayerDecision(p);
          await tx.wait();
          console.log(`[reveal-bot] player-agent tick fired for ${p.slice(0, 10)}... (${tx.hash.slice(0, 12)}...)`);
        } catch (e) {
          // insufficient-vault-budget / inactive / not-wired are normal skips
        }
      }
    } catch (e) {
      console.warn(`[reveal-bot] player-agent tick: ${e.shortMessage || e.message}`);
    } finally {
      playerTickBusy = false;
    }
  }
  setTimeout(() => { playerAgentTick().catch(() => {}); }, 120_000);
  setInterval(() => { playerAgentTick().catch(() => {}); }, PLAYER_TICK_MS);

  const currentBlock0 = await provider.getBlockNumber();

  // ───────────────────────── PUSH PATH (WebSocket) ──────────────────────────
  // The HTTP poll loop below still runs every POLL_MS as a safety net (catches
  // anything the WS dropped during reconnect, plus the periodic refundExpired
  // sweep). The WS subscriptions let us add a new pending bet to the map
  // ~5-20ms after the placement tx mines instead of paying the average poll
  // latency (~50ms at POLL_MS=100). On a spin this shaves the wait window
  // measurably and removes the variance of "did we just miss the poll window".
  let wsProvider = null;
  let triggerLoop = () => {}; // overwritten after `loop` is defined
  try {
    // Canonical infra endpoint per emrestay's reactivity examples - more
    // reliable for sub pushes than the public dream-rpc.
    const wsUrl = process.env.WS_URL || "wss://api.infra.testnet.somnia.network/ws";
    wsProvider = new ethers.WebSocketProvider(wsUrl);
    const onBetPlaced = (log) => {
      try {
        const parsed = casino.interface.parseLog({ topics: log.topics, data: log.data });
        const a = parsed.args;
        const id = a.betId.toString();
        if (!pending.has(id)) {
          pending.set(id, {
            commitBlock: BigInt(a.commitBlock),
            seedIdx: Number(a.seedIdx),
            game: Number(a.game),
            player: a.player,
          });
          // Kick the loop immediately so we attempt reveal the moment
          // REVEAL_DELAY+1 blocks have elapsed (the loop itself rechecks age).
          triggerLoop();
        }
      } catch (_) {}
    };
    const onCrashRound = (log) => {
      try {
        const parsed = casino.interface.parseLog({ topics: log.topics, data: log.data });
        const a = parsed.args;
        const id = a.roundId.toString();
        if (!pendingRounds.has("c:" + id)) {
          pendingRounds.set("c:" + id, { kind: "crash", roundId: id, commitBlock: BigInt(a.commitBlock), seedIdx: Number(a.seedIdx), betWindowEnd: Number(a.betWindowEnd) });
        }
      } catch (_) {}
    };
    const onRouletteRound = (log) => {
      try {
        const parsed = casino.interface.parseLog({ topics: log.topics, data: log.data });
        const a = parsed.args;
        const id = a.roundId.toString();
        if (!pendingRounds.has("r:" + id)) {
          pendingRounds.set("r:" + id, { kind: "roulette", roundId: id, commitBlock: BigInt(a.commitBlock), seedIdx: Number(a.seedIdx), betWindowEnd: Number(a.betWindowEnd) });
        }
      } catch (_) {}
    };
    wsProvider.on({ address: casinoAddr, topics: [topics.betPlaced] }, onBetPlaced);
    wsProvider.on({ address: casinoAddr, topics: [topics.crashRoundStarted] }, onCrashRound);
    wsProvider.on({ address: casinoAddr, topics: [topics.rouletteRoundStarted] }, onRouletteRound);
    // Newheads subscription - every block tick wakes the loop, so the moment
    // a pending bet's REVEAL_DELAY block is mined we attempt reveal. Without
    // this we'd wait up to POLL_MS extra after the block ticked.
    wsProvider.on("block", () => { triggerLoop(); });
    console.log(`[reveal-bot] WS push-path active (${wsUrl})`);
  } catch (e) {
    console.warn(`[reveal-bot] WS setup failed, polling-only: ${e.message}`);
    wsProvider = null;
  }
  let lastScannedBlock;
  // Cap the cold-start range so the bot doesn't block for minutes scanning
  // tens of thousands of blocks from deploymentBlock. Anything older than
  // BLOCKHASH_WINDOW (256 blocks) can't be revealed anyway - it falls into
  // the refundExpired branch which the bot reaches via the periodic sweep.
  const COLD_START_MAX = Math.min(COLD_START_LOOKBACK || 2000, 2000);
  if (manifest.deploymentBlock) {
    const fromManifest = Math.max(0, Number(manifest.deploymentBlock) - 10);
    lastScannedBlock = Math.max(fromManifest, currentBlock0 - COLD_START_MAX);
    console.log(`[reveal-bot] cold start from block ${lastScannedBlock} (head=${currentBlock0}, manifest=${fromManifest})`);
  } else {
    lastScannedBlock = Math.max(0, currentBlock0 - COLD_START_MAX);
    console.log(`[reveal-bot] cold start from head-${COLD_START_MAX}=${lastScannedBlock}`);
  }

  // Per-bet pending: betId → { commitBlock, seedIdx, game, player }
  const pending = new Map();
  // Round-based pending: roundId → { commitBlock, seedIdx, betWindowEnd, kind: "crash"|"roulette" }
  const pendingRounds = new Map();
  // round key -> { fails, nextMs }: throttles doomed settle re-submits (e.g. an
  // orphaned round whose seed no longer matches) so we don't burn gas firing a
  // reverting settle tx every 100ms. The round still refunds once it crosses the
  // blockhash window in the refund branch below.
  const roundSettleBackoff = new Map();

  const loop = async () => {
    let cur, chainNowSec;
    try {
      const blk = await provider.getBlock("latest");
      cur = BigInt(blk.number);
      chainNowSec = Number(blk.timestamp); // chain clock, NOT Date.now()
    }
    catch (e) { console.warn(`[reveal-bot] getBlock: ${e.message}`); return; }

    // 1. eth_getLogs for ALL relevant topics in the new window.
    const fromBlock = lastScannedBlock + 1;
    const toBlock = Number(cur);
    if (toBlock >= fromBlock) {
      let foundBets = 0, foundCrashRounds = 0, foundRouletteRounds = 0;
      for (let start = fromBlock; start <= toBlock; start += SCAN_CHUNK) {
        const end = Math.min(start + SCAN_CHUNK - 1, toBlock);
        const sweepRange = async (topic0, handler) => {
          let raw;
          try { raw = await rawGetLogs(provider, casinoAddr, topic0, start, end); }
          catch (e) { console.warn(`[reveal-bot] getLogs ${start}..${end}: ${e.shortMessage || e.message}`); return; }
          for (const r of raw) {
            try {
              const parsed = casino.interface.parseLog({ topics: r.topics, data: r.data });
              handler(parsed, parseInt(r.blockNumber, 16));
            } catch (_) {}
          }
        };
        await Promise.all([
          sweepRange(topics.betPlaced, (p) => {
            const a = p.args;
            const id = a.betId.toString();
            if (!pending.has(id)) {
              pending.set(id, {
                commitBlock: BigInt(a.commitBlock),
                seedIdx: Number(a.seedIdx),
                game: Number(a.game),
                player: a.player,
              });
              foundBets++;
            }
          }),
          sweepRange(topics.crashRoundStarted, (p) => {
            const a = p.args;
            const id = a.roundId.toString();
            if (!pendingRounds.has("c:" + id)) {
              pendingRounds.set("c:" + id, {
                kind: "crash",
                roundId: id,
                commitBlock: BigInt(a.commitBlock),
                seedIdx: Number(a.seedIdx),
                betWindowEnd: Number(a.betWindowEnd),
              });
              foundCrashRounds++;
            }
          }),
          sweepRange(topics.rouletteRoundStarted, (p) => {
            const a = p.args;
            const id = a.roundId.toString();
            if (!pendingRounds.has("r:" + id)) {
              pendingRounds.set("r:" + id, {
                kind: "roulette",
                roundId: id,
                commitBlock: BigInt(a.commitBlock),
                seedIdx: Number(a.seedIdx),
                betWindowEnd: Number(a.betWindowEnd),
              });
              foundRouletteRounds++;
            }
          }),
        ]);
      }
      lastScannedBlock = toBlock;
      if (foundBets + foundCrashRounds + foundRouletteRounds > 0) {
        console.log(`[reveal-bot] scan ${fromBlock}..${toBlock} bets=+${foundBets} crash=+${foundCrashRounds} roulette=+${foundRouletteRounds} pending=${pending.size} rounds=${pendingRounds.size}`);
      }
    }

    // Use the chain clock (latest block timestamp), not Date.now() - the host
    // wall-clock can drift from chain time and make windowClosed/timeout checks
    // wrong (rounds settling too late -> refund -> result 0).
    const nowSec = chainNowSec;

    // 2. Sweep per-bet pending.
    for (const [betId, info] of pending) {
      const age = cur - info.commitBlock;
      if (age < 0n) continue;
      if (age > REVEAL_DELAY + BLOCKHASH_WINDOW) {
        try {
          const tx = await casino.refundExpired(betId);
          await tx.wait();
          console.log(`[reveal-bot] refunded expired bet ${betId} tx=${tx.hash}`);
        } catch (e) {
          const msg = e.shortMessage || e.message;
          if (/BetAlreadySettled|BetNotFound|not expired/.test(msg)) {/* drop */}
          else console.warn(`[reveal-bot] refundExpired ${betId}: ${msg}`);
        }
        pending.delete(betId);
      } else if (age > REVEAL_DELAY) {
        const seed = seedStore.get(info.seedIdx);
        if (!seed) { console.warn(`[reveal-bot] no seed at idx=${info.seedIdx} for bet ${betId}`); pending.delete(betId); continue; }
        const action = info.game === 3 ? "REVEAL_MINES" : (info.game === 1 || info.game === 5 ? "SKIP_ROUND" : "SETTLE");
        if (action === "SKIP_ROUND") { pending.delete(betId); continue; }
        try {
          const tx = info.game === 3
            ? await casino.revealMinesSeed(betId, seed)
            : await casino.revealAndSettle(betId, seed);
          await tx.wait();
          console.log(`[reveal-bot] ${action} bet ${betId} tx=${tx.hash}`);
          pending.delete(betId);
          if (action === "SETTLE") maybeFireQuorum(betId).catch(() => {});
        } catch (e) {
          const msg = e.shortMessage || e.message;
          if (/BetAlreadySettled|BetNotFound|InvalidGame/.test(msg)) pending.delete(betId);
          else if (/RevealTooEarly/.test(msg)) {/* retry next tick */}
          else if (/RevealExpired/.test(msg)) {/* refund branch next tick */}
          else {
            // Generic "execution reverted" - bot can't decode the custom
            // error. Probable causes:
            //   • on-chain bet was already settled by another caller
            //   • the seed in our local store doesn't match the contract's
            //     hash at this seedIdx (stale seed file vs new deploy)
            //   • CommitReveal expired between scan and tx submit
            // Either way, retrying forever is worse than dropping - the
            // refundExpired path will kick in on the age check next tick if
            // the bet is genuinely stuck.
            info._retries = (info._retries || 0) + 1;
            if (info._retries >= 5) {
              console.warn(`[reveal-bot] ${action} ${betId}: ${msg} (dropping after 5 retries)`);
              pending.delete(betId);
            } else {
              console.warn(`[reveal-bot] ${action} ${betId}: ${msg} (retry ${info._retries}/5)`);
            }
          }
        }
      }
    }

    // 3. Sweep round-based pending - try settle first, then refund only on
    //    real timeout. The contract enforces order:
    //      - settle is allowed when commitBlock+3 has passed AND not settled
    //      - refund is allowed only after the round timeout (5 min + buffer)
    //    Checking settled flag onchain before either action keeps us from
    //    bouncing reverts forever on already-finished rounds.
    // CRITICAL TIMING: at ~0.1s/block the 256-block blockhash window is only
    // ~28s. A round's bet window closes ~10s after open, leaving < 18s to
    // settle before the entropy block expires (-> forced refund -> result 0).
    // So round settle MUST be eager: we (a) sort pending rounds by how close
    // they are to expiry and settle the most urgent first, (b) skip the
    // redundant getRouletteRound pre-check (the settle tx reverts harmlessly
    // if already settled), and (c) do NOT await tx.wait() - blocking the loop
    // on each receipt is what let rounds pile up past the window. Fire and
    // let the next tick confirm via the on-chain settled flag.
    const roundList = [...pendingRounds.entries()]
      .map(([key, info]) => ({ key, info, age: cur - info.commitBlock }))
      .filter((x) => x.age >= 0n)
      .sort((a, b) => Number(b.age - a.age)); // oldest (closest to expiry) first
    for (const { key, info, age } of roundList) {
      // Try settle when window closed + REVEAL_DELAY blocks elapsed, and the
      // entropy block has NOT yet expired (else go straight to refund below).
      const windowClosed = nowSec >= info.betWindowEnd;
      const readyToReveal = age > REVEAL_DELAY;
      const expired = age > REVEAL_DELAY + BLOCKHASH_WINDOW;
      const bo = roundSettleBackoff.get(key);
      const throttled = bo && bo.fails >= 2 && Date.now() < bo.nextMs;
      if (windowClosed && readyToReveal && !expired && !throttled) {
        const seed = seedStore.get(info.seedIdx);
        if (!seed) continue; // no seed yet - keep the round around
        const fn = info.kind === "crash" ? "settleCrashRound" : "settleRouletteRound";
        try {
          // No tx.wait(): submit and move on so a backlog can't blow the
          // ~28s window. Optimistically drop from pending; if the tx fails
          // the cold-start scan re-adds the round next sweep.
          const tx = await casino[fn](info.roundId, seed);
          console.log(`[reveal-bot] settle ${info.kind} round ${info.roundId} submitted tx=${tx.hash} (age=${age})`);
          pendingRounds.delete(key); roundSettleBackoff.delete(key);
          continue;
        } catch (e) {
          const msg = e.shortMessage || e.message;
          if (/RoundAlreadySettled/.test(msg)) { pendingRounds.delete(key); roundSettleBackoff.delete(key); continue; }
          if (/RevealTooEarly|RoundClosed/.test(msg)) continue; // retry next tick
          if (!/RevealExpired/.test(msg)) {
            // Non-transient settle failure (orphaned/seed-mismatch round). Back
            // off per-round (3s, 6s, 9s ... capped 30s) so we stop firing a
            // reverting settle tx every 100ms; the refund branch reclaims it.
            const cur = roundSettleBackoff.get(key) || { fails: 0, nextMs: 0 };
            cur.fails++; cur.nextMs = Date.now() + Math.min(30000, 3000 * cur.fails);
            roundSettleBackoff.set(key, cur);
            if (cur.fails <= 2) console.warn(`[reveal-bot] settle ${info.roundId}: ${msg} (backing off)`);
            continue;
          }
          // RevealExpired -> fall through to refund below
        }
      }
      // Refund only on hard timeout (blockhash window expired OR betWindowEnd
      // long past + buffer). Contract enforces this - the check is just to
      // avoid noisy reverts here.
      const refundable = age > REVEAL_DELAY + BLOCKHASH_WINDOW
                      || (nowSec - info.betWindowEnd > ROUND_TIMEOUT_S + 60);
      if (refundable) {
        const fn = info.kind === "crash" ? "refundCrashRound" : "refundRouletteRound";
        try {
          const tx = await casino[fn](info.roundId);
          await tx.wait();
          console.log(`[reveal-bot] refunded ${info.kind} round ${info.roundId} tx=${tx.hash}`);
        } catch (e) {
          const msg = e.shortMessage || e.message;
          if (!/RoundAlreadySettled|RoundNotSettleable/.test(msg)) {
            console.warn(`[reveal-bot] ${fn} ${info.roundId}: ${msg}`);
          }
        }
        pendingRounds.delete(key); roundSettleBackoff.delete(key);
      }
    }

    // 4. Round keepalive - make sure there's always an open Crash + Roulette
    //    round so players can hop in.
    if (ROUND_KEEPALIVE) {
      const startIfNoOpen = async (gameLabel, currentFn, hasFn, refundFn) => {
        // Skip entirely if this round-game is paused on-chain. Crash/roulette
        // auto-open a round every betWindow (~18s) and settling each one costs
        // gas even with ZERO players - on a scarce-STT testnet that idle burn
        // drains the relayer in hours. When the owner pauses them to conserve
        // STT (re-enabled on mainnet), this guard stops the bot from hammering
        // startRound (which would just revert GameIsPaused) and spamming logs.
        const gid = gameLabel === "crash" ? 1 : 5;
        if (roundGameDisabled(gid)) return;                         // off on testnet (ROUND_GAMES env)
        try { if (await casino.gamePaused(gid)) return; } catch (_) {} // also respect an on-chain pause
        let round = null, id = null;
        try {
          id = await casino[currentFn]();
          round = await casino[hasFn](id);
          // round is open if betWindowEnd > now AND not settled
          if (!round.settled && Number(round.betWindowEnd) > nowSec) return; // open, no-op
          if (Number(round.betWindowEnd) === 0) return; // race - wait
        } catch (_) { /* never started - proceed */ }
        // SETTLE-BEFORE-OPEN: if the current round's window has closed but it
        // is still unsettled AND still inside the blockhash window, settle it
        // RIGHT HERE before opening the next. Opening N+1 first advances
        // currentRoundId, so N's settle slips to a later tick and its age
        // creeps past the 257-block reveal window => refund => result 0. Doing
        // it inline (await wait) guarantees N lands a real result first.
        try {
          if (round && !round.settled && Number(round.betWindowEnd) > 0 && nowSec >= Number(round.betWindowEnd)) {
            const age = Number(cur) - Number(round.commitBlock);
            if (age > REVEAL_DELAY && age <= REVEAL_DELAY + BLOCKHASH_WINDOW) {
              const seed = seedStore.get(Number(round.seedIdx));
              if (seed) {
                const settleFn = gameLabel === "crash" ? "settleCrashRound" : "settleRouletteRound";
                const tx = await casino[settleFn](id, seed);
                await tx.wait();
                console.log(`[reveal-bot] keepalive settle ${gameLabel} round ${id} (age=${age}) tx=${tx.hash}`);
              }
            }
          }
        } catch (e) {
          const msg = e.shortMessage || e.message;
          if (!/RoundAlreadySettled|RevealTooEarly|RoundClosed/.test(msg)) {
            console.warn(`[reveal-bot] keepalive settle ${gameLabel}: ${msg}`);
          }
        }
        // SELF-HEAL: an unsettled round whose window closed long ago (past the
        // round timeout) blocks startRound forever with RoundClosed. This
        // happens after a bot restart: the round is older than the cold-start
        // lookback, so it never re-enters pendingRounds to be settled/refunded.
        // Without this, the wheel sits in LOCK for days (exactly what we hit).
        // Refund it here so a fresh round can open immediately.
        try {
          if (round && !round.settled && Number(round.betWindowEnd) > 0 &&
              nowSec - Number(round.betWindowEnd) > ROUND_TIMEOUT_S) {
            const tx = await casino[refundFn](id);
            await tx.wait();
            console.log(`[reveal-bot] self-heal: refunded stuck ${gameLabel} round ${id} tx=${tx.hash}`);
          }
        } catch (e) {
          const msg = e.shortMessage || e.message;
          if (!/RoundAlreadySettled|RoundNotSettleable/.test(msg)) {
            console.warn(`[reveal-bot] self-heal refund ${gameLabel}: ${msg}`);
          }
        }
        // INTER-ROUND GAP: hold the next open until ROUND_GAP_S after the
        // previous round's window closed. The chain used to open N+1 the
        // instant N closed, but the browser is still playing N's ~4-5s spin
        // animation - so by the time the UI shows N+1 its window had already
        // drained and the player saw a jittery 1-5s countdown. Waiting out the
        // spin means N+1 opens fresh and the UI catches its FULL window, giving
        // a stable countdown every round. The gap is filled visually by the
        // spin + result display, so there is no dead time on screen. Only
        // applies once a round exists (skip on first bootstrap).
        const ROUND_GAP_S = parseInt(process.env.ROUND_GAP_S || "6", 10);
        if (round && Number(round.betWindowEnd) > 0 && nowSec < Number(round.betWindowEnd) + ROUND_GAP_S) {
          return; // still inside the post-round gap - open on a later tick
        }
        if (Date.now() < seedEmptyBackoffUntil) return; // empty-pool backoff: don't storm startRound
        try {
          const startFn = gameLabel === "crash" ? "startCrashRound" : "startRouletteRound";
          const tx = await casino[startFn]();
          await tx.wait();
          console.log(`[reveal-bot] opened new ${gameLabel} round tx=${tx.hash}`);
        } catch (e) {
          const msg = e.shortMessage || e.message;
          if (/RoundClosed|GameIsPaused/.test(msg)) {/* ok */}
          else if (/NoSeedAvailable|execution reverted/.test(msg)) {
            // Almost certainly an empty seed pool (NoSeedAvailable often arrives
            // undecoded as "execution reverted"). Back off so we stop starving
            // the topup of nonces, and proactively kick a refill.
            seedEmptyBackoffUntil = Date.now() + SEED_EMPTY_BACKOFF_S * 1000;
            maybeAutoTopupSeeds().catch(() => {});
            if (Date.now() - lastSeedEmptyLog > 30000) {
              console.warn(`[reveal-bot] ${gameLabel} start reverted (empty seed pool?) — backing off ${SEED_EMPTY_BACKOFF_S}s + kicking seed topup`);
              lastSeedEmptyLog = Date.now();
            }
          } else console.warn(`[reveal-bot] start ${gameLabel}: ${msg}`);
        }
      };
      // Only act if we have at least one round in history; bootstrap below.
      try {
        const crashTotal = Number(await casino.totalCrashRounds());
        if (crashTotal === 0) {
          const tx = await casino.startCrashRound();
          await tx.wait();
          console.log(`[reveal-bot] bootstrapped first crash round tx=${tx.hash}`);
        } else {
          await startIfNoOpen("crash", "currentCrashRoundId", "getCrashRound", "refundCrashRound");
        }
      } catch (e) { console.warn(`[reveal-bot] crash keepalive: ${e.shortMessage || e.message}`); }
      try {
        const rouletteTotal = Number(await casino.totalRouletteRounds());
        if (rouletteTotal === 0) {
          const tx = await casino.startRouletteRound();
          await tx.wait();
          console.log(`[reveal-bot] bootstrapped first roulette round tx=${tx.hash}`);
        } else {
          await startIfNoOpen("roulette", "currentRouletteRoundId", "getRouletteRound", "refundRouletteRound");
        }
      } catch (e) { console.warn(`[reveal-bot] roulette keepalive: ${e.shortMessage || e.message}`); }
    }
  };

  // Wire the WS push handlers' trigger to the real loop now that it exists.
  //
  // LEADING-EDGE DEBOUNCE: the first WS event fires the loop IMMEDIATELY
  // (no added latency); any subsequent triggers within COOLDOWN_MS are
  // dropped because the loop is already mid-flight or just finished and
  // re-running would just hit the same on-chain state. We track when the
  // last loop finished and refuse to start a new one inside the cooldown.
  // Net: zero added latency on the critical-path event; ~10 sweeps/sec
  // ceiling even under WS flood. RPC stays well under timeout pressure.
  const WS_COOLDOWN_MS = parseInt(process.env.WS_COOLDOWN_MS || "150", 10);
  let loopRunning = false;
  let lastLoopEndedAt = 0;
  let pendingTrigger = false;
  triggerLoop = () => {
    const now = Date.now();
    if (loopRunning) { pendingTrigger = true; return; }
    if (now - lastLoopEndedAt < WS_COOLDOWN_MS) { pendingTrigger = true; return; }
    loopRunning = true;
    pendingTrigger = false;
    loop()
      .catch((e) => console.warn(`[reveal-bot] loop(ws): ${e.message}`))
      .finally(() => {
        loopRunning = false;
        lastLoopEndedAt = Date.now();
        // If a trigger came in while we were running, schedule a follow-up.
        if (pendingTrigger) {
          pendingTrigger = false;
          setTimeout(() => triggerLoop(), Math.max(0, WS_COOLDOWN_MS - (Date.now() - lastLoopEndedAt)));
        }
      });
  };

  // ───────────────── DEPLOYER GAS AUTO-TOPUP FROM HM ─────────────────
  // Each revealAndSettle / refundExpired costs ~0.0001 STT in gas. Over a
  // few hundred spins this drains the deployer's float and bets start to
  // expire un-settled (chain hands the locked reserve back only after the
  // 256-block BLOCKHASH_WINDOW). To prevent that, periodically check the
  // signer's balance and pull a small amount from HM if it's low. HM
  // bond floor is the Reactivity precompile minimum (32 STT) - we leave
  // a 0.1 STT margin above it.
  const HM_FLOOR_BUF = ethers.parseEther("32.1");
  const DEPLOYER_LOW = ethers.parseEther("0.2");   // refill when below this
  const DEPLOYER_HIGH = ethers.parseEther("1.0");  // refill up to this
  let lastTopupCheckAt = 0;
  const TOPUP_CHECK_MS = 30_000;
  const maybeTopup = async () => {
    const now = Date.now();
    if (now - lastTopupCheckAt < TOPUP_CHECK_MS) return;
    lastTopupCheckAt = now;
    try {
      const [dep, hmBal] = await Promise.all([
        provider.getBalance(signer.address),
        provider.getBalance(manifest.addresses.houseManager),
      ]);
      if (dep >= DEPLOYER_LOW) return;
      const need = DEPLOYER_HIGH - dep;
      const room = hmBal > HM_FLOOR_BUF ? (hmBal - HM_FLOOR_BUF) : 0n;
      if (room > 0n) {
        // Preferred source: HM surplus above the Reactivity floor.
        const amt = need < room ? need : room;
        const hmContract = await ethers.getContractAt("HouseManager", manifest.addresses.houseManager, signer);
        const tx = await hmContract.withdrawTo(signer.address, amt);
        await tx.wait();
        console.log(`[reveal-bot] gas auto-topup: pulled ${ethers.formatEther(amt)} STT from HM → deployer (tx=${tx.hash})`);
        return;
      }
      // FALLBACK: HM is at its floor. Without a second source the signer drains
      // to zero and EVERY round/bet settle stops (the wheel froze for hours
      // exactly this way). The bot's signer is the Casino owner, so pull gas
      // from the casino bankroll via the (zero-delay) owner-withdraw. Leave a
      // generous bankroll cushion so we never strand player payouts.
      const free = await casino.freeBankroll().catch(() => 0n);
      const BANKROLL_CUSHION = ethers.parseEther("5");
      const bankRoom = free > BANKROLL_CUSHION ? (free - BANKROLL_CUSHION) : 0n;
      if (bankRoom === 0n) {
        console.warn(`[reveal-bot] deployer low (${ethers.formatEther(dep)} STT); HM at floor AND casino bankroll thin (${ethers.formatEther(free)} STT) - top up manually`);
        return;
      }
      const amt = need < bankRoom ? need : bankRoom;
      try {
        let tx = await casino.scheduleOwnerWithdraw(amt); await tx.wait();
        tx = await casino.executeOwnerWithdraw(); await tx.wait();
        console.log(`[reveal-bot] gas auto-topup (fallback): pulled ${ethers.formatEther(amt)} STT from casino bankroll → deployer (tx=${tx.hash})`);
      } catch (e) {
        console.warn(`[reveal-bot] casino-bankroll gas fallback failed: ${e.shortMessage || e.message}`);
      }
    } catch (e) {
      console.warn(`[reveal-bot] gas auto-topup failed: ${e.shortMessage || e.message}`);
    }
  };

  // ============== HOUSE-MANAGER AGENT-BUDGET AUTO-REFILL ==============
  // The HM pays for every agent call (player decisions via inferToolsChat,
  // competitor RTP via the JSON agent, RTP-analysis + news via the LLM agent).
  // Its balance must stay ABOVE the Reactivity subscription floor (32 STT) by
  // enough to cover a tick's worth of calls, otherwise createRequest reverts
  // with "insufficient-balance" and EVERY agent goes silent. The bot's signer
  // is the casino owner, so when the HM dips below the working floor we pull
  // free bankroll surplus from the casino (zero-delay owner-withdraw) and
  // forward it to the HM, keeping a generous casino payout cushion. This makes
  // the agent budget self-sustaining: no manual top-ups, no agents stalling.
  const HM_REFILL_FLOOR  = ethers.parseEther(process.env.HM_REFILL_FLOOR  || "38"); // refill when HM < this (6 above the 32 floor)
  const HM_REFILL_TARGET = ethers.parseEther(process.env.HM_REFILL_TARGET || "48"); // top HM up to this
  const CASINO_MIN_KEEP  = ethers.parseEther(process.env.CASINO_MIN_KEEP  || "40"); // never pull casino free bankroll below this
  let lastHMRefillAt = 0;
  const HM_REFILL_CHECK_MS = 60_000;
  const maybeRefillHM = async () => {
    // DISABLED: pulling casino bankroll into the HM trips the on-chain circuit
    // breaker (it reads a sharp freeBankroll drop as a loss and pauses every
    // game) and spends player-payout funds on agent compute. With the agent
    // fee subsidy at 0 the HM only pays for its own hourly news/RTP/competitor
    // calls (~1 STT/hour), so a one-time top-up lasts many hours - it does not
    // need an aggressive auto-pull. The HM is a house-operations budget, funded
    // directly, kept separate from the payout bankroll. A safe re-enable would
    // require a casino whose breaker excludes owner-withdrawals.
    return;
    // eslint-disable-next-line no-unreachable
    const now = Date.now();
    if (now - lastHMRefillAt < HM_REFILL_CHECK_MS) return;
    lastHMRefillAt = now;
    try {
      const hmBal = await provider.getBalance(manifest.addresses.houseManager);
      if (hmBal >= HM_REFILL_FLOOR) return; // HM healthy, nothing to do
      const need = HM_REFILL_TARGET - hmBal;
      const free = await casino.freeBankroll().catch(() => 0n);
      const room = free > CASINO_MIN_KEEP ? (free - CASINO_MIN_KEEP) : 0n;
      if (room === 0n) {
        console.warn(`[reveal-bot] HM agent budget low (${ethers.formatEther(hmBal)} STT) but casino free bankroll at cushion (${ethers.formatEther(free)} STT) - manual refill needed`);
        return;
      }
      const amt = need < room ? need : room;
      // casino free bankroll -> deployer (owner) -> HM. Owner-withdraw is zero-delay.
      let tx = await casino.scheduleOwnerWithdraw(amt); await tx.wait();
      tx = await casino.executeOwnerWithdraw(); await tx.wait();
      tx = await signer.sendTransaction({ to: manifest.addresses.houseManager, value: amt }); await tx.wait();
      console.log(`[reveal-bot] HM agent-budget refill: moved ${ethers.formatEther(amt)} STT casino -> HM (HM ${ethers.formatEther(hmBal)} -> ~${ethers.formatEther(hmBal + amt)} STT, tx=${tx.hash})`);
    } catch (e) {
      console.warn(`[reveal-bot] HM auto-refill failed: ${e.shortMessage || e.message}`);
    }
  };

  // ───────────────── DEDICATED FAST ROUND-SETTLER ─────────────────
  // The main loop() does a lot (scan + per-bet sweep + keepalive) and can run
  // late, but round games have a HARD ~26s deadline (256 blocks at 0.1s/block)
  // from commit to settle, and the bet window eats the first ~10s of that. So
  // round settle gets its own tight, self-contained ticker that does ONLY:
  // read the current crash+roulette round, and if its window has closed, it's
  // unsettled, and the entropy block has NOT expired -> settle it immediately.
  // No pending map, no scan dependency. This is what guarantees a real result
  // instead of a timeout-refund (result 0).
  // Settle ONE specific round id if it is closed, unsettled and not yet expired.
  const fastSettleRound = async (label, getFn, settleFn, id, blk) => {
    let r;
    try { r = await casino[getFn](id); } catch (_) { return; }
    if (r.settled) return;
    // Gate on the CHAIN clock + block age, never on Date.now(). The contract
    // closes the window when block.timestamp >= betWindowEnd, and the Railway
    // server's wall-clock can drift seconds from chain time - gating on
    // Date.now() made the settler think the window was "still open" until its
    // clock caught up, by which point the entropy block (age 257) had already
    // expired -> forced refund -> result 0. Using the latest block's timestamp
    // removes that skew entirely.
    const chainNow = Number(blk.timestamp);
    if (chainNow < Number(r.betWindowEnd)) return;    // window still open (chain time)
    const age = BigInt(blk.number) - BigInt(r.commitBlock);
    if (age <= REVEAL_DELAY) return;                  // not revealable yet
    if (age > REVEAL_DELAY + BLOCKHASH_WINDOW) return;// expired -> main loop refunds
    const seed = seedStore.get(Number(r.seedIdx));
    if (!seed) return;
    try {
      const tx = await casino[settleFn](id, seed);   // no await wait(): stay snappy
      console.log(`[reveal-bot] fast-settle ${label} round ${id} tx=${tx.hash} (age=${age})`);
    } catch (e) {
      const msg = e.shortMessage || e.message;
      if (!/RoundAlreadySettled|RevealTooEarly|RoundClosed/.test(msg)) {
        console.warn(`[reveal-bot] fast-settle ${label} ${id}: ${msg}`);
      }
    }
  };
  // Settle the current round AND the previous one. The keepalive opens round
  // N+1 the instant round N's window closes, which advances currentRoundId -
  // so a settler that only looked at "current" ORPHANED the just-closed round
  // N to the slow main-loop path, and N aged past the 257-block blockhash
  // window before it settled => result 0 every time. Checking id and id-1 each
  // tick guarantees the closed round gets settled inside its window.
  const fastSettleOne = async (label, currentFn, getFn, settleFn) => {
    let id, blk;
    try {
      id = Number(await casino[currentFn]());
      blk = await provider.getBlock("latest");
    } catch (_) { return; }
    if (id >= 1) await fastSettleRound(label, getFn, settleFn, id - 1, blk);
    await fastSettleRound(label, getFn, settleFn, id, blk);
  };
  let fastBusy = false;
  const FAST_SETTLE_MS = parseInt(process.env.FAST_SETTLE_MS || "1000", 10);
  const fastSettleTick = async () => {
    if (fastBusy) return; fastBusy = true;
    try {
      await fastSettleOne("roulette", "currentRouletteRoundId", "getRouletteRound", "settleRouletteRound");
      await fastSettleOne("crash", "currentCrashRoundId", "getCrashRound", "settleCrashRound");
    } catch (_) {} finally { fastBusy = false; }
  };

  // ADAPTIVE circuit-breaker recovery. The casino's on-chain breaker is a real
  // risk feature we KEEP: a >20% free-bankroll drop in an hour halts the whole
  // floor to stop the bleeding. The problem was only that it stayed frozen
  // forever. So instead of defeating it, we make RECOVERY intelligent, like a
  // market trading halt: when the breaker trips the keeper holds the halt for a
  // cooldown, then reopens the floor ONLY once the bankroll has stopped
  // dropping AND sits above a healthy floor. Sharp loss -> timed halt ->
  // auto-resume when stable; if the bankroll is genuinely depleted it STAYS
  // halted until it is funded. (The House Manager's RTP / max-bet flex is the
  // graceful first line of defence; this is the hard stop with smart recovery.)
  const HALT_COOLDOWN_MS = +(process.env.HALT_COOLDOWN_MS || 90_000);
  const MIN_HEALTHY_BANKROLL = ethers.parseEther(process.env.MIN_HEALTHY_BANKROLL || "20");
  let haltSince = 0;
  let haltBankroll = 0n;
  let lastHaltLog = 0;
  let lastRecoveryCheck = 0;
  const maybeUnpauseGames = async () => {
    const now = Date.now();
    if (now - lastRecoveryCheck < 12_000) return;
    lastRecoveryCheck = now;
    // breaker pauses games 0..5; check if any are halted
    let anyPaused = false;
    // Skip intentionally-disabled round games (e.g. crash off on testnet): a
    // deliberate pause there must NOT look like a tripped circuit breaker, or
    // the bot would report a perpetual "CIRCUIT HALT".
    for (let g = 0; g < 6; g++) { if (roundGameDisabled(g)) continue; try { if (await casino.gamePaused(g)) { anyPaused = true; break; } } catch {} }
    if (!anyPaused) { haltSince = 0; return; }
    const free = await casino.freeBankroll().catch(() => 0n);
    if (haltSince === 0) {
      haltSince = now;
      haltBankroll = free;
      console.log(`[reveal-bot] CIRCUIT HALT: breaker tripped, freeBankroll=${ethers.formatEther(free)} STT. holding the floor ${HALT_COOLDOWN_MS / 1000}s before assessing recovery.`);
      return;
    }
    const cooled = now - haltSince >= HALT_COOLDOWN_MS;
    const stabilized = free >= (haltBankroll * 999n) / 1000n; // not still bleeding
    const healthy = free >= MIN_HEALTHY_BANKROLL;
    if (cooled && stabilized && healthy) {
      for (let g = 0; g < 7; g++) {
        if (roundGameDisabled(g)) continue; // leave intentionally-off round games (crash/roulette) paused
        try { if (await casino.gamePaused(g)) { const tx = await casino.unpauseGame(g); await tx.wait(); } }
        catch (e) { console.warn(`[reveal-bot] reopen game ${g}: ${e.shortMessage || e.message}`); }
      }
      console.log(`[reveal-bot] CIRCUIT RECOVERED: bankroll stable at ${ethers.formatEther(free)} STT - floor reopened.`);
      haltSince = 0;
    } else if (now - lastHaltLog > 30_000) {
      lastHaltLog = now;
      console.log(`[reveal-bot] holding halt (cooled=${cooled} stabilized=${stabilized} healthy=${healthy} free=${ethers.formatEther(free)}/${ethers.formatEther(MIN_HEALTHY_BANKROLL)} STT).`);
    }
  };

  console.log(`[reveal-bot] running (poll=${POLL_MS}ms, fast-settle=${FAST_SETTLE_MS}ms, keepalive=${ROUND_KEEPALIVE}, ws=${wsProvider ? "on" : "off"}, gas-autopilot=on, circuit-recovery=on)`);
  await loop();
  await maybeTopup();
  await maybeRefillHM();
  await maybeUnpauseGames();
  // PREVENTION layer: heartbeat + per-iteration timeout + single-flight guard.
  // lastLoopOkAt = last SUCCESSFUL loop() completion (the watchdog below
  // restarts if it goes stale). The timeout is what stops the loop from
  // wedging in the first place: a hung RPC/WS await can't freeze it forever -
  // the iteration rejects after LOOP_TIMEOUT_MS, the busy flag clears, and the
  // next tick retries fresh. So a transient endpoint blip self-corrects WITHOUT
  // a restart; only a persistent stall trips the watchdog. pollBusy prevents
  // overlapping iterations piling up while one is slow.
  let lastLoopOkAt = Date.now();
  let pollBusy = false;
  const LOOP_TIMEOUT_MS = parseInt(process.env.LOOP_TIMEOUT_MS || "30000", 10);
  setInterval(() => {
    if (!pollBusy) {
      pollBusy = true;
      Promise.race([
        loop(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("loop iteration timeout")), LOOP_TIMEOUT_MS)),
      ])
        .then(() => { lastLoopOkAt = Date.now(); })
        .catch((e) => console.warn(`[reveal-bot] loop: ${e.message || e}`))
        .finally(() => { pollBusy = false; });
    }
    maybeTopup().catch(() => {});
    maybeRefillHM().catch(() => {});
    maybeUnpauseGames().catch(() => {});
  }, POLL_MS);
  setInterval(() => { fastSettleTick().catch(() => {}); }, FAST_SETTLE_MS);

  // ── WATCHDOG: self-restart on a SILENT stall ─────────────────────────
  // Root cause of the recurring outages: the settle loop can wedge on a hung
  // RPC/WS await WITHOUT the process crashing. Railway's ON_FAILURE restart
  // policy never fires (the process didn't exit), so the bot stays "Online"
  // but dead — bets stop settling, expired-bet refunds stop, so stuck cluster
  // bets keep their (huge) maxPayout reserve locked and freeBankroll → 0 →
  // the whole casino freezes; the on-chain hourly cron also never gets its
  // watchdog reboot. We detect the wedge by the heartbeat above and exit
  // non-zero so the host restarts a clean process (which re-scans, refunds
  // expired bets to release reserve, resumes settling + roulette + the cron
  // watchdog). Normal loops finish in well under a second, so a multi-minute
  // gap is unambiguously a hang — no false positives when merely idle.
  const STALL_EXIT_MS = parseInt(process.env.STALL_EXIT_MS || "300000", 10); // 5 min
  setInterval(() => {
    const idle = Date.now() - lastLoopOkAt;
    if (idle > STALL_EXIT_MS) {
      console.error(`[reveal-bot] WATCHDOG: settle loop stalled ${Math.round(idle / 1000)}s — exiting(1) for a clean restart`);
      process.exit(1);
    }
  }, 30_000);

  await new Promise(() => {});
}

// Survive transient RPC/socket errors (undici ConnectTimeoutError etc.) on a
// flaky testnet RPC. Without this, one unhandled network blip exits the process
// and `concurrently --kill-others-on-fail` drops the WHOLE stack (seed pool then
// drains → NoSeedAvailable → bets revert). Log and keep running; the poll loop
// retries every tick.
process.on("unhandledRejection", (e) => {
  console.warn(`[reveal-bot] unhandledRejection (continuing): ${(e && (e.shortMessage || e.message)) || e}`);
});
process.on("uncaughtException", (e) => {
  const msg = (e && (e.shortMessage || e.message)) || String(e);
  if (/timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|network|fetch failed|Connect Timeout/i.test(msg)) {
    console.warn(`[reveal-bot] recovered from transient network error (continuing): ${msg}`);
  } else {
    console.error(`[reveal-bot] uncaughtException (continuing): ${msg}`);
  }
});

main().catch((e) => { console.error(e); process.exit(1); });
