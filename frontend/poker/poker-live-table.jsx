/* ShinyPoker — LIVE table. Reuses the design's visual components (Card, Seat,
   Board, Pot, grid felt) but every value is read from the on-chain snapshot via
   window.SP (poker-bridge.js). No hardcoded SCENES. */
const { useState, useEffect, useRef } = React;

// Seat ring positions per table size (index 0 = bottom = hero), % of the felt.
const POS = {
  2: [{ x: 50, y: 84 }, { x: 50, y: 10 }],
  6: [{ x: 50, y: 83 }, { x: 15, y: 65 }, { x: 15, y: 27 }, { x: 50, y: 12 }, { x: 85, y: 27 }, { x: 85, y: 65 }],
  9: [{ x: 50, y: 87 }, { x: 18, y: 80 }, { x: 6, y: 52 }, { x: 14, y: 22 }, { x: 38, y: 8 }, { x: 62, y: 8 }, { x: 86, y: 22 }, { x: 94, y: 52 }, { x: 82, y: 80 }],
};

const short = (a) => (a && a !== "0x0000000000000000000000000000000000000000" ? a.slice(0, 6) + "…" + a.slice(-4) : "");
const N = (wei) => Number(SP.fmt(wei, 6));
// Tournament tables play in plain CHIP units (1500 chips, blinds 10/20), not
// wei — NV switches the whole table's value formatting per mode.
let CHIPS = false;
const NV = (v) => (CHIPS ? Number(v) : Number(SP.fmt(v, 6)));
const A = SP.ACTION, ST = SP.STREET;

// pot-collect: chips fly from the center to the winning seat
function FlyChips({ wrapRef, toX, toY }) {
  const [vec, setVec] = useState(null);
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    setVec({ dx: ((toX - 50) / 100) * r.width, dy: ((toY - 43) / 100) * r.height });
  }, []);
  if (!vec) return null;
  return (
    <div className="flychips">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <span key={i} className="flychip" style={{ left: Math.cos(i) * 10 + "px", top: Math.sin(i) * 10 + "px", "--ptx": vec.dx + "px", "--pty": vec.dy + "px", animationDelay: i * 50 + "ms" }} />
      ))}
    </div>
  );
}

