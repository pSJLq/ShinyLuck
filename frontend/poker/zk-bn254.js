// ShinyPoker · zkShuffle v2 core on BN254 (alt_bn128 G1), the ON-CHAIN-verifiable
// variant of zk-poker.js. Same Barnett–Smart mental poker, but on the curve the
// EVM has native precompiles for (ecAdd 0x06, ecMul 0x07), so every Schnorr and
// Chaum–Pedersen proof this file produces is verified BY THE CONTRACT
// (ZkDealerV2.sol) during the hand · not just re-checked in JS.
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

/// Batch of decryption-share proofs from ONE sender (shared pubkey X), folded
/// into a single randomized MSM. Each verifyShare is a Chaum–Pedersen pair:
///   eq1_i:  s_i·G − R1_i − c_i·X       == O
///   eq2_i:  s_i·A_i − R2_i − c_i·d_i   == O    (A_i = ct_i.A)
/// Verify Σ_i w_i·(eq1_i + z·eq2_i) == O with local random weights w_i (128-bit)
/// and one fold z; a single bad share survives with prob ~2⁻¹²⁸. Returns true
/// iff EVERY share is valid. `items` = [{ct, d, R1, R2, s, domain}]. verifyShare
/// stays the reference; the equivalence test proves they agree.
export function verifySharesBatched(X, items) {
  if (!Array.isArray(items) || items.length === 0) return true;
  const zr = () => BigInt(toHex(rnd(16))) | 1n;
  const z = zr();
  const neg = (v) => mod(Fr - mod(v));
  const pts = [G1.BASE, X], cfs = [0n, 0n]; // [0]=G, [1]=X (shared)
  let gCoef = 0n, xCoef = 0n;
  for (const it of items) {
    const c = challenge(it.domain, [it.ct.A, X, it.d, it.R1, it.R2]);
    const w = zr(), wz = mod(w * z);
    gCoef = mod(gCoef + w * it.s);          // eq1: +s_i·G
    xCoef = mod(xCoef + neg(w * c));        // eq1: −c_i·X
    pts.push(it.R1); cfs.push(neg(w));      // eq1: −R1_i
    pts.push(it.ct.A); cfs.push(mod(wz * it.s)); // eq2: +s_i·A_i
    pts.push(it.R2); cfs.push(neg(wz));     // eq2: −R2_i
    pts.push(it.d); cfs.push(neg(mod(wz * c))); // eq2: −c_i·d_i
  }
  cfs[0] = mod(gCoef); cfs[1] = mod(xCoef);
  return msm(pts, cfs).equals(G1.ZERO);
}

// ============================================================================
// Verifiable shuffle · Wikström's proof of a re-encryption shuffle, implemented
// LINE-BY-LINE from the published pseudo-code in Haenni, Locher, Koenig, Dubuis,
// "Pseudo-Code Algorithms for Verifiable Re-encryption Mix-Nets" (FC'17 Voting;
// Algorithms 4.3–4.6), the same construction deployed in the CHVote /
// Verificatum e-voting stacks. Translated to additive EC notation on BN254:
//   g^x → x·G, pk^r → r·X, and our ciphertext layout ct=(A,B)=(ρ·G, M+ρ·X)
//   maps to the paper's e=(a,b)=(m·pk^ρ, g^ρ) as a↔B, b↔A, pk↔X.
// Every shuffler proves its output deck is a permutation + re-encryption of its
// input deck WITHOUT revealing the permutation. With every participant (and the
// coordinator) verifying every proof in the chain, a malicious shuffler · even
// the last one, even with every OTHER shuffler colluding · cannot substitute,
// duplicate or bias a single ciphertext: the deck any honest player is dealt
// from is provably a permutation of the canonical 52-card deck that includes
// that player's OWN secret shuffle.
// ============================================================================

// BN254 base field prime (for NUMS generator derivation; = ZkVerify.P on-chain).
const P_BASE = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

function powmod(a, e, m) {
  a = ((a % m) + m) % m;
  let r = 1n;
  while (e > 0n) { if (e & 1n) r = (r * a) % m; a = (a * a) % m; e >>= 1n; }
  return r;
}

