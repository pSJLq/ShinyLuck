// Validate the EXACT pipelined-dispatch logic from poker-dealer-bot.js against
// real Somnia: fire a burst of independent txns concurrently through run() and
// confirm (a) all succeed, (b) nonces are contiguous — no gap, no collision,
// (c) the burst completes in ~one confirmation wave, not K×1.5s.
// Run: node scripts/_validate-pipeline.js
require("dotenv").config();
const { ethers } = require("ethers");

async function main() {
  const p = new ethers.JsonRpcProvider(process.env.RPC_TESTNET);
  p.pollingInterval = 60;
  const w = new ethers.Wallet(process.env.POKER_DEPLOYER_KEY, p);

  // ---- verbatim from poker-dealer-bot.js worker setup ----
  let nextNonce = null, syncing = null;
  const rawSend = w.sendTransaction.bind(w);
  w.sendTransaction = async (tx) => {
    if (nextNonce === null) { syncing = syncing || w.getNonce("latest").then((n) => { nextNonce = n; syncing = null; }); await syncing; }
    const nonce = nextNonce++;
    for (let a = 0; ; a++) {
      try { return await rawSend({ ...tx, nonce }); }
      catch (e) {
        const m = (e.shortMessage || e.message || "").toLowerCase();
        if (/nonce too low|already known|already imported|replacement/.test(m)) throw e;
        if (a >= 4) throw e;
        await new Promise((r) => setTimeout(r, 120 * (a + 1)));
      }
    }
  };
  const run = (fn) => fn().then((r) => r.wait());
  // --------------------------------------------------------

  const K = 20;
  const startNonce = await w.getNonce("latest");
  console.log(`firing ${K} independent txns concurrently through the pipelined run() (start nonce ${startNonce})...`);
  const t0 = Date.now();
  const receipts = await Promise.all(Array.from({ length: K }, () => run(() => w.sendTransaction({ to: w.address, value: 0 }))));
  const wall = Date.now() - t0;

  const nonces = receipts.map((r) => r.from && r.blockNumber != null ? null : null); // receipts don't carry nonce; re-derive
  // fetch each tx to read its nonce
  const txNonces = [];
  for (const r of receipts) { const tx = await p.getTransaction(r.hash); txNonces.push(tx.nonce); }
  txNonces.sort((a, b) => a - b);
  const contiguous = txNonces.every((n, i) => n === startNonce + i);
  const unique = new Set(txNonces).size === K;
  const blocks = [...new Set(receipts.map((r) => r.blockNumber))];
  const allOk = receipts.every((r) => r.status === 1);

  console.log(`\n${K} txns in ${wall}ms across ${blocks.length} block(s) = ${(K / (wall / 1000)).toFixed(1)} tx/s`);
  console.log(`nonces ${txNonces[0]}..${txNonces[txNonces.length - 1]}  contiguous=${contiguous}  unique=${unique}  allMined=${allOk}`);
  const ok = contiguous && unique && allOk && wall < 6000;
  console.log(ok
    ? `\n✅ PIPELINE VALID: ${K} concurrent txns, contiguous nonces, no gap/collision, one confirmation wave (${(wall/1000).toFixed(1)}s vs ${(K*1.5).toFixed(0)}s if serial).`
    : `\n❌ inspect: contiguous=${contiguous} unique=${unique} allMined=${allOk} wall=${wall}ms`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
