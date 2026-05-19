/* ==========================================================
 * SUGAR.LAB — cluster pays engine (7x7)
 * Sticky multipliers, tumble cascades, scatter -> free spins
 * ========================================================== */

const C_SYMBOLS = {
  WILD: { id: 'WILD', glyph: '✦', kind: 'wild', color: '#fff',     pay5: 0.4, pay15: 18 },
  H1:   { id: 'H1',   glyph: '♥', kind: 'high', color: '#ff5e8a',  pay5: 0.5, pay15: 14 },
  H2:   { id: 'H2',   glyph: '◆', kind: 'high', color: '#4ee3ff',  pay5: 0.4, pay15: 10 },
  H3:   { id: 'H3',   glyph: '⬡', kind: 'high', color: '#b794ff',  pay5: 0.3, pay15: 8  },
  M1:   { id: 'M1',   glyph: '●', kind: 'mid',  color: '#ffc847',  pay5: 0.25,pay15: 5  },
  M2:   { id: 'M2',   glyph: '▲', kind: 'mid',  color: '#4ade80',  pay5: 0.20,pay15: 4.5},
  M3:   { id: 'M3',   glyph: '◼', kind: 'mid',  color: '#ff9a3c',  pay5: 0.18,pay15: 4  },
  L1:   { id: 'L1',   glyph: '✕', kind: 'low',  color: '#7f8aa5',  pay5: 0.12,pay15: 2  },
  L2:   { id: 'L2',   glyph: '◯', kind: 'low',  color: '#8fb3d0',  pay5: 0.10,pay15: 1.5},
  SCAT: { id: 'SCAT', glyph: '✺', kind: 'scat', color: '#ffc847',  pay5: 0,   pay15: 0  },
};

const C_SIZE = 7;

// reel "bag" – weighted draw pool
const C_BAG = [];
const C_WEIGHTS = {
  WILD: 1,
  H1: 5, H2: 6, H3: 7,
  M1: 11, M2: 11, M3: 11,
  L1: 22, L2: 22,
  SCAT: 1,
};
for (const k in C_WEIGHTS) for (let i = 0; i < C_WEIGHTS[k]; i++) C_BAG.push(k);

const C_STAKE_PRESETS = [0.10, 0.25, 0.50, 1.00, 2.50, 5.00, 10.00, 25.00, 50.00];
// multipliers that can drop during free spins
const MULT_VALUES = [2, 3, 4, 5, 8, 10, 15, 20, 25, 50, 100];
const MULT_WEIGHTS = [55, 38, 28, 18, 10, 6, 3, 2, 1, 1, 1];
const MULT_BAG = [];
for (let i = 0; i < MULT_VALUES.length; i++) for (let j = 0; j < MULT_WEIGHTS[i]; j++) MULT_BAG.push(MULT_VALUES[i]);

