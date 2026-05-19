/* ============================================================================
 * slot-decoders.js — convert on-chain settle data → SugarSlot/Vault7Slot
 * ResultData (the shape the animator expects).
 *
 * IMPORTANT: the Solidity ClusterLib / Vault7Lib resolvers use a different
 * RNG than the JS engines (keccak256-based vs FNV+xorshift32 string seeds),
 * so we CANNOT exactly replay a contract spin in JS. What we do instead:
 *
 *   1. seed a local JS engine spin from the contract's `randomness`
 *      (gives a deterministic, plausible cascade journey)
 *   2. OVERRIDE top-level numbers — totalPayout, freeSpinsTriggered,
 *      chargeReward — with the contract's actual values
 *
 * Effect: animation looks right, on-screen balance change exactly matches
 * what the contract paid. The intermediate cluster pattern shown may not
 * be the literal cluster pattern the contract walked through, but every
 * player-facing number is correct and matches block explorer.
 *
 * For the SUGAR.LAB charge meter we ALSO need the `ChargeMeterTriggered`
 * event if it fired in the same tx — parsing that out is the caller's job
 * (`decodeSugarLabResult` accepts it as an optional argument).
 * ============================================================================ */

import { ethers } from "https://esm.sh/ethers@6.13.2";
import { generateSpin as sugarGenerateSpin, generateBuyBonusSpin as sugarGenerateBuyBonusSpin } from "/games/sugar/engine.js";
import { generateSpin as vaultGenerateSpin, generateBuyBonusSpin as vaultGenerateBuyBonusSpin } from "/games/vault7/engine.js";

// ----------------------------------------------------------------------------
// Charge reward id → SugarSlot type string. Mirrors Casino._bumpChargeMeter.
// ----------------------------------------------------------------------------
const CHARGE_REWARD_BY_ID = {
  1: "CASH_TIP",
  2: "CASH_DROP",
  3: "CASH_SURGE",
  4: "FREE_SPINS_3",
  5: "MYSTERY_MULT",
  6: "CASH_BLAST",
  7: "FREE_SPINS_5",
  8: "JACKPOT_BURST",
};

// Pay constants for the visual celebration overlay; the actual STT credit
// is queued in `chargeMeterReward` on-chain and claimed via claimChargeReward.
const CHARGE_REWARD_FREE_SPINS = {
  FREE_SPINS_3: 3,
  FREE_SPINS_5: 5,
};

/**
 * Decode a SUGAR.LAB BetSettled into the ResultData shape SugarSlot expects.
 *
 * @param {object} settled       result of `sl.waitForSettle(betId)`
 * @param {bigint} stakeWei      the stake the player just placed (wei)
 * @param {object|null} chargeEvent  optional ChargeMeterTriggered event in the
 *                                   same tx — { rewardId, amount, cycle }
 * @param {boolean} isBuyBonus   if true, treat as buy-bonus path
 * @returns ResultData (engine.js shape)
 */
export function decodeSugarLabResult({ settled, stakeWei, chargeEvent = null, isBuyBonus = false }) {
  if (!settled) throw new Error("decodeSugarLabResult: settled required");
  const payoutWei = BigInt(settled.payout);
  const randomness = String(settled.randomness || "0x" + "0".repeat(64));
  const seed = `chain:${randomness.replace(/^0x/, "")}`;

  // contract resultData layout:
  //   abi.encode(uint8[49] finalGrid, uint256 totalPayoutX100,
  //              uint8 scatterCount, uint8 cascadeDepth, bool useFreeSpin)
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

  // Run a local engine spin seeded from contract randomness — purely visual.
  // The local engine's payout / fs / charge are discarded; we use contract truth.
  const localState = { charge: 0, chargeThreshold: 240, pendingWildStorm: false };
  const local = isBuyBonus
    ? sugarGenerateBuyBonusSpin(stakeWei, seed)
    : sugarGenerateSpin(stakeWei, seed, localState);

  const result = {
    initialGrid: local.initialGrid,
    baseCascades: local.baseCascades,
    freeSpins: local.freeSpins,
    // Override numerical claims with on-chain truth:
    freeSpinsTriggered: scatterCountToFreeSpins(scatterCount),
    chargeMeterAdd: 0, // visual only — UI also reads getChargeMeter() after settle
    totalPayout: payoutWei,
    spinType: isBuyBonus ? "buyBonus" : (isFreeSpinResult ? "free" : "base"),
    // Carry-through diagnostics so the UI / fair panel can show them
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
      // we don't know the picked multiplier from event alone; show "Mystery"
      const stk = Number(stakeWei);
      const amt = Number(chargeEvent.amount || 0);
      const m = stk > 0 ? Math.round(amt / stk) : 0;
      result.chargeReward.multiplier = m;
    }
  }

  return result;
}

