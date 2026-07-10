// zkShuffle v2 coordinator for the ShinyPoker dealer bot. Drives the per-hand
// mental-poker protocol against ZkTableDealer + PokerRoom v3, with the PLAYERS'
// browsers doing all the actual cryptography — this module only relays,
// verifies and posts. It never holds key material, so it cannot see a card.
//
// Phase machine per table (between hands, happy path ~3-6s):
//   keys        every eligible seat sends a fresh per-hand pubkey + Schnorr PoK
//   shuffle     sequential relay: each participant shuffles+remasks the 52-ct deck
//   holeshares  everyone posts decryption shares for the OTHERS' hole cts
//               (board shares are NOT pre-collected — the bot must never be able
//               to decrypt the board early; own-hole shares stay with the owner)
//   prepare     prepareDeal on-chain (PoKs verified, deck committed) → room.startHand
//   live        betting runs on the unchanged engine; the bot requests board
//               shares street by street, own-hole shares at showdown, posts the
//               verified reveals, and settles.
//
// Liveness: a seat that misses a phase deadline BEFORE money is in gets a
// sitOutIdle strike and the deal restarts without it. A seat that withholds
// shares MID-hand triggers cancelHandPenalized — its committed chips are
// forfeited to the other players (ragequit is never cheaper than folding).
//
// Every client artifact is verified here (PoK, CP share proofs, deck shape)
// before being accepted, and again by the CONTRACT before any card is trusted.
//
// Pure of process/HTTP setup: the runner wires these handlers to endpoints and
// calls tickZkTable on its poll loop. Unit-drivable (see ZkZealerDriver tests).

const fs = require("fs");
const path = require("path");

let zk = null; // zk-bn254.js module (init'd by the runner)
let G1 = null; // noble bn254 G1 ProjectivePoint

function init({ zkModule, bn254 }) {
  zk = zkModule;
  G1 = bn254.G1.ProjectivePoint;
}

const STREET = { PREFLOP: 0, FLOP: 1, TURN: 2, RIVER: 3, SHOWDOWN: 4, IDLE: 255 };
const boardCountForStreet = (s) => (s === STREET.FLOP ? 3 : s === STREET.TURN ? 4 : s === STREET.RIVER || s === STREET.SHOWDOWN ? 5 : 0);

// ---- wire encoding: points as {x,y} hex strings --------------------------
const hex = (b) => "0x" + b.toString(16);
function serPt(P) {
  const a = zk.aff(P);
  return { x: hex(a.x), y: hex(a.y) };
}
function parsePt(o) {
  const P = G1.fromAffine({ x: BigInt(o.x), y: BigInt(o.y) });
  P.assertValidity(); // rejects off-curve garbage
  return P;
}
const serCt = (ct) => ({ A: serPt(ct.A), B: serPt(ct.B) });
const parseCt = (o) => ({ A: parsePt(o.A), B: parsePt(o.B) });
// contract tuple shape
const cPt = (P) => { const a = zk.aff(P); return { x: a.x, y: a.y }; };

const keyDomain = (d, s) => `SPZK:${d}:key:${s}`;
const shareDomain = (d, c, s) => `SPZK:${d}:share:${c}:${s}`;

function newZkState() {
  return new Map(); // tableId -> session
}

// ---- eligibility (must MATCH PokerRoom._eligibleSeats exactly) ------------
async function eligibleSeats(room, tableId, maxSeats) {
  const nextHand = Number(await room.handCounter(tableId)) + 1;
  const out = [];
  for (let s = 0; s < maxSeats; s++) {
    const seat = await room.getSeat(tableId, s);
    if (seat.occupied && !seat.sittingOut && seat.stack > 0n && Number(seat.sitInHandId) <= nextHand) {
      out.push({ seat: s, addr: seat.player.toLowerCase() });
    }
  }
  return { nextHand, elig: out };
}

