// Pick the most recently-written seeds file for the current network and
// exec reveal-bot. Used by `npm run dev:reveal-bot` so the user doesn't have
// to manually update SEEDS_FILE after every redeploy.
//
//   node scripts/_dev-reveal-bot.js

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const NET = process.env.HH_NETWORK || "somniaTestnet";
const seedsDir = path.join(__dirname, "..", "deployments", "seeds");

if (!fs.existsSync(seedsDir)) {
  console.error(`[dev-reveal-bot] no seeds dir at ${seedsDir}; deploy first`);
  process.exit(1);
}

const candidates = fs.readdirSync(seedsDir)
  .filter((f) => f.startsWith(`${NET}-`) && f.endsWith(".json"))
  .map((f) => ({ name: f, mtime: fs.statSync(path.join(seedsDir, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

if (candidates.length === 0) {
  console.error(`[dev-reveal-bot] no seeds files for network ${NET}`);
  process.exit(1);
}

const seedsFile = path.join(seedsDir, candidates[0].name);
const poolFile = path.join(seedsDir, `${NET}-pool.json`);
console.log(`[dev-reveal-bot] using seeds: ${candidates[0].name}`);
console.log(`[dev-reveal-bot] watching pool: ${path.basename(poolFile)}`);

const env = {
  ...process.env,
  SEEDS_FILE: seedsFile,
  SEED_POOL_FILE: poolFile,
};

// Use async spawn so the wrapper stays alive as long as the child runs.
// Windows: cmd /c "npx hardhat run ..." to avoid PATH issues with .cmd files
// inside a piped concurrently parent.
const isWin = process.platform === "win32";
const cmd = isWin ? "cmd.exe" : "npx";
const args = isWin
  ? ["/c", "npx hardhat run scripts/reveal-bot.js --network " + NET]
  : ["hardhat", "run", "scripts/reveal-bot.js", "--network", NET];

const child = spawn(cmd, args, {
  stdio: "inherit",
  env,
  cwd: path.join(__dirname, ".."),
  shell: false,
});

child.on("error", (e) => {
  console.error("[dev-reveal-bot] spawn error:", e.message);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  console.log(`[dev-reveal-bot] hardhat exited code=${code} signal=${signal}`);
  process.exit(code == null ? 1 : code);
});

// Forward SIGINT / SIGTERM to the child so Ctrl+C in concurrently works.
const forward = (sig) => () => { try { child.kill(sig); } catch (_) {} };
process.on("SIGINT",  forward("SIGINT"));
process.on("SIGTERM", forward("SIGTERM"));
