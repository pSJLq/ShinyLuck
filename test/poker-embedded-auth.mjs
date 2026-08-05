// THE POKER FRAME BORROWS THE SHELL'S WALLET INSTEAD OF LOADING ITS OWN.
//
// Poker is an iframe of the same origin as the site around it, and both used to
// load `/vendor/privy.bundle.js` — 4.8 MB each, with its own auth.privy.io
// iframe and its own Turnstile frame on top. Measured on the live site with an
// iPhone profile: six frames, ~179 MB of JS heap for one poker tab. That is the
// shape of failure players reported (the frame blank, everything around it
// alive): when a phone runs short, WebKit kills the FRAME's content process.
//
// poker-auth.js now reuses the parent's `window.ShinyLuckAuth` when embedded.
// This is the money path — login and signing — so it does not ship on a
// "looks fine": the test drives a REAL transaction from inside the frame,
// signed through the parent's auth object, and checks the chain moved.
//
// The Privy bundle is blocked outright here, and a stand-in auth object backed
// by a real key is installed in the SHELL. If the frame can deposit under those
// conditions, it needs no Privy of its own.
//
//   node test/poker-embedded-auth.mjs
import {
  bringUpStack, fundPlayers, loadPlaywright, abiOf, ethers, sleep,
  ok, bad, step, finish, HEADED, KEEP, WEB_PORT, RPC,
} from "./_e2e-stack.mjs";

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
  const { man } = await bringUpStack({ origins: 1 });

  step("5  a funded player, whose key stands in for the Privy wallet");
  const { wallets } = await fundPlayers(1);
  const wallet = wallets[0];
  const provider = new ethers.JsonRpcProvider(RPC);
  const room = new ethers.Contract(man.addresses.pokerRoom, abiOf("PokerRoom"), provider);
  ok(`player ${wallet.address.slice(0, 10)}…`);

  step("6  browser · Privy bundle BLOCKED everywhere");
  const browser = await loadPlaywright().chromium.launch({ headless: !HEADED });
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  · page error: ${e.message.slice(0, 140)}`));
  // the signer narrates its own path (fast sign vs legacy) — the only way to
  // see WHY a signature was refused
  page.on("console", (m) => {
    const t = m.text();
    if (/privy-signer|SIGN FAIL|BROADCAST/.test(t)) console.log(`  · ${t.slice(0, 200)}`);
  });

  let privyRequests = 0;
  await page.route("**/vendor/privy.bundle.js", (r) => { privyRequests++; r.abort(); });

  // The shell's wallet: same surface poker-sdk.js and privy-signer.js use.
  // signTransaction is the path PrivySigner prefers (sign here, broadcast from
  // the frame), so that is the one worth proving.
  await page.exposeFunction("__e2eSign", async (tx) => {
    const signed = await wallet.signTransaction({
      to: tx.to,
      value: BigInt(tx.value || "0"),
      data: tx.data || "0x",
      // Privy's embedded wallet knows its own chain, so the signer legitimately
      // leaves chainId out; a bare key does not, hence the local default.
      chainId: Number(tx.chainId) || 31337,
      nonce: Number(tx.nonce),
      gasLimit: BigInt(tx.gas),
      maxFeePerGas: BigInt(tx.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
      type: 2,
    });
    return signed;
  });
  await page.exposeFunction("__e2eSignMsg", (m) => wallet.signMessage(m));

  await page.addInitScript((addr) => {
    if (window.self !== window.top) return;      // ONLY the shell has the wallet
    const big = (v) => (typeof v === "bigint" ? "0x" + v.toString(16) : v);
    window.ShinyLuckAuth = {
      ready: true, authenticated: true, address: addr,
      login: async () => addr,
      logout: async () => {},
      signTransaction: (tx) => window.__e2eSign({
        to: tx.to, value: big(tx.value ?? 0n), data: tx.data || "0x", chainId: tx.chainId,
        nonce: big(tx.nonce), gas: big(tx.gas),
        maxFeePerGas: big(tx.maxFeePerGas), maxPriorityFeePerGas: big(tx.maxPriorityFeePerGas),
      }),
      signMessage: (m) => window.__e2eSignMsg(m),
      sendTransaction: async () => { throw new Error("legacy path not used in this test"); },
    };
  }, wallet.address);
  ok("stand-in wallet installed in the shell only");

  step("7  open /poker and let the frame come up");
  await goTo(page, `http://127.0.0.1:${WEB_PORT}/poker`);
  const frame = await (async () => {
    for (let i = 0; i < 60; i++) {
      const f = page.frames().find((x) => /poker\/lobby\.html/.test(x.url()));
      if (f) {
        const up = await f.evaluate(() => {
          const r = document.getElementById("root");
          return !!r && r.childElementCount > 0;
        }).catch(() => false);
        if (up) return f;
      }
      await sleep(500);
    }
    return null;
  })();
  if (!frame) { bad("the poker frame never mounted without a Privy bundle of its own"); return; }
  ok("lobby mounted with NO Privy bundle in the frame");

  step("8  where the frame's wallet comes from");
  const src = await frame.evaluate(() => ({
    source: window.SPAuthSource,
    sameObject: window.ShinyLuckAuth === window.parent.ShinyLuckAuth,
    address: window.ShinyLuckAuth && window.ShinyLuckAuth.address,
    ready: !!(window.ShinyLuckAuth && window.ShinyLuckAuth.ready),
  }));
  if (src.source === "parent" && src.sameObject) ok("frame reads the shell's auth object directly");
  else bad(`frame did not borrow the shell's auth: ${JSON.stringify(src)}`);
  if (src.ready && src.address) ok(`sees the wallet: ${src.address.slice(0, 10)}…`);
  else bad("frame sees no wallet through the bridge");
  // exactly ONE request for the 4.8 MB bundle (the shell's), not two
  if (privyRequests <= 1) ok(`privy.bundle.js requested ${privyRequests}× (was 2× — one per frame)`);
  else bad(`the frame still asks for its own Privy bundle (${privyRequests} requests)`);

  step("9  the parent REPLACES its auth object · the frame must follow");
  // Privy swaps window.ShinyLuckAuth (stub → real API) once React mounts. A
  // one-shot copy would freeze the frame on the stub, and every login would
  // time out for reasons nobody could see.
  await page.evaluate(() => {
    const prev = window.ShinyLuckAuth;
    window.ShinyLuckAuth = Object.assign({}, prev, { address: "0x000000000000000000000000000000000000dEaD" });
    window.__prevAuth = prev;
  });
  const after = await frame.evaluate(() => window.ShinyLuckAuth.address);
  if (after === "0x000000000000000000000000000000000000dEaD") ok("frame follows the swap (live getter, not a copy)");
  else bad(`frame kept a stale auth object: ${after}`);
  await page.evaluate(() => { window.ShinyLuckAuth = window.__prevAuth; });

  step("10  auth-state events reach the frame's document");
  const heard = await frame.evaluate(() => new Promise((resolve) => {
    const on = (e) => { document.removeEventListener("shinyluck:auth-state", on); resolve((e.detail && e.detail.tag) || "no-detail"); };
    document.addEventListener("shinyluck:auth-state", on);
    setTimeout(() => resolve(null), 8000);
    window.parent.document.dispatchEvent(new CustomEvent("shinyluck:auth-state", { detail: { tag: "from-shell" } }));
  }));
  if (heard === "from-shell") ok("the shell's auth events are forwarded into the frame");
  else bad(`frame never heard the auth event (${heard}) — logins would hang waiting for it`);

  step("11  A REAL TRANSACTION, signed through the shell's wallet");
  const before = await room.balance(wallet.address);
  const res = await frame.evaluate(async () => {
    try {
      await window.SP.sdk.connect();                 // privy path, via the parent
      await window.SP.sdk.deposit("1");              // real tx: sign in shell, broadcast here
      return { ok: true, addr: window.SP.sdk.address, backend: window.SP.sdk.backend };
    } catch (e) { return { ok: false, err: String((e && e.message) || e).slice(0, 200) }; }
  });
  if (!res.ok) bad(`deposit through the bridge failed: ${res.err}`);
  else {
    ok(`frame connected as ${res.addr.slice(0, 10)}… (backend=${res.backend})`);
    const after2 = await room.balance(wallet.address);
    const moved = after2 - before;
    if (moved === ethers.parseEther("1")) ok(`chain agrees: poker balance +${ethers.formatEther(moved)} STT`);
    else bad(`chain does not agree: balance moved by ${ethers.formatEther(moved)} STT`);
  }

  step("12  a comma is an amount, not a zero");
  // On a phone the decimal key is whatever the locale says, and in Russian it
  // is a COMMA. The cashier read parseFloat("0,2") → 0 and told the player to
  // "Enter an amount" when they just had; the casino's stake reader stripped
  // the comma and bet "02" — ten times the money. Both go through one
  // normalizer now, and this proves the whole path: typed string → contract.
  const parsed = await frame.evaluate(() => ({
    num: window.SP.num("0,2"),
    wei: window.SP.parseEther("0,2").toString(),
    spaced: window.SP.num(" 1 234,56 "),
    junk: window.SP.num("abc"),
  }));
  if (parsed.num === 0.2 && parsed.wei === "200000000000000000") ok(`"0,2" reads as ${parsed.num} (${parsed.wei} wei)`);
  else bad(`"0,2" still misreads: ${JSON.stringify(parsed)}`);
  if (parsed.spaced === 1234.56 && parsed.junk === 0) ok("thousands separators survive, junk collapses to 0");
  else bad(`normalizer edge cases wrong: ${JSON.stringify(parsed)}`);

  const beforeComma = await room.balance(wallet.address);
  const dep2 = await frame.evaluate(async () => {
    try { await window.SP.sdk.deposit("0,2"); return { ok: true }; }
    catch (e) { return { ok: false, err: String((e && e.message) || e).slice(0, 160) }; }
  });
  if (!dep2.ok) bad(`depositing "0,2" failed: ${dep2.err}`);
  else {
    const moved = (await room.balance(wallet.address)) - beforeComma;
    if (moved === ethers.parseEther("0.2")) ok(`the chain received 0.2 STT, not 0 and not 2`);
    else bad(`typed "0,2" but the chain moved ${ethers.formatEther(moved)} STT`);
  }

  if (!KEEP) await browser.close();
}

main()
  .catch((e) => { bad(`harness threw: ${e && e.message}`); console.error(e); })
  .finally(async () => {
    await sleep(300);
    finish("the frame plays with the shell's wallet, no Privy of its own");
  });
