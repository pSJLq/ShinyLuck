// THE POKER FRAME MUST NEVER GO SILENTLY BLANK.
//
// Some players got an empty poker tab: no lobby, no error, nothing to report.
// Everything around it worked, so the fault was inside the frame and invisible
// from outside — we could not even tell whether their browser had run our code.
// We cannot ask those players to retry on demand, so instead of waiting for a
// reproduction, the page was made to survive, heal and confess. This holds it
// to that, in a real browser, against the real dealer:
//
//   healthy load    · says nothing at all. A beacon that cries on every normal
//                     page load is a beacon nobody reads.
//   storage throws  · iOS Safari (which is what an in-app browser opens) can
//                     make `localStorage` THROW rather than return null. One
//                     unguarded read in a React initializer blanked the lobby.
//   bundle missing  · the player gets a readable panel with a way out, and the
//                     dealer is told WHICH file failed.
//   module fails once · the page reloads itself and the player sees a lobby.
//                     This is the only failure that blanks the page for good:
//                     Privy, /rpc, the dealer API and the fonts can all die
//                     without stopping it (measured — see HANDOFF 27.11).
//   module never comes · exactly one retry, then the panel. No reload loop.
//   document missing  · the frame cannot speak for itself, so the SHELL retries
//                     it once and then reports.
//
//   node test/poker-hostile-browser.mjs        (~1 min after the stack is up)
//   HEADED=1 node test/poker-hostile-browser.mjs
import {
  bringUpStack, loadPlaywright, sleep, ok, bad, step, finish, killAll,
  HEADED, KEEP, WEB_PORT, DEALER_PORT,
} from "./_e2e-stack.mjs";

const LOBBY = `http://127.0.0.1:${WEB_PORT}/poker/lobby.html?embed=1`;
const clientLog = () =>
  fetch(`http://127.0.0.1:${DEALER_PORT}/clientlog?tail=200`).then((r) => r.json()).catch(() => ({ entries: [] }));

// The storage a hostile in-app browser gives a framed document: the property
// itself throws, so `typeof localStorage !== "undefined"` sees nothing wrong.
const THROWING_STORAGE = () => {
  const boom = () => { throw new DOMException("The operation is insecure.", "SecurityError"); };
  Object.defineProperty(window, "localStorage", { configurable: true, get: boom });
  Object.defineProperty(window, "sessionStorage", { configurable: true, get: boom });
};

// Poll rather than waitForFunction: the page under test may RELOAD itself
// (that is the behaviour being tested), and an evaluation in flight when the
// document swaps throws — which would read as a failure of the app instead of
// a race in the harness.
async function waitMounted(page, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const up = await page.evaluate(() => {
      const r = document.getElementById("root");
      return !!r && r.childElementCount > 0;
    }).catch(() => false);
    if (up) return true;
    await sleep(500);
  }
  return false;
}

const mountedIn = (page) => page.evaluate(() => {
  const r = document.getElementById("root");
  return { kids: r ? r.childElementCount : -1, chars: r ? r.innerHTML.length : 0, text: (document.body.innerText || "").slice(0, 400) };
});

// The local stack (chain + dealer + zk workers) can starve the box for a beat
// right after bring-up, and a cold navigation then misses the default 30s.
// Retrying once keeps a busy machine from reading as a product failure.
async function goTo(page, url) {
  for (let i = 0; i < 2; i++) {
    try { return await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }); }
    catch (e) { if (i) throw e; await sleep(1500); }
  }
}

