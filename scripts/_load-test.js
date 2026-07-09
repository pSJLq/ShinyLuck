// Load test: N script wallets play REAL cash hands simultaneously through the
// live dealer bot, polling the dealer's HTTP snapshot cache exactly like a
// browser would. Measures what the stack can actually take before the public
// launch: action-confirm latency, snapshot latency, bot dealing throughput,
// and exercises table auto-spawn (fill a config's tables → a clone appears).
//
//   node scripts/_load-test.js fund          # top up wallets (STOP the bot first — shares the deployer key)
//   node scripts/_load-test.js play [min]    # run the swarm (bot RUNNING), default 4 minutes
//
// Wallets are derived load-1..load-N from POKER_SEED_MASTER_KEY (reusable).
require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const RPC = "https://api.infra.testnet.somnia.network";
const DEALER_API = process.env.LOAD_DEALER_API || "https://shinia.mom/dealer";
const N = parseInt(process.env.LOAD_WALLETS || "12", 10);
const E = (n) => ethers.parseEther(String(n));
const F = (w) => ethers.formatEther(w);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const A = { FOLD: 0, CHECK: 1, CALL: 2, BET: 3, RAISE: 4, ALLIN: 5 };

function loadAbi(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", "poker", `${name}.sol`, `${name}.json`), "utf8")).abi;
}
const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

