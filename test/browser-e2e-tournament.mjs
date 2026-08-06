// THE EVENT SHAPE: a real tournament, played by this script in real browsers.
//
// Tournament #23 (2026-08-02) is the reason this exists. Everything that went
// wrong there lived in places no unit test looks:
//   · the dealer struck five of eight players inside the first minute, while
//     their browsers were still coming up — one never got back and finished
//     eighth without playing a hand;
//   · every blind level froze the table, and the restart afterwards cost 25-45
//     seconds because the freeze ended in another strike;
//   · the felt went blank at showdown.
// So this runs a whole tournament — registration, start, blind levels, busts,
// finish — with a browser per player, and asserts the things that actually hurt.
//
//   npm run test:tournament            headless, ~4-6 min
//   HEADED=1 npm run test:tournament   watch it play
//
// Needs Playwright once: npm i -D playwright && npx playwright install chromium
import {
  bringUpStack, fundPlayers, openTable, felt, loadPlaywright, abiOf, snapshotOf,
  ethers, sleep, ok, bad, step, finish, killAll, dealerTail, waitFor, shippedStructures,
  HEADED, KEEP, WEB_PORT, RPC, FUNDER_KEY,
} from "./_e2e-stack.mjs";

const PLAYERS = 3;
// The REAL preset a host would pick, with only the clock compressed: same
// ladder, same ante schedule, same starting depth, levels squeezed from minutes
// to seconds so a structure that takes half an hour to bite can be watched in
// one test run. STRUCT=regular|turbo|hyper to try another.
const PRESET = process.env.STRUCT || "hyper";
const LEVEL_SECS = Number(process.env.LEVEL_SECS || 25);
const SIT_OUT_IDLE = "0x7d7c1738"; // PokerRoom.sitOutIdle — the DEALER striking a seat
let tabs = [];

