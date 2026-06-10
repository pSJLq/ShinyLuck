/* ShinyPoker — Profile / Stats. Reuses TopBar + slim footer. Scrollable app page. */

const { useState: useStateP, useRef: useRefP, useEffect: useEffectP } = React;

const PI = {
  trophy: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6 4h12v3a6 6 0 0 1-12 0z"/><path d="M6 5H3v2a3 3 0 0 0 3 3M18 5h3v2a3 3 0 0 1-3 3M9 16h6M10 16l-.5 4M14 16l.5 4M8 20h8"/></svg>,
  fire: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 2s5 4 5 9a5 5 0 0 1-10 0c0-2 1-3 1-3s.5 2 2 2c0-3 2-5 2-8z"/></svg>,
  target: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></svg>,
  crown: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 7l4 4 5-7 5 7 4-4-2 12H5z"/></svg>,
  spade: <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3c0 0-7 5.5-7 11a4 4 0 0 0 6 3.5L10 21h4l-1-3.5A4 4 0 0 0 19 14c0-5.5-7-11-7-11z"/></svg>,
  skull: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 2a8 8 0 0 0-5 14v3h10v-3a8 8 0 0 0-5-14z"/><circle cx="9" cy="11" r="1.5" fill="currentColor"/><circle cx="15" cy="11" r="1.5" fill="currentColor"/></svg>,
  lock: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>,
  copy: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>,
};

function Profile() {
  const [product, setProduct] = useStateP("poker");
  const [showSettings, setShowSettings] = useStateP(false);
  const [dir, setDir] = useStateP(() => localStorage.getItem("sp_theme") || "b");
  const [settings, setSettings] = useStateP({ sound: true, deck: "4", automuck: true, turbo: false, reduced: false, autoblind: true });
  const setT = (k, v) => setSettings(s => ({ ...s, [k]: v }));
  useEffectP(() => { localStorage.setItem("sp_theme", dir); }, [dir]);

  return (
    <React.Fragment>
      <div className="app-topbar-host">
        <TopBar mode="lobby" roomLabel="PROFILE" product={product} onProduct={setProduct} balance={142.0}
          onSettings={() => setShowSettings(s => !s)} onDeposit={() => {}} />
        {showSettings && <SettingsPanel t={settings} set={setT} dir={dir} setDir={setDir} onClose={() => setShowSettings(false)} />}
      </div>

      <div className="page">
        {/* hero */}
        <div className="profhero">
          <div className="pava">D<span className="g" /></div>
          <div className="pmeta">
            <div className="nm">degenqueen.somi <span className="vbadge">✓ ENS verified</span></div>
            <div className="addr">0x7f3a9c4e21d0…b21d <span className="copy">{PI.copy}</span></div>
            <div className="joined">On-chain since Jan 2026 · 1,284 hands this week</div>
          </div>
          <div className="pactions">
            <a className="btn primary" href="ShinyPoker Lobby.html">Find a table</a>
            <a className="btn ghost" href="ShinyPoker Cashier.html">Cashier</a>
          </div>
        </div>

        {/* stat tiles */}
        <div className="stattiles">
          <div className="stattile"><div className="k">Hands played</div><div className="v tnum">48,210</div></div>
          <div className="stattile"><div className="k">Win rate (bb/100)</div><div className="v win tnum">+6.4</div><div className="d">last 30 days</div></div>
          <div className="stattile"><div className="k">Biggest pot</div><div className="v acc tnum">2,840</div><div className="d">SOMI</div></div>
          <div className="stattile"><div className="k">Tournament cashes</div><div className="v tnum">37</div><div className="d">9 final tables</div></div>
          <div className="stattile"><div className="k">ROI</div><div className="v win tnum">+18%</div><div className="d">128 entries</div></div>
          <div className="stattile"><div className="k">Total KOs</div><div className="v gold tnum">214</div><div className="d">bounties</div></div>
        </div>

        {/* two-col */}
        <div className="profgrid">
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {/* bankroll chart */}
            <div className="pcard">
              <div className="ph"><span className="ttl">Bankroll over time</span><a href="ShinyPoker Cashier.html">Full tx history →</a></div>
              <BankrollChart />
              <div className="chartlegend">
                <span><i />Net bankroll (SOMI)</span>
                <span style={{ color: "var(--win)" }}>+842 SOMI all-time</span>
              </div>
            </div>

            {/* achievements */}
            <div className="pcard">
              <div className="ph"><span className="ttl">Achievements &amp; NFT badges</span><a href="#">View collection →</a></div>
              <div className="badgegrid">
                <div className="badge-nft"><span className="bi">{PI.trophy}</span><span className="br">Gold</span><span className="bn">Sunday Major winner</span></div>
                <div className="badge-nft"><span className="bi">{PI.fire}</span><span className="br">Rare</span><span className="bn">10-table heater</span></div>
                <div className="badge-nft"><span className="bi">{PI.crown}</span><span className="br">Epic</span><span className="bn">Final table x9</span></div>
                <div className="badge-nft"><span className="bi" style={{ color: "var(--gold)" }}>{PI.target}</span><span className="br">Gold</span><span className="bn">200 bounties</span></div>
                <div className="badge-nft"><span className="bi">{PI.spade}</span><span className="br" style={{ color: "var(--accent-soft)" }}>Common</span><span className="bn">Royal flush</span></div>
                <div className="badge-nft locked"><span className="bi">{PI.lock}</span><span className="bn">Whale Room cash</span></div>
                <div className="badge-nft locked"><span className="bi">{PI.lock}</span><span className="bn">100k hands</span></div>
                <div className="badge-nft locked"><span className="bi">{PI.lock}</span><span className="bn">#1 leaderboard</span></div>
              </div>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {/* session-key manager */}
            <div className="pcard" data-anno="sessions">
              <div className="ph"><span className="ttl">Session-key manager</span></div>
              <div className="sessrow">
                <div className="si">{PI.lock}</div>
                <div className="sm"><div className="st">NLHE 1/2 · 6-max</div><div className="ss">cap 50 SOMI · expires in 2h 14m</div></div>
                <button className="revoke">Revoke</button>
              </div>
              <div className="sessrow">
                <div className="si">{PI.lock}</div>
                <div className="sm"><div className="st">Somnia Sunday Major</div><div className="ss">cap 25 SOMI · active</div></div>
                <button className="revoke">Revoke</button>
              </div>
              <div style={{ marginTop: 10, fontFamily: "var(--label)", fontSize: 11, color: "var(--muted)", lineHeight: 1.5 }}>
                Session keys let you play popup-free. Revoking ends a session immediately — your funds stay in escrow.
              </div>
            </div>

            {/* clubs */}
            <div className="pcard">
              <div className="ph"><span className="ttl">Club memberships</span><a href="ShinyPoker Clubs.html">All clubs →</a></div>
              <div className="clubchip"><div className="ci">W</div><div className="cm"><div className="cn">Whale Room</div><div className="cs">Private · 248 members · owner</div></div></div>
              <div className="clubchip"><div className="ci">D</div><div className="cm"><div className="cn">Degens Anonymous</div><div className="cs">Public · 1,402 members</div></div></div>
              <div className="clubchip"><div className="ci">S</div><div className="cm"><div className="cn">Somnia Grinders</div><div className="cs">Invite-only · 56 members</div></div></div>
            </div>

            {/* play style */}
            <div className="pcard">
              <div className="ph"><span className="ttl">Play style</span></div>
              <StatBar label="VPIP" value={24} max={50} />
              <StatBar label="PFR" value={19} max={50} />
              <StatBar label="3-bet %" value={8} max={20} />
              <StatBar label="WTSD %" value={27} max={50} />
            </div>
          </div>
        </div>
      </div>

      <div id="slim-footer" />
    </React.Fragment>
  );
}

