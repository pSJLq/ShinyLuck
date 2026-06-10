/* ShinyPoker — marketing shared chrome (vanilla). Injects header + footer,
   ambient grid, FAQ toggles, zkShuffle scramble viz. */
(function () {
  "use strict";

  var BRACE = '<svg viewBox="0 0 514.666 390.309" fill="none" style="width:.62em;height:.78em;display:inline-block;vertical-align:-0.08em"><path d="M 0 180.699 L 18.07 180.699 C 23.19 180.699 27.707 179.644 31.622 177.536 C 35.537 175.127 38.7 172.115 41.109 168.501 C 43.819 164.586 45.777 160.37 46.982 155.852 C 48.487 151.034 49.24 146.215 49.24 141.397 L 49.24 68.665 C 49.24 57.522 50.294 47.735 52.403 39.302 C 54.812 30.869 58.727 23.792 64.148 18.07 C 69.569 12.047 76.797 7.529 85.832 4.517 C 95.168 1.506 106.763 0 120.616 0 L 157.208 0 L 157.208 29.364 L 118.809 29.364 C 106.16 29.364 97.125 32.225 91.704 37.947 C 86.585 43.669 84.025 54.059 84.025 69.117 L 84.025 131.458 C 84.025 151.636 81.013 166.544 74.99 176.181 C 68.967 185.517 62.04 191.842 54.21 195.154 C 62.04 198.768 68.967 205.545 74.99 215.483 C 81.013 225.421 84.025 239.877 84.025 258.851 L 84.025 321.192 C 84.025 336.25 86.735 346.64 92.156 352.362 C 97.577 358.084 106.612 360.945 119.261 360.945 L 157.208 360.945 L 157.208 390.309 L 120.616 390.309 C 106.763 390.309 95.168 388.803 85.832 385.791 C 76.797 382.78 69.569 378.262 64.148 372.239 C 58.727 366.517 54.812 359.439 52.403 351.007 C 50.294 342.574 49.24 332.786 49.24 321.643 L 49.24 248.912 C 49.24 244.395 48.487 239.877 46.982 235.36 C 45.777 230.541 43.819 226.325 41.109 222.711 C 38.7 218.796 35.537 215.634 31.622 213.224 C 28.008 210.815 23.641 209.61 18.522 209.61 L 0 209.61 Z" fill="currentColor"/></svg>';
  var BRACE_R = '<svg viewBox="0 0 514.666 390.309" fill="none" style="width:.62em;height:.78em;display:inline-block;vertical-align:-0.08em;transform:scaleX(-1)"><path d="M 0 180.699 L 18.07 180.699 C 23.19 180.699 27.707 179.644 31.622 177.536 C 35.537 175.127 38.7 172.115 41.109 168.501 C 43.819 164.586 45.777 160.37 46.982 155.852 C 48.487 151.034 49.24 146.215 49.24 141.397 L 49.24 68.665 C 49.24 57.522 50.294 47.735 52.403 39.302 C 54.812 30.869 58.727 23.792 64.148 18.07 C 69.569 12.047 76.797 7.529 85.832 4.517 C 95.168 1.506 106.763 0 120.616 0 L 157.208 0 L 157.208 29.364 L 118.809 29.364 C 106.16 29.364 97.125 32.225 91.704 37.947 C 86.585 43.669 84.025 54.059 84.025 69.117 L 84.025 131.458 C 84.025 151.636 81.013 166.544 74.99 176.181 C 68.967 185.517 62.04 191.842 54.21 195.154 C 62.04 198.768 68.967 205.545 74.99 215.483 C 81.013 225.421 84.025 239.877 84.025 258.851 L 84.025 321.192 C 84.025 336.25 86.735 346.64 92.156 352.362 C 97.577 358.084 106.612 360.945 119.261 360.945 L 157.208 360.945 L 157.208 390.309 L 120.616 390.309 C 106.763 390.309 95.168 388.803 85.832 385.791 C 76.797 382.78 69.569 378.262 64.148 372.239 C 58.727 366.517 54.812 359.439 52.403 351.007 C 50.294 342.574 49.24 332.786 49.24 321.643 L 49.24 248.912 C 49.24 244.395 48.487 239.877 46.982 235.36 C 45.777 230.541 43.819 226.325 41.109 222.711 C 38.7 218.796 35.537 215.634 31.622 213.224 C 28.008 210.815 23.641 209.61 18.522 209.61 L 0 209.61 Z" fill="currentColor"/></svg>';
  function logo(size) {
    size = size || 18;
    return '<span class="brace-logo" style="font-size:' + size + 'px;color:#fff">' + BRACE +
      '<span class="glyph" style="font-family:var(--mono);font-weight:500;margin:0 -0.14em">s</span>' + BRACE_R + '</span>' +
      '<span class="wordmark" style="font-size:' + Math.round(size * 0.92) + 'px;color:#fff">shiny<span class="accent" style="color:var(--accent)">poker</span></span>';
  }
  window.SPLogo = logo;

  var HEADER = '' +
    '<header class="mkt-header"><div class="container">' +
      '<a href="ShinyPoker Landing.html" class="mkt-logo">' + logo(19) + '</a>' +
      '<nav class="mkt-nav">' +
        '<a href="ShinyPoker Landing.html#how">How it works</a>' +
        '<a href="ShinyPoker Landing.html#fair">Provably fair</a>' +
        '<a href="ShinyPoker Lobby.html">Tournaments</a>' +
        '<a href="ShinyPoker Provably-Fair.html">Docs</a>' +
      '</nav>' +
      '<div class="spacer"></div>' +
      '<div class="mkt-switcher">' +
        '<a class="casino" href="#"><span class="dot"></span>ShinyLuck</a>' +
        '<a class="on" href="ShinyPoker Landing.html"><span class="dot"></span>Poker</a>' +
      '</div>' +
      '<a class="btn primary" href="ShinyPoker Onboarding.html">Connect Wallet &amp; Play</a>' +
    '</div></header>';

  var SOCIAL = {
    x: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.9 3H22l-7.3 8.3L23 21h-6.6l-5.2-6.6L5.3 21H2l7.8-8.9L1.5 3h6.8l4.7 6.1zm-1.2 16h1.8L7.1 4.8H5.2z"/></svg>',
    discord: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.5 5.3A17 17 0 0 0 15.4 4l-.2.4a13 13 0 0 1 3.7 1.9 12 12 0 0 0-10 0A13 13 0 0 1 12.6 4l-.3-.4A17 17 0 0 0 8.2 5.3 17.7 17.7 0 0 0 5 17.3a17 17 0 0 0 5.2 2.6l.4-1a11 11 0 0 1-1.8-.9l.4-.3a8.5 8.5 0 0 0 7.3 0l.5.3c-.6.4-1.2.7-1.9.9l.4 1a17 17 0 0 0 5.2-2.6 17.6 17.6 0 0 0-3.2-12zM9.7 14.9c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.9.9 1.8 2c0 1.1-.8 2-1.8 2zm4.6 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.9.9 1.8 2c0 1.1-.8 2-1.8 2z"/></svg>',
    telegram: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.9 4.3 18.6 20c-.2 1-.9 1.3-1.8.8l-4.9-3.6-2.3 2.3c-.3.3-.5.5-1 .5l.3-5 9.1-8.2c.4-.3-.1-.5-.6-.2L6.1 13.6l-4.8-1.5c-1-.3-1-1 .2-1.5l18.7-7.2c.9-.3 1.7.2 1.4 1z"/></svg>',
  };

  var FOOTER = '' +
    '<footer class="mkt-footer"><div class="container">' +
      '<div class="ftop">' +
        '<div class="fbrand">' +
          '<a href="ShinyPoker Landing.html" style="text-decoration:none">' + logo(18) + '</a>' +
          '<div class="tag">Provably-fair on-chain poker on Somnia. Your keys, your cards, your chips.</div>' +
          '<div class="fsocial">' +
            '<a href="#" title="X / Twitter">' + SOCIAL.x + '</a>' +
            '<a href="#" title="Discord">' + SOCIAL.discord + '</a>' +
            '<a href="#" title="Telegram">' + SOCIAL.telegram + '</a>' +
          '</div>' +
        '</div>' +
        '<div class="fcol"><div class="fh">Play</div>' +
          '<a href="ShinyPoker Lobby.html">Cash games</a><a href="ShinyPoker Lobby.html">Tournaments</a>' +
          '<a href="ShinyPoker Lobby.html">Sit &amp; Go</a><a href="ShinyPoker Clubs.html">Clubs</a>' +
          '<a href="ShinyPoker Cashier.html">Cashier</a></div>' +
        '<div class="fcol"><div class="fh">Trust</div>' +
          '<a href="ShinyPoker Provably-Fair.html">Provably fair</a><a href="ShinyPoker Provably-Fair.html">zkShuffle</a>' +
          '<a href="#">Docs</a><a href="#">GitHub</a><a href="#">Audits</a></div>' +
        '<div class="fcol"><div class="fh">Company</div>' +
          '<a href="ShinyPoker Terms.html">Terms of Service</a><a href="ShinyPoker Privacy.html">Privacy Policy</a>' +
          '<a href="ShinyPoker Responsible-Gaming.html">Responsible Gaming</a>' +
          '<a href="#">Powered by Somnia ↗</a><a href="#">ShinyLuck Casino ↗</a></div>' +
      '</div>' +
      '<div class="fchain">' +
        '<span class="ci"><span class="dot"></span>Somnia Mainnet</span>' +
        '<span class="ci">Escrow: <a href="#">0x9F3a…21cE7b2d ↗</a></span>' +
        '<span class="ci">Build v1.4.2</span>' +
        '<span class="ci">RPC: wss://api.somnia.network</span>' +
      '</div>' +
      '<div class="fbot">' +
        '<span class="copy">© 2026 ShinyPoker. All rights reserved.</span>' +
        '<div class="fresp"><span class="age">18+</span>' +
          '<span class="respline">Play responsibly. Poker involves financial risk.</span></div>' +
        '<span class="powered">Powered by <b>Somnia</b> · 1M+ TPS</span>' +
      '</div>' +
    '</div></footer>';

  function slimFooter() {
    return '<div class="appfooter">' + logo(12) +
      '<span>· Provably-fair on-chain poker</span>' +
      '<a href="ShinyPoker Provably-Fair.html">Provably Fair</a>' +
      '<a href="ShinyPoker Responsible-Gaming.html">Responsible Gaming</a>' +
      '<a href="ShinyPoker Terms.html">Terms</a>' +
      '<span class="spacer"></span>' +
      '<span class="ci"><span class="dot"></span>Somnia Mainnet · v1.4.2</span>' +
      '<span>© 2026 ShinyPoker</span></div>';
  }
  window.SPSlimFooter = slimFooter;

  function inject() {
    var h = document.getElementById("site-header");
    if (h) h.innerHTML = HEADER;
    var f = document.getElementById("site-footer");
    if (f) f.innerHTML = FOOTER;

    // ambient bg grid
    var bg = document.getElementById("mkt-bg");
    if (bg && window.GridField) {
      new GridField(bg, { cell: 24, gap: 8, speed: 0.34, density: 0.5, accent: "#6E6EED", accent2: "#9B9BF4",
        maxAlpha: 0.7, minBright: 0.008, shape: "square" }).start();
    }

    // zkShuffle viz
    var zk = document.getElementById("zkviz-canvas");
    if (zk && window.GridField) {
      var field = new GridField(zk, { cell: 16, gap: 4, speed: 0.5, density: 0.45, accent: "#6E6EED",
        accent2: "#9B9BF4", maxAlpha: 0.9, minBright: 0.02, shape: "square" });
      field.start();
      window.__zkField = field;
      var btn = document.getElementById("zk-shuffle-btn");
      if (btn) btn.addEventListener("click", function () { field.scramble(1400); });
      setTimeout(function () { field.scramble(1400); }, 600);
    }

    // FAQ
    document.querySelectorAll(".faqitem").forEach(function (it) {
      it.addEventListener("click", function () { it.classList.toggle("open"); });
    });

    // animated stat counters
    document.querySelectorAll("[data-count]").forEach(function (el) {
      var target = parseFloat(el.getAttribute("data-count"));
      var dur = 1100, start = performance.now();
      var suffix = el.getAttribute("data-suffix") || "";
      function setFinal() { el.textContent = target.toLocaleString("en-US") + suffix; }
      function tick(now) {
        var t = Math.min(1, (now - start) / dur);
        var e = 1 - Math.pow(1 - t, 3);
        var val = Math.floor(target * e);
        el.textContent = val.toLocaleString("en-US") + suffix;
        if (t < 1) requestAnimationFrame(tick);
        else setFinal();
      }
      requestAnimationFrame(tick);
      setTimeout(setFinal, dur + 250); // fallback if rAF is throttled
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", inject);
  else inject();
})();
