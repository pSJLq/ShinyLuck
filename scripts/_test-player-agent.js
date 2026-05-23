// E2E test of the on-chain Player Agent dispatcher.
//
//   1. Register the deployer EOA as a player agent (allowed games = DICE)
//   2. Fund the freshly-deployed AgentVault with 1 STT
//   3. Manually call HM.requestPlayerDecision(deployer)  (skips waiting for the
//      hourly cron tick - same code path, just trigger-able now)
//   4. Poll for the PlayerDecisionResolved event - reports LLM decision +
//      whether a bet was actually placed.
//
//   npx hardhat run scripts/_test-player-agent.js --network somniaTestnet

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [signer] = await ethers.getSigners();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"),
  );
  const hmAddr  = manifest.addresses.houseManager;
  const regAddr = manifest.addresses.playerAgentRegistry;
  const casinoAddr = manifest.addresses.casino;

  const hm = await ethers.getContractAt("HouseManager", hmAddr, signer);
  const reg = await ethers.getContractAt("PlayerAgentRegistry", regAddr, signer);

  console.log(`signer:   ${signer.address}`);
  console.log(`HM:       ${hmAddr}`);
  console.log(`Registry: ${regAddr}\n`);

  // Step 1: register if not already
  const perm = await reg.permissions(signer.address);
  let vaultAddr;
  if (perm.player === ethers.ZeroAddress) {
    // allow DICE (bit 0), SLOTS (bit 2), CLUSTER (bit 6) = 0b1000101 = 69
    const mask = (1 << 0) | (1 << 2) | (1 << 6);
    console.log(`Registering agent (allowedGames mask=${mask}, dailyLimit=2, totalLimit=10)…`);
    const tx = await reg.registerAgent(
      ethers.ZeroHash,           // strategyHash placeholder
      ethers.parseEther("2"),     // dailyLimit 2 STT
      ethers.parseEther("10"),    // totalLimit 10 STT
      mask,
      { value: 0n },
    );
    const r = await tx.wait();
    const evt = r.logs
      .map((l) => { try { return reg.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === "AgentRegistered");
    vaultAddr = evt.args.vault;
    console.log(`  registered. vault=${vaultAddr}, tx=${tx.hash}`);
  } else {
    vaultAddr = perm.vault;
    console.log(`Already registered. vault=${vaultAddr}`);
  }

  // Step 2: fund the vault with 1 STT if it's empty
  const vaultBal = await ethers.provider.getBalance(vaultAddr);
  console.log(`vault balance: ${ethers.formatEther(vaultBal)} STT`);
  if (vaultBal < ethers.parseEther("1")) {
    const need = ethers.parseEther("1") - vaultBal;
    console.log(`Funding vault with ${ethers.formatEther(need)} STT…`);
    const tx = await signer.sendTransaction({ to: vaultAddr, value: need });
    await tx.wait();
    console.log(`  tx=${tx.hash}`);
  }

  // Step 3: manually trigger the LLM decision (owner can call directly)
  console.log(`\nFiring HM.requestPlayerDecision(${signer.address.slice(0,10)}…)…`);
  const startBlock = await ethers.provider.getBlockNumber();
  const reqTx = await hm.requestPlayerDecision(signer.address);
  const reqReceipt = await reqTx.wait();
  console.log(`  tx=${reqTx.hash} @ block ${reqReceipt.blockNumber}`);
  let requestId = null;
  for (const log of reqReceipt.logs) {
    try {
      const p = hm.interface.parseLog(log);
      if (!p) continue;
      if (p.name === "PlayerDecisionRequested") {
        requestId = p.args.requestId.toString();
        console.log(`  → PlayerDecisionRequested: requestId=${requestId}, vault=${ethers.formatEther(p.args.vaultBalance)} STT, spentToday=${ethers.formatEther(p.args.spentTodayWei)}/${ethers.formatEther(p.args.dailyLimitWei)} STT`);
      }
      if (p.name === "AgentRequestSkipped") {
        console.log(`  ⚠ Skipped: ${p.args.kind} → ${p.args.reason}`);
      }
    } catch (_) {}
  }
  if (!requestId) {
    console.error("\n❌ Request did not fire.");
    return;
  }

  // Step 4: poll up to 5 minutes for the resolution event
  console.log(`\nPolling for LLM callback (up to 5 min)…`);
  const tStart = Date.now();
  let resolved = null;
  while (Date.now() - tStart < 300_000 && !resolved) {
    const head = await ethers.provider.getBlockNumber();
    let from = startBlock;
    while (from <= head && !resolved) {
      const to = Math.min(from + 900, head);
      const logs = await ethers.provider.send("eth_getLogs", [{
        address: hmAddr,
        fromBlock: "0x" + from.toString(16),
        toBlock: "0x" + to.toString(16),
      }]);
      for (const raw of logs) {
        try {
          const p = hm.interface.parseLog({ topics: raw.topics, data: raw.data });
          if (p.name === "PlayerDecisionResolved" && p.args.requestId.toString() === requestId) {
            resolved = p.args;
            break;
          }
          if (p.name === "AgentRequestSkipped") {
            console.log(`  ⚠ Skipped: ${p.args.kind} → ${p.args.reason}`);
          }
        } catch (_) {}
      }
      from = to + 1;
    }
    if (!resolved) { process.stdout.write("."); await new Promise((r) => setTimeout(r, 10000)); }
  }
  console.log();
  if (resolved) {
    console.log(`\n🎉 ON-CHAIN PLAYER AGENT VERIFIED.`);
    console.log(`   decision : "${resolved.decision}"`);
    console.log(`   game id  : ${resolved.game}`);
    console.log(`   stake    : ${ethers.formatEther(resolved.stakeWei)} STT`);
    console.log(`   placed   : ${resolved.placed}`);
    if (resolved.placed) console.log(`   betId    : ${resolved.betId}`);
  } else {
    console.warn(`⏱ No PlayerDecisionResolved within 5 min.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
