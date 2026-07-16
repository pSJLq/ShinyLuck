// Bridges the ES-module SDK into the design's classic-script React layer.
// The live table app (poker-live-table.jsx, loaded via Babel) reads window.SP.
import { ethers } from "/vendor/ethers.bundle.js";
import { ShinyPoker, ACTION, STREET, STREET_NAME, TRN_STATUS, fmt } from "./poker-sdk.js";
import { POKER_CONFIG, NETWORK } from "./poker-config.js";

const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const SUITS = ["c", "d", "h", "s"];
// int 0..51 -> design card string like "As" (255/undefined -> null)
const intToCardStr = (c) => (c == null || c === 255 ? null : RANKS[Math.floor(c / 4)] + SUITS[c % 4]);

// Human-readable best hand from 2..7 card ints (hole + visible board).
// Plain TIER names only ("Pair", "Full House") · the rank details ("Pair of
// Sevens") read as noise at the table; the highlighted cards say the rest.
function handName(cards) {
  const ev = handEval(cards);
  if (!ev) return "";
  return ["High Card", "Pair", "Two Pair", "Three of a Kind", "Straight", "Flush", "Full House", "Four of a Kind", ev.royal ? "Royal Flush" : "Straight Flush"][ev.cat];
}

// Numeric strength of the same best hand: category 0 (high card) … 8 (straight
// flush / royal) plus packed tiebreak kickers. The UI tiers the combo badge by
// `cat` and picks the showdown winner by comparing `score`.
function handEval(cards) {
  const cs = (cards || []).filter((c) => c != null && c !== 255);
  if (cs.length < 2) return null;
  const rc = new Array(13).fill(0), bySuit = [[], [], [], []], byRank = Array.from({ length: 13 }, () => []);
  let mask = 0;
  for (const c of cs) { const r = Math.floor(c / 4), s = c % 4; rc[r]++; bySuit[s].push(r); byRank[r].push(c); mask |= 1 << r; }
  const straightHigh = (m) => {
    for (let top = 12; top >= 4; top--) { let ok = true; for (let d = 0; d < 5; d++) if (!(m & (1 << (top - d)))) { ok = false; break; } if (ok) return top; }
    const wheel = (1 << 12) | 1 | 2 | 4 | 8; return (m & wheel) === wheel ? 3 : -1;
  };
  const kick = (n, skip) => { const out = []; for (let r = 12; r >= 0 && out.length < n; r--) if ((mask & (1 << r)) && skip.indexOf(r) < 0) out.push(r); return out; };
  const S = (cat, ks) => { let v = cat; for (let i = 0; i < 5; i++) v = v * 16 + (ks[i] != null ? ks[i] + 1 : 0); return v; };
  // `used` · the exact five card ints forming the best hand, so the UI can
  // highlight the combination itself (and dim the cards that play no part)
  const ofRank = (r, n, suit) => {
    const src = suit == null ? byRank[r] : byRank[r].filter((c) => c % 4 === suit);
    return src.slice(0, n);
  };
  const straightUsed = (top, suit) => {
    const ranks = top === 3 ? [3, 2, 1, 0, 12] : [top, top - 1, top - 2, top - 3, top - 4]; // 3 = wheel (5-4-3-2-A)
    return ranks.map((r) => ofRank(r, 1, suit)[0]);
  };
  let flushSuit = -1; for (let s = 0; s < 4; s++) if (bySuit[s].length >= 5) flushSuit = s;
  if (flushSuit >= 0) {
    let sm = 0; for (const r of bySuit[flushSuit]) sm |= 1 << r;
    const sf = straightHigh(sm);
    if (sf >= 0) return { cat: 8, royal: sf === 12, score: S(8, [sf]), used: straightUsed(sf, flushSuit) };
  }
  let quad = -1; const trips = [], pairs = [];
  for (let r = 12; r >= 0; r--) { if (rc[r] === 4) quad = r; else if (rc[r] === 3) trips.push(r); else if (rc[r] === 2) pairs.push(r); }
  if (quad >= 0) { const ks = kick(1, [quad]); return { cat: 7, score: S(7, [quad].concat(ks)), used: ofRank(quad, 4).concat(ks.length ? ofRank(ks[0], 1) : []) }; }
  if (trips.length >= 1 && (pairs.length >= 1 || trips.length >= 2)) {
    const t = trips[0]; const p = trips.length >= 2 ? Math.max(trips[1], pairs.length ? pairs[0] : -1) : pairs[0];
    return { cat: 6, score: S(6, [t, p]), used: ofRank(t, 3).concat(ofRank(p, 2)) };
  }
  if (flushSuit >= 0) {
    const top5 = bySuit[flushSuit].slice().sort((a, b) => b - a).slice(0, 5);
    return { cat: 5, score: S(5, top5), used: top5.map((r) => ofRank(r, 1, flushSuit)[0]) };
  }
  const sh = straightHigh(mask); if (sh >= 0) return { cat: 4, score: S(4, [sh]), used: straightUsed(sh) };
  if (trips.length >= 1) { const ks = kick(2, [trips[0]]); return { cat: 3, score: S(3, [trips[0]].concat(ks)), used: ofRank(trips[0], 3).concat(ks.map((r) => ofRank(r, 1)[0])) }; }
  if (pairs.length >= 2) { const ks = kick(1, [pairs[0], pairs[1]]); return { cat: 2, score: S(2, [pairs[0], pairs[1]].concat(ks)), used: ofRank(pairs[0], 2).concat(ofRank(pairs[1], 2), ks.map((r) => ofRank(r, 1)[0])) }; }
  if (pairs.length === 1) { const ks = kick(3, [pairs[0]]); return { cat: 1, score: S(1, [pairs[0]].concat(ks)), used: ofRank(pairs[0], 2).concat(ks.map((r) => ofRank(r, 1)[0])) }; }
  const ks = kick(5, []);
  return { cat: 0, score: S(0, ks), used: ks.map((r) => ofRank(r, 1)[0]) };
}

window.SP = {
  sdk: new ShinyPoker(),
  ACTION, STREET, STREET_NAME, TRN_STATUS, fmt, intToCardStr, handName, handEval, NETWORK, POKER_CONFIG,
  parseEther: (v) => ethers.parseEther(String(v)),
  tableId: Number(new URLSearchParams(location.search).get("t") || 0),
};
// Globals the design's SideRail expects (live feeds can replace these later).
window.CHAT = [{ dealer: true, t: window.SP.sdk.zkLayer
  ? "Welcome · this table runs zkShuffle v2: the deck is shuffled by the players' own browsers and every card is proven on-chain. Nobody, not even our dealer bot, can see your hole cards."
  : "Welcome · this table is live on Somnia testnet. Provably-fair commit-reveal dealing." }];
window.HISTORY = [];

// zkShuffle v2: start the background protocol agent (keygen/shuffle/decryption
// shares run silently in this tab; your cards are decrypted locally, only by you).
if (window.SP.sdk.zkLayer) {
  import("./zk-agent.js").then((m) => m.autoStart(window.SP)).catch((e) => console.error("[zk-agent] load:", e));
}

window.dispatchEvent(new Event("sp:ready"));
