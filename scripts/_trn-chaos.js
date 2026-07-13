// Tournament CHAOS harness: N zk bot-players + scripted fault injection against
// the LIVE dealer, answering the launch-audit questions EMPIRICALLY:
// zombies (closed tab) mid-hand / on their turn / after an all-in, a whole
// table going dark, revive (sit back in), registration edges, rebalancing with
// dead seats, the never-finishing stall, pre-deal in tournaments, rate limits.
//
// Run:  SCENARIO=A BOTS=15 WALLET_TAG=c LIGHT=1 node scripts/_trn-chaos.js
//       SCENARIO=B BOTS=15 WALLET_TAG=d LIGHT=1 node scripts/_trn-chaos.js
//
// SCENARIO A (faults + full finish):
//   - bot 3 goes ZOMBIE (total silence) once its table has played 2 hands
//   - bot 5 goes ZOMBIE the moment its first ALL-IN lands on-chain
//   - bot 3 REVIVES (setSitOut false) 150s later and resumes playing
//   - everyone else plays to the finish; final placings/prizes verified
// SCENARIO B (the stall):
//   - pre-start: 16th registration must revert; unregister must refund
//   - once running, EVERY bot at bot#0's table goes dark after 2 hands there
//   - when remaining <= 5, every live bot except ONE goes dark
//   - expected today (pre-fix): Running forever with remaining > 1 — proven
//     by 4 minutes of zero progress; the idle-forfeit redeploy fixes it.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("node:crypto");
const { ethers } = require("ethers");
const zkDrv = require("./lib/poker-zk-dealer");

const FOLD = 0, CHECK = 1, CALL = 2, ALLIN = 5;
const BASE = process.env.DEALER_URL || "https://shinia.mom/dealer";
const RPC = process.env.RPC_TESTNET || "https://api.infra.testnet.somnia.network";
const N = Number(process.env.BOTS || 15);
const SCENARIO = process.env.SCENARIO || "A";
const TAG = process.env.WALLET_TAG || "c";
const L = (m) => console.log(`[chaos:${SCENARIO}] +${((Date.now() - T0) / 1000).toFixed(0)}s ${m}`);
let T0 = Date.now();
let http429 = 0;

const loadAbi = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", "poker", `${n}.sol`, `${n}.json`), "utf8")).abi;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hexS = (b) => "0x" + b.toString(16);

function strength(cards) {
  if (!cards || cards.length !== 2) return 0.3;
  const r = cards.map((c) => Math.floor(c / 4)), s = cards.map((c) => c % 4);
  const hi = Math.max(...r), lo = Math.min(...r);
  let v = (hi + lo) / 24;
  if (r[0] === r[1]) v = 0.5 + hi / 26;
  if (s[0] === s[1]) v += 0.05;
  if (Math.abs(r[0] - r[1]) === 1) v += 0.04;
  return Math.min(1, v);
}
function decide(cards, hand, sh, stack, bb) {
  const cur = BigInt(hand.currentBet), comm = BigInt(sh.committedStreet);
  const toCall = cur > comm ? cur - comm : 0n;
  const st = strength(cards), short = stack <= 12n * bb, R = Math.random();
  if (toCall === 0n) {
    if (st > 0.72 && R < 0.55) return { action: ALLIN };
    if (short && st > 0.33) return { action: ALLIN };
    if (st > 0.5 && R < 0.25) return { action: ALLIN };
    return { action: CHECK };
  }
  if (toCall >= stack) return st > 0.42 ? { action: ALLIN } : { action: FOLD };
  if (st > 0.62) return R < 0.45 ? { action: ALLIN } : { action: CALL };
  if (st > 0.36) return { action: CALL };
  if (short && st > 0.3) return { action: ALLIN };
  return { action: FOLD };
}