async function main() {
  await bringUpStack({ origins: 1 });

  step("5  browser");
  // BROWSER=webkit runs this on Safari's engine — the family the broken devices
  // actually use (`npx playwright install webkit` once).
  const engine = process.env.BROWSER === "webkit" ? "webkit" : "chromium";
  const browser = await loadPlaywright()[engine].launch({ headless: !HEADED });
  const newTab = async (init) => {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
    if (init) await ctx.addInitScript(init);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log(`  · page error: ${e.message.slice(0, 160)}`));
    return { ctx, page };
  };
  ok(`${engine} up`);

  // ---- C · a healthy load stays quiet ------------------------------------
  step("6  healthy load says nothing");
  const before = (await clientLog()).count;
  {
    const { ctx, page } = await newTab();
    await goTo(page, LOBBY);
    await waitMounted(page, 60_000);
    const m = await mountedIn(page);
    ok(`lobby mounted normally (${m.chars} chars in #root)`);
    await sleep(12_000); // past the watchdog's 9s
    if (await page.locator("#sp-boot-fail").count()) bad("the failure panel appeared on a HEALTHY page");
    else ok("no failure panel on a healthy page");
    await ctx.close();
  }
  const afterHealthy = (await clientLog()).count;
  if (afterHealthy === before) ok("dealer received no reports from the healthy load");
  else bad(`healthy load sent ${afterHealthy - before} report(s) — the beacon is noisy`);

  // ---- A · localStorage throws -------------------------------------------
  step("7  a browser whose localStorage throws");
  {
    const { ctx, page } = await newTab(THROWING_STORAGE);
    await goTo(page, LOBBY);
    // The bug under test: the lobby never mounted at all on such a device.
    const up = await waitMounted(page, 60_000);
    if (!up) bad("lobby did NOT mount with throwing storage — this is the reported bug");
    else {
      const m = await mountedIn(page);
      ok(`lobby mounted anyway (${m.chars} chars in #root)`);
      if (/stakes|table|cash/i.test(m.text)) ok("real lobby content on screen, not an empty shell");
      else bad(`mounted but the page reads empty: "${m.text.slice(0, 120)}"`);
    }
    // Storage still has to WORK, or every preference write becomes a new crash.
    const shim = await page.evaluate(() => {
      try {
        localStorage.setItem("sp_probe", "1");
        return { state: window.SPBoot && window.SPBoot.storage, roundtrip: localStorage.getItem("sp_probe") };
      } catch (e) { return { state: window.SPBoot && window.SPBoot.storage, err: String(e) }; }
    });
    if (shim.roundtrip === "1") ok(`storage stood in for the broken one (${shim.state})`);
    else bad(`storage still unusable after boot: ${JSON.stringify(shim)}`);
    if (await page.locator("#sp-boot-fail").count()) bad("failure panel shown even though the lobby mounted");
    await sleep(3000);
    await ctx.close();
  }
  {
    const entries = (await clientLog()).entries;
    const rep = entries.find((e) => e.kind === "storage");
    if (rep && /shim/.test(rep.diag.ls || "")) ok(`dealer was told: "${rep.msg}"`);
    else bad("dealer never heard that this device's storage was broken");
  }

  // ---- B · a bundle that never arrives ------------------------------------
  step("8  the app's bundle fails to load");
  {
    const { ctx, page } = await newTab();
    await page.route("**/poker-lobby-app.compiled.js", (r) => r.abort());
    await goTo(page, LOBBY);
    const shown = await page.waitForSelector("#sp-boot-fail", { timeout: 45_000 }).then(() => true).catch(() => false);
    if (!shown) bad("nothing mounted AND no failure panel — the player sees a black rectangle");
    else {
      const t = await page.locator("#sp-boot-fail").innerText();
      ok(`player sees: "${t.replace(/\s+/g, " ").slice(0, 90)}…"`);
      if (/reload/i.test(t)) ok("panel offers a way out (Reload)");
      else bad("panel has no reload affordance");
    }
    await sleep(2000);
    await ctx.close();
  }
  {
    const entries = (await clientLog()).entries;
    const blank = entries.find((e) => e.kind === "blank");
    const res = entries.find((e) => e.kind === "resource" && /poker-lobby-app/.test(e.msg));
    if (blank) ok(`dealer was told the frame was blank (react=${blank.diag.react}, sp=${blank.diag.sp}, app=${blank.diag.app})`);
    else bad("dealer never heard about the blank frame");
    if (res) ok(`dealer was told WHICH file failed: ${res.msg.replace(/^failed to load /, "")}`);
    else bad("dealer never heard which resource failed");
  }

  // ---- B2 · a module that fails ONCE must heal itself ---------------------
  // The only failure that blanks this page permanently is a module that does
  // not arrive (ethers -> poker-sdk -> poker-bridge): nothing else we can break
  // — Privy, /rpc, the dealer API, fonts — stops the lobby from drawing. On a
  // phone's network one bad fetch is ordinary, and players do not reload; they
  // leave. So the page reloads itself once, and the player sees a lobby.
  step("8b  a module fails once, then works");
  {
    const { ctx, page } = await newTab();
    let blocked = 0;
    await page.route("**/vendor/ethers.bundle.js", (r) => {
      if (blocked++ === 0) return r.abort();   // first load fails, retry gets it
      return r.continue();
    });
    await goTo(page, LOBBY);
    const up = await waitMounted(page, 45_000);
    if (up) ok(`lobby healed itself after a failed module (${blocked} attempts at ethers)`);
    else bad("a single failed module still costs the player the whole tab");
    if (!/_spretry/.test(page.url())) bad("mounted without the retry marker — the test did not exercise the retry");
    await sleep(2000);
    await ctx.close();
  }
  {
    const e = (await clientLog()).entries.find((x) => x.kind === "blank-retry");
    if (e) ok(`dealer heard about the near-miss too (sp=${e.diag.sp})`);
    else bad("the page healed silently — we would never learn this device had trouble");
  }

  // ---- B3 · when it never arrives, the retry must not loop -----------------
  step("8c  a module that never arrives: one retry, then the panel");
  {
    const { ctx, page } = await newTab();
    let hits = 0;
    await page.route("**/vendor/ethers.bundle.js", (r) => { hits++; r.abort(); });
    await goTo(page, LOBBY);
    const shown = await page.waitForSelector("#sp-boot-fail", { timeout: 45_000 }).then(() => true).catch(() => false);
    if (shown) ok(`gave up gracefully after ${hits} attempts and showed the panel`);
    else bad("no panel after the retry failed — the player is left with a blank frame");
    await sleep(6000);                                    // a loop would show up here
    if (hits <= 3) ok(`no reload loop (${hits} attempts total)`);
    else bad(`reload loop: ${hits} attempts at the same file`);
    await ctx.close();
  }

  // ---- D · the frame's own document never arrives -------------------------
  // The blind spot the frame cannot cover: if lobby.html itself never loads,
  // the guard inside it never runs and the player's empty tab says nothing.
  // The SHELL has to notice that one.
  step("9  the frame's document never loads");
  {
    const { ctx, page } = await newTab();
    await page.route("**/poker/lobby.html*", (r) => r.abort());
    await goTo(page, `http://127.0.0.1:${WEB_PORT}/poker`);
    const got = await (async () => {
      for (let i = 0; i < 50; i++) {          // 14s, one reload, 14s again
        const e = (await clientLog()).entries.find((x) => x.kind === "frame");
        if (e) return e;
        await sleep(1000);
      }
      return null;
    })();
    if (got) ok(`shell reported for the silent frame: "${got.msg}" (guard=${got.diag.guard}, inner=${got.diag.inner})`);
    else bad("the poker frame stayed empty and NOBODY reported it");
    await ctx.close();
  }

  if (!KEEP) await browser.close();
}

main()
  // bad(), not just a log: finish() prints its verdict from the failure count,
  // so a thrown harness error must count as a failure or the run reports green.
  .catch((e) => { bad(`harness threw: ${e && e.message}`); console.error(e); })
  .finally(async () => {
    await sleep(300);
    finish("the poker frame reports itself when it breaks");   // exits unless KEEP=1
  });