function StatBar({ label, value, max }) {
  return (
    <div style={{ marginBottom: 13 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--label)", fontSize: 11, marginBottom: 6 }}>
        <span style={{ color: "var(--muted)" }}>{label}</span>
        <span style={{ fontFamily: "var(--mono)", color: "var(--white)" }}>{value}%</span>
      </div>
      <div style={{ height: 5, borderRadius: 5, background: "rgba(255,255,255,0.07)", overflow: "hidden" }}>
        <div style={{ height: "100%", width: (value / max * 100) + "%", background: "var(--accent)", boxShadow: "0 0 8px var(--accent-55)" }} />
      </div>
    </div>
  );
}

function BankrollChart() {
  // generate a rising-with-variance bankroll line
  const pts = [0, 60, 40, 120, 90, 180, 150, 260, 230, 340, 300, 420, 480, 440, 560, 620, 590, 720, 780, 842];
  const W = 600, H = 200, max = 900;
  const path = pts.map((p, i) => `${(i / (pts.length - 1)) * W},${H - (p / max) * H}`).join(" L ");
  const area = `M 0,${H} L ${path} L ${W},${H} Z`;
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="bkgrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(110,110,237,0.35)" />
            <stop offset="100%" stopColor="rgba(110,110,237,0)" />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((g, i) => <line key={i} className="gridline" x1="0" y1={H * g} x2={W} y2={H * g} />)}
        <path d={area} fill="url(#bkgrad)" />
        <path d={`M ${path}`} fill="none" stroke="var(--accent)" strokeWidth="2.5" vectorEffect="non-scaling-stroke"
          style={{ filter: "drop-shadow(0 0 6px rgba(110,110,237,0.5))" }} />
      </svg>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<Profile />);
window.addEventListener("load", function () {
  var sf = document.getElementById("slim-footer");
  if (sf && window.SPSlimFooter) sf.innerHTML = window.SPSlimFooter();
});
