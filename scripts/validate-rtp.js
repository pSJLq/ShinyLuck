/* eslint-disable */
/**
 * validate-rtp.js - empirical RTP for SUGAR.LAB (cluster) and VAULT.7 (lines).
 *
 * Runs the pure-JS math from `slots-from-design/slots/cluster-engine.js` and
 * `slots-from-design/slots/engine.js`, simulating N spins per game at a fixed
 * stake. Reports:
 *
 *   - total stake
 *   - total payout (base game)
 *   - charge-meter contribution (SUGAR.LAB only)
 *   - buy-bonus and free-spin contribution if hit
 *   - empirical RTP = (total payout) / (total stake)
 *
 * Expected: ~92% per `slots-from-design/slots/STATS.md`.
 *
 * Usage:
 *   N=100000 node scripts/validate-rtp.js
 *   N=1000000 node scripts/validate-rtp.js   # production tuning
 *
 * The script is self-contained: it does NOT touch hardhat / chain / contracts.
 * The on-chain ClusterLib / Vault7Lib resolvers reproduce this same math, so a
 * passing empirical RTP here is the source of truth the contracts mirror.
 */

const N = Number(process.env.N || 100_000);
const STAKE = 1.0;
const SEED = process.env.SEED || `sim-${Date.now()}`;

// ============================================================================
// SUGAR.LAB - cluster engine (mirrors slots-from-design/slots/cluster-engine.js)
// ============================================================================

// RTP tuning constants - STATS.md pay tables intrinsically deliver only
// ~40% RTP for SUGAR and ~30% RTP for VAULT. We multiply the final pay-table
// output by these boosts to land within the STATS.md ~92% target.
// MUST stay in sync with `slots-from-design/slots/cluster-engine.js`,
// `slots-from-design/slots/engine.js`, `frontend/games/sugar/engine.js`,
// `frontend/games/vault7/engine.js`, `contracts/Casino.sol` (CLUSTER /
// SLOTS payout multipliers).
// v15 retuned these on chain with setPayBoost (contract defaults are still
// 332/560). Measuring with the old numbers reports an RTP nobody is playing —
// keep them equal to the deployed `payBoostX100` / 100 and re-measure whenever
// a boost changes.
const SUGAR_PAY_BOOST = 3.40;   // cluster payBoostX100 = 340
const VAULT_PAY_BOOST = 5.89;   // vault7  payBoostX100 = 589

const C_SYMBOLS = {
  WILD: { id: 'WILD', pay5: 0.4,  pay15: 18 },
  H1:   { id: 'H1',   pay5: 0.5,  pay15: 14 },
  H2:   { id: 'H2',   pay5: 0.4,  pay15: 10 },
  H3:   { id: 'H3',   pay5: 0.3,  pay15: 8  },
  M1:   { id: 'M1',   pay5: 0.25, pay15: 5  },
  M2:   { id: 'M2',   pay5: 0.20, pay15: 4.5},
  M3:   { id: 'M3',   pay5: 0.18, pay15: 4  },
  L1:   { id: 'L1',   pay5: 0.12, pay15: 2  },
  L2:   { id: 'L2',   pay5: 0.10, pay15: 1.5},
  SCAT: { id: 'SCAT', pay5: 0,    pay15: 0  },
};
const C_SIZE = 7;
const C_WEIGHTS = { WILD: 1, H1: 5, H2: 6, H3: 7, M1: 11, M2: 11, M3: 11, L1: 22, L2: 22, SCAT: 1 };
const C_BAG = [];
for (const k in C_WEIGHTS) for (let i = 0; i < C_WEIGHTS[k]; i++) C_BAG.push(k);

const MULT_VALUES = [2, 3, 4, 5, 8, 10, 15, 20, 25, 50, 100];
const MULT_WEIGHTS = [55, 38, 28, 18, 10, 6, 3, 2, 1, 1, 1];
const MULT_BAG = [];
for (let i = 0; i < MULT_VALUES.length; i++) for (let j = 0; j < MULT_WEIGHTS[i]; j++) MULT_BAG.push(MULT_VALUES[i]);

