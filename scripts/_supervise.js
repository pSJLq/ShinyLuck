// Production-resilience supervisor for the ShinyLuck backend.
//
// Unlike `npm run dev:play` (concurrently -k --kill-others-on-fail, where ANY
// single process dying drops the WHOLE stack and it STAYS down), this keeps each
// process alive INDEPENDENTLY and auto-restarts any that exit, with capped
// exponential backoff. Combined with the per-process uncaughtException guards,
// the stack self-heals through RPC blips, transient crashes and one-off failures
// - so an event like "reveal-bot hit a network timeout at 3am" no longer leaves
// the casino unable to take bets.
//
//   npm run play        (or: node scripts/_supervise.js)
//
// Ctrl+C / SIGTERM shuts the whole stack down cleanly.

const { spawn } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const NODE = process.execPath;

// Same entry points the dev:play concurrently uses, so behaviour matches.
const PROCS = [
  { name: "FRONTEND", args: ["scripts/_dev-frontend.js"] },
  { name: "REVEAL", args: ["scripts/_dev-reveal-bot.js"] },
  { name: "AGENT", args: ["agent-service/index.js"] },
  { name: "HMCRON", args: ["agent-service/hm-cron.js"] },
];

const MIN_BACKOFF = 1000;   // 1s
const MAX_BACKOFF = 30000;  // 30s
const STABLE_MS = 60000;    // ran >60s ⇒ treat as healthy, reset backoff

let shuttingDown = false;

function start(p) {
  if (shuttingDown) return;
  p.startedAt = Date.now();
  const child = spawn(NODE, p.args, { cwd: ROOT, stdio: "inherit", env: process.env, shell: false });
  p.child = child;
  console.log(`[SUPERVISOR] started ${p.name} (pid=${child.pid})`);

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    const ranMs = Date.now() - p.startedAt;
    if (ranMs > STABLE_MS) p.fails = 0;
    p.fails = (p.fails || 0) + 1;
    const backoff = Math.min(MAX_BACKOFF, MIN_BACKOFF * Math.pow(2, p.fails - 1));
    console.error(`[SUPERVISOR] ${p.name} exited (code=${code} signal=${signal}) after ${Math.round(ranMs / 1000)}s - restarting in ${Math.round(backoff / 1000)}s (fail #${p.fails})`);
    p.timer = setTimeout(() => start(p), backoff);
  });
  child.on("error", (e) => console.error(`[SUPERVISOR] ${p.name} spawn error: ${e.message}`));
}

console.log("[SUPERVISOR] launching ShinyLuck backend (self-healing, auto-restart)...");
PROCS.forEach(start);

function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[SUPERVISOR] ${sig} - stopping all processes`);
  for (const p of PROCS) {
    if (p.timer) clearTimeout(p.timer);
    try { if (p.child) p.child.kill(sig); } catch (_) {}
  }
  setTimeout(() => process.exit(0), 2500);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
// The supervisor itself must never die on an unhandled error.
process.on("uncaughtException", (e) => console.error(`[SUPERVISOR] uncaughtException (continuing): ${e && e.message || e}`));
process.on("unhandledRejection", (e) => console.error(`[SUPERVISOR] unhandledRejection (continuing): ${e && e.message || e}`));
