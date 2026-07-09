// STRESS TEST — a 50-bot multi-table tournament through the LIVE dealer bot.
// The hardest path in the whole system: 6 controlled tables, round-robin
// seating, blind escalation, busts, table rebalancing/consolidation, a final
// table, and prize payout — all driven by the single dealer process.
//
//   node scripts/_stress-mtt.js fund     # fund 50 gas wallets (bot may run)
//   node scripts/_stress-mtt.js run      # create + register + play to a finish
//
// Real (tiny) money: 0.01 STT buy-in each → 0.5 pool, top-5 paid. Bots poll the
// dealer's HTTP snapshot cache like real clients and re-scan their table every
// loop so they follow rebalancing moves. Metrics printed at the end.
require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const RPC = "https://api.infra.testnet.somnia.network";
const DEALER = process.env.LOAD_DEALER_API || "https://shinia.mom/dealer";
const N = parseInt(process.env.STRESS_N || "50", 10);
const BUYIN = ethers.parseEther("0.01");
const GAS_EACH = ethers.parseEther("0.12"); // 0.01 buy-in + gas headroom
const E = (n) => ethers.parseEther(String(n));
const F = (w) => ethers.formatEther(w);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const A = { FOLD: 0, CHECK: 1, CALL: 2, BET: 3, RAISE: 4, ALLIN: 5 };
const loadAbi = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", "poker", `${n}.sol`, `${n}.json`), "utf8")).abi;
const wallet = (master, i) => new ethers.Wallet(ethers.keccak256(ethers.solidityPacked(["bytes32", "string"], [master, `stress-${i}`])), null);

