/* ShinyPoker chrome: top bar, side rail, action bar, annotations, HUD, overlays. */

const I = {
  gear: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></svg>,
  leave: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>,
  lock: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>,
  plus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 5v14M5 12h14"/></svg>,
  shield: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5z"/><path d="M9 12l2 2 4-4"/></svg>,
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M20 6L9 17l-5-5"/></svg>,
  pause: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>,
};

/* ---------------- Top bar ---------------- */
function TopBar({ scene, product, onProduct, onSettings, deckMode, balance, mode = "table", onDeposit, wrongNetwork, roomLabel }) {
  return (
    <header className="topbar">
      <div className="group">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <BraceLogo size={22} />
          <span className="wordmark" style={{ fontSize: 17 }}>shiny<span className="accent">poker</span></span>
        </span>
      </div>
      <div className="switcher" data-anno="switcher">
        <button className={product === "casino" ? "on casino" : ""} onClick={() => onProduct && onProduct("casino")}>
          <span className="dot" />ShinyLuck
        </button>
        <button className={product === "poker" ? "on" : ""} onClick={() => onProduct && onProduct("poker")}>
          <span className="dot" />Poker
        </button>
      </div>
      <div className="sep" />
      {mode === "table" ? (
        <div className="group" data-anno="blinds">
          <span className="metapill"><span className="k">NLHE</span><b>6-MAX</b></span>
          <span className="metapill"><span className="k">Blinds</span><b>0.5 / 1</b></span>
          <span className="metapill"><span className="k">Hand</span><b>#{scene.hand}</b></span>
        </div>
      ) : (
        <div className="group">
          <span className="metapill"><span className="k">Room</span><b>{roomLabel || "LOBBY"}</b></span>
        </div>
      )}
      <div className="spacer" />
      {mode === "table" && <button className="iconbtn" title="Add chips / top-up">{I.plus}</button>}
      {mode === "lobby" && (
        <button className="metapill" data-anno="deposit" onClick={onDeposit}
          style={{ cursor: "pointer", gap: 7, height: 34, color: "var(--accent-soft)", borderColor: "var(--accent-32)", background: "var(--accent-12)" }}>
          <span style={{ width: 13, height: 13 }}>{I.plus}</span> Deposit
        </button>
      )}
      {mode === "table" && (
        <div className="session" data-anno="session" title="Table session active — fold/call/raise without a wallet popup">
          <span className="pulse" />
          <span className="lock">{I.lock}</span>
          <span>session active · cap 50</span>
        </div>
      )}
      <div className={"wallet" + (wrongNetwork ? " wrongnet" : "")} data-anno="wallet">
        <SomiIcon className="somi" />
        <span className="bal tnum">{balance.toFixed(1)}</span>
        <span className="net">{wrongNetwork ? "Wrong network" : "Somnia"}</span>
      </div>
      <button className="iconbtn" title="Settings" onClick={onSettings}>{I.gear}</button>
      {mode === "table" && <button className="iconbtn leavebtn" title="Leave table">{I.leave}</button>}
    </header>
  );
}

