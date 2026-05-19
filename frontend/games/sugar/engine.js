/* ============================================================================
 * sugar/engine.js — pure math + ResultData generator (demo mode RNG)
 * No DOM. Deterministic from seed string. Wei (bigint) for all amounts.
 * ============================================================================
 *
 * Public API:
 *   generateSpin(stakeWei: bigint, seed: string, state: EngineState) → SugarResultData
 *   generateBuyBonusSpin(stakeWei: bigint, seed: string, state: EngineState) → SugarResultData
 *
 * EngineState is opaque to consumers; api.js manages it. Carries:
 *   { charge, chargeThreshold, chargeCycle, pendingWildStorm }
 *
 * When the contract takes over (production mode), this file is unused.
 * The contract must emit ResultData with the same shape — see types in api.js.
 * ============================================================================ */

// ---------- symbol indices (numeric for compact ResultData) ----------
export const SYMBOL_INDEX = {
  WILD: 0, H1: 1, H2: 2, H3: 3,
  M1: 4, M2: 5, M3: 6,
  L1: 7, L2: 8, SCAT: 9,
};
export const SYMBOL_BY_INDEX = ['WILD','H1','H2','H3','M1','M2','M3','L1','L2','SCAT'];

// pay table — per cluster size 5 and 15 (linear interp; +0.25 per symbol >19)
export const SYMBOL_PAY = {
  WILD: { pay5: 0.40, pay15: 18.00 },
  H1:   { pay5: 0.50, pay15: 14.00 },
  H2:   { pay5: 0.40, pay15: 10.00 },
  H3:   { pay5: 0.30, pay15:  8.00 },
  M1:   { pay5: 0.25, pay15:  5.00 },
  M2:   { pay5: 0.20, pay15:  4.50 },
  M3:   { pay5: 0.18, pay15:  4.00 },
  L1:   { pay5: 0.12, pay15:  2.00 },
  L2:   { pay5: 0.10, pay15:  1.50 },
};

// RTP boost — the STATS.md pay tables alone deliver only ~40% RTP (see
// `scripts/validate-rtp.js`). This multiplier scales every cluster payout
// uniformly so empirical RTP (base game + charge meter) lands at ~91-92%.
// MUST stay in sync with `contracts/Casino.sol::CLUSTER_PAY_BOOST_X100`
// (320 = 3.20). Demo + production payouts both flow through here.
export const SUGAR_PAY_BOOST = 3.20;

// weighted symbol bag (sum=97)
const WEIGHTS = { WILD:1, H1:5, H2:6, H3:7, M1:11, M2:11, M3:11, L1:22, L2:22, SCAT:1 };
const SYMBOL_BAG = (() => {
  const bag = [];
  for (const k of Object.keys(WEIGHTS)) for (let i = 0; i < WEIGHTS[k]; i++) bag.push(SYMBOL_INDEX[k]);
  return bag;
})();

// sticky-orb multiplier bag
const MULT_VALUES =  [2,  3,  4,  5,  8,  10, 15, 20, 25, 50, 100];
const MULT_WEIGHTS = [55, 38, 28, 18, 10, 6,  3,  2,  1,  1,  1];
const MULT_BAG = (() => {
  const bag = [];
  for (let i = 0; i < MULT_VALUES.length; i++) for (let j = 0; j < MULT_WEIGHTS[i]; j++) bag.push(MULT_VALUES[i]);
  return bag;
})();

// charge meter reward weights (sum=100)
export const CHARGE_REWARDS = [
  { type: 'CASH_TIP',      weight: 38, payX: 3   },
  { type: 'CASH_DROP',     weight: 25, payX: 8   },
  { type: 'CASH_SURGE',    weight: 12, payX: 18  },
  { type: 'FREE_SPINS_3',  weight: 8,  freeSpinsGranted: 3 },
  { type: 'MYSTERY_MULT',  weight: 6 },
  { type: 'CASH_BLAST',    weight: 4,  payX: 45  },
  { type: 'FREE_SPINS_5',  weight: 4,  freeSpinsGranted: 5 },
  { type: 'WILD_STORM',    weight: 2 },
  { type: 'JACKPOT_BURST', weight: 1,  payX: 120 },
];
const CHARGE_REWARD_BAG = (() => {
  const bag = [];
  for (const r of CHARGE_REWARDS) for (let i = 0; i < r.weight; i++) bag.push(r);
  return bag;
})();