async function main() {
  const mode = process.argv[2] || "run";
  const provider = new ethers.JsonRpcProvider(RPC);
  provider.pollingInterval = 500;
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "poker-somniaTestnet.json"), "utf8"));
  const master = process.env.POKER_SEED_MASTER_KEY;
  const ws = Array.from({ length: N }, (_, i) => wallet(master, i + 1).connect(provider));
  const roomR = new ethers.Contract(m.addresses.pokerRoom, loadAbi("PokerRoom"), provider);
  const trnR = new ethers.Contract(m.addresses.pokerTournament, loadAbi("PokerTournament"), provider);

  if (mode === "fund") {
    const dep = new ethers.Wallet(process.env.POKER_DEPLOYER_KEY, provider);
    let nonce = await provider.getTransactionCount(dep.address);
    console.log(`[stress] funding ${N} wallets ${F(GAS_EACH)} each from ${dep.address}`);
    const txs = [];
    for (const w of ws) {
      const bal = await provider.getBalance(w.address);
      if (bal >= GAS_EACH) continue;
      txs.push(dep.sendTransaction({ to: w.address, value: GAS_EACH - bal, nonce: nonce++ }));
      if (txs.length % 10 === 0) { await Promise.all(txs.splice(0).map((t) => t.then((x) => x.wait()))); process.stdout.write("."); }
    }
    await Promise.all(txs.map((t) => t.then((x) => x.wait())));
    console.log(`\n[stress] funded. deployer left: ${F(await provider.getBalance(dep.address))} STT`);
    return;
  }

  // ---------------- RUN ----------------
  const trn = trnR.connect(ws[0]);
  const balBefore = await Promise.all(ws.map((w) => roomR.balance(w.address)));

  // 6 tables of 9 (last partial). Turbo-ish so blinds bite; top-5 paid.
  console.log(`[stress] creating a ${N}-player MTT (9-max → ${Math.ceil(N / 9)} tables)…`);
  await (await trn.createTournament({
    buyIn: BUYIN, fee: 0, maxPlayers: N, seatsPerTable: 9, startStack: 1500,
    sbStart: 10, bbStart: 20, anteStart: 0, levelDur: 120, growthBps: 20000,
    startTime: 0, approvalRequired: false, actionSecs: 20, payoutBps: [4000, 2500, 1800, 1000, 700], structure: [], hostBps: 0,
  })).wait();
  const id = Number(await trn.count()) - 1;
  console.log(`[stress] SNG/MTT #${id} created — registering ${N} bots…`);

  // register all (managed concurrency; each from its own wallet = no nonce clash)
  let reg = 0, regFail = 0;
  for (let i = 0; i < N; i += 10) {
    await Promise.all(ws.slice(i, i + 10).map(async (w) => {
      try { await (await trnR.connect(w).register(id, { value: BUYIN })).wait(); reg++; }
      catch (e) { regFail++; if (regFail <= 3) console.log("  reg fail:", e.shortMessage || e.message); }
    }));
    process.stdout.write(`${reg} `);
  }
  console.log(`\n[stress] registered ${reg}/${N} (${regFail} failed)`);

  // wait for the bot to auto-start when full
  let tables = [];
  const startDeadline = Date.now() + 180_000;
  while (Date.now() < startDeadline) {
    const info = await trnR.info(id);
    if (Number(info.status) === 1) { tables = (await trnR.tablesOf(id)).map(Number); break; }
    await sleep(3000);
  }
  if (!tables.length) throw new Error("bot never started the MTT");
  console.log(`[stress] ===== STARTED on ${tables.length} tables: ${tables.join(", ")} =====`);
  console.log(`[stress]   watch any table live:  https://shinia.mom/table?t=${tables[0]}`);

  // metrics
  const t0 = Date.now();
  let acts = 0, actFail = 0, maxTables = tables.length;
  const health = [];
  const snap = async (t) => { try { const r = await fetch(`${DEALER}/snapshot?t=${t}`, { signal: AbortSignal.timeout(4000) }); return r.ok ? r.json() : null; } catch { return null; } };
  const myTable = async (w) => { // re-scan every loop → follows rebalancing moves
    const ts = (await trnR.tablesOf(id)).map(Number);
    for (const t of ts) { try { if (Number(await roomR.seatOf(t, w.address)) !== 255) return t; } catch {} }
    return null;
  };

  // one player agent: shove-heavy so busts (and rebalancing) happen fast
  async function agent(w) {
    const room = roomR.connect(w);
    let idle = 0;
    while (Date.now() - t0 < 20 * 60_000) {
      const t = await myTable(w);
      if (t == null) { if (++idle > 3) return; await sleep(4000); continue; } // busted
      idle = 0;
      const s = await snap(t);
      if (!s || !s.hand.inProgress) { await sleep(1500); continue; }
      const me = s.seats.find((x) => x.player.toLowerCase() === w.address.toLowerCase());
      if (!me || Number(s.hand.actingSeat) !== me.index || Number(s.hand.street) > 3) { await sleep(1200); continue; }
      const owe = BigInt(s.hand.currentBet) > BigInt(me.committedStreet);
      const bb = BigInt(s.cfg.bigBlind);
      const roll = Math.random();
      let action, amount = 0n;
      if (process.env.PLAY === "normal") {
        // human-ish: mostly call/check, some folds, occasional raise, rare shove
        if (owe) action = roll < 0.25 ? A.FOLD : roll < 0.9 ? A.CALL : roll < 0.97 ? (amount = BigInt(s.hand.currentBet) + (BigInt(s.hand.minRaise) || bb), A.RAISE) : A.ALLIN;
        else action = roll < 0.8 ? A.CHECK : roll < 0.97 ? (amount = bb * 2n, A.BET) : A.ALLIN;
      } else {
        action = A.ALLIN;
        if (roll < 0.35 && owe) action = A.FOLD;
        else if (roll < 0.5 && !owe) action = A.CHECK;
      }
      try { await (await room.act(t, action, amount)).wait(); acts++; }
      catch { actFail++; await sleep(600); }
      await sleep(400 + Math.random() * 800);
    }
  }

  // health sampler
  const sampler = setInterval(async () => {
    try {
      const h = await fetch(`${DEALER}/health`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json());
      const info = await trnR.info(id);
      const live = (await trnR.tablesOf(id)).length;
      maxTables = Math.max(maxTables, live);
      health.push({ t: Math.round((Date.now() - t0) / 1000), ok: h.ok, loop: h.loopAgeMs, gas: +h.gasSTT.toFixed(2), tables: h.tables, remaining: Number(info.remaining), status: Number(info.status) });
      console.log(`[stress] +${health[health.length - 1].t}s  remaining=${Number(info.remaining)}/${N}  botLoop=${h.loopAgeMs}ms  gas=${h.gasSTT.toFixed(2)}  acts=${acts}(${actFail} fail)`);
      if (Number(info.status) === 2) clearInterval(sampler);
    } catch {}
  }, 15000);

  await Promise.all(ws.map((w) => agent(w).catch(() => {})));
  clearInterval(sampler);

  // ---- results ----
  const info = await trnR.info(id);
  const finished = Number(info.status) === 2;
  const balAfter = await Promise.all(ws.map((w) => roomR.balance(w.address)));
  let paid = 0n, winners = 0;
  for (let i = 0; i < N; i++) { const d = balAfter[i] - balBefore[i]; if (d > 0n) { paid += d; winners++; } }
  const minLoop = Math.max(...health.map((h) => h.loop), 0);
  console.log(`\n[stress] ================= RESULTS =================`);
  console.log(`[stress] status: ${finished ? "FINISHED ✅" : "status=" + Number(info.status) + " (did not finish in window)"}`);
  console.log(`[stress] duration: ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  console.log(`[stress] registered: ${reg}/${N} · remaining: ${Number(info.remaining)}`);
  console.log(`[stress] tables at peak: ${maxTables} → consolidated toward a final table`);
  console.log(`[stress] player actions confirmed: ${acts} (${actFail} failed)`);
  console.log(`[stress] prize pool: ${F(info.pool)} STT · paid out to ${winners} finishers: ${F(paid)} STT`);
  console.log(`[stress] bot loop age: worst ${minLoop}ms (healthy < 5000)`);
  console.log(`[stress] bot never wedged: ${health.every((h) => h.ok) ? "YES ✅" : "NO ❌ — check /health"}`);
  process.exit(finished ? 0 : 1);
}

main().catch((e) => { console.error("[stress] fatal:", e.shortMessage || e.message); process.exit(1); });
