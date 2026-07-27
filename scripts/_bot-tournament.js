// Bot tournament arena: spins up N HTTP bot-players that play a REAL zkShuffle v2
// tournament against the LIVE dealer bot (shinia.mom/dealer). Each bot does the
// full mental-poker protocol over signed fetch() — keygen+binding, shuffle+proof,
// chain verify, decryption shares, decrypts its own cards — exactly like the
// browser, then bets with a simple push/fold/call strategy. The VPS coordinator
// auto-starts the tournament when it fills, seats players across tables, and
// deals; the bots find their (possibly moving) table each tick.
//
// Run:  BOTS=6 node scripts/_bot-tournament.js         (validate small)
//       BOTS=40 TURBO=1 node scripts/_bot-tournament.js
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("node:crypto");
const { ethers } = require("ethers");
const zkDrv = require("./lib/poker-zk-dealer");

const FOLD = 0, CHECK = 1, CALL = 2, BET = 3, RAISE = 4, ALLIN = 5;
const BASE = process.env.DEALER_URL || "https://shinia.mom/dealer";
const RPC = process.env.RPC_TESTNET || "https://api.infra.testnet.somnia.network";
const N = Number(process.env.BOTS || 6);
const loadAbi = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", "poker", `${n}.sol`, `${n}.json`), "utf8")).abi;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hexS = (b) => "0x" + b.toString(16);

// --- simple preflop hand strength 0..1 from two card indices (rank=idx/4) ---
function strength(cards) {
  if (!cards || cards.length !== 2) return 0.3;
  const r = cards.map((c) => Math.floor(c / 4)); // 0(2)..12(A)
  const s = cards.map((c) => c % 4);
  const hi = Math.max(...r), lo = Math.min(...r);
  let v = (hi + lo) / 24; // 0..1 by rank sum
  if (r[0] === r[1]) v = 0.5 + hi / 26; // pair: 0.5..0.96
  if (s[0] === s[1]) v += 0.05;          // suited
  if (Math.abs(r[0] - r[1]) === 1) v += 0.04; // connected
  return Math.min(1, v);
}

// --- betting decision → {action, amount(chips)} ---
function decide(cards, hand, sh, stack, bb) {
  const cur = BigInt(hand.currentBet), comm = BigInt(sh.committedStreet);
  const toCall = cur > comm ? cur - comm : 0n;
  const st = strength(cards);
  const short = stack <= 12n * bb;
  const R = Math.random();
  if (toCall === 0n) {
    if (st > 0.72 && R < 0.55) return { action: ALLIN };      // value shove
    if (short && st > 0.33) return { action: ALLIN };          // desperate
    if (st > 0.5 && R < 0.25) return { action: ALLIN };        // occasional aggression
    return { action: CHECK };
  }
  if (toCall >= stack) return st > 0.42 ? { action: ALLIN } : { action: FOLD }; // call would be all-in
  if (st > 0.62) return R < 0.45 ? { action: ALLIN } : { action: CALL };
  if (st > 0.36) return { action: CALL };
  if (short && st > 0.3) return { action: ALLIN };
  return { action: FOLD };
}

