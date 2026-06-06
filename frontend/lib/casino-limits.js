/* ============================================================================
 * casino-limits.js - read the live `effective max bet` from Casino and clamp
 * stake inputs across all game pages.
 *
 * Effective cap = min(gameMaxBet[g], freeBankroll * maxBetBps / 10000)
 *
 * `safeStake(rawStakeWei, maxBetWei)` applies a 5% safety margin so a small
 * drop in bankroll between the fetch and the submit (e.g. another player
 * just won) doesn't flip a borderline stake into BetTooLarge revert territory.
 * ========================================================================= */

import { ethers } from "/vendor/ethers.bundle.js";
// scripts/deploy.js auto-writes config.js with only a CONFIG export - no
// standalone CASINO_ADDRESS const. Pulling the address off CONFIG keeps the
// single source of truth and avoids the linker-time crash this used to throw
// after every redeploy ("does not provide an export named 'CASINO_ADDRESS'").
import { CONFIG } from "./config.js";
import { provider } from "./rpc.js";

const CASINO_ADDRESS = CONFIG.casino;

const CASINO_ABI = [
  "function freeBankroll() view returns (uint256)",
  "function maxBetBps() view returns (uint256)",
  "function gameMaxBet(uint8) view returns (uint256)",
  // EXPOSURE model: max payout per bet <= maxExposureBps of the pool.
  "function maxExposureBps() view returns (uint256)",
  "function vault7MaxMultX100() view returns (uint256)",
  "function clusterMaxMultX100() view returns (uint256)",
];

// Numeric ids - must match contracts/Casino.sol::GameType enum order.
export const GAME = {
  dice: 0, crash: 1, slots: 2, mines: 3, plinko: 4, roulette: 5, cluster: 6,
};

// EXPOSURE model: the contract caps a bet's max payout at maxExposureBps of the
// free pool. So the binding stake limit for a fixed-max-mult game is:
//   stake <= free * maxExposureBps / (100 * capX100)   (capX100 = max-mult ×100)
// slots/cluster max-mults are read LIVE from the contract (vault7/clusterMaxMultX100);
// mines uses the constant below. dice/crash/plinko/roulette have variable
// per-bet payouts handled by their own pre-submit logic, so they're not clamped
// here (the contract's exposure check is the backstop).
const MINES_CAP_X100 = 10000; // 100×

// Bankroll moves slowly relative to a single spin (5% safetyMargin in
// `safeStake` absorbs typical drift), so a 30s TTL is conservative even when
// other players are settling concurrently. Callers can also force a refresh
// after their own BetSettled lands via `invalidateMaxBetCache()`.
const TTL_MS = 30_000;
const cache = new Map(); // key=game id → { maxBet: bigint, ts: number }

/** Drop all cached maxBet values. Call after the player's own BetSettled
 *  fires so the next spin reads the post-settle bankroll. */
export function invalidateMaxBetCache() { cache.clear(); }

function getCasino() {
  return new ethers.Contract(CASINO_ADDRESS, CASINO_ABI, provider());
}

/**
 * Return the *effective* max bet (wei) for the named game - the min of the
 * game-specific hardcap and the bankroll-relative bps cap. Cached for 10s
 * so a page that shows the slider on every render doesn't hammer the RPC.
 *
 * @param {keyof typeof GAME} game e.g. "dice"
 * @returns {Promise<bigint>}
 */
