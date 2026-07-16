/* ShinyPoker · marketing shared chrome (vanilla). Injects header + footer,
   ambient grid, FAQ toggles, zkShuffle scramble viz. */
(function () {
  "use strict";

  var BRACE = '<svg viewBox="0 0 514.666 390.309" fill="none" style="width:.62em;height:.78em;display:inline-block;vertical-align:-0.08em"><path d="M 0 180.699 L 18.07 180.699 C 23.19 180.699 27.707 179.644 31.622 177.536 C 35.537 175.127 38.7 172.115 41.109 168.501 C 43.819 164.586 45.777 160.37 46.982 155.852 C 48.487 151.034 49.24 146.215 49.24 141.397 L 49.24 68.665 C 49.24 57.522 50.294 47.735 52.403 39.302 C 54.812 30.869 58.727 23.792 64.148 18.07 C 69.569 12.047 76.797 7.529 85.832 4.517 C 95.168 1.506 106.763 0 120.616 0 L 157.208 0 L 157.208 29.364 L 118.809 29.364 C 106.16 29.364 97.125 32.225 91.704 37.947 C 86.585 43.669 84.025 54.059 84.025 69.117 L 84.025 131.458 C 84.025 151.636 81.013 166.544 74.99 176.181 C 68.967 185.517 62.04 191.842 54.21 195.154 C 62.04 198.768 68.967 205.545 74.99 215.483 C 81.013 225.421 84.025 239.877 84.025 258.851 L 84.025 321.192 C 84.025 336.25 86.735 346.64 92.156 352.362 C 97.577 358.084 106.612 360.945 119.261 360.945 L 157.208 360.945 L 157.208 390.309 L 120.616 390.309 C 106.763 390.309 95.168 388.803 85.832 385.791 C 76.797 382.78 69.569 378.262 64.148 372.239 C 58.727 366.517 54.812 359.439 52.403 351.007 C 50.294 342.574 49.24 332.786 49.24 321.643 L 49.24 248.912 C 49.24 244.395 48.487 239.877 46.982 235.36 C 45.777 230.541 43.819 226.325 41.109 222.711 C 38.7 218.796 35.537 215.634 31.622 213.224 C 28.008 210.815 23.641 209.61 18.522 209.61 L 0 209.61 Z" fill="currentColor"/></svg>';
  var BRACE_R = '<svg viewBox="0 0 514.666 390.309" fill="none" style="width:.62em;height:.78em;display:inline-block;vertical-align:-0.08em;transform:scaleX(-1)"><path d="M 0 180.699 L 18.07 180.699 C 23.19 180.699 27.707 179.644 31.622 177.536 C 35.537 175.127 38.7 172.115 41.109 168.501 C 43.819 164.586 45.777 160.37 46.982 155.852 C 48.487 151.034 49.24 146.215 49.24 141.397 L 49.24 68.665 C 49.24 57.522 50.294 47.735 52.403 39.302 C 54.812 30.869 58.727 23.792 64.148 18.07 C 69.569 12.047 76.797 7.529 85.832 4.517 C 95.168 1.506 106.763 0 120.616 0 L 157.208 0 L 157.208 29.364 L 118.809 29.364 C 106.16 29.364 97.125 32.225 91.704 37.947 C 86.585 43.669 84.025 54.059 84.025 69.117 L 84.025 131.458 C 84.025 151.636 81.013 166.544 74.99 176.181 C 68.967 185.517 62.04 191.842 54.21 195.154 C 62.04 198.768 68.967 205.545 74.99 215.483 C 81.013 225.421 84.025 239.877 84.025 258.851 L 84.025 321.192 C 84.025 336.25 86.735 346.64 92.156 352.362 C 97.577 358.084 106.612 360.945 119.261 360.945 L 157.208 360.945 L 157.208 390.309 L 120.616 390.309 C 106.763 390.309 95.168 388.803 85.832 385.791 C 76.797 382.78 69.569 378.262 64.148 372.239 C 58.727 366.517 54.812 359.439 52.403 351.007 C 50.294 342.574 49.24 332.786 49.24 321.643 L 49.24 248.912 C 49.24 244.395 48.487 239.877 46.982 235.36 C 45.777 230.541 43.819 226.325 41.109 222.711 C 38.7 218.796 35.537 215.634 31.622 213.224 C 28.008 210.815 23.641 209.61 18.522 209.61 L 0 209.61 Z" fill="currentColor"/></svg>';
  // Brand mark = the "shiny card" sparkle (see logo.svg / SparkLogo). The {s}
  // braces stay ONLY as the SOMI currency glyph next to balances.
  var SPARK = function (px) {
    return '<svg viewBox="0 0 64 64" style="width:' + px + 'px;height:' + px + 'px;display:inline-block;vertical-align:-0.18em">' +
      '<g transform="rotate(26 32 32)">' +
      '<path d="M 32 3 Q 36.5 23 47 32 Q 36.5 41 32 61 Q 27.5 41 17 32 Q 27.5 23 32 3 Z" fill="#e8c15a" opacity="0.45"/>' +
      '<path d="M 32 5 Q 36.2 24 45.5 32 Q 36.2 40 32 59 Q 27.8 40 18.5 32 Q 27.8 24 32 5 Z" fill="#fff6dd" stroke="#d9ab4a" stroke-width="1.6" stroke-linejoin="round"/>' +
      '</g>' +
      '<path d="M 13 15 L 13.8 17.2 L 16 18 L 13.8 18.8 L 13 21 L 12.2 18.8 L 10 18 L 12.2 17.2 Z" fill="#f2d78a"/>' +
      '<path d="M 50 48.4 L 50.7 50.3 L 52.6 51 L 50.7 51.7 L 50 53.6 L 49.3 51.7 L 47.4 51 L 49.3 50.3 Z" fill="#f2d78a" opacity="0.9"/>' +
      '</svg>';
  };
  function logo(size) {
    size = size || 18;
    return SPARK(Math.round(size * 1.35)) +
      '<span class="wordmark" style="font-size:' + Math.round(size * 0.92) + 'px;color:#fff;margin-left:6px">shiny<span class="accent" style="color:var(--accent)">poker</span></span>';
  }
  window.SPLogo = logo;

  var HEADER = '' +
    '<header class="mkt-header"><div class="container">' +
      '<a href="/poker/" class="mkt-logo">' + logo(19) + '</a>' +
      '<nav class="mkt-nav">' +
        '<a href="/poker/#how">How it works</a>' +
        '<a href="provably-fair">Provably fair</a>' +
        '<a href="lobby?tab=tournaments">Tournaments</a>' +
        '<a href="zk-lab">zk Lab</a>' +
      '</nav>' +
      '<div class="spacer"></div>' +
      '<div class="mkt-switcher">' +
        '<a class="casino" href="https://shiny-luck.vercel.app/"><span class="dot"></span>ShinyLuck</a>' +
        '<a class="on" href="/poker/"><span class="dot"></span>Poker</a>' +
      '</div>' +
      '<a class="btn primary" href="lobby">Connect Wallet &amp; Play</a>' +
    '</div></header>';

  // Real community links · used by BOTH footers.
  var LINKS = {
    telegram: "https://t.me/ShinyLuck1",
    x: "https://x.com/ShinyLuck_",
    discord: "https://discord.gg/DxRzqnXmeq",
    github: "https://github.com/pSJLq",
    somnia: "https://somnia.network/",
    casino: "https://shiny-luck.vercel.app/",
    escrow: "https://shannon-explorer.somnia.network/address/0x7E1387FCE14522B981C07bca921e857CfeD636e3",
  };

  var SOCIAL = {
    x: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.9 3H22l-7.3 8.3L23 21h-6.6l-5.2-6.6L5.3 21H2l7.8-8.9L1.5 3h6.8l4.7 6.1zm-1.2 16h1.8L7.1 4.8H5.2z"/></svg>',
    discord: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.5 5.3A17 17 0 0 0 15.4 4l-.2.4a13 13 0 0 1 3.7 1.9 12 12 0 0 0-10 0A13 13 0 0 1 12.6 4l-.3-.4A17 17 0 0 0 8.2 5.3 17.7 17.7 0 0 0 5 17.3a17 17 0 0 0 5.2 2.6l.4-1a11 11 0 0 1-1.8-.9l.4-.3a8.5 8.5 0 0 0 7.3 0l.5.3c-.6.4-1.2.7-1.9.9l.4 1a17 17 0 0 0 5.2-2.6 17.6 17.6 0 0 0-3.2-12zM9.7 14.9c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.9.9 1.8 2c0 1.1-.8 2-1.8 2zm4.6 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.9.9 1.8 2c0 1.1-.8 2-1.8 2z"/></svg>',
    telegram: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.9 4.3 18.6 20c-.2 1-.9 1.3-1.8.8l-4.9-3.6-2.3 2.3c-.3.3-.5.5-1 .5l.3-5 9.1-8.2c.4-.3-.1-.5-.6-.2L6.1 13.6l-4.8-1.5c-1-.3-1-1 .2-1.5l18.7-7.2c.9-.3 1.7.2 1.4 1z"/></svg>',
    github: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 1.8a10.4 10.4 0 0 0-3.3 20.3c.5.1.7-.2.7-.5v-1.9c-2.9.6-3.5-1.2-3.5-1.2-.5-1.2-1.2-1.5-1.2-1.5-1-.6.1-.6.1-.6 1 .1 1.6 1.1 1.6 1.1.9 1.6 2.5 1.1 3.1.9.1-.7.4-1.1.7-1.4-2.3-.3-4.8-1.2-4.8-5.2 0-1.1.4-2 1.1-2.8-.1-.2-.5-1.3.1-2.8 0 0 .9-.3 2.9 1.1a10 10 0 0 1 5.2 0c2-1.4 2.9-1.1 2.9-1.1.6 1.5.2 2.6.1 2.8.7.8 1.1 1.7 1.1 2.8 0 4-2.5 4.9-4.8 5.2.4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5A10.4 10.4 0 0 0 12 1.8z"/></svg>',
  };

  function socialRow() {
    return '<div class="fsocial">' +
      '<a href="' + LINKS.x + '" target="_blank" rel="noopener" title="X / Twitter">' + SOCIAL.x + '</a>' +
      '<a href="' + LINKS.discord + '" target="_blank" rel="noopener" title="Discord">' + SOCIAL.discord + '</a>' +
      '<a href="' + LINKS.telegram + '" target="_blank" rel="noopener" title="Telegram">' + SOCIAL.telegram + '</a>' +
      '<a href="' + LINKS.github + '" target="_blank" rel="noopener" title="GitHub">' + SOCIAL.github + '</a>' +
    '</div>';
  }

  var FOOTER = '' +
    '<footer class="mkt-footer"><div class="container">' +
      '<div class="ftop">' +
        '<div class="fbrand">' +
          '<a href="/poker/" style="text-decoration:none">' + logo(18) + '</a>' +
          '<div class="tag">Provably-fair on-chain poker on Somnia. Your keys, your cards, your chips.</div>' +
          socialRow() +
        '</div>' +
        '<div class="fcol"><div class="fh">Play</div>' +
          '<a href="lobby?tab=cash">Cash games</a><a href="lobby?tab=tournaments">Tournaments</a>' +
          '<a href="lobby?tab=sng">Sit &amp; Go</a><a href="lobby?tab=clubs">Clubs</a>' +
          '<a href="lobby?cashier=1">Cashier</a></div>' +
        '<div class="fcol"><div class="fh">Trust</div>' +
          '<a href="provably-fair">Provably fair · docs</a><a href="provably-fair#verify">Verify a hand</a>' +
          '<a href="zk-lab">zkShuffle v2 Lab</a><a href="' + LINKS.github + '" target="_blank" rel="noopener">GitHub ↗</a></div>' +
        '<div class="fcol"><div class="fh">Company</div>' +
          '<a href="terms">Terms of Service</a><a href="privacy">Privacy Policy</a>' +
          '<a href="responsible">Responsible Gaming</a>' +
          '<a href="' + LINKS.somnia + '" target="_blank" rel="noopener">Powered by Somnia ↗</a><a href="' + LINKS.casino + '">ShinyLuck Casino ↗</a></div>' +
      '</div>' +
      '<div class="fchain">' +
        '<span class="ci"><span class="dot"></span>Somnia Testnet</span>' +
        '<span class="ci">Escrow: <a href="' + LINKS.escrow + '" target="_blank" rel="noopener">0x7E13…36e3 ↗</a></span>' +
        '<span class="ci">Build v1.5</span>' +
        '<span class="ci">RPC: api.infra.testnet.somnia.network</span>' +
      '</div>' +
      '<div class="fbot">' +
        '<span class="copy">© 2026 ShinyPoker. All rights reserved.</span>' +
        '<div class="fresp"><span class="age">18+</span>' +
          '<span class="respline">Play responsibly. Poker involves financial risk.</span></div>' +
        '<a class="powered" style="text-decoration:none;color:inherit" href="' + LINKS.somnia + '" target="_blank" rel="noopener">Powered by <b>Somnia</b> ↗</a>' +
      '</div>' +
    '</div></footer>';

  function slimFooter() {
    return '<div class="appfooter two">' +
      '<div class="afrow">' + logo(13) +
        '<span class="aftag">Provably-fair on-chain poker · your keys, your cards, your chips</span>' +
        '<span class="spacer"></span>' +
        socialRow() +
      '</div>' +
      '<div class="afrow links">' +
        '<a href="/poker/">About</a>' +
        '<a href="provably-fair">Provably Fair</a>' +
        '<a href="zk-lab">zk Lab</a>' +
        '<a href="responsible">Responsible Gaming</a>' +
        '<a href="terms">Terms</a>' +
        '<a href="privacy">Privacy</a>' +
        '<span class="spacer"></span>' +
        '<span class="ci"><span class="dot"></span>Somnia Testnet · v1.5</span>' +
        '<span class="copy">© 2026 ShinyPoker · 18+ play responsibly</span>' +
      '</div></div>';
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
      new GridField(bg, { cell: 24, gap: 8, speed: 0.34, density: 0.5, accent: "#d9ab4a", accent2: "#f2d78a",
        maxAlpha: 0.7, minBright: 0.008, shape: "square" }).start();
    }

    // zkShuffle viz
    var zk = document.getElementById("zkviz-canvas");
    if (zk && window.GridField) {
      var field = new GridField(zk, { cell: 16, gap: 4, speed: 0.5, density: 0.45, accent: "#d9ab4a",
        accent2: "#f2d78a", maxAlpha: 0.9, minBright: 0.02, shape: "square" });
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

    // LIVE landing data from the public dealer feed (same one the lobby uses) -
    // the hero stats and "featured" lists are real chain state, not decor.
    liveLanding();

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

  var DEALER_URL = "/dealer"; // same-origin public feed · domain-agnostic
  var ZERO_ADDR = "0x0000000000000000000000000000000000000000";
  var stt = function (wei) { var v = Number(BigInt(wei || 0)) / 1e18; return v >= 100 ? Math.round(v).toLocaleString("en-US") : +v.toFixed(v >= 1 ? 2 : 4); };

  function liveLanding() {
    if (!document.getElementById("live-stats") && !document.getElementById("feat-cash")) return;
    function esc(s) { return String(s).replace(/[<>&"]/g, function (c) { return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]; }); }
    function apply(lob) {
      var tables = (lob.tables || []).filter(function (t) { return t.controller === ZERO_ADDR; });
      var trns = lob.tournaments || [];
      var running = trns.filter(function (t) { return Number(t.status) === 1; });
      var seated = tables.reduce(function (a, t) { return a + Number(t.seated); }, 0) +
        running.reduce(function (a, t) { return a + Number(t.remaining); }, 0);
      var inHand = tables.filter(function (t) { return t.inHand; }).length;
      var pot = tables.reduce(function (m, t) { return Math.max(m, Number(BigInt(t.pot || 0)) / 1e18); }, 0);
      var set = function (id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
      set("ls-players", String(seated));
      set("ls-tables", String(tables.length));
      set("ls-hands", String(inHand));
      set("ls-pot", pot > 0 ? (+pot.toFixed(2)) + " STT" : "-");

      var fc = document.getElementById("feat-cash");
      if (fc) {
        var top = tables.slice().sort(function (a, b) { return b.seated - a.seated || a.id - b.id; }).slice(0, 3);
        fc.innerHTML = top.map(function (t) {
          return '<a class="fitem" href="table?t=' + t.id + '" style="text-decoration:none"><div class="fmain">' +
            '<div class="ft">NLHE · ' + t.maxSeats + '-max</div>' +
            '<div class="fm">' + t.seated + "/" + t.maxSeats + " seated · rake " + (t.rakeBps / 100) + "%" + (t.inHand ? " · hand in play" : "") + "</div></div>" +
            '<div class="fval tnum">' + stt(t.smallBlind) + " / " + stt(t.bigBlind) + '<span class="u"> STT</span></div></a>';
        }).join("") || '<div class="fitem"><div class="fmain"><div class="fm">No cash tables right now.</div></div></div>';
      }
      var ftr = document.getElementById("feat-trn");
      if (ftr) {
        var open = trns.filter(function (t) { return Number(t.status) <= 1; }).sort(function (a, b) { return b.id - a.id; }).slice(0, 3);
        ftr.innerHTML = open.map(function (t) {
          var st = Number(t.status) === 1 ? (t.remaining + " left · in progress") : ("registering · " + t.registered + "/" + t.maxPlayers);
          var cost = BigInt(t.buyIn || 0) + BigInt(t.fee || 0);
          return '<a class="fitem" href="tournament?id=' + t.id + '" style="text-decoration:none"><div class="fmain">' +
            '<div class="ft">' + esc(t.maxPlayers + "-max " + (cost === 0n ? "freeroll" : "tournament") + " #" + t.id) + "</div>" +
            '<div class="fm secure">✓ ' + stt(t.pool) + " STT secured on-chain · " + esc(st) + "</div></div>" +
            '<div class="fval tnum">' + (cost === 0n ? "FREE" : stt(cost.toString()) + '<span class="u"> STT</span>') + "</div></a>";
        }).join("") || '<div class="fitem"><div class="fmain"><div class="fm">No open events · start one in the lobby.</div></div></div>';
      }
    }
    fetch(DEALER_URL + "/lobby").then(function (r) { return r.json(); }).then(apply).catch(function () {
      var fc = document.getElementById("feat-cash");
      if (fc) fc.innerHTML = '<div class="fitem"><div class="fmain"><div class="fm">Live feed warming up · open the lobby for tables.</div></div></div>';
      var ftr = document.getElementById("feat-trn");
      if (ftr) ftr.innerHTML = '<div class="fitem"><div class="fmain"><div class="fm">Live feed warming up · open the lobby for events.</div></div></div>';
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", inject);
  else inject();
})();
