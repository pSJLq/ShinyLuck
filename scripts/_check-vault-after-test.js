// After running _test-player-agent.js, verify the player's AgentVault was
// actually charged the userShare of the LLM cost (proves the new
// vault-funded-fee path works, not just that the LLM came back).
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
async function main() {
  const [signer] = await ethers.getSigners();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"),
  );
  const regAddr = manifest.addresses.playerAgentRegistry;
  const hmAddr  = manifest.addresses.houseManager;
  const reg = await ethers.getContractAt("PlayerAgentRegistry", regAddr);
  const hm  = await ethers.getContractAt("HouseManager", hmAddr);

  const perm = await reg.permissions(signer.address);
  const vaultBal = await ethers.provider.getBalance(perm.vault);
  const hmBal    = await ethers.provider.getBalance(hmAddr);
  const cost     = await hm.quoteLlmCost();
  const subsidy  = await hm.agentDecisionSubsidyBps();
  const userShare = (cost * (10000n - subsidy)) / 10000n;
  console.log("player     :", signer.address);
  console.log("vault      :", perm.vault);
  console.log("vault bal  :", ethers.formatEther(vaultBal), "STT");
  console.log("HM bal     :", ethers.formatEther(hmBal), "STT");
  console.log("LLM cost   :", ethers.formatEther(cost), "STT");
  console.log("subsidyBps :", subsidy.toString(), "(0 = user pays 100%)");
  console.log("userShare  :", ethers.formatEther(userShare), "STT (expected delta from 1.0 funding)");
  console.log("");
  if (vaultBal < ethers.parseEther("1") - userShare + ethers.parseEther("0.001") && vaultBal >= ethers.parseEther("1") - userShare - ethers.parseEther("0.001")) {
    console.log("OK: vault was charged the user share of the LLM cost.");
  } else {
    const charged = ethers.parseEther("1") - vaultBal;
    console.log(`charged: ${ethers.formatEther(charged)} STT (expected ~${ethers.formatEther(userShare)} STT)`);
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
