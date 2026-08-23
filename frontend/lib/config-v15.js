// Auto-written by scripts/deploy-v15.js — do not edit by hand.
export const CONFIG_V15 = {
  "network": "somniaTestnet",
  "chainId": "50312",
  "addresses": {
    "vault": "0x6497D80cCd713F0BD4d8B22CE96Eae0F92EC7Cca",
    "loyalty": "0xDc75211541dF47D5023ae74A873194ad5296c22a",
    "timelock": null
  },
  "games": [
    {
      "id": 0,
      "name": "dice",
      "kind": "single-shot",
      "module": "0x531b7BB7076Bb7181f374A5D4E0CEc7a57CBa66B"
    },
    {
      "id": 1,
      "name": "crash",
      "kind": "round",
      "module": "0xb96Fb6e3C6fb82acB448e53a3cb59e09f2B0ABD3"
    },
    {
      "id": 2,
      "name": "vault7",
      "kind": "slot",
      "module": "0xEB0221E338ba0b054571a00282f875f729E69A6A"
    },
    {
      "id": 3,
      "name": "mines",
      "kind": "multi-step",
      "module": "0x3B958cFfe3b282908BdD85E2f8cEAf94CBcc87E8"
    },
    {
      "id": 4,
      "name": "plinko",
      "kind": "single-shot",
      "module": "0x47026C7FF5393BB962f26179FA89E5498F2b29A6"
    },
    {
      "id": 5,
      "name": "roulette",
      "kind": "round",
      "module": "0xEA30b4c708A780A600D8dE792ae0D1F0D1ab37DF"
    },
    {
      "id": 6,
      "name": "cluster",
      "kind": "slot",
      "module": "0x37d984410718BA70066aE9A897C6DfeC57049dC4"
    }
  ],
  "deploymentBlock": 443910973,
  "previousModules": [
    {
      "name": "vault7",
      "id": 2,
      "module": "0x0d8DfE977893A3d53552cA93f0f6e4B090d5DB14"
    },
    {
      "name": "cluster",
      "id": 6,
      "module": "0x6C03aB85F121D9f576ec1DD117D822e769c9d1C1"
    },
    {
      "name": "mines",
      "id": 3,
      "module": "0x10F76C3D9eF3E694bCEF3A5d171D39eb539E7f58"
    },
    {
      "name": "crash",
      "id": 1,
      "module": "0x469281C5DE93ff1cB6C876D2a03f5733AE3dbC27"
    },
    {
      "name": "roulette",
      "id": 5,
      "module": "0x38d52FFBE6884B50B22e4964C60Cb2495a3b67eb"
    },
    {
      "name": "dice",
      "id": 0,
      "module": "0xcB9fCE13969da659b871D245dF1436e78ecD1bEe"
    }
  ]
};
// partials.js is a classic script and cannot import this module, but it needs
// the Vault address for the footer's Contracts column. Publish it so the shell
// uses the deployed value instead of its hard-coded fallback.
if (typeof window !== "undefined") window.SL_V15 = CONFIG_V15;
export default CONFIG_V15;
