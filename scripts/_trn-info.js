const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const ID = Number(process.env.ID || 19);
const ABI = [
  "function info(uint256) view returns (address creator,uint128 buyIn,uint128 fee,uint128 startStack,uint128 pool,uint8 maxPlayers,uint8 registered,uint8 status,uint8 remaining,uint256 tableId,uint16[] payoutBps,bool approvalRequired,uint8 pendingCount)",
  "function clock(uint256) view returns (uint64 startTime,uint64 levelStartedAt,uint16 level,uint32 levelDur)",
  "function seatsPerTableOf(uint256) view returns (uint8)",
  "function hostBpsOf(uint256) view returns (uint16)",
];
(async () => {
  const p = new ethers.JsonRpcProvider("https://api.infra.testnet.somnia.network");
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "poker-somniaTestnet.json"), "utf8"));
  const trn = new ethers.Contract(m.addresses.pokerTournament, ABI, p);
  const i = await trn.info(ID);
  const c = await trn.clock(ID);
  const now = Math.floor(Date.now() / 1000);
  console.log("creator        ", i.creator);
  console.log("status         ", ["REGISTERING", "RUNNING", "FINISHED", "CANCELLED"][Number(i.status)]);
  console.log("registered     ", Number(i.registered), "/", Number(i.maxPlayers));
  console.log("buyIn + fee    ", ethers.formatEther(i.buyIn), "+", ethers.formatEther(i.fee), "STT");
  console.log("startStack     ", i.startStack.toString(), "chips");
  console.log("approval req   ", i.approvalRequired, "| pending:", Number(i.pendingCount));
  console.log("payout bps     ", i.payoutBps.map(Number).join("/"));
  try { console.log("seats/table    ", Number(await trn.seatsPerTableOf(ID))); } catch (_) {}
  try { console.log("host bps       ", Number(await trn.hostBpsOf(ID))); } catch (_) {}
  const st = Number(c.startTime);
  console.log("startTime      ", st ? new Date(st * 1000).toISOString() + (st > now ? `  (in ${Math.round((st - now) / 60)} min)` : "  (passed)") : "0 — starts only when the field is FULL");
  console.log("level duration ", Number(c.levelDur), "s | level", Number(c.level));
})();
