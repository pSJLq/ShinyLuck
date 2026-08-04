// Post-mortem of one tournament: every on-chain fact about it, with real
// timestamps, dumped to JSON + a readable timeline.
//
// Why: pm2's poker log has no clock of its own, so a complaint like "it hung"
// cannot be placed in time from the log alone. The chain carries the timestamps,
// and every hand, action, street and payout is an event — that is the record we
// can actually reason about after the fact.
//
// Usage: ID=23 OUT="D:/Рабочий стол/_event-2026-08-02" node scripts/_trn-postmortem.js
//   PAD_BEFORE=1800  seconds of scan window before the tournament started
//   RPC_URL=...      override the public Somnia endpoint
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const ID = Number(process.env.ID || 23);
const RPC = process.env.RPC_URL || "https://api.infra.testnet.somnia.network";
const PAD_BEFORE = Number(process.env.PAD_BEFORE || 1800);
const PAD_AFTER = Number(process.env.PAD_AFTER || 900);
const OUT = process.env.OUT || path.join(__dirname, "..", "_postmortem");
const CHUNK = 1000; // eth_getLogs is capped at 1000 blocks on Somnia
const sleep = (m) => new Promise((r) => setTimeout(r, m));
const J = (o) => JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);

const root = path.join(__dirname, "..");
const man = JSON.parse(fs.readFileSync(path.join(root, "deployments", "poker-somniaTestnet.json"), "utf8"));
const abiOf = (f) => JSON.parse(fs.readFileSync(path.join(root, "artifacts", "contracts", "poker", f), "utf8")).abi;
const ABI = {
  trn: abiOf("PokerTournament.sol/PokerTournament.json"),
  room: abiOf("PokerRoom.sol/PokerRoom.json"),
  zkd: abiOf("ZkTableDealer.sol/ZkTableDealer.json"),
};
const ADDR = {
  trn: man.addresses.pokerTournament,
  room: man.addresses.pokerRoom,
  zkd: man.addresses.zkTableDealer,
};

const provider = new ethers.JsonRpcProvider(RPC);
const iface = { trn: new ethers.Interface(ABI.trn), room: new ethers.Interface(ABI.room), zkd: new ethers.Interface(ABI.zkd) };

// Shannon-style endpoints pad `topics` out to 4 with nulls; parseLog throws on those.
const parseLog = (src, log) => {
  try {
    return iface[src].parseLog({ topics: log.topics.filter((t) => t != null), data: log.data });
  } catch (_) {
    return null;
  }
};

