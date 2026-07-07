// Tournament driving logic for the ShinyPoker dealer bot. Pure of process/RPC
// setup so tests can drive it directly. Each tickTournament advances one
// tournament by at most one action, always in the BETWEEN-HANDS window (the
// contract enforces !handInProgress for busts/level-ups):
//
//   REGISTERING (full / scheduled) → start()      (full→now; scheduled→at startTime; creator early)
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

  // Auto-start: a SCHEDULED event starts at its startTime once a field exists
  // (>=2); an UNSCHEDULED one starts the moment the field is full. (The creator
  // can always start manually/early; the contract blocks the bot before startTime.)
  if (status === TSTATUS.REGISTERING) {
    const registered = Number(info.registered);
    const startTime = Number((await trn.clock(id)).startTime);
    const nowTs = opts.now ? opts.now() : Math.floor(Date.now() / 1000);
    if (startTime > 0) {
      if (nowTs >= startTime && registered >= 2) {
        await (await trn.start(id)).wait();
        return "started";
      }
      return "idle";
    }
    if (registered >= Number(info.maxPlayers)) {
      await (await trn.start(id)).wait();
      return "started";
    }
    return "idle";
  }
  if (status !== TSTATUS.RUNNING) return "idle";

  // MTT-aware: this tournament may span several controlled tables.
  const tables = (await trn.tablesOf(id)).map(Number);
  const freeze = opts.freeze; // Set<tableId> the bot consults before STARTING a hand

  // The contract's levelUp needs EVERY table idle at once — impossible while
  // several tables deal continuously, so blinds would never rise. When a level
  // is due we FREEZE new hands on this event's tables; the in-progress ones
  // drain, then all-idle is reached and levelUp fires (below). Clear the freeze
  // whenever a level-up isn't pending so normal play resumes.
  // A tournament whose blinds overflowed (a runaway geometric backlog) makes the
  // clock/due math revert — treat that as "not due" so we UNFREEZE and let it
  // play out at the current blinds instead of holding the tables forever.
  let due = false;
  try { due = await trn.dueForLevelUp(id); } catch (_) { due = false; }

  // BLIND CAP (bot-side): the contract's geometric growth has no ceiling (the
  // real fix needs a tournament redeploy), so stop levelling once the big
  // blind covers every chip in play twice — beyond that more levels add
  // nothing but the uint128 overflow that wedged past events. Every table is
  // effectively all-in-or-fold long before this cap.
  if (due) {
    try {
      const c = await trn.clock(id);
      const cap = BigInt(info.startStack) * BigInt(info.registered) * 2n;
      if (BigInt(c.curBb) >= cap) due = false;
    } catch (_) { due = false; } // clock() reverting (overflowed debris) = stop levelling
  }
  if (!due && freeze) for (const tid of tables) freeze.delete(tid);

  // 1. Busted seats → report one per tick (place is global). Idle tables only.
  for (let ti = 0; ti < tables.length; ti++) {
    if (await room.handInProgress(tables[ti])) continue;
    const cfg = await room.getTable(tables[ti]);
    for (let s = 0; s < Number(cfg.maxSeats); s++) {
      const seat = await room.getSeat(tables[ti], s);
      if (seat.occupied && seat.stack === 0n) {
        await (await trn.reportBust(id, ti, s)).wait();
        return "bust:" + ti + ":" + s;
      }
    }
  }

  // 2. MTT rebalancing: keep tables playable + consolidate toward the final table.
  if (tables.length > 1) {
    const tag = await rebalanceOne(trn, room, id, tables);
    if (tag) return tag;
  }

  // 3. Level-up when the contract says the next level is due. If any table is
  //    still mid-hand, FREEZE new hands on all this event's tables (via the
  //    shared set) and wait — they'll drain, then we level up and unfreeze.
  if (due) {
    let anyBusy = false;
    for (const tid of tables) if (await room.handInProgress(tid)) { anyBusy = true; break; }
    if (anyBusy) {
      if (freeze) for (const tid of tables) freeze.add(tid);
      return "leveling-hold";
    }
    const lvl = Number((await trn.clock(id)).level);
    try {
      await (await trn.levelUp(id)).wait();
    } catch (e) {
      // levelUp itself reverted (e.g. blind overflow at an absurd level) — stop
      // trying and UNFREEZE so play resumes and the event can bust out to a finish.
      if (freeze) for (const tid of tables) freeze.delete(tid);
      return "level-failed (unfrozen)";
    }
    // Unfreeze once caught up; if STILL overdue (multi-level backlog), stay frozen
    // and blitz the next level next tick while the tables are already idle.
    let stillDue = true;
    try { stillDue = await trn.dueForLevelUp(id); } catch (_) { stillDue = false; }
    if (freeze && !stillDue) for (const tid of tables) freeze.delete(tid);
    return "level:" + (lvl + 1);
  }
  return "idle";
}

