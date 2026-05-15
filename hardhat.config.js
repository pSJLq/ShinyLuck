require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const RPC_TESTNET = process.env.RPC_TESTNET || "https://dream-rpc.somnia.network";
const RPC_MAINNET = process.env.RPC_MAINNET || "";

const accounts = PRIVATE_KEY ? [PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1,           // optimize for deploy size — Casino.sol is at ~30KB
                           // pre-optimisation. testnet gas is cheap so trading
                           // a bit of runtime efficiency for deployability is
                           // a fair trade. Bump back to 200+ once Casino is
                           // split into libraries.
      },
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
      allowUnlimitedContractSize: true,   // Casino.sol is ~30KB after the
                                          // round-based + slots-5x3 rewrite.
                                          // Somnia testnet doesn't enforce
                                          // EIP-170 strictly; allow large
                                          // deploys in tests too.
    },
    somniaTestnet: {
      url: RPC_TESTNET,
      chainId: 50312,
      accounts,
      allowUnlimitedContractSize: true,
    },
    // Somnia Mainnet — раскомментировать перед шагом 19 (final deploy).
    // somniaMainnet: {
    //   url: process.env.RPC_MAINNET || "https://api.infra.mainnet.somnia.network/",
    //   chainId: 5031,
    //   accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    // },
  },
  etherscan: {
    apiKey: {
      somniaTestnet: "empty",
      // somniaMainnet: "empty",
    },
    customChains: [
      {
        network: "somniaTestnet",
        chainId: 50312,
        urls: {
          apiURL: "https://shannon-explorer.somnia.network/api",
          browserURL: "https://shannon-explorer.somnia.network",
        },
      },
      // {
      //   network: "somniaMainnet",
      //   chainId: 5031,
      //   urls: {
      //     apiURL: "https://explorer.somnia.network/api",
      //     browserURL: "https://explorer.somnia.network",
      //   },
      // },
    ],
  },
  sourcify: {
    enabled: false,
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  mocha: {
    timeout: 120000,
  },
};
