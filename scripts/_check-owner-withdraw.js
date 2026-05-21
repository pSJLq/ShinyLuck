const { ethers } = require("hardhat");
const path = require("path");
const dep = require(path.join(__dirname, "..", "deployments", "somniaTestnet.json"));
(async () => {
  const casino = await ethers.getContractAt("Casino", dep.addresses.casino);
  const pw = await casino.ownerWithdrawal();
  const now = BigInt(Math.floor(Date.now() / 1000));
  console.log("pending owner withdraw:", ethers.formatEther(pw.amount), "STT, readyAt:", pw.readyAt.toString());
  console.log("now:", now.toString(), " ready in:", (Number(pw.readyAt) - Number(now)) / 3600, "hours");
})();
