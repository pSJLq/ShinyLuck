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
// Pre-deal: while a hand is at SHOWDOWN, the NEXT hand's setup runs in a
// speculative second session (`next:` slot) — keys/shuffle/holeshares overlap
// the reveals, prepareDeal rides the winner-display pause, and at settle the
// session is promoted iff the fresh eligibility check still matches its seat
// set. Any mismatch/stall just falls back to the normal path (no strikes for
// a speculative deal); a client must complete BOTH deals' tasks, and its own
// NEXT-hand cards are never relayed while the deal is speculative.
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

// ---- shuffle-proof verification pool (worker_threads) --------------------
// verifyShuffle is ~400ms of BN254 math. Running it inline froze the HTTP
// relay when two tables were live (players on the other table missed their
// deadlines -> the "tables take turns" report). Offload to a small pool so the
// event loop stays free to relay keys/shuffles/shares. Verification is public
// (no secrets), so this changes nothing about the trust model.
let VPOOL = null; // { workers:[{w,busy}], queue:[], next, seq, pending:Map }
function initVerifyPool(size) {
  if (VPOOL || !size) return;
  let Worker;
  try { ({ Worker } = require("node:worker_threads")); } catch (_) { return; }
  const path = require("node:path");
  const workerFile = path.join(__dirname, "zk-verify-worker.js");
  VPOOL = { workers: [], queue: [], seq: 1, pending: new Map() };
  for (let i = 0; i < size; i++) {
    let w;
    try { w = new Worker(workerFile); } catch (e) { console.error("[zk-pool] worker spawn failed:", e.message); break; }
    const rec = { w, busy: false, ready: false };
    w.on("message", (m) => {
      if (m && m.ready) { rec.ready = true; return; }
      if (m && m.fatal) { console.error("[zk-pool] worker fatal:", m.fatal); return; }
      const p = VPOOL.pending.get(m.id);
      if (!p) return;
      VPOOL.pending.delete(m.id);
      clearTimeout(p.timer);
      rec.busy = false;
      p.resolve(!!m.ok);
      _drain();
    });
    w.on("error", (e) => { console.error("[zk-pool] worker error:", e.message); rec.busy = false; _drain(); });
    VPOOL.workers.push(rec);
  }
  if (!VPOOL.workers.length) { VPOOL = null; return; }
  console.log(`[zk-pool] ${VPOOL.workers.length} shuffle-verify workers up`);
}
function _drain() {
  if (!VPOOL || !VPOOL.queue.length) return;
  const free = VPOOL.workers.find((r) => !r.busy);
  if (!free) return;
  const job = VPOOL.queue.shift();
  free.busy = true;
  const id = VPOOL.seq++;
  const timer = setTimeout(() => {
    if (!VPOOL.pending.has(id)) return;
    VPOOL.pending.delete(id);
    free.busy = false;
    // a hung worker must NEVER resolve true - reject so the caller falls back
    // to an inline verify (still correct, just on the main thread)
    job.reject(new Error("verify worker timeout"));
    _drain();
  }, 8000);
  VPOOL.pending.set(id, { resolve: job.resolve, reject: job.reject, timer });
  free.w.postMessage({ id, domain: job.domain, prevDeck: job.prevDeck, newDeck: job.newDeck, aggKey: job.aggKey, proofWire: job.proofWire });
}
/// Verify a shuffle proof off-thread; falls back to inline on any pool issue.
/// Result is IDENTICAL to zk.verifyShuffle - the worker runs the same code.
async function verifyShuffleOffthread(domain, prevDeck, newDeck, aggKey, proofWire) {
  if (VPOOL) {
    try {
      const prevW = prevDeck.map(serCt), nextW = newDeck.map(serCt), keyW = serPt(aggKey);
      return await new Promise((resolve, reject) => {
        VPOOL.queue.push({ domain, prevDeck: prevW, newDeck: nextW, aggKey: keyW, proofWire, resolve, reject });
        _drain();
      });
    } catch (e) {
      // pool timeout/crash -> fall through to inline (never silently accept)
    }
  }
  return (zk.verifyShuffleBatched || zk.verifyShuffle)(domain, prevDeck, newDeck, aggKey, zk.shuffleProofFromWire(proofWire, parsePt));
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
  return new Map(); // tableId -> session (+ `next:` / `ended:` / `nextskip:` aux keys)
}

// Pre-deal: while hand N is at showdown, the NEXT hand's setup (keys → shuffle
// → holeshares → prepareDeal) runs in a second session under `next:` so the
// visible between-hands gap shrinks to roughly startHand's confirmation.
const nextKey = (t) => `next:${t}`;

