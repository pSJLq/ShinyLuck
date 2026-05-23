// Smoke test on the LIVE deployment - place 1 dice bet, 1 sugar bet, 1
// vault7 bet, wait for reveal-bot to settle each.
//
//   npx hardhat run scripts/_smoke-test.js --network somniaTestnet
//
// Assumes reveal-bot.js is running with SEEDS_FILE pointing at the seed
// batch this deployment provisioned.

const { ethers, network } = require("hardhat");
const path = require("path");

const dep = require(path.join(__dirname, "..", "deployments", `${network.name}.json`));

async function placeAndWait(casino, signer, label, fn) {
  console.log(`\n[smoke] ${label}: placing…`);
  const tx = await fn();
  const receipt = await tx.wait();
  // pull betId from the BetPlaced event
  const betPlacedEv = receipt.logs.map(l => { try { return casino.interface.parseLog(l); } catch { return null; } })
    .filter(Boolean).find(e => e.name === "BetPlaced");
  if (!betPlacedEv) { console.error(`[smoke] ${label}: no BetPlaced event!`); return null; }
  const betId = betPlacedEv.args.betId;
  console.log(`[smoke] ${label}: betId=${betId} tx=${tx.hash}, waiting for settle…`);

  // Poll getBet(betId).status - Somnia logs miss the `removed` field which
  // ethers v6 rejects on subscribe, so we can't use casino.on("BetSettled").
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 4000));
    const bet = await casino.getBet(betId);
    if (Number(bet.status) === 1) {  // 1 = settled
      console.log(`[smoke] ${label}: SETTLED won=${bet.won} payout=${ethers.formatEther(bet.payout)} STT`);
      return { id: betId, won: bet.won, payout: bet.payout };
    }
    if (Number(bet.status) === 2) {  // 2 = refunded
      console.log(`[smoke] ${label}: REFUNDED`);
      return { id: betId, refunded: true };
    }
  }
  throw new Error(`${label}: settle timeout (180s)`);
}

async function main() {
  const [signer] = await ethers.getSigners();
  const casino = await ethers.getContractAt("Casino", dep.addresses.casino, signer);
  console.log(`[smoke] casino=${dep.addresses.casino} signer=${signer.address}`);
  const before = await ethers.provider.getBalance(signer.address);
  console.log(`[smoke] deployer balance pre: ${ethers.formatEther(before)} STT`);

  // 1) DICE  - over 50, 1.99x payout, 0.01 STT stake
  const cs1 = ethers.hexlify(ethers.randomBytes(32));
  await placeAndWait(casino, signer, "DICE",
    () => casino.placeDiceBet(50, true, cs1, { value: ethers.parseEther("0.01") }));

  // 2) SUGAR - 0.001 STT stake (cluster cap 2500x → reserves 2.5 STT)
  const cs2 = ethers.hexlify(ethers.randomBytes(32));
  await placeAndWait(casino, signer, "SUGAR",
    () => casino.placeClusterBet(cs2, false, { value: ethers.parseEther("0.001") }));

  // 3) VAULT - 0.005 STT stake (cap 2000x → reserves 10 STT). Min is 20 wei.
  const cs3 = ethers.hexlify(ethers.randomBytes(32));
  await placeAndWait(casino, signer, "VAULT",
    () => casino.placeSlotsBet(cs3, false, { value: ethers.parseEther("0.005") }));

  const after = await ethers.provider.getBalance(signer.address);
  console.log(`\n[smoke] deployer balance post: ${ethers.formatEther(after)} STT`);
  console.log(`[smoke] net change: ${ethers.formatEther(after - before)} STT`);
  console.log("[smoke] done.");
}
main().catch(e => { console.error(e); process.exit(1); });
