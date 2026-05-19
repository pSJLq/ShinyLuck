// Deploys the full ShinyLuck stack: Casino → HouseManager → AgentQuorumVerifier →
// PlayerAgentRegistry. Wires HouseManager as Casino's houseManager, provisions
// an initial batch of seed hashes, and writes a deployment manifest the
// frontend & agent-service consume.
//
// Usage:
//   npx hardhat run scripts/deploy.js --network somniaTestnet

const { ethers, network, run, artifacts } = require("hardhat");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Somnia agent platform / agent IDs (testnet). Mainnet values may differ;
// override via env if needed.
const AGENT_PLATFORM = process.env.AGENT_PLATFORM || "0x5E5205CF39E766118C01636bED000A54D93163E6";
const LLM_AGENT_ID = BigInt(process.env.AGENT_ID_LLM || "128472938475610293844");

const RELAYER = process.env.RELAYER_ADDRESS || ""; // optional: for the registry
const HM_AGENT = process.env.HM_AGENT_ADDRESS || ""; // off-chain HM agent signer
const INITIAL_BANKROLL_ETH = process.env.INITIAL_BANKROLL_ETH || "1";
const SEED_BATCH_SIZE = parseInt(process.env.SEED_BATCH_SIZE || "200", 10);

function genServerSeed() {
  return "0x" + crypto.randomBytes(32).toString("hex");
}

