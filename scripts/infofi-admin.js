// InfoFi list editor - owner-gated HTTP service behind Caddy at /infofi-admin.
//
// The mindshare board is driven by three plain text files that the daily
// collector reads (infofi/projects.txt, voices.txt, tags.txt). Editing them used
// to mean an SSH session; this lets the owner do it from /admin.
//
// AUTH: there is no session and no API key. Every write carries an EIP-191
// personal_sign over a message that names the exact action, and the recovered
// address must be one of the project's on-chain owners - the same three keys
// that open the admin console (casino Vault, PokerRoom, prediction market).
// Owners are READ FROM CHAIN rather than configured here, so rotating an owner
// key does not leave a stale allowlist behind. If none can be read, the service
// fails CLOSED.
//
// Run: PORT=3005 INFOFI_DIR=/root/predictions/infofi node scripts/infofi-admin.js
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const PORT = Number(process.env.PORT || 3005);
const INFOFI_DIR = process.env.INFOFI_DIR || "/root/predictions/infofi";
const RPC = process.env.RPC_TESTNET || "https://api.infra.testnet.somnia.network";
const REPO = path.join(__dirname, "..");

// Only these three, by fixed name. The list name arrives from the client, so it
// must never be able to reach an arbitrary path.
const LISTS = {
  projects: "projects.txt",
  voices: "voices.txt",
  tags: "tags.txt",
};
// X handles: letters, digits, underscore, at most 15. Also what the collector
// uses to decide a handle is safe to use as an avatar filename.
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

const SIG_WINDOW_S = 120;

const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
const OWNER_ABI = ["function owner() view returns (address)"];

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return null; }
}

/// Contract addresses come from the deployment manifests, not from constants
/// duplicated here - a redeploy already rewrites those files.
function ownerContracts() {
  const out = [];
  const at = (m, key) => (m && m.addresses && m.addresses[key]) || null;

  const vault = at(readJson(path.join(REPO, "deployments", "somniaTestnet-v15.json")), "vault");
  if (vault) out.push(["casino", vault]);

  const room = at(readJson(path.join(REPO, "deployments", "poker-somniaTestnet.json")), "pokerRoom");
  if (room) out.push(["poker", room]);

  const market = at(readJson(path.join(process.env.PRED_DIR || "/root/predictions",
    "deployments", "somniaTestnet.json")), "predictionMarket");
  if (market) out.push(["predictions", market]);

  return out;
}

/// Addresses allowed in addition to whatever the chain says. Empty in
/// production; it exists so the service stays usable when a manifest is missing
/// and so the auth path can be tested without a live owner key. Anyone who can
/// set this already has root on the box, so it grants nothing new.
function extraOwners() {
  return (process.env.INFOFI_ADMIN_OWNERS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-f]{40}$/.test(s));
}

let ownerCache = { at: 0, set: new Set(), detail: [] };
async function owners() {
  if (Date.now() - ownerCache.at < 60_000 && ownerCache.set.size) return ownerCache;
  const detail = [];
  const set = new Set();
  await Promise.all(ownerContracts().map(async ([label, addr]) => {
    try {
      const o = (await new ethers.Contract(addr, OWNER_ABI, provider).owner()).toLowerCase();
      set.add(o);
      detail.push({ label, contract: addr, owner: o });
    } catch (e) {
      detail.push({ label, contract: addr, error: e.shortMessage || e.message });
    }
  }));
  const chainOnly = set.size;
  for (const a of extraOwners()) { set.add(a); detail.push({ label: "configured", owner: a }); }
  // Keep the previous good set if the chain is briefly unreachable, rather than
  // locking the owner out of their own console over one RPC blip.
  if (!chainOnly && !extraOwners().length && ownerCache.set.size) return ownerCache;
  ownerCache = { at: Date.now(), set, detail };
  return ownerCache;
}

/// Exactly the string the browser signs. Rebuilt server-side from the parsed
/// fields so a signature for one action cannot be replayed as another.
function signMessage({ action, list, handle, ts }) {
  return [
    "ShinyLuck InfoFi admin",
    `action: ${action}`,
    `list: ${list}`,
    `handle: ${handle}`,
    `ts: ${ts}`,
  ].join("\n");
}

// Signatures are single-use. Bounded by the timestamp window, so the set stays
// tiny; swept on every insert.
const usedSigs = new Map();
function markUsed(sig) {
  const now = Date.now();
  for (const [k, t] of usedSigs) if (now - t > SIG_WINDOW_S * 2000) usedSigs.delete(k);
  if (usedSigs.has(sig)) return false;
  usedSigs.set(sig, now);
  return true;
}

