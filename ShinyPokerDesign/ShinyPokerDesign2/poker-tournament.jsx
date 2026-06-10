/* ShinyPoker — Tournament Table assembly. Reuses felt + seats + chrome. */

function TournamentTable() {
  const [dir, setDir] = useStateT(() => localStorage.getItem("sp_theme") || "b");
  const [state, setState] = useStateT("running");
  const [anno, setAnno] = useStateT(false);
  const [product, setProduct] = useStateT("poker");
  const [showSettings, setShowSettings] = useStateT(false);
  const [settings, setSettings] = useStateT({ sound: true, deck: "4", automuck: true, turbo: false, reduced: false, autoblind: true });
  const setT = (k, v) => setSettings(s => ({ ...s, [k]: v }));
  useEffectT(() => { localStorage.setItem("sp_theme", dir); }, [dir]);

  const [now, setNow] = useStateT(0);
  useEffectT(() => { const iv = setInterval(() => setNow(n => n + 1), 1000); return () => clearInterval(iv); }, []);
  const [betValue, setBetValue] = useStateT(2400);

  const appRef = useRefT(null);
  const feltCanvasRef = useRefT(null);
  const fieldRef = useRefT(null);
  useEffectT(() => {
    if (!feltCanvasRef.current) return;
    if (fieldRef.current) fieldRef.current.destroy();
    const cfg = {
      a: { cell: 15, gap: 4, speed: 0.7, density: 0.5, accent: "#6E6EED", maxAlpha: 0.55, minBright: 0.02, shape: "square" },
      b: { cell: 17, gap: 6, speed: 0.55, density: 0.42, accent: "#6E6EED", accent2: "#9B9BF4", maxAlpha: 0.5, minBright: 0.015, shape: "dot" },
      c: { cell: 13, gap: 3, speed: 0.6, density: 0.45, accent: "#6E6EED", maxAlpha: 0.42, minBright: 0.02, shape: "square" },
    }[dir];
    const f = new GridField(feltCanvasRef.current, cfg);
    fieldRef.current = f;
    if (!settings.reduced) f.start(); else f._draw(0);
    return () => f.destroy();
  }, [dir, settings.reduced]);

  const deckMode = settings.deck;
  const scene = { dealer: 5, sb: 0, bb: 3, activeSeat: 0 };
  const heroHole = ["As", "Kd"];
  const board = ["Qh", "Jc", "9s"];
  const isBust = state === "bust";
  const isBreak = state === "break";

  function markerFor(i) {
    if (i === scene.dealer) return "dealer";
    if (i === scene.sb) return "sb";
    if (i === scene.bb) return "bb";
    return null;
  }

  const trnAction = {
    toCall: 1200, minRaise: 2400, potForBet: 6300, heroStack: 38500,
    best: "Open-ended straight draw", outs: 8, potOdds: "19%", vpip: "23/19",
  };

  return (
    <div className="scaler" id="scaler">
      <div className="app trntable" ref={appRef} data-dir={dir} data-deck={deckMode}
        data-screen-label={"Tournament Table · " + state}>
        <TopBar mode="table" scene={{ hand: "12·4821" }} product={product} onProduct={setProduct} balance={142.0}
          onSettings={() => setShowSettings(s => !s)} deckMode={deckMode} />
        {showSettings && <SettingsPanel t={settings} set={setT} dir={dir} setDir={setDir} onClose={() => setShowSettings(false)} />}

        <TrnTopStrip now={now} state={state} />

        <div className="mainrow">
          <div className="feltwrap scanlines">
            <canvas className="feltcanvas" ref={feltCanvasRef} />
            <div className="feltglow" />
            <div className="felt">
              <div className="center">
                <span className="zkbadge" data-anno-skip>
                  <span className="chk">{ChromeIcons.shield}</span>zkShuffle · provably fair ✓
                </span>
                {!isBreak && <Board cards={board} deckMode={deckMode} />}
                {!isBreak && <Pot pot={6300} chips={true} />}
              </div>
              {isBreak && <BreakBanner />}
              {state === "final" && <FinalTableBadge />}
            </div>
            <div className="feltvignette" />

            {/* seats */}
            {!isBreak && TRN_PLAYERS.map((p, i) => {
              if (p.hero) return null;
              const d = TRN_SEATS[i];
              return <Seat key={i} player={p} data={d} pos={SEAT_POS_6[i]} active={i === scene.activeSeat && state === "running"}
                marker={markerFor(i)} deckMode={deckMode} />;
            })}
            {!isBreak && TRN_PLAYERS.map((p, i) => {
              const d = TRN_SEATS[i];
              return (d.bet && !p.hero) ? <BetChips key={i} pos={SEAT_POS_6[i]} amount={d.bet} chips={true} /> : null;
            })}

            {/* hero zone */}
            {!isBreak && (
              <div className="herozone">
                <div className="hole peek">{heroHole.map((c, i) => <Card key={i} c={c} />)}</div>
                <div className={"heroinfo" + (state === "running" ? " active" : "")}>
                  <div className="avatar">Y<span className="ava-grid" /></div>
                  <div className="meta">
                    <span className="nm">YOU · you.somi</span>
                    <span className="stack tnum">{fmtChips(TRN.chips)}<span className="bbcount"> · {TRN.bb}bb</span></span>
                  </div>
                  <div className="hmark">{markerFor(0) && <Marker kind={markerFor(0)} />}</div>
                  <span className="hstatus">{TRN_SEATS[0].status}</span>
                </div>
              </div>
            )}

            {/* overlays */}
            <RankChip state={state} />
            <PrizeRail state={state} />
            {state === "bubble" && <BubbleStrip />}
            {isBust && <EliminationScreen />}

            <AnnotationLayer enabled={anno} containerRef={appRef} defs={TRN_ANNO} />
          </div>

          <SideRail />
        </div>

        {/* action bar (running) or status strip */}
        {state === "running" && (
          <ActionBar action={trnAction} deckMode={deckMode} betValue={betValue} setBetValue={setBetValue} onFold={() => {}} />
        )}
        {state === "bubble" && <StatusStrip text="Hand-for-hand — play tightens on the bubble" sub="One more bust-out and everyone left is in the money" accent="var(--gold)" />}
        {state === "break" && <StatusStrip text="On break — 2:58 remaining" sub="Blinds go up to 800 / 1600 at Level 13" accent="var(--accent-soft)" />}
        {state === "final" && <StatusStrip text="Final table — 6 players left" sub="Every elimination pays out automatically on-chain" accent="var(--gold)" />}
        {state === "bust" && <StatusStrip text="Eliminated in 47th" sub="33.5 SOMI paid to your escrow balance" accent="var(--win)" />}
      </div>

      {/* dev HUD */}
      <div className="hud">
        <a href="ShinyPoker Table.html" className="hgroup" style={{ textDecoration: "none" }}><button>Cash</button></a>
        <a href="ShinyPoker Lobby.html" className="hgroup" style={{ textDecoration: "none" }}><button>Lobby</button></a>
        <div className="hsep" />
        <div className="hgroup">
          {TRN_STATES.map(s => {
            const lbl = { running: "Running", bubble: "Bubble", break: "Break", final: "Final", bust: "Bust" }[s];
            return <button key={s} className={state === s ? "on" : ""} onClick={() => setState(s)}>{lbl}</button>;
          })}
        </div>
        <div className="hsep" />
        <div className="hgroup">
          {[["a", "Term"], ["b", "Prem"], ["c", "Grid"]].map(([k, l]) => (
            <button key={k} className={dir === k ? "on" : ""} onClick={() => setDir(k)}>{l}</button>
          ))}
        </div>
        <div className="hsep" />
        <label className={"htoggle" + (anno ? " on" : "")} onClick={() => setAnno(!anno)}>
          <span className="sw"><i /></span> Notes
        </label>
      </div>
    </div>
  );
}

const TRN_ANNO = [
  { sel: "trnstrip", kind: "chain", text: "Blind level & player count · on-chain tournament state", at: "bottom" },
  { sel: "bounty", kind: "chain", text: "KO bounties paid on-chain at elimination", at: "bottom" },
  { sel: "rebuy", kind: "chain", text: "Re-entry buy-in → prize pool escrow · on-chain", at: "bottom" },
  { sel: "prize", kind: "chain", text: "Prize pool secured in escrow · auto-paid on-chain", at: "left" },
  { sel: "rank", kind: "off", text: "Your live rank · pushed via WebSocket", at: "right" },
  { sel: "actions", kind: "session", text: "Fold/Call/Raise · session-key (no popup)", at: "top" },
];

function mountScaleT() {
  const scaler = document.getElementById("scaler");
  if (!scaler) return;
  const app = scaler.querySelector(".app");
  function fit() {
    const pad = 24, topBand = 60;
    const s = Math.min((window.innerWidth - pad) / 1600, (window.innerHeight - topBand - pad) / 1000, 1);
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

ReactDOM.createRoot(document.getElementById("root")).render(<TournamentTable />);
setTimeout(mountScaleT, 60);
