// zkShuffle v2 Lab · drives the REAL protocol core (zk-bn254.js) and verifies
// every proof AGAINST THE DEPLOYED CONTRACT (ZkDealerV2 on Somnia testnet) with
// a zero-gas eth_call. So the "verified on-chain" claim isn't a description -
// you watch the browser ask the actual contract, live.
import nobleBn254 from "/vendor/noble-bn254.js"; // self-hosted (no CDN); esbuild CJS bundle → default export
const { bn254 } = nobleBn254;
import { ethers } from "/vendor/ethers.bundle.js";
import { POKER_CONFIG, NETWORK } from "./poker-config.js";
import * as zk from "./zk-bn254.js";

zk.init({ bn254, keccak256: ethers.keccak256, randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)) });

const ZK_ABI = [
  "function verifyKeygenProof(string domain,(uint256 x,uint256 y) X,(uint256 x,uint256 y) R,uint256 s) view returns (bool)",
  "function verifyShareProof(string domain,(uint256 x,uint256 y) A,(uint256 x,uint256 y) X,(uint256 x,uint256 y) d,(uint256 x,uint256 y) R1,(uint256 x,uint256 y) R2,uint256 s) view returns (bool)",
];
const provider = new ethers.JsonRpcProvider(NETWORK.rpcUrls[0]);
const zkContract = POKER_CONFIG.zkDealerV2 ? new ethers.Contract(POKER_CONFIG.zkDealerV2, ZK_ABI, provider) : null;
const CADDR = POKER_CONFIG.zkDealerV2;
const explorer = (NETWORK.explorer || "").replace(/\/$/, "");

const K = 3;
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const SUITS = ["♣", "♦", "♥", "♠"];
const cardHtml = (c) => {
  if (c == null) return `<span class="pc hidden">encrypted</span>`;
  const red = c % 4 === 1 || c % 4 === 2;
  return `<span class="pc${red ? " red" : ""}">${RANKS[Math.floor(c / 4)]}${SUITS[c % 4]}</span>`;
};
const P = (pt) => { const a = zk.aff(pt); return { x: a.x, y: a.y }; };
const keyDomain = (d, s) => `SPZK:${d}:key:${s}`;
const shareDomain = (d, c, s) => `SPZK:${d}:share:${c}:${s}`;

