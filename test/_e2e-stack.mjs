// The local stack the browser tests play on: chain, contracts, dealer bot, web
// server, wallets, tabs. Shared by browser-e2e.mjs (cash) and
// browser-e2e-tournament.mjs (the event shape).
//
// Nothing here asserts anything — it exists so a scenario file can be about
// poker instead of about plumbing.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FRONT = path.join(REPO, "frontend");
export const RPC = "http://127.0.0.1:8545";
export const CHAIN_PORT = 8545, DEALER_PORT = 3010, WEB_PORT = 8099;
// hardhat #0 — deploy-poker-v2's owner/operator on localhost, and the dealer's key
export const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
// hardhat #1. A test must NOT share a key with the running dealer: both would
// sign from the same nonce and one loses every race (the trap the casino
// deployer hit in production).
export const FUNDER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
export const MASTER = "0x" + "11".repeat(32);
export const HEADED = process.env.HEADED === "1";
export const KEEP = process.env.KEEP === "1";

const require_ = createRequire(import.meta.url);
export const { ethers } = require_(path.join(REPO, "node_modules", "ethers"));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadPlaywright() {
  for (const c of [process.env.PLAYWRIGHT_DIR && path.join(process.env.PLAYWRIGHT_DIR, "playwright"), "playwright"].filter(Boolean)) {
    try { return require_(c); } catch (_) {}
  }
  throw new Error("playwright not found — `npm i -D playwright && npx playwright install chromium` (or set PLAYWRIGHT_DIR)");
}

// ---- reporting -------------------------------------------------------------
export const R = { failures: 0 };
export const ok = (m) => console.log("  ✓ " + m);
export const bad = (m) => { console.error("  ✗ " + m); R.failures++; };
export const step = (m) => console.log("\n" + m);

// ---- processes -------------------------------------------------------------
export const procs = [];
export function run(cmd, args, opts = {}) {
  const p = spawn(cmd, args, { cwd: REPO, shell: true, env: { ...process.env, ...(opts.env || {}) }, stdio: ["ignore", "pipe", "pipe"] });
  p.tag = opts.tag || cmd;
  p.lines = [];
  const cap = (b) => { const s = b.toString(); p.lines.push(s); if (opts.echo) process.stdout.write(`[${p.tag}] ${s}`); };
  p.stdout.on("data", cap);
  p.stderr.on("data", cap);
  procs.push(p);
  return p;
}
export function killAll() {
  for (const p of procs) {
    try {
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore", shell: true });
      else process.kill(-p.pid, "SIGKILL");
    } catch (_) {}
  }
}
export function dealerTail(n = 25) {
  const d = procs.find((p) => p.tag === "dealer");
  return d ? d.lines.join("").split("\n").slice(-n).join("\n") : "(no dealer)";
}

export async function waitFor(label, fn, ms = 90_000) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (_) {}
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
    await sleep(400);
  }
}

export const rpc = async (method, params = []) => {
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
};

export const snapshotOf = (t) => fetch(`http://127.0.0.1:${DEALER_PORT}/snapshot?t=${t}`).then((r) => r.json()).catch(() => null);

/// Anything still listening is a previous run that outlived its own cleanup (a
/// killed shell does not always take its child with it on Windows). A half-dead
/// dealer from the last attempt is the most confusing way for this to fail.
export async function freePorts(extraOrigins = 4) {
  const ports = [CHAIN_PORT, DEALER_PORT, ...Array.from({ length: extraOrigins }, (_, i) => WEB_PORT + i)];
  await new Promise((done) => {
    const cmd = process.platform === "win32"
      ? `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${ports.join(",")} -State Listen -ErrorAction SilentlyContinue | Select-Object -Expand OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"`
      : `lsof -ti tcp:${ports.join(",tcp:")} | xargs -r kill -9`;
    const p = spawn(cmd, { shell: true, stdio: "ignore" });
    p.on("exit", done);
    p.on("error", done);
  });
  await sleep(700);
}