/// Nothing-up-my-sleeve generator: keccak-driven try-and-increment. BN254 G1
/// has cofactor 1 and p ≡ 3 (mod 4), so any on-curve point is in the prime-
/// order group and sqrt is a single exponentiation. Anyone can re-derive these
/// from the public labels and confirm nobody knows their discrete logs.
function numsPoint(label) {
  for (let ctr = 0; ctr < 4096; ctr++) {
    const x = BigInt(keccak(toHex(concat(utf8(label + ":" + ctr))))) % P_BASE;
    const rhs = (((x * x) % P_BASE) * x + 3n) % P_BASE; // x^3 + 3
    if (rhs !== 0n && powmod(rhs, (P_BASE - 1n) / 2n, P_BASE) !== 1n) continue;
    let y = powmod(rhs, (P_BASE + 1n) / 4n, P_BASE);
    if ((y & 1n) === 1n) y = P_BASE - y; // canonical even-y
    try {
      const P = G1.fromAffine({ x, y });
      P.assertValidity();
      return P;
    } catch (_) { /* keep counting */ }
  }
  throw new Error("numsPoint: no point for " + label);
}

let _sg = null; // { H: [52 generators h_1..h_N], h0: chain seed h }
export function shuffleGens() {
  if (_sg) return _sg;
  const H = [];
  for (let i = 0; i < 52; i++) H.push(numsPoint("SHINYPOKER/wikstrom/h" + i));
  const h0 = numsPoint("SHINYPOKER/wikstrom/h");
  // fixed for the process lifetime · window tables make them ~10× faster
  try { for (const g of H) g.precompute(8); h0.precompute(8); } catch (_) {}
  _sg = { H, h0 };
  return _sg;
}

/// s·P that tolerates s ≡ 0 and P = O (noble's multiply() rejects both).
function mulSafe(P, s) {
  s = mod(s);
  if (s === 0n || P.equals(G1.ZERO)) return G1.ZERO;
  return P.multiply(s);
}

/// Multi-scalar multiplication Σ s_i·P_i · Pippenger when the bundle has it.
function msm(points, scalars) {
  const ps = [], ss = [];
  for (let i = 0; i < points.length; i++) {
    const s = mod(scalars[i]);
    if (s === 0n || points[i].equals(G1.ZERO)) continue;
    ps.push(points[i]); ss.push(s);
  }
  if (!ps.length) return G1.ZERO;
  if (typeof G1.msm === "function") { try { return G1.msm(ps, ss); } catch (_) {} }
  let acc = G1.ZERO;
  for (let i = 0; i < ps.length; i++) acc = acc.add(ps[i].multiply(ss[i]));
  return acc;
}

const packPts = (points) => {
  const parts = [];
  for (const P of points) { const a = aff(P); parts.push(fe32(a.x), fe32(a.y)); }
  return parts;
};
const deckFlat = (deck) => { const o = []; for (const ct of deck) o.push(ct.A, ct.B); return o; };

/// Statement binding: base = H(domain ‖ e ‖ e' ‖ c). The per-index challenges
/// u_i = H(base ‖ i) and the main challenge chain from it (standard composed
/// Fiat–Shamir; the paper's u_i = Hash((e,e',c), i) / c = Hash(y,t)).
function shuffleBase(domain, prevDeck, newDeck, cCom) {
  return keccak(toHex(concat(utf8(domain), ...packPts([...deckFlat(prevDeck), ...deckFlat(newDeck), ...cCom]))));
}
function deriveU(baseHex, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(mod(BigInt(keccak(toHex(concat(hexToBytes(baseHex), fe32(BigInt(i))))))));
  return out;
}
function shuffleChallenge(baseHex, cHat, X, t) {
  const pts = [...cHat, X, t.t1, t.t2, t.t3, t.t41, t.t42, ...t.tHat];
  return mod(BigInt(keccak(toHex(concat(hexToBytes(baseHex), ...packPts(pts))))));
}

