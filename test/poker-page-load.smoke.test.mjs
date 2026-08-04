// Loads every poker page's classic scripts the way a browser does — in the
// page's own order, in one shared global scope — and runs them.
//
// Why this exists: the table, lobby and tournament pages used to pull React,
// ReactDOM and Babel Standalone from unpkg.com and transpile ~140 KB of JSX in
// the browser on every load. Players whose network could not reach unpkg saw
// the background and nothing else, with no error anywhere. The pages now serve
// vendored React and precompiled JSX, which moves the risk: a stale or missing
// .compiled.js, a name that two files both declare at top level, or a file
// loaded before the one it needs is now a blank page for EVERYONE. `node --check`
// sees none of that — only executing the files in order does.
//
//   node test/poker-page-load.smoke.test.mjs        (from the repo root)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POKER = path.join(REPO, "frontend", "poker");
const FRONT = path.join(REPO, "frontend");
const PAGES = ["table.html", "lobby.html", "tournament.html"];

let failures = 0;
const fail = (msg) => { console.error("  ✗ " + msg); failures++; };
const ok = (msg) => console.log("  ✓ " + msg);

// Anything the page code touches that a browser would provide. Permissive on
// purpose: the files themselves are what is under test, not our stub fidelity.
function makeContext() {
  const any = () => new Proxy(function () {}, {
    get: (t, k) => (k === "then" || k === Symbol.toPrimitive || k === Symbol.iterator ? undefined : any()),
    apply: () => any(),
    construct: () => any(),
  });
  const el = () => ({
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    dataset: {}, children: [], appendChild() {}, removeChild() {}, remove() {},
    setAttribute() {}, getAttribute: () => null, addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [], getBoundingClientRect: () => ({ x: 0, y: 0, width: 800, height: 600, top: 0, left: 0 }),
    focus() {}, blur() {}, click() {}, insertAdjacentHTML() {}, contains: () => false,
    get innerHTML() { return ""; }, set innerHTML(_v) {}, get textContent() { return ""; }, set textContent(_v) {},
  });
  const store = { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
  const doc = {
    ...el(),
    documentElement: el(), body: el(), head: el(),
    getElementById: () => el(), createElement: () => el(), createElementNS: () => el(),
    createTextNode: () => el(), querySelector: () => el(), querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {}, hidden: false, visibilityState: "visible",
    readyState: "complete", cookie: "", fonts: { ready: Promise.resolve() },
  };
  const React = {
    createElement: () => ({}), Fragment: "fragment", memo: (f) => f, forwardRef: (f) => f,
    useState: (v) => [typeof v === "function" ? v() : v, () => {}],
    useEffect() {}, useLayoutEffect() {}, useMemo: (f) => f(), useCallback: (f) => f,
    useRef: (v) => ({ current: v }), useContext: () => ({}), createContext: () => ({}),
    useReducer: (_r, v) => [v, () => {}],
  };
  const ctx = {
    React, ReactDOM: { createRoot: () => ({ render() {}, unmount() {} }), render() {} },
    document: doc, localStorage: store, sessionStorage: store,
    location: { href: "https://shinyluck.win/poker/table.html?t=0", search: "?t=0", pathname: "/poker/table.html", hash: "", origin: "https://shinyluck.win", protocol: "https:", host: "shinyluck.win", reload() {}, assign() {}, replace() {} },
    navigator: { userAgent: "node-smoke", language: "en", clipboard: { writeText: async () => {} }, maxTouchPoints: 0 },
    history: { pushState() {}, replaceState() {}, back() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" }),
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    Audio: function () { return any(); }, Worker: function () { return any(); },
    Blob: function () { return {}; }, URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    URLSearchParams, CustomEvent: function () { return {}; }, Event: function () { return {}; },
    IntersectionObserver: function () { return { observe() {}, disconnect() {}, unobserve() {} }; },
    ResizeObserver: function () { return { observe() {}, disconnect() {}, unobserve() {} }; },
    MutationObserver: function () { return { observe() {}, disconnect() {} }; },
    console, JSON, Math, Date, Promise, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, WeakMap, Symbol, BigInt, Intl, TextEncoder, TextDecoder,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1, scrollTo() {}, getComputedStyle: () => ({ getPropertyValue: () => "" }),
    parent: { postMessage() {} }, top: null, screen: { width: 1280, height: 800 },
    alert() {}, confirm: () => true, prompt: () => null, crypto: { getRandomValues: (a) => a, randomUUID: () => "x" },
    // Deliberately absent: SP / window.SP. Every app defers its boot() to the
    // "sp:ready" event, so leaving it unset keeps this a LOAD test — exactly the
    // part that decides between a table and a blank background.
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.self = ctx;
  return vm.createContext(ctx);
}

// Every external <script>, in document order, tagged the way the browser will
// treat it. Order is the whole point of this test: plain classic scripts run
// while the document parses, and DEFERRED classic scripts run afterwards
// interleaved with module scripts in document order. poker-bridge.js is a
// module that publishes window.SP, and the table's compiled bundle reads SP at
// top level — get that order wrong and every player gets a blank page.
function scriptTags(html) {
  const out = [];
  const re = /<script\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
    if (!src) continue;
    const type = /\btype\s*=\s*["']([^"']+)["']/i.exec(attrs);
    const isModule = !!(type && /module/i.test(type[1]));
    out.push({
      src: src[1], type: type ? type[1] : "", isModule,
      deferred: isModule || /\bdefer\b/i.test(attrs),
    });
  }
  return out;
}
const classicScripts = (html) => scriptTags(html).filter((s) => !s.isModule);
// Third-party bundles need a real browser, not a stub. Their presence is
// checked; running them proves nothing about our code.
const isVendor = (src) => /^\/vendor\//.test(src);

const resolve = (src) => (src.startsWith("/") ? path.join(FRONT, src.slice(1)) : path.join(POKER, src));

for (const page of PAGES) {
  console.log(`\n${page}`);
  const html = fs.readFileSync(path.join(POKER, page), "utf8");

  // 1. No page may depend on a third-party host for its code.
  const ext = [...html.matchAll(/\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1]);
  if (ext.length) fail(`loads code from another host: ${ext.join(", ")}`);
  else ok("no third-party script hosts");

  // 2. No JSX left to transpile in the browser.
  const babel = classicScripts(html).filter((s) => /babel/i.test(s.type) || /\.jsx$/.test(s.src));
  if (babel.length) fail(`still ships raw JSX: ${babel.map((s) => s.src).join(", ")}`);
  else ok("no in-browser JSX transpile");

  // 3. Every referenced file exists.
  const scripts = classicScripts(html);
  let missing = 0;
  for (const s of scripts) {
    if (/^https?:/i.test(s.src)) continue;
    if (!fs.existsSync(resolve(s.src))) { fail(`missing file: ${s.src}`); missing++; }
  }
  if (!missing) ok(`${scripts.length} classic scripts all present`);

  // 4. Compiled artifacts must not be older than the .jsx they came from.
  for (const s of scripts) {
    if (!/\.compiled\.js$/.test(s.src)) continue;
    const c = resolve(s.src);
    const j = c.replace(/\.compiled\.js$/, ".jsx");
    if (!fs.existsSync(j)) continue;
    if (fs.statSync(c).mtimeMs < fs.statSync(j).mtimeMs) {
      fail(`${path.basename(c)} is older than its source — run: node scripts/build-poker-jsx.js`);
    }
  }

  // 5. Run them in the browser's real order and in ONE shared scope: parse-time
  //    scripts first, then the deferred ones and the modules in document order.
  const ctx = makeContext();
  const all = scriptTags(html);
  const phase = [...all.filter((s) => !s.deferred), ...all.filter((s) => s.deferred)];
  let ran = 0, want = 0, threw = false;
  for (const s of phase) {
    if (/^https?:/i.test(s.src) || isVendor(s.src)) continue;
    const file = resolve(s.src);
    if (!fs.existsSync(file)) continue;
    if (s.isModule) {
      // Stand in for poker-bridge.js: an ES module with real imports cannot run
      // here, but WHERE it runs is exactly what we are checking. Everything
      // after this point may rely on window.SP; everything before it may not.
      if (/poker-bridge/.test(s.src)) {
        const sp = new Proxy({ sdk: {}, ACTION: {}, STREET: {}, NETWORK: { currency: { symbol: "STT" } } }, {
          get: (t, k) => (k in t ? t[k] : new Proxy(function () {}, { get: () => () => {}, apply: () => ({}) })),
        });
        vm.runInContext("window.SP = arguments0;", Object.assign(ctx, { arguments0: sp }), { filename: "poker-bridge.js (stub)" });
      }
      continue;
    }
    want++;
    try {
      vm.runInContext(fs.readFileSync(file, "utf8"), ctx, { filename: s.src, timeout: 20000 });
      ran++;
    } catch (e) {
      fail(`${s.src} threw on load: ${e.message}`);
      threw = true;
    }
  }
  if (!threw && ran === want) ok(`all ${ran} own scripts executed in browser order without throwing`);

  // 6. The app the page exists for must have reached its boot guard.
  const wants = page === "table.html" ? "LiveTable" : page === "lobby.html" ? "LobbyApp" : "TournamentPage";
  if (typeof ctx[wants] === "function") ok(`${wants} defined`);
  else fail(`${wants} never got defined — the page would render nothing`);
}

console.log(failures ? `\n${failures} FAILED` : "\nall poker pages load");
process.exit(failures ? 1 : 0);