function newSession(tableId, elig, nextHand, opts) {
  const dealId = Date.now() * 1000 + (tableId % 997) + Math.floor(Math.random() * 997) * 1_000_000_000_000;
  const sess = {
    tableId,
    dealId,
    forHand: nextHand,
    phase: "keys",
    k: elig.length,
    seats: elig.map((e) => e.seat), // ascending — participant i sits at seats[i]
    addrs: elig.map((e) => e.addr),
    part: new Map(elig.map((e, i) => [e.addr, i])),
    pubkeys: new Array(elig.length).fill(null), // {X, pok} noble points
    decks: [zk.initialDeck(zk.deckPoints())], // decks[i] = deck after i shuffles
    shuffleTurn: 0,
    deck: null, // final 52 cts once every participant shuffled
    shares: new Map(), // cardIdx -> Map(participant -> {d, R1, R2, s})  (verified)
    prepared: false,
    started: false,
    boardRevealed: 0,
    holesRevealed: new Set(),
    markedReady: false,
    showdownAt: 0,
    phaseAt: Date.now(),
    deadlineAt: Date.now() + (opts.keysMs ?? 10_000),
  };
  return sess;
}

const inPlayCount = (k) => 2 * k + 5;
function holeIdxsOf(part, k) { return [2 * part, 2 * part + 1]; }
function boardIdx(k, slot) { return 2 * k + slot; }

