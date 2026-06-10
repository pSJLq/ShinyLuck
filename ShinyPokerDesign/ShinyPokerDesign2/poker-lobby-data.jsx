/* ShinyPoker — Lobby data: cash tables, tournaments, SNGs, clubs. */

const CASH_TABLES = [
  { id: "c1", blinds: [0.5, 1], game: "NLHE", size: 6, seated: 5, avgPot: 18.4, ppf: 38, waitlist: 0, rake: 0.2, cap: 2, stake: "low" },
  { id: "c2", blinds: [1, 2], game: "NLHE", size: 6, seated: 6, avgPot: 41.2, ppf: 29, waitlist: 3, rake: 0.4, cap: 4, stake: "mid" },
  { id: "c3", blinds: [0.1, 0.2], game: "NLHE", size: 9, seated: 7, avgPot: 4.1, ppf: 47, waitlist: 0, rake: 0.05, cap: 0.5, stake: "micro" },
  { id: "c4", blinds: [2, 5], game: "NLHE", size: 6, seated: 4, avgPot: 96.0, ppf: 24, waitlist: 0, rake: 1.0, cap: 10, stake: "high" },
  { id: "c5", blinds: [1, 2], game: "PLO", size: 6, seated: 5, avgPot: 64.5, ppf: 52, waitlist: 1, rake: 0.4, cap: 4, stake: "mid" },
  { id: "c6", blinds: [0.5, 1], game: "NLHE", size: 2, seated: 2, avgPot: 22.0, ppf: 71, waitlist: 0, rake: 0.2, cap: 2, stake: "low" },
  { id: "c7", blinds: [0.25, 0.5], game: "NLHE", size: 9, seated: 3, avgPot: 9.8, ppf: 41, waitlist: 0, rake: 0.1, cap: 1, stake: "micro" },
  { id: "c8", blinds: [5, 10], game: "NLHE", size: 6, seated: 6, avgPot: 248.0, ppf: 31, waitlist: 5, rake: 2.0, cap: 20, stake: "high" },
  { id: "c9", blinds: [0.5, 1], game: "PLO", size: 9, seated: 8, avgPot: 33.5, ppf: 58, waitlist: 2, rake: 0.2, cap: 2, stake: "low" },
  { id: "c10", blinds: [1, 2], game: "NLHE", size: 2, seated: 1, avgPot: 0, ppf: 0, waitlist: 0, rake: 0.4, cap: 4, stake: "mid" },
];

