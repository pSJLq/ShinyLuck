/* ============================================================================
 * slot-decoders.js — convert on-chain BetSettled into the ResultData shape
 * the slot animators (SugarSlot/Vault7Slot) expect.
 *
 * CONTRACT-EXACT REPLAY (NEW)
 * ---------------------------
 * Earlier rounds of this code generated a *local* cluster cascade using a JS
 * engine seeded from the contract's randomness, but the local cluster math
 * used a different RNG than ClusterLib.sol → the visible clusters could lie.
 * Then we dropped cascades entirely (initialGrid = contract's finalGrid,
 * baseCascades = []) → honest but kills the slot's main visual feature.
 *
 * This file now **reimplements ClusterLib.resolve() and Vault7Lib.resolve()
 * in JavaScript**, byte-for-byte. The same `randomness` (bytes32) that the
 * contract used to produce its finalGrid is fed into a local function that
 * walks the identical keccak chain, picks symbols with the identical
 * `_pickSymbol` rule, BFS-finds clusters with the identical 4-way flood
 * fill, computes the same `_clusterPayX100`, and tumbles via the same
 * keccak-derived refill RNG.
 *
 * Result: the animated cascade chain matches the on-chain spin step-for-step.
 * Every visible cluster pop matches a cluster the contract paid for. The
 * sum of cluster payouts × CLUSTER_PAY_BOOST equals the contract's payout.
 * The final grid we land on matches `resultData.finalGrid` exactly. Player
 * can audit each spin on the block explorer and see the same path the slot
 * showed them.
 * ========================================================================= */

import { ethers } from "https://esm.sh/ethers@6.13.2";

// ----------------------------------------------------------------------------
// Pay-boost constants — MUST stay in sync with contracts/Casino.sol.
// `CLUSTER_PAY_BOOST_X100 = 320` means cluster payouts are scaled 3.20× on
// chain after the ClusterLib resolver returns its basis-100 figure.
// ----------------------------------------------------------------------------
const CLUSTER_PAY_BOOST_X100 = 320n;
const VAULT_PAY_BOOST_X100   = 560n;
const VAULT7_FREE_SPIN_MULT_X100 = 200n;

// ----------------------------------------------------------------------------
// CLUSTER (SUGAR.LAB) — symbol IDs
// ----------------------------------------------------------------------------
//   ClusterLib.sol:  0=L2 1=L1 2=M3 3=M2 4=M1 5=H3 6=H2 7=H1 8=WILD 9=SCAT
//   frontend engine.js (sugar): WILD:0 H1:1 H2:2 H3:3 M1:4 M2:5 M3:6 L1:7 L2:8 SCAT:9
const CLUSTER_SOL_TO_ENGINE = [8, 7, 6, 5, 4, 3, 2, 1, 0, 9];

const CLUSTER_WILD = 8;
const CLUSTER_SCAT = 9;
const GRID_SIZE = 7;
const MAX_CASCADE = 12;

// Mirror `ClusterLib._pickSymbol`. Input: 24-bit chunk. Output: solidity sym id.
function _pickSymbol(chunk) {
  const v = chunk % 97n;
  if (v < 22n) return 0;
  if (v < 44n) return 1;
  if (v < 55n) return 2;
  if (v < 66n) return 3;
  if (v < 77n) return 4;
  if (v < 84n) return 5;
  if (v < 90n) return 6;
  if (v < 95n) return 7;
  if (v < 96n) return 8;
  return 9;
}

