/* ==========================================================
 * VAULT.7 — slot engine
 * provably-fair-ish RNG, weighted reels, 20 paylines, free spins
 * ========================================================== */

const SYMBOLS = {
  WILD: { id: 'WILD', glyph: '∞',  kind: 'wild', label: 'WILD',    pay: [0, 0, 50, 200, 800] },
  DIAM: { id: 'DIAM', glyph: '◆',  kind: 'high', label: 'DIAMOND', pay: [0, 0, 25, 100, 400] },
  CRYS: { id: 'CRYS', glyph: '⬢',  kind: 'high', label: 'CRYSTAL', pay: [0, 0, 12, 50,  200] },
  BOLT: { id: 'BOLT', glyph: '⚡', kind: 'mid',  label: 'BOLT',    pay: [0, 0, 8,  25,  100] },
  COIN: { id: 'COIN', glyph: '⬣',  kind: 'mid',  label: 'COIN',    pay: [0, 0, 5,  15,  60]  },
  A:    { id: 'A',    glyph: 'A',  kind: 'low',  label: 'HEX·A',   pay: [0, 0, 3,  10,  40]  },
  F:    { id: 'F',    glyph: 'F',  kind: 'low',  label: 'HEX·F',   pay: [0, 0, 2,  6,   24]  },
  D:    { id: 'D',    glyph: 'D',  kind: 'low',  label: 'HEX·D',   pay: [0, 0, 1.5, 4,  16]  },
  E:    { id: 'E',    glyph: 'E',  kind: 'low',  label: 'HEX·E',   pay: [0, 0, 1,  3,   12]  },
  SCAT: { id: 'SCAT', glyph: '✦',  kind: 'scat', label: 'SCATTER', pay: [0, 0, 0,  0,   0]   },
};

// per-reel weighted strips, slightly different per column so wins feel less repetitive
const REEL_STRIPS = [
  // col 0
  ['E','D','F','A','COIN','E','F','D','BOLT','A','E','F','COIN','D','CRYS','E','F','A','D','BOLT','E','F','D','WILD','A','COIN','E','D','DIAM','F','A','E','SCAT','D','F','A','E','BOLT','D','F'],
  // col 1
  ['F','D','E','A','BOLT','F','D','E','COIN','A','D','F','E','BOLT','A','CRYS','D','E','F','A','BOLT','D','E','COIN','F','DIAM','A','D','E','F','WILD','A','D','SCAT','E','F','A','D','BOLT','E'],
  // col 2 — middle reel is best
  ['D','E','F','BOLT','A','D','F','COIN','E','A','D','CRYS','F','E','A','BOLT','D','F','WILD','E','A','COIN','D','F','DIAM','E','A','D','BOLT','F','SCAT','E','A','D','F','CRYS','E','A','BOLT','D'],
  // col 3
  ['F','A','D','E','COIN','F','A','D','BOLT','E','F','A','CRYS','D','E','F','A','D','BOLT','E','F','A','WILD','D','COIN','E','F','A','DIAM','D','E','F','SCAT','A','D','E','F','BOLT','A','D'],
  // col 4
  ['E','F','A','D','BOLT','E','F','A','COIN','D','E','F','A','BOLT','D','CRYS','E','F','A','D','BOLT','E','F','COIN','A','D','DIAM','E','F','A','WILD','D','E','SCAT','F','A','D','E','BOLT','F'],
];

