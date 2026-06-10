/* ShinyPoker — Lobby views: Cash, Tournaments, Drawer, SNG, Clubs, states. */

const LI = {
  search: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>,
  clock: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>,
  trophy: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M6 4h12v3a6 6 0 0 1-12 0z"/><path d="M6 5H3v2a3 3 0 0 0 3 3M18 5h3v2a3 3 0 0 1-3 3M9 16h6M10 16l-.5 4M14 16l.5 4M8 20h8"/></svg>,
  users: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 6a3 3 0 0 1 0 6M18 13.5a5.5 5.5 0 0 1 3.5 5.5"/></svg>,
  plus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 5v14M5 12h14"/></svg>,
  alert: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17h.01"/></svg>,
  wifioff: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M3 3l18 18M9 17l3-3 3 3M5 12a11 11 0 0 1 4-2.5M19 12a11 11 0 0 0-4.5-2.7M2 8.8A16 16 0 0 1 7 6M22 8.8a16 16 0 0 0-6-3"/></svg>,
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M20 6L9 17l-5-5"/></svg>,
  link: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M10 14a4 4 0 0 0 6 .5l2-2a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6-.5l-2 2a4 4 0 0 0 6 6l1-1"/></svg>,
  spades: <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C12 2 4 8.5 4 14.2 4 17.4 6.4 19.6 9.2 19.6 10.3 19.6 11.2 19.2 12 18.5 12.8 19.2 13.7 19.6 14.8 19.6 17.6 19.6 20 17.4 20 14.2 20 8.5 12 2 12 2ZM10.6 18.5C10.6 20.4 9.8 21.6 8.5 22.4L15.5 22.4C14.2 21.6 13.4 20.4 13.4 18.5Z"/></svg>,
};

function fmtCountdown(sec) {
  if (sec < 0) return { txt: "Running", cls: "live" };
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  let txt;
  if (h > 0) txt = `${h}h ${String(m).padStart(2, "0")}m`;
  else txt = `${m}:${String(s).padStart(2, "0")}`;
  return { txt, cls: sec < 600 ? "soon" : "" };
}
function fmtNum(n) { return n.toLocaleString("en-US"); }

