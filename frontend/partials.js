/* Shared chrome injector - loader, nav, footer, cursor, page transitions */

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
        network: "somniaTestnet", casino: "-", houseManager: "-", agentVerifier: "-",
        registry: "-", agentPlatform: "-", agentIds: {},
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

  const shortAddr = (a) => (a && a.length > 10 ? `${a.slice(0,6)}…${a.slice(-4)}` : (a || "-"));

  function buildLines(cfg) {
    const netLabel = cfg.network === "somniaMainnet" ? "mainnet" : "testnet";
    const ids = cfg.agentIds || {};
    return [
      `> connecting to ${netLabel}…`,
      `> resolving agent registry ${shortAddr(cfg.agentPlatform)}`,
      `> handshake LLM Inference · ${ids.llm || "-"} ✓`,
      `> handshake JSON API · ${ids.json || "-"} ✓`,
      `> handshake Parse Website · ${ids.parse || "-"} ✓`,
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

  // Splash strategy: the bar climbs from 0% → 90% via fake timer (snappy
  // animation that lets the user see the brand), then HOLDS at 90% until
  // livedata.js fires `shinyluck:ready` (sent after the initial feed +
  // stats scans complete). This guarantees the splash covers the slowest
  // on-chain RPC the page needs - by the time the splash fades, the feed
  // and ticker are already populated, not "loading…".
  let p = 0, lineIdx = 0;
  let dataReady = false;
  let finishingUp = false;
  document.addEventListener('shinyluck:ready', () => { dataReady = true; }, { once: true });
  // Slot pages dispatch `shinyluck:slot-mounted` when their UI is up and
  // either (a) connected + slot rendered or (b) confirmed unauthenticated
  // and the connect prompt is shown. Listening for this avoids the flash
  // where the splash fades early, the connect-prompt appears for a few
  // hundred ms, and THEN the slot renders. Falls back to the data-ready
  // event (lobby/leaderboard) or the 8s safety timeout.
  document.addEventListener('shinyluck:slot-mounted', () => { dataReady = true; }, { once: true });

  // Pages with neither livedata nor a slot dispatch (simple games like
  // dice/crash) should release on DOMContentLoaded so we don't trap them
  // for 8s. We detect this structurally - no livedata.js script AND no
  // [data-slot-root] hook in the page.
  const hasLivedata = !!document.querySelector('script[src*="livedata"]');
  const hasSlotRoot = !!document.getElementById('slot-root');
  if (!hasLivedata && !hasSlotRoot) {
    const release = () => { dataReady = true; };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', release, { once: true });
    } else {
      release();
    }
  }
  // Safety: if neither shinyluck:ready nor shinyluck:slot-mounted fires
  // (offline RPC, mount crash) the splash should NOT trap the page. Auto-
  // release after 15s. Slot pages occasionally need 8-10s for the full
  // Privy bootstrap + balance/chargeMeter chain reads + slot skeleton
  // render on cold cache, so the previous 8s safety could fire BEFORE
  // mount completed → empty screen flash between splash and slot UI.
  setTimeout(() => { dataReady = true; }, 15000);
  const tick = () => {
    const ceiling = dataReady ? 100 : 90;
    p += Math.random() * 6 + 3;
    if (p > ceiling) p = ceiling;
    fill.style.width = p + '%';
    pctEl.textContent = Math.floor(p) + '%';
    if (lineIdx < cachedLines.length && p > (lineIdx + 1) * (100 / cachedLines.length)) {
      const ln = document.createElement('div');
      ln.className = 'sl-loader-log-line';
      ln.textContent = cachedLines[lineIdx];
      logEl.appendChild(ln);
      lineIdx++;
    }
    if (p < 100) {
      // While capped at 90%, slow the cadence so the bar doesn't visibly
      // re-tick the same %. Use 100ms throttle vs raf.
      if (p >= 90 && !dataReady) setTimeout(tick, 120);
      else if (p >= 90 && dataReady && !finishingUp) { finishingUp = true; requestAnimationFrame(tick); }
      else requestAnimationFrame(tick);
    } else {
      setTimeout(() => loader.classList.add('done'), 280);
    }
  };
  if (document.readyState !== 'loading') requestAnimationFrame(tick);
  else document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(tick));

  // ---------- NAV ----------
  const navHTML = `
    <header class="nav">
      <div class="nav-inner">
        <a class="logo" href="/" data-link data-hover>
          <span class="brackets">{</span><span class="name"><b>l</b></span><span class="brackets">}</span>
          <span class="name">ShinyLuck</span>
          <span class="badge-mainnet" data-sl-network-badge>-</span>
        </a>
        <nav class="nav-links">
          <a href="/#games" data-link data-page="games">Games</a>
          <a href="/leaderboard" data-link data-page="leaderboard">Leaderboard</a>
          <a href="/fair" data-link data-page="fair">Provably Fair</a>
          <a href="/docs" data-link data-page="docs">Docs</a>
          <a href="/account" data-link data-page="account">Account</a>
          <a href="/agent" data-link data-page="agent">My Agent</a>
        </nav>
        <div class="nav-spacer"></div>
        <button class="btn btn-ghost" data-hover data-wallet-btn>Connect Wallet</button>
        <a class="btn btn-primary" data-hover href="/#games" data-link>Play Now →</a>
      </div>
    </header>
  `;

  function footerHTMLFor(cfg) {
    const addrLink = (label, addr) => addr && addr !== "-"
      ? `<a href="${explorerBase}/address/${addr}" target="_blank" rel="noopener" data-hover>${label}: <span class="mono">${shortAddr(addr)}</span></a>`
      : `<span>${label}: -</span>`;
    return `
    <footer>
      <div class="foot-grid">
        <div class="foot-brand">
          <div class="logo foot-brand-name">
            <span class="brackets">{</span><span class="name"><b>l</b></span><span class="brackets">}</span>
            <span>ShinyLuck</span>
          </div>
          <p class="foot-tag">Provably fair, agent-settled gambling on Somnia. Open contracts, open RNG, open books - every bet auditable from the Genesis block.</p>
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
          <a href="../games/vault7/index.html" data-link>Vault.7 (slots)</a>
          <a href="../games/sugar/index.html" data-link>Sugar.Lab (cluster)</a>
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
    // Template paths use `../X.html` - that's correct from `/games/X.html`
    // (1 dir deep). For root pages we strip the `../` since it's irrelevant.
    // For nested game pages `/games/sugar/index.html` (2 dirs deep) we
    // PREFIX an extra `../` per extra level.
    const path = location.pathname.replace(/[^/]*$/, '');           // dir part
    const inGames = path.includes('/games/');
    const segs = path.split('/').filter(Boolean);
    const gamesIdx = segs.indexOf('games');
    // depthInGames: how many extra dirs we are below /games/
    //   /games/dice.html      → dir = '/games/'         → segs=['games']         → depth=0
    //   /games/sugar/X.html   → dir = '/games/sugar/'   → segs=['games','sugar'] → depth=1
    const depthInGames = gamesIdx >= 0 ? Math.max(0, segs.length - gamesIdx - 1) : 0;
    if (!inGames) {
      return html.replace(/href="\.\.\//g, 'href="').replace(/src="\.\.\//g, 'src="');
    }
    if (depthInGames >= 1) {
      // Add depthInGames extra `../` to every `href="../` and `src="../`.
      const extra = '../'.repeat(depthInGames);
      return html
        .replace(/href="\.\.\//g, `href="${extra}../`)
        .replace(/src="\.\.\//g, `src="${extra}../`);
    }
    return html;
  }

  async function mount() {
    const page = document.querySelector('[data-page-shell]');
    if (!page) return;
    // Inject favicon link if the page doesn't have one. The user put their
    // .ico file at /Luck.ico (also duplicated to /favicon.ico for browsers
    // that probe the root by convention).
    if (!document.querySelector('link[rel="icon"]')) {
      const link = document.createElement('link');
      link.rel = 'icon';
      link.type = 'image/x-icon';
      link.href = '/favicon.ico';
      document.head.appendChild(link);
    }
    // TESTING ribbon on beta game pages - every game except Sugar + Dice.
    // pointer-events:none in CSS means the user can still click through to
    // the place-bet UI underneath; this is just a visual "warning, rough
    // edges" marker. The two stable games (sugar/dice) are explicitly
    // excluded so the lobby's most-promoted titles look polished.
    const path = (location.pathname || "").toLowerCase();
    const isGamePage = /\/games\//.test(path);
    // sugar, dice AND vault7 are the polished, fully-working titles - no
    // TESTING ribbon on them.
    const isStableGame = /\/games\/(sugar|dice|vault7)/.test(path);
    if (isGamePage && !isStableGame && !document.querySelector('.sl-testing-ribbon')) {
      const ribbon = document.createElement('div');
      ribbon.className = 'sl-testing-ribbon';
      ribbon.innerHTML = '<span>TESTING</span>';
      ribbon.title = 'This game is in beta - sugar/dice are the polished demos';
      document.body.appendChild(ribbon);
    }
    // Slot pages hide the ambient orb layer in CSS - there's no point
    // running the parallax RAF loop on them since the effect is invisible
    // and the per-frame setProperty triggers style recalc on the whole
    // .amb subtree. Detect by checking the slot-root hook before mounting
    // the ambient layer at all on those pages.
    const isSlotPage = !!document.getElementById('slot-root');
    if (!document.querySelector('.amb') && !isSlotPage) {
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
      let lastMx = 0, lastMy = 0;
      addEventListener('mousemove', e => {
        tx = (e.clientX / innerWidth - .5) * 24;
        ty = (e.clientY / innerHeight - .5) * 24;
      }, { passive: true });
      // Throttle the parallax to ~30 Hz and only write the CSS var when the
      // value actually moved more than 0.5 px. The CSS rule sets an 0.8s
      // transition on .amb's transform, so the browser smooths between
      // updates anyway - driving setProperty at 60 Hz did NOT make the
      // motion smoother but DID force a style recalc on the entire .amb
      // subtree every frame (3 blurred orbs, scanline, noise). That recalc
      // was the dominant main-thread cost responsible for the visible
      // cursor lag on the lobby (the cursor RAF runs in the same frame
      // budget and starved). Skipping ~50% of frames + skipping no-ops
      // gives the cursor RAF most of its frame back.
      let lastTick = 0;
      (function p(now){
        if (now - lastTick >= 32) {
          lastTick = now;
          cx += (tx - cx) * 0.08;  // 2x lerp coefficient since we tick at 30 Hz
          cy += (ty - cy) * 0.08;
          if (Math.abs(cx - lastMx) > 0.5 || Math.abs(cy - lastMy) > 0.5) {
            amb.style.setProperty('--mx', cx.toFixed(1) + 'px');
            amb.style.setProperty('--my', cy.toFixed(1) + 'px');
            lastMx = cx; lastMy = cy;
          }
        }
        requestAnimationFrame(p);
      })(0);
    }
    const navMount = document.querySelector('[data-mount="nav"]');
    const footMount = document.querySelector('[data-mount="footer"]');
    if (navMount) navMount.outerHTML = fixRelative(navHTML);
    const cfg = await expectConfig();
    if (footMount) footMount.outerHTML = fixRelative(footerHTMLFor(cfg));
    // Update the TESTNET/MAINNET badge text - used to be done by livedata.js,
    // but Sugar/Vault7 don't include livedata so the badge stayed as "-".
    // Set it here from the cfg we already have, so every page has it.
    const isMainnet = cfg.network === "somniaMainnet";
    const label = isMainnet ? "MAINNET" : "TESTNET";
    document.querySelectorAll('[data-sl-network-badge]').forEach((el) => {
      el.textContent = label;
      el.classList.toggle("is-testnet", !isMainnet);
      el.classList.toggle("is-mainnet", isMainnet);
    });
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
  // Was a 520ms setTimeout fade - felt laggy. Now: navigate immediately, the
  // overlay shows for ~120ms while the new page is fetching (visual courtesy).
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link], a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('http') || a.target === '_blank') return;
    if (!href.endsWith('.html') && !href.includes('.html#') && !href.includes('.html?')) return;
    e.preventDefault();
    transition.classList.add('active');
    window.location.href = href;
  });

  // ---------- CURSOR ----------
  // Original RAF spring-lerp cursor - same code path on every page.
  // The Sugar page now has all its heavy CSS animations disabled, so
  // the main thread has enough budget to tick this loop at 60 fps.
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