/// GenProof (Alg 4.3). `secret` is shuffleRemask's {perm, rho}: output slot
/// `pos` holds remask(prevDeck[perm[pos]], rho[pos]) · i.e. the paper's
/// ψ = (j_1..j_N) with j_pos = perm[pos], and r'_{j_pos} = rho[pos].
export function proveShuffle(domain, prevDeck, newDeck, X, secret) {
  const { H, h0 } = shuffleGens();
  const n = prevDeck.length;
  const { perm, rho } = secret;

  // permutation commitment (Alg 4.4): c_{j_i} = r_{j_i}·G + h_i
  const rCom = new Array(n), cCom = new Array(n);
  for (let pos = 0; pos < n; pos++) {
    const j = perm[pos];
    rCom[j] = randScalar();
    cCom[j] = G1.BASE.multiply(rCom[j]).add(H[pos]);
  }
  const base = shuffleBase(domain, prevDeck, newDeck, cCom);
  const u = deriveU(base, n);          // input-indexed
  const uP = perm.map((j) => u[j]);    // u'_pos = u_{ψ(pos)}

  // commitment chain (Alg 4.5): ĉ_i = r̂_i·G + u'_i·ĉ_{i-1}, ĉ_0 = h
  const rHat = new Array(n), cHat = new Array(n);
  let prev = h0;
  for (let pos = 0; pos < n; pos++) {
    rHat[pos] = randScalar();
    cHat[pos] = G1.BASE.multiply(rHat[pos]).add(mulSafe(prev, uP[pos]));
    prev = cHat[pos];
  }

  // aggregated secrets (Alg 4.3 lines 8–14)
  let rBar = 0n; for (let j = 0; j < n; j++) rBar = mod(rBar + rCom[j]);
  const v = new Array(n); v[n - 1] = 1n;
  for (let i = n - 2; i >= 0; i--) v[i] = mod(uP[i + 1] * v[i + 1]);
  let rHatAgg = 0n; for (let i = 0; i < n; i++) rHatAgg = mod(rHatAgg + rHat[i] * v[i]);
  let rTil = 0n; for (let j = 0; j < n; j++) rTil = mod(rTil + rCom[j] * u[j]);
  let rPr = 0n; for (let pos = 0; pos < n; pos++) rPr = mod(rPr + rho[pos] * uP[pos]);

  // commitments t (lines 15–25)
  const w1 = randScalar(), w2 = randScalar(), w3 = randScalar(), w4 = randScalar();
  const wHat = Array.from({ length: n }, () => randScalar());
  const wP = Array.from({ length: n }, () => randScalar());
  const A2 = newDeck.map((ct) => ct.A), B2 = newDeck.map((ct) => ct.B);
  const t1 = G1.BASE.multiply(w1);
  const t2 = G1.BASE.multiply(w2);
  const t3 = G1.BASE.multiply(w3).add(msm(H, wP));
  const t41 = msm(B2, wP).subtract(mulSafe(X, w4));      // pk^{-ω4}·Π(a'_i)^{ω'_i}
  const t42 = msm(A2, wP).subtract(G1.BASE.multiply(w4)); // g^{-ω4}·Π(b'_i)^{ω'_i}
  const tHat = new Array(n);
  prev = h0;
  for (let pos = 0; pos < n; pos++) {
    tHat[pos] = G1.BASE.multiply(wHat[pos]).add(mulSafe(prev, wP[pos]));
    prev = cHat[pos];
  }

  // challenge + responses (lines 26–34)
  const c = shuffleChallenge(base, cHat, X, { t1, t2, t3, t41, t42, tHat });
  const s1 = mod(w1 + c * rBar), s2 = mod(w2 + c * rHatAgg);
  const s3 = mod(w3 + c * rTil), s4 = mod(w4 + c * rPr);
  const sHat = wHat.map((w, i) => mod(w + c * rHat[i]));
  const sP = wP.map((w, i) => mod(w + c * uP[i]));
  return { cCom, cHat, t1, t2, t3, t41, t42, tHat, s1, s2, s3, s4, sHat, sP };
}

