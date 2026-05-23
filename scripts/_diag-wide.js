const { ethers } = require("hardhat");
const dep = require("../deployments/somniaTestnet.json");

async function main() {
  const casino = await ethers.getContractAt("Casino", dep.addresses.casino);
  const cur = await ethers.provider.getBlockNumber();
  const from = Math.max(0, dep.deploymentBlock - 5);
  const placedTopic = casino.interface.getEvent("BetPlaced").topicHash;
  const settledTopic = casino.interface.getEvent("BetSettled").topicHash;
  const refundedTopic = casino.interface.getEvent("BetRefunded")?.topicHash || null;

  console.log(`scanning ${from}..${cur} (~${cur - from} blocks)`);
  const CHUNK = 900;
  const placed = new Map();
  const settled = new Set();
  const refunded = new Set();
  for (let s = from; s <= cur; s += CHUNK) {
    const e = Math.min(s + CHUNK - 1, cur);
    const reqs = [
      ethers.provider.getLogs({ address: dep.addresses.casino, topics: [placedTopic], fromBlock: s, toBlock: e }),
      ethers.provider.getLogs({ address: dep.addresses.casino, topics: [settledTopic], fromBlock: s, toBlock: e }),
    ];
    if (refundedTopic) reqs.push(ethers.provider.getLogs({ address: dep.addresses.casino, topics: [refundedTopic], fromBlock: s, toBlock: e }));
    const [p, st, rf] = await Promise.all(reqs);
    for (const l of p) { try { const x = casino.interface.parseLog(l); placed.set(x.args.betId.toString(), { game: Number(x.args.game), amount: x.args.amount, block: l.blockNumber }); } catch {} }
    for (const l of st) { try { settled.add(casino.interface.parseLog(l).args.betId.toString()); } catch {} }
    if (rf) for (const l of rf) { try { refunded.add(casino.interface.parseLog(l).args.betId.toString()); } catch {} }
  }
  const pending = [...placed.keys()].filter(id => !settled.has(id) && !refunded.has(id));
  console.log(`placed=${placed.size}  settled=${settled.size}  refunded=${refunded.size}  PENDING=${pending.length}`);
  const GAMES = ["DICE","CRASH","SLOTS","MINES","PLINKO","ROULETTE","CLUSTER"];
  for (const id of pending) {
    const p = placed.get(id);
    const age = cur - p.block;
    console.log(`  betId=${id.padStart(4)}  ${GAMES[p.game].padEnd(8)}  amount=${ethers.formatEther(p.amount)} STT  block=${p.block}  age=${age} blocks`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
