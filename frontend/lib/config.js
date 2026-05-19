// Auto-written by scripts/deploy.js. Live addresses below — re-run
// `npm run deploy:testnet` to overwrite (don't edit by hand).
export const CONFIG = {
  network: "somniaTestnet",
  casino: "0x0d397E36215Fb534F0dE4E279f505dEC3F63E4B6",
  registry: "0xb61fA312A83cadd836eC0bF90493A9d62AC9F747",
  houseManager: "0x8864e2B29D1dd1A9969d6182095776Ab0D26DC4A",
  agentVerifier: "0xe83cA2b91216A038f3825CE1F5131f3133f0fA2C",
  agentPlatform: "0x5E5205CF39E766118C01636bED000A54D93163E6",
  agentServiceUrl: "http://localhost:3001",
  // Privy app ID — published, not a secret. Lives in .env as Privy_App_Id.
  // The vendor bundle reads it from window.SHINYLUCK_CONFIG at mount time.
  privyAppId: "cmp9pb26g01py0cjlks1njki1",
  // Public Somnia Provider App ID per docs.somnia.network — Global Wallet.
  somniaProviderAppId: "cm8d9yzp2013kkr612h8ymoq8",
  agentIds: {
    json:  "131742929374160097713",
    llm:   "128472938475610293844",
    parse: "128754011420709690852",
    hm:    "119284756103948572617",
  },
};

// Expose to the non-module partials.js loader so it can render real
// addresses / agent IDs / network in the boot animation lines and footer.
// Also expose as SHINYLUCK_CONFIG so the Privy vendor bundle finds privyAppId.
if (typeof window !== "undefined") {
  window.SL_CONFIG = CONFIG;
  window.SHINYLUCK_CONFIG = CONFIG;
  document.dispatchEvent(new CustomEvent("shinyluck:config", { detail: CONFIG }));
}
