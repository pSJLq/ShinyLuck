// ShinyPoker frontend config. Addresses are auto-written by
// scripts/deploy-poker.js — don't edit the address block by hand.
export const POKER_CONFIG = {
  network: "somniaTestnet",
  // --- deployed addresses (filled in on deploy) ---
  pokerRoom: "0x7E1387FCE14522B981C07bca921e857CfeD636e3",
  commitRevealDealer: "0x551C3ee9352199Ad0b100D7deD0fD13637B30E79",
  pokerTournament: "0xB4808411903Fb8e2Eee23bceB9f274943EDAf766",
  playerProfile: "0x7364E1ED8a07b4659c059fa66D346c42907C3F14", // on-chain nicknames (PlayerProfile.sol) — filled on deploy
  avatarStore: "0x20c39988b480485aD2a9715c32Ff1866Ea890Ec4", // on-chain uploaded avatars (AvatarStore.sol)
  zkDealerV2: "0x292Ef0e15fC62613B00c55b0eEAC38279Efdb67D", // EXPERIMENTAL zkShuffle v2 on-chain verifier (ZkDealerV2.sol)
  // Off-chain dealer bot's hole-card API (serves each player only their cards).
  dealerApiUrl: "http://localhost:3002",
  // Reciprocal link back to the ShinyLuck casino (Casino⇄Poker switcher).
  casinoUrl: "https://shiny-luck.vercel.app/",
  // Same Privy app as ShinyLuck → same embedded Somnia wallet across both
  // products (email login, headless txs, no popups). Published, not a secret.
  privyAppId: "cmp9pb26g01py0cjlks1njki1",
};

export const NETWORKS = {
  somniaTestnet: {
    chainId: 50312,
    chainIdHex: "0xC488",
    name: "Somnia Testnet (Shannon)",
    rpcUrls: ["https://api.infra.testnet.somnia.network"],
    wsUrl: "wss://api.infra.testnet.somnia.network/ws",
    explorer: "https://shannon-explorer.somnia.network",
    currency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  },
  somniaMainnet: {
    chainId: 5031,
    chainIdHex: "0x13A7",
    name: "Somnia",
    rpcUrls: ["https://api.infra.mainnet.somnia.network"],
    wsUrl: "wss://api.infra.mainnet.somnia.network/ws",
    explorer: "https://explorer.somnia.network",
    currency: { name: "Somnia", symbol: "SOMI", decimals: 18 },
  },
};

export const NETWORK = NETWORKS[POKER_CONFIG.network];

if (typeof window !== "undefined") {
  window.POKER_CONFIG = POKER_CONFIG;
  // The reused Privy vendor bundle reads window.SHINYLUCK_CONFIG.{privyAppId,network}.
  window.SHINYLUCK_CONFIG = Object.assign({}, window.SHINYLUCK_CONFIG, {
    privyAppId: POKER_CONFIG.privyAppId,
    network: POKER_CONFIG.network,
  });
  document.dispatchEvent(new CustomEvent("shinypoker:config", { detail: POKER_CONFIG }));
}