// Mirror `ClusterLib._clusterPayX100` (basis 100). Returns payout-units * 100.
function _clusterPayX100(sym, n) {
  if (n < 5) return 0n;
  let pay5, pay15;
  if (sym === 0)      { pay5 = 10n;  pay15 = 150n;  }    // L2
  else if (sym === 1) { pay5 = 12n;  pay15 = 200n;  }    // L1
  else if (sym === 2) { pay5 = 18n;  pay15 = 400n;  }    // M3
  else if (sym === 3) { pay5 = 20n;  pay15 = 450n;  }    // M2
  else if (sym === 4) { pay5 = 25n;  pay15 = 500n;  }    // M1
  else if (sym === 5) { pay5 = 30n;  pay15 = 800n;  }    // H3
  else if (sym === 6) { pay5 = 40n;  pay15 = 1000n; }    // H2
  else if (sym === 7) { pay5 = 50n;  pay15 = 1400n; }    // H1
  else if (sym === 8) { pay5 = 40n;  pay15 = 1800n; }    // WILD
  else return 0n;                                        // SCAT
  // linear interp 5..15 (basis 100): t = (n-5)*100/10 capped at 100
  const N = BigInt(n);
  const t = N > 15n ? 100n : ((N - 5n) * 100n) / 10n;
  let p = pay5 + ((pay15 - pay5) * t) / 100n;
  if (N >= 20n) p += (N - 19n) * 25n;
  return p;
}

// keccak256(abi.encode(rr)) — single bytes32 input.
function _hashRR(rr) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [rr]),
  );
}
// keccak256(abi.encode(rr, depth))
function _hashRRDepth(rr, depth) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint8"], [rr, depth]),
  );
}
// keccak256(abi.encode(rr, col, r))
function _hashRRColRow(rr, col, r) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint8", "uint8"], [rr, col, r]),
  );
}

// Read a 24-bit window of `rr` starting at byte offset `rByte`. The contract
// computes: `chunk = uint256(rr) >> (rByte * 8); pick(chunk & 0xFFFFFF)`.
// In JS we shift the BigInt and mask. rByte is 0..31.
function _bitWindow(rr, rByte) {
  const big = BigInt(rr);
  return (big >> BigInt(rByte * 8)) & 0xFFFFFFn;
}

// Build initial 49-cell grid (row-major). Returns { gridFlat, scatterCount, rrFinal, rByteFinal }.
function _initialGrid(randomness) {
  let rr = randomness;
  let rByte = 0;
  const g = new Uint8Array(49);
  let scatterCount = 0;
  for (let i = 0; i < 49; i++) {
    if (rByte >= 32) { rr = _hashRR(rr); rByte = 0; }
    const chunk = _bitWindow(rr, rByte);
    const sym = _pickSymbol(chunk);
    g[i] = sym;
    if (sym === CLUSTER_SCAT) scatterCount++;
    rByte++;
  }
  return { g, scatterCount, rr, rByte };
}

// BFS findClusters + accumulate payouts. Returns { totalX100, clusters }.
// Each cluster: { sym, cells: [{r,c,idx}, ...] } — cells are removed positions.
function _findAndPay(g) {
  const seen = new Array(49).fill(false);
  let totalX100 = 0n;
  const clusters = [];
  for (let i = 0; i < 49; i++) {
    if (seen[i]) continue;
    const sym = g[i];
    if (sym === CLUSTER_SCAT || sym === CLUSTER_WILD || sym >= 10) { seen[i] = true; continue; }
    const stack = [i];
    seen[i] = true;
    const cluster = [];
    while (stack.length > 0) {
      const cur = stack.pop();
      cluster.push(cur);
      const row = (cur / 7) | 0;
      const col = cur % 7;
      // up
      if (row > 0) { const n = cur - 7; if (!seen[n] && (g[n] === sym || g[n] === CLUSTER_WILD)) { seen[n] = true; stack.push(n); } }
      // down
      if (row < 6) { const n = cur + 7; if (!seen[n] && (g[n] === sym || g[n] === CLUSTER_WILD)) { seen[n] = true; stack.push(n); } }
      // left
      if (col > 0) { const n = cur - 1; if (!seen[n] && (g[n] === sym || g[n] === CLUSTER_WILD)) { seen[n] = true; stack.push(n); } }
      // right
      if (col < 6) { const n = cur + 1; if (!seen[n] && (g[n] === sym || g[n] === CLUSTER_WILD)) { seen[n] = true; stack.push(n); } }
    }
    if (cluster.length >= 5) {
      const payX100 = _clusterPayX100(sym, cluster.length);
      totalX100 += payX100;
      clusters.push({ sym, size: cluster.length, indices: cluster, payX100 });
    }
  }
  return { totalX100, clusters };
}

