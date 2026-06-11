// ShinyPoker off-chain dealer bot (standalone Node service, à la agent-service).
//
// Responsibilities (all driven through scripts/lib/poker-dealer.js):
//   - keep the on-chain dealer stocked with server-seed commitments
//   - open a hand whenever a table has >=2 seated players and none is running
//   - lock the future-blockhash entropy, derive the deck, and reveal the board
//     in lockstep with the betting streets
//   - fold/check players whose action clock has expired
//   - reveal the seed at showdown (deck verified on-chain) and settle
//   - serve each player THEIR two hole cards over an authenticated endpoint
//     (the player signs a message; the bot checks it matches the seat owner)
//
// The provably-fair guarantee does not depend on this service being honest:
// every deal's seed is committed up front and the full deck is re-derived and
// checked on-chain at showdown. The bot is a convenience + liveness driver.
//
// Run:  node scripts/poker-dealer-bot.js
// Env:  RPC_URL, DEALER_KEY (or PRIVATE_KEY), POKER_ROOM, POKER_DEALER,
//       POKER_SEED_MASTER_KEY (or SEED_MASTER_KEY), POLL_MS, POKER_DEALER_PORT

const fs = require("fs");
const path = require("path");
const http = require("http");
const { ethers } = require("ethers");
const { tickTable, newState } = require("./lib/poker-dealer");
const { tickTournaments } = require("./lib/poker-tournament-driver");
const { cardStr } = require("./lib/poker-deck");

require("dotenv").config();

// Never let a transient RPC hiccup kill the dealer — log and keep polling.
process.on("unhandledRejection", (e) => console.error("[poker-bot] unhandledRejection:", e?.shortMessage || e?.message || e));
process.on("uncaughtException", (e) => console.error("[poker-bot] uncaughtException:", e?.shortMessage || e?.message || e));

const NET = process.env.NETWORK_NAME || "somniaTestnet";
const RPC_URL = process.env.RPC_URL || process.env.RPC_TESTNET || "https://api.infra.testnet.somnia.network";
const KEY = process.env.DEALER_KEY || process.env.POKER_DEPLOYER_KEY || process.env.PRIVATE_KEY;
const MASTER = process.env.POKER_SEED_MASTER_KEY || process.env.SEED_MASTER_KEY;
const POLL_MS = parseInt(process.env.POLL_MS || "1500", 10);
const PORT = parseInt(process.env.POKER_DEALER_PORT || "3002", 10);

function loadAbi(name) {
  const p = path.join(__dirname, "..", "artifacts", "contracts", "poker", `${name}.sol`, `${name}.json`);
  return JSON.parse(fs.readFileSync(p, "utf8")).abi;
}

function loadAddresses() {
  const fromEnv = { room: process.env.POKER_ROOM, dealer: process.env.POKER_DEALER, tournament: process.env.POKER_TOURNAMENT };
  if (fromEnv.room && fromEnv.dealer) return fromEnv;
  const f = path.join(__dirname, "..", "deployments", `poker-${NET}.json`);
  if (fs.existsSync(f)) {
    const m = JSON.parse(fs.readFileSync(f, "utf8"));
    return { room: m.addresses.pokerRoom, dealer: m.addresses.commitRevealDealer, tournament: m.addresses.pokerTournament, deployBlock: m.deploymentBlock || 0 };
  }
  throw new Error("set POKER_ROOM + POKER_DEALER or deploy first (deployments/poker-*.json)");
}

