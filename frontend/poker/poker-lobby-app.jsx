/* ShinyPoker · LIVE lobby. Design look (lobby.css) driven by on-chain tables
   via window.SP. Cash tab is live; other tabs are flagged coming-soon. */
const { useState: uS, useEffect: uE, useRef: uR } = React;
// Render modals to <body> so they escape the scaled/transformed .app (a CSS
// transform makes position:fixed resolve against .app, not the viewport).
const Portal = ({ children }) => (window.ReactDOM && ReactDOM.createPortal ? ReactDOM.createPortal(children, document.body) : children);
// Little circular "?" with a hover explanation (native title tooltip).
const Hint = ({ text }) => <span title={text} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 14, height: 14, borderRadius: "50%", border: "1px solid var(--muted)", color: "var(--muted)", fontSize: 9, cursor: "help", marginLeft: 5, verticalAlign: "middle" }}>?</span>;
const Ln = (wei) => Number(SP.fmt(wei, 6));
const lshort = (a) => (a && a !== "0x0000000000000000000000000000000000000000" ? a.slice(0, 6) + "…" + a.slice(-4) : "");
const stakeOf = (bb) => (bb <= 0.05 ? "micro" : bb <= 1 ? "low" : bb <= 5 ? "mid" : "high");

// Three separate components poll the tournament list on the same 4s cadence.
// Un-shared, that is three independent chain reads per cycle - and each one
// then fired one isRegisteredIn per tournament SEQUENTIALLY, so a connected
// wallet looking at ten tournaments drove ~23 awaited reads every 4 seconds.
// One in-flight read is shared for a beat; actions bust it so a freshly
// created or joined tournament still shows up immediately.
let _trnCache = { at: 0, p: null };
function trnList() {
  const now = Date.now();
  if (_trnCache.p && now - _trnCache.at < 3000) return _trnCache.p;
  _trnCache = { at: now, p: SP.sdk.tournaments().catch((e) => { _trnCache = { at: 0, p: null }; throw e; }) };
  return _trnCache.p;
}
function bustTrnCache() { _trnCache = { at: 0, p: null }; }
// registration lookups run together instead of one-at-a-time
async function regMap(ts) {
  const pairs = await Promise.all(ts.map(async (t) => [t.id, await SP.sdk.isRegisteredIn(t.id)]));
  const m = {}; for (const [id, v] of pairs) m[id] = v;
  return m;
}

