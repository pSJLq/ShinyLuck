/* ============================================================================
 * vault7/engine.js — pure math + ResultData generator for VAULT.7 (5×3, 20 lines)
 * No DOM. Deterministic from seed. Wei (bigint) for amounts.
 * ============================================================================ */

export const SYMBOL_INDEX = {
  WILD:0, DIAM:1, CRYS:2, BOLT:3, COIN:4,
  A:5, F:6, D:7, E:8, SCAT:9,
};
export const SYMBOL_BY_INDEX = ['WILD','DIAM','CRYS','BOLT','COIN','A','F','D','E','SCAT'];

// pay table — [3-of-a-kind, 4, 5] (multiplier of line bet)
export const SYMBOL_PAY = {
  WILD: [50, 200, 800],
  DIAM: [25, 100, 400],
  CRYS: [12,  50, 200],
  BOLT: [ 8,  25, 100],
  COIN: [ 5,  15,  60],
  A:    [ 3,  10,  40],
  F:    [ 2,   6,  24],
  D:    [1.5,  4,  16],
  E:    [ 1,   3,  12],
};

const SCATTER_PAY = { 3: 2, 4: 10, 5: 50 }; // × total stake

// RTP boost — the STATS.md pay tables alone deliver only ~30% RTP (see
// `scripts/validate-rtp.js`). This multiplier scales every line / scatter
// payout uniformly so empirical RTP lands at ~91-92%. MUST stay in sync
// with `contracts/Casino.sol::VAULT7_PAY_BOOST_X100` (560 = 5.60).
export const VAULT_PAY_BOOST = 5.60;

const COLS = 5, ROWS = 3;
const SCAT = SYMBOL_INDEX.SCAT;
const WILD = SYMBOL_INDEX.WILD;

