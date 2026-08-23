// READ-ONLY probe: real Somnia RPC latency per method (the constants that
// decide how fast the reveal bot can settle), plus live casino limits.
require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const RPC = process.env.RPC_TESTNET || "https://api.infra.testnet.somnia.network";
const F = (w) => Number(ethers.formatEther(w));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };

const ABI = [
  "function freeBankroll() view returns (uint256)",
  "function maxBetBps() view returns (uint256)",
  "function maxExposureBps() view returns (uint256)",
  "function nextHashIndex() view returns (uint256)",
  "function vault7MaxMultX100() view returns (uint256)",
  "function clusterMaxMultX100() view returns (uint256)",
];

async function timeIt(fn, n) {
  const out = [];
  for (let i = 0; i < n; i++) { const t = Date.now(); try { await fn(i); } catch (_) {} out.push(Date.now() - t); }
  return out;
}

async function main() {
  const p = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "somniaTestnet.json"), "utf8"));
  const casino = m.addresses.casino;
  const c = new ethers.Contract(casino, ABI, p);

  const head = await p.getBlockNumber();
  console.log(`RPC ${RPC}\nhead block ${head}\n`);

  // per-method latency; the block argument varies to defeat any caching
  const sel = (sig) => ethers.id(sig).slice(0, 10);
  const methods = {
    eth_blockNumber:  () => p.send("eth_blockNumber", []),
    eth_getBlockByNumber: (i) => p.send("eth_getBlockByNumber", ["0x" + (head - i).toString(16), false]),
    eth_call_view:    (i) => p.send("eth_call", [{ to: casino, data: sel("freeBankroll()") }, "0x" + (head - i).toString(16)]),
    eth_getTransactionCount: (i) => p.send("eth_getTransactionCount", [m.deployer, "0x" + (head - i).toString(16)]),
    eth_gasPrice:     () => p.send("eth_gasPrice", []),
    eth_estimateGas:  () => p.send("eth_estimateGas", [{ to: casino, data: sel("freeBankroll()") }]),
    eth_getLogs_900:  (i) => p.send("eth_getLogs", [{ address: casino, fromBlock: "0x" + (head - 900 - i * 900).toString(16), toBlock: "0x" + (head - i * 900).toString(16) }]),
  };
  console.log("--- RPC latency (ms, n=10 each) ---");
  for (const [name, fn] of Object.entries(methods)) {
    const t = await timeIt(fn, 10);
    console.log(`${name.padEnd(24)} p50=${pct(t, 50)}  p90=${pct(t, 90)}  max=${pct(t, 100)}`);
  }

  const b1 = await p.getBlock(head), b0 = await p.getBlock(head - 1000);
  const bt = (Number(b1.timestamp) - Number(b0.timestamp)) / 1000;
  console.log(`\nblock time ${bt.toFixed(4)}s -> 256-block reveal window = ${(256 * bt).toFixed(1)}s`);

  const [free, mbps, mebps, v7, clu, nhi] = await Promise.all([
    c.freeBankroll(), c.maxBetBps(), c.maxExposureBps(), c.vault7MaxMultX100(), c.clusterMaxMultX100(), c.nextHashIndex(),
  ]);
  const expo = free * mebps / 10000n;
  console.log(`\nfreeBankroll ${F(free).toFixed(2)} STT | maxBet 1%=${F(free * mbps / 10000n).toFixed(3)} STT | exposure cap ${F(expo).toFixed(2)} STT`);
  console.log(`max stake slots ${F(expo * 100n / v7).toFixed(4)} STT, cluster ${F(expo * 100n / clu).toFixed(4)} STT (maxMult ${Number(v7) / 100}x)`);
  console.log(`seed cursor nextHashIndex=${nhi}`);
  console.log(`bot signer gas ${F(await p.getBalance(m.deployer)).toFixed(3)} STT`);
}
main().catch((e) => { console.error(e); process.exit(1); });