function LiveTable() {
  const [snap, setSnap] = useState(null);
  const [connected, setConnected] = useState(false);
  const [addr, setAddr] = useState(null);
  const [bal, setBal] = useState(0);
  const [holes, setHoles] = useState({}); // dealId -> [strA,strB]
  const [theme, setTheme] = useState(() => localStorage.getItem("sp_theme") || "b");
  const [deck, setDeck] = useState("4");
  const [showSettings, setShowSettings] = useState(false);
  const [betValue, setBetValue] = useState(0);
  const [modal, setModal] = useState(null); // {type, seat}
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sessionOn, setSessionOn] = useState(false);
  const [anim, setAnim] = useState({ dealing: false, flipFrom: 99, winnerSeat: -1, won: 0 });
  const [nowMs, setNowMs] = useState(Date.now());
  const [reveals, setReveals] = useState({}); // dealId -> { seat: [c0,c1] }
  const [trn, setTrn] = useState(null); // tournament info+clock when this table is controlled
  const [heroDealing, setHeroDealing] = useState(false);
  const heroDealRef = useRef(null);
  const fetchingRef = useRef(false);
  const sigCacheRef = useRef({}); // dealId -> hole-card signature (sign once per hand)
  const prevRef = useRef({ handId: 0, boardLen: 0, inProgress: false, stacks: {} });
  const dealTimerRef = useRef(null);
  const winTimerRef = useRef(null);
  const feltWrapRef = useRef(null);
  const reducedMo = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  const tableId = SP.tableId;
  const canvasRef = useRef(null);
  const fieldRef = useRef(null);

  useEffect(() => { localStorage.setItem("sp_theme", theme); }, [theme]);

  // live snapshot poll
  useEffect(() => SP.sdk.watch(tableId, setSnap, 1500), []);

  // auto-restore an existing email (Privy) session — now and whenever Privy boots
  useEffect(() => {
    const restore = () => SP.sdk.tryRestorePrivy().then((a) => { if (a) { setAddr(a); setConnected(true); refreshBal(); } }).catch(() => {});
    restore();
    const on = (ev) => { if (ev.detail && ev.detail.authenticated && ev.detail.address) restore(); };
    document.addEventListener("shinyluck:auth-state", on);
    return () => document.removeEventListener("shinyluck:auth-state", on);
  }, []);

  // wallet balance refresh
  async function refreshBal() {
    if (!SP.sdk.address) return;
    try { setBal(N(await SP.sdk.balanceOf(SP.sdk.address))); } catch {}
  }
  useEffect(() => { if (connected) { refreshBal(); const id = setInterval(refreshBal, 4000); return () => clearInterval(id); } }, [connected]);

  // LED grid background on the felt canvas (design motion engine)
  useEffect(() => {
    if (!canvasRef.current || !window.GridField) return;
    if (fieldRef.current) fieldRef.current.destroy();
    const cfg = {
      a: { cell: 15, gap: 4, speed: 0.7, density: 0.5, accent: "#6E6EED", maxAlpha: 0.55, minBright: 0.02, shape: "square" },
      b: { cell: 17, gap: 6, speed: 0.55, density: 0.42, accent: "#6E6EED", accent2: "#9B9BF4", maxAlpha: 0.5, minBright: 0.015, shape: "dot" },
      c: { cell: 13, gap: 3, speed: 0.6, density: 0.45, accent: "#6E6EED", maxAlpha: 0.42, minBright: 0.02, shape: "square" },
    }[theme];
    const f = new GridField(canvasRef.current, cfg);
    fieldRef.current = f; f.start();
    // GridField sizes its buffer at construction, before the scaler finishes
    // layout — re-measure a couple of times so the felt grid fills the oval.
    const r1 = setTimeout(() => f._resize(), 160);
    const r2 = setTimeout(() => f._resize(), 650);
    return () => { clearTimeout(r1); clearTimeout(r2); f.destroy(); };
    // Re-run once the first snapshot arrives — until then the felt canvas isn't
    // mounted (loading state), so the grid had nothing to attach to.
  }, [theme, snap ? 1 : 0]);

  // fetch my hole cards once per deal
  useEffect(() => {
    if (!snap || !connected) return;
    const h = snap.hand;
    if (!h.inProgress || snap.mySeat < 0) return;
    const me = snap.seats[snap.mySeat];
    if (!me.inHand) return;
    const key = String(h.dealId);
    if (holes[key] || fetchingRef.current) return;
    fetchingRef.current = true;
    (async () => {
      try {
        // Sign once per hand; reuse the signature on retries while the dealer
        // finishes locking entropy — so only ONE wallet popup per hand.
        if (!sigCacheRef.current[key]) sigCacheRef.current[key] = await SP.sdk.signHoles(tableId, h.dealId);
        const r = await SP.sdk.myHoleCards(tableId, h.dealId, sigCacheRef.current[key]);
        setHoles((m) => ({ ...m, [key]: r }));
        setHeroDealing(true);
        clearTimeout(heroDealRef.current);
        heroDealRef.current = setTimeout(() => setHeroDealing(false), 1100);
      } catch (e) {
        console.warn("hole:", e.message); // not ready yet — retry next snapshot, no re-sign
      } finally {
        fetchingRef.current = false;
      }
    })();
  }, [snap, connected]);

  // keep the session indicator in sync (Privy = always popup-free; injected = once a session is granted)
  useEffect(() => { setSessionOn(SP.sdk.popupFree()); }, [snap, connected]);

  // 1s tick so countdown timers update smoothly
  useEffect(() => { const id = setInterval(() => setNowMs(Date.now()), 1000); return () => clearInterval(id); }, []);

  // tournament HUD: if this table is controlled by a tournament, poll its state
  useEffect(() => {
    if (!SP.sdk.hasTournaments()) return;
    let stop = false;
    async function poll() {
      try {
        const t = await SP.sdk.tournamentOfTable(tableId);
        if (stop) return;
        if (!t) { setTrn(null); return; }
        const c = await SP.sdk.tournamentClock(t.id);
        if (!stop) setTrn({ ...t, ...c });
      } catch {}
    }
    poll();
    const iv = setInterval(poll, 5000);
    return () => { stop = true; clearInterval(iv); };
  }, []);

  // detect hand transitions → deal scramble, board flip, winner glow + pot collect
  useEffect(() => {
    if (!snap) return;
    const prev = prevRef.current;
    const h = snap.hand;
    const boardLen = snap.board.length;
    if (h.inProgress && h.handId !== prev.handId && h.handId > 0) {
      if (fieldRef.current && !reducedMo) fieldRef.current.scramble(900);
      setAnim((a) => ({ ...a, dealing: !reducedMo, flipFrom: 99, winnerSeat: -1 }));
      clearTimeout(dealTimerRef.current);
      dealTimerRef.current = setTimeout(() => setAnim((a) => ({ ...a, dealing: false })), 1300);
    }
    if (boardLen > prev.boardLen) setAnim((a) => ({ ...a, flipFrom: prev.boardLen }));
    if (!h.inProgress && prev.inProgress) {
      let winner = -1, best = 0n;
      for (const s of snap.seats) { const d = s.stack - (prev.stacks[s.index] || 0n); if (d > best) { best = d; winner = s.index; } }
      if (fieldRef.current) fieldRef.current.flash();
      if (winner >= 0 && !reducedMo) {
        setAnim((a) => ({ ...a, winnerSeat: winner, won: NV(best) }));
        clearTimeout(winTimerRef.current);
        winTimerRef.current = setTimeout(() => setAnim((a) => ({ ...a, winnerSeat: -1 })), 2600);
      }
    }
    const stacks = {}; snap.seats.forEach((s) => { stacks[s.index] = s.stack; });
    prevRef.current = { handId: h.handId, boardLen, inProgress: h.inProgress, stacks };
  }, [snap]);

  // at showdown, fetch opponents' revealed hole cards (public once the seed is revealed)
  useEffect(() => {
    if (!snap || !SP.sdk.dealerRead) return;
    const h = snap.hand;
    if (!h.inProgress || h.street !== ST.SHOWDOWN) return;
    const key = String(h.dealId);
    if (reveals[key]) return;
    (async () => {
      try {
        if (!(await SP.sdk.dealerRead.isShowdownReady(h.dealId))) return;
        const out = {};
        for (const s of snap.seats) { if (!s.empty && s.inHand) out[s.index] = await SP.sdk.revealedHole(h.dealId, s.index); }
        setReveals((m) => ({ ...m, [key]: out }));
      } catch {}
    })();
  }, [snap]);

  function flash(msg, ms = 3000) { setToast(msg); setTimeout(() => setToast(null), ms); }
  async function tx(label, fn) {
    setBusy(true);
    try { await fn(); flash(label + " ✓"); await refreshBal(); }
    catch (e) { flash(label + " ✗ " + (e?.shortMessage || e?.reason || e?.message || "").replace(/execution reverted:?/i, "").slice(0, 80), 5000); console.error(e); }
    finally { setBusy(false); }
  }

  async function connect() {
    try {
      const a = await SP.sdk.connect(); setAddr(a); setConnected(true); refreshBal(); flash("Connected ✓");
      // brand-new email wallets start empty — guide funding so they can play
      try { if ((await SP.sdk.walletBalance()) < SP.parseEther("0.02")) setModal({ type: "fund" }); } catch {}
    }
    catch (e) { if (e && e.message !== "cancelled") flash(e.message || "connect failed", 5000); }
  }
  const act = (action, amount = 0) => tx(["Fold", "Check", "Call", "Bet", "Raise", "All-in"][action], () => SP.sdk.act(tableId, action, amount, !!trn));

  if (!snap) return <div className="center-load">Loading table…</div>;

  const { cfg, hand, seats, mySeat } = snap;
  const maxSeats = cfg.maxSeats;
  const board = snap.board.map(SP.intToCardStr);
  const dealKey = String(hand.dealId);
  const myHoleObj = hand.inProgress ? holes[dealKey] : null;
  const myHole = myHoleObj ? myHoleObj.cardsStr : null;
  const bestHand = myHoleObj ? SP.handName(myHoleObj.cards.concat(snap.board)) : "";
  // rotate so my seat sits at the bottom
  CHIPS = !!trn; // tournament table → format values as chips, not wei
  const positions = POS[maxSeats] || (maxSeats < 6 ? POS[6] : POS[9]);
  const view = (i) => (mySeat >= 0 ? (i - mySeat + maxSeats) % maxSeats : i % maxSeats);
  const seatPos = (i) => positions[view(i)] || positions[0];
  const now = Math.floor(nowMs / 1000);
  const showdown = hand.inProgress && hand.street === ST.SHOWDOWN;

  return (
    <div className="scaler" id="scaler">
      <div className="app" data-dir={theme} data-deck={deck} data-anim={reducedMo ? "off" : "on"} data-turbo="0">
        {/* top bar */}
        <header className="topbar">
          <div className="group">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }} title="Back to lobby" onClick={() => (location.href = "lobby.html")}>
              <BraceLogo size={22} />
              <span className="wordmark" style={{ fontSize: 17 }}>shiny<span className="accent">poker</span></span>
            </span>
          </div>
          <div className="switcher">
            <button onClick={() => (location.href = SP.POKER_CONFIG.casinoUrl)}><span className="dot" />ShinyLuck</button>
            <button className="on"><span className="dot" />Poker</button>
          </div>
          <div className="sep" />
          <div className="group">
            <span className="metapill"><span className="k">NLHE</span><b>{maxSeats}-MAX</b></span>
            <span className="metapill"><span className="k">Blinds</span><b>{NV(cfg.smallBlind)} / {NV(cfg.bigBlind)}</b></span>
            <span className="metapill"><span className="k">Hand</span><b>#{hand.handId}</b></span>
          </div>
          <div className="spacer" />
          {connected ? (
            <>
              <button className="metapill" style={{ cursor: "pointer" }} onClick={() => setModal({ type: "cashier" })}>
                <span className="k">Cashier</span><b>{bal.toFixed(2)}</b>
              </button>
              {mySeat >= 0 && sessionOn && (
                <div className="session" title="Table session active — acting without a wallet popup">
                  <span className="pulse" /><span className="lock">{ChromeIcons.lock}</span><span>session</span>
                </div>
              )}
              <div className="wallet"><SomiIcon className="somi" /><span className="bal tnum">{bal.toFixed(1)}</span><span className="net">{short(addr)}</span></div>
            </>
          ) : (
            <button className="metapill" style={{ cursor: "pointer", color: "var(--accent-soft)", borderColor: "var(--accent-32)", background: "var(--accent-12)" }} onClick={connect}>Connect Wallet</button>
          )}
          {connected && mySeat >= 0 && (
            <button className="iconbtn" title={seats[mySeat].sittingOut ? "Sit in" : "Sit out"} disabled={busy}
              onClick={() => tx(seats[mySeat].sittingOut ? "Sit in" : "Sit out", () => SP.sdk.sitOut(tableId, !seats[mySeat].sittingOut))}>{ChromeIcons.pause}</button>
          )}
          <button className="iconbtn" title="Settings" onClick={() => setShowSettings((s) => !s)}>{ChromeIcons.gear}</button>
          {connected && mySeat >= 0 && (
            <button className="iconbtn leavebtn" title="Leave table" disabled={busy}
              onClick={() => tx("Leave", () => SP.sdk.leave(tableId))}>{ChromeIcons.leave}</button>
          )}
        </header>

        {showSettings && (
          <SettingsPanel t={{ sound: true, deck, automuck: true, turbo: false, reduced: false, autoblind: true }}
            set={(k, v) => { if (k === "deck") setDeck(v); }} dir={theme} setDir={setTheme} onClose={() => setShowSettings(false)}
            session={{
              active: sessionOn, busy,
              label: SP.sdk.backend === "privy" ? "Email wallet · headless (no popups)" : null,
              cap: mySeat >= 0 ? NV(seats[mySeat].stack).toFixed(CHIPS ? 0 : 2) + " " + (CHIPS ? "chips" : SP.NETWORK.currency.symbol) : null,
              onActivate: SP.sdk.backend === "injected" ? () => tx("Activate session", () => SP.sdk.activateSession()).then(() => setSessionOn(true)) : null,
              onRevoke: SP.sdk.backend === "privy"
                ? () => { SP.sdk.signOut().finally(() => location.reload()); }
                : () => tx("Revoke session", () => SP.sdk.revokeSession()).then(() => setSessionOn(false)),
            }} />
        )}

        {trn && (() => {
          const mult = 1 << trn.level;
          const lsb = Number(trn.sbStart) * mult, lbb = Number(trn.bbStart) * mult;
          const nextIn = Math.max(0, trn.startedAt + (trn.level + 1) * trn.levelDur - now);
          const mm = Math.floor(nextIn / 60), ss = String(nextIn % 60).padStart(2, "0");
          return (
            <div className="trn-hud">
              <span className="tag">TOURNAMENT · SNG #{trn.id}</span>
              <span>Level <b className="tnum">{trn.level + 1}</b></span>
              <span>Blinds <b className="tnum">{lsb} / {lbb}</b></span>
              {trn.status === 1 && <span>Next level <b className="tnum">{mm}:{ss}</b></span>}
              <span>Players <b className="tnum">{trn.remaining}/{trn.registered}</b></span>
              <span>Prize <b className="tnum">{Number(SP.fmt(trn.pool, 4))} {SP.NETWORK.currency.symbol}</b></span>
              <span>Split <b className="tnum">{trn.payoutBps.map((b) => b / 100 + "%").join(" / ")}</b></span>
              {trn.status === 2 && <span className="done">FINISHED</span>}
            </div>
          );
        })()}

        <div className="mainrow">
          <div className="feltwrap scanlines" ref={feltWrapRef}>
            <canvas className="feltcanvas" ref={canvasRef} />
            <div className="feltglow" />
            <div className="felt">
              <div className="center">
                <span className={"zkbadge" + (anim.dealing ? " shuffling" : "")}><span className="chk">{ChromeIcons.shield}</span>{anim.dealing ? "shuffling · zkShuffle…" : "provably fair · commit-reveal ✓"}</span>
                <Board cards={board} deckMode={deck} flipFrom={anim.flipFrom} />
                {hand.inProgress
                  ? <Pot pot={NV(hand.pot)} chips={CHIPS} />
                  : <div className="pot"><div className="potmain"><span className="k">Waiting for players</span></div></div>}
              </div>
              {anim.winnerSeat >= 0 && (
                <WinBanner won={mySeat === anim.winnerSeat ? anim.won : null} lose={mySeat >= 0 && mySeat !== anim.winnerSeat}
                  hand={reveals[dealKey] && reveals[dealKey][anim.winnerSeat] ? SP.handName(reveals[dealKey][anim.winnerSeat].concat(snap.board)) : "Winning hand"} />
              )}
            </div>
            <div className="feltvignette" />

            {/* opponents' face-down cards while in hand (flipped up at showdown) */}
            {hand.inProgress && !showdown && seats.map((s) => (
              !s.empty && s.index !== mySeat && s.inHand
                ? <HoleBacks key={"b" + s.index} pos={seatPos(s.index)} deal={anim.dealing} delay={300 + s.index * 120} />
                : null
            ))}

            {/* seats */}
            {seats.map((s) => {
              if (s.index === mySeat) return null; // hero is shown in the herozone
              const pos = seatPos(s.index);
              if (s.empty) {
                if (trn) return null; // tournament seats are managed by the tournament
                return (
                  <div key={s.index} className="seat" style={{ left: pos.x + "%", top: pos.y + "%" }}>
                    <button className="emptyseat" onClick={() => connected ? setModal({ type: "sit", seat: s.index }) : connect()}>
                      <span className="plus">+</span><span>{connected ? "Sit" : "Connect"}</span>
                    </button>
                  </div>
                );
              }
              const isMe = s.index === mySeat;
              const active = hand.inProgress && hand.actingSeat === s.index && hand.street <= ST.RIVER;
              const rev = showdown && reveals[dealKey] && reveals[dealKey][s.index] ? reveals[dealKey][s.index].map(SP.intToCardStr) : null;
              return (
                <Seat key={s.index}
                  player={{ hero: isMe, name: short(s.player), av: (s.player ? s.player.slice(2, 3).toUpperCase() : "P") }}
                  data={{
                    stack: NV(s.stack),
                    ...(CHIPS ? { chips: NV(s.stack), bb: Math.max(0, Math.round(NV(s.stack) / Math.max(1, NV(cfg.bigBlind)))) } : {}),
                    status: s.allIn ? "all-in" : s.folded ? "folded" : s.sittingOut ? "sitting out" : (hand.inProgress && s.inHand ? "" : "waiting"),
                    folded: s.folded, allin: s.allIn, winner: s.index === anim.winnerSeat,
                    timer: Number(cfg.actionTimeout),
                  }}
                  pos={pos} active={active} marker={s.index === hand.button && hand.inProgress ? "dealer" : null} deckMode={deck}
                  revealCards={rev} revealAnim={!reducedMo} />
              );
            })}

            {/* bet chips in front of seats */}
            {hand.inProgress && seats.map((s) => (
              !s.empty && s.committedStreet > 0n
                ? <BetChips key={"c" + s.index} pos={seatPos(s.index)} amount={NV(s.committedStreet)} chips={CHIPS} slide={!reducedMo} fromSeat />
                : null
            ))}

            {/* hero zone: hole cards + identity (design herozone) */}
            {mySeat >= 0 && (
              <div className="herozone">
                {hand.inProgress && seats[mySeat].inHand && (
                  <div className="hole peek">
                    {myHole
                      ? myHole.map((c, i) => <Card key={dealKey + i} c={c} className={heroDealing ? "deal" : ""} style={heroDealing ? { "--dy": "-220px", "--dr": (i ? 4 : -2) + "deg", animationDelay: i * 130 + "ms" } : undefined} />)
                      : [<Card key="0" back />, <Card key="1" back />]}
                  </div>
                )}
                {myHole && bestHand && <div className="herocombo">{bestHand}</div>}
                <div className={"heroinfo" + (hand.inProgress && hand.actingSeat === mySeat ? " active" : "") + (seats[mySeat].allIn ? " allin" : "") + (seats[mySeat].folded ? " folded" : "") + (mySeat === anim.winnerSeat ? " winner" : "")}>
                  <div className="avatar">{addr ? addr.slice(2, 3).toUpperCase() : "Y"}<span className="ava-grid" /></div>
                  <div className="meta">
                    <span className="nm">YOU · {short(addr)}</span>
                    <span className="stack tnum">{NV(seats[mySeat].stack).toFixed(CHIPS ? 0 : 2)}<span className="u">{CHIPS ? "chips" : SP.NETWORK.currency.symbol}</span></span>
                  </div>
                  <div className="hmark">{mySeat === hand.button && hand.inProgress && <Marker kind="dealer" />}</div>
                  <span className="hstatus">{seats[mySeat].allIn ? "all-in" : seats[mySeat].folded ? "folded" : seats[mySeat].sittingOut ? "sitting out" : ""}</span>
                </div>
              </div>
            )}

            {/* pot collected to the winner */}
            {anim.winnerSeat >= 0 && (
              <FlyChips wrapRef={feltWrapRef} toX={seatPos(anim.winnerSeat).x} toY={seatPos(anim.winnerSeat).y} />
            )}
          </div>
          {React.createElement(SideRail)}
        </div>

        {renderBar()}
        {toast && <div className="lt-toast">{toast}</div>}
        {modal && <Modal kind={modal} close={() => setModal(null)} sdk={SP.sdk} tableId={tableId} cfg={cfg} bal={bal} tx={tx} refresh={refreshBal} />}
      </div>
    </div>
  );

  function renderBar() {
    if (!connected) return <StatusStrip text="Sign in to play" sub="Email login → instant Somnia wallet, no popups" accent="var(--accent-soft)" />;
    if (mySeat < 0) return <StatusStrip text="Take an empty seat to join" sub="Click a “+ Sit” spot around the table" accent="var(--muted)" />;
    const me = seats[mySeat];
    const myTurn = hand.inProgress && hand.actingSeat === mySeat && hand.street <= ST.RIVER;
    if (!myTurn) {
      const text = hand.inProgress ? (hand.street === ST.SHOWDOWN ? "Showdown — settling on-chain" : "Waiting for your turn") : "Waiting for the next hand";
      return <StatusStrip text={text} sub="Your chips & action are safe on-chain" accent="var(--muted)" />;
    }
    const cur = hand.currentBet, committed = me.committedStreet;
    const toCallW = cur > committed ? cur - committed : 0n;
    const minRaiseToW = cur === 0n ? cfg.bigBlind : cur + hand.minRaise;
    const maxToW = committed + me.stack;
    const minN = NV(minRaiseToW), maxN = NV(maxToW), call = NV(toCallW), pot = NV(hand.pot);
    const canCheck = toCallW === 0n;
    const isBet = cur === 0n;
    const canRaise = me.stack > toCallW && maxToW > cur && maxN > minN;
    const bv = Math.min(maxN, Math.max(minN, betValue || minN));
    const onFold = () => act(A.FOLD);
    const onCheckCall = () => act(canCheck ? A.CHECK : A.CALL);
    const onRaise = (v) => act(isBet ? A.BET : A.RAISE, Math.min(maxN, Math.max(minN, v)));
    if (!canRaise) {
      return (
        <div className="actionbar" style={{ justifyContent: "center", gap: 10 }}>
          <div className="actions">
            <button className="abtn fold" disabled={busy} onClick={onFold}><span className="key">F</span><span className="lbl">Fold</span></button>
            <button className="abtn call" disabled={busy} onClick={onCheckCall}><span className="key">C</span><span className="lbl">{canCheck ? "Check" : "Call"}</span>{!canCheck && <span className="amt tnum">{call.toFixed(2)}</span>}</button>
            {me.stack > 0n && !canCheck && <button className="abtn raise" disabled={busy} onClick={() => act(A.ALLIN)}><span className="lbl">All-in</span><span className="amt tnum">{maxN.toFixed(2)}</span></button>}
          </div>
        </div>
      );
    }
    const actionData = {
      toCall: call, minRaise: minN, potForBet: pot, heroStack: maxN,
      best: bestHand || "—", outs: "—", potOdds: canCheck ? "—" : Math.round((call / (pot + call)) * 100) + "%",
      raiseLabel: isBet ? "Bet" : "Raise to", canCheck, step: NV(cfg.bigBlind) || (CHIPS ? 1 : 0.01), symbol: CHIPS ? "chips" : SP.NETWORK.currency.symbol,
      timer: Math.max(0, hand.actingDeadline - now), timerTotal: Number(cfg.actionTimeout),
    };
    return <ActionBar action={actionData} onFold={onFold} onCheckCall={onCheckCall} onRaise={onRaise} betValue={bv} setBetValue={setBetValue} />;
  }
}

