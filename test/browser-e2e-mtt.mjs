// MULTI-TABLE: the exact shape of the event that went wrong.
//
// Tournament #23 ran on two tables and consolidated to a final one. Everything
// specific to that — a player being picked up mid-event and put down at another
// table, their browser having to follow without them touching anything, the
// tables merging — has never been exercised by a test. This runs five players
// across two tables in five browsers and watches them merge into a final table.
//
//   npm run test:mtt              headless, ~6-9 min
//   HEADED=1 npm run test:mtt     watch it play
//
// Needs Playwright once: npm i -D playwright && npx playwright install chromium
import {
  bringUpStack, fundPlayers, openTable, felt, loadPlaywright, abiOf, snapshotOf,
  ethers, sleep, ok, bad, step, finish, killAll, dealerTail, waitFor, shippedStructures,
  HEADED, KEEP, WEB_PORT, RPC, FUNDER_KEY,
} from "./_e2e-stack.mjs";

const PLAYERS = 5;
const SEATS_PER_TABLE = 3;   // 5 players → two tables (3 + 2), merging to one at 3
// The preset a host would pick, clock compressed (see browser-e2e-tournament).
const PRESET = process.env.STRUCT || "hyper";
const LEVEL_SECS = Number(process.env.LEVEL_SECS || 22);
const SIT_OUT_IDLE = "0x7d7c1738"; // PokerRoom.sitOutIdle — the DEALER striking a seat
const FOLLOW_GRACE_MS = 15_000;    // the app shows "you're moving" for 2.6s first
let tabs = [];

/// Where the chain says this player is sitting right now (-1 = nowhere).
async function tableOfPlayer(room, tables, addr) {
  for (const t of tables) {
    const s = Number(await room.seatOf(t, addr));
    if (s !== 255) return t;
  }
  return -1;
}
/// Which table the tab is actually LOOKING at (switchTable rewrites the URL).
const tabTable = (tab) => tab.page.evaluate(() => Number(new URLSearchParams(location.search).get("t")));

