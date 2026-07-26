// Auth tests for scripts/infofi-admin.js. Every negative case must be REJECTED;
// if the service let them through the whole gate would be decorative.
import { ethers } from "ethers";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const REPO = "D:/Рабочий стол/ShinyLuck";
const PORT = 3999;

// Sandbox list dir so the real files are never touched.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "infofi-lists-"));
fs.writeFileSync(path.join(dir, "projects.txt"), "# curated ecosystem accounts\nSomnia_Network\nSomniaEco\n");
fs.writeFileSync(path.join(dir, "voices.txt"), "# curated voices\ndjaikoku\n");
fs.writeFileSync(path.join(dir, "tags.txt"), "Somnia_Network\n");

// A throwaway key stands in for the real owner: EXTRA_OWNER_CONTRACT would need
// a contract, so instead we point the service at a stub that returns it.
const owner = ethers.Wallet.createRandom();
const stranger = ethers.Wallet.createRandom();

// /collect really launches the collector, so point it at a stand-in that just
// sleeps - a test must never start a 20-minute walk of X. Driven through
// INFOFI_SHELL with node as the interpreter so this runs on Windows too, where
// `bash` is not on the spawn PATH.
const fakeDaily = path.join(dir, "fake-daily.js");
fs.writeFileSync(fakeDaily, "setTimeout(() => console.log('fake collection done'), 8000);\n");
fs.writeFileSync(path.join(dir, "snapshot.json"), JSON.stringify({
  generated: new Date(0).toISOString(), window_hours: 168,
  projects: [{ handle: "a", avatar: "/x.jpg" }, { handle: "b", avatar: "" }],
}));

const srv = spawn(process.execPath, [path.join(REPO, "scripts", "infofi-admin.js")], {
  cwd: REPO,
  env: {
    ...process.env, PORT: String(PORT), INFOFI_DIR: dir,
    INFOFI_ADMIN_OWNERS: owner.address,
    INFOFI_DAILY: fakeDaily,
    INFOFI_SHELL: process.execPath,
    // spawn cwd must exist; the default /root/predictions does not, on Windows
    PRED_DIR: dir,
    INFOFI_SNAPSHOT: path.join(dir, "snapshot.json"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
srv.stdout.on("data", (d) => process.env.VERBOSE && console.log("  [srv]", String(d).trim()));
srv.stderr.on("data", (d) => console.log("  [srv-err]", String(d).trim()));

const base = `http://127.0.0.1:${PORT}`;
const wait = async () => {
  for (let i = 0; i < 60; i++) {
    try { await fetch(base + "/health"); return true; } catch (_) { await new Promise((r) => setTimeout(r, 200)); }
  }
  return false;
};
if (!(await wait())) { console.log("server did not start"); srv.kill(); process.exit(1); }

const msg = ({ action, list, handle, ts }) =>
  ["ShinyLuck InfoFi admin", `action: ${action}`, `list: ${list}`, `handle: ${handle}`, `ts: ${ts}`].join("\n");

async function edit(fields, wallet, override = {}) {
  const body = { ...fields, ...override };
  const signature = await wallet.signMessage(msg(fields));
  const r = await fetch(base + "/edit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, signature: override.signature ?? signature }),
  });
  return { status: r.status, body: await r.json() };
}

const now = () => Math.floor(Date.now() / 1000);
let fails = 0;
const check = (ok, label, extra = "") => {
  if (!ok) { fails++; console.log(`FAIL  ${label} ${extra}`); }
  else console.log(`ok    ${label}`);
};

// --- the gate ------------------------------------------------------------
const good = { action: "add", list: "projects", handle: "newproject", ts: now() };

let r = await edit(good, stranger);
check(r.status === 403, "a non-owner signature is rejected", JSON.stringify(r.body));

r = await edit(good, owner, { signature: "0x" + "11".repeat(65) });
check(r.status === 401, "a garbage signature is rejected", JSON.stringify(r.body));

r = await edit({ ...good, ts: now() - 600 }, owner);
check(r.status === 401, "a stale timestamp is rejected", JSON.stringify(r.body));

// signature bound to the ACTION: sign a remove, submit it as an add
const removeFields = { action: "remove", list: "projects", handle: "SomniaEco", ts: now() };
const removeSig = await owner.signMessage(msg(removeFields));
r = await fetch(base + "/edit", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ ...removeFields, action: "add", signature: removeSig }),
});
check(r.status === 401 || r.status === 403, "a signature cannot be reused for a different action", String(r.status));