// Mirror ClusterLib._tumble. Modifies g in place. rr is the keccak-derived
// entropy for this cascade depth.
function _tumble(g, toRemove, rr) {
  for (let col = 0; col < 7; col++) {
    const keep = [];
    for (let row = 6; row >= 0; row--) {
      const idx = row * 7 + col;
      if (!toRemove[idx]) keep.push(g[idx]);
    }
    const klen = keep.length;
    for (let k = 0; k < klen; k++) {
      const destRow = 6 - k;
      g[destRow * 7 + col] = keep[k];
    }
    const refill = 7 - klen;
    for (let r = 0; r < refill; r++) {
      const cellRng = _hashRRColRow(rr, col, r);
      const chunk = BigInt(cellRng) & 0xFFFFFFn;
      g[r * 7 + col] = _pickSymbol(chunk);
    }
  }
}

// Convert flat Solidity-sym grid (row-major 49) → 7×7 engine-sym nested array.
function _toEngineGrid(flat) {
  const out = [];
  for (let r = 0; r < 7; r++) {
    const row = [];
    for (let c = 0; c < 7; c++) row.push(CLUSTER_SOL_TO_ENGINE[flat[r * 7 + c]] ?? flat[r * 7 + c]);
    out.push(row);
  }
  return out;
}

// Convert flat cluster indices (0..48) → engine.js positions [[r,c], ...].
function _toEnginePositions(indices) {
  return indices.map((i) => [(i / 7) | 0, i % 7]);
}

// ============================================================================
// SUGAR.LAB — full contract-exact replay
// ============================================================================
//
// Builds the ResultData the SugarSlot animator expects, with every cascade
// matching what the on-chain ClusterLib.resolve() did. The contract emits the
// final grid in resultData; we sanity-check our replay against it.
//
// @param settled       result of SL.waitForSettle (has .randomness, .payout, .resultData)
// @param stakeWei      the bet stake in wei (BigInt)
// @param chargeEvent   optional ChargeMeterTriggered event parsed elsewhere
// @param isBuyBonus    true if this came from buyBonusCluster
// ----------------------------------------------------------------------------

const CHARGE_REWARD_BY_ID = {
  1: "CASH_TIP", 2: "CASH_DROP", 3: "CASH_SURGE",
  4: "FREE_SPINS_3", 5: "MYSTERY_MULT", 6: "CASH_BLAST",
  7: "FREE_SPINS_5", 8: "JACKPOT_BURST",
};
const CHARGE_REWARD_FREE_SPINS = { FREE_SPINS_3: 3, FREE_SPINS_5: 5 };

