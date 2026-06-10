// ShinyPoker frontend config. Addresses are auto-written by
// scripts/deploy-poker.js — don't edit the address block by hand.
export const POKER_CONFIG = {
  network: "somniaTestnet",
  // --- deployed addresses (filled in on deploy) ---
  pokerRoom: "0xA1B2405b2F4e60fd22a818C207e9dB8F29A5f18B",
  commitRevealDealer: "0xBd74e57f0a4ad8f6F1c502a50ff9963701d93a05",
  pokerTournament: "0xefE078Fac143796aC50431Beb4e594a0956d2635",
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
