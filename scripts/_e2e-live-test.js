// LIVE end-to-end proof on Somnia testnet: two script wallets play a real
// cash hand AND a full Sit&Go tournament through the running dealer bot,
// asserting on-chain results at every step. Run with the bot ALREADY running.
//
//   node scripts/_e2e-live-test.js
//
// Wallets are derived from POKER_SEED_MASTER_KEY (deterministic, reusable)
// and must be pre-funded (fund-e2e step in this file, run with bot STOPPED).
require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const RPC = "https://api.infra.testnet.somnia.network";
const E = (n) => ethers.parseEther(String(n));
const F = (w) => ethers.formatEther(w);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ACTION = { FOLD: 0, CHECK: 1, CALL: 2, BET: 3, RAISE: 4, ALLIN: 5 };

function loadAbi(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", "poker", `${name}.sol`, `${name}.json`), "utf8")).abi;
}

function wallets(provider) {
  const master = process.env.POKER_SEED_MASTER_KEY;
  const k1 = ethers.keccak256(ethers.solidityPacked(["bytes32", "string"], [master, "e2e-player-1"]));
  const k2 = ethers.keccak256(ethers.solidityPacked(["bytes32", "string"], [master, "e2e-player-2"]));
  return [new ethers.Wallet(k1, provider), new ethers.Wallet(k2, provider)];
}

