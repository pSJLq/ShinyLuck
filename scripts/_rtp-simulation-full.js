// Full RTP simulation for SUGAR.LAB cluster:
//   1. Base ClusterLib.resolve() payout
//   2. Charge meter rewards (per Casino._bumpChargeMeter)
//   3. Loyalty free spins (every SPINS_PER_BONUS = 150 base spins → 5 FS)
//
// Mirrors all three RTP contributors from Casino.sol so the total RTP
// figure should land at ~92% - the contract's published target.
//
//   N=100000 node scripts/_rtp-simulation-full.js

const { ethers } = require("ethers");
const crypto = require("crypto");

const SIZE = 7;
const WILD = 8;
const SCAT = 9;
const MAX_CASCADE = 12;
const CLUSTER_PAY_BOOST_X100 = 320n;
const CLUSTER_MAX_MULT_X100 = 250000n;
const SPINS_PER_BONUS = 150;
const FREE_SPINS_PER_BONUS = 5;
const FREE_SPIN_REFERENCE_STAKE = ethers.parseEther("0.001"); // 0.001 STT notional

// ── ClusterLib mirror ──────────────────────────────────────────────────
function pickSymbol(c) {
  const v = c % 97n;
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
function clusterPayX100(sym, n) {
  if (n < 5) return 0n;
  let p5, p15;
  if (sym === 0)      { p5 = 10n;  p15 = 150n;  }
  else if (sym === 1) { p5 = 12n;  p15 = 200n;  }
  else if (sym === 2) { p5 = 18n;  p15 = 400n;  }
  else if (sym === 3) { p5 = 20n;  p15 = 450n;  }
  else if (sym === 4) { p5 = 25n;  p15 = 500n;  }
  else if (sym === 5) { p5 = 30n;  p15 = 800n;  }
  else if (sym === 6) { p5 = 40n;  p15 = 1000n; }
  else if (sym === 7) { p5 = 50n;  p15 = 1400n; }
  else if (sym === 8) { p5 = 40n;  p15 = 1800n; }
  else return 0n;
  const N = BigInt(n);
  const t = N > 15n ? 100n : ((N - 5n) * 100n) / 10n;
  let p = p5 + ((p15 - p5) * t) / 100n;
  if (N >= 20n) p += (N - 19n) * 25n;
  return p;
}
const hashRR = (r) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [r]));
const hashRRD = (r, d) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint8"], [r, d]));
const hashRRCR = (r, c, x) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint8", "uint8"], [r, c, x]));
const bw = (rr, b) => (BigInt(rr) >> BigInt(b * 8)) & 0xFFFFFFn;

function findAndPay(g) {
  const seen = new Array(49).fill(false);
  const rem = new Uint8Array(49);
  let stepX100 = 0n;
  for (let i = 0; i < 49; i++) {
    if (seen[i]) continue;
    const s = g[i];
    if (s === SCAT || s === WILD || s >= 10) { seen[i] = true; continue; }
    const stk = [i]; seen[i] = true;
    const cl = [];
    while (stk.length) {
      const cur = stk.pop(); cl.push(cur);
      const row = (cur / 7) | 0, col = cur % 7;
      if (row > 0) { const n = cur - 7; if (!seen[n] && (g[n] === s || g[n] === WILD)) { seen[n] = true; stk.push(n); } }
      if (row < 6) { const n = cur + 7; if (!seen[n] && (g[n] === s || g[n] === WILD)) { seen[n] = true; stk.push(n); } }
      if (col > 0) { const n = cur - 1; if (!seen[n] && (g[n] === s || g[n] === WILD)) { seen[n] = true; stk.push(n); } }
      if (col < 6) { const n = cur + 1; if (!seen[n] && (g[n] === s || g[n] === WILD)) { seen[n] = true; stk.push(n); } }
    }
    if (cl.length >= 5) {
      stepX100 += clusterPayX100(s, cl.length);
      for (const c of cl) rem[c] = 1;
    }
  }
  return { stepX100, rem };
}
function tumble(g, rem, rr) {
  for (let col = 0; col < 7; col++) {
    const keep = [];
    for (let row = 6; row >= 0; row--) {
      const idx = row * 7 + col;
      if (!rem[idx]) keep.push(g[idx]);
    }
    const k = keep.length;
    for (let i = 0; i < k; i++) g[(6 - i) * 7 + col] = keep[i];
    for (let r = 0; r < 7 - k; r++) g[r * 7 + col] = pickSymbol(BigInt(hashRRCR(rr, col, r)) & 0xFFFFFFn);
  }
}
function resolveSpin(randomness) {
  let rr = randomness;
  let rByte = 0;
  const g = new Uint8Array(49);
  for (let i = 0; i < 49; i++) {
    if (rByte >= 32) { rr = hashRR(rr); rByte = 0; }
    g[i] = pickSymbol(bw(rr, rByte));
    rByte++;
  }
  let totalX100 = 0n;
  for (let d = 0; d < MAX_CASCADE; d++) {
    const { stepX100, rem } = findAndPay(g);
    if (stepX100 === 0n) break;
    totalX100 += stepX100;
    rr = hashRRD(rr, d);
    tumble(g, rem, rr);
  }
  return totalX100;
}

