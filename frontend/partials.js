/* ============================================================================
   Shared chrome injector v2 · gold/matte design (from ShinyLuck.dc.html).
   Injects: loader, topbar, sidebar, footer, profile drawer, settings modal,
   mobile bottom bar, dust layer, page-transition veil.
   Contracts kept from v1: [data-mount="nav"], [data-mount="footer"],
   `shinyluck:config`, `shinyluck:ready`, `shinyluck:slot-mounted`,
   `shinyluck:chrome-ready`, [data-sl-network-badge], body[data-active-page].
   New mounts: [data-mount="side"].
   ========================================================================== */

(function injectChrome() {

  const partialsBase = (document.currentScript && document.currentScript.src)
    ? new URL(document.currentScript.src, document.baseURI)
    : new URL(location.href);
  const explorerBase = "https://shannon-explorer.somnia.network";

  // Embedded inside the shell's view iframe (/, /poker, /dice, …): the parent
  // page owns nav/sidebar/footer, so we skip the chrome and forward internal
  // navigation up to the shell router instead of navigating the frame.
  const EMBED = (() => {
    try { if (window.self !== window.top) return true; } catch (_) { return true; }
    return /(^|[?&])embed=1/.test(location.search);
  })();
  if (EMBED) document.documentElement.classList.add('sl-embed');

  // ── ONE SCROLLBAR ─────────────────────────────────────────────────────────
  // A framed page that scrolls itself puts a second scrollbar right next to the
  // shell's. Instead the frame reports its content height and the shell grows
  // the iframe to match · the frame then never needs to scroll and the page
  // does all the scrolling (which is also what keeps the footer reachable).
  // Pages that are deliberately viewport-sized (roulette, poker table) simply
  // report the viewport height and stay put.
  function measureHeight() {
    const d = document.documentElement;
    const b = document.body;
    return Math.ceil(Math.max(
      d ? d.scrollHeight : 0,
      b ? b.scrollHeight : 0,
      b ? b.offsetHeight : 0,
    ));
  }
  let lastH = 0;
  function reportHeight() {
    if (!EMBED) return;
    const h = measureHeight();
    if (!h || Math.abs(h - lastH) < 2) return;
    lastH = h;
    try { window.parent.postMessage({ type: 'sl-height', h }, '*'); } catch (_) {}
  }
  if (EMBED) {
    addEventListener('load', reportHeight);
    addEventListener('resize', reportHeight);
    // Games mutate their DOM constantly (reels, boards) · observe instead of
    // polling hard, with a slow tick as the backstop for transitions/fonts.
    try { new ResizeObserver(() => reportHeight()).observe(document.documentElement); } catch (_) {}
    setInterval(reportHeight, 1000);
  }

  const shortAddr = (a) => (a && a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : (a || "-"));

  function expectConfig() {
    if (typeof window !== "undefined" && window.SL_CONFIG) return Promise.resolve(window.SL_CONFIG);
    return new Promise((resolve) => {
      const done = (cfg) => resolve(cfg);
      document.addEventListener("shinyluck:config", (e) => done(e.detail || window.SL_CONFIG), { once: true });
      const url = new URL("./lib/config.js", partialsBase).href;
      import(url).then((m) => { if (m && m.CONFIG) done(m.CONFIG); }).catch(() => {});
      setTimeout(() => done(window.SL_CONFIG || {
        network: "somniaTestnet", casino: "-", houseManager: "-", agentVerifier: "-",
        registry: "-", agentPlatform: "-", agentIds: {},
      }), 1200);
    });
  }

  // Root-relative asset/link helper · pages live at /, /games/ and /games/x/.
  const R = (p) => "/" + p.replace(/^\//, "");

  // ---------- SVG icon paths (design spec) ----------
  const I = {
    spark: 'M12 2.5c.9 5.6 3.4 8.2 8.7 9.5-5.3 1.3-7.8 3.9-8.7 9.5-.9-5.6-3.4-8.2-8.7-9.5 5.3-1.3 7.8-3.9 8.7-9.5Z',
    poker: 'M12 3c3.2 3.8 6.8 5.8 6.8 9.3a3.9 3.9 0 0 1-6.8 2.6 3.9 3.9 0 0 1-6.8-2.6C5.2 8.8 8.8 6.8 12 3Z M9.5 20.5h5M12 15.5v5',
    diamond: 'M12 3l9 9-9 9-9-9 9-9Z M12 9.2 14.8 12 12 14.8 9.2 12Z',
    clock: 'M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z M12 7.5V12l3 2',
    user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M4.5 20.5c1.2-3.6 4.1-5.5 7.5-5.5s6.3 1.9 7.5 5.5',
    trophy: 'M7 4.5h10v2.8a5 5 0 0 1-10 0V4.5Z M7 5.5H4.5V7A3 3 0 0 0 7.5 10 M17 5.5h2.5V7a3 3 0 0 1-3 3 M12 12.3V16 M10 16h4v4h-4Z M8 20h8',
    shield: 'M12 3l7.5 3v6c0 4.6-3.2 7.6-7.5 9-4.3-1.4-7.5-4.4-7.5-9V6L12 3Z M9 12l2.2 2.2 4.2-4.4',
    doc: 'M7 3.5h6.5L18 8v12.5H7Z M13.5 3.5V8H18 M9.8 12.5h4.4 M9.8 16h4.4',
  };
  const icon = (d, size = 20, sw = 1.5) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><path d="${d}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;

  // ---------- LOADER ----------
  const loader = document.createElement('div');
  loader.className = 'loader2';
  loader.innerHTML = `
    <div class="spark"><img src="${R('assets/spark.png')}" alt=""></div>
    <div class="track"><div class="fill"></div></div>
    <div class="status">Syncing Somnia…</div>
  `;
  document.documentElement.appendChild(loader);
  setTimeout(() => loader.classList.add('lit'), 150);

  const fill = loader.querySelector('.fill');
  const statusEl = loader.querySelector('.status');
  let p = 0;
  let dataReady = false;
  document.addEventListener('shinyluck:ready', () => { dataReady = true; }, { once: true });
  document.addEventListener('shinyluck:slot-mounted', () => { dataReady = true; }, { once: true });
  const hasLivedata = !!document.querySelector('script[src*="livedata"]');
  const hasSlotRoot = !!document.getElementById('slot-root');
  if (!hasLivedata && !hasSlotRoot) {
    const release = () => { dataReady = true; };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', release, { once: true });
    else release();
  }
  setTimeout(() => { dataReady = true; }, 15000);
  // setTimeout (not rAF) so the splash still completes in a background tab.
  const tick = () => {
    const ceiling = dataReady ? 100 : 90;
    p += Math.random() * 7 + 4;
    if (p > ceiling) p = ceiling;
    fill.style.width = p + '%';
    if (p > 55) statusEl.textContent = 'Finalizing block state…';
    if (p < 100) setTimeout(tick, p >= 90 && !dataReady ? 140 : 55);
    else setTimeout(() => loader.classList.add('done'), 240);
  };
  if (document.readyState !== 'loading') setTimeout(tick, 30);
  else document.addEventListener('DOMContentLoaded', () => setTimeout(tick, 30));

  // ---------- TRANSITION VEIL ----------
  const veil = document.createElement('div');
  veil.className = 'veil2';
  document.documentElement.appendChild(veil);

  // ---------- NAV (topbar) ----------
  const navHTML = `
    <div style="position:sticky;top:0;z-index:60">
      <nav class="nav2">
        <a class="nav2-logo" href="/" data-link>
          <span class="img"><img src="${R('assets/spark.png')}" alt="ShinyLuck"></span>
          <span class="name">ShinyLuck</span>
          <span class="badge-net" data-sl-network-badge>-</span>
        </a>
        <div style="flex:1"></div>
        <button class="btn2 btn2-gold nav2-connect" data-connect-btn>
          <svg width="14" height="14" viewBox="0 0 24 24"><path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h11.5A2.5 2.5 0 0 1 20 7.5v9A2.5 2.5 0 0 1 17.5 19H6a2.5 2.5 0 0 1-2.5-2.5v-9Z M15 12h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path><circle cx="15.5" cy="12" r="1.1" fill="currentColor"></circle></svg>
          <span data-connect-label>Connect Wallet</span>
        </button>
        <button class="nav2-avatar" data-avatar-btn aria-label="Profile" title="Profile">
          <span class="av" data-avatar-img data-no-i18n style="background-image:url('${R('assets/spark.png')}')"></span>
        </button>
      </nav>
    </div>
  `;

  // ---------- SIDEBAR ----------
  function sideHTML(active) {
    const it = (id, href, label, iconPath, badge, sw) => `
      <a class="it ${active === id ? 'active' : ''}" data-side="${id}" ${href ? `href="${href}" data-link` : ''} title="${label}">
        <span class="ic">${icon(iconPath, 20, sw || 1.5)}</span>
        <span class="lb">${label}</span>
        ${badge ? `<span class="bdg"><span>${badge}</span></span>` : ''}
      </a>`;
    return `
      <aside class="side2" data-r-hide-m>
        <div style="padding:18px 12px 7px;font:600 9px var(--mono);letter-spacing:.2em;color:#57554F;text-transform:uppercase;white-space:nowrap">Casino</div>
        ${it('lobby', '/', 'Lobby', I.spark)}
        ${it('poker', '/poker', 'Poker', I.poker)}
        ${it('nfts', '', 'NFTs', I.diamond, 'SOON')}
        ${it('predictions', '', 'Predictions', I.clock, 'SOON')}
        <div style="flex:1;min-height:22px"></div>
        <div class="side2-foot">
          <button class="fbtn" data-sound-btn aria-label="Toggle sound" title="Sound"><svg width="17" height="17" viewBox="0 0 24 24"><path data-sound-path d="" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></path></svg></button>
          <button class="fbtn" data-settings-btn aria-label="Settings" title="Settings"><svg width="17" height="17" viewBox="0 0 24 24"><path d="M19.4 13a7.8 7.8 0 0 0 0-2l2-1.5-2-3.5-2.4 1a7.8 7.8 0 0 0-1.7-1L15 3H9l-.3 2.5a7.8 7.8 0 0 0-1.7 1l-2.4-1-2 3.5L2.6 11a7.8 7.8 0 0 0 0 2l-2 1.5 2 3.5 2.4-1a7.8 7.8 0 0 0 1.7 1L9 21h6l.3-2.5a7.8 7.8 0 0 0 1.7-1l2.4 1 2-3.5-2-1.5Z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path></svg></button>
          <a class="fbtn" href="https://x.com/ShinyLuck_" target="_blank" rel="noopener" aria-label="X (Twitter)" title="X"><svg width="14" height="14" viewBox="0 0 24 24"><path d="M3 3h4.7l4.3 6 5-6H20l-6.7 7.9L21 21h-4.7l-4.6-6.5L6.2 21H3.4l7.1-8.4Z" fill="currentColor"></path></svg></a>
          <a class="fbtn" href="/docs" data-link aria-label="Docs" title="Docs">${icon(I.doc, 17)}</a>
        </div>
      </aside>
    `;
  }

  // ---------- FOOTER ----------
  function footerHTMLFor(cfg) {
    const poker = window.POKER_ADDR || {
      pokerRoom: "0xFeF7d1bb6c0DffaB4e13D9b49BBE1F1459266A24",
      pokerTournament: "0xf2d3785645985618b866594cE6e924Ae35608948",
      playerProfile: "0x7364E1ED8a07b4659c059fa66D346c42907C3F14",
    };
    // `hook` marks a row whose address may still be loading · it renders hidden
    // and paintContractLink() fills it the moment the real config lands.
    const addrLink = (label, addr, hook) => {
      const known = addr && addr !== "-";
      if (!known && !hook) return ``;
      return `<a ${hook ? `data-contract-link="${hook}" data-contract-label="${label}"` : ""}`
        + ` href="${known ? `${explorerBase}/address/${addr}` : "#"}" target="_blank" rel="noopener"`
        + `${known ? "" : ` style="display:none"`}>`
        + `${label} · <span style="font-family:var(--mono);font-size:11px">${known ? shortAddr(addr) : "-"}</span></a>`;
    };
    return `
    <footer class="foot2" data-r-pad-m>
      <div class="foot2-grid" data-r-grid-m1>
        <div>
          <span class="logo-img"><img src="${R('assets/spark.png')}" alt="ShinyLuck"></span>
          <div class="stats">
            <span>Bankroll <b data-sl="bankroll">-</b> STT</span>
            <span>Players <b data-sl="playersOnline">-</b></span>
            <span>Bets <b data-sl="totalBets">-</b></span>
            <span>block <b data-sl="blockNumber">-</b></span>
            <span>finality <b data-sl="finality">-</b>s</span>
          </div>
        </div>
        <div>
          <h4>Information</h4>
          <div class="col">
            <a href="/docs" data-link>Docs</a>
            <a href="/fair" data-link>Provably Fair</a>
            <a href="/leaderboard" data-link>Leaderboard</a>
            <a href="/zk-lab" data-link>ZK Lab</a>
          </div>
        </div>
        <div>
          <h4>Contracts</h4>
          <div class="col">
            ${addrLink("Casino", cfg.casino, "casino")}
            ${addrLink("PokerRoom", poker.pokerRoom)}
            ${addrLink("Tournaments", poker.pokerTournament)}
            ${addrLink("Profiles", poker.playerProfile)}
          </div>
        </div>
      </div>
      <div class="foot2-bottom">
        <span>© 2026 ShinyLuck · All rights reserved · 18+ · Play responsibly · Somnia testnet · STT carries no monetary value</span>
      </div>
    </footer>
    `;
  }

  // ---------- MOBILE BOTTOM BAR ----------
  function mobHTML(active) {
    const it = (id, href, label, d) => `
      <a ${href ? `href="${href}" data-link` : 'href="#"'} class="${active === id ? 'active' : ''}">
        <svg width="21" height="21" viewBox="0 0 24 24"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>
        <span>${label}</span>
      </a>`;
    return `
      <div class="mob2" data-r-show-m>
        ${it('lobby', '/', 'Lobby', I.spark)}
        ${it('poker', '/poker', 'Poker', I.poker)}
        <button data-avatar-btn-mob>
          <svg width="21" height="21" viewBox="0 0 24 24"><path d="${I.user}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>
          <span>Profile</span>
        </button>
      </div>
    `;
  }

  // ---------- PROFILE DRAWER + SETTINGS (skeleton; logic in lib/profile.js) ----------
  const drawerHTML = `
    <div class="pdrawer-mask" data-pdrawer-mask>
      <div class="pdrawer-veil" data-pdrawer-close></div>
      <div class="pdrawer">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font:700 15px var(--sans);color:var(--fg-strong)">Profile</span>
          <span style="flex:1"></span>
          <button class="x" data-pdrawer-close aria-label="Close">×</button>
        </div>
        <div style="display:flex;flex-direction:column;align-items:center;gap:11px;margin-top:18px">
          <span class="avatar-big"><span class="av" data-avatar-img data-no-i18n style="background-image:url('${R('assets/spark.png')}')"></span></span>
          <input type="file" accept="image/*" data-avatar-file style="display:none">
          <button class="mini" data-avatar-upload style="height:32px;padding:0 14px;border-radius:8px;font:600 11px var(--sans)">
            <svg width="12" height="12" viewBox="0 0 24 24" style="vertical-align:-1px;margin-right:6px"><path d="M12 16V5m0 0 4 4m-4-4L8 9M5 19h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path></svg>Upload</button>
          <div data-nick-view style="display:flex;align-items:center;gap:7px">
            <span class="nick-chip"><span class="dot"></span><span data-nick-label data-no-i18n>-</span></span>
            <button class="mini" data-nick-edit aria-label="Edit nickname" title="Set a nickname" style="width:30px;height:30px;padding:0"><svg width="13" height="13" viewBox="0 0 24 24"><path d="M4 20h4L18.5 9.5a2 2 0 0 0 0-3l-1-1a2 2 0 0 0-3 0L4 16v4Z M13.5 7.5l3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg></button>
          </div>
          <div data-nick-form style="display:none;align-items:center;gap:6px">
            <input class="in2" data-nick-input placeholder="Choose a nickname" maxlength="20" style="height:34px;width:166px;font:500 12px var(--sans)">
            <button class="btn2 btn2-gold" data-nick-save style="height:34px;padding:0 13px;font:600 11px var(--sans)">Save</button>
            <button class="mini" data-nick-cancel style="width:34px;height:34px;padding:0">×</button>
          </div>
          <div class="msg" data-nick-msg></div>
        </div>
        <div class="box">
          <div class="k-label">Wallet balance</div>
          <div class="bal"><span data-wallet-bal>-</span> <span class="u">STT</span></div>
          <!-- Casino wins are pull-payment: the contract credits them, you pull
               them. Only shown when something is actually claimable. -->
          <div data-claim-box style="display:none;margin-top:14px;padding:12px;border:1px solid rgba(111,207,151,.3);border-radius:12px;background:rgba(111,207,151,.06)">
            <div style="display:flex;align-items:center;gap:8px">
              <div style="flex:1;min-width:0">
                <div class="k-label" style="color:var(--green)">Unclaimed winnings</div>
                <div style="margin-top:4px;font:600 18px var(--mono);color:var(--green)"><span data-claim-amt>0</span> <span style="font:500 10px var(--mono);color:var(--fg-faint)">STT</span></div>
              </div>
              <button class="btn2 btn2-gold" data-claim-go style="height:36px;padding:0 16px;font:600 12px var(--sans)">Claim</button>
            </div>
            <div class="msg" data-claim-msg></div>
          </div>
          <div class="k-label" style="margin:15px 0 6px">Deposit address</div>
          <div class="addr-row">
            <span class="a" data-deposit-addr>-</span>
            <button class="mini" data-copy-addr>Copy</button>
          </div>
          <div class="k-label" style="margin:15px 0 6px">Withdraw</div>
          <input class="in2" data-wdr-dest placeholder="Destination address 0x…">
          <div style="display:flex;gap:8px;margin-top:8px">
            <input class="in2" data-wdr-amt inputmode="decimal" placeholder="Amount" style="flex:1;min-width:0;font:600 13px var(--mono)">
            <button class="btn2 btn2-gold" data-wdr-go style="height:40px;padding:0 18px;font:600 12px var(--sans)">Withdraw</button>
          </div>
          <div class="msg" data-wallet-msg></div>
        </div>
        <div class="box">
          <div style="display:flex;align-items:center">
            <span class="k-label">Poker balance</span><span style="flex:1"></span>
            <span style="font:600 8px var(--mono);letter-spacing:.18em;color:var(--fg-faint);border:1px solid var(--bd);border-radius:6px;padding:3px 7px">SHINYPOKER</span>
          </div>
          <div class="bal gold"><span data-poker-bal>-</span> <span class="u">STT</span></div>
          <input class="in2" data-poker-amt inputmode="decimal" placeholder="Amount" style="margin-top:13px;font:600 13px var(--mono)">
          <div style="display:flex;gap:8px;margin-top:8px">
            <button class="btn2 btn2-gold" data-poker-dep style="flex:1;height:40px;font:600 12px var(--sans)">Top up</button>
            <button class="btn2 btn2-line" data-poker-wdr style="flex:1;height:40px;font:600 12px var(--sans)">To wallet</button>
          </div>
          <div class="msg" data-poker-msg></div>
          <p class="note">Moves between wallet and poker settle instantly on Somnia.</p>
        </div>
        <div style="flex:1;min-height:16px"></div>
        <button class="btn2 btn2-danger" data-disconnect style="width:100%;height:38px;margin-top:8px;font:600 12px var(--sans)">Disconnect wallet</button>
      </div>
    </div>
    <div class="smodal-mask" data-smodal-mask>
      <div class="smodal-veil" data-smodal-close></div>
      <div class="smodal">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font:700 16px var(--sans);color:var(--fg-strong)">Settings</span>
          <span style="flex:1"></span>
          <button class="smodal-x" data-smodal-close aria-label="Close">×</button>
        </div>
        <div class="k-label" style="margin-top:22px">Audio</div>
        <div style="border:1px solid var(--line-3);background:var(--panel-2);border-radius:14px;padding:16px 18px;margin-top:14px">
          <div style="display:flex;align-items:center;gap:13px">
            <span style="flex:none;width:42px;height:42px;border-radius:11px;background:rgba(217,185,112,.12);display:flex;align-items:center;justify-content:center;color:var(--gold)"><svg width="20" height="20" viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4Z" fill="currentColor"></path><path d="M16.5 8.5a5 5 0 0 1 0 7 M19 6a8 8 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path></svg></span>
            <div style="flex:1;min-width:0">
              <div style="font:700 15px var(--sans);color:var(--fg)">Sound FX</div>
              <div style="font:400 11.5px var(--sans);color:var(--fg-mute)">Reel spins, wins, and interaction feedback in the slots.</div>
            </div>
            <button class="btn2 btn2-line" data-sound-toggle style="height:34px;padding:0 16px;font:600 11px var(--sans)">ON</button>
          </div>
          <div style="display:flex;align-items:center;gap:12px;margin-top:16px">
            <span class="k-label" style="flex:none">Volume</span>
            <input type="range" min="0" max="100" step="5" data-vol-fx aria-label="Sound FX volume" style="flex:1;--p:40%">
            <span style="flex:none;width:44px;text-align:right;font:700 14px var(--mono);color:var(--fg-strong)"><span data-vol-fx-label>40</span>%</span>
          </div>
        </div>
        <div class="k-label" style="margin-top:22px">Language</div>
        <div style="border:1px solid var(--line-3);background:var(--panel-2);border-radius:14px;padding:16px 18px;margin-top:14px">
          <div style="display:flex;align-items:center;gap:13px;flex-wrap:wrap">
            <span style="flex:none;width:42px;height:42px;border-radius:11px;background:rgba(217,185,112,.12);display:flex;align-items:center;justify-content:center;color:var(--gold)"><svg width="20" height="20" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"></circle><path d="M3 12h18 M12 3a15 15 0 0 1 0 18 M12 3a15 15 0 0 0 0 18" fill="none" stroke="currentColor" stroke-width="1.6"></path></svg></span>
            <div style="flex:1;min-width:140px">
              <div style="font:700 15px var(--sans);color:var(--fg)">Language</div>
              <div style="font:400 11.5px var(--sans);color:var(--fg-mute)">Interface language across the casino and poker.</div>
            </div>
            <div data-lang-row style="display:flex;gap:8px;flex:none">
              <button class="btn2 btn2-line" data-lang="en" style="height:34px;padding:0 14px;font:600 11px var(--sans)" data-no-i18n>English</button>
              <button class="btn2 btn2-line" data-lang="ru" style="height:34px;padding:0 14px;font:600 11px var(--sans)" data-no-i18n>Русский</button>
            </div>
          </div>
        </div>
        <p style="margin:14px 0 0;font:400 11.5px var(--sans);color:var(--fg-ghost)">Audio is synthesized in your browser · there is no music track, so this is the one mix that matters.</p>
      </div>
    </div>
  `;

  // ---------- SOUND PREF ----------
  const soundOn = () => { try { return localStorage.getItem('sl-sound-on') !== '0'; } catch (_) { return true; } };
  const SND_ON  = 'M4 9v6h4l5 4V5L8 9H4Z M16.5 8.5a5 5 0 0 1 0 7 M19 6a8 8 0 0 1 0 12';
  const SND_OFF = 'M4 9v6h4l5 4V5L8 9H4Z M16.5 9.5l4 5 M20.5 9.5l-4 5';
  const volFx = () => {
    try { const v = parseInt(localStorage.getItem('sl-vol-fx') || '40', 10); return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 40; }
    catch (_) { return 40; }
  };
  function paintSound() {
    const on = soundOn();
    const v = volFx();
    document.querySelectorAll('[data-sound-path]').forEach((el) => el.setAttribute('d', on ? SND_ON : SND_OFF));
    document.querySelectorAll('[data-sound-toggle]').forEach((el) => { el.textContent = on ? 'ON' : 'OFF'; });
    document.querySelectorAll('[data-vol-fx]').forEach((el) => {
      el.value = String(v);
      el.style.setProperty('--p', v + '%');
      el.disabled = !on;
      el.style.opacity = on ? '1' : '.45';
    });
    document.querySelectorAll('[data-vol-fx-label]').forEach((el) => { el.textContent = String(v); });
  }
  // Games live in the shell's iframe. localStorage is the shared channel: the
  // `storage` event fires in every OTHER same-origin document, so writing here
  // reaches a running slot instantly (see games/*/sound.js applyPrefs). The
  // CustomEvent covers same-document listeners, which `storage` skips.
  function announceSound() {
    paintSound();
    document.dispatchEvent(new CustomEvent('shinyluck:sound', { detail: { on: soundOn(), volume: volFx() } }));
    document.querySelectorAll('iframe').forEach((f) => {
      try { f.contentDocument?.dispatchEvent(new CustomEvent('shinyluck:sound', { detail: { on: soundOn(), volume: volFx() } })); } catch (_) {}
    });
  }
  function toggleSound() {
    try { localStorage.setItem('sl-sound-on', soundOn() ? '0' : '1'); } catch (_) {}
    announceSound();
  }
  function setVolFx(v) {
    try { localStorage.setItem('sl-vol-fx', String(Math.min(100, Math.max(0, v)))); } catch (_) {}
    announceSound();
  }

  // ---------- DUST ----------
  const DUST = [[8,22,13,5.5],[21,64,16,7],[34,12,12,6.2],[47,78,18,8],[58,34,14,5.8],[69,16,15,9],[78,58,13.5,6.6],[88,30,17,7.4],[93,74,15,6],[14,88,19,7.8]];
  function mountDust() {
    if (document.querySelector('.dust2')) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const d = document.createElement('div');
    d.className = 'dust2';
    d.setAttribute('aria-hidden', 'true');
    d.innerHTML = DUST.map(([x, y, drift, tw], i) =>
      `<span style="position:absolute;left:${x}%;top:${y}%;animation:sl-drift ${drift}s ease-in-out ${i * 0.4}s infinite alternate"><i style="animation:sl-twinkle ${tw}s ease-in-out ${(i % 4)}s infinite"></i></span>`
    ).join('');
    document.body.appendChild(d);
  }

  function paintContractLink(cfg) {
    const addr = cfg && cfg.casino;
    if (!addr || addr === "-") return;
    document.querySelectorAll('[data-contract-link="casino"]').forEach((a) => {
      a.href = `${explorerBase}/address/${addr}`;
      a.innerHTML = `${a.dataset.contractLabel || "Casino"} · <span style="font-family:var(--mono);font-size:11px">${shortAddr(addr)}</span>`;
      a.style.display = "";
    });
  }

  // ---------- MOUNT ----------
  async function mount() {
    const page = document.querySelector('[data-page-shell]');
    if (!page) return;
    document.body.classList.add('v2-body');
    if (EMBED) {
      // The shell owns all chrome · drop the mounts and keep the page bare.
      ['nav', 'side', 'footer'].forEach((m) => {
        const el = document.querySelector(`[data-mount="${m}"]`);
        if (el) el.remove();
      });
      reportHeight();
      import(new URL("./lib/profile.js", partialsBase).href).catch(() => {});
      document.dispatchEvent(new CustomEvent('shinyluck:chrome-ready'));
      return;
    }
    // Circular spark favicon (generated from assets/spark.png). Replace any
    // page-declared icon so every tab shows the round logo from the header.
    document.querySelectorAll('link[rel="icon"], link[rel="shortcut icon"]').forEach((l) => l.remove());
    const link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/png';
    link.href = '/assets/favicon.png';
    document.head.appendChild(link);
    const active = document.body.dataset.activePage || '';
    const navMount = document.querySelector('[data-mount="nav"]');
    const sideMount = document.querySelector('[data-mount="side"]');
    const footMount = document.querySelector('[data-mount="footer"]');
    if (navMount) navMount.outerHTML = navHTML;
    if (sideMount) sideMount.outerHTML = sideHTML(active);
    const cfg = await expectConfig();
    if (footMount) footMount.outerHTML = footerHTMLFor(cfg);
    // expectConfig() gives up after 1.2s and hands back a "-" placeholder; on a
    // cold load (Privy bundle hogging the network) that dropped the Casino row
    // from the footer. Paint it as soon as the real address is known.
    paintContractLink(cfg);
    document.addEventListener("shinyluck:config", (e) => paintContractLink(e.detail || window.SL_CONFIG));
    if (!document.querySelector('.mob2')) document.body.insertAdjacentHTML('beforeend', mobHTML(active));
    if (!document.querySelector('[data-pdrawer-mask]')) document.body.insertAdjacentHTML('beforeend', drawerHTML);
    mountDust();
    paintSound();

    const isMainnet = cfg.network === "somniaMainnet";
    const label = isMainnet ? "MAINNET" : "TESTNET";
    document.querySelectorAll('[data-sl-network-badge]').forEach((el) => {
      el.textContent = label;
      el.classList.toggle("is-testnet", !isMainnet);
      el.classList.toggle("is-mainnet", isMainnet);
    });

    // profile / wallet logic (module) · lazy so simple pages stay light
    import(new URL("./lib/profile.js", partialsBase).href).catch((e) => console.warn("[partials] profile module:", e.message));

    document.dispatchEvent(new CustomEvent('shinyluck:chrome-ready'));
  }
  if (document.readyState !== 'loading') mount();
  else document.addEventListener('DOMContentLoaded', mount);

  // ---------- LANGUAGE ----------
  // The switch used to live in the poker table's settings, where it could only
  // ever reach that page. It is a site-wide preference, so it lives here and
  // lib/i18n.js broadcasts it into the game/poker iframes.
  const paintLang = () => {
    const cur = window.SLI18N ? window.SLI18N.lang() : 'en';
    document.querySelectorAll('[data-lang]').forEach((b) => {
      const on = b.getAttribute('data-lang') === cur;
      b.style.borderColor = on ? 'var(--gold)' : '';
      b.style.color = on ? 'var(--gold)' : '';
      b.style.background = on ? 'rgba(217,185,112,.12)' : '';
    });
  };
  // i18n.js is a module (deferred) · it may land after this classic script.
  if (window.SLI18N) paintLang();
  else window.addEventListener('DOMContentLoaded', paintLang);
  document.addEventListener('shinyluck:lang', paintLang);

  // ---------- GLOBAL CLICKS (drawer/settings/sound toggles) ----------
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('[data-sound-btn]') || t.closest('[data-sound-toggle]')) { toggleSound(); return; }
    if (t.closest('[data-vol-fx]')) return; // slider · handled by the input listener
    if (t.closest('[data-settings-btn]')) { document.querySelector('[data-smodal-mask]')?.classList.add('on'); return; }
    const lb = t.closest('[data-lang]');
    if (lb) { window.SLI18N?.setLang(lb.getAttribute('data-lang')); paintLang(); return; }
    if (t.closest('[data-smodal-close]')) { document.querySelector('[data-smodal-mask]')?.classList.remove('on'); return; }
    if (t.closest('[data-pdrawer-close]')) { document.querySelector('[data-pdrawer-mask]')?.classList.remove('on'); return; }
  });

  // ---------- VOLUME SLIDER ----------
  document.addEventListener('input', (e) => {
    const el = e.target.closest && e.target.closest('[data-vol-fx]');
    if (!el) return;
    setVolFx(parseInt(el.value, 10) || 0);
  });

  // ---------- PAGE TRANSITIONS ----------
  // The shell router (index.html, capture phase) handles view links itself
  // and calls preventDefault · anything that reaches us is a REAL navigation.
  // Inside a view iframe we never navigate the frame: internal links are
  // forwarded up to the shell router instead.
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented) return;
    const a = e.target.closest('a[data-link], a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('http') || a.target === '_blank') return;
    if (!href.startsWith('/') || href.startsWith('//')) return;
    e.preventDefault();
    if (EMBED) {
      try { window.parent.postMessage({ type: 'sl-nav', href }, '*'); return; } catch (_) {}
    }
    veil.classList.add('on');
    window.location.href = href;
  });
})();
