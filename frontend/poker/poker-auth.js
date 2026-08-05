/* ShinyPoker · where the wallet comes from.
   Loaded instead of a bare <script src="/vendor/privy.bundle.js"> on every
   poker page.

   Poker runs inside the merged site as an iframe of the SAME ORIGIN, and the
   shell has already booted Privy — so a second copy in the frame bought us
   nothing and cost a lot: 4.8 MB of script to fetch and parse, plus its own
   auth.privy.io iframe and its own Cloudflare Turnstile frame. Measured on the
   live site with an iPhone profile: SIX frames and ~179 MB of JS heap for one
   poker tab. When a phone runs short of memory WebKit kills the frame's content
   process, and what the player gets is an empty poker tab while everything
   around it keeps working — which is exactly the failure we have been chasing.

   Same origin means we do not need a message protocol: the frame can simply use
   the parent's object. Two details make that correct rather than merely clever:

     · the parent REPLACES window.ShinyLuckAuth as auth progresses (stub first,
       real API once React mounts), so we expose a GETTER that reads through to
       the parent every time. A one-shot copy would freeze the frame on the stub
       and every login would time out.
     · the state event is dispatched on the parent's DOCUMENT. Our SDK waits on
       it in THIS document (poker-sdk.js `_privyWait`), so it is forwarded.

   Standalone (opening /poker/table.html directly, or any page outside the
   shell) there is no parent to borrow from and the bundle is loaded as before.
   ES5, like poker-boot.js: this runs before anything that could polyfill it. */
(function () {
  "use strict";
  var parentWin = null;
  try {
    if (window.parent && window.parent !== window && window.parent.ShinyLuckAuth) parentWin = window.parent;
  } catch (e) { parentWin = null; }   // cross-origin parent: not our shell

  if (parentWin) {
    try {
      Object.defineProperty(window, "ShinyLuckAuth", {
        configurable: true,
        get: function () { try { return parentWin.ShinyLuckAuth; } catch (e) { return undefined; } },
        set: function (v) { try { parentWin.ShinyLuckAuth = v; } catch (e) {} },
      });
      parentWin.document.addEventListener("shinyluck:auth-state", function (ev) {
        try { document.dispatchEvent(new CustomEvent("shinyluck:auth-state", { detail: ev.detail })); } catch (e2) {}
      });
      window.SPAuthSource = "parent";
      return;
    } catch (e) { /* fall through and load our own copy */ }
  }

  // No shell to borrow from · load the bundle ourselves. Inserted rather than
  // written with document.write: Chrome BLOCKS document.write-injected scripts
  // on slow connections, and a slow connection is precisely when we need this
  // to work. `async = false` keeps it ordered with the other page scripts.
  var s = document.createElement("script");
  s.src = "/vendor/privy.bundle.js";
  s.async = false;
  (document.head || document.documentElement).appendChild(s);
  window.SPAuthSource = "own";
})();
