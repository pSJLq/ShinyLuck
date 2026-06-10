const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

// ActionType enum (PokerRoom.sol)
const FOLD = 0, CHECK = 1, CALL = 2, BET = 3, RAISE = 4, ALLIN = 5;
const E = (n) => ethers.parseEther(String(n));

// A 6-max cash table: blinds 1/2, buy-in 40..200, 2.5% rake capped at 3, 30s clock.
function tableCfg(over = {}) {
  return {
    maxSeats: over.maxSeats ?? 6,
    smallBlind: over.smallBlind ?? E(1),
    bigBlind: over.bigBlind ?? E(2),
    ante: over.ante ?? 0,
    minBuyIn: over.minBuyIn ?? E(40),
    maxBuyIn: over.maxBuyIn ?? E(200),
    rakeBps: over.rakeBps ?? 250,
    rakeCap: over.rakeCap ?? E(3),
    actionTimeout: over.actionTimeout ?? 30,
    active: over.active ?? true,
  };
}

describe("PokerRoom — engine", function () {
  async function setup() {
    const [owner, operator, alice, bob, carol] = await ethers.getSigners();
    const Room = await ethers.getContractFactory("PokerRoom");
    const poker = await Room.deploy(owner.address);
    await poker.waitForDeployment();
    await poker.connect(owner).setDealerOperator(operator.address);
    return { owner, operator, alice, bob, carol, poker };
  }

  // Sit `players` at seats 0.. with a 100-buy-in each, on a fresh table.
  async function seatPlayers(poker, operator, players, cfg = tableCfg()) {
    await poker.connect(operator.owner ?? operator).getAddress?.();
    return cfg;
  }

  async function makeTable(poker, owner, cfg = tableCfg()) {
    await poker.connect(owner).createTable(cfg);
    return Number((await poker.tableCount()) - 1n);
  }

  async function buyIn(poker, signer, tableId, seat, amount = E(100)) {
    await poker.connect(signer).deposit({ value: amount });
    await poker.connect(signer).sitDown(tableId, seat, amount);
  }

  const actingSeat = async (poker, t) => Number((await poker.getHand(t)).actingSeat);
  const seatStack = async (poker, t, s) => (await poker.getSeat(t, s)).stack;

  it("seats players and posts blinds (heads-up: button is SB and acts first)", async function () {
    const { owner, operator, alice, bob, poker } = await loadFixture(setup);
    const t = await makeTable(poker, owner, tableCfg({ maxSeats: 2 }));
    await buyIn(poker, alice, t, 0);
    await buyIn(poker, bob, t, 1);

    await poker.connect(operator).startHand(t);
    const h = await poker.getHand(t);
    expect(h.inProgress).to.equal(true);
    expect(Number(h.button)).to.equal(0); // first hand → button to first eligible seat
    expect(h.currentBet).to.equal(E(2)); // big blind
    // SB = button = seat0, BB = seat1
    expect((await poker.getSeatHand(t, 0)).committedStreet).to.equal(E(1));
    expect((await poker.getSeatHand(t, 1)).committedStreet).to.equal(E(2));
    // Heads-up: SB/button (seat0) acts first preflop
    expect(Number(h.actingSeat)).to.equal(0);
    expect(await seatStack(poker, t, 0)).to.equal(E(99));
    expect(await seatStack(poker, t, 1)).to.equal(E(98));
  });

  it("heads-up: a flop bet that gets folded awards the pot minus rake", async function () {
    const { owner, operator, alice, bob, poker } = await loadFixture(setup);
    const t = await makeTable(poker, owner, tableCfg({ maxSeats: 2 }));
    await buyIn(poker, alice, t, 0);
    await buyIn(poker, bob, t, 1);
    await poker.connect(operator).startHand(t);

    // preflop: alice (SB/button) calls, bob (BB) checks → flop, pot 4
    await poker.connect(alice).act(t, CALL, 0);
    await poker.connect(bob).act(t, CHECK, 0);
    expect(Number((await poker.getHand(t)).street)).to.equal(1); // FLOP

    // flop: bob (first to act postflop) checks, alice bets 4, bob folds
    await poker.connect(bob).act(t, CHECK, 0);
    await poker.connect(alice).act(t, BET, E(4));
    const tx = await poker.connect(bob).act(t, FOLD, 0);

    // pot = 4 (preflop) + 4 (alice's flop bet) = 8; rake 2.5% = 0.2; alice wins 7.8
    await expect(tx).to.emit(poker, "HandSettled").withArgs(t, 1, 0, E("7.8"), E("0.2"));
    expect(await poker.rakeCollected()).to.equal(E("0.2"));
    // alice: 100 - 2 (preflop) - 4 (flop) + 7.8 = 101.8 ; bob: 100 - 2 = 98
    expect(await seatStack(poker, t, 0)).to.equal(E("101.8"));
    expect(await seatStack(poker, t, 1)).to.equal(E(98));
    expect((await poker.getHand(t)).inProgress).to.equal(false);
  });

  it("preflop fold to the big blind takes no rake (no flop, no drop)", async function () {
    const { owner, operator, alice, bob, poker } = await loadFixture(setup);
    const t = await makeTable(poker, owner, tableCfg({ maxSeats: 2 }));
    await buyIn(poker, alice, t, 0);
    await buyIn(poker, bob, t, 1);
    await poker.connect(operator).startHand(t);

    // alice (SB/button) folds preflop → bob wins the blinds, no rake
    const tx = await poker.connect(alice).act(t, FOLD, 0);
    await expect(tx).to.emit(poker, "HandSettled").withArgs(t, 1, 1, E(3), 0);
    expect(await poker.rakeCollected()).to.equal(0);
    expect(await seatStack(poker, t, 1)).to.equal(E(101)); // 98 + 3
  });

  it("rejects a raise below the minimum", async function () {
    const { owner, operator, alice, bob, carol, poker } = await loadFixture(setup);
    const t = await makeTable(poker, owner);
    await buyIn(poker, alice, t, 0);
    await buyIn(poker, bob, t, 1);
    await buyIn(poker, carol, t, 2);
    await poker.connect(operator).startHand(t);

    // UTG (button, seat0) tries to raise to 3 (raiseBy 1 < minRaise 2) → revert
    const seat = await actingSeat(poker, t);
    expect(seat).to.equal(0);
    await expect(poker.connect(alice).act(t, RAISE, E(3))).to.be.revertedWithCustomError(
      poker,
      "BelowMinRaise"
    );
    // raising to 4 (raiseBy 2 == minRaise) is allowed
    await expect(poker.connect(alice).act(t, RAISE, E(4))).to.not.be.reverted;
  });

  it("3-handed checked/called down reaches showdown with the right pot", async function () {
    const { owner, operator, alice, bob, carol, poker } = await loadFixture(setup);
    const t = await makeTable(poker, owner);
    const sgn = [alice, bob, carol];
    await buyIn(poker, alice, t, 0);
    await buyIn(poker, bob, t, 1);
    await buyIn(poker, carol, t, 2);
    await poker.connect(operator).startHand(t);

    // Preflop: seat0 (button) calls, seat1 (SB) calls, seat2 (BB) checks option.
    await poker.connect(alice).act(t, CALL, 0);
    await poker.connect(bob).act(t, CALL, 0);
    await poker.connect(carol).act(t, CHECK, 0);
    expect(Number((await poker.getHand(t)).street)).to.equal(1); // FLOP, pot 6

    // Flop, turn, river: everyone checks (driven by actingSeat).
    let lastTx;
    for (let street = 0; street < 3; street++) {
      for (let i = 0; i < 3; i++) {
        const s = await actingSeat(poker, t);
        lastTx = await poker.connect(sgn[s]).act(t, CHECK, 0);
      }
    }
    await expect(lastTx).to.emit(poker, "ShowdownReached").withArgs(t, 1, E(6));
    const h = await poker.getHand(t);
    expect(Number(h.street)).to.equal(4); // SHOWDOWN
    expect(h.inProgress).to.equal(true); // awaits resolveShowdown (next engine section)
  });

  it("timeoutAct folds a stalled player after the clock expires", async function () {
    const { owner, operator, alice, bob, poker } = await loadFixture(setup);
    const t = await makeTable(poker, owner, tableCfg({ maxSeats: 2, actionTimeout: 30 }));
    await buyIn(poker, alice, t, 0);
    await buyIn(poker, bob, t, 1);
    await poker.connect(operator).startHand(t);

    // alice (to act) stalls; too-early timeout reverts, then succeeds past deadline
    await expect(poker.connect(operator).timeoutAct(t)).to.be.revertedWithCustomError(poker, "TooEarly");
    await time.increase(31);
    const tx = await poker.connect(operator).timeoutAct(t);
    // alice owed a call (1 to match BB) so timeout folds her → bob wins blinds
    await expect(tx).to.emit(poker, "HandSettled").withArgs(t, 1, 1, E(3), 0);
  });

  it("a session key acts on the player's behalf (no per-action signature); revoke disables it", async function () {
    const { owner, operator, alice, bob, poker } = await loadFixture(setup);
    const sessionKey = (await ethers.getSigners())[5];
    const t = await makeTable(poker, owner, tableCfg({ maxSeats: 2 }));
    await buyIn(poker, alice, t, 0);
    await buyIn(poker, bob, t, 1);

    // alice authorizes + funds her session key in one call
    const before = await ethers.provider.getBalance(sessionKey.address);
    await poker.connect(alice).setSessionKey(sessionKey.address, { value: E(1) });
    expect((await ethers.provider.getBalance(sessionKey.address)) - before).to.equal(E(1));
    expect(await poker.sessionKeyOf(alice.address)).to.equal(sessionKey.address);
    expect(await poker.sessionOwnerOf(sessionKey.address)).to.equal(alice.address);

    await poker.connect(operator).startHand(t);
    expect(Number((await poker.getHand(t)).actingSeat)).to.equal(0); // alice's turn

    // alice folds via the SESSION KEY (alice never signs) → bob wins the blinds
    const tx = await poker.connect(sessionKey).act(t, FOLD, 0);
    await expect(tx).to.emit(poker, "HandSettled").withArgs(t, 1, 1, E(3), 0);

    // revoke → the key can no longer resolve to alice (acts as itself → not seated)
    await poker.connect(alice).revokeSessionKey();
    expect(await poker.sessionKeyOf(alice.address)).to.equal(ethers.ZeroAddress);
    expect(await poker.sessionOwnerOf(sessionKey.address)).to.equal(ethers.ZeroAddress);
    await poker.connect(operator).startHand(t);
    await expect(poker.connect(sessionKey).act(t, FOLD, 0)).to.be.revertedWithCustomError(poker, "NotSeated");
  });
});