function shareCount(sess, idx) {
  const m = sess.shares.get(idx);
  return m ? m.size : 0;
}
function haveAllShares(sess, idx) { return shareCount(sess, idx) === sess.k; }
function haveOthersShares(sess, idx, ownerPart) {
  const m = sess.shares.get(idx);
  if (!m) return false;
  for (let i = 0; i < sess.k; i++) if (i !== ownerPart && !m.has(i)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// HTTP handlers (the runner authenticates the caller first: signature →
// sessionOwnerOf → seat-owner address, exactly like the v1 /holes endpoint).
// Each returns a JSONable object or throws with a message.
// ---------------------------------------------------------------------------

/// What should this client do right now? Also carries the relayed shares the
/// client needs to decrypt its OWN hole cards.
function zkTask(state, tableId, addrLower) {
  const sess = state.get(tableId);
  if (!sess) return { phase: "none" };
  const part = sess.part.get(addrLower);
  if (part === undefined) return { phase: sess.phase, dealId: String(sess.dealId), observer: true };
  const base = { phase: sess.phase, dealId: String(sess.dealId), participant: part, k: sess.k, seats: sess.seats, mySeat: sess.seats[part] };

  if (sess.phase === "keys") {
    if (!sess.pubkeys[part]) return { ...base, do: "key", domain: keyDomain(sess.dealId, part) };
    return base;
  }
  if (sess.phase === "shuffle") {
    if (sess.shuffleTurn === part) {
      return { ...base, do: "shuffle", first: sess.shuffleTurn === 0, deck: sess.decks[sess.shuffleTurn].map(serCt), aggKey: serPt(sess.aggKey) };
    }
    return base;
  }
  if (sess.phase === "holeshares" || sess.phase === "prepare" || sess.phase === "live") {
    const need = [];
    // others' hole cards I still owe shares for (pre-collected at deal time)
    for (let j = 0; j < sess.k; j++) {
      if (j === part) continue;
      for (const idx of holeIdxsOf(j, sess.k)) {
        const m = sess.shares.get(idx);
        if (!m || !m.has(part)) need.push(idx);
      }
    }
    // board slots the bot is currently requesting (street closed)
    for (const idx of sess.boardNeeded ?? []) {
      const m = sess.shares.get(idx);
      if (!m || !m.has(part)) need.push(idx);
    }
    // showdown: my own hole cards (only once the hand is actually at showdown)
    if (sess.ownNeeded && sess.ownNeeded.has(part)) {
      for (const idx of holeIdxsOf(part, sess.k)) {
        const m = sess.shares.get(idx);
        if (!m || !m.has(part)) need.push(idx);
      }
    }
    const out = { ...base };
    if (sess.pubkeys && sess.pubkeys.every(Boolean)) out.pubkeys = sess.pubkeys.map((p) => serPt(p.X));
    if (need.length && sess.deck) {
      out.do = "shares";
      out.idxs = need;
      out.cts = {};
      for (const idx of need) out.cts[idx] = serCt(sess.deck[idx]);
      out.domains = {};
      for (const idx of need) out.domains[idx] = shareDomain(sess.dealId, idx, part);
    }
    // relay: the OTHERS' shares for my own two cards, so I can decrypt locally.
    // Full CP proofs ride along — the client re-verifies each share against its
    // sender's key instead of trusting this relay.
    if (sess.deck) {
      const mine = {};
      let complete = true;
      for (const idx of holeIdxsOf(part, sess.k)) {
        if (!haveOthersShares(sess, idx, part)) { complete = false; break; }
        const m = sess.shares.get(idx);
        mine[idx] = {
          ct: serCt(sess.deck[idx]),
          shares: Array.from({ length: sess.k }, (_, i) => (i === part ? null : {
            i, d: serPt(m.get(i).d),
            proof: { R1: serPt(m.get(i).R1), R2: serPt(m.get(i).R2), s: hex(m.get(i).s) },
          })),
        };
      }
      if (complete) out.myHoles = mine;
    }
    return out;
  }
  return base;
}

/// Client posts its per-hand pubkey + Schnorr PoK.
function zkPostKey(state, tableId, addrLower, body) {
  const sess = state.get(tableId);
  if (!sess || sess.phase !== "keys") throw new Error("not collecting keys");
  if (String(sess.dealId) !== String(body.dealId)) throw new Error("stale dealId");
  const part = sess.part.get(addrLower);
  if (part === undefined) throw new Error("not in this deal");
  if (sess.pubkeys[part]) return { ok: true }; // idempotent
  const X = parsePt(body.X);
  const pok = { R: parsePt(body.pokR), s: BigInt(body.pokS) };
  if (!zk.verifyPok(keyDomain(sess.dealId, part), X, pok)) throw new Error("bad key proof");
  sess.pubkeys[part] = { X, pok };
  return { ok: true };
}

/// Client returns the deck it just shuffled+remasked (its turn only).
function zkPostShuffle(state, tableId, addrLower, body) {
  const sess = state.get(tableId);
  if (!sess || sess.phase !== "shuffle") throw new Error("not shuffling");
  if (String(sess.dealId) !== String(body.dealId)) throw new Error("stale dealId");
  const part = sess.part.get(addrLower);
  if (part !== sess.shuffleTurn) throw new Error("not your shuffle turn");
  if (!Array.isArray(body.deck) || body.deck.length !== 52) throw new Error("bad deck");
  const deck = body.deck.map(parseCt); // validates every point on-curve
  sess.decks.push(deck);
  sess.shuffleTurn += 1;
  sess.deadlineAt = Date.now() + 8_000;
  if (sess.shuffleTurn === sess.k) {
    sess.deck = deck;
    sess.phase = "holeshares";
    sess.phaseAt = Date.now();
    sess.deadlineAt = Date.now() + 10_000;
  }
  return { ok: true };
}

/// Client posts decryption shares (+CP proofs) for a set of card indices.
/// Accepted for: others' holes (pre-collect), requested board slots, own holes
/// at showdown. Every proof is verified against the sender's pubkey.
function zkPostShares(state, tableId, addrLower, body) {
  const sess = state.get(tableId);
  if (!sess || !sess.deck) throw new Error("no deck yet");
  if (String(sess.dealId) !== String(body.dealId)) throw new Error("stale dealId");
  const part = sess.part.get(addrLower);
  if (part === undefined) throw new Error("not in this deal");
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > inPlayCount(sess.k)) throw new Error("bad items");
  const X = sess.pubkeys[part].X;
  let accepted = 0;
  for (const item of body.items) {
    const idx = Number(item.idx);
    if (!(idx >= 0 && idx < inPlayCount(sess.k))) throw new Error("bad idx");
    // own-hole shares are only accepted once the hand reached showdown — the
    // bot must never hold a full share set for a live player's cards earlier
    const own = holeIdxsOf(part, sess.k).includes(idx);
    if (own && !(sess.ownNeeded && sess.ownNeeded.has(part))) throw new Error("own shares not needed yet");
    let m = sess.shares.get(idx);
    if (m && m.has(part)) continue; // idempotent
    const share = { d: parsePt(item.d), proof: { R1: parsePt(item.R1), R2: parsePt(item.R2), s: BigInt(item.s) } };
    if (!zk.verifyShare(sess.deck[idx], X, share, shareDomain(sess.dealId, idx, part))) throw new Error(`bad share proof for idx ${idx}`);
    if (!m) { m = new Map(); sess.shares.set(idx, m); }
    m.set(part, { d: share.d, R1: share.proof.R1, R2: share.proof.R2, s: share.proof.s });
    accepted++;
  }
  return { ok: true, accepted };
}

// ---------------------------------------------------------------------------
// Contract call assembly
// ---------------------------------------------------------------------------
function contractShares(sess, idx) {
  const m = sess.shares.get(idx);
  const d = [], R1 = [], R2 = [], s = [];
  for (let i = 0; i < sess.k; i++) {
    const sh = m.get(i);
    d.push(cPt(sh.d)); R1.push(cPt(sh.R1)); R2.push(cPt(sh.R2)); s.push(sh.s);
  }
  return { d, R1, R2, s };
}
function decryptCard(sess, idx) {
  const m = sess.shares.get(idx);
  const ds = Array.from({ length: sess.k }, (_, i) => m.get(i).d);
  return zk.pointToCard(zk.decryptWithShares(sess.deck[idx], ds, null), zk.deckPoints());
}

// ---- persistence: in-play cts must survive a bot restart (chain stores only
// their hashes) or a live hand becomes unservable → cancel. Tiny JSON per table.
function persistPath(dir, tableId) { return path.join(dir, `zk-table-${tableId}.json`); }
function persistSession(dir, sess) {
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const inPlay = sess.deck.slice(0, inPlayCount(sess.k)).map(serCt);
    fs.writeFileSync(persistPath(dir, sess.tableId), JSON.stringify({
      dealId: String(sess.dealId), forHand: sess.forHand, k: sess.k, seats: sess.seats, addrs: sess.addrs,
      pubkeys: sess.pubkeys.map((p) => serPt(p.X)), inPlay,
    }));
  } catch (_) {}
}
function dropPersisted(dir, tableId) {
  if (!dir) return;
  try { fs.unlinkSync(persistPath(dir, tableId)); } catch (_) {}
}

