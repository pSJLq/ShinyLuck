const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const ALLIN = 5;
const E = (n) => ethers.parseEther(String(n));
const R = { "2": 0, "3": 1, "4": 2, "5": 3, "6": 4, "7": 5, "8": 6, "9": 7, T: 8, J: 9, Q: 10, K: 11, A: 12 };
const S = { c: 0, d: 1, h: 2, s: 3 };
const card = (str) => R[str[0]] * 4 + S[str[1]];

// Build a TournamentParams struct with sensible defaults; override per test.
const tp = (over = {}) => ({
  buyIn: 0,
  fee: 0,
  maxPlayers: 2,
  seatsPerTable: 0,
  startStack: 1000,
  sbStart: 10,
  bbStart: 20,
  anteStart: 0,
  levelDur: 60,
  growthBps: 20000, // ×2 per level
  startTime: 0,
  approvalRequired: false,
  actionSecs: 0,
  payoutBps: [10000],
  structure: [],
  hostBps: 0,
  ...over,
});

describe("PokerTournament — buy-in + sponsored pool, custom split", function () {
  async function setup() {
    const [owner, operator, alice, bob, carol] = await ethers.getSigners();
    const Room = await ethers.getContractFactory("PokerRoom");
    const room = await Room.deploy(owner.address);
    await room.waitForDeployment();
    const Dealer = await ethers.getContractFactory("MockPokerDealer");
    const dealer = await Dealer.deploy();
    await dealer.waitForDeployment();
    const Trn = await ethers.getContractFactory("PokerTournament");
    const trn = await Trn.deploy(owner.address, await room.getAddress());
    await trn.waitForDeployment();

    await room.connect(owner).setDealer(await dealer.getAddress());
    await room.connect(owner).setDealerOperator(operator.address);
    await room.connect(owner).setTournamentFactory(await trn.getAddress());
    await trn.connect(owner).setOperator(operator.address);
    return { owner, operator, alice, bob, carol, room, dealer, trn };
  }

  it("runs a heads-up SNG end-to-end and pays the winner from the pool", async function () {
    const { operator, alice, bob, carol, room, dealer, trn } = await loadFixture(setup);

    // carol creates a tournament and SPONSORS 100 (one person funds part of the pool);
    // players also buy in 10 (+1 fee). Winner-take-all split.
    await trn.connect(carol).createTournament(tp({ buyIn: E(10), fee: E(1), payoutBps: [10000] }), { value: E(100) });
    const id = 0;
    await trn.connect(alice).register(id, { value: E(11) });
    await trn.connect(bob).register(id, { value: E(11) });

    let info = await trn.info(id);
    expect(info.pool).to.equal(E(110)); // 90% of 100 sponsored (10% fee) + 10 + 10 buy-ins
    expect(await trn.feeCollected()).to.equal(E(12)); // 10 sponsor fee + 2 buy-in fees
    expect(info.registered).to.equal(2);

    // start → controlled table created, both seated with 1000 chips
    await trn.connect(operator).start(id);
    const t = Number((await trn.info(id)).tableId);
    expect((await room.getSeat(t, 0)).stack).to.equal(1000n);
    expect((await room.getSeat(t, 1)).stack).to.equal(1000n);
    expect(await room.tableController(t)).to.equal(await trn.getAddress());
    // cash actions are blocked on a tournament table
    await expect(room.connect(carol).sitDown(t, 0, E(1))).to.be.revertedWithCustomError(room, "ControlledTable");

    // play one all-in hand; alice (AA) beats bob → bob busts
    await room.connect(operator).startHand(t);
    await room.connect(alice).act(t, ALLIN, 0); // seat0 = button/SB acts first HU
    await room.connect(bob).act(t, ALLIN, 0);
    const dealId = (await room.getHand(t)).dealId;
    await dealer.setBoard(dealId, ["2c", "7d", "9h", "Js", "Ks"].map(card));
    await dealer.setHole(dealId, 0, card("Ac"), card("Ad")); // alice: pair of aces
    await dealer.setHole(dealId, 1, card("3d"), card("4h")); // bob: high card
    await dealer.setReady(dealId, true);
    await room.resolveShowdown(t);

    expect((await room.getSeat(t, 1)).stack).to.equal(0n); // bob busted
    expect((await room.getSeat(t, 0)).stack).to.equal(2000n); // alice has all chips

    // report bob's bust → he's 2nd (no payout), alice wins the whole pool
    const tx = await trn.connect(operator).reportBust(id, 0, 1);
    await expect(tx).to.emit(trn, "Finished").withArgs(id, alice.address, E(110));
    expect(await room.balance(alice.address)).to.equal(E(110)); // prize credited to in-room balance
    expect((await trn.info(id)).status).to.equal(2); // FINISHED
    // the WINNER's seat is freed too — no ghost seat on the dead table that
    // "already playing elsewhere" checks would trip over forever
    expect((await room.getSeat(t, 0)).occupied).to.equal(false);
    expect(Number(await room.seatOf(t, alice.address))).to.equal(255);
  });

  it("host reward: creator's hostBps cut is paid at the finish, prizes come from the net pool", async function () {
    const { operator, alice, bob, carol, room, dealer, trn } = await loadFixture(setup);
    // carol hosts a 10+1 buy-in SNG with a 5% host reward
    await trn.connect(carol).createTournament(tp({ buyIn: E(10), fee: E(1), hostBps: 500 }));
    const id = 0;
    await trn.connect(alice).register(id, { value: E(11) });
    await trn.connect(bob).register(id, { value: E(11) });
    expect(await trn.hostBpsOf(id)).to.equal(500);
    expect((await trn.info(id)).pool).to.equal(E(20));

    await trn.connect(operator).start(id);
    const t = Number((await trn.info(id)).tableId);
    await room.connect(operator).startHand(t);
    await room.connect(alice).act(t, ALLIN, 0);
    await room.connect(bob).act(t, ALLIN, 0);
    const dealId = (await room.getHand(t)).dealId;
    await dealer.setBoard(dealId, ["2c", "7d", "9h", "Js", "Ks"].map(card));
    await dealer.setHole(dealId, 0, card("Ac"), card("Ad"));
    await dealer.setHole(dealId, 1, card("3d"), card("4h"));
    await dealer.setReady(dealId, true);
    await room.resolveShowdown(t);

    // pool 20 → host 5% = 1, winner gets 100% of the net 19
    const tx = await trn.connect(operator).reportBust(id, 0, 1);
    await expect(tx).to.emit(trn, "HostPaid").withArgs(id, carol.address, E(1));
    await expect(tx).to.emit(trn, "Finished").withArgs(id, alice.address, E(19));
    expect(await room.balance(alice.address)).to.equal(E(19));
    expect(await room.balance(carol.address)).to.equal(E(1));
    // nothing left stranded in the tournament contract beyond collected fees
    expect(await ethers.provider.getBalance(await trn.getAddress())).to.equal(E(2)); // 2 × 1 fee
  });

  it("host reward: rejected above 10% and on free (sponsored) events", async function () {
    const { carol, trn } = await loadFixture(setup);
    await expect(trn.connect(carol).createTournament(tp({ buyIn: E(1), hostBps: 1001 })))
      .to.be.revertedWithCustomError(trn, "BadParams");
    // buyIn == 0 (sponsored/free entry) → host reward is meaningless, reject
    await expect(trn.connect(carol).createTournament(tp({ buyIn: 0, hostBps: 500 }), { value: E(10) }))
      .to.be.revertedWithCustomError(trn, "BadParams");
    // and plain hostBps: 0 sponsored still works
    await trn.connect(carol).createTournament(tp({ buyIn: 0, hostBps: 0 }), { value: E(10) });
  });

  it("splits the pool per the creator's payout structure (rejects bad splits)", async function () {
    const { carol, trn } = await loadFixture(setup);
    // split must sum to 10000
    await expect(trn.connect(carol).createTournament(tp({ buyIn: E(1), maxPlayers: 3, payoutBps: [6000, 3000] }))).to.be.revertedWithCustomError(trn, "BadParams");
    // valid 65/35 split
    await trn.connect(carol).createTournament(tp({ buyIn: E(1), maxPlayers: 3, payoutBps: [6500, 3500] }));
    const info = await trn.info(0);
    expect(info.payoutBps.map(Number)).to.deep.equal([6500, 3500]);
  });

  it("refunds buy-in + sponsor on cancel", async function () {
    const { alice, carol, trn } = await loadFixture(setup);
    await trn.connect(carol).createTournament(tp({ buyIn: E(5), fee: E(0.5), maxPlayers: 4, payoutBps: [10000] }), { value: E(50) });
    await trn.connect(alice).register(0, { value: E(5.5) });
    const aliceBefore = await ethers.provider.getBalance(alice.address);
    await trn.connect(carol).cancel(0);
    // alice refunded buy-in + fee
    expect((await ethers.provider.getBalance(alice.address)) - aliceBefore).to.equal(E(5.5));
    expect((await trn.info(0)).status).to.equal(3); // CANCELLED
  });

  it("free fully-sponsored event: buyIn 0, creator funds the prize, 10% platform fee", async function () {
    const { alice, bob, carol, trn } = await loadFixture(setup);
    await trn.connect(carol).createTournament(tp({ buyIn: 0, fee: 0, payoutBps: [10000] }), { value: E(40) });
    await trn.connect(alice).register(0, { value: 0 }); // free entry
    await trn.connect(bob).register(0, { value: 0 });
    const info = await trn.info(0);
    expect(info.pool).to.equal(E(36)); // 90% of the sponsorship — the flat 10% fee applies
    expect(await trn.feeCollected()).to.equal(E(4)); // 10% platform fee
    expect(info.registered).to.equal(2);
  });

  it("sponsored cancel: creator gets the FULL sponsorship back and the fee is reversed", async function () {
    const { owner, carol, trn } = await loadFixture(setup);
    await trn.connect(carol).createTournament(tp({ buyIn: 0, fee: 0, payoutBps: [10000] }), { value: E(40) });
    expect(await trn.feeCollected()).to.equal(E(4));
    const before = await ethers.provider.getBalance(carol.address);
    await trn.connect(owner).cancel(0); // owner cancels → no gas cost to carol
    expect((await ethers.provider.getBalance(carol.address)) - before).to.equal(E(40)); // full gross refund
    expect(await trn.feeCollected()).to.equal(0); // fee reversed — nothing earned on an event that never ran
  });

  it("scheduled start: operator must wait for startTime; can start after", async function () {
    const { operator, alice, bob, carol, trn } = await loadFixture(setup);
    const startTime = (await time.latest()) + 1000;
    await trn.connect(carol).createTournament(tp({ buyIn: E(1), fee: 0, startTime, payoutBps: [10000] }));
    await trn.connect(alice).register(0, { value: E(1) });
    await trn.connect(bob).register(0, { value: E(1) });

    await expect(trn.connect(operator).start(0)).to.be.revertedWithCustomError(trn, "NotDue");
    await time.increaseTo(startTime + 1);
    await trn.connect(operator).start(0);
    expect((await trn.info(0)).status).to.equal(1); // RUNNING
  });

  it("scheduled start: creator may start early (override)", async function () {
    const { alice, bob, carol, trn } = await loadFixture(setup);
    const startTime = (await time.latest()) + 1000;
    await trn.connect(carol).createTournament(tp({ buyIn: E(1), fee: 0, startTime, payoutBps: [10000] }));
    await trn.connect(alice).register(0, { value: E(1) });
    await trn.connect(bob).register(0, { value: E(1) });
    await trn.connect(carol).start(0); // before startTime — creator override
    expect((await trn.info(0)).status).to.equal(1); // RUNNING
  });

  it("antes: table is opened with the ante and it grows each level", async function () {
    const { operator, alice, bob, carol, room, trn } = await loadFixture(setup);
    await trn.connect(carol).createTournament(tp({ buyIn: E(1), fee: 0, anteStart: 5, growthBps: 20000, levelDur: 60, payoutBps: [10000] }));
    await trn.connect(alice).register(0, { value: E(1) });
    await trn.connect(bob).register(0, { value: E(1) });
    await trn.connect(operator).start(0);
    const t = Number((await trn.info(0)).tableId);

    let cfg = await room.getTable(t);
    expect(cfg.ante).to.equal(5n);
    expect(cfg.smallBlind).to.equal(10n);
    expect(cfg.bigBlind).to.equal(20n);

    // advance a level; blinds and ante double
    await time.increase(60);
    await trn.connect(operator).levelUp(0);
    cfg = await room.getTable(t);
    expect(cfg.ante).to.equal(10n);
    expect(cfg.smallBlind).to.equal(20n);
    expect(cfg.bigBlind).to.equal(40n);
  });

  it("anteStart above the big blind is rejected", async function () {
    const { carol, trn } = await loadFixture(setup);
    await expect(trn.connect(carol).createTournament(tp({ anteStart: 21, bbStart: 20 }))).to.be.revertedWithCustomError(trn, "BadParams");
  });

  it("approval flow: applicants wait, creator approves or rejects (refund)", async function () {
    const { alice, bob, carol, trn } = await loadFixture(setup);
    // carol creates a private (approval-required) event
    await trn.connect(carol).createTournament(tp({ buyIn: E(10), fee: E(1), maxPlayers: 3, approvalRequired: true, payoutBps: [10000] }));

    // alice applies → escrowed, pending, NOT yet registered
    await expect(trn.connect(alice).register(0, { value: E(11) })).to.emit(trn, "Applied").withArgs(0, alice.address);
    expect(await trn.isPending(0, alice.address)).to.equal(true);
    expect(await trn.isRegistered(0, alice.address)).to.equal(false);
    expect((await trn.info(0)).pendingCount).to.equal(1);
    expect((await trn.info(0)).registered).to.equal(0);

    // creator approves alice → registered, pool + buyIn, fee taken
    await trn.connect(carol).approveEntry(0, alice.address);
    expect(await trn.isRegistered(0, alice.address)).to.equal(true);
    expect((await trn.info(0)).pool).to.equal(E(10));
    expect(await trn.feeCollected()).to.equal(E(1));

    // bob applies, creator rejects → full refund
    await trn.connect(bob).register(0, { value: E(11) });
    const bobBefore = await ethers.provider.getBalance(bob.address);
    await expect(trn.connect(carol).rejectEntry(0, bob.address)).to.emit(trn, "ApplicationRejected").withArgs(0, bob.address);
    expect((await ethers.provider.getBalance(bob.address)) - bobBefore).to.equal(E(11)); // bob paid no gas (carol called)
    expect(await trn.isPending(0, bob.address)).to.equal(false);
  });

  it("approval flow: applicant can withdraw their own pending entry", async function () {
    const { alice, carol, trn } = await loadFixture(setup);
    await trn.connect(carol).createTournament(tp({ buyIn: E(2), fee: 0, approvalRequired: true, payoutBps: [10000] }));
    await trn.connect(alice).register(0, { value: E(2) });
    expect(await trn.isPending(0, alice.address)).to.equal(true);
    await expect(trn.connect(alice).withdrawApplication(0)).to.emit(trn, "ApplicationWithdrawn").withArgs(0, alice.address);
    expect(await trn.isPending(0, alice.address)).to.equal(false);
  });

  it("MTT: a bigger field spans several tables (round-robin seating)", async function () {
    const { operator, room, trn } = await loadFixture(setup);
    const s = await ethers.getSigners();
    const players = s.slice(2, 6); // 4 players
    await trn.connect(s[2]).createTournament(tp({ buyIn: E(1), maxPlayers: 4, seatsPerTable: 2, payoutBps: [10000] }));
    for (const p of players) await trn.connect(p).register(0, { value: E(1) });
    await trn.connect(operator).start(0);

    const tables = await trn.tablesOf(0);
    expect(tables.length).to.equal(2); // ceil(4 / 2)
    for (const tid of tables) {
      expect((await room.getSeat(tid, 0)).stack).to.equal(1000n);
      expect((await room.getSeat(tid, 1)).stack).to.equal(1000n);
    }
    expect((await trn.info(0)).remaining).to.equal(4);
  });

  it("MTT: movePlayer relocates a player (with their stack) to another table", async function () {
    const { operator, room, trn } = await loadFixture(setup);
    const s = await ethers.getSigners();
    const players = s.slice(2, 6); // 4 players, 3 seats/table → 2 tables with a free seat each
    await trn.connect(s[2]).createTournament(tp({ buyIn: E(1), maxPlayers: 4, seatsPerTable: 3, payoutBps: [10000] }));
    for (const p of players) await trn.connect(p).register(0, { value: E(1) });
    await trn.connect(operator).start(0);
    const tables = await trn.tablesOf(0);
    expect(tables.length).to.equal(2); // ceil(4 / 3)

    const mover = (await room.getSeat(tables[1], 0)).player;
    await expect(trn.connect(operator).movePlayer(0, 1, 0, 0, 2)).to.emit(trn, "PlayerMoved");
    expect((await room.getSeat(tables[0], 2)).player).to.equal(mover);
    expect((await room.getSeat(tables[0], 2)).stack).to.equal(1000n);
    expect((await room.getSeat(tables[1], 0)).player).to.equal(ethers.ZeroAddress);
    // moving onto an occupied seat is rejected
    await expect(trn.connect(operator).movePlayer(0, 0, 0, 0, 2)).to.be.revertedWithCustomError(trn, "BadParams");
  });

  it("custom blind structure: levels follow the schedule (not geometric) + action clock", async function () {
    const { operator, alice, bob, room, trn } = await loadFixture(setup);
    const structure = [
      { sb: 10, bb: 20, ante: 0, durationSecs: 60 },
      { sb: 50, bb: 100, ante: 10, durationSecs: 60 },
      { sb: 200, bb: 400, ante: 40, durationSecs: 60 },
    ];
    await trn.connect(alice).createTournament(tp({ buyIn: E(1), actionSecs: 15, structure }));
    await trn.connect(alice).register(0, { value: E(1) });
    await trn.connect(bob).register(0, { value: E(1) });
    await trn.connect(operator).start(0);
    const t = Number((await trn.info(0)).tableId);

    let cfg = await room.getTable(t);
    expect(cfg.smallBlind).to.equal(10n);
    expect(cfg.bigBlind).to.equal(20n);
    expect(cfg.actionTimeout).to.equal(15n); // custom per-action clock
    expect(await trn.dueForLevelUp(0)).to.equal(false);

    await time.increase(61);
    expect(await trn.dueForLevelUp(0)).to.equal(true);
    await trn.connect(operator).levelUp(0);
    cfg = await room.getTable(t);
    expect(cfg.smallBlind).to.equal(50n); // exact schedule value, not ×growth
    expect(cfg.bigBlind).to.equal(100n);
    expect(cfg.ante).to.equal(10n);

    const s = await trn.structureOf(0);
    expect(s.length).to.equal(3);
    expect(s[2].bb).to.equal(400n);

    // reach the last scheduled level…
    await time.increase(61);
    await trn.connect(operator).levelUp(0);
    cfg = await room.getTable(t);
    expect(cfg.bigBlind).to.equal(400n);

    // …and past it: blinds KEEP escalating (×growthBps overtime) so an
    // abandoned heads-up can't blind-oscillate forever.
    await time.increase(61);
    expect(await trn.dueForLevelUp(0)).to.equal(true);
    await trn.connect(operator).levelUp(0);
    cfg = await room.getTable(t);
    expect(cfg.smallBlind).to.equal(400n); // 200 ×2 (growthBps 20000)
    expect(cfg.bigBlind).to.equal(800n);
    expect(cfg.ante).to.equal(80n);
  });

  it("custom structure rejects a malformed level (sb > bb)", async function () {
    const { alice, trn } = await loadFixture(setup);
    const bad = [{ sb: 100, bb: 20, ante: 0, durationSecs: 60 }];
    await expect(trn.connect(alice).createTournament(tp({ buyIn: E(1), structure: bad }))).to.be.revertedWithCustomError(trn, "BadParams");
  });

  it("idle forfeit: an abandoned (sat-out) stack can no longer freeze the event — and sitting back in cancels the countdown", async function () {
    const { operator, alice, bob, carol, room, trn } = await loadFixture(setup);
    await trn.connect(carol).createTournament(tp({ buyIn: E(10), maxPlayers: 3, payoutBps: [10000] }));
    for (const pl of [alice, bob, carol]) await trn.connect(pl).register(0, { value: E(10) });
    await trn.connect(operator).start(0);
    const t = Number((await trn.info(0)).tableId);
    const seatOf = async (pl) => Number(await room.seatOf(t, pl.address));

    // bob's tab dies → the zk strike path sits him out (operator = dealer op)
    await room.connect(operator).sitOutIdle(t, await seatOf(bob));
    // too early — the reconnect window is his
    await expect(trn.connect(operator).forfeitIdle(0, 0, await seatOf(bob)))
      .to.be.revertedWithCustomError(trn, "NotIdleLongEnough");

    // alice also gets struck, but SITS BACK IN — her countdown is cancelled
    await room.connect(operator).sitOutIdle(t, await seatOf(alice));
    await time.increase(200);
    await room.connect(alice).setSitOut(t, false);
    await time.increase(200); // bob is now 400s idle, alice only "in"
    await expect(trn.connect(operator).forfeitIdle(0, 0, await seatOf(alice)))
      .to.be.revertedWithCustomError(trn, "NotIdleLongEnough");

    // bob's window elapsed → forfeited at his CURRENT place (3rd of 3)
    await expect(trn.connect(operator).forfeitIdle(0, 0, await seatOf(bob)))
      .to.emit(trn, "ForfeitedIdle").withArgs(0, bob.address, 3);
    expect(Number((await trn.info(0)).remaining)).to.equal(2);
    // same seat can't be forfeited twice
    await expect(trn.connect(operator).forfeitIdle(0, 0, 1)).to.be.revertedWithCustomError(trn, "NotBusted");

    // carol abandons too → her forfeit ENDS the event, alice takes the pool
    await room.connect(operator).sitOutIdle(t, await seatOf(carol));
    await time.increase(301);
    const tx = trn.connect(operator).forfeitIdle(0, 0, await seatOf(carol));
    await expect(tx).to.emit(trn, "Finished").withArgs(0, alice.address, E(30));
    expect(await room.balance(alice.address)).to.equal(E(30));
    expect((await trn.info(0)).status).to.equal(2); // FINISHED — no eternal stall
  });

  it("idle forfeit: owner tunes the window, hair-trigger values are rejected", async function () {
    const { owner, trn } = await loadFixture(setup);
    await expect(trn.connect(owner).setIdleForfeitSecs(30)).to.be.revertedWithCustomError(trn, "BadParams");
    await trn.connect(owner).setIdleForfeitSecs(120);
    expect(Number(await trn.idleForfeitSecs())).to.equal(120);
  });

  it("blind cap: geometric escalation saturates at 2× the chips in play and dueForLevelUp goes quiet", async function () {
    const { operator, alice, bob, room, trn } = await loadFixture(setup);
    // 2 players × 1000 chips → cap = 4000; ×2 growth from 10/20
    await trn.connect(alice).createTournament(tp({ buyIn: E(1) }));
    await trn.connect(alice).register(0, { value: E(1) });
    await trn.connect(bob).register(0, { value: E(1) });
    await trn.connect(operator).start(0);
    const t = Number((await trn.info(0)).tableId);

    for (let i = 0; i < 30; i++) {
      if (!(await trn.dueForLevelUp(0))) {
        const cfg = await room.getTable(t);
        if (cfg.bigBlind >= 4000n) break; // capped — the driver stops being told to level
        await time.increase(61);
        continue;
      }
      await trn.connect(operator).levelUp(0);
    }
    const cfg = await room.getTable(t);
    expect(cfg.bigBlind).to.equal(4000n);      // saturated exactly at the cap
    expect(cfg.smallBlind).to.be.lte(4000n);   // never above bb, no overflow
    await time.increase(3600);
    expect(await trn.dueForLevelUp(0)).to.equal(false); // stays quiet forever
  });
});
