const { expect } = require("chai");
const { ethers } = require("hardhat");
const crypto = require("node:crypto");

// Canonical Fiat–Shamir domains — MUST match ZkDealerV2.keyDomain / shareDomain.
const keyDomain = (dealId, seat) => `SPZK:${dealId}:key:${seat}`;
const shareDomain = (dealId, card, seat) => `SPZK:${dealId}:share:${card}:${seat}`;

describe("ZkDealerV2 — on-chain mental poker (BN254)", () => {
  let zk, dealer, bn254;
  const K = 3;

  before(async () => {
    zk = await import("../frontend/poker/zk-bn254.js");
    ({ bn254 } = await import("@noble/curves/bn254"));
    zk.init({ bn254, keccak256: ethers.keccak256, randomBytes: (n) => crypto.randomBytes(n) });
  });

  beforeEach(async () => {
    dealer = await (await ethers.getContractFactory("ZkDealerV2")).deploy();
  });

  // ethers struct arg from a noble point
  const P = (pt) => { const a = zk.aff(pt); return { x: a.x, y: a.y }; };

  async function openDealOnChain(dealId) {
    const players = Array.from({ length: K }, (_, i) => zk.keygen(keyDomain(dealId, i)));
    // sanity: proofs verify in JS too
    players.forEach((p, i) => expect(zk.verifyPok(keyDomain(dealId, i), p.X, p.pok)).to.equal(true));
    await dealer.openDeal(
      dealId,
      players.map((p) => P(p.X)),
      players.map((p) => P(p.pok.R)),
      players.map((p) => p.pok.s),
    );
    return players;
  }

  it("verifies every player's Schnorr key proof on-chain and aggregates the table key", async () => {
    const players = await openDealOnChain(1);
    const d = await dealer.getDeal(1);
    expect(d.k).to.equal(K);
    expect(d.open).to.equal(true);
    // on-chain aggregate == JS aggregate
    const X = zk.aggregate(players.map((p) => p.X));
    const a = zk.aff(X);
    expect(d.X.x).to.equal(a.x);
    expect(d.X.y).to.equal(a.y);
  });

  it("rejects a forged key proof (rogue-key / bad Schnorr)", async () => {
    const players = Array.from({ length: K }, (_, i) => zk.keygen(keyDomain(2, i)));
    players[1].pok.s = (players[1].pok.s + 1n); // tamper one proof
    await expect(dealer.openDeal(
      2,
      players.map((p) => P(p.X)),
      players.map((p) => P(p.pok.R)),
      players.map((p) => p.pok.s),
    )).to.be.revertedWithCustomError(dealer, "BadProof");
  });

  it("verifies a Chaum–Pedersen decryption share on-chain; forged share reverts", async () => {
    const dealId = 3;
    const players = await openDealOnChain(dealId);
    const X = zk.aggregate(players.map((p) => p.X));

    // build the shuffled encrypted deck
    let deck = zk.initialDeck(zk.deckPoints());
    for (let i = 0; i < K; i++) deck = zk.shuffleRemask(deck, X).deck;
    await dealer.setDeck(dealId, deck.map((c) => P(c.A)), deck.map((c) => P(c.B)));

    // seat 1 publishes a decryption share for card 0, verified on-chain
    const card = 0, seat = 1;
    const sh = zk.decryptionShare(deck[card], players[seat].x, players[seat].X, shareDomain(dealId, card, seat));
    expect(zk.verifyShare(deck[card], players[seat].X, sh, shareDomain(dealId, card, seat))).to.equal(true);
    await expect(dealer.revealShare(dealId, card, seat, P(sh.d), P(sh.proof.R1), P(sh.proof.R2), sh.proof.s))
      .to.emit(dealer, "ShareRevealed").withArgs(dealId, card, seat);
    const stored = await dealer.share(dealId, card, seat);
    const da = zk.aff(sh.d);
    expect(stored.x).to.equal(da.x);

    // a forged share (wrong d) must revert
    const bad = { ...sh, d: sh.d.add(bn254.G1.ProjectivePoint.BASE) };
    await expect(dealer.revealShare(dealId, card, seat, P(bad.d), P(bad.proof.R1), P(bad.proof.R2), bad.proof.s))
      .to.be.revertedWithCustomError(dealer, "BadProof");
  });

  it("the shuffle audit re-derives a stage on-chain: honest passes, tampered is caught", async () => {
    const dealId = 4;
    const players = await openDealOnChain(dealId);
    const X = zk.aggregate(players.map((p) => p.X));
    const Xp = P(X);

    const prev = zk.initialDeck(zk.deckPoints());
    const { deck: out, secret } = zk.shuffleRemask(prev, X);

    const prevA = prev.map((c) => P(c.A)), prevB = prev.map((c) => P(c.B));
    const outA = out.map((c) => P(c.A)), outB = out.map((c) => P(c.B));
    const perm = secret.perm, rho = secret.rho;

    const good = await dealer.checkStage(Xp, prevA, prevB, perm, rho, outA, outB);
    expect(good.ok).to.equal(true);

    // tamper one output card → audit catches it at that index
    const badOutB = outB.slice();
    badOutB[7] = P(out[7].B.add(bn254.G1.ProjectivePoint.BASE));
    const bad = await dealer.checkStage(Xp, prevA, prevB, perm, rho, outA, badOutB);
    expect(bad.ok).to.equal(false);
    expect(bad.firstBadCard).to.equal(7n);
  });
});