/// Rebuild a live session skeleton after a restart: seats/pubkeys/cts from the
/// persisted file (verified against the on-chain ct hashes); shares re-arrive
/// from the clients (their per-hand secrets live in their sessionStorage).
async function recoverSession(zkd, dir, tableId, dealIdOnChain) {
  if (!dir) return null;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(persistPath(dir, tableId), "utf8")); } catch (_) { return null; }
  if (String(raw.dealId) !== String(dealIdOnChain)) return null;
  const sess = {
    tableId, dealId: BigInt(raw.dealId) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(raw.dealId) : raw.dealId,
    forHand: raw.forHand, phase: "live", k: raw.k, seats: raw.seats, addrs: raw.addrs,
    part: new Map(raw.addrs.map((a, i) => [a, i])),
    pubkeys: raw.pubkeys.map((p) => ({ X: parsePt(p) })),
    decks: [], shuffleTurn: raw.k,
    deck: raw.inPlay.map(parseCt), // NOTE: only in-play indices are usable post-restart
    shares: new Map(), prepared: true, started: true,
    boardRevealed: Number(await zkd.boardRevealedCount(dealIdOnChain)),
    holesRevealed: new Set(), markedReady: await zkd.isShowdownReady(dealIdOnChain),
    showdownAt: 0, phaseAt: Date.now(), deadlineAt: 0, recovered: true,
  };
  // verify every recovered ct against the on-chain commitment before trusting it
  for (let i = 0; i < sess.deck.length; i++) {
    const a = zk.aff(sess.deck[i].A), b = zk.aff(sess.deck[i].B);
    const packed = "0x" + [a.x, a.y, b.x, b.y].map((v) => v.toString(16).padStart(64, "0")).join("");
    const want = await zkd.ctHash(dealIdOnChain, i);
    const { keccak256 } = require("ethers");
    if (keccak256(packed) !== want) return null;
  }
  return sess;
}

