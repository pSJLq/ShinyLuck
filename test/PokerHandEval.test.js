const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

// Card encoding: card = rank*4 + suit. rank 0=2..12=A; suit c,d,h,s = 0..3.
const R = { "2": 0, "3": 1, "4": 2, "5": 3, "6": 4, "7": 5, "8": 6, "9": 7, T: 8, J: 9, Q: 10, K: 11, A: 12 };
const S = { c: 0, d: 1, h: 2, s: 3 };
const card = (str) => R[str[0]] * 4 + S[str[1]];
const hand = (...cs) => cs.map(card);

describe("PokerHandEval — 7-card evaluator", function () {
  async function setup() {
    const H = await ethers.getContractFactory("PokerEvalHarness");
    const h = await H.deploy();
    await h.waitForDeployment();
    return h;
  }

  it("orders every hand category correctly", async function () {
    const h = await loadFixture(setup);
    const sf = await h.score(hand("As", "Ks", "Qs", "Js", "Ts", "2c", "3d")); // royal flush
    const quads = await h.score(hand("Ac", "Ad", "Ah", "As", "Ks", "2c", "3d"));
    const boat = await h.score(hand("Ac", "Ad", "Ah", "Ks", "Kd", "2c", "3d"));
    const flush = await h.score(hand("As", "Js", "9s", "6s", "3s", "2c", "Kd"));
    const straight = await h.score(hand("9c", "8d", "7h", "6s", "5c", "2c", "Kd"));
    const trips = await h.score(hand("Ac", "Ad", "Ah", "Ks", "Qd", "2c", "3d"));
    const twoPair = await h.score(hand("Ac", "Ad", "Ks", "Kd", "Qd", "2c", "3h"));
    const pair = await h.score(hand("Ac", "Ad", "Ks", "Qd", "Jh", "2c", "3h"));
    const high = await h.score(hand("Ac", "Kd", "Qs", "Jd", "9h", "2c", "3h"));

    expect(sf).to.be.gt(quads);
    expect(quads).to.be.gt(boat);
    expect(boat).to.be.gt(flush);
    expect(flush).to.be.gt(straight);
    expect(straight).to.be.gt(trips);
    expect(trips).to.be.gt(twoPair);
    expect(twoPair).to.be.gt(pair);
    expect(pair).to.be.gt(high);
  });

  it("breaks ties on kickers", async function () {
    const h = await loadFixture(setup);
    const aceKing = await h.score(hand("Ac", "Ad", "Ks", "Qd", "9h", "2c", "3h")); // AA, K kicker
    const aceQueen = await h.score(hand("Ac", "Ad", "Qs", "Jd", "9h", "2c", "3h")); // AA, Q kicker
    expect(aceKing).to.be.gt(aceQueen);
  });

  it("recognizes the wheel as the lowest straight", async function () {
    const h = await loadFixture(setup);
    const wheel = await h.score(hand("Ac", "2d", "3h", "4s", "5c", "Kd", "Qh")); // A-2-3-4-5
    const six = await h.score(hand("6c", "2d", "3h", "4s", "5c", "Kd", "Qh")); // 2-3-4-5-6
    const pairAces = await h.score(hand("Ac", "Ad", "3h", "4s", "7c", "Kd", "Qh"));
    expect(six).to.be.gt(wheel); // a 6-high straight beats the wheel
    expect(wheel).to.be.gt(pairAces); // but the wheel is still a straight, above a pair
  });

  it("ties when both players play the board", async function () {
    const h = await loadFixture(setup);
    const board = ["As", "Ks", "Qs", "Js", "Ts"]; // royal flush on the board
    const p1 = await h.score(hand(...board, "2c", "3d"));
    const p2 = await h.score(hand(...board, "4c", "5d"));
    expect(p1).to.equal(p2);
  });
});