/// Route a client post to the session its dealId names — the live deal or the
/// pre-deal. Unknown dealIds fall back to the main session so the existing
/// "stale dealId" errors (and old clients) behave exactly as before.
function _sessFor(state, tableId, dealId) {
  const main = state.get(tableId);
  if (main && String(main.dealId) === String(dealId)) return main;
  const nx = state.get(nextKey(tableId));
  if (nx && String(nx.dealId) === String(dealId)) return nx;
  return main;
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

// A strictly-monotonic, process-global counter so no two sessions can EVER
// share a dealId (the old scheme relied on time+random not colliding; a
// collision would let a proof from one deal be replayed into another, since the
// Fiat–Shamir domains are keyed by dealId). dealId = ms · 4096 + seq(12 bits):
// unique within a process as long as < 4096 deals start per millisecond (always
// true), monotonic across time, and still < 2^53 so the Number code paths hold.
// The contract's `_deal[dealId].exists` guard remains the on-chain backstop.
let _dealSeq = 0;
function newSession(tableId, elig, nextHand, opts) {
  const dealId = Date.now() * 4096 + ((_dealSeq++) & 0xfff);
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
    keySigs: new Array(elig.length).fill(null), // seat-binding signature per participant
    decks: [zk.initialDeck(zk.deckPoints())], // decks[i] = deck after i shuffles
    shuffleTurn: 0,
    deck: null, // final 52 cts once every participant shuffled
    // Wikström shuffle proofs, one per shuffler — the deck is not trusted (and
    // holeshares don't start) until EVERY stage is proven a correct
    // permutation+re-encryption. proofs[i] = parsed, proofWires[i] = wire JSON.
    proofs: new Array(elig.length).fill(null),
    proofWires: new Array(elig.length).fill(null),
    transcriptHash: null,
    shares: new Map(), // cardIdx -> Map(participant -> {d, R1, R2, s})  (verified)
    prepared: false,
    started: false,
    boardRevealed: 0,
    holesRevealed: new Set(),
    markedReady: false,
    showdownAt: 0,
    phaseAt: Date.now(),
    deadlineAt: Date.now() + (opts.keysMs ?? 12_000),
  };
  return sess;
}

const inPlayCount = (k) => 2 * k + 5;

