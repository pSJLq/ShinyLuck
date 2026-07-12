// Cash-table bot pair + phase-timing observer against the LIVE dealer.
// Purpose: measure WHERE the between-hands seconds actually go (keys/shuffle/
// holeshares/prepare/tx) with fully responsive players, and verify board
// reveals never stall on a healthy table (obs-2 repro).
//
// Two bots (reused arena-b wallets) sit at a cash table and always check/call —
// every hand runs to showdown. A 150ms observer polls /snapshot and logs every
// phase/street/board transition with the snapshot's own build timestamp, then
// prints a per-hand breakdown.
//
// Run:  node scripts/_cash-bots.js            (table 0, 8 hands, then leaves)
// Env:  TABLE=0 HANDS=8 DEALER_URL=... LIGHT=1(skip chain verify)
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("node:crypto");
const { ethers } = require("ethers");
const zkDrv = require("./lib/poker-zk-dealer");

const BASE = process.env.DEALER_URL || "https://shinia.mom/dealer";
const RPC = process.env.RPC_TESTNET || "https://api.infra.testnet.somnia.network";
const TABLE = Number(process.env.TABLE || 0);
const HANDS = Number(process.env.HANDS || 8);
const FOLD = 0, CHECK = 1, CALL = 2;
const loadAbi = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", "poker", `${n}.sol`, `${n}.json`), "utf8")).abi;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hexS = (b) => "0x" + b.toString(16);

