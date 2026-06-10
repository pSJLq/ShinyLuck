/* ShinyPoker — Lobby shell. Reuses TopBar, SettingsPanel, AnnotationLayer, GridField. */

const { useState: useStateL, useRef: useRefL, useEffect: useEffectL } = React;

/* lobby annotation defs */
const LOBBY_ANNO = [
  { sel: "switcher", kind: "off", text: "Casino ⇄ Poker · shared wallet & session", at: "bottom" },
  { sel: "wallet", kind: "chain", text: "Escrow balance · read on-chain", at: "bottom" },
  { sel: "deposit", kind: "chain", text: "Deposit wallet → escrow · on-chain tx", at: "bottom" },
  { sel: "join", kind: "chain", text: "Join → buy-in escrowed on-chain", at: "left" },
  { sel: "rake", kind: "chain", text: "Rake taken per pot on-chain · capped", at: "top" },
  { sel: "register", kind: "chain", text: "Tournament registration · on-chain tx", at: "left" },
  { sel: "regtx", kind: "chain", text: "Buy-in → prize-pool escrow · on-chain", at: "top" },
  { sel: "buyinsplit", kind: "off", text: "Transparent fee split shown before you pay", at: "right" },
  { sel: "spin", kind: "chain", text: "Spin multiplier · provably-fair on-chain roll", at: "left" },
  { sel: "createclub", kind: "off", text: "Club creation · off-chain metadata", at: "top" },
];

const LOBBY_STATES = ["normal", "loading", "empty", "error", "wrongnet", "insufficient"];

