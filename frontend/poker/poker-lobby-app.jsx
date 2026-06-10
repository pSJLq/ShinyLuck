/* ShinyPoker — LIVE lobby. Design look (lobby.css) driven by on-chain tables
   via window.SP. Cash tab is live; other tabs are flagged coming-soon. */
const { useState: uS, useEffect: uE, useRef: uR } = React;
const Ln = (wei) => Number(SP.fmt(wei, 6));
const lshort = (a) => (a && a !== "0x0000000000000000000000000000000000000000" ? a.slice(0, 6) + "…" + a.slice(-4) : "");
const stakeOf = (bb) => (bb <= 0.05 ? "micro" : bb <= 1 ? "low" : bb <= 5 ? "mid" : "high");

function LobbyApp() {
  const [tab, setTab] = uS("cash");
  const [rows, setRows] = uS([]);
  const [loaded, setLoaded] = uS(false);
  const [connected, setConnected] = uS(false);
  const [addr, setAddr] = uS(null);
  const [bal, setBal] = uS(0);
  const [stake, setStake] = uS("all");
  const [size, setSize] = uS("all");
  const [trnCount, setTrnCount] = uS(0);
  const [showCreate, setShowCreate] = uS(false);
  const [theme] = uS(() => localStorage.getItem("sp_theme") || "b");
  const canvasRef = uR(null);

  // ambient grid
  uE(() => {
    if (!canvasRef.current || !window.GridField) return;
    const f = new GridField(canvasRef.current, { cell: 20, gap: 6, speed: 0.4, density: 0.5, accent: "#6E6EED", accent2: "#9B9BF4", maxAlpha: 0.7, minBright: 0.01, shape: "square" });
    f.start();
    const r = setTimeout(() => f._resize(), 300);
    return () => { clearTimeout(r); f.destroy(); };
  }, []);

  // restore Privy session
  uE(() => {
    const restore = () => SP.sdk.tryRestorePrivy().then((a) => { if (a) { setAddr(a); setConnected(true); refreshBal(); } }).catch(() => {});
    restore();
    const on = (ev) => { if (ev.detail && ev.detail.authenticated && ev.detail.address) restore(); };
    document.addEventListener("shinyluck:auth-state", on);
    return () => document.removeEventListener("shinyluck:auth-state", on);
  }, []);

  async function refreshBal() { if (SP.sdk.address) { try { setBal(Ln(await SP.sdk.balanceOf(SP.sdk.address))); } catch {} } }

  // poll live tables
  uE(() => {
    let stop = false;
    async function load() {
      try {
        const n = await SP.sdk.tableCount();
        const out = [];
        for (let t = 0; t < n; t++) {
          const [cfg, hand, seats] = await Promise.all([SP.sdk.getTable(t), SP.sdk.getHand(t), SP.sdk.getSeats(t)]);
          out.push({
            id: t, sb: Ln(cfg.smallBlind), bb: Ln(cfg.bigBlind), size: cfg.maxSeats,
            seated: seats.filter((s) => !s.empty).length, pot: Ln(hand.pot), inHand: hand.inProgress,
            rake: (cfg.rakeBps / 100), cap: Ln(cfg.rakeCap), stake: stakeOf(Ln(cfg.bigBlind)),
          });
        }
        if (!stop) { setRows(out); setLoaded(true); }
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
  const biggest = rows.reduce((m, r) => Math.max(m, r.pot), 0);
  const sym = SP.NETWORK.currency.symbol;
  const COLS = "1.1fr 0.7fr 0.9fr 1.2fr 0.8fr 1.1fr";

  return (
    <div className="scaler" id="scaler">
      <div className="app lobby" data-dir={theme} data-deck="4">
        <header className="topbar">
          <div className="group"><span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><BraceLogo size={22} /><span className="wordmark" style={{ fontSize: 17 }}>shiny<span className="accent">poker</span></span></span></div>
          <div className="switcher">
            <button onClick={() => (location.href = SP.POKER_CONFIG.casinoUrl)}><span className="dot" />ShinyLuck</button>
            <button className="on"><span className="dot" />Poker</button>
          </div>
          <div className="sep" />
          <div className="group"><span className="metapill"><span className="k">Room</span><b>LOBBY</b></span></div>
          <div className="spacer" />
          {connected ? (
            <div className="wallet"><SomiIcon className="somi" /><span className="bal tnum">{bal.toFixed(1)}</span><span className="net">{lshort(addr)}</span></div>
          ) : (
            <button className="metapill" style={{ cursor: "pointer", color: "var(--accent-soft)", borderColor: "var(--accent-32)", background: "var(--accent-12)" }} onClick={connect}>Connect Wallet</button>
          )}
        </header>

        <canvas className="lobbyfield" ref={canvasRef} />

        <div className="lobbyhead">
          <div className="lobbytabs">
            {[["cash", "Cash"], ["tournaments", "Tournaments"], ["sng", "Sit & Go"], ["clubs", "Clubs"]].map(([k, l]) => (
              <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}<span className="ct tnum">{k === "cash" ? cash.length : k === "tournaments" && SP.sdk.hasTournaments() ? trnCount : "soon"}</span></button>
            ))}
          </div>
          <div className="statstrip">
            <div className="stat"><span className="k"><span className="live" />Players seated</span><span className="v count tnum">{totalSeated}</span></div>
            <div className="stat"><span className="k">Tables</span><span className="v tnum">{rows.length}</span></div>
            <div className="stat"><span className="k">Hands running</span><span className="v tnum">{running}</span></div>
            <div className="stat"><span className="k">Biggest pot now</span><span className="v tnum">{biggest.toFixed(2)}<span className="u">{sym}</span></span></div>
          </div>
        </div>

        <div className="subbar">
          {tab === "cash" ? (
            <React.Fragment>
              <span className="filterlabel">Stakes</span>
              <div className="chipset">{[["all", "All"], ["micro", "Micro"], ["low", "Low"], ["mid", "Mid"], ["high", "High"]].map(([k, l]) => <button key={k} className={stake === k ? "on" : ""} onClick={() => setStake(k)}>{l}</button>)}</div>
              <span className="filterlabel">Size</span>
              <div className="chipset">{[["all", "All"], ["6", "6-max"], ["9", "9-max"], ["2", "Heads-up"]].map(([k, l]) => <button key={k} className={size === k ? "on" : ""} onClick={() => setSize(k)}>{l}</button>)}</div>
              <div className="spacerflex" />
              <span className="filterlabel">Provably fair · commit-reveal</span>
            </React.Fragment>
          ) : tab === "tournaments" && SP.sdk.hasTournaments() ? (
            <React.Fragment>
              <span className="filterlabel">Single-table tournaments · buy-in or sponsored pools</span>
              <div className="spacerflex" />
              <button className="cta" onClick={() => (connected ? setShowCreate(true) : connect())}>+ Create tournament</button>
            </React.Fragment>
          ) : <span className="filterlabel">{tab === "tournaments" ? "Scheduled tournaments" : tab === "sng" ? "Sit & Go / Spin" : "Clubs & private tables"}</span>}
        </div>

        <div className="lobbybody">
          <div className="listscroll">
            {tab === "tournaments" && SP.sdk.hasTournaments() ? (
              <TournamentsTab connected={connected} connect={connect} addr={addr} onCount={setTrnCount}
                showCreate={showCreate} closeCreate={() => setShowCreate(false)} />
            ) : tab !== "cash" ? (
              <div style={{ textAlign: "center", padding: "70px 20px", color: "var(--muted)", fontFamily: "var(--label)" }}>
                <div style={{ fontSize: 30, marginBottom: 10 }}>♠</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 18, color: "var(--text)" }}>{tab === "tournaments" ? "Tournaments" : tab === "sng" ? "Sit & Go" : "Clubs"} — coming soon</div>
                <div style={{ marginTop: 8, fontSize: 13 }}>Cash NLHE is live now. Scheduled tournaments, Sit&Go and clubs land next.</div>
              </div>
            ) : !loaded ? <div style={{ padding: 50, color: "var(--muted)", fontFamily: "var(--label)", textAlign: "center" }}>Loading tables…</div>
              : cash.length === 0 ? <div style={{ padding: 50, color: "var(--muted)", fontFamily: "var(--label)", textAlign: "center" }}>No tables match your filters.</div>
              : (
                <div className="dtable">
                  <div className="dthead" style={{ gridTemplateColumns: COLS }}>
                    <span className="h">Stakes · Rake</span><span className="h">Game</span><span className="h">Size</span><span className="h">Seats</span><span className="h r">Pot now</span><span className="h r">Action</span>
                  </div>
                  {cash.map((r) => {
                    const full = r.seated >= r.size;
                    const sizeLabel = r.size === 2 ? "Heads-up" : r.size + "-max";
                    return (
                      <div key={r.id} className="drow" style={{ gridTemplateColumns: COLS }}>
                        <div className="cell-stakes"><span className="bl tnum">{r.sb} / {r.bb}<span className="u">{sym}</span></span><span className="rk">rake <b>{r.rake}%</b> · cap {r.cap} · no flop no drop</span></div>
                        <div><span className="gametag">NLHE</span></div>
                        <div className="sizetag">{sizeLabel}</div>
                        <div className="seatdots">{Array.from({ length: r.size }).map((_, i) => <span key={i} className={"sd" + (i < r.seated ? " on" : "")} />)}<span className={"lbl" + (full ? " full" : "")}>{r.seated}/{r.size}</span></div>
                        <div className="numcell tnum">{r.pot > 0 ? r.pot.toFixed(2) : "—"}<span className="u">{r.pot > 0 ? sym : ""}</span></div>
                        <div className="rowactions">
                          <a className="btn-sm" href={"table.html?t=" + r.id}>Observe</a>
                          <a className={"btn-sm " + (full ? "full" : "join")} href={"table.html?t=" + r.id}>{full ? "Waitlist" : "Join"}</a>
                        </div>
                      </div>
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
      const ts = await SP.sdk.tournaments();
      ts.reverse(); // newest first
      setList(ts);
      onCount(ts.filter((t) => t.status <= 1).length);
      if (SP.sdk.address) {
        const m = {};
        for (const t of ts) m[t.id] = await SP.sdk.isRegisteredIn(t.id);
        setMine(m);
      }
    } catch (e) { console.warn("trn load:", e.message); setList([]); }
  }
  uE(() => { load(); const iv = setInterval(load, 4000); return () => clearInterval(iv); }, [connected]);

  async function act(label, fn) {
    setBusy(true);
    try { await fn(); flash(label + " ✓"); await load(); }
    catch (e) { flash(label + " ✗ " + (e?.shortMessage || e?.reason || e?.message || "").replace(/execution reverted:?/i, "").slice(0, 70)); console.error(e); }
    finally { setBusy(false); }
  }

  const fmtSplit = (bps) => bps.map((b) => (b / 100) + "%").join(" / ");

  return (
    <React.Fragment>
      {msg && <div className="lt-toast" style={{ bottom: 60 }}>{msg}</div>}
      {showCreate && <CreateTournamentModal close={closeCreate} onDone={() => { closeCreate(); load(); }} act={act} busy={busy} />}
      {list == null ? (
        <div style={{ padding: 50, color: "var(--muted)", fontFamily: "var(--label)", textAlign: "center" }}>Loading tournaments…</div>
      ) : list.length === 0 ? (
        <div style={{ textAlign: "center", padding: "70px 20px", color: "var(--muted)", fontFamily: "var(--label)" }}>
          <div style={{ fontSize: 30, marginBottom: 10 }}>♠</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 18, color: "var(--text)" }}>No tournaments yet</div>
          <div style={{ marginTop: 8, fontSize: 13 }}>Be the first — create one with your own buy-in, prize pool and payout split.</div>
        </div>
      ) : (
        <div className="dtable">
          <div className="dthead" style={{ gridTemplateColumns: TRN_COLS }}>
            <span className="h">Tournament</span><span className="h">Buy-in · split</span><span className="h">Prize pool</span>
            <span className="h c">Entrants</span><span className="h">Status</span><span className="h r">Action</span>
          </div>
          {list.map((t) => {
            const cost = t.buyIn + t.fee;
            const statusCls = ["registering", "running", "finished", "finished"][t.status];
            const reg = mine[t.id];
            const isCreator = addr && t.creator.toLowerCase() === addr.toLowerCase();
            return (
              <div key={t.id} className="drow" style={{ gridTemplateColumns: TRN_COLS }}>
                <div className="cell-tname">
                  <span className="nm">SNG #{t.id} · {t.maxPlayers}-max</span>
                  <span className="meta"><span>{Number(t.startStack)} chips</span><span>by {t.creator.slice(0, 6)}…</span>{t.pool > t.buyIn * BigInt(t.registered) && <span className="bnt">◆ sponsored</span>}</span>
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
                  {t.status === 0 && !connected && <button className="btn-sm join" onClick={connect}>Connect</button>}
                  {t.status === 0 && connected && !reg && <button className="btn-sm join" disabled={busy} onClick={() => act("Register", () => SP.sdk.registerTournament(t.id, cost))}>Register {Number(SP.fmt(cost, 4))}</button>}
                  {t.status === 0 && connected && reg && <button className="btn-sm" disabled={busy} onClick={() => act("Unregister", () => SP.sdk.unregisterTournament(t.id))}>Unregister</button>}
                  {t.status === 0 && connected && isCreator && t.registered >= 2 && <button className="btn-sm join" disabled={busy} onClick={() => act("Start", () => SP.sdk.startTournament(t.id))}>Start now</button>}
                  {t.status === 1 && <a className="btn-sm join" href={"table.html?t=" + t.tableId}>{reg ? "Play →" : "Observe"}</a>}
                  {t.status >= 2 && <span style={{ color: "var(--muted)", fontFamily: "var(--label)", fontSize: 12 }}>—</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </React.Fragment>
  );
}

function CreateTournamentModal({ close, onDone, act, busy }) {
  const sym = SP.NETWORK.currency.symbol;
  const [f, setF] = uS({ buyIn: "0.5", fee: "0.05", maxPlayers: "6", startStack: "1500", sb: "10", bb: "20", levelMin: "5", split: "65/35", sponsor: "0" });
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const splitBps = f.split.split("/").map((s) => Math.round(parseFloat(s.trim()) * 100)).filter((n) => !isNaN(n));
  const splitOk = splitBps.length > 0 && splitBps.reduce((a, b) => a + b, 0) === 10000;
  const stop = (e) => e.stopPropagation();
  return (
    <div className="lt-modalbg" onClick={close}>
      <div className="lt-modal" onClick={stop} style={{ width: "min(430px,92vw)" }}>
        <h3>Create tournament</h3>
        <p className="note">Players' buy-ins build the prize pool — or sponsor the pool yourself (or both). Winners split it exactly how you set below.</p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div><label>Buy-in ({sym})</label><input value={f.buyIn} onChange={set("buyIn")} /></div>
          <div><label>Fee ({sym})</label><input value={f.fee} onChange={set("fee")} /></div>
          <div><label>Players (2–9)</label><input value={f.maxPlayers} onChange={set("maxPlayers")} /></div>
          <div><label>Start stack (chips)</label><input value={f.startStack} onChange={set("startStack")} /></div>
          <div><label>Blinds (sb)</label><input value={f.sb} onChange={set("sb")} /></div>
          <div><label>Blinds (bb)</label><input value={f.bb} onChange={set("bb")} /></div>
          <div><label>Level (minutes)</label><input value={f.levelMin} onChange={set("levelMin")} /></div>
          <div><label>Sponsor pool ({sym})</label><input value={f.sponsor} onChange={set("sponsor")} /></div>
        </div>
        <label>Payout split, % (e.g. 65/35 or 50/30/20)</label>
        <input value={f.split} onChange={set("split")} style={{ borderColor: splitOk ? undefined : "var(--danger, #ef5a6f)" }} />
        {!splitOk && <p className="note" style={{ color: "var(--danger, #ef5a6f)" }}>Percentages must add up to exactly 100.</p>}
        <div className="row">
          <button className="pill" onClick={close}>Cancel</button>
          <button className="pill primary" disabled={busy || !splitOk} onClick={() => act("Create tournament", async () => {
            await SP.sdk.createTournament({
              buyInEth: f.buyIn || 0, feeEth: f.fee || 0, maxPlayers: parseInt(f.maxPlayers, 10),
              startStack: parseInt(f.startStack, 10), sbStart: parseInt(f.sb, 10), bbStart: parseInt(f.bb, 10),
              levelDur: Math.max(30, Math.round(parseFloat(f.levelMin) * 60)), payoutBps: splitBps, sponsorEth: f.sponsor || 0,
            });
          }).then(onDone)}>Create</button>
        </div>
      </div>
    </div>
  );
}

function mountScaleLobby() {
  const scaler = document.getElementById("scaler"); if (!scaler) return;
  const app = scaler.querySelector(".app"); if (!app) return;
  const fit = () => {
    const s = Math.min((window.innerWidth - 24) / 1600, (window.innerHeight - 84) / 1000, 1);
    app.style.transform = `scale(${s})`; app.style.transformOrigin = "top left"; app.style.position = "absolute"; app.style.top = "0"; app.style.left = "0";
    scaler.style.width = 1600 * s + "px"; scaler.style.height = 1000 * s + "px";
  };
  fit(); window.addEventListener("resize", fit);
}

function bootLobby() { ReactDOM.createRoot(document.getElementById("root")).render(<LobbyApp />); setInterval(mountScaleLobby, 400); setTimeout(mountScaleLobby, 80); }
if (window.SP) bootLobby(); else window.addEventListener("sp:ready", bootLobby, { once: true });