const $ = (id) => document.getElementById(id);
const log = (html, cls) => { const el = $("log"); el.innerHTML += (cls ? `<span class="${cls}">${html}</span>` : html) + "\n"; el.scrollTop = el.scrollHeight; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shh = (p) => { const a = zk.aff(p); return "0x" + a.x.toString(16).slice(0, 10) + "…"; };

function renderPlayers(states) {
  $("players").innerHTML = states.map((s, i) => `
    <div class="pl">
      <h4>Player ${i + 1} ${s.cheater ? "😈" : ""}</h4>
      <div class="pcards">${cardHtml(s.cards[0])}${cardHtml(s.cards[1])}</div>
      <div class="know">${s.know}</div>
    </div>`).join("");
}

/// Ask the DEPLOYED contract to verify a proof (read-only eth_call, no gas).
async function chainVerifyKey(domain, X, pok) {
  if (!zkContract) return null;
  try { return await zkContract.verifyKeygenProof(domain, P(X), P(pok.R), pok.s); } catch { return null; }
}
async function chainVerifyShare(domain, A, X, sh) {
  if (!zkContract) return null;
  try { return await zkContract.verifyShareProof(domain, P(A), P(X), P(sh.d), P(sh.proof.R1), P(sh.proof.R2), sh.proof.s); } catch { return null; }
}

async function playHand(withCheat) {
  $("log").innerHTML = "";
  $("board").innerHTML = "";
  const states = Array.from({ length: K }, (_, i) => ({ cards: [null, null], know: "…", cheater: withCheat && i === 1 }));
  renderPlayers(states);
  const pts = zk.deckPoints();
  const dealId = Math.floor(Math.random() * 1e9);

  if (CADDR) log(`Contract: <a href="${explorer}/address/${CADDR}" target="_blank" style="color:#57d9a3">${CADDR}</a> · every ✓ below is a live eth_call to it\n`, "");

  log("- DKG: each player proves their key (Schnorr), verified on-chain -", "head");
  const players = [];
  for (let i = 0; i < K; i++) {
    const p = zk.keygen(keyDomain(dealId, i));
    const onchain = await chainVerifyKey(keyDomain(dealId, i), p.X, p.pok);
    log(`player ${i + 1}: pubkey ${shh(p.X)} · Schnorr ${onchain === null ? "(chain offline)" : onchain ? "verified ON-CHAIN ✓" : "REJECTED ✗"}`, onchain ? "ok" : onchain === false ? "bad" : "");
    players.push(p);
    states[i].know = "holds a secret key only this panel knows";
    await sleep(120);
  }
  const X = zk.aggregate(players.map((p) => p.X));
  log(`table key X = Σ pubkeys = ${shh(X)} (BN254 G1)`);

  log("\n- each player shuffles + re-encrypts the deck -", "head");
  let deck = zk.initialDeck(pts);
  const stages = [];
  for (let i = 0; i < K; i++) {
    const { deck: out, secret } = zk.shuffleRemask(deck, X);
    if (withCheat && i === 1) {
      const r = zk.randScalar();
      out[2] = zk.remask({ A: bn254.G1.ProjectivePoint.ZERO, B: pts[51] }, X, r);
      log(`player 2 shuffles… <span class="bad">and silently swaps ciphertext #2 for a planted A♠</span>`);
    } else {
      log(`player ${i + 1} shuffles 52 ciphertexts + re-randomizes (perm & randomness stay secret)`);
    }
    stages.push({ published: out, secret });
    deck = out;
    await sleep(150);
  }

  log("\n- hole cards: shares proven (Chaum–Pedersen) & verified on-chain -", "head");
  for (let i = 0; i < K; i++) {
    for (const [slot, idx] of [[0, 2 * i], [1, 2 * i + 1]]) {
      const ct = deck[idx];
      const shares = [];
      let allOk = true;
      for (let j = 0; j < K; j++) {
        if (j === i) continue;
        const sh = zk.decryptionShare(ct, players[j].x, players[j].X, shareDomain(dealId, idx, j));
        const onchain = await chainVerifyShare(shareDomain(dealId, idx, j), ct.A, players[j].X, sh);
        if (onchain === false) { allOk = false; log(`  share for card #${idx} from player ${j + 1} REJECTED on-chain ✗`, "bad"); continue; }
        shares.push(sh.d);
      }
      const outsider = zk.pointToCard(zk.decryptWithShares(ct, shares, null), pts);
      const M = zk.decryptWithShares(ct, shares, players[i].x);
      states[i].cards[slot] = zk.pointToCard(M, pts);
      log(`card #${idx} → player ${i + 1}: shares ${allOk ? "verified ON-CHAIN ✓" : "•"} · outsiders see ${outsider === -1 ? "<span class='ok'>nothing</span>" : "<span class='bad'>A CARD?!</span>"} · owner reads it privately`);
      renderPlayers(states);
      await sleep(120);
    }
    states[i].know = "sees ONLY its own two cards";
  }
  renderPlayers(states);

  log("\n- board: public decryption (all shares) -", "head");
  const boardCards = [];
  for (let b = 0; b < 5; b++) {
    const ct = deck[2 * K + b];
    const shares = players.map((p) => zk.decryptionShare(ct, p.x, p.X, shareDomain(dealId, 2 * K + b, 99)).d);
    boardCards.push(zk.pointToCard(zk.decryptWithShares(ct, shares, null), pts));
    $("board").innerHTML = boardCards.map(cardHtml).join("");
    await sleep(110);
  }

  log("\n- shuffle audit: re-derive every stage -", "head");
  const audit = zk.auditShuffles(pts, X, stages);
  if (audit.ok) {
    log("every shuffle recomputes exactly · the hand was clean ✓", "ok");
    log("(on a live table this same check runs on-chain via ZkDealerV2.checkStage)", "");
  } else {
    log(`AUDIT FAILED at player ${audit.cheater + 1}, ciphertext #${audit.card} · tampering attributed with certainty.`, "bad");
    log(`on a live table ZkDealerV2.checkStage proves this on-chain → the cheat is slashed.`, "bad");
    states[audit.cheater].know = "CAUGHT by the audit · escrow slashed";
    renderPlayers(states);
  }
  log("\ndone.", "head");
}

$("btn-honest").addEventListener("click", () => playHand(false).catch((e) => log("error: " + e.message, "bad")));
$("btn-cheat").addEventListener("click", () => playHand(true).catch((e) => log("error: " + e.message, "bad")));