/* ---------------- Side rail ---------------- */
function SideRail() {
  const [tab, setTab] = React.useState("chat");
  return (
    <aside className="siderail" data-anno="rail">
      <div className="railtabs">
        {["chat", "hands", "notes"].map(t => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>
      <div style={{ padding: "9px 12px", borderBottom: "1px solid var(--line)" }}>
        <span className="tag">{tab === "chat" ? "table chat · dealer feed" : tab === "hands" ? "hand history · #4821" : "player notes & tags"}</span>
      </div>
      <div className="railbody">
        {tab === "chat" && CHAT.map((c, i) => (
          <div key={i} className={"chatline" + (c.dealer ? " dealer" : "")}>
            {!c.dealer && <span className="who">{c.who}</span>}{c.t}
          </div>
        ))}
        {tab === "hands" && HISTORY.map((h, i) => (
          <div key={i} className="hhrow"><span className="st">{h.st}</span><span className="act">{h.act}</span></div>
        ))}
        {tab === "notes" && (
          <div>
            <div className="hhrow"><span className="st" style={{ color: "var(--danger-soft)" }}>RED</span><span className="act">degenqueen.somi — <span className="dim">3-bets light, c-bets 80%+</span></span></div>
            <div className="hhrow"><span className="st" style={{ color: "var(--win)" }}>GREEN</span><span className="act">nakamoto.somi — <span className="dim">tight / folds to aggression</span></span></div>
            <div className="hhrow"><span className="st" style={{ color: "var(--accent-soft)" }}>NOTE</span><span className="act">blockwizard.somi — <span className="dim">straddles every BTN</span></span></div>
            <div className="chatinput"><input placeholder="Add a note…" /></div>
          </div>
        )}
      </div>
      <div className="pfwidget" data-anno="pf">
        <div className="pfhead">
          <span className="ttl">{I.shield} zkShuffle · provably fair</span>
          <span className="zkbadge" style={{ padding: "3px 8px" }}><span className="chk">{I.check}</span>Verify</span>
        </div>
        <div className="commit">
          <div><span className="lab">commit</span> 0x8af3c1d9…e7b2d21c</div>
          <div style={{ marginTop: 4 }}><span className="lab">deck</span> sealed pre-deal · reveal post-hand</div>
        </div>
      </div>
    </aside>
  );
}

/* ---------------- Action bar (your turn) ---------------- */
function ActionBar({ action, deckMode, onFold, onCheckCall, onRaise, betValue, setBetValue }) {
  const { toCall, minRaise, potForBet, heroStack, best, outs, potOdds, raiseLabel, canCheck, step, symbol } = action;
  const [active, setActive] = React.useState(null);
  const min = minRaise, max = heroStack;
  const fill = ((betValue - min) / (max - min)) * 100;
  const quick = [
    { k: "Min", v: minRaise },
    { k: "½", v: round1(potForBet * 0.5 + toCall) },
    { k: "⅔", v: round1(potForBet * 0.66 + toCall) },
    { k: "Pot", v: round1(potForBet + toCall) },
    { k: "All-in", v: heroStack },
  ];
  return (
    <div className="actionbar">
      <div className="helpers" data-anno="helpers">
        <span className="helperchip best"><span className="k">Best</span><b>{best}</b></span>
        <div style={{ display: "flex", gap: 7 }}>
          <span className="helperchip"><span className="k">Pot odds</span><b>{potOdds}</b></span>
          <span className="helperchip"><span className="k">Outs</span><b>{outs}</b></span>
        </div>
      </div>

      <div className="betcontrols" data-anno="bet">
        <div className="quickchips">
          {quick.map(q => (
            <button key={q.k} className={active === q.k ? "on" : ""}
              onClick={() => { setActive(q.k); setBetValue(Math.min(max, Math.max(min, q.v))); }}>{q.k}</button>
          ))}
        </div>
        <div className="sliderrow">
          <div className="bslider" style={{ "--fill": fill + "%" }}>
            <input type="range" min={min} max={max} step={step || 0.5} value={betValue}
              onChange={e => { setBetValue(parseFloat(e.target.value)); setActive(null); }} />
          </div>
          <div className="betinput">
            <input type="text" value={betValue.toFixed(betValue % 1 ? 1 : 0)}
              onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) setBetValue(v); }} />
            <span className="u">{symbol || "SOMI"}</span>
          </div>
        </div>
      </div>

      <div className="timebank">
        <div className="tbring">
          <svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="20" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="3"/>
            <circle cx="24" cy="24" r="20" fill="none" stroke={action.timer != null && action.timer <= 8 ? "var(--danger-soft)" : "var(--accent)"} strokeWidth="3" strokeLinecap="round"
              strokeDasharray="125.6" strokeDashoffset={action.timer != null ? (125.6 * (1 - Math.max(0, Math.min(1, action.timer / (action.timerTotal || 45))))) : 34} transform="rotate(-90 24 24)" /></svg>
          <span className="num tnum">{action.timer != null ? action.timer : 18}</span>
        </div>
        <button className="addtime">+ Time bank</button>
      </div>

      <div className="actions" data-anno="actions">
        <button className="abtn fold" onClick={onFold}><span className="key">F</span><span className="lbl">Fold</span></button>
        <button className="abtn call" onClick={onCheckCall}><span className="key">C</span><span className="lbl">{canCheck ? "Check" : "Call"}</span>{!canCheck && <span className="amt tnum">{toCall.toFixed(2)}</span>}</button>
        <button className="abtn raise" onClick={() => onRaise(betValue)}><span className="key">R</span><span className="lbl">{raiseLabel || "Raise to"}</span><span className="amt tnum">{betValue.toFixed(betValue % 1 ? 1 : 0)}</span></button>
      </div>
    </div>
  );
}

