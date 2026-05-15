// Auto-written by scripts/deploy.js. Live addresses below — re-run
// `npm run deploy:testnet` to overwrite (don't edit by hand).
export const CONFIG = {
  network: "somniaTestnet",
  casino: "0x92335188B6dD1BEd41Ed63Ce8C534a6a74B18e5b",
  registry: "0x63Cdd6EfB9684b18eb3642122003FdaC4cE0D96a",
  houseManager: "0x9b23624845730A9dBCb5CD33B17C66625DA6e6B8",
  agentVerifier: "0x3e84C178b5F7c25b4Ff245b495136C230D6b773f",
  agentPlatform: "0x5E5205CF39E766118C01636bED000A54D93163E6",
  agentServiceUrl: "http://localhost:3001",
  agentIds: {
    json:  "131742929374160097713",
    llm:   "128472938475610293844",
    parse: "128754011420709690852",
    hm:    "119284756103948572617",
  },
};

// Expose to the non-module partials.js loader so it can render real
// addresses / agent IDs / network in the boot animation lines and footer.
if (typeof window !== "undefined") {
  window.SL_CONFIG = CONFIG;
  document.dispatchEvent(new CustomEvent("shinyluck:config", { detail: CONFIG }));
}
