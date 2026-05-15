/* Shared chrome injector — loader, nav, footer, cursor, page transitions */

(function injectChrome() {

  // Capture this script's URL synchronously so we can resolve sibling assets
  // even after async callbacks (document.currentScript only works at parse).
  const partialsBase = (document.currentScript && document.currentScript.src)
    ? new URL(document.currentScript.src, document.baseURI)
    : new URL(location.href);
  const explorerBase = "https://shannon-explorer.somnia.network";

  function expectConfig() {
    if (typeof window !== "undefined" && window.SL_CONFIG) return Promise.resolve(window.SL_CONFIG);
    return new Promise((resolve) => {
      const done = (cfg) => resolve(cfg);
      // event-driven: lib/config.js dispatches it on module evaluation
      document.addEventListener("shinyluck:config", (e) => done(e.detail || window.SL_CONFIG), { once: true });
      // dynamic import fallback (works because lib/config.js lives next to partials.js)
      const url = new URL("./lib/config.js", partialsBase).href;
      import(url).then((m) => { if (m && m.CONFIG) done(m.CONFIG); }).catch(() => {});
      // last-ditch placeholder so the loader never hangs forever
      setTimeout(() => done(window.SL_CONFIG || {
        network: "somniaTestnet", casino: "—", houseManager: "—", agentVerifier: "—",
        registry: "—", agentPlatform: "—", agentIds: {},
      }), 1200);
    });
  }

  // ---------- LOADER ----------
  const loader = document.createElement('div');
  loader.className = 'sl-loader';
  loader.innerHTML = `
    <div class="sl-loader-grid"></div>
    <div class="sl-loader-stack">
      <div class="sl-loader-logo">
        <span class="b">{</span><span class="s">l</span><span class="b">}</span>
        <span class="n">ShinyLuck</span>
      </div>
      <div class="sl-loader-line">
        <div class="sl-loader-line-fill"></div>
      </div>
      <div class="sl-loader-status">
        <span class="sl-loader-key">INITIALIZING</span>
        <span class="sl-loader-dots">...</span>
        <span class="sl-loader-pct">0%</span>
      </div>
      <div class="sl-loader-log" id="sl-loader-log"></div>
    </div>
  `;
  document.documentElement.appendChild(loader);

  // ---------- TRANSITION OVERLAY ----------
  const transition = document.createElement('div');
  transition.className = 'sl-transition';
  transition.innerHTML = `
    <div class="sl-trans-grid"></div>
    <div class="sl-trans-logo">
      <span class="b">{</span><span class="s">l</span><span class="b">}</span>
    </div>
    <div class="sl-trans-bar"></div>
  `;
  document.documentElement.appendChild(transition);

  // ---------- LOADER ANIMATION ----------
  const fill = loader.querySelector('.sl-loader-line-fill');
  const pctEl = loader.querySelector('.sl-loader-pct');
  const logEl = loader.querySelector('#sl-loader-log');

  const shortAddr = (a) => (a && a.length > 10 ? `${a.slice(0,6)}…${a.slice(-4)}` : (a || "—"));

  function buildLines(cfg) {
    const netLabel = cfg.network === "somniaMainnet" ? "mainnet" : "testnet";
    const ids = cfg.agentIds || {};
    return [
      `> connecting to ${netLabel}…`,
      `> resolving agent registry ${shortAddr(cfg.agentPlatform)}`,
      `> handshake LLM Inference · ${ids.llm || "—"} ✓`,
      `> handshake JSON API · ${ids.json || "—"} ✓`,
      `> handshake Parse Website · ${ids.parse || "—"} ✓`,
      `> handshake House Manager · autonomous ✓`,
      `> casino contract synced · ${shortAddr(cfg.casino)}`,
      `> reveal-bot live · finality ~1.2s · ready`,
    ];
  }

  let cachedLines = [
    "> connecting to somnia…",
    "> resolving agent registry…",
    "> handshake LLM Inference",
    "> handshake JSON API",
    "> handshake Parse Website",
    "> handshake House Manager",
    "> casino contract syncing…",
    "> reveal-bot live · ready",
  ];
  expectConfig().then((cfg) => {
    cachedLines = buildLines(cfg);
    // Patch any lines that have already been printed.
    const printed = logEl.querySelectorAll(".sl-loader-log-line");
    printed.forEach((el, i) => { if (cachedLines[i]) el.textContent = cachedLines[i]; });
  });

  let p = 0, lineIdx = 0;
  const tick = () => {
    p += Math.random() * 6 + 3;
    if (p > 100) p = 100;
    fill.style.width = p + '%';
    pctEl.textContent = Math.floor(p) + '%';
    if (lineIdx < cachedLines.length && p > (lineIdx + 1) * (100 / cachedLines.length)) {
      const ln = document.createElement('div');
      ln.className = 'sl-loader-log-line';
      ln.textContent = cachedLines[lineIdx];
      logEl.appendChild(ln);
      lineIdx++;
    }
    if (p < 100) requestAnimationFrame(tick);
    else setTimeout(() => loader.classList.add('done'), 280);
  };
  if (document.readyState !== 'loading') requestAnimationFrame(tick);
  else document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(tick));

  // ---------- NAV ----------
  const navHTML = `
    <header class="nav">
      <div class="nav-inner">
        <a class="logo" href="../SomniaLuck.html" data-link data-hover>
          <span class="brackets">{</span><span class="name"><b>l</b></span><span class="brackets">}</span>
          <span class="name">ShinyLuck</span>
          <span class="badge-mainnet" data-sl-network-badge>—</span>
        </a>
        <nav class="nav-links">
          <a href="../SomniaLuck.html#games" data-link data-page="games">Games</a>
          <a href="../leaderboard.html" data-link data-page="leaderboard">Leaderboard</a>
          <a href="../fair.html" data-link data-page="fair">Provably Fair</a>
          <a href="../docs.html" data-link data-page="docs">Docs</a>
          <a href="../account.html" data-link data-page="account">Account</a>
          <a href="../agent.html" data-link data-page="agent">My Agent</a>
        </nav>
        <div class="nav-spacer"></div>
        <button class="btn btn-ghost" data-hover data-wallet-btn>Connect Wallet</button>
        <a class="btn btn-primary" data-hover href="../SomniaLuck.html#games" data-link>Play Now →</a>
      </div>
    </header>
  `;

  function footerHTMLFor(cfg) {
    const addrLink = (label, addr) => addr && addr !== "—"
      ? `<a href="${explorerBase}/address/${addr}" target="_blank" rel="noopener" data-hover>${label}: <span class="mono">${shortAddr(addr)}</span></a>`
      : `<span>${label}: —</span>`;
    return `
    <footer>
      <div class="foot-grid">
        <div class="foot-brand">
          <div class="logo foot-brand-name">
            <span class="brackets">{</span><span class="name"><b>l</b></span><span class="brackets">}</span>
            <span>ShinyLuck</span>
          </div>
          <p class="foot-tag">Provably fair, agent-settled gambling on Somnia. Open contracts, open RNG, open books — every bet auditable from the Genesis block.</p>
          <div class="foot-socials">
            <a class="social-tag" data-hover href="https://github.com/" target="_blank" rel="noopener">GITHUB</a>
            <a class="social-tag" data-hover href="https://discord.com/" target="_blank" rel="noopener">DISCORD</a>
            <a class="social-tag" data-hover href="../docs.html" data-link>DOCS</a>
            <a class="social-tag" data-hover href="https://x.com/" target="_blank" rel="noopener">X</a>
          </div>
        </div>
        <div class="foot-col">
          <h4>Games</h4>
          <a href="../games/crash.html" data-link>Crash</a>
          <a href="../games/vault7.html" data-link>Vault.7 (slots)</a>
          <a href="../games/cluster.html" data-link>Sugar.Lab (cluster)</a>
          <a href="../games/dice.html" data-link>Dice</a>
          <a href="../games/plinko.html" data-link>Plinko</a>
          <a href="../games/mines.html" data-link>Mines</a>
          <a href="../games/roulette.html" data-link>Roulette</a>
        </div>
        <div class="foot-col">
          <h4>Platform</h4>
          <a href="../leaderboard.html" data-link>Leaderboard</a>
          <a href="../fair.html" data-link>Provably Fair</a>
          <a href="../docs.html" data-link>Docs</a>
          <a href="../agent.html" data-link>My Agent</a>
          <a href="../account.html" data-link>Account</a>
        </div>
        <div class="foot-col">
          <h4>Contracts</h4>
          ${addrLink("Casino", cfg.casino)}
          ${addrLink("HM", cfg.houseManager)}
          ${addrLink("Verifier", cfg.agentVerifier)}
          ${addrLink("Registry", cfg.registry)}
          ${addrLink("Agent Platform", cfg.agentPlatform)}
        </div>
      </div>
      <div class="foot-bottom">
        <span>© 2026 All rights reserved.</span>
        <span class="age">18+ · play responsibly</span>
        <span class="verified">● contracts verified ·
          <a href="${explorerBase}/address/${cfg.agentPlatform || ''}" target="_blank" rel="noopener" style="color:inherit;">${shortAddr(cfg.agentPlatform)}</a>
        </span>
      </div>
      <div class="built-on">
        <span>Built on</span>
        <a class="pill" href="https://somnia.network" target="_blank" rel="noopener" data-hover>
          <span class="dot"></span> <b>Somnia Network</b> <span class="arrow">→</span> the Agentic L1
        </a>
      </div>
    </footer>
    `;
  }

  // ---------- INSERT INTO PAGE ----------
  function fixRelative(html) {
    const inGames = location.pathname.includes('/games/');
    if (inGames) return html;
    return html.replace(/href="\.\.\//g, 'href="').replace(/src="\.\.\//g, 'src="');
  }

  async function mount() {
    const page = document.querySelector('[data-page-shell]');
    if (!page) return;
    if (!document.querySelector('.amb')) {
      const amb = document.createElement('div');
      amb.className = 'amb';
      amb.innerHTML = `
        <div class="amb-grid"></div>
        <div class="amb-orb amb-orb-1"></div>
        <div class="amb-orb amb-orb-2"></div>
        <div class="amb-orb amb-orb-3"></div>
        <div class="amb-scanline"></div>
        <div class="amb-noise"></div>
      `;
      document.body.insertBefore(amb, document.body.firstChild);
      let tx = 0, ty = 0, cx = 0, cy = 0;
      addEventListener('mousemove', e => {
        tx = (e.clientX / innerWidth - .5) * 24;
        ty = (e.clientY / innerHeight - .5) * 24;
      });
      (function p(){
        cx += (tx - cx) * 0.04;
        cy += (ty - cy) * 0.04;
        amb.style.setProperty('--mx', cx.toFixed(2) + 'px');
        amb.style.setProperty('--my', cy.toFixed(2) + 'px');
        requestAnimationFrame(p);
      })();
    }
    const navMount = document.querySelector('[data-mount="nav"]');
    const footMount = document.querySelector('[data-mount="footer"]');
    if (navMount) navMount.outerHTML = fixRelative(navHTML);
    const cfg = await expectConfig();
    if (footMount) footMount.outerHTML = fixRelative(footerHTMLFor(cfg));
    const active = document.body.dataset.activePage;
    if (active) {
      document.querySelectorAll('[data-page]').forEach(a => {
        if (a.dataset.page === active) a.classList.add('active');
      });
    }
    // Signal to wallet.js that [data-wallet-btn] now exists in DOM, so a
    // pre-existing Sequence/MetaMask session can re-paint the button.
    document.dispatchEvent(new CustomEvent('shinyluck:chrome-ready'));
  }
  if (document.readyState !== 'loading') mount();
  else document.addEventListener('DOMContentLoaded', mount);

  // ---------- PAGE TRANSITIONS ----------
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link], a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('http') || a.target === '_blank') return;
    if (!href.endsWith('.html') && !href.includes('.html#') && !href.includes('.html?')) return;
    e.preventDefault();
    transition.classList.add('active');
    setTimeout(() => { window.location.href = href; }, 520);
  });

  // ---------- CURSOR ----------
  const dot = document.createElement('div');
  const ring = document.createElement('div');
  dot.className = 'cursor-dot';
  ring.className = 'cursor-ring';
  document.documentElement.appendChild(dot);
  document.documentElement.appendChild(ring);

  let mx = innerWidth/2, my = innerHeight/2, dx = mx, dy = my, rx = mx, ry = my;
  addEventListener('mousemove', e => { mx = e.clientX; my = e.clientY; });
  function loop() {
    dx += (mx - dx) * 0.55; dy += (my - dy) * 0.55;
    rx += (mx - rx) * 0.16; ry += (my - ry) * 0.16;
    dot.style.transform = `translate(${dx}px,${dy}px) translate(-50%,-50%)`;
    ring.style.transform = `translate(${rx}px,${ry}px) translate(-50%,-50%)`;
    requestAnimationFrame(loop);
  }
  loop();
  const hoverSel = 'a, button, .game, .agent-card, .tile, .stat, .flow-step, .chip, .social-tag, [data-hover], input, .bet-row, .row';
  document.addEventListener('mouseover', e => { if (e.target.closest(hoverSel)) ring.classList.add('hover'); });
  document.addEventListener('mouseout', e => {
    if (e.target.closest(hoverSel) && !e.relatedTarget?.closest(hoverSel)) ring.classList.remove('hover');
  });
  document.addEventListener('mousedown', () => ring.classList.add('click'));
  document.addEventListener('mouseup', () => ring.classList.remove('click'));
})();
