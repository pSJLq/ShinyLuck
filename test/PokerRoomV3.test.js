const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const FOLD = 0, CHECK = 1, CALL = 2, BET = 3, RAISE = 4, ALLIN = 5;
const E = (n) => ethers.parseEther(String(n));

function tableCfg(over = {}) {
  return {
    maxSeats: over.maxSeats ?? 6,
    smallBlind: over.smallBlind ?? E(1),
    bigBlind: over.bigBlind ?? E(2),
    ante: over.ante ?? 0,
    minBuyIn: over.minBuyIn ?? E(40),
    maxBuyIn: over.maxBuyIn ?? E(200),
    rakeBps: over.rakeBps ?? 0,
    rakeCap: over.rakeCap ?? 0,
    actionTimeout: over.actionTimeout ?? 30,
    active: over.active ?? true,
  };
}

describe("PokerRoom v3 — worker operators, idle strikes, penalized cancel, tournament blind-off", function () {
  async function setup() {
    const [owner, operator, worker, alice, bob, carol, factory] = await ethers.getSigners();
    const Room = await ethers.getContractFactory("PokerRoom");
    const poker = await Room.deploy(owner.address);
    await poker.waitForDeployment();
    await poker.connect(owner).setDealerOperator(operator.address);
    return { owner, operator, worker, alice, bob, carol, factory, poker };
  }

  async function makeTable(poker, owner, cfg = tableCfg()) {
    await poker.connect(owner).createTable(cfg);
    return Number((await poker.tableCount()) - 1n);
  }

  async function buyIn(poker, signer, tableId, seat, amount = E(100)) {
    await poker.connect(signer).deposit({ value: amount });
    await poker.connect(signer).sitDown(tableId, seat, amount);
  }

  const seatStack = async (poker, t, s) => (await poker.getSeat(t, s)).stack;

  it("worker operator keys: enabled key can drive tables, disabled key cannot", async function () {
    const { owner, worker, alice, bob, poker } = await loadFixture(setup);
    const t = await makeTable(poker, owner, tableCfg({ maxSeats: 2 }));
    await buyIn(poker, alice, t, 0);
    await buyIn(poker, bob, t, 1);

    await expect(poker.connect(worker).startHand(t)).to.be.revertedWithCustomError(poker, "NotDealerOrOperator");
    await poker.connect(owner).setOperator(worker.address, true);
    await poker.connect(worker).startHand(t); // worker drives the table now
    await poker.connect(worker).cancelHand(t);
    await poker.connect(owner).setOperator(worker.address, false);
    await expect(poker.connect(worker).startHand(t)).to.be.revertedWithCustomError(poker, "NotDealerOrOperator");
  });

  it("sitOutIdle strikes an unresponsive seat; 3 strikes make it kickable", async function () {
    const { owner, operator, alice, bob, carol, poker } = await loadFixture(setup);
    const t = await makeTable(poker, owner);
    await buyIn(poker, alice, t, 0);
    await buyIn(poker, bob, t, 1);
    await buyIn(poker, carol, t, 2);

    await expect(poker.connect(carol).sitOutIdle(t, 2)).to.be.revertedWithCustomError(poker, "NotDealerOrOperator");

    await poker.connect(operator).sitOutIdle(t, 2);
    expect((await poker.getSeat(t, 2)).sittingOut).to.equal(true);
    expect(Number(await poker.timeoutStreak(t, 2))).to.equal(1);
    await expect(poker.connect(operator).kickIdle(t, 2)).to.be.revertedWithCustomError(poker, "NotIdle");

    await poker.connect(operator).sitOutIdle(t, 2);
    await poker.connect(operator).sitOutIdle(t, 2);
    expect(Number(await poker.timeoutStreak(t, 2))).to.equal(3);
    await poker.connect(operator).kickIdle(t, 2);
    expect((await poker.getSeat(t, 2)).occupied).to.equal(false);
    expect(await poker.balance(carol.address)).to.equal(E(100)); // stack returned in full
  });

  it("a seat parked sitting-out for 10+ minutes becomes kickable; coming back clears strikes", async function () {
    const { owner, operator, alice, bob, poker } = await loadFixture(setup);
    const t = await makeTable(poker, owner);
    await buyIn(poker, alice, t, 0);
    await buyIn(poker, bob, t, 1);

    await poker.connect(bob).setSitOut(t, true);
    await expect(poker.connect(operator).kickIdle(t, 1)).to.be.revertedWithCustomError(poker, "NotIdle");
    await time.increase(601);
    await poker.connect(operator).kickIdle(t, 1);
    expect(await poker.balance(bob.address)).to.equal(E(100));

    // strikes are forgiven when the player voluntarily sits back in
    await poker.connect(operator).sitOutIdle(t, 0);
    expect(Number(await poker.timeoutStreak(t, 0))).to.equal(1);
    await poker.connect(alice).setSitOut(t, false);
    expect(Number(await poker.timeoutStreak(t, 0))).to.equal(0);
    expect((await poker.getSeat(t, 0)).sittingOut).to.equal(false);
  });

  it("cancelHandPenalized: offender forfeits committed chips to the other seats pro-rata", async function () {
    const { owner, operator, alice, bob, carol, poker } = await loadFixture(setup);
    const t = await makeTable(poker, owner);
    await buyIn(poker, alice, t, 0);
    await buyIn(poker, bob, t, 1);
    await buyIn(poker, carol, t, 2);
    await poker.connect(operator).startHand(t);
    // first hand: button seat0, SB seat1 (1), BB seat2 (2), seat0 acts first

    // nothing committed by seat0 yet → penalized cancel is not applicable
    await expect(poker.connect(operator).cancelHandPenalized(t, 0)).to.be.revertedWithCustomError(poker, "NotIdle");

    await poker.connect(alice).act(t, RAISE, E(6)); // seat0 commits 6
    await poker.connect(bob).act(t, CALL, 0); // seat1: 1 + 5 = 6
    await poker.connect(carol).act(t, FOLD, 0); // seat2 folded with 2 in

    // seat0's browser "vanishes" mid-hand → penalized cancel
    const tx = await poker.connect(operator).cancelHandPenalized(t, 0);
    await expect(tx).to.emit(poker, "HandCancelledPenalized").withArgs(t, 1, 0, E(6));

    // forfeit 6 split pro-rata over others' committed (bob 6, carol 2 → 8):
    // bob: 100−6 +6 +6·6/8 = 104.5 ; carol: 100−2 +2 +6·2/8 = 101.5 ; alice: 94
    expect(await seatStack(poker, t, 0)).to.equal(E(94));
    expect(await seatStack(poker, t, 1)).to.equal(E("104.5"));
    expect(await seatStack(poker, t, 2)).to.equal(E("101.5"));
    expect((await poker.getHand(t)).inProgress).to.equal(false);
    // offender is sat out with a strike — repeat offenders become kickable
    expect((await poker.getSeat(t, 0)).sittingOut).to.equal(true);
    expect(Number(await poker.timeoutStreak(t, 0))).to.equal(1);
    // chip conservation: 94 + 104.5 + 101.5 = 300
  });

  it("tournament blind-off: a sitting-out seat posts a dead big blind into the pot each hand", async function () {
    const { owner, operator, alice, bob, carol, factory, poker } = await loadFixture(setup);
    await poker.connect(owner).setTournamentFactory(factory.address);
    const cfg = tableCfg({ maxSeats: 3, smallBlind: 10n, bigBlind: 20n, minBuyIn: 0, maxBuyIn: 0 });
    await poker.connect(factory).createControlledTable(cfg);
    const t = Number((await poker.tableCount()) - 1n);
    await poker.connect(factory).seatPlayerWithChips(t, 0, alice.address, 100n);
    await poker.connect(factory).seatPlayerWithChips(t, 1, bob.address, 100n);
    await poker.connect(factory).seatPlayerWithChips(t, 2, carol.address, 100n);

    // carol's client is gone → operator sits her out; she still pays to play
    await poker.connect(operator).sitOutIdle(t, 2);
    await poker.connect(operator).startHand(t);
    expect(await seatStack(poker, t, 2)).to.equal(80n); // dead bb 20 gone
    expect((await poker.getSeatHand(t, 2)).committedTotal).to.equal(20n);
    expect((await poker.getHand(t)).pot).to.equal(20n); // dead money straight into the pot
    // she is NOT dealt in — the hand is heads-up between seats 0 and 1
    expect((await poker.getSeatHand(t, 2)).inHand).to.equal(false);
    expect(Number((await poker.getHand(t)).numInHand)).to.equal(2);

    // mid-hand, the controller cannot remove her seat (her chips are in the pot)
    await expect(poker.connect(factory).removeSeat(t, 2)).to.be.revertedWithCustomError(poker, "InHand");

    // fold-win sweeps the dead blind to the winner: HU btn/SB seat0 folds → seat1 wins 10+20+20
    await poker.connect(alice).act(t, FOLD, 0);
    expect(await seatStack(poker, t, 0)).to.equal(90n);
    expect(await seatStack(poker, t, 1)).to.equal(130n);
    expect(await seatStack(poker, t, 2)).to.equal(80n); // 90+130+80 = 300 conserved

    // a cancelled hand refunds the dead blind like any other contribution
    await poker.connect(operator).startHand(t);
    expect(await seatStack(poker, t, 2)).to.equal(60n);
    await poker.connect(operator).cancelHand(t);
    expect(await seatStack(poker, t, 2)).to.equal(80n);

    // between hands the controller can remove the (eventually busted) seat
    await poker.connect(factory).removeSeat(t, 2);
    expect((await poker.getSeat(t, 2)).occupied).to.equal(false);
  });

  it("resolveShowdown refuses unrevealed cards even if the dealer claims ready", async function () {
    const { owner, operator, alice, bob, poker } = await loadFixture(setup);
    const Mock = await ethers.getContractFactory("MockPokerDealer");
    const mock = await Mock.deploy();
    await poker.connect(owner).setDealer(await mock.getAddress());
    const t = await makeTable(poker, owner, tableCfg({ maxSeats: 2 }));
    await buyIn(poker, alice, t, 0);
    await buyIn(poker, bob, t, 1);
    await poker.connect(operator).startHand(t);

    // check the hand down to showdown
    await poker.connect(alice).act(t, CALL, 0);
    await poker.connect(bob).act(t, CHECK, 0);
    for (let street = 0; street < 3; street++) {
      await poker.connect(bob).act(t, CHECK, 0);
      await poker.connect(alice).act(t, CHECK, 0);
    }
    expect(Number((await poker.getHand(t)).street)).to.equal(4); // SHOWDOWN

    const dealId = 1;
    await mock.setBoard(dealId, [0, 5, 10, 15, 20]);
    await mock.setHole(dealId, 0, 255, 255); // seat0 "revealed" as unrevealed
    await mock.setHole(dealId, 1, 30, 31);
    await mock.setReady(dealId, true);
    await expect(poker.resolveShowdown(t)).to.be.revertedWithCustomError(poker, "ShowdownNotReady");

    await mock.setHole(dealId, 0, 40, 41); // real cards land → settles fine
    await poker.resolveShowdown(t);
    expect((await poker.getHand(t)).inProgress).to.equal(false);
  });
});