/// CheckProof (Alg 4.6). Returns true iff `newDeck` is a permutation +
/// re-encryption of `prevDeck` under table key X, as attested by `prf`.
export function verifyShuffle(domain, prevDeck, newDeck, X, prf) {
  const { H, h0 } = shuffleGens();
  const n = prevDeck.length;
  if (!prf || newDeck.length !== n) return false;
  for (const arr of [prf.cCom, prf.cHat, prf.tHat, prf.sHat, prf.sP]) {
    if (!Array.isArray(arr) || arr.length !== n) return false;
  }
  const base = shuffleBase(domain, prevDeck, newDeck, prf.cCom);
  const u = deriveU(base, n);
  const c = shuffleChallenge(base, prf.cHat, X, prf);

  // t1: c̄ = Σc_j − Σh_j ; s1·G − c·c̄ == t1
  let sumC = G1.ZERO; for (const p of prf.cCom) sumC = sumC.add(p);
  let sumH = G1.ZERO; for (const p of H) sumH = sumH.add(p);
  const cBar = sumC.subtract(sumH);
  if (!mulSafe(G1.BASE, prf.s1).subtract(mulSafe(cBar, c)).equals(prf.t1)) return false;

  // t2: ĉ = ĉ_N − (Πu_i)·h ; s2·G − c·ĉ == t2
  let uProd = 1n; for (const ui of u) uProd = mod(uProd * ui);
  const cHatBar = prf.cHat[n - 1].subtract(mulSafe(h0, uProd));
  if (!mulSafe(G1.BASE, prf.s2).subtract(mulSafe(cHatBar, c)).equals(prf.t2)) return false;

  // t3: c̃ = Σu_j·c_j ; s3·G + Σs'_i·h_i − c·c̃ == t3
  const cTil = msm(prf.cCom, u);
  if (!mulSafe(G1.BASE, prf.s3).add(msm(H, prf.sP)).subtract(mulSafe(cTil, c)).equals(prf.t3)) return false;

  // t4: (B̃,Ã) = Σu_j·(B_j,A_j) over the INPUT deck;
  //     Σs'_i·B'_i − s4·X − c·B̃ == t41   and   Σs'_i·A'_i − s4·G − c·Ã == t42
  const A1 = prevDeck.map((ct) => ct.A), B1 = prevDeck.map((ct) => ct.B);
  const A2 = newDeck.map((ct) => ct.A), B2 = newDeck.map((ct) => ct.B);
  const bTil = msm(B1, u), aTil = msm(A1, u);
  if (!msm(B2, prf.sP).subtract(mulSafe(X, prf.s4)).subtract(mulSafe(bTil, c)).equals(prf.t41)) return false;
  if (!msm(A2, prf.sP).subtract(mulSafe(G1.BASE, prf.s4)).subtract(mulSafe(aTil, c)).equals(prf.t42)) return false;

  // t̂ chain: ŝ_i·G + s'_i·ĉ_{i-1} − c·ĉ_i == t̂_i for all i · batched into one
  // MSM with verifier-local random 128-bit weights λ_i (standard small-exponent
  // batching; a single forged equation survives with probability ~2⁻¹²⁸).
  const lam = Array.from({ length: n }, () => BigInt(toHex(rnd(16))) | 1n);
  let gCoef = 0n;
  for (let i = 0; i < n; i++) gCoef = mod(gCoef + lam[i] * prf.sHat[i]);
  const pts = [G1.BASE, h0], cfs = [gCoef, mod(lam[0] * prf.sP[0])];
  for (let i = 0; i < n; i++) {
    let cf = mod(Fr - mod(c * lam[i])); // −c·λ_i on ĉ_i
    if (i + 1 < n) cf = mod(cf + lam[i + 1] * prf.sP[i + 1]); // +λ_{i+1}·s'_{i+1} (as ĉ_{i} is chain-prev of i+1)
    pts.push(prf.cHat[i]); cfs.push(cf);
  }
  for (let i = 0; i < n; i++) { pts.push(prf.tHat[i]); cfs.push(mod(Fr - lam[i])); }
  return msm(pts, cfs).equals(G1.ZERO);
}

