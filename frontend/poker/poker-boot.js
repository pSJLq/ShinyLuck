/* ShinyPoker · boot guard. FIRST script on every poker page, deliberately not
   deferred: it has to be installed before anything else can fail.

   It exists because of one bug we could not see. After the React/JSX fix some
   players still got an EMPTY poker frame — no lobby, no error, nothing to
   report but a black rectangle. Everything around it worked (casino feed, the
   header wallet, even POKER BALANCE read from the same contract), so the fault
   was inside this frame and invisible from the outside. This file makes such a
   failure say something: to us over the wire, and to the player on the screen.

   Three jobs:
     1. Storage that cannot throw. WKWebView (Telegram's in-app browser, iOS
        with cross-site tracking prevention) makes `localStorage` THROW inside a
        framed document instead of returning null. One unguarded read in a React
        initializer is enough to blank the whole app. If storage throws we swap
        in a memory-backed stand-in, so a hostile browser costs a player their
        saved theme, never the page.
     2. A beacon. window.onerror, unhandled rejections, and failed <script>/CSS
        loads go to the dealer at /dealer/clientlog. Capped and de-duplicated.
     3. A watchdog. If nothing has mounted into #root after 9s, report a
        diagnosis (which globals arrived, which resources failed, storage state)
        and REPLACE the blank frame with something readable and a reload button.

   ES5 ON PURPOSE — no arrow functions, no const/let, no template strings. A
   boot guard written in syntax the broken browser cannot parse reports nothing.
   Do not "modernize" this file. */