/**
 * Decode a VAULT.7 BetSettled into the ResultData shape Vault7Slot expects.
 */
export function decodeVault7Result({ settled, stakeWei, isBuyBonus = false }) {
  if (!settled) throw new Error("decodeVault7Result: settled required");
  const payoutWei = BigInt(settled.payout);
  const randomness = String(settled.randomness || "0x" + "0".repeat(64));
  const seed = `chain:${randomness.replace(/^0x/, "")}`;

  // contract resultData layout:
  //   abi.encode(uint8[15] grid, uint256 lineMult, uint8 scatterCount,
  //              uint256 scatterPayX100, bool useFreeSpin)
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

  // Local plausible-cascade journey for the animator.
  const local = isBuyBonus
    ? vaultGenerateBuyBonusSpin(stakeWei, seed)
    : vaultGenerateSpin(stakeWei, seed);

  // Map contract symbol index (uint8 grid) → engine.js layout.
  // Solidity / Vault7Lib symbol IDs (lib comment):
  //   0=E 1=D 2=F 3=A 4=COIN 5=BOLT 6=CRYS 7=DIAM 8=WILD 9=SCAT
  // engine.js symbol indices:
  //   0=WILD 1=DIAM 2=CRYS 3=BOLT 4=COIN 5=A 6=F 7=D 8=E 9=SCAT
  // So we re-index the on-chain grid before stamping it into local.grid for
  // the LAST frame. The intermediate spin animation uses local indices end
  // to end; only `result.grid` (the still-frame shown after the reels stop)
  // gets the on-chain re-mapped grid.
  if (onchainGrid && onchainGrid.length === 15) {
    const remapped = onchainGrid.map(SOLIDITY_TO_VAULT_ENGINE);
    // engine grid is column-major (grid[col][row]); resultData is also col-major
    // since Vault7Lib emits grid[c*3 + r].
    const colMajor = [];
    for (let c = 0; c < 5; c++) {
      const col = [];
      for (let r = 0; r < 3; r++) col.push(remapped[c * 3 + r]);
      colMajor.push(col);
    }
    local.grid = colMajor;
  }

  return {
    grid: local.grid,
    winningLines: local.winningLines,
    scatterCount,
    scatterPositions: local.scatterPositions,
    scatterPayout: 0n, // we don't break apart line vs scatter on the wire; the
                       // on-chain `payout` already aggregates them
    freeSpinsTriggered: scatterCountToFreeSpins(scatterCount),
    freeSpins: local.freeSpins,
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

// Solidity sym IDs → engine.js sym indices. Used for VAULT.7 grid re-mapping.
function SOLIDITY_TO_VAULT_ENGINE(soliditySym) {
  switch (soliditySym) {
    case 0: return 8;  // E
    case 1: return 7;  // D
    case 2: return 6;  // F
    case 3: return 5;  // A
    case 4: return 4;  // COIN
    case 5: return 3;  // BOLT
    case 6: return 2;  // CRYS
    case 7: return 1;  // DIAM
    case 8: return 0;  // WILD
    case 9: return 9;  // SCAT
    default: return soliditySym;
  }
}

function scatterCountToFreeSpins(n) {
  if (n >= 6) return 20;
  if (n === 5) return 15;
  if (n === 4) return 10;
  if (n === 3) return 5; // retrigger small (when isFreeSpin); in base game, 3 SCAT awards 0 FS for SUGAR
  return 0;
}

/**
 * Pull a ChargeMeterTriggered event out of a tx receipt's logs, if any.
 * Used by sugar UI right after waitForSettle to attach the reward to ResultData.
 *
 * @param {object} casino     ethers.Contract bound to Casino
 * @param {array}  logs       tx receipt logs (or settled.logs if your wrapper kept them)
 * @returns {{rewardId:number, amount:bigint, cycle:number}|null}
 */
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
    } catch (_) {
      // not a Casino event — skip
    }
  }
  return null;
}
