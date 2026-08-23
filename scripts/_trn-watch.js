// Watch a live tournament and the dealer behind it. Prints only things worth
// reacting to: progress milestones, and anything that looks like trouble.
// Silence means healthy — a status line every few seconds would bury the one
// line that matters.
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const ID = Number(process.env.ID || 19);
const BASE = process.env.DEALER_URL || "https://shinyluck.win/dealer";
const RPC = "https://api.infra.testnet.somnia.network";
const sleep = (m) => new Promise((r) => setTimeout(r, m));
const S = ["REGISTERING", "RUNNING", "FINISHED", "CANCELLED"];

(async () => {
  const p = new ethers.JsonRpcProvider(RPC);
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "poker-somniaTestnet.json"), "utf8"));
  const abi = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", "poker", "PokerTournament.sol", "PokerTournament.json"), "utf8")).abi;
  const trn = new ethers.Contract(m.addresses.pokerTournament, abi, p);

  let prev = {};
  const handAt = new Map(); // table -> { handId, since }
  const t0 = Date.now();
  for (;;) {
    let line = [];
    try {
      const i = await trn.info(ID);
      const c = await trn.clock(ID);
      const status = Number(i.status), rem = Number(i.remaining), lvl = Number(c.level);

      if (prev.status !== status) line.push(`status ${S[status]}`);
      if (prev.rem !== undefined && prev.rem !== rem) line.push(`players ${prev.rem} -> ${rem}`);
      if (prev.lvl !== undefined && prev.lvl !== lvl) line.push(`level ${lvl + 1} (blinds ${c.curSb}/${c.curBb}${c.curAnte > 0n ? " ante " + c.curAnte : ""})`);
      prev = { status, rem, lvl };

      if (status >= 2) {
        console.log(`[watch] tournament #${ID} ${S[status]} after ${Math.round((Date.now() - t0) / 60000)} min`);
        return;
      }

      // dealer health
      const h = await (await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(8000) })).json();
      if (!h.ok) line.push(`DEALER UNHEALTHY (loopAge ${h.loopAgeMs}ms)`);
      if (h.loopAgeMs > 25000) line.push(`dealer loop silent ${Math.round(h.loopAgeMs / 1000)}s`);
      if (h.gasSTT < 3) line.push(`DEALER GAS LOW: ${h.gasSTT.toFixed(2)} STT`);
      const lowW = (h.workersSTT || []).filter((w) => w.stt < 0.35);
      if (lowW.length) line.push(`worker gas low: ${lowW.map((w) => w.w + "=" + w.stt.toFixed(2)).join(", ")}`);

      // per-table stall detection: a hand that has not changed in 2 minutes
      const tables = (await trn.tablesOf(ID)).map(Number);
      for (const t of tables) {
        try {
          const s = await (await fetch(`${BASE}/snapshot?t=${t}`, { signal: AbortSignal.timeout(6000) })).json();
          const hid = Number(s.hand.handId), live = s.hand.inProgress;
          const rec = handAt.get(t);
          if (!rec || rec.handId !== hid) handAt.set(t, { handId: hid, since: Date.now() });
          else if (live && Date.now() - rec.since > 120000 && !rec.warned) {
            rec.warned = true;
            line.push(`table ${t} STUCK on hand ${hid} for ${Math.round((Date.now() - rec.since) / 1000)}s (street ${s.hand.street}, board ${(s.board || []).length})`);
          }
        } catch (_) {}
      }
    } catch (e) {
      line.push(`watch error: ${(e.shortMessage || e.message || e).toString().slice(0, 80)}`);
    }
    if (line.length) console.log(`[watch ${new Date().toISOString().slice(11, 19)}] ${line.join(" | ")}`);
    await sleep(15000);
  }
})();
