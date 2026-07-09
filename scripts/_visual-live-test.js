// Scripted 2-player show-match on the live heads-up table — slow, watchable
// actions so the UI (action badges, fold muck, showdown banner, combo tiers)
// can be verified from an observer browser while it plays.
//
//   node scripts/_visual-live-test.js
//
// Hand A: preflop call/check → flop: BB bets, SB FOLDS (fold badge + muck).
// Hand B: check/call every street to SHOWDOWN (winner banner + combos).
// Then both sit out and leave. Uses the same derived e2e wallets as
// _e2e-live-test.js — safe to run alongside the live dealer bot.
require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const RPC = "https://api.infra.testnet.somnia.network";
const E = (n) => ethers.parseEther(String(n));
const F = (w) => ethers.formatEther(w);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const A = { FOLD: 0, CHECK: 1, CALL: 2, BET: 3, RAISE: 4, ALLIN: 5 };
const T = 2;

function loadAbi(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", "poker", `${name}.sol`, `${name}.json`), "utf8")).abi;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  provider.pollingInterval = 500;
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "poker-somniaTestnet.json"), "utf8"));
  const master = process.env.POKER_SEED_MASTER_KEY;
  const [p1, p2] = ["e2e-player-1", "e2e-player-2"].map((tag) =>
    new ethers.Wallet(ethers.keccak256(ethers.solidityPacked(["bytes32", "string"], [master, tag])), provider));
  const roomAbi = loadAbi("PokerRoom");
  const room1 = new ethers.Contract(m.addresses.pokerRoom, roomAbi, p1);
  const room2 = new ethers.Contract(m.addresses.pokerRoom, roomAbi, p2);
  const roomR = room1.connect(provider);
  console.log("[vis] players:", p1.address, p2.address);

  for (const [pl, room] of [[p1, room1], [p2, room2]]) {
    const have = await roomR.balance(pl.address);
    if (have < E("0.45")) await (await room.deposit({ value: E("0.45") - have })).wait();
  }
  await (await room1.sitDown(T, 0, E("0.4"))).wait();
  await (await room2.sitDown(T, 1, E("0.4"))).wait();
  console.log("[vis] both seated — waiting for the deal. WATCH table", T, "now.");

  const bySeat = async (seatIdx) => {
    const seat = await roomR.getSeat(T, seatIdx);
    return seat.player.toLowerCase() === p1.address.toLowerCase() ? room1
      : seat.player.toLowerCase() === p2.address.toLowerCase() ? room2 : null;
  };

  let phase = "A", settles = 0, flopBet = false;
  const deadline = Date.now() + 420000;
  let prevInProgress = false;

  while (Date.now() < deadline) {
    const h = await roomR.getHand(T);
    if (!h.inProgress && prevInProgress) {
      settles++;
      console.log(`[vis] hand settled (#${settles})`);
      if (phase === "A" && flopBet) { phase = "B"; console.log("[vis] === Hand B: check/call to showdown ==="); }
      else if (phase === "B") { phase = "done"; }
      if (phase === "done") break;
    }
    prevInProgress = h.inProgress;

    if (h.inProgress && Number(h.street) <= 3) {
      const seatIdx = Number(h.actingSeat);
      const ctl = await bySeat(seatIdx);
      if (ctl) {
        const sh = await roomR.getSeatHand(T, seatIdx);
        const owe = h.currentBet > sh.committedStreet;
        const isSB = seatIdx === Number(h.button); // HU: button posts SB
        const street = Number(h.street);
        try {
          if (phase === "A" && street === 1 && !owe && !isSB && !flopBet) {
            // flop, BB first to act → open for exactly one BB
            await (await ctl.act(T, A.BET, E("0.02"))).wait();
            flopBet = true;
            console.log("[vis] BB bets 0.02 on the flop");
          } else if (phase === "A" && street === 1 && owe && isSB && flopBet) {
            await (await ctl.act(T, A.FOLD, 0)).wait();
            console.log("[vis] SB FOLDS — watch the muck + fold badge");
          } else {
            await (await ctl.act(T, owe ? A.CALL : A.CHECK, 0)).wait();
            process.stdout.write(owe ? "C" : "k");
          }
        } catch (e) { process.stdout.write("!"); }
      }
    }
    await sleep(3000); // slow enough to watch
  }

  console.log("\n[vis] sitting out + leaving…");
  try { await (await room1.setSitOut(T, true)).wait(); } catch {}
  try { await (await room2.setSitOut(T, true)).wait(); } catch {}
  for (let i = 0; i < 40; i++) { if (!(await roomR.getHand(T)).inProgress) break; await sleep(2500); }
  try { await (await room1.leaveTable(T)).wait(); } catch (e) { console.log("[vis] p1 leave:", e.shortMessage || e.message); }
  try { await (await room2.leaveTable(T)).wait(); } catch (e) { console.log("[vis] p2 leave:", e.shortMessage || e.message); }
  console.log("[vis] DONE — hands settled:", settles);
}

main().catch((e) => { console.error("[vis] fatal:", e.shortMessage || e.message); process.exit(1); });
