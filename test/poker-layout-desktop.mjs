// DOES ANYTHING SIT ON TOP OF ANYTHING? — measured, on a live hand.
//
// The complaint that started this file: "the action panel covers the player
// panel, the top bar clips the players, opening the chat covers the table."
// All three are geometry, and geometry can be measured — so this seats two
// players on the local stack, plays until the felt is full, and reads the
// bounding boxes of the things that must not touch. A screenshot next to it
// is for the eye; the assertions are for the build.
//
//   node test/poker-layout-desktop.mjs        → test/_shots-desktop/*.png
//   KEEP=1 …                                  → leave the stack up
import fs from "node:fs";
import path from "node:path";
import {
  bringUpStack, fundPlayers, loadPlaywright, injectWallet, abiOf, snapshotOf,
  ethers, sleep, ok, bad, step, finish, KEEP, WEB_PORT, REPO,
} from "./_e2e-stack.mjs";

const TABLE = 3;                        // the 2-seat tier
const VIEW = { width: 1440, height: 950 };
const OUT = path.join(REPO, "test", "_shots-desktop");
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (f.endsWith(".png")) fs.unlinkSync(path.join(OUT, f));

let failures = 0;
const fail = (m) => { failures++; bad(m); };

// Two boxes overlap when they overlap on BOTH axes. `slack` forgives the
// deliberate straddle (a seat pod is meant to sit half on the rail).
const overlap = (a, b) => {
  if (!a || !b) return null;
  const x = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const y = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return x > 0 && y > 0 ? { x: Math.round(x), y: Math.round(y) } : null;
};
// The table is a page inside the shell's iframe, so every query has to go to
// that frame — the top document holds nothing but the chrome. Boxes are read
// in the FRAME's coordinates, which is what makes them comparable.
const frameOf = async (page) => {
  for (let i = 0; i < 60; i++) {
    const f = page.frames().find((fr) => /table\.html/.test(fr.url()));
    if (f && (await f.$(".app").catch(() => null))) return f;
    await sleep(500);
  }
  throw new Error("the table frame never appeared");
};
const boxOf = (frame, sel) => frame.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width && r.height ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
}, sel);

