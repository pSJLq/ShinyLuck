// THE decisive measurement: is Somnia tx confirmation PARALLEL across senders,
// or a global serial throughput cap? Everything about the 200-online target
// hinges on this. Run: node scripts/_somnia-parallelism.js
require("dotenv").config();
const { ethers } = require("ethers");

const N = Number(process.env.PAR_N || 16);   // distinct sender wallets
const RPC = process.env.RPC_TESTNET || "https://api.infra.testnet.somnia.network";

async function main() {
  const p = new ethers.JsonRpcProvider(RPC);
  p.pollingInterval = 60;
  const dep = new ethers.Wallet(process.env.POKER_DEPLOYER_KEY, p);
  console.log(`RPC ${RPC}\ndeployer ${dep.address}  bal=${ethers.formatEther(await p.getBalance(dep.address))} STT\n`);

  // ---- Phase A: single tx, how many BLOCKS does inclusion actually take? ----
  {
    const b0 = await p.getBlockNumber();
    const t0 = Date.now();
    const tx = await dep.sendTransaction({ to: dep.address, value: 0 });
    const rc = await tx.wait();
    const wall = Date.now() - t0;
    console.log(`[A] single tx: submitBlock=${b0} minedBlock=${rc.blockNumber} (Δ${rc.blockNumber - b0} blocks) wall=${wall}ms`);
    console.log(`    → blocks are ~0.1s, so ${rc.blockNumber - b0} blocks ≈ ${((rc.blockNumber - b0) * 0.1).toFixed(1)}s of real inclusion; the rest of ${wall}ms is submit/RPC overhead\n`);
  }

  // ---- fund N ephemeral senders (parallel, explicit nonces from deployer) ----
  const gasEach = ethers.parseEther("0.02");
  const kids = Array.from({ length: N }, () => ethers.Wallet.createRandom().connect(p));
  let nonce = await p.getTransactionCount(dep.address);
  console.log(`[fund] funding ${N} senders (0.02 STT each) from nonce ${nonce}...`);
  await Promise.all(kids.map((k, i) => dep.sendTransaction({ to: k.address, value: gasEach, nonce: nonce + i }).then((t) => t.wait())));
  console.log(`[fund] done\n`);

  // ---- Phase B: same-sender burst (one wallet, K contiguous-nonce txns) ----
  {
    const K = 10;
    const n0 = await p.getTransactionCount(dep.address);
    const t0 = Date.now();
    const rcs = await Promise.all(Array.from({ length: K }, (_, i) => dep.sendTransaction({ to: dep.address, value: 0, nonce: n0 + i }).then((t) => t.wait())));
    const wall = Date.now() - t0;
    const blocks = [...new Set(rcs.map((r) => r.blockNumber))];
    console.log(`[B] same-sender burst: ${K} txns from ONE wallet in ${wall}ms across ${blocks.length} block(s) → ${(K / (wall / 1000)).toFixed(1)} tx/s from a single nonce queue\n`);
  }

  // ---- Phase C: MULTI-SENDER parallel — the decisive test ----
  {
    const t0 = Date.now();
    const lat = new Array(N);
    await Promise.all(kids.map(async (k, i) => {
      const s = Date.now();
      const tx = await k.sendTransaction({ to: k.address, value: 0 });
      await tx.wait();
      lat[i] = Date.now() - s;
    }));
    const wall = Date.now() - t0;
    lat.sort((a, b) => a - b);
    const median = lat[Math.floor(N / 2)];
    console.log(`[C] MULTI-SENDER: ${N} txns from ${N} DIFFERENT wallets fired at once`);
    console.log(`    per-tx latency: min=${lat[0]}ms median=${median}ms max=${lat[N - 1]}ms`);
    console.log(`    TOTAL wall-clock for all ${N}: ${wall}ms`);
    console.log(`    effective throughput: ${(N / (wall / 1000)).toFixed(1)} tx/s\n`);

    console.log("===== VERDICT =====");
    const serialWall = median * N;
    if (wall < median * 2.5) {
      console.log(`✅ PARALLEL: ${N} concurrent senders confirmed in ${wall}ms ≈ one tx's ${median}ms.`);
      console.log(`   Confirms do NOT serialize across senders → per-action latency stays ~${(median/1000).toFixed(1)}s`);
      console.log(`   at ANY online count, and dealer throughput scales with more workers/dealers.`);
      console.log(`   → the ≤2s @ 200-online target is ACHIEVABLE with enough dealer wallets.`);
    } else if (wall > serialWall * 0.6) {
      console.log(`❌ SERIAL cap: ${N} txns took ${wall}ms ≈ ${N}×${median}ms. The network/RPC serializes`);
      console.log(`   submissions → more workers can't help; the ${(median/1000).toFixed(1)}s floor is a hard global cap on this RPC.`);
    } else {
      console.log(`⚠️ PARTIAL: ${wall}ms for ${N} (between 1× and ${N}× a single tx). Some parallelism,`);
      console.log(`   some contention — likely public-RPC rate-limiting. A dedicated RPC would clarify.`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
