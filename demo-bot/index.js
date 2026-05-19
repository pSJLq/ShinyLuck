// Demo bot — keeps the Live Feed alive during demo runs by placing tiny
// random bets with a roster of pre-funded testnet wallets.
//
// IMPORTANT: never run against mainnet. The bot is a demo aid only.
//
// Env vars:
//   RPC_URL          — defaults to https://dream-rpc.somnia.network
//   CASINO_ADDRESS   — required
//   WALLET_KEYS      — comma-separated private keys for bet senders
//   MIN_INTERVAL     — min seconds between bets (default 30)
//   MAX_INTERVAL     — max seconds between bets (default 60)
//   MIN_STAKE        — min STT per bet (default 0.001)
//   MAX_STAKE        — max STT per bet (default 0.01)
//   GAMES            — comma-separated subset: dice,mines,plinko,slots,cluster,crash,roulette

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || process.env.RPC_TESTNET || "https://dream-rpc.somnia.network";

// Auto-resolve CASINO_ADDRESS from the deployments manifest if not given via env.
let CASINO_ADDRESS = process.env.CASINO_ADDRESS;
if (!CASINO_ADDRESS) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somniaTestnet.json"), "utf8"));
    CASINO_ADDRESS = manifest.addresses.casino;
    console.log(`[demo-bot] auto-resolved casino=${CASINO_ADDRESS} from manifest`);
  } catch (e) {
    console.error("CASINO_ADDRESS missing and no manifest at deployments/somniaTestnet.json");
    process.exit(1);
  }
}

// Roster of signers. If WALLET_KEYS not given, fall back to PRIVATE_KEY (the
// deployer). The bot is most fun with 5-10 funded wallets to populate the feed
// with varied addresses, but solo demo works too.
const KEYS = (process.env.WALLET_KEYS || process.env.PRIVATE_KEY || "")
  .split(",").map((k) => k.trim()).filter(Boolean);
if (KEYS.length === 0) { console.error("WALLET_KEYS or PRIVATE_KEY missing"); process.exit(1); }

const MIN_INTERVAL = parseInt(process.env.MIN_INTERVAL, 10) || 30;
const MAX_INTERVAL = parseInt(process.env.MAX_INTERVAL, 10) || 60;
// Cluster reserves 2500× stake from bankroll per bet. With a 20 STT bankroll
// on the current deployment, the practical max stake for SUGAR is ~0.008 STT
// (0.008 × 2500 = 20). MAX_STAKE 0.003 keeps every game well inside the
// reserve envelope so we don't trip BankrollInsufficient on jackpot pulls.
const MIN_STAKE = parseFloat(process.env.MIN_STAKE) || 0.0005;
const MAX_STAKE = parseFloat(process.env.MAX_STAKE) || 0.003;
const GAMES = (process.env.GAMES || "dice,mines,plinko,slots,cluster,crash,roulette")
  .split(",").map((g) => g.trim()).filter(Boolean);

const ABI_PATH = path.join(__dirname, "..", "artifacts", "contracts", "Casino.sol", "Casino.json");
const ABI = JSON.parse(fs.readFileSync(ABI_PATH, "utf8")).abi;

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallets = KEYS.map((k) => new ethers.Wallet(k, provider));
console.log(`[demo-bot] casino=${CASINO_ADDRESS} roster=${wallets.length} wallets games=[${GAMES.join(",")}]`);

function rng() { return ethers.hexlify(ethers.randomBytes(32)); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randFloat(min, max) { return Math.random() * (max - min) + min; }
function jitter() { return (MIN_INTERVAL + Math.random() * (MAX_INTERVAL - MIN_INTERVAL)) * 1000; }
function shortAddr(a) { return `${a.slice(0,6)}…${a.slice(-4)}`; }

async function placeRandomBet(wallet) {
  const casino = new ethers.Contract(CASINO_ADDRESS, ABI, wallet);
  const game = GAMES[randInt(0, GAMES.length - 1)];
  const stake = randFloat(MIN_STAKE, MAX_STAKE).toFixed(4);
  const value = ethers.parseEther(stake);
  const cs = rng();
  try {
    let tx, label = game;
    if (game === "dice") {
      const target = randInt(20, 80);
      const over = Math.random() > 0.5;
      tx = await casino.placeDiceBet(target, over, cs, { value });
    } else if (game === "mines") {
      const mineCount = randInt(2, 8);
      tx = await casino.placeMinesBet(mineCount, cs, { value });
      label = `mines(${mineCount})`;
    } else if (game === "plinko") {
      const risk = randInt(0, 2);
      tx = await casino.placeplinkoBet(risk, cs, { value });
      label = `plinko(r=${risk})`;
    } else if (game === "slots") {
      // VAULT.7 — placeSlotsBet(clientSeed, useFreeSpin)
      tx = await casino.placeSlotsBet(cs, false, { value });
    } else if (game === "cluster") {
      // SUGAR.LAB — placeClusterBet(clientSeed, useFreeSpin)
      tx = await casino.placeClusterBet(cs, false, { value });
    } else if (game === "crash") {
      // Round-based — placeCrashBet(autoCashoutX100). 0 = manual cashout only,
      // but the bot won't be around to cash out, so use auto in [110, 400].
      const ac = randInt(110, 400);
      tx = await casino.placeCrashBet(ac, { value });
      label = `crash(@${(ac/100).toFixed(2)}x)`;
    } else if (game === "roulette") {
      // Round-based, multi-bet — placeRouletteBets(RouletteBetInput[]).
      // Build a single random outside bet for simplicity.
      const kind = randInt(1, 9); // skip STRAIGHT (would need a number 0..37)
      const bets = [{ kind, number: 0, amount: value }];
      tx = await casino.placeRouletteBets(bets, { value });
      const KIND_NAMES = ["STRAIGHT","RED","BLACK","EVEN","ODD","LOW","HIGH","DZ1","DZ2","DZ3"];
      label = `roulette(${KIND_NAMES[kind]})`;
    } else {
      console.warn(`[demo-bot] unknown game: ${game}`);
      return;
    }
    const r = await tx.wait();
    console.log(`[demo-bot] ${shortAddr(wallet.address)} ${label} ${stake} STT → ${r.hash.slice(0,12)}…`);
  } catch (e) {
    // Round-based games revert when no round is open / window closed — that's
    // fine, the bot just skips and retries on the next tick.
    const msg = (e.shortMessage || e.message || "unknown").slice(0, 120);
    console.error(`[demo-bot] ${shortAddr(wallet.address)} ${game} failed: ${msg}`);
  }
}

(async function loop() {
  console.log(`[demo-bot] starting loop — first bet in ${MIN_INTERVAL}s…`);
  while (true) {
    const w = wallets[randInt(0, wallets.length - 1)];
    placeRandomBet(w).catch(() => {});
    await new Promise((r) => setTimeout(r, jitter()));
  }
})();
