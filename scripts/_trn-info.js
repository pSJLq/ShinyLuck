const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const ID = Number(process.env.ID || 19);
// ABI FROM THE ARTIFACT, never hand-written. The hand-written `clock()` here
// listed four fields in the wrong order; the real one is
// (startedAt, level, levelDur, curSb, curBb, curAnte, startTime), so this tool
// printed "level duration 500s | level 300" for a tournament whose levels were
// 300s long with a 500-chip small blind — and never showed the level at all.
// That is exactly the kind of quiet lie a diagnostic must not tell.
const ABI = JSON.parse(fs.readFileSync(
  path.join(__dirname, "..", "artifacts", "contracts", "poker", "PokerTournament.sol", "PokerTournament.json"), "utf8")).abi;
(async () => {
  const p = new ethers.JsonRpcProvider("https://api.infra.testnet.somnia.network");
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "poker-somniaTestnet.json"), "utf8"));
  const trn = new ethers.Contract(m.addresses.pokerTournament, ABI, p);
  const i = await trn.info(ID);
  const c = await trn.clock(ID);
  const now = Math.floor(Date.now() / 1000);
  console.log("creator        ", i.creator);
  console.log("status         ", ["REGISTERING", "RUNNING", "FINISHED", "CANCELLED"][Number(i.status)]);
  console.log("registered     ", Number(i.registered), "/", Number(i.maxPlayers));
  console.log("buyIn + fee    ", ethers.formatEther(i.buyIn), "+", ethers.formatEther(i.fee), "STT");
  console.log("startStack     ", i.startStack.toString(), "chips");
  console.log("approval req   ", i.approvalRequired, "| pending:", Number(i.pendingCount));
  console.log("payout bps     ", i.payoutBps.map(Number).join("/"));
  try { console.log("seats/table    ", Number(await trn.seatsPerTableOf(ID))); } catch (_) {}
  try { console.log("host bps       ", Number(await trn.hostBpsOf(ID))); } catch (_) {}
  const st = Number(c.startTime);
  console.log("startTime      ", st ? new Date(st * 1000).toISOString() + (st > now ? `  (in ${Math.round((st - now) / 60)} min)` : "  (passed)") : "0 — starts only when the field is FULL");
  const sa = Number(c.startedAt);
  console.log("startedAt      ", sa ? new Date(sa * 1000).toISOString() + `  (${Math.round((now - sa) / 60)} min ago)` : "not started");
  console.log("level          ", Number(c.level), "· blinds", c.curSb.toString() + "/" + c.curBb.toString(),
    Number(c.curAnte) ? "ante " + c.curAnte.toString() : "");
  // With a custom structure the per-level durations come from it, and levelDur
  // is only the fallback — printing it alone made a 2.5-minute event look like
  // a 5-minute one.
  const struct = await trn.structureOf(ID).catch(() => []);
  if (struct.length) {
    console.log("structure      ", struct.length, "levels:", struct.slice(0, 8).map((l) => `${l[0]}/${l[1]}@${Number(l[3] ?? l.durationSecs ?? 0)}s`).join(" "), struct.length > 8 ? "…" : "");
  } else {
    console.log("level duration ", Number(c.levelDur), "s (geometric growth — no custom structure)");
  }
})();
