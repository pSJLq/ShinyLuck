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
const RNAME = ["Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Jack", "Queen", "King", "Ace"];
const PLURAL = ["Twos", "Threes", "Fours", "Fives", "Sixes", "Sevens", "Eights", "Nines", "Tens", "Jacks", "Queens", "Kings", "Aces"];
function handName(cards) {
  const cs = (cards || []).filter((c) => c != null && c !== 255);
  if (cs.length < 2) return "";
  const rc = new Array(13).fill(0), sc = new Array(4).fill(0), bySuit = [[], [], [], []];
  let mask = 0;
  for (const c of cs) { const r = Math.floor(c / 4), s = c % 4; rc[r]++; sc[s]++; bySuit[s].push(r); mask |= 1 << r; }
  const straightHigh = (m) => {
    for (let top = 12; top >= 4; top--) { let ok = true; for (let d = 0; d < 5; d++) if (!(m & (1 << (top - d)))) { ok = false; break; } if (ok) return top; }
    const wheel = (1 << 12) | 1 | 2 | 4 | 8; return (m & wheel) === wheel ? 3 : -1;
  };
  let flushSuit = -1; for (let s = 0; s < 4; s++) if (sc[s] >= 5) flushSuit = s;
  if (flushSuit >= 0) { let sm = 0; for (const r of bySuit[flushSuit]) sm |= 1 << r; const sf = straightHigh(sm); if (sf >= 0) return sf === 12 ? "Royal Flush" : "Straight Flush, " + RNAME[sf] + " high"; }
  let quad = -1; const trips = [], pairs = [];
  for (let r = 12; r >= 0; r--) { if (rc[r] === 4) quad = r; else if (rc[r] === 3) trips.push(r); else if (rc[r] === 2) pairs.push(r); }
  if (quad >= 0) return "Four of a Kind, " + PLURAL[quad];
  if (trips.length >= 1 && (pairs.length >= 1 || trips.length >= 2)) { const t = trips[0]; const p = trips.length >= 2 ? Math.max(trips[1], pairs.length ? pairs[0] : -1) : pairs[0]; return "Full House, " + PLURAL[t] + " full of " + PLURAL[p]; }
  if (flushSuit >= 0) return "Flush, " + RNAME[Math.max.apply(null, bySuit[flushSuit])] + " high";
  const sh = straightHigh(mask); if (sh >= 0) return "Straight, " + RNAME[sh] + " high";
  if (trips.length >= 1) return "Three of a Kind, " + PLURAL[trips[0]];
  if (pairs.length >= 2) return "Two Pair, " + PLURAL[pairs[0]] + " & " + PLURAL[pairs[1]];
  if (pairs.length === 1) return "Pair of " + PLURAL[pairs[0]];
  let hi = -1; for (let r = 12; r >= 0; r--) if (mask & (1 << r)) { hi = r; break; }
  return RNAME[hi] + " high";
}

window.SP = {
  sdk: new ShinyPoker(),
  ACTION, STREET, STREET_NAME, TRN_STATUS, fmt, intToCardStr, handName, NETWORK, POKER_CONFIG,
  parseEther: (v) => ethers.parseEther(String(v)),
  tableId: Number(new URLSearchParams(location.search).get("t") || 0),
};
// Globals the design's SideRail expects (live feeds can replace these later).
window.CHAT = [{ dealer: true, t: "Welcome — this table is live on Somnia testnet. Provably-fair commit-reveal dealing." }];
window.HISTORY = [];

window.dispatchEvent(new Event("sp:ready"));