async function mustNotOverlap(frame, name, selA, selB, slack = 0) {
  const [a, b] = await Promise.all([boxOf(frame, selA), boxOf(frame, selB)]);
  if (!a) return console.log(`  · ${name}: ${selA} not on screen, skipped`);
  if (!b) return console.log(`  · ${name}: ${selB} not on screen, skipped`);
  const o = overlap(a, b);
  if (o && o.x > slack && o.y > slack) fail(`${name}: ${selA} and ${selB} overlap by ${o.x}×${o.y}px`);
  else ok(`${name}: clear`);
}

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

  step("6  two desktop browsers");
  const pw = loadPlaywright();
  const browser = await pw.chromium.launch({ headless: true });
  const tabs = [];
  for (let i = 0; i < wallets.length; i++) {
    const ctx = await browser.newContext({ viewport: VIEW });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => fail(`[p${i}] ${e.message.slice(0, 140)}`));
    await injectWallet(page, wallets[i]);
    await page.goto(`http://127.0.0.1:${WEB_PORT + i}/poker?v=table&t=${TABLE}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    tabs.push({ page, tag: "p" + i });
  }
  ok("two tables open at 1440×950");

  const shot = async (name) => {
    for (const t of tabs) await t.page.screenshot({ path: path.join(OUT, `${name}-${t.tag}.png`) });
    console.log("  ▸ " + name);
  };

  step("7  wait for a hand");
  for (let i = 0; i < 120; i++) {
    const s = await snapshotOf(TABLE);
    if (s && s.hand && s.hand.inProgress) break;
    await sleep(1000);
  }
  await sleep(8000);

  // whoever is to act sees the FULL bar (sizing row + four buttons) — the tall
  // state, which is the one that used to ride up over the hero's plaque
  step("8  the acting player's screen");
  const snap = await snapshotOf(TABLE);
  const actor = tabs[Number(snap.hand.actingSeat)] || tabs[0];
  const waiter = tabs[Number(snap.hand.actingSeat) === 0 ? 1 : 0];
  const aF = await frameOf(actor.page), wF = await frameOf(waiter.page);
  await shot("acting");

  await mustNotOverlap(aF, "action bar vs hero panel", ".actbar", ".heroinfo");
  // NOT TOUCHING IS NOT THE SAME AS BREATHING. Clearing the overlap left the
  // player's plaque and the card holding their buttons a hairline apart, which
  // reads as one crowded block; the gap is a number now, not an accident.
  //
  // MEASURED AT MORE THAN ONE WINDOW SIZE, and that is the point. The desktop
  // stage is a fixed canvas under a CSS scale, so a short window scales it
  // DOWN — and the first version of this measurement read the bar through that
  // transform and under-reported it, which pulled the plaque back toward the
  // buttons. At 1440x950 the scale is ~1.0 and the bug is invisible; on the
  // 1536x792 window the user was actually playing on, it is 14px.
  const GAP_MIN = 24;
  const gapAt = async (page, frame, w, h) => {
    await page.setViewportSize({ width: w, height: h });
    await sleep(1200);
    const [pod, card] = [await boxOf(frame, ".heroinfo"), await boxOf(frame, ".actbar")];
    if (!pod || !card) return console.log(`  · ${w}x${h}: nothing to measure, skipped`);
    // both boxes come through the same transform, so their ratio is honest;
    // undo it so the number is comparable to the CSS that produced it
    const s = await frame.evaluate(() => {
      const m = new DOMMatrixReadOnly(getComputedStyle(document.querySelector(".app")).transform);
      return m.a || 1;
    });
    const gap = Math.round((card.y - (pod.y + pod.height)) / s);
    if (gap < GAP_MIN) fail(`${w}x${h} (stage scale ${s.toFixed(2)}): only ${gap}px between the hero's panel and the action card, want ≥${GAP_MIN}`);
    else ok(`${w}x${h} (stage scale ${s.toFixed(2)}): ${gap}px between the hero's panel and the action card`);
    // THE INVARIANT UNDER THE GAP: --sp-barmax is a LAYOUT length, used inside
    // the scaled canvas, so it has to be measured in layout px. Read through
    // the transform it comes out `scale` times too small, and everything
    // positioned off it drifts by that much — silently, and only on the window
    // sizes nobody happened to test.
    const m = await frame.evaluate(() => ({
      published: parseInt(getComputedStyle(document.documentElement).getPropertyValue("--sp-barmax"), 10) || 0,
      layout: (document.querySelector(".actionbar") || {}).offsetHeight || 0,
    }));
    if (m.published && Math.abs(m.published - m.layout) > 1)
      fail(`--sp-barmax is ${m.published}px but the bar lays out at ${m.layout}px — measured through the stage transform`);
    else if (m.published) ok(`--sp-barmax ${m.published}px = the bar's layout height`);
  };
  await gapAt(actor.page, aF, VIEW.width, VIEW.height);
  await gapAt(actor.page, aF, 1536, 792);   // the window in the user's screenshot
  await gapAt(actor.page, aF, 1280, 720);
  await actor.page.setViewportSize(VIEW);
  await sleep(1000);
  await mustNotOverlap(aF, "action bar vs hero cards", ".actbar", ".herozone .hole");
  await mustNotOverlap(aF, "header vs felt", ".topbar", ".felt");
  await mustNotOverlap(wF, "pre-select bar vs hero panel", ".actbar", ".heroinfo");

  // every seat pod must stay inside the stage and clear the header
  step("9  seat pods");
  const pods = await aF.evaluate(() => [...document.querySelectorAll(".seatcard")].map((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }));
  const stage = await aF.evaluate(() => ({ w: document.documentElement.clientWidth, h: document.documentElement.scrollHeight }));
  const top = await boxOf(aF, ".topbar");
  let clipped = 0, under = 0;
  for (const p of pods) {
    if (p.x < -2 || p.y < -2 || p.x + p.width > stage.w + 2 || p.y + p.height > stage.h + 2) clipped++;
    if (top && overlap(p, top)) under++;
  }
  if (!pods.length) fail("no seat pods rendered at all");
  else if (clipped) fail(`${clipped} of ${pods.length} seat pods run off the stage`);
  else ok(`${pods.length} seat pods all on the stage`);
  if (under) fail(`${under} seat pod(s) sit under the header`); else ok("no seat pod under the header");

  // the strip that was deleted must be gone, and what replaced it present
  step("10  the header carries the table's facts");
  const hud = await aF.$(".trn-hud");
  if (hud) fail(".trn-hud is still rendered"); else ok("the tournament strip is gone");
  const sub = await aF.evaluate(() => (document.querySelector(".tableid .sub") || {}).textContent || "");
  if (!/Hand/i.test(sub)) fail(`header sub-line lost the hand number: "${sub}"`); else ok(`header reads: ${sub.trim()}`);

  // THE BUTTON THAT WAS TOO LOUD. The raise used to be the one filled slab of
  // gold; toning it down must not tip it into unreadable, so every action
  // button is checked for a visible label and a real contrast against its own
  // background — and none of them may be the only lit thing on the bar.
  step("10b  the action buttons are readable");
  const btns = await aF.evaluate(() => [...document.querySelectorAll(".actionbar .abtn")].map((el) => {
    const cs = getComputedStyle(el), lbl = el.querySelector(".lbl");
    const lum = (c) => { const m = c.match(/[\d.]+/g) || [0, 0, 0]; return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; };
    return {
      cls: el.className, text: (el.textContent || "").trim(), disabled: el.disabled,
      opacity: Number(cs.opacity), labelLum: lbl ? lum(getComputedStyle(lbl).color) : 0,
    };
  }));
  for (const b of btns) {
    const tag = b.cls.replace("abtn ", "");
    if (!b.text) fail(`action button "${tag}" has no text`);
    else if (!b.disabled && (b.opacity < 0.9 || b.labelLum < 0.28))
      fail(`action button "${tag}" (${b.text.replace(/\s+/g, " ")}) is hard to read: opacity ${b.opacity}, label luminance ${b.labelLum.toFixed(2)}`);
    else ok(`"${tag}" → ${b.text.replace(/\s+/g, " ")}${b.disabled ? " (disabled)" : ""}`);
  }

  step("11  the chat moves the table instead of covering it");
  const feltBefore = await boxOf(aF, ".felt");
  await aF.click(".railfab", { timeout: 8000 }).catch((e) => fail("chat button: " + e.message.slice(0, 60)));
  await sleep(900);
  await actor.page.screenshot({ path: path.join(OUT, "chat-open.png") });
  const railBox = await boxOf(aF, ".siderail");
  const feltAfter = await boxOf(aF, ".felt");
  if (!railBox) fail("the chat rail did not open");
  else if (overlap(railBox, feltAfter)) fail(`the open chat still covers the felt by ${overlap(railBox, feltAfter).x}px`);
  else ok(`chat open: felt ${Math.round(feltBefore.width)}px → ${Math.round(feltAfter.width)}px, nothing covered`);
  await mustNotOverlap(aF, "open chat vs action bar", ".siderail", ".actbar");

  if (!KEEP) await browser.close();
  console.log(failures ? `\n${failures} LAYOUT FAILURES\n` : "\nlayout clear · shots in test/_shots-desktop/\n");
  process.exitCode = failures ? 1 : 0;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await sleep(200); finish("desktop layout"); });