async function main() {
  const { man, webs } = await bringUpStack({ origins: PLAYERS });
  const provider = new ethers.JsonRpcProvider(RPC);
  const trnAbi = abiOf("PokerTournament"), roomAbi = abiOf("PokerRoom");
  const room = new ethers.Contract(man.addresses.pokerRoom, roomAbi, provider);

  step("5  create a two-table event");
  const { wallets, signers } = await fundPlayers(PLAYERS);
  const host = new ethers.NonceManager(new ethers.Wallet(FUNDER_KEY, provider));
  const trn = new ethers.Contract(man.addresses.pokerTournament, trnAbi, host);
  const buyIn = ethers.parseEther("0.01"), fee = ethers.parseEther("0.001");
  const preset = shippedStructures()[PRESET];
  if (!preset) throw new Error(`no such preset: ${PRESET}`);
  const START_STACK = BigInt(preset.stack);
  const levels = preset.levels.map((l) => ({ sb: BigInt(l.sb), bb: BigInt(l.bb), ante: BigInt(l.ante), durationSecs: LEVEL_SECS }));
  ok(`preset "${preset.label}": ${preset.levels.length} levels, start ${preset.levels[0].sb}/${preset.levels[0].bb}, ${preset.stack / preset.levels[0].bb} BB deep`);
  await (await trn.createTournament({
    buyIn, fee, maxPlayers: PLAYERS, seatsPerTable: SEATS_PER_TABLE, startStack: START_STACK,
    sbStart: 10n, bbStart: 20n, anteStart: 0n, levelDur: LEVEL_SECS, growthBps: 20000,
    startTime: 0, approvalRequired: false, actionSecs: 30,
    payoutBps: [5000, 3000, 2000], structure: levels, hostBps: 0,
  })).wait();
  const id = Number(await trn.count()) - 1;
  for (let i = 0; i < PLAYERS; i++) {
    const c = new ethers.Contract(man.addresses.pokerTournament, trnAbi, signers[i]);
    await (await c.register(id, { value: buyIn + fee })).wait();
  }
  await waitFor("the tournament to start", async () => Number((await trn.info(id)).status) === 1, 90_000);
  let tables = (await trn.tablesOf(id)).map(Number);
  if (tables.length >= 2) ok(`tournament #${id} started on ${tables.length} tables: ${tables.join(", ")}`);
  else bad(`expected two tables, got ${tables.length} — the multi-table path is untested`);

  step("6  a browser per player, each at its own table");
  const browser = await loadPlaywright().chromium.launch({ headless: !HEADED });
  for (let i = 0; i < PLAYERS; i++) {
    const at = await tableOfPlayer(room, tables, wallets[i].address);
    const tab = await openTable(browser, wallets[i], "p" + i, i, at);
    tabs.push(tab);
  }
  const where = await Promise.all(tabs.map(tabTable));
  ok(`seated across tables: ${where.map((t, i) => `p${i}@t${t}`).join(" ")}`);

  step("7  play both tables out to one");
  let acted = 0, moves = 0, followFails = 0, sawTwoDealing = false, mergedAt = null;
  const pending = new Map(); // tab -> { table, since } while a move is in flight
  const budget = Date.now() + 600_000;
  let status = 1;
  while (Date.now() < budget) {
    status = Number((await trn.info(id)).status);
    if (status >= 2) break;
    tables = (await trn.tablesOf(id)).map(Number);

    // both tables must actually be dealing, not just existing
    const snaps = await Promise.all(tables.map(snapshotOf));
    if (snaps.filter((s) => s && s.hand && s.hand.inProgress).length >= 2) sawTwoDealing = true;

    // …and the survivors must end up together
    const live = [];
    for (const t of tables) {
      const cfg = await room.getTable(t);
      let n = 0;
      for (let s = 0; s < Number(cfg.maxSeats); s++) if ((await room.getSeat(t, s)).occupied) n++;
      if (n) live.push({ t, n });
    }
    if (!mergedAt && live.length === 1 && live[0].n >= 2 && tables.length > 1) {
      mergedAt = live[0].t;
      ok(`consolidated onto the final table t${mergedAt}`);
    }

    // DOES THE BROWSER FOLLOW A MOVE? The player does nothing; the app notices
    // its seat is at another table and switches in place.
    for (const tab of tabs) {
      const chainAt = await tableOfPlayer(room, tables, tab.wallet.address);
      if (chainAt < 0) { pending.delete(tab.tag); continue; }
      const viewing = await tabTable(tab).catch(() => -1);
      if (viewing === chainAt) {
        const p = pending.get(tab.tag);
        if (p) { moves++; ok(`${tab.tag} was moved t${p.from}→t${chainAt} and its tab followed by itself`); pending.delete(tab.tag); }
        continue;
      }
      if (!pending.has(tab.tag)) pending.set(tab.tag, { from: viewing, since: Date.now() });
      else if (Date.now() - pending.get(tab.tag).since > FOLLOW_GRACE_MS) {
        bad(`${tab.tag} was moved to t${chainAt} but its tab is still showing t${viewing}`);
        followFails++;
        pending.delete(tab.tag);
      }
    }

    // act for whoever is to act, on whichever table
    for (const t of tables) {
      const snap = await snapshotOf(t);
      if (!snap || !snap.hand || !snap.hand.inProgress || Number(snap.hand.street) === 4) continue;
      const who = (await room.getSeat(t, Number(snap.hand.actingSeat))).player.toLowerCase();
      const tab = tabs.find((x) => x.wallet.address.toLowerCase() === who);
      if (!tab) continue;
      if ((await tabTable(tab).catch(() => -1)) !== t) continue; // mid-move, leave it alone
      await sleep(650); // the click guard
      const btn = tab.page.locator(".actionbar .abtn.call").first();
      if (await btn.count()) { await btn.click({ timeout: 5000 }).catch(() => {}); acted++; }
    }
    await sleep(400);
  }
  ok(`${acted} actions clicked across ${tables.length === 1 ? "the final table" : "both tables"}`);

  step("8  the record");
  if (sawTwoDealing) ok("both tables were dealing hands at the same time");
  else bad("only one table ever dealt — this ran as a single-table event");
  if (mergedAt !== null) ok("the field merged onto one final table");
  else bad("the tables never consolidated");
  if (moves) ok(`${moves} player move(s) followed by the browser with no action from the player`);
  else bad("no player was ever moved between tables — the move path went untested");
  if (!followFails) ok("no tab was left behind on a table it had been moved off");

  const head = await provider.getBlockNumber();
  const logs = await provider.getLogs({ fromBlock: 0, toBlock: head });
  const iRoom = new ethers.Interface(roomAbi), iTrn = new ethers.Interface(trnAbi);
  const parse = (i, l) => { try { return i.parseLog({ topics: [...l.topics], data: l.data }); } catch (_) { return null; } };
  const ev = [];
  for (const l of logs) {
    const p = (l.address.toLowerCase() === man.addresses.pokerRoom.toLowerCase() ? parse(iRoom, l) : null)
      || (l.address.toLowerCase() === man.addresses.pokerTournament.toLowerCase() ? parse(iTrn, l) : null);
    if (p) ev.push({ name: p.name, args: p.args, tx: l.transactionHash, block: l.blockNumber });
  }
  const onChainMoves = ev.filter((e) => e.name === "PlayerMoved").length;
  ok(`chain: ${onChainMoves} PlayerMoved, ${ev.filter((e) => e.name === "LevelUp").length} level-ups, ${ev.filter((e) => e.name === "Busted").length} busts`);

  // A rebalance changes a table's seat set, which rebuilds the deal — a prime
  // spot for the strike path to fire on players who did nothing wrong.
  const struck = [];
  for (const s of ev.filter((e) => e.name === "SitOutToggled" && e.args.sittingOut === true)) {
    const tx = await provider.getTransaction(s.tx);
    if (tx && tx.data.startsWith(SIT_OUT_IDLE)) struck.push(s);
  }
  if (!struck.length) ok("nobody was struck out of a hand, moves and level-ups included");
  else bad(`the dealer struck ${struck.length} seat(s) — check the move/level path`);
  const forfeits = ev.filter((e) => e.name === "ForfeitedIdle").length;
  if (forfeits) bad(`${forfeits} player(s) forfeited for idleness`); else ok("nobody was eliminated by the system");

  if (status >= 2) {
    const fin = ev.find((e) => e.name === "Finished");
    ok(`finished · winner ${fin ? fin.args.winner.slice(0, 10) : "?"}`);
    const winner = tabs.find((t) => fin && t.wallet.address.toLowerCase() === fin.args.winner.toLowerCase());
    if (winner) {
      const said = await waitFor("the winner's screen", async () => {
        const f = await felt(winner);
        return /you win|1st|first|champion|final standings|winner|побед/i.test(f.body || "") ? f : null;
      }, 30_000).catch(() => null);
      if (said) ok("the winner's screen announces the result"); else bad("the winner's screen never announced the win");
    }
    // and no eliminated player may be congratulated
    for (const t of tabs) {
      if (winner && t === winner) continue;
      const f = await felt(t);
      if (/you win/i.test(f.body || "")) bad(`${t.tag} is out but its screen says YOU WIN`);
    }
    ok("no eliminated player is told they won");
  } else bad(`tournament did not finish inside the budget (status ${status})`);

  if (process.env.SHOTS !== "0") {
    const fs = await import("node:fs");
    fs.mkdirSync("test/_e2e-shots", { recursive: true });
    for (const t of tabs) await t.page.screenshot({ path: `test/_e2e-shots/mtt-${t.tag}.png` });
    console.log("\nscreenshots → test/_e2e-shots/");
  }
  if (!KEEP) { await browser.close(); webs.forEach((w) => w.close()); }
  else console.log(`\nKEEP=1 — still up at http://127.0.0.1:${WEB_PORT}/poker/table.html?embed=1`);
}

main()
  .then(() => finish("a multi-table tournament merges to a final table through real browsers"))
  .catch(async (e) => {
    console.error("\nharness error:", e.message);
    for (const t of tabs) {
      try { console.error(`  [${t.tag}] viewing t${await tabTable(t)} · ${(await felt(t)).strip || ""}`.slice(0, 160)); } catch (_) {}
    }
    console.error("--- dealer tail ---\n" + dealerTail(30));
    killAll();
    process.exit(1);
  });
