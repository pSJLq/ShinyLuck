/* ShinyPoker — Tournament detail page. The invite-link target
   (tournament?id=N): info + countdown + blind structure + prize/split, and the
   approval flow — applicants apply with their on-chain nickname, the host
   approves/rejects. Fully on-chain via window.SP. Mirrors the lobby chrome. */
const { useState: uS, useEffect: uE } = React;
const sym = () => SP.NETWORK.currency.symbol;
const N4 = (w) => Number(SP.fmt(w, 4));
const tshort = (a) => (a && a !== "0x0000000000000000000000000000000000000000" ? a.slice(0, 6) + "…" + a.slice(-4) : "");
const qId = () => { const v = parseInt(new URLSearchParams(location.search).get("id"), 10); return Number.isNaN(v) ? null : v; };
const ZERO = "0x0000000000000000000000000000000000000000";
// Styled input matching the site (bare <input> outside .lt-modal gets browser default white).
const INP = { background: "var(--panel, #141420)", border: "1px solid var(--line)", color: "var(--text)", borderRadius: 8, padding: "8px 10px", fontFamily: "var(--mono)", fontSize: 13, outline: "none" };

/// Nickname setter row — shared by the player apply flow AND the host join flow.
function NickRow({ nick, setNick, busy, run, onSet }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 380 }}>
      <span style={{ fontFamily: "var(--label)", fontSize: 12, color: "var(--muted)" }}>Pick a nickname to enter (3–20 letters/digits/_):</span>
      <div style={{ display: "flex", gap: 8 }}>
        <input value={nick} onChange={(e) => setNick(e.target.value)} placeholder="YourName" style={{ ...INP, flex: 1 }} />
        <button className="btn-sm join" disabled={busy || nick.trim().length < 3} onClick={() => run("Nickname set", onSet)}>Set</button>
      </div>
    </div>
  );
}

function structureLabel(levelDur) {
  if (!levelDur) return "—";
  const m = Math.max(1, Math.round(levelDur / 60));
  const name = levelDur <= 180 ? "Turbo" : levelDur <= 360 ? "Standard" : "Slow";
  return `${name} · ${m} min levels`;
}
function clk(secs) { const m = Math.floor(secs / 60), s = String(secs % 60).padStart(2, "0"); return `${m}:${s}`; }

const Centered = ({ children }) => (
  <div className="scaler" id="scaler"><div className="app lobby">
    <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "var(--muted)", fontFamily: "var(--label)", fontSize: 18 }}>{children}</div>
  </div></div>
);

