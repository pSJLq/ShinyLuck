// zkShuffle v2 Lab — drives the REAL protocol core (zk-poker.js) in the page.
// Three simulated players, honest + cheating runs, full transcript in the log.
import { secp256k1 } from "https://esm.sh/@noble/curves@1.9.2/secp256k1";
import { ethers } from "/vendor/ethers.bundle.js";
import * as zk from "./zk-poker.js";

zk.init({
  curve: secp256k1,
  keccak256: ethers.keccak256,
  randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
});

const K = 3;
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const SUITS = ["♣", "♦", "♥", "♠"];
const cardHtml = (c) => {
  if (c == null) return `<span class="pc hidden">encrypted</span>`;
  const red = c % 4 === 1 || c % 4 === 2;
  return `<span class="pc${red ? " red" : ""}">${RANKS[Math.floor(c / 4)]}${SUITS[c % 4]}</span>`;
};

const $ = (id) => document.getElementById(id);
const log = (html, cls) => { const el = $("log"); el.innerHTML += (cls ? `<span class="${cls}">${html}</span>` : html) + "\n"; el.scrollTop = el.scrollHeight; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shh = (p) => p.toHex(true).slice(0, 14) + "…";

function renderPlayers(states) {
  $("players").innerHTML = states.map((s, i) => `
    <div class="pl">
      <h4>Player ${i + 1} ${s.cheater ? "😈" : ""}</h4>
      <div class="pcards">${cardHtml(s.cards[0])}${cardHtml(s.cards[1])}</div>
      <div class="know">${s.know}</div>
    </div>`).join("");
}

async function playHand(withCheat) {
  $("log").innerHTML = "";
  $("board").innerHTML = "";
  const states = Array.from({ length: K }, (_, i) => ({ cards: [null, null], know: "…", cheater: withCheat && i === 1 }));
  renderPlayers(states);
  const pts = zk.deckPoints();
  const ctx = "lab:" + Date.now();

  log("— DKG: aggregate table key —", "head");
  const players = [];
  for (let i = 0; i < K; i++) {
    const p = zk.keygen(ctx);
    const ok = zk.verifyPok(ctx, p.X, p.pok);
    log(`player ${i + 1}: pubkey ${shh(p.X)} · Schnorr PoK ${ok ? "✓" : "✗"}`, ok ? "ok" : "bad");
    players.push(p);
    states[i].know = "holds a secret key only this panel knows";
    await sleep(120);
  }
  const X = zk.aggregate(players.map((p) => p.X));
  log(`table key X = Σ pubkeys = ${shh(X)}`);

  log("\n— each player shuffles + re-encrypts the deck —", "head");
  let deck = zk.initialDeck(pts);
  const stages = [];
  for (let i = 0; i < K; i++) {
    const { deck: out, secret } = zk.shuffleRemask(deck, X);
    if (withCheat && i === 1) {
      const r = zk.randScalar();
      out[2] = zk.remask({ A: secp256k1.ProjectivePoint.ZERO, B: pts[51] }, X, r); // plants A♠ for their own hole
      log(`player 2 shuffles… <span class="bad">and silently swaps ciphertext #2 for a planted A♠</span>`);
    } else {
      log(`player ${i + 1} shuffles 52 ciphertexts + re-randomizes (perm & randomness stay secret until audit)`);
    }
    stages.push({ published: out, secret });
    deck = out;
    await sleep(160);
  }
  log(`deck is now encrypted under EVERYONE's keys — e.g. card #0 = (${shh(deck[0].A)}, ${shh(deck[0].B)})`);

  log("\n— hole cards: shares from others, owner decrypts alone —", "head");
  for (let i = 0; i < K; i++) {
    for (const [slot, idx] of [[0, 2 * i], [1, 2 * i + 1]]) {
      const ct = deck[idx];
      const shares = [];
      for (let j = 0; j < K; j++) {
        if (j === i) continue;
        const sh = zk.decryptionShare(ct, players[j].x, players[j].X, ctx + ":c" + idx);
        const ok = zk.verifyShare(ct, players[j].X, sh, ctx + ":c" + idx);
        if (!ok) { log(`player ${j + 1}'s share for card #${idx} FAILED its Chaum–Pedersen proof — rejected`, "bad"); continue; }
        shares.push(sh.d);
      }
      const outsider = zk.pointToCard(zk.decryptWithShares(ct, shares, null), pts);
      const M = zk.decryptWithShares(ct, shares, players[i].x);
      const card = zk.pointToCard(M, pts);
      states[i].cards[slot] = card;
      log(`card #${idx} → player ${i + 1}: shares proven ✓ · outsiders see ${outsider === -1 ? "<span class='ok'>nothing (not a valid card point)</span>" : "<span class='bad'>A CARD?!</span>"} · owner reads it privately`);
      renderPlayers(states);
      await sleep(140);
    }
    states[i].know = "sees ONLY its own two cards — the others' stay encrypted";
  }
  renderPlayers(states);

  log("\n— board: public decryption (all shares) —", "head");
  const boardCards = [];
  for (let b = 0; b < 5; b++) {
    const ct = deck[2 * K + b];
    const shares = players.map((p) => zk.decryptionShare(ct, p.x, p.X, ctx + ":b" + b).d);
    boardCards.push(zk.pointToCard(zk.decryptWithShares(ct, shares, null), pts));
    $("board").innerHTML = boardCards.map(cardHtml).join("");
    await sleep(120);
  }

  log("\n— post-hand audit: everyone opens their shuffle —", "head");
  const audit = zk.auditShuffles(pts, X, stages);
  if (audit.ok) {
    log("every shuffle recomputes exactly — the hand was clean ✓", "ok");
  } else {
    log(`AUDIT FAILED at player ${audit.cheater + 1}, ciphertext #${audit.card} — the tampering is attributed with certainty.`, "bad");
    log(`on a live table this voids the hand and slashes player ${audit.cheater + 1}'s escrowed stack.`, "bad");
    states[audit.cheater].know = "CAUGHT by the audit — escrow slashed";
    renderPlayers(states);
  }
  log("\ndone.", "head");
}

$("btn-honest").addEventListener("click", () => playHand(false).catch((e) => log("error: " + e.message, "bad")));
$("btn-cheat").addEventListener("click", () => playHand(true).catch((e) => log("error: " + e.message, "bad")));
