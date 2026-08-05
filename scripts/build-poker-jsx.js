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

// Babel is not a dependency of this repo (its tree has an unrelated peer
// conflict that makes `npm i -D` noisy), so it is looked up rather than
// installed. It used to be hardcoded to one session's scratch directory, which
// then got reaped — leaving a build that could not run at all. Env var first,
// repo node_modules next, and a scratch install anywhere under the temp root
// last, found by looking instead of by remembering a path.
function loadBabel() {
  const candidates = [];
  if (process.env.BABEL_STANDALONE_DIR) candidates.push(path.join(process.env.BABEL_STANDALONE_DIR, "@babel", "standalone"));
  candidates.push("@babel/standalone");
  const tmpRoot = path.join("C:", "TEMP", "claude", "D---------------ShinyLuck");
  try {
    for (const d of fs.readdirSync(tmpRoot)) {
      const p = path.join(tmpRoot, d, "scratchpad", "babelc", "node_modules", "@babel", "standalone");
      if (fs.existsSync(path.join(p, "package.json"))) candidates.push(p);
    }
  } catch (_) {}
  for (const c of candidates) {
    try { return require(c); } catch (_) {}
  }
  throw new Error(
    "@babel/standalone not found. Install it anywhere and point at it:\n" +
    "  mkdir babelc && cd babelc && npm init -y && npm i @babel/standalone\n" +
    "  BABEL_STANDALONE_DIR=<babelc>/node_modules node scripts/build-poker-jsx.js");
}

function main() {
  const Babel = loadBabel();
  let total = 0;
  for (const f of FILES) {
    const src = path.join(POKER, f);
    if (!fs.existsSync(src)) { console.warn("skip (missing):", f); continue; }
    const code = fs.readFileSync(src, "utf8");
    const { code: out } = Babel.transform(code, {
      // CLASSIC runtime, stated rather than inherited. These files are loaded
      // as plain <script> tags and hang their components off `window`; the
      // automatic runtime emits `import { jsx } from "react/jsx-runtime"` at
      // the top, which is a syntax error in a classic script and takes the
      // whole page down with nothing rendered. Babel 8 flipped that default,
      // so a build that only said "react" silently changed meaning between
      // installs — pin it.
      presets: [["react", { runtime: "classic" }]],
      compact: false,
      retainLines: false,
    });
    if (/^\s*(import|export)\s/m.test(out)) {
      throw new Error(`${f} compiled to a module (import/export at top level) — the poker pages load these as classic scripts and would render nothing`);
    }
    const dst = src.replace(/\.jsx$/, ".compiled.js");
    const banner = `/* AUTO-GENERATED from ${f} by scripts/build-poker-jsx.js — do NOT edit. */\n`;
    fs.writeFileSync(dst, banner + out, "utf8");
    total++;
    console.log(`compiled ${f} -> ${path.basename(dst)} (${(out.length / 1024).toFixed(1)} KB)`);
  }
  console.log(`\n${total} files compiled. Update the poker HTML to load *.compiled.js and drop babel.min.js.`);
}

main();
