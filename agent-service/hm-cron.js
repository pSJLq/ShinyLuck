// Autonomous House Manager cron - runs alongside the API service. Owns a
// distinct hot key (HM_PRIVATE_KEY) registered as the casino's hmAgent so it
// can call setGameMaxBet, activateBonusMode, pauseGame, recordReasoning,
// triggerThemeRotation, and provisionSeedHashes.
//
// Tick cadence:
//   - every 5 min  : rebalance per-game max bet to 1% of free bankroll
//   - every 60 min : check 1h bankroll delta → bonus mode or pause
//   - every 24h    : rotate slots theme
//
// All decisions are recorded on-chain via recordReasoning(...) for auditability.
// The reasoning text is a one-line summary; when SOMNIA_LLM_URL is set we POST
// a prompt to the Somnia LLM Inference Agent for richer narration (free-text
// from the agent layer is *cosmetic only* - the action itself is deterministic).
//
// Run:   node hm-cron.js
//   or:  pm2 start hm-cron.js --name hm-agent

const path = require("path");
// Load .env from this script's directory, not cwd - dev:play runs us from
// repo root where there's a different .env that doesn't have our keys.
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { ethers } = require("ethers");
const fs = require("fs");
const crypto = require("crypto");

// Canonical Somnia infra HTTP endpoint per emrestay's examples - more
// reliable than the public dream-rpc.somnia.network mirror.
const RPC = process.env.RPC_URL || "https://api.infra.testnet.somnia.network";
const HM_KEY = process.env.HM_PRIVATE_KEY || process.env.RELAYER_KEY;
const HM_ADDR = process.env.HM_ADDRESS;
const CASINO_ADDR = process.env.CASINO_ADDRESS;
const LLM_URL = process.env.SOMNIA_LLM_URL; // optional - POST {prompt} → {text}
const NETWORK = process.env.NETWORK_NAME || "somniaTestnet";

const TICK_MS = parseInt(process.env.HM_TICK_INTERVAL_MS, 10) || 60 * 1000;
const MAXBET_PERIOD = parseInt(process.env.HM_MAXBET_PERIOD_MS, 10) || 5 * 60 * 1000;
const BANKROLL_PERIOD = parseInt(process.env.HM_BANKROLL_PERIOD_MS, 10) || 60 * 60 * 1000;
const THEME_PERIOD = parseInt(process.env.HM_THEME_PERIOD_MS, 10) || 24 * 60 * 60 * 1000;
const SEED_REFILL_THRESHOLD = parseInt(process.env.HM_SEED_REFILL_THRESHOLD, 10) || 50;
const SEED_REFILL_BATCH = parseInt(process.env.HM_SEED_REFILL_BATCH, 10) || 200;
// Path where new seeds get appended; reveal-bot hot-reads this file each tick.
const POOL_FILE = path.join(__dirname, "..", "deployments", "seeds", `${NETWORK}-pool.json`);

const GAMES = ["DICE","CRASH","SLOTS","MINES","PLINKO","ROULETTE"];

if (!HM_KEY || !CASINO_ADDR || !HM_ADDR) {
  console.error("[hm-cron] missing HM_PRIVATE_KEY / CASINO_ADDRESS / HM_ADDRESS in .env");
  process.exit(1);
}

function loadAbi(name) {
  const p = path.join(__dirname, "..", "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  return JSON.parse(fs.readFileSync(p, "utf8")).abi;
}

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(HM_KEY, provider);
const casino = new ethers.Contract(CASINO_ADDR, loadAbi("Casino"), wallet);
const hm = new ethers.Contract(HM_ADDR, loadAbi("HouseManager"), wallet);

const STATE_FILE = path.join(__dirname, "data", "hm-state.json");
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch (_) { return { lastMaxBet: 0, lastBankroll: 0, lastTheme: 0, hourStartBankroll: null }; }
}
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

async function llmNarrate(promptText) {
  if (!LLM_URL) return null;
  try {
    const r = await fetch(LLM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: promptText, max_tokens: 100 }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return (j.text || j.response || "").slice(0, 280) || null;
  } catch (e) {
    console.warn("[hm-cron] LLM error:", e.message);
    return null;
  }
}

