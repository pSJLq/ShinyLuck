/* ShinyPoker — Clubs: browse, create, detail, invite. */

const { useState: useStateCl, useRef: useRefCl, useEffect: useEffectCl } = React;

const CLI = {
  plus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 5v14M5 12h14"/></svg>,
  link: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/></svg>,
  x: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>,
  users: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 6a3 3 0 0 1 0 6"/></svg>,
};

const CLUBS = [
  { id: "whale", logo: "W", name: "Whale Room", banner: "", badge: "private", desc: "High-stakes private cash & SNGs for verified members.", members: 248, tables: 6, owner: true },
  { id: "degen", logo: "D", name: "Degens Anonymous", banner: "gold", badge: "public", desc: "The biggest public club on ShinyPoker. All stakes welcome.", members: 1402, tables: 14 },
  { id: "grind", logo: "S", name: "Somnia Grinders", banner: "cyan", badge: "invite", desc: "Serious regs running daily mid-stakes sessions.", members: 56, tables: 3 },
  { id: "nft", logo: "N", name: "NFT Degens Club", banner: "", badge: "public", desc: "Holders-only freerolls and bounty nights.", members: 884, tables: 9 },
  { id: "moon", logo: "M", name: "Moonshot SNG", banner: "gold", badge: "public", desc: "Spin SNGs and hyper-turbos around the clock.", members: 311, tables: 5 },
];

const MEMBERS = [
  { av: "D", name: "degenqueen.somi", role: "Owner", tag: "Owner" },
  { av: "N", name: "nakamoto.somi", role: "Admin", tag: "Admin" },
  { av: "B", name: "blockwizard.somi", role: "Member" },
  { av: "7", name: "0x7f3a…b21d", role: "Member" },
  { av: "9", name: "0x9c4e…01af", role: "Member" },
];

function Clubs() {
  const [product, setProduct] = useStateCl("poker");
  const [showSettings, setShowSettings] = useStateCl(false);
  const [dir, setDir] = useStateCl(() => localStorage.getItem("sp_theme") || "b");
  const [settings, setSettings] = useStateCl({ sound: true, deck: "4", automuck: true, turbo: false, reduced: false, autoblind: true });
  const setT = (k, v) => setSettings(s => ({ ...s, [k]: v }));
  useEffectCl(() => { localStorage.setItem("sp_theme", dir); }, [dir]);

  const [view, setView] = useStateCl("browse");   // browse | detail
  const [tab, setTab] = useStateCl("my");
  const [showCreate, setShowCreate] = useStateCl(false);
  const [priv, setPriv] = useStateCl("private");

  return (
    <React.Fragment>
      <div className="app-topbar-host">
        <TopBar mode="lobby" roomLabel="CLUBS" product={product} onProduct={setProduct} balance={142.0}
          onSettings={() => setShowSettings(s => !s)} onDeposit={() => {}} />
        {showSettings && <SettingsPanel t={settings} set={setT} dir={dir} setDir={setDir} onClose={() => setShowSettings(false)} />}
      </div>

      <div className="page">
        {view === "browse" ? (
          <React.Fragment>
            <div className="clubs-head">
              <div>
                <h1>Clubs</h1>
                <div className="sub">Play with your crew. Create a private room, invite by link, run your own tables.</div>
              </div>
              <button className="btn primary" onClick={() => setShowCreate(true)}>{CLI.plus} Create a club</button>
            </div>
            <div className="clubs-tabs">
              {[["my", "My clubs"], ["discover", "Discover"], ["invites", "Invites"]].map(([k, l]) => (
                <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>
              ))}
            </div>
            <div className="club-grid">
              {CLUBS.map(c => (
                <div key={c.id} className="clubcard" onClick={() => setView("detail")}>
                  <div className={"cbanner " + c.banner}><GridBanner seed={c.id} /></div>
                  <div className="cbody">
                    <div className="clogo" style={{ background: c.banner === "gold" ? "#1a1408" : c.banner === "cyan" ? "#08171a" : "#15151c" }}>{c.logo}</div>
                    <span className={"cbadge " + c.badge} style={{ position: "static", display: "none" }}></span>
                    <div className="cn">{c.name}</div>
                    <div className="cd">{c.desc}</div>
                    <div className="cstats">
                      <span className="cs-i">Members<b className="tnum">{c.members.toLocaleString()}</b></span>
                      <span className="cs-i">Live tables<b className="tnum">{c.tables}</b></span>
                      <span className="cs-i">Type<b style={{ textTransform: "capitalize" }}>{c.badge}</b></span>
                    </div>
                  </div>
                </div>
              ))}
              <div className="create-tile" onClick={() => setShowCreate(true)}>
                <span className="ct-ic">{CLI.plus}</span>
                <span className="ct-t">Create a club</span>
                <span className="ct-d">Spin up a private room with invite-only cash &amp; SNG tables.</span>
              </div>
            </div>
          </React.Fragment>
        ) : (
          <ClubDetail onBack={() => setView("browse")} />
        )}
      </div>

      {showCreate && (
        <div className="modal-scrim" onClick={(e) => { if (e.target.classList.contains("modal-scrim")) setShowCreate(false); }}>
          <div className="modal">
            <div className="m-head"><span className="m-t">Create a club</span><button className="m-x" onClick={() => setShowCreate(false)}>{CLI.x}</button></div>
            <div className="m-body">
              <div className="field"><label>Club name</label><input placeholder="e.g. Whale Room" defaultValue="" /></div>
              <div className="field"><label>Description</label><textarea rows="2" placeholder="What's your club about?"></textarea></div>
              <div className="field"><label>Visibility</label>
                <div className="seg">
                  {[["private", "Private"], ["invite", "Invite-only"], ["public", "Public"]].map(([k, l]) => (
                    <button key={k} className={priv === k ? "on" : ""} onClick={() => setPriv(k)}>{l}</button>
                  ))}
                </div>
              </div>
              <div className="invitebox" style={{ margin: 0 }}>
                <div className="ib-t">{CLI.link} Your invite link (shareable after creation)</div>
                <div className="ib-link"><input readOnly value="shiny.poker/club/whale-room-x8f2" /><button className="copy">Copy</button></div>
              </div>
            </div>
            <div className="m-foot">
              <button className="btn ghost" onClick={() => setShowCreate(false)}>Cancel</button>
              <button className="btn primary" onClick={() => { setShowCreate(false); setView("detail"); }}>Create club</button>
            </div>
          </div>
        </div>
      )}

      <div id="slim-footer" />
    </React.Fragment>
  );
}