(function () {
  "use strict";
  var T0 = Date.now();
  var CAP = 12;          // reports per page load
  var sent = 0;
  var seen = {};         // de-dupe key -> 1
  var failedRes = [];    // scripts/styles that never loaded
  var storageState = "ok";

  // ---- 1. storage that cannot throw ---------------------------------------
  // NB: in WKWebView the THROW can come from touching `window.localStorage`
  // itself, not only from getItem — so the property access is inside the try.
  // `typeof localStorage !== "undefined"` (what poker-sdk.js used to do) does
  // not protect anything: the object is there, the call is what fails.
  function memStore() {
    var map = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
      setItem: function (k, v) { map[k] = String(v); },
      removeItem: function (k) { delete map[k]; },
      clear: function () { map = {}; },
      key: function (i) { var ks = Object.keys(map); return i < ks.length ? ks[i] : null; },
      get length() { return Object.keys(map).length; }
    };
  }
  function harden(name) {
    var probe = "__sp_probe__";
    try {
      var s = window[name];
      s.setItem(probe, "1");
      s.removeItem(probe);
      return "ok";
    } catch (e) {
      try {
        Object.defineProperty(window, name, { value: memStore(), configurable: true, writable: true });
        return "shim:" + ((e && e.name) || "Error");
      } catch (e2) {
        return "blocked:" + ((e && e.name) || "Error");
      }
    }
  }
  storageState = harden("localStorage") + "/" + harden("sessionStorage");
  if (storageState.indexOf("ok/ok") !== 0) {
    // Worth knowing on its own: it means this device would have blanked the
    // page before the shim existed, and tells us the guess in §26.4 was right.
    setTimeout(function () { report("storage", "storage unavailable: " + storageState, {}); }, 1500);
  }

  // ---- 2. beacon ----------------------------------------------------------
  function diag() {
    var d = {
      ls: storageState,
      react: typeof window.React,
      dom: typeof window.ReactDOM,
      sp: typeof window.SP,                       // set by poker-bridge.js (module chain)
      app: [
        typeof window.LobbyApp !== "undefined" ? "lobby" : "",
        typeof window.TableApp !== "undefined" ? "table" : "",
        typeof window.TournamentApp !== "undefined" ? "trn" : ""
      ].join("").replace(/^$/, "none"),
      esm: ("noModule" in document.createElement("script")) ? 1 : 0,
      ready: document.readyState,
      scripts: document.scripts ? document.scripts.length : -1,
      root: rootCount(),
      frame: inFrame() ? 1 : 0,
      online: navigator.onLine === false ? 0 : 1,
      vw: window.innerWidth + "x" + window.innerHeight,
      up: Date.now() - T0
    };
    if (failedRes.length) d.failed = failedRes.slice(0, 8);
    return d;
  }
  function inFrame() { try { return window.self !== window.top; } catch (e) { return true; } }
  function rootCount() {
    var r = document.getElementById("root");
    return r ? r.childElementCount : -1;
  }
  function report(kind, msg, extra) {
    if (sent >= CAP) return;
    var key = kind + "|" + String(msg).slice(0, 120);
    if (seen[key]) return;
    seen[key] = 1;
    sent++;
    var body = {
      k: kind,
      m: String(msg == null ? "" : msg).slice(0, 400),
      p: location.pathname + location.search,
      ua: navigator.userAgent.slice(0, 200),
      t: Date.now() - T0,
      d: diag()
    };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) body[k] = extra[k];
    try {
      var x = new XMLHttpRequest();          // XHR, not fetch: works everywhere
      x.open("POST", "/dealer/clientlog", true);
      x.setRequestHeader("Content-Type", "application/json");
      x.send(JSON.stringify(body));
    } catch (e) {}
  }
  window.SPBoot = {                          // app code can add its own notes
    report: report,
    diag: diag,
    get storage() { return storageState; }
  };

  window.addEventListener("error", function (e) {
    // Two different events share this name. A resource that failed to load has
    // a target with a src/href and no message — that is the case that used to
    // leave us with a blank frame and no clue which file went missing.
    var t = e && e.target;
    if (t && t !== window && (t.src || t.href)) {
      var url = String(t.src || t.href);
      failedRes.push(url.replace(location.origin, ""));
      report("resource", "failed to load " + url.replace(location.origin, ""), {});
      return;
    }
    report("error", (e && e.message) || "unknown error", {
      f: e && e.filename ? String(e.filename).replace(location.origin, "") : "",
      l: (e && e.lineno) || 0,
      c: (e && e.colno) || 0,
      s: e && e.error && e.error.stack ? String(e.error.stack).slice(0, 1200) : ""
    });
  }, true);                                  // capture: resource errors do not bubble

  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason;
    report("reject", (r && (r.message || r)) || "unhandled rejection", {
      s: r && r.stack ? String(r.stack).slice(0, 1200) : ""
    });
  });

  // ---- 3. watchdog: never leave the player with a black rectangle ---------
  var WAIT_MS = 9000;
  var RETRY = "_spretry";
  function mounted() { return rootCount() > 0; }
  function retried() { return location.search.indexOf(RETRY) >= 0; }

  /* ONE AUTOMATIC RETRY. Every failure we could simulate against the live site
     is survivable — a blocked Privy, a dead /rpc, a dead dealer API, missing
     fonts: the lobby still draws. Exactly one thing blanks it, and it blanks it
     permanently: a MODULE that does not arrive (ethers -> poker-sdk ->
     poker-bridge). Nothing retried it, so a single bad fetch on a phone's
     network cost the player the whole tab until they thought to reload — and
     players do not reload, they leave.
     So we reload once, ourselves. `cache: "reload"` re-fetches the scripts
     first: a truncated or corrupted cached copy is a real failure mode on iOS
     and a plain reload would just serve it again. The marker lives in the URL,
     not in storage, because storage is exactly what may be broken here — and it
     makes a loop impossible: the second attempt never retries, it shows the
     panel. */
  function selfHeal() {
    var urls = [], s = document.scripts, i;
    for (i = 0; i < s.length; i++) if (s[i].src && s[i].src.indexOf(location.origin) === 0) urls.push(s[i].src);
    var went = false;
    var go = function () {
      if (went) return;
      went = true;
      location.replace(location.pathname + location.search + (location.search ? "&" : "?") + RETRY + "=1" + location.hash);
    };
    if (typeof fetch !== "function" || !urls.length) return go();
    var left = urls.length;
    var tick = function () { if (--left <= 0) go(); };
    for (i = 0; i < urls.length; i++) {
      try { fetch(urls[i], { cache: "reload" }).then(tick, tick); } catch (e) { tick(); }
    }
    setTimeout(go, 6000);   // a hung fetch must not hold the retry forever
  }
  function panel() {
    if (document.getElementById("sp-boot-fail")) return;
    var d = diag();
    // Plain DOM, inline styles: the stylesheets may be the thing that failed.
    var box = document.createElement("div");
    box.id = "sp-boot-fail";
    box.setAttribute("style", "position:fixed;z-index:99999;left:50%;top:50%;transform:translate(-50%,-50%);" +
      "max-width:min(92vw,420px);box-sizing:border-box;padding:20px 18px;border-radius:14px;" +
      "background:#111117;border:1px solid #2a2a35;color:#e8e8ef;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
      "text-align:center;box-shadow:0 18px 60px rgba(0,0,0,.6)");
    var h = document.createElement("div");
    h.setAttribute("style", "font-size:16px;font-weight:700;color:#F0C46A;margin-bottom:6px");
    h.appendChild(document.createTextNode("Poker did not load"));
    var p = document.createElement("div");
    p.setAttribute("style", "color:#a0a0ad;margin-bottom:14px");
    p.appendChild(document.createTextNode("Покер не загрузился. Попробуйте перезагрузить страницу или открыть shinyluck.win во внешнем браузере."));
    var btn = document.createElement("button");
    btn.setAttribute("style", "appearance:none;border:0;border-radius:10px;padding:10px 18px;cursor:pointer;" +
      "background:#F0C46A;color:#15150f;font-weight:700;font-size:14px");
    btn.appendChild(document.createTextNode("Reload"));
    btn.onclick = function () { location.reload(); };
    // The same line the beacon sent — so a photo of the phone screen is a
    // usable bug report even when the device can reach nothing of ours.
    var code = document.createElement("div");
    code.setAttribute("style", "margin-top:14px;color:#6a6a78;font:11px/1.4 ui-monospace,Menlo,Consolas,monospace;word-break:break-all");
    code.appendChild(document.createTextNode(
      "r:" + d.react + " d:" + d.dom + " sp:" + d.sp + " app:" + d.app +
      " ls:" + d.ls + " esm:" + d.esm + (d.failed ? " x:" + d.failed.join(",") : "")));
    box.appendChild(h); box.appendChild(p); box.appendChild(btn); box.appendChild(code);
    (document.body || document.documentElement).appendChild(box);
  }
  function drop() {
    var b = document.getElementById("sp-boot-fail");
    if (b && b.parentNode) b.parentNode.removeChild(b);
  }
  function watch() {
    if (mounted()) return;
    // Report BEFORE healing: a retry that works still tells us this device had
    // trouble, which is the only way we learn about the near-misses.
    if (!retried()) {
      report("blank-retry", "nothing mounted after " + WAIT_MS + "ms · reloading once", {});
      return selfHeal();
    }
    report("blank", "nothing mounted after " + WAIT_MS + "ms, even after a retry", {});
    panel();
    // A slow phone on a slow network can still arrive late — if it does, the
    // panel gets out of the way by itself.
    var iv = setInterval(function () {
      if (!mounted()) return;
      clearInterval(iv);
      drop();
    }, 1000);
    setTimeout(function () { clearInterval(iv); }, 60000);
  }
  setTimeout(watch, WAIT_MS);
})();