// path traversal through the list name
r = await edit({ ...good, list: "../../../etc/passwd" }, owner);
check(r.status === 400, "a traversal list name is rejected", JSON.stringify(r.body));

r = await edit({ ...good, handle: "bad handle!" }, owner);
check(r.status === 400, "an invalid handle is rejected", JSON.stringify(r.body));

// --- the happy path ------------------------------------------------------
const addFields = { action: "add", list: "projects", handle: "brandnew", ts: now() };
r = await edit(addFields, owner);
check(r.status === 200 && r.body.changed === true, "the owner can add", JSON.stringify(r.body));
check(fs.readFileSync(path.join(dir, "projects.txt"), "utf8").includes("brandnew"), "the file really changed");
check(fs.readFileSync(path.join(dir, "projects.txt"), "utf8").startsWith("# curated"), "the comment header survived");

// replay of the exact same signature
r = await fetch(base + "/edit", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ ...addFields, signature: await owner.signMessage(msg(addFields)) }),
});
const rb = await r.json();
check(r.status === 401, "a replayed signature is rejected", JSON.stringify(rb));

r = await edit({ action: "remove", list: "projects", handle: "brandnew", ts: now() }, owner);
check(r.status === 200 && r.body.changed === true, "the owner can remove", JSON.stringify(r.body));
check(!fs.readFileSync(path.join(dir, "projects.txt"), "utf8").includes("brandnew"), "removal really happened");
check(fs.readFileSync(path.join(dir, "projects.txt"), "utf8").includes("Somnia_Network"), "other entries survived removal");

const lists = await (await fetch(base + "/lists")).json();
check(Array.isArray(lists.projects) && Array.isArray(lists.voices) && Array.isArray(lists.tags),
  "GET /lists returns all three", JSON.stringify(lists));

// --- manual collection ---------------------------------------------------
const collectMsg = (ts) => msg({ action: "collect", list: "-", handle: "-", ts });
const collect = async (wallet, tsOverride) => {
  const ts = tsOverride ?? now();
  const signature = await wallet.signMessage(collectMsg(ts));
  const r = await fetch(base + "/collect", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ts, signature }),
  });
  return { status: r.status, body: await r.json() };
};

let st = await (await fetch(base + "/status")).json();
check(st.running === false, "status reports idle before any run", JSON.stringify(st.running));
check(st.snapshot && st.snapshot.accounts === 2 && st.snapshot.withAvatar === 1,
  "status summarises the published snapshot", JSON.stringify(st.snapshot));

r = await collect(stranger);
check(r.status === 403, "a non-owner cannot start a collection", JSON.stringify(r.body));

// a collect signature must not be usable as a list edit
const ctsFixed = now();
const collectSig = await owner.signMessage(collectMsg(ctsFixed));
r = await fetch(base + "/edit", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ action: "add", list: "projects", handle: "sneaky", ts: ctsFixed, signature: collectSig }),
});
check(r.status === 401 || r.status === 403, "a collect signature is not accepted as an edit", String(r.status));
check(!fs.readFileSync(path.join(dir, "projects.txt"), "utf8").includes("sneaky"), "and it changed nothing");

r = await collect(owner, ctsFixed + 1);
check(r.status === 202 && r.body.started === true, "the owner can start a collection", JSON.stringify(r.body));

st = await (await fetch(base + "/status")).json();
check(st.running === true, "status reports the run as live", JSON.stringify(st.running));

r = await collect(owner, ctsFixed + 2);
check(r.status === 409, "a second collection is refused while one runs", JSON.stringify(r.body));

srv.kill();
console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL AUTH TESTS PASS");
process.exit(fails ? 1 : 0);
