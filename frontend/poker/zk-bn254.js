// ShinyPoker — zkShuffle v2 core on BN254 (alt_bn128 G1), the ON-CHAIN-verifiable
// variant of zk-poker.js. Same Barnett–Smart mental poker, but on the curve the
// EVM has native precompiles for (ecAdd 0x06, ecMul 0x07), so every Schnorr and
// Chaum–Pedersen proof this file produces is verified BY THE CONTRACT
// (ZkDealerV2.sol) during the hand — not just re-checked in JS.
//
// The Fiat–Shamir challenge is hashed byte-for-byte the way Solidity's
// abi.encodePacked lays it out: utf8(domain) ‖ 32-byte-BE x ‖ 32-byte-BE y …
// so a proof generated here verifies on-chain unchanged.
//
// Dependency-injected (browser: esm.sh noble + ethers keccak; node test: npm
// noble + ethers keccak) so the exact same code path is what the contract sees.

let G1;      // bn254 G1 ProjectivePoint class
let Fr;      // scalar field order (group order r)
let keccak;  // (0x-hex or bytes) -> 0x-hex
let rnd;     // (nBytes) -> Uint8Array

export function init({ bn254, keccak256, randomBytes }) {
  G1 = bn254.G1.ProjectivePoint;
  Fr = bn254.G1.CURVE.n;
  keccak = keccak256;
  rnd = randomBytes;
}

const mod = (x) => ((x % Fr) + Fr) % Fr;

/// 32-byte big-endian encoding of a field/scalar element (matches uint256 in
/// abi.encodePacked).
export function fe32(x) {
  const out = new Uint8Array(32);
  let v = ((x % (1n << 256n)) + (1n << 256n)) % (1n << 256n);
  for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}
const hexToBytes = (h) => { h = h.replace(/^0x/, ""); const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };
const concat = (...arrs) => { const n = arrs.reduce((a, b) => a + b.length, 0); const o = new Uint8Array(n); let k = 0; for (const a of arrs) { o.set(a, k); k += a.length; } return o; };
const toHex = (b) => "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

export function randScalar() {
  for (;;) { const s = mod(BigInt(toHex(rnd(32)))); if (s > 0n) return s; }
}

/// Affine {x,y} of a point (infinity → {x:0n,y:0n}, the precompile convention).
export function aff(P) {
  if (P.equals(G1.ZERO)) return { x: 0n, y: 0n };
  const a = P.toAffine();
  return { x: a.x, y: a.y };
}
const utf8 = (s) => new TextEncoder().encode(s);

/// Fiat–Shamir challenge over a domain tag + a list of points, encoded exactly
/// like Solidity abi.encodePacked(string, uint256, uint256, …).
function challenge(domain, points) {
  const parts = [utf8(domain)];
  for (const P of points) { const a = aff(P); parts.push(fe32(a.x), fe32(a.y)); }
  return mod(BigInt(keccak(toHex(concat(...parts)))));
}

// ---- deck: 52 fixed points M_j = (j+1)·G ----------------------------------
export function deckPoints() { const p = []; for (let j = 0; j < 52; j++) p.push(G1.BASE.multiply(BigInt(j + 1))); return p; }
export function pointToCard(M, pts) { for (let j = 0; j < 52; j++) if (pts[j].equals(M)) return j; return -1; }

// ---- DKG (aggregate table key) with Schnorr PoK ---------------------------
export function keygen(domain) {
  const x = randScalar();
  const X = G1.BASE.multiply(x);
  const k = randScalar();
  const R = G1.BASE.multiply(k);
  const c = challenge(domain, [X, R]);
  const s = mod(k + c * x);
  return { x, X, pok: { R, s } };
}
export function verifyPok(domain, X, pok) {
  const c = challenge(domain, [X, pok.R]);
  return G1.BASE.multiply(pok.s).equals(pok.R.add(X.multiply(c)));
}
export function aggregate(Xs) { return Xs.reduce((a, X) => a.add(X), G1.ZERO); }

// ---- ElGamal deck ----------------------------------------------------------
export function initialDeck(pts) { return pts.map((M) => ({ A: G1.ZERO, B: M })); }
export function remask(ct, X, rho) { return { A: ct.A.add(G1.BASE.multiply(rho)), B: ct.B.add(X.multiply(rho)) }; }
export function shuffleRemask(deck, X) {
  const n = deck.length;
  const perm = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Number(BigInt(toHex(rnd(4))) % BigInt(i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  const rho = perm.map(() => randScalar());
  const out = perm.map((from, k) => remask(deck[from], X, rho[k]));
  return { deck: out, secret: { perm, rho } };
}

// ---- decryption shares (Chaum–Pedersen), on-chain-verifiable ---------------
export function decryptionShare(ct, x, X, domain) {
  const d = ct.A.multiply(x);
  const k = randScalar();
  const R1 = G1.BASE.multiply(k);
  const R2 = ct.A.multiply(k);
  const c = challenge(domain, [ct.A, X, d, R1, R2]);
  const s = mod(k + c * x);
  return { d, proof: { R1, R2, s } };
}
export function verifyShare(ct, X, share, domain) {
  const { d, proof } = share;
  const c = challenge(domain, [ct.A, X, d, proof.R1, proof.R2]);
  return G1.BASE.multiply(proof.s).equals(proof.R1.add(X.multiply(c)))
    && ct.A.multiply(proof.s).equals(proof.R2.add(d.multiply(c)));
}
export function decryptWithShares(ct, shares, ownX) {
  let M = ct.B;
  for (const d of shares) M = M.subtract(d);
  if (ownX != null) M = M.subtract(ct.A.multiply(ownX));
  return M;
}

// ---- post-hand / on-chain audit -------------------------------------------
export function auditShuffles(pts, X, stages) {
  let cur = initialDeck(pts);
  for (let i = 0; i < stages.length; i++) {
    const { published, secret } = stages[i];
    const expect = secret.perm.map((from, k) => remask(cur[from], X, secret.rho[k]));
    for (let k = 0; k < expect.length; k++) {
      if (!expect[k].A.equals(published[k].A) || !expect[k].B.equals(published[k].B)) return { ok: false, cheater: i, card: k };
    }
    cur = published;
  }
  return { ok: true, cheater: -1 };
}

// ---- ABI helpers: pack points/proofs the way the contract expects ----------
export const pt = (P) => { const a = aff(P); return [a.x, a.y]; };
export const ptFlat = (P) => { const a = aff(P); return [a.x.toString(), a.y.toString()]; };