/// Canonical share-release policy — the client's secrecy gate (mirrored inline
/// in frontend/poker/zk-agent.js `mayRelease`, and matching the on-chain
/// ZkTableDealer.accusationAllowed). Given the deal's k, the caller's
/// participant index and the ON-CHAIN hand street (-1 when this deal is not the
/// live hand yet), returns whether releasing a decryption share for in-play
/// index `idx` is safe. Own holes: showdown only. Board: only once its street
/// opened. Others' holes: always (k−1 shares decrypt nothing without the owner).
function mayReleaseShare(idx, k, participant, street) {
  if (idx < 0 || idx >= inPlayCount(k)) return false;
  if (idx < 2 * k) {
    const owner = Math.floor(idx / 2);
    if (owner === participant) return street === 4; // own holes: showdown/all-in runout
    return true;
  }
  const slot = idx - 2 * k;
  const boardDue = street >= 3 ? 5 : street === 2 ? 4 : street === 1 ? 3 : 0;
  return slot < boardDue;
}
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
/// client needs to decrypt its OWN hole cards. `dealId` (optional) selects the
/// pre-deal session when the client polls for the NEXT hand's setup.
function zkTask(state, tableId, addrLower, dealId) {
  const sess = dealId !== undefined ? _sessFor(state, tableId, dealId) : state.get(tableId);
  if (!sess) return { phase: "none" };
  const part = sess.part.get(addrLower);
  if (part === undefined) return { phase: sess.phase, dealId: String(sess.dealId), observer: true };
  // `prepared` tells the client whether prepareDeal has CONFIRMED on-chain —
  // before that, the on-chain ctHash commitments its decrypt path checks
  // against don't exist yet (the read panics, and the client used to park the
  // whole deal for 45s: the "hand started but my cards are still hidden" bug).
  const base = { phase: sess.phase, dealId: String(sess.dealId), participant: part, k: sess.k, seats: sess.seats, mySeat: sess.seats[part], prepared: !!sess.prepared };

  if (sess.phase === "keys") {
    if (!sess.pubkeys[part]) return { ...base, do: "key", domain: keyDomain(sess.dealId, part) };
    return base;
  }
  if (sess.phase === "shuffle") {
    if (sess.shuffleTurn === part) {
      return { ...base, do: "shuffle", first: sess.shuffleTurn === 0, deck: sess.decks[sess.shuffleTurn].map(serCt), aggKey: serPt(sess.aggKey) };
    }
    // already shuffled but the proof hasn't landed: normally the client proves
    // from its own local state right after posting the deck; this payload is
    // the F5-recovery path (secret {perm,rho} survives in sessionStorage, the
    // decks are re-served here).
    if (part < sess.shuffleTurn && !sess.proofs[part]) {
      return {
        ...base, do: "shuffleproof", turn: part, domain: shufDomain(sess.dealId, part),
        inDeck: sess.decks[part].map(serCt), outDeck: sess.decks[part + 1].map(serCt), aggKey: serPt(sess.aggKey),
      };
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
    // sender's key instead of trusting this relay. NOT served while this deal
    // is still a speculative pre-deal: a player must never see their NEXT
    // hand's cards before that hand exists (they could dodge blinds on bad
    // holes with perfect information). Also NOT served until prepareDeal has
    // confirmed: the client verifies each ciphertext against the ON-CHAIN
    // ctHash before decrypting, and reading a not-yet-prepared deal panics —
    // the client then parked the dealId and the hand ran with hidden cards.
    if (sess.deck && !sess.predeal && sess.prepared) {
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
  const sess = _sessFor(state, tableId, body.dealId);
  if (!sess || sess.phase !== "keys") throw new Error("not collecting keys");
  if (String(sess.dealId) !== String(body.dealId)) throw new Error("stale dealId");
  const part = sess.part.get(addrLower);
  if (part === undefined) throw new Error("not in this deal");
  if (sess.pubkeys[part]) return { ok: true }; // idempotent
  const X = parsePt(body.X);
  const pok = { R: parsePt(body.pokR), s: BigInt(body.pokS) };
  if (!zk.verifyPok(keyDomain(sess.dealId, part), X, pok)) throw new Error("bad key proof");
  sess.pubkeys[part] = { X, pok };
  // seat-binding signature: relayed verbatim to every client, which checks it
  // against the seat's on-chain occupant before sharing (the bot is NOT the
  // trust point — this is the anti-key-substitution guarantee). Stored as-is.
  if (body.keySig) sess.keySigs[part] = String(body.keySig);
  return { ok: true };
}

/// Client returns the deck it just shuffled+remasked (its turn only). The next
/// shuffler proceeds IMMEDIATELY — the proof of this shuffle streams in behind
/// it (zkPostShuffleProof) so proving pipelines with the next player's shuffle.
function zkPostShuffle(state, tableId, addrLower, body) {
  const sess = _sessFor(state, tableId, body.dealId);
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
    sess.deck = deck; // candidate final deck — NOT trusted until all proofs land
    sess.deadlineAt = Date.now() + 15_000; // window for outstanding proofs
  }
  return { ok: true };
}

const shufDomain = (dealId, turn) => `SPZK:${dealId}:shuffle:${turn}`;

/// Client posts the Wikström proof for the shuffle it performed at `turn`.
/// Verified HERE against the exact input/output decks the coordinator relayed;
/// every other client independently re-verifies the whole chain via zkChain
/// before contributing any decryption share. An invalid proof is simply not
/// accepted — the prover gets struck at the deadline like any no-show.
async function zkPostShuffleProof(state, tableId, addrLower, body) {
  const sess = _sessFor(state, tableId, body.dealId);
  if (!sess || sess.phase !== "shuffle") throw new Error("not in shuffle phase");
  if (String(sess.dealId) !== String(body.dealId)) throw new Error("stale dealId");
  const part = sess.part.get(addrLower);
  if (part === undefined) throw new Error("not in this deal");
  const turn = Number(body.turn);
  if (turn !== part) throw new Error("can only prove your own shuffle");
  if (turn >= sess.shuffleTurn) throw new Error("deck not posted yet");
  if (sess.proofs[turn]) return { ok: true }; // idempotent
  const prf = zk.shuffleProofFromWire(body.proof, parsePt); // parse = cheap validity gate (points on-curve)
  // OPTIMISTIC ACCEPT (see initVerifyPool). Store the proof and let the NEXT
  // shuffler proceed at once, instead of holding this response ~220ms for the
  // verify. Money is not at risk yet: honest clients run their OWN full
  // verifyChain before releasing any decryption share, so a bad shuffle can
  // never reach startHand — it stalls holeshares and cancels with a refund.
  // The background verify below is a FAST-FAIL: it flags a bad shuffler early
  // so the tick strikes them, rather than waiting for the holeshares deadline.
  const dealId = sess.dealId;
  sess.proofs[turn] = prf;
  sess.proofWires[turn] = body.proof;
  const prevDeck = sess.decks[turn], newDeck = sess.decks[turn + 1], aggKey = sess.aggKey;
  verifyShuffleOffthread(shufDomain(dealId, turn), prevDeck, newDeck, aggKey, body.proof)
    .then((ok) => {
      if (ok) return;
      const s2 = _sessFor(state, tableId, dealId);
      if (s2 && String(s2.dealId) === String(dealId) && s2.badShuffle == null) {
        s2.badShuffle = turn;
        console.error(`[poker-bot] bad shuffle proof t${tableId} turn${turn} (background) - striking`);
      }
    })
    .catch(() => {}); // pool hiccup: the client gate + holeshares deadline still protect money
  if (sess.shuffleTurn === sess.k && sess.proofs.every(Boolean)) {
    sess.transcriptHash = zk.shuffleTranscriptHash(
      `SPZKSH:tr:${sess.dealId}`,
      sess.proofs.map((p, i) => ({ deck: sess.decks[i + 1], proof: p })),
    );
    sess.phase = "holeshares";
    sess.phaseAt = Date.now();
    sess.deadlineAt = Date.now() + 15_000;
  }
  return { ok: true };
}

/// The public shuffle transcript: every posted deck + every proof. Clients
/// fetch this ONCE per hand and independently verify the full chain before
/// giving out any decryption share — the coordinator's own verification is
/// thereby not a trust point. (The initial deck is canonical — derived
/// locally, not served.)
function zkChain(state, tableId, dealId) {
  const sess = dealId !== undefined ? _sessFor(state, tableId, dealId) : state.get(tableId);
  if (!sess || !sess.aggKey) return { phase: sess ? sess.phase : "none" };
  return {
    dealId: String(sess.dealId),
    k: sess.k,
    aggKey: serPt(sess.aggKey),
    seats: sess.seats,
    // per-participant pubkey + its seat-binding signature: the client recomputes
    // the aggregate from these, checks its OWN key is present, and verifies every
    // binding against the seat's on-chain occupant before sharing.
    pubkeys: sess.pubkeys.map((p) => (p ? serPt(p.X) : null)),
    keySigs: sess.keySigs,
    decks: sess.decks.slice(1).map((d) => d.map(serCt)),
    proofs: sess.proofWires,
    transcriptHash: sess.transcriptHash,
  };
}

/// Client posts decryption shares (+CP proofs) for a set of card indices.
/// Accepted for: others' holes (pre-collect), requested board slots, own holes
/// at showdown. Every proof is verified against the sender's pubkey.
function zkPostShares(state, tableId, addrLower, body) {
  const sess = _sessFor(state, tableId, body.dealId);
  if (!sess || !sess.deck) throw new Error("no deck yet");
  if (sess.phase === "shuffle") throw new Error("shuffle proofs pending"); // deck not proven yet
  if (String(sess.dealId) !== String(body.dealId)) throw new Error("stale dealId");
  const part = sess.part.get(addrLower);
  if (part === undefined) throw new Error("not in this deal");
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > inPlayCount(sess.k)) throw new Error("bad items");
  const X = sess.pubkeys[part].X;
  let accepted = 0;
  // Pass 1: run every per-item guard (idx bounds, own-hole rule, idempotency)
  // and parse the points; collect what still needs a crypto check.
  const pending = []; // { idx, d, R1, R2, s, domain }
  for (const item of body.items) {
    const idx = Number(item.idx);
    if (!(idx >= 0 && idx < inPlayCount(sess.k))) throw new Error("bad idx");
    // own-hole shares are only accepted once the hand reached showdown — the
    // bot must never hold a full share set for a live player's cards earlier
    const own = holeIdxsOf(part, sess.k).includes(idx);
    if (own && !(sess.ownNeeded && sess.ownNeeded.has(part))) throw new Error("own shares not needed yet");
    const m = sess.shares.get(idx);
    if (m && m.has(part)) continue; // idempotent
    pending.push({ idx, d: parsePt(item.d), R1: parsePt(item.R1), R2: parsePt(item.R2), s: BigInt(item.s), domain: shareDomain(sess.dealId, idx, part) });
  }
  // Pass 2: ONE batched Chaum–Pedersen check for the whole POST (measured ~3×
  // over per-item verifyShare). Same all-or-nothing semantics: a single bad
  // share rejects the POST. Falls back to per-item if the batch fn is absent.
  if (pending.length) {
    const items = pending.map((p) => ({ ct: sess.deck[p.idx], d: p.d, R1: p.R1, R2: p.R2, s: p.s, domain: p.domain }));
    const okAll = zk.verifySharesBatched
      ? zk.verifySharesBatched(X, items)
      : items.every((it) => zk.verifyShare(it.ct, X, { d: it.d, proof: { R1: it.R1, R2: it.R2, s: it.s } }, it.domain));
    if (!okAll) throw new Error("bad share proof in batch");
    for (const p of pending) {
      let m = sess.shares.get(p.idx);
      if (!m) { m = new Map(); sess.shares.set(p.idx, m); }
      m.set(part, { d: p.d, R1: p.R1, R2: p.R2, s: p.s });
      accepted++;
    }
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
      // full shuffle transcript: /zk/chain keeps serving across a bot restart
      // (clients that hadn't verified yet would otherwise refuse to share),
      // and it's the permanent audit artifact behind the on-chain proofHash
      aggKey: sess.aggKey ? serPt(sess.aggKey) : null,
      keySigs: sess.keySigs,
      chainDecks: sess.decks.slice(1).map((d) => d.map(serCt)),
      proofWires: sess.proofWires,
      transcriptHash: sess.transcriptHash,
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
    keySigs: raw.keySigs || [],
    aggKey: raw.aggKey ? parsePt(raw.aggKey) : null,
    decks: raw.chainDecks ? [zk.initialDeck(zk.deckPoints()), ...raw.chainDecks.map((d) => d.map(parseCt))] : [],
    shuffleTurn: raw.k,
    proofs: (raw.proofWires || []).map(Boolean), proofWires: raw.proofWires || [],
    transcriptHash: raw.transcriptHash || null,
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

/// Pop the table's pre-deal session. Promoted when the EXPENSIVE work is done
/// (keys+shuffles proven → phase "holeshares" or "prepare"); the holeshares
/// case gets a fresh full deadline so nobody is struck off a stale speculative
/// clock — every participant already proved liveness by shuffling this deal.
/// A session still in keys/shuffle is dropped and the normal path rebuilds
/// from scratch (the graceful path for old cached clients that never answer
/// pre-deal tasks). Either way the `next:` slot is cleared.
function _takeNext(state, tableId, now, opts) {
  const nx = state.get(nextKey(tableId));
  if (!nx) return null;
  state.delete(nextKey(tableId));
  if (nx.phase !== "prepare" && nx.phase !== "holeshares") return null;
  if (nx.phase === "holeshares") nx.deadlineAt = now + (opts.holesharesMs ?? 15_000);
  nx.predeal = false; // myHoles relay unlocks once this becomes the live deal
  return nx;
}

/// Runs on every tick of a LIVE hand: opens the next hand's session (predicted
/// from current eligibility) as soon as the hand starts, advances its phase
/// transitions as client artifacts land, and — once complete — fires its
/// prepareDeal on the first tick with no reveal pending (`busy` gates the tx
/// so a pending board/hole reveal is never delayed by it). By settle time only
/// startHand separates the players from hand N+1; a FOLD ending at any street
/// benefits the same way. No strikes here — a pre-deal that stalls (old
/// clients, closed tab) is silently dropped and the normal path takes over.
async function _predealTick(room, zkd, state, tableId, maxSeats, liveSess, now, opts, send, busy) {
  const key = nextKey(tableId);
  let nx = state.get(key);
  if (!nx) {
    // one attempt per live hand: if it was dropped once, don't churn new
    // sessions (and new client keygens) every tick for the rest of the hand
    if (state.get(`nextskip:${tableId}`) === String(liveSess.dealId)) return;
    const { nextHand, elig } = await eligibleSeats(room, tableId, maxSeats);
    if (elig.length < 2) return;
    nx = newSession(tableId, elig, nextHand, opts);
    nx.predeal = true;
    nx.deadlineAt = now + (opts.predealKeysMs ?? 20_000);
    state.set(key, nx);
    return;
  }
  // phase transitions (the HTTP handlers do the heavy lifting, same as the
  // normal path — this mirrors the between-hands keys→shuffle / holeshares→
  // prepare advancement, minus the strikes)
  if (nx.phase === "keys" && nx.pubkeys.every(Boolean)) {
    nx.aggKey = zk.aggregate(nx.pubkeys.map((p) => p.X));
    nx.phase = "shuffle";
    nx.phaseAt = now;
    nx.deadlineAt = now + (opts.shuffleMs ?? 8_000) * 2;
    return;
  }
  if (nx.phase === "holeshares") {
    let complete = true;
    for (let j = 0; j < nx.k && complete; j++) {
      for (const idx of holeIdxsOf(j, nx.k)) {
        if (!haveOthersShares(nx, idx, j)) { complete = false; break; }
      }
    }
    if (complete) { nx.phase = "prepare"; nx.deadlineAt = 0; }
  }
  // complete → commit the deal on-chain in the background; a revert (raced
  // duplicate, bad state) just drops the speculation — the normal path
  // re-prepares from scratch with a fresh session
  if (nx.phase === "prepare" && !nx.prepared && !busy) {
    const inPlay = nx.deck.slice(0, inPlayCount(nx.k));
    try {
      await send(() => zkd.prepareDeal(
        nx.dealId, tableId, nx.forHand, nx.seats,
        nx.pubkeys.map((p) => cPt(p.X)), nx.pubkeys.map((p) => cPt(p.pok.R)), nx.pubkeys.map((p) => p.pok.s),
        inPlay.map((c) => cPt(c.A)), inPlay.map((c) => cPt(c.B)),
        nx.transcriptHash,
      ));
      nx.prepared = true;
    } catch (_) {
      state.delete(key);
      state.set(`nextskip:${tableId}`, String(liveSess.dealId));
    }
    return;
  }
  if (nx.deadlineAt && now > nx.deadlineAt && nx.phase !== "prepare") {
    state.delete(key);
    state.set(`nextskip:${tableId}`, String(liveSess.dealId));
  }
}

// ---------------------------------------------------------------------------
// The tick — advance one table by at most one on-chain action.
// ---------------------------------------------------------------------------
async function tickZkTable(room, zkd, state, tableId, opts = {}) {
  const send = opts.tx || ((fn) => fn().then((r) => r.wait()));
  // Multi-tx reveals go out concurrently ONLY when the caller's sender
  // pipelines nonces (the production runner); plain signers (tests, ad-hoc
  // drivers) would nonce-race, so they keep the sequential path.
  const sendAll = async (thunks) => {
    if (opts.concurrentTx) { await Promise.all(thunks.map((th) => th())); return; }
    for (const th of thunks) await th();
  };
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
      state.delete(`nextskip:${tableId}`);
      // promote a COMPLETE pre-deal into the main slot: the fresh eligibleSeats
      // check below re-validates its seat set before anything on-chain happens,
      // so a stale prediction (bust-out, sit-down, strike) is simply replaced.
      const promoted = _takeNext(state, tableId, now, opts);
      if (promoted) state.set(tableId, promoted);
      state.set(`ended:${tableId}`, now);
      return promoted ? "hand-ended:next-ready" : "hand-ended";
    }
    const endedAt = state.get(`ended:${tableId}`);
    if (endedAt && now - endedAt < (opts.interHandMs ?? 400)) return "inter-hand";
    state.delete(`ended:${tableId}`);
    if (opts.noNewHands) return "hold";
    // stray pre-deal left by a cancelled hand (cancel paths clear the main
    // session immediately) — adopt it as the candidate; validated just below
    if (!sess) {
      const stray = _takeNext(state, tableId, now, opts);
      if (stray) { state.set(tableId, stray); sess = stray; }
    }

    const { nextHand, elig } = await eligibleSeats(room, tableId, maxSeats);
    if (elig.length < 2) { state.delete(tableId); return "idle"; }

    // (re)open a session when none, or the seat set / target hand changed
    const setChanged = sess && (sess.forHand !== nextHand || sess.seats.join() !== elig.map((e) => e.seat).join() || sess.addrs.join() !== elig.map((e) => e.addr).join());
    if (!sess || setChanged) {
      sess = newSession(tableId, elig, nextHand, opts);
      state.set(tableId, sess);
      return "keys:0/" + sess.k;
    }

    // fast-fail: the background shuffle verify flagged a forged proof. Strike
    // its author and restart without them (money was never at risk - clients
    // gate on their own verifyChain - this just avoids the holeshares stall).
    if (sess.badShuffle != null) {
      const seat = sess.seats[sess.badShuffle];
      try {
        await send(() => room.sitOutIdle(tableId, seat));
        state.delete(tableId);
        return `strike:badshuffle:seat${seat}`;
      } catch (e) {
        try { await send(() => room.cancelHand(tableId)); state.delete(tableId); dropPersisted(opts.persistDir, tableId); return `cancelled:badshuffle:seat${seat}`; }
        catch (_) { return `strike-blocked:seat${seat}`; }
      }
    }

    // deadline enforcement (pre-hand: strike + restart without the offender)
    if (sess.deadlineAt && now > sess.deadlineAt) {
      const missing = [];
      if (sess.phase === "keys") {
        for (let i = 0; i < sess.k; i++) if (!sess.pubkeys[i]) missing.push(i);
      } else if (sess.phase === "shuffle") {
        if (sess.shuffleTurn < sess.k) missing.push(sess.shuffleTurn);
        else for (let i = 0; i < sess.k; i++) if (!sess.proofs[i]) { missing.push(i); break; } // decks all in — a PROOF is overdue
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
        try {
          await send(() => room.sitOutIdle(tableId, seat));
          state.delete(tableId);
          return `strike:${sess.phase}:seat${seat}`;
        } catch (e) {
          // The strike tx ITSELF failed - classically the bot's gas tank ran
          // dry mid-tournament. The old code swallowed this and deleted state
          // anyway, faking a strike that never hit the chain: the table then
          // re-hit this same deadline every tick and wedged (the first
          // tournament's 8-minute freeze at shufproofs:2/3). Retry a couple of
          // times for a transient failure; if it keeps failing, cancel the deal
          // with a FULL REFUND so one unreachable tx can never hold the table.
          sess.strikeFails = (sess.strikeFails || 0) + 1;
          console.error(`[poker-bot] strike tx failed t${tableId} seat${seat} (#${sess.strikeFails}): ${e.shortMessage || e.message}`);
          if (sess.strikeFails >= 3) {
            try {
              await send(() => room.cancelHand(tableId));
              state.delete(tableId);
              dropPersisted(opts.persistDir, tableId);
              return `cancelled:strike-unreachable:seat${seat}`;
            } catch (e2) {
              console.error(`[poker-bot] cancelHand ALSO failed t${tableId}: ${e2.shortMessage || e2.message} - bot wallet out of gas? TOP UP`);
              return `strike-blocked:seat${seat}`; // surfaced, not silently wedged
            }
          }
          return `strike-retry:${sess.phase}:seat${seat}`;
        }
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
    if (sess.phase === "shuffle") {
      if (sess.shuffleTurn < sess.k) return `shuffle:${sess.shuffleTurn}/${sess.k}`;
      return `shufproofs:${sess.proofs.filter(Boolean).length}/${sess.k}`;
    }
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
            sess.transcriptHash, // on-chain commitment to the shuffle-proof chain
          ));
          sess.prepared = true;
        }
        // unconditional: a PROMOTED pre-deal arrives here already prepared and
        // must still be persisted, or a bot restart mid-hand couldn't recover it
        persistSession(opts.persistDir, sess);
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

  // 1.5 pre-deal the NEXT hand in parallel with this one (speculative — the
  // promotion path re-validates the seat set before anything binds). `busy`
  // defers its prepareDeal tx off ticks that owe the table a reveal.
  if (opts.predeal !== false) {
    const busyNow = boardCountForStreet(street) > sess.boardRevealed || (street === STREET.SHOWDOWN && !sess.markedReady);
    try { await _predealTick(room, zkd, state, tableId, maxSeats, sess, now, opts, send, busyNow); } catch (_) {}
  }

  // 2. board reveals in lockstep with the streets. Reveal EVERY due card that
  //    already has all shares in ONE tick (not one per poll cycle) — so the flop
  //    (3 cards) comes out as a unit instead of trickling one card at a time.
  const want = boardCountForStreet(street);
  if (want > sess.boardRevealed) {
    sess.boardNeeded = [];
    for (let sl = sess.boardRevealed; sl < want; sl++) sess.boardNeeded.push(boardIdx(sess.k, sl));
    if (!sess.boardDeadline) sess.boardDeadline = now + (opts.boardMs ?? 9_000);

    // The flop is atomic for the UI: hold the first reveal until all 3 cards
    // have their shares, so watchers never see the flop trickle one card at a
    // time (shares arrive per-client-poll, so card 0 is often ready first).
    // Past the deadline the hold lifts — the timeout path below needs the
    // ready prefix revealed to name the right missing card.
    const flopHold = street === STREET.FLOP && sess.boardRevealed === 0
      && ![0, 1, 2].every((sl) => haveAllShares(sess, boardIdx(sess.k, sl)))
      && now <= sess.boardDeadline;
    // Collect every share-ready contiguous slot, then dispatch the reveal txs
    // CONCURRENTLY (the worker's pipelined sender keeps nonces contiguous) so
    // a multi-card reveal lands in one block — watchers see the flop appear as
    // one unit instead of card-by-card at ~0.6s tx intervals.
    const readySlots = [];
    if (!flopHold) {
      for (let slot = sess.boardRevealed; slot < want; slot++) {
        if (!haveAllShares(sess, boardIdx(sess.k, slot))) break; // contiguous prefix only
        readySlots.push(slot);
      }
    }
    if (readySlots.length) {
      try {
        const args = readySlots.map((slot) => {
          const idx = boardIdx(sess.k, slot);
          const ct = sess.deck[idx];
          const sh = contractShares(sess, idx);
          return [sess.dealId, slot, decryptCard(sess, idx), [cPt(ct.A), cPt(ct.B)], sh.d, sh.R1, sh.R2, sh.s];
        });
        // The contract enforces slot order (boardSlot == boardCount), so later
        // slots can't be gas-ESTIMATED against the pre-state — estimate the
        // first (valid now), give the rest the same limit with headroom, and
        // let the pipelined sender broadcast all of them; same-sender nonce
        // order guarantees in-order execution within the block.
        let overrides = {};
        if (opts.concurrentTx && args.length > 1) {
          const est = await zkd.revealBoardCard.estimateGas(...args[0]);
          overrides = { gasLimit: (est * 16n) / 10n };
        }
        await sendAll(args.map((a) => () => send(() => zkd.revealBoardCard(...a, overrides))));
      } catch (e) {
        // recheck on-chain how far the batch got before deciding it's fatal
        sess.boardRevealed = Number(await zkd.boardRevealedCount(sess.dealId));
        return await _revealFailed(room, state, tableId, sess, e, send, opts);
      }
      sess.boardRevealed = readySlots[readySlots.length - 1] + 1;
      sess.boardDeadline = 0;
      return `board:${sess.boardRevealed}`;
    }
    if (sess.accused && (await _tryIngestRescue(room, zkd, sess, now, opts))) return "rescued";
    if (now > sess.boardDeadline) return await _sharesTimeout(room, zkd, state, tableId, sess, [boardIdx(sess.k, sess.boardRevealed)], send, opts);
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

    // Reveal EVERY share-ready hand in this one tick (the old one-seat-per-tick
    // return made a heads-up showdown cost ~4 poll cycles before the pot could
    // move), then mark readiness in the SAME tick — the showdown tail drops
    // from ~10s to roughly the winner-display pause.
    // Reveal every ready seat CONCURRENTLY (seat reveals are order-independent
    // on-chain) so a multi-way showdown costs one confirmation, not one per seat.
    const readyParts = liveParts.filter((p) => {
      if (sess.holesRevealed.has(p)) return false;
      const [i0, i1] = holeIdxsOf(p, sess.k);
      return haveAllShares(sess, i0) && haveAllShares(sess, i1);
    });
    let revealedNow = 0;
    if (readyParts.length) {
      try {
        await sendAll(readyParts.map((p) => () => {
          const [i0, i1] = holeIdxsOf(p, sess.k);
          const c0 = decryptCard(sess, i0), c1 = decryptCard(sess, i1);
          const s0 = contractShares(sess, i0), s1 = contractShares(sess, i1);
          const ct0 = sess.deck[i0], ct1 = sess.deck[i1];
          return send(() => zkd.revealHoleCards(
            sess.dealId, p, sess.seats[p], [c0, c1],
            [cPt(ct0.A), cPt(ct0.B), cPt(ct1.A), cPt(ct1.B)],
            [...s0.d, ...s1.d], [...s0.R1, ...s1.R1], [...s0.R2, ...s1.R2], [...s0.s, ...s1.s],
          )).then(() => { sess.holesRevealed.add(p); revealedNow++; });
        }));
      } catch (e) {
        return await _revealFailed(room, state, tableId, sess, e, send, opts);
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
      // Short beat only: the UI announces the winner CLIENT-side the moment the
      // reveals land and holds its own banner through settle, so a long
      // "display pause" here just kept everyone staring at a finished hand
      // (part of the reported ~7s cards-open→result wait).
      if (now - (sess.showdownAt || 0) < (opts.showdownMs ?? 400)) return "showdown-wait";
      await send(() => room.resolveShowdown(tableId));
      return "settled";
    }
    if (revealedNow) return `holes:${revealedNow}`;
    if (sess.accused && (await _tryIngestRescue(room, zkd, sess, now, opts))) return "rescued";
    if (now > sess.showdownDeadline) {
      const missing = liveParts.filter((p) => !sess.holesRevealed.has(p) && !(haveAllShares(sess, holeIdxsOf(p, sess.k)[0]) && haveAllShares(sess, holeIdxsOf(p, sess.k)[1])));
      const idxs = missing.length ? holeIdxsOf(missing[0], sess.k) : [];
      return await _sharesTimeout(room, zkd, state, tableId, sess, idxs, send, opts);
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

/// Push both share deadlines (whichever is armed) out to `until` — used when an
/// accusation opens/clears so the timeout logic re-fires AFTER the rescue window.
function _bumpShareDeadlines(sess, until) {
  if (sess.boardDeadline) sess.boardDeadline = Math.max(sess.boardDeadline, until);
  if (sess.showdownDeadline) sess.showdownDeadline = Math.max(sess.showdownDeadline, until);
}

/// If our accusation is no longer active on-chain, pull the (verified, recorded)
/// rescue share from the dealer contract into the session — a self-rescue
/// doesn't just clear the accused, it DELIVERS the share the hand was stuck on.
/// Returns true when a share was ingested.
async function _tryIngestRescue(room, zkd, sess, now, opts) {
  if (!sess.accused) return false;
  const acc = await room.accusationOf(sess.tableId);
  if (acc.active) return false; // window still open — keep waiting
  const { idx, part } = sess.accused;
  sess.accused = null;
  _bumpShareDeadlines(sess, now + (opts.postRescueMs ?? 9_000)); // fresh window for whatever is still missing
  const r = await zkd.rescuedShare(sess.dealId, idx, part);
  if (!r.exists) return false;
  const P = (o) => G1.fromAffine({ x: BigInt(o.x), y: BigInt(o.y) });
  const share = { d: P(r.d), proof: { R1: P(r.R1), R2: P(r.R2), s: BigInt(r.s) } };
  // defensive re-verify (the chain already did) before trusting our own parse
  if (!zk.verifyShare(sess.deck[idx], sess.pubkeys[part].X, share, shareDomain(sess.dealId, idx, part))) return false;
  let m = sess.shares.get(idx);
  if (!m) { m = new Map(); sess.shares.set(idx, m); }
  m.set(part, { d: share.d, R1: share.proof.R1, R2: share.proof.R2, s: share.proof.s });
  return true;
}

/// Mid-hand share deadline breached. The penalty is no longer a one-shot
/// operator call — the contract only forfeits after an ACCUSATION the accused
/// failed to self-rescue from within the on-chain rescue window:
///   1. name the first participant with a missing share, accuseAbandon(seat, idx)
///   2. the accused's client can proveResponsive on-chain (posting the share) —
///      we ingest it and the hand continues
///   3. only an expired, un-rescued accusation finalizes cancelHandPenalized
/// A seat with nothing committed is handled the cheap old way (cancel + strike).
async function _sharesTimeout(room, zkd, state, tableId, sess, idxs, send, opts) {
  const now = opts.now ? opts.now() : Date.now();
  let offender = -1, missIdx = -1;
  for (const idx of idxs) {
    const m = sess.shares.get(idx) || new Map();
    for (let i = 0; i < sess.k; i++) {
      if (!m.has(i)) { offender = i; missIdx = idx; break; }
    }
    if (offender >= 0) break;
  }
  if (offender < 0) {
    // nothing identifiably missing (defensive) — refund everyone
    await send(() => room.cancelHand(tableId));
    state.delete(tableId);
    dropPersisted(opts.persistDir, tableId);
    return "cancelled:shares:seat255";
  }
  const seat = sess.seats[offender];

  const acc = await room.accusationOf(tableId);
  if (acc.active) {
    // adopt the on-chain accusation (covers bot restarts mid-dispute)
    const accSeat = Number(acc.offenderSeat);
    sess.accused = { seat: accSeat, idx: Number(acc.cardIdx), part: sess.seats.indexOf(accSeat), deadline: Number(acc.deadline) * 1000 };
    if (now > sess.accused.deadline + (opts.penalizeGraceMs ?? 1500)) {
      try {
        await send(() => room.cancelHandPenalized(tableId));
        state.delete(tableId);
        dropPersisted(opts.persistDir, tableId);
        return `cancelled:penalized:seat${accSeat}`;
      } catch (_) {
        return "penalize-wait"; // chain clock behind, or raced a last-second rescue
      }
    }
    _bumpShareDeadlines(sess, sess.accused.deadline + (opts.penalizeGraceMs ?? 1500) + 1_000);
    return "accusation-wait";
  }

  // an accusation we made is gone → it was rescued; ingest the delivered share
  if (sess.accused) {
    const got = await _tryIngestRescue(room, zkd, sess, now, opts);
    return got ? "rescued" : "rescue-reset";
  }

  // nothing committed → penalty impossible; strike + full-refund cancel (as before)
  const sh = await room.getSeatHand(tableId, seat);
  if (sh.committedTotal === 0n) {
    await send(() => room.cancelHand(tableId));
    try { await send(() => room.sitOutIdle(tableId, seat)); } catch (_) {}
    state.delete(tableId);
    dropPersisted(opts.persistDir, tableId);
    return `cancelled:shares:seat${seat}`;
  }

  // open the accusation (carrying the committed ciphertext so the accused can
  // always self-rescue); forfeiture can only finalize after the rescue window
  const ct = sess.deck[missIdx];
  await send(() => room.accuseAbandon(tableId, seat, missIdx, cPt(ct.A), cPt(ct.B)));
  if (!sess.rescueWinMs) sess.rescueWinMs = Number(await room.rescueWindow()) * 1000;
  sess.accused = { seat, idx: missIdx, part: offender, deadline: now + sess.rescueWinMs };
  _bumpShareDeadlines(sess, now + sess.rescueWinMs + (opts.penalizeGraceMs ?? 1500) + 1_000);
  return `accused:seat${seat}:idx${missIdx}`;
}

/// Public snapshot fragment for the table snapshot cache (observer-safe: no
/// shares, no cts — just protocol progress for UI hints).
function zkSnapshot(state, tableId) {
  const sess = state.get(tableId);
  if (!sess) return null;
  const nx = state.get(nextKey(tableId));
  return {
    phase: sess.phase,
    dealId: String(sess.dealId),
    k: sess.k,
    seats: sess.seats,
    keysIn: sess.pubkeys ? sess.pubkeys.filter(Boolean).length : 0,
    shuffleTurn: sess.shuffleTurn,
    boardRevealed: sess.boardRevealed,
    deadlineAt: sess.deadlineAt || sess.boardDeadline || sess.showdownDeadline || 0,
    // pre-deal of the NEXT hand (clients poll a second task loop for it)
    next: nx ? { dealId: String(nx.dealId), phase: nx.phase, keysIn: nx.pubkeys.filter(Boolean).length, shuffleTurn: nx.shuffleTurn } : null,
  };
}

module.exports = {
  init, initVerifyPool, newZkState, tickZkTable, zkTask, zkPostKey, zkPostShuffle, zkPostShuffleProof, zkChain, zkPostShares, zkSnapshot,
  eligibleSeats, keyDomain, shareDomain, shufDomain, serPt, parsePt, serCt, parseCt, cPt, STREET, boardCountForStreet, inPlayCount, holeIdxsOf, boardIdx, mayReleaseShare,
  nextKey,
};