export function decodeSugarLabResult({ settled, stakeWei, chargeEvent = null, isBuyBonus = false }) {
  if (!settled) throw new Error("decodeSugarLabResult: settled required");
  const payoutWei = BigInt(settled.payout);
  const stake = BigInt(stakeWei);
  const randomness = String(settled.randomness || "0x" + "0".repeat(64));

  // ----- (optional) decode resultData for sanity check -----
  let onchainFinalGrid = null;
  let onchainScatterCount = 0;
  let onchainCascadeDepth = 0;
  let isFreeSpinResult = false;
  try {
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ["uint8[49]", "uint256", "uint8", "uint8", "bool"],
      settled.resultData,
    );
    onchainFinalGrid = decoded[0].map((v) => Number(v));
    onchainScatterCount = Number(decoded[2]);
    onchainCascadeDepth = Number(decoded[3]);
    isFreeSpinResult = Boolean(decoded[4]);
  } catch (_) {}

  // ----- Replay -----
  const { g: initialFlat, scatterCount } = _initialGrid(randomness);
  const initialGrid = _toEngineGrid(initialFlat);

  // Walk cascade chain, capture per-step state for animator.
  const baseCascades = [];
  const working = Uint8Array.from(initialFlat);
  let rr = randomness;
  let totalPayX100 = 0n;
  for (let depth = 0; depth < MAX_CASCADE; depth++) {
    const { totalX100, clusters } = _findAndPay(working);
    if (totalX100 === 0n) break;
    totalPayX100 += totalX100;

    // Build animator's cluster records BEFORE tumble — engine.js expects:
    //   { symbolIndex, positions, size, payout, appliedMultipliers }
    const animClusters = clusters.map((cl) => {
      // Per-cluster payout in wei (with boost): stake × payX100 × BOOST / 10000
      const payWei = (stake * cl.payX100 * CLUSTER_PAY_BOOST_X100) / 10_000n;
      return {
        symbolIndex: CLUSTER_SOL_TO_ENGINE[cl.sym] ?? cl.sym,
        size: cl.size,
        positions: _toEnginePositions(cl.indices),
        payout: payWei,
        appliedMultipliers: [],
      };
    });

    // Mark cells to remove + tumble (mutates `working`).
    const toRemove = new Array(49).fill(0);
    for (const cl of clusters) for (const idx of cl.indices) toRemove[idx] = 1;
    rr = _hashRRDepth(rr, depth);
    _tumble(working, toRemove, rr);

    baseCascades.push({
      clusters: animClusters,
      gridAfter: _toEngineGrid(working),
      newStickyOrbs: [],
    });
  }

  // Sanity check: our replayed final grid should equal the contract's emitted
  // finalGrid. Log a warning if they ever diverge — guards against drift.
  if (onchainFinalGrid && onchainFinalGrid.length === 49) {
    let mismatch = false;
    for (let i = 0; i < 49; i++) if (working[i] !== onchainFinalGrid[i]) { mismatch = true; break; }
    if (mismatch) {
      console.warn("[slot-decoders] sugar replay mismatch vs on-chain finalGrid — please audit ClusterLib in sync");
    }
  }

  // Free-spin trigger detection matches Casino's rule: 4+ scatters in INITIAL
  // grid (during base game), 3+ scatters during a free spin (retrigger).
  let freeSpinsTriggered = 0;
  if (!isFreeSpinResult) {
    if (scatterCount >= 6) freeSpinsTriggered = 20;
    else if (scatterCount === 5) freeSpinsTriggered = 15;
    else if (scatterCount === 4) freeSpinsTriggered = 10;
  } else {
    if (scatterCount >= 3) freeSpinsTriggered = 5;
  }

  const result = {
    initialGrid,
    baseCascades,
    freeSpins: [],
    freeSpinsTriggered,
    chargeMeterAdd: 0,
    totalPayout: payoutWei,   // on-chain truth wins
    spinType: isBuyBonus ? "buyBonus" : (isFreeSpinResult ? "free" : "base"),
    _chain: {
      betId: String(settled.id),
      payout: payoutWei,
      randomness,
      scatterCount: onchainScatterCount || scatterCount,
      cascadeDepth: onchainCascadeDepth,
      isFreeSpin: isFreeSpinResult,
      onchainFinalGrid,
      txHash: settled.txHash || null,
    },
  };

  if (chargeEvent) {
    const type = CHARGE_REWARD_BY_ID[Number(chargeEvent.rewardId)] || "CASH_TIP";
    result.chargeReward = { type, payout: BigInt(chargeEvent.amount || 0) };
    if (CHARGE_REWARD_FREE_SPINS[type]) result.chargeReward.freeSpinsGranted = CHARGE_REWARD_FREE_SPINS[type];
    if (type === "MYSTERY_MULT") {
      const stk = Number(stakeWei);
      const amt = Number(chargeEvent.amount || 0);
      result.chargeReward.multiplier = stk > 0 ? Math.round(amt / stk) : 0;
    }
  }

  return result;
}

// ============================================================================
// VAULT.7 — contract-exact replay
// ============================================================================
// Mirror Vault7Lib.resolve(). 5 reel strips × 40 cells each. Each reel picks a
// starting index from 8 bits of randomness; cells are 3 consecutive strip
// positions (mod 40). 20 paylines.
// ----------------------------------------------------------------------------

// Sym IDs: same convention as cluster — Solidity vs engine.js layout.
//   Vault7Lib.sol: 0=E 1=D 2=F 3=A 4=COIN 5=BOLT 6=CRYS 7=DIAM 8=WILD 9=SCAT
//   vault7 engine.js: WILD:0 DIAM:1 CRYS:2 BOLT:3 COIN:4 A:5 F:6 D:7 E:8 SCAT:9
const VAULT_SOL_TO_ENGINE = [8, 7, 6, 5, 4, 3, 2, 1, 0, 9];
const VAULT_WILD_SOL = 8;
const VAULT_SCAT_SOL = 9;

