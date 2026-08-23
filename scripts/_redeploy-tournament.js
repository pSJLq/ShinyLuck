// Redeploy ONLY PokerTournament and repoint the live room's factory at it.
// Purpose (2026-07-12): wipe the 4 stuck test tournaments (#1-4, frozen in
// "Running" with dead bot players — cancel() only works on Registering). The
// old contract keeps its dust pools; its controlled tables become "foreign"
// to the dealer bot and are skipped permanently.
//
// Run: npx hardhat run scripts/_redeploy-tournament.js --network somniaTestnet
// After: update deployments manifest + frontend poker-config.js + restart bot
// (this script rewrites both files locally; upload them to the VPS yourself).

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const net = network.name;
  const manPath = path.join(__dirname, "..", "deployments", `poker-${net}.json`);
  const man = JSON.parse(fs.readFileSync(manPath, "utf8"));
  const [deployer] = await ethers.getSigners();
  console.log(`net=${net} deployer=${deployer.address} room=${man.addresses.pokerRoom}`);
  console.log(`old tournament: ${man.addresses.pokerTournament}`);

  const room = await ethers.getContractAt("PokerRoom", man.addresses.pokerRoom, deployer);
  const owner = await room.owner();
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) throw new Error(`deployer is not room owner (${owner})`);

  const Trn = await ethers.getContractFactory("PokerTournament", deployer);
  const trn = await Trn.deploy(deployer.address, man.addresses.pokerRoom);
  await trn.waitForDeployment();
  const trnAddr = await trn.getAddress();
  console.log(`new PokerTournament: ${trnAddr}`);

  await (await room.setTournamentFactory(trnAddr)).wait();
  await (await trn.setOperator(deployer.address)).wait();
  console.log("factory repointed + operator set");

  man.addresses.pokerTournamentOld = man.addresses.pokerTournament;
  man.addresses.pokerTournament = trnAddr;
  man.tournamentRedeployedAt = new Date().toISOString();
  fs.writeFileSync(manPath, JSON.stringify(man, null, 2));
  console.log(`manifest updated: ${manPath}`);

  const cfgPath = path.join(__dirname, "..", "frontend", "poker", "poker-config.js");
  let cfg = fs.readFileSync(cfgPath, "utf8");
  cfg = cfg.replace(man.addresses.pokerTournamentOld, trnAddr);
  fs.writeFileSync(cfgPath, cfg);
  console.log(`frontend config updated: ${cfgPath}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
