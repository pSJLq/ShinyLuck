/* ============================================================================
   whenAuthSettled · resolves once Privy has actually decided whether we have a
   session, so pages never flash a "connect to play" gate at a user who IS
   signed in (session restore takes ~0.5-2s on a cold load).

   Resolves true  · authenticated with an embedded address
           false · Privy is ready and there is no session (or it timed out)
   ========================================================================== */

const TIMEOUT_MS = 9000;

export function whenAuthSettled() {
  return new Promise((resolve) => {
    const done = (v) => { cleanup(); resolve(v); };
    const check = () => {
      const a = window.ShinyLuckAuth;
      if (!a || !a.ready) return false;
      if (a.authenticated && a.address) { done(true); return true; }
      if (!a.authenticated) { done(false); return true; }
      return false; // ready + authenticated but no address yet · keep waiting
    };
    const onState = () => check();
    const t = setTimeout(() => done(Boolean(window.ShinyLuckAuth?.address)), TIMEOUT_MS);
    const iv = setInterval(check, 200);
    function cleanup() {
      clearTimeout(t); clearInterval(iv);
      document.removeEventListener("shinyluck:auth-state", onState);
      document.removeEventListener("shinyluck:connected", onState);
    }
    document.addEventListener("shinyluck:auth-state", onState);
    document.addEventListener("shinyluck:connected", onState);
    check();
  });
}