// 20 paylines: each is [rowIdx for col0, col1, col2, col3, col4]
export const PAYLINES = [
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

// per-reel strips (numeric symbol indices). Central reel a touch richer.
export const REEL_STRIPS = (() => {
  const idx = SYMBOL_INDEX;
  const make = (extras) => [
    idx.E, idx.D, idx.F, idx.A, idx.COIN, idx.E, idx.F, idx.D, idx.BOLT, idx.A,
    idx.E, idx.F, idx.COIN, idx.D, idx.CRYS, idx.E, idx.F, idx.A, idx.D, idx.BOLT,
    idx.E, idx.F, idx.D, idx.WILD, idx.A, idx.COIN, idx.E, idx.D, idx.DIAM, idx.F,
    idx.A, idx.E, idx.SCAT, idx.D, idx.F, idx.A, idx.E, idx.BOLT, idx.D, idx.F,
    ...extras,
  ];
  return [
    make([]),
    make([idx.A, idx.F]),
    make([idx.CRYS, idx.BOLT, idx.DIAM, idx.D]), // richer middle reel
    make([idx.F, idx.A]),
    make([]),
  ];
})();

// ---------- deterministic RNG ----------
function hashSeed(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function makeRng(seed) {
  let a = hashSeed(seed) || 1;
  return () => {
    a ^= a << 13; a >>>= 0; a ^= a >>> 17; a >>>= 0; a ^= a << 5; a >>>= 0;
    return (a >>> 0) / 0x100000000;
  };
}

const SCALE = 10_000n;
function scaleMul(stakeWei, mult) {
  const m = BigInt(Math.round(mult * Number(SCALE)));
  return (stakeWei * m) / SCALE;
}

function spinReels(rng) {
  // grid is column-major: grid[col][row]
  const grid = [];
  for (let c = 0; c < COLS; c++) {
    const strip = REEL_STRIPS[c];
    const start = Math.floor(rng() * strip.length);
    const col = [];
    for (let r = 0; r < ROWS; r++) col.push(strip[(start + r) % strip.length]);
    grid.push(col);
  }
  return grid;
}

function countScattersGrid(grid) {
  let n = 0; const positions = [];
  for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) if (grid[c][r] === SCAT) { n++; positions.push([c, r]); }
  return { count: n, positions };
}

function evaluate(grid, stakeWei, multiplier = 1) {
  const lineBet = stakeWei / 20n;
  const winningLines = [];
  for (let li = 0; li < PAYLINES.length; li++) {
    const pl = PAYLINES[li];
    const seq = pl.map((row, col) => grid[col][row]);
    // anchor symbol = first non-WILD non-SCAT
    let anchor = null;
    for (const s of seq) { if (s !== WILD && s !== SCAT) { anchor = s; break; } }
    let target = anchor;
    let count = 0;
    if (anchor == null) {
      target = WILD;
      for (let i = 0; i < seq.length; i++) { if (seq[i] === WILD) count++; else break; }
    } else {
      for (let i = 0; i < seq.length; i++) {
        const s = seq[i];
        if (s === target || s === WILD) count++; else break;
      }
    }
    if (count >= 3 && target !== SCAT) {
      const def = SYMBOL_PAY[SYMBOL_BY_INDEX[target]];
      const mult = def[count - 3];
      if (mult > 0) {
        let payout = scaleMul(lineBet, mult * VAULT_PAY_BOOST);
        if (multiplier > 1) payout = payout * BigInt(multiplier);
        winningLines.push({ lineIndex: li, symbolIndex: target, matchCount: count, payout });
      }
    }
  }
  const { count: scatterCount, positions: scatterPositions } = countScattersGrid(grid);
  let scatterPayout = 0n;
  if (SCATTER_PAY[scatterCount]) {
    scatterPayout = scaleMul(stakeWei, SCATTER_PAY[scatterCount] * VAULT_PAY_BOOST);
    if (multiplier > 1) scatterPayout *= BigInt(multiplier);
  }
  let totalLine = 0n; for (const w of winningLines) totalLine += w.payout;
  return { winningLines, scatterCount, scatterPositions, scatterPayout, total: totalLine + scatterPayout };
}

function placeForcedScatters(grid, minCount, rng) {
  let placed = countScattersGrid(grid).count;
  let tries = 0;
  while (placed < minCount && tries < 600) {
    const c = Math.floor(rng() * COLS);
    const r = Math.floor(rng() * ROWS);
    if (grid[c][r] !== SCAT) { grid[c][r] = SCAT; placed++; }
    tries++;
  }
}

function buildFreeSpin(spinNumber, stakeWei, rng) {
  const grid = spinReels(rng);
  const ev = evaluate(grid, stakeWei, 2); // ×2 in FS
  let retriggerAdded = 0;
  if (ev.scatterCount >= 3) retriggerAdded = ev.scatterCount >= 5 ? 15 : ev.scatterCount === 4 ? 10 : 5;
  return {
    payload: {
      spinNumber,
      grid,
      winningLines: ev.winningLines,
      scatterCount: ev.scatterCount,
      scatterPositions: ev.scatterPositions,
      scatterPayout: ev.scatterPayout,
      payoutWithMultiplier: ev.total,
      retriggerAdded,
    },
    spinTotal: ev.total,
  };
}

export function generateSpin(stakeWei, seed) {
  const rng = makeRng(seed);
  const grid = spinReels(rng);
  const ev = evaluate(grid, stakeWei, 1);
  let freeSpinsTriggered = 0;
  if (ev.scatterCount >= 3) freeSpinsTriggered = ev.scatterCount >= 5 ? 20 : ev.scatterCount === 4 ? 15 : 10;

  let totalPayout = ev.total;
  const freeSpins = [];
  if (freeSpinsTriggered > 0) {
    let remaining = freeSpinsTriggered;
    let n = 1;
    while (remaining > 0) {
      const { payload, spinTotal } = buildFreeSpin(n, stakeWei, rng);
      remaining--;
      remaining += payload.retriggerAdded;
      totalPayout += spinTotal;
      freeSpins.push(payload);
      n++;
      if (n > 200) break;
    }
  }
  return {
    grid,
    winningLines: ev.winningLines,
    scatterCount: ev.scatterCount,
    scatterPositions: ev.scatterPositions,
    scatterPayout: ev.scatterPayout,
    freeSpinsTriggered,
    freeSpins,
    totalPayout,
    spinType: 'base',
  };
}

export function generateBuyBonusSpin(stakeWei, seed) {
  const rng = makeRng(seed);
  const grid = spinReels(rng);
  placeForcedScatters(grid, 3, rng);
  const ev = evaluate(grid, stakeWei, 1);
  const freeSpinsTriggered = ev.scatterCount >= 5 ? 20 : ev.scatterCount === 4 ? 15 : 10;
  let totalPayout = ev.total;
  const freeSpins = [];
  let remaining = freeSpinsTriggered;
  let n = 1;
  while (remaining > 0) {
    const { payload, spinTotal } = buildFreeSpin(n, stakeWei, rng);
    remaining--;
    remaining += payload.retriggerAdded;
    totalPayout += spinTotal;
    freeSpins.push(payload);
    n++;
    if (n > 200) break;
  }
  return {
    grid,
    winningLines: ev.winningLines,
    scatterCount: ev.scatterCount,
    scatterPositions: ev.scatterPositions,
    scatterPayout: ev.scatterPayout,
    freeSpinsTriggered,
    freeSpins,
    totalPayout,
    spinType: 'buyBonus',
  };
}

export const ENGINE_META = { rtpBps: 9200, houseEdgeBps: 800, cols: COLS, rows: ROWS, lines: PAYLINES.length, maxWinX: 10000 };