function LobbyApp() {
  // Language is owned by the casino's Settings · repaint the WHOLE tree when it
  // changes so every SPT() below re-runs at once. It has to sit on the root:
  // the lobby's own stats live here, and a tab-level hook would leave them
  // waiting on the 4s poll to catch up (measured: ~2s of stale labels).
  const [, setLangTick] = uS(0);
  uE(() => {
    const on = () => setLangTick((n) => n + 1);
    window.addEventListener("sp-lang-changed", on);
    return () => window.removeEventListener("sp-lang-changed", on);
  }, []);

  // footer/nav deep-links: lobby?tab=tournaments|cash
  const [tab, setTab] = uS(() => {
    const t = new URLSearchParams(location.search).get("tab");
    return ["cash", "tournaments"].includes(t) ? t : "cash";
  });
  const [rows, setRows] = uS([]);
  const [loaded, setLoaded] = uS(false);
  const [connected, setConnected] = uS(false);
  const [addr, setAddr] = uS(null);
  const [bal, setBal] = uS(0);
  const [stake, setStake] = uS("all");
  const [size, setSize] = uS("all");
  const [trnCount, setTrnCount] = uS(0);
  const [trnSeated, setTrnSeated] = uS(0);
  const [showCreate, setShowCreate] = uS(false);
  const [showCashier, setShowCashier] = uS(false);
  const [theme] = uS(() => localStorage.getItem("sp_theme") || "b");

  // Ambient backdrop is poker-dust.js now (six composited sparks) instead of a
  // GridField canvas repainting thousands of cells every frame at 16% opacity.

  // restore Privy session
  uE(() => {
    const restore = () => SP.sdk.tryRestorePrivy().then((a) => { if (a) { setAddr(a); setConnected(true); refreshBal(); } }).catch(() => {});
    restore();
    const on = (ev) => { if (ev.detail && ev.detail.authenticated && ev.detail.address) restore(); };
    document.addEventListener("shinyluck:auth-state", on);
    return () => document.removeEventListener("shinyluck:auth-state", on);
  }, []);

  async function refreshBal() { if (SP.sdk.address) { try { setBal(Ln(await SP.sdk.balanceOf(SP.sdk.address))); } catch {} } }

  // Deep-link: the table/tournament headers send the wallet chip here (lobby?cashier=1).
  uE(() => { if (connected && new URLSearchParams(location.search).get("cashier") === "1") { setShowCashier(true); history.replaceState(null, "", "lobby"); } }, [connected]);

  // poll live tables
  uE(() => {
    let stop = false;
    async function load() {
      try {
        let out;
        // dealer cache first: ONE GET for the whole lobby instead of ~5 RPC
        // calls per table per client · the difference between 20 and 200 users
        const lob = await SP.sdk.lobbySnapshot();
        if (lob && Array.isArray(lob.tables)) {
          out = lob.tables
            .filter((r) => r.controller === "0x0000000000000000000000000000000000000000")
            .map((r) => ({
              id: Number(r.id), sb: Ln(BigInt(r.smallBlind)), bb: Ln(BigInt(r.bigBlind)), size: Number(r.maxSeats),
              seated: Number(r.seated), pot: Ln(BigInt(r.pot || 0)), inHand: !!r.inHand,
              rake: Number(r.rakeBps) / 100, cap: Ln(BigInt(r.rakeCap || 0)), stake: stakeOf(Ln(BigInt(r.bigBlind))),
            }));
        } else {
          const n = await SP.sdk.tableCount();
          out = [];
          for (let t = 0; t < n; t++) {
            const [cfg, hand, seats, ctl] = await Promise.all([SP.sdk.getTable(t), SP.sdk.getHand(t), SP.sdk.getSeats(t), SP.sdk.tableController(t)]);
            if (ctl && ctl !== "0x0000000000000000000000000000000000000000") continue; // hide tournament-controlled tables from the cash list
            out.push({
              id: t, sb: Ln(cfg.smallBlind), bb: Ln(cfg.bigBlind), size: cfg.maxSeats,
              seated: seats.filter((s) => !s.empty).length, pot: Ln(hand.pot), inHand: hand.inProgress,
              rake: (cfg.rakeBps / 100), cap: Ln(cfg.rakeCap), stake: stakeOf(Ln(cfg.bigBlind)),
            });
          }
        }
        if (!stop) { setRows(out); setLoaded(true); }
        if (SP.sdk.hasTournaments()) {
          try {
            const ts = await trnList();
            if (!stop) {
              setTrnCount(ts.filter((t) => t.status <= 1).length);
              setTrnSeated(ts.filter((t) => t.status === 1).reduce((a, t) => a + t.remaining, 0)); // tournament players count as seated
            }
          } catch {}
        }
      } catch (e) { if (!stop) setLoaded(true); }
    }
    load();
    const iv = setInterval(load, 4000);
    return () => { stop = true; clearInterval(iv); };
  }, []);

  async function connect() {
    try { const a = await SP.sdk.connect(); setAddr(a); setConnected(true); refreshBal(); }
    catch (e) { if (e && e.message !== "cancelled") alert(e.message || "connect failed"); }
  }

  let cash = rows;
  if (stake !== "all") cash = cash.filter((r) => r.stake === stake);
  if (size !== "all") cash = cash.filter((r) => String(r.size) === size);
  const totalSeated = rows.reduce((a, r) => a + r.seated, 0);
  const running = rows.filter((r) => r.inHand).length;
  const sym = SP.NETWORK.currency.symbol;

  return (
    <div className="scaler" id="scaler">
      <div className="app lobby" data-dir={theme} data-deck="4">
        <header className="topbar">
          <div className="group"><span style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }} title="Home" onClick={() => (location.href = "/poker/")}><SparkLogo size={24} /><span className="wordmark" style={{ fontSize: 17 }}>shiny<span className="accent">poker</span></span></span></div>
          <div className="switcher">
            <button onClick={() => (location.href = SP.POKER_CONFIG.casinoUrl)}><span className="dot" />ShinyLuck</button>
            <button className="on"><span className="dot" />Poker</button>
          </div>
          <div className="sep" />
          <div className="spacer" />
          {connected ? (
            <div className="wallet" style={{ cursor: "pointer" }} title="Cashier · nickname" onClick={() => setShowCashier(true)}><BraceLogo size={16} /><span className="bal tnum">{bal.toFixed(1)}</span><span className="net">{lshort(addr)}</span></div>
          ) : (
            <button className="metapill" style={{ cursor: "pointer", color: "var(--accent-soft)", borderColor: "var(--accent-32)", background: "var(--accent-12)" }} onClick={connect}>{SPT("Connect Wallet")}</button>
          )}
        </header>

        {showCashier && connected && <CashierModal close={() => setShowCashier(false)} addr={addr} bal={bal} refresh={refreshBal} />}

        <div className="lobbyhead">
          <div className="lobbytabs">
            {[["cash", "Cash"], ["tournaments", "Tournaments"]].map(([k, l]) => (
              <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}<span className="ct tnum">{k === "cash" ? cash.length : SP.sdk.hasTournaments() ? trnCount : "soon"}</span></button>
            ))}
          </div>
          <div className="statstrip">
            <div className="stat"><span className="k"><span className="live" />{SPT("Players seated")}</span><span className="v count tnum">{totalSeated + trnSeated}</span></div>
            <div className="stat"><span className="k">{SPT("Tables")}</span><span className="v tnum">{rows.length}</span></div>
            <div className="stat" title="Tables with a hand being dealt right now"><span className="k">{SPT("Hands in play")}</span><span className="v tnum">{running}</span></div>
          </div>
        </div>

        <div className="subbar">
          {tab === "cash" ? (
            <React.Fragment>
              <span className="filterlabel">{SPT("Stakes")}</span>
              <div className="chipset">{[["all", "All"], ["micro", "Micro"], ["low", "Low"], ["mid", "Mid"], ["high", "High"]].map(([k, l]) => <button key={k} className={stake === k ? "on" : ""} onClick={() => setStake(k)}>{l}</button>)}</div>
              <span className="filterlabel">{SPT("Size")}</span>
              <div className="chipset">{[["all", "All"], ["6", "6-max"], ["9", "9-max"], ["2", "Heads-up"]].map(([k, l]) => <button key={k} className={size === k ? "on" : ""} onClick={() => setSize(k)}>{l}</button>)}</div>
              <div className="spacerflex" />
            </React.Fragment>
          ) : tab === "tournaments" && SP.sdk.hasTournaments() ? (
            <React.Fragment>
              <span className="filterlabel">Single-table tournaments · buy-in or sponsored pools</span>
              <div className="spacerflex" />
              <button className="cta" onClick={() => (connected ? setShowCreate(true) : connect())}>+ Create tournament</button>
            </React.Fragment>
          ) : <span className="filterlabel">{SPT("Scheduled tournaments")}</span>}
        </div>

        <div className="lobbybody">
          <div className="listscroll">
            {tab === "tournaments" && SP.sdk.hasTournaments() ? (
              <TournamentsTab connected={connected} connect={connect} addr={addr} onCount={setTrnCount}
                showCreate={showCreate} closeCreate={() => setShowCreate(false)} />
            ) : tab !== "cash" ? (
              <div style={{ textAlign: "center", padding: "70px 20px", color: "var(--muted)", fontFamily: "var(--label)" }}>
                <div style={{ fontSize: 30, marginBottom: 10 }}>♠</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 18, color: "var(--text)" }}>Tournaments · coming soon</div>
                <div style={{ marginTop: 8, fontSize: 13 }}>{SPT("Cash NLHE is live now.")}</div>
              </div>
            ) : !loaded ? <div style={{ padding: 50, color: "var(--muted)", fontFamily: "var(--label)", textAlign: "center" }}>{SPT("Loading tables…")}</div>
              : cash.length === 0 ? <div style={{ padding: 50, color: "var(--muted)", fontFamily: "var(--label)", textAlign: "center" }}>{SPT("No tables match your filters.")}</div>
              : (
                /* cash tables as mini-felt cards: a plan-view oval with the
                   actual seat occupancy around it and the live pot in the
                   middle · the row list read like a spreadsheet */
                <div className="tgrid">
                  {cash.map((r) => {
                    const full = r.seated >= r.size;
                    const sizeLabel = r.size === 2 ? "Heads-up" : r.size + "-max";
                    const suit = ["♠", "♥", "♦", "♣"][r.id % 4];
                    const red = r.id % 4 === 1 || r.id % 4 === 2;
                    const tilt = ((r.id * 47) % 22) - 11; // deterministic per table · no two cards sit identical
                    const seats = Array.from({ length: r.size }, (_, i) => {
                      const a = Math.PI / 2 + (i / r.size) * Math.PI * 2; // clockwise from the bottom seat
                      return { x: 50 + 43 * Math.cos(a), y: 50 + 38 * Math.sin(a), on: i < r.seated };
                    });
                    return (
                      <a key={r.id} className={"tcard" + (r.inHand ? " live" : "")} href={"table?t=" + r.id}>
                        <div className="tc-top">
                          <span className="tc-stakes tnum">{r.sb} / {r.bb}<span className="u">{sym}</span></span>
                          <span className="tc-tags"><span className="gametag">NLHE</span><span className="tc-size">{sizeLabel}</span></span>
                        </div>
                        <div className="tc-felt">
                          <span className="tc-suit" style={{ transform: `translate(-50%, -52%) rotate(${tilt}deg)`, color: red ? "rgba(190,80,80,.075)" : "rgba(217,171,74,.07)" }}>{suit}</span>
                          {seats.map((s, i) => <span key={i} className={"tc-seat" + (s.on ? " on" : "")} style={{ left: s.x + "%", top: s.y + "%" }} />)}
                          <div className="tc-center">
                            {r.inHand ? (
                              <React.Fragment>
                                {r.pot > 0 && <span className="tc-pot tnum">{r.pot.toFixed(2)}<span className="u">{sym}</span></span>}
                                <span className="tc-live"><span className="dot" />{SPT("hand in play")}</span>
                              </React.Fragment>
                            ) : (
                              <span className="tc-wait">{r.seated > 0 ? "waiting for players" : "open table · be first"}</span>
                            )}
                          </div>
                        </div>
                        <div className="tc-bottom">
                          <span className="tc-rake">rake <b>{r.rake}%</b> · cap {r.cap} · no flop no drop</span>
                          <span className="tc-actions">
                            {full
                              ? <span className="btn-sm full">{SPT("Full · watch")}</span>
                              : <span className="btn-sm join">{r.seated === 0 ? "Sit first" : `Join · ${r.seated}/${r.size}`}</span>}
                          </span>
                        </div>
                      </a>
                    );
                  })}
                </div>
              )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Tournaments (live) ---------------- */
