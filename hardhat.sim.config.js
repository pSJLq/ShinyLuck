// Hardhat config for the casino LOAD SIMULATION rig only.
//
// Same compilers/paths as hardhat.config.js, but the in-process node mines on
// a 101ms interval instead of auto-mining per tx — that is Somnia's measured
// block time (scripts/_casino-probe.js), and block cadence is what sets the
// 256-block reveal window the settle bot has to beat.
//
//   npx hardhat --config hardhat.sim.config.js node
const base = require("./hardhat.config.js");

module.exports = {
  ...base,
  networks: {
    ...base.networks,
    hardhat: {
      ...base.networks.hardhat,
      mining: { auto: false, interval: 101 },
      // 50 player wallets + bot + deployer
      accounts: { count: 60, accountsBalance: "10000000000000000000000" },
      gas: 30_000_000,
      blockGasLimit: 30_000_000,
    },
    // players + bot talk to the node through the lag proxy (_rpc-lag-proxy.js)
    // so every RPC call carries the real Somnia round-trip
    simlag: {
      url: process.env.SIM_RPC || "http://127.0.0.1:8546",
      chainId: 31337,
      accounts: process.env.SIM_BOT_KEY ? [process.env.SIM_BOT_KEY] : [],
      allowUnlimitedContractSize: true,
      timeout: 120000,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
      allowUnlimitedContractSize: true,
      timeout: 120000,
    },
  },
};
