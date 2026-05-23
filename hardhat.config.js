require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
// Canonical Somnia infra RPC per emrestay's official examples + somnia-devrel
// SKILL. The dream-rpc.somnia.network mirror is the public fallback.
const RPC_TESTNET = process.env.RPC_TESTNET || "https://api.infra.testnet.somnia.network";
const RPC_MAINNET = process.env.RPC_MAINNET || "";

const accounts = PRIVATE_KEY ? [PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    compilers: [
      {
        version: "0.8.24",
        settings: {
          optimizer: { enabled: true, runs: 1 },
          viaIR: true,
        },
      },
      {
        // SomniaEventHandler from @somnia-chain/reactivity-contracts pins
        // pragma solidity 0.8.30 exactly. HouseManager extends it, so it and
        // the vendored helpers compile with 0.8.30 via the overrides below.
        // Casino + the rest stay on 0.8.24 - bumping the whole tree to 0.8.30
        // would shift gas costs across all 125 existing tests.
        version: "0.8.30",
        settings: {
          optimizer: { enabled: true, runs: 1 },
          viaIR: true,
        },
      },
    ],
    overrides: {
      "contracts/HouseManager.sol": { version: "0.8.30", settings: { optimizer: { enabled: true, runs: 1 }, viaIR: true } },
      "node_modules/@somnia-chain/reactivity-contracts/contracts/SomniaEventHandler.sol": { version: "0.8.30", settings: { optimizer: { enabled: true, runs: 1 }, viaIR: true } },
      "node_modules/@somnia-chain/reactivity-contracts/contracts/interfaces/ISomniaEventHandler.sol": { version: "0.8.30", settings: { optimizer: { enabled: true, runs: 1 }, viaIR: true } },
      "node_modules/@somnia-chain/reactivity-contracts/contracts/interfaces/ISomniaReactivityPrecompile.sol": { version: "0.8.30", settings: { optimizer: { enabled: true, runs: 1 }, viaIR: true } },
      "node_modules/@somnia-chain/reactivity-contracts/contracts/interfaces/SomniaExtensions.sol": { version: "0.8.30", settings: { optimizer: { enabled: true, runs: 1 }, viaIR: true } },
      "node_modules/@somnia-chain/reactivity-contracts/contracts/interfaces/IERC165.sol": { version: "0.8.30", settings: { optimizer: { enabled: true, runs: 1 }, viaIR: true } },
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
    // Somnia Mainnet - раскомментировать перед шагом 19 (final deploy).
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
