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
// time) and the shared HM-cron pool file (sparse { idx: seed } map). The pool
// file is reread before every lookup so refills land without a restart.
function makeSeedStore({ initialSeedsFile, poolFile }) {
  const initial = initialSeedsFile && fs.existsSync(initialSeedsFile)
    ? JSON.parse(fs.readFileSync(initialSeedsFile, "utf8")).seeds || []
    : [];
  console.log(`[reveal-bot] loaded ${initial.length} initial seeds from ${initialSeedsFile}`);
  if (poolFile) console.log(`[reveal-bot] watching pool file: ${poolFile}`);
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
      refreshPool();
      const i = Number(idx);
      if (poolArray[i]) return poolArray[i];
      if (i < initial.length) return initial[i];
      return null;
    },
    refresh: refreshPool,
  };
}

async function main() {
  const seedsFile = process.env.SEEDS_FILE;
  const poolFile = path.join(__dirname, "..", "deployments", "seeds", `${network.name}-pool.json`);
  const seedStore = makeSeedStore({ initialSeedsFile: seedsFile, poolFile });

  const manifestPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const casinoAddr = manifest.addresses.casino;

  const Casino = await ethers.getContractFactory("Casino");
  const casino = Casino.attach(casinoAddr);
  const [signer] = await ethers.getSigners();
  const provider = ethers.provider;
  console.log(`[reveal-bot] signer=${signer.address} casino=${casinoAddr} network=${network.name}`);

  const topics = {
    betPlaced:           casino.interface.getEvent("BetPlaced").topicHash,
    crashRoundStarted:   casino.interface.getEvent("CrashRoundStarted").topicHash,
    rouletteRoundStarted:casino.interface.getEvent("RouletteRoundStarted").topicHash,
  };

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

  const loop = async () => {
    let cur;
    try { cur = BigInt(await provider.getBlockNumber()); }
    catch (e) { console.warn(`[reveal-bot] getBlockNumber: ${e.message}`); return; }

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

    const nowSec = Math.floor(Date.now() / 1000);

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
    for (const [key, info] of pendingRounds) {
      const age = cur - info.commitBlock;
      if (age < 0n) continue;
      // First - check if the round is already settled on-chain (some other
      // caller may have done it).
      let roundState;
      try {
        roundState = info.kind === "crash"
          ? await casino.getCrashRound(info.roundId)
          : await casino.getRouletteRound(info.roundId);
      } catch (_) { roundState = null; }
      if (roundState && roundState.settled) { pendingRounds.delete(key); continue; }

      // Try settle when window closed + REVEAL_DELAY blocks elapsed.
      const windowClosed = nowSec >= info.betWindowEnd;
      const readyToReveal = age > REVEAL_DELAY;
      if (windowClosed && readyToReveal) {
        const seed = seedStore.get(info.seedIdx);
        if (!seed) {
          // No seed yet - HM cron will refill; keep this round around.
          continue;
        }
        const fn = info.kind === "crash" ? "settleCrashRound" : "settleRouletteRound";
        try {
          const tx = await casino[fn](info.roundId, seed);
          await tx.wait();
          console.log(`[reveal-bot] settled ${info.kind} round ${info.roundId} tx=${tx.hash}`);
          pendingRounds.delete(key);
          continue;
        } catch (e) {
          const msg = e.shortMessage || e.message;
          if (/RoundAlreadySettled/.test(msg)) { pendingRounds.delete(key); continue; }
          // Try refund path below only on RevealExpired (256-block window).
          if (!/RevealExpired/.test(msg)) {
            // RevealTooEarly / RoundClosed → wait next tick
            continue;
          }
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
        pendingRounds.delete(key);
      }
    }

    // 4. Round keepalive - make sure there's always an open Crash + Roulette
    //    round so players can hop in.
    if (ROUND_KEEPALIVE) {
      const startIfNoOpen = async (gameLabel, currentFn, hasFn) => {
        try {
          const id = await casino[currentFn]();
          const round = await casino[hasFn](id);
          // round is open if betWindowEnd > now AND not settled
          if (!round.settled && Number(round.betWindowEnd) > nowSec) return; // open, no-op
          if (Number(round.betWindowEnd) === 0) return; // race - wait
        } catch (_) { /* never started - proceed */ }
        try {
          const startFn = gameLabel === "crash" ? "startCrashRound" : "startRouletteRound";
          const tx = await casino[startFn]();
          await tx.wait();
          console.log(`[reveal-bot] opened new ${gameLabel} round tx=${tx.hash}`);
        } catch (e) {
          const msg = e.shortMessage || e.message;
          if (/RoundClosed|NoSeedAvailable|GameIsPaused/.test(msg)) {/* ok */}
          else console.warn(`[reveal-bot] start ${gameLabel}: ${msg}`);
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
          await startIfNoOpen("crash", "currentCrashRoundId", "getCrashRound");
        }
      } catch (e) { console.warn(`[reveal-bot] crash keepalive: ${e.shortMessage || e.message}`); }
      try {
        const rouletteTotal = Number(await casino.totalRouletteRounds());
        if (rouletteTotal === 0) {
          const tx = await casino.startRouletteRound();
          await tx.wait();
          console.log(`[reveal-bot] bootstrapped first roulette round tx=${tx.hash}`);
        } else {
          await startIfNoOpen("roulette", "currentRouletteRoundId", "getRouletteRound");
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
      if (room === 0n) {
        console.warn(`[reveal-bot] deployer low (${ethers.formatEther(dep)} STT) but HM at floor - top up manually`);
        return;
      }
      const amt = need < room ? need : room;
      const hmContract = await ethers.getContractAt("HouseManager", manifest.addresses.houseManager, signer);
      const tx = await hmContract.withdrawTo(signer.address, amt);
      await tx.wait();
      console.log(`[reveal-bot] gas auto-topup: pulled ${ethers.formatEther(amt)} STT from HM → deployer (tx=${tx.hash})`);
    } catch (e) {
      console.warn(`[reveal-bot] gas auto-topup failed: ${e.shortMessage || e.message}`);
    }
  };

  console.log(`[reveal-bot] running (poll=${POLL_MS}ms, keepalive=${ROUND_KEEPALIVE}, ws=${wsProvider ? "on" : "off"}, gas-autopilot=on)`);
  await loop();
  await maybeTopup();
  setInterval(() => {
    loop().catch((e) => console.warn(`[reveal-bot] loop: ${e.message}`));
    maybeTopup().catch(() => {});
  }, POLL_MS);
  await new Promise(() => {});
}

main().catch((e) => { console.error(e); process.exit(1); });
