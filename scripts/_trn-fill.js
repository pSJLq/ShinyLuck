// Fill a tournament with test players so the host can rehearse the real thing.
// Free-entry events cost the bots nothing but gas. Wallets are derived, so the
// same run can be re-issued and swept later.
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const ID = Number(process.env.ID || 19);
const WANT = Number(process.env.WANT || 12); // total registered we aim for
const TAG = process.env.WALLET_TAG || "t";

(async () => {
  const env = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
  const get = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1].trim();
  const master = get("POKER_SEED_MASTER_KEY");
  const p = new ethers.JsonRpcProvider("https://api.infra.testnet.somnia.network");
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "poker-somniaTestnet.json"), "utf8"));
  const abi = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", "poker", "PokerTournament.sol", "PokerTournament.json"), "utf8")).abi;
  const trn = new ethers.Contract(m.addresses.pokerTournament, abi, p);
  const deployer = new ethers.Wallet(get("POKER_DEPLOYER_KEY"), p);
  const wal = (n) => new ethers.Wallet(ethers.keccak256(ethers.solidityPacked(["bytes32", "string"], [master, n])), p);

  const i = await trn.info(ID);
  if (Number(i.status) !== 0) { console.log("tournament is not REGISTERING — nothing to do"); return; }
  const have = Number(i.registered);
  const add = Math.max(0, Math.min(WANT, Number(i.maxPlayers)) - have);
  const cost = i.buyIn + i.fee;
  console.log(`#${ID}: ${have}/${i.maxPlayers} registered, entry ${ethers.formatEther(cost)} STT — adding ${add} test players`);
  if (!add) return;

  const bots = Array.from({ length: add }, (_, k) => wal(`arena-${TAG}-bot-${k}`));
  const need = cost + ethers.parseEther("0.26"); // entry + gas for a full event
  let nonce = await deployer.getNonce("latest");
  const funds = [];
  for (const b of bots) {
    const bal = await p.getBalance(b.address);
    if (bal < need) funds.push(deployer.sendTransaction({ to: b.address, value: need - bal, nonce: nonce++ }).then((t) => t.wait()));
  }
  await Promise.all(funds);
  console.log("funded.");

  for (const b of bots) {
    try {
      await (await trn.connect(b).register(ID, { value: cost })).wait();
      process.stdout.write(".");
    } catch (e) { console.log(`\n  ${b.address.slice(0, 8)} register failed: ${(e.shortMessage || e.message).slice(0, 70)}`); }
  }
  const after = await trn.info(ID);
  console.log(`\n#${ID}: now ${Number(after.registered)}/${Number(after.maxPlayers)} registered`);
  console.log(`startTime is 0, so it will NOT auto-start until the field is FULL — the host presses "Start now".`);
})();
