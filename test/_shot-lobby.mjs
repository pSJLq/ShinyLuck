// Screenshot rig for the redesign: brings up the same local stack the browser
// E2E uses, then photographs the lobby (cash + tournaments) and a table at a
// few viewport widths. Not a test — it asserts nothing; it exists so the felt,
// the cards and the rows can be LOOKED at without a deploy.
//
//   node test/_shot-lobby.mjs            desktop
//   MOBILE=1 node test/_shot-lobby.mjs   390x844
import path from "node:path";
import fs from "node:fs";
import {
  REPO, WEB_PORT, RPC, FUNDER_KEY, bringUpStack, killAll, loadPlaywright,
  abiOf, ethers, shippedStructures, sleep, ok, step,
} from "./_e2e-stack.mjs";

const OUT = path.join(REPO, "test", "_e2e-shots");
const MOBILE = process.env.MOBILE === "1";
const VIEW = MOBILE ? { width: 390, height: 844 } : { width: 1440, height: 950 };
const TAG = MOBILE ? "m-" : "";

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  step("1  stack");
  const { man } = await bringUpStack({ origins: 1 });

  // The tournaments tab is the page this redesign changed most, and an empty
  // one proves nothing: the whole point is how a list of open events reads
  // next to a pile of finished ones. So make some.
  step("1b  seed tournaments");
  const provider = new ethers.JsonRpcProvider(RPC);
  const host = new ethers.NonceManager(new ethers.Wallet(FUNDER_KEY, provider));
  const trn = new ethers.Contract(man.addresses.pokerTournament, abiOf("PokerTournament"), host);
  const levels = shippedStructures().regular.levels
    .map((l) => ({ sb: BigInt(l.sb), bb: BigInt(l.bb), ante: BigInt(l.ante), durationSecs: 480 }));
  const mk = (buyIn, fee, players, payout) => trn.createTournament({
    buyIn, fee, maxPlayers: players, seatsPerTable: Math.min(players, 9), startStack: 10000n,
    sbStart: 25n, bbStart: 50n, anteStart: 0n, levelDur: 480, growthBps: 20000,
    startTime: 0, approvalRequired: false, actionSecs: 30,
    payoutBps: payout, structure: levels, hostBps: 0,
  });
  await (await mk(ethers.parseEther("0.05"), ethers.parseEther("0.005"), 9, [5000, 3000, 2000])).wait();
  await (await mk(0n, 0n, 20, [6500, 3500], { value: 0 })).wait();          // freeroll
  await (await mk(ethers.parseEther("0.01"), ethers.parseEther("0.001"), 6, [10000])).wait();
  ok(`${Number(await trn.count())} tournaments seeded`);

  step("2  browser");
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });
  const page = await ctx.newPage();

  // `embed=1` or the page redirects itself into the SPA shell (which this
  // static server cannot serve — /poker is a directory) and we photograph a
  // 404. It is also the mode that actually ships: everything the player sees
  // is inside the casino's iframe.
  const base = `http://127.0.0.1:${WEB_PORT}/poker`;
  const shots = [
    ["lobby-cash", `${base}/lobby.html?embed=1`],
    ["lobby-trn", `${base}/lobby.html?embed=1&tab=tournaments`],
    ["table-empty", `${base}/table.html?embed=1&t=1`],
  ];
  for (const [name, url] of shots) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await sleep(6000);
    await page.screenshot({ path: path.join(OUT, `${TAG}${name}.png`), fullPage: !MOBILE });
    ok(`${TAG}${name}.png`);
  }

  await browser.close();
  killAll();
  console.log("\nshots → test/_e2e-shots/");
  process.exit(0);
})().catch((e) => { console.error(e); killAll(); process.exit(1); });
