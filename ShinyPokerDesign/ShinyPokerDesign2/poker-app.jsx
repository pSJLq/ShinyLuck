/* ShinyPoker — Poker Table app. Assembles the felt, seats, board, action bar,
   side rail, annotations, state machine + full deal/chip/pot animation. */

const { useState, useRef, useEffect, useLayoutEffect } = React;

/* flying chips for pot-collect: from center → winner seat */
function FlyChips({ containerRef, toX, toY }) {
  const [vec, setVec] = useState(null);
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // center anchor at 50%,43%
    const dx = (toX - 50) / 100 * r.width;
    const dy = (toY - 43) / 100 * r.height;
    setVec({ dx, dy });
  }, []);
  if (!vec) return null;
  return (
    <div className="flychips">
      {[0, 1, 2, 3, 4, 5].map(i => (
        <span key={i} className="flychip" style={{
          left: (Math.cos(i) * 10) + "px", top: (Math.sin(i) * 10) + "px",
          "--ptx": vec.dx + "px", "--pty": vec.dy + "px", animationDelay: (i * 50) + "ms",
        }} />
      ))}
    </div>
  );
}

function PokerTable() {
  const [dir, setDir] = useState(() => localStorage.getItem("sp_theme") || "b");
  const [stateKey, setStateKey] = useState("yourturn");
  const [anno, setAnno] = useState(false);
  const [product, setProduct] = useState("poker");
  const [showSettings, setShowSettings] = useState(false);
  const [rit, setRit] = useState(null);          // run-it-twice choice
  const [settings, setSettings] = useState({
    sound: true, deck: "4", automuck: true, turbo: false, reduced: false, autoblind: true,
  });
  const setT = (k, v) => setSettings(s => ({ ...s, [k]: v }));
  useEffect(() => { localStorage.setItem("sp_theme", dir); }, [dir]);

  const scene = SCENES[stateKey];
  const [betValue, setBetValue] = useState(6);
  useEffect(() => {
    if (scene.action) setBetValue(scene.action.minRaise);
    setRit(null);
  }, [stateKey]);

  const appRef = useRef(null);
  const feltCanvasRef = useRef(null);
  const feltWrapRef = useRef(null);
  const fieldRef = useRef(null);

  // ---- animation phase engine ----
  // phases: shuffle → deal → flop → turn → done   (yourturn only); other states = done
  const [phase, setPhase] = useState("done");
  const [dealNonce, setDealNonce] = useState(0);
  const reduced = settings.reduced;
  const u = settings.turbo ? 0.45 : 1;
  const timersRef = useRef([]);

  function clearTimers() { timersRef.current.forEach(clearTimeout); timersRef.current = []; }
  function seq(steps) {
    clearTimers();
    let t = 0;
    steps.forEach(([ms, fn]) => { t += ms; timersRef.current.push(setTimeout(fn, t)); });
  }

  useEffect(() => {
    clearTimers();
    if (reduced) { setPhase("done"); return; }
    if (stateKey === "yourturn") {
      setPhase("shuffle");
      if (fieldRef.current) fieldRef.current.scramble(900 * u);
      seq([
        [820 * u, () => setPhase("deal")],
        [620 * u, () => setPhase("flop")],
        [780 * u, () => setPhase("turn")],
        [640 * u, () => setPhase("done")],
      ]);
    } else {
      setPhase("done");
      if (fieldRef.current && (stateKey === "win" || stateKey === "lose")) fieldRef.current.flash();
    }
    return clearTimers;
  }, [stateKey, dealNonce, reduced]);

  function replay() { setDealNonce(n => n + 1); }
  const dealing = stateKey === "yourturn" && phase !== "done";

  // felt grid field — re-tune per direction
  useEffect(() => {
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
  const isAllIn = stateKey === "allin";

  function markerFor(i) {
    if (i === scene.dealer) return "dealer";
    if (i === scene.sb) return "sb";
    if (i === scene.bb) return "bb";
    return null;
  }

  // visible board derived from phase (yourturn deal sequence)
  let visN, flipFrom;
  if (stateKey === "yourturn") {
    visN = phase === "flop" ? 3 : phase === "turn" || phase === "done" ? 4 : 0;
    flipFrom = phase === "flop" ? 0 : phase === "turn" ? 3 : 99;
  } else { visN = 5; flipFrom = 99; }

  // board element
  let boardEl;
  if (isAllIn) {
    if (rit === "twice") {
      boardEl = (
        <div className="boards">
          <div className="boardrow"><span className="bnum">Board<b>1 / 2</b></span><Board cards={scene.boardTwice1} deckMode={deckMode} /></div>
          <div className="boardrow"><span className="bnum">Board<b>2 / 2</b></span><Board cards={scene.boardTwice2} deckMode={deckMode} /></div>
        </div>
      );
    } else if (rit === "once") {
      boardEl = <Board cards={scene.boardTwice1} deckMode={deckMode} />;
    } else {
      boardEl = <Board cards={scene.board} deckMode={deckMode} />;
    }
  } else {
    boardEl = <Board cards={scene.board.slice(0, visN)} deckMode={deckMode} flipFrom={flipFrom} />;
  }

  // which seats are in the hand (for face-down deal)
  const inHandSeats = PLAYERS.filter(p => !p.hero && !scene.seats[p.id].folded).map(p => p.id);

  const winnerSeat = scene.winnerSeat;
  const showCollect = (stateKey === "win" || stateKey === "lose") && winnerSeat != null && !reduced;
  const winnerPos = winnerSeat === 0 ? { x: 50, y: 74 } : SEAT_POS_6[winnerSeat] || { x: 50, y: 50 };

  return (
    <div className="scaler" id="scaler">
      <div className="app" ref={appRef} data-dir={dir} data-deck={deckMode}
        data-anim={reduced ? "off" : "on"} data-turbo={settings.turbo ? "1" : "0"}
        data-screen-label={"Poker Table · " + scene.label}>
        <TopBar scene={scene} product={product} onProduct={setProduct} balance={142.0}
          onSettings={() => setShowSettings(s => !s)} deckMode={deckMode} />
        {showSettings && <SettingsPanel t={settings} set={(k, v) => { setT(k, v); }} dir={dir} setDir={setDir} onClose={() => setShowSettings(false)} />}

        <div className="mainrow">
          <div className="feltwrap scanlines" ref={feltWrapRef}>
            <canvas className="feltcanvas" ref={feltCanvasRef} />
            <div className="feltglow" />
            <div className="felt">
              <div className="center">
                <span className={"zkbadge" + (phase === "shuffle" ? " shuffling" : "")} data-anno-skip>
                  <span className="chk">{ChromeIcons.shield}</span>
                  {phase === "shuffle" ? "zkShuffle · shuffling…" : "zkShuffle · provably fair ✓"}
                </span>
                {boardEl}
                {isAllIn ? (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                    <Pot pot={scene.pot} sidePots={scene.sidePots} />
                    <div style={{ display: "flex", gap: 10 }}>
                      <span className="equity lead">YOU {scene.equity.hero}%</span>
                      <span className="equity behind">QQ {scene.equity.villain}%</span>
                    </div>
                  </div>
                ) : (
                  <div className={"pot-wrap" + (showCollect ? "" : "")}>
                    <div className={showCollect ? "pot collect-host" : ""}>
                      <Pot pot={showCollect ? 0 : scene.pot} sidePots={scene.sidePots} />
                    </div>
                  </div>
                )}
              </div>

              {(stateKey === "win" || stateKey === "lose") && (
                <WinBanner hand={stateKey === "win" ? scene.handName : scene.loseHand}
                  won={stateKey === "win" ? scene.wonAmount : null} lose={stateKey === "lose"} />
              )}
            </div>
            <div className="feltvignette" />

            {/* pot-collect flying chips */}
            {showCollect && <FlyChips containerRef={feltWrapRef} toX={winnerPos.x} toY={winnerPos.y} />}

            {/* face-down hole cards dealt to in-hand opponents */}
            {stateKey === "yourturn" && (phase === "deal" || phase === "flop" || phase === "turn" || phase === "done") &&
              inHandSeats.map((id, idx) => (
                <HoleBacks key={id} pos={SEAT_POS_6[id]} deal={phase === "deal"} delay={300 + idx * 120} />
              ))}

            {/* seats (non-hero ring) */}
            {PLAYERS.map((p, i) => {
              if (p.hero) return null;
              const d = scene.seats[i];
              const pos = SEAT_POS_6[i];
              const reveal = (d.show && (stateKey === "lose" || stateKey === "allin" || stateKey === "win"))
                ? (scene.villainShow && scene.villainShow.seat === i ? scene.villainShow.cards : null) : null;
              return <Seat key={i} player={p} data={d} pos={pos} active={i === scene.activeSeat}
                marker={markerFor(i)} deckMode={deckMode} revealCards={reveal} revealAnim={!reduced} />;
            })}

            {/* bet chips in front of seats */}
            {PLAYERS.map((p, i) => {
              const d = scene.seats[i];
              if (!d.bet || p.hero) return null;
              const slide = !reduced && (stateKey === "yourturn" ? phase === "done" : true);
              return <BetChips key={i} pos={SEAT_POS_6[i]} amount={d.bet} slide={slide} fromSeat />;
            })}

            {/* hero zone: hole cards + identity */}
            <div className="herozone">
              <div className="hole peek">
                {scene.heroHole.map((c, i) => (
                  <Card key={i} c={c}
                    className={(stateKey === "yourturn" && !reduced && (phase === "deal" || phase === "flop" || phase === "turn" || phase === "done")) ? "deal" : ""}
                    style={(stateKey === "yourturn" && !reduced) ? { "--dy": "-220px", "--dr": (i ? 4 : -2) + "deg", animationDelay: (i * 130) + "ms" } : undefined} />
                ))}
              </div>
              <div className={"heroinfo" + (scene.activeSeat === 0 ? " active" : "")
                + (scene.seats[0].winner ? " winner" : "") + (scene.seats[0].allin ? " allin" : "")}>
                <div className="avatar">Y<span className="ava-grid" /></div>
                <div className="meta">
                  <span className="nm">YOU · you.somi</span>
                  <span className="stack tnum">{scene.seats[0].stack.toFixed(1)}<span className="u">SOMI</span></span>
                </div>
                <div className="hmark">
                  {markerFor(0) && <Marker kind={markerFor(0)} />}
                </div>
                <span className="hstatus">{scene.seats[0].status}</span>
              </div>
            </div>

            {/* run-it-twice prompt */}
            {isAllIn && rit === null && <RunItTwicePrompt onChoose={setRit} />}
            {/* pending tx (win/lose) */}
            {(stateKey === "win" || stateKey === "lose") && <TxToast />}

            {/* annotations */}
            <AnnotationLayer enabled={anno} containerRef={appRef} />

            {/* disconnected overlay */}
            {stateKey === "disconnected" && <DiscOverlay />}
          </div>

          <SideRail />
        </div>

        {/* action bar / status strip */}
        {stateKey === "yourturn" && (
          dealing
            ? <StatusStrip text={phase === "shuffle" ? "Shuffling — zkShuffle in progress" : "Dealing…"} sub="Deck commitment sealed on-chain" accent="var(--accent-soft)" />
            : <ActionBar action={scene.action} deckMode={deckMode} betValue={betValue} setBetValue={setBetValue} onFold={() => {}} />
        )}
        {isAllIn && <StatusStrip text={rit === "twice" ? "Running it twice — dealing two boards" : "All-in — runout in progress"}
          sub={rit === null ? "Choose run-once or run-it-twice above" : "Equity locked · pot held on-chain"} accent="var(--danger-soft)" />}
        {stateKey === "win" && <StatusStrip text="You won the pot" sub="Auto-paid to your escrow balance · next hand in 3s" accent="var(--win)" />}
        {stateKey === "lose" && <StatusStrip text="Hand lost" sub="Better luck next hand · top-up available any time" accent="var(--danger-soft)" />}
        {stateKey === "disconnected" && <StatusStrip text="Connection lost" sub="Your action is protected by the time bank" accent="var(--gold)" />}
      </div>

      <ReviewHUD dir={dir} setDir={setDir} state={stateKey} setState={setStateKey}
        anno={anno} setAnno={setAnno} deck={settings.deck} setDeck={(v) => setT("deck", v)}
        onDeal={replay} dealing={dealing} turbo={settings.turbo} setTurbo={(v) => setT("turbo", v)} />
    </div>
  );
}

/* ---- scale-to-fit stage ---- */
function mountScale() {
  const scaler = document.getElementById("scaler");
  if (!scaler) return;
  const app = scaler.querySelector(".app");
  function fit() {
    const pad = 24;
    const topBand = 60;
    const sw = (window.innerWidth - pad) / 1600;
    const sh = (window.innerHeight - topBand - pad) / 1000;
    const s = Math.min(sw, sh, 1);
    app.style.transform = `scale(${s})`;
    app.style.transformOrigin = "top left";
    app.style.position = "absolute";
    app.style.top = "0";
    app.style.left = "0";
    scaler.style.width = (1600 * s) + "px";
    scaler.style.height = (1000 * s) + "px";
  }
  fit();
  window.addEventListener("resize", fit);
}

ReactDOM.createRoot(document.getElementById("root")).render(<PokerTable />);
setTimeout(mountScale, 60);
