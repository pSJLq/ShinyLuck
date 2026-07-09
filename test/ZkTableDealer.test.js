const { expect } = require("chai");
const { ethers } = require("hardhat");
const crypto = require("node:crypto");

const keyDomain = (d, s) => `SPZK:${d}:key:${s}`;
const shareDomain = (d, c, s) => `SPZK:${d}:share:${c}:${s}`;

describe("ZkTableDealer — live v2 card layer (IPokerDealer, cards from verified decryption)", () => {
  let zk, bn254, dealer, room, coord, other;

  before(async () => {
    zk = await import("../frontend/poker/zk-bn254.js");
    ({ bn254 } = await import("@noble/curves/bn254"));
    zk.init({ bn254, keccak256: ethers.keccak256, randomBytes: (n) => crypto.randomBytes(n) });
  });

  beforeEach(async () => {
    [room, coord, other] = await ethers.getSigners();
    dealer = await (await ethers.getContractFactory("ZkTableDealer")).deploy(room.address, coord.address);
  });

  const P = (pt) => { const a = zk.aff(pt); return { x: a.x, y: a.y }; };
  const ctPair = (ct) => [P(ct.A), P(ct.B)]; // calldata shape for one ciphertext

  // Set up a k-player deal: keygen, shuffle deck, prepareDeal(coordinator).
  async function setup(dealId, tableId, handId, seats) {
    const k = seats.length;
    const players = seats.map((_, i) => zk.keygen(keyDomain(dealId, i)));
    const X = zk.aggregate(players.map((p) => p.X));
    let deck = zk.initialDeck(zk.deckPoints());
    for (let i = 0; i < k; i++) deck = zk.shuffleRemask(deck, X).deck;
    const inPlay = deck.slice(0, 2 * k + 5); // only hole + board ciphertexts are committed/revealed
    await dealer.connect(coord).prepareDeal(
      dealId, tableId, handId, seats,
      players.map((p) => P(p.X)), players.map((p) => P(p.pok.R)), players.map((p) => p.pok.s),
      inPlay.map((c) => P(c.A)), inPlay.map((c) => P(c.B)),
    );
    return { players, X, deck, k };
  }

  // Every participant's decryption share (+CP proof) for one ciphertext index.
  function sharesFor(deck, players, dealId, cardIdx) {
    const ct = deck[cardIdx];
    const shs = players.map((p, i) => zk.decryptionShare(ct, p.x, p.X, shareDomain(dealId, cardIdx, i)));
    return {
      ct,
      d: shs.map((s) => P(s.d)), R1: shs.map((s) => P(s.proof.R1)), R2: shs.map((s) => P(s.proof.R2)), s: shs.map((s) => s.proof.s),
      trueCard: zk.pointToCard(zk.decryptWithShares(ct, shs.map((s) => s.d), null), zk.deckPoints()),
    };
  }

  it("prepares a heads-up deal, binds it via room.startHand, reveals the board from proven shares", async () => {
    const dealId = 1, tableId = 7, handId = 1, seats = [0, 1];
    const { players, deck, k } = await setup(dealId, tableId, handId, seats);

    // room binds the hand
    await dealer.connect(room).startHand(tableId, handId, k, seats);
    expect(await dealer.dealIdForHand(tableId, handId)).to.equal(dealId);

    // reveal the flop (board slots 0,1,2 → deck idx 2k+slot), each decrypted publicly
    for (let slot = 0; slot < 3; slot++) {
      const cardIdx = 2 * k + slot;
      const sh = sharesFor(deck, players, dealId, cardIdx);
      await dealer.connect(coord).revealBoardCard(dealId, slot, sh.trueCard, ctPair(sh.ct), sh.d, sh.R1, sh.R2, sh.s);
    }
    expect(await dealer.boardRevealedCount(dealId)).to.equal(3);
    const board = await dealer.boardCards(dealId);
    // matches the true decryption of the committed deck
    for (let slot = 0; slot < 3; slot++) {
      const sh = sharesFor(deck, players, dealId, 2 * k + slot);
      expect(Number(board[slot])).to.equal(sh.trueCard);
    }
    expect(Number(board[3])).to.equal(255);
  });

  it("rejects a lie about a board card (shares valid but claimed card wrong)", async () => {
    const dealId = 2, tableId = 7, handId = 2, seats = [0, 1];
    const { players, deck, k } = await setup(dealId, tableId, handId, seats);
    const sh = sharesFor(deck, players, dealId, 2 * k);
    const wrong = (sh.trueCard + 1) % 52;
    await expect(dealer.connect(coord).revealBoardCard(dealId, 0, wrong, ctPair(sh.ct), sh.d, sh.R1, sh.R2, sh.s))
      .to.be.revertedWithCustomError(dealer, "BadCard");
  });

  it("rejects a forged decryption share (bad Chaum–Pedersen)", async () => {
    const dealId = 3, tableId = 7, handId = 3, seats = [0, 1];
    const { players, deck, k } = await setup(dealId, tableId, handId, seats);
    const sh = sharesFor(deck, players, dealId, 2 * k);
    sh.s[1] = sh.s[1] + 1n; // tamper participant 1's proof
    await expect(dealer.connect(coord).revealBoardCard(dealId, 0, sh.trueCard, ctPair(sh.ct), sh.d, sh.R1, sh.R2, sh.s))
      .to.be.revertedWithCustomError(dealer, "BadProof");
  });

  it("rejects a ciphertext that doesn't match the prepareDeal commitment", async () => {
    const dealId = 31, tableId = 7, handId = 31, seats = [0, 1];
    const { players, deck, k } = await setup(dealId, tableId, handId, seats);
    // proofs computed against a DIFFERENT (uncommitted) ciphertext — a coordinator
    // swapping the deck after commit must be caught by the hash check.
    const swapped = deck[2 * k + 1]; // wrong index for board slot 0
    const shs = players.map((p, i) => zk.decryptionShare(swapped, p.x, p.X, shareDomain(dealId, 2 * k, i)));
    const card = zk.pointToCard(zk.decryptWithShares(swapped, shs.map((s) => s.d), null), zk.deckPoints());
    await expect(dealer.connect(coord).revealBoardCard(
      dealId, 0, card, ctPair(swapped),
      shs.map((s) => P(s.d)), shs.map((s) => P(s.proof.R1)), shs.map((s) => P(s.proof.R2)), shs.map((s) => s.proof.s),
    )).to.be.revertedWithCustomError(dealer, "BadCiphertext");
  });

  it("reveals a seat's hole cards at showdown from proven shares; room reads them", async () => {
    const dealId = 4, tableId = 7, handId = 4, seats = [0, 1];
    const { players, deck, k } = await setup(dealId, tableId, handId, seats);
    await dealer.connect(room).startHand(tableId, handId, k, seats);

    // participant 0 → seat 0, cards at deck idx 0 and 1
    const c0 = sharesFor(deck, players, dealId, 0);
    const c1 = sharesFor(deck, players, dealId, 1);
    await dealer.connect(coord).revealHoleCards(
      dealId, 0, 0, [c0.trueCard, c1.trueCard],
      [...ctPair(c0.ct), ...ctPair(c1.ct)],
      [...c0.d, ...c1.d], [...c0.R1, ...c1.R1], [...c0.R2, ...c1.R2], [...c0.s, ...c1.s],
    );
    const [h0, h1] = await dealer.holeCards(dealId, 0);
    expect(Number(h0)).to.equal(c0.trueCard);
    expect(Number(h1)).to.equal(c1.trueCard);
    // unrevealed seat stays hidden
    const [u0, u1] = await dealer.holeCards(dealId, 1);
    expect(Number(u0)).to.equal(255);
    expect(Number(u1)).to.equal(255);
  });

  it("binds only the EXACT prepared seat set (element-wise, not just length)", async () => {
    const dealId = 6, tableId = 7, handId = 6, seats = [0, 2];
    const { k } = await setup(dealId, tableId, handId, seats);
    // same length, different seats — the participant→seat mapping would corrupt
    await expect(dealer.connect(room).startHand(tableId, handId, k, [0, 3]))
      .to.be.revertedWithCustomError(dealer, "SeatMismatch");
    await dealer.connect(room).startHand(tableId, handId, k, [0, 2]); // exact set binds
  });

  it("rejects the same card value revealed twice (duplicated-card shuffle tripwire)", async () => {
    const dealId = 8, tableId = 7, handId = 8, seats = [0, 1];
    const k = seats.length;
    const players = seats.map((_, i) => zk.keygen(keyDomain(dealId, i)));
    const X = zk.aggregate(players.map((p) => p.X));
    // MALICIOUS deck: board slot 1 is a remask of board slot 0 → same card twice
    let deck = zk.initialDeck(zk.deckPoints());
    for (let i = 0; i < k; i++) deck = zk.shuffleRemask(deck, X).deck;
    deck = deck.slice();
    deck[2 * k + 1] = zk.remask(deck[2 * k], X, 12345n);
    const inPlay = deck.slice(0, 2 * k + 5);
    await dealer.connect(coord).prepareDeal(
      dealId, tableId, handId, seats,
      players.map((p) => P(p.X)), players.map((p) => P(p.pok.R)), players.map((p) => p.pok.s),
      inPlay.map((c) => P(c.A)), inPlay.map((c) => P(c.B)),
    );
    const a = sharesFor(deck, players, dealId, 2 * k);
    await dealer.connect(coord).revealBoardCard(dealId, 0, a.trueCard, ctPair(a.ct), a.d, a.R1, a.R2, a.s);
    const b = sharesFor(deck, players, dealId, 2 * k + 1);
    expect(b.trueCard).to.equal(a.trueCard); // the dupe decrypts to the same card…
    await expect(dealer.connect(coord).revealBoardCard(dealId, 1, b.trueCard, ctPair(b.ct), b.d, b.R1, b.R2, b.s))
      .to.be.revertedWithCustomError(dealer, "DupeCard"); // …and is rejected on-chain
  });

  it("only the room can bind a hand; only a coordinator can reveal; workers are addable", async () => {
    const dealId = 5, tableId = 7, handId = 5, seats = [0, 1];
    const { deck, players, k } = await setup(dealId, tableId, handId, seats);
    await expect(dealer.connect(other).startHand(tableId, handId, k, seats)).to.be.revertedWithCustomError(dealer, "NotRoom");
    const sh = sharesFor(deck, players, dealId, 2 * k);
    await expect(dealer.connect(other).revealBoardCard(dealId, 0, sh.trueCard, ctPair(sh.ct), sh.d, sh.R1, sh.R2, sh.s))
      .to.be.revertedWithCustomError(dealer, "NotCoordinator");
    // owner (deployer = room signer here) enables a second worker key → it can post
    await dealer.connect(room).setCoordinator(other.address, true);
    await dealer.connect(other).revealBoardCard(dealId, 0, sh.trueCard, ctPair(sh.ct), sh.d, sh.R1, sh.R2, sh.s);
    expect(await dealer.boardRevealedCount(dealId)).to.equal(1);
  });
});
