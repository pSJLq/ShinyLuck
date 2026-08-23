// pm2 apps for the ShinyLuck box. Deployed to /root/ecosystem.config.js.
//
//   pm2 start /root/ecosystem.config.js
//   pm2 save                       # survive reboot (pm2 startup done by bootstrap.sh)
//
// Ports 3002/3003 bind loopback only and are reached through Caddy.
module.exports = {
  apps: [
    {
      // Caddy runs as root under pm2 because the site root lives in /root
      // (mode 700), which the packaged `caddy` user cannot read. The systemd
      // unit is disabled by bootstrap.sh so the two never fight over :443.
      name: "poker-web",
      cwd: "/root/poker-web",
      script: "/root/poker-web/caddy",
      args: "run --config /root/poker-web/Caddyfile",
      interpreter: "none",
      autorestart: true,
      max_restarts: 20,
    },
    {
      // Poker dealer: main loop, /dealer HTTP API, snapshot cache, zkShuffle
      // coordination. POLL_MS=500 is the event-tuned value from 2026-07-23.
      name: "poker",
      cwd: "/root/shinyluck",
      script: "scripts/poker-dealer-bot.js",
      autorestart: true,
      max_memory_restart: "700M",
      env: { POKER_DEALER_PORT: "3002", POLL_MS: "500" },
    },
    {
      // Chain proxy for players' browsers: retries and fails over between
      // Somnia upstreams so their periodic 502 waves stay invisible.
      name: "rpc-proxy",
      cwd: "/root/shinyluck",
      script: "scripts/rpc-proxy.js",
      autorestart: true,
      env: { PORT: "3003" },
    },
    {
      // Owner-signed editor for the InfoFi account lists, behind /infofi-admin.
      // Writes into the predictions tree, so it needs that path; the owner set
      // is read from chain, never configured.
      name: "infofi-admin",
      cwd: "/root/shinyluck",
      script: "scripts/infofi-admin.js",
      autorestart: true,
      env: { PORT: "3005", INFOFI_DIR: "/root/predictions/infofi", PRED_DIR: "/root/predictions" },
    },
    {
      // Casino v15 settlement: one cashier wallet (own nonce lane) per game,
      // plus gas auto-refuel and seed-pool top-up (both need V15_OWNER_KEY).
      name: "casino-reveal-v15",
      cwd: "/root/casino-bot",
      script: "scripts/reveal-bot-v15.js",
      autorestart: true,
      max_memory_restart: "500M",
    },
    {
      // Predictions keeper: fires agent resolves, voids expired markets.
      name: "pred-keeper",
      cwd: "/root/predictions",
      script: "scripts/keeper.js",
      autorestart: true,
    },
    {
      // Predictions X-oracle: measures the X metric for open markets and
      // publishes a public JSON. Runs from its own venv (twscrape/curl_cffi).
      name: "pred-oracle",
      cwd: "/root/predictions",
      script: "oracle/xoracle.py",
      interpreter: "/root/predictions/oracle/.venv/bin/python",
      interpreter_args: "-u",
      autorestart: true,
    },
  ],
};