function hashSeed(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rngFromSeed(s) {
  let a = hashSeed(s) || 1;
  return () => {
    a ^= a << 13; a >>>= 0; a ^= a >>> 17; a >>>= 0; a ^= a << 5; a >>>= 0;
    return (a >>> 0) / 0x100000000;
  };
}
function makeSeed(len=24) {
  const a = 'abcdef0123456789'; let s = '';
  for (let i=0;i<len;i++) s += a[Math.floor(Math.random()*a.length)];
  return s;
}

// Charge Meter — hidden-threshold reward mechanic.
// Player sees a filling bar (no numbers). Threshold is random.
// Tuned so house keeps a healthy edge: small frequent rewards, rare big ones.
const CHARGE_REWARDS = [
  { id: 'CASH_XS', weight: 38, label: 'CASH TIP',      kind: 'cash',     payX: 3    },
  { id: 'CASH_S',  weight: 25, label: 'CASH DROP',     kind: 'cash',     payX: 8    },
  { id: 'CASH_M',  weight: 12, label: 'CASH SURGE',    kind: 'cash',     payX: 18   },
  { id: 'CASH_L',  weight: 4,  label: 'CASH BLAST',    kind: 'cash',     payX: 45   },
  { id: 'CASH_XL', weight: 1,  label: 'JACKPOT BURST', kind: 'cash',     payX: 120  },
  { id: 'FS3',     weight: 8,  label: '+3 FREE SPINS', kind: 'freespin', count: 3   },
  { id: 'FS5',     weight: 4,  label: '+5 FREE SPINS', kind: 'freespin', count: 5   },
  { id: 'MULT',    weight: 6,  label: 'MYSTERY ×',     kind: 'multorb' },
  { id: 'WILDS',   weight: 2,  label: 'WILD STORM',    kind: 'wilds' },
];
const CHARGE_BAG = [];
for (const r of CHARGE_REWARDS) for (let i = 0; i < r.weight; i++) CHARGE_BAG.push(r);

class ClusterEngine {
  constructor() {
    this.balance = 1000.00;
    this.stakeIdx = 3;
    this.serverSeed = makeSeed(40);
    this.clientSeed = makeSeed(24);
    this.nonce = 0;
    this.freeSpins = 0;
    this.bonusActive = false;
    this.stickyMults = []; // {row, col, value}
    this.bonusTotal = 0;
    // charge meter state
    this.charge = 0;
    this.chargeThreshold = 180 + Math.floor(Math.random() * 121); // 180..300
    this.chargeCycle = 1;
    this.pendingWildStorm = false; // adds wilds to next spin
  }

  // visible "fullness" — non-linear so the meter feels like it accelerates near full
  // but never actually shows true progress. Caps at 92% until trigger.
  visibleFill() {
    const raw = Math.min(1, this.charge / Math.max(this.chargeThreshold, 1));
    const eased = Math.pow(raw, 0.55); // steeper-feeling early progress, slower near top
    return Math.min(0.92, eased);
  }

  rollChargeReward(rng) {
    const r = CHARGE_BAG[Math.floor(rng() * CHARGE_BAG.length)];
    return { ...r };
  }
  get stake() { return C_STAKE_PRESETS[this.stakeIdx]; }
  setStake(i) { this.stakeIdx = Math.max(0, Math.min(C_STAKE_PRESETS.length - 1, i)); }

  randomGrid(rng) {
    const g = [];
    for (let r = 0; r < C_SIZE; r++) {
      const row = [];
      for (let c = 0; c < C_SIZE; c++) row.push(C_BAG[Math.floor(rng() * C_BAG.length)]);
      g.push(row);
    }
    return g;
  }

  // BFS flood-fill cluster detect; only orthogonal; WILD acts as match for any non-SCAT cluster
  findClusters(grid) {
    const seen = Array.from({length: C_SIZE}, () => Array(C_SIZE).fill(false));
    const clusters = [];
    for (let r = 0; r < C_SIZE; r++) for (let c = 0; c < C_SIZE; c++) {
      const sym = grid[r][c];
      if (!sym || sym === 'SCAT' || sym === 'WILD' || seen[r][c]) continue;
      // BFS from this anchor; collect cells whose sym matches OR is WILD
      const stack = [[r, c]];
      const cells = [];
      seen[r][c] = true;
      while (stack.length) {
        const [y, x] = stack.pop();
        cells.push([y, x]);
        const neigh = [[y-1,x],[y+1,x],[y,x-1],[y,x+1]];
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

  // payout for cluster of size n for symbol
  symbolPay(symId, n) {
    const s = C_SYMBOLS[symId];
    if (!s) return 0;
    // linear interp between pay5 and pay15 across n=5..15+
    const t = Math.min(1, (n - 5) / 10);
    const p = s.pay5 + (s.pay15 - s.pay5) * t;
    // smaller bonus for huge clusters (was .5 per extra)
    const big = n >= 20 ? (n - 19) * 0.25 : 0;
    return p + big;
  }

  // remove cells, gravity-drop, fill new from top
  tumble(grid, removeSet, rng) {
    for (let c = 0; c < C_SIZE; c++) {
      const col = [];
      for (let r = C_SIZE - 1; r >= 0; r--) {
        if (!removeSet.has(r+','+c)) col.push(grid[r][c]);
      }
      while (col.length < C_SIZE) col.push(C_BAG[Math.floor(rng() * C_BAG.length)]);
      // re-write column from bottom up
      for (let r = C_SIZE - 1, i = 0; r >= 0; r--, i++) grid[r][c] = col[i];
    }
  }

  spin(buyBonus=false) {
    const isFree = this.freeSpins > 0;
    let cost = 0;
    if (buyBonus) {
      cost = this.stake * 100;
      if (this.balance < cost) return { error: 'insufficient' };
      this.balance -= cost;
    } else if (!isFree) {
      cost = this.stake;
      if (this.balance < cost) return { error: 'insufficient' };
      this.balance -= cost;
    }

    this.nonce++;
    const rng = rngFromSeed(this.serverSeed + ':' + this.clientSeed + ':' + this.nonce);

    let grid;
    let scatters = 0;
    if (buyBonus) {
      // force ≥4 scatters
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

    // Wild Storm: sprinkle wilds before evaluation
    let wildStormApplied = false;
    if (this.pendingWildStorm) {
      this.pendingWildStorm = false;
      wildStormApplied = true;
      const wildCount = 4 + Math.floor(rng() * 4); // 4..7 wilds
      let placed = 0, tries = 0;
      while (placed < wildCount && tries < 200) {
        const r = Math.floor(rng() * C_SIZE);
        const c = Math.floor(rng() * C_SIZE);
        if (grid[r][c] !== 'WILD' && grid[r][c] !== 'SCAT') { grid[r][c] = 'WILD'; placed++; }
        tries++;
      }
    }

    // cascade chain
    const steps = [];
    let totalWin = 0;
    let chainIdx = 0;
    // start: record initial grid
    steps.push({ type: 'initial', grid: grid.map(r => r.slice()), scatters });

    while (true) {
      const clusters = this.findClusters(grid);
      if (clusters.length === 0) break;
      // payout for this step
      let stepWin = 0;
      const winningCells = new Set();
      const stepClusters = [];
      for (const cl of clusters) {
        const pay = this.symbolPay(cl.sym, cl.cells.length) * this.stake;
        stepWin += pay;
        for (const [r, c] of cl.cells) winningCells.add(r+','+c);
        stepClusters.push({ sym: cl.sym, size: cl.cells.length, payout: pay, cells: cl.cells });
      }
      // apply sticky multipliers (free spins): if any sticky cell is within a winning cluster, its multiplier applies once per cluster (sum)
      let multApplied = 0;
      if (isFree || buyBonus) {
        for (const m of this.stickyMults) {
          if (winningCells.has(m.row + ',' + m.col)) multApplied += m.value;
        }
        if (multApplied > 0) stepWin = stepWin * multApplied;
      }
      totalWin += stepWin;

      // record step
      steps.push({
        type: 'cascade',
        idx: chainIdx,
        clusters: stepClusters,
        winningCells: [...winningCells],
        stepWin,
        multApplied
      });

      // tumble
      this.tumble(grid, winningCells, rng);

      // chance to drop multiplier orbs during free spins (after tumble, on empty random cell)
      const newMults = [];
      if (isFree || buyBonus) {
        // probability rises with chain depth
        const pMult = Math.min(0.55, 0.18 + chainIdx * 0.07);
        if (rng() < pMult) {
          const r = Math.floor(rng() * C_SIZE);
          const c = Math.floor(rng() * C_SIZE);
          if (!this.stickyMults.some(m => m.row === r && m.col === c)) {
            const value = MULT_BAG[Math.floor(rng() * MULT_BAG.length)];
            this.stickyMults.push({ row: r, col: c, value });
            newMults.push({ row: r, col: c, value });
          }
        }
      }
      steps.push({ type: 'tumble', grid: grid.map(r => r.slice()), newMults });

      chainIdx++;
      if (chainIdx > 50) break; // safety
    }

    this.balance += totalWin;
    if (isFree || buyBonus) this.bonusTotal += totalWin;

    let triggered = false;
    let freeSpinsAwarded = 0;
    if (scatters >= 4 && !isFree) {
      // free spins
      freeSpinsAwarded = scatters >= 6 ? 20 : scatters === 5 ? 15 : 10;
      this.freeSpins += freeSpinsAwarded;
      this.stickyMults = []; // reset sticky pool
      this.bonusTotal = 0;
      triggered = true;
    } else if (scatters >= 3 && isFree) {
      // retrigger small
      freeSpinsAwarded = 5;
      this.freeSpins += freeSpinsAwarded;
    }

    if (isFree) this.freeSpins--;

    // ============== CHARGE METER ==============
    // Charges slowly. Smaller, mostly modest rewards. House keeps the edge.
    let chargeReward = null;
    if (!isFree && !buyBonus) {
      const base = 2.2 + (this.stake / 50) * 3.5; // 2.2..5.7ish
      const missBonus = totalWin === 0 ? 1.2 : 0;
      this.charge += base + missBonus + rng() * 1.5;

      if (this.charge >= this.chargeThreshold) {
        // pick a reward
        chargeReward = this.rollChargeReward(rng);
        // resolve
        if (chargeReward.kind === 'cash') {
          const amount = chargeReward.payX * this.stake;
          chargeReward.amount = amount;
          this.balance += amount;
        } else if (chargeReward.kind === 'freespin') {
          this.freeSpins += chargeReward.count;
          chargeReward.triggered = true;
        } else if (chargeReward.kind === 'multorb') {
          // smaller mystery mult range
          const pool = [5, 8, 10, 15, 20, 25, 50];
          const value = pool[Math.floor(rng() * pool.length)];
          chargeReward.multValue = value;
          const amount = value * this.stake;
          chargeReward.amount = amount;
          this.balance += amount;
        } else if (chargeReward.kind === 'wilds') {
          this.pendingWildStorm = true;
        }
        // reset with new hidden threshold (wider range so cycles vary a lot)
        this.charge = 0;
        this.chargeThreshold = 180 + Math.floor(rng() * 121); // 180..300
        this.chargeCycle++;
      }
    }

    // If bonus has just ended, summarize
    let bonusEnded = false;
    let bonusEndedTotal = 0;
    if (this.freeSpins === 0 && (isFree || buyBonus) && this.bonusTotal > 0) {
      bonusEnded = true;
      bonusEndedTotal = this.bonusTotal;
      this.bonusTotal = 0;
      this.stickyMults = [];
    }

    return {
      steps, totalWin, scatters, isFree, triggered, freeSpinsAwarded,
      stake: this.stake, buyBonus, finalGrid: grid,
      stickyMults: this.stickyMults.slice(),
      bonusEnded, bonusEndedTotal,
      chargeReward, wildStormApplied,
      chargeFill: this.visibleFill(),
      chargeCycle: this.chargeCycle,
    };
  }
}

window.ClusterEngine = ClusterEngine;
window.C_SYMBOLS = C_SYMBOLS;
window.C_SIZE = C_SIZE;
window.C_STAKE_PRESETS = C_STAKE_PRESETS;
window.MULT_VALUES = MULT_VALUES;