const TRN_COLS = "1.5fr 1.2fr 1.2fr 0.9fr 0.9fr 1.2fr";

function TournamentsTab({ connected, connect, addr, onCount, showCreate, closeCreate }) {
  const [list, setList] = uS(null);
  const [mine, setMine] = uS({}); // id -> isRegistered
  const [busy, setBusy] = uS(false);
  const [msg, setMsg] = uS(null);
  const sym = SP.NETWORK.currency.symbol;

  function flash(m) { setMsg(m); setTimeout(() => setMsg(null), 4000); }

  async function load() {
    try {
      const ts = await trnList();
      ts.reverse(); // newest first
      setList(ts);
      onCount(ts.filter((t) => t.status <= 1).length);
      if (SP.sdk.address) {
        setMine(await regMap(ts));
      }
    } catch (e) { console.warn("trn load:", e.message); setList([]); }
  }
  uE(() => { load(); const iv = setInterval(load, 4000); return () => clearInterval(iv); }, [connected]);
  // Language is owned by the casino's Settings · repaint when it changes so
  // SPT() below re-runs with the new one (no reload).
  const [, setLangTick] = uS(0);
  uE(() => {
    const on = () => setLangTick((n) => n + 1);
    window.addEventListener("sp-lang-changed", on);
    return () => window.removeEventListener("sp-lang-changed", on);
  }, []);

  async function act(label, fn) {
    // the clicked button owns the spinner until this settles
    const done = SPPress.claim();
    setBusy(true);
    try { await fn(); flash(label + " ✓"); bustTrnCache(); await load(); }
    catch (e) { flash(label + " ✗ " + (e?.shortMessage || e?.reason || e?.message || "").replace(/execution reverted:?/i, "").slice(0, 70)); console.error(e); }
    finally { setBusy(false); done(); }
  }

  const fmtSplit = (bps) => bps.map((b) => (b / 100) + "%").join(" / ");
  // Private (approval) tournaments are invite-by-link · list them only for their host.
  const visible = (list || []).filter((t) => !t.approvalRequired || (addr && t.creator.toLowerCase() === addr.toLowerCase()));

  return (
    <React.Fragment>
      {msg && <div className="lt-toast" style={{ bottom: 60 }}>{msg}</div>}
      {showCreate && <CreateTournamentModal close={closeCreate} onDone={() => { closeCreate(); load(); }} act={act} busy={busy} />}
      {list == null ? (
        <div style={{ padding: 50, color: "var(--muted)", fontFamily: "var(--label)", textAlign: "center" }}>{SPT("Loading tournaments…")}</div>
      ) : visible.length === 0 ? (
        <div style={{ textAlign: "center", padding: "70px 20px", color: "var(--muted)", fontFamily: "var(--label)" }}>
          <div style={{ fontSize: 30, marginBottom: 10 }}>♠</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 18, color: "var(--text)" }}>{SPT("No tournaments yet")}</div>
          <div style={{ marginTop: 8, fontSize: 13 }}>Be the first · create one with your own buy-in, prize pool and payout split.</div>
        </div>
      ) : (
        <div className="dtable">
          <div className="dthead" style={{ gridTemplateColumns: TRN_COLS }}>
            <span className="h">{SPT("Tournament")}</span><span className="h">Buy-in · split</span><span className="h">{SPT("Prize pool")}</span>
            <span className="h c">{SPT("Entrants")}</span><span className="h">{SPT("Status")}</span><span className="h r">{SPT("Action")}</span>
          </div>
          {visible.map((t) => {
            const cost = t.buyIn + t.fee;
            const statusCls = ["registering", "running", "finished", "finished"][t.status];
            const reg = mine[t.id];
            const isCreator = addr && t.creator.toLowerCase() === addr.toLowerCase();
            return (
              <div key={t.id} className="drow" style={{ gridTemplateColumns: TRN_COLS }}>
                <div className="cell-tname">
                  <span className="nm">SNG #{t.id} · {t.maxPlayers}-max</span>
                  <span className="meta"><span>{Number(t.startStack)} chips</span><span>by {t.creator.slice(0, 6)}…</span>{t.pool > t.buyIn * BigInt(t.registered) && <span className="bnt">◆ sponsored</span>}{t.hostBps > 0 && <span className="bnt" style={{ color: "var(--gold, #e8c15a)" }}>★ host {t.hostBps / 100}%</span>}{t.approvalRequired && <span className="bnt">● private</span>}{isCreator && t.pendingCount > 0 && <span className="bnt">{t.pendingCount} applied</span>}</span>
                </div>
                <div className="buyincell">
                  <span className="bi tnum">{Number(SP.fmt(cost, 4))}<span className="u">{sym}</span></span>
                  <span className="split">payout {fmtSplit(t.payoutBps)}</span>
                </div>
                <div className="prizecell">
                  <span className="pp tnum">{Number(SP.fmt(t.pool, 4))}<span className="u">{sym}</span></span>
                  <span className="securechip">✓ secured on-chain</span>
                </div>
                <div className="regcell tnum">{t.registered}/{t.maxPlayers}{t.status === 1 && <span className="u">{t.remaining} left</span>}</div>
                <div><span className={"statuschip " + statusCls}>{SP.TRN_STATUS[t.status]}</span></div>
                <div className="rowactions">
                  <a className="btn-sm" href={"tournament?id=" + t.id}>{SPT("View")}</a>
                  {t.status === 0 && t.approvalRequired && !isCreator && <a className="btn-sm join" href={"tournament?id=" + t.id}>{SPT("Apply")}</a>}
                  {t.status === 0 && !t.approvalRequired && !connected && <button className="btn-sm join" onClick={connect}>{SPT("Connect")}</button>}
                  {t.status === 0 && !t.approvalRequired && connected && !reg && <button className="btn-sm join" disabled={busy} onClick={() => act("Register", () => SP.sdk.registerTournament(t.id, cost))}>{SPT("Register")}</button>}
                  {t.status === 0 && !t.approvalRequired && connected && reg && <button className="btn-sm" disabled={busy} onClick={() => act("Unregister", () => SP.sdk.unregisterTournament(t.id))}>{SPT("Unregister")}</button>}
                  {t.status === 0 && connected && isCreator && t.registered >= 2 && <button className="btn-sm join" disabled={busy} onClick={() => act("Start", () => SP.sdk.startTournament(t.id))}>{SPT("Start")}</button>}
                  {t.status === 1 && <a className="btn-sm join" href={"table?t=" + t.tableId}>{reg ? "Play →" : "Observe"}</a>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </React.Fragment>
  );
}

/* ---------------- Sit & Go (live, one-click presets on the tournament engine) ---------------- */
const SNG_PRESETS = [
  { name: "Heads-Up Duel", structure: "turbo", players: 2, buyIn: "0.5", fee: "0.05", stack: 1500, sb: 10, bb: 20, levelMin: 4, split: [10000] },
  { name: "Hyper 6-Max", structure: "hyper", players: 6, buyIn: "0.5", fee: "0.05", stack: 1000, sb: 25, bb: 50, levelMin: 3, split: [6500, 3500] },
  { name: "9-Max Standard", structure: "regular", players: 9, buyIn: "0.3", fee: "0.03", stack: 1500, sb: 10, bb: 20, levelMin: 5, split: [5000, 3000, 2000] },
];
const SPIN_MULTIS = [{ x: 2 }, { x: 3 }, { x: 5 }, { x: 10 }, { x: 25 }, { x: 120 }, { x: 1000 }];

function SngTab({ connected, connect, addr }) {
  const [open, setOpen] = uS(null); // registering tournaments
  const [mine, setMine] = uS({});
  const [busy, setBusy] = uS(false);
  const [msg, setMsg] = uS(null);
  const [display, setDisplay] = uS(SPIN_MULTIS[2]);
  const sym = SP.NETWORK.currency.symbol;
  function flash(m) { setMsg(m); setTimeout(() => setMsg(null), 4000); }

  async function load() {
    try {
      const ts = (await trnList()).filter((t) => t.status === 0).reverse();
      setOpen(ts);
      if (SP.sdk.address) setMine(await regMap(ts));
    } catch (e) { setOpen([]); }
  }
  uE(() => { load(); const iv = setInterval(load, 4000); return () => clearInterval(iv); }, [connected]);
  // Language is owned by the casino's Settings · repaint when it changes so
  // SPT() below re-runs with the new one (no reload).
  const [, setLangTick] = uS(0);
  uE(() => {
    const on = () => setLangTick((n) => n + 1);
    window.addEventListener("sp-lang-changed", on);
    return () => window.removeEventListener("sp-lang-changed", on);
  }, []);

  // spin reel · pure eye-candy teaser while Spin SNG awaits on-chain randomness
  uE(() => { const iv = setInterval(() => setDisplay(SPIN_MULTIS[Math.floor(Math.random() * SPIN_MULTIS.length)]), 1400); return () => clearInterval(iv); }, []);

  async function act(label, fn) {
    // the clicked button owns the spinner until this settles
    const done = SPPress.claim();
    setBusy(true);
    try { await fn(); flash(label + " ✓"); bustTrnCache(); await load(); }
    catch (e) { flash(label + " ✗ " + (e?.shortMessage || e?.reason || e?.message || "").replace(/execution reverted:?/i, "").slice(0, 70)); console.error(e); }
    finally { setBusy(false); done(); }
  }

  /// One click: create the SNG from the preset AND take the first seat.
  const quickStart = (p) => act("Create & join " + p.name, async () => {
    await SP.sdk.createTournament({
      buyInEth: p.buyIn, feeEth: p.fee, maxPlayers: p.players, startStack: p.stack,
      sbStart: p.sb, bbStart: p.bb, levelDur: p.levelMin * 60, payoutBps: p.split, sponsorEth: 0,
    });
    const id = (await SP.sdk.tournamentCount()) - 1;
    const t = await SP.sdk.tournamentInfo(id);
    await SP.sdk.registerTournament(id, t.buyIn + t.fee);
  });

  return (
    <div className="sngsplit">
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="dtable" style={{ border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden", alignSelf: "stretch" }}>
          <div className="dthead" style={{ gridTemplateColumns: "1.4fr 0.8fr 0.8fr 0.9fr", position: "static" }}>
            <span className="h">Quick Sit &amp; Go</span><span className="h">Buy-in</span><span className="h c">{SPT("Format")}</span><span className="h r">{SPT("Action")}</span>
          </div>
          {SNG_PRESETS.map((p) => (
            <div key={p.name} className="sngrow" style={{ gridTemplateColumns: "1.4fr 0.8fr 0.8fr 0.9fr" }}>
              <div className="cell-tname">
                <span className="nm">{p.name}</span>
                <span className="meta"><span>{p.structure}</span><span>{p.stack} chips</span><span>payout {p.split.map((b) => b / 100 + "%").join("/")}</span></span>
              </div>
              <div className="buyincell"><span className="bi tnum" style={{ fontSize: 13 }}>{(parseFloat(p.buyIn) + parseFloat(p.fee)).toFixed(2)}<span className="u">{sym}</span></span>
                <span className="split"><b>{p.buyIn}</b>+{p.fee} fee</span></div>
              <div className="sizetag" style={{ textAlign: "center" }}>{p.players === 2 ? "Heads-up" : p.players + "-max"}</div>
              <div className="rowactions">
                <button className="btn-sm join" disabled={busy} onClick={() => (connected ? quickStart(p) : connect())}>{connected ? "Create & join" : "Connect"}</button>
              </div>
            </div>
          ))}
        </div>

        <div className="dtable" style={{ border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden" }}>
          <div className="dthead" style={{ gridTemplateColumns: "1.4fr 0.8fr 0.8fr 0.9fr", position: "static" }}>
            <span className="h">{SPT("Open seats · join now")}</span><span className="h">Buy-in</span><span className="h c">{SPT("Seats")}</span><span className="h r">{SPT("Action")}</span>
          </div>
          {open == null ? <div style={{ padding: 24, color: "var(--muted)", fontFamily: "var(--label)", textAlign: "center" }}>Loading…</div>
            : open.length === 0 ? <div style={{ padding: 24, color: "var(--muted)", fontFamily: "var(--label)", textAlign: "center" }}>No open Sit &amp; Go right now · start one above.</div>
            : open.map((t) => {
              const cost = t.buyIn + t.fee;
              return (
                <div key={t.id} className="sngrow" style={{ gridTemplateColumns: "1.4fr 0.8fr 0.8fr 0.9fr" }}>
                  <div className="cell-tname">
                    <span className="nm">SNG #{t.id}</span>
                    <span className="meta"><span>{Number(t.startStack)} chips</span><span>pool {Number(SP.fmt(t.pool, 4))} {sym}</span></span>
                  </div>
                  <div className="buyincell"><span className="bi tnum" style={{ fontSize: 13 }}>{Number(SP.fmt(cost, 4))}<span className="u">{sym}</span></span></div>
                  <div className="seatdots" style={{ justifyContent: "center" }}>
                    {Array.from({ length: t.maxPlayers }).map((_, i) => <span key={i} className={"sd" + (i < t.registered ? " on" : "")} />)}
                    <span className="lbl">{t.registered}/{t.maxPlayers}</span>
                  </div>
                  <div className="rowactions">
                    {!connected ? <button className="btn-sm join" onClick={connect}>{SPT("Connect")}</button>
                      : mine[t.id] ? <button className="btn-sm" disabled={busy} onClick={() => act("Unregister", () => SP.sdk.unregisterTournament(t.id))}>{SPT("Unregister")}</button>
                      : <button className="btn-sm join" disabled={busy} onClick={() => act("Register", () => SP.sdk.registerTournament(t.id, cost))}>{SPT("Register")}</button>}
                  </div>
                </div>
              );
            })}
        </div>
      </div>

      <div className="spincard">
        <div className="sptop">
          <div className="t">◆ Spin &amp; Go</div>
          <div className="s">3-handed hyper turbo with a random prize multiplier revealed at seating · powered by the same provably-fair on-chain randomness as the deck. Coming soon.</div>
        </div>
        <div className="spinreel">
          <div style={{ fontFamily: "var(--mono)", fontSize: 54, fontWeight: 700, color: "var(--accent-soft)" }}>×{display.x}</div>
          <button className="spinbtn" disabled>Spin · soon</button>
        </div>
      </div>
      {msg && <div className="lt-toast" style={{ bottom: 60 }}>{msg}</div>}
    </div>
  );
}

// LePoker-style blind schedules. Each preset = start stack + per-level rows
// [smallBlind, bigBlind, ante] at a common per-level duration.
const MK = (mins, rows) => rows.map(([sb, bb, ante]) => ({ sb, bb, ante, durationSecs: mins * 60 }));
// Deep enough that no allowed field (up to 45 players) can outlast the final
// level: the last blinds dwarf the total chips in play. Contract caps custom
// structures at 40 levels.
const STRUCTURES = {
  slow: { label: "Slow", stack: 2000, mins: 5, levels: MK(5, [[10, 20, 2], [20, 40, 4], [30, 60, 7], [40, 80, 9], [50, 100, 12], [60, 120, 14], [80, 160, 19], [100, 200, 24], [125, 250, 30], [150, 300, 36], [175, 350, 42], [200, 400, 48], [250, 500, 60], [300, 600, 72], [400, 800, 96], [500, 1000, 120], [600, 1200, 144], [800, 1600, 192], [1000, 2000, 240], [1250, 2500, 300], [1500, 3000, 360], [2000, 4000, 480], [2500, 5000, 600], [3000, 6000, 720]]) },
  standard: { label: "Standard", stack: 5000, mins: 3, levels: MK(3, [[25, 50, 6], [30, 60, 7], [40, 80, 9], [50, 100, 12], [60, 120, 14], [80, 160, 19], [90, 180, 21], [100, 200, 24], [125, 250, 30], [150, 300, 36], [200, 400, 48], [250, 500, 60], [300, 600, 72], [400, 800, 96], [500, 1000, 120], [600, 1200, 144], [800, 1600, 192], [1000, 2000, 240], [1250, 2500, 300], [1500, 3000, 360], [2000, 4000, 480], [2500, 5000, 600], [3000, 6000, 720], [4000, 8000, 960]]) },
  turbo: { label: "Turbo", stack: 10000, mins: 2, levels: MK(2, [[50, 100, 12], [60, 120, 14], [80, 160, 19], [100, 200, 24], [125, 250, 30], [150, 300, 36], [200, 400, 48], [250, 500, 60], [300, 600, 72], [400, 800, 96], [500, 1000, 120], [600, 1200, 144], [800, 1600, 192], [1000, 2000, 240], [1250, 2500, 300], [1500, 3000, 360], [2000, 4000, 480], [2500, 5000, 600], [3000, 6000, 720], [4000, 8000, 960], [5000, 10000, 1200], [6000, 12000, 1440]]) },
};

// Blind-structure viewer + editor (LePoker-style level table).
function StructureEditor({ levels, onSave, close }) {
  const [rows, setRows] = uS(levels.map((l) => ({ sb: l.sb, bb: l.bb, ante: l.ante, min: Math.max(1, Math.round(l.durationSecs / 60)) })));
  const upd = (i, k, v) => setRows((r) => r.map((row, j) => (j === i ? { ...row, [k]: v } : row)));
  const del = (i) => setRows((r) => (r.length > 1 ? r.filter((_, j) => j !== i) : r));
  const add = () => setRows((r) => { const last = r[r.length - 1] || { sb: 10, bb: 20, ante: 0, min: 5 }; return [...r, { sb: Number(last.bb), bb: Number(last.bb) * 2, ante: Math.round(Number(last.bb) / 8), min: last.min }]; });
  const save = () => { onSave(rows.map((r) => ({ sb: parseInt(r.sb, 10) || 0, bb: parseInt(r.bb, 10) || 0, ante: parseInt(r.ante, 10) || 0, durationSecs: Math.max(15, (parseInt(r.min, 10) || 1) * 60) }))); close(); };
  const stop = (e) => e.stopPropagation();
  const inp = { width: "100%", background: "var(--panel,#141420)", border: "1px solid var(--line)", color: "var(--text)", borderRadius: 6, padding: "4px 6px", fontFamily: "var(--mono)", fontSize: 13 };
  return (
    <Portal><div className="lt-modalbg" onClick={close}>
      <div className="lt-modal" onClick={stop} style={{ width: "min(520px,95vw)", maxHeight: "90vh", display: "flex", flexDirection: "column" }}>
        <h3>{SPT("Blind structure")}</h3>
        <div style={{ overflowY: "auto", flex: 1 }}>
          <div style={{ display: "grid", gridTemplateColumns: "26px 1.6fr 0.8fr 0.7fr 30px", gap: 6, fontFamily: "var(--label)", fontSize: 10, textTransform: "uppercase", color: "var(--muted)", padding: "4px 0" }}>
            <span>Lv</span><span>Blinds</span><span>Ante</span><span>{SPT("Min")}</span><span></span>
          </div>
          {rows.map((r, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "26px 1.6fr 0.8fr 0.7fr 30px", gap: 6, alignItems: "center", padding: "3px 0" }}>
              <span style={{ fontFamily: "var(--mono)", color: "var(--muted)", fontSize: 12 }}>{i + 1}</span>
              <span style={{ display: "flex", gap: 4, alignItems: "center" }}><input style={inp} value={r.sb} onChange={(e) => upd(i, "sb", e.target.value)} /><span style={{ color: "var(--muted)" }}>/</span><input style={inp} value={r.bb} onChange={(e) => upd(i, "bb", e.target.value)} /></span>
              <input style={inp} value={r.ante} onChange={(e) => upd(i, "ante", e.target.value)} />
              <input style={inp} value={r.min} onChange={(e) => upd(i, "min", e.target.value)} />
              <button type="button" className="btn-sm" style={{ padding: "2px 6px" }} onClick={() => del(i)}>✕</button>
            </div>
          ))}
          <button type="button" className="btn-sm" style={{ marginTop: 8 }} onClick={add}>+ Add level</button>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="pill" onClick={close}>{SPT("Cancel")}</button>
          <button className="pill primary" onClick={save}>{SPT("Save structure")}</button>
        </div>
      </div>
    </div></Portal>
  );
}

function CreateTournamentModal({ close, onDone, act, busy }) {
  const sym = SP.NETWORK.currency.symbol;
  const [f, setF] = uS({
    mode: "buyin", buyIn: "0.5", fee: "0.05", sponsor: "1",
    maxPlayers: "6", seatsPerTable: "9", startStack: String(STRUCTURES.standard.stack),
    struct: "standard", levels: STRUCTURES.standard.levels, actionSecs: "15",
    schedule: "open", startAt: "", priv: false, split: "65/35", hostReward: false,
  });
  const [showStruct, setShowStruct] = uS(false);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const pick = (k, v) => () => setF((s) => ({ ...s, [k]: v }));
  const sponsored = f.mode === "sponsored";
  const splitBps = f.split.split("/").map((s) => Math.round(parseFloat(s.trim()) * 100)).filter((n) => !isNaN(n));
  const splitOk = splitBps.length > 0 && splitBps.reduce((a, b) => a + b, 0) === 10000;
  const startTime = f.schedule === "scheduled" && f.startAt ? Math.floor(new Date(f.startAt).getTime() / 1000) : 0;
  const scheduleOk = f.schedule === "open" || startTime > Math.floor(Date.now() / 1000) + 60;
  const sponsorOk = !sponsored || parseFloat(f.sponsor) > 0;
  const ok = splitOk && scheduleOk && sponsorOk;
  const stop = (e) => e.stopPropagation();
  const Seg = ({ k, opts }) => (
    <div className="chipset" style={{ marginTop: 6 }}>{opts.map(([v, l]) => <button key={v} type="button" className={f[k] === v ? "on" : ""} onClick={pick(k, v)}>{l}</button>)}</div>
  );
  return (
    <Portal><div className="lt-modalbg" onClick={close}>
      <div className="lt-modal" onClick={stop} style={{ width: "min(480px,94vw)", maxHeight: "92vh", overflowY: "auto" }}>
        <h3>{SPT("Create tournament")}</h3>
        {showStruct && <StructureEditor levels={f.levels} onSave={(lv) => setF((s) => ({ ...s, levels: lv, struct: "custom" }))} close={() => setShowStruct(false)} />}

        <label>{SPT("Prize pool")}</label>
        <Seg k="mode" opts={[["buyin", "Buy-in pool"], ["sponsored", "I sponsor it · free entry"]]} />
        {sponsored ? (
          <div style={{ marginTop: 8 }}>
            <label>Sponsor amount ({sym}) <Hint text="You fund the prize pool; entry is free for everyone else. A flat 10% platform fee applies, the same as buy-in events · 90% becomes the prize pool." /></label>
            <input value={f.sponsor} onChange={set("sponsor")} />
            <p className="note" style={{ marginTop: 4 }}>Free entry · prize pool gets 90% · 10% platform fee{parseFloat(f.sponsor) > 0 ? ` · pool ≈ ${(parseFloat(f.sponsor) * 0.9).toFixed(4)} ${sym}` : ""}</p>
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>
            <label>Buy-in ({sym}) <Hint text="Entry cost per player. 90% builds the prize pool; a flat 10% platform fee goes to the house." /></label>
            <input value={f.buyIn} onChange={set("buyIn")} />
            <p className="note" style={{ marginTop: 4 }}>Pool gets 90% · 10% platform fee</p>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
          <div><label>Players (2–45)</label><input value={f.maxPlayers} onChange={set("maxPlayers")} /></div>
          <div><label>Start stack (chips)</label><input value={f.startStack} onChange={set("startStack")} /></div>
          <div><label>Action time (sec) <Hint text="Seconds each player has to act before they're auto-folded." /></label><input value={f.actionSecs} onChange={set("actionSecs")} /></div>
          <div><label>Payout split % <Hint text="How the prize pool is divided by finishing place. '65/35' → winner gets 65%, runner-up 35%. '50/30/20' → top-3 paid: 1st 50%, 2nd 30%, 3rd 20%. Any number of places (up to player count); must add up to 100." /></label><input value={f.split} onChange={set("split")} style={{ borderColor: splitOk ? undefined : "var(--danger,#ef5a6f)" }} /></div>
        </div>
        {!splitOk && <p className="note" style={{ color: "var(--danger,#ef5a6f)" }}>Percentages must add up to exactly 100 (e.g. 65/35 or 50/30/20).</p>}

        <label style={{ marginTop: 10 }}>Table size <Hint text="Seats per table. With more players than this it becomes multi-table (MTT) · the number of tables is calculated automatically." /></label>
        <Seg k="seatsPerTable" opts={[["2", "Heads-up"], ["6", "6-max"], ["9", "9-max"]]} />
        <p className="note" style={{ marginTop: 4 }}>{(() => { const ts = parseInt(f.seatsPerTable || "9", 10), mp = parseInt(f.maxPlayers || "0", 10); const nt = ts > 0 && mp > 0 ? Math.ceil(mp / ts) : 1; return nt > 1 ? `⌗ Multi-table: ${nt} tables of up to ${ts}` : `⌗ Single table (${ts}-max)`; })()}</p>

        <label style={{ marginTop: 10 }}>Blind structure <Hint text="How fast blinds rise. Pick a preset (Slow/Standard/Turbo) or edit the levels yourself." /></label>
        <div className="chipset" style={{ marginTop: 6 }}>
          {["slow", "standard", "turbo"].map((k) => <button key={k} type="button" className={f.struct === k ? "on" : ""} onClick={() => setF((s) => ({ ...s, struct: k, levels: STRUCTURES[k].levels, startStack: String(STRUCTURES[k].stack) }))}>{STRUCTURES[k].label}</button>)}
          <button type="button" className={f.struct === "custom" ? "on" : ""} onClick={() => setF((s) => ({ ...s, struct: "custom" }))}>{SPT("Custom")}</button>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 6 }}>
          <span className="note" style={{ flex: 1 }}>{f.levels.length} levels · start {f.levels[0] ? f.levels[0].sb + "/" + f.levels[0].bb : "-"} · {Math.round((f.levels[0]?.durationSecs || 0) / 60)} min/level</span>
          <button type="button" className="btn-sm" onClick={() => setShowStruct(true)}>{SPT("View / edit")}</button>
        </div>

        <label>Start <Hint text="Open = starts when full or when you press Start. Scheduled = starts at a set time with a live countdown for everyone." /></label>
        <Seg k="schedule" opts={[["open", "When full / I start"], ["scheduled", "Scheduled time"]]} />
        {f.schedule === "scheduled" && <input type="datetime-local" value={f.startAt} onChange={set("startAt")} style={{ marginTop: 6, borderColor: scheduleOk ? undefined : "var(--danger,#ef5a6f)" }} />}
        {f.schedule === "scheduled" && <p className="note" style={{ marginTop: 4 }}>Your local time ({Intl.DateTimeFormat().resolvedOptions().timeZone}) · everyone sees a live countdown.</p>}
        {f.schedule === "scheduled" && !scheduleOk && <p className="note" style={{ color: "var(--danger,#ef5a6f)" }}>{SPT("Pick a time at least a minute in the future.")}</p>}

        {!sponsored && (
          <label style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontFamily: "var(--label)" }}>
            <input type="checkbox" checked={f.hostReward} onChange={(e) => setF((s) => ({ ...s, hostReward: e.target.checked }))} style={{ width: "auto" }} />
            <span>Host reward · <b style={{ color: "var(--gold, #e8c15a)" }}>5% of the prize pool</b> goes to me for organizing <Hint text="Paid to you automatically when the tournament finishes. Prizes are split from the remaining 95%. Shown to players on the tournament card." /></span>
          </label>
        )}
        <label style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontFamily: "var(--label)" }}>
          <input type="checkbox" checked={f.priv} onChange={(e) => setF((s) => ({ ...s, priv: e.target.checked }))} style={{ width: "auto" }} />
          Private · players apply and I approve each (invite by link)
        </label>

        <div className="row" style={{ marginTop: 14 }}>
          <button className="pill" onClick={close}>{SPT("Cancel")}</button>
          <button className="pill primary" disabled={busy || !ok} onClick={() => act("Create tournament", async () => {
            await SP.sdk.createTournament({
              buyInEth: sponsored ? 0 : ((parseFloat(f.buyIn) || 0) * 0.9).toFixed(6), feeEth: sponsored ? 0 : ((parseFloat(f.buyIn) || 0) * 0.1).toFixed(6),
              maxPlayers: parseInt(f.maxPlayers, 10), seatsPerTable: parseInt(f.seatsPerTable || "0", 10), startStack: parseInt(f.startStack, 10),
              actionSecs: parseInt(f.actionSecs || "15", 10), structure: f.levels,
              startTime, approvalRequired: f.priv, payoutBps: splitBps, sponsorEth: sponsored ? (f.sponsor || 0) : 0,
              hostBps: !sponsored && f.hostReward ? 500 : 0,
            });
            const newId = (await SP.sdk.tournamentCount()) - 1;
            location.href = "tournament?id=" + newId; // land on the page (invite link + applicants)
          })}>{SPT("Create")}</button>
        </div>
      </div>
    </div></Portal>
  );
}

// Bound once. This used to run `window.addEventListener("resize", fit)` on
// every tick of a 400ms interval, so the handler list grew forever — an hour
// on this screen left ~9000 live closures, and every one of them ran on each
// resize. The interval stays (it is what re-fits the stage after React
// remounts a tab), but `fit` now no-ops unless something actually changed, so
// the idle cost is two property reads instead of a layout write 2.5x/second.
let _lobbyScaleBound = false;
function mountScaleLobby() {
  const scaler = document.getElementById("scaler"); if (!scaler) return;
  const app = scaler.querySelector(".app"); if (!app) return;
  const fit = () => {
    const embedNow = document.documentElement.classList.contains("sp-embed");
    const key = window.innerWidth + "x" + window.innerHeight + "|" + (embedNow ? 1 : 0);
    // a freshly remounted .app carries no marker, so it always re-fits
    if (app.dataset.slFit === key) return;
    app.dataset.slFit = key;
    if (window.innerWidth <= 760) { // fluid mobile layout (mobile.css) - no stage scaling
      app.style.transform = ""; app.style.position = ""; app.style.top = ""; app.style.left = "";
      scaler.style.width = ""; scaler.style.height = "";
      return;
    }
    // Embedded in the merged site (sp-embed): fill the WIDTH of the frame -
    // the stage scrolls vertically if needed, so no dead side margins.
    const embed = document.documentElement.classList.contains("sp-embed");
    const sW = (window.innerWidth - 24) / 1600;
    // Embedded, scale to WIDTH only: the shell sizes the iframe to whatever
    // height we report, so keying off window.innerHeight would feed back on
    // itself (taller frame → bigger scale → taller frame). Width is stable and
    // the shell page does the scrolling.
    const sH = (window.innerHeight - 84) / 1000;
    const s = embed ? sW : Math.min(sW, sH);
    app.style.transform = `scale(${s})`; app.style.transformOrigin = "top left"; app.style.position = "absolute"; app.style.top = "0"; app.style.left = "0";
    scaler.style.width = 1600 * s + "px"; scaler.style.height = 1000 * s + "px";
  };
  fit();
  if (_lobbyScaleBound) return;
  _lobbyScaleBound = true;
  // re-enter through the mount fn so the handler always re-queries the DOM
  window.addEventListener("resize", () => mountScaleLobby());
}

function bootLobby() { ReactDOM.createRoot(document.getElementById("root")).render(<LobbyApp />); setInterval(mountScaleLobby, 400); setTimeout(mountScaleLobby, 80); }
if (window.SP) bootLobby(); else window.addEventListener("sp:ready", bootLobby, { once: true });