async function blockAt(ts, loB, hiB) {
  let lo = loB, hi = hiB, ans = loB;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await provider.getBlock(mid);
    if (!b) { hi = mid - 1; continue; }
    if (b.timestamp <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

async function logsFor(address, fromB, toB) {
  const out = [];
  for (let f = fromB; f <= toB; f += CHUNK) {
    const t = Math.min(f + CHUNK - 1, toB);
    for (let tries = 0; ; tries++) {
      try {
        out.push(...(await provider.getLogs({ address, fromBlock: f, toBlock: t })));
        break;
      } catch (e) {
        if (tries >= 4) throw e;
        await sleep(500 * (tries + 1));
      }
    }
    if (((f - fromB) / CHUNK) % 10 === 0) process.stdout.write(".");
  }
  return out;
}

// Block timestamps, fetched once per block with a small concurrency window.
async function stampBlocks(nums) {
  const ts = new Map();
  const list = [...new Set(nums)];
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const n = list[i++];
      for (let tries = 0; ; tries++) {
        try { const b = await provider.getBlock(n); ts.set(n, b ? b.timestamp : 0); break; }
        catch (e) { if (tries >= 4) { ts.set(n, 0); break; } await sleep(400 * (tries + 1)); }
      }
      if (list.length > 200 && i % 200 === 0) process.stdout.write("+");
    }
  };
  await Promise.all(Array.from({ length: 24 }, worker));
  return ts;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const trn = new ethers.Contract(ADDR.trn, ABI.trn, provider);
  const room = new ethers.Contract(ADDR.room, ABI.room, provider);

  const head = await provider.getBlockNumber();
  const info = await trn.info(ID);
  const clock = await trn.clock(ID);
  const players = await trn.playersOf(ID);
  const tables = (await trn.tablesOf(ID)).map(Number);
  let structure = [];
  try { structure = (await trn.structureOf(ID)).map((l) => ({ sb: l[0], bb: l[1], ante: l[2] })); } catch (_) {}

  const startedAt = Number(clock.startedAt);
  const state = {
    id: ID,
    capturedAt: new Date().toISOString(),
    headBlock: head,
    creator: info.creator,
    status: ["REGISTERING", "RUNNING", "FINISHED", "CANCELLED"][Number(info.status)],
    buyIn: ethers.formatEther(info.buyIn),
    fee: ethers.formatEther(info.fee),
    pool: ethers.formatEther(info.pool),
    startStack: info.startStack.toString(),
    maxPlayers: Number(info.maxPlayers),
    registered: Number(info.registered),
    remaining: Number(info.remaining),
    payoutBps: info.payoutBps.map(Number),
    approvalRequired: info.approvalRequired,
    firstTable: Number(info.tableId),
    tables,
    players,
    clock: {
      startedAt, startedAtISO: startedAt ? new Date(startedAt * 1000).toISOString() : null,
      level: Number(clock.level), levelDurSec: Number(clock.levelDur),
      curSb: clock.curSb.toString(), curBb: clock.curBb.toString(), curAnte: clock.curAnte.toString(),
      scheduledStart: Number(clock.startTime),
      scheduledStartISO: Number(clock.startTime) ? new Date(Number(clock.startTime) * 1000).toISOString() : null,
    },
    structure,
  };
  console.log(`tournament #${ID} ${state.status} · ${state.registered} registered · tables ${tables.join(",")}`);
  console.log(`started ${state.clock.startedAtISO} · level ${state.clock.level} · levelDur ${state.clock.levelDurSec}s`);

  if (!startedAt) { console.log("never started — nothing to scan"); fs.writeFileSync(path.join(OUT, `trn${ID}-state.json`), J(state)); return; }

  const headBlk = await provider.getBlock(head);
  const fromB = await blockAt(startedAt - PAD_BEFORE, man.deploymentBlock, head);
  const toB = headBlk.timestamp > startedAt + PAD_AFTER ? await blockAt(startedAt + 6 * 3600, man.deploymentBlock, head) : head;
  console.log(`scanning blocks ${fromB}..${toB} (${toB - fromB} blocks, ${Math.ceil((toB - fromB) / CHUNK)} chunks/contract)`);

  const raw = {};
  for (const src of ["trn", "room", "zkd"]) {
    process.stdout.write(`  ${src} `);
    raw[src] = await logsFor(ADDR[src], fromB, toB);
    console.log(` ${raw[src].length} logs`);
  }

  // Decode, then keep only what belongs to this tournament: its own events by id,
  // room/dealer events on its tables (including tables players were moved to).
  const tableSet = new Set(tables);
  const decoded = [];
  for (const log of raw.trn) {
    const p = parseLog("trn", log);
    if (!p) continue;
    if (p.args.id !== undefined && Number(p.args.id) !== ID) continue;
    decoded.push({ src: "trn", name: p.name, block: log.blockNumber, tx: log.transactionHash, li: log.index, args: p.args.toObject() });
    if (p.name === "PlayerMoved") tableSet.add(Number(p.args.toTable));
    if (p.name === "Started") tableSet.add(Number(p.args.tableId));
  }
  const dealIds = new Set();
  for (const log of raw.room) {
    const p = parseLog("room", log);
    if (!p) continue;
    const t = p.args.tableId !== undefined ? Number(p.args.tableId) : null;
    if (t === null || !tableSet.has(t)) continue;
    decoded.push({ src: "room", name: p.name, block: log.blockNumber, tx: log.transactionHash, li: log.index, table: t, args: p.args.toObject() });
    if (p.name === "HandStarted") dealIds.add(String(p.args.dealId));
  }
  for (const log of raw.zkd) {
    const p = parseLog("zkd", log);
    if (!p) continue;
    const d = p.args.dealId !== undefined ? String(p.args.dealId) : null;
    const t = p.args.tableId !== undefined ? Number(p.args.tableId) : null;
    if (!(d && dealIds.has(d)) && !(t !== null && tableSet.has(t))) continue;
    decoded.push({ src: "zkd", name: p.name, block: log.blockNumber, tx: log.transactionHash, li: log.index, table: t, args: p.args.toObject() });
  }

  process.stdout.write(`stamping ${new Set(decoded.map((d) => d.block)).size} blocks `);
  const ts = await stampBlocks(decoded.map((d) => d.block));
  console.log("");
  for (const d of decoded) { d.ts = ts.get(d.block) || 0; d.iso = d.ts ? new Date(d.ts * 1000).toISOString() : null; }
  decoded.sort((a, b) => a.block - b.block || a.li - b.li);

  // ---- analytics -----------------------------------------------------------
  const fmt = (n) => (n === null || n === undefined ? "?" : String(n));
  const seatName = new Map(); // table:seat -> address
  const hands = [];          // one row per hand
  const open = new Map();    // table -> current hand row
  const gaps = [];           // seconds between a hand ending and the next starting
  const lastEnd = new Map();

  for (const e of decoded) {
    if (e.src === "room" && e.name === "TournamentSeated") seatName.set(`${e.table}:${e.args.seat}`, e.args.player);
    if (e.src === "room" && e.name === "PlayerSeated") seatName.set(`${e.table}:${e.args.seat}`, e.args.player);
    if (e.src === "room" && e.name === "HandStarted") {
      const row = { table: e.table, handId: Number(e.args.handId), dealId: String(e.args.dealId), startTs: e.ts, startBlock: e.block, acts: 0, streets: [], showdownTs: null, endTs: null, end: null, cancelled: false };
      open.set(e.table, row);
      hands.push(row);
      const prev = lastEnd.get(e.table);
      if (prev && e.ts >= prev) gaps.push({ table: e.table, sec: e.ts - prev, handId: row.handId });
    }
    const cur = open.get(e.table);
    if (!cur) continue;
    if (e.src === "room" && e.name === "PlayerActed") cur.acts++;
    if (e.src === "room" && e.name === "StreetAdvanced") cur.streets.push({ street: Number(e.args.street), ts: e.ts });
    if (e.src === "room" && e.name === "ShowdownReached") cur.showdownTs = e.ts;
    if (e.src === "room" && (e.name === "HandSettled" || e.name === "ShowdownSettled")) {
      cur.endTs = e.ts; cur.end = e.name;
      lastEnd.set(e.table, e.ts); open.delete(e.table);
    }
    if (e.src === "room" && (e.name === "HandCancelled" || e.name === "HandCancelledPenalized")) {
      cur.endTs = e.ts; cur.end = e.name; cur.cancelled = true;
      lastEnd.set(e.table, e.ts); open.delete(e.table);
    }
  }

  const durs = hands.filter((h) => h.endTs).map((h) => h.endTs - h.startTs).sort((a, b) => a - b);
  const gapSec = gaps.map((g) => g.sec).sort((a, b) => a - b);
  const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor((arr.length - 1) * p))] : null);
  const showdownTails = hands.filter((h) => h.showdownTs && h.endTs).map((h) => h.endTs - h.showdownTs).sort((a, b) => a - b);

  const byName = {};
  for (const e of decoded) byName[`${e.src}.${e.name}`] = (byName[`${e.src}.${e.name}`] || 0) + 1;

  const busts = decoded.filter((e) => e.src === "trn" && (e.name === "Busted" || e.name === "ForfeitedIdle"))
    .map((e) => ({ iso: e.iso, player: e.args.player, place: Number(e.args.place), prize: e.args.prize !== undefined ? ethers.formatEther(e.args.prize) : "0", forfeit: e.name === "ForfeitedIdle" }));
  const finished = decoded.find((e) => e.src === "trn" && e.name === "Finished");

  const summary = {
    tournament: state,
    window: { fromBlock: fromB, toBlock: toB },
    eventCounts: byName,
    hands: {
      total: hands.length,
      byTable: [...tableSet].map((t) => ({ table: t, hands: hands.filter((h) => h.table === t).length })),
      cancelled: hands.filter((h) => h.cancelled).length,
      unfinished: hands.filter((h) => !h.endTs).map((h) => ({ table: h.table, handId: h.handId, startIso: new Date(h.startTs * 1000).toISOString() })),
      durationSec: { p50: pct(durs, 0.5), p90: pct(durs, 0.9), max: durs[durs.length - 1] || null },
      gapBetweenHandsSec: { n: gapSec.length, p50: pct(gapSec, 0.5), p90: pct(gapSec, 0.9), max: gapSec[gapSec.length - 1] || null },
      showdownTailSec: { n: showdownTails.length, p50: pct(showdownTails, 0.5), p90: pct(showdownTails, 0.9), max: showdownTails[showdownTails.length - 1] || null },
      worstGaps: gaps.sort((a, b) => b.sec - a.sec).slice(0, 15),
    },
    busts,
    finished: finished ? { iso: finished.iso, winner: finished.args.winner, prize: ethers.formatEther(finished.args.prize) } : null,
    durationMin: finished && startedAt ? Math.round((finished.ts - startedAt) / 60) : null,
    trouble: decoded.filter((e) => /Cancelled|Accus|Kicked|Forfeit|Penal|Rescue/.test(e.name))
      .map((e) => ({ iso: e.iso, src: e.src, name: e.name, table: e.table ?? null, args: JSON.parse(J(e.args)) })),
  };

  // ---- output --------------------------------------------------------------
  fs.writeFileSync(path.join(OUT, `trn${ID}-events.json`), J(decoded));
  fs.writeFileSync(path.join(OUT, `trn${ID}-summary.json`), J(summary));
  fs.writeFileSync(path.join(OUT, `trn${ID}-hands.json`), J(hands));

  const t0 = startedAt;
  const rel = (t) => (t ? `+${String(Math.floor((t - t0) / 60)).padStart(3)}:${String((t - t0) % 60).padStart(2, "0")}` : "  ?  ");
  const lines = decoded.map((e) => {
    const a = Object.entries(e.args)
      .filter(([k]) => !/^(id|tableId)$/.test(k))
      .map(([k, v]) => `${k}=${typeof v === "bigint" ? v.toString() : fmt(v)}`)
      .join(" ");
    return `${e.iso ? e.iso.slice(11, 19) : "        "} ${rel(e.ts)} ${String(e.block).padStart(10)} ${e.src}.${e.name}${e.table !== undefined && e.table !== null ? ` t${e.table}` : ""} ${a}`;
  });
  fs.writeFileSync(path.join(OUT, `trn${ID}-timeline.txt`),
    `tournament #${ID} — started ${state.clock.startedAtISO}\n` +
    `players: ${players.join(", ")}\n` +
    `tables: ${[...tableSet].join(", ")}\n\n` + lines.join("\n") + "\n");

  console.log("");
  console.log(`hands ${summary.hands.total} (cancelled ${summary.hands.cancelled}, unfinished ${summary.hands.unfinished.length})`);
  console.log(`hand duration  p50 ${summary.hands.durationSec.p50}s p90 ${summary.hands.durationSec.p90}s max ${summary.hands.durationSec.max}s`);
  console.log(`between hands  p50 ${summary.hands.gapBetweenHandsSec.p50}s p90 ${summary.hands.gapBetweenHandsSec.p90}s max ${summary.hands.gapBetweenHandsSec.max}s`);
  console.log(`showdown tail  p50 ${summary.hands.showdownTailSec.p50}s p90 ${summary.hands.showdownTailSec.p90}s max ${summary.hands.showdownTailSec.max}s`);
  console.log(`trouble events ${summary.trouble.length}`);
  console.log(`wrote ${OUT}\\trn${ID}-{events,summary,hands}.json + timeline.txt`);
})();