// 20 paylines: rows per column [0,1,2]
const PAYLINES = [
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

const ROWS = 3, COLS = 5;
const STAKE_PRESETS = [0.10, 0.25, 0.50, 1.00, 2.50, 5.00, 10.00, 25.00, 50.00];

// ============ RNG (deterministic from seed+nonce) ============
function hashSeed(s) {
  // tiny xorshift over string
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
function makeSeed(len=24) {
  const a = 'abcdef0123456789';
  let s = ''; for (let i=0;i<len;i++) s += a[Math.floor(Math.random()*a.length)];
  return s;
}

// ============ Engine ============
class SlotEngine {
  constructor() {
    this.balance = 1000.00;
    this.stakeIdx = 3; // 1.00
    this.serverSeed = makeSeed(40);
    this.clientSeed = makeSeed(24);
    this.nonce = 0;
    this.lastSpin = null;
    this.freeSpins = 0;
    this.freeSpinMult = 1;
    this.bonusActive = false;
    this.totalWonInBonus = 0;
  }
  get stake() { return STAKE_PRESETS[this.stakeIdx]; }
  setStake(idx) { this.stakeIdx = Math.max(0, Math.min(STAKE_PRESETS.length - 1, idx)); }

  // generate a 5x3 grid using reel strips weighted by their natural frequency
  spinGrid(force) {
    this.nonce++;
    const rng = rngFromSeed(this.serverSeed + ':' + this.clientSeed + ':' + this.nonce);
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

  // evaluate wins; returns { wins:[{line, ids, count, sym, payout, cells}], totalLine, scatterCount, scatterPay, total }
  evaluate(grid, stake, mult=1) {
    const lineBet = stake / 20; // 20 paylines
    const wins = [];
    let totalLine = 0;
    for (let li = 0; li < PAYLINES.length; li++) {
      const pl = PAYLINES[li];
      const seq = pl.map((row, col) => grid[col][row]);
      // find first non-WILD/non-SCAT symbol to anchor
      let anchor = null;
      for (const s of seq) {
        if (s !== 'WILD' && s !== 'SCAT') { anchor = s; break; }
      }
      // If no anchor (all wilds), use WILD as anchor
      let target;
      let count = 0;
      let cells = [];
      if (!anchor) {
        target = 'WILD';
        for (let i = 0; i < seq.length; i++) {
          if (seq[i] === 'WILD') { count++; cells.push([i, pl[i]]); } else break;
        }
      } else {
        target = anchor;
        for (let i = 0; i < seq.length; i++) {
          const s = seq[i];
          if (s === target || s === 'WILD') { count++; cells.push([i, pl[i]]); } else break;
        }
      }
      if (count >= 3 && target !== 'SCAT') {
        const sym = SYMBOLS[target];
        const pay = sym.pay[count - 1] * lineBet * mult;
        if (pay > 0) {
          wins.push({ line: li, sym: target, count, payout: pay, cells });
          totalLine += pay;
        }
      }
    }
    // scatters anywhere
    let scatCount = 0;
    const scatCells = [];
    for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) if (grid[c][r] === 'SCAT') { scatCount++; scatCells.push([c, r]); }
    const scatterPays = [0, 0, 2, 10, 50];
    const scatPay = (scatterPays[scatCount] || 0) * stake;
    return { wins, totalLine, scatterCount: scatCount, scatterCells: scatCells, scatterPay: scatPay, total: totalLine + scatPay };
  }

  spin(buyBonus=false) {
    const isFree = this.freeSpins > 0;
    let cost = 0;
    let mult = 1;
    if (buyBonus) {
      cost = this.stake * 75;
      if (this.balance < cost) return { error: 'insufficient' };
      this.balance -= cost;
      // forced bonus: keep generating until scatters are 3+
      let grid; let evalRes; let tries = 0;
      do {
        grid = this.spinGrid();
        evalRes = this.evaluate(grid, this.stake, mult);
        tries++;
      } while (evalRes.scatterCount < 3 && tries < 200);
      this.balance += evalRes.total;
      const fs = evalRes.scatterCount >= 5 ? 20 : evalRes.scatterCount === 4 ? 15 : 10;
      this.freeSpins = fs;
      this.freeSpinMult = 2;
      this.lastSpin = { grid, ...evalRes, stake: this.stake, mult, isFree:false, triggeredBonus:true, freeSpinsAwarded: fs };
      return this.lastSpin;
    }
    if (!isFree) {
      cost = this.stake;
      if (this.balance < cost) return { error: 'insufficient' };
      this.balance -= cost;
    } else {
      mult = this.freeSpinMult;
      this.freeSpins--;
    }
    const grid = this.spinGrid();
    const evalRes = this.evaluate(grid, this.stake, mult);
    this.balance += evalRes.total;
    let triggeredBonus = false;
    let freeSpinsAwarded = 0;
    // retrigger scatters during free spins add more
    if (evalRes.scatterCount >= 3) {
      const add = evalRes.scatterCount >= 5 ? 20 : evalRes.scatterCount === 4 ? 15 : 10;
      if (!isFree) {
        this.freeSpins += add;
        this.freeSpinMult = 2;
        triggeredBonus = true;
        freeSpinsAwarded = add;
      } else {
        this.freeSpins += 5; // retrigger small
        freeSpinsAwarded = 5;
      }
    }
    if (isFree) this.totalWonInBonus += evalRes.total;
    this.lastSpin = { grid, ...evalRes, stake: this.stake, mult, isFree, triggeredBonus, freeSpinsAwarded };
    return this.lastSpin;
  }
}

// expose
window.SlotEngine = SlotEngine;
window.SYMBOLS = SYMBOLS;
window.PAYLINES = PAYLINES;
window.REEL_STRIPS = REEL_STRIPS;
window.STAKE_PRESETS = STAKE_PRESETS;