function hashServerSeed(seed) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [seed])
  );
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = network.name;
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`[deploy] network=${net}, deployer=${deployer.address}, balance=${ethers.formatEther(balance)}`);

  // Record the block we start at — reveal-bot uses this as its scan floor so
  // it doesn't replay every block of network history on cold start.
  const deploymentBlock = await ethers.provider.getBlockNumber();

  // 1. Casino — Vault7Lib + ClusterLib are imported with `internal` functions,
  //    so Solidity inlines them into the Casino bytecode (no library linking).
  const Casino = await ethers.getContractFactory("Casino");
  const casino = await Casino.deploy(deployer.address);
  await casino.waitForDeployment();
  const casinoAddr = await casino.getAddress();
  const casinoDeployTx = casino.deploymentTransaction();
  const casinoDeployBlock = casinoDeployTx ? casinoDeployTx.blockNumber : deploymentBlock;
  console.log("[deploy] Casino:", casinoAddr, "@ block", casinoDeployBlock);

  // 2. HouseManager — caller key for off-chain HM agent. Defaults to deployer if not set.
  const hmAgent = HM_AGENT || deployer.address;
  const HM = await ethers.getContractFactory("HouseManager");
  const houseManager = await HM.deploy(casinoAddr, hmAgent);
  await houseManager.waitForDeployment();
  const hmAddr = await houseManager.getAddress();
  console.log("[deploy] HouseManager:", hmAddr, "(agent:", hmAgent, ")");

  // 3. AgentQuorumVerifier
  const Verifier = await ethers.getContractFactory("AgentQuorumVerifier");
  const verifier = await Verifier.deploy(casinoAddr, AGENT_PLATFORM, LLM_AGENT_ID);
  await verifier.waitForDeployment();
  const verifierAddr = await verifier.getAddress();
  console.log("[deploy] AgentQuorumVerifier:", verifierAddr);

  // 4. PlayerAgentRegistry — relayer = HM_AGENT or deployer
  const relayer = RELAYER || deployer.address;
  const Reg = await ethers.getContractFactory("PlayerAgentRegistry");
  const registry = await Reg.deploy(casinoAddr, relayer);
  await registry.waitForDeployment();
  const regAddr = await registry.getAddress();
  console.log("[deploy] PlayerAgentRegistry:", regAddr, "(relayer:", relayer, ")");

  // 5. Wiring — point Casino at the HouseManager contract.
  let tx = await casino.setHouseManager(hmAddr);
  await tx.wait();
  console.log("[deploy] Casino.houseManager ←", hmAddr);

  // 6. Initial bankroll
  if (Number(INITIAL_BANKROLL_ETH) > 0) {
    tx = await deployer.sendTransaction({
      to: casinoAddr,
      value: ethers.parseEther(INITIAL_BANKROLL_ETH),
    });
    await tx.wait();
    console.log(`[deploy] funded bankroll: ${INITIAL_BANKROLL_ETH} STT`);
  }

  // 7. Provision initial seed batch. Save unrevealed seeds for the house service.
  const seeds = [];
  const hashes = [];
  for (let i = 0; i < SEED_BATCH_SIZE; i++) {
    const s = genServerSeed();
    seeds.push(s);
    hashes.push(hashServerSeed(s));
  }
  // The HM is now the contract; we still own the casino so we can call
  // provisionSeedHashes via the owner fallback path.
  tx = await casino.provisionSeedHashes(hashes);
  await tx.wait();
  console.log(`[deploy] provisioned ${SEED_BATCH_SIZE} seed hashes`);

  // 8. Write deployment manifest.
  const out = {
    network: net,
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    deployer: deployer.address,
    deploymentBlock: casinoDeployBlock,
    addresses: {
      casino: casinoAddr,
      houseManager: hmAddr,
      agentQuorumVerifier: verifierAddr,
      playerAgentRegistry: regAddr,
    },
    agents: { platform: AGENT_PLATFORM, llmAgentId: LLM_AGENT_ID.toString() },
    seedBatch: { size: SEED_BATCH_SIZE, firstHashIdx: 0 },
    deployedAt: new Date().toISOString(),
  };
  const manifestDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(manifestDir, { recursive: true });
  const manifestPath = path.join(manifestDir, `${net}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(out, null, 2));
  console.log("[deploy] manifest →", manifestPath);

  // Copy into frontend/deployments/ so the static site can fetch it via
  // a same-origin GET (the HTTP server is rooted at frontend/).
  const frontendDeploymentsDir = path.join(__dirname, "..", "frontend", "deployments");
  fs.mkdirSync(frontendDeploymentsDir, { recursive: true });
  const frontendManifestPath = path.join(frontendDeploymentsDir, `${net}.json`);
  fs.copyFileSync(manifestPath, frontendManifestPath);
  console.log("[deploy] manifest (frontend copy) →", frontendManifestPath);

  // Save seeds OUTSIDE git (operator must guard this file). Used by the
  // house service to call casino.revealAndSettle once bets mature.
  const seedsDir = path.join(__dirname, "..", "deployments", "seeds");
  fs.mkdirSync(seedsDir, { recursive: true });
  const seedsPath = path.join(seedsDir, `${net}-${Date.now()}.json`);
  fs.writeFileSync(seedsPath, JSON.stringify({ seeds, hashes }, null, 2));
  console.log("[deploy] seeds (DO NOT COMMIT) →", seedsPath);

  // Update frontend config.
  const cfgPath = path.join(__dirname, "..", "frontend", "lib", "config.js");
  const networkLabel = net === "somniaTestnet" || net === "hardhat" ? "somniaTestnet" : "somniaMainnet";
  const PRIVY_APP_ID = process.env.Privy_App_Id || process.env.PRIVY_APP_ID || "";
  const cfgContent = `// Auto-written by scripts/deploy.js. Live addresses below — re-run
// \`npm run deploy:testnet\` to overwrite (don't edit by hand).
export const CONFIG = {
  network: "${networkLabel}",
  casino: "${casinoAddr}",
  registry: "${regAddr}",
  houseManager: "${hmAddr}",
  agentVerifier: "${verifierAddr}",
  agentPlatform: "${AGENT_PLATFORM}",
  agentServiceUrl: "${process.env.AGENT_SERVICE_URL || "http://localhost:3001"}",
  // Privy app ID — published, not a secret. Lives in .env as Privy_App_Id.
  privyAppId: "${PRIVY_APP_ID}",
  // Public Somnia Provider App ID per docs.somnia.network — Global Wallet.
  somniaProviderAppId: "cm8d9yzp2013kkr612h8ymoq8",
  agentIds: {
    json:  "${process.env.AGENT_ID_JSON  || "131742929374160097713"}",
    llm:   "${LLM_AGENT_ID.toString()}",
    parse: "${process.env.AGENT_ID_PARSE || "128754011420709690852"}",
    hm:    "${process.env.AGENT_ID_HM    || "119284756103948572617"}",
  },
};

// Expose to the non-module partials.js loader so it can render real
// addresses / agent IDs / network in the boot animation lines and footer.
// Also expose as SHINYLUCK_CONFIG so the Privy vendor bundle finds privyAppId.
if (typeof window !== "undefined") {
  window.SL_CONFIG = CONFIG;
  window.SHINYLUCK_CONFIG = CONFIG;
  document.dispatchEvent(new CustomEvent("shinyluck:config", { detail: CONFIG }));
}
`;
  fs.writeFileSync(cfgPath, cfgContent);
  console.log("[deploy] frontend config updated");

  // 9. Verify (best-effort — only on real networks).
  if (net !== "hardhat" && net !== "localhost") {
    console.log("[deploy] verifying on explorer (best-effort)…");
    for (const [name, addr, args] of [
      ["Casino", casinoAddr, [deployer.address]],
      ["HouseManager", hmAddr, [casinoAddr, hmAgent]],
      ["AgentQuorumVerifier", verifierAddr, [casinoAddr, AGENT_PLATFORM, LLM_AGENT_ID.toString()]],
      ["PlayerAgentRegistry", regAddr, [casinoAddr, relayer]],
    ]) {
      try {
        await run("verify:verify", { address: addr, constructorArguments: args });
        console.log(`[deploy] verified ${name}`);
      } catch (e) {
        console.warn(`[deploy] verify ${name} failed: ${e.message}`);
      }
    }
  }

  console.log("[deploy] done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
