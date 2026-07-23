// zkShuffle v2 browser agent · the player's side of the mental-poker protocol.
// Runs silently in the table page: generates the per-hand key, shuffles the
// encrypted deck on its turn, provides decryption shares when the protocol
// needs them, and decrypts the player's OWN hole cards locally. The secret
// never leaves this tab (sessionStorage keeps it across F5 mid-hand), no
// wallet popups (messages are signed by the session key / headless signer),
// and the player pays zero gas · the coordinator posts everything, and the
// CONTRACT verifies every card cryptographically.
//
// Trust hygiene (what we re-check instead of believing the bot):
//   - first shuffler verifies the initial deck is the canonical 52 points
//   - every relayed decryption share is CP-verified against that player's key
//   - the ciphertexts of MY hole cards are checked against the ON-CHAIN
//     commitments (ctHash) before I trust what I see
import nobleBn254 from "/vendor/noble-bn254.js"; // esbuild CJS bundle → single default export
const { bn254 } = nobleBn254;
import { ethers } from "/vendor/ethers.bundle.js";
import * as zk from "./zk-bn254.js";
import { POKER_CONFIG } from "./poker-config.js";

zk.init({ bn254, keccak256: ethers.keccak256, randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)) });
const G1 = bn254.G1.ProjectivePoint;

const hex = (b) => "0x" + b.toString(16);
const serPt = (P) => { const a = zk.aff(P); return { x: hex(a.x), y: hex(a.y) }; };
const parsePt = (o) => { const P = G1.fromAffine({ x: BigInt(o.x), y: BigInt(o.y) }); P.assertValidity(); return P; };
const serCt = (ct) => ({ A: serPt(ct.A), B: serPt(ct.B) });
const parseCt = (o) => ({ A: parsePt(o.A), B: parsePt(o.B) });
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const cardStr = (c) => RANKS[Math.floor(c / 4)] + ["c", "d", "h", "s"][c % 4];

// SDK reads decrypted cards from here (same shape the v1 /holes endpoint had)
window.__SPZK = window.__SPZK || { holes: {}, status: {} };

const ZKD_ABI = [
  "function ctHash(uint256 dealId, uint16 cardIdx) view returns (bytes32)",
  "function proofHash(uint256 dealId) view returns (bytes32)",
  "function dealIdForHand(uint256 tableId, uint64 handId) view returns (uint256)",
  "function dealInfo(uint256 dealId) view returns (bool exists, bool bound, uint8 playerCount, uint256 tableId, uint64 handId, uint8[] seats)",
  "function boardRevealedCount(uint256 dealId) view returns (uint8)",
];
// Self-rescue path: read the accusation straight from the chain (NOT via the
// bot · a malicious coordinator is exactly the threat model here) and answer it.
const ROOM_ZK_ABI = [
  "function accusationOf(uint256 t) view returns (bool active, uint8 offenderSeat, uint16 cardIdx, uint64 handId, uint64 deadline, (uint256,uint256) ctA, (uint256,uint256) ctB)",
  "function seatOf(uint256 t, address player) view returns (uint8)",
  "function getSeat(uint256 t, uint8 seat) view returns ((address player, uint128 stack, bool occupied, bool sittingOut, uint64 sitInHandId, uint64 sitOutSince))",
  "function getHand(uint256 t) view returns ((uint64 handId, uint8 street, uint8 button, uint8 actingSeat, uint8 aggressorSeat, uint8 numInHand, uint128 currentBet, uint128 minRaise, uint128 pot, uint64 actingDeadline, uint256 dealId, bool inProgress))",
  "function getSeatHand(uint256 t, uint8 seat) view returns ((bool inHand, bool folded, bool allIn, bool hasActed, uint128 committedStreet, uint128 committedTotal))",
  "function sessionKeyOf(address player) view returns (address)",
  "function proveResponsive(uint256 t, (uint256,uint256) d, (uint256,uint256) R1, (uint256,uint256) R2, uint256 s)",
];

