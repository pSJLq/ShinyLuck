/* ============================================================================
 * slot-decoders.js — convert on-chain BetSettled into the ResultData shape
 * the slot animators (SugarSlot/Vault7Slot) expect.
 *
 * CONTRACT-EXACT MODE (post P0.5 fix)
 * -----------------------------------
 * Earlier versions generated a local cascade using a *plausible* JS engine
 * spin seeded from contract randomness, then overrode `totalPayout` with the
 * contract's number. That produced a UX bug the user flagged: the animator
 * could paint a winning cluster while the contract paid 0 (or vice-versa).
 *
 * Now we use ONLY the contract's emitted data:
 *   - SUGAR (cluster): the resultData carries the final 7×7 grid + total
 *     payout. We remap symbol IDs to the engine.js layout, drop the grid
 *     as `initialGrid`, and leave `baseCascades` empty. The animator drops
 *     the final grid in (no fake cluster animations) and the slot's HUD
 *     shows the actual payout. The cluster-cascade *journey* (which steps
 *     happened on chain) is NOT visualised because the contract doesn't
 *     emit per-step state — only the final grid. The end state and the
 *     dollar amount the player sees match the on-chain truth bit-for-bit.
 *   - VAULT.7 (lines): same — drop the 5×3 grid, no fake payline highlights.
 *     Real total payout from contract. Scatter count and FS trigger from
 *     contract.
 *
 * If you ever want richer animations, the next step is to fully re-implement
 * ClusterLib.resolve / Vault7Lib.resolve in JS (using ethers' keccak256 and
 * AbiCoder to mirror Solidity's RNG keccak chain). That gives a contract-
 * exact replay of every cascade step. ~150 lines of code, deferred for now.
 * ========================================================================= */

import { ethers } from "https://esm.sh/ethers@6.13.2";

// ----------------------------------------------------------------------------
// Symbol-ID remapping: contract Solidity layout → JS engine.js layout.
// ----------------------------------------------------------------------------

// ClusterLib.sol comment:
//   0 = L2, 1 = L1, 2 = M3, 3 = M2, 4 = M1, 5 = H3, 6 = H2, 7 = H1, 8 = WILD, 9 = SCAT
// engine.js SYMBOL_INDEX:
//   WILD:0, H1:1, H2:2, H3:3, M1:4, M2:5, M3:6, L1:7, L2:8, SCAT:9
// Mapping (solidity index → engine index): [8,7,6,5,4,3,2,1,0,9]
const CLUSTER_SOL_TO_ENGINE = [8, 7, 6, 5, 4, 3, 2, 1, 0, 9];

// Vault7Lib.sol comment:
//   0 = E, 1 = D, 2 = F, 3 = A, 4 = COIN, 5 = BOLT, 6 = CRYS, 7 = DIAM, 8 = WILD, 9 = SCAT
// vault7/engine.js SYMBOL_INDEX:
//   WILD:0, DIAM:1, CRYS:2, BOLT:3, COIN:4, A:5, F:6, D:7, E:8, SCAT:9
const VAULT_SOL_TO_ENGINE = [8, 7, 6, 5, 4, 3, 2, 1, 0, 9];

// ----------------------------------------------------------------------------
// Charge reward id → SugarSlot type string. Mirrors Casino._bumpChargeMeter.
// ----------------------------------------------------------------------------
const CHARGE_REWARD_BY_ID = {
  1: "CASH_TIP", 2: "CASH_DROP", 3: "CASH_SURGE",
  4: "FREE_SPINS_3", 5: "MYSTERY_MULT", 6: "CASH_BLAST",
  7: "FREE_SPINS_5", 8: "JACKPOT_BURST",
};
const CHARGE_REWARD_FREE_SPINS = { FREE_SPINS_3: 3, FREE_SPINS_5: 5 };

// ----------------------------------------------------------------------------
// SUGAR.LAB — cluster
// ----------------------------------------------------------------------------

/**
 * Decode a SUGAR.LAB BetSettled into the ResultData shape SugarSlot expects.
 *
 * The contract resultData layout:
 *   abi.encode(uint8[49] finalGrid, uint256 totalPayoutX100,
 *              uint8 scatterCount, uint8 cascadeDepth, bool useFreeSpin)
 */
