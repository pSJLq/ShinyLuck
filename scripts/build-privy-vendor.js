// scripts/build-privy-vendor.js
//
// Bundle the React + Privy SDK chain into a single self-contained ESM file
// that the vanilla-JS frontend can load with one <script> tag. Output is
// `frontend/vendor/privy.bundle.js`; the bundle auto-mounts a React root and
// publishes `window.ShinyLuckAuth` (see frontend/lib/privy-entry.jsx).
//
// Run:   node scripts/build-privy-vendor.js
//
// Rebuild whenever you change privy-entry.jsx OR upgrade @privy-io/react-auth.

const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const outDir = path.join(ROOT, 'frontend', 'vendor');
fs.mkdirSync(outDir, { recursive: true });

(async () => {
  const entry = path.join(ROOT, 'frontend', 'lib', 'privy-entry.jsx');
  const outfile = path.join(outDir, 'privy.bundle.js');

  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',           // immediately-invoked — runs on <script> load
    target: 'es2022',
    platform: 'browser',
    jsx: 'automatic',
    jsxImportSource: 'react',
    loader: { '.js': 'jsx', '.jsx': 'jsx' },
    minify: true,
    sourcemap: 'linked',
    outfile,
    legalComments: 'none',
    define: {
      'process.env.NODE_ENV': '"production"',
      'global': 'window',
    },
    logLevel: 'warning',
    metafile: false,
  });

  const stats = fs.statSync(outfile);
  console.log(`[build-privy-vendor] → frontend/vendor/privy.bundle.js  (${(stats.size / 1024).toFixed(1)} KB)`);
  if (result.warnings.length) {
    console.warn(`[build-privy-vendor] ${result.warnings.length} esbuild warnings (above)`);
  }
})().catch((e) => {
  console.error('[build-privy-vendor] FAILED:', e.message || e);
  if (e.errors) for (const err of e.errors) console.error('  ', err.text || err);
  process.exit(1);
});
