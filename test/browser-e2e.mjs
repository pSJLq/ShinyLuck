// A REAL GAME OF POKER, PLAYED BY THIS SCRIPT, IN A REAL BROWSER.
//
// Everything else we have tests the parts: contracts in isolation, the dealer
// module against a fake client, the pages' ability to load. None of it opened a
// table, looked at the felt and said "the cards are on screen". That gap is why
// the showdown could stop rendering for a whole tournament without a single
// test going red, and why finding out cost twelve people their evening.
//
// Two headless tabs run the SAME frontend production serves, play a hand out
// through the real UI (clicking the real buttons), and this asserts what a
// player would actually see.
//
//   npm run test:browser              headless, ~2 min
//   HEADED=1 npm run test:browser     watch it play
//   KEEP=1   npm run test:browser     leave the stack up afterwards
//
// Needs Playwright once: npm i -D playwright && npx playwright install chromium
import {
  bringUpStack, fundPlayers, openTable, felt, loadPlaywright, abiOf, snapshotOf,
  ethers, sleep, ok, bad, step, finish, killAll, dealerTail, waitFor, HEADED, KEEP, WEB_PORT,
} from "./_e2e-stack.mjs";

const TABLE = 3; // the 2-seat tier from deploy-poker-v2's TABLES
let tabs = [];

async function main() {
  const { man, webs } = await bringUpStack({ origins: 2 });

  step("5  seat two players");
  const { wallets, signers } = await fundPlayers(2);
  for (let i = 0; i < wallets.length; i++) {
    const room = new ethers.Contract(man.addresses.pokerRoom, abiOf("PokerRoom"), signers[i]);
    await (await room.deposit({ value: ethers.parseEther("3") })).wait();
    await (await room.sitDown(TABLE, i, ethers.parseEther("2"))).wait();
  }
  ok(`${wallets.map((w) => w.address.slice(0, 8)).join(", ")} seated at table ${TABLE}`);

  step("6  browsers");
  const browser = await loadPlaywright().chromium.launch({ headless: !HEADED });
  for (let i = 0; i < wallets.length; i++) tabs.push(await openTable(browser, wallets[i], "p" + i, i, TABLE));
  ok("two tabs connected with injected wallets");

  step("7  play a hand through the UI");
  await waitFor("hand to start", async () => {
    const s = await snapshotOf(TABLE);
    return s && s.hand && s.hand.inProgress;
  }, 120_000);
  ok("hand started (the browsers ran the shuffle themselves)");

  for (const t of tabs) {
    const seen = await waitFor(`${t.tag} hole cards`, async () => {
      const f = await felt(t);
      return f.hero >= 2 && f.heroBacks === 0 ? f : null;
    }, 90_000).catch(() => null);
    if (seen) ok(`${t.tag}: own cards face-up`); else bad(`${t.tag}: never saw its own hole cards`);
  }

  // Everything below is pinned to ONE hand. The dealer keeps dealing, so an
  // assertion that waits for "a settle" can land on the next hand (a preflop
  // fold with no board) and report a regression that never happened.
  let acted = 0, sdHand = null;
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const snap = await snapshotOf(TABLE);
    if (!snap || !snap.hand) { await sleep(300); continue; }
    if (Number(snap.hand.street) === 4 && snap.hand.inProgress) { sdHand = String(snap.hand.handId); break; }
    if (!snap.hand.inProgress) { await sleep(300); continue; }
    const t = tabs[Number(snap.hand.actingSeat)];
    if (!t) { await sleep(300); continue; }
    // the click guard refuses anything landing within 600ms of the bar changing
    // meaning — that IS the fix under test, so wait it out like a player would
    await sleep(800);
    const btn = t.page.locator(".actionbar .abtn.call").first();
    if (await btn.count()) {
      const label = (await btn.textContent().catch(() => "")).replace(/\s+/g, " ").trim();
      await btn.click({ timeout: 5000 }).catch(() => {});
      if (acted < 3) ok(`${t.tag} clicked "${label}"`);
      acted++;
    }
    await sleep(900);
  }
  if (acted) ok(`${acted} actions sent by clicking the real buttons`);
  else bad("never managed to act through the UI");

  if (!sdHand) { bad("the hand never reached showdown"); }
  else {
    const sd = await waitFor("both hands open on screen", async () => {
      for (const t of tabs) {
        const f = await felt(t);
        if (f.board >= 5 && f.revealed >= 2) return { t, f };
      }
      return null;
    }, 45_000).catch(() => null);
    if (sd) ok(`showdown on ${sd.t.tag}: ${sd.f.board} board cards + ${sd.f.revealed} opponent cards open`);
    else bad("showdown never put the board and the opponent's cards on screen");

    // …and it must SURVIVE the settle. The bug was that the felt went blank the
    // instant the pot moved: board, opponent's hand and your own cards all gone,
    // leaving a winner banner hanging over nothing.
    // Timing matters. The hold lasts about three seconds and the next hand
    // starts one or two behind the settle, so this watches the dealer's snapshot
    // directly and photographs the felt the moment the pot moves — which is
    // exactly the moment a player is looking at it.
    let shot = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 60_000) {
      const s = await snapshotOf(TABLE);
      if (s && s.hand && (!s.hand.inProgress || String(s.hand.handId) !== sdHand)) {
        const [a, b] = await Promise.all([felt(tabs[0]), felt(tabs[1])]);
        shot = a.board >= b.board ? a : b;
        break;
      }
      await sleep(100);
    }
    if (!shot) bad("the showdown hand never settled");
    else {
      if (shot.board >= 5) ok("board still on screen after the pot moved"); else bad(`board vanished at settle (${shot.board} cards)`);
      if (shot.hero >= 2) ok("own cards still on screen after the pot moved"); else bad("own cards vanished at settle");
      if (shot.revealed >= 2) ok("opponent's hand still open after the pot moved"); else bad(`reveals vanished at settle (${shot.revealed})`);
      if (shot.banner) ok(`winner announced: "${shot.banner.slice(0, 60)}"`); else bad("no winner banner");
    }
  }

  if (process.env.SHOTS !== "0") {
    const fs = await import("node:fs");
    const dir = "test/_e2e-shots";
    fs.mkdirSync(dir, { recursive: true });
    for (const t of tabs) await t.page.screenshot({ path: `${dir}/cash-${t.tag}.png` });
    console.log(`\nscreenshots → ${dir}/`);
  }
  if (!KEEP) { await browser.close(); webs.forEach((w) => w.close()); }
  else console.log(`\nKEEP=1 — still up at http://127.0.0.1:${WEB_PORT}/poker/table.html?t=${TABLE}&embed=1`);
}

main()
  .then(() => finish("poker plays end to end in a real browser"))
  .catch(async (e) => {
    console.error("\nharness error:", e.message);
    for (const t of tabs) {
      try {
        const d = await t.page.evaluate(() => ({
          addr: window.SP && window.SP.sdk && window.SP.sdk.address,
          zk: (window.__SPZK || {}).status,
          holes: Object.keys((window.__SPZK || {}).holes || {}),
        }));
        console.error(`  [${t.tag}] ${JSON.stringify(d).slice(0, 400)}`);
      } catch (_) {}
    }
    console.error("--- dealer tail ---\n" + dealerTail());
    killAll();
    process.exit(1);
  });
