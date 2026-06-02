const { ethers } = require("hardhat");
const dep = require("../deployments/somniaTestnet.json");
const RPC="https://api.infra.testnet.somnia.network";
const VAULT="0xa3Be7a363B660F8bfd7D969aA2e2eCa811549D5d";
async function main(){
  const provider=new ethers.JsonRpcProvider(RPC);
  const casino=await ethers.getContractAt("Casino", dep.addresses.casino, provider);
  const cs="0x"+"cd".repeat(32);
  try{ await casino.placeDiceBet.staticCall(60,true,cs,{value:ethers.parseEther("0.02"),from:VAULT}); console.log("placeDiceBet staticCall: OK - seeds available now"); }
  catch(e){ const d=e.data||(e.info&&e.info.error&&e.info.error.data); console.log("still reverts:", d||e.shortMessage||e.message); }
}
main().catch(e=>{console.error("ERR:",e.shortMessage||e.message);process.exit(1);});
