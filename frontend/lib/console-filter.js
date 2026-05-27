// Console noise filter. Suppresses warnings/errors that we know are not
// actionable on our side - MetaMask extension contentscript chatter and
// Privy/Coinbase Smart Wallet placeholder warnings. Without this, the
// browser devtools console on the lobby fills with ~30 lines of irrelevant
// stack traces before our own logs appear, making debugging hard.
//
// Loaded as a regular (non-module) script in <head>, BEFORE everything else
// so the patches are in place when third-party bundles boot.

(function installConsoleFilter() {
  const NOISE_PATTERNS = [
    // MetaMask injected contentscript spam - their internal stream plumbing.
    "MaxListenersExceededWarning",
    "ObjectMultiplex - orphaned data",
    "ObjectMultiplex - malformed chunk",
    // Privy's prebuilt bundle complains about Coinbase Smart Wallet not
    // supporting Somnia testnet (chain 50312). We don't use CSW - it's a
    // sibling connector in their stack we never wire up.
    "The configured chains are not supported by Coinbase Smart Wallet",
    // Privy iframe's own "console scam" boilerplate - shown in every
    // embedded-wallets dApp. Useful for end users but pure noise during dev.
    "You are reading this message because you opened the browser console",
    "Warning!",
  ];

  function makeFiltered(orig) {
    return function (...args) {
      // Inspect the first stringifiable arg + the stack-style 2nd if present.
      const probe = args
        .slice(0, 3)
        .map((a) => {
          if (typeof a === "string") return a;
          if (a && typeof a === "object") {
            try { return a.message || JSON.stringify(a).slice(0, 200); }
            catch (_) { return ""; }
          }
          return String(a);
        })
        .join(" ");
      for (const pat of NOISE_PATTERNS) {
        if (probe.indexOf(pat) !== -1) return; // drop silently
      }
      return orig.apply(this, args);
    };
  }

  // Wrap warn + error. Don't touch log/info - those are intentional debug
  // output and we don't want to lose them.
  try {
    const origWarn = console.warn.bind(console);
    const origError = console.error.bind(console);
    console.warn  = makeFiltered(origWarn);
    console.error = makeFiltered(origError);
  } catch (_) { /* sandboxed iframe etc; just skip */ }
})();