async function main() {
  const mode = process.argv[2] || "play";
  const minutes = parseFloat(process.argv[3] || "4");
  const provider = new ethers.JsonRpcProvider(RPC);
  provider.pollingInterval = 400;
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "poker-somniaTestnet.json"), "utf8"));
  const master = process.env.POKER_SEED_MASTER_KEY;
  const wallets = Array.from({ length: N }, (_, i) =>
    new ethers.Wallet(ethers.keccak256(ethers.solidityPacked(["bytes32", "string"], [master, `load-${i + 1}`])), provider));
  const roomAbi = loadAbi("PokerRoom");
  const roomR = new ethers.Contract(m.addresses.pokerRoom, roomAbi, provider);
  console.log(`[load] ${N} wallets, dealer API ${DEALER_API}`);

  if (mode === "fund") {
    const deployer = new ethers.Wallet(process.env.POKER_DEPLOYER_KEY, provider);
    let nonce = await provider.getTransactionCount(deployer.address);
    for (const w of wallets) {
      const bal = await provider.getBalance(w.address);
      if (bal < E("0.7")) {
        await (await deployer.sendTransaction({ to: w.address, value: E("1.0") - bal, nonce: nonce++ })).wait();
        console.log(`[load] funded ${w.address}`);
      } else console.log(`[load] ok ${w.address} ${F(bal)}`);
    }
    console.log("[load] deployer left:", F(await provider.getBalance(deployer.address)));
    return;
  }

  // ---- play ----
  const snapLat = [], actLat = [];
  let actions = 0, folds = 0, errors = 0, snapStale = 0;
  const started = Date.now();
  const deadline = started + minutes * 60_000;

  async function getSnap(t) {
    const t0 = Date.now();
    const r = await fetch(`${DEALER_API}/snapshot?t=${t}`, { signal: AbortSignal.timeout(4000) });
    snapLat.push(Date.now() - t0);
    if (!r.ok) throw new Error("snap " + r.status);
    const s = await r.json();
    if (Date.now() - s.ts > 8000) snapStale++;
    return s;
  }

  async function pickTable(w) {
    // a cash table with a free seat and an affordable buy-in, straight from /lobby
    const r = await fetch(`${DEALER_API}/lobby`, { signal: AbortSignal.timeout(4000) });
    const lob = await r.json();
    const zero = "0x0000000000000000000000000000000000000000";
    const options = [];
    for (const t of lob.tables) {
      if (t.controller !== zero || t.seated >= t.maxSeats) continue;
      const snap = await getSnap(t.id).catch(() => null);
      if (!snap || BigInt(snap.cfg.minBuyIn) > E("0.5")) continue;
      const free = snap.seats.filter((s) => s.player === zero);
      for (const seat of free) options.push({ tableId: t.id, seat: seat.index, minBuyIn: BigInt(snap.cfg.minBuyIn) });
    }
    // random free seat — 12 players all charging at "the first free seat" of a
    // 3s-cached lobby just trample each other
    return options.length ? options[Math.floor(Math.random() * options.length)] : null;
  }

  // stand up from any table a previous (crashed/reverted) run left us at
  async function cleanupSeats(w, room) {
    const r = await fetch(`${DEALER_API}/lobby`, { signal: AbortSignal.timeout(4000) }).catch(() => null);
    if (!r || !r.ok) return;
    const lob = await r.json();
    const zero = "0x0000000000000000000000000000000000000000";
    for (const t of lob.tables) {
      if (t.controller !== zero || t.seated === 0) continue;
      const s = await getSnap(t.id).catch(() => null);
      if (!s || !s.seats.some((x) => x.player.toLowerCase() === w.address.toLowerCase())) continue;
      try { await (await room.setSitOut(t.id, true)).wait(); } catch (_) {}
      // an abandoned multiway hand timeout-folds one 45s clock at a time — a
      // full table can take several minutes to unwind before leave stops reverting
      for (let i = 0; i < 70; i++) {
        try { await (await room.leaveTable(t.id)).wait(); console.log(`[cleanup] left stale seat at table ${t.id}`); break; }
        catch (_) { await sleep(6000); }
      }
    }
  }

  async function runPlayer(w, idx) {
    const room = new ethers.Contract(m.addresses.pokerRoom, roomAbi, w);
    await sleep(idx * 700); // stagger joins
    await cleanupSeats(w, room).catch(() => {});
    // bankroll
    const have = await roomR.balance(w.address);
    if (have < E("0.5")) { try { await (await room.deposit({ value: E("0.5") - have })).wait(); } catch (e) { console.log(`[p${idx}] deposit fail: ${e.shortMessage || e.message}`); return; } }
    // find a seat (retry long enough for auto-spawn to add a table when the
    // existing ones fill up — that's part of what we're testing)
    let seatAt = null;
    for (let tries = 0; tries < 16 && !seatAt; tries++) {
      const pick = await pickTable(w).catch(() => null);
      if (!pick) { await sleep(3500); continue; }
      try { await (await room.sitDown(pick.tableId, pick.seat, pick.minBuyIn)).wait(); seatAt = pick; }
      catch (_) { await sleep(1000 + Math.random() * 1500); } // seat race — repick
    }
    if (!seatAt) { console.log(`[p${idx}] no seat found`); return; }
    const t = seatAt.tableId;
    console.log(`[p${idx}] seated at table ${t} seat ${seatAt.seat}`);

    let meMissing = 0;
    while (Date.now() < deadline) {
      let s;
      try { s = await getSnap(t); } catch (_) { errors++; await sleep(1500); continue; }
      const me = s.seats.find((x) => x.player.toLowerCase() === w.address.toLowerCase());
      // idle tables refresh every ~8s on the dealer — a snapshot can lag our
      // own sitDown; only give up when we're gone for a sustained stretch
      if (!me) { if (++meMissing >= 10) break; await sleep(1500); continue; }
      meMissing = 0;
      if (BigInt(me.stack) === 0n && !s.hand.inProgress) break; // busted
      const h = s.hand;
      if (h.inProgress && h.street <= 3 && h.actingSeat === me.index) {
        const owe = BigInt(h.currentBet) > BigInt(me.committedStreet);
        const roll = Math.random();
        let action = owe ? A.CALL : A.CHECK, amount = 0n;
        if (owe && roll < 0.08) { action = A.FOLD; }
        else if (!owe && roll < 0.12) { action = A.BET; amount = BigInt(s.cfg.bigBlind); }
        else if (owe && roll < 0.16) { action = A.RAISE; amount = BigInt(h.currentBet) + BigInt(h.minRaise); }
        const t0 = Date.now();
        try {
          await (await room.act(t, action, amount)).wait();
          actLat.push(Date.now() - t0);
          actions++; if (action === A.FOLD) folds++;
          process.stdout.write(["F", "k", "C", "B", "R", "A"][action]);
        } catch (_) { errors++; }
      }
      await sleep(1200 + Math.random() * 600);
    }
    // wind down — the snapshot can lag a couple seconds, so retry the leave
    // until the live hand actually settles instead of trusting one read
    try { await (await room.setSitOut(t, true)).wait(); } catch (_) {}
    let left = false;
    for (let i = 0; i < 70 && !left; i++) {
      try { await (await room.leaveTable(t)).wait(); left = true; }
      catch (_) { await sleep(6000); }
    }
    console.log(`\n[p${idx}] ${left ? "left" : "COULD NOT LEAVE (chips parked at the seat — next run's cleanup will collect)"} table ${t}`);
  }

  await Promise.all(wallets.map((w, i) => runPlayer(w, i).catch((e) => { errors++; console.log(`[p${i}] fatal: ${e.shortMessage || e.message}`); })));

  const health = await fetch(`${DEALER_API}/health`).then((r) => r.json()).catch(() => null);
  console.log("\n\n[load] ===== RESULTS =====");
  console.log(`[load] duration: ${((Date.now() - started) / 60000).toFixed(1)} min, players: ${N}`);
  console.log(`[load] actions confirmed: ${actions} (${folds} folds), errors: ${errors}`);
  console.log(`[load] action tx latency ms: p50=${pct(actLat, 50)} p90=${pct(actLat, 90)} max=${pct(actLat, 100)}`);
  console.log(`[load] snapshot GET ms: n=${snapLat.length} p50=${pct(snapLat, 50)} p90=${pct(snapLat, 90)} p99=${pct(snapLat, 99)} stale=${snapStale}`);
  if (health) console.log(`[load] bot health: ok=${health.ok} loopAge=${health.loopAgeMs}ms gas=${health.gasSTT?.toFixed(2)} STT tables=${health.tables} spawned=${health.spawned} snapErrors=${health.snapErrors}`);
}

main().catch((e) => { console.error("[load] fatal:", e.shortMessage || e.message); process.exit(1); });