export function startZkAgent(sdk, getTableId) {
  const api = sdk.cfg.dealerApiUrl;
  const zkd = new ethers.Contract(sdk.cfg.zkTableDealer, ZKD_ABI, sdk.read);
  const roomZk = new ethers.Contract(sdk.cfg.pokerRoom, ROOM_ZK_ABI, sdk.read);
  const sigCache = new Map(); // dealId -> signature
  const secKey = (t, dealId) => `spzk:${sdk.cfg.pokerRoom.slice(2, 10)}:${t}:${dealId}`;
  const shufKey = (t, dealId) => `spzksh:${sdk.cfg.pokerRoom.slice(2, 10)}:${t}:${dealId}`;
  // dealId -> { ok, hash } · verdict of my own verification of the full shuffle
  // chain. I contribute NO decryption share until every stage is proven.
  const chainVerdict = new Map();
  // dealId -> Map(stage -> {inH,outH,prfH,aggH}) · stages already proven during
  // the shuffle phase (incremental pre-verification). Keyed by content hashes:
  // the final verifyChain only skips a stage if the transcript it is looking at
  // is byte-identical to what was proven, so a coordinator that swaps data
  // after the pre-pass gains nothing.
  const chainProg = new Map();
  let preverifyBusy = false;
  let preverifyAt = 0;
  const myShuffle = new Map(); // dealId -> { outHash, aggKey } pin of my own contribution
  let running = false;
  let stopped = false;
  let ticks = 0;
  let rescueBusy = false;

  const deckHashHex = (wireDeck) => ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(wireDeck)));

  // SECRECY GATE: may I release a decryption share for in-play index `idx`,
  // given my participant index, the deal's k, and the ON-CHAIN hand street
  // (street = -1 when this deal isn't the live hand yet · pre-collect phase)?
  //   - another player's hole card: always safe · the coordinator still lacks
  //     the OWNER's own share, so k−1 shares decrypt nothing;
  //   - my OWN hole cards: only at showdown (street 4; all-in runout also lands
  //     the engine on street 4) · earlier would hand the coordinator the last
  //     share it needs to read my hand;
  //   - a board card: only once its street has opened on-chain · otherwise a
  //     malicious coordinator could ask for the whole board during preflop.
  // This never trusts task.idxs. Canonical copy: poker-zk-dealer.mayReleaseShare
  // (kept in sync); also mirrors on-chain ZkTableDealer.accusationAllowed.
  function mayRelease(idx, k, participant, street) {
    if (idx < 2 * k) {
      const owner = Math.floor(idx / 2);
      if (owner === participant) return street === 4; // own holes: showdown only
      return true;                                    // someone else's holes
    }
    const slot = idx - 2 * k;
    const boardDue = street >= 3 ? 5 : street === 2 ? 4 : street === 1 ? 3 : 0; // river(3)/showdown(4)→all
    return slot < boardDue;
  }

  const stageSig = (ch, i, X) => ({
    inH: i === 0 ? "init" : deckHashHex(ch.decks[i - 1]),
    outH: deckHashHex(ch.decks[i]),
    prfH: ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(ch.proofs[i]))),
    aggH: (() => { const a = zk.aff(X); return `${a.x.toString(16)}:${a.y.toString(16)}`; })(),
  });

  /// Incremental pre-verification: while OTHER players are still shuffling,
  /// verify the already-posted stages so the expensive MSMs don't all land in
  /// the holeshares window (at a 6-max table that's ~2s of proofs + a ~0.5MB
  /// transcript fetch that used to stall the deal right before hole cards).
  /// Purely an optimization · verifyChain re-checks anything not byte-matched.
  async function preverifyChain(t, dealId, signature) {
    if (chainVerdict.has(dealId) || preverifyBusy || Date.now() - preverifyAt < 900) return;
    preverifyBusy = true;
    preverifyAt = Date.now();
    try {
      const ch = await post("/zk/chain", { tableId: t, dealId, signature });
      if (!ch || !Array.isArray(ch.decks) || !Array.isArray(ch.proofs) || !Array.isArray(ch.pubkeys) ||
          !ch.pubkeys.length || ch.pubkeys.some((p) => !p)) return; // keys not all in yet
      const pubkeys = ch.pubkeys.map(parsePt);
      let X = G1.ZERO;
      for (const P of pubkeys) X = X.add(P);
      let prog = chainProg.get(dealId);
      if (!prog) { prog = new Map(); chainProg.set(dealId, prog); }
      const initial = zk.initialDeck(zk.deckPoints());
      for (let i = 0; i < ch.decks.length; i++) {
        if (prog.has(i) || !ch.proofs[i] || !ch.decks[i]) continue;
        const inDeck = i === 0 ? initial : ch.decks[i - 1].map(parseCt);
        const outDeck = ch.decks[i].map(parseCt);
        const prf = zk.shuffleProofFromWire(ch.proofs[i], parsePt);
        if (!zk.verifyShuffle(`SPZK:${dealId}:shuffle:${i}`, inDeck, outDeck, X, prf)) return; // final pass will re-check & refuse
        prog.set(i, stageSig(ch, i, X));
      }
    } catch (_) { /* best-effort · the authoritative pass is verifyChain */ }
    finally { preverifyBusy = false; }
  }

  /// Fetch the full shuffle transcript and verify EVERY stage's Wikström proof
  /// myself · the coordinator's word is not a trust point. Also pins my own
  /// shuffle: the chain must contain the exact deck I produced at my turn.
  /// Returns { ok, hash } and caches per deal.
  async function verifyChain(t, dealId, signature, myTurn, myX) {
    if (chainVerdict.has(dealId)) return chainVerdict.get(dealId);
    const ch = await post("/zk/chain", { tableId: t, dealId, signature });
    if (!ch || !Array.isArray(ch.decks) || !Array.isArray(ch.proofs) || ch.decks.length !== ch.k ||
        ch.proofs.length !== ch.k || !Array.isArray(ch.pubkeys) || ch.pubkeys.length !== ch.k ||
        !Array.isArray(ch.keySigs) || !Array.isArray(ch.seats) || ch.pubkeys.some((p) => !p) || ch.proofs.some((p) => !p)) {
      return { ok: false, hash: null }; // incomplete · retry next poll, no verdict cached
    }
    try {
      // 1. KEY-SUBSTITUTION DEFENCE: recompute the aggregate from the posted
      //    pubkeys and verify each pubkey is bound BY ITS SEAT'S OCCUPANT.
      //    A coordinator that swaps in its own key for a seat can't forge that
      //    seat's signature, so the swap is caught here and we never share -
      //    which is what denies the coordinator the shares it would need to
      //    decrypt that seat's cards. This is the "not even the house sees your
      //    cards" guarantee, enforced client-side, not trusted from the bot.
      const pubkeys = ch.pubkeys.map(parsePt);
      let X = G1.ZERO;
      for (const P of pubkeys) X = X.add(P);
      // my own key must be present at my index (else my card isn't under my key)
      if (myX && !pubkeys[myTurn].equals(myX)) {
        console.error("[zk-agent] my own per-hand key is NOT in the aggregate · refusing");
        return cacheBad(dealId);
      }
      // what I shuffled under must equal the real aggregate. The pin is
      // reconstructed from sessionStorage after an F5 (the in-memory Map is
      // gone) so the "my shuffle is in the chain" check below is never skipped
      // just because the tab reloaded.
      let pin = myShuffle.get(dealId);
      if (!pin) {
        try {
          const saved = JSON.parse(sessionStorage.getItem(shufKey(t, dealId)) || "null");
          if (saved && saved.outHash && saved.aggKey) {
            pin = { outHash: saved.outHash, aggKey: parsePt(saved.aggKey) };
            myShuffle.set(dealId, pin);
          }
        } catch (_) {}
      }
      // I shuffled (I'm a participant reaching the share gate), so I MUST be
      // able to confirm my own contribution · refuse to share blind if the pin
      // is unrecoverable rather than risk sharing on a chain missing my shuffle.
      if (myX && !pin) {
        console.error("[zk-agent] cannot confirm my own shuffle is in the chain · refusing");
        return cacheBad(dealId);
      }
      if (pin && !pin.aggKey.equals(X)) {
        console.error("[zk-agent] aggregate key I shuffled under ≠ Σ posted pubkeys · refusing");
        return cacheBad(dealId);
      }
      for (let i = 0; i < ch.k; i++) {
        const seat = Number(ch.seats[i]);
        const a = zk.aff(pubkeys[i]);
        const msg = `ShinyPoker:zk-key:${t}:${dealId}:${seat}:0x${a.x.toString(16)}:0x${a.y.toString(16)}`;
        let recovered;
        try { recovered = ethers.verifyMessage(msg, ch.keySigs[i]).toLowerCase(); }
        catch (_) { console.error(`[zk-agent] key binding ${i}: unverifiable signature`); return cacheBad(dealId); }
        const occ = await roomZk.getSeat(t, seat);
        const player = occ.player.toLowerCase();
        if (player === ethers.ZeroAddress) { console.error(`[zk-agent] key binding ${i}: empty seat`); return cacheBad(dealId); }
        const sk = (await roomZk.sessionKeyOf(occ.player)).toLowerCase();
        if (recovered !== player && recovered !== sk) {
          console.error(`[zk-agent] key binding ${i}: pubkey NOT signed by seat ${seat}'s occupant · refusing`);
          return cacheBad(dealId);
        }
      }

      // 2. every shuffle in the chain is a proven permutation+re-encryption
      //    under that SAME recomputed aggregate.
      const decks = [zk.initialDeck(zk.deckPoints()), ...ch.decks.map((d) => d.map(parseCt))];
      const proofs = ch.proofs.map((w) => zk.shuffleProofFromWire(w, parsePt));
      if (pin && deckHashHex(ch.decks[myTurn]) !== pin.outHash) {
        console.error("[zk-agent] chain does NOT contain my own shuffle output · refusing");
        return cacheBad(dealId);
      }
      const prog = chainProg.get(dealId);
      for (let i = 0; i < ch.k; i++) {
        // skip the MSM only when the pre-verified stage is byte-identical
        // (same in/out decks, same proof, same aggregate) to what's here now
        const cached = prog && prog.get(i);
        if (cached) {
          const sig = stageSig(ch, i, X);
          if (cached.inH === sig.inH && cached.outH === sig.outH && cached.prfH === sig.prfH && cached.aggH === sig.aggH) continue;
        }
        if (!zk.verifyShuffle(`SPZK:${dealId}:shuffle:${i}`, decks[i], decks[i + 1], X, proofs[i])) {
          console.error(`[zk-agent] shuffle proof ${i} FAILED verification · refusing`);
          return cacheBad(dealId);
        }
      }
      chainProg.delete(dealId);
      const hash = zk.shuffleTranscriptHash(`SPZKSH:tr:${dealId}`, proofs.map((p, i) => ({ deck: decks[i + 1], proof: p })));
      // expose the VERIFIED participant count and seat map so the share gate can
      // use them instead of the coordinator-supplied task.k / task.mySeat: both k
      // (anchored to the seat-binding sig count above) and each seat are proven
      // here, so trusting the task's copies would let a malicious bot mis-classify
      // ciphertexts (inflated k → board reads as "someone else's hole") or point
      // the fold check at the wrong seat (harvesting a folded hand at showdown).
      const verdict = { ok: true, hash, k: ch.k, seats: ch.seats.map(Number) };
      chainVerdict.set(dealId, verdict);
      console.log(`[zk-agent] chain verified: ${ch.k} bound keys + ${ch.k} shuffle proofs ok (deal ${dealId})`);
      return verdict;
    } catch (e) {
      console.error("[zk-agent] chain verification error · refusing:", e.message || e);
      return cacheBad(dealId);
    }
  }
  const cacheBad = (dealId) => { const v = { ok: false, hash: null, bad: true }; chainVerdict.set(dealId, v); return v; };

  // If an on-chain accusation names MY seat, compute the demanded share from the
  // ciphertext embedded in the accusation and post proveResponsive · this both
  // clears the (false or late) accusation and delivers the share, so an honest
  // player can never be penalized while their client is alive. Own-hole shares
  // are only ever surrendered once the board is complete (showdown/runout);
  // the contract enforces that too · this is defense in depth.
  async function selfRescue(t) {
    if (rescueBusy) return;
    const acc = await roomZk.accusationOf(t);
    if (!acc.active) return;
    const mySeat = Number(await roomZk.seatOf(t, sdk.address));
    if (mySeat === 255 || Number(acc.offenderSeat) !== mySeat) return;
    const dealId = String(await zkd.dealIdForHand(t, acc.handId));
    if (dealId === "0") return;
    // my per-hand secret must actually exist (a fresh keygen here would just
    // produce a share for the wrong key and waste gas)
    if (!sessionStorage.getItem(secKey(t, dealId))) return;
    const info = await zkd.dealInfo(dealId);
    const p = info.seats.map(Number).indexOf(mySeat);
    if (p < 0) return;
    const idx = Number(acc.cardIdx);
    if ((idx === 2 * p || idx === 2 * p + 1) && Number(await zkd.boardRevealedCount(dealId)) < 5) return;
    // if this accusation names ONE OF MY OWN hole cards and I FOLDED, my cards
    // stay hidden even at showdown · refuse to rescue (mirrors the shares-path
    // fold gate). The coordinator holds k-1 of my hole shares from the pre-hand
    // collect; delivering the last one here would hand it my folded hand. Letting
    // the accusation expire → cancelHandPenalized against my seat is the correct
    // outcome: a folded seat's cards must never surface.
    if (idx === 2 * p || idx === 2 * p + 1) {
      let inHand;
      try { inHand = (await roomZk.getSeatHand(t, mySeat)).inHand; } catch (_) { return; }
      if (!inHand) { console.warn("[zk-agent] refusing own-hole rescue · I folded"); return; }
    }
    const sec = secretFor(t, dealId, "");
    const ct = {
      A: parsePt({ x: acc.ctA[0], y: acc.ctA[1] }),
      B: parsePt({ x: acc.ctB[0], y: acc.ctB[1] }),
    };
    const sh = zk.decryptionShare(ct, sec.x, G1.BASE.multiply(sec.x), `SPZK:${dealId}:share:${idx}:${p}`);
    const signer = sdk.sessionWallet || sdk.signer;
    if (!signer) return;
    rescueBusy = true;
    try {
      const c = (P) => { const a = zk.aff(P); return [a.x, a.y]; };
      const tx = await roomZk.connect(signer).proveResponsive(t, c(sh.d), c(sh.proof.R1), c(sh.proof.R2), sh.proof.s);
      await tx.wait();
      console.warn("[zk-agent] self-rescued: posted the demanded share on-chain (card idx " + idx + ")");
    } finally { rescueBusy = false; }
  }

  async function sign(t, dealId) {
    const k = `${t}:${dealId}`;
    if (!sigCache.has(k)) sigCache.set(k, await sdk.signZk(t, dealId));
    return sigCache.get(k);
  }

  // per-hand secret: created once, survives refresh via sessionStorage
  function secretFor(t, dealId, domain) {
    const key = secKey(t, dealId);
    const prev = sessionStorage.getItem(key);
    if (prev) {
      const x = BigInt(prev);
      return { x, X: G1.BASE.multiply(x) };
    }
    const kg = zk.keygen(domain);
    try { sessionStorage.setItem(key, hex(kg.x)); } catch (_) {}
    return { x: kg.x, X: kg.X, pok: kg.pok };
  }

  async function post(pathname, body) {
    const r = await fetch(`${api}${pathname}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `zk ${pathname} ${r.status}`);
    return out;
  }

  async function iteration() {
    const t = Number(getTableId());
    if (!Number.isFinite(t) || !sdk.address) return;

    // the table snapshot carries the protocol phase + dealId (public info)
    let snap;
    try {
      const r = await fetch(`${api}/snapshot?t=${t}`, { signal: AbortSignal.timeout(2500) });
      if (!r.ok) return;
      snap = await r.json();
    } catch (_) { return; }
    const zs = snap && snap.zk;
    window.__SPZK.status[t] = zs || null;
    if (!zs || !zs.dealId) return;
    await runDeal(t, zs.dealId);
    // pre-deal: while the live hand shows down, the bot runs the NEXT hand's
    // setup under a second dealId · same protocol, same secrecy gates (that
    // deal has no live hand yet, so the street gate reads -1: own-hole and
    // board shares stay locked; only the harmless others'-holes pre-collect
    // and the shuffle itself go out early).
    if (zs.next && zs.next.dealId && zs.next.dealId !== zs.dealId) {
      try { await runDeal(t, zs.next.dealId); } catch (e) {
        if (!/stale dealId|not collecting|not your/i.test(e.message || "")) console.warn("[zk-agent] predeal:", e.message || e);
      }
    }
  }

  // Deals whose ON-CHAIN data is gone (a strike re-deal replaces the deal and
  // wipes the old ciphertexts - ctHash then panics ARRAY_RANGE_ERROR). Parked
  // with an expiry rather than forever: the relay moves to a fresh dealId
  // within seconds, and if this one somehow revives, we retry after the pause.
  const deadDeals = new Map(); // String(dealId) -> retry-after timestamp
  const parkDeal = (dealId, why) => {
    if (!deadDeals.has(String(dealId))) console.warn(`[zk-agent] deal ${dealId}: ${why} - parked 45s`);
    deadDeals.set(String(dealId), Date.now() + 45_000);
    if (deadDeals.size > 64) { // prune the oldest so the map can't grow all session
      const oldest = [...deadDeals.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) deadDeals.delete(oldest[0]);
    }
  };

  async function runDeal(t, dealId) {
    if ((deadDeals.get(String(dealId)) || 0) > Date.now()) return;
    const signature = await sign(t, dealId);
    const task = await post("/zk/task", { tableId: t, dealId, signature });
    if (task.observer || task.phase === "none" || task.participant === undefined) return;

    // while OTHERS shuffle, verify the posted stages in the background so the
    // full-chain check is (mostly) done before shares are requested
    if ((task.phase === "shuffle" || task.phase === "holeshares") && task.do !== "shuffle" && task.do !== "shuffleproof") {
      preverifyChain(t, dealId, signature).catch(() => {});
    }

    if (task.do === "key") {
      const sec = secretFor(t, dealId, task.domain);
      // PoK might be missing when the secret was restored from storage · redo it
      let pok = sec.pok;
      if (!pok) {
        const k = zk.randScalar();
        const R = G1.BASE.multiply(k);
        // Schnorr for the existing x: c = H(domain ‖ X ‖ R); s = k + c·x
        const cBytes = ethers.keccak256(ethers.concat([
          ethers.toUtf8Bytes(task.domain),
          ethers.toBeHex(zk.aff(sec.X).x, 32), ethers.toBeHex(zk.aff(sec.X).y, 32),
          ethers.toBeHex(zk.aff(R).x, 32), ethers.toBeHex(zk.aff(R).y, 32),
        ]));
        const n = bn254.G1.CURVE.n;
        const c = BigInt(cBytes) % n;
        const s = (k + c * sec.x) % n;
        pok = { R, s };
      }
      // seat-binding signature: proves to every OTHER client that THIS pubkey
      // belongs to my seat, so a coordinator can't substitute its own key here
      const a = zk.aff(sec.X);
      const keySig = await sdk.signZkKeyBinding(t, dealId, task.mySeat, a.x, a.y);
      await post("/zk/key", { tableId: t, dealId, signature, X: serPt(sec.X), pokR: serPt(pok.R), pokS: hex(pok.s), keySig });
      return;
    }

    if (task.do === "shuffle") {
      const deck = task.deck.map(parseCt);
      // first shuffler sees the plaintext deck · verify it's the canonical one
      if (task.first) {
        const pts = zk.deckPoints();
        for (let j = 0; j < 52; j++) {
          if (!deck[j].A.equals(G1.ZERO) || !deck[j].B.equals(pts[j])) throw new Error("non-canonical initial deck");
        }
      }
      const X = parsePt(task.aggKey);
      const out = zk.shuffleRemask(deck, X);
      const wireDeck = out.deck.map(serCt);
      const outHash = deckHashHex(wireDeck);
      // secret + PIN survive F5 so that after a reload I can still (a) produce
      // the proof and (b) verify the served chain actually contains MY shuffle -
      // without the persisted pin, a fully-colluding table + coordinator could
      // drop a refreshed player's shuffle and learn their cards.
      try {
        sessionStorage.setItem(shufKey(t, dealId), JSON.stringify({
          turn: task.participant, perm: out.secret.perm, rho: out.secret.rho.map((r) => hex(r)),
          outHash, aggKey: serPt(X),
        }));
      } catch (_) {}
      myShuffle.set(dealId, { outHash, aggKey: X });
      // deck goes out FIRST (the next shuffler proceeds immediately); the
      // Wikström proof of this shuffle is computed right after and streams in
      // behind it · proving pipelines with the next player's shuffle.
      await post("/zk/shuffle", { tableId: t, dealId, signature, deck: wireDeck });
      const prf = zk.proveShuffle(`SPZK:${dealId}:shuffle:${task.participant}`, deck, out.deck, X, out.secret);
      await post("/zk/shuffleproof", { tableId: t, dealId, signature, turn: task.participant, proof: zk.shuffleProofToWire(prf) });
      return;
    }

    // F5-recovery: deck already posted, proof still owed · decks come from the
    // task, the secret {perm, rho} from sessionStorage.
    if (task.do === "shuffleproof") {
      const saved = sessionStorage.getItem(shufKey(t, dealId));
      if (!saved) return; // secret lost with the tab · the deadline will strike us
      const sec = JSON.parse(saved);
      if (Number(sec.turn) !== Number(task.turn)) return;
      const inDeck = task.inDeck.map(parseCt);
      const outDeck = task.outDeck.map(parseCt);
      const X = parsePt(task.aggKey);
      const secret = { perm: sec.perm.map(Number), rho: sec.rho.map((r) => BigInt(r)) };
      const prf = zk.proveShuffle(task.domain, inDeck, outDeck, X, secret);
      await post("/zk/shuffleproof", { tableId: t, dealId, signature, turn: task.turn, proof: zk.shuffleProofToWire(prf) });
      return;
    }

    if (task.do === "shares") {
      // HARD GATE: not a single decryption share leaves this tab until I have
      // verified the ENTIRE shuffle chain myself. A deck that isn't a proven
      // permutation could have my own card's ciphertext planted in another
      // player's slot · my share would then help decrypt MY card to them.
      // (an incomplete chain isn't cached → retried next poll; a verified-BAD
      // verdict is cached → this deal is dead to us permanently)
      const secForGate = secretFor(t, dealId, "");
      const verdict = await verifyChain(t, dealId, signature, task.participant, secForGate.X);
      if (!verdict.ok) return;
      const sec = secForGate;
      // read the hand street FROM CHAIN (never the bot) to gate share release
      const hand = await roomZk.getHand(t);
      const street = (hand.inProgress && String(hand.dealId) === String(dealId)) ? Number(hand.street) : -1;
      // if I FOLDED, my hole cards are never shown · refuse own-hole shares even
      // at showdown (a malicious bot must not harvest folded players' cards).
      // k and my seat come from the VERIFIED chain (verdict), never from the task:
      // an inflated task.k would reclassify a board ciphertext as "someone else's
      // hole" (unconditionally releasable), and a task.mySeat pointed at a still-
      // live seat would defeat the fold gate below. task.participant is safe · it
      // was pinned to my own key inside verifyChain.
      const k = verdict.k;
      const mySeat = verdict.seats[task.participant];
      const wantsOwnHole = task.idxs.some((idx) => idx < 2 * k && Math.floor(idx / 2) === task.participant);
      let amFolded = false;
      if (wantsOwnHole && street === 4) {
        try { amFolded = !(await roomZk.getSeatHand(t, mySeat)).inHand; } catch (_) { amFolded = true; }
      }
      const items = [];
      for (const idx of task.idxs) {
        const own = idx < 2 * k && Math.floor(idx / 2) === task.participant;
        if (own && amFolded) { console.warn(`[zk-agent] refusing own-hole share idx ${idx} · I folded`); continue; }
        if (!mayRelease(idx, k, task.participant, street)) {
          console.warn(`[zk-agent] refusing to release share idx ${idx} at street ${street} (secrecy gate)`);
          continue; // the coordinator asked too early · never comply
        }
        const ct = parseCt(task.cts[idx]);
        const sh = zk.decryptionShare(ct, sec.x, G1.BASE.multiply(sec.x), task.domains[idx]);
        items.push({ idx, d: serPt(sh.d), R1: serPt(sh.proof.R1), R2: serPt(sh.proof.R2), s: hex(sh.proof.s) });
      }
      if (items.length) await post("/zk/shares", { tableId: t, dealId, signature, items });
    }

    // my own hole cards: verify everything, then decrypt locally
    if (task.myHoles && !window.__SPZK.holes[String(dealId)]) {
      // the deal the room bound on-chain must commit to the EXACT proof chain
      // I verified · otherwise the coordinator swapped decks after the proofs
      const verdict = chainVerdict.get(dealId);
      if (verdict && verdict.ok) {
        const onchain = await zkd.proofHash(dealId);
        if (onchain !== ethers.ZeroHash && onchain !== verdict.hash) {
          console.error("[zk-agent] on-chain proofHash mismatch · refusing this deal");
          chainVerdict.set(dealId, { ok: false, hash: verdict.hash });
          return;
        }
      }
      const sec = secretFor(t, dealId, "");
      const pubkeys = (task.pubkeys || []).map(parsePt);
      const cards = [];
      const idxs = Object.keys(task.myHoles).map(Number).sort((a, b) => a - b);
      for (const idx of idxs) {
        const h = task.myHoles[idx];
        const ct = parseCt(h.ct);
        // 1. the ciphertext I'm about to decrypt is the one committed on-chain
        const a = zk.aff(ct.A), b = zk.aff(ct.B);
        const packed = ethers.concat([ethers.toBeHex(a.x, 32), ethers.toBeHex(a.y, 32), ethers.toBeHex(b.x, 32), ethers.toBeHex(b.y, 32)]);
        let want;
        try {
          want = await zkd.ctHash(dealId, idx);
        } catch (e) {
          // ARRAY_RANGE panic = the deal no longer exists on-chain (re-deal
          // after a strike). Retrying is pointless and each retry logs a huge
          // CALL_EXCEPTION object - this exact loop ate players' RAM at the
          // first tournament. Park and wait for the relay's fresh dealId.
          if (/Panic|ARRAY_RANGE|CALL_EXCEPTION|missing revert data/i.test(e.message || "")) {
            parkDeal(dealId, "on-chain deal data gone (re-deal)");
            return;
          }
          throw e;
        }
        if (ethers.keccak256(packed) !== want) throw new Error("hole ct mismatch vs on-chain commitment");
        // 2. every relayed share is proof-checked against its sender's key
        const ds = [];
        for (const s of h.shares) {
          if (!s) continue;
          const d = parsePt(s.d);
          if (s.proof && pubkeys[s.i]) {
            const share = { d, proof: { R1: parsePt(s.proof.R1), R2: parsePt(s.proof.R2), s: BigInt(s.proof.s) } };
            if (!zk.verifyShare(ct, pubkeys[s.i], share, `SPZK:${dealId}:share:${idx}:${s.i}`)) {
              throw new Error("relayed share failed verification");
            }
            ds.push(d);
          } else ds.push(d);
        }
        const M = zk.decryptWithShares(ct, ds, sec.x);
        const card = zk.pointToCard(M, zk.deckPoints());
        if (card < 0) throw new Error("hole decryption produced a non-card");
        cards.push(card);
      }
      window.__SPZK.holes[String(dealId)] = { seat: task.mySeat, cards, cardsStr: cards.map(cardStr) };
      try { window.dispatchEvent(new CustomEvent("shinypoker:zk-holes", { detail: { tableId: t, dealId } })); } catch (_) {}
    }
  }

  // Errors: back off when they repeat (a broken state otherwise spins at full
  // tick rate) and never print the same message more than once per burst - the
  // console retains every logged object, so spam IS a memory leak.
  let errStreak = 0, errBackoffUntil = 0, lastErrMsg = "", lastErrCount = 0;
  const logErrOnce = (msg) => {
    if (msg === lastErrMsg) {
      if (++lastErrCount % 40 === 0) console.warn(`[zk-agent] (still) ${msg} ×${lastErrCount}`);
      return;
    }
    lastErrMsg = msg; lastErrCount = 1;
    console.warn("[zk-agent]", msg);
  };

  const tick = async () => {
    if (running || stopped) return;
    if (Date.now() < errBackoffUntil) return;
    running = true;
    try {
      await iteration();
      errStreak = 0; lastErrMsg = ""; lastErrCount = 0;
    } catch (e) {
      const msg = e.message || String(e);
      if (!/stale dealId|not collecting|not your|snapshot/i.test(msg)) logErrOnce(msg);
      if (++errStreak >= 3) {
        errBackoffUntil = Date.now() + Math.min(8_000, 1_000 * 2 ** (errStreak - 3));
      }
    } finally { running = false; }
    // Accusation watch runs on the CHAIN, not the bot relay, every ~3.5s · the
    // 45s rescue window leaves plenty of margin even with a couple of misses.
    if (++ticks % 10 === 0 && sdk.address) {
      const t = Number(getTableId());
      if (Number.isFinite(t)) selfRescue(t).catch((e) => console.warn("[zk-agent] rescue check:", e.message || e));
    }
  };

  // The ticker lives in a dedicated Worker: browsers throttle MAIN-THREAD
  // timers in background tabs to >=1s (and harder under "intensive throttling"),
  // which is exactly why the table you were not watching kept missing its key/
  // shuffle deadlines at the first tournament. Worker timers are exempt, so the
  // deal protocol keeps its 350ms cadence even in a background tab.
  let timer = null, tickWorker = null;
  try {
    const src = "setInterval(function(){ postMessage(0); }, 350);";
    tickWorker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    tickWorker.onmessage = tick;
  } catch (_) {
    timer = setInterval(tick, 350); // CSP fallback: main-thread interval
  }
  // Coming back to the tab: resync immediately instead of waiting a tick.
  const onVis = () => { if (!document.hidden) { errBackoffUntil = 0; tick(); } };
  document.addEventListener("visibilitychange", onVis);

  return { stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    if (tickWorker) tickWorker.terminate();
    document.removeEventListener("visibilitychange", onVis);
  } };
}

/// Attach to the page: waits for the SDK to connect, follows the ?t= param
/// (in-place MTT table switches included).
export function autoStart(SP) {
  const getT = () => new URLSearchParams(location.search).get("t") ?? 0;
  let started = null;
  const tryStart = () => {
    if (started || !SP || !SP.sdk || !SP.sdk.address) return;
    started = startZkAgent(SP.sdk, getT);
    console.log("[zk-agent] active · your cards are decrypted locally, only by you");
  };
  tryStart();
  window.addEventListener("shinyluck:auth-state", tryStart);
  const iv = setInterval(() => { tryStart(); if (started) clearInterval(iv); }, 1000);
}