// ==== HTTP zk client (same protocol as the browser agent) ====================
class Bot {
  constructor(zk, G1, signer, room, zkd, idx) {
    this.zk = zk; this.G1 = G1; this.signer = signer; this.room = room; this.zkd = zkd; this.idx = idx;
    this.addr = signer.address; this.t = null; this.zombie = false; this.zombieAfterAllin = false;
    this.byDeal = new Map(); this.holes = new Map(); this.pins = new Map(); this.chainOk = new Map(); this.sigs = new Map();
    this.handsSeen = new Set(); this.acted = 0;
  }
  async sign(dealId) {
    const k = `${this.t}:${dealId}`;
    if (!this.sigs.has(k)) this.sigs.set(k, await this.signer.signMessage(`ShinyPoker:zk:${this.t}:${dealId}`));
    return this.sigs.get(k);
  }
  async post(p, body) {
    const r = await fetch(`${BASE}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(9000) });
    if (r.status === 429) { http429++; throw new Error("429"); }
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
  T0 = Date.now();
  L(`${N} bots (tag arena-${TAG}) vs ${BASE} | trn ${m.addresses.pokerTournament}`);

  // wallets + funding (one extra wallet for the overflow-registration probe)
  const bots = [];
  for (let i = 0; i < N; i++) {
    const w = new ethers.Wallet(ethers.keccak256(ethers.solidityPacked(["bytes32", "string"], [master, `arena-${TAG}-bot-${i}`])), p);
    bots.push(new Bot(zk, G1, w, room, zkd, i));
  }
  const extra = new ethers.Wallet(ethers.keccak256(ethers.solidityPacked(["bytes32", "string"], [master, `arena-${TAG}-bot-${N}`])), p);
  const buyIn = ethers.parseEther("0.01"), fee = ethers.parseEther("0.001");
  const need = buyIn + fee + ethers.parseEther("0.22");
  // sequential sends — two chaos scenarios fund from the SAME deployer in
  // parallel, so hand-assigned nonces collide; let the provider pick each one
  for (const b of [...bots.map((x) => ({ addr: x.addr })), { addr: extra.address }]) {
    const have = await p.getBalance(b.addr);
    if (have < need) {
      for (let tries = 0; ; tries++) {
        try { await (await deployer.sendTransaction({ to: b.addr, value: need - have })).wait(); break; }
        catch (e) { if (tries >= 4) throw e; await sleep(800 + Math.random() * 1200); }
      }
    }
  }
  L(`funded ${N + 1} wallets`);

  // create the tournament (turbo, auto-start on fill)
  const params = {
    buyIn, fee, maxPlayers: N, seatsPerTable: 6, startStack: 1000n,
    sbStart: 25n, bbStart: 50n, anteStart: 5n, levelDur: 90n, growthBps: 15000,
    startTime: 0n, approvalRequired: false, actionSecs: 20,
    payoutBps: [5000, 3000, 2000], structure: [], hostBps: 0,
  };
  const rc = await (await trn.createTournament(params, { value: 0 })).wait();
  const created = rc.logs.map((lg) => { try { return trn.interface.parseLog(lg); } catch { return null; } }).find((e) => e && e.name === "TournamentCreated");
  const trnId = Number(created.args.id);
  L(`created trn #${trnId} (${N} max, turbo 25/50+5, 1000 chips, 90s levels)`);

  // register all but one, run the registration edge probes, then fill
  const regs = [];
  for (const b of bots.slice(0, N - 1)) regs.push(trn.connect(b.signer).register(trnId, { value: buyIn + fee }).then((t) => t.wait()));
  await Promise.all(regs);

  if (SCENARIO === "B") {
    // Q16: unregister refunds buy-in + fee
    const b0 = bots[0];
    const before = await p.getBalance(b0.addr);
    await (await trn.connect(b0.signer).unregister(trnId)).wait();
    const after = await p.getBalance(b0.addr);
    L(`Q16 unregister: refund ≈ ${ethers.formatEther(after - before)} STT (expected ~0.011 minus gas) — ${after > before ? "REFUNDED ✓" : "NO REFUND ✗"}`);
    await (await trn.connect(b0.signer).register(trnId, { value: buyIn + fee })).wait();
    L(`Q16b re-register after unregister: OK ✓`);
  }

  // last seat + Q17 overflow probe racing it
  await (await trn.connect(bots[N - 1].signer).register(trnId, { value: buyIn + fee })).wait();
  try {
    await (await trn.connect(extra).register(trnId, { value: buyIn + fee })).wait();
    L(`Q17 overflow registration: ACCEPTED ✗ (16th of ${N}-max got in!)`);
  } catch (e) {
    L(`Q17 overflow registration: REVERTED ✓ (${(e.shortMessage || e.message).slice(0, 60)})`);
  }
  L(`registered ${N}/${N} — waiting for auto-start`);

  // ---- table tracking helpers ----------------------------------------------
  const tablesCache = { list: [], at: 0 };
  async function trnTables() {
    if (Date.now() - tablesCache.at > 4000) { tablesCache.list = (await trn.tablesOf(trnId)).map(Number); tablesCache.at = Date.now(); }
    return tablesCache.list;
  }
  async function myTable(addr) {
    for (const t of await trnTables()) { const s = Number(await room.seatOf(t, addr)); if (s !== 255) return { t, seat: s }; }
    return null;
  }
  const snapCache = new Map(); // t -> {at, snap}
  async function snapOf(t) {
    const c = snapCache.get(t);
    if (c && Date.now() - c.at < 900) return c.snap;
    try {
      const r = await fetch(`${BASE}/snapshot?t=${t}`, { signal: AbortSignal.timeout(4000) });
      if (r.status === 429) { http429++; return c ? c.snap : null; }
      if (!r.ok) return c ? c.snap : null;
      const snap = await r.json();
      snapCache.set(t, { at: Date.now(), snap });
      return snap;
    } catch { return c ? c.snap : null; }
  }
  const tableHands = new Map(); // t -> Set(handIds seen live)

  // ---- fault schedule -------------------------------------------------------
  let darkTable = null;          // scenario B: the table that goes dark
  let stallArmed = false;        // scenario B: endgame mass-zombie fired
  let reviveAt = 0;              // A/C: when the briefly-disconnected bot returns
  let reviveBot = null;
  const zombieLog = [];

  function makeZombie(b, why) {
    if (b.zombie) return;
    b.zombie = true;
    zombieLog.push({ i: b.idx, why, at: Date.now() });
    L(`💀 bot ${b.idx} (${b.addr.slice(0, 8)}) ZOMBIE — ${why}`);
  }

  // ---- bot loop --------------------------------------------------------------
  let finished = false;
  async function runBot(b) {
    while (!finished) {
      try {
        if (b.zombie) { await sleep(1500); continue; } // a closed tab does nothing at all
        const mt = await myTable(b.addr);
        if (!mt) { await sleep(2500); continue; }
        b.t = mt.t;
        const snap = await snapOf(mt.t);
        const dealId = snap && snap.zk && snap.zk.dealId ? snap.zk.dealId : null;
        if (dealId) await b.step(dealId);
        const nd = snap && snap.zk && snap.zk.next && snap.zk.next.dealId;
        if (nd && nd !== dealId && !b.zombie) await b.step(nd); // pre-deal (Q14)
        const h = await room.getHand(mt.t);
        if (h.inProgress) {
          let set = tableHands.get(mt.t);
          if (!set) { set = new Set(); tableHands.set(mt.t, set); }
          set.add(Number(h.handId));
          // scenario A faults keyed on table hand count
          if (SCENARIO === "A" && b.idx === 3 && !b.revived && set.size >= 2 && !b.zombie) {
            makeZombie(b, "mid-hand walk-away (Q1/Q2/Q4)"); reviveBot = b; reviveAt = Date.now() + 150_000; continue;
          }
          // scenario C (post-fix validation, 3 bots, single table)
          if (SCENARIO === "C" && b.idx === 2 && set.size >= 1 && !b.zombie) {
            makeZombie(b, "mid-hand walk-away — should be timeout-folded, struck, then FORFEITED (Q1/Q2/Q4/fix)"); continue;
          }
          if (SCENARIO === "C" && b.idx === 1 && !b.revived && set.size >= 2 && !b.zombie) {
            makeZombie(b, "brief disconnect — will sit back in (Q18)"); reviveBot = b; reviveAt = Date.now() + 60_000; continue;
          }
          if (SCENARIO === "B" && darkTable === null && set.size >= 2) {
            darkTable = mt.t;
            L(`🌑 table ${darkTable} goes DARK — every bot seated there stops responding (Q5/Q7/Q12)`);
            for (const bb of bots) { const bt = await myTable(bb.addr).catch(() => null); if (bt && bt.t === darkTable) makeZombie(bb, "whole-table blackout"); }
            if (b.zombie) continue;
          }
        }
        if (h.inProgress && Number(h.actingSeat) === mt.seat && Number(h.street) <= 3) {
          const seat = await room.getSeat(mt.t, mt.seat);
          const sh = await room.getSeatHand(mt.t, mt.seat);
          const cards = dealId ? b.holes.get(dealId) : null;
          const bb = (await room.getTable(mt.t)).bigBlind;
          const d = decide(cards, h, sh, seat.stack, bb);
          try {
            await (await room.connect(b.signer).act(mt.t, d.action, 0)).wait();
            b.acted++;
            if (SCENARIO === "A" && b.idx === 5 && d.action === ALLIN && !b.zombie) {
              makeZombie(b, "walked away right after an ALL-IN landed (Q3)");
            }
          } catch (_) {}
        }
      } catch (_) {}
      await sleep(800);
    }
  }

  // scenario A: revive bot 3 (Q18)
  async function reviver() {
    while (!finished) {
      await sleep(3000);
      if (reviveBot && reviveAt && Date.now() > reviveAt) {
        const b = reviveBot;
        reviveAt = 0;
        const mt = await myTable(b.addr).catch(() => null);
        if (!mt) { L(`Q18 revive: bot ${b.idx} no longer seated (busted/forfeited while away)`); b.revived = true; continue; }
        try {
          await (await room.connect(b.signer).setSitOut(mt.t, false)).wait();
          b.zombie = false; b.revived = true;
          L(`💚 Q18: bot ${b.idx} SAT BACK IN at table ${mt.t} — resuming play`);
        } catch (e) { L(`Q18 revive setSitOut failed: ${e.shortMessage || e.message}`); b.revived = true; }
      }
      // scenario B endgame: leave exactly ONE live bot among the survivors
      if (SCENARIO === "B" && !stallArmed) {
        try {
          const info = await trn.info(trnId);
          if (Number(info.status) === 1 && Number(info.remaining) <= 5) {
            stallArmed = true;
            const live = bots.filter((x) => !x.zombie);
            for (const b of live.slice(1)) makeZombie(b, "endgame blackout — engineering the stall (Q6)");
            L(`🧊 stall armed: 1 live bot (${live[0] ? live[0].idx : "?"}) vs sat-out chip stacks. If the design holds, remaining never reaches 1.`);
          }
        } catch (_) {}
      }
    }
  }

  // ---- monitor ---------------------------------------------------------------
  const STAT = ["Registering", "Running", "Finished", "Cancelled"];
  let stallProof = 0;
  async function monitor() {
    let lastLine = "", lastRemaining = -1, lastChangeAt = Date.now();
    while (!finished) {
      await sleep(5000);
      try {
        const info = await trn.info(trnId);
        const status = Number(info.status), remaining = Number(info.remaining);
        const tables = await trnTables();
        let sit = 0, live = 0, frozenChips = 0;
        for (const t of tables) {
          const cfg = await room.getTable(t).catch(() => null); if (!cfg) continue;
          for (let s = 0; s < Number(cfg.maxSeats); s++) {
            const seat = await room.getSeat(t, s);
            if (!seat.occupied) continue;
            if (seat.sittingOut) { sit++; frozenChips += Number(seat.stack); } else live++;
          }
        }
        const line = `[trn#${trnId}] ${STAT[status]} rem=${remaining} tables=${tables.length} liveSeats=${live} satOut=${sit} frozenChips=${frozenChips} 429s=${http429}`;
        if (line !== lastLine) { L(line); lastLine = line; }
        if (remaining !== lastRemaining) { lastRemaining = remaining; lastChangeAt = Date.now(); }
        // stall verdict: engineered endgame + no progress for 4 minutes
        if (SCENARIO === "B" && stallArmed && status === 1 && remaining > 1 && Date.now() - lastChangeAt > 240_000) {
          L(`Q6 VERDICT: STALL CONFIRMED — Running, remaining=${remaining}, ${sit} sat-out seats holding ${frozenChips} chips, no progress in 4min. Tournament can NEVER finish without an idle-forfeit.`);
          finished = true; stallProof = remaining;
        }
        if (status === 2 || status === 3) {
          finished = true;
          L(`🏁 ${STAT[status]}. pool=${ethers.formatEther(info.pool)} STT`);
        }
      } catch (_) {}
    }
  }

  await Promise.all([...bots.map(runBot), reviver(), monitor()]);

  // ---- final forensics --------------------------------------------------------
  L(`--- FINAL: per-bot room balances (prizes land here) ---`);
  for (const b of bots) {
    const bal = await room.balance(b.addr);
    if (bal > 0n) L(`bot ${b.idx} ${b.addr.slice(0, 8)} room.balance=${ethers.formatEther(bal)} STT ${b.zombie ? "(zombie)" : ""}`);
  }
  const info = await trn.info(trnId);
  L(`trn #${trnId} final: ${STAT[Number(info.status)]} remaining=${Number(info.remaining)} | zombies=${zombieLog.length} | 429s=${http429}`);
  process.exit(0);
}
main().catch((e) => { console.error(`[chaos:${SCENARIO}] FATAL`, e); process.exit(1); });