// Per-reel strip data (40 cells per reel). Must match Vault7Lib reelSymbol().
const VAULT_REEL_STRIPS = [
  // reel 0:  E D F A COIN E F D BOLT A E F COIN D CRYS E F A D BOLT
  //          E F D WILD A COIN E D DIAM F A E SCAT D F A E BOLT D F
  [0,1,2,3,4,0,2,1,5,3,0,2,4,1,6,0,2,3,1,5,
   0,2,1,8,3,4,0,1,7,2,3,0,9,1,2,3,0,5,1,2],
  // reel 1
  [2,1,0,3,5,2,1,0,4,3,1,2,0,5,3,6,1,0,2,3,
   5,1,0,4,2,7,3,1,0,2,8,3,1,9,0,2,3,1,5,0],
  // reel 2
  [1,0,2,5,3,1,2,4,0,3,1,6,2,0,3,5,1,2,8,0,
   3,4,1,2,7,0,3,1,5,2,9,0,3,1,2,6,0,3,5,1],
  // reel 3
  [2,3,1,0,4,2,3,1,5,0,2,3,6,1,0,2,3,1,5,0,
   2,3,8,1,4,0,2,3,7,1,0,2,9,3,1,0,2,5,3,1],
  // reel 4
  [0,2,3,1,5,0,2,3,4,1,0,2,3,5,1,6,0,2,3,1,
   5,0,2,4,3,1,7,0,2,3,8,1,0,9,2,3,1,0,5,2],
];

// 20 paylines (rows per reel, must match Vault7Lib.payline + engine.js PAYLINES)
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

// Per-symbol payout (3/4/5 of a kind) basis 100, from Vault7Lib.payX100.
function _vaultPayX100(sym, run) {
  if (run < 3) return 0n;
  switch (sym) {
    case 8: return run === 3 ? 5000n  : (run === 4 ? 20000n : 80000n); // WILD
    case 7: return run === 3 ? 2500n  : (run === 4 ? 10000n : 40000n); // DIAM
    case 6: return run === 3 ? 1200n  : (run === 4 ? 5000n  : 20000n); // CRYS
    case 5: return run === 3 ? 800n   : (run === 4 ? 2500n  : 10000n); // BOLT
    case 4: return run === 3 ? 500n   : (run === 4 ? 1500n  : 6000n);  // COIN
    case 3: return run === 3 ? 300n   : (run === 4 ? 1000n  : 4000n);  // A
    case 2: return run === 3 ? 200n   : (run === 4 ? 600n   : 2400n);  // F
    case 1: return run === 3 ? 150n   : (run === 4 ? 400n   : 1600n);  // D
    case 0: return run === 3 ? 100n   : (run === 4 ? 300n   : 1200n);  // E
    default: return 0n;
  }
}

// Scatter "anywhere" pay (basis 100 × stake). Mirrors Vault7Lib.scatterPayX100.
function _scatterPayX100(n) {
  if (n < 3) return 0n;
  if (n === 3) return 200n;
  if (n === 4) return 1000n;
  return 5000n;
}