// Casino-side: cluster payout = stake × clusterX100 × CLUSTER_PAY_BOOST_X100 / 10_000
// then clamped at stake × CLUSTER_MAX_MULT_X100 / 100.
function clusterPayout(stake, totalX100) {
  let raw = (stake * totalX100 * CLUSTER_PAY_BOOST_X100) / 10_000n;
  const cap = (stake * CLUSTER_MAX_MULT_X100) / 100n;
  if (raw > cap) raw = cap;
  return raw;
}

// ── Charge meter mirror (Casino._bumpChargeMeter) ──────────────────────
// Reward roll percentages - exactly as in Casino.sol line 612-619.
const REWARD_TABLE = [
  { roll: 38,  multBp10000: 30000  }, // CASH_TIP × 3
  { roll: 63,  multBp10000: 80000  }, // CASH_DROP × 8
  { roll: 75,  multBp10000: 180000 }, // CASH_SURGE × 18
  { roll: 83,  multBp10000: 30000  }, // FS3 cash-equivalent × 3
  { roll: 89,  multBp10000: 120000 }, // MYSTERY × 12
  { roll: 93,  multBp10000: 450000 }, // CASH_BLAST × 45
  { roll: 97,  multBp10000: 50000  }, // FS5 cash-equivalent × 5
  { roll: 98,  multBp10000: 1200000}, // JACKPOT × 120
];

class ChargeMeter {
  constructor(player) {
    this.player = player;
    this.meter = 0;
    this.threshold = 0; // initialised on first spin
    this.cycle = 0;
  }
  init(rand) {
    if (this.threshold !== 0) return;
    this.threshold = 18000 + Number(BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "address", "string"], [rand, this.player, "init"]))) % 12001n);
  }
  bump(stake, missed, rand) {
    this.init(rand);
    const base = Math.min(600, 220 + Number((stake * 350n) / (50n * 10n ** 18n)));
    const miss = missed ? 120 : 0;
    const noise = Number(BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "address", "string"], [rand, this.player, "noise"]))) % 150n);
    const inc = base + miss + noise;
    const nc = this.meter + inc;
    if (nc >= this.threshold) {
      const roll = Number(BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "address", "string"], [rand, this.player, "reward"]))) % 98n);
      let mult = 0n;
      for (const tier of REWARD_TABLE) {
        if (roll < tier.roll) { mult = BigInt(tier.multBp10000); break; }
      }
      // basis 10000 of stake
      const reward = (stake * mult) / 10_000n;
      this.meter = 0;
      this.cycle++;
      this.threshold = 18000 + Number(BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "address", "string"], [rand, this.player, "th"]))) % 12001n);
      return reward;
    }
    this.meter = nc;
    return 0n;
  }
}

