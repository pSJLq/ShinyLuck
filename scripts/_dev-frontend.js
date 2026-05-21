// Serve the static `frontend/` directory on port 8080 using Node's built-in
// http module — no extra npm package required (`serve`, `http-server`, etc.
// add a dependency we'd rather not carry).
//
// Logs each request so the user can see Privy bundle / module loads in the
// dev:all stream. Stops cleanly on SIGINT.

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const PORT = parseInt(process.env.FRONTEND_PORT || "8080", 10);
const ROOT = path.join(__dirname, "..", "frontend");

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
  fs.readFile(filePath, (err, body) => {
    const ts = new Date().toISOString().slice(11, 23);
    if (err) {
      console.log(`[${ts}] 404  ${req.method} ${parsed.pathname}`);
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      return res.end("not found: " + parsed.pathname);
    }
    const ext = path.extname(filePath).toLowerCase();
    res.statusCode = 200;
    res.setHeader("content-type", MIME[ext] || "application/octet-stream");
    // FORCE no-store on JS/CSS/HTML — browsers were serving stale
    // animation.js even after the user did Ctrl+Shift+R. `no-cache` only
    // asks the browser to revalidate; `no-store` forbids storage entirely.
    if (ext === ".js" || ext === ".mjs" || ext === ".css" || ext === ".html") {
      res.setHeader("cache-control", "no-store, no-cache, must-revalidate, max-age=0");
      res.setHeader("pragma", "no-cache");
      res.setHeader("expires", "0");
    } else {
      res.setHeader("cache-control", "no-cache");
    }
    console.log(`[${ts}] 200  ${req.method} ${parsed.pathname}  (${body.length} B)`);
    res.end(body);
  });
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`[dev-frontend] port ${PORT} already in use — is another dev:all running?`);
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