const CHARGE_REWARDS = [
  { id: 'CASH_XS', weight: 38, kind: 'cash',     payX: 3    },
  { id: 'CASH_S',  weight: 25, kind: 'cash',     payX: 8    },
  { id: 'CASH_M',  weight: 12, kind: 'cash',     payX: 18   },
  { id: 'CASH_L',  weight: 4,  kind: 'cash',     payX: 45   },
  { id: 'CASH_XL', weight: 1,  kind: 'cash',     payX: 120  },
  { id: 'FS3',     weight: 8,  kind: 'freespin', count: 3   },
  { id: 'FS5',     weight: 4,  kind: 'freespin', count: 5   },
  { id: 'MULT',    weight: 6,  kind: 'multorb' },
  { id: 'WILDS',   weight: 2,  kind: 'wilds' },
];
const CHARGE_BAG = [];
for (const r of CHARGE_REWARDS) for (let i = 0; i < r.weight; i++) CHARGE_BAG.push(r);

function hashSeed(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rngFromSeed(s) {
  let a = hashSeed(s) || 1;
  return () => {
    a ^= a << 13; a >>>= 0;
    a ^= a >>> 17; a >>>= 0;
    a ^= a << 5;  a >>>= 0;
    return (a >>> 0) / 0x100000000;
  };
}

class ClusterSim {
  constructor(seed) {
    this.stake = STAKE;
    this.serverSeed = seed;
    this.nonce = 0;
    this.freeSpins = 0;
    this.stickyMults = [];
    this.charge = 0;
    this.chargeThreshold = 180 + Math.floor(Math.random() * 121);
    this.pendingWildStorm = false;
    this.totals = { stake: 0, basePay: 0, fsPay: 0, chargePay: 0, fsTriggers: 0, chargeTriggers: 0 };
  }
  rng() {
    this.nonce++;
    return rngFromSeed(`${this.serverSeed}:${this.nonce}`);
  }
  randomGrid(rng) {
    const g = [];
    for (let r = 0; r < C_SIZE; r++) {
      const row = [];
      for (let c = 0; c < C_SIZE; c++) row.push(C_BAG[Math.floor(rng() * C_BAG.length)]);
      g.push(row);
    }
    return g;
  }
  findClusters(grid) {
    const seen = Array.from({ length: C_SIZE }, () => Array(C_SIZE).fill(false));
    const clusters = [];
    for (let r = 0; r < C_SIZE; r++) for (let c = 0; c < C_SIZE; c++) {
      const sym = grid[r][c];
      if (!sym || sym === 'SCAT' || sym === 'WILD' || seen[r][c]) continue;
      const stack = [[r, c]];
      const cells = [];
      seen[r][c] = true;
      while (stack.length) {
        const [y, x] = stack.pop();
        cells.push([y, x]);
        const neigh = [[y - 1, x], [y + 1, x], [y, x - 1], [y, x + 1]];
        for (const [ny, nx] of neigh) {
          if (ny < 0 || ny >= C_SIZE || nx < 0 || nx >= C_SIZE) continue;
          if (seen[ny][nx]) continue;
          const s = grid[ny][nx];
          if (s === sym || s === 'WILD') { seen[ny][nx] = true; stack.push([ny, nx]); }
        }
      }
      if (cells.length >= 5) clusters.push({ sym, cells });
    }
    return clusters;
  }
  symbolPay(symId, n) {
    const s = C_SYMBOLS[symId]; if (!s) return 0;
    const t = Math.min(1, (n - 5) / 10);
    const p = s.pay5 + (s.pay15 - s.pay5) * t;
    const big = n >= 20 ? (n - 19) * 0.25 : 0;
    return (p + big) * SUGAR_PAY_BOOST;
  }
  tumble(grid, removeSet, rng) {
    for (let c = 0; c < C_SIZE; c++) {
      const col = [];
      for (let r = C_SIZE - 1; r >= 0; r--) {
        if (!removeSet.has(r + ',' + c)) col.push(grid[r][c]);
      }
      while (col.length < C_SIZE) col.push(C_BAG[Math.floor(rng() * C_BAG.length)]);
      for (let r = C_SIZE - 1, i = 0; r >= 0; r--, i++) grid[r][c] = col[i];
    }
  }
  spin(buyBonus = false) {
    const isFree = this.freeSpins > 0;
    let cost = 0;
    if (buyBonus) cost = this.stake * 100;
    else if (!isFree) cost = this.stake;
    this.totals.stake += cost;

    const rng = this.rng();

    let grid;
    let scatters = 0;
    if (buyBonus) {
      let tries = 0;
      do {
        grid = this.randomGrid(rng);
        scatters = grid.flat().filter(s => s === 'SCAT').length;
        tries++;
      } while (scatters < 4 && tries < 500);
    } else {
      grid = this.randomGrid(rng);
      scatters = grid.flat().filter(s => s === 'SCAT').length;
    }

    if (this.pendingWildStorm) {
      this.pendingWildStorm = false;
      const wildCount = 4 + Math.floor(rng() * 4);
      let placed = 0, tries = 0;
      while (placed < wildCount && tries < 200) {
        const r = Math.floor(rng() * C_SIZE);
        const c = Math.floor(rng() * C_SIZE);
        if (grid[r][c] !== 'WILD' && grid[r][c] !== 'SCAT') { grid[r][c] = 'WILD'; placed++; }
        tries++;
      }
    }

    let totalWin = 0;
    let chainIdx = 0;
    while (true) {
      const clusters = this.findClusters(grid);
      if (clusters.length === 0) break;
      let stepWin = 0;
      const winningCells = new Set();
      for (const cl of clusters) {
        stepWin += this.symbolPay(cl.sym, cl.cells.length) * this.stake;
        for (const [r, c] of cl.cells) winningCells.add(r + ',' + c);
      }
      let multApplied = 0;
      if (isFree || buyBonus) {
        for (const m of this.stickyMults) if (winningCells.has(m.row + ',' + m.col)) multApplied += m.value;
        if (multApplied > 0) stepWin *= multApplied;
      }
      totalWin += stepWin;
      this.tumble(grid, winningCells, rng);
      if (isFree || buyBonus) {
        const pMult = Math.min(0.55, 0.18 + chainIdx * 0.07);
        if (rng() < pMult) {
          const r = Math.floor(rng() * C_SIZE);
          const c = Math.floor(rng() * C_SIZE);
          if (!this.stickyMults.some(m => m.row === r && m.col === c)) {
            const value = MULT_BAG[Math.floor(rng() * MULT_BAG.length)];
            this.stickyMults.push({ row: r, col: c, value });
          }
        }
      }
      chainIdx++;
      if (chainIdx > 50) break;
    }

    if (isFree || buyBonus) this.totals.fsPay += totalWin;
    else this.totals.basePay += totalWin;

    let triggered = false;
    if (scatters >= 4 && !isFree) {
      const fs = scatters >= 6 ? 20 : scatters === 5 ? 15 : 10;
      this.freeSpins += fs;
      this.stickyMults = [];
      this.totals.fsTriggers++;
      triggered = true;
    } else if (scatters >= 3 && isFree) {
      this.freeSpins += 5;
    }
    if (isFree) this.freeSpins--;

    if (!isFree && !buyBonus) {
      const base = 2.2 + (this.stake / 50) * 3.5;
      const missBonus = totalWin === 0 ? 1.2 : 0;
      this.charge += base + missBonus + rng() * 1.5;
      if (this.charge >= this.chargeThreshold) {
        const r = CHARGE_BAG[Math.floor(rng() * CHARGE_BAG.length)];
        if (r.kind === 'cash') this.totals.chargePay += r.payX * this.stake;
        else if (r.kind === 'freespin') this.freeSpins += r.count;
        else if (r.kind === 'multorb') {
          const pool = [5, 8, 10, 15, 20, 25, 50];
          this.totals.chargePay += pool[Math.floor(rng() * pool.length)] * this.stake;
        } else if (r.kind === 'wilds') {
          this.pendingWildStorm = true;
        }
        this.charge = 0;
        this.chargeThreshold = 180 + Math.floor(rng() * 121);
        this.totals.chargeTriggers++;
      }
    }
    return { totalWin, isFree, buyBonus, scatters };
  }
}

// ============================================================================
// VAULT.7 - line engine (mirrors slots-from-design/slots/engine.js)
// ============================================================================

const V_SYMBOLS = {
  WILD: { pay: [0, 0, 50, 200, 800] },
  DIAM: { pay: [0, 0, 25, 100, 400] },
  CRYS: { pay: [0, 0, 12, 50,  200] },
  BOLT: { pay: [0, 0, 8,  25,  100] },
  COIN: { pay: [0, 0, 5,  15,  60]  },
  A:    { pay: [0, 0, 3,  10,  40]  },
  F:    { pay: [0, 0, 2,  6,   24]  },
  D:    { pay: [0, 0, 1.5, 4,  16]  },
  E:    { pay: [0, 0, 1,  3,   12]  },
  SCAT: { pay: [0, 0, 0,  0,   0]   },
};
const V_REEL_STRIPS = [
  ['E','D','F','A','COIN','E','F','D','BOLT','A','E','F','COIN','D','CRYS','E','F','A','D','BOLT','E','F','D','WILD','A','COIN','E','D','DIAM','F','A','E','SCAT','D','F','A','E','BOLT','D','F'],
  ['F','D','E','A','BOLT','F','D','E','COIN','A','D','F','E','BOLT','A','CRYS','D','E','F','A','BOLT','D','E','COIN','F','DIAM','A','D','E','F','WILD','A','D','SCAT','E','F','A','D','BOLT','E'],
  ['D','E','F','BOLT','A','D','F','COIN','E','A','D','CRYS','F','E','A','BOLT','D','F','WILD','E','A','COIN','D','F','DIAM','E','A','D','BOLT','F','SCAT','E','A','D','F','CRYS','E','A','BOLT','D'],
  ['F','A','D','E','COIN','F','A','D','BOLT','E','F','A','CRYS','D','E','F','A','D','BOLT','E','F','A','WILD','D','COIN','E','F','A','DIAM','D','E','F','SCAT','A','D','E','F','BOLT','A','D'],
  ['E','F','A','D','BOLT','E','F','A','COIN','D','E','F','A','BOLT','D','CRYS','E','F','A','D','BOLT','E','F','COIN','A','D','DIAM','E','F','A','WILD','D','E','SCAT','F','A','D','E','BOLT','F'],
];
const V_PAYLINES = [
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
const V_ROWS = 3, V_COLS = 5, V_LINES = 20;

class Vault7Sim {
  constructor(seed) {
    this.stake = STAKE;
    this.serverSeed = seed;
    this.nonce = 0;
    this.freeSpins = 0;
    this.freeSpinMult = 1;
    this.totals = { stake: 0, basePay: 0, scatterPay: 0, fsPay: 0, fsTriggers: 0 };
  }
  rng() { this.nonce++; return rngFromSeed(`${this.serverSeed}:${this.nonce}`); }
  spinGrid(rng) {
    const grid = [];
    for (let c = 0; c < V_COLS; c++) {
      const strip = V_REEL_STRIPS[c];
      const start = Math.floor(rng() * strip.length);
      const col = [];
      for (let r = 0; r < V_ROWS; r++) col.push(strip[(start + r) % strip.length]);
      grid.push(col);
    }
    return grid;
  }
  evaluate(grid, stake, mult) {
    const lineBet = stake / V_LINES;
    let totalLine = 0;
    for (let li = 0; li < V_PAYLINES.length; li++) {
      const pl = V_PAYLINES[li];
      const seq = pl.map((row, col) => grid[col][row]);
      let anchor = null;
      for (const s of seq) if (s !== 'WILD' && s !== 'SCAT') { anchor = s; break; }
      let target, count = 0;
      if (!anchor) {
        target = 'WILD';
        for (const s of seq) if (s === 'WILD') count++; else break;
      } else {
        target = anchor;
        for (const s of seq) if (s === target || s === 'WILD') count++; else break;
      }
      if (count >= 3 && target !== 'SCAT') {
        const sym = V_SYMBOLS[target];
        totalLine += sym.pay[count - 1] * lineBet * mult;
      }
    }
    totalLine *= VAULT_PAY_BOOST;
    let scatCount = 0;
    for (let c = 0; c < V_COLS; c++) for (let r = 0; r < V_ROWS; r++) if (grid[c][r] === 'SCAT') scatCount++;
    // NOTE: original engine.js has off-by-one ([0,0,2,10,50] → 2-scat pays
    // ×2). STATS.md says 3+ scatters pay 2/10/50, matching Vault7Lib.sol.
    // We use the corrected table here.
    const scatterPays = [0, 0, 0, 2, 10, 50];
    const scatPay = (scatterPays[scatCount] || 0) * stake;
    return { totalLine, scatPay, scatCount };
  }
  spin(buyBonus = false) {
    const isFree = this.freeSpins > 0;
    let cost = 0;
    let mult = 1;
    if (buyBonus) cost = this.stake * 75;
    else if (!isFree) cost = this.stake;
    else { mult = this.freeSpinMult; this.freeSpins--; }
    this.totals.stake += cost;

    const rng = this.rng();
    let grid, res;
    if (buyBonus) {
      let tries = 0;
      do { grid = this.spinGrid(rng); res = this.evaluate(grid, this.stake, mult); tries++; }
      while (res.scatCount < 3 && tries < 200);
    } else {
      grid = this.spinGrid(rng);
      res = this.evaluate(grid, this.stake, mult);
    }
    const win = res.totalLine + res.scatPay;
    if (buyBonus || isFree) this.totals.fsPay += win;
    else {
      this.totals.basePay += res.totalLine;
      this.totals.scatterPay += res.scatPay;
    }

    if (res.scatCount >= 3 && !isFree && !buyBonus) {
      const fs = res.scatCount >= 5 ? 20 : res.scatCount === 4 ? 15 : 10;
      this.freeSpins += fs;
      this.freeSpinMult = 2;
      this.totals.fsTriggers++;
    } else if (res.scatCount >= 3 && isFree) {
      this.freeSpins += 5;
    } else if (buyBonus) {
      const fs = res.scatCount >= 5 ? 20 : res.scatCount === 4 ? 15 : 10;
      this.freeSpins = fs;
      this.freeSpinMult = 2;
    }
    return { win, scatCount: res.scatCount };
  }
}

// ============================================================================
// Run
// ============================================================================

function pct(x) { return (x * 100).toFixed(3) + '%'; }
function num(x) { return x.toLocaleString(undefined, { maximumFractionDigits: 2 }); }

function runSugar(label, seed, N) {
  const sim = new ClusterSim(seed);
  for (let i = 0; i < N; i++) sim.spin(false);
  // drain any free spins still owed
  let safety = 0;
  while (sim.freeSpins > 0 && safety++ < 1000) sim.spin(false);
  const t = sim.totals;
  const totalPay = t.basePay + t.fsPay + t.chargePay;
  const rtp = totalPay / t.stake;
  console.log(`\n=== ${label} ===`);
  console.log(`spins:           ${num(N)}`);
  console.log(`stake total:     ${num(t.stake)}`);
  console.log(`base pay:        ${num(t.basePay)}  (${pct(t.basePay / t.stake)})`);
  console.log(`free-spin pay:   ${num(t.fsPay)}  (${pct(t.fsPay / t.stake)})  triggers=${t.fsTriggers}`);
  console.log(`charge pay:      ${num(t.chargePay)}  (${pct(t.chargePay / t.stake)})  triggers=${t.chargeTriggers}`);
  console.log(`EMPIRICAL RTP:   ${pct(rtp)}`);
  return rtp;
}

function runVault(label, seed, N) {
  const sim = new Vault7Sim(seed);
  for (let i = 0; i < N; i++) sim.spin(false);
  let safety = 0;
  while (sim.freeSpins > 0 && safety++ < 1000) sim.spin(false);
  const t = sim.totals;
  const totalPay = t.basePay + t.scatterPay + t.fsPay;
  const rtp = totalPay / t.stake;
  console.log(`\n=== ${label} ===`);
  console.log(`spins:           ${num(N)}`);
  console.log(`stake total:     ${num(t.stake)}`);
  console.log(`line pay:        ${num(t.basePay)}  (${pct(t.basePay / t.stake)})`);
  console.log(`scatter pay:     ${num(t.scatterPay)}  (${pct(t.scatterPay / t.stake)})`);
  console.log(`free-spin pay:   ${num(t.fsPay)}  (${pct(t.fsPay / t.stake)})  triggers=${t.fsTriggers}`);
  console.log(`EMPIRICAL RTP:   ${pct(rtp)}`);
  return rtp;
}

console.log(`SHINY·LUCK · empirical RTP from JS engines · seed="${SEED}", N=${num(N)} per game\n`);
const rtpSugar = runSugar('SUGAR.LAB (7×7 cluster, base + FS + charge)', SEED + '-sugar', N);
const rtpVault = runVault('VAULT.7 (5×3 / 20 lines, base + FS)', SEED + '-vault', N);

console.log('\n=== Summary ===');
console.log(`SUGAR.LAB: ${pct(rtpSugar)}   target ~92%   ${rtpSugar >= 0.90 && rtpSugar <= 0.94 ? 'OK' : 'OUT-OF-BAND'}`);
console.log(`VAULT.7:   ${pct(rtpVault)}   target ~92%   ${rtpVault >= 0.90 && rtpVault <= 0.94 ? 'OK' : 'OUT-OF-BAND'}`);

if (rtpSugar < 0.85 || rtpSugar > 1.05 || rtpVault < 0.85 || rtpVault > 1.05) {
  console.error('\nWARNING: RTP outside sanity band - investigate engine before contract redeploy.');
  process.exitCode = 1;
}
