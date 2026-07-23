// Worker thread: verifies Wikström shuffle proofs off the main event loop.
//
// WHY: verifyShuffle is ~400ms of BN254 math (measured; a VPS 1-vCPU core is
// slower still). Run inline on the coordinator's single thread, a burst of
// proofs from two active tables froze the HTTP relay for many seconds, so
// players on the OTHER table missed their key/share deadlines and got sat out
// -- the "tables take turns" report. Verification needs no secrets (only the
// public domain, the two decks, the aggregate key and the wire proof), so it
// is safe to hand to a pool of workers.
//
// The worker returns ONLY a boolean. An invalid proof therefore fails exactly
// as it did inline; there is no path by which a bad proof is accepted because
// the worker crashed (the pool rejects the promise, and the caller treats a
// rejection as "not verified" -> proof refused).

const { parentPort } = require("node:worker_threads");
const { pathToFileURL } = require("node:url");
const path = require("node:path");

let zk = null;

async function boot() {
  const R = path.join(__dirname, "..", "..");
  const ethers = require(path.join(R, "node_modules", "ethers"));
  const { bn254 } = await import(pathToFileURL(path.join(R, "node_modules", "@noble", "curves", "bn254.js")).href);
  const nodeCrypto = require("node:crypto");
  zk = await import(pathToFileURL(path.join(R, "frontend", "poker", "zk-bn254.js")).href);
  zk.init({ bn254, keccak256: ethers.keccak256, randomBytes: (n) => nodeCrypto.randomBytes(n) });
  const G1 = bn254.G1.ProjectivePoint;

  // deserialize exactly like the driver's parsePt/parseCt (assertValidity
  // rejects off-curve garbage before it ever reaches the pairing math)
  const parsePt = (o) => { const P = G1.fromAffine({ x: BigInt(o.x), y: BigInt(o.y) }); P.assertValidity(); return P; };
  const parseCt = (o) => ({ A: parsePt(o.A), B: parsePt(o.B) });

  parentPort.on("message", (msg) => {
    const { id } = msg;
    try {
      const prev = msg.prevDeck.map(parseCt);
      const next = msg.newDeck.map(parseCt);
      const X = parsePt(msg.aggKey);
      const prf = zk.shuffleProofFromWire(msg.proofWire, parsePt);
      const ok = (zk.verifyShuffleBatched || zk.verifyShuffle)(msg.domain, prev, next, X, prf);
      parentPort.postMessage({ id, ok: !!ok });
    } catch (e) {
      // any deserialization / validity failure = not verified (never "true")
      parentPort.postMessage({ id, ok: false, err: e.message });
    }
  });

  parentPort.postMessage({ ready: true });
}

boot().catch((e) => {
  parentPort.postMessage({ fatal: e.message || String(e) });
});