function must(cond, msg) {
  if (!cond) {
    console.error("[poker-bot]", msg);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Table chat: in-memory ring buffer per table. Player messages are signature-
// gated (seat owner or their session key); the bot itself posts dealer lines.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Hand-history indexer: one backfill from the deployment block, then small
// incremental scans. The frontend reads it instantly via GET /history?t=N
// (scanning ~0.2s-block Somnia history from the browser is hopeless).
// ---------------------------------------------------------------------------
const HIST = new Map(); // tableId -> [{handId, seat, amount, kind}]
function histPush(t, item) {
  const list = HIST.get(t) || [];
  list.push(item);
  while (list.length > 100) list.shift();
  HIST.set(t, list);
}

async function startHistoryIndexer(provider, room, fromBlock) {
  const iface = room.interface;
  const addr = await room.getAddress();
  const defs = [
    ["HandSettled", (a) => ({ handId: Number(a.handId), seat: Number(a.winnerSeat), amount: a.amountWon.toString(), kind: "fold-win" })],
    ["PotWinner", (a) => ({ handId: Number(a.handId), seat: Number(a.seat), amount: a.amount.toString(), kind: "showdown" })],
  ];
  let cursor = fromBlock;
  let scanning = false;
  async function scan() {
    if (scanning) return;
    scanning = true;
    try {
      const latest = await provider.getBlockNumber();
      while (cursor <= latest) {
        const batch = [];
        for (let i = 0; i < 8 && cursor <= latest; i++) {
          const to = Math.min(cursor + 899, latest);
          for (const [ev, map] of defs) {
            const topic = iface.getEvent(ev).topicHash;
            batch.push(provider.send("eth_getLogs", [{ address: addr, topics: [topic], fromBlock: "0x" + cursor.toString(16), toBlock: "0x" + to.toString(16) }])
              .then((logs) => logs.map((lg) => ({ t: Number(iface.parseLog({ topics: lg.topics, data: lg.data }).args.tableId), item: map(iface.parseLog({ topics: lg.topics, data: lg.data }).args) })))
              .catch(() => []));
          }
          cursor = to + 1;
        }
        for (const found of await Promise.all(batch)) for (const { t, item } of found) histPush(t, item);
      }
    } catch (_) {} finally { scanning = false; }
  }
  await scan();
  console.log(`[poker-bot] history indexer caught up to block ${cursor - 1}`);
  setInterval(scan, 8000);
}

const CHATS = new Map(); // tableId -> [{ id, who, text, dealer, ts }]
let chatSeq = 1;
function pushChat(tableId, who, text, dealer = false) {
  const list = CHATS.get(Number(tableId)) || [];
  list.push({ id: chatSeq++, who, text: String(text).slice(0, 240), dealer, ts: Date.now() });
  while (list.length > 60) list.shift();
  CHATS.set(Number(tableId), list);
}

async function main() {
  must(KEY, "missing DEALER_KEY / PRIVATE_KEY");
  must(MASTER && /^0x[0-9a-fA-F]{64}$/.test(MASTER), "missing/invalid POKER_SEED_MASTER_KEY (need 32-byte hex)");
  const { room: roomAddr, dealer: dealerAddr, tournament: trnAddr, deployBlock } = loadAddresses();

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(KEY, provider);
  const room = new ethers.Contract(roomAddr, loadAbi("PokerRoom"), wallet);
  const dealer = new ethers.Contract(dealerAddr, loadAbi("CommitRevealDealer"), wallet);
  const trn = trnAddr ? new ethers.Contract(trnAddr, loadAbi("PokerTournament"), wallet) : null;
  const state = newState();

  console.log(`[poker-bot] net=${NET} room=${roomAddr} dealer=${dealerAddr} tournament=${trnAddr || "(none)"} wallet=${wallet.address}`);

  // --- hole-card API: a player proves wallet ownership, gets only their cards.
  startCardServer(room, state);

  // --- hand-history indexer (backfills in the background, then stays current)
  startHistoryIndexer(provider, room, deployBlock || 0).catch((e) => console.error("[poker-bot] indexer:", e.message));

  // --- main poll loop: tournaments first (busts/level-ups land in the
  //     inter-hand window), then deal every table.
  async function loop() {
    if (trn) {
      const tags = await tickTournaments(trn, room);
      for (const tag of tags) console.log(`[poker-bot] ${tag}`);
    }
    let tableCount;
    try {
      tableCount = Number(await room.tableCount());
    } catch (e) {
      console.error("[poker-bot] tableCount failed:", e.shortMessage || e.message);
      return;
    }
    for (let t = 0; t < tableCount; t++) {
      try {
        const tag = await tickTable(room, dealer, MASTER, state, t);
        if (tag && tag !== "idle" && tag !== "wait") console.log(`[poker-bot] table ${t}: ${tag}`);
        // dealer feed lines for the table chat
        if (tag === "started") pushChat(t, "dealer", "New hand — deck commitment sealed on-chain.", true);
        else if (tag === "showdown-reveal") pushChat(t, "dealer", "Showdown — deck revealed & verified on-chain.", true);
        else if (tag === "settled") pushChat(t, "dealer", "Pot settled on-chain.", true);
        else if (tag === "timeout") pushChat(t, "dealer", "Player timed out — auto-folded.", true);
        else if (tag && tag.startsWith("cancelled")) pushChat(t, "dealer", "Hand cancelled — all contributions refunded.", true);
      } catch (e) {
        console.error(`[poker-bot] table ${t} error:`, e.shortMessage || e.message);
      }
    }
  }

  // simple non-overlapping interval
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await loop();
    } finally {
      running = false;
    }
  }, POLL_MS);
}