async function rebalanceMaxBets(state) {
  const bankroll = await casino.freeBankroll();
  // 1% of free bankroll, with a sane floor (0.01 STT) so we never set 0.
  const minBet = ethers.parseEther("0.01");
  let target = bankroll / 100n;
  if (target < minBet) target = minBet;

  const wei = (g) => casino.gameMaxBet(g);
  const current = await Promise.all([0,1,2,3,4,5].map(wei));
  const tasks = [];
  for (let g = 0; g < 6; g++) {
    if (current[g] !== target) {
      tasks.push((async () => {
        try {
          const tx = await hm.setGameMaxBet(g, target);
          await tx.wait();
          console.log(`[hm-cron] setGameMaxBet(${GAMES[g]}, ${ethers.formatEther(target)} STT) tx=${tx.hash}`);
        } catch (e) {
          console.warn(`[hm-cron] setGameMaxBet(${GAMES[g]}) failed:`, e.shortMessage || e.message);
        }
      })());
    }
  }
  await Promise.all(tasks);
  if (tasks.length > 0) {
    const reasoning =
      (await llmNarrate(`The casino bankroll is ${ethers.formatEther(bankroll)} STT. As House Manager Agent, briefly justify resizing per-game maxBet to 1% of bankroll (${ethers.formatEther(target)} STT) in one short sentence.`)) ||
      `Bankroll ${ethers.formatEther(bankroll)} STT → maxBet rebalanced to 1% (${ethers.formatEther(target)} STT) across all games.`;
    try {
      const tx = await hm.recordReasoning(reasoning);
      await tx.wait();
    } catch (_) {}
  }
  state.lastMaxBet = Date.now();
  state.lastBankroll = bankroll.toString();
  saveState(state);
}

async function bankrollSwingCheck(state) {
  // Use the TOTAL casino balance, NOT freeBankroll(). freeBankroll subtracts
  // the locked reserve of every in-flight bet, so it dives sharply the instant
  // a player places a bet (e.g. 84 -> 4 STT while a max-payout reserve is held)
  // and snaps back when it settles. Sampling that mid-bet read the dip as a
  // phantom >20% "drop" and paused every game. Total balance only moves on a
  // real win payout / deposit / withdraw, so it is the honest hour-over-hour
  // house P&L signal.
  const bankroll = await provider.getBalance(CASINO_ADDR);
  // Reset the baseline if it is missing, stale, OR was captured against a
  // DIFFERENT casino. Without the casino-address guard a redeploy carried the
  // old casino's higher bankroll baseline into the fresh one, so the very first
  // hourly tick saw a phantom >20% "drop" and paused every game (only Sugar,
  // on the cluster path, kept working). That is exactly the bug that took the
  // whole board offline.
  if (state.hourStartBankroll === null || state.hourStartTs === undefined ||
      state.hourStartCasino !== CASINO_ADDR ||
      Date.now() - state.hourStartTs > BANKROLL_PERIOD) {
    state.hourStartBankroll = bankroll.toString();
    state.hourStartTs = Date.now();
    state.hourStartCasino = CASINO_ADDR;
    saveState(state);
    return;
  }
  const startBR = BigInt(state.hourStartBankroll);
  if (startBR === 0n) {
    state.hourStartBankroll = bankroll.toString();
    state.hourStartTs = Date.now();
    state.hourStartCasino = CASINO_ADDR;
    saveState(state);
    return;
  }
  // bps signed change
  const diff = bankroll - startBR;
  const absBps = (diff < 0n ? -diff : diff) * 10000n / startBR;
  if (diff > 0n && absBps >= 1000n) {
    // +10% over the window → bonus mode 60 min
    const reason =
      (await llmNarrate(`The house took +${ethers.formatEther(diff)} STT (${absBps}bps) in the past hour. As House Manager Agent, briefly justify activating Bonus Mode (house edge × 0.5) for 60 minutes to give it back to players.`)) ||
      `+${ethers.formatEther(diff)} STT (${Number(absBps)/100}%) in 60min → activating Bonus Mode for players.`;
    try {
      const tx = await hm.activateBonusMode(60, reason);
      await tx.wait();
      console.log(`[hm-cron] activateBonusMode 60 min - reason: ${reason}`);
    } catch (e) {
      console.warn("[hm-cron] activateBonusMode failed:", e.shortMessage || e.message);
    }
    state.hourStartBankroll = bankroll.toString();
    state.hourStartTs = Date.now();
    saveState(state);
  } else if (diff < 0n && absBps >= 2000n && (-diff) >= ethers.parseEther("10")) {
    // −20% over the window AND a real ≥10 STT loss → pause all games. The
    // absolute floor stops a tiny swing (or a stale/cross-deploy baseline) from
    // taking the whole board offline; pausing everything is a heavy action that
    // should only fire on a genuinely large drawdown the operator must review.
    const reason =
      (await llmNarrate(`The house lost ${ethers.formatEther(-diff)} STT (${absBps}bps) in the past hour. As House Manager Agent, briefly justify pausing all games for operator review.`)) ||
      `-${ethers.formatEther(-diff)} STT (${Number(absBps)/100}%) in 60min → pausing all games for review.`;
    for (let g = 0; g < 6; g++) {
      try { await (await hm.pauseGame(g)).wait(); }
      catch (e) { console.warn(`[hm-cron] pauseGame(${GAMES[g]})`, e.shortMessage || e.message); }
    }
    try { await (await hm.recordReasoning(reason)).wait(); } catch (_) {}
    console.log(`[hm-cron] paused all games - reason: ${reason}`);
    state.hourStartBankroll = bankroll.toString();
    state.hourStartTs = Date.now();
    saveState(state);
  }
}

