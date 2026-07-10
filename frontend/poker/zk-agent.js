// zkShuffle v2 browser agent — the player's side of the mental-poker protocol.
// Runs silently in the table page: generates the per-hand key, shuffles the
// encrypted deck on its turn, provides decryption shares when the protocol
// needs them, and decrypts the player's OWN hole cards locally. The secret
// never leaves this tab (sessionStorage keeps it across F5 mid-hand), no
// wallet popups (messages are signed by the session key / headless signer),
// and the player pays zero gas — the coordinator posts everything, and the
// CONTRACT verifies every card cryptographically.
//
// Trust hygiene (what we re-check instead of believing the bot):
//   - first shuffler verifies the initial deck is the canonical 52 points
//   - every relayed decryption share is CP-verified against that player's key
//   - the ciphertexts of MY hole cards are checked against the ON-CHAIN
//     commitments (ctHash) before I trust what I see
import { bn254 } from "/vendor/noble-bn254.js";
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
  "function dealIdForHand(uint256 tableId, uint64 handId) view returns (uint256)",
  "function dealInfo(uint256 dealId) view returns (bool exists, bool bound, uint8 playerCount, uint256 tableId, uint64 handId, uint8[] seats)",
  "function boardRevealedCount(uint256 dealId) view returns (uint8)",
];
// Self-rescue path: read the accusation straight from the chain (NOT via the
// bot — a malicious coordinator is exactly the threat model here) and answer it.
const ROOM_ZK_ABI = [
  "function accusationOf(uint256 t) view returns (bool active, uint8 offenderSeat, uint16 cardIdx, uint64 handId, uint64 deadline, (uint256,uint256) ctA, (uint256,uint256) ctB)",
  "function seatOf(uint256 t, address player) view returns (uint8)",
  "function proveResponsive(uint256 t, (uint256,uint256) d, (uint256,uint256) R1, (uint256,uint256) R2, uint256 s)",
];

export function startZkAgent(sdk, getTableId) {
  const api = sdk.cfg.dealerApiUrl;
  const zkd = new ethers.Contract(sdk.cfg.zkTableDealer, ZKD_ABI, sdk.read);
  const roomZk = new ethers.Contract(sdk.cfg.pokerRoom, ROOM_ZK_ABI, sdk.read);
  const sigCache = new Map(); // dealId -> signature
  const secKey = (t, dealId) => `spzk:${sdk.cfg.pokerRoom.slice(2, 10)}:${t}:${dealId}`;
  let running = false;
  let stopped = false;
  let ticks = 0;
  let rescueBusy = false;

  // If an on-chain accusation names MY seat, compute the demanded share from the
  // ciphertext embedded in the accusation and post proveResponsive — this both
  // clears the (false or late) accusation and delivers the share, so an honest
  // player can never be penalized while their client is alive. Own-hole shares
  // are only ever surrendered once the board is complete (showdown/runout);
  // the contract enforces that too — this is defense in depth.
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
    const dealId = zs.dealId;

    const signature = await sign(t, dealId);
    const task = await post("/zk/task", { tableId: t, dealId, signature });
    if (task.observer || task.phase === "none" || task.participant === undefined) return;

    if (task.do === "key") {
      const sec = secretFor(t, dealId, task.domain);
      // PoK might be missing when the secret was restored from storage — redo it
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
      await post("/zk/key", { tableId: t, dealId, signature, X: serPt(sec.X), pokR: serPt(pok.R), pokS: hex(pok.s) });
      return;
    }

    if (task.do === "shuffle") {
      const deck = task.deck.map(parseCt);
      // first shuffler sees the plaintext deck — verify it's the canonical one
      if (task.first) {
        const pts = zk.deckPoints();
        for (let j = 0; j < 52; j++) {
          if (!deck[j].A.equals(G1.ZERO) || !deck[j].B.equals(pts[j])) throw new Error("non-canonical initial deck");
        }
      }
      const X = parsePt(task.aggKey);
      const out = zk.shuffleRemask(deck, X);
      await post("/zk/shuffle", { tableId: t, dealId, signature, deck: out.deck.map(serCt) });
      return;
    }

    if (task.do === "shares") {
      const sec = secretFor(t, dealId, "");
      const items = task.idxs.map((idx) => {
        const ct = parseCt(task.cts[idx]);
        const sh = zk.decryptionShare(ct, sec.x, G1.BASE.multiply(sec.x), task.domains[idx]);
        return { idx, d: serPt(sh.d), R1: serPt(sh.proof.R1), R2: serPt(sh.proof.R2), s: hex(sh.proof.s) };
      });
      await post("/zk/shares", { tableId: t, dealId, signature, items });
    }

    // my own hole cards: verify everything, then decrypt locally
    if (task.myHoles && !window.__SPZK.holes[String(dealId)]) {
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
        const want = await zkd.ctHash(dealId, idx);
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

  const timer = setInterval(async () => {
    if (running || stopped) return;
    running = true;
    try { await iteration(); } catch (e) {
      if (!/stale dealId|not collecting|not your|snapshot/i.test(e.message || "")) console.warn("[zk-agent]", e.message || e);
    } finally { running = false; }
    // Accusation watch runs on the CHAIN, not the bot relay, every ~3.5s — the
    // 45s rescue window leaves plenty of margin even with a couple of misses.
    if (++ticks % 5 === 0 && sdk.address) {
      const t = Number(getTableId());
      if (Number.isFinite(t)) selfRescue(t).catch((e) => console.warn("[zk-agent] rescue check:", e.message || e));
    }
  }, 700);

  return { stop() { stopped = true; clearInterval(timer); } };
}

/// Attach to the page: waits for the SDK to connect, follows the ?t= param
/// (in-place MTT table switches included).
export function autoStart(SP) {
  const getT = () => new URLSearchParams(location.search).get("t") ?? 0;
  let started = null;
  const tryStart = () => {
    if (started || !SP || !SP.sdk || !SP.sdk.address) return;
    started = startZkAgent(SP.sdk, getT);
    console.log("[zk-agent] active — your cards are decrypted locally, only by you");
  };
  tryStart();
  window.addEventListener("shinyluck:auth-state", tryStart);
  const iv = setInterval(() => { tryStart(); if (started) clearInterval(iv); }, 1000);
}