export async function readMaxBet(game = "dice") {
  const id = GAME[game];
  if (id == null) throw new Error(`casino-limits: unknown game "${game}"`);
  const cached = cache.get(id);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.maxBet;

  const casino = getCasino();
  let mb;
  try {
    const [bankroll, bps, gMax, exposureBps] = await Promise.all([
      casino.freeBankroll(),
      casino.maxBetBps(),
      casino.gameMaxBet(id),
      casino.maxExposureBps(),
    ]);
    // Tightest of:
    //   bpsCap      : free × maxBetBps / 10000   (per-bet stake risk %)
    //   gMax        : per-game hardcap (gameMaxBet)
    //   exposureCap : free × maxExposureBps / (100 × capX100)  ← THE binding cap
    //                 for high-max-mult games (slots/cluster) under the exposure
    //                 model: keeps maxPayout ≤ maxExposureBps of the pool.
    const free = BigInt(bankroll);
    const bpsCap = (free * BigInt(bps)) / 10_000n;
    const candidates = [bpsCap];
    if (gMax > 0n) candidates.push(BigInt(gMax));
    let capX100 = null;
    if (id === GAME.slots)        capX100 = BigInt(await casino.vault7MaxMultX100());
    else if (id === GAME.cluster) capX100 = BigInt(await casino.clusterMaxMultX100());
    else if (id === GAME.mines)   capX100 = BigInt(MINES_CAP_X100);
    if (capX100 && capX100 > 0n) {
      candidates.push((free * BigInt(exposureBps)) / (100n * capX100));
    }
    mb = candidates.reduce((m, c) => (c < m ? c : m));
  } catch (e) {
    // Fallback: assume the default formula bankroll/100. Better than throwing
    // because some UIs render before wallet has finished bootstrapping.
    console.warn("[casino-limits] read failed, falling back to bankroll/100:", e?.message || e);
    const bankroll = await provider().getBalance(CASINO_ADDRESS);
    mb = bankroll / 100n;
  }
  cache.set(id, { maxBet: mb, ts: Date.now() });
  return mb;
}

/**
 * Clamp `rawStakeWei` to 95% of `maxBetWei`. The 5% margin guards against
 * a borderline stake (= exactly maxBet) reverting when freeBankroll dropped
 * by even a wei between the fetch and the submit tx.
 *
 * @param {bigint|string|number} rawStakeWei
 * @param {bigint} maxBetWei
 * @returns {bigint}
 */
export function safeStake(rawStakeWei, maxBetWei) {
  const raw = BigInt(rawStakeWei);
  const cap = (BigInt(maxBetWei) * 95n) / 100n;
  return raw > cap ? cap : raw;
}

/**
 * Read max + clamp + present a friendly toast if user asked for too much.
 * Returns the clamped value (wei) AND a boolean telling the caller whether
 * the value was reduced (so the UI can flash the input). Throws if the
 * clamped value is below `minStakeWei` - meaning the casino can't even cover
 * the minimum payout right now (rare, but possible if bankroll drained).
 *
 * @param {bigint} stakeWei
 * @param {string} game
 * @param {bigint} minStakeWei
 * @returns {Promise<{ stake: bigint, clamped: boolean, maxBet: bigint }>}
 */
export async function clampStake(stakeWei, game, minStakeWei = 100_000_000_000_000n) {
  const maxBet = await readMaxBet(game);
  const stake = safeStake(stakeWei, maxBet);
  if (stake < minStakeWei) {
    const err = new Error("Casino restocking - try smaller stake or come back soon");
    err.code = "CASINO_BANKROLL_LOW";
    throw err;
  }
  return { stake, clamped: stake !== BigInt(stakeWei), maxBet };
}

/**
 * String-in, string-out wrapper around clampStake. Returns the stake value
 * the caller should actually submit (as a decimal STT string, suitable for
 * SL.placeDice/placeCrash/etc which call ethers.parseEther internally).
 * Also fires a toast on clamp / on too-low error.
 *
 * Returns null if the stake was rejected (caller should bail out).
 *
 * @param {string} stakeStr    e.g. "0.10"
 * @param {string} game        "dice" / "crash" / ...
 * @returns {Promise<string|null>}
 */
export async function clampStakeStr(stakeStr, game) {
  const raw = ethers.parseEther(String(stakeStr));
  try {
    const { stake, clamped } = await clampStake(raw, game);
    const out = ethers.formatEther(stake);
    if (clamped) {
      const { toast } = await import("./ui.js");
      toast(`Stake clamped to ${out} STT (live casino max).`, { kind: "warn", ttl: 4000 });
    }
    return out;
  } catch (e) {
    const { toast } = await import("./ui.js");
    toast(e?.message || "Casino is restocking - try a smaller stake", { kind: "warn", ttl: 4500 });
    return null;
  }
}

// Convenience for inputs: write the snapped max attr on a stake <input>.
// Returns the same max-bet bigint for callers that also want to log it.
export async function applyMaxToInput(inputEl, game) {
  if (!inputEl) return null;
  try {
    const mb = await readMaxBet(game);
    inputEl.max = (Number(mb) / 1e18).toFixed(4);
    return mb;
  } catch (e) {
    console.warn("[casino-limits] applyMaxToInput failed:", e?.message || e);
    return null;
  }
}