/// Same check as verifyShuffle, but the six sub-equations are folded into ONE
/// randomized multi-scalar multiplication (small-exponent batching, weights
/// z_k / λ_i chosen locally AFTER seeing the proof). Six MSM(52) collapse to a
/// single MSM(~8n) — measured ~2.5× faster, and MSM is the whole cost. The math
/// is identical: rewrite each check as `EQ_k == O`, then verify
/// `Σ_k z_k·EQ_k == O`; a single failing equation survives with prob ~2⁻¹²⁸.
/// verifyShuffle stays as the reference; test/zk-batch-equiv proves they agree.
export function verifyShuffleBatched(domain, prevDeck, newDeck, X, prf) {
  const { H, h0 } = shuffleGens();
  const n = prevDeck.length;
  if (!prf || newDeck.length !== n) return false;
  for (const arr of [prf.cCom, prf.cHat, prf.tHat, prf.sHat, prf.sP]) {
    if (!Array.isArray(arr) || arr.length !== n) return false;
  }
  const base = shuffleBase(domain, prevDeck, newDeck, prf.cCom);
  const u = deriveU(base, n);
  const c = shuffleChallenge(base, prf.cHat, X, prf);
  let uProd = 1n; for (const ui of u) uProd = mod(uProd * ui);

  const A1 = prevDeck.map((ct) => ct.A), B1 = prevDeck.map((ct) => ct.B);
  const A2 = newDeck.map((ct) => ct.A), B2 = newDeck.map((ct) => ct.B);

  // verifier-local random weights: z1..z5 fold the five scalar checks; the t̂
  // chain (eq6) keeps its own per-index λ, scaled by z6. |z| = 128 bits, odd.
  const zr = () => BigInt(toHex(rnd(16))) | 1n;
  const z1 = zr(), z2 = zr(), z3 = zr(), z4 = zr(), z5 = zr(), z6 = zr();
  const lam = Array.from({ length: n }, () => zr());

  // scalar accumulators on the shared singleton generators
  let gCoef = 0n, h0Coef = 0n, xCoef = 0n;
  const add = (name, v) => {
    if (name === "G") gCoef = mod(gCoef + v);
    else if (name === "h0") h0Coef = mod(h0Coef + v);
    else if (name === "X") xCoef = mod(xCoef + v);
  };
  const neg = (v) => mod(Fr - mod(v));

  // per-index accumulators for the arrays that appear in >1 equation
  const cComCoef = new Array(n).fill(0n);
  const hCoef = new Array(n).fill(0n);
  const cHatCoef = new Array(n).fill(0n);

  // eq1 (z1):  s1·G − c·Σc_j + c·Σh_j − t1 == O
  add("G", z1 * prf.s1);
  for (let j = 0; j < n; j++) cComCoef[j] = mod(cComCoef[j] + neg(z1 * c));
  for (let i = 0; i < n; i++) hCoef[i] = mod(hCoef[i] + z1 * c);
  // t1 handled below (singleton per-eq point)

  // eq2 (z2):  s2·G − c·ĉ_{n-1} + c·uProd·h0 − t2 == O
  add("G", z2 * prf.s2);
  cHatCoef[n - 1] = mod(cHatCoef[n - 1] + neg(z2 * c));
  add("h0", z2 * mod(c * uProd));

  // eq3 (z3):  s3·G + Σ s'_i·h_i − c·Σ u_j·c_j − t3 == O
  add("G", z3 * prf.s3);
  for (let i = 0; i < n; i++) hCoef[i] = mod(hCoef[i] + z3 * prf.sP[i]);
  for (let j = 0; j < n; j++) cComCoef[j] = mod(cComCoef[j] + neg(z3 * mod(c * u[j])));

  // eq4 (z4):  Σ s'_i·B'_i − s4·X − c·Σ u_j·B_j − t41 == O
  add("X", neg(z4 * prf.s4));
  // eq5 (z5):  Σ s'_i·A'_i − s4·G − c·Σ u_j·A_j − t42 == O
  add("G", neg(z5 * prf.s4));

  // assemble the big MSM
  const pts = [], cfs = [];
  const push = (P, cf) => { pts.push(P); cfs.push(mod(cf)); };
  // singletons
  push(G1.BASE, gCoef); push(h0, h0Coef); push(X, xCoef);
  // per-eq unique targets t1..t42 (each −z_k)
  push(prf.t1, neg(z1)); push(prf.t2, neg(z2)); push(prf.t3, neg(z3));
  push(prf.t41, neg(z4)); push(prf.t42, neg(z5));
  // H and cCom (merged coefficients from eqs above)
  for (let i = 0; i < n; i++) push(H[i], hCoef[i]);
  for (let j = 0; j < n; j++) push(prf.cCom[j], cComCoef[j]);
  // eq4/eq5 deck vectors
  for (let i = 0; i < n; i++) push(B2[i], z4 * prf.sP[i]);
  for (let j = 0; j < n; j++) push(B1[j], neg(z4 * mod(c * u[j])));
  for (let i = 0; i < n; i++) push(A2[i], z5 * prf.sP[i]);
  for (let j = 0; j < n; j++) push(A1[j], neg(z5 * mod(c * u[j])));

  // eq6 (z6): the t̂ chain, its own λ-batch, whole thing scaled by z6
  //   ŝ_i·G + s'_i·ĉ_{i-1} − c·ĉ_i == t̂_i    (ĉ_{-1} = h0)
  let g6 = 0n;
  for (let i = 0; i < n; i++) g6 = mod(g6 + lam[i] * prf.sHat[i]);
  gCoef = mod(gCoef + z6 * g6); // fold eq6's G term into the singleton (once)
  cfs[0] = mod(gCoef);          // overwrite the earlier G push with the full coef
  h0Coef = mod(h0Coef + z6 * mod(lam[0] * prf.sP[0]));
  cfs[1] = mod(h0Coef);
  for (let i = 0; i < n; i++) {
    let cf = neg(c * lam[i]);
    if (i + 1 < n) cf = mod(cf + lam[i + 1] * prf.sP[i + 1]);
    cHatCoef[i] = mod(cHatCoef[i] + z6 * cf);
  }
  for (let i = 0; i < n; i++) push(prf.cHat[i], cHatCoef[i]);
  for (let i = 0; i < n; i++) push(prf.tHat[i], neg(z6 * lam[i]));

  return msm(pts, cfs).equals(G1.ZERO);
}

