// One-shot fix: previous deploys hardcoded the MAINNET Agent Platform
// address (0x5E5205CF…) on TESTNET, so every LLM/JSON agent invocation
// silently dropped (eth_getCode at that addr returns 0x on Shannon).
// This script flips both the HouseManager + AgentQuorumVerifier to the
// correct testnet platform: 0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776.
// Run AFTER a redeploy if the env still had the mainnet value during it.

const { ethers, network } = require("hardhat");
const fs   = require("fs");
const path = require("path");

const TESTNET_PLATFORM = "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776";

async function main() {
  const [signer] = await ethers.getSigners();
  const manifestPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const hmAddr  = m.addresses.houseManager;
  const verAddr = m.addresses.agentQuorumVerifier;

  console.log(`network=${network.name}, signer=${signer.address}`);
  console.log(`HouseManager=${hmAddr}`);
  console.log(`Verifier=${verAddr}`);
  console.log(`→ setting platform to ${TESTNET_PLATFORM}\n`);

  const hm = await ethers.getContractAt("HouseManager", hmAddr, signer);
  const tx1 = await hm.setAgentPlatform(TESTNET_PLATFORM, "128472938475610293844");
  await tx1.wait();
  console.log(`[1/2] HouseManager.setAgentPlatform → tx ${tx1.hash}`);

  const ver = await ethers.getContractAt("AgentQuorumVerifier", verAddr, signer);
  const tx2 = await ver.setPlatform(TESTNET_PLATFORM);
  await tx2.wait();
  console.log(`[2/2] Verifier.setPlatform → tx ${tx2.hash}`);

  // Sync frontend config too.
  const cfgPath = path.join(__dirname, "..", "frontend", "lib", "config.js");
  let cfg = fs.readFileSync(cfgPath, "utf8");
  cfg = cfg.replace(/agentPlatform:\s*"0x[0-9a-fA-F]{40}"/, `agentPlatform: "${TESTNET_PLATFORM}"`);
  fs.writeFileSync(cfgPath, cfg);
  console.log(`[+] frontend/lib/config.js synced to testnet platform`);
}

main().catch((e) => { console.error(e); process.exit(1); });
