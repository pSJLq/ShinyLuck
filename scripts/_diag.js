// One-off diagnostic - bankroll + balances + bet state.
const { ethers } = require("ethers");
const fs = require("fs");
require("dotenv").config();
(async () => {
  const m = JSON.parse(fs.readFileSync("deployments/somniaTestnet.json"));
  const provider = new ethers.JsonRpcProvider(process.env.RPC_TESTNET || "https://dream-rpc.somnia.network");
  const head = await provider.getBlockNumber();
  const dep = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const depBal = await provider.getBalance(dep.address);
  const casinoBal = await provider.getBalance(m.addresses.casino);
  const hmBal = await provider.getBalance(m.addresses.houseManager);
  const abi = [
    "function freeBankroll() view returns(uint256)",
    "function reservedBankroll() view returns(uint256)",
    "function totalBets() view returns(uint256)",
    "function nextSeedIdx() view returns(uint256)",
  ];
  const c = new ethers.Contract(m.addresses.casino, abi, provider);
  const [free, reserved, total, nextSeed] = await Promise.all([
    c.freeBankroll().catch(() => 0n),
    c.reservedBankroll().catch(() => 0n),
    c.totalBets().catch(() => 0n),
    c.nextSeedIdx().catch(() => 0n),
  ]);
  console.log("Head block:", head, "(deploy at:", m.deploymentBlock, "lookback ok:", head - m.deploymentBlock < 20000, ")");
  console.log("Deployer:", dep.address, "balance:", ethers.formatEther(depBal), "STT");
  console.log("Casino:  ", m.addresses.casino, "balance:", ethers.formatEther(casinoBal), "STT");
  console.log("HM:      ", m.addresses.houseManager, "balance:", ethers.formatEther(hmBal), "STT");
  console.log("Casino freeBankroll:    ", ethers.formatEther(free), "STT");
  console.log("Casino reservedBankroll:", ethers.formatEther(reserved), "STT");
  console.log("Casino totalBets:       ", total.toString());
  console.log("Casino nextSeedIdx:     ", nextSeed.toString());
})().catch(e => { console.error("ERR:", e.message); process.exit(1); });