function Lobby() {
  const [tab, setTab] = useStateL("cash");
  const [trnSub, setTrnSub] = useStateL("upcoming");
  const [anno, setAnno] = useStateL(false);
  const [lstate, setLstate] = useStateL("normal");
  const [product, setProduct] = useStateL("poker");
  const [showSettings, setShowSettings] = useStateL(false);
  const [dir, setDir] = useStateL(() => localStorage.getItem("sp_theme") || "b");
  const [settings, setSettings] = useStateL({ sound: true, deck: "4", automuck: true, turbo: false, reduced: false, autoblind: true });
  const setT = (k, v) => setSettings(s => ({ ...s, [k]: v }));
  useEffectL(() => { localStorage.setItem("sp_theme", dir); }, [dir]);

  const [filters, setFilters] = useStateL({ stake: "all", size: "all", hideFull: false, hideEmpty: true });
  const setF = (k, v) => setFilters(f => ({ ...f, [k]: v }));
  const [density, setDensity] = useStateL("comfortable");
  const [selTrn, setSelTrn] = useStateL(null);

  // live ticking clock for countdowns
  const [now, setNow] = useStateL(0);
  useEffectL(() => { const iv = setInterval(() => setNow(n => n + 1), 1000); return () => clearInterval(iv); }, []);

  const appRef = useRefL(null);
  const fieldRef = useRefL(null);
  const canvasRef = useRefL(null);
  useEffectL(() => {
    if (!canvasRef.current) return;
    const f = new GridField(canvasRef.current, { cell: 20, gap: 6, speed: 0.4, density: 0.5,
      accent: "#6E6EED", accent2: "#9B9BF4", maxAlpha: 0.7, minBright: 0.01, shape: "square" });
    fieldRef.current = f;
    if (!settings.reduced) f.start(); else f._draw(0);
    return () => f.destroy();
  }, [settings.reduced]);

  const wrongNet = lstate === "wrongnet";
  const balance = lstate === "insufficient" ? 1.2 : 142.0;

  // counts per tab
  const counts = {
    cash: CASH_TABLES.filter(r => r.seated > 0 || !filters.hideEmpty).length,
    tournaments: TOURNAMENTS.length, sng: SNGS.length + 1, clubs: CLUBS.length,
  };

  const LS = LIVE_STATS;
  const tourneyCd = fmtCountdown(Math.max(0, LS.nextTourneyIn - (now % 320)));

  const selTrnObj = selTrn ? TOURNAMENTS.find(t => t.id === selTrn) : null;
  const showDrawer = tab === "tournaments" && selTrnObj && lstate === "normal";

  function renderBody() {
    if (lstate === "loading") return <SkeletonList />;
    if (lstate === "error") return <EmptyState kind="error" />;
    if (lstate === "wrongnet") return <EmptyState kind="wrongnet" />;
    if (lstate === "empty") return <EmptyState kind="empty" tab={tab} />;
    if (tab === "cash") return <CashView filters={filters} balance={balance} density={density} />;
    if (tab === "tournaments") return <TournamentsView sub={trnSub} now={now} selId={selTrn} onSelect={setSelTrn} />;
    if (tab === "sng") return <SngView />;
    if (tab === "clubs") return <ClubsView />;
    return null;
  }

  return (
    <div className="scaler" id="scaler">
      <div className="app lobby" ref={appRef} data-screen-label={"Lobby · " + tab} data-deck={settings.deck}>
        <TopBar mode="lobby" product={product} onProduct={setProduct} balance={balance} wrongNetwork={wrongNet}
          onSettings={() => setShowSettings(s => !s)} onDeposit={() => {}} />
        {showSettings && <SettingsPanel t={settings} set={setT} dir={dir} setDir={setDir} onClose={() => setShowSettings(false)} />}

        <canvas className="lobbyfield" ref={canvasRef} />

        {/* head: tabs + live stats */}
        <div className="lobbyhead">
          <div className="lobbytabs">
            {[["cash", "Cash"], ["tournaments", "Tournaments"], ["sng", "Sit & Go"], ["clubs", "Clubs"]].map(([k, l]) => (
              <button key={k} className={tab === k ? "on" : ""} onClick={() => { setTab(k); }}>
                {l}<span className="ct tnum">{counts[k]}</span>
              </button>
            ))}
          </div>
          <div className="statstrip" data-anno-skip>
            <div className="stat"><span className="k"><span className="live" />Players online</span><span className="v count tnum">{fmtNum(LS.online)}</span></div>
            <div className="stat"><span className="k">Tables running</span><span className="v tnum">{LS.tables}</span></div>
            <div className="stat"><span className="k">Biggest pot today</span><span className="v tnum">{fmtNum(LS.biggestPot)}<span className="u">SOMI</span></span></div>
            <div className="stat"><span className="k">Next tournament</span><span className="v tnum" style={{ color: "var(--gold)" }}>{tourneyCd.txt}</span></div>
          </div>
        </div>

        {/* sub bar */}
        <div className="subbar">
          {tab === "cash" && (
            <React.Fragment>
              <span className="filterlabel">Stakes</span>
              <div className="chipset">
                {[["all", "All"], ["micro", "Micro"], ["low", "Low"], ["mid", "Mid"], ["high", "High"]].map(([k, l]) => (
                  <button key={k} className={filters.stake === k ? "on" : ""} onClick={() => setF("stake", k)}>{l}</button>
                ))}
              </div>
              <span className="filterlabel">Size</span>
              <div className="chipset">
                {[["all", "All"], ["6", "6-max"], ["9", "9-max"], ["2", "Heads-up"]].map(([k, l]) => (
                  <button key={k} className={filters.size === k ? "on" : ""} onClick={() => setF("size", k)}>{l}</button>
                ))}
              </div>
              <label className={"ftoggle" + (filters.hideFull ? " on" : "")} onClick={() => setF("hideFull", !filters.hideFull)}><span className="box" />Hide full</label>
              <label className={"ftoggle" + (filters.hideEmpty ? " on" : "")} onClick={() => setF("hideEmpty", !filters.hideEmpty)}><span className="box" />Hide empty</label>
              <div className="spacerflex" />
              <div className="subtabs" title="Row density">
                {[["comfortable", "Comfortable"], ["compact", "Compact"]].map(([k, l]) => (
                  <button key={k} className={density === k ? "on" : ""} onClick={() => setDensity(k)}>{l}</button>
                ))}
              </div>
              <div className="searchbox">{LobbyIcons.search}<input placeholder="Search tables…" /></div>
              <button className="cta">{LobbyIcons.spades && <span style={{ width: 13, height: 13, display: "inline-flex" }}>{LobbyIcons.plus}</span>}Quick Seat</button>
            </React.Fragment>
          )}
          {tab === "tournaments" && (
            <React.Fragment>
              <div className="subtabs">
                {[["upcoming", "Upcoming"], ["running", "Running"], ["completed", "Completed"]].map(([k, l]) => (
                  <button key={k} className={trnSub === k ? "on" : ""} onClick={() => { setTrnSub(k); setSelTrn(null); }}>{l}</button>
                ))}
              </div>
              <div className="spacerflex" />
              <div className="searchbox">{LobbyIcons.search}<input placeholder="Search tournaments…" /></div>
            </React.Fragment>
          )}
          {tab === "sng" && (
            <React.Fragment>
              <span className="filterlabel">Sit &amp; Go · Spin</span>
              <div className="spacerflex" />
              <div className="searchbox">{LobbyIcons.search}<input placeholder="Search SNGs…" /></div>
            </React.Fragment>
          )}
          {tab === "clubs" && (
            <React.Fragment>
              <span className="filterlabel">Your clubs &amp; invites</span>
              <div className="spacerflex" />
              <div className="searchbox">{LobbyIcons.link}<input placeholder="Paste club invite link…" /></div>
              <button className="cta"><span style={{ width: 13, height: 13, display: "inline-flex" }}>{LobbyIcons.plus}</span>Create club</button>
            </React.Fragment>
          )}
        </div>

        {/* insufficient balance banner */}
        {lstate === "insufficient" && (
          <div className="balbanner">
            <div className="bi">{LobbyIcons.alert}</div>
            <div><div className="bt">Insufficient balance to buy in</div><div className="bs">Your escrow balance is 1.2 SOMI. Deposit more to join these tables.</div></div>
            <div className="spacerflex" />
            <button className="cta">Deposit SOMI</button>
          </div>
        )}

        {/* body */}
        <div className={"lobbybody" + (showDrawer ? " withdrawer" : "")}>
          <div className="listscroll">{renderBody()}</div>
          {showDrawer && <TournamentDrawer t={selTrnObj} now={now} onClose={() => setSelTrn(null)} />}
        </div>

        <AnnotationLayer enabled={anno && lstate === "normal"} containerRef={appRef} defs={LOBBY_ANNO} />
      </div>

      {/* dev HUD */}
      <div className="hud">
        <a href="ShinyPoker Table.html" className="hgroup" style={{ textDecoration: "none" }}>
          <button>← Table</button>
        </a>
        <a href="ShinyPoker Cashier.html" className="hgroup" style={{ textDecoration: "none" }}>
          <button>Cashier</button>
        </a>
        <div className="hsep" />
        <div className="hgroup">
          {[["cash", "Cash"], ["tournaments", "Trns"], ["sng", "SNG"], ["clubs", "Clubs"]].map(([k, l]) => (
            <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        <div className="hsep" />
        <div className="hgroup">
          {LOBBY_STATES.map(s => {
            const lbl = { normal: "Live", loading: "Load", empty: "Empty", error: "Err", wrongnet: "Net", insufficient: "Low$" }[s];
            return <button key={s} className={lstate === s ? "on" : ""} onClick={() => setLstate(s)}>{lbl}</button>;
          })}
        </div>
        <div className="hsep" />
        <label className={"htoggle" + (anno ? " on" : "")} onClick={() => setAnno(!anno)}>
          <span className="sw"><i /></span> Notes
        </label>
      </div>
    </div>
  );
}

function mountScaleL() {
  const scaler = document.getElementById("scaler");
  if (!scaler) return;
  const app = scaler.querySelector(".app");
  function fit() {
    const pad = 24, topBand = 60;
    const sw = (window.innerWidth - pad) / 1600;
    const sh = (window.innerHeight - topBand - pad) / 1000;
    const s = Math.min(sw, sh, 1);
    app.style.transform = `scale(${s})`;
    app.style.transformOrigin = "top left";
    app.style.position = "absolute";
    app.style.top = "0"; app.style.left = "0";
    scaler.style.width = (1600 * s) + "px";
    scaler.style.height = (1000 * s) + "px";
  }
  fit();
  window.addEventListener("resize", fit);
}

ReactDOM.createRoot(document.getElementById("root")).render(<Lobby />);
setTimeout(mountScaleL, 60);