/* sit / cashier modal */
function Modal({ kind, close, sdk, tableId, cfg, bal, tx, refresh }) {
  const minE = Number(SP.fmt(cfg.minBuyIn, 4)), maxE = Number(SP.fmt(cfg.maxBuyIn, 4));
  const [amt, setAmt] = useState(kind.type === "sit" ? String(maxE) : "1");
  const [wd, setWd] = useState(String(bal));
  const [walletBal, setWalletBal] = useState(null);
  useEffect(() => { sdk.walletBalance().then((b) => setWalletBal(Number(SP.fmt(b, 6)))).catch(() => {}); }, []);
  const stop = (e) => e.stopPropagation();
  const sym = SP.NETWORK.currency.symbol;
  const lowWallet = walletBal != null && walletBal < 0.05;
  const isTestnet = SP.NETWORK.chainId === 50312;
  const copyAddr = () => { try { navigator.clipboard.writeText(sdk.address); } catch {} };
  return (
    <div className="lt-modalbg" onClick={close}>
      <div className="lt-modal" onClick={stop}>
        {kind.type === "sit" ? (
          <>
            <h3>Sit at seat {kind.seat}</h3>
            <p className="note">Blinds {Number(SP.fmt(cfg.smallBlind, 4))}/{Number(SP.fmt(cfg.bigBlind, 4))} {SP.NETWORK.currency.symbol}. Buy-in {minE}–{maxE}. We'll deposit from your wallet if your room balance is short.</p>
            <label>Buy-in</label>
            <input value={amt} onChange={(e) => setAmt(e.target.value)} />
            <div className="row">
              <button className="pill" onClick={close}>Cancel</button>
              <button className="pill primary" onClick={async () => {
                close();
                await tx("Take seat", async () => {
                  const need = SP.parseEther(amt);
                  const have = await sdk.balanceOf(sdk.address);
                  if (have < need) await sdk.deposit(SP.fmt(need - have, 6));
                  await sdk.sitDown(tableId, kind.seat, amt);
                  // injected wallets: grant a session key so actions need no popup.
                  // Privy email wallets are already headless — nothing to do.
                  if (sdk.backend === "injected" && !sdk.hasSession()) await sdk.activateSession();
                });
              }}>Take seat</button>
            </div>
          </>
        ) : (
          <>
            <h3>{kind.type === "fund" ? "Fund your wallet" : "Cashier"}</h3>
            <p className="note">Wallet <b className="mono">{short(sdk.address)}</b> · {walletBal == null ? "…" : walletBal.toFixed(3)} {sym} &nbsp;|&nbsp; In-room <b>{bal.toFixed(3)}</b> {sym}</p>
            {lowWallet && (
              <div className="fundbox">
                <div className="fh">Low {sym} balance — you need {sym} to buy in and cover gas.</div>
                <div className="fa"><span className="mono">{sdk.address}</span><button className="pill" onClick={copyAddr}>copy</button></div>
                {isTestnet
                  ? <a className="pill primary" href="https://testnet.somnia.network" target="_blank" rel="noopener" style={{ display: "block", textAlign: "center", textDecoration: "none", marginTop: 8 }}>Get free test {sym} — open faucet ↗</a>
                  : <div className="note" style={{ marginTop: 6 }}>Send {sym} to this address from any wallet or exchange.</div>}
                <div className="note" style={{ marginTop: 8 }}>Then deposit below and take a seat.</div>
              </div>
            )}
            <label>Deposit (wallet → room)</label>
            <input value={amt} onChange={(e) => setAmt(e.target.value)} />
            <div className="row"><button className="pill primary" onClick={() => { close(); tx("Deposit", () => sdk.deposit(amt)).then(refresh); }}>Deposit</button></div>
            <label>Withdraw (room → wallet)</label>
            <input value={wd} onChange={(e) => setWd(e.target.value)} />
            <div className="row"><button className="pill" onClick={() => { close(); tx("Withdraw", () => sdk.withdraw(wd)).then(refresh); }}>Withdraw</button></div>
          </>
        )}
      </div>
    </div>
  );
}

/* ---- scale-to-fit stage (from the design) ---- */
function mountScale() {
  const scaler = document.getElementById("scaler");
  if (!scaler) return;
  const app = scaler.querySelector(".app");
  if (!app) return;
  function fit() {
    const s = Math.min((window.innerWidth - 24) / 1600, (window.innerHeight - 84) / 1000, 1);
    app.style.transform = `scale(${s})`; app.style.transformOrigin = "top left"; app.style.position = "absolute"; app.style.top = "0"; app.style.left = "0";
    scaler.style.width = 1600 * s + "px"; scaler.style.height = 1000 * s + "px";
  }
  fit(); window.addEventListener("resize", fit);
}

function boot() {
  ReactDOM.createRoot(document.getElementById("root")).render(<LiveTable />);
  setInterval(mountScale, 400);
  setTimeout(mountScale, 80);
}
if (window.SP) boot(); else window.addEventListener("sp:ready", boot, { once: true });
