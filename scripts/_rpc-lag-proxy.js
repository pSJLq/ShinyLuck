// JSON-RPC lag proxy for the casino load rig.
//
// A local hardhat node answers in ~0ms, which would make the settle bot look
// infinitely fast. Real Somnia answers the VPS in ~65ms (measured: curl from
// 213.108.20.111, p50 0.065s; scripts/_casino-probe.js measures ~130ms from a
// home connection). This proxy sits in front of the node and adds that
// round-trip to every request, so the bot's serial send→wait loop takes the
// same wall-clock time it takes in production.
//
//   node scripts/_rpc-lag-proxy.js            # :8546 -> :8545, 65ms
//   LAG_MS=130 PORT=8546 node scripts/_rpc-lag-proxy.js
const http = require("http");

const PORT = parseInt(process.env.PORT || "8546", 10);
const UPSTREAM_PORT = parseInt(process.env.UPSTREAM_PORT || "8545", 10);
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || "127.0.0.1";
const LAG_MS = parseInt(process.env.LAG_MS || "65", 10);
const JITTER_MS = parseInt(process.env.JITTER_MS || "15", 10);

let served = 0;
const byMethod = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Without pooled keep-alive sockets the proxy runs out of ephemeral ports once
// ~100 simulated players poll it, and ethers surfaces that as "could not
// coalesce error" — a rig artefact that looks exactly like a casino failure.
const agent = new http.Agent({ keepAlive: true, maxSockets: 512, maxFreeSockets: 256 });

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    try {
      const parsed = JSON.parse(body || "{}");
      const calls = Array.isArray(parsed) ? parsed : [parsed];
      for (const c of calls) byMethod.set(c.method, (byMethod.get(c.method) || 0) + 1);
    } catch (_) {}
    served++;
    // half the latency on the way in, half on the way back — matches how a
    // real round trip splits around the node's own processing
    const lag = LAG_MS + Math.random() * JITTER_MS;
    await sleep(lag / 2);
    const up = http.request(
      { agent, host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: "POST", path: "/", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (upRes) => {
        let out = "";
        upRes.on("data", (c) => (out += c));
        upRes.on("end", async () => {
          await sleep(lag / 2);
          res.writeHead(upRes.statusCode || 200, { "content-type": "application/json" });
          res.end(out);
        });
      },
    );
    up.on("error", (e) => { res.writeHead(502); res.end(JSON.stringify({ error: String(e) })); });
    up.end(body);
  });
});

server.keepAliveTimeout = 60000;
server.headersTimeout = 65000;
server.listen(PORT, () => {
  console.log(`[lag-proxy] :${PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT}, +${LAG_MS}ms (+${JITTER_MS}ms jitter) per request`);
});

setInterval(() => {
  const top = [...byMethod.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([m, n]) => `${m}=${n}`).join(" ");
  console.log(`[lag-proxy] served=${served} ${top}`);
}, 30000).unref?.();
