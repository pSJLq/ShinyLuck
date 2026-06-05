// agent-service entrypoint: HTTP API + tick scheduler.

// Look for .env next to THIS script, not in cwd - dev:play runs us from
// the repo root, where there's a different .env that doesn't have our keys.
require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const relayer = require("./relayer");
const apiMod = require("./api");
const executor = require("./strategies/executor");

// Base scheduler resolution. Each player's OWN cadence (strategy.cadenceSec) is
// enforced inside executor.tick(); this only needs to be fine enough to honour
// the smallest cadence a user might pick (so 5s, not 30s).
const TICK_INTERVAL_MS = parseInt(process.env.TICK_INTERVAL_MS, 10) || 5_000;
const PORT = parseInt(process.env.PORT, 10) || 3001;

async function main() {
  const ctx = relayer.init();
  console.log("[agent-service] relayer:", await ctx.wallet.getAddress());
  const balance = await ctx.provider.getBalance(await ctx.wallet.getAddress());
  console.log("[agent-service] relayer balance:", balance.toString());

  const app = apiMod.build(ctx);
  app.listen(PORT, () => console.log(`[agent-service] listening on :${PORT}`));

  // tick loop
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await executor.tick(ctx);
    } catch (e) {
      console.error("[agent-service] tick error:", e.shortMessage || e.message);
    } finally {
      busy = false;
    }
  }, TICK_INTERVAL_MS);
}

// Survive transient RPC/socket errors instead of exiting (the supervisor would
// restart us, but staying up avoids churn and dropped HTTP requests).
process.on("unhandledRejection", (e) => console.warn(`[agent-service] unhandledRejection (continuing): ${(e && (e.shortMessage || e.message)) || e}`));
process.on("uncaughtException", (e) => console.warn(`[agent-service] uncaughtException (continuing): ${(e && (e.shortMessage || e.message)) || e}`));

main().catch((e) => { console.error(e); process.exit(1); });