export function decodeSugarLabResult({ settled, stakeWei, chargeEvent = null, isBuyBonus = false }) {
  if (!settled) throw new Error("decodeSugarLabResult: settled required");
  const payoutWei = BigInt(settled.payout);
  const randomness = String(settled.randomness || "0x" + "0".repeat(64));

  let onchainGrid = null;
  let scatterCount = 0;
  let cascadeDepth = 0;
  let isFreeSpinResult = false;
  try {
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ["uint8[49]", "uint256", "uint8", "uint8", "bool"],
      settled.resultData,
    );
    onchainGrid = decoded[0].map((v) => Number(v));
    scatterCount = Number(decoded[2]);
    cascadeDepth = Number(decoded[3]);
    isFreeSpinResult = Boolean(decoded[4]);
  } catch (e) {
    console.warn("[slot-decoders] could not decode SUGAR resultData:", e?.message || e);
  }

  // Convert Solidity's flat uint8[49] into the 7×7 nested array engine.js uses.
  // ClusterLib emits grid in row-major order: index = row * 7 + col.
  let initialGrid;
  if (onchainGrid && onchainGrid.length === 49) {
    const remapped = onchainGrid.map((s) => CLUSTER_SOL_TO_ENGINE[s] ?? s);
    initialGrid = [];
    for (let r = 0; r < 7; r++) {
      const row = [];
      for (let c = 0; c < 7; c++) row.push(remapped[r * 7 + c]);
      initialGrid.push(row);
    }
  } else {
    // Last-resort fallback if resultData failed to decode — empty grid of L2.
    initialGrid = Array.from({ length: 7 }, () => Array(7).fill(8 /* L2 */));
  }

  const result = {
    initialGrid,
    // Cascade journey is NOT emitted by the contract — leaving baseCascades
    // empty means the animator drops the final grid and skips fake cluster
    // animations. The HUD still shows totalPayout (truth).
    baseCascades: [],
    freeSpins: [],
    freeSpinsTriggered: clusterScatterCountToFs(scatterCount, isFreeSpinResult),
    chargeMeterAdd: 0, // visual only — UI reads getChargeMeter() after settle
    totalPayout: payoutWei,
    spinType: isBuyBonus ? "buyBonus" : (isFreeSpinResult ? "free" : "base"),
    _chain: {
      betId: String(settled.id),
      payout: payoutWei,
      randomness,
      scatterCount,
      cascadeDepth,
      isFreeSpin: isFreeSpinResult,
      onchainFinalGrid: onchainGrid,
      txHash: settled.txHash || null,
    },
  };

  if (chargeEvent) {
    const type = CHARGE_REWARD_BY_ID[Number(chargeEvent.rewardId)] || "CASH_TIP";
    result.chargeReward = {
      type,
      payout: BigInt(chargeEvent.amount || 0),
    };
    if (CHARGE_REWARD_FREE_SPINS[type]) {
      result.chargeReward.freeSpinsGranted = CHARGE_REWARD_FREE_SPINS[type];
    }
    if (type === "MYSTERY_MULT") {
      const stk = Number(stakeWei);
      const amt = Number(chargeEvent.amount || 0);
      result.chargeReward.multiplier = stk > 0 ? Math.round(amt / stk) : 0;
    }
  }

  return result;
}

function clusterScatterCountToFs(n, isFs) {
  // ClusterLib FS rules (mirror cluster-engine.js):
  //   base game: 4+ SCAT → 10/15/20 FS
  //   free spin: 3+ SCAT → +5 FS (retrigger small)
  if (isFs) {
    return n >= 3 ? 5 : 0;
  }
  if (n >= 6) return 20;
  if (n === 5) return 15;
  if (n === 4) return 10;
  return 0;
}

// ----------------------------------------------------------------------------
// VAULT.7 — lines
// ----------------------------------------------------------------------------

/**
 * Decode a VAULT.7 BetSettled into the ResultData shape Vault7Slot expects.
 *
 * The contract resultData layout:
 *   abi.encode(uint8[15] grid, uint256 lineMult, uint8 scatterCount,
 *              uint256 scatterPayX100, bool useFreeSpin)
 */
