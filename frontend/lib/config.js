// Auto-written by scripts/deploy.js. Live addresses below - re-run
// `npm run deploy:testnet` to overwrite (don't edit by hand).
export const CONFIG = {
  network: "somniaTestnet",
  casino: "0x01D31a1aD1D82F0409dD1d5a7680065F71a3dbB3",
  registry: "0x54f686118588Ec935530C84d4752Dd7eAA95E9c9",
  houseManager: "0x74f189f46E37d742101a8242cC0E88B658c8d75d",
  agentVerifier: "0xaB37e48a5FF59a49e450ea380D270619Efc1ce02",
  agentPlatform: "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776",
  agentServiceUrl: "http://localhost:3001",
  // Privy app ID - published, not a secret. Lives in .env as Privy_App_Id.
  privyAppId: "cmp9pb26g01py0cjlks1njki1",
  // Public Somnia Provider App ID per docs.somnia.network - Global Wallet.
  somniaProviderAppId: "cm8d9yzp2013kkr612h8ymoq8",
  agentIds: {
    // Canonical Somnia agent IDs (same on mainnet + testnet) per
    // github.com/somnia-chain/agentathon references/agents.json. The
    // 21-digit values that used to live here were a copy-paste typo
    // from older docs - those IDs don't exist on the testnet platform
    // and every createRequest reverted with AgentNotFound.
    json:  "13174292974160097713",
    llm:   "12847293847561029384",
    parse: "12875401142070969085",
    hm:    "11928475610394857261",
  },
  // All historical casino deployments (oldest → newest). Aggregated by
  // livedata.js / account.js / leaderboard.js so "lifetime" stats survive
  // every redeploy. Auto-rotated here on each deploy - don't edit by hand.
  historicalCasinos: [
    { address: "0x0d397E36215Fb534F0dE4E279f505dEC3F63E4B6", deploymentBlock: 385550223 },
    { address: "0x46d37cd00F1eB308eb8a7eE864BC73774A029311", deploymentBlock: 388292876 },
    { address: "0x93104E4eA6ebb43F43e71ec51831Ef4ba6F64112", deploymentBlock: 389395940 },
    { address: "0x447b5989CaFD94204872924e4B5f684C6484c21d", deploymentBlock: 389926718 },
    { address: "0x530A3F3673049CA88184397f2bCc654E3c35eB04", deploymentBlock: 389960276 },
    { address: "0x2B78E51A0794049A453a3303A8A864779F0d5e92", deploymentBlock: 390121501 },
    { address: "0x6771De2cB1f1356a41Fb424F235C0d5896B35B9a", deploymentBlock: 390136107 },
    { address: "0x9a5D25cBc00178D3051a897568F62F1EA4540C24", deploymentBlock: 390672006 },
    { address: "0xb17CE5D7bf4eCa28580368FaD1548C99D5a2545C", deploymentBlock: 390697989 },
    { address: "0x7983E6D858cd683C243ABe71b8729861E8020F6f", deploymentBlock: 393518558 },
    { address: "0x0e969E514E86e7608966921a4D381088623ccf39", deploymentBlock: 396676068 },
    { address: "0x400Aa6cc87B13e4f5203C4DD37ea300Fdcb61CdF", deploymentBlock: 396761180 },
    { address: "0xDD9Bf933A1C6E98B559427881201d06DF77BAf3d", deploymentBlock: 396942954 },
    { address: "0x2367ffbb1f6d90e3Ee116287d4533063ceBf8AB4", deploymentBlock: 396999715 },
    { address: "0x47E6600bF736D32E09E4DD1A089C8395734AB12B", deploymentBlock: 397710670 },
    { address: "0x8Ce0eA2fC7aBDeD1F90A4A9CCAB6A66B9469633b", deploymentBlock: 398356916 },
    { address: "0xd5dB5F85aDe7e1A6296e15F8E5eB897b24241833", deploymentBlock: 401123935 },
    { address: "0xa8685Ca735F9c9a5F8133A67a1A74bc5005E2dba", deploymentBlock: 401981765 },
    { address: "0x01D31a1aD1D82F0409dD1d5a7680065F71a3dbB3", deploymentBlock: 402025580 },
  ],
};

// Expose to the non-module partials.js loader so it can render real
// addresses / agent IDs / network in the boot animation lines and footer.
// Also expose as SHINYLUCK_CONFIG so the Privy vendor bundle finds privyAppId.
if (typeof window !== "undefined") {
  window.SL_CONFIG = CONFIG;
  window.SHINYLUCK_CONFIG = CONFIG;
  document.dispatchEvent(new CustomEvent("shinyluck:config", { detail: CONFIG }));
}
