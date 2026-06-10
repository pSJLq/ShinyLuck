/* ShinyPoker — Mobile portrait showcase: Table (all states) + Lobby. */

const { useState: useStateM, useRef: useRefM, useEffect: useEffectM } = React;

const MNI = {
  cards: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="6" width="12" height="15" rx="2"/><path d="M9 3h9a2 2 0 0 1 2 2v12"/></svg>,
  trophy: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M6 4h12v3a6 6 0 0 1-12 0z"/><path d="M9 16h6M8 20h8"/></svg>,
  wallet: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M16 12h3"/></svg>,
  user: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>,
  signal: <svg viewBox="0 0 24 24" fill="currentColor"><rect x="2" y="14" width="3" height="6"/><rect x="7" y="10" width="3" height="10"/><rect x="12" y="6" width="3" height="14"/><rect x="17" y="2" width="3" height="18"/></svg>,
  wifi: <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 18l3-3a4 4 0 0 0-6 0zM5 11a10 10 0 0 1 14 0l-2 2a7 7 0 0 0-10 0z"/></svg>,
  batt: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="2" y="8" width="18" height="10" rx="2"/><rect x="4" y="10" width="13" height="6" rx="1" fill="currentColor"/><path d="M22 11v4"/></svg>,
};

// portrait 6-max seat positions (% of felt wrap). hero handled separately.
const MSEAT_POS = [
  null, // hero
  { x: 15, y: 56 }, { x: 15, y: 28 }, { x: 50, y: 13 }, { x: 85, y: 28 }, { x: 85, y: 56 },
];

function MFlyChips({ wrapRef, toX, toY }) {
  const [vec, setVec] = useStateM(null);
  useEffectM(() => {
    const el = wrapRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    setVec({ dx: (toX - 50) / 100 * r.width, dy: (toY - 33) / 100 * r.height });
  }, []);
  if (!vec) return null;
  return (
    <div className="mflychips">
      {[0,1,2,3,4].map(i => (
        <span key={i} className="mflychip" style={{ left: (Math.cos(i) * 8) + "px", top: (Math.sin(i) * 8) + "px",
          "--ptx": vec.dx + "px", "--pty": vec.dy + "px", animationDelay: (i * 55) + "ms" }} />
      ))}
    </div>
  );
}

function MStatusBar() {
  return (
    <div className="mstatus">
      <span>9:41</span>
      <span className="r">{MNI.signal}{MNI.wifi}{MNI.batt}</span>
    </div>
  );
}

function MTopBar({ product, setProduct, balance }) {
  return (
    <div className="mtop">
      <div className="mlogo"><BraceLogo size={16} /></div>
      <div className="spacer" />
      <div className="mswitch">
        <button className="casino">Luck</button>
        <button className="on">Poker</button>
      </div>
      <div className="mwallet"><span className="somi"><SomiIcon /></span><span className="bal tnum">{balance.toFixed(0)}</span></div>
    </div>
  );
}