// ---------------------------------------------------------------------------
// The tick — advance one table by at most one on-chain action.
// ---------------------------------------------------------------------------
async function tickZkTable(room, zkd, state, tableId, opts = {}) {
  const send = opts.tx || ((fn) => fn().then((r) => r.wait()));
  const now = opts.now ? opts.now() : Date.now();
  const cfg = await room.getTable(tableId);
  const maxSeats = Number(cfg.maxSeats);
  const h = await room.getHand(tableId);
  let sess = state.get(tableId);

  // ======================= between hands: deal prep =======================
  if (!h.inProgress) {
    if (sess && sess.started) {
      // the live hand just ended (settle/fold-win/cancel) — clear + brief pause
      dropPersisted(opts.persistDir, tableId);
      state.delete(tableId);
      state.set(`ended:${tableId}`, now);
      return "hand-ended";
    }
    const endedAt = state.get(`ended:${tableId}`);
    if (endedAt && now - endedAt < (opts.interHandMs ?? 1200)) return "inter-hand";
    state.delete(`ended:${tableId}`);
    if (opts.noNewHands) return "hold";

    const { nextHand, elig } = await eligibleSeats(room, tableId, maxSeats);
    if (elig.length < 2) { state.delete(tableId); return "idle"; }

    // (re)open a session when none, or the seat set / target hand changed
    const setChanged = sess && (sess.forHand !== nextHand || sess.seats.join() !== elig.map((e) => e.seat).join() || sess.addrs.join() !== elig.map((e) => e.addr).join());
    if (!sess || setChanged) {
      sess = newSession(tableId, elig, nextHand, opts);
      state.set(tableId, sess);
      return "keys:0/" + sess.k;
    }

    // deadline enforcement (pre-hand: strike + restart without the offender)
    if (sess.deadlineAt && now > sess.deadlineAt) {
      const missing = [];
      if (sess.phase === "keys") {
        for (let i = 0; i < sess.k; i++) if (!sess.pubkeys[i]) missing.push(i);
      } else if (sess.phase === "shuffle") {
        missing.push(sess.shuffleTurn);
      } else if (sess.phase === "holeshares") {
        for (let i = 0; i < sess.k; i++) {
          for (let j = 0; j < sess.k; j++) {
            if (i === j) continue;
            for (const idx of holeIdxsOf(j, sess.k)) {
              const m = sess.shares.get(idx);
              if (!m || !m.has(i)) { if (!missing.includes(i)) missing.push(i); }
            }
          }
        }
      }
      if (missing.length) {
        const seat = sess.seats[missing[0]];
        try { await send(() => room.sitOutIdle(tableId, seat)); } catch (_) {}
        state.delete(tableId);
        return `strike:${sess.phase}:seat${seat}`;
      }
    }

    if (sess.phase === "keys") {
      const got = sess.pubkeys.filter(Boolean).length;
      if (got < sess.k) return `keys:${got}/${sess.k}`;
      sess.aggKey = zk.aggregate(sess.pubkeys.map((p) => p.X));
      sess.phase = "shuffle";
      sess.phaseAt = now;
      sess.deadlineAt = now + (opts.shuffleMs ?? 8_000);
      return "shuffle:0/" + sess.k;
    }
    if (sess.phase === "shuffle") return `shuffle:${sess.shuffleTurn}/${sess.k}`;
    if (sess.phase === "holeshares") {
      // need: every participant's shares for every OTHER participant's holes
      for (let j = 0; j < sess.k; j++) {
        for (const idx of holeIdxsOf(j, sess.k)) {
          if (!haveOthersShares(sess, idx, j)) return "holeshares-wait";
        }
      }
      sess.phase = "prepare";
      sess.deadlineAt = 0;
    }
    if (sess.phase === "prepare") {
      const k = sess.k;
      const inPlay = sess.deck.slice(0, inPlayCount(k));
      try {
        if (!sess.prepared) {
          await send(() => zkd.prepareDeal(
            sess.dealId, tableId, sess.forHand, sess.seats,
            sess.pubkeys.map((p) => cPt(p.X)), sess.pubkeys.map((p) => cPt(p.pok.R)), sess.pubkeys.map((p) => p.pok.s),
            inPlay.map((c) => cPt(c.A)), inPlay.map((c) => cPt(c.B)),
          ));
          sess.prepared = true;
          persistSession(opts.persistDir, sess);
        }
        await send(() => room.startHand(tableId));
        sess.started = true;
        sess.phase = "live";
        return "started";
      } catch (e) {
        // seat set raced (SeatMismatch / NotEnoughPlayers / player left) —
        // drop and re-collect next tick with the fresh set
        state.delete(tableId);
        dropPersisted(opts.persistDir, tableId);
        return "prep-reset";
      }
    }
    return "wait";
  }

  // =========================== live hand ================================
  const dealIdOnChain = h.dealId;
  if (!sess || String(sess.dealId) !== String(dealIdOnChain)) {
    sess = await recoverSession(zkd, opts.persistDir, tableId, dealIdOnChain);
    if (!sess) {
      // unrecoverable (cts lost) — refund and free the table
      await send(() => room.cancelHand(tableId));
      state.delete(tableId);
      return "cancelled:no-session";
    }
    state.set(tableId, sess);
    return "recovered";
  }

  const street = Number(h.street);

  // 1. betting timeout (same as v1 — permissionless fold/check)
  if (street <= STREET.RIVER) {
    const nowSec = Math.floor(now / 1000);
    if (nowSec > Number(h.actingDeadline) + (opts.timeoutGrace ?? 2)) {
      try { await send(() => room.timeoutAct(tableId)); return "timeout"; } catch (_) {}
    }
  }

  // 2. board reveals in lockstep with the streets
  const want = boardCountForStreet(street);
  if (want > sess.boardRevealed) {
    const slot = sess.boardRevealed;
    const idx = boardIdx(sess.k, slot);
    sess.boardNeeded = [];
    for (let sl = sess.boardRevealed; sl < want; sl++) sess.boardNeeded.push(boardIdx(sess.k, sl));
    if (!sess.boardDeadline) sess.boardDeadline = now + (opts.boardMs ?? 9_000);

    if (haveAllShares(sess, idx)) {
      const card = decryptCard(sess, idx);
      const ct = sess.deck[idx];
      const sh = contractShares(sess, idx);
      try {
        await send(() => zkd.revealBoardCard(sess.dealId, slot, card, [cPt(ct.A), cPt(ct.B)], sh.d, sh.R1, sh.R2, sh.s));
      } catch (e) {
        return await _revealFailed(room, state, tableId, sess, e, send, opts);
      }
      sess.boardRevealed = slot + 1;
      sess.boardDeadline = 0;
      return `board:${slot + 1}`;
    }
    if (now > sess.boardDeadline) return await _sharesTimeout(room, state, tableId, sess, [idx], send, opts);
    return "board-wait";
  }
  sess.boardNeeded = [];
  sess.boardDeadline = 0;

  // 3. showdown: collect own-hole shares from live seats, reveal, settle
  if (street === STREET.SHOWDOWN) {
    // which seats are still in the hand (the room needs THEIR cards)
    const liveParts = [];
    for (let i = 0; i < sess.k; i++) {
      const sh = await room.getSeatHand(tableId, sess.seats[i]);
      if (sh.inHand) liveParts.push(i);
    }
    sess.ownNeeded = new Set(liveParts.filter((p) => !sess.holesRevealed.has(p)));
    if (!sess.showdownDeadline) sess.showdownDeadline = now + (opts.showdownSharesMs ?? 12_000);

    for (const p of liveParts) {
      if (sess.holesRevealed.has(p)) continue;
      const [i0, i1] = holeIdxsOf(p, sess.k);
      if (haveAllShares(sess, i0) && haveAllShares(sess, i1)) {
        const c0 = decryptCard(sess, i0), c1 = decryptCard(sess, i1);
        const s0 = contractShares(sess, i0), s1 = contractShares(sess, i1);
        const ct0 = sess.deck[i0], ct1 = sess.deck[i1];
        try {
          await send(() => zkd.revealHoleCards(
            sess.dealId, p, sess.seats[p], [c0, c1],
            [cPt(ct0.A), cPt(ct0.B), cPt(ct1.A), cPt(ct1.B)],
            [...s0.d, ...s1.d], [...s0.R1, ...s1.R1], [...s0.R2, ...s1.R2], [...s0.s, ...s1.s],
          ));
        } catch (e) {
          return await _revealFailed(room, state, tableId, sess, e, send, opts);
        }
        sess.holesRevealed.add(p);
        return `holes:seat${sess.seats[p]}`;
      }
    }

    const allRevealed = liveParts.every((p) => sess.holesRevealed.has(p));
    if (allRevealed) {
      if (!sess.markedReady) {
        await send(() => zkd.markShowdownReady(sess.dealId));
        sess.markedReady = true;
        sess.showdownAt = now;
        return "showdown-ready";
      }
      if (now - (sess.showdownAt || 0) < (opts.showdownMs ?? 1800)) return "showdown-wait";
      await send(() => room.resolveShowdown(tableId));
      return "settled";
    }
    if (now > sess.showdownDeadline) {
      const missing = liveParts.filter((p) => !sess.holesRevealed.has(p) && !(haveAllShares(sess, holeIdxsOf(p, sess.k)[0]) && haveAllShares(sess, holeIdxsOf(p, sess.k)[1])));
      const idxs = missing.length ? holeIdxsOf(missing[0], sess.k) : [];
      return await _sharesTimeout(room, state, tableId, sess, idxs, send, opts);
    }
    return "showdown-collect";
  }

  return "wait";
}