function GridBanner({ seed }) {
  const ref = useRefCl(null);
  useEffectCl(() => {
    if (!ref.current) return;
    const f = new GridField(ref.current, { cell: 12, gap: 3, speed: 0.5, density: 0.5, accent: "#6E6EED", maxAlpha: 0.7, minBright: 0.02, shape: "square" });
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced) f.start(); else f._draw(0);
    return () => f.destroy();
  }, []);
  return <canvas ref={ref} />;
}

function ClubDetail({ onBack }) {
  const bRef = useRefCl(null);
  useEffectCl(() => {
    if (!bRef.current) return;
    const f = new GridField(bRef.current, { cell: 14, gap: 4, speed: 0.45, density: 0.5, accent: "#6E6EED", accent2: "#9B9BF4", maxAlpha: 0.8, minBright: 0.02, shape: "square" });
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced) f.start(); else f._draw(0);
    return () => f.destroy();
  }, []);
  return (
    <React.Fragment>
      <div className="pagehead"><span className="crumb"><a href="#" onClick={(e) => { e.preventDefault(); onBack(); }}>Clubs</a> · Whale Room</span></div>
      <div className="club-detail">
        <div className="cd-banner"><canvas ref={bRef} /></div>
        <div className="cd-head">
          <div className="cd-logo">W</div>
          <div className="cd-meta">
            <div className="cn">Whale Room <span className="mtag">Owner</span></div>
            <div className="cdesc">High-stakes private cash &amp; SNGs for verified members · 248 members · 6 live tables</div>
          </div>
          <div className="cd-actions">
            <button className="btn ghost">Club settings</button>
            <button className="btn primary">{CLI.plus} New table</button>
          </div>
        </div>
        <div className="cd-body">
          <div className="cd-main">
            <div className="cd-sectitle">Private tables <a href="ShinyPoker Lobby.html">Open in lobby →</a></div>
            <div className="ptable"><span className="pt-type">Cash</span><div className="pt-m"><div className="pt-n">NLHE 5 / 10 · 6-max</div><div className="pt-d">avg pot 184 · rake 0.5 capped</div></div><span className="pt-seats tnum">4/6</span><button className="pt-join">Join</button></div>
            <div className="ptable"><span className="pt-type">Cash</span><div className="pt-m"><div className="pt-n">NLHE 10 / 20 · heads-up</div><div className="pt-d">avg pot 420 · rake 0.5 capped</div></div><span className="pt-seats tnum">2/2</span><button className="pt-join" style={{ background: "var(--elevated)", borderColor: "var(--line-2)" }}>Watch</button></div>
            <div className="ptable"><span className="pt-type sng">SNG</span><div className="pt-m"><div className="pt-n">Whale Hyper Turbo</div><div className="pt-d">buy-in 50 SOMI · 6 seats · starts when full</div></div><span className="pt-seats tnum">5/6</span><button className="pt-join">Register</button></div>
            <div className="ptable"><span className="pt-type sng">SNG</span><div className="pt-m"><div className="pt-n">Sunday Members Freeroll</div><div className="pt-d">free · 248 eligible · 18:00 UTC</div></div><span className="pt-seats tnum">81</span><button className="pt-join">Register</button></div>

            <div className="cd-sectitle" style={{ marginTop: 26 }}>Club activity</div>
            <div style={{ fontFamily: "var(--label)", fontSize: 12, color: "var(--muted)", lineHeight: 1.8 }}>
              <div>· blockwizard.somi won <b style={{ color: "var(--win)", fontFamily: "var(--mono)" }}>1,240 SOMI</b> at NLHE 5/10</div>
              <div>· degenqueen.somi created table <b style={{ color: "var(--white)" }}>NLHE 10/20 heads-up</b></div>
              <div>· nakamoto.somi joined the club</div>
            </div>
          </div>
          <div className="cd-side">
            <div className="invitebox">
              <div className="ib-t">{CLI.link} Invite by link</div>
              <div className="ib-link"><input readOnly value="shiny.poker/club/whale-room-x8f2" /><button className="copy">Copy</button></div>
            </div>
            <div className="cd-sectitle">Members · 248 <a href="#">See all →</a></div>
            {MEMBERS.map((m, i) => (
              <div key={i} className="memberrow">
                <div className="mav">{m.av}</div>
                <div className="mm"><div className="mn">{m.name}</div><div className="mr">{m.role}</div></div>
                {m.tag && <span className="mtag">{m.tag}</span>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </React.Fragment>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<Clubs />);
window.addEventListener("load", function () {
  var sf = document.getElementById("slim-footer");
  if (sf && window.SPSlimFooter) sf.innerHTML = window.SPSlimFooter();
});