function TournamentPage() {
  const id = qId();
  const [info, setInfo] = uS(null);
  const [clock, setClock] = uS(null);
  const [connected, setConnected] = uS(false);
  const [addr, setAddr] = uS(null);
  const [handle, setHandle] = uS("");
  const [pending, setPending] = uS([]);
  const [players, setPlayers] = uS([]);
  const [myReg, setMyReg] = uS(false);
  const [myPend, setMyPend] = uS(false);
  const [now, setNow] = uS(Math.floor(Date.now() / 1000));
  const [busy, setBusy] = uS(false);
  const [msg, setMsg] = uS(null);
  const [nick, setNick] = uS("");
  const [playTable, setPlayTable] = uS(null);
  const [numTables, setNumTables] = uS(1);
  const [tables, setTables] = uS([]);
  const [results, setResults] = uS(null); // [{addr, place, prize, handle}] — winner first
  const [structure, setStructure] = uS([]);
  const [showStruct, setShowStruct] = uS(false);
  const [showCashier, setShowCashier] = uS(false);
  const [pokerBal, setPokerBal] = uS(0);
  const refreshPokerBal = async () => { if (SP.sdk.address) { try { setPokerBal(Number(SP.fmt(await SP.sdk.balanceOf(SP.sdk.address), 6))); } catch {} } };
  uE(() => { if (connected) refreshPokerBal(); }, [connected]);
  const [theme] = uS(() => localStorage.getItem("sp_theme") || "b");

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(null), 4500); };

  uE(() => { const iv = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000); return () => clearInterval(iv); }, []);

  uE(() => {
    const r = () => SP.sdk.tryRestorePrivy().then((a) => { if (a) { setAddr(a); setConnected(true); } }).catch(() => {});
    r();
    const on = (e) => { if (e.detail && e.detail.authenticated && e.detail.address) r(); };
    document.addEventListener("shinyluck:auth-state", on);
    return () => document.removeEventListener("shinyluck:auth-state", on);
  }, []);

  async function load() {
    if (id == null || !SP.sdk.hasTournaments()) return;
    try {
      const [i, c, pend, plrs] = await Promise.all([
        SP.sdk.tournamentInfo(id), SP.sdk.tournamentClock(id),
        SP.sdk.pendingEntries(id), SP.sdk.tournamentPlayers(id),
      ]);
      setInfo(i); setClock(c);
      try { const tb = await SP.sdk.tournamentTables(id); setTables(tb); setNumTables(tb.length || 1); } catch {}
      try { setStructure(await SP.sdk.tournamentStructure(id)); } catch {}
      // finishing places & prizes (event-only data via the dealer bot indexer)
      if (i.status === 2) {
        try {
          const res = await SP.sdk.tournamentResults(id);
          if (res && (res.winner || res.busts.length)) {
            const rows = (res.winner ? [{ addr: res.winner.player, place: 1, prize: res.winner.prize }] : [])
              .concat([...res.busts].sort((a, b) => a.place - b.place).map((b) => ({ addr: b.player, place: b.place, prize: b.prize })));
            const m = await SP.sdk.profilesFor(rows.map((r) => r.addr));
            setResults(rows.map((r) => ({ ...r, ...m[r.addr.toLowerCase()] })));
          }
        } catch {}
      }
      const withNames = async (list) => {
        const real = list.filter((a) => a !== ZERO);
        const m = await SP.sdk.profilesFor(real);
        return real.map((a) => ({ addr: a, ...m[a.toLowerCase()] }));
      };
      setPending(await withNames(pend)); setPlayers(await withNames(plrs));
      if (SP.sdk.address) {
        const [r1, r2, h] = await Promise.all([SP.sdk.isRegisteredIn(id), SP.sdk.isPendingIn(id), SP.sdk.myHandle()]);
        setMyReg(r1); setMyPend(r2); setHandle(h);
        if (r1 && i.status === 1) { try { setPlayTable(await SP.sdk.myTournamentTable(id)); } catch {} }
      }
    } catch (e) { console.warn("trn page:", e.message); }
  }
  uE(() => { load(); const iv = setInterval(load, 5000); return () => clearInterval(iv); }, [connected]);

  async function connect() { try { const a = await SP.sdk.connect(); setAddr(a); setConnected(true); load(); } catch (e) { if (e && e.message !== "cancelled") flash(e.message || "connect failed"); } }
  async function run(label, fn) {
    setBusy(true);
    try { await fn(); flash(label + " ✓"); await load(); }
    catch (e) { flash(label + " ✗ " + (e?.shortMessage || e?.reason || e?.message || "").replace(/execution reverted:?/i, "").slice(0, 90)); console.error(e); }
    finally { setBusy(false); }
  }

  if (id == null) return <Centered>Invalid tournament link.</Centered>;
  if (!SP.sdk.hasTournaments()) return <Centered>Tournaments are not deployed on this network yet.</Centered>;
  if (!info) return <Centered>Loading tournament…</Centered>;

  const cost = info.buyIn + info.fee; // BigInt wei
  const free = cost === 0n;
  const sponsored = info.pool > info.buyIn * BigInt(Math.max(0, info.registered));
  const isCreator = !!addr && info.creator.toLowerCase() === addr.toLowerCase();
  const startTime = clock ? clock.startTime : 0;
  const startsIn = startTime ? Math.max(0, startTime - now) : 0;
  const statusCls = ["registering", "running", "finished", "finished"][info.status];
  const splitStr = info.payoutBps.map((b) => b / 100 + "%").join(" / ");
  const sb = clock ? Number(clock.curSb) : 0, bb = clock ? Number(clock.curBb) : 0, ante = clock ? Number(clock.curAnte) : 0;

  const Stat = ({ k, children }) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontFamily: "var(--label)", fontSize: 10, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted)" }}>{k}</span>
      <span style={{ fontFamily: "var(--mono)", fontSize: 16, color: "var(--text)" }}>{children}</span>
    </div>
  );

  return (
    <div className="scaler" id="scaler">
      <div className="app lobby" data-dir={theme} data-deck="4">
        <header className="topbar">
          <div className="group"><span style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }} title="Back to lobby" onClick={() => (location.href = "lobby")}><SparkLogo size={24} /><span className="wordmark" style={{ fontSize: 17 }}>shiny<span className="accent">poker</span></span></span></div>
          <div className="switcher">
            <button onClick={() => (location.href = SP.POKER_CONFIG.casinoUrl)}><span className="dot" />ShinyLuck</button>
            <button className="on"><span className="dot" />Poker</button>
          </div>
          <div className="sep" />
          <div className="spacer" />
          {connected
            ? <div className="wallet" style={{ cursor: "pointer" }} title="Cashier · nickname" onClick={() => setShowCashier(true)}><BraceLogo size={16} /><span className="net">{handle || tshort(addr)}</span></div>
            : <button className="metapill" style={{ cursor: "pointer", color: "var(--accent-soft)", borderColor: "var(--accent-32)", background: "var(--accent-12)" }} onClick={connect}>Connect Wallet</button>}
        </header>

        <div style={{ position: "absolute", left: "50%", top: 92, transform: "translateX(-50%)", width: "min(760px, 94%)", display: "flex", flexDirection: "column", gap: 16 }}>
          {/* header card */}
          <div style={{ border: "1px solid var(--line)", borderRadius: 14, padding: "20px 22px", background: "var(--panel, rgba(255,255,255,.02))" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 22, fontWeight: 700, color: "var(--text)" }}>
                  Tournament #{id} · {info.maxPlayers}-max
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  <span className={"statuschip " + statusCls}>{SP.TRN_STATUS[info.status]}</span>
                  {info.approvalRequired && <span className="bnt" style={{ background: "var(--accent-12)", color: "var(--accent-soft)", padding: "2px 8px", borderRadius: 6, fontFamily: "var(--label)", fontSize: 11 }}>● private · by approval</span>}
                  {sponsored && <span className="bnt" style={{ padding: "2px 8px", borderRadius: 6, fontFamily: "var(--label)", fontSize: 11 }}>◆ sponsored</span>}
                  {free && <span className="bnt" style={{ padding: "2px 8px", borderRadius: 6, fontFamily: "var(--label)", fontSize: 11, color: "var(--win, #57d9a3)" }}>FREE entry</span>}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontFamily: "var(--label)", fontSize: 10, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--muted)" }}>Prize pool</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 26, fontWeight: 700, color: "var(--accent-soft)" }}>{N4(info.pool)} {sym()}</div>
                <div style={{ fontFamily: "var(--label)", fontSize: 12, color: "var(--muted)" }}>split {splitStr}</div>
                {info.hostBps > 0 && <div style={{ fontFamily: "var(--label)", fontSize: 11, marginTop: 2, color: "var(--gold, #e8c15a)" }}>★ {info.hostBps / 100}% host reward · prizes from the remaining {100 - info.hostBps / 100}%</div>}
              </div>
            </div>

            {/* schedule line */}
            <div style={{ marginTop: 16, padding: "10px 14px", borderRadius: 10, background: "var(--accent-08, rgba(217,171,74,.08))", fontFamily: "var(--mono)", fontSize: 15, color: "var(--text)" }}>
              {info.status === 0 && startTime > 0 && startsIn > 0 && <>⏱ Starts in <b>{clk(startsIn)}</b></>}
              {info.status === 0 && startTime > 0 && startsIn === 0 && <>⏱ Start time reached — waiting on the host / enough players</>}
              {info.status === 0 && startTime === 0 && <>Starts when full or when the host starts it</>}
              {info.status === 1 && <>● In progress — Level {clock.level + 1}, blinds {sb}/{bb}{ante ? ` (ante ${ante})` : ""}{numTables > 1 ? ` · ${numTables} tables` : ""}</>}
              {info.status === 2 && <>🏁 Finished{results && results[0] && results[0].place === 1 && <> — 🏆 <b style={{ color: "var(--accent-soft)" }}>{results[0].handle || tshort(results[0].addr)}</b> wins {N4(results[0].prize)} {sym()}</>}</>}
              {info.status === 3 && <>Cancelled — all entries refunded</>}
            </div>

            {/* stat grid */}
            <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
              <Stat k="Buy-in">{free ? "Free" : `${N4(cost)} ${sym()}`}{!free && info.fee > 0n ? ` (incl ${N4(info.fee)} fee)` : ""}</Stat>
              <Stat k="Entrants">{info.registered}/{info.maxPlayers}{info.status === 1 ? ` · ${info.remaining} left` : ""}</Stat>
              <Stat k="Start stack">{Number(info.startStack)} chips</Stat>
              <Stat k="Blinds">
                {structure.length
                  ? <span style={{ cursor: "pointer", textDecoration: "underline dotted", textUnderlineOffset: 3 }} onClick={() => setShowStruct((v) => !v)}>{structure.length} levels · {Math.round(structure[0].durationSecs / 60)} min ▾</span>
                  : structureLabel(clock && Number(clock.levelDur))}
              </Stat>
            </div>
          </div>

          {/* blind structure (read-only viewer) */}
          {showStruct && structure.length > 0 && (
            <div style={{ border: "1px solid var(--line)", borderRadius: 14, padding: "14px 22px", maxHeight: 260, overflowY: "auto" }}>
              <div style={{ display: "grid", gridTemplateColumns: "36px 1fr 0.6fr 0.6fr", gap: 6, fontFamily: "var(--label)", fontSize: 10, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--muted)", padding: "2px 0 6px" }}>
                <span>Lv</span><span>Blinds</span><span>Ante</span><span>Min</span>
              </div>
              {structure.map((l, i) => {
                const cur = info.status === 1 && clock && clock.level === i;
                return (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "36px 1fr 0.6fr 0.6fr", gap: 6, fontFamily: "var(--mono)", fontSize: 13, padding: "3px 0", color: cur ? "var(--accent-soft)" : "var(--text)", background: cur ? "var(--accent-08, rgba(217,171,74,.08))" : "transparent", borderRadius: 6 }}>
                    <span style={{ color: cur ? "var(--accent-soft)" : "var(--muted)" }}>{i + 1}{cur ? " ●" : ""}</span>
                    <span>{l.sb} / {l.bb}</span><span>{l.ante || "—"}</span><span>{Math.round(l.durationSecs / 60)}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* actions */}
          <div style={{ border: "1px solid var(--line)", borderRadius: 14, padding: "18px 22px", display: "flex", flexDirection: "column", gap: 12 }}>
            {info.status === 1 && (tables.length > 1
              ? (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  {myReg && playTable != null && <a className="btn-sm join" href={"table?t=" + playTable}>Play →</a>}
                  <span style={{ fontFamily: "var(--label)", fontSize: 12, color: "var(--muted)" }}>Watch:</span>
                  {tables.map((tid, i2) => (
                    <a key={tid} className="btn-sm" href={"table?t=" + tid} style={playTable === tid ? { borderColor: "var(--accent-32)", color: "var(--accent-soft)" } : undefined}>
                      Table {i2 + 1}{playTable === tid ? " · yours" : ""}
                    </a>
                  ))}
                </div>
              )
              : <a className="btn-sm join" style={{ alignSelf: "flex-start" }} href={"table?t=" + (playTable != null ? playTable : info.tableId)}>{myReg ? "Play →" : "Observe table"}</a>
            )}

            {info.status === 0 && !isCreator && (
              !connected ? <button className="btn-sm join" style={{ alignSelf: "flex-start" }} onClick={connect}>Connect wallet to enter</button>
              : myReg ? <span style={{ color: "var(--win, #57d9a3)", fontFamily: "var(--mono)" }}>✓ You're in — see you at the table</span>
              : myPend ? (
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ color: "var(--accent-soft)", fontFamily: "var(--mono)" }}>⏳ Application pending — waiting for the host</span>
                  <button className="btn-sm" disabled={busy} onClick={() => run("Withdraw", () => SP.sdk.withdrawApplication(id))}>Withdraw</button>
                </div>
              ) : !handle ? (
                <NickRow nick={nick} setNick={setNick} busy={busy} run={run} onSet={async () => { await SP.sdk.setProfile(nick.trim(), 0); setHandle(nick.trim()); }} />
              ) : (
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <button className="btn-sm join" disabled={busy} onClick={() => run(info.approvalRequired ? "Application sent" : "Registered", () => SP.sdk.registerTournament(id, cost))}>
                    {info.approvalRequired ? "Apply to join" : "Register"}{free ? "" : ` · ${N4(cost)} ${sym()}`}
                  </button>
                  <span style={{ fontFamily: "var(--label)", fontSize: 12, color: "var(--muted)" }}>as <b style={{ color: "var(--text)" }}>{handle}</b></span>
                </div>
              )
            )}

            {/* creator controls — the host can also play in their own event
                (the contract admits the creator directly, no self-approval). */}
            {isCreator && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {info.status === 0 && !myReg && (handle
                  ? <div><button className="btn-sm join" disabled={busy} onClick={() => run("Registered", () => SP.sdk.registerTournament(id, cost))}>Join as player{free ? "" : ` · ${N4(cost)} ${sym()}`}</button></div>
                  : <NickRow nick={nick} setNick={setNick} busy={busy} run={run} onSet={async () => { await SP.sdk.setProfile(nick.trim(), 0); setHandle(nick.trim()); }} />)}
                {info.status === 0 && myReg && (
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ color: "var(--win, #57d9a3)", fontFamily: "var(--mono)" }}>✓ You're in as a player</span>
                    <button className="btn-sm" disabled={busy} onClick={() => run("Unregistered", () => SP.sdk.unregisterTournament(id))}>Unregister</button>
                  </div>
                )}
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <button className="btn-sm" onClick={() => { navigator.clipboard?.writeText(location.href); flash("Invite link copied"); }}>🔗 Copy invite link</button>
                  {info.status === 0 && info.registered >= 2 && <button className="btn-sm join" disabled={busy} onClick={() => run("Start", () => SP.sdk.startTournament(id))}>Start now</button>}
                  {info.status === 0 && <button className="btn-sm" disabled={busy} onClick={() => run("Cancelled", () => SP.sdk.cancelTournament(id))}>Cancel & refund</button>}
                  <span style={{ fontFamily: "var(--label)", fontSize: 12, color: "var(--muted)" }}>You're the host — share the link so players can apply.</span>
                </div>
              </div>
            )}
          </div>

          {/* applicants (creator, approval mode) */}
          {isCreator && info.approvalRequired && info.status === 0 && (
            <div style={{ border: "1px solid var(--line)", borderRadius: 14, padding: "16px 22px" }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 15, marginBottom: 10, color: "var(--text)" }}>Applicants ({pending.length})</div>
              {pending.length === 0 ? <span style={{ color: "var(--muted)", fontFamily: "var(--label)", fontSize: 13 }}>No pending applications yet.</span>
                : pending.map((p) => (
                  <div key={p.addr} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderTop: "1px solid var(--line)" }}>
                    <span style={{ fontFamily: "var(--mono)", color: "var(--text)" }}>{p.handle || tshort(p.addr)} <span style={{ color: "var(--muted)", fontSize: 11 }}>{p.handle ? tshort(p.addr) : ""}</span></span>
                    <span style={{ display: "flex", gap: 8 }}>
                      <button className="btn-sm join" disabled={busy} onClick={() => run("Approved", () => SP.sdk.approveEntry(id, p.addr))}>Approve</button>
                      <button className="btn-sm" disabled={busy} onClick={() => run("Rejected", () => SP.sdk.rejectEntry(id, p.addr))}>Reject</button>
                    </span>
                  </div>
                ))}
            </div>
          )}

          {/* final standings (place → player → prize) */}
          {info.status === 2 && (
            <div style={{ border: "1px solid var(--line)", borderRadius: 14, padding: "16px 22px" }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 15, marginBottom: 10, color: "var(--text)" }}>Final standings</div>
              {results == null
                ? <span style={{ color: "var(--muted)", fontFamily: "var(--label)", fontSize: 13 }}>Results are being indexed — check back in a moment.</span>
                : results.map((r) => {
                    const me = !!addr && r.addr.toLowerCase() === addr.toLowerCase();
                    const medal = r.place === 1 ? "🥇" : r.place === 2 ? "🥈" : r.place === 3 ? "🥉" : null;
                    return (
                      <div key={r.place} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 10px", borderRadius: 8, marginTop: 2,
                        background: me ? "var(--accent-12, rgba(217,171,74,.12))" : r.place <= 3 ? "var(--accent-08, rgba(217,171,74,.06))" : "transparent" }}>
                        <span style={{ width: 40, fontFamily: "var(--mono)", fontSize: 14, color: r.place <= 3 ? "var(--accent-soft)" : "var(--muted)" }}>{medal || "#" + r.place}</span>
                        <AvatarIcon av={r.avatar} img={r.img} name={r.handle || r.addr} size={24} style={{ borderRadius: 6 }} />
                        <span style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 14, color: "var(--text)" }}>
                          {r.handle || tshort(r.addr)}{me && <b style={{ color: "var(--accent-soft)" }}> · you</b>}
                          <span style={{ color: "var(--muted)", fontSize: 11, marginLeft: 8 }}>{r.handle ? tshort(r.addr) : ""}</span>
                        </span>
                        <span style={{ fontFamily: "var(--mono)", fontSize: 14, color: r.prize > 0n ? "var(--win, #57d9a3)" : "var(--muted)" }}>
                          {r.prize > 0n ? `+${N4(r.prize)} ${sym()}` : "—"}
                        </span>
                      </div>
                    );
                  })}
              {results && addr && (() => {
                const mine = results.find((r) => r.addr.toLowerCase() === addr.toLowerCase());
                if (!mine) return null;
                return (
                  <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 10, background: "var(--accent-08, rgba(217,171,74,.08))", fontFamily: "var(--mono)", fontSize: 14, color: "var(--text)" }}>
                    {mine.place === 1
                      ? <>🏆 You won this tournament — <b style={{ color: "var(--win, #57d9a3)" }}>{N4(mine.prize)} {sym()}</b> credited to your poker balance.</>
                      : mine.prize > 0n
                        ? <>You finished <b>#{mine.place}</b> and won <b style={{ color: "var(--win, #57d9a3)" }}>{N4(mine.prize)} {sym()}</b> — credited to your poker balance.</>
                        : <>You finished <b>#{mine.place}</b> of {info.registered}. Better luck next time!</>}
                  </div>
                );
              })()}
            </div>
          )}

          {/* registered players */}
          <div style={{ border: "1px solid var(--line)", borderRadius: 14, padding: "16px 22px" }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 15, marginBottom: 10, color: "var(--text)" }}>Registered ({players.length}/{info.maxPlayers})</div>
            {players.length === 0 ? <span style={{ color: "var(--muted)", fontFamily: "var(--label)", fontSize: 13 }}>No players registered yet.</span>
              : <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {players.map((p) => (
                    <span key={p.addr} style={{ display: "inline-flex", alignItems: "center", gap: 7, fontFamily: "var(--mono)", fontSize: 13, padding: "4px 10px 4px 5px", borderRadius: 8, background: "var(--accent-08, rgba(217,171,74,.08))", color: "var(--text)" }}>
                      <AvatarIcon av={p.avatar} img={p.img} name={p.handle || p.addr} size={22} style={{ borderRadius: 6 }} />
                      {p.handle || tshort(p.addr)}
                    </span>
                  ))}
                </div>}
          </div>
        </div>

        {showCashier && connected && <CashierModal close={() => setShowCashier(false)} addr={addr} bal={pokerBal} refresh={refreshPokerBal} />}
        {msg && <div className="lt-toast" style={{ bottom: 60 }}>{msg}</div>}
      </div>
    </div>
  );
}

function mountScaleTrn() {
  const scaler = document.getElementById("scaler"); if (!scaler) return;
  const app = scaler.querySelector(".app"); if (!app) return;
  const fit = () => {
    if (window.innerWidth <= 760) { // fluid mobile layout (mobile.css) - no stage scaling
      app.style.transform = ""; app.style.position = ""; app.style.top = ""; app.style.left = "";
      scaler.style.width = ""; scaler.style.height = "";
      return;
    }
    const s = Math.min((window.innerWidth - 24) / 1600, (window.innerHeight - 84) / 1000);
    app.style.transform = `scale(${s})`; app.style.transformOrigin = "top left"; app.style.position = "absolute"; app.style.top = "0"; app.style.left = "0";
    scaler.style.width = 1600 * s + "px"; scaler.style.height = 1000 * s + "px";
  };
  fit(); window.addEventListener("resize", fit);
}
function bootTrn() { ReactDOM.createRoot(document.getElementById("root")).render(<TournamentPage />); setInterval(mountScaleTrn, 400); setTimeout(mountScaleTrn, 80); }
if (window.SP) bootTrn(); else window.addEventListener("sp:ready", bootTrn, { once: true });