/// One rebalancing move per tick for a multi-table tournament: consolidate to a
/// final table once everyone fits, unstick a lone player, or even out lopsided
/// tables. Moves happen only between hands on both tables (movePlayer conserves
/// the stack on-chain).
async function rebalanceOne(trn, room, id, tables) {
  const snap = [];
  for (let ti = 0; ti < tables.length; ti++) {
    const cfg = await room.getTable(tables[ti]);
    const busy = await room.handInProgress(tables[ti]);
    const occ = [], empty = [];
    for (let s = 0; s < Number(cfg.maxSeats); s++) {
      const seat = await room.getSeat(tables[ti], s);
      (seat.occupied ? occ : empty).push(s);
    }
    snap.push({ ti, busy, occ, empty, count: occ.length, maxSeats: Number(cfg.maxSeats) });
  }
  const active = snap.filter((x) => x.count > 0);
  const total = active.reduce((a, x) => a + x.count, 0);
  const maxSeats = Math.max(...snap.map((x) => x.maxSeats));

  async function move(src, dst, why) {
    if (!src || !dst || src.busy || dst.busy || src.count === 0 || dst.empty.length === 0) return null;
    await (await trn.movePlayer(id, src.ti, src.occ[0], dst.ti, dst.empty[0])).wait();
    return `${why} ${src.ti}:${src.occ[0]}->${dst.ti}:${dst.empty[0]}`;
  }

  // (a) consolidate: standard MTT table-count shrink — whenever everyone fits
  //     on FEWER tables (ceil(total/maxSeats) < active), drain the smallest
  //     active table into the fullest one with space. The old rule only fired
  //     when the whole field fit on ONE table, which left 8 players smeared
  //     3/3/2 across three tables instead of 4/4 across two.
  if (active.length > 1 && total <= (active.length - 1) * maxSeats) {
    const src = active.filter((x) => !x.busy).sort((a, b) => a.count - b.count)[0];
    const dst = active.filter((x) => src && x.ti !== src.ti && !x.busy && x.empty.length > 0)
      .sort((a, b) => b.count - a.count)[0];
    const tag = await move(src, dst, "consolidate"); if (tag) return tag;
  }
  // (b) unstick a lone player (1 at a table) → a table with space
  const lone = active.find((x) => x.count === 1 && !x.busy);
  if (lone) {
    const dst = active.filter((x) => x.ti !== lone.ti && !x.busy && x.empty.length > 0).sort((a, b) => a.count - b.count)[0];
    const tag = await move(lone, dst, "rebalance"); if (tag) return tag;
  }
  // (c) even out: fullest has 2+ more than emptiest
  const idle = active.filter((x) => !x.busy);
  if (idle.length > 1) {
    const most = [...idle].sort((a, b) => b.count - a.count)[0];
    const least = [...idle].sort((a, b) => a.count - b.count)[0];
    if (most.count - least.count >= 2 && least.empty.length > 0) {
      const tag = await move(most, least, "rebalance"); if (tag) return tag;
    }
  }
  return null;
}

module.exports = { tickTournaments, tickTournament, TSTATUS };
