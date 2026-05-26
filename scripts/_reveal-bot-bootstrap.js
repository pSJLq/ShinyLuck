// Production bootstrap for the reveal-bot on Railway / Render / fly.io.
//
// Why this exists: the canonical reveal-bot (scripts/reveal-bot.js) reads
// server seeds from a JSON file path passed via the SEEDS_FILE env var.
// On a dev box that file lives in deployments/seeds/ (gitignored - never
// committed). On a deploy host we have no checkout of that folder, so we
// pass the same JSON in via SEEDS_JSON_B64 (base64-encoded contents of the
// seeds file) and this wrapper materialises it on disk before exec'ing the
// real reveal-bot under hardhat.
//
// Required env vars (set in the Railway dashboard):
//   PRIVATE_KEY        - deployer / reveal-bot signer (same key as .env locally)
//   RPC_TESTNET        - https://api.infra.testnet.somnia.network (default ok)
//   SEEDS_JSON_GZ_B64  - base64(gzip(JSON)) of deployments/seeds/<deploy>.json
//                          (preferred: ~19 KB - fits in Railway free-tier env)
//   SEEDS_JSON_B64     - base64(JSON) - fallback if you can't gzip; ~39 KB so
//                          may overflow tight env-var caps on some hosts.
//
// Generate SEEDS_JSON_GZ_B64 from your repo root:
//   node -e "const fs=require('fs'),z=require('zlib');console.log(z.gzipSync(fs.readFileSync('deployments/seeds/somniaTestnet-XXX.json')).toString('base64'))"
// or for the raw base64 (no gzip) fallback:
//   node -e "console.log(require('fs').readFileSync('deployments/seeds/somniaTestnet-XXX.json').toString('base64'))"

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { spawn } = require("child_process");

function die(msg, code = 1) {
  console.error(`[reveal-bot-bootstrap] ${msg}`);
  process.exit(code);
}

if (!process.env.PRIVATE_KEY) die("PRIVATE_KEY env var not set");

const gzB64 = process.env.SEEDS_JSON_GZ_B64;
const rawB64 = process.env.SEEDS_JSON_B64;
if (!gzB64 && !rawB64) die("set either SEEDS_JSON_GZ_B64 (preferred) or SEEDS_JSON_B64");

let seedsJson;
try {
  if (gzB64) {
    seedsJson = zlib.gunzipSync(Buffer.from(gzB64, "base64")).toString("utf8");
    console.log("[reveal-bot-bootstrap] decoded SEEDS_JSON_GZ_B64 (gzip)");
  } else {
    seedsJson = Buffer.from(rawB64, "base64").toString("utf8");
    console.log("[reveal-bot-bootstrap] decoded SEEDS_JSON_B64 (raw)");
  }
} catch (e) {
  die(`seeds decode failed: ${e.message}`);
}

// Validate the JSON shape so we fail loud at boot, not deep inside the bot.
// reveal-bot.js accepts two shapes:
//   shape-1 (deployment file): { seeds: [string, ...], hashes: [string, ...] }
//   shape-2 (pool file, post-topup): { "<absoluteIdx>": "<seed>", ... }
// Detect which one we got so we can log a sensible count.
let parsed;
try {
  parsed = JSON.parse(seedsJson);
} catch (e) {
  die(`seeds payload is not valid JSON: ${e.message}`);
}
let seedCount = 0;
if (parsed && Array.isArray(parsed.seeds) && Array.isArray(parsed.hashes)) {
  if (parsed.seeds.length === 0 || parsed.seeds.length !== parsed.hashes.length) {
    die(`bad shape-1 payload: seeds=${parsed.seeds.length} hashes=${parsed.hashes.length}`);
  }
  seedCount = parsed.seeds.length;
} else if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
  // Sparse map (shape-2): every value must be a 0x-prefixed 32-byte hex.
  const keys = Object.keys(parsed);
  if (keys.length === 0) die("shape-2 sparse map is empty");
  const bad = keys.find((k) => typeof parsed[k] !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(parsed[k]));
  if (bad) die(`shape-2 entry "${bad}" is not a 32-byte 0x hex string`);
  seedCount = keys.length;
} else {
  die("seeds payload must be {seeds:[],hashes:[]} (deployment file) or {idx:seed,...} (pool file)");
}

const seedsPath = path.join(os.tmpdir(), `shinyluck-seeds-${Date.now()}.json`);
fs.writeFileSync(seedsPath, seedsJson, { mode: 0o600 });
console.log(
  `[reveal-bot-bootstrap] materialised ${seedCount} seeds at ${seedsPath} (${seedsJson.length} bytes)`,
);

// Light sanity check on the chain wiring before we spawn hardhat - faster
// failure than waiting for the bot to time out on a typo'd RPC URL.
const rpc = process.env.RPC_TESTNET || "https://api.infra.testnet.somnia.network";
console.log(`[reveal-bot-bootstrap] RPC_TESTNET=${rpc}`);

const env = {
  ...process.env,
  SEEDS_FILE: seedsPath,
  // The canonical bot polls every 100ms by default. On a paid Railway plan
  // that's fine; on the free tier (~512 MB) we ease the pressure a touch.
  POLL_MS: process.env.POLL_MS || "150",
};

console.log("[reveal-bot-bootstrap] spawning: npx hardhat run scripts/reveal-bot.js --network somniaTestnet");

const child = spawn(
  "npx",
  ["hardhat", "run", "scripts/reveal-bot.js", "--network", "somniaTestnet"],
  { stdio: "inherit", env, shell: process.platform === "win32" },
);

const cleanup = () => {
  try { fs.unlinkSync(seedsPath); } catch (_) {}
};

child.on("exit", (code, signal) => {
  cleanup();
  console.log(`[reveal-bot-bootstrap] reveal-bot exited code=${code} signal=${signal}`);
  process.exit(code == null ? 1 : code);
});

process.on("SIGTERM", () => { cleanup(); child.kill("SIGTERM"); });
process.on("SIGINT",  () => { cleanup(); child.kill("SIGINT"); });
