// Targeted redeploy v3: keep PokerRoom + CommitRevealDealer + PlayerProfile,
// deploy the NEW PokerTournament (host reward: creator's hostBps cut of the
// pool), repoint room.setTournamentFactory, seed a demo SNG, rewrite the
// manifest + frontend config. The OLD tournament contract is orphaned — any
// still-REGISTERING event on it is owner-CANCELLED first so escrowed buy-ins
// and sponsorships are refunded, not stranded behind a frontend switch.
//
// SAFETY: signs with POKER_DEPLOYER_KEY — the SAME key the VPS dealer bot uses.
// STOP the VPS `poker` pm2 process before running, restart it after (it
// re-reads the manifest). Underscore-prefixed → gitignored, not shipped.
//
// Run: npx hardhat run scripts/_redeploy-trn-v3.js --network somniaTestnet

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const net = network.name;
  const manifestPath = path.join(__dirname, "..", "deployments", `poker-${net}.json`);
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const roomAddr = m.addresses.pokerRoom;

  if (!process.env.POKER_DEPLOYER_KEY) throw new Error("set POKER_DEPLOYER_KEY");
  const deployer = new ethers.Wallet(process.env.POKER_DEPLOYER_KEY, ethers.provider);
  const operator = process.env.POKER_OPERATOR || deployer.address;
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`net=${net} deployer=${deployer.address} bal=${ethers.formatEther(bal)} room=${roomAddr}`);

  const room = await ethers.getContractAt("PokerRoom", roomAddr, deployer);
  const oldTrnAddr = m.addresses.pokerTournament;

  // 0. Refund anything still escrowed on the OLD tournament contract: cancel
  //    every REGISTERING event (owner may cancel; refunds buy-ins + sponsor).
  if (oldTrnAddr && (await ethers.provider.getCode(oldTrnAddr)) !== "0x") {
    const old = await ethers.getContractAt("PokerTournament", oldTrnAddr, deployer);
    const n = Number(await old.count());
    for (let id = 0; id < n; id++) {
      try {
        const i = await old.info(id);
        if (Number(i.status) !== 0) continue; // only REGISTERING can strand funds
        console.log(`old trn #${id}: REGISTERING, ${Number(i.registered)} registered, pool ${ethers.formatEther(i.pool)} — cancelling (full refunds)`);
        await (await old.cancel(id)).wait();
      } catch (e) {
        console.log(`old trn #${id}: cancel skipped (${e.shortMessage || e.message})`);
      }
    }
  }

  // 1. Deploy the new PokerTournament (host reward build)
  const Trn = await ethers.getContractFactory("PokerTournament", deployer);
  const trn = await Trn.deploy(deployer.address, roomAddr);
  await trn.waitForDeployment();
  const trnAddr = await trn.getAddress();
  console.log(`PokerTournament(v3)=${trnAddr}  (old ${oldTrnAddr} orphaned)`);

  // 2. Wire factory + operator
  await (await room.setTournamentFactory(trnAddr)).wait();
  await (await trn.setOperator(operator)).wait();
  console.log("wired: room.setTournamentFactory(v3) + trn.setOperator(bot)");

  // 3. Seed a demo public SNG so the Tournaments tab isn't empty
  const demo = {
    buyIn: ethers.parseEther("0.05"), fee: ethers.parseEther("0.005"), maxPlayers: 6, seatsPerTable: 0,
    startStack: 1500n, sbStart: 10n, bbStart: 20n, anteStart: 0n, levelDur: 300n,
    growthBps: 15000, startTime: 0n, approvalRequired: false, actionSecs: 0,
    payoutBps: [6500, 3500], structure: [], hostBps: 0,
  };
  await (await trn.createTournament(demo, { value: 0 })).wait();
  console.log("created demo public SNG (id 0)");

  // 4. Rewrite manifest + frontend config (tournament only)
  m.addresses.pokerTournament = trnAddr;
  m.tournamentRedeployedAt = new Date().toISOString();
  fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
  const feDep = path.join(__dirname, "..", "frontend", "deployments", `poker-${net}.json`);
  if (fs.existsSync(path.dirname(feDep))) fs.writeFileSync(feDep, JSON.stringify(m, null, 2));

  const cfgPath = path.join(__dirname, "..", "frontend", "poker", "poker-config.js");
  let src = fs.readFileSync(cfgPath, "utf8");
  src = src.replace(/pokerTournament:\s*"[^"]*"/, `pokerTournament: "${trnAddr}"`);
  fs.writeFileSync(cfgPath, src);

  console.log("\nDONE. manifest + poker-config.js updated.");
  console.log(`  pokerTournament (NEW) = ${trnAddr}`);
  console.log("  Next: update_bot.py (manifest + artifacts + restart), deploy frontend, run e2e.");
}
main().catch((e) => { console.error(e); process.exit(1); });