// ==== HTTP zk browser (crypto over signed fetch to the LIVE bot) ============
class Bot {
  constructor(zk, G1, signer, room, zkd) {
    this.zk = zk; this.G1 = G1; this.signer = signer; this.room = room; this.zkd = zkd;
    this.addr = signer.address; this.t = null;
    this.byDeal = new Map(); this.holes = new Map(); this.pins = new Map(); this.chainOk = new Map(); this.sigs = new Map();
  }
  async sign(dealId) {
    const k = `${this.t}:${dealId}`;
    if (!this.sigs.has(k)) this.sigs.set(k, await this.signer.signMessage(`ShinyPoker:zk:${this.t}:${dealId}`));
    return this.sigs.get(k);
  }
  async post(p, body, timeoutMs = 9000) {
    const r = await fetch(`${BASE}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `${p} ${r.status}`);
    return out;
  }
  secretFor(dealId) { if (!this.byDeal.has(dealId)) { const kg = this.zk.keygen(""); this.byDeal.set(dealId, { x: kg.x, X: kg.X }); } return this.byDeal.get(dealId); }
  deckHash(w) { return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(w))); }
  mayRelease(idx, k, part, street) { if (idx < 2 * k) { const o = Math.floor(idx / 2); return o === part ? street === 4 : true; } const slot = idx - 2 * k; const due = street >= 3 ? 5 : street === 2 ? 4 : street === 1 ? 3 : 0; return slot < due; }
  async verifyChain(dealId, sig, myTurn, myX) {
    if (this.chainOk.has(dealId)) return this.chainOk.get(dealId);
    // LIGHT mode: bots trust the coordinator and skip the (heavy, ~2.4s) full
    // chain re-verification so one observer machine can drive many tables. The
    // security of that check is validated in the test suite + real browsers do
    // it per-user; here it's just about watching hands play.
    if (process.env.LIGHT === "1") { const v = { ok: true }; this.chainOk.set(dealId, v); return v; }
    const ch = await this.post("/zk/chain", { tableId: this.t, dealId, signature: sig });
    if (!ch || !Array.isArray(ch.decks) || ch.decks.length !== ch.k || !Array.isArray(ch.proofs) || ch.proofs.some((p) => !p) || !Array.isArray(ch.pubkeys) || ch.pubkeys.some((p) => !p)) return { ok: false };
    const pubkeys = ch.pubkeys.map(zkDrv.parsePt);
    let X = this.G1.ZERO; for (const P of pubkeys) X = X.add(P);
    if (myX && !pubkeys[myTurn].equals(myX)) return this._bad(dealId);
    const pin = this.pins.get(dealId);
    if (pin && !pin.aggKey.equals(X)) return this._bad(dealId);
    for (let i = 0; i < ch.k; i++) {
      const seat = Number(ch.seats[i]); const a = this.zk.aff(pubkeys[i]);
      let rec; try { rec = ethers.verifyMessage(`ShinyPoker:zk-key:${this.t}:${dealId}:${seat}:0x${a.x.toString(16)}:0x${a.y.toString(16)}`, ch.keySigs[i]).toLowerCase(); } catch { return this._bad(dealId); }
      const occ = await this.room.getSeat(this.t, seat); const player = occ.player.toLowerCase();
      const sk = (await this.room.sessionKeyOf(occ.player)).toLowerCase();
      if (rec !== player && rec !== sk) return this._bad(dealId);
    }
    const decks = [this.zk.initialDeck(this.zk.deckPoints()), ...ch.decks.map((d) => d.map(zkDrv.parseCt))];
    const proofs = ch.proofs.map((w) => this.zk.shuffleProofFromWire(w, zkDrv.parsePt));
    if (pin && this.deckHash(ch.decks[myTurn]) !== pin.outHash) return this._bad(dealId);
    for (let i = 0; i < ch.k; i++) if (!this.zk.verifyShuffle(`SPZK:${dealId}:shuffle:${i}`, decks[i], decks[i + 1], X, proofs[i])) return this._bad(dealId);
    const v = { ok: true }; this.chainOk.set(dealId, v); return v;
  }
  _bad(dealId) { const v = { ok: false }; this.chainOk.set(dealId, v); return v; }
  async step(dealId) {
    if (!dealId) return;
    const sig = await this.sign(dealId);
    // long-poll exactly like the browser agent: park only while the last answer
    // had nothing to do, so this measures the relay's reaction, not our timer
    const key = String(dealId);
    if (!this.etags) this.etags = new Map();
    const parkOn = this.etags.get(key);
    let task;
    try {
      task = await this.post("/zk/task",
        parkOn ? { tableId: this.t, dealId, signature: sig, wait: 5000, etag: parkOn } : { tableId: this.t, dealId, signature: sig },
        parkOn ? 12_000 : 9000);
    } catch { return; }
    if (task.etag !== undefined && !task.do && !task.myHoles) this.etags.set(key, task.etag);
    else this.etags.delete(key);
    if (task.observer || task.phase === "none" || task.participant === undefined) return;
    if (task.do === "key") {
      const kg = this.zk.keygen(task.domain); this.byDeal.set(dealId, { x: kg.x, X: kg.X });
      const a = this.zk.aff(kg.X);
      const keySig = await this.signer.signMessage(`ShinyPoker:zk-key:${this.t}:${dealId}:${task.mySeat}:0x${a.x.toString(16)}:0x${a.y.toString(16)}`);
      await this.post("/zk/key", { tableId: this.t, dealId, signature: sig, X: zkDrv.serPt(kg.X), pokR: zkDrv.serPt(kg.pok.R), pokS: hexS(kg.pok.s), keySig });
    } else if (task.do === "shuffle") {
      const deck = task.deck.map(zkDrv.parseCt), X = zkDrv.parsePt(task.aggKey);
      const out = this.zk.shuffleRemask(deck, X), wire = out.deck.map(zkDrv.serCt);
      this.pins.set(dealId, { outHash: this.deckHash(wire), aggKey: X });
      await this.post("/zk/shuffle", { tableId: this.t, dealId, signature: sig, deck: wire });
      const prf = this.zk.proveShuffle(`SPZK:${dealId}:shuffle:${task.participant}`, deck, out.deck, X, out.secret);
      await this.post("/zk/shuffleproof", { tableId: this.t, dealId, signature: sig, turn: task.participant, proof: this.zk.shuffleProofToWire(prf) });
    } else if (task.do === "shares") {
      const sec = this.secretFor(dealId);
      const verdict = await this.verifyChain(dealId, sig, task.participant, sec.X);
      if (!verdict.ok) return;
      const hand = await this.room.getHand(this.t);
      const street = (hand.inProgress && String(hand.dealId) === String(dealId)) ? Number(hand.street) : -1;
      const items = [];
      for (const idx of task.idxs) {
        if (!this.mayRelease(idx, task.k, task.participant, street)) continue;
        const ct = zkDrv.parseCt(task.cts[idx]);
        const sh = this.zk.decryptionShare(ct, sec.x, this.G1.BASE.multiply(sec.x), task.domains[idx]);
        items.push({ idx, d: zkDrv.serPt(sh.d), R1: zkDrv.serPt(sh.proof.R1), R2: zkDrv.serPt(sh.proof.R2), s: hexS(sh.proof.s) });
      }
      if (items.length) await this.post("/zk/shares", { tableId: this.t, dealId, signature: sig, items });
    }
    if (task.myHoles && !this.holes.has(dealId)) {
      const sec = this.secretFor(dealId); const pubkeys = (task.pubkeys || []).map(zkDrv.parsePt); const cards = [];
      for (const idx of Object.keys(task.myHoles).map(Number).sort((a, b) => a - b)) {
        const h = task.myHoles[idx], ct = zkDrv.parseCt(h.ct), ds = [];
        for (const s of h.shares) { if (!s) continue; ds.push(zkDrv.parsePt(s.d)); }
        const card = this.zk.pointToCard(this.zk.decryptWithShares(ct, ds, sec.x), this.zk.deckPoints());
        if (card >= 0) cards.push(card);
      }
      if (cards.length === 2) this.holes.set(dealId, cards);
    }
  }
}

const RANKS = "23456789TJQKA", SUITS = "cdhs";
const cardStr = (c) => RANKS[Math.floor(c / 4)] + SUITS[c % 4];

async function main() {
  const zk = await import("../frontend/poker/zk-bn254.js");
  const { bn254 } = await import("@noble/curves/bn254");
  zk.init({ bn254, keccak256: ethers.keccak256, randomBytes: (n) => crypto.randomBytes(n) });
  zkDrv.init({ zkModule: zk, bn254 });
  const G1 = bn254.G1.ProjectivePoint;

  const p = new ethers.JsonRpcProvider(RPC);
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "poker-somniaTestnet.json"), "utf8"));
  const deployer = new ethers.Wallet(process.env.POKER_DEPLOYER_KEY, p);
  const master = process.env.POKER_SEED_MASTER_KEY;
  const room = new ethers.Contract(m.addresses.pokerRoom, loadAbi("PokerRoom"), p);
  const zkd = new ethers.Contract(m.addresses.zkTableDealer, loadAbi("ZkTableDealer"), p);
  const trn = new ethers.Contract(m.addresses.pokerTournament, loadAbi("PokerTournament"), deployer);

  console.log(`[arena] ${N} bots vs LIVE dealer ${BASE}\n[arena] room ${m.addresses.pokerRoom}  trn ${m.addresses.pokerTournament}`);

  // 1. bot wallets, funded from the deployer (buy-in + fee + gas headroom)
  const bots = [];
  for (let i = 0; i < N; i++) {
    const w = new ethers.Wallet(ethers.keccak256(ethers.solidityPacked(["bytes32", "string"], [master, `arena-${process.env.WALLET_TAG || "a"}-bot-${i}`])), p);
    bots.push(new Bot(zk, G1, w, room, zkd));
  }
  const buyIn = ethers.parseEther("0.01"), fee = ethers.parseEther("0.001");
  const need = buyIn + fee + ethers.parseEther("0.25"); // + gas
  console.log(`[arena] funding ${N} bots (${ethers.formatEther(need)} STT each)...`);
  let nonce = await deployer.getNonce("latest");
  const fundTxs = [];
  for (const b of bots) {
    const have = await p.getBalance(b.addr);
    if (have < need) fundTxs.push(deployer.sendTransaction({ to: b.addr, value: need - have, nonce: nonce++ }).then((t) => t.wait()));
  }
  await Promise.all(fundTxs);
  console.log(`[arena] funded.`);

  // 2. create a turbo tournament
  const turbo = process.env.TURBO === "1" || N >= 20;
  const params = {
    buyIn, fee, maxPlayers: N, seatsPerTable: 6, startStack: 1000n,
    sbStart: turbo ? 25n : 10n, bbStart: turbo ? 50n : 20n, anteStart: turbo ? 5n : 0n,
    levelDur: turbo ? 90n : 180n, growthBps: 15000, startTime: 0n, // 0 = the coordinator auto-starts the instant it fills
    approvalRequired: false, actionSecs: 20, payoutBps: [5000, 3000, 2000], structure: [], hostBps: 0,
  };
  const idBefore = Number(await trn.count());
  await (await trn.createTournament(params, { value: 0 })).wait();
  const trnId = idBefore; // new tournament id
  console.log(`[arena] created tournament #${trnId} — ${N} max, 6-max tables, ${turbo ? "TURBO" : "normal"} (${params.sbStart}/${params.bbStart} +${params.anteStart} ante, ${params.startStack} chips)`);

  // 3. all bots register (buy in)
  console.log(`[arena] registering ${N} bots...`);
  const regs = [];
  for (const b of bots) regs.push(trn.connect(b.signer).register(trnId, { value: buyIn + fee }).then((t) => t.wait()).catch((e) => console.log(`  reg ${b.addr.slice(0, 8)} failed: ${e.shortMessage || e.message}`)));
  await Promise.all(regs);
  const info0 = await trn.info(trnId);
  console.log(`[arena] registered ${Number(info0.registered)}/${N}. Waiting for the LIVE bot to auto-start + seat + deal...`);

  // 4. find-my-table helper
  const tablesCache = { list: [], at: 0 };
  async function myTable(addr) {
    if (Date.now() - tablesCache.at > 4000) { tablesCache.list = (await trn.tablesOf(trnId)).map(Number); tablesCache.at = Date.now(); }
    for (const t of tablesCache.list) { const s = Number(await room.seatOf(t, addr)); if (s !== 255) return { t, seat: s }; }
    return null;
  }
  async function snapOf(t) {
    try { const r = await fetch(`${BASE}/snapshot?t=${t}`, { signal: AbortSignal.timeout(4000) }); if (!r.ok) return null; return await r.json(); }
    catch { return null; }
  }

  // 5. bot loop — THREE INDEPENDENT LANES, like the browser.
  // This used to be one loop with a 700ms sleep that never touched the pre-deal
  // at all, so the rig itself missed protocol deadlines: bots got struck out and
  // the between-hands gaps it reported were its own, not the product's. A stress
  // test whose slowest part is the test tells you nothing about the thing under
  // test - and here it actively fabricated failures.
  let finished = false;
  async function runBot(b) {
    let mt = null, snap = null;
    const lanes = [
      (async () => { // where am I sitting, and what is on that table
        while (!finished) {
          try {
            mt = await myTable(b.addr);
            if (mt) { b.t = mt.t; snap = await snapOf(mt.t); }
          } catch (_) {}
          await sleep(mt ? 300 : 2500);
        }
      })(),
      (async () => { // live deal
        while (!finished) {
          try { const d = snap && snap.zk && snap.zk.dealId; if (d) await b.step(d); } catch (_) {}
          await sleep(100);
        }
      })(),
      (async () => { // the NEXT hand's setup, which the old rig ignored entirely
        while (!finished) {
          try {
            const d = snap && snap.zk && snap.zk.dealId;
            const nd = snap && snap.zk && snap.zk.next && snap.zk.next.dealId;
            if (nd && nd !== d) await b.step(nd);
          } catch (_) {}
          await sleep(200);
        }
      })(),
      (async () => { // acting
        while (!finished) {
          try {
            if (mt) {
              const h = await room.getHand(mt.t);
              if (h.inProgress && Number(h.actingSeat) === mt.seat && Number(h.street) <= 3) {
                const seat = await room.getSeat(mt.t, mt.seat);
                const sh = await room.getSeatHand(mt.t, mt.seat);
                const cards = b.holes.get(snap && snap.zk ? snap.zk.dealId : null);
                const bb = (await room.getTable(mt.t)).bigBlind;
                const d = decide(cards, h, sh, seat.stack, bb);
                await (await room.connect(b.signer).act(mt.t, d.action, 0)).wait();
                fetch(`${BASE}/poke?t=${mt.t}`, { signal: AbortSignal.timeout(3000) }).catch(() => {});
              }
            }
          } catch (_) {}
          await sleep(250);
        }
      })(),
    ];
    await Promise.all(lanes);
  }

  // 6. monitor + narrate
  const STAT = ["Registering", "Running", "Finished", "Cancelled"];
  async function monitor() {
    let lastRem = -1, lastLine = "";
    while (!finished) {
      await sleep(6000);
      try {
        const info = await trn.info(trnId);
        const status = Number(info.status), remaining = Number(info.remaining), pool = ethers.formatEther(info.pool);
        // chip counts across live tables
        const tables = (await trn.tablesOf(trnId)).map(Number);
        let leaders = [];
        for (const t of tables) {
          const cfg = await room.getTable(t).catch(() => null); if (!cfg) continue;
          for (let s = 0; s < Number(cfg.maxSeats); s++) { const seat = await room.getSeat(t, s); if (seat.occupied && seat.stack > 0n) leaders.push({ a: seat.player, c: Number(seat.stack), t }); }
        }
        leaders.sort((x, y) => y.c - x.c);
        const line = `[trn#${trnId}] ${STAT[status]} | remaining=${remaining} | pool=${pool} STT | tables=${tables.length} | chipLeader=${leaders[0] ? Number(leaders[0].c) + " (…" + leaders[0].a.slice(-4) + ")" : "—"}`;
        if (line !== lastLine) { console.log(line); lastLine = line; }
        if (status === 2 || status === 3) { finished = true; console.log(`\n[arena] 🏁 tournament ${STAT[status]}. Final pool ${pool} STT.`); }
      } catch (_) {}
    }
  }

  await Promise.all([...bots.map(runBot), monitor()]);
  process.exit(0);
}
main().catch((e) => { console.error("[arena] FATAL", e); process.exit(1); });
