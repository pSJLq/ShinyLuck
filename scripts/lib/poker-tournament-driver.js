// Tournament driving logic for the ShinyPoker dealer bot. Pure of process/RPC
// setup so tests can drive it directly. Each tickTournament advances one
// tournament by at most one action, always in the BETWEEN-HANDS window (the
// contract enforces !handInProgress for busts/level-ups):
//
//   REGISTERING + full        → start()           (creator can also start early)
//   RUNNING, busted seat      → reportBust(seat)  (pays finisher per the split)
//   RUNNING, level timer due  → levelUp()         (blinds double per level)
//
// The regular table loop (poker-dealer.js tickTable) keeps dealing the hands —
// tournament tables are just controlled PokerRoom tables. IMPORTANT: run
// tickTournaments BEFORE tickTable in the same poll iteration so busts and
// level-ups land in the inter-hand window before the next hand starts.

const TSTATUS = { REGISTERING: 0, RUNNING: 1, FINISHED: 2, CANCELLED: 3 };

/// Advance every tournament by at most one step. Returns log tags.
async function tickTournaments(trn, room, opts = {}) {
  const tags = [];
  let n = 0;
  try {
    n = Number(await trn.count());
  } catch (e) {
    return ["count failed: " + (e.shortMessage || e.message)];
  }
  for (let id = 0; id < n; id++) {
    try {
      const tag = await tickTournament(trn, room, id, opts);
      if (tag && tag !== "idle") tags.push(`trn ${id}: ${tag}`);
    } catch (e) {
      tags.push(`trn ${id} error: ${e.shortMessage || e.message}`);
    }
  }
  return tags;
}

/// One step for one tournament. Returns a short status tag.
async function tickTournament(trn, room, id, opts = {}) {
  const info = await trn.info(id);
  const status = Number(info.status);

  // Auto-start the moment the field is full (the creator can also start a
  // short-handed one manually whenever they like).
  if (status === TSTATUS.REGISTERING) {
    if (Number(info.registered) >= Number(info.maxPlayers)) {
      await (await trn.start(id)).wait();
      return "started";
    }
    return "idle";
  }
  if (status !== TSTATUS.RUNNING) return "idle";

  const tableId = Number(info.tableId);
  if (await room.handInProgress(tableId)) return "idle"; // only act between hands

  // 1. Busted seats (occupied, stack 0) → report one per tick. The contract
  //    assigns place = remaining-at-report, so report order matters only when
  //    several bust in the same hand; lowest seat first is deterministic.
  const cfg = await room.getTable(tableId);
  for (let s = 0; s < Number(cfg.maxSeats); s++) {
    const seat = await room.getSeat(tableId, s);
    if (seat.occupied && seat.stack === 0n) {
      await (await trn.reportBust(id, s)).wait();
      return "bust:" + s;
    }
  }

  // 2. Level-up when the clock says the next level is due.
  const c = await trn.clock(id);
  const nowTs = opts.now ? opts.now() : Math.floor(Date.now() / 1000);
  const due = Number(c.startedAt) + (Number(c.level) + 1) * Number(c.levelDur);
  if (nowTs >= due) {
    await (await trn.levelUp(id)).wait();
    return "level:" + (Number(c.level) + 1);
  }
  return "idle";
}

module.exports = { tickTournaments, tickTournament, TSTATUS };
