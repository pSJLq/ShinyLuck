// Bundle ethers into frontend/vendor/ethers.bundle.js so the frontend
// doesn't depend on esm.sh (which timed out today for the user). This
// is a one-time build artifact - re-run after bumping ethers in
// package.json:
//   node scripts/build-ethers-vendor.js

const esbuild = require("esbuild");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const ENTRY = path.join(ROOT, "scripts", "_ethers-entry.js");
const OUT = path.join(ROOT, "frontend", "vendor", "ethers.bundle.js");

fs.writeFileSync(ENTRY, 'export * from "ethers";\n');

(async () => {
  const r = await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    format: "esm",
    target: "es2022",
    platform: "browser",
    minify: true,
    sourcemap: false,
    outfile: OUT,
    logLevel: "warning",
  });
  fs.unlinkSync(ENTRY);
  const stats = fs.statSync(OUT);
  console.log(`[build-ethers-vendor] → frontend/vendor/ethers.bundle.js  (${(stats.size / 1024).toFixed(1)} KB)`);
  if (r.warnings.length) console.warn(`${r.warnings.length} esbuild warnings`);
})().catch((e) => { console.error(e); process.exit(1); });
