// Demo bot — keeps the Live Feed alive during demo runs by placing tiny
// random bets with a roster of pre-funded testnet wallets.
//
// IMPORTANT: never run against mainnet. The bot is a demo aid only.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://dream-rpc.somnia.network";
const CASINO_ADDRESS = process.env.CASINO_ADDRESS;
if (!CASINO_ADDRESS) { console.error("CASINO_ADDRESS missing"); process.exit(1); }
if (!process.env.WALLET_KEYS) { console.error("WALLET_KEYS missing"); process.exit(1); }

const KEYS = process.env.WALLET_KEYS.split(",").map((k) => k.trim()).filter(Boolean);
const MIN_INTERVAL = parseInt(process.env.MIN_INTERVAL, 10) || 30;
const MAX_INTERVAL = parseInt(process.env.MAX_INTERVAL, 10) || 60;
const MIN_STAKE = parseFloat(process.env.MIN_STAKE) || 0.01;
const MAX_STAKE = parseFloat(process.env.MAX_STAKE) || 0.1;

const ABI_PATH = path.join(__dirname, "..", "artifacts", "contracts", "Casino.sol", "Casino.json");
const ABI = JSON.parse(fs.readFileSync(ABI_PATH, "utf8")).abi;

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallets = KEYS.map((k) => new ethers.Wallet(k, provider));
console.log(`[demo-bot] roster: ${wallets.length} wallets`);

const GAMES = ["dice", "crash", "slots", "plinko", "roulette"];

function rng() { return ethers.hexlify(ethers.randomBytes(32)); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randFloat(min, max) { return Math.random() * (max - min) + min; }
function jitter() { return (MIN_INTERVAL + Math.random() * (MAX_INTERVAL - MIN_INTERVAL)) * 1000; }

async function placeRandomBet(wallet) {
  const casino = new ethers.Contract(CASINO_ADDRESS, ABI, wallet);
  const game = GAMES[randInt(0, GAMES.length - 1)];
  const stake = randFloat(MIN_STAKE, MAX_STAKE).toFixed(4);
  const value = ethers.parseEther(stake);
  const cs = rng();
  try {
    let tx;
    if (game === "dice") {
      const target = randInt(20, 80);
      const over = Math.random() > 0.5;
      tx = await casino.placeDiceBet(target, over, cs, { value });
    } else if (game === "crash") {
      const ac = randInt(110, 400); // 1.10 – 4.00x
      tx = await casino.placeCrashBet(ac, cs, { value });
    } else if (game === "slots") {
      tx = await casino.placeSlotsBet(cs, { value });
    } else if (game === "plinko") {
      const risk = randInt(0, 2);
      tx = await casino.placeplinkoBet(risk, cs, { value });
    } else if (game === "roulette") {
      const kind = randInt(1, 9); // skip STRAIGHT for simplicity
      tx = await casino.placeRouletteBet(kind, 0, cs, { value });
    }
    const r = await tx.wait();
    console.log(`[demo-bot] ${shortAddr(wallet.address)} ${game} ${stake} STT → ${r.hash}`);
  } catch (e) {
    console.error(`[demo-bot] ${shortAddr(wallet.address)} ${game} failed: ${e.shortMessage || e.message}`);
  }
}

function shortAddr(a) { return `${a.slice(0,6)}…${a.slice(-4)}`; }

(async function loop() {
  while (true) {
    const w = wallets[randInt(0, wallets.length - 1)];
    placeRandomBet(w).catch(() => {});
    await new Promise((r) => setTimeout(r, jitter()));
  }
})();