// ---------------------------------------------------------------------------
// Hole-card delivery. Pre-showdown the deck seed is secret, so a player learns
// only their own two cards, and only after proving they own the seat. (The full
// deck becomes public + verifiable at showdown via the seed reveal.)
// ---------------------------------------------------------------------------
function startCardServer(room, state) {
  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    if (req.method === "GET" && req.url.startsWith("/health")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method === "GET" && req.url.startsWith("/history")) {
      const u = new URL(req.url, "http://x");
      const t = Number(u.searchParams.get("t") || 0);
      const list = (HIST.get(t) || []).slice(-40).reverse();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ hands: list }));
    }
    if (req.method === "GET" && req.url.startsWith("/chat")) {
      const u = new URL(req.url, "http://x");
      const t = Number(u.searchParams.get("t") || 0);
      const since = Number(u.searchParams.get("since") || 0);
      const list = (CHATS.get(t) || []).filter((m) => m.id > since);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ messages: list }));
    }
    if (req.method === "POST" && req.url.startsWith("/chat")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const { tableId, text, signature } = JSON.parse(body || "{}");
          if (!text || !String(text).trim()) throw new Error("empty message");
          const message = `ShinyPoker:chat:${tableId}:${text}`;
          const signer = ethers.verifyMessage(message, signature);
          let effective = signer;
          try {
            const owner = await room.sessionOwnerOf(signer);
            if (owner && owner !== "0x0000000000000000000000000000000000000000") effective = owner;
          } catch (_) {}
          // only seated players may talk
          const seatIdx = Number(await room.seatOf(tableId, effective));
          if (seatIdx === 255) throw new Error("not seated at this table");
          const who = effective.slice(0, 6) + "…" + effective.slice(-4);
          pushChat(tableId, who, String(text).trim());
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    if (req.method !== "POST" || !req.url.startsWith("/holes")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { tableId, dealId, signature } = JSON.parse(body || "{}");
        const message = `ShinyPoker:holes:${tableId}:${Number(dealId)}`;
        const signer = ethers.verifyMessage(message, signature);
        const st = state.get(Number(tableId));
        if (!st || st.dealId !== Number(dealId) || !st.holes) {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "no active deal / cards not ready" }));
        }
        // The signer may be the seat owner OR their authorized session key.
        let effective = signer;
        try {
          const owner = await room.sessionOwnerOf(signer);
          if (owner && owner !== "0x0000000000000000000000000000000000000000") effective = owner;
        } catch (_) {}
        const cfg = await room.getTable(tableId);
        let mySeat = -1;
        for (let s = 0; s < Number(cfg.maxSeats); s++) {
          const seat = await room.getSeat(tableId, s);
          if (seat.player.toLowerCase() === effective.toLowerCase()) {
            mySeat = s;
            break;
          }
        }
        const cards = mySeat >= 0 ? st.holes.holesBySeat[mySeat] : null;
        if (!cards) {
          res.writeHead(403, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "not seated in this deal" }));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ seat: mySeat, cards, cardsStr: cards.map(cardStr) }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });
  server.listen(PORT, () => console.log(`[poker-bot] hole-card API on :${PORT}`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
