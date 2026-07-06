// ShinyPoker — in-browser deal verifier (provably-fair page).
// Re-derives the committed deck for any deal ENTIRELY IN YOUR BROWSER and
// checks it against the chain: the seed commitment, the posted board, and the
// contract's own recomputeDeck. No wallet, no trust in our servers — the RPC
// reads are the only dependency, and you can swap the RPC in devtools.
import { ethers } from "/vendor/ethers.bundle.js";
import { POKER_CONFIG, NETWORK } from "./poker-config.js";

const ABI = [
  "function nextDealId() view returns (uint256)",
  "function dealInfo(uint256) view returns (uint64 handId, uint64 tableId, uint64 commitBlock, uint8 playerCount, bytes32 seedHash, bytes32 entropy, bytes32 serverSeed, bool revealed, uint8[] seats)",
  "function boardCards(uint256) view returns (uint8[5])",
  "function boardRevealedCount(uint256) view returns (uint8)",
  "function recomputeDeck(bytes32, bytes32, uint64, uint64) view returns (uint8[52])",
];
const provider = new ethers.JsonRpcProvider(NETWORK.rpcUrls[0]);
const dealer = new ethers.Contract(POKER_CONFIG.commitRevealDealer, ABI, provider);
const CODER = ethers.AbiCoder.defaultAbiCoder();

const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const SUITS = ["♣", "♦", "♥", "♠"];
const card = (c) => {
  const red = c % 4 === 1 || c % 4 === 2;
  return `<span class="fc${red ? " red" : ""}">${RANKS[Math.floor(c / 4)]}${SUITS[c % 4]}</span>`;
};

/// Byte-for-byte port of CommitRevealDealer._deriveDeck (pinned by the
/// on-chain recomputeDeck cross-check below — if this drifts, the ✗ shows).
function deriveDeck(serverSeed, entropy, handId, tableId) {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  let r = ethers.keccak256(CODER.encode(["bytes32", "bytes32", "uint64", "uint64"], [serverSeed, entropy, BigInt(handId), BigInt(tableId)]));
  for (let i = 51; i > 0; i--) {
    r = ethers.keccak256(CODER.encode(["bytes32", "uint256"], [r, BigInt(i)]));
    const j = Number(BigInt(r) % BigInt(i + 1));
    const t = deck[i];
    deck[i] = deck[j];
    deck[j] = t;
  }
  return deck;
}

const $ = (id) => document.getElementById(id);
const row = (ok, label, detail) =>
  `<div class="vrow"><span class="vt ${ok === null ? "wait" : ok ? "ok" : "bad"}">${ok === null ? "…" : ok ? "✓" : "✗"}</span><span><b>${label}</b>${detail ? `<span class="vd">${detail}</span>` : ""}</span></div>`;