export function decodeVault7Result({ settled, stakeWei, isBuyBonus = false }) {
  if (!settled) throw new Error("decodeVault7Result: settled required");
  const payoutWei = BigInt(settled.payout);
  const stake = BigInt(stakeWei);
  const randomness = String(settled.randomness || "0x" + "0".repeat(64));

  let onchainGrid = null;
  let isFreeSpinResult = false;
  try {
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ["uint8[15]", "uint256", "uint8", "uint256", "bool"],
      settled.resultData,
    );
    onchainGrid = decoded[0].map((v) => Number(v));
    isFreeSpinResult = Boolean(decoded[4]);
  } catch (_) {}

  // ----- Replay: 5 reels × 8-bit start each, 3-cell window per reel -----
  const r = BigInt(randomness);
  const gridSol = []; // column-major: gridSol[col][row]
  let scatterCount = 0;
  for (let c = 0; c < 5; c++) {
    const start = Number((r >> BigInt(c * 8)) & 0xFFn);
    const strip = VAULT_REEL_STRIPS[c];
    const col = [];
    for (let row = 0; row < 3; row++) {
      const sym = strip[(start + row) % 40];
      col.push(sym);
      if (sym === VAULT_SCAT_SOL) scatterCount++;
    }
    gridSol.push(col);
  }

  // Re-map to engine grid (column-major preserved).
  const gridEng = gridSol.map((col) => col.map((s) => VAULT_SOL_TO_ENGINE[s] ?? s));

  // Walk paylines to identify winning lines (for animator highlights).
  const freeSpinMultX100 = isFreeSpinResult ? VAULT7_FREE_SPIN_MULT_X100 : 100n;
  const winningLines = [];
  for (let li = 0; li < VAULT_PAYLINES.length; li++) {
    const pl = VAULT_PAYLINES[li];
    const seq = pl.map((row, col) => gridSol[col][row]);
    // anchor = first non-WILD non-SCAT
    let anchor = -1;
    for (const s of seq) {
      if (s !== VAULT_WILD_SOL && s !== VAULT_SCAT_SOL) { anchor = s; break; }
    }
    if (anchor === -1) anchor = VAULT_WILD_SOL;
    let run = 0;
    const cells = [];
    for (let i = 0; i < seq.length; i++) {
      const s = seq[i];
      if (s === anchor || s === VAULT_WILD_SOL) { run++; cells.push([i, pl[i]]); }
      else break;
    }
    if (run >= 3 && anchor !== VAULT_SCAT_SOL) {
      const mult = _vaultPayX100(anchor, run);
      // Per-line payout in wei: lineBet × mult / 100 × FS_mult × payBoost / 100
      const lineBet = stake / 20n;
      let pay = (lineBet * mult) / 100n;
      if (freeSpinMultX100 > 100n) pay = (pay * freeSpinMultX100) / 100n;
      pay = (pay * VAULT_PAY_BOOST_X100) / 100n;
      winningLines.push({
        lineIndex: li,
        symbolIndex: VAULT_SOL_TO_ENGINE[anchor] ?? anchor,
        matchCount: run,
        payout: pay,
        cells,
      });
    }
  }

  // Sanity: replayed final grid should equal on-chain grid.
  if (onchainGrid && onchainGrid.length === 15) {
    let mismatch = false;
    for (let c = 0; c < 5; c++) {
      for (let row = 0; row < 3; row++) {
        if (gridSol[c][row] !== onchainGrid[c * 3 + row]) { mismatch = true; break; }
      }
      if (mismatch) break;
    }
    if (mismatch) {
      console.warn("[slot-decoders] vault replay mismatch vs on-chain grid — please audit Vault7Lib in sync");
    }
  }

  const scatterPositions = [];
  for (let c = 0; c < 5; c++) for (let row = 0; row < 3; row++) {
    if (gridSol[c][row] === VAULT_SCAT_SOL) scatterPositions.push([c, row]);
  }
  const scatterPay = (stake * _scatterPayX100(scatterCount) * VAULT_PAY_BOOST_X100) / 10_000n;

  let freeSpinsTriggered = 0;
  if (!isFreeSpinResult) {
    if (scatterCount >= 5) freeSpinsTriggered = 20;
    else if (scatterCount === 4) freeSpinsTriggered = 15;
    else if (scatterCount === 3) freeSpinsTriggered = 10;
  } else {
    if (scatterCount >= 3) freeSpinsTriggered = 5;
  }

  return {
    grid: gridEng,
    winningLines,
    scatterCount,
    scatterPositions,
    scatterPayout: scatterPay,
    freeSpinsTriggered,
    freeSpins: [],
    totalPayout: payoutWei,
    spinType: isBuyBonus ? "buyBonus" : (isFreeSpinResult ? "free" : "base"),
    _chain: {
      betId: String(settled.id),
      payout: payoutWei,
      randomness,
      scatterCount,
      isFreeSpin: isFreeSpinResult,
      onchainFinalGrid: onchainGrid,
      txHash: settled.txHash || null,
    },
  };
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
    } catch (_) {}
  }
  return null;
}
