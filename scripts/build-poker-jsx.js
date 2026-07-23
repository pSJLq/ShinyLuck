// Precompile the poker JSX to plain JS so the browser never loads Babel
// Standalone (2.9 MB + runtime transpile heap on EVERY poker page). Output is
// `<name>.compiled.js` next to each source; the HTML loads those and drops the
// babel.min.js script. Re-run after editing any poker *.jsx:
//   node scripts/build-poker-jsx.js
//
// Uses @babel/standalone (the exact build the browser used, so output is
// byte-for-byte the same transform) from the scratchpad install, falling back
// to a local one. Same preset as the browser: ["react"].
const fs = require("fs");
const path = require("path");

const POKER = path.join(__dirname, "..", "frontend", "poker");
const FILES = [
  "poker-cards.jsx", "poker-seats.jsx", "poker-chrome.jsx",
  "poker-live-table.jsx", "poker-cashier.jsx", "poker-lobby-app.jsx",
  "poker-tournament-app.jsx",
];

function loadBabel() {
  const candidates = [
    path.join(process.env.BABEL_STANDALONE_DIR || "", "@babel", "standalone"),
    "@babel/standalone",
    path.join("C:", "TEMP", "claude", "D---------------ShinyLuck",
      "63cac2ea-12fc-41b2-a703-164d4ad7c1da", "scratchpad", "babelc", "node_modules", "@babel", "standalone"),
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch (_) {}
  }
  throw new Error("@babel/standalone not found — npm i @babel/standalone in a scratch dir and set BABEL_STANDALONE_DIR");
}

function main() {
  const Babel = loadBabel();
  let total = 0;
  for (const f of FILES) {
    const src = path.join(POKER, f);
    if (!fs.existsSync(src)) { console.warn("skip (missing):", f); continue; }
    const code = fs.readFileSync(src, "utf8");
    const { code: out } = Babel.transform(code, {
      presets: ["react"],
      // no filename-based config; match the browser's zero-config transform
      compact: false,
      retainLines: false,
    });
    const dst = src.replace(/\.jsx$/, ".compiled.js");
    const banner = `/* AUTO-GENERATED from ${f} by scripts/build-poker-jsx.js — do NOT edit. */\n`;
    fs.writeFileSync(dst, banner + out, "utf8");
    total++;
    console.log(`compiled ${f} -> ${path.basename(dst)} (${(out.length / 1024).toFixed(1)} KB)`);
  }
  console.log(`\n${total} files compiled. Update the poker HTML to load *.compiled.js and drop babel.min.js.`);
}

main();