// ==== the same HTTP zk client the arena uses (full protocol over fetch) =====
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
  async post(p, body) {
    const r = await fetch(`${BASE}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(9000) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `${p} ${r.status}`);
    return out;
  }
  secretFor(dealId) { if (!this.byDeal.has(dealId)) { const kg = this.zk.keygen(""); this.byDeal.set(dealId, { x: kg.x, X: kg.X }); } return this.byDeal.get(dealId); }
  deckHash(w) { return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(w))); }
  mayRelease(idx, k, part, street) { if (idx < 2 * k) { const o = Math.floor(idx / 2); return o === part ? street === 4 : true; } const slot = idx - 2 * k; const due = street >= 3 ? 5 : street === 2 ? 4 : street === 1 ? 3 : 0; return slot < due; }
  async verifyChain(dealId, sig, myTurn, myX) {
    if (this.chainOk.has(dealId)) return this.chainOk.get(dealId);
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
    let task; try { task = await this.post("/zk/task", { tableId: this.t, dealId, signature: sig }); } catch { return; }
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
      const sec = this.secretFor(dealId); const cards = [];
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

// ==== observer: log every table transition with the snapshot's build ts =====
function startObserver(events) {
  let prev = null, stopped = false;
  (async () => {
    while (!stopped) {
      try {
        const r = await fetch(`${BASE}/snapshot?t=${TABLE}`, { signal: AbortSignal.timeout(4000) });
        if (r.ok) {
          const s = await r.json();
          const cur = {
            ts: s.ts, handId: s.hand.handId, inProgress: s.hand.inProgress, street: s.hand.street,
            board: (s.board || []).length,
            phase: s.zk ? s.zk.phase : "-", keysIn: s.zk ? s.zk.keysIn : 0,
            shuffleTurn: s.zk ? s.zk.shuffleTurn : 0, dealId: s.zk ? s.zk.dealId : null,
            next: s.zk && s.zk.next ? `${s.zk.next.phase}(k:${s.zk.next.keysIn},sh:${s.zk.next.shuffleTurn})` : "-",
          };
          const key = JSON.stringify({ ...cur, ts: 0 });
          if (!prev || prev.key !== key) {
            events.push(cur);
            const d = prev ? ((cur.ts - prev.ts) / 1000).toFixed(1).padStart(6) : "  0.0";
            console.log(`[obs] +${d}s hand=${cur.handId} live=${cur.inProgress ? 1 : 0} street=${cur.street} board=${cur.board} zk=${cur.phase}(k:${cur.keysIn},sh:${cur.shuffleTurn}) next=${cur.next}`);
            prev = { key, ts: cur.ts };
          }
        }
      } catch (_) {}
      await sleep(150);
    }
  })();
  return { stop() { stopped = true; } };
}

async function main() {
  const zk = await import("../frontend/poker/zk-bn254.js");
  const { bn254 } = await import("@noble/curves/bn254");
  zk.init({ bn254, keccak256: ethers.keccak256, randomBytes: (n) => crypto.randomBytes(n) });
  zkDrv.init({ zkModule: zk, bn254 });
  const G1 = bn254.G1.ProjectivePoint;

  const p = new ethers.JsonRpcProvider(RPC);
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "poker-somniaTestnet.json"), "utf8"));
  const master = process.env.POKER_SEED_MASTER_KEY;
  const room = new ethers.Contract(m.addresses.pokerRoom, loadAbi("PokerRoom"), p);
  const zkd = new ethers.Contract(m.addresses.zkTableDealer, loadAbi("ZkTableDealer"), p);
  const wal = (name) => new ethers.Wallet(ethers.keccak256(ethers.solidityPacked(["bytes32", "string"], [master, name])), p);

  // 2 players = arena-b-bot-0/1; top them up from other arena-b leftovers.
  // A bot already seated (or with the buy-in banked) only needs act gas.
  const players = [wal("arena-b-bot-0"), wal("arena-b-bot-1")];
  const ACT_GAS = ethers.parseEther("0.15");
  const donors = Array.from({ length: 16 }, (_, i) => wal(`arena-b-bot-${i + 2}`));
  for (const pl of players) {
    const seated = Number(await room.seatOf(TABLE, pl.address)) !== 255;
    const banked = await room.balance(pl.address);
    const buyInDue = seated ? 0n : (banked >= ethers.parseEther("0.4") ? 0n : ethers.parseEther("0.4") - banked);
    const NEED = ACT_GAS + buyInDue + (buyInDue > 0n ? ethers.parseEther("0.07") : 0n);
    let bal = await p.getBalance(pl.address);
    while (bal < NEED && donors.length) {
      const d = donors.shift();
      const db = await p.getBalance(d.address);
      const give = db - ethers.parseEther("0.005");
      if (give <= 0n) continue;
      await (await d.sendTransaction({ to: pl.address, value: give })).wait();
      bal += give;
      console.log(`[fund] ${ethers.formatEther(give)} STT -> ${pl.address.slice(0, 8)} (now ${ethers.formatEther(bal)})`);
    }
    if (bal < NEED) throw new Error(`cannot fund ${pl.address}`);
  }

  // deposit + sit
  const cfg = await room.getTable(TABLE);
  const buyIn = cfg.minBuyIn;
  const bots = [];
  for (let i = 0; i < players.length; i++) {
    const pl = players[i];
    const bank = await room.balance(pl.address);
    if (bank < buyIn) await (await room.connect(pl).deposit({ value: buyIn - bank })).wait();
    let seat = Number(await room.seatOf(TABLE, pl.address));
    if (seat === 255) {
      // find a free seat
      for (let s = 0; s < Number(cfg.maxSeats); s++) {
        const st = await room.getSeat(TABLE, s);
        if (!st.occupied) { await (await room.connect(pl).sitDown(TABLE, s, buyIn)).wait(); seat = s; break; }
      }
    } else if ((await room.getSeat(TABLE, seat)).sittingOut) {
      // a previous interrupted run got struck into sit-out — come back
      await (await room.connect(pl).setSitOut(TABLE, false)).wait();
      console.log(`[sit] ${pl.address.slice(0, 8)} was sitting out — back in`);
    }
    console.log(`[sit] ${pl.address.slice(0, 8)} seat ${seat} buyIn ${ethers.formatEther(buyIn)}`);
    const b = new Bot(zk, G1, pl, room, zkd);
    b.t = TABLE; b.seat = seat;
    bots.push(b);
  }

  const events = [];
  const obs = startObserver(events);
  console.log(`[run] playing ${HANDS} hands on table ${TABLE} (always check/call)...`);

  const hand0 = Number((await room.getHand(TABLE)).handId);
  let done = false;
  async function runBot(b) {
    while (!done) {
      try {
        const r = await fetch(`${BASE}/snapshot?t=${TABLE}`, { signal: AbortSignal.timeout(4000) });
        const s = r.ok ? await r.json() : null;
        const dealId = s && s.zk && s.zk.dealId ? s.zk.dealId : (s && s.hand.inProgress ? s.hand.dealId : null);
        if (dealId) await b.step(dealId);
        // pre-deal of the next hand (runs during the current hand's showdown)
        const nd = s && s.zk && s.zk.next && s.zk.next.dealId;
        if (nd && nd !== dealId) await b.step(nd);
        const h = await room.getHand(TABLE);
        if (h.inProgress && Number(h.actingSeat) === b.seat && Number(h.street) <= 3) {
          const sh = await room.getSeatHand(TABLE, b.seat);
          const toCall = BigInt(h.currentBet) - BigInt(sh.committedStreet);
          try { await (await room.connect(b.signer).act(TABLE, toCall > 0n ? CALL : CHECK, 0)).wait(); } catch (_) {}
        }
      } catch (_) {}
      await sleep(350); // matches the browser agent's poll cadence
    }
  }
  const runners = bots.map(runBot);

  // stop after HANDS settle
  while (!done) {
    await sleep(2000);
    const h = await room.getHand(TABLE);
    if (Number(h.handId) >= hand0 + HANDS && !h.inProgress) done = true;
  }
  console.log(`[run] ${HANDS} hands complete — leaving the table`);
  await sleep(1500); // let the last settle tick pass
  for (const b of bots) {
    try { await (await room.connect(b.signer).leaveTable(TABLE)).wait(); } catch (e) { console.log(`[leave] ${b.addr.slice(0, 8)}: ${e.shortMessage || e.message}`); }
  }
  obs.stop();

  // ---- report: per-hand phase budget from observed transitions -------------
  console.log("\n==== BETWEEN-HANDS BREAKDOWN (snapshot-ts resolution ~0.9s) ====");
  let lastEnd = null; // ts when previous hand stopped being live
  const mark = {};
  for (const e of events) {
    if (!e.inProgress && lastEnd === null) continue;
    if (!e.inProgress) {
      if (mark.phase !== e.phase || (e.phase === "keys" && !mark.keysAt)) {
        if (e.phase === "keys" && !mark.keysAt) mark.keysAt = e.ts;
        if (e.phase === "shuffle" && !mark.shufAt) mark.shufAt = e.ts;
        if (e.phase === "holeshares" && !mark.holeAt) mark.holeAt = e.ts;
        if (e.phase === "prepare" && !mark.prepAt) mark.prepAt = e.ts;
        mark.phase = e.phase;
      }
    }
    if (e.inProgress && lastEnd !== null && mark.keysAt) {
      const f = (a, b) => (a && b ? ((b - a) / 1000).toFixed(1) : "?");
      console.log(`hand ${e.handId}: dead->keys ${f(lastEnd, mark.keysAt)}s | keys ${f(mark.keysAt, mark.shufAt)}s | shuffle+proofs ${f(mark.shufAt, mark.holeAt)}s | holeshares ${f(mark.holeAt, mark.prepAt)}s | prepare->live ${f(mark.prepAt, e.ts)}s | TOTAL ${f(lastEnd, e.ts)}s`);
      lastEnd = null;
      for (const k of Object.keys(mark)) delete mark[k];
    }
    if (!e.inProgress && events[events.indexOf(e) - 1] && events[events.indexOf(e) - 1].inProgress) lastEnd = e.ts;
  }
  // simpler: recompute lastEnd transitions
  console.log("\n(raw transitions logged above; exiting)");
  process.exit(0);
}
main().catch((e) => { console.error("[cash] FATAL", e); process.exit(1); });