// ---- web -------------------------------------------------------------------
// The real frontend, with the config repointed at this local stack and /dealer
// and /rpc proxied so the page talks same-origin exactly as production does.
// One server per player: the dealer rate-limits per client IP and trusts
// x-forwarded-for from localhost, so each tab needs its own origin to be seen
// as its own player.
export function startWeb(man, idx = 0) {
  const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".mjs": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".map": "application/json" };
  const proxy = (req, res, port, url) => {
    const up = http.request({ host: "127.0.0.1", port, path: url, method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${port}`, "x-forwarded-for": `10.0.0.${idx + 1}` } }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on("error", (e) => { res.writeHead(502); res.end(String(e.message)); });
    req.pipe(up);
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname.startsWith("/dealer")) return proxy(req, res, DEALER_PORT, u.pathname.replace(/^\/dealer/, "") + u.search);
    if (u.pathname === "/rpc") return proxy(req, res, CHAIN_PORT, "/");
    // SPA routes, as Caddy serves them in production: /poker is the shell page
    // (index.html) with the poker frame inside it, not a file on disk. Without
    // this, a test can only ever open the frame's own URL and never the thing
    // players actually visit.
    const SPA = ["/poker", "/dice", "/mines", "/plinko", "/crash", "/roulette", "/vault7", "/sugar", "/docs", "/fair", "/zk-lab"];
    const f = path.join(FRONT, u.pathname === "/" || SPA.includes(u.pathname) ? "index.html" : u.pathname.slice(1));
    if (!f.startsWith(FRONT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("nf"); }
    let body = fs.readFileSync(f);
    if (u.pathname === "/poker/poker-config.js") {
      body = Buffer.from(String(body)
        .replace(/network: "somniaTestnet"/, 'network: "localhost"')
        .replace(/pokerRoom: "0x[0-9a-fA-F]*"/, `pokerRoom: "${man.addresses.pokerRoom}"`)
        .replace(/pokerTournament: "0x[0-9a-fA-F]*"/, `pokerTournament: "${man.addresses.pokerTournament}"`)
        .replace(/playerProfile: "0x[0-9a-fA-F]*"/, `playerProfile: "${man.addresses.playerProfile || ""}"`)
        .replace(/avatarStore: "0x[0-9a-fA-F]*"/, 'avatarStore: ""')
        .replace(/zkTableDealer: "0x[0-9a-fA-F]*"/, `zkTableDealer: "${man.addresses.zkTableDealer}"`)
        // ABSOLUTE, not "/rpc": ethers rejects a relative URL outright
        // ("unsupported protocol"), invisible in production where the config
        // carries a full https origin.
        .replace(/rpcUrls: \["http:\/\/127\.0\.0\.1:8545"\]/, `rpcUrls: ["http://127.0.0.1:${WEB_PORT + idx}/rpc"]`));
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
  });
  return new Promise((r) => server.listen(WEB_PORT + idx, () => r(server)));
}

// ---- wallet ----------------------------------------------------------------
// An EIP-1193 wallet for the page. The crypto stays in node (real ethers, real
// key); the page gets a `window.ethereum` that forwards. This is the whole
// reason a browser test is possible: the client still supports injected
// wallets, so no email/OTP stands between the harness and a seat.
export async function injectWallet(page, wallet) {
  await page.exposeFunction("__e2eWallet", async (req) => {
    const { method, params = [] } = req;
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [wallet.address];
    if (method === "eth_chainId") return "0x7a69";
    if (method === "net_version") return "31337";
    if (method === "wallet_requestPermissions") return [{ parentCapability: "eth_accounts" }];
    if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
    if (method === "personal_sign") return wallet.signMessage(ethers.getBytes(params[0]));
    if (method === "eth_sign") return wallet.signMessage(ethers.getBytes(params[1]));
    if (method === "eth_sendTransaction") {
      const t = params[0];
      const sent = await wallet.sendTransaction({
        to: t.to, data: t.data, value: t.value ? BigInt(t.value) : 0n,
        ...(t.gas ? { gasLimit: BigInt(t.gas) } : {}),
      });
      return sent.hash;
    }
    return rpc(method, params);
  });
  await page.addInitScript(() => {
    // Registered before every page script, so this listener beats the app's own.
    // The app must reach its CONNECTED state through its own code path or the
    // test is a spectator test: React decides whether you hold a seat, see hole
    // cards and get an action bar. Production offers only Privy (email + OTP,
    // nothing a test can pass), so the single substitution is which backend the
    // session comes from — `tryRestorePrivy` is the app's own "you were already
    // signed in" path, called on mount.
    window.addEventListener("sp:ready", () => {
      try {
        const sdk = window.SP.sdk, orig = sdk.connect.bind(sdk);
        sdk.connect = () => orig("injected");
        sdk.tryRestorePrivy = async () => orig("injected");
      } catch (e) { console.error("e2e wallet hook:", e.message); }
    }, { once: true });
    window.ethereum = {
      isMetaMask: true,
      request: (args) => window.__e2eWallet({ method: args.method, params: args.params || [] }),
      on: () => {}, removeListener: () => {}, removeAllListeners: () => {},
    };
  });
}

/// `opts.device` opens the same table on a phone profile instead of a desktop
/// viewport — the portrait layout is a different screen and deserves the same
/// hand played through it, not a separate half-working driver.
export async function openTable(browser, wallet, tag, idx, tableId, opts = {}) {
  const ctx = await browser.newContext(opts.device || { viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error(`  [${tag}] page error: ${e.message}`));
  // The zk client reports its own refusals through console.warn, so warnings are
  // not noise here — they are the only place a silent client explains itself.
  page.on("console", (m) => {
    const t = m.text();
    if (/font-size:0|^%c/.test(t) || /privy|turnstile|WebGL|OTS parsing|postMessage|adapters/i.test(t)) return;
    if (["error", "warning"].includes(m.type()) && !/favicon|404/.test(t)) console.error(`  [${tag}] ${m.type()}: ${t.slice(0, 300)}`);
    else if (process.env.VERBOSE === "1") console.log(`  [${tag}] ${t.slice(0, 200)}`);
  });
  page.on("response", (r) => {
    const st = r.status();
    // third-party auth noise: the Privy bundle boots and fails on an origin
    // its allowlist has never heard of. Ours are the ones worth seeing.
    if (st >= 400 && !/privy|turnstile|favicon|cdn-cgi|challenge-platform|cloudflare/i.test(r.url())) console.error(`  [${tag}] HTTP ${st} ${r.url().replace(/^https?:\/\/[^/]+/, "")}`);
  });
  await injectWallet(page, wallet);
  await page.goto(`http://127.0.0.1:${WEB_PORT + idx}/poker/table.html?t=${tableId}&embed=1`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.SP && !!window.SP.sdk && !!window.SP.sdk.address, null, { timeout: 60_000 });
  await page.waitForFunction(() => document.querySelector(".herozone .heroinfo"), null, { timeout: 45_000 }).catch(() => {});
  return { page, ctx, tag, wallet };
}

/// What the player can actually see right now, read off the DOM the same way a
/// human reads the felt.
export async function felt(p) {
  return p.page.evaluate(() => {
    const txt = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
    return {
      hero: document.querySelectorAll(".herozone .hole .card").length,
      heroBacks: document.querySelectorAll(".herozone .hole .card.back").length,
      board: document.querySelectorAll(".board .card").length,
      revealed: document.querySelectorAll(".seatreveal .card").length,
      banner: txt(document.querySelector(".winbanner, .win-banner")),
      // Who the table SAYS won, on its own — separate from the hand name and
      // the amount, because that is the part that must never change once said.
      verdict: txt(document.querySelector(".winbanner .won")),
      // …and who it POINTS at: the crown/green seat. A player should not have
      // to read a sentence to find the winner, so the test does not either.
      crowned: [...document.querySelectorAll(".seat.winner, .heroinfo.winner")]
        .map((e) => (e.className.includes("heroinfo") ? "hero" : (txt(e.querySelector(".nm")) || "?"))),
      // The whole table header: stakes plus, in a tournament, the level, its
      // clock and how many players are left. It used to be a full-width strip
      // of its own; the blinds it printed were the only truthful ones on the
      // screen, because the header's came from a table config that is cached
      // per table and never refreshed after a level-up.
      header: txt(document.querySelector(".tableid")),
      actionbar: [...document.querySelectorAll(".actionbar .abtn")].map((b) => b.textContent.replace(/\s+/g, " ").trim()),
      strip: txt(document.querySelector(".actionbar")),
      pills: [...document.querySelectorAll(".topbar .pill, .topbar .group")].map((e) => e.textContent.replace(/\s+/g, " ").trim()),
      body: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 4000),
    };
  });
}

// ---- bring-up --------------------------------------------------------------
export async function bringUpStack({ origins = 2, verbose = false } = {}) {
  await freePorts(Math.max(origins, 4));

  step("1  local chain");
  run("npx", ["hardhat", "node", "--port", String(CHAIN_PORT)], { tag: "chain" });
  await waitFor("chain", async () => (await rpc("eth_blockNumber")) !== undefined);
  ok(`hardhat node on :${CHAIN_PORT}`);

  step("2  contracts");
  const dep = run("npx", ["hardhat", "run", "scripts/deploy-poker-v2.js", "--network", "localhost"], {
    tag: "deploy", env: { POKER_SEED_MASTER_KEY: MASTER, WRITE_CONFIG: "0", ZK_WORKERS: "2" },
  });
  await new Promise((r) => dep.on("exit", r));
  const manPath = path.join(REPO, "deployments", "poker-localhost.json");
  if (!fs.existsSync(manPath)) { console.error(dep.lines.join("")); throw new Error("deploy produced no manifest"); }
  const man = JSON.parse(fs.readFileSync(manPath, "utf8"));
  ok(`room ${man.addresses.pokerRoom.slice(0, 10)}… · tournament ${man.addresses.pokerTournament.slice(0, 10)}…`);

  step("3  dealer bot");
  run("node", ["scripts/poker-dealer-bot.js"], {
    tag: "dealer",
    env: {
      NETWORK_NAME: "localhost", RPC_URL: RPC, DEALER_KEY: DEPLOYER_KEY, POKER_SEED_MASTER_KEY: MASTER,
      POKER_DEALER_PORT: String(DEALER_PORT), PREDEAL: "1", POLL_MS: "300", ZK_WORKERS: "2",
    },
    echo: verbose,
  });
  const health = await waitFor("dealer", async () => {
    const r = await fetch(`http://127.0.0.1:${DEALER_PORT}/health`).catch(() => null);
    return r && r.ok ? r.json() : null;
  });
  ok(`dealer up · ${health.tables} tables`);

  step("4  web");
  const webs = [];
  for (let i = 0; i < origins; i++) webs.push(await startWeb(man, i));
  ok(`http://127.0.0.1:${WEB_PORT}.. · ${origins} origins (one per player)`);

  return { man, webs };
}

/// Funded player wallets, each with its own nonce counter.
export async function fundPlayers(n, eth = "10") {
  const provider = new ethers.JsonRpcProvider(RPC);
  const funder = new ethers.NonceManager(new ethers.Wallet(FUNDER_KEY, provider));
  const wallets = [];
  for (let i = 1; i <= n; i++) {
    const w = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes("e2e-player-" + i)), provider);
    await (await funder.sendTransaction({ to: w.address, value: ethers.parseEther(eth) })).wait();
    wallets.push(w);
  }
  return { provider, wallets, signers: wallets.map((w) => new ethers.NonceManager(w)) };
}

