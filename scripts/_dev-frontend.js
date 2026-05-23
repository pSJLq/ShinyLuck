// Serve the static `frontend/` directory on port 8080 using Node's built-in
// http module - no extra npm package required (`serve`, `http-server`, etc.
// add a dependency we'd rather not carry).
//
// Logs each request so the user can see Privy bundle / module loads in the
// dev:all stream. Stops cleanly on SIGINT.

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const zlib = require("zlib");

const PORT = parseInt(process.env.FRONTEND_PORT || process.env.PORT || "8080", 10);
const ROOT = path.join(__dirname, "..", "frontend");

// In-memory cache for compressed text assets, keyed by file path + encoding.
// We're a dev server, files change rarely between hits; an mtime check
// invalidates the entry. Saves re-gzipping the 4.6MB Privy bundle on every
// page-reload.
const COMPRESS_CACHE = new Map();
const COMPRESSIBLE_EXT = new Set([".js", ".mjs", ".css", ".html", ".json", ".svg", ".txt", ".md", ".map"]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico":  "image/x-icon",
  ".map":  "application/json; charset=utf-8",
  ".txt":  "text/plain; charset=utf-8",
  ".md":   "text/markdown; charset=utf-8",
};

function safeJoin(root, reqPath) {
  // Strip query, decode percent-escapes, resolve absolute, ensure inside root.
  const decoded = decodeURIComponent(reqPath.split("?")[0]);
  const resolved = path.normalize(path.join(root, decoded));
  if (!resolved.startsWith(root)) return null;
  return resolved;
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  let p = parsed.pathname || "/";
  if (p === "/") p = "/SomniaLuck.html";
  // /games/sugar/  →  /games/sugar/index.html
  let filePath = safeJoin(ROOT, p);
  if (!filePath) { res.statusCode = 403; return res.end("forbidden"); }
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
  } catch (_) {
    // file may not exist directly; if SPA-style, try .html suffix
    if (!filePath.endsWith(".html") && !path.extname(filePath)) {
      filePath += ".html";
    }
  }
  fs.stat(filePath, (statErr, stat) => {
    const ts = new Date().toISOString().slice(11, 23);
    if (statErr || !stat) {
      console.log(`[${ts}] 404  ${req.method} ${parsed.pathname}`);
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      return res.end("not found: " + parsed.pathname);
    }
    fs.readFile(filePath, (err, body) => {
      if (err) {
        console.log(`[${ts}] 500  ${req.method} ${parsed.pathname}`);
        res.statusCode = 500;
        return res.end("read error");
      }
      const ext = path.extname(filePath).toLowerCase();
      res.statusCode = 200;
      res.setHeader("content-type", MIME[ext] || "application/octet-stream");
      // FORCE no-store on JS/CSS/HTML - browsers were serving stale
      // animation.js even after the user did Ctrl+Shift+R. `no-cache` only
      // asks the browser to revalidate; `no-store` forbids storage entirely.
      //
      // EXCEPTION: /vendor/ files are pre-built bundles (ethers, privy) that
      // never change at runtime. Forcing no-store on them meant every nav
      // re-downloaded the 372 KB ethers bundle - visible as cursor lag on
      // the first second of every page (the main-thread JSON.parse hit).
      // Cache for 1h so navigation between lobby/account/game pages reuses
      // the parsed module from disk cache without going back to the wire.
      const isVendor = /^\/vendor\//.test(parsed.pathname || "");
      if (isVendor && (ext === ".js" || ext === ".mjs" || ext === ".map")) {
        res.setHeader("cache-control", "public, max-age=3600");
      } else if (ext === ".js" || ext === ".mjs" || ext === ".css" || ext === ".html") {
        res.setHeader("cache-control", "no-store, no-cache, must-revalidate, max-age=0");
        res.setHeader("pragma", "no-cache");
        res.setHeader("expires", "0");
      } else {
        res.setHeader("cache-control", "no-cache");
      }
      // Content-Encoding negotiation. Privy bundle compresses 4.6 MB → ~1.1 MB
      // (gzip) → ~900 KB (brotli). For most files the win is smaller but
      // every JS/CSS module the slot page pulls benefits.
      const acceptEnc = String(req.headers["accept-encoding"] || "").toLowerCase();
      const wantBr = acceptEnc.includes("br");
      const wantGz = acceptEnc.includes("gzip");
      const compressible = COMPRESSIBLE_EXT.has(ext) && body.length > 1024;
      let outBody = body;
      let outEnc = null;
      if (compressible && (wantBr || wantGz)) {
        const enc = wantBr ? "br" : "gzip";
        const cacheKey = `${filePath}::${enc}::${stat.mtimeMs}`;
        const cached = COMPRESS_CACHE.get(cacheKey);
        if (cached) {
          outBody = cached;
          outEnc = enc;
        } else {
          try {
            outBody = enc === "br"
              ? zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })
              : zlib.gzipSync(body, { level: 6 });
            outEnc = enc;
            // Cap memory: drop oldest if cache grows past 50 entries.
            if (COMPRESS_CACHE.size > 50) {
              const firstKey = COMPRESS_CACHE.keys().next().value;
              COMPRESS_CACHE.delete(firstKey);
            }
            COMPRESS_CACHE.set(cacheKey, outBody);
          } catch (_) {
            outBody = body;
            outEnc = null;
          }
        }
      }
      if (outEnc) {
        res.setHeader("content-encoding", outEnc);
        res.setHeader("vary", "accept-encoding");
      }
      const sizeLog = outEnc
        ? `${outBody.length} B / ${body.length} B raw, ${outEnc}`
        : `${body.length} B`;
      console.log(`[${ts}] 200  ${req.method} ${parsed.pathname}  (${sizeLog})`);
      res.end(outBody);
    });
  });
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`[dev-frontend] port ${PORT} already in use - is another dev:all running?`);
    process.exit(1);
  }
  console.error("[dev-frontend] error:", e);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`[dev-frontend] http://localhost:${PORT}/`);
  console.log(`[dev-frontend] serving ${ROOT}`);
});

process.on("SIGINT",  () => { console.log("[dev-frontend] shutting down"); server.close(() => process.exit(0)); });
process.on("SIGTERM", () => { console.log("[dev-frontend] shutting down"); server.close(() => process.exit(0)); });
