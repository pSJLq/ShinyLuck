// Loads frontend/lib/admin.js the way a browser does and actually RUNS its
// DOMContentLoaded path against the real admin.html markup.
//
// Why this exists: `node --check` validates syntax, not name resolution. A
// reference to a helper that was scoped inside another function passed the
// syntax check, threw ReferenceError at runtime inside bindActions(), and took
// the whole console down - bindActions() runs BEFORE refreshAll() and before the
// refresh interval is armed, so the owner gate never ran and every owner saw
// ACCESS DENIED with both addresses blank. Nothing but executing the module
// catches that.
//
//   node test/admin-page.smoke.test.mjs        (from the repo root)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname: the repo lives under a Cyrillic path and the
// raw pathname is percent-encoded.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FRONT = path.join(REPO, "frontend");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-smoke-"));

// Everything admin.js imports is browser-shaped. Stub each specifier with a
// permissive module so the file itself is the only thing under test.
const STUB = `
const ADDR = "0x00000000000000000000000000000000000000aa";
const any = () => new Proxy(function () {}, {
  get: (t, k) => (k === "then" ? undefined : any()),
  apply: () => any(),
  construct: () => any(),
});
// A contract whose every method resolves. owner() has to return a real address
// string or the gate cannot run, and the gate is what this test is about.
const contract = () => new Proxy({}, {
  get: (t, k) => {
    if (k === "connect") return () => contract();
    if (k === "then") return undefined;
    return async (...a) => {
      if (k === "owner") return ADDR;
      if (k === "ownerWithdrawal") return { amount: 0n, readyAt: 0n };
      if (k === "seedPoolStatus") return [0n, 0n];
      if (k === "queryFilter") return [];
      if (k === "curatedMode" || k === "allowedCreators") return false;
      return 0n;
    };
  },
});
export const ethers = new Proxy({}, {
  get: (t, k) => {
    if (k === "Contract") return function () { return contract(); };
    if (k === "isAddress") return () => true;
    if (k === "formatEther") return () => "0";
    if (k === "parseEther") return () => 0n;
    if (k === "verifyMessage") return () => ADDR;
    return any();
  },
});
export const SL = { address: null, signer: null };
export const connect = async () => {};
export const shortAddr = (a) => (a && a.length > 10 ? a.slice(0, 6) + "…" + a.slice(-4) : (a || "-"));
export const CONFIG = { registry: null, casino: "0x0000000000000000000000000000000000000001", historicalCasinos: [] };
export const provider = () => new Proxy({}, { get: () => async () => 0n });
export const fetchLogs = async () => [];
export const fetchRecentLogs = async () => [];
export const fetchDeploymentBlock = async () => 0;
export const POKER_CONFIG = { pokerRoom: null, pokerTournament: null };
export const vaultAddress = () => "0x0000000000000000000000000000000000000001";
export const moduleOf = () => null;
export const toast = () => {};
export default {};
`;
for (const n of ["stub.mjs", "ui.js"]) fs.writeFileSync(path.join(dir, n), STUB);

let src = fs.readFileSync(path.join(FRONT, "lib", "admin.js"), "utf8");
const before = src;
src = src.replace(/from\s+["'][^"']+["']/g, (m) =>
  /["']\.\/ui\.js["']/.test(m) ? 'from "./ui.js"' : 'from "./stub.mjs"');
// import("./ui.js") inside the toast helpers
src = src.replace(/import\((["'])[^"']*ui\.js\1\)/g, 'import("./ui.js")');
if (src === before) { console.log("FAIL  no imports were rewritten - the stub did not take"); process.exit(1); }
fs.writeFileSync(path.join(dir, "admin.js"), src);

// --- DOM built from the REAL admin.html, so every selector admin.js reaches
// --- for is either genuinely present or genuinely absent.
const html = fs.readFileSync(path.join(FRONT, "admin.html"), "utf8");
const attrs = new Set([...html.matchAll(/\bdata-[a-z0-9-]+/gi)].map((m) => m[0].toLowerCase()));

const made = new Map();
function el(sel) {
  if (made.has(sel)) return made.get(sel);
  const node = {
    sel, value: "", textContent: "", innerHTML: "", style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    children: [], appendChild() {}, removeAttribute() {},
    getAttribute: (k) => (k.startsWith("data-") ? sel.replace(/[[\]]/g, "").split("=")[1]?.replace(/"/g, "") ?? "" : null),
    setAttribute() {},
    addEventListener(ev, fn) { (this._h ||= {})[ev] = fn; },
  };
  made.set(sel, node);
  return node;
}
const present = (sel) => {
  const m = /^\[?(data-[a-z0-9-]+)/i.exec(sel);
  return !m || attrs.has(m[1].toLowerCase());
};

globalThis.document = {
  querySelector: (sel) => (present(sel) ? el(sel) : null),
  querySelectorAll: (sel) => (present(sel) ? [el(sel)] : []),
  createElement: () => el("created"),
  addEventListener(ev, fn) { (this._h ||= {})[ev] = fn; },
  body: el("body"),
};
globalThis.window = { innerWidth: 1400, location: { search: "" } };
globalThis.addEventListener = () => {};
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ projects: [], voices: [], tags: [] }) });
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const errors = [];
process.on("unhandledRejection", (e) => errors.push("unhandledRejection: " + (e && e.message ? e.message : e)));

await import(pathToFileURL(path.join(dir, "admin.js")).href);

const fire = document._h && document._h.DOMContentLoaded;
if (!fire) { console.log("FAIL  admin.js never registered a DOMContentLoaded handler"); process.exit(1); }

let threw = null;
try { fire(); } catch (e) { threw = e; }
await new Promise((r) => setTimeout(r, 120));

let fails = 0;
const check = (ok, label, extra = "") => {
  if (!ok) { fails++; console.log(`FAIL  ${label}${extra ? " :: " + extra : ""}`); }
  else console.log(`ok    ${label}`);
};

check(!threw, "DOMContentLoaded runs without throwing", threw && (threw.message + "\n      " + String(threw.stack).split("\n")[1]));
check(!errors.some((e) => /is not defined|is not a function/.test(e)),
  "no ReferenceError/TypeError escaped into a rejection", errors.join(" | "));

// The gate must have been reached - that is the thing the regression skipped.
const ownerField = made.get("[data-sl-adm-owner]");
check(!!ownerField && ownerField.textContent !== "", "the owner gate ran and wrote the owner field",
  ownerField ? `textContent=${JSON.stringify(ownerField.textContent)}` : "field never touched");

console.log(fails ? `\n${fails} FAILURE(S)` : "\nADMIN PAGE SMOKE PASSES");
process.exit(fails ? 1 : 0);