async function main() {
  const N = parseInt(process.env.N || "100000", 10);
  const stake = ethers.parseEther("0.01"); // 0.01 STT per base spin
  console.log(`[rtp-sim-full] running ${N.toLocaleString()} base spins at ${ethers.formatEther(stake)} STT each…`);
  const t0 = Date.now();

  const player = "0x0000000000000000000000000000000000000001";
  const meter = new ChargeMeter(player);
  let totalWagered = 0n;
  let totalReturned = 0n;
  let basePayoutSum = 0n;
  let chargeRewardSum = 0n;
  let fsBonusSum = 0n;
  let baseSpinsCount = 0;
  let loyaltyFsCount = 0;
  let chargeRewardCount = 0;
  let wins = 0;

  for (let i = 0; i < N; i++) {
    const seed = "0x" + crypto.randomBytes(32).toString("hex");
    const tX100 = resolveSpin(seed);
    const payout = clusterPayout(stake, tX100);
    totalWagered += stake;
    basePayoutSum += payout;
    if (payout > 0n) wins++;
    baseSpinsCount++;

    // Charge meter bump
    const cmReward = meter.bump(stake, payout === 0n, seed);
    chargeRewardSum += cmReward;
    if (cmReward > 0n) chargeRewardCount++;

    // Loyalty: every SPINS_PER_BONUS base spins → 5 free spins
    if (baseSpinsCount % SPINS_PER_BONUS === 0) {
      for (let f = 0; f < FREE_SPINS_PER_BONUS; f++) {
        const fsSeed = "0x" + crypto.randomBytes(32).toString("hex");
        const fsTX100 = resolveSpin(fsSeed);
        const fsPayout = clusterPayout(FREE_SPIN_REFERENCE_STAKE, fsTX100);
        fsBonusSum += fsPayout;
        loyaltyFsCount++;
      }
    }

    if (i % 10_000 === 9_999) {
      const totReturned = basePayoutSum + chargeRewardSum + fsBonusSum;
      const rtp = Number(totReturned * 10_000n / totalWagered) / 100;
      process.stdout.write(`  ${(i + 1).toLocaleString()} spins  RTP=${rtp.toFixed(2)}%  ${(Date.now() - t0) / 1000 | 0}s\r`);
    }
  }
  const dt = (Date.now() - t0) / 1000;
  totalReturned = basePayoutSum + chargeRewardSum + fsBonusSum;
  const rtp = Number(totalReturned * 10_000n / totalWagered) / 100;
  const baseRtp = Number(basePayoutSum * 10_000n / totalWagered) / 100;
  const cmRtp = Number(chargeRewardSum * 10_000n / totalWagered) / 100;
  const fsRtp = Number(fsBonusSum * 10_000n / totalWagered) / 100;

  console.log("\n");
  console.log("======================  RESULT  ======================");
  console.log(`spins:           ${N.toLocaleString()}`);
  console.log(`elapsed:         ${dt.toFixed(1)}s`);
  console.log(`stake per spin:  ${ethers.formatEther(stake)} STT`);
  console.log("");
  console.log(`wagered:         ${ethers.formatEther(totalWagered)} STT`);
  console.log(`returned:        ${ethers.formatEther(totalReturned)} STT`);
  console.log("");
  console.log(`TOTAL RTP:       ${rtp.toFixed(3)}%   (contract target 92.000%)`);
  console.log("");
  console.log("  base ClusterLib:    ${" + baseRtp.toFixed(3) + "%}".replace(/\$\{|\}/g, ""));
  console.log(`  base ClusterLib:    ${baseRtp.toFixed(3)}%`);
  console.log(`  charge meter:       ${cmRtp.toFixed(3)}%  (${chargeRewardCount.toLocaleString()} rewards, 1 in ${(N/Math.max(1,chargeRewardCount)).toFixed(0)} spins)`);
  console.log(`  loyalty free spins: ${fsRtp.toFixed(3)}%  (${loyaltyFsCount.toLocaleString()} FS at ${ethers.formatEther(FREE_SPIN_REFERENCE_STAKE)} STT reference)`);
  console.log("");
  console.log(`hit rate:        ${(wins / N * 100).toFixed(2)}%`);
  console.log("======================================================");
}
main().catch((e) => { console.error(e); process.exit(1); });