async function main() {
  const { man, webs } = await bringUpStack({ origins: PLAYERS });
  const provider = new ethers.JsonRpcProvider(RPC);
  const trnAbi = abiOf("PokerTournament"), roomAbi = abiOf("PokerRoom");

  step("5  create + fill a tournament");
  const { wallets, signers } = await fundPlayers(PLAYERS);
  const host = new ethers.NonceManager(new ethers.Wallet(FUNDER_KEY, provider));
  const trnHost = new ethers.Contract(man.addresses.pokerTournament, trnAbi, host);
  const buyIn = ethers.parseEther("0.01"), fee = ethers.parseEther("0.001");
  const preset = shippedStructures()[PRESET];
  if (!preset) throw new Error(`no such preset: ${PRESET}`);
  // the screen's own abbreviation (fmtChips in poker-seats.jsx): 1000 → "1k"
  const chipsK = (n) => (n >= 1000 ? (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + "k" : String(n));
  const START_STACK = BigInt(preset.stack);
  const levels = preset.levels.map((l) => ({ sb: BigInt(l.sb), bb: BigInt(l.bb), ante: BigInt(l.ante), durationSecs: LEVEL_SECS }));

  // What the host is actually choosing, asserted before a card is dealt.
  const bb1 = preset.levels[0].bb, deep = preset.stack / bb1;
  const anteFrom = preset.levels.findIndex((l) => l.ante > 0) + 1;
  ok(`preset "${preset.label}": ${preset.levels.length} levels, ${preset.mins} min each, start ${preset.levels[0].sb}/${bb1}, ${deep} BB deep`);
  if (deep >= 50) ok(`${deep} big blinds deep at level 1`);
  else bad(`only ${deep} big blinds deep — a structure nobody can play`);
  if (anteFrom === 5) ok("antes start at level 5, not level 1");
  else bad(`antes start at level ${anteFrom}`);
  // the ladder must climb, and never by more than ~1.6x a level
  let worst = 0;
  for (let i = 1; i < preset.levels.length; i++) {
    const r = preset.levels[i].bb / preset.levels[i - 1].bb;
    if (r <= 1) { bad(`level ${i + 1} does not raise the blinds`); break; }
    worst = Math.max(worst, r);
  }
  if (worst && worst <= 1.6) ok(`blinds climb smoothly (worst step ${worst.toFixed(2)}x)`);
  else if (worst) bad(`a level jumps ${worst.toFixed(2)}x — too steep for a real structure`);
  await (await trnHost.createTournament({
    buyIn, fee, maxPlayers: PLAYERS, seatsPerTable: PLAYERS, startStack: START_STACK,
    sbStart: 10n, bbStart: 20n, anteStart: 0n, levelDur: LEVEL_SECS, growthBps: 20000,
    startTime: 0, approvalRequired: false, actionSecs: 30,
    payoutBps: [6000, 4000], structure: levels, hostBps: 0,
  })).wait();
  const id = Number(await trnHost.count()) - 1;
  for (let i = 0; i < PLAYERS; i++) {
    const t = new ethers.Contract(man.addresses.pokerTournament, trnAbi, signers[i]);
    await (await t.register(id, { value: buyIn + fee })).wait();
  }
  ok(`tournament #${id} · ${PLAYERS} registered · ${START_STACK} chips · levels compressed to ${LEVEL_SECS}s`);

  step("6  browsers open BEFORE the start (as players do)");
  const startedAt = Date.now();
  // A full field starts ITSELF — the dealer does it, exactly as in production.
  // Calling start() here raced it and reverted with NotRegistering.
  await (await trnHost.start(id)).wait().catch(() => {});
  await waitFor("the tournament to start", async () => Number((await trnHost.info(id)).status) === 1, 60_000);
  const table = Number((await trnHost.tablesOf(id))[0]);
  const browser = await loadPlaywright().chromium.launch({ headless: !HEADED });
  const room = new ethers.Contract(man.addresses.pokerRoom, roomAbi, provider);
  const seatOfAddr = new Map();
  for (let s = 0; s < PLAYERS; s++) {
    const seat = await room.getSeat(table, s);
    if (seat.occupied) seatOfAddr.set(seat.player.toLowerCase(), s);
  }
  const bySeat = [];
  // ONE OF THEM IS ON A PHONE. The tournament header carries more than the
  // cash one (level, its clock, players left) and a phone is where that line
  // runs out of room first — §29.4 left "the tournament table on a phone" as
  // the screen nobody had looked at. Now a real player of every event is on
  // one, and the header check below reads ITS screen.
  const pw2 = loadPlaywright();
  for (let i = 0; i < PLAYERS; i++) {
    const tab = await openTable(browser, wallets[i], "p" + i, i, table,
      i === 0 ? { device: pw2.devices["iPhone 13"] } : {});
    tab.seat = seatOfAddr.get(wallets[i].address.toLowerCase());
    tabs.push(tab);
    bySeat[tab.seat] = tab;
  }
  ok(`table ${table} · seats ${tabs.map((t) => `${t.tag}=${t.seat}`).join(" ")}`);

  // THE FIRST MINUTE. At the event this is where five players were sat out for
  // not answering a deal their browsers had not finished loading yet.
  for (const t of tabs) {
    const seen = await waitFor(`${t.tag} hole cards`, async () => {
      const f = await felt(t);
      return f.hero >= 2 && f.heroBacks === 0;
    }, 120_000).catch(() => null);
    if (seen) ok(`${t.tag}: dealt in and holding cards`); else bad(`${t.tag}: never got cards — struck at the start?`);
  }

  step("7  play it out: levels, busts, finish");
  let acted = 0, lastLevel = 0;
  const budget = Date.now() + 420_000;
  let status = 1;
  while (Date.now() < budget) {
    const info = await trnHost.info(id);
    status = Number(info.status);
    if (status >= 2) break;
    const lvl = Number((await trnHost.clock(id)).level);
    if (lvl > lastLevel) {
      lastLevel = lvl;
      ok(`level ${lvl} — blinds up, tables were frozen and released`);
      // AND THE PLAYER MUST BE TOLD. The blinds in the table header come from
      // a per-table config the SDK caches and never re-reads, so they used to
      // freeze at the opening level for the whole event; the tournament strip
      // (now deleted) was the only place with the live ones. The header reads
      // them off the tournament clock now — this is that promise, checked.
      //
      // Checked against the level the HEADER ITSELF names, not against the one
      // the chain was on when this fired: these levels are compressed to 30s,
      // so by the time the poll lands the event has often moved on, and an
      // assertion racing it would only ever be testing the clock.
      await sleep(2500);
      const head = (await felt(tabs[0])).header || "";     // tabs[0] is the phone
      const shown = Number((head.match(/Level (\d+)/) || [])[1]);
      const L = preset.levels[shown - 1];
      if (!L) bad(`header names level ${shown}, which the structure does not have: "${head}"`);
      else {
        const want = `${chipsK(L.sb)} / ${chipsK(L.bb)}`;
        if (head.startsWith(want)) ok(`header follows the level (on the phone): "${head}"`);
        else bad(`header says level ${shown} but prints blinds "${head.slice(0, 24)}…", expected "${want}"`);
      }
      // …and it has to FIT. One line, clipped by CSS, is how a hand number
      // silently disappears on a 390px screen.
      const cut = await tabs[0].page.evaluate(() => {
        const el = document.querySelector(".tableid .sub");
        return el ? { over: el.scrollWidth - el.clientWidth, text: el.textContent } : null;
      });
      if (cut && cut.over > 1) bad(`the header line is clipped on the phone by ${cut.over}px: "${cut.text}"`);
      else if (cut) ok("the header line fits the phone");
    }

    const snap = await snapshotOf(table);
    if (!snap || !snap.hand || !snap.hand.inProgress) { await sleep(400); continue; }
    if (Number(snap.hand.street) === 4) { await sleep(400); continue; }
    const t = bySeat[Number(snap.hand.actingSeat)];
    if (!t) { await sleep(400); continue; }
    await sleep(700); // respect the click guard, like a player
    const btn = t.page.locator(".actionbar .abtn.call").first();
    if (await btn.count()) {
      await btn.click({ timeout: 5000 }).catch(() => {});
      acted++;
    }
    await sleep(700);
  }
  ok(`${acted} actions clicked · reached level ${lastLevel}`);

  // ---- what the chain says happened ---------------------------------------
  step("8  the record");
  const head = await provider.getBlockNumber();
  const logs = await provider.getLogs({ fromBlock: 0, toBlock: head });
  const iRoom = new ethers.Interface(roomAbi), iTrn = new ethers.Interface(trnAbi);
  const parse = (i, l) => { try { return i.parseLog({ topics: [...l.topics], data: l.data }); } catch (_) { return null; } };
  const ev = [];
  for (const l of logs) {
    const p = (l.address.toLowerCase() === man.addresses.pokerRoom.toLowerCase() ? parse(iRoom, l) : null)
      || (l.address.toLowerCase() === man.addresses.pokerTournament.toLowerCase() ? parse(iTrn, l) : null);
    if (p) ev.push({ name: p.name, args: p.args, block: l.blockNumber, tx: l.transactionHash });
  }
  const ts = new Map();
  for (const b of new Set(ev.map((e) => e.block))) ts.set(b, (await provider.getBlock(b)).timestamp);
  ev.forEach((e) => { e.ts = ts.get(e.block); });

  // (1) NOBODY may be struck by the dealer. A strike is the system removing a
  //     live player from a hand; at the event it happened fourteen times.
  const sitOuts = ev.filter((e) => e.name === "SitOutToggled" && e.args.sittingOut === true);
  const struck = [];
  for (const s of sitOuts) {
    const tx = await provider.getTransaction(s.tx);
    if (tx && tx.data.startsWith(SIT_OUT_IDLE)) struck.push(s);
  }
  if (!struck.length) ok("no player was struck out of a hand by the dealer");
  else bad(`the dealer struck ${struck.length} seat(s): ${struck.map((s) => `seat${s.args.seat}@+${s.ts - Math.floor(startedAt / 1000)}s`).join(", ")}`);

  // (2) A BLIND LEVEL MUST NOT COST THE TABLE HALF A MINUTE. Every level-up
  //     freezes the tables; the event's restarts took 23-45s whenever the freeze
  //     ended in a strike, and 1-2s when it did not.
  const levelUps = ev.filter((e) => e.name === "LevelUp");
  const starts = ev.filter((e) => e.name === "HandStarted");
  if (!levelUps.length) bad("no blind level ever fired — the level path went untested");
  else {
    const gaps = levelUps.map((L) => {
      const next = starts.find((h) => h.ts >= L.ts);
      return next ? next.ts - L.ts : null;
    }).filter((g) => g !== null);
    const worst = Math.max(...gaps, 0);
    if (worst <= 15) ok(`${levelUps.length} blind level(s), table back dealing in ${gaps.join("s, ")}s`);
    else bad(`a blind level left the table idle ${worst}s (was 23-45s at the event when a strike fired)`);
  }

  // (3) A BUST MUST BE TOLD TO THE PLAYER. "The money just left" was a real
  //     complaint; being knocked out is the loudest version of it.
  const busts = ev.filter((e) => e.name === "Busted" || e.name === "ForfeitedIdle");
  const forfeits = ev.filter((e) => e.name === "ForfeitedIdle");
  if (forfeits.length) bad(`${forfeits.length} player(s) were forfeited for idleness — the system eliminated them, not the poker`);
  else ok("nobody was eliminated by the system");
  if (busts.length) {
    const out = busts[0].args.player.toLowerCase();
    const t = tabs.find((x) => x.wallet.address.toLowerCase() === out);
    if (t) {
      const f = await felt(t);
      const told = /out|observ|place|выбыл|finished/i.test(f.body || "");
      if (told) ok(`${t.tag} busted and its screen says so`);
      else bad(`${t.tag} busted and the screen never said so`);
      // …and it must not congratulate them. A player who is OUT being shown
      // "YOU WIN" over someone else's pot is the loudest possible way for a
      // table to look rigged.
      if (/you win/i.test(f.body || "")) bad(`${t.tag} is OUT but its screen says YOU WIN`);
      else ok(`${t.tag} is not told it won anything after busting`);
    }
  } else bad("nobody busted — the elimination path went untested");

  // (4) The event must end, and the survivors must be told.
  if (status >= 2) {
    const fin = ev.find((e) => e.name === "Finished");
    ok(`tournament finished · winner ${fin ? fin.args.winner.slice(0, 10) : "?"} · ${busts.length} eliminated`);
    const winner = tabs.find((t) => fin && t.wallet.address.toLowerCase() === fin.args.winner.toLowerCase());
    if (winner) {
      // the table learns the event is over from a 5s tournament poll, so give it
      // a few of those before calling it silent
      const said = await waitFor("the winner's screen", async () => {
        const f = await felt(winner);
        return /you win|1st|first|champion|final standings|winner|побед/i.test(f.body || "") ? f : null;
      }, 30_000).catch(() => null);
      if (said) ok("the winner's screen announces the result");
      else bad("the winner's screen never announced the win");
    }
  } else bad(`tournament did not finish inside the budget (status ${status})`);

  if (process.env.SHOTS !== "0") {
    const fs = await import("node:fs");
    fs.mkdirSync("test/_e2e-shots", { recursive: true });
    for (const t of tabs) await t.page.screenshot({ path: `test/_e2e-shots/trn-${t.tag}.png` });
    console.log("\nscreenshots → test/_e2e-shots/");
  }
  if (!KEEP) { await browser.close(); webs.forEach((w) => w.close()); }
  else console.log(`\nKEEP=1 — still up at http://127.0.0.1:${WEB_PORT}/poker/table.html?t=${table}&embed=1`);
}

main()
  .then(() => finish("a whole tournament plays through real browsers"))
  .catch(async (e) => {
    console.error("\nharness error:", e.message);
    for (const t of tabs) {
      try {
        const f = await felt(t);
        console.error(`  [${t.tag}] seat=${t.seat} hero=${f.hero} board=${f.board} strip=${(f.strip || "").slice(0, 80)}`);
      } catch (_) {}
    }
    console.error("--- dealer tail ---\n" + dealerTail(30));
    killAll();
    process.exit(1);
  });