/// The blind presets the lobby actually ships, read straight out of its source
/// so a test cannot quietly drift from what a host will pick in the form. If
/// the shape of that file changes this throws, which is the right failure: the
/// structures would no longer be the thing under test.
export function shippedStructures() {
  const src = fs.readFileSync(path.join(FRONT, "poker", "poker-lobby-app.jsx"), "utf8");
  const ladder = /const LADDER = \[([\s\S]*?)\n\];/.exec(src);
  const presets = /const STRUCTURES = \{([\s\S]*?)\n\};/.exec(src);
  if (!ladder || !presets) throw new Error("cannot find LADDER/STRUCTURES in poker-lobby-app.jsx");
  const LADDER = JSON.parse("[" + ladder[1].replace(/\/\/.*$/gm, "").trim().replace(/,\s*$/, "") + "]");
  const MK = (mins, fromBB) => {
    const start = LADDER.findIndex(([, bb]) => bb === fromBB);
    if (start < 0) throw new Error(`ladder has no ${fromBB} big blind`);
    return LADDER.slice(start).map(([sb, bb, ante], i) => ({ sb, bb, ante: i < 4 ? 0 : ante, durationSecs: mins * 60 }));
  };
  const out = {};
  for (const m of presets[1].matchAll(/(\w+):\s*\{\s*label:\s*"([^"]+)",\s*stack:\s*(\d+),\s*mins:\s*(\d+),\s*levels:\s*MK\((\d+),\s*(\d+)\)/g)) {
    out[m[1]] = { label: m[2], stack: Number(m[3]), mins: Number(m[4]), levels: MK(Number(m[5]), Number(m[6])) };
  }
  if (!Object.keys(out).length) throw new Error("no presets parsed");
  return out;
}

export const abiOf = (name) =>
  JSON.parse(fs.readFileSync(path.join(REPO, "artifacts", "contracts", "poker", `${name}.sol`, `${name}.json`), "utf8")).abi;

export function finish(label) {
  console.log(R.failures ? `\n${R.failures} FAILED` : `\n${label}`);
  if (!KEEP) { killAll(); process.exit(R.failures ? 1 : 0); }
}