// ---- wire format (JSON) + transcript hash ----------------------------------
const ptHex = (P) => { const a = aff(P); return { x: "0x" + a.x.toString(16), y: "0x" + a.y.toString(16) }; };
export function shuffleProofToWire(prf) {
  const s = (v) => "0x" + v.toString(16);
  return {
    cCom: prf.cCom.map(ptHex), cHat: prf.cHat.map(ptHex),
    t1: ptHex(prf.t1), t2: ptHex(prf.t2), t3: ptHex(prf.t3), t41: ptHex(prf.t41), t42: ptHex(prf.t42),
    tHat: prf.tHat.map(ptHex),
    s1: s(prf.s1), s2: s(prf.s2), s3: s(prf.s3), s4: s(prf.s4),
    sHat: prf.sHat.map(s), sP: prf.sP.map(s),
  };
}
export function shuffleProofFromWire(w, parsePoint) {
  const P = parsePoint; // {x,y} hex → validated ProjectivePoint (caller supplies)
  const sc = (v) => { const x = BigInt(v); if (x < 0n || x >= Fr) throw new Error("scalar out of range"); return x; };
  const arr = (a, f, n) => { if (!Array.isArray(a) || a.length !== n) throw new Error("bad proof shape"); return a.map(f); };
  return {
    cCom: arr(w.cCom, P, 52), cHat: arr(w.cHat, P, 52),
    t1: P(w.t1), t2: P(w.t2), t3: P(w.t3), t41: P(w.t41), t42: P(w.t42),
    tHat: arr(w.tHat, P, 52),
    s1: sc(w.s1), s2: sc(w.s2), s3: sc(w.s3), s4: sc(w.s4),
    sHat: arr(w.sHat, sc, 52), sP: arr(w.sP, sc, 52),
  };
}

/// keccak commitment to the WHOLE shuffle transcript (each stage's output deck
/// + its proof). The coordinator posts this in prepareDeal, so the on-chain
/// deal permanently commits to the exact proof chain behind its deck · anyone
/// holding the transcript can re-verify the shuffle years later.
export function shuffleTranscriptHash(domainPrefix, stages) {
  const parts = [utf8(domainPrefix)];
  for (const st of stages) {
    parts.push(...packPts(deckFlat(st.deck)));
    const p = st.proof;
    parts.push(...packPts([...p.cCom, ...p.cHat, p.t1, p.t2, p.t3, p.t41, p.t42, ...p.tHat]));
    parts.push(fe32(p.s1), fe32(p.s2), fe32(p.s3), fe32(p.s4));
    for (const v of p.sHat) parts.push(fe32(v));
    for (const v of p.sP) parts.push(fe32(v));
  }
  return keccak(toHex(concat(...parts)));
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
