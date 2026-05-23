// Top up the live Casino's bankroll. Reads target casino addr from the
// deployments manifest (or env var). Calls depositBankroll() - emits
// BankrollDeposited which the subgraph / livedata can pick up.
//
//   AMOUNT=30 npx hardhat run scripts/topup-bankroll.js --network somniaTestnet

const { ethers, network } = require("hardhat");
const path = require("path");
const fs = require("fs");

async function main() {
  const dep = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"),
  );
  const CASINO = process.env.CASINO_ADDRESS || dep.addresses.casino;
  const AMOUNT_STT = process.env.AMOUNT || "30";
  const AMOUNT = ethers.parseEther(String(AMOUNT_STT));

  const [deployer] = await ethers.getSigners();
  const casino = await ethers.getContractAt("Casino", CASINO);

  const beforeCasino = await ethers.provider.getBalance(CASINO);
  const beforeFree   = await casino.freeBankroll();
  const beforeMaxBps = await casino.maxBetBps();
  console.log(`[topup-bankroll] casino=${CASINO}`);
  console.log(`[topup-bankroll] balance before:      ${ethers.formatEther(beforeCasino)} STT`);
  console.log(`[topup-bankroll] freeBankroll before: ${ethers.formatEther(beforeFree)} STT`);
  console.log(`[topup-bankroll] maxBetBps:           ${beforeMaxBps}  (effective cap = freeBankroll * bps / 10000)`);
  console.log(`[topup-bankroll] depositing:          ${AMOUNT_STT} STT`);

  const tx = await casino.depositBankroll({ value: AMOUNT });
  console.log(`[topup-bankroll] tx=${tx.hash}`);
  await tx.wait();

  const afterCasino = await ethers.provider.getBalance(CASINO);
  const afterFree   = await casino.freeBankroll();
  const effectiveMax = (afterFree * BigInt(beforeMaxBps)) / 10000n;
  console.log(`[topup-bankroll] balance after:       ${ethers.formatEther(afterCasino)} STT`);
  console.log(`[topup-bankroll] freeBankroll after:  ${ethers.formatEther(afterFree)} STT`);
  console.log(`[topup-bankroll] effective max stake: ${ethers.formatEther(effectiveMax)} STT  (bankroll * ${beforeMaxBps}/10000)`);
}
main().catch(e => { console.error(e); process.exit(1); });