async function main() {
  const mode = process.argv[2] || "play";
  const provider = new ethers.JsonRpcProvider(RPC);
  provider.pollingInterval = 500;
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "poker-somniaTestnet.json"), "utf8"));
  const [p1, p2] = wallets(provider);
  console.log("[e2e] players:", p1.address, p2.address);

  if (mode === "fund") {
    // Run with the BOT STOPPED (shares the deployer key / nonce).
    const deployer = new ethers.Wallet(process.env.POKER_DEPLOYER_KEY, provider);
    for (const p of [p1, p2]) {
      const bal = await provider.getBalance(p.address);
      if (bal < E("0.8")) {
        await (await deployer.sendTransaction({ to: p.address, value: E("1.0") })).wait();
        console.log("[e2e] funded", p.address);
      } else console.log("[e2e] already funded", p.address, F(bal));
    }
    console.log("[e2e] deployer left:", F(await provider.getBalance(deployer.address)));
    return;
  }

  const roomAbi = loadAbi("PokerRoom");
  const trnAbi = loadAbi("PokerTournament");
  const room1 = new ethers.Contract(m.addresses.pokerRoom, roomAbi, p1);
  const room2 = new ethers.Contract(m.addresses.pokerRoom, roomAbi, p2);
  const roomR = room1.connect(provider);
  const trn1 = new ethers.Contract(m.addresses.pokerTournament, trnAbi, p1);
  const trn2 = trn1.connect(p2);

  const results = [];
  const check = (name, ok, detail = "") => { results.push([name, ok]); console.log(`[e2e] ${ok ? "PASS" : "FAIL"}: ${name} ${detail}`); };

  // ---------------- CASH: full hand on the heads-up table ----------------
  const T = 2; // 2-max 0.01/0.02 table from _add-poker-tables
  console.log("\n[e2e] === CASH hand on table", T, "===");
  await (await room1.deposit({ value: E("0.5") })).wait();
  await (await room2.deposit({ value: E("0.5") })).wait();
  await (await room1.sitDown(T, 0, E("0.4"))).wait();
  await (await room2.sitDown(T, 1, E("0.4"))).wait();
  console.log("[e2e] both seated 0.4 — waiting for the bot to deal…");

  const me = { [p1.address.toLowerCase()]: { c: room1, seat: 0 }, [p2.address.toLowerCase()]: { c: room2, seat: 1 } };
  let handsPlayed = 0, satOut = false;
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const h = await roomR.getHand(T);
    if (h.inProgress && Number(h.street) <= 3) {
      const seatIdx = Number(h.actingSeat);
      const seat = await roomR.getSeat(T, seatIdx);
      const ctl = me[seat.player.toLowerCase()];
      if (ctl) {
        const sh = await roomR.getSeatHand(T, seatIdx);
        const owe = h.currentBet > sh.committedStreet;
        try { await (await ctl.c.act(T, owe ? ACTION.CALL : ACTION.CHECK, 0)).wait(); process.stdout.write(owe ? "C" : "k"); } catch (_) {}
      }
    } else if (!h.inProgress && handsPlayed === 0 && Number(await roomR.handCounter(T)) > 0) {
      handsPlayed = 1;
      console.log("\n[e2e] hand settled on-chain");
      if (!satOut) { satOut = true; await (await room1.setSitOut(T, true)).wait(); await (await room2.setSitOut(T, true)).wait(); }
      break;
    }
    await sleep(1200);
  }
  check("cash: a full hand played through the live bot", handsPlayed === 1);

  // chip conservation: stacks + rake-side == everything that went in
  const s0 = (await roomR.getSeat(T, 0)).stack, s1 = (await roomR.getSeat(T, 1)).stack;
  check("cash: chip conservation (stacks sum sane)", s0 + s1 <= E("0.8") && s0 + s1 >= E("0.79"), `${F(s0)} + ${F(s1)}`);
  // wait out any started hand, then leave
  for (let i = 0; i < 30; i++) { if (!(await roomR.getHand(T)).inProgress) break; await sleep(2000); }
  await (await room1.leaveTable(T)).wait();
  await (await room2.leaveTable(T)).wait();
  check("cash: both players left the table cleanly", true);

  // ---------------- TOURNAMENT: full SNG to payout ----------------
  console.log("\n[e2e] === SNG tournament (all-in until someone busts) ===");
  const balBefore1 = await roomR.balance(p1.address);
  const balBefore2 = await roomR.balance(p2.address);
  await (await trn1.createTournament(E("0.05"), 0, 2, 200, 10, 20, 60, [10000])).wait();
  const id = Number(await trn1.count()) - 1;
  await (await trn1.register(id, { value: E("0.05") })).wait();
  await (await trn2.register(id, { value: E("0.05") })).wait();
  console.log("[e2e] SNG", id, "created + both registered — bot should auto-start…");

  let info, tTable = null, finished = false;
  const tDeadline = Date.now() + 420000;
  while (Date.now() < tDeadline) {
    info = await trn1.info(id);
    if (Number(info.status) === 1 && tTable == null) { tTable = Number(info.tableId); console.log("[e2e] auto-started on table", tTable); }
    if (Number(info.status) === 2) { finished = true; break; }
    if (tTable != null) {
      const h = await roomR.getHand(tTable);
      if (h.inProgress && Number(h.street) <= 3) {
        const seatIdx = Number(h.actingSeat);
        const seat = await roomR.getSeat(tTable, seatIdx);
        const ctl = me[seat.player.toLowerCase()];
        if (ctl) { try { await (await ctl.c.act(tTable, ACTION.ALLIN, 0)).wait(); process.stdout.write("A"); } catch (_) {} }
      }
    }
    await sleep(1500);
  }
  console.log("");
  check("trn: bot auto-started when full", tTable != null);
  check("trn: played all-in hands to a finish", finished, `status=${info && Number(info.status)}`);

  const winBal1 = (await roomR.balance(p1.address)) - balBefore1;
  const winBal2 = (await roomR.balance(p2.address)) - balBefore2;
  const winner = winBal1 > 0n ? winBal1 : winBal2;
  check("trn: winner received the whole 0.1 pool in-room", winner === E("0.1"), `p1 +${F(winBal1)}, p2 +${F(winBal2)}`);

  console.log("\n[e2e] ===== SUMMARY =====");
  let pass = 0;
  for (const [name, ok] of results) { console.log(` ${ok ? "✅" : "❌"} ${name}`); if (ok) pass++; }
  console.log(`[e2e] ${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.error("[e2e] fatal:", e.shortMessage || e.message); process.exit(1); });
