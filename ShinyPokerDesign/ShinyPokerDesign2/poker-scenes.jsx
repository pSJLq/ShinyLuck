/* ShinyPoker — scene data. One base table; states reconfigure it. */

// 6-max seat ring positions (% of felt area). index 0 = hero, bottom-center.
const SEAT_POS_6 = [
  { x: 50, y: 83 },  // 0 hero
  { x: 15, y: 65 },  // 1
  { x: 15, y: 27 },  // 2
  { x: 50, y: 12 },  // 3
  { x: 85, y: 27 },  // 4
  { x: 85, y: 65 },  // 5
];

const PLAYERS = [
  { id: 0, name: "you.somi", short: "YOU", av: "Y", hero: true },
  { id: 1, name: "nakamoto.somi", short: "0xNa", av: "N" },
  { id: 2, name: "0x7f3a…b21d", short: "0x7f", av: "7" },
  { id: 3, name: "degenqueen.somi", short: "0xDe", av: "D" },
  { id: 4, name: "0x9c4e…01af", short: "0x9c", av: "9" },
  { id: 5, name: "blockwizard.somi", short: "0xBw", av: "B" },
];

const COMMIT = "0x8af3…d21c · h#4821";

// chat / dealer feed
const CHAT = [
  { who: "dealer", dealer: true, t: "Hand #4821 — blinds 0.5 / 1 SOMI" },
  { who: "dealer", dealer: true, t: "degenqueen.somi posts big blind 1.0" },
  { who: "nakamoto", t: "gl all" },
  { who: "dealer", dealer: true, t: "Dealing hole cards — zkShuffle verified ✓" },
  { who: "blockwizard", t: "nh" },
  { who: "you", t: "ty" },
];

// hand history (current hand log)
const HISTORY = [
  { st: "Pre", act: <span><b className="you">YOU</b> raise to <b>3.0</b></span> },
  { st: "Pre", act: <span>degenqueen <b>call 3.0</b></span> },
  { st: "Pre", act: <span>nakamoto <b>fold</b></span> },
  { st: "Flop", act: <span className="dim">K♥ 7♦ 2♣ · pot 8.5</span> },
  { st: "Flop", act: <span>degenqueen <b>check</b></span> },
  { st: "Flop", act: <span><b className="you">YOU</b> bet <b>4.0</b></span> },
  { st: "Flop", act: <span>degenqueen <b>call 4.0</b></span> },
  { st: "Turn", act: <span className="dim">T♠ · pot 16.5</span> },
  { st: "Turn", act: <span>degenqueen <b>bet 3.0</b></span> },
];

/* ---- per-state scene config ----
   Each returns: { seats, board(s), pot, sidePots, heroHole, action, banner, ... } */

const SCENES = {
  yourturn: {
    label: "Your turn",
    hand: "4821",
    pot: 19.5, sidePots: [],
    board: ["Kh", "7d", "2c", "Ts"],   // turn
    heroHole: ["As", "Ks"],
    activeSeat: 0,
    dealer: 5, sb: 0, bb: 1,
    seats: {
      0: { stack: 142.0, status: "to act", bet: 0 },
      1: { stack: 88.5, status: "folded", folded: true },
      2: { stack: 210.0, status: "folded", folded: true },
      3: { stack: 96.0, status: "bet 3.0", bet: 3.0, name: "degenqueen.somi" },
      4: { stack: 54.5, status: "folded", folded: true },
      5: { stack: 305.0, status: "folded", folded: true },
    },
    action: {
      toCall: 3.0, minRaise: 6.0, potForBet: 19.5, heroStack: 142.0,
      best: "Pair of Kings · A kicker", outs: 8, potOdds: "13%", vpip: "24/19",
    },
  },

  allin: {
    label: "All-in · run it twice",
    hand: "4821",
    pot: 191.0, sidePots: [{ label: "Side", v: 12.0 }],
    board: ["Kh", "7d", "2c"],   // flop (decision)
    boardTwice1: ["Kh", "7d", "2c", "Ts", "3d"],
    boardTwice2: ["Kh", "7d", "2c", "9c", "Qh"],
    heroHole: ["As", "Ks"],
    villainShow: { seat: 3, cards: ["Qd", "Qc"] },
    equity: { hero: 46, villain: 54 },
    activeSeat: -1,
    dealer: 5, sb: 0, bb: 3,
    seats: {
      0: { stack: 0, status: "all-in", allin: true, bet: 95.5 },
      1: { stack: 88.5, status: "folded", folded: true },
      2: { stack: 210.0, status: "folded", folded: true },
      3: { stack: 0, status: "all-in", allin: true, bet: 95.5, name: "degenqueen.somi", show: true },
      4: { stack: 54.5, status: "folded", folded: true },
      5: { stack: 305.0, status: "folded", folded: true },
    },
  },

  win: {
    label: "Showdown · you win",
    hand: "4820",
    pot: 49.0, sidePots: [],
    board: ["Kd", "Th", "Ts", "4c", "2d"],
    heroHole: ["Ks", "Kc"],
    winnerSeat: 0,
    handName: "Full House · Kings full of Tens",
    wonAmount: 49.0,
    activeSeat: -1,
    dealer: 5, sb: 0, bb: 1,
    seats: {
      0: { stack: 142.0, status: "winner", winner: true, bet: 0 },
      1: { stack: 88.5, status: "folded", folded: true },
      2: { stack: 210.0, status: "folded", folded: true },
      3: { stack: 71.0, status: "mucked", folded: true, name: "degenqueen.somi" },
      4: { stack: 54.5, status: "folded", folded: true },
      5: { stack: 305.0, status: "folded", folded: true },
    },
  },

  lose: {
    label: "Showdown · you lose",
    hand: "4819",
    pot: 88.0, sidePots: [],
    board: ["9d", "9c", "4s", "4d", "Jh"],
    heroHole: ["As", "Ks"],
    winnerSeat: 3,
    villainShow: { seat: 3, cards: ["Jc", "Js"] },
    handName: "Jacks full of Nines",
    loseHand: "Two Pair · Nines & Fours",
    activeSeat: -1,
    dealer: 1, sb: 3, bb: 4,
    seats: {
      0: { stack: 54.0, status: "two pair", showdown: true, bet: 0 },
      1: { stack: 88.5, status: "folded", folded: true },
      2: { stack: 210.0, status: "folded", folded: true },
      3: { stack: 159.0, status: "winner", winner: true, name: "degenqueen.somi", show: true },
      4: { stack: 54.5, status: "folded", folded: true },
      5: { stack: 305.0, status: "folded", folded: true },
    },
  },

  disconnected: {
    label: "Disconnected · reconnecting",
    hand: "4821",
    pot: 19.5, sidePots: [],
    board: ["Kh", "7d", "2c", "Ts"],
    heroHole: ["As", "Ks"],
    activeSeat: 0,
    disconnected: true,
    dealer: 5, sb: 0, bb: 1,
    seats: {
      0: { stack: 142.0, status: "reconnecting", disc: true, bet: 0 },
      1: { stack: 88.5, status: "folded", folded: true },
      2: { stack: 210.0, status: "folded", folded: true },
      3: { stack: 96.0, status: "waiting", bet: 3.0, name: "degenqueen.somi" },
      4: { stack: 54.5, status: "folded", folded: true },
      5: { stack: 305.0, status: "folded", folded: true },
    },
  },
};

const STATE_ORDER = ["yourturn", "allin", "win", "lose", "disconnected"];

Object.assign(window, { SEAT_POS_6, PLAYERS, SCENES, STATE_ORDER, CHAT, HISTORY, COMMIT });
