/* ============================================================================
 * casino-limits.js — read the live `effective max bet` from Casino and clamp
 * stake inputs across all game pages.
 *
 * Effective cap = min(gameMaxBet[g], freeBankroll * maxBetBps / 10000)
 *
 * `safeStake(rawStakeWei, maxBetWei)` applies a 5% safety margin so a small
 * drop in bankroll between the fetch and the submit (e.g. another player
 * just won) doesn't flip a borderline stake into BetTooLarge revert territory.
 * ========================================================================= */

import { ethers } from "https://esm.sh/ethers@6.13.2";
import { CONFIG, CASINO_ADDRESS } from "./config.js";
import { provider } from "./rpc.js";

const CASINO_ABI = [
  "function freeBankroll() view returns (uint256)",
  "function maxBetBps() view returns (uint256)",
  "function gameMaxBet(uint8) view returns (uint256)",
];

// Numeric ids — must match contracts/Casino.sol::GameType enum order.
export const GAME = {
  dice: 0, crash: 1, slots: 2, mines: 3, plinko: 4, roulette: 5, cluster: 6,
};

// Per-game payout cap multiplier (basis 100), mirroring Casino.sol constants.
// Used to bound max stake so `_openBet`'s `reserveAdd > free + amount` check
// (=> BankrollInsufficient revert, error 0x8f523bc4) is never triggered.
// For each game: maxPayout = stake * capX100 / 100. The contract requires
// `maxPayout - amount <= free + amount` ⇒ `amount <= free / (capX100/100 - 2)`.
// Games without a static cap (DICE depends on win-chance, CRASH/PLINKO on
// internal multipliers, ROULETTE on bet kind) are not clamped here — their
// own pre-submit logic computes payout directly.
const PAYOUT_CAP_X100 = {
  [GAME.slots]:   200000,  // VAULT.7  — 2000×
  [GAME.cluster]: 250000,  // SUGAR.LAB — 2500×
  [GAME.mines]:    10000,  // 100×
  // dice, crash, plinko, roulette: no constant cap → omit
};

const TTL_MS = 10_000;
const cache = new Map(); // key=game id → { maxBet: bigint, ts: number }

function getCasino() {
  return new ethers.Contract(CASINO_ADDRESS, CASINO_ABI, provider());
}

/**
 * Return the *effective* max bet (wei) for the named game — the min of the
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
    const [bankroll, bps, gMax] = await Promise.all([
      casino.freeBankroll(),
      casino.maxBetBps(),
      casino.gameMaxBet(id),
    ]);
    // Three independent caps, take the tightest:
    //   bpsCap     : free × maxBetBps / 10000  (config-controlled risk %)
    //   gMax       : per-game hardcap (gameMaxBet, set at deploy time)
    //   payoutCap  : free / (capX100/100 - 2)  ← guards BankrollInsufficient
    //                                            on the contract's reserveAdd check
    const free = BigInt(bankroll);
    const bpsCap = (free * BigInt(bps)) / 10_000n;
    const candidates = [bpsCap];
    if (gMax > 0n) candidates.push(BigInt(gMax));
    const capX100 = PAYOUT_CAP_X100[id];
    if (capX100) {
      // stake × (capX100/100 - 2) ≤ free  ⇒  stake ≤ free × 100 / (capX100 - 200)
      const denom = BigInt(capX100) - 200n;
      if (denom > 0n) candidates.push((free * 100n) / denom);
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
 * clamped value is below `minStakeWei` — meaning the casino can't even cover
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
    const err = new Error("Casino restocking — try smaller stake or come back soon");
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
    toast(e?.message || "Casino is restocking — try a smaller stake", { kind: "warn", ttl: 4500 });
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