/* ---------------- CASH ---------------- */
const CASH_COLS = "1.1fr 0.7fr 0.8fr 1.1fr 0.8fr 0.9fr 0.7fr 1.3fr";
const CASH_COLS_COMPACT = "1.2fr 0.7fr 1.1fr 0.8fr 1.1fr";
function CashView({ filters, balance, density }) {
  let rows = CASH_TABLES;
  if (filters.stake !== "all") rows = rows.filter(r => r.stake === filters.stake);
  if (filters.size !== "all") rows = rows.filter(r => String(r.size) === filters.size);
  if (filters.hideFull) rows = rows.filter(r => r.seated < r.size);
  if (filters.hideEmpty) rows = rows.filter(r => r.seated > 0);

  if (rows.length === 0) return <EmptyState kind="empty" tab="cash" />;
  const cols = density === "compact" ? CASH_COLS_COMPACT : CASH_COLS;
  return (
    <div className="dtable" data-density={density} style={{ "--cash-cols-compact": CASH_COLS_COMPACT }}>
      <div className="dthead" style={{ gridTemplateColumns: cols }}>
        <span className="h">Stakes · Rake</span><span className="h hide-narrow">Game</span><span className="h">Size</span>
        <span className="h">Seats</span><span className="h r">Avg pot</span><span className="h r hide-narrow">Players/flop</span>
        <span className="h c hide-narrow">Wait</span><span className="h r">Action</span>
      </div>
      {rows.map(r => {
        const full = r.seated >= r.size;
        const sizeLabel = r.size === 2 ? "Heads-up" : r.size + "-max";
        return (
          <div key={r.id} className="drow" style={{ gridTemplateColumns: cols }}>
            <div className="cell-stakes">
              <span className="bl tnum">{r.blinds[0]} / {r.blinds[1]}<span className="u">SOMI</span></span>
              <span className="rk" data-anno={r.id === "c1" ? "rake" : undefined}>rake <b>{r.rake}</b> · cap {r.cap} · no flop no drop</span>
            </div>
            <div className="hide-narrow"><span className={"gametag" + (r.game === "PLO" ? " plo" : "")}>{r.game}</span></div>
            <div className="sizetag">{sizeLabel}</div>
            <div className="seatdots">
              {Array.from({ length: r.size }).map((_, i) => <span key={i} className={"sd" + (i < r.seated ? " on" : "")} />)}
              <span className={"lbl" + (full ? " full" : "")}>{r.seated}/{r.size}</span>
            </div>
            <div className="numcell tnum">{r.avgPot > 0 ? r.avgPot.toFixed(1) : "—"}<span className="u">{r.avgPot > 0 ? "SOMI" : ""}</span></div>
            <div className="ppfbar hide-narrow"><span className="pv tnum">{r.ppf}%</span><span className="pt"><i style={{ width: r.ppf + "%" }} /></span></div>
            <div className="waitcell hide-narrow">{r.waitlist > 0 ? <b>{r.waitlist}</b> : "—"}</div>
            <div className="rowactions">
              <button className="btn-sm">Observe</button>
              {full ? <button className="btn-sm full">Waitlist</button>
                : <button className="btn-sm join" data-anno={r.id === "c1" ? "join" : undefined}>Join</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- TOURNAMENTS ---------------- */
const TRN_COLS = "1.6fr 0.9fr 1.2fr 1.3fr 0.7fr 0.9fr 0.9fr";
function TournamentsView({ sub, now, selId, onSelect }) {
  const filtered = TOURNAMENTS.filter(t => {
    if (sub === "upcoming") return t.status === "registering" || t.status === "latereg";
    if (sub === "running") return t.status === "running";
    if (sub === "completed") return t.status === "finished";
    return true;
  });
  if (filtered.length === 0) return <EmptyState kind="empty" tab="tournaments" />;
  return (
    <div className="dtable">
      <div className="dthead" style={{ gridTemplateColumns: TRN_COLS }}>
        <span className="h">Tournament</span><span className="h">Starts</span><span className="h">Buy-in · split</span>
        <span className="h">Prize pool</span><span className="h c">Entrants</span><span className="h">Status</span><span className="h r">Action</span>
      </div>
      {filtered.map(t => {
        const cd = fmtCountdown(t.startIn);
        const statusLabel = { registering: "Registering", latereg: "Late Reg", running: "Running", finished: "Finished" }[t.status];
        return (
          <div key={t.id} className={"trow" + (selId === t.id ? " sel" : "")} style={{ gridTemplateColumns: TRN_COLS }} onClick={() => onSelect(t.id)}>
            <div className="cell-tname">
              <span className="nm">{t.name}</span>
              <span className="meta">
                <span>{t.startStack / 1000}k stack</span>
                <span>{t.structure}</span>
                {t.bounty && <span className="bnt">◆ KO bounty</span>}
                {t.reentry && <span>re-entry</span>}
              </span>
            </div>
            <div className="countdown">
              <span className={"cd " + cd.cls}>{cd.txt}</span>
              <span className="when">{t.status === "finished" ? "ended" : t.startIn < 0 ? `${t.playersLeft} left` : "to start"}</span>
            </div>
            <div className="buyincell">
              <span className="bi tnum">{t.buyIn + t.fee}<span className="u">SOMI</span></span>
              <span className="split"><b>{t.buyIn}</b> pool + <span className="fee">{t.fee} fee</span> · {Math.round(t.fee / (t.buyIn + t.fee) * 100)}%</span>
            </div>
            <div className="prizecell">
              <span className="pp tnum">{fmtNum(t.prizePool)}<span className="u">SOMI</span></span>
              <span className="securechip">{LI.check} secured on-chain <a href="#" onClick={e => e.stopPropagation()}>{t.escrow} ↗</a></span>
            </div>
            <div className="regcell tnum">{fmtNum(t.registered)}<span className="u">{t.gtd ? `${fmtNum(t.gtd)} gtd` : ""}</span></div>
            <div><span className={"statuschip " + t.status}>{statusLabel}</span></div>
            <div className="rowactions">
              {t.status === "finished"
                ? <button className="btn-sm">Results</button>
                : <button className="btn-sm join" data-anno={t.id === "t1" ? "register" : undefined} onClick={e => { e.stopPropagation(); onSelect(t.id); }}>
                    {t.status === "running" ? "Observe" : "Register"}</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TournamentDrawer({ t, now, onClose }) {
  const cd = fmtCountdown(t.startIn);
  const total = t.buyIn + t.fee;
  return (
    <div className="drawer">
      <div className="drawerhead">
        <button className="close" onClick={onClose}>✕</button>
        <div className="tnm">{t.name}</div>
        <div className="tsub">
          <span>{t.structure}</span><span>·</span>
          <span>{t.startStack / 1000}k starting stack</span><span>·</span>
          <span className={cd.cls === "live" ? "" : ""}>{t.status === "finished" ? "Finished" : t.startIn < 0 ? "Running" : "Starts in " + cd.txt}</span>
        </div>
      </div>
      <div className="drawerbody">
        <div className="dsec" data-anno="buyinsplit">
          <div className="dsh">Buy-in breakdown</div>
          <div className="kv">
            <span className="k">Total buy-in</span><span className="v">{total} SOMI</span>
            <span className="k">→ Prize pool</span><span className="v acc">{t.buyIn} SOMI</span>
            <span className="k">→ Platform fee</span><span className="v">{t.fee} SOMI · {Math.round(t.fee / total * 100)}%</span>
            {t.koBounty && <React.Fragment><span className="k">→ KO bounty each</span><span className="v acc">{t.koBounty} SOMI</span></React.Fragment>}
          </div>
        </div>

        <div className="dsec">
          <div className="dsh">Prize pool · on-chain escrow</div>
          <div className="prizecell" style={{ marginBottom: 10 }}>
            <span className="pp tnum" style={{ fontSize: 22 }}>{fmtNum(t.prizePool)}<span className="u">SOMI</span></span>
            <span className="securechip">{LI.check} {t.gtd ? `${fmtNum(t.gtd)} guaranteed · ` : ""}secured on-chain</span>
          </div>
          <div className="escrowbox">
            <span className="addr">{t.escrow}</span>
            <a href="#">View on explorer ↗</a>
          </div>
        </div>

        <div className="dsec">
          <div className="dsh">Blind structure</div>
          <div className="blindtable">
            <div className="bhd"><span>Lvl</span><span>Blinds</span><span>Ante</span><span>Mins</span></div>
            {t.blinds.map((b, i) => b[0] === "BREAK" || b[1] === "Finished"
              ? <div key={i} className="br brk">{b[0] === "BREAK" ? `☕ Break · ${b[3]} min` : "Tournament finished"}</div>
              : <div key={i} className={"br" + (i === (t.startIn < 0 ? 0 : -1) && t.status === "running" ? " cur" : "")}>
                  <span className="lv">{b[0]}</span><span>{b[1]}</span><span>{b[2]}</span><span>{b[3]}m</span></div>
            )}
          </div>
          <div className="kv" style={{ marginTop: 10 }}>
            <span className="k">Late registration</span><span className="v">{t.lateReg}</span>
            <span className="k">Re-entry</span><span className="v">{t.reentry ? "Allowed" : "Freezeout"}</span>
            <span className="k">Rebuy / Add-on</span><span className="v">{[t.rebuy && "Rebuy", t.addon && "Add-on"].filter(Boolean).join(" · ") || "None"}</span>
          </div>
        </div>

        <div className="dsec">
          <div className="dsh">Payout ladder · ICM</div>
          <div className="ladder">
            {t.payouts.map((p, i) => (
              <div key={i} className={"lr" + (i < 3 ? " itm" : "")}>
                <span className="pos">{typeof p[0] === "number" ? `#${p[0]}` : p[0]}</span>
                <span className="pct">{p[1]}% of pool</span>
                <span className="amt tnum">{fmtNum(p[2])} SOMI</span>
              </div>
            ))}
          </div>
          <div style={{ fontFamily: "var(--label)", fontSize: 10.5, color: "var(--muted)", marginTop: 8, lineHeight: 1.5 }}>
            Final-table deals use ICM (Independent Chip Model). Payouts settle automatically on-chain at elimination.
          </div>
        </div>
      </div>
      <div className="drawerfoot">
        {t.status === "finished"
          ? <button className="regbtn" style={{ background: "transparent", border: "1px solid var(--line-2)", color: "var(--text-2)" }}>View full results · winner {t.winner}</button>
          : <button className="regbtn" data-anno="regtx">
              {t.status === "running" ? "Observe tournament" : `Register · ${total} SOMI`}
              <small>{t.status === "running" ? "late reg may be open" : "on-chain registration · one signature"}</small>
            </button>}
      </div>
    </div>
  );
}

/* ---------------- SIT & GO + SPIN ---------------- */
function SngView() {
  const [spinState, setSpinState] = React.useState("idle"); // idle | spinning | done
  const [display, setDisplay] = React.useState(SPIN_MULTIS[2]);
  const [result, setResult] = React.useState(null);
  const spin = () => {
    if (spinState === "spinning") return;
    setSpinState("spinning"); setResult(null);
    let ticks = 0;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      const final = SPIN_MULTIS[4];
      setDisplay(final); setResult(final); setSpinState("done"); return;
    }
    const iv = setInterval(() => {
      setDisplay(SPIN_MULTIS[Math.floor(Math.random() * SPIN_MULTIS.length)]);
      ticks++;
      if (ticks > 22) {
        clearInterval(iv);
        const final = SPIN_MULTIS[4]; // land on 25x
        setDisplay(final); setResult(final); setSpinState("done");
      }
    }, 90);
  };
  return (
    <div className="sngsplit">
      <div className="dtable" style={{ border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden", alignSelf: "start" }}>
        <div className="dthead" style={{ gridTemplateColumns: "1.4fr 0.8fr 0.8fr 0.8fr", position: "static" }}>
          <span className="h">Sit &amp; Go</span><span className="h">Buy-in</span><span className="h c">Seats</span><span className="h r">Action</span>
        </div>
        {SNGS.map(s => (
          <div key={s.id} className="sngrow">
            <div className="cell-tname">
              <span className="nm">{s.name}</span>
              <span className="meta"><span>{s.structure}</span><span>prize {s.prize} SOMI</span></span>
            </div>
            <div className="buyincell"><span className="bi tnum" style={{ fontSize: 13 }}>{s.buyIn + s.fee}<span className="u">SOMI</span></span>
              <span className="split"><b>{s.buyIn}</b>+{s.fee} fee</span></div>
            <div className="seatdots" style={{ justifyContent: "center" }}>
              {Array.from({ length: s.seats }).map((_, i) => <span key={i} className={"sd" + (i < s.seated ? " on" : "")} />)}
              <span className="lbl">{s.seated}/{s.seats}</span>
            </div>
            <div className="rowactions"><button className="btn-sm join">Register</button></div>
          </div>
        ))}
      </div>

      <div className="spincard" data-anno="spin">
        <div className="sptop">
          <div className="t">{LI.spades} Spin SNG</div>
          <div className="s">Pay {SPIN_MULTIS[0].prize / 2 || 6} SOMI. A provably-fair on-chain roll sets your prize pool — up to 1000× — before three players are seated.</div>
        </div>
        <div className="spinreel">
          <div className={"reelwin" + (display.hot ? " gold" : "")}>{display.x}×</div>
          <div className="reellabel">{spinState === "done" ? "Your prize pool" : spinState === "spinning" ? "Rolling on-chain…" : "Tap to reveal"}</div>
          <div className="reelprize tnum">{display.prize} SOMI</div>
          <button className="spinbtn" onClick={spin} disabled={spinState === "spinning"}>
            {spinState === "spinning" ? "Rolling…" : spinState === "done" ? "Seat me →" : "Spin · 6 SOMI"}
          </button>
          <div className="multistrip">
            {SPIN_MULTIS.map((m, i) => <span key={i} className={"multichip" + (m.hot ? " hot" : "")}>{m.x}×</span>)}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- CLUBS ---------------- */
function ClubsView() {
  return (
    <div className="clubgrid">
      {CLUBS.map(c => (
        <div key={c.id} className="clubcard">
          <div className="ctop">
            <div className="cav" style={{ background: `linear-gradient(135deg, ${c.color}, #2a2a55)` }}>{c.tag}</div>
            <div><div className="cn">{c.name}</div><div className="cm">{c.role} · private</div></div>
          </div>
          <div className="cstats">
            <div className="cs"><span className="csv tnum">{c.members}</span><span className="csk">Members</span></div>
            <div className="cs"><span className="csv tnum">{c.tables}</span><span className="csk">Live tables</span></div>
          </div>
          <div className="invitebar"><span style={{ color: "var(--muted)" }}>{LI.link}</span><span className="lnk">shiny.poker/c/{c.tag.toLowerCase()}-{c.id}</span></div>
          <div className="cfoot">
            <button className="btn-sm join" style={{ flex: 1 }}>Enter club</button>
            <button className="btn-sm">Invite</button>
          </div>
        </div>
      ))}
      <div className="clubcard create" data-anno="createclub">
        <div className="cav" style={{ background: "var(--accent-12)", color: "var(--accent-soft)", border: "1px dashed var(--accent-32)" }}>{LI.plus}</div>
        <div><div className="cn">Create a club</div><div className="cm" style={{ marginTop: 4 }}>Spin up private cash &amp; SNG tables. Invite by link.</div></div>
        <button className="cta" style={{ marginTop: 4 }}>New club</button>
      </div>
    </div>
  );
}

/* ---------------- STATES ---------------- */
function SkeletonList() {
  return (
    <div className="dtable">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="skelrow" style={{ gridTemplateColumns: "1.1fr 0.7fr 0.8fr 1.1fr 0.8fr 0.9fr 0.7fr 1.3fr", gap: 18 }}>
          <span className="skel" style={{ width: "70%" }} /><span className="skel" style={{ width: "50%" }} />
          <span className="skel" style={{ width: "60%" }} /><span className="skel" style={{ width: "85%" }} />
          <span className="skel" style={{ width: "55%" }} /><span className="skel" style={{ width: "65%" }} />
          <span className="skel" style={{ width: "40%" }} /><span className="skel" style={{ width: "80%" }} />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ kind, tab }) {
  const map = {
    empty: { icon: LI.spades, t: "No tables match your filters", s: "Try widening your stakes or table-size filters, or start a new table with Quick Seat.", cls: "" },
    error: { icon: LI.alert, t: "Couldn't load the lobby", s: "We lost the live event stream from the Somnia node. Your balance and any seated tables are safe on-chain.", cls: "err" },
    wrongnet: { icon: LI.wifioff, t: "Wrong network", s: "Your wallet is connected to another chain. Switch to Somnia mainnet to browse tables and play.", cls: "wrongnet" },
  }[kind] || {};
  return (
    <div className={"emptystate " + map.cls}>
      <div className="eicon">{map.icon}</div>
      <div className="et">{map.t}</div>
      <div className="es">{map.s}</div>
      {kind === "error" && <button className="cta ghost">Retry connection</button>}
      {kind === "wrongnet" && <button className="cta">Switch to Somnia</button>}
      {kind === "empty" && <button className="cta">Quick Seat</button>}
    </div>
  );
}

Object.assign(window, { CashView, TournamentsView, TournamentDrawer, SngView, ClubsView, SkeletonList, EmptyState, LobbyIcons: LI, fmtCountdown, fmtNum });