function round1(n) { return Math.round(n * 2) / 2; }

/* status strip for non-your-turn states */
function StatusStrip({ text, sub, accent }) {
  return (
    <div className="actionbar" style={{ alignItems: "center", justifyContent: "center" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, paddingBottom: 6 }}>
        <div style={{ fontFamily: "var(--label)", fontSize: 13, letterSpacing: "0.1em", textTransform: "uppercase",
          color: accent || "var(--muted)" }}>{text}</div>
        {sub && <div style={{ fontFamily: "var(--body)", fontSize: 12.5, color: "var(--muted)" }}>{sub}</div>}
      </div>
    </div>
  );
}

/* ---------------- Banners & overlays ---------------- */
function WinBanner({ hand, won, lose }) {
  return (
    <div className={"winbanner" + (lose ? " lose" : "")}>
      <div className="won">{lose ? "You lose" : "You win"}</div>
      <div className="hand">{hand}</div>
      {won != null && !lose && <div className="zkbadge" style={{ marginTop: 4 }}><span className="chk">{I.check}</span>{won.toFixed(1)} SOMI paid out on-chain</div>}
      {lose && <div className="zkbadge" style={{ marginTop: 4, borderColor: "rgba(229,86,42,0.4)", color: "var(--danger-soft)" }}>pot settled on-chain</div>}
    </div>
  );
}

function RunItTwicePrompt({ onChoose }) {
  return (
    <div className="ritprompt">
      <div className="q">Run it twice?<small>Deal the turn &amp; river on two boards — split the pot, reduce variance.</small></div>
      <div className="btns">
        <button className="pill" onClick={() => onChoose("once")}>Run once</button>
        <button className="pill primary" onClick={() => onChoose("twice")}>Run it twice ✓</button>
      </div>
    </div>
  );
}

function DiscOverlay({ field }) {
  return (
    <div className="discoverlay">
      <div className="disccard">
        <div className="spin" />
        <div className="ttl">Reconnecting…</div>
        <div className="sub">Lost connection to the Somnia node. Re-subscribing to the table's live event stream.</div>
        <div className="note">{I.lock} Your hand &amp; chips are safe — held on-chain. Time-bank auto-protects your action.</div>
      </div>
    </div>
  );
}

function TxToast() {
  return (
    <div className="txtoast" data-anno="tx">
      <span className="sp" />
      <span>Settling pot on-chain… <a href="#">0x4f…a91 ↗</a></span>
    </div>
  );
}

/* ---------------- Settings popover ---------------- */
const THEME_SWATCHES = [
  { k: "a", name: "Terminal", bg: "radial-gradient(120% 120% at 50% 30%, rgba(110,110,237,0.18), #08080b 60%)", border: "1px solid rgba(255,255,255,0.14)" },
  { k: "b", name: "Premium", bg: "radial-gradient(70% 70% at 50% 35%, #2a2150, #140f29 60%, #0a0813)", border: "2px solid rgba(110,110,237,0.5)" },
  { k: "c", name: "Grid", bg: "linear-gradient(180deg,#0e0e11,#0a0a0c)", border: "1px solid rgba(255,255,255,0.1)", grid: true },
];

