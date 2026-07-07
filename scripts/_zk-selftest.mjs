// zkShuffle v2 core selftest — runs the FULL mental-poker hand off-chain and
// then attacks it. Exits 0 only if every honest property holds AND the cheat
// is caught and attributed.  node scripts/_zk-selftest.mjs
import { secp256k1 } from "@noble/curves/secp256k1";
import { ethers } from "ethers";
import crypto from "node:crypto";
import * as zk from "../frontend/poker/zk-poker.js";

zk.init({ curve: secp256k1, keccak256: ethers.keccak256, randomBytes: (n) => crypto.randomBytes(n) });

const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } console.log("  ✓", msg); };

const K = 3; // players
const pts = zk.deckPoints();
const ctx = "table:0:hand:1";

console.log("== DKG ==");
const players = Array.from({ length: K }, () => zk.keygen(ctx));
for (const p of players) assert(zk.verifyPok(ctx, p.X, p.pok), "Schnorr PoK verifies");
const X = zk.aggregate(players.map((p) => p.X));

console.log("== shuffles (each player, secret perm+rho) ==");
let deck = zk.initialDeck(pts);
const stages = [];
for (let i = 0; i < K; i++) {
  const { deck: out, secret } = zk.shuffleRemask(deck, X);
  stages.push({ published: out, secret });
  deck = out;
}

console.log("== hole cards: each player decrypts ONLY their own ==");
// convention: card 2i, 2i+1 -> player i (like the live dealer)
const dealt = [];
for (let i = 0; i < K; i++) {
  for (const idx of [2 * i, 2 * i + 1]) {
    const ct = deck[idx];
    // all OTHER players publish shares with CP proofs
    const shares = [];
    for (let j = 0; j < K; j++) {
      if (j === i) continue;
      const sh = zk.decryptionShare(ct, players[j].x, players[j].X, ctx + ":card" + idx);
      assert(zk.verifyShare(ct, players[j].X, sh, ctx + ":card" + idx), `CP share proof ok (card ${idx} from p${j})`);
      shares.push(sh.d);
    }
    const M = zk.decryptWithShares(ct, shares, players[i].x);
    const card = zk.pointToCard(M, pts);
    assert(card >= 0, `player ${i} decrypted a REAL card (${card})`);
    // an outsider (or any single other player) holding the same public shares
    // but NOT the owner's secret must land outside the deck:
    const outsider = zk.decryptWithShares(ct, shares, null);
    assert(zk.pointToCard(outsider, pts) === -1, `without the owner's key card ${idx} stays hidden`);
    dealt.push(card);
  }
}
assert(new Set(dealt).size === dealt.length, "no duplicate cards dealt");

console.log("== board: public decryption with all shares ==");
const bIdx = 2 * K;
const bCt = deck[bIdx];
const bShares = players.map((p) => zk.decryptionShare(bCt, p.x, p.X, ctx + ":board0").d);
const board0 = zk.pointToCard(zk.decryptWithShares(bCt, bShares, null), pts);
assert(board0 >= 0 && !dealt.includes(board0), "board card decrypts publicly and is fresh");

console.log("== post-hand audit (honest) ==");
assert(zk.auditShuffles(pts, X, stages).ok, "honest shuffle chain passes the audit");

console.log("== ATTACK: player 1 swaps a ciphertext for a chosen ace during their shuffle ==");
{
  let d2 = zk.initialDeck(pts);
  const st = [];
  for (let i = 0; i < K; i++) {
    const { deck: out, secret } = zk.shuffleRemask(d2, X);
    if (i === 1) {
      // cheater plants an encryption of card 51 where THEIR hole card will be
      const r = zk.randScalar();
      out[2] = zk.remask({ A: secp256k1.ProjectivePoint.ZERO, B: pts[51] }, X, r);
    }
    st.push({ published: out, secret });
    d2 = out;
  }
  const audit = zk.auditShuffles(pts, X, st);
  assert(!audit.ok, "tampered chain FAILS the audit");
  assert(audit.cheater === 1, `the audit attributes it to the exact cheater (player ${audit.cheater})`);
}

console.log("== ATTACK: forged decryption share is rejected by the CP proof ==");
{
  const ct = deck[0];
  const honest = zk.decryptionShare(ct, players[1].x, players[1].X, ctx + ":card0");
  const forged = { d: honest.d.add(secp256k1.ProjectivePoint.BASE), proof: honest.proof };
  assert(!zk.verifyShare(ct, players[1].X, forged, ctx + ":card0"), "forged share rejected");
}

console.log("\nALL GREEN — the v2 core holds: secrecy in-hand, deterministic cheat attribution post-hand.");
