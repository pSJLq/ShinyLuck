// Pre-redeploy sweep: every SCRIPT wallet (load-1..12 + e2e-player-1/2) stands
// up from whatever old-room table it's parked at and withdraws its in-room
// balance back to native STT. Run with the bot RUNNING (pending hands need the
// dealer to finish); after this the balance migration only concerns real users.
require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const RPC = "https://api.infra.testnet.somnia.network";
const F = (w) => ethers.formatEther(w);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const loadAbi = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", "poker", `${n}.sol`, `${n}.json`), "utf8")).abi;

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "poker-somniaTestnet.json"), "utf8"));
  const master = process.env.POKER_SEED_MASTER_KEY;
  const tags = [...Array.from({ length: 12 }, (_, i) => `load-${i + 1}`), "e2e-player-1", "e2e-player-2"];
  const ws = tags.map((t) => new ethers.Wallet(ethers.keccak256(ethers.solidityPacked(["bytes32", "string"], [master, t])), provider));
  const roomR = new ethers.Contract(m.addresses.pokerRoom, loadAbi("PokerRoom"), provider);
  const nTables = Number(await roomR.tableCount());

  // tournament-CONTROLLED tables hold play chips, not funds — nothing to evacuate
  const controlled = new Set();
  for (let t = 0; t < nTables; t++) {
    try { if ((await roomR.tableController(t)) !== ethers.ZeroAddress) controlled.add(t); } catch {}
  }

  for (const [i, w] of ws.entries()) {
    const room = roomR.connect(w);
    for (let t = 0; t < nTables; t++) {
      if (controlled.has(t)) continue;
      let seat;
      try { seat = Number(await roomR.seatOf(t, w.address)); } catch { continue; }
      if (seat === 255) continue;
      console.log(`[evac] ${tags[i]} seated at t${t}s${seat} — standing up`);
      try { await (await room.setSitOut(t, true)).wait(); } catch (_) {}
      let left = false;
      for (let k = 0; k < 40 && !left; k++) {
        try { await (await room.leaveTable(t)).wait(); left = true; }
        catch (_) { await sleep(5000); } // live hand — the bot will finish it
      }
      console.log(`[evac] ${tags[i]} ${left ? "left" : "STUCK AT"} t${t}`);
    }
    const bal = await roomR.balance(w.address);
    if (bal > 0n) {
      await (await room.withdraw(bal)).wait();
      console.log(`[evac] ${tags[i]} withdrew ${F(bal)} STT`);
    }
  }
  console.log("[evac] DONE");
}
main().catch((e) => { console.error("[evac] fatal:", e.shortMessage || e.message); process.exit(1); });