// ---------------------------------------------------------------------------
// Seed pool refill - most critical job. Casino consumes one hash per bet AND
// one per round (Crash/Roulette), so a 200-batch evaporates in <1 hour of
// real play. Without refill, every game starts reverting `NoSeedAvailable`
// and reveal-bot's "start crash/roulette" calls fail.
//
// Layout: we maintain a shared `<network>-pool.json` { idx: seed } so the
// reveal-bot can hot-read new seeds without restart. The contract's
// `nextHashIndex` is our cursor - we generate batches and append to the file.
// ---------------------------------------------------------------------------

function genSeed() { return "0x" + crypto.randomBytes(32).toString("hex"); }
function hashSeed(seed) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [seed]));
}

function loadPool() {
  try { return JSON.parse(fs.readFileSync(POOL_FILE, "utf8")); }
  catch (_) { return {}; }
}
function savePool(pool) {
  fs.mkdirSync(path.dirname(POOL_FILE), { recursive: true });
  fs.writeFileSync(POOL_FILE, JSON.stringify(pool, null, 2));
}

async function refillSeedsIfLow(state) {
  let total, consumed, available;
  try { [total, consumed, available] = await casino.seedPoolStatus(); }
  catch (e) { console.warn("[hm-cron] seedPoolStatus:", e.shortMessage || e.message); return; }
  const avail = Number(available);
  if (avail >= SEED_REFILL_THRESHOLD) return;
  console.log(`[hm-cron] seed pool low (avail=${avail}, total=${total}) → refilling ${SEED_REFILL_BATCH}`);
  const startIdx = Number(total);
  const newSeeds = [];
  const hashes = [];
  for (let i = 0; i < SEED_REFILL_BATCH; i++) {
    const s = genSeed();
    newSeeds.push(s);
    hashes.push(hashSeed(s));
  }
  // Save seeds to shared pool BEFORE the tx - if the chain accepts but our
  // disk write fails, reveal-bot would otherwise reveal with the wrong seed.
  // The contract has 256-block reveal window so we get to retry safely.
  const pool = loadPool();
  for (let i = 0; i < newSeeds.length; i++) pool[String(startIdx + i)] = newSeeds[i];
  savePool(pool);
  try {
    const tx = await hm.provisionSeedHashes(hashes);
    await tx.wait();
    console.log(`[hm-cron] provisionSeedHashes(${SEED_REFILL_BATCH}) tx=${tx.hash} idx=${startIdx}..${startIdx+SEED_REFILL_BATCH-1}`);
    const reason =
      (await llmNarrate(`As House Manager Agent, briefly note that the seed pool was refilled with ${SEED_REFILL_BATCH} new commitment hashes (one sentence).`)) ||
      `Seed pool refill: +${SEED_REFILL_BATCH} hashes (now ${startIdx + SEED_REFILL_BATCH} total).`;
    try { await (await hm.recordReasoning(reason)).wait(); } catch (_) {}
  } catch (e) {
    console.warn("[hm-cron] provisionSeedHashes failed:", e.shortMessage || e.message);
    // Roll back the disk write so we don't end up with seed indexes that
    // don't exist on-chain.
    const undo = loadPool();
    for (let i = 0; i < newSeeds.length; i++) delete undo[String(startIdx + i)];
    savePool(undo);
  }
}

