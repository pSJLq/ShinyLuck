// Somnia JSON-RPC proxy for the ShinyLuck frontend.
//
// WHY: browsers used to call Somnia's public RPC directly. That gateway
// (Google LB) throws waves of 502s every ~15-40 min and silently rejects some
// VPN exit IPs — players saw flickering lobbies and stuck pages. Routed
// through our own origin (shinyluck.win/rpc → this process), a transient
// upstream failure is retried here, invisibly to the player, with failover to
// the secondary gateway. eth_sendRawTransaction is safe to retry: the same
// signed bytes map to the same tx hash (a duplicate submit is a no-op).
//
// Deliberately dependency-free (node http/https only) and NOT in the dealer
// process: the dealer keeps talking to Somnia directly with its own proven
// backoff — this proxy can restart without touching a live hand.
//
// Run: PORT=3003 node scripts/rpc-proxy.js
// pm2:  pm2 start rpc-proxy.js --name rpc-proxy  (lives in /root/poker-web)
"use strict";
const http = require("http");
const https = require("https");

const PORT = Number(process.env.PORT || 3003);
// Order: official gateway → legacy official (same infra, different LB entry) →
// Ankr (independent infra per docs.somnia.network partner list; slower ~0.8s,
// strictly a last resort — it only sees traffic when both Somnia gateways fail).
const UPSTREAMS = (process.env.RPC_UPSTREAMS ||
  "https://api.infra.testnet.somnia.network,https://dream-rpc.somnia.network,https://rpc.ankr.com/somnia_testnet")
  .split(",").map((s) => s.trim()).filter(Boolean);
const ATTEMPTS = 4;                 // total tries across upstreams per request
const ATTEMPT_TIMEOUT_MS = 9000;    // per try
const RETRY_DELAYS_MS = [0, 250, 600, 1200];
const BODY_CAP = 1 << 20;           // 1MB request cap (normal calls are <2KB)
const RESP_CAP = 32 << 20;          // 32MB response cap (getLogs bursts)
const FAIL_SHUN_MS = 10_000;        // a just-failed upstream is deprioritized

const agent = new https.Agent({ keepAlive: true, maxSockets: 64 });
const health = UPSTREAMS.map(() => ({ lastFailAt: 0, fails: 0, served: 0 }));
const stats = { requests: 0, retries: 0, failovers: 0, exhausted: 0, started: Date.now() };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// upstream order for this request: healthy first, then recently-failed ones
function order() {
  const now = Date.now();
  return UPSTREAMS.map((u, i) => i)
    .sort((a, b) => {
      const sa = now - health[a].lastFailAt < FAIL_SHUN_MS ? 1 : 0;
      const sb = now - health[b].lastFailAt < FAIL_SHUN_MS ? 1 : 0;
      return sa - sb || a - b;
    });
}

function tryUpstream(idx, body, clientHeaders) {
  return new Promise((resolve) => {
    const u = new URL(UPSTREAMS[idx]);
    const req = https.request({
      agent, hostname: u.hostname, port: u.port || 443, path: u.pathname === "/" ? "/" : u.pathname,
      method: "POST",
      headers: {
        "content-type": clientHeaders["content-type"] || "application/json",
        "content-length": Buffer.byteLength(body),
        "accept": "application/json",
      },
      timeout: ATTEMPT_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > RESP_CAP) { req.destroy(new Error("resp too large")); return; }
        chunks.push(c);
      });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", (e) => resolve({ err: e }));
    });
    req.on("timeout", () => req.destroy(new Error("upstream timeout")));
    req.on("error", (e) => resolve({ err: e }));
    req.end(body);
  });
}

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (req.method === "GET") {
    // /health for pm2/humans; anything else GET → tiny info
    const up = UPSTREAMS.map((u, i) => ({ url: u, served: health[i].served, fails: health[i].fails }));
    res.writeHead(200, { "content-type": "application/json", ...cors });
    return res.end(JSON.stringify({ ok: true, upSec: Math.round((Date.now() - stats.started) / 1000), ...stats, upstreams: up }));
  }
  if (req.method !== "POST") { res.writeHead(405, cors); return res.end(); }

  // buffer the JSON-RPC request so it can be re-sent on retry
  const chunks = [];
  let size = 0, tooBig = false;
  req.on("data", (c) => { size += c.length; if (size > BODY_CAP) { tooBig = true; req.destroy(); } else chunks.push(c); });
  req.on("close", async () => {
    if (tooBig) { try { res.writeHead(413, cors); res.end(); } catch {} return; }
    if (!req.complete) return; // client gave up mid-upload — nothing to answer
    const body = Buffer.concat(chunks);
    stats.requests++;

    const ord = order();
    let last = null;
    for (let att = 0; att < ATTEMPTS; att++) {
      if (RETRY_DELAYS_MS[att]) await sleep(RETRY_DELAYS_MS[att]);
      const idx = ord[att % ord.length];
      if (att > 0) { stats.retries++; if (idx !== ord[0]) stats.failovers++; }
      const out = await tryUpstream(idx, body, req.headers);
      const bad = out.err || out.status >= 500 || out.status === 429;
      if (!bad) {
        health[idx].served++;
        res.writeHead(out.status, { "content-type": out.headers["content-type"] || "application/json", ...cors });
        return res.end(out.body);
      }
      health[idx].lastFailAt = Date.now();
      health[idx].fails++;
      last = out;
      // one line per failure, no bodies — pm2 log stays readable
      console.error(`[rpc-proxy] attempt ${att + 1}/${ATTEMPTS} upstream ${idx} ${out.err ? out.err.message : "HTTP " + out.status}`);
    }
    stats.exhausted++;
    if (last && !last.err) {
      res.writeHead(last.status, { "content-type": last.headers["content-type"] || "application/json", ...cors });
      return res.end(last.body);
    }
    res.writeHead(502, { "content-type": "application/json", ...cors });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "all RPC upstreams unreachable" } }));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[rpc-proxy] listening on 127.0.0.1:${PORT} → ${UPSTREAMS.join(" | ")}`);
});
