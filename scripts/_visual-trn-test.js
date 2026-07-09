// 4-player SNG show-match at human pace — for WATCHING a live tournament in a
// browser. Creates a real buy-in SNG (with the 5% host reward enabled so the
// "★ host" tag shows), registers 4 script wallets, and plays believable poker
// (checks/calls, occasional bets & raises, push/fold when short) until someone
// wins. Prints the table URL the moment the bot auto-starts it.
//
//   node scripts/_visual-trn-test.js
require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const RPC = "https://api.infra.testnet.somnia.network";
const E = (n) => ethers.parseEther(String(n));
const F = (w) => ethers.formatEther(w);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const A = { FOLD: 0, CHECK: 1, CALL: 2, BET: 3, RAISE: 4, ALLIN: 5 };
const loadAbi = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", "poker", `${n}.sol`, `${n}.json`), "utf8")).abi;

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  provider.pollingInterval = 500;
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "poker-somniaTestnet.json"), "utf8"));
  const master = process.env.POKER_SEED_MASTER_KEY;
  const ws = [1, 2, 3, 4].map((i) => new ethers.Wallet(ethers.keccak256(ethers.solidityPacked(["bytes32", "string"], [master, `load-${i}`])), provider));
  const roomR = new ethers.Contract(m.addresses.pokerRoom, loadAbi("PokerRoom"), provider);
  const rooms = ws.map((w) => new ethers.Contract(m.addresses.pokerRoom, loadAbi("PokerRoom"), w));
  const trn = new ethers.Contract(m.addresses.pokerTournament, loadAbi("PokerTournament"), ws[0]);
  console.log("[show] players:", ws.map((w) => w.address.slice(0, 8)).join(" "));

  // host = player 1; 5% host reward ON (buy-in event)
  const hostBalBefore = await roomR.balance(ws[0].address);
  await (await trn.createTournament({
    buyIn: E("0.02"), fee: 0, maxPlayers: 4, seatsPerTable: 0, startStack: 1500,
    sbStart: 10, bbStart: 20, anteStart: 0, levelDur: 90, growthBps: 20000,
    startTime: 0, approvalRequired: false, actionSecs: 20, payoutBps: [7000, 3000], structure: [], hostBps: 500,
  })).wait();
  const id = Number(await trn.count()) - 1;
  console.log(`[show] SNG #${id} created (buy-in 0.02, host reward 5%, split 70/30)`);
  for (const [i, w] of ws.entries()) {
    await (await trn.connect(w).register(id, { value: E("0.02") })).wait();
    console.log(`[show] p${i + 1} registered`);
  }

  // wait for the bot to auto-start
  let t = null;
  for (let i = 0; i < 60 && t == null; i++) {
    const info = await trn.info(id);
    if (Number(info.status) === 1) t = Number(info.tableId);
    else await sleep(2000);
  }
  if (t == null) throw new Error("bot never started the SNG");
  console.log(`\n[show] ================================================`);
  console.log(`[show]  LIVE — watch now:  https://shinia.mom/table?t=${t}`);
  console.log(`[show] ================================================\n`);

  const mine = new Map(ws.map((w) => [w.address.toLowerCase(), w]));
  const deadline = Date.now() + 25 * 60_000;
  let acted = 0;

  while (Date.now() < deadline) {
    const info = await trn.info(id);
    if (Number(info.status) === 2) {
      console.log("\n[show] FINISHED");
      const hostBal = await roomR.balance(ws[0].address);
      console.log(`[show] host reward received: +${F(hostBal - hostBalBefore > 0n ? hostBal - hostBalBefore : 0n)} STT (expected includes 5% of the 0.08 pool = 0.004)`);
      break;
    }
    const h = await roomR.getHand(t);
    if (h.inProgress && Number(h.street) <= 3) {
      const seatIdx = Number(h.actingSeat);
      const seat = await roomR.getSeat(t, seatIdx);
      const w = mine.get(seat.player.toLowerCase());
      if (w) {
        const sh = await roomR.getSeatHand(t, seatIdx);
        const cfg = await roomR.getTable(t);
        const bb = cfg.bigBlind;
        const stack = seat.stack;
        const owe = h.currentBet > sh.committedStreet;
        const short = stack <= bb * 4n;
        const roll = Math.random();
        let action, amount = 0n;
        if (short) { action = A.ALLIN; } // push/fold poker when shallow
        else if (owe) {
          if (roll < 0.14) action = A.FOLD;
          else if (roll < 0.24) { action = A.RAISE; amount = h.currentBet + (h.minRaise > 0n ? h.minRaise : bb); }
          else action = A.CALL;
        } else {
          if (roll < 0.28) { action = A.BET; amount = bb * 2n; }
          else action = A.CHECK;
        }
        await sleep(1800 + Math.random() * 2200); // human-ish thinking time
        try {
          await (await rooms[ws.indexOf(w)].act(t, action, amount)).wait();
          acted++;
          process.stdout.write(["F", "k", "C", "B", "R", "A"][action]);
        } catch (_) { process.stdout.write("!"); }
      }
    }
    await sleep(1500);
  }
  console.log(`\n[show] done — ${acted} actions played`);
}

main().catch((e) => { console.error("[show] fatal:", e.shortMessage || e.message); process.exit(1); });
