const { expect } = require("chai");
const zkDealer = require("../scripts/lib/poker-zk-dealer");

// The client-side secrecy gate: which decryption shares a player will release
// given the ON-CHAIN street — never trusting the coordinator's requested set.
// A malicious coordinator that asks for a player's own holes (or future board
// cards) early is simply refused. Truth table for k=2 (holes 0..3, board 4..8).
describe("zkShuffle v2 — share-release secrecy gate (mayReleaseShare)", function () {
  const k = 2, me = 0;                 // participant 0: own holes are idx 0,1
  const OTHER_HOLE = 2, MY_HOLE = 0;   // participant 1's hole is idx 2
  const FLOP0 = 2 * k + 0, TURN = 2 * k + 3, RIVER = 2 * k + 4;
  const PREFLOP = 0, F = 1, T = 2, R = 3, SHOWDOWN = 4, NOT_LIVE = -1;
  const may = (idx, street) => zkDealer.mayReleaseShare(idx, k, me, street);

  it("others' hole shares are always releasable (they decrypt nothing alone)", () => {
    for (const s of [NOT_LIVE, PREFLOP, F, T, R, SHOWDOWN]) expect(may(OTHER_HOLE, s)).to.equal(true);
  });

  it("my own hole shares only at showdown (and all-in runout, which lands on showdown)", () => {
    for (const s of [NOT_LIVE, PREFLOP, F, T, R]) expect(may(MY_HOLE, s)).to.equal(false);
    expect(may(MY_HOLE, SHOWDOWN)).to.equal(true);
    expect(may(1, SHOWDOWN)).to.equal(true); // my second hole card too
  });

  it("board shares only once their street has opened", () => {
    // flop (slot 0) — not before FLOP
    expect(may(FLOP0, PREFLOP)).to.equal(false);
    expect(may(FLOP0, NOT_LIVE)).to.equal(false);
    expect(may(FLOP0, F)).to.equal(true);
    // turn — not before TURN
    expect(may(TURN, F)).to.equal(false);
    expect(may(TURN, T)).to.equal(true);
    // river — not before RIVER
    expect(may(RIVER, T)).to.equal(false);
    expect(may(RIVER, R)).to.equal(true);
    expect(may(RIVER, SHOWDOWN)).to.equal(true);
  });

  it("the classic leak — coordinator asks for the whole board preflop — is fully refused", () => {
    for (let slot = 0; slot < 5; slot++) expect(may(2 * k + slot, PREFLOP)).to.equal(false);
  });

  it("out-of-range indices are refused", () => {
    expect(may(-1, SHOWDOWN)).to.equal(false);
    expect(may(2 * k + 5, SHOWDOWN)).to.equal(false);
  });
});