/* ---------------- Mobile Table ---------------- */
function MobileTable({ stateKey }) {
  const scene = SCENES[stateKey];
  const feltRef = useRefM(null);
  const wrapRef = useRefM(null);
  const fieldRef = useRefM(null);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  useEffectM(() => {
    if (!feltRef.current) return;
    const f = new GridField(feltRef.current, { cell: 13, gap: 4, speed: 0.55, density: 0.4, accent: "#6E6EED", accent2: "#9B9BF4", maxAlpha: 0.45, minBright: 0.015, shape: "dot" });
    fieldRef.current = f;
    if (!reduced) f.start(); else f._draw(0);
    return () => f.destroy();
  }, []);
  const [bet, setBet] = useStateM(6);
  useEffectM(() => { if (scene.action) setBet(scene.action.minRaise); }, [stateKey]);

  // deal phase engine
  const [phase, setPhase] = useStateM("done");
  const timers = useRefM([]);
  useEffectM(() => {
    timers.current.forEach(clearTimeout); timers.current = [];
    if (reduced) { setPhase("done"); return; }
    if (stateKey === "yourturn") {
      setPhase("shuffle");
      if (fieldRef.current) fieldRef.current.scramble(800);
      let t = 0;
      [[760, "deal"], [560, "flop"], [700, "turn"], [560, "done"]].forEach(([ms, ph]) => { t += ms; timers.current.push(setTimeout(() => setPhase(ph), t)); });
    } else {
      setPhase("done");
      if (fieldRef.current && (stateKey === "win" || stateKey === "lose")) fieldRef.current.flash();
    }
    return () => timers.current.forEach(clearTimeout);
  }, [stateKey]);

  const isAllIn = stateKey === "allin";
  const deckMode = "4";
  function markerFor(i) { return i === scene.dealer ? "dealer" : i === scene.sb ? "sb" : i === scene.bb ? "bb" : null; }
  const dealing = stateKey === "yourturn" && phase !== "done";

  // visible board
  let visN, flipFrom;
  if (stateKey === "yourturn") {
    visN = phase === "flop" ? 3 : phase === "turn" || phase === "done" ? 4 : 0;
    flipFrom = phase === "flop" ? 0 : phase === "turn" ? 3 : 99;
  } else { visN = 5; flipFrom = 99; }
  const board = (isAllIn ? scene.board : scene.board).slice(0, visN);

  // pot collect
  const winnerSeat = scene.winnerSeat;
  const showCollect = (stateKey === "win" || stateKey === "lose") && winnerSeat != null && !reduced;
  const winnerPos = winnerSeat === 0 ? { x: 50, y: 70 } : MSEAT_POS[winnerSeat] || { x: 50, y: 50 };
  const dealStart = stateKey === "yourturn" && (phase === "deal" || phase === "flop" || phase === "turn" || phase === "done") && !reduced;

  return (
    <div className="screen" data-deck={deckMode} data-anim={reduced ? "off" : "on"} ref={wrapRef}>
      <div className="notch" />
      <MStatusBar />
      <MTopBar product="poker" setProduct={() => {}} balance={142} />

      <div className="mfeltwrap">
        <canvas className="mfelt" ref={feltRef} />
        <div className="mblinds">
          <span className="mb">NLHE <b>6-max</b></span>
          <span className="mb">Blinds <b>0.5/1</b></span>
          <span className="mb">#<b>{scene.hand}</b></span>
        </div>
        <div className="moval prem" />
        <div className="mfeltglow" />

        <div className="mcenter">
          <span className="zkbadge"><span className="chk">{ChromeIcons.shield}</span>{phase === "shuffle" ? "shuffling…" : "zkShuffle ✓"}</span>
          <div className="mboard">
            {[0,1,2,3,4].map(i => board[i]
              ? <Card key={i} c={board[i]} className={i >= flipFrom ? "flip" : ""} style={i >= flipFrom ? { animationDelay: ((i - flipFrom) * 70) + "ms" } : undefined} />
              : <div key={i} className="slot empty" />)}
          </div>
          {isAllIn ? (
            <React.Fragment>
              <div className="mpot tnum">{scene.pot.toFixed(0)}<span className="u">SOMI</span></div>
              <div className="mequity"><span className="lead">YOU {scene.equity.hero}%</span><span className="behind">QQ {scene.equity.villain}%</span></div>
            </React.Fragment>
          ) : <div className="mpot tnum">{showCollect ? "0" : scene.pot.toFixed(scene.pot % 1 ? 1 : 0)}<span className="u">SOMI</span></div>}
        </div>

        {showCollect && <MFlyChips wrapRef={wrapRef} toX={winnerPos.x} toY={winnerPos.y} />}

        {(stateKey === "win" || stateKey === "lose") && (
          <div className={"mbanner " + (stateKey === "win" ? "win" : "lose")}>
            <div className="won">{stateKey === "win" ? "You win" : "You lose"}</div>
            <div className="hand">{stateKey === "win" ? scene.handName : scene.loseHand}</div>
          </div>
        )}

        {/* opponents */}
        {PLAYERS.map((p, i) => {
          if (p.hero) return null;
          const d = scene.seats[i]; const pos = MSEAT_POS[i];
          const reveal = d.show && scene.villainShow && scene.villainShow.seat === i ? scene.villainShow.cards : null;
          const inHand = !d.folded;
          const cls = ["mseat"];
          if (i === scene.activeSeat) cls.push("active");
          if (d.folded) cls.push("folded");
          if (d.allin) cls.push("allin");
          if (d.winner) cls.push("winner");
          return (
            <div key={i} className={cls.join(" ")} style={{ left: pos.x + "%", top: pos.y + "%" }}>
              {reveal
                ? <div className="mvcards">{reveal.map((c, j) => <Card key={j} c={c} className={!reduced ? "reveal" : ""} style={!reduced ? { animationDelay: (j * 120) + "ms" } : undefined} />)}</div>
                : (stateKey === "yourturn" && inHand && (phase === "deal" || phase === "flop" || phase === "turn" || phase === "done")) ?
                  <div className="mvcards">{[0,1].map(j => <Card key={j} back className={phase === "deal" && !reduced ? "deal" : ""} style={phase === "deal" && !reduced ? { "--dr": (j ? 5 : -5) + "deg", animationDelay: (300 + j * 70) + "ms" } : undefined} />)}</div>
                  : null}
              <div className="mscard">
                <div className="mav">{p.av}</div>
                <div className="mi">
                  <div className="mn">{(d.name || p.name).split(".")[0]}</div>
                  <div className="mst tnum">{d.stack.toFixed(0)}</div>
                  <div className="mstat">{d.status}</div>
                </div>
                {markerFor(i) && <span className={"mbtn " + markerFor(i)}>{markerFor(i) === "dealer" ? "D" : markerFor(i) === "sb" ? "S" : "B"}</span>}
              </div>
              {d.bet ? <span className="mbet tnum">{d.bet.toFixed(d.bet % 1 ? 1 : 0)}</span> : null}
            </div>
          );
        })}

        {/* hero */}
        <div className="mhero">
          <div className="mhole">
            {scene.heroHole.map((c, i) => (
              <Card key={i} c={c} className={dealStart ? "deal" : ""}
                style={dealStart ? { "--dr": (i ? 3 : -3) + "deg", "--dx": "0px", animationDelay: (i * 110) + "ms" } : undefined} />
            ))}
          </div>
          <div className={"mheroinfo" + (scene.activeSeat === 0 ? " active" : "") + (scene.seats[0].winner ? " winner" : "")}>
            <div className="mav" style={{ width: 26, height: 26 }}>Y</div>
            <div><div className="mn">YOU</div><div className="mst tnum">{scene.seats[0].stack.toFixed(0)} SOMI</div></div>
            {markerFor(0) && <span className={"mbtn " + markerFor(0)} style={{ position: "static" }}>{markerFor(0) === "dealer" ? "D" : markerFor(0) === "sb" ? "S" : "B"}</span>}
            <span className="mstat">{scene.seats[0].status}</span>
          </div>
        </div>

        <div className="mvignette" />
        {stateKey === "disconnected" && (
          <div className="mdisc"><div className="dc">
            <div className="spin" />
            <div className="t">Reconnecting…</div>
            <div className="s">Re-subscribing to the table's live event stream.</div>
            <div className="note">🔒 Hand &amp; chips safe on-chain · time-bank protects you</div>
          </div></div>
        )}
      </div>

      {/* action / status */}
      {stateKey === "yourturn" ? (
        dealing ? (
          <div className="mstrip"><div className="mt" style={{ color: "var(--accent-soft)" }}>{phase === "shuffle" ? "Shuffling…" : "Dealing…"}</div><div className="ms">Deck commitment sealed on-chain</div></div>
        ) : (
        <div className="maction">
          <div className="mhelpers">
            <div className="hc best">Best<b>Pair of Kings</b></div>
            <div className="hc">Pot odds<b>13%</b></div>
            <div className="hc">Outs<b>8</b></div>
          </div>
          <div className="mquick">
            {[["½", 11.75], ["⅔", 16], ["Pot", 22.5], ["All-in", 142]].map(([k, v]) => (
              <button key={k} onClick={() => setBet(v)}>{k}</button>
            ))}
          </div>
          <div className="msliderrow" style={{ "--f": ((bet - 6) / (142 - 6) * 100) + "%" }}>
            <input type="range" min="6" max="142" step="0.5" value={bet} onChange={e => setBet(parseFloat(e.target.value))} />
            <span className="mval tnum">{bet.toFixed(bet % 1 ? 1 : 0)}</span>
          </div>
          <div className="mbtns">
            <button className="fold"><span className="l">Fold</span></button>
            <button className="call"><span className="l">Call</span><span className="a tnum">3.0</span></button>
            <button className="raise"><span className="l">Raise</span><span className="a tnum">{bet.toFixed(bet % 1 ? 1 : 0)}</span></button>
          </div>
        </div>
        )
      ) : (
        <div className="mstrip">
          <div className="mt" style={{ color: stateKey === "win" ? "var(--win)" : stateKey === "allin" ? "var(--danger-soft)" : stateKey === "disconnected" ? "var(--gold)" : "var(--muted)" }}>
            {stateKey === "allin" ? "All-in · runout" : stateKey === "win" ? "You won the pot" : stateKey === "lose" ? "Hand lost" : "Connection lost"}
          </div>
          <div className="ms">
            {stateKey === "allin" ? "Equity locked · pot held on-chain" : stateKey === "win" ? "Auto-paid to escrow · next hand 3s" : stateKey === "lose" ? "Top-up available any time" : "Your action is protected by the time bank"}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Mobile Lobby ---------------- */
const MCASH = [
  { blinds: [0.5, 1], size: 6, seated: 5, avg: 18.4, ppf: 62, rake: 0.2 },
  { blinds: [1, 2], size: 6, seated: 6, avg: 41.2, ppf: 48, rake: 0.4 },
  { blinds: [0.25, 0.5], size: 9, seated: 7, avg: 9.1, ppf: 55, rake: 0.1 },
  { blinds: [2, 5], size: 6, seated: 4, avg: 88.0, ppf: 41, rake: 0.5 },
  { blinds: [5, 10], size: 2, seated: 2, avg: 210.0, ppf: 70, rake: 0.5 },
];
const MTRN = [
  { name: "Somnia Sunday Major", buyin: 20, pool: 50000, reg: 478, status: "Late Reg" },
  { name: "Hyper Turbo Bounty KO", buyin: 10, pool: 11400, reg: 212, status: "Running" },
  { name: "Whale Room High Roller", buyin: 500, pool: 142500, reg: 38, status: "Registering" },
];

function MobileLobby({ tab, setTab }) {
  return (
    <div className="screen">
      <div className="notch" />
      <MStatusBar />
      <MTopBar product="poker" setProduct={() => {}} balance={142} />
      <div className="mlobby">
        <div className="mstatstrip">
          <div className="si"><div className="k">Online</div><div className="v acc tnum">12,480</div></div>
          <div className="si"><div className="k">Tables</div><div className="v tnum">342</div></div>
          <div className="si"><div className="k">Top pot</div><div className="v tnum">2,840</div></div>
          <div className="si"><div className="k">Next major</div><div className="v tnum">1h12</div></div>
        </div>
        <div className="mtabs">
          {[["cash", "Cash"], ["trn", "Tourneys"], ["sng", "Sit & Go"], ["clubs", "Clubs"]].map(([k, l]) => (
            <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        <div className="mlist">
          {tab === "cash" && MCASH.map((r, i) => {
            const full = r.seated >= r.size;
            return (
              <div key={i} className="mrow">
                <div className="ml">
                  <div className="mlb tnum">{r.blinds[0]} / {r.blinds[1]}<span className="u">SOMI</span></div>
                  <div className="mlm">NLHE · {r.size === 2 ? "heads-up" : r.size + "-max"} · avg pot {r.avg.toFixed(0)}</div>
                  <div className="mlrake">rake <b>{r.rake}</b> capped · no flop no drop</div>
                  <div className="mseatdots">{Array.from({ length: Math.min(r.size, 9) }).map((_, j) => <span key={j} className={"d" + (j < r.seated ? " on" : "")} />)}</div>
                </div>
                <button className={"mjoin" + (full ? " full" : "")}>{full ? "Wait" : "Join"}</button>
              </div>
            );
          })}
          {tab === "trn" && MTRN.map((t, i) => (
            <div key={i} className="mrow">
              <div className="ml">
                <div className="mlb" style={{ fontSize: 13, fontFamily: "var(--label)" }}>{t.name}</div>
                <div className="mlm">buy-in {t.buyin} SOMI · {t.reg} entered · {t.status}</div>
                <div className="msecure">✓ {t.pool.toLocaleString()} SOMI secured on-chain</div>
              </div>
              <button className="mjoin">Register</button>
            </div>
          ))}
          {tab === "sng" && (
            <React.Fragment>
              <div className="mrow"><div className="ml"><div className="mlb" style={{ fontSize: 13, fontFamily: "var(--label)" }}>Spin SNG · 3-max</div><div className="mlm">buy-in 5 SOMI · random multiplier</div><div className="msecure">up to 1,000× · prize on-chain</div></div><button className="mjoin">Spin</button></div>
              <div className="mrow"><div className="ml"><div className="mlb" style={{ fontSize: 13, fontFamily: "var(--label)" }}>Hyper Turbo · 6-max</div><div className="mlm">buy-in 10 SOMI · 5/6 seated</div></div><button className="mjoin">Register</button></div>
            </React.Fragment>
          )}
          {tab === "clubs" && (
            <React.Fragment>
              <div className="mrow"><div className="ml"><div className="mlb" style={{ fontSize: 13, fontFamily: "var(--label)" }}>Whale Room</div><div className="mlm">Private · 248 members · 6 tables</div></div><button className="mjoin">Open</button></div>
              <div className="mrow"><div className="ml"><div className="mlb" style={{ fontSize: 13, fontFamily: "var(--label)" }}>Degens Anonymous</div><div className="mlm">Public · 1,402 members</div></div><button className="mjoin">Join</button></div>
            </React.Fragment>
          )}
        </div>
        <div className="mnav">
          <a className="on">{MNI.cards}Play</a>
          <a>{MNI.trophy}Tourneys</a>
          <a>{MNI.wallet}Cashier</a>
          <a>{MNI.user}Profile</a>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Showcase shell ---------------- */
function MobileShowcase() {
  const [view, setView] = useStateM("table");
  const [tState, setTState] = useStateM("yourturn");
  const [lTab, setLTab] = useStateM("cash");
  return (
    <React.Fragment>
      <div className="phone-pick">
        <button className={view === "table" ? "on" : ""} onClick={() => setView("table")}>Table</button>
        <button className={view === "lobby" ? "on" : ""} onClick={() => setView("lobby")}>Lobby</button>
      </div>
      <div className="phone">
        {view === "table" ? <MobileTable stateKey={tState} /> : <MobileLobby tab={lTab} setTab={setLTab} />}
      </div>
      {view === "table" && (
        <div className="state-pick">
          {STATE_ORDER.map(s => {
            const lbl = { yourturn: "Turn", allin: "All-in", win: "Win", lose: "Lose", disconnected: "Disc." }[s];
            return <button key={s} className={tState === s ? "on" : ""} onClick={() => setTState(s)}>{lbl}</button>;
          })}
        </div>
      )}
    </React.Fragment>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<MobileShowcase />);
