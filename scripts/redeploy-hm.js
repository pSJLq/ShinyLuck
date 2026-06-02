// HM-ONLY redeploy (gen-17): swaps just the HouseManager to fix the Parse
// Website agent call (parseText -> ExtractString). Casino, registry, bankroll,
// seeds and all registered player agents stay put. Steps:
//   1. deploy new HouseManager(casino, hmAgent)
//   2. drain old HM balance -> deployer (fund migration + gas headroom)
//   3. casino.setHouseManager(newHM)
//   4. newHM.setAgentPlatform(platform, llmAgentId)
//   5. registry.addExecutor(newHM)
//   6. newHM.setPlayerRegistry(registry)
//   7. fund newHM to ~46 STT
//   8. rewrite deployments/somniaTestnet.json (houseManager -> newHM)
// Run setup-reactivity.js afterwards to bootstrap the hourly cron + event sub.
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const PLATFORM = "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776";
const LLM_AGENT_ID = BigInt(process.env.AGENT_ID_LLM || "12847293847561029384");
const NEW_HM_TARGET = ethers.parseEther(process.env.NEW_HM_TARGET || "46");
const f = (x) => ethers.formatEther(x);

async function main() {
  const [s] = await ethers.getSigners();
  const manifestPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const casinoAddr = manifest.addresses.casino;
  const oldHm = manifest.addresses.houseManager;
  const regAddr = manifest.addresses.playerAgentRegistry;
  const hmAgent = process.env.HM_AGENT_ADDRESS || s.address;
  console.log(`[redeploy-hm] signer=${s.address} bal=${f(await ethers.provider.getBalance(s.address))}`);
  console.log(`[redeploy-hm] casino=${casinoAddr} oldHM=${oldHm} registry=${regAddr}`);

  // 1. drain old HM -> deployer FIRST (gives gas headroom for the big HM deploy
  //    + the funds to migrate to the new HM). A single cheap tx.
  const oldHmC = await ethers.getContractAt("HouseManager", oldHm, s);
  const oldBal = await ethers.provider.getBalance(oldHm);
  if (oldBal > ethers.parseEther("0.1")) {
    const drain = oldBal - ethers.parseEther("0.05");
    const tx = await oldHmC.withdrawTo(s.address, drain); await tx.wait();
    console.log(`[redeploy-hm] drained ${f(drain)} STT old HM -> deployer (deployer now ${f(await ethers.provider.getBalance(s.address))})`);
  }

  // 2. deploy new HM
  const HM = await ethers.getContractFactory("HouseManager");
  const hm = await HM.deploy(casinoAddr, hmAgent);
  await hm.waitForDeployment();
  const newHm = await hm.getAddress();
  console.log(`[redeploy-hm] NEW HouseManager: ${newHm}`);

  // 3-6. wiring
  const casino = await ethers.getContractAt("Casino", casinoAddr, s);
  let tx = await casino.setHouseManager(newHm); await tx.wait();
  console.log(`[redeploy-hm] casino.setHouseManager <- ${newHm}`);
  tx = await hm.setAgentPlatform(PLATFORM, LLM_AGENT_ID); await tx.wait();
  console.log(`[redeploy-hm] hm.setAgentPlatform <- ${PLATFORM} (LLM ${LLM_AGENT_ID})`);
  const registry = await ethers.getContractAt("PlayerAgentRegistry", regAddr, s);
  try { tx = await registry.addExecutor(newHm); await tx.wait(); console.log(`[redeploy-hm] registry.addExecutor <- ${newHm}`); }
  catch (e) { console.warn(`[redeploy-hm] registry.addExecutor failed: ${e.shortMessage || e.message}`); }
  tx = await hm.setPlayerRegistry(regAddr); await tx.wait();
  console.log(`[redeploy-hm] hm.setPlayerRegistry <- ${regAddr}`);

  // 7. fund new HM to target
  const curHmBal = await ethers.provider.getBalance(newHm);
  if (curHmBal < NEW_HM_TARGET) {
    const need = NEW_HM_TARGET - curHmBal;
    tx = await s.sendTransaction({ to: newHm, value: need }); await tx.wait();
    console.log(`[redeploy-hm] funded new HM with ${f(need)} STT -> ${f(await ethers.provider.getBalance(newHm))} STT`);
  }

  // 8. rewrite manifest
  manifest.addresses.houseManager = newHm;
  manifest.historicalHouseManagers = (manifest.historicalHouseManagers || []).concat([oldHm]);
  manifest.hmRedeployedAt = new Date().toISOString();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`[redeploy-hm] manifest updated: ${manifestPath}`);

  // verification
  console.log("--- verify new HM ---");
  console.log("  casino()        :", await hm.casino());
  console.log("  agentPlatform() :", await hm.agentPlatform());
  console.log("  llmAgentId()    :", (await hm.llmAgentId()).toString());
  console.log("  parseAgentId()  :", (await hm.parseAgentId()).toString());
  console.log("  jsonAgentId()   :", (await hm.jsonAgentId()).toString());
  console.log("  playerRegistry():", await hm.playerRegistry());
  console.log("  newsFeedUrl()   :", await hm.newsFeedUrl());
  console.log("  newsExtractPrompt():", await hm.newsExtractPrompt());
  console.log("  competitorFeedUrl():", await hm.competitorFeedUrl());
  console.log("  casino.houseManager():", await casino.houseManager());
  console.log("  deployer bal    :", f(await ethers.provider.getBalance(s.address)));
  console.log("  new HM bal      :", f(await ethers.provider.getBalance(newHm)));
  console.log(`\nNEXT: npx hardhat run scripts/setup-reactivity.js --network ${network.name}`);
}
main().catch((e) => { console.error("[redeploy-hm] ERR:", e.shortMessage || e.message); process.exit(1); });
