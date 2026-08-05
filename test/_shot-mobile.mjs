// A PHONE, AT A LIVE TABLE. The portrait layout was only ever checked on an
// empty felt; this seats two players on the local stack, plays until cards are
// out, and photographs what a phone actually shows: hole cards, board, pot,
// seat pods and the action bar, at 390×664.
//
//   node test/_shot-mobile.mjs            → test/_shots-mobile/*.png
//   KEEP=1 node test/_shot-mobile.mjs     → leave the stack up
import fs from "node:fs";
import path from "node:path";
import {
  bringUpStack, fundPlayers, loadPlaywright, injectWallet, abiOf, snapshotOf,
  ethers, sleep, ok, step, finish, KEEP, WEB_PORT, REPO,
} from "./_e2e-stack.mjs";

const TABLE = 3;                       // the 2-seat tier
const OUT = path.join(REPO, "test", "_shots-mobile");
fs.mkdirSync(OUT, { recursive: true });

async function main() {
  const { man } = await bringUpStack({ origins: 2 });

  step("5  seat two players");
  const { wallets, signers } = await fundPlayers(2);
  for (let i = 0; i < wallets.length; i++) {
    const room = new ethers.Contract(man.addresses.pokerRoom, abiOf("PokerRoom"), signers[i]);
    await (await room.deposit({ value: ethers.parseEther("3") })).wait();
    await (await room.sitDown(TABLE, i, ethers.parseEther("2"))).wait();
  }
  ok("two seats taken");

  step("6  phones");
  const pw = loadPlaywright();
  const browser = await pw.chromium.launch({ headless: true });
  const tabs = [];
  for (let i = 0; i < wallets.length; i++) {
    const ctx = await browser.newContext({ ...pw.devices["iPhone 13"] });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log(`  · [p${i}] ${e.message.slice(0, 120)}`));
    await injectWallet(page, wallets[i]);
    await page.goto(`http://127.0.0.1:${WEB_PORT + i}/poker?v=table&t=${TABLE}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    tabs.push({ page, ctx, tag: "p" + i });
  }
  ok("two phones at the table");

  const shot = async (name) => {
    for (const t of tabs) await t.page.screenshot({ path: path.join(OUT, `${name}-${t.tag}.png`) });
    console.log("  ▸ " + name);
  };

  step("7  wait for cards, then photograph");
  for (let i = 0; i < 120; i++) {
    const s = await snapshotOf(TABLE);
    if (s && s.hand && s.hand.inProgress) break;
    await sleep(1000);
  }
  await sleep(9000);                    // let the deal render
  await shot("preflop");

  // push the hand to a board: click whatever the acting phone offers
  for (let round = 0; round < 10; round++) {
    const s = await snapshotOf(TABLE);
    if (!s || !s.hand) break;
    if (Number(s.hand.street) >= 1) { await sleep(3500); await shot("flop"); break; }
    const t = tabs[Number(s.hand.actingSeat)];
    if (t) {
      await sleep(900);
      const btn = t.page.locator(".actionbar .abtn.call").first();
      if (await btn.count()) await btn.click({ timeout: 4000 }).catch(() => {});
    }
    await sleep(1200);
  }
  await sleep(2500);
  await shot("late");

  step("8  the lobby, on the same phone");
  await tabs[0].page.goto(`http://127.0.0.1:${WEB_PORT}/poker`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(9000);
  await tabs[0].page.screenshot({ path: path.join(OUT, "lobby-p0.png") });
  await tabs[0].page.screenshot({ path: path.join(OUT, "lobby-full.png"), fullPage: true });
  ok("lobby shot");

  if (!KEEP) await browser.close();
  console.log("\nshots → test/_shots-mobile/");
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await sleep(200); finish("mobile shots"); });