const GRID_SIZE = 7;
const SCAT = SYMBOL_INDEX.SCAT;
const WILD = SYMBOL_INDEX.WILD;
const HOUSE_EDGE_BPS = 800n; // 8% as basis points for EV displays

// ---------- deterministic RNG (FNV-1a + xorshift32) ----------
function hashSeed(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function makeRng(seed) {
  let a = hashSeed(seed) || 1;
  return () => {
    a ^= a << 13; a >>>= 0; a ^= a >>> 17; a >>>= 0; a ^= a << 5;  a >>>= 0;
    return (a >>> 0) / 0x100000000;
  };
}

// ---------- bigint scaling helpers ----------
// payout = stakeWei * mult, where mult may have 4 decimals → multiply by 10000 / 10000
const SCALE = 10_000n;
function scaleMul(stakeWei, mult) {
  const m = BigInt(Math.round(mult * Number(SCALE)));
  return (stakeWei * m) / SCALE;
}

// ---------- grid helpers ----------
function makeGrid(rng) {
  const g = [];
  for (let r = 0; r < GRID_SIZE; r++) {
    const row = [];
    for (let c = 0; c < GRID_SIZE; c++) row.push(SYMBOL_BAG[Math.floor(rng() * SYMBOL_BAG.length)]);
    g.push(row);
  }
  return g;
}
function cloneGrid(g) { return g.map(r => r.slice()); }
function countScatters(g) { let n = 0; for (const r of g) for (const v of r) if (v === SCAT) n++; return n; }

// BFS clusters; WILD matches any non-SCAT cluster anchor
function findClusters(grid) {
  const seen = Array.from({length: GRID_SIZE}, () => Array(GRID_SIZE).fill(false));
  const clusters = [];
  for (let r = 0; r < GRID_SIZE; r++) for (let c = 0; c < GRID_SIZE; c++) {
    const s = grid[r][c];
    if (s === SCAT || s === WILD || seen[r][c]) continue;
    const stack = [[r, c]];
    const cells = [];
    seen[r][c] = true;
    while (stack.length) {
      const [y, x] = stack.pop();
      cells.push([y, x]);
      for (const [ny, nx] of [[y-1,x],[y+1,x],[y,x-1],[y,x+1]]) {
        if (ny < 0 || ny >= GRID_SIZE || nx < 0 || nx >= GRID_SIZE) continue;
        if (seen[ny][nx]) continue;
        const ns = grid[ny][nx];
        if (ns === s || ns === WILD) { seen[ny][nx] = true; stack.push([ny, nx]); }
      }
    }
    if (cells.length >= 5) clusters.push({ symbolIndex: s, positions: cells, size: cells.length });
  }
  return clusters;
}

function symbolPayMult(symIdx, size) {
  const name = SYMBOL_BY_INDEX[symIdx];
  const def = SYMBOL_PAY[name];
  if (!def) return 0;
  const t = Math.min(1, (size - 5) / 10);
  const p = def.pay5 + (def.pay15 - def.pay5) * t;
  const big = size >= 20 ? (size - 19) * 0.25 : 0;
  return (p + big) * SUGAR_PAY_BOOST;
}

function tumble(grid, removedSet, rng) {
  for (let c = 0; c < GRID_SIZE; c++) {
    const col = [];
    for (let r = GRID_SIZE - 1; r >= 0; r--) {
      if (!removedSet.has(r + ',' + c)) col.push(grid[r][c]);
    }
    while (col.length < GRID_SIZE) col.push(SYMBOL_BAG[Math.floor(rng() * SYMBOL_BAG.length)]);
    for (let r = GRID_SIZE - 1, i = 0; r >= 0; r--, i++) grid[r][c] = col[i];
  }
}

// Run cascade chain on a grid. Optionally with sticky multipliers (FS).
// Returns { cascades: [...], totalPayout: bigint, finalGrid }.
function runCascades(grid, stakeWei, rng, opts = {}) {
  const { isFreeSpin = false } = opts;
  let stickyOrbs = (opts.stickyOrbs || []).map(o => ({ ...o })); // {row,col,value}
  const cascades = [];
  let totalPayout = 0n;
  let chainIdx = 0;

  while (true) {
    const clusters = findClusters(grid);
    if (clusters.length === 0) break;
    const removedSet = new Set();
    const winningCellsSet = new Set();
    const clusterRecords = [];
    for (const cl of clusters) {
      const baseMult = symbolPayMult(cl.symbolIndex, cl.size);
      const basePayout = scaleMul(stakeWei, baseMult);
      // sticky orbs that hit this cluster (FS only)
      const cellSet = new Set(cl.positions.map(p => p[0] + ',' + p[1]));
      const applied = [];
      let totalOrbMult = 0;
      if (isFreeSpin) {
        for (const o of stickyOrbs) {
          if (cellSet.has(o.row + ',' + o.col)) { applied.push(o.value); totalOrbMult += o.value; }
        }
      }
      const finalPayout = totalOrbMult > 0 ? basePayout * BigInt(totalOrbMult) : basePayout;
      totalPayout += finalPayout;
      for (const [r, c] of cl.positions) { removedSet.add(r + ',' + c); winningCellsSet.add(r + ',' + c); }
      clusterRecords.push({
        symbolIndex: cl.symbolIndex,
        positions: cl.positions,
        size: cl.size,
        payout: finalPayout,
        appliedMultipliers: applied,
      });
    }

    tumble(grid, removedSet, rng);

    // new sticky orbs in FS — probability rises with chain
    const newStickyOrbs = [];
    if (isFreeSpin) {
      const p = Math.min(0.55, 0.18 + chainIdx * 0.07);
      if (rng() < p) {
        let attempts = 0;
        while (attempts < 20) {
          const r = Math.floor(rng() * GRID_SIZE);
          const c = Math.floor(rng() * GRID_SIZE);
          if (!stickyOrbs.some(o => o.row === r && o.col === c)) {
            const value = MULT_BAG[Math.floor(rng() * MULT_BAG.length)];
            const orb = { row: r, col: c, value };
            stickyOrbs.push(orb);
            newStickyOrbs.push({ position: [r, c], value });
            break;
          }
          attempts++;
        }
      }
    }

    cascades.push({
      clusters: clusterRecords,
      gridAfter: cloneGrid(grid),
      ...(isFreeSpin ? { newStickyOrbs } : {}),
    });
    chainIdx++;
    if (chainIdx > 50) break;
  }
  return { cascades, totalPayout, stickyOrbs };
}

// roll a charge reward; resolves payout amounts (so api.js / contract has no extra logic)
function rollChargeReward(stakeWei, rng) {
  const r = { ...CHARGE_REWARD_BAG[Math.floor(rng() * CHARGE_REWARD_BAG.length)] };
  delete r.weight;
  r.payout = 0n;
  if (r.payX != null) r.payout = scaleMul(stakeWei, r.payX);
  if (r.type === 'MYSTERY_MULT') {
    const pool = [5, 8, 10, 15, 20, 25, 50];
    const m = pool[Math.floor(rng() * pool.length)];
    r.multiplier = m;
    r.payout = scaleMul(stakeWei, m);
  }
  if (r.type === 'WILD_STORM') {
    r.wildsForNextSpin = 4 + Math.floor(rng() * 4); // 4..7
  }
  return r;
}

// ---------- entry: generateSpin ----------
function chargeAdd(stakeWei, miss, rng) {
  const stakeDec = Number(stakeWei) / 1e18;
  return 2.2 + (stakeDec / 50) * 3.5 + (miss ? 1.2 : 0) + rng() * 1.5;
}

function placeForcedWilds(grid, count, rng) {
  let placed = 0, tries = 0;
  while (placed < count && tries < 500) {
    const r = Math.floor(rng() * GRID_SIZE);
    const c = Math.floor(rng() * GRID_SIZE);
    if (grid[r][c] !== WILD && grid[r][c] !== SCAT) { grid[r][c] = WILD; placed++; }
    tries++;
  }
}

function placeForcedScatters(grid, minCount, rng) {
  let placed = countScatters(grid);
  let tries = 0;
  while (placed < minCount && tries < 800) {
    const r = Math.floor(rng() * GRID_SIZE);
    const c = Math.floor(rng() * GRID_SIZE);
    if (grid[r][c] !== SCAT) { grid[r][c] = SCAT; placed++; }
    tries++;
  }
}

// Build a single free-spin's payload
function buildFreeSpin(spinNumber, stakeWei, rng, prevStickyOrbs) {
  const grid = makeGrid(rng);
  const initialGrid = cloneGrid(grid);
  const { cascades, totalPayout, stickyOrbs } = runCascades(grid, stakeWei, rng, {
    isFreeSpin: true, stickyOrbs: prevStickyOrbs,
  });
  // scatter retrigger on the post-cascade final grid (we follow industry convention:
  // count scatters in the initial FS grid)
  const sc = countScatters(initialGrid);
  let retriggerAdded = 0;
  if (sc >= 3) retriggerAdded = sc >= 5 ? 15 : sc === 4 ? 10 : 5;

  return {
    payload: {
      spinNumber,
      initialGrid,
      cascades,
      activeStickyOrbs: stickyOrbs.map(o => ({ position: [o.row, o.col], value: o.value })),
      retriggerAdded,
    },
    spinTotal: totalPayout,
    stickyOrbs,
  };
}

export function generateSpin(stakeWei, seed, state) {
  const rng = makeRng(seed);

  // wild storm sprinkled before grid eval
  let initial = makeGrid(rng);
  if (state && state.pendingWildStorm) {
    const n = 4 + Math.floor(rng() * 4);
    placeForcedWilds(initial, n, rng);
  }

  // base game cascades
  const baseGrid = cloneGrid(initial);
  const baseRun = runCascades(baseGrid, stakeWei, rng, { isFreeSpin: false });
  let totalPayout = baseRun.totalPayout;

  const baseScatters = countScatters(initial);
  let freeSpinsTriggered = 0;
  if (baseScatters >= 3) freeSpinsTriggered = baseScatters >= 5 ? 20 : baseScatters === 4 ? 15 : 10;

  const freeSpins = [];
  if (freeSpinsTriggered > 0) {
    let remaining = freeSpinsTriggered;
    let stickyOrbs = [];
    let n = 1;
    while (remaining > 0) {
      const { payload, spinTotal, stickyOrbs: nextOrbs } = buildFreeSpin(n, stakeWei, rng, stickyOrbs);
      remaining--;
      remaining += payload.retriggerAdded;
      stickyOrbs = nextOrbs;
      totalPayout += spinTotal;
      freeSpins.push(payload);
      n++;
      if (n > 200) break; // safety
    }
  }

  // charge meter
  const miss = baseRun.cascades.length === 0 && freeSpinsTriggered === 0;
  const chargeMeterAdd = chargeAdd(stakeWei, miss, rng);
  let chargeReward;
  const newCharge = (state?.charge ?? 0) + chargeMeterAdd;
  if (newCharge >= (state?.chargeThreshold ?? 240)) {
    chargeReward = rollChargeReward(stakeWei, rng);
    if (chargeReward.payout) totalPayout += chargeReward.payout;
  }

  return {
    initialGrid: initial,
    baseCascades: baseRun.cascades,
    freeSpinsTriggered,
    freeSpins,
    chargeMeterAdd,
    chargeReward,
    totalPayout,
    spinType: 'base',
  };
}

export function generateBuyBonusSpin(stakeWei, seed) {
  const rng = makeRng(seed);
  // forced ≥4 scatters in the initial grid
  let initial = makeGrid(rng);
  placeForcedScatters(initial, 4, rng);

  const baseGrid = cloneGrid(initial);
  const baseRun = runCascades(baseGrid, stakeWei, rng, { isFreeSpin: false });

  const baseScatters = countScatters(initial);
  const freeSpinsTriggered = baseScatters >= 5 ? 20 : baseScatters === 4 ? 15 : 10;

  let totalPayout = baseRun.totalPayout;
  const freeSpins = [];
  let remaining = freeSpinsTriggered;
  let stickyOrbs = [];
  let n = 1;
  while (remaining > 0) {
    const { payload, spinTotal, stickyOrbs: nextOrbs } = buildFreeSpin(n, stakeWei, rng, stickyOrbs);
    remaining--;
    remaining += payload.retriggerAdded;
    stickyOrbs = nextOrbs;
    totalPayout += spinTotal;
    freeSpins.push(payload);
    n++;
    if (n > 200) break;
  }

  return {
    initialGrid: initial,
    baseCascades: baseRun.cascades,
    freeSpinsTriggered,
    freeSpins,
    chargeMeterAdd: 0, // buy bonus doesn't add to charge
    totalPayout,
    spinType: 'buyBonus',
  };
}

export const ENGINE_META = {
  rtpBps: 9200, // 92.00%
  houseEdgeBps: 800,
  gridSize: GRID_SIZE,
  maxWinX: 25000,
  chargeThresholdMin: 180,
  chargeThresholdMax: 300,
};
