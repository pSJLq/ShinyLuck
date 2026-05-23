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

// Somnia Agent Platform addresses per the public docs
//   (docs.somnia.network/agents/invoking-agents/from-solidity):
//   - Mainnet (chain 5031):  0x5E5205CF39E766118C01636bED000A54D93163E6
//   - Testnet (chain 50312): 0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776
// We default by network name and fall back to env override. Hardcoding the
// mainnet address on testnet was silently breaking every agent invocation
// (eth_getCode returns 0x at that addr on Somnia Shannon), which is why
// AgentQuorumVerifier never produced QuorumResult events historically.
const AGENT_PLATFORM_BY_NET = {
  somniaTestnet: "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776",
  somniaMainnet: "0x5E5205CF39E766118C01636bED000A54D93163E6",
  hardhat:       "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776",
};
// IMPORTANT: this is the TESTNET LLM Inference Agent ID. The old default
// (`128472938475610293844`, 21 digits) was a typo in docs we pulled from -
// it doesn't exist on the testnet AgentPlatform and every createRequest
// reverted with `AgentNotFound(uint256)`. The actual on-chain ID is the
// 20-digit value below. Confirmed via internal-txs to 0x037Bb9C7… on
// Shannon Explorer: only 12847293847561029384 + 12875401142070969085 appear
// as agentId arguments in real createAdvancedRequest calls.
const LLM_AGENT_ID = BigInt(process.env.AGENT_ID_LLM || "12847293847561029384");

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
  const AGENT_PLATFORM = process.env.AGENT_PLATFORM
    || AGENT_PLATFORM_BY_NET[net]
    || AGENT_PLATFORM_BY_NET.somniaTestnet;
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`[deploy] network=${net}, deployer=${deployer.address}, balance=${ethers.formatEther(balance)}`);
  console.log(`[deploy] agentPlatform=${AGENT_PLATFORM} (LLM agent ${LLM_AGENT_ID})`);

  // Record the block we start at - reveal-bot uses this as its scan floor so
  // it doesn't replay every block of network history on cold start.
  const deploymentBlock = await ethers.provider.getBlockNumber();

  // 1. Casino - Vault7Lib + ClusterLib are imported with `internal` functions,
  //    so Solidity inlines them into the Casino bytecode (no library linking).
  const Casino = await ethers.getContractFactory("Casino");
  const casino = await Casino.deploy(deployer.address);
  await casino.waitForDeployment();
  const casinoAddr = await casino.getAddress();
  const casinoDeployTx = casino.deploymentTransaction();
  const casinoDeployBlock = casinoDeployTx ? casinoDeployTx.blockNumber : deploymentBlock;
  console.log("[deploy] Casino:", casinoAddr, "@ block", casinoDeployBlock);

  // 2. HouseManager - caller key for off-chain HM agent. Defaults to deployer if not set.
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

  // 4. PlayerAgentRegistry - relayer = HM_AGENT or deployer
  const relayer = RELAYER || deployer.address;
  const Reg = await ethers.getContractFactory("PlayerAgentRegistry");
  const registry = await Reg.deploy(casinoAddr, relayer);
  await registry.waitForDeployment();
  const regAddr = await registry.getAddress();
  console.log("[deploy] PlayerAgentRegistry:", regAddr, "(relayer:", relayer, ")");

  // 5. Wiring - point Casino at the HouseManager contract.
  let tx = await casino.setHouseManager(hmAddr);
  await tx.wait();
  console.log("[deploy] Casino.houseManager ←", hmAddr);

  // 5b. Wire HM's autonomous LLM-driven RTP analyser to the Somnia Agent
  // Platform. After this, every hourly cron tick will fire an LLM Inference
  // request via the platform and the consensus response will adjust slot
  // RTP autonomously. Without this call HM emits `RtpAnalysisSkipped:
  // platform-not-wired` on every tick (graceful degradation, but the agent
  // chain stays dormant).
  try {
    tx = await houseManager.setAgentPlatform(AGENT_PLATFORM, LLM_AGENT_ID);
    await tx.wait();
    console.log("[deploy] HouseManager.agentPlatform ←", AGENT_PLATFORM, "(LLM agent", LLM_AGENT_ID.toString(), ")");
  } catch (e) {
    console.warn("[deploy] setAgentPlatform failed (HM upgrade pending?):", e.shortMessage || e.message);
  }

  // 5c. Wire HM <-> Registry for on-chain Player Agent dispatch.
  // - registry.addExecutor(hm): lets HM call registry.executeBet on
  //   behalf of users (via their AgentVault) when the LLM picks a bet.
  // - hm.setPlayerRegistry(registry): HM hourly cron iterates this
  //   registry's getActivePlayers() and fires one LLM decision per.
  try {
    tx = await registry.addExecutor(hmAddr);
    await tx.wait();
    console.log("[deploy] Registry.addExecutor ←", hmAddr);
  } catch (e) {
    console.warn("[deploy] registry.addExecutor failed:", e.shortMessage || e.message);
  }
  try {
    tx = await houseManager.setPlayerRegistry(regAddr);
    await tx.wait();
    console.log("[deploy] HouseManager.playerRegistry ←", regAddr);
  } catch (e) {
    console.warn("[deploy] hm.setPlayerRegistry failed:", e.shortMessage || e.message);
  }

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

  // Rotate historicalCasinos: parse existing config.js, pull the previous
  // `casino` + deploymentBlock, append both old + new entries. The frontend
  // aggregates BetSettled events across this list so account/leaderboard/
  // feed survive every redeploy with full lifetime history intact.
  let historical = [];
  try {
    const prevSrc = fs.readFileSync(cfgPath, "utf8");
    // Extract whole historicalCasinos array literal (lazy parse but robust).
    const histMatch = prevSrc.match(/historicalCasinos:\s*\[([\s\S]*?)\]/);
    if (histMatch) {
      const entryRe = /\{\s*address:\s*"(0x[0-9a-fA-F]{40})"\s*,\s*deploymentBlock:\s*(\d+)\s*\}/g;
      let m;
      while ((m = entryRe.exec(histMatch[1])) !== null) {
        historical.push({ address: m[1], deploymentBlock: Number(m[2]) });
      }
    } else {
      // Legacy config (no historicalCasinos yet) - try to extract just the
      // previous `casino` line and treat it as a historical entry without
      // a known deploymentBlock (frontend tolerates 0 → scans from genesis,
      // capped by Shannon Explorer page size).
      const casinoMatch = prevSrc.match(/casino:\s*"(0x[0-9a-fA-F]{40})"/);
      if (casinoMatch) historical.push({ address: casinoMatch[1], deploymentBlock: 0 });
    }
  } catch (_) { /* no previous config: first deploy, historical stays empty */ }
  // Append the freshly deployed casino with its real deployment block.
  if (!historical.some((e) => e.address.toLowerCase() === casinoAddr.toLowerCase())) {
    historical.push({ address: casinoAddr, deploymentBlock: casinoDeployBlock });
  }
  // De-dup by address (case-insensitive), preserve order.
  const seen = new Set();
  historical = historical.filter((e) => {
    const k = e.address.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const historicalLiteral = historical
    .map((e) => `    { address: "${e.address}", deploymentBlock: ${e.deploymentBlock} },`)
    .join("\n");

  const cfgContent = `// Auto-written by scripts/deploy.js. Live addresses below - re-run
// \`npm run deploy:testnet\` to overwrite (don't edit by hand).
export const CONFIG = {
  network: "${networkLabel}",
  casino: "${casinoAddr}",
  registry: "${regAddr}",
  houseManager: "${hmAddr}",
  agentVerifier: "${verifierAddr}",
  agentPlatform: "${AGENT_PLATFORM}",
  agentServiceUrl: "${process.env.AGENT_SERVICE_URL || "http://localhost:3001"}",
  // Privy app ID - published, not a secret. Lives in .env as Privy_App_Id.
  privyAppId: "${PRIVY_APP_ID}",
  // Public Somnia Provider App ID per docs.somnia.network - Global Wallet.
  somniaProviderAppId: "cm8d9yzp2013kkr612h8ymoq8",
  agentIds: {
    // Canonical Somnia agent IDs (same on mainnet + testnet) per
    // github.com/somnia-chain/agentathon references/agents.json. The
    // 21-digit values that used to live here were a copy-paste typo
    // from older docs - those IDs don't exist on the testnet platform
    // and every createRequest reverted with AgentNotFound.
    json:  "${process.env.AGENT_ID_JSON  || "13174292974160097713"}",
    llm:   "${LLM_AGENT_ID.toString()}",
    parse: "${process.env.AGENT_ID_PARSE || "12875401142070969085"}",
    hm:    "${process.env.AGENT_ID_HM    || "11928475610394857261"}",
  },
  // All historical casino deployments (oldest → newest). Aggregated by
  // livedata.js / account.js / leaderboard.js so "lifetime" stats survive
  // every redeploy. Auto-rotated here on each deploy - don't edit by hand.
  historicalCasinos: [
${historicalLiteral}
  ],
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

  // Sync agent-service/.env so the relayer + HM cron pick up the new
  // Casino/Registry/HM addresses without manual editing.
  try {
    const envPath = path.join(__dirname, "..", "agent-service", ".env");
    if (fs.existsSync(envPath)) {
      let env = fs.readFileSync(envPath, "utf8");
      const setOrInsert = (key, value) => {
        const re = new RegExp(`^${key}=.*$`, "m");
        if (re.test(env)) env = env.replace(re, `${key}=${value}`);
        else              env += `\n${key}=${value}`;
      };
      setOrInsert("CASINO_ADDRESS",   casinoAddr);
      setOrInsert("REGISTRY_ADDRESS", regAddr);
      setOrInsert("HM_ADDRESS",       hmAddr);
      fs.writeFileSync(envPath, env);
      console.log("[deploy] agent-service/.env synced");
    }
  } catch (e) { console.warn("[deploy] agent-service/.env sync skipped:", e.message); }

  // 9. Verify (best-effort - only on real networks).
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
