// Quick RNG diagnostic for validate-rtp.js
// Checks: is the xorshift32 + FNV combo producing uniform [0,1) when seeded per-spin?

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

// Test 1: distribution of FIRST rng() output across fresh seeds
const buckets = new Array(40).fill(0);
const N = 100000;
for (let i = 0; i < N; i++) {
  const r = rngFromSeed('seed:' + i);
  const v = Math.floor(r() * 40);
  buckets[v]++;
}
const expected = N / 40;
console.log('First rng() bucket distribution (40 buckets, N=' + N + '):');
let maxDev = 0;
for (let i = 0; i < 40; i++) {
  const dev = (buckets[i] - expected) / expected;
  if (Math.abs(dev) > maxDev) maxDev = Math.abs(dev);
}
console.log(`  max deviation from uniform: ${(maxDev * 100).toFixed(2)}%`);

// Test 2: scatter count distribution on VAULT.7 reels
const STRIPS = [
  ['E','D','F','A','COIN','E','F','D','BOLT','A','E','F','COIN','D','CRYS','E','F','A','D','BOLT','E','F','D','WILD','A','COIN','E','D','DIAM','F','A','E','SCAT','D','F','A','E','BOLT','D','F'],
  ['F','D','E','A','BOLT','F','D','E','COIN','A','D','F','E','BOLT','A','CRYS','D','E','F','A','BOLT','D','E','COIN','F','DIAM','A','D','E','F','WILD','A','D','SCAT','E','F','A','D','BOLT','E'],
  ['D','E','F','BOLT','A','D','F','COIN','E','A','D','CRYS','F','E','A','BOLT','D','F','WILD','E','A','COIN','D','F','DIAM','E','A','D','BOLT','F','SCAT','E','A','D','F','CRYS','E','A','BOLT','D'],
  ['F','A','D','E','COIN','F','A','D','BOLT','E','F','A','CRYS','D','E','F','A','D','BOLT','E','F','A','WILD','D','COIN','E','F','A','DIAM','D','E','F','SCAT','A','D','E','F','BOLT','A','D'],
  ['E','F','A','D','BOLT','E','F','A','COIN','D','E','F','A','BOLT','D','CRYS','E','F','A','D','BOLT','E','F','COIN','A','D','DIAM','E','F','A','WILD','D','E','SCAT','F','A','D','E','BOLT','F'],
];
console.log('\nSCAT index per strip:');
for (let c = 0; c < 5; c++) console.log(`  reel ${c}: ${STRIPS[c].indexOf('SCAT')}`);

const scatDist = new Array(16).fill(0);
const NS = 50000;
for (let i = 0; i < NS; i++) {
  const rng = rngFromSeed('vault:' + i);
  let scat = 0;
  for (let c = 0; c < 5; c++) {
    const start = Math.floor(rng() * 40);
    for (let r = 0; r < 3; r++) {
      if (STRIPS[c][(start + r) % 40] === 'SCAT') scat++;
    }
  }
  scatDist[scat]++;
}
console.log('\nSCAT count per spin (N=' + NS + '):');
for (let i = 0; i < 8; i++) {
  if (scatDist[i] > 0) {
    console.log(`  ${i} scatters: ${scatDist[i]} (${(scatDist[i] / NS * 100).toFixed(3)}%)`);
  }
}
const trig = scatDist.slice(3).reduce((a, b) => a + b, 0);
console.log(`  TOTAL 3+ scatters (FS trigger): ${trig} (${(trig / NS * 100).toFixed(3)}%)`);
console.log(`  expected 3+: ~0.36%`);