/* tournaments — startIn is seconds from "now" (negative = already running) */
const TOURNAMENTS = [
  {
    id: "t1", name: "Somnia Sunday Major", startIn: 5400, buyIn: 20, fee: 1.5, gtd: 50000,
    prizePool: 50000, registered: 1842, status: "registering", bounty: false, reentry: true,
    startStack: 30000, lateReg: "15 levels", structure: "regular", rebuy: false, addon: false,
    escrow: "0x9F3a…Tourney50K",
    payouts: [[1, 22, 9250], [2, 14, 6800], [3, 9.5, 5400], ["4-6", 6, 3100], ["7-12", 3.5, 1800], ["13-27", 2, 1050]],
    blinds: [["1", "100/200", "—", 12], ["2", "150/300", "—", 12], ["3", "200/400", "50", 12], ["4", "300/600", "75", 12], ["5", "400/800", "100", 12], ["BREAK", "", "", 5], ["6", "500/1000", "125", 12]],
    curLevel: 0,
  },
  {
    id: "t2", name: "Hyper Turbo Bounty KO", startIn: 320, buyIn: 10, fee: 0.8, gtd: 8000,
    prizePool: 11400, registered: 624, status: "latereg", bounty: true, reentry: true,
    startStack: 12000, lateReg: "6 levels", structure: "turbo", rebuy: false, addon: false,
    koBounty: 5, escrow: "0x4c1e…KObounty",
    payouts: [[1, 18, 1240], [2, 12, 880], [3, 8.5, 620], ["4-6", 5.5, 410], ["7-12", 3, 260]],
    blinds: [["1", "75/150", "—", 6], ["2", "100/200", "25", 6], ["3", "150/300", "40", 6], ["4", "200/400", "50", 6], ["5", "300/600", "75", 6], ["6", "400/800", "100", 6]],
    curLevel: 4,
  },
  {
    id: "t3", name: "Daily Deepstack 5K GTD", startIn: -1800, buyIn: 15, fee: 1.2, gtd: 5000,
    prizePool: 6300, registered: 478, status: "running", bounty: false, reentry: false,
    startStack: 50000, lateReg: "closed", structure: "deepstack", rebuy: false, addon: true,
    escrow: "0xA77b…Deep5K", playersLeft: 213,
    payouts: [[1, 20, 1260], [2, 13, 820], [3, 9, 570], ["4-6", 6, 380], ["7-12", 3.5, 220]],
    blinds: [["8", "600/1200", "150", 15], ["9", "800/1600", "200", 15], ["10", "1000/2000", "250", 15], ["11", "1500/3000", "400", 15]],
    curLevel: 9,
  },
  {
    id: "t4", name: "Micro Mania 1K GTD", startIn: 9000, buyIn: 2, fee: 0.2, gtd: 1000,
    prizePool: 1000, registered: 312, status: "registering", bounty: false, reentry: true,
    startStack: 20000, lateReg: "20 levels", structure: "regular", rebuy: true, addon: true,
    escrow: "0x12dd…Micro1K",
    payouts: [[1, 19, 190], [2, 13, 130], [3, 9, 90], ["4-8", 5.5, 55], ["9-18", 3, 30]],
    blinds: [["1", "50/100", "—", 10], ["2", "75/150", "—", 10], ["3", "100/200", "25", 10]],
    curLevel: 0,
  },
  {
    id: "t5", name: "Whale Room High Roller", startIn: 18000, buyIn: 500, fee: 25, gtd: 200000,
    prizePool: 142500, registered: 198, status: "registering", bounty: false, reentry: false,
    startStack: 100000, lateReg: "10 levels", structure: "slow", rebuy: false, addon: false,
    escrow: "0xE9aa…HighRoll",
    payouts: [[1, 28, 56000], [2, 18, 36000], [3, 12, 24000], ["4-5", 8, 16000], ["6-9", 5, 10000]],
    blinds: [["1", "200/400", "—", 20], ["2", "300/600", "75", 20], ["3", "400/800", "100", 20]],
    curLevel: 0,
  },
  {
    id: "t6", name: "Freezeout Friday 3K", startIn: -7200, buyIn: 12, fee: 1, gtd: 3000,
    prizePool: 3000, registered: 289, status: "finished", bounty: false, reentry: false,
    startStack: 25000, lateReg: "closed", structure: "regular", rebuy: false, addon: false,
    escrow: "0x55cc…Freeze3K", winner: "nakamoto.somi",
    payouts: [[1, 22, 660], [2, 14, 420], [3, 9.5, 285]],
    blinds: [["—", "Finished", "", 0]],
    curLevel: 0,
  },
];

const SNGS = [
  { id: "s1", name: "6-Max Hyper", buyIn: 5, fee: 0.4, seats: 6, seated: 4, prize: 30, structure: "hyper" },
  { id: "s2", name: "Heads-Up Turbo", buyIn: 10, fee: 0.6, seats: 2, seated: 1, prize: 20, structure: "turbo" },
  { id: "s3", name: "9-Max Standard", buyIn: 3, fee: 0.25, seats: 9, seated: 6, prize: 27, structure: "regular" },
  { id: "s4", name: "Bounty 6-Max KO", buyIn: 8, fee: 0.5, seats: 6, seated: 3, prize: 48, structure: "ko" },
];

/* Spin SNG multipliers (probability weighted display) */
const SPIN_MULTIS = [
  { x: 2, prize: 12, hot: false },
  { x: 3, prize: 18, hot: false },
  { x: 5, prize: 30, hot: false },
  { x: 10, prize: 60, hot: false },
  { x: 25, prize: 150, hot: true },
  { x: 120, prize: 720, hot: true },
  { x: 1000, prize: 6000, hot: true },
];

const CLUBS = [
  { id: "cl1", name: "Degen Syndicate", tag: "DS", members: 248, tables: 3, role: "Owner", color: "#6E6EED" },
  { id: "cl2", name: "Somnia Whales", tag: "SW", members: 64, tables: 1, role: "Member", color: "#E5B43C" },
  { id: "cl3", name: "ZK Grinders", tag: "ZK", members: 512, tables: 5, role: "Admin", color: "#2BD480" },
];

const LIVE_STATS = { online: 12480, tables: 342, biggestPot: 2840, nextTourneyIn: 320 };

Object.assign(window, { CASH_TABLES, TOURNAMENTS, SNGS, SPIN_MULTIS, CLUBS, LIVE_STATS });