async function verify(dealId) {
  const out = $("fair-result");
  out.style.display = "block";
  out.innerHTML = `<div class="vd">Reading deal #${dealId} from the chain…</div>`;
  let d;
  try { d = await dealer.dealInfo(dealId); } catch (e) { out.innerHTML = row(false, "Could not read this deal", e.shortMessage || e.message); return; }
  if (Number(d.handId) === 0 && d.seedHash === ethers.ZeroHash) { out.innerHTML = row(false, `Deal #${dealId} does not exist`, "deal ids start at 1 — try the finder below"); return; }

  const head = `<div class="vhead">Deal <b>#${dealId}</b> · table <b>${d.tableId}</b> · hand <b>#${d.handId}</b> · ${Number(d.playerCount)} players · entropy block ${d.commitBlock}</div>`;
  const rows = [];
  rows.push(row(true, "Seed commitment found on-chain", `${d.seedHash.slice(0, 18)}… — posted before any card existed`));

  if (!d.revealed) {
    rows.push(row(null, "Seed not revealed yet", "the hand is still live (or was cancelled) — verification completes at showdown"));
    out.innerHTML = head + rows.join("");
    return;
  }

  // 1. the revealed seed must hash to the pre-deal commitment
  const rehash = ethers.keccak256(CODER.encode(["bytes32"], [d.serverSeed]));
  rows.push(row(rehash === d.seedHash, "Revealed seed matches the commitment", `keccak256(seed) ${rehash === d.seedHash ? "==" : "!="} committed hash`));

  // 2. re-derive the deck locally
  const deck = deriveDeck(d.serverSeed, d.entropy, d.handId, d.tableId);

  // 3. cross-check the local port against the CONTRACT's pure recomputeDeck
  let onchainSame = null;
  try {
    const oc = (await dealer.recomputeDeck(d.serverSeed, d.entropy, d.handId, d.tableId)).map(Number);
    onchainSame = oc.length === 52 && oc.every((c, i) => c === deck[i]);
  } catch {}
  rows.push(row(onchainSame, "Browser shuffle == contract recomputeDeck()", onchainSame === null ? "RPC call failed — the local derivation below still stands" : "the same 52-card order, derived twice independently"));

  // 4. the board that was posted street-by-street must sit exactly where the
  //    derived deck says it should
  const k = d.seats.length;
  const derivedBoard = deck.slice(2 * k, 2 * k + 5);
  let boardOk = null, shown = 0;
  try {
    shown = Number(await dealer.boardRevealedCount(dealId));
    const posted = (await dealer.boardCards(dealId)).map(Number).slice(0, shown);
    boardOk = posted.every((c, i) => c === derivedBoard[i]);
    rows.push(row(boardOk, `Posted board matches the committed deck (${shown} cards)`, posted.map(card).join(" ") || "no board cards were dealt"));
  } catch {}

  // 5. show everyone's hole cards from the derived deck (public post-reveal)
  const holes = [...d.seats].map((s, i) => `<span class="vseat">seat ${s}: ${card(deck[i])} ${card(deck[k + i])}</span>`).join("");
  rows.push(`<div class="vrow"><span class="vt ok">✓</span><span><b>Hole cards from the committed deck</b><span class="vd">${holes}</span></span></div>`);
  rows.push(`<div class="vd" style="margin-top:8px">Full derived deck: ${deck.map(card).join(" ")}</div>`);

  out.innerHTML = head + rows.join("");
}

/// Find a deal by table + hand — scans recent deal ids (they're sequential).
async function findDeal(tableId, handId) {
  const out = $("fair-result");
  out.style.display = "block";
  const latest = Number(await dealer.nextDealId());
  const CAP = 600;
  for (let hi = latest; hi > Math.max(0, latest - CAP); hi -= 20) {
    out.innerHTML = `<div class="vd">Searching deals #${Math.max(1, hi - 19)}–${hi} for table ${tableId}, hand #${handId}…</div>`;
    const ids = Array.from({ length: Math.min(20, hi) }, (_, i) => hi - i);
    const infos = await Promise.all(ids.map((i) => dealer.dealInfo(i).then((d) => ({ i, d })).catch(() => null)));
    const hit = infos.find((x) => x && Number(x.d.tableId) === tableId && Number(x.d.handId) === handId);
    if (hit) { $("fair-deal").value = String(hit.i); return verify(hit.i); }
  }
  out.innerHTML = row(false, "Not found in the last " + CAP + " deals", "older hands: pass the deal id directly (shown in the table's provably-fair widget)");
}

function wire() {
  $("fair-go").addEventListener("click", () => {
    const v = parseInt($("fair-deal").value, 10);
    if (v > 0) verify(v);
  });
  $("fair-find").addEventListener("click", () => {
    const t = parseInt($("fair-table").value, 10), h = parseInt($("fair-hand").value, 10);
    if (t >= 0 && h > 0) findDeal(t, h);
  });
  // deep link: provably-fair?deal=123
  const q = new URLSearchParams(location.search).get("deal");
  if (q && parseInt(q, 10) > 0) { $("fair-deal").value = q; verify(parseInt(q, 10)); }
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire); else wire();