async function themeRotation(state) {
  if (state.lastTheme && Date.now() - state.lastTheme < THEME_PERIOD) return;
  // Pool of theme symbol sets; LLM picks if available, else random.
  const themes = [
    { name: "Crypto Night",  symbols: ["₿", "💎", "⚡", "🌙", "🪐"] },
    { name: "Vegas Neon",    symbols: ["🍒", "🍋", "🔔", "💎", "7️⃣"] },
    { name: "Cyberpunk",     symbols: ["🌐", "🤖", "🧬", "⚙️", "🔥"] },
    { name: "Galactic",      symbols: ["🌌", "🚀", "☄️", "🛰️", "👽"] },
    { name: "Mythic",        symbols: ["🐉", "🦄", "🗡️", "🛡️", "🔮"] },
  ];
  const pick = themes[Math.floor(Math.random() * themes.length)];
  try {
    const tx = await hm.triggerThemeRotation(pick.name, pick.symbols);
    await tx.wait();
    const reason =
      (await llmNarrate(`As the ShinyLuck House Manager Agent, briefly announce the new daily slots theme: "${pick.name}". One short sentence, marketing tone.`)) ||
      `Daily slots theme rotated → "${pick.name}".`;
    try { await (await hm.recordReasoning(reason)).wait(); } catch (_) {}
    console.log(`[hm-cron] triggerThemeRotation(${pick.name}) tx=${tx.hash}`);
  } catch (e) {
    console.warn("[hm-cron] triggerThemeRotation failed:", e.shortMessage || e.message);
  }
  state.lastTheme = Date.now();
  saveState(state);
}

async function tick() {
  const state = loadState();
  // Seed refill is the most important - run it on every tick (every 60s) so
  // the pool never drops below SEED_REFILL_THRESHOLD. The rest only fire on
  // their own cadence.
  await refillSeedsIfLow(state).catch((e) => console.warn("[hm-cron] seed refill:", e.message));
  const tasks = [];
  if (!state.lastMaxBet || Date.now() - state.lastMaxBet > MAXBET_PERIOD) {
    tasks.push(rebalanceMaxBets(state).catch((e) => console.warn("[hm-cron] rebalance:", e.message)));
  }
  tasks.push(bankrollSwingCheck(state).catch((e) => console.warn("[hm-cron] swing:", e.message)));
  tasks.push(themeRotation(state).catch((e) => console.warn("[hm-cron] theme:", e.message)));
  await Promise.all(tasks);
}

(async () => {
  console.log("[hm-cron] starting - wallet:", await wallet.getAddress());
  console.log("[hm-cron] HM contract:", HM_ADDR, "Casino:", CASINO_ADDR);
  // Best-effort initial tick to surface any config issues immediately.
  try { await tick(); } catch (e) { console.error("[hm-cron] initial tick:", e.message); }
  setInterval(() => {
    tick().catch((e) => console.error("[hm-cron] tick:", e.message));
  }, TICK_MS);
})();
