// ShinyPoker frontend config. Addresses are auto-written by
// scripts/deploy-poker.js · don't edit the address block by hand.
export const POKER_CONFIG = {
  network: "somniaTestnet",
  // --- deployed addresses (filled in on deploy) ---
  pokerRoom: "0xFeF7d1bb6c0DffaB4e13D9b49BBE1F1459266A24",
  commitRevealDealer: "",
  pokerTournament: "0xf2d3785645985618b866594cE6e924Ae35608948",
  playerProfile: "0x7364E1ED8a07b4659c059fa66D346c42907C3F14", // on-chain nicknames (PlayerProfile.sol) · filled on deploy
  avatarStore: "0x20c39988b480485aD2a9715c32Ff1866Ea890Ec4", // on-chain uploaded avatars (AvatarStore.sol)
  zkDealerV2: "0x292Ef0e15fC62613B00c55b0eEAC38279Efdb67D", // zkShuffle v2 on-chain verifier (ZkDealerV2.sol) · powers the zk-lab page
  zkTableDealer: "0x3fD6dfe201cf217A27c41878FE41faCd98B43fe8", // v2 live card layer implementing IPokerDealer (ZkTableDealer.sol)
  // "zk" = the room's dealer is ZkTableDealer (mental poker; cards decrypted in
  // the player's browser). "v1" = commit-reveal. Written by the deploy script.
  cardLayer: "zk",
  // Off-chain dealer bot's hole-card API (serves each player only their cards).
  // Same-origin path · works on any domain we serve from (shinyluck.win,
  // shinia.mom, localhost) with no CORS and no redirect on POSTs.
  dealerApiUrl: "/dealer",
  // Reciprocal link back to the ShinyLuck casino (Casino⇄Poker switcher).
  // Merged site: the casino now lives at the root of the same origin.
  casinoUrl: "/",
  // Same Privy app as ShinyLuck → same embedded Somnia wallet across both
  // products (email login, headless txs, no popups). Published, not a secret.
  privyAppId: "cmp9pb26g01py0cjlks1njki1",
};

export const NETWORKS = {
  localhost: {
    chainId: 31337,
    chainIdHex: "0x7A69",
    name: "Localhost (hardhat)",
    rpcUrls: ["http://127.0.0.1:8545"],
    explorer: "",
    currency: { name: "Test Ether", symbol: "tETH", decimals: 18 },
  },
  somniaTestnet: {
    chainId: 50312,
    chainIdHex: "0xC488",
    name: "Somnia Testnet (Shannon)",
    // [0] = our proxy (shinyluck.win/rpc, retry+failover over Somnia gateways
    // + Ankr) — poker-sdk reads through rpcUrls[0]; direct endpoint kept as a
    // manual fallback.
    rpcUrls: ["https://shinyluck.win/rpc", "https://api.infra.testnet.somnia.network"],
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
