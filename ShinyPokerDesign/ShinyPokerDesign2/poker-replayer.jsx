/* ShinyPoker — Hand Replayer / History. Reuses Card; mini felt + playback. */

const { useState: useStateH, useRef: useRefH, useEffect: useEffectH } = React;

const HRI = {
  play: <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5l12 7-12 7z"/></svg>,
  pause: <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>,
  prev: <svg viewBox="0 0 24 24" fill="currentColor"><path d="M18 5v14l-9-7zM7 5h2v14H7z"/></svg>,
  next: <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5v14l9-7zM15 5h2v14h-2z"/></svg>,
  shield: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5z"/><path d="M9 12l2 2 4-4"/></svg>,
  share: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>,
};

// hand being replayed: each street reveals board cards + an action label
const REPLAY = {
  id: "4821", stakes: "NLHE 1/2", date: "2m ago", result: "won", amount: 49.0,
  heroHole: ["As", "Ks"],
  villain: { name: "degenqueen.somi", cards: ["Qd", "Qc"], seatPos: { x: 50, y: 12 } },
  streets: [
    { name: "Preflop", board: [], pot: 6.5, action: { who: "hero", txt: "raise 3 → call" } },
    { name: "Flop", board: ["Kh", "7d", "2c"], pot: 14.5, action: { who: "hero", txt: "bet 4 → call" } },
    { name: "Turn", board: ["Kh", "7d", "2c", "Ts"], pot: 22.5, action: { who: "villain", txt: "bet 3 → call" } },
    { name: "River", board: ["Kh", "7d", "2c", "Ts", "Kd"], pot: 49.0, action: { who: "hero", txt: "bet 13 → call" } },
    { name: "Showdown", board: ["Kh", "7d", "2c", "Ts", "Kd"], pot: 49.0, action: { who: "hero", txt: "wins: Trip Kings" }, showdown: true },
  ],
};

const HAND_HISTORY = [
  { id: "4821", hole: ["As", "Ks"], desc: "Trip Kings on K-7-2-T-K", stakes: "NLHE 1/2 · 6-max", time: "2m ago", result: "won", amt: 49.0 },
  { id: "4820", hole: ["Ks", "Kc"], desc: "Full House, Kings full of Tens", stakes: "NLHE 1/2 · 6-max", time: "12m ago", result: "won", amt: 28.0 },
  { id: "4819", hole: ["As", "Ks"], desc: "Missed flush draw vs JJ", stakes: "NLHE 1/2 · 6-max", time: "24m ago", result: "lost", amt: -34.0 },
  { id: "4818", hole: ["Qh", "Qd"], desc: "Overpair held on dry board", stakes: "NLHE 1/2 · 6-max", time: "31m ago", result: "won", amt: 18.5 },
  { id: "4817", hole: ["7c", "8c"], desc: "Straight on the turn", stakes: "Sunday Major · L12", time: "44m ago", result: "won", amt: 96.0 },
  { id: "4816", hole: ["Ad", "Qs"], desc: "Folded river to a shove", stakes: "NLHE 1/2 · 6-max", time: "1h ago", result: "lost", amt: -12.0 },
  { id: "4815", hole: ["Js", "Jd"], desc: "Set over set, paid off", stakes: "Whale Room 5/10", time: "1h ago", result: "won", amt: 240.0 },
];

