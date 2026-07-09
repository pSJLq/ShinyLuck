// Targeted redeploy: keep the EXISTING PokerRoom + CommitRevealDealer (and all
// cash tables/balances), deploy the NEW PokerTournament (scheduled start +
// antes + approval) and PlayerProfile (on-chain nicknames), repoint
// room.setTournamentFactory, set cash rake to 10%, seed one demo tournament,
// and rewrite the manifest + frontend config. The OLD tournament is orphaned.
//
// SAFETY: signs with POKER_DEPLOYER_KEY — the SAME key the VPS dealer bot uses.
// STOP the VPS `poker` pm2 process before running, restart it after (it re-reads
// the manifest). Underscore-prefixed → gitignored, not shipped.
//
// Run: npx hardhat run scripts/_redeploy-poker-v2.js --network somniaTestnet

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const net = network.name;
  const manifestPath = path.join(__dirname, "..", "deployments", `poker-${net}.json`);
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const roomAddr = m.addresses.pokerRoom;
  const dealerAddr = m.addresses.commitRevealDealer;

  if (!process.env.POKER_DEPLOYER_KEY) throw new Error("set POKER_DEPLOYER_KEY");
  const deployer = new ethers.Wallet(process.env.POKER_DEPLOYER_KEY, ethers.provider);
  const operator = process.env.POKER_OPERATOR || deployer.address;
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`net=${net} deployer=${deployer.address} bal=${ethers.formatEther(bal)} room=${roomAddr}`);

  const room = await ethers.getContractAt("PokerRoom", roomAddr, deployer);
  const oldTrn = m.addresses.pokerTournament;

  // 1. Deploy new PokerTournament; reuse the existing PlayerProfile if still deployed.
  let ppAddr = m.addresses.playerProfile;
  if (!ppAddr || (await ethers.provider.getCode(ppAddr)) === "0x") {
    const PP = await ethers.getContractFactory("PlayerProfile", deployer);
    const pp = await PP.deploy(); await pp.waitForDeployment();
    ppAddr = await pp.getAddress();
    console.log(`PlayerProfile (new) = ${ppAddr}`);
  } else {
    console.log(`PlayerProfile (reused) = ${ppAddr}`);
  }

  const Trn = await ethers.getContractFactory("PokerTournament", deployer);
  const trn = await Trn.deploy(deployer.address, roomAddr); await trn.waitForDeployment();
  const trnAddr = await trn.getAddress();
  console.log(`PlayerProfile=${ppAddr}\nPokerTournament(new)=${trnAddr}  (old ${oldTrn} orphaned)`);

  // 2. Wire the new tournament factory + operator (bot)
  await (await room.setTournamentFactory(trnAddr)).wait();
  await (await trn.setOperator(operator)).wait();
  console.log("wired: room.setTournamentFactory(new) + trn.setOperator(bot)");

  // 3. Rake -> 10% on pure cash tables (controller==0), huge cap = stable 10%
  const RAKE_BPS = 1000n, RAKE_CAP = ethers.parseEther("1000");
  const n = Number(await room.tableCount());
  for (let t = 0; t < n; t++) {
    const ctl = await room.tableController(t);
    if (ctl !== ethers.ZeroAddress) { console.log(`table ${t}: controlled — skip`); continue; }
    if (await room.handInProgress(t)) { console.log(`table ${t}: hand live — skip`); continue; }
    const c = await room.getTable(t);
    if (c.rakeBps === RAKE_BPS && c.rakeCap === RAKE_CAP) { console.log(`table ${t}: already 10%`); continue; }
    const cfg = {
      maxSeats: c.maxSeats, smallBlind: c.smallBlind, bigBlind: c.bigBlind, ante: c.ante,
      minBuyIn: c.minBuyIn, maxBuyIn: c.maxBuyIn, rakeBps: RAKE_BPS, rakeCap: RAKE_CAP,
      actionTimeout: c.actionTimeout, active: c.active,
    };
    await (await room.updateTable(t, cfg)).wait();
    console.log(`table ${t}: rake -> 10%`);
  }

  // 4. Seed a demo public SNG so the Tournaments tab isn't empty
  const demo = {
    buyIn: ethers.parseEther("0.05"), fee: ethers.parseEther("0.005"), maxPlayers: 6, seatsPerTable: 0,
    startStack: 1500n, sbStart: 10n, bbStart: 20n, anteStart: 0n, levelDur: 300n,
    growthBps: 15000, startTime: 0n, approvalRequired: false, actionSecs: 0, payoutBps: [6500, 3500], structure: [],
  };
  await (await trn.createTournament(demo, { value: 0 })).wait();
  console.log("created demo public SNG (id 0)");

  // 5. Rewrite manifest + frontend config (tournament + profile only)
  m.addresses.pokerTournament = trnAddr;
  m.addresses.playerProfile = ppAddr;
  m.tournamentRedeployedAt = new Date().toISOString();
  fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
  const feDep = path.join(__dirname, "..", "frontend", "deployments", `poker-${net}.json`);
  if (fs.existsSync(path.dirname(feDep))) fs.writeFileSync(feDep, JSON.stringify(m, null, 2));

  const cfgPath = path.join(__dirname, "..", "frontend", "poker", "poker-config.js");
  let src = fs.readFileSync(cfgPath, "utf8");
  src = src.replace(/pokerTournament:\s*"[^"]*"/, `pokerTournament: "${trnAddr}"`);
  src = src.replace(/playerProfile:\s*"[^"]*"/, `playerProfile: "${ppAddr}"`);
  fs.writeFileSync(cfgPath, src);

  console.log("\nDONE. manifest + poker-config.js updated.");
  console.log(`  pokerRoom (unchanged) = ${roomAddr}`);
  console.log(`  commitRevealDealer (unchanged) = ${dealerAddr}`);
  console.log(`  pokerTournament (NEW) = ${trnAddr}`);
  console.log(`  playerProfile (NEW) = ${ppAddr}`);
  console.log("  Next: update /root/poker-bot manifest+artifact, restart pm2 poker, deploy frontend.");
}
main().catch((e) => { console.error(e); process.exit(1); });
