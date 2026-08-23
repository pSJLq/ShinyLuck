// Take the test bots off the tables. leaveTable reverts while they are dealt
// into a hand, and the pre-deal starts the next one within seconds, so sit them
// OUT first (that is honoured between hands) and only then leave.
const { ethers } = require("ethers");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", "..", "..", "..", "Рабочий стол", "ShinyLuck", ".env") });
const fs = require("fs");

const REPO = "D:/Рабочий стол/ShinyLuck";
const ABI = [
  "function seatOf(uint256 t, address p) view returns (uint8)",
  "function getSeat(uint256 t, uint8 s) view returns ((address player, uint128 stack, bool occupied, bool sittingOut, uint64 sitInHandId, uint64 sitOutSince))",
  "function getHand(uint256 t) view returns ((uint64 handId, uint8 street, uint8 button, uint8 actingSeat, uint8 aggressorSeat, uint8 numInHand, uint128 currentBet, uint128 minRaise, uint128 pot, uint64 actingDeadline, uint256 dealId, bool inProgress))",
  "function setSitOut(uint256 t, bool on)",
  "function leaveTable(uint256 t)",
];
const sleep = (m) => new Promise((r) => setTimeout(r, m));

(async () => {
  const env = fs.readFileSync(path.join(REPO, ".env"), "utf8");
  const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1].trim();
  const master = get("POKER_SEED_MASTER_KEY");
  const p = new ethers.JsonRpcProvider("https://api.infra.testnet.somnia.network");
  const m = JSON.parse(fs.readFileSync(path.join(REPO, "deployments", "poker-somniaTestnet.json"), "utf8"));
  const wal = (n) => new ethers.Wallet(ethers.keccak256(ethers.solidityPacked(["bytes32", "string"], [master, n])), p);
  const room = new ethers.Contract(m.addresses.pokerRoom, ABI, p);

  const bots = Array.from({ length: 6 }, (_, i) => wal(`arena-b-bot-${i}`));
  const tables = [0, 2, 3];
  // 1) sit everyone out so no new hand deals them in
  for (const t of tables) {
    for (const b of bots) {
      const s = Number(await room.seatOf(t, b.address));
      if (s === 255) continue;
      const seat = await room.getSeat(t, s);
      if (seat.sittingOut) continue;
      try { await (await room.connect(b).setSitOut(t, true)).wait(); console.log(`sit-out t${t} ${b.address.slice(0, 8)}`); } catch (e) { console.log("sitout fail", e.shortMessage || e.message); }
    }
  }
  // 2) wait for any hand still running to finish, then leave
  for (const t of tables) {
    for (let i = 0; i < 40; i++) {
      if (!(await room.getHand(t)).inProgress) break;
      await sleep(1500);
    }
    for (const b of bots) {
      if (Number(await room.seatOf(t, b.address)) === 255) continue;
      for (let tr = 0; tr < 4; tr++) {
        try { await (await room.connect(b).leaveTable(t)).wait(); console.log(`left t${t} ${b.address.slice(0, 8)}`); break; }
        catch (_) { await sleep(2500); }
      }
    }
  }
  for (const t of tables) {
    const occ = [];
    for (let s = 0; s < 6; s++) { const q = await room.getSeat(t, s); if (q.occupied) occ.push(s); }
    console.log(`table ${t}: occupied seats [${occ.join(",")}]`);
  }
})();
