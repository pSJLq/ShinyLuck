// Recomputes the house math for MINES / PLINKO / CRASH straight from
// contracts/Casino.sol source (tables are parsed, not copied — no drift):
//   plinko: EV per risk over the binomial(16, ½) slot distribution
//   crash:  closed-form EV of the bustabit-style point formula
//   mines:  EV of "open k cells then cash out" for a spread of (mines, k)
// Run: node scripts/verify-game-math.js
"use strict";
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "contracts", "Casino.sol"), "utf8");

// ---- plinko ---------------------------------------------------------------
// _plinkoPayoutAt holds three uint32[17] literals (X100), risk 0/1/2 in order.
const tables = [...src.matchAll(/uint32\[17\] memory \w+ = \[\s*uint32\((\d+)\),([\s\d,]+)\]/g)]
  .map((m) => [Number(m[1]), ...m[2].split(",").map((s) => Number(s.trim())).filter(Number.isFinite)]);
if (tables.length !== 3 || tables.some((t) => t.length !== 17)) throw new Error("plinko tables parse failed");

const C = (n, k) => { let r = 1; for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1); return r; };
console.log("== PLINKO (slot = popcount of 16 random bits → binomial) ==");
tables.forEach((t, risk) => {
  let evX100 = 0;
  for (let s = 0; s < 17; s++) evX100 += (C(16, s) / 2 ** 16) * t[s];
  console.log(`  risk ${risk}: RTP ${(evX100).toFixed(2)}% · max ${Math.max(...t) / 100}x`);
});
const reported = src.match(/GameType\.PLINKO\)\s*return (\d+);/);
console.log(`  contract reports RTP ${(Number(reported?.[1] ?? NaN) / 100).toFixed(2)}% on the stat strip`);

// ---- crash ----------------------------------------------------------------
// _crashPoint (v14): h uniform in [0,e); cp_X100 = 99·e/(e−h) with the 1.00x
// floor clamp (no separate bust branch). For a target M (X100), M ≥ 99:
//   P(cp ≥ M) = 99/M   ⟹   EV/stake = (M/100)·(99/M) = (100−edgeBps/100)/100.
// The instant-1.00x floor is intrinsic (h < e/100 ⇒ ~1% of rounds), NOT an
// extra charge — RTP is exactly 1 − edge at every cashout target.
const crashEdge = Number(src.match(/GameType\.CRASH\)\s*bps = (\d+)/)?.[1] ?? NaN);
console.log("\n== CRASH (bustabit formula, single edge, no double bust) ==");
if (Number.isFinite(crashEdge)) {
  const num = 10000 - crashEdge;
  // Monte-Carlo the exact on-chain integer formula to confirm the closed form.
  const e = 2 ** 52;
  let staked = 0, ret = 0; const M = 200; // cash out at 2.00x
  for (let i = 0; i < 2_000_000; i++) {
    const h = Math.floor(Math.random() * e);
    let cp = Math.floor((num * e) / (100 * (e - h)));
    if (cp < 100) cp = 100;
    staked += 100;
    if (cp >= M) ret += M;
  }
  console.log(`  edgeBps ${crashEdge} → closed-form RTP ${(num / 100).toFixed(2)}% at ANY target`);
  console.log(`  2M-round sim at 2.00x target: ${(ret / staked * 100).toFixed(2)}% (Stake reference 99.00%)`);
} else {
  console.log("  couldn't parse crash edge bps — check houseEdgeBps()");
}

// ---- mines ----------------------------------------------------------------
// _minesMultiplierX100: fair odds of surviving k picks with `mines` mines,
// times (1 − edge). EV of "pick k then cash out" = P(survive k)·mult.
const minesEdge = Number(src.match(/GameType\.MINES\)\s*bps = (\d+)/)?.[1] ?? 150);
console.log(`\n== MINES (edgeBps ${minesEdge}) — EV of open-k-then-cashout ==`);
const pSurvive = (mines, k) => { let p = 1; for (let i = 0; i < k; i++) p *= (25 - mines - i) / (25 - i); return p; };
const multX100 = (mines, k) => {
  let num = 1n, den = 1n;
  for (let i = 0; i < k; i++) { num *= BigInt(25 - i); den *= BigInt(25 - mines - i); }
  let m = (num * BigInt(10000 - minesEdge) * 100n) / (den * 10000n);
  if (m < 100n) m = 100n;
  return Number(m);
};
for (const [mines, k] of [[1, 1], [1, 5], [3, 3], [5, 5], [10, 3], [24, 1]]) {
  const ev = pSurvive(mines, k) * multX100(mines, k);
  console.log(`  mines=${mines} picks=${k}: mult ${(multX100(mines, k) / 100).toFixed(2)}x · EV ${(ev).toFixed(2)}%`);
}
console.log("\n(EV < 100% = house keeps an edge · every line should sit near 100 − edge)");
