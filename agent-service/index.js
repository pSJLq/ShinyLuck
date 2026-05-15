// agent-service entrypoint: HTTP API + tick scheduler.

require("dotenv").config();
const relayer = require("./relayer");
const apiMod = require("./api");
const executor = require("./strategies/executor");

const TICK_INTERVAL_MS = parseInt(process.env.TICK_INTERVAL_MS, 10) || 30_000;
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

main().catch((e) => { console.error(e); process.exit(1); });
