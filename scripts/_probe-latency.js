// Measures the latency a PLAYER actually feels: from the moment a street opens
// ON-CHAIN to the moment the board card is visible in the dealer snapshot the
// browser polls. Two independent probes, both at 120ms, so each timestamp has
// <=120ms of error and the difference is the real wait.
//
//   TABLE=0 DEALER_URL=https://shinyluck.win/dealer node probe-latency.js
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const REPO = process.env.REPO || "D:/Рабочий стол/ShinyLuck";
const BASE = process.env.DEALER_URL || "https://shinyluck.win/dealer";
const RPC = process.env.RPC_TESTNET || "https://api.infra.testnet.somnia.network";
const TABLES = (process.env.TABLES || process.env.TABLE || "0").split(",").map(Number);
const SECS = Number(process.env.SECS || 300);

const ROOM_ABI = [
  "function getHand(uint256 t) view returns ((uint64 handId, uint8 street, uint8 button, uint8 actingSeat, uint8 aggressorSeat, uint8 numInHand, uint128 currentBet, uint128 minRaise, uint128 pot, uint64 actingDeadline, uint256 dealId, bool inProgress))",
];
const ZKD_ABI = ["function boardRevealedCount(uint256 dealId) view returns (uint8)"];
const want = (s) => (s === 1 ? 3 : s === 2 ? 4 : s >= 3 ? 5 : 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(REPO, "deployments", "poker-somniaTestnet.json"), "utf8"));
  const p = new ethers.JsonRpcProvider(RPC);
  const room = new ethers.Contract(m.addresses.pokerRoom, ROOM_ABI, p);
  const zkd = new ethers.Contract(m.addresses.zkTableDealer, ZKD_ABI, p);
  const t0 = Date.now();
  const rows = [];
  const hands = new Map(); // table -> {handId, startedAt, endedAt}

  for (const t of TABLES) {
    // chain probe: exact moment the street advances, and the exact moment the
    // card lands ON-CHAIN. The gap between those two is the protocol (dealer
    // notices -> clients hand over shares -> reveal tx); the gap from there to
    // the snapshot is purely our own delivery. They need very different fixes,
    // so measuring them together tells you nothing.
    const streetAt = new Map(); // "handId:street" -> ms
    const chainAt = new Map(); // "handId:street" -> ms the reveal landed on-chain
    (async () => {
      let prevCount = -1, prevDeal = null;
      while (Date.now() - t0 < SECS * 1000) {
        try {
          const h = await room.getHand(t);
          if (h.inProgress && h.dealId !== 0n) {
            if (String(h.dealId) !== prevDeal) { prevDeal = String(h.dealId); prevCount = -1; }
            const n = Number(await zkd.boardRevealedCount(h.dealId));
            if (prevCount >= 0 && n > prevCount) {
              const st = n === 3 ? 1 : n === 4 ? 2 : n === 5 ? 3 : 0;
              if (st) chainAt.set(`${Number(h.handId)}:${st}`, Date.now());
            }
            prevCount = n;
          }
        } catch (_) {}
        await sleep(120);
      }
    })();
    (async () => {
      let prev = null;
      while (Date.now() - t0 < SECS * 1000) {
        try {
          const h = await room.getHand(t);
          const cur = { handId: Number(h.handId), street: Number(h.street), live: h.inProgress };
          const now = Date.now();
          if (cur.live && (!prev || prev.handId !== cur.handId)) hands.set(t, { handId: cur.handId, startedAt: now });
          if (cur.live && prev && prev.live && prev.handId === cur.handId && cur.street > prev.street && cur.street <= 4) {
            streetAt.set(`${cur.handId}:${cur.street}`, now);
          }
          if (!cur.live && prev && prev.live) {
            const rec = hands.get(t);
            if (rec) { rec.endedAt = now; rows.push({ kind: "hand", t, handId: rec.handId, ms: now - rec.startedAt }); }
          }
          prev = cur;
        } catch (_) {}
        await sleep(120);
      }
    })();
    // snapshot probe: the moment the browser would see the card
    (async () => {
      let prevBoard = -1, prevHand = -1;
      while (Date.now() - t0 < SECS * 1000) {
        try {
          const r = await fetch(`${BASE}/snapshot?t=${t}`, { signal: AbortSignal.timeout(3000) });
          if (r.ok) {
            const s = await r.json();
            const hid = Number(s.hand.handId), b = (s.board || []).length;
            if (hid !== prevHand) { prevHand = hid; prevBoard = b; }
            else if (b > prevBoard) {
              const now = Date.now();
              // which street does this board size complete?
              const st = b === 3 ? 1 : b === 4 ? 2 : b === 5 ? 3 : 0;
              const openedAt = streetAt.get(`${hid}:${st}`) ?? (st === 3 ? streetAt.get(`${hid}:4`) : undefined);
              if (openedAt) {
                const ms = now - openedAt;
                const onchain = chainAt.get(`${hid}:${st}`);
                const proto = onchain ? onchain - openedAt : null;   // shares + reveal tx
                const deliver = onchain ? now - onchain : null;      // our snapshot delivery
                rows.push({ kind: "board", t, handId: hid, street: st, cards: b, ms, proto, deliver });
                console.log(`t${t} hand ${hid} ${["", "FLOP", "TURN", "RIVER"][st]} -> ${(ms / 1000).toFixed(2)}s`
                  + (onchain ? `  (protocol ${(proto / 1000).toFixed(2)}s + delivery ${(deliver / 1000).toFixed(2)}s)` : ""));
              }
              prevBoard = b;
            }
          }
        } catch (_) {}
        await sleep(120);
      }
    })();
  }

  await sleep(SECS * 1000 + 500);
  const by = {};
  for (const r of rows.filter((x) => x.kind === "board")) {
    const k = ["", "FLOP", "TURN", "RIVER"][r.street];
    (by[k] = by[k] || []).push(r.ms);
  }
  console.log("\n==== street opened on-chain -> board visible in snapshot ====");
  for (const k of ["FLOP", "TURN", "RIVER"]) {
    const a = (by[k] || []).slice().sort((x, y) => x - y);
    if (!a.length) { console.log(`${k}: no samples`); continue; }
    const q = (p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
    console.log(`${k}: n=${a.length} p50=${(q(0.5) / 1000).toFixed(2)}s p90=${(q(0.9) / 1000).toFixed(2)}s max=${(a[a.length - 1] / 1000).toFixed(2)}s`);
  }
  const split = rows.filter((x) => x.kind === "board" && x.proto != null);
  if (split.length) {
    const avg = (f) => (split.reduce((s, x) => s + f(x), 0) / split.length / 1000).toFixed(2);
    console.log(`\nsplit (n=${split.length}): protocol ${avg((x) => x.proto)}s  +  delivery ${avg((x) => x.deliver)}s`);
  }
  const hs = rows.filter((x) => x.kind === "hand").map((x) => x.ms).sort((a, b) => a - b);
  if (hs.length) console.log(`hand duration: n=${hs.length} p50=${(hs[Math.floor(hs.length / 2)] / 1000).toFixed(1)}s`);
  fs.writeFileSync(path.join(__dirname, "probe-out.json"), JSON.stringify(rows, null, 1));
}
main();