/// A reveal the CONTRACT refused (DupeCard from a malicious shuffle, ciphertext
/// mismatch, …) can never succeed on retry — void the hand with a full refund
/// instead of wedging the table. Transient RPC errors are retried (rethrown).
async function _revealFailed(room, state, tableId, sess, e, send, opts) {
  const msg = (e && (e.shortMessage || e.info?.error?.message || e.message)) || "";
  const reverted = /execution reverted|CALL_EXCEPTION|DupeCard|BadProof|BadCard|BadCiphertext|BadLength|BadStreet|NotPrepared/i.test(msg);
  if (!reverted) throw e;
  await send(() => room.cancelHand(tableId));
  state.delete(tableId);
  dropPersisted(opts.persistDir, tableId);
  return "cancelled:reveal-refused";
}

/// Mid-hand share deadline breached: find the participant(s) whose shares are
/// missing, penalize the first (their committed chips go to the others), or
/// plain-cancel when the offender has nothing committed.
async function _sharesTimeout(room, state, tableId, sess, idxs, send, opts) {
  let offender = -1;
  for (const idx of idxs) {
    const m = sess.shares.get(idx) || new Map();
    for (let i = 0; i < sess.k; i++) {
      if (!m.has(i)) { offender = i; break; }
    }
    if (offender >= 0) break;
  }
  const seat = offender >= 0 ? sess.seats[offender] : 255;
  try {
    if (seat !== 255) {
      await send(() => room.cancelHandPenalized(tableId, seat));
      state.delete(tableId);
      dropPersisted(opts.persistDir, tableId);
      return `cancelled:penalized:seat${seat}`;
    }
  } catch (_) { /* offender had nothing committed → fall through */ }
  await send(() => room.cancelHand(tableId));
  if (seat !== 255) { try { await send(() => room.sitOutIdle(tableId, seat)); } catch (_) {} }
  state.delete(tableId);
  dropPersisted(opts.persistDir, tableId);
  return `cancelled:shares:seat${seat}`;
}

/// Public snapshot fragment for the table snapshot cache (observer-safe: no
/// shares, no cts — just protocol progress for UI hints).
function zkSnapshot(state, tableId) {
  const sess = state.get(tableId);
  if (!sess) return null;
  return {
    phase: sess.phase,
    dealId: String(sess.dealId),
    k: sess.k,
    seats: sess.seats,
    keysIn: sess.pubkeys ? sess.pubkeys.filter(Boolean).length : 0,
    shuffleTurn: sess.shuffleTurn,
    boardRevealed: sess.boardRevealed,
    deadlineAt: sess.deadlineAt || sess.boardDeadline || sess.showdownDeadline || 0,
  };
}

module.exports = {
  init, newZkState, tickZkTable, zkTask, zkPostKey, zkPostShuffle, zkPostShares, zkSnapshot,
  eligibleSeats, keyDomain, shareDomain, serPt, parsePt, serCt, parseCt, cPt, STREET, boardCountForStreet, inPlayCount, holeIdxsOf, boardIdx,
};