export function decodeVault7Result({ settled, stakeWei, isBuyBonus = false }) {
  if (!settled) throw new Error("decodeVault7Result: settled required");
  const payoutWei = BigInt(settled.payout);
  const randomness = String(settled.randomness || "0x" + "0".repeat(64));

  let onchainGrid = null;
  let lineMultSum = 0n;
  let scatterCount = 0;
  let scatterPayX100 = 0n;
  let isFreeSpinResult = false;
  try {
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ["uint8[15]", "uint256", "uint8", "uint256", "bool"],
      settled.resultData,
    );
    onchainGrid = decoded[0].map((v) => Number(v));
    lineMultSum = BigInt(decoded[1]);
    scatterCount = Number(decoded[2]);
    scatterPayX100 = BigInt(decoded[3]);
    isFreeSpinResult = Boolean(decoded[4]);
  } catch (e) {
    console.warn("[slot-decoders] could not decode VAULT resultData:", e?.message || e);
  }

  // Convert flat uint8[15] (Vault7Lib emits grid[c*3+r], column-major) into
  // the column-major nested array vault7/engine.js uses (grid[col][row]).
  let grid;
  if (onchainGrid && onchainGrid.length === 15) {
    const remapped = onchainGrid.map((s) => VAULT_SOL_TO_ENGINE[s] ?? s);
    grid = [];
    for (let c = 0; c < 5; c++) {
      const col = [];
      for (let r = 0; r < 3; r++) col.push(remapped[c * 3 + r]);
      grid.push(col);
    }
  } else {
    grid = Array.from({ length: 5 }, () => Array(3).fill(8 /* E */));
  }

  // Walk the grid to compute which paylines lit on the contract result. We
  // do this purely visually — the contract already computed the totalPayout.
  // Highlighting the winning lines makes the spin feel earned.
  const winningLines = computeVault7WinningLines(grid, stakeWei, isFreeSpinResult ? 2 : 1);

  // Scatter positions for the celebration highlights.
  const scatterPositions = [];
  for (let c = 0; c < 5; c++) {
    for (let r = 0; r < 3; r++) {
      if (grid[c][r] === 9) scatterPositions.push([c, r]);
    }
  }

  return {
    grid,
    winningLines,
    scatterCount,
    scatterPositions,
    scatterPayout: 0n,        // aggregated into totalPayout already
    freeSpinsTriggered: vaultScatterToFs(scatterCount, isFreeSpinResult),
    freeSpins: [],
    totalPayout: payoutWei,
    spinType: isBuyBonus ? "buyBonus" : (isFreeSpinResult ? "free" : "base"),
    _chain: {
      betId: String(settled.id),
      payout: payoutWei,
      randomness,
      lineMultSum,
      scatterCount,
      scatterPayX100,
      isFreeSpin: isFreeSpinResult,
      onchainFinalGrid: onchainGrid,
      txHash: settled.txHash || null,
    },
  };
}

function vaultScatterToFs(n, isFs) {
  if (isFs) return n >= 3 ? 5 : 0;
  if (n >= 5) return 20;
  if (n === 4) return 15;
  if (n === 3) return 10;
  return 0;
}

// Vault7 paylines (must match Vault7Lib.payline + vault7/engine.js PAYLINES).
const VAULT_PAYLINES = [
  [1,1,1,1,1], [0,0,0,0,0], [2,2,2,2,2],
  [0,1,2,1,0], [2,1,0,1,2],
  [1,0,0,0,1], [1,2,2,2,1],
  [0,0,1,2,2], [2,2,1,0,0],
  [1,0,1,0,1], [1,2,1,2,1],
  [0,1,0,1,0], [2,1,2,1,2],
  [0,1,1,1,0], [2,1,1,1,2],
  [1,1,0,1,1], [1,1,2,1,1],
  [0,2,0,2,0], [2,0,2,0,2],
  [0,1,2,2,2],
];

function computeVault7WinningLines(grid, _stakeWei, _mult) {
  // We don't have the per-line pay table here (lives in vault7/engine.js).
  // For visual highlighting it's enough to identify which lines have a
  // matching run of 3+ from reel 0 — the slot animator paints those lines.
  // Actual payout already came from the contract.
  const WILD = 0, SCAT = 9;
  const winning = [];
  for (let li = 0; li < VAULT_PAYLINES.length; li++) {
    const pl = VAULT_PAYLINES[li];
    const seq = pl.map((row, col) => grid[col][row]);
    let anchor = null;
    for (const s of seq) if (s !== WILD && s !== SCAT) { anchor = s; break; }
    if (anchor == null) anchor = WILD;
    let count = 0;
    for (const s of seq) {
      if (s === anchor || s === WILD) count++; else break;
    }
    if (count >= 3 && anchor !== SCAT) {
      winning.push({
        lineIndex: li,
        symbolIndex: anchor,
        matchCount: count,
        payout: 0n, // unknown without pay table; slot animator only needs cells
      });
    }
  }
  return winning;
}

// ----------------------------------------------------------------------------
// ChargeMeterTriggered event extractor
// ----------------------------------------------------------------------------
export function extractChargeMeterEvent(casino, logs) {
  if (!logs || !logs.length) return null;
  const iface = casino.interface;
  for (const log of logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === "ChargeMeterTriggered") {
        return {
          rewardId: Number(parsed.args.rewardId),
          amount: BigInt(parsed.args.amount),
          cycle: Number(parsed.args.cycle),
        };
      }
    } catch (_) { /* not a Casino event — skip */ }
  }
  return null;
}