function SettingsPanel({ t, set, dir, setDir, onClose, session }) {
  const Row = ({ label, children }) => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "9px 0", borderBottom: "1px solid var(--hair)" }}>
      <span style={{ fontFamily: "var(--label)", fontSize: 12, color: "var(--text-2)" }}>{label}</span>{children}
    </div>
  );
  const Sw = ({ on, onClick }) => (
    <button onClick={onClick} className={"htoggle" + (on ? " on" : "")} style={{ padding: 0 }}>
      <span className="sw"><i /></span></button>
  );
  return (
    <div style={{ position: "absolute", top: 50, right: 14, zIndex: 60, width: 280, padding: "12px 14px",
      borderRadius: 12, background: "rgba(13,13,18,0.97)", border: "1px solid var(--line-2)",
      boxShadow: "0 24px 70px rgba(0,0,0,0.6)", backdropFilter: "blur(10px)", maxHeight: "calc(100% - 70px)", overflowY: "auto" }}>
      <div className="tag" style={{ marginBottom: 8 }}>table settings</div>

      {/* Table theme selector */}
      <div style={{ fontFamily: "var(--label)", fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase",
        color: "var(--muted)", marginBottom: 8 }}>Table theme</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 6 }}>
        {THEME_SWATCHES.map(s => (
          <button key={s.k} onClick={() => setDir(s.k)} style={{ background: "transparent", border: 0, padding: 0, cursor: "pointer" }}>
            <div style={{ height: 46, borderRadius: 8, background: s.bg, border: dir === s.k ? "1px solid var(--accent)" : s.border,
              boxShadow: dir === s.k ? "0 0 0 1px var(--accent), 0 0 14px rgba(110,110,237,0.35)" : "none",
              position: "relative", overflow: "hidden", transition: ".15s" }}>
              {s.grid && <div style={{ position: "absolute", inset: 0, backgroundImage: "linear-gradient(rgba(255,255,255,0.07) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.07) 1px,transparent 1px)", backgroundSize: "8px 8px" }} />}
              <div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)", width: 18, height: 12, borderRadius: 2,
                background: "#f3f3f7", boxShadow: "5px 0 0 #f3f3f7" }} />
            </div>
            <div style={{ fontFamily: "var(--label)", fontSize: 10, marginTop: 5, textAlign: "center",
              color: dir === s.k ? "var(--accent-soft)" : "var(--muted)" }}>{s.name}{dir === s.k ? " ✓" : ""}</div>
          </button>
        ))}
      </div>
      <div style={{ height: 1, background: "var(--hair)", margin: "6px 0 2px" }} />

      <Row label="Sound effects"><Sw on={t.sound} onClick={() => set("sound", !t.sound)} /></Row>
      <Row label="4-color deck"><Sw on={t.deck === "4"} onClick={() => set("deck", t.deck === "4" ? "2" : "4")} /></Row>
      <Row label="Auto-muck losing hands"><Sw on={t.automuck} onClick={() => set("automuck", !t.automuck)} /></Row>
      <Row label="Turbo animations"><Sw on={t.turbo} onClick={() => set("turbo", !t.turbo)} /></Row>
      <Row label="Reduced motion"><Sw on={t.reduced} onClick={() => set("reduced", !t.reduced)} /></Row>
      <Row label="Auto-post blinds"><Sw on={t.autoblind} onClick={() => set("autoblind", !t.autoblind)} /></Row>
      {session && (
        <div style={{ marginTop: 10, padding: "10px 11px", borderRadius: 8, border: "1px solid var(--accent-32)", background: "var(--accent-12)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, fontFamily: "var(--label)", fontSize: 11, color: "var(--accent-soft)" }}>
            <span style={{ width: 14, height: 14, display: "inline-flex", flexShrink: 0 }}>{I.lock}</span>
            {session.label ? session.label : (session.active ? ("Session key active" + (session.cap != null ? " · cap " + session.cap : "")) : "Session key off")}</div>
          <div style={{ fontFamily: "var(--label)", fontSize: 10.5, color: "var(--muted)", margin: "6px 0 9px" }}>
            {session.active ? "Fold / call / raise without a wallet popup." : "Grant a table session to act without a popup each time."}</div>
          <button className="pill" disabled={session.busy} onClick={session.active ? session.onRevoke : session.onActivate}
            style={{ fontSize: 11, padding: "7px 12px", width: "100%", borderColor: session.active ? "rgba(229,86,42,0.4)" : "var(--accent-32)", color: session.active ? "var(--danger-soft)" : "var(--accent-soft)" }}>
            {session.active ? "Revoke session key" : "Activate session"}</button>
        </div>
      )}
      <button className="pill" style={{ fontSize: 11, padding: "7px 12px", width: "100%", marginTop: 8 }} onClick={onClose}>Close</button>
    </div>
  );
}

Object.assign(window, { TopBar, SideRail, ActionBar, StatusStrip, WinBanner, RunItTwicePrompt, DiscOverlay, TxToast, SettingsPanel, ChromeIcons: I });
