// Wraps ethers Wallet with Casino + Registry contract instances.

const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

function loadAbi(name) {
  // Hardhat artifacts live in ../artifacts/contracts/<Name>.sol/<Name>.json
  const p = path.join(__dirname, "..", "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  return JSON.parse(fs.readFileSync(p, "utf8")).abi;
}

function loadManifest() {
  try {
    const net = process.env.NETWORK_NAME || "somniaTestnet";
    return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${net}.json`), "utf8"));
  } catch (_) { return null; }
}

function init() {
  const rpc = process.env.RPC_URL;
  const key = process.env.RELAYER_KEY;
  // Addresses come from the COMMITTED deployment manifest (single source of
  // truth, auto-written by deploy.js and shipped to Railway via git), so a
  // redeploy can never strand the bots on a stale casino. Env is fallback only.
  const m = loadManifest();
  const casinoAddr = (m && m.addresses && m.addresses.casino) || process.env.CASINO_ADDRESS;
  const regAddr = (m && m.addresses && m.addresses.playerAgentRegistry) || process.env.REGISTRY_ADDRESS;
  if (!rpc || !key || !casinoAddr || !regAddr) {
    throw new Error("missing RPC_URL / RELAYER_KEY / CASINO_ADDRESS / REGISTRY_ADDRESS");
  }
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(key, provider);
  const casinoAbi = loadAbi("Casino");
  const regAbi = loadAbi("PlayerAgentRegistry");
  const casino = new ethers.Contract(casinoAddr, casinoAbi, wallet);
  const registry = new ethers.Contract(regAddr, regAbi, wallet);
  return { provider, wallet, casino, registry, casinoAbi };
}

module.exports = { init, loadAbi };
