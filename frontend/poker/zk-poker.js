// ShinyPoker — zkShuffle v2 core (EXPERIMENTAL): Barnett–Smart mental poker.
//
// The property v1 cannot give: DURING the hand nobody — not the dealer bot,
// not the host, not other players — learns your hole cards. The deck is
// ElGamal-encrypted under the TABLE's aggregate key; every player shuffles and
// re-randomizes it themselves; a hole card is decrypted only by its owner from
// the other players' decryption shares.
//
// Cryptography used (nothing hand-rolled where it matters):
//   - group ops: @noble/curves secp256k1 (audited, used by every wallet)
//   - Schnorr proof-of-knowledge for DKG contributions (anti rogue-key)
//   - Chaum–Pedersen proofs for decryption shares (share is honest or rejected)
//   - Fiat–Shamir via keccak256
//
// Verification model of THIS stage (v2-beta, документировано и в UI):
// shuffles are verified OPTIMISTICALLY — after the hand every player opens
// their permutation+randomness and the whole chain is re-computed; any
// manipulation is detected deterministically and attributable to the exact
// cheater (on a real table: escrow slash + hand void). Zero-knowledge shuffle
// arguments (verify DURING the hand, nothing opened after) are the next stage
// — see docs/ZKSHUFFLE-V2-SPEC.md R2.
//
// Dependency-injected so the SAME code runs in the browser (esm.sh noble +
// vendored ethers keccak) and in node selftests (npm noble + ethers).

let P; // ProjectivePoint class
let N; // curve order (bigint)
let keccak; // (hexOrBytes) -> 0x-hex
let rnd; // (nBytes) -> Uint8Array

export function init({ curve, keccak256, randomBytes }) {
  P = curve.ProjectivePoint;
  N = curve.CURVE.n;
  keccak = keccak256;
  rnd = randomBytes;
}

// ---- scalars / points ------------------------------------------------------
const toHex = (bytes) => "0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

export function randScalar() {
  for (;;) {
    const s = BigInt(toHex(rnd(32))) % N;
    if (s > 0n) return s;
  }
}

const mod = (x) => ((x % N) + N) % N;

/// Fiat–Shamir challenge from a transcript of points/strings.
function challenge(...items) {
  const enc = items.map((i) => (typeof i === "string" ? i : i.toHex(true))).join("|");
  let hex = "";
  for (const ch of enc) hex += ch.charCodeAt(0).toString(16).padStart(2, "0");
  return mod(BigInt(keccak("0x" + hex)));
}

// ---- deck encoding ---------------------------------------------------------
/// Card j (0..51) is the fixed public point G*(j+1). Known-dlog encoding is
/// fine for ElGamal message points; decryption gives the point, the reverse
/// table gives the card.
export function deckPoints() {
  const pts = [];
  for (let j = 0; j < 52; j++) pts.push(P.BASE.multiply(BigInt(j + 1)));
  return pts;
}
export function pointToCard(M, pts) {
  for (let j = 0; j < 52; j++) if (pts[j].equals(M)) return j;
  return -1;
}

// ---- DKG (aggregate table key) ---------------------------------------------
/// Each player: x_i secret, X_i = G·x_i with a Schnorr PoK so nobody can play
/// rogue-key games. Aggregate X = Σ X_i.
export function keygen(ctx) {
  const x = randScalar();
  const X = P.BASE.multiply(x);
  const k = randScalar();
  const R = P.BASE.multiply(k);
  const c = challenge("pok", ctx, X, R);
  const s = mod(k + c * x);
  return { x, X, pok: { R, s } };
}
export function verifyPok(ctx, X, pok) {
  const c = challenge("pok", ctx, X, pok.R);
  return P.BASE.multiply(pok.s).equals(pok.R.add(X.multiply(c)));
}
export function aggregate(Xs) {
  return Xs.reduce((a, X) => a.add(X), P.ZERO);
}

// ---- ElGamal deck ----------------------------------------------------------
/// Start with trivial ciphertexts (A=O, B=M_j): no trusted encryptor needed —
/// the first shuffle's re-randomization makes them real.
export function initialDeck(pts) {
  return pts.map((M) => ({ A: P.ZERO, B: M }));
}

/// One player's shuffle stage: output[k] = remask(input[perm[k]], rho[k]).
/// Returns what gets PUBLISHED (the new deck) and what stays SECRET until the
/// post-hand audit (perm + rho).
export function shuffleRemask(deck, X) {
  const n = deck.length;
  const perm = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Number(BigInt(toHex(rnd(4))) % BigInt(i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  const rho = perm.map(() => randScalar());
  const out = perm.map((from, k) => remask(deck[from], X, rho[k]));
  return { deck: out, secret: { perm, rho } };
}
export function remask(ct, X, rho) {
  return { A: ct.A.add(P.BASE.multiply(rho)), B: ct.B.add(X.multiply(rho)) };
}

// ---- decryption shares (Chaum–Pedersen) --------------------------------------
/// Share for ciphertext (A,B) from player with secret x: d = A·x, plus a proof
/// that log_G(X) == log_A(d) — an invalid share is rejected on the spot.
export function decryptionShare(ct, x, X, ctx) {
  const d = ct.A.multiply(x);
  const k = randScalar();
  const R1 = P.BASE.multiply(k);
  const R2 = ct.A.multiply(k);
  const c = challenge("cp", ctx, X, ct.A, d, R1, R2);
  const s = mod(k + c * x);
  return { d, proof: { R1, R2, s } };
}
export function verifyShare(ct, X, share, ctx) {
  const { d, proof } = share;
  const c = challenge("cp", ctx, X, ct.A, d, proof.R1, proof.R2);
  return P.BASE.multiply(proof.s).equals(proof.R1.add(X.multiply(c)))
    && ct.A.multiply(proof.s).equals(proof.R2.add(d.multiply(c)));
}

/// Owner-side decryption: M = B − Σ shares − A·x_own.
export function decryptWithShares(ct, shares, ownX) {
  let M = ct.B;
  for (const d of shares) M = M.subtract(d);
  if (ownX != null) M = M.subtract(ct.A.multiply(ownX));
  return M;
}

// ---- post-hand audit ---------------------------------------------------------
/// Every player opens {perm, rho}; the chain is recomputed stage by stage.
/// The first stage whose published deck doesn't match the recomputation is the
/// cheater — deterministically, no probabilistic hand-waving.
export function auditShuffles(pts, X, stages) {
  let cur = initialDeck(pts);
  for (let i = 0; i < stages.length; i++) {
    const { published, secret } = stages[i];
    const expect = secret.perm.map((from, k) => remask(cur[from], X, secret.rho[k]));
    for (let k = 0; k < expect.length; k++) {
      if (!expect[k].A.equals(published[k].A) || !expect[k].B.equals(published[k].B)) {
        return { ok: false, cheater: i, card: k };
      }
    }
    cur = published;
  }
  return { ok: true, cheater: -1 };
}
