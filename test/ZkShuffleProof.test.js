const { expect } = require("chai");
const { ethers } = require("hardhat");
const crypto = require("node:crypto");

// The Wikström verifiable-shuffle argument (Haenni et al. FC'17 pseudo-code,
// Algorithms 4.3–4.6) on BN254 — the primitive that closes the "at least one
// honest shuffler" gap: every shuffler PROVES its output deck is a permutation
// + re-encryption of its input deck, so even the last shuffler (with everyone
// else colluding) cannot substitute, duplicate or bias a single ciphertext.
describe("zkShuffle v2 — Wikström shuffle argument", function () {
  this.timeout(120000);
  let zk, bn254, G1, X, deck0, pts;

  before(async () => {
    zk = await import("../frontend/poker/zk-bn254.js");
    ({ bn254 } = await import("@noble/curves/bn254"));
    zk.init({ bn254, keccak256: ethers.keccak256, randomBytes: (n) => crypto.randomBytes(n) });
    G1 = bn254.G1.ProjectivePoint;
    const p1 = zk.keygen("k1"), p2 = zk.keygen("k2");
    X = zk.aggregate([p1.X, p2.X]);
    pts = zk.deckPoints();
    deck0 = zk.initialDeck(pts);
  });

  it("NUMS generators derive deterministically and are distinct", () => {
    const { H, h0 } = zk.shuffleGens();
    expect(H).to.have.length(52);
    const seen = new Set(H.map((P) => zk.aff(P).x.toString()));
    seen.add(zk.aff(h0).x.toString());
    expect(seen.size).to.equal(53); // no collisions, h ∉ {h_i}
    for (const P of [...H, h0]) expect(() => P.assertValidity()).to.not.throw();
  });

  it("accepts an honest shuffle and a chained second stage", () => {
    const { deck: d1, secret } = zk.shuffleRemask(deck0, X);
    const prf = zk.proveShuffle("SPZK:t:shuffle:0", deck0, d1, X, secret);
    expect(zk.verifyShuffle("SPZK:t:shuffle:0", deck0, d1, X, prf)).to.equal(true);
    const { deck: d2, secret: s2 } = zk.shuffleRemask(d1, X);
    const prf2 = zk.proveShuffle("SPZK:t:shuffle:1", d1, d2, X, s2);
    expect(zk.verifyShuffle("SPZK:t:shuffle:1", d1, d2, X, prf2)).to.equal(true);
  });

  it("rejects every tampering class: substitution, duplication, reorder, foreign deck, wrong domain, bad scalar", () => {
    const { deck: d1, secret } = zk.shuffleRemask(deck0, X);
    const prf = zk.proveShuffle("SPZK:t:shuffle:0", deck0, d1, X, secret);

    // substitution: a KNOWN card's ciphertext planted into a slot
    const subbed = d1.slice();
    subbed[0] = { A: G1.ZERO, B: pts[51] };
    expect(zk.verifyShuffle("SPZK:t:shuffle:0", deck0, subbed, X, prf)).to.equal(false);

    // duplication: two slots decrypt to the same card
    const duped = d1.slice();
    duped[5] = duped[4];
    expect(zk.verifyShuffle("SPZK:t:shuffle:0", deck0, duped, X, prf)).to.equal(false);

    // post-proof reorder
    const swapped = d1.slice();
    [swapped[3], swapped[7]] = [swapped[7], swapped[3]];
    expect(zk.verifyShuffle("SPZK:t:shuffle:0", deck0, swapped, X, prf)).to.equal(false);

    // a proof reused for a different (even honestly shuffled) deck
    const { deck: foreign } = zk.shuffleRemask(deck0, X);
    expect(zk.verifyShuffle("SPZK:t:shuffle:0", deck0, foreign, X, prf)).to.equal(false);

    // domain separation (deal/turn binding)
    expect(zk.verifyShuffle("SPZK:t:shuffle:1", deck0, d1, X, prf)).to.equal(false);

    // tampered response scalar
    const bad = { ...prf, s3: (prf.s3 + 1n) % bn254.G1.CURVE.n };
    expect(zk.verifyShuffle("SPZK:t:shuffle:0", deck0, d1, X, bad)).to.equal(false);
  });

  it("wire roundtrip preserves validity; transcript hash is stable and content-sensitive", () => {
    const { deck: d1, secret } = zk.shuffleRemask(deck0, X);
    const prf = zk.proveShuffle("SPZK:t:shuffle:0", deck0, d1, X, secret);
    const wire = JSON.parse(JSON.stringify(zk.shuffleProofToWire(prf)));
    const parsePoint = (o) => { const P = G1.fromAffine({ x: BigInt(o.x), y: BigInt(o.y) }); P.assertValidity(); return P; };
    const back = zk.shuffleProofFromWire(wire, parsePoint);
    expect(zk.verifyShuffle("SPZK:t:shuffle:0", deck0, d1, X, back)).to.equal(true);

    const h1 = zk.shuffleTranscriptHash("SPZKSH:tr:1", [{ deck: d1, proof: prf }]);
    const h2 = zk.shuffleTranscriptHash("SPZKSH:tr:1", [{ deck: d1, proof: prf }]);
    const h3 = zk.shuffleTranscriptHash("SPZKSH:tr:2", [{ deck: d1, proof: prf }]);
    expect(h1).to.equal(h2);
    expect(h1).to.not.equal(h3);
  });

  it("rejects out-of-range scalars and malformed shapes at the wire boundary", () => {
    const { deck: d1, secret } = zk.shuffleRemask(deck0, X);
    const prf = zk.proveShuffle("SPZK:t:shuffle:0", deck0, d1, X, secret);
    const wire = zk.shuffleProofToWire(prf);
    const parsePoint = (o) => { const P = G1.fromAffine({ x: BigInt(o.x), y: BigInt(o.y) }); P.assertValidity(); return P; };
    // scalar ≥ group order must be refused (canonical encoding only)
    const badScalar = { ...wire, s1: "0x" + bn254.G1.CURVE.n.toString(16) };
    expect(() => zk.shuffleProofFromWire(badScalar, parsePoint)).to.throw(/out of range/);
    // truncated arrays must be refused
    const badShape = { ...wire, cHat: wire.cHat.slice(0, 51) };
    expect(() => zk.shuffleProofFromWire(badShape, parsePoint)).to.throw(/bad proof shape/);
    // off-curve point must be refused
    const badPt = { ...wire, t1: { x: "0x1", y: "0x1" } };
    expect(() => zk.shuffleProofFromWire(badPt, parsePoint)).to.throw();
  });
});
