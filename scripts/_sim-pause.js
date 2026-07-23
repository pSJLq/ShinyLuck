// sim rig helper: pause/unpause games on the local casino
const { ethers } = require("hardhat");
const fs = require("fs"), path = require("path");
async function main() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "simlag.json"), "utf8"));
  const c = await ethers.getContractAt("Casino", m.addresses.casino);
  const mode = process.env.SIM_GAME_MODE || "pause";
  const games = (process.env.SIM_GAMES || "1,5").split(",").map(Number);
  for (const g of games) {
    await (await (mode === "pause" ? c.pauseGame(g) : c.unpauseGame(g))).wait();
    console.log(`${mode}d game ${g}`);
  }
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