function HandReplayer() {
  const [product, setProduct] = useStateH("poker");
  const [showSettings, setShowSettings] = useStateH(false);
  const [dir, setDir] = useStateH(() => localStorage.getItem("sp_theme") || "b");
  const [settings, setSettings] = useStateH({ sound: true, deck: "4", automuck: true, turbo: false, reduced: false, autoblind: true });
  const setT = (k, v) => setSettings(s => ({ ...s, [k]: v }));
  useEffectH(() => { localStorage.setItem("sp_theme", dir); }, [dir]);

  const [street, setStreet] = useStateH(1); // start on flop
  const [playing, setPlaying] = useStateH(false);
  const [selHand, setSelHand] = useStateH("4821");
  const canvasRef = useRefH(null);
  useEffectH(() => {
    if (!canvasRef.current) return;
    const f = new GridField(canvasRef.current, { cell: 14, gap: 4, speed: 0.5, density: 0.4, accent: "#6E6EED", maxAlpha: 0.5, minBright: 0.015, shape: "dot" });
    if (!settings.reduced) f.start(); else f._draw(0);
    return () => f.destroy();
  }, [settings.reduced]);

  useEffectH(() => {
    if (!playing) return;
    if (street >= REPLAY.streets.length - 1) { setPlaying(false); return; }
    const iv = setTimeout(() => setStreet(s => Math.min(REPLAY.streets.length - 1, s + 1)), 1200);
    return () => clearTimeout(iv);
  }, [playing, street]);

  const deckMode = settings.deck;
  const st = REPLAY.streets[street];
  const isShowdown = st.showdown;

  return (
    <React.Fragment>
      <div className="app-topbar-host">
        <TopBar mode="lobby" roomLabel="HAND REPLAYER" product={product} onProduct={setProduct} balance={142.0}
          onSettings={() => setShowSettings(s => !s)} onDeposit={() => {}} />
        {showSettings && <SettingsPanel t={settings} set={setT} dir={dir} setDir={setDir} onClose={() => setShowSettings(false)} />}
      </div>

      <div className="page" data-deck={deckMode}>
        <div className="pagehead">
          <span className="crumb"><a href="ShinyPoker Profile.html">Profile</a> · Hand replayer</span>
        </div>

        <div className="replay-grid">
          {/* left: replayer */}
          <div>
            <div className="minifelt">
              <canvas ref={canvasRef} />
              {/* villain seat (top) */}
              <div className={"mseat" + (isShowdown ? "" : " ")} style={{ left: "50%", top: "11%" }}>
                <div className="mcards">
                  {isShowdown
                    ? REPLAY.villain.cards.map((c, i) => <Card key={i} c={c} />)
                    : [0, 1].map(i => <Card key={i} back />)}
                </div>
                <div className="mname">{REPLAY.villain.name}</div>
                <div className="mstack">{isShowdown ? "loses 49.0" : "stack 96.0"}</div>
              </div>

              {/* center board + pot */}
              <div className="mcenter">
                <div className="mboard">
                  {[0, 1, 2, 3, 4].map(i => st.board[i]
                    ? <Card key={i} c={st.board[i]} />
                    : <div key={i} className="slot empty" />)}
                </div>
                <div className="mpot tnum">{st.pot.toFixed(1)}<span className="u">SOMI</span></div>
              </div>

              {/* hero seat (bottom) */}
              <div className={"mseat hero" + (isShowdown ? " winner" : "")} style={{ left: "50%", top: "84%" }}>
                <div className="mcards">{REPLAY.heroHole.map((c, i) => <Card key={i} c={c} />)}</div>
                <div className="mname">YOU · you.somi {isShowdown && "🏆"}</div>
                <div className="mstack">{isShowdown ? "wins 49.0" : "stack 142.0"}</div>
              </div>

              {/* action label */}
              <div className="maction" style={{ left: st.action.who === "hero" ? "50%" : "50%", top: st.action.who === "hero" ? "68%" : "30%" }}>
                {st.action.txt}
              </div>
            </div>

            {/* playback */}
            <div className="playback">
              <div className="streets">
                {REPLAY.streets.map((s, i) => (
                  <button key={i} className={i === street ? "on" : i < street ? "done" : ""} onClick={() => { setStreet(i); setPlaying(false); }}>{s.name}</button>
                ))}
              </div>
              <div className="transport">
                <button className="pbtn" onClick={() => { setStreet(s => Math.max(0, s - 1)); setPlaying(false); }}>{HRI.prev}</button>
                <button className="pbtn play" onClick={() => { if (street >= REPLAY.streets.length - 1) setStreet(0); setPlaying(p => !p); }}>{playing ? HRI.pause : HRI.play}</button>
                <button className="pbtn" onClick={() => { setStreet(s => Math.min(REPLAY.streets.length - 1, s + 1)); setPlaying(false); }}>{HRI.next}</button>
                <div className="track" onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  const f = (e.clientX - r.left) / r.width;
                  setStreet(Math.round(f * (REPLAY.streets.length - 1))); setPlaying(false);
                }}>
                  <i style={{ width: (street / (REPLAY.streets.length - 1) * 100) + "%" }} />
                  <span className="knob" style={{ left: (street / (REPLAY.streets.length - 1) * 100) + "%" }} />
                </div>
                <span className="tlabel">{st.name} · {street + 1}/{REPLAY.streets.length}</span>
              </div>
              <div className="verifystrip" data-anno="verify">
                <span className="vi">{HRI.shield}</span>
                <span className="vt"><b>zkShuffle verified ✓</b> — deck commitment 0x8af3…d21c re-hashes to the revealed seed.</span>
                <a href="ShinyPoker Cashier.html">Verify ↗</a>
              </div>
            </div>
          </div>

          {/* right: hand list */}
          <div className="pcard" style={{ padding: 18 }}>
            <div className="ph"><span className="ttl">Hand history</span><a href="#"><span style={{ display: "inline-flex", width: 13, height: 13, verticalAlign: "-2px", marginRight: 4 }}>{HRI.share}</span>Share</a></div>
            <div className="handlist-head">
              {["All", "Won", "Lost", "Tournaments"].map((f, i) => (
                <span key={f} className={"hf" + (i === 0 ? " on" : "")}>{f}</span>
              ))}
            </div>
            <div>
              {HAND_HISTORY.map(h => (
                <div key={h.id} className={"handrow" + (selHand === h.id ? " on" : "")} onClick={() => { setSelHand(h.id); setStreet(1); setPlaying(false); }}>
                  <div className="hcards">{h.hole.map((c, i) => <Card key={i} c={c} />)}</div>
                  <div className="hmain">
                    <div className="ht">{h.desc}</div>
                    <div className="hm">#{h.id} · {h.stakes} · {h.time}</div>
                  </div>
                  <div className={"hres " + (h.result === "won" ? "won" : "lost")}>{h.amt >= 0 ? "+" : "−"}{Math.abs(h.amt).toFixed(0)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div id="slim-footer" />
    </React.Fragment>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<HandReplayer />);
window.addEventListener("load", function () {
  var sf = document.getElementById("slim-footer");
  if (sf && window.SPSlimFooter) sf.innerHTML = window.SPSlimFooter();
});