function listPath(list) {
  const f = LISTS[list];
  if (!f) throw new Error("unknown list");
  return path.join(INFOFI_DIR, f);
}

/// Returns { handles, lines }: handles for the UI, raw lines so an edit can
/// preserve the comments the files carry.
function readList(list) {
  let text = "";
  try { text = fs.readFileSync(listPath(list), "utf8"); } catch (_) {}
  const lines = text.split(/\r?\n/);
  const handles = [];
  for (const line of lines) {
    const s = line.trim().replace(/^@/, "");
    if (s && !s.startsWith("#")) handles.push(s);
  }
  return { handles, lines };
}

function writeList(list, lines) {
  const p = listPath(list);
  const body = lines.join("\n").replace(/\n{3,}$/, "\n");
  // Write beside and rename: the collector may be reading this file right now.
  const tmp = p + ".part";
  fs.writeFileSync(tmp, body.endsWith("\n") ? body : body + "\n", "utf8");
  fs.renameSync(tmp, p);
}

function applyEdit(list, action, handle) {
  const { handles, lines } = readList(list);
  const lower = handle.toLowerCase();
  const present = handles.some((h) => h.toLowerCase() === lower);

  if (action === "add") {
    if (present) return { changed: false, reason: "already in the list" };
    const out = lines.slice();
    while (out.length && !out[out.length - 1].trim()) out.pop();
    out.push(handle);
    writeList(list, out);
    return { changed: true };
  }
  if (action === "remove") {
    if (!present) return { changed: false, reason: "not in the list" };
    const out = lines.filter((line) => {
      const s = line.trim().replace(/^@/, "");
      return !(s && !s.startsWith("#") && s.toLowerCase() === lower);
    });
    writeList(list, out);
    return { changed: true };
  }
  throw new Error("unknown action");
}

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(s),
    "cache-control": "no-store",
  });
  res.end(s);
};

async function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");

    if (req.method === "GET" && url.pathname === "/health") {
      const o = await owners();
      return json(res, 200, { ok: true, owners: o.detail, lists: Object.keys(LISTS) });
    }

    // Reading the lists is public: they are already visible on the board and in
    // a public repo. Only writing is gated.
    if (req.method === "GET" && url.pathname === "/lists") {
      const out = {};
      for (const name of Object.keys(LISTS)) out[name] = readList(name).handles;
      return json(res, 200, out);
    }

    if (req.method === "POST" && url.pathname === "/edit") {
      const body = JSON.parse(await readBody(req) || "{}");
      const action = String(body.action || "");
      const list = String(body.list || "");
      const handle = String(body.handle || "").trim().replace(/^@/, "");
      const ts = Number(body.ts);
      const signature = String(body.signature || "");

      if (!LISTS[list]) return json(res, 400, { error: "unknown list" });
      if (action !== "add" && action !== "remove") return json(res, 400, { error: "unknown action" });
      if (!HANDLE.test(handle)) return json(res, 400, { error: "handle must be 1-15 of A-Z a-z 0-9 _" });
      if (!Number.isFinite(ts)) return json(res, 400, { error: "missing ts" });

      const skew = Math.abs(Date.now() / 1000 - ts);
      if (skew > SIG_WINDOW_S) return json(res, 401, { error: `signature is ${Math.round(skew)}s old - check your clock and retry` });
      if (!signature) return json(res, 401, { error: "missing signature" });
      if (!markUsed(signature)) return json(res, 401, { error: "signature already used" });

      let signer;
      try { signer = ethers.verifyMessage(signMessage({ action, list, handle, ts }), signature).toLowerCase(); }
      catch (_) { return json(res, 401, { error: "bad signature" }); }

      const o = await owners();
      if (!o.set.size) return json(res, 503, { error: "cannot read owners from chain - refusing to authorise" });
      if (!o.set.has(signer)) return json(res, 403, { error: "signer is not a project owner", signer });

      const result = applyEdit(list, action, handle);
      console.log(`[infofi-admin] ${signer} ${action} @${handle} ${list} -> ${result.changed ? "ok" : result.reason}`);
      return json(res, 200, { ...result, list, handle, action, lists: { [list]: readList(list).handles } });
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[infofi-admin] listening on 127.0.0.1:${PORT} · lists in ${INFOFI_DIR}`);
  owners().then((o) => console.log("[infofi-admin] owners:", JSON.stringify(o.detail)));
});
