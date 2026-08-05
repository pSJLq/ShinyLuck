/* AUTO-GENERATED from poker-live-table.jsx by scripts/build-poker-jsx.js — do NOT edit. */
/* ShinyPoker · LIVE table. Reuses the design's visual components (Card, Seat,
   Board, Pot, grid felt) but every value is read from the on-chain snapshot via
   window.SP (poker-bridge.js). No hardcoded SCENES. */
const {
  useState,
  useEffect,
  useRef
} = React;

// Seat ring positions per table size (index 0 = bottom = hero), % of the felt.
// Top seats sit at ≥12% so they clear the tournament HUD strip even on the
// compact "larger interface" canvas.
const POS = {
  2: [{
    x: 50,
    y: 84
  }, {
    x: 50,
    y: 12
  }],
  6: [{
    x: 50,
    y: 83
  }, {
    x: 15,
    y: 65
  }, {
    x: 15,
    y: 27
  }, {
    x: 50,
    y: 12
  }, {
    x: 85,
    y: 27
  }, {
    x: 85,
    y: 65
  }],
  9: [{
    x: 50,
    y: 87
  }, {
    x: 18,
    y: 80
  }, {
    x: 6,
    y: 52
  }, {
    x: 14,
    y: 22
  }, {
    x: 38,
    y: 8
  }, {
    x: 62,
    y: 8
  }, {
    x: 86,
    y: 22
  }, {
    x: 94,
    y: 52
  }, {
    x: 82,
    y: 80
  }]
};
// Phones: the feltwrap is short, the HUD/topbar eat a bigger share of it and
// the action bar overlays the bottom — pull top seats down and bottom seats up
// so nothing slides under the chrome.
const POS_M = {
  2: [{
    x: 50,
    y: 78
  }, {
    x: 50,
    y: 18
  }],
  6: [{
    x: 50,
    y: 78
  }, {
    x: 14,
    y: 61
  }, {
    x: 14,
    y: 32
  }, {
    x: 50,
    y: 17
  }, {
    x: 86,
    y: 32
  }, {
    x: 86,
    y: 61
  }],
  9: [{
    x: 50,
    y: 80
  }, {
    x: 17,
    y: 74
  }, {
    x: 7,
    y: 51
  }, {
    x: 15,
    y: 27
  }, {
    x: 38,
    y: 15
  }, {
    x: 62,
    y: 15
  }, {
    x: 85,
    y: 27
  }, {
    x: 93,
    y: 51
  }, {
    x: 83,
    y: 74
  }]
};

// ---- desktop felt geometry ----
// The stage canvas follows the viewport aspect (mountScale), so the fixed POS
// percentages drifted off the rail on wide screens: the oval stretched into a
// racetrack and the side seats floated mid-felt. On desktop the felt is now a
// stadium (half-circle ends) capped at a real poker-table proportion (~2:1) —
// leftover width becomes margin the seat pods straddle into — and the seats
// are placed ON the measured rail. The JSX publishes --sp-feltside/--sp-feltr
// and poker-live.css draws the same shape, so the oval and the seat ring can
// never disagree. POS/POS_M stay as the pre-measure fallback and for phones.
const FELT_D = {
  top: 92,
  bottom: 188,
  minSide: 150,
  maxAR: 2.0
};
function feltGeom(w, h) {
  const fh = h - FELT_D.top - FELT_D.bottom;
  const side = Math.max(FELT_D.minSide, Math.round((w - FELT_D.maxAR * fh) / 2));
  return {
    side,
    r: fh / 2,
    fw: w - side * 2,
    fh,
    x0: side,
    y0: FELT_D.top,
    y1: h - FELT_D.bottom,
    cx: w / 2,
    cy: FELT_D.top + fh / 2
  };
}
// n seats at equal arc steps along the rail, seat 0 = bottom center (hero),
// walking the LEFT side first (same order as POS, so view() rotation holds).
function seatRing(n, w, h) {
  const g = feltGeom(w, h);
  if (g.fh <= 120 || g.fw <= 2 * g.r) return null;
  const straight = g.fw - 2 * g.r,
    arc = Math.PI * g.r;
  const P = 2 * straight + 2 * arc;
  const pt = s => {
    if (s <= straight / 2) return {
      x: g.cx - s,
      y: g.y1
    }; // bottom rail, walking left
    s -= straight / 2;
    if (s <= arc) {
      const a = s / g.r;
      return {
        x: g.x0 + g.r * (1 - Math.sin(a)),
        y: g.cy + g.r * Math.cos(a)
      };
    } // left cap, upward
    s -= arc;
    if (s <= straight) return {
      x: g.x0 + g.r + s,
      y: g.y0
    }; // top rail, walking right
    s -= straight;
    if (s <= arc) {
      const a = s / g.r;
      return {
        x: g.x0 + g.fw - g.r * (1 - Math.sin(a)),
        y: g.cy - g.r * Math.cos(a)
      };
    } // right cap, downward
    s -= arc;
    return {
      x: g.x0 + g.fw - g.r - s,
      y: g.y1
    }; // bottom rail, back to center
  };
  const ring = [];
  for (let i = 0; i < n; i++) {
    const p = pt(i / n * P);
    if (i === 0) p.y += 22; // hero anchor straddles outward, toward the herozone
    ring.push({
      x: p.x / w * 100,
      y: p.y / h * 100
    });
  }
  return ring;
}
const short = a => a && a !== "0x0000000000000000000000000000000000000000" ? a.slice(0, 6) + "…" + a.slice(-4) : "";
const N = wei => Number(SP.fmt(wei, 6));
// Tournament tables play in plain CHIP units (1500 chips, blinds 10/20), not
// wei · NV switches the whole table's value formatting per mode.
let CHIPS = false;
const NV = v => CHIPS ? Number(v) : Number(SP.fmt(v, 6));
const A = SP.ACTION,
  ST = SP.STREET;

// Tiny WebAudio synth · no assets, gated by the sound preference.
let AC = null;
function sfx(kind, on) {
  if (!on) return;
  // …and obey the casino's Settings slider, not just its on/off switch. These
  // sounds used to ignore the volume control entirely: turning it down did
  // nothing at the table, which made the setting look broken.
  const vol = window.SPMusic ? window.SPMusic.fx() : 1;
  if (vol <= 0) return;
  try {
    AC = AC || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = AC.currentTime;
    const tone = (f, start, dur, g0 = 0.05, type = "sine") => {
      const g = g0 * vol;
      const o = AC.createOscillator(),
        ga = AC.createGain();
      o.type = type;
      o.frequency.value = f;
      ga.gain.setValueAtTime(g, t0 + start);
      ga.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
      o.connect(ga);
      ga.connect(AC.destination);
      o.start(t0 + start);
      o.stop(t0 + start + dur + 0.02);
    };
    if (kind === "turn") {
      tone(660, 0, 0.12, 0.06);
      tone(880, 0.13, 0.15, 0.06);
    } else if (kind === "deal") {
      tone(420, 0, 0.05, 0.03, "triangle");
      tone(420, 0.07, 0.05, 0.03, "triangle");
    } else if (kind === "chip") tone(520, 0, 0.05, 0.035, "square");else if (kind === "win") {
      tone(523, 0, 0.12, 0.06);
      tone(659, 0.12, 0.12, 0.06);
      tone(784, 0.24, 0.2, 0.07);
    }
  } catch {}
}

// pot-collect: chips fly from the center to the winning seat
function FlyChips({
  wrapRef,
  toX,
  toY
}) {
  const [vec, setVec] = useState(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setVec({
      dx: (toX - 50) / 100 * r.width,
      dy: (toY - 43) / 100 * r.height
    });
  }, []);
  if (!vec) return null;
  return /*#__PURE__*/React.createElement("div", {
    className: "flychips"
  }, [0, 1, 2, 3, 4, 5].map(i => /*#__PURE__*/React.createElement("span", {
    key: i,
    className: "flychip",
    style: {
      left: Math.cos(i) * 10 + "px",
      top: Math.sin(i) * 10 + "px",
      "--ptx": vec.dx + "px",
      "--pty": vec.dy + "px",
      animationDelay: i * 50 + "ms"
    }
  })));
}

// the reverse: chips fly FROM a seat / bet spot INTO the pot · antes at the
// deal and each street's bets being collected. Every client renders this from
// the same snapshot diff, so everyone sees everyone posting.
function FlyToPot({
  wrapRef,
  fromX,
  fromY,
  delay = 0
}) {
  const [vec, setVec] = useState(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setVec({
      dx: (50 - fromX) / 100 * r.width,
      dy: (43 - fromY) / 100 * r.height
    });
  }, []);
  if (!vec) return null;
  return /*#__PURE__*/React.createElement("div", {
    className: "flychips",
    style: {
      left: fromX + "%",
      top: fromY + "%"
    }
  }, [0, 1, 2, 3].map(i => /*#__PURE__*/React.createElement("span", {
    key: i,
    className: "flychip",
    style: {
      left: Math.cos(i * 2) * 8 + "px",
      top: Math.sin(i * 2) * 8 + "px",
      "--ptx": vec.dx + "px",
      "--pty": vec.dy + "px",
      animationDelay: delay + i * 45 + "ms"
    }
  })));
}
function LiveTable() {
  const [snap, setSnap] = useState(null);
  const [connected, setConnected] = useState(false);
  const [addr, setAddr] = useState(null);
  const [bal, setBal] = useState(0);
  const [holes, setHoles] = useState({}); // dealId -> [strA,strB]
  // guarded: a framed WKWebView can THROW on storage and blank the table (§26)
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem("sp_theme") || "b";
    } catch (e) {
      return "b";
    }
  });
  // Language lives in the casino's Settings now · we only listen, so SPT() at
  // this table repaints the moment the player switches it out there.
  const [, setLangState] = useState(() => window.__SPLANG || "en");
  useEffect(() => {
    const on = e => setLangState(e && e.detail && e.detail.lang || window.__SPLANG || "en");
    window.addEventListener("sp-lang-changed", on);
    return () => window.removeEventListener("sp-lang-changed", on);
  }, []);
  // persisted table preferences · every toggle here actually works
  const [prefs, setPrefs] = useState(() => {
    const d = {
      sound: true,
      deck: "4",
      turbo: false,
      reduced: false,
      bbstacks: false,
      bigui: false
    };
    try {
      return Object.assign(d, JSON.parse(localStorage.getItem("sp_prefs") || "{}"));
    } catch {
      return d;
    }
  });
  const setPref = (k, v) => setPrefs(p => {
    const n = {
      ...p,
      [k]: v
    };
    try {
      localStorage.setItem("sp_prefs", JSON.stringify(n));
    } catch {}
    return n;
  });
  const deck = prefs.deck;
  const [preAct, setPreAct] = useState(null); // "checkfold" | "callany" | "check"
  const preActRef = useRef({
    key: null
  });
  const [showSettings, setShowSettings] = useState(false);
  const [railOpen, setRailOpen] = useState(false); // mobile: side rail as a bottom sheet
  // 0 means "not chosen" · renderBar() falls back to the legal minimum raise.
  // It is reset on every new turn (see the turnKey effect below): a slider left
  // at 40 big blinds from the hand before is not a preference, it is a trap —
  // the bar would come back pre-loaded with an amount the player picked in a
  // completely different spot, and the raise button says only "Raise to".
  const [betValue, setBetValue] = useState(0);
  const betTurnRef = useRef(null);
  const [modal, setModal] = useState(null); // {type, seat}
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sessionOn, setSessionOn] = useState(false);
  const [anim, setAnim] = useState({
    dealing: false,
    flipFrom: 99,
    winnerSeat: -1,
    won: 0
  });
  const [nowMs, setNowMs] = useState(Date.now());
  const [reveals, setReveals] = useState({}); // dealId -> { seat: [c0,c1] }
  const [sdWin, setSdWin] = useState(null); // showdown winner computed from reveals, BEFORE on-chain settle
  const [pendingAct, setPendingAct] = useState(null); // optimistic: my action tx sent, waiting for the chain
  const [lastActs, setLastActs] = useState({}); // seat -> {kind, amt, ts, deal} · action badges
  const [foldFx, setFoldFx] = useState({}); // seat -> ts · the muck fling, owned by its own timer
  const [leaving, setLeaving] = useState(false); // "get me out" · see startLeave()
  const leaveTxRef = useRef(false);
  const [potFly, setPotFly] = useState(null); // {ts, kind: "ante"|"sweep", idxs} · chips flying into the pot
  const [trn, setTrn] = useState(null); // tournament info+clock when this table is controlled
  const [movedTo, setMovedTo] = useState(null); // MTT rebalance: my seat is now at this table
  const [bustHidden, setBustHidden] = useState(false); // bust screen dismissed → observe
  const [finalHidden, setFinalHidden] = useState(false); // standings screen dismissed
  const moveRef = useRef(false); // redirect fired once
  const [names, setNames] = useState({}); // lowercased addr -> on-chain nickname
  const [avs, setAvs] = useState({}); // lowercased addr -> { id, img } (on-chain preset + uploaded image)
  const [heroDealing, setHeroDealing] = useState(false);
  const heroDealRef = useRef(null);
  const fetchingRef = useRef(false);
  const sigCacheRef = useRef({}); // dealId -> hole-card signature (sign once per hand)
  const prevRef = useRef({
    handId: 0,
    boardLen: 0,
    inProgress: false,
    stacks: {}
  });
  const dealTimerRef = useRef(null);
  const winTimerRef = useRef(null);
  const sdTimerRef = useRef(null);
  const potFlyRef = useRef(null);
  const sdWinRef = useRef(null);
  const boardsRef = useRef({}); // dealId -> last non-empty board (combo display survives the post-settle board clear)
  const holeRetryRef = useRef(null);
  const gotHolesRef = useRef({}); // dealId -> true once holes landed (retry-timer guard)
  const dealIdRef = useRef("0");
  const balSeqRef = useRef(0);
  const feltWrapRef = useRef(null);
  // What the action bar MEANT when it last changed, and when that was. A click
  // is only honoured once the player has had time to see the bar it landed on
  // (see the guard in renderBar).
  const barGuardRef = useRef({
    turn: "",
    meaning: "",
    since: 0
  });
  const [wrapBox, setWrapBox] = useState(null); // feltwrap layout box (offset px · immune to the stage scale transform)
  const reducedMo = prefs.reduced || !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [tableId, setTableId] = useState(SP.tableId); // switchable WITHOUT a page reload (LePoker-style)
  const [ctl, setCtl] = useState(undefined); // table controller: undefined = not resolved yet, zero = cash, else = tournament
  const ZERO_CTL = "0x0000000000000000000000000000000000000000";
  useEffect(() => {
    try {
      localStorage.setItem("sp_theme", theme);
    } catch (e) {}
  }, [theme]);

  // live snapshot poll · the table you're AT polls fast (served from the
  // dealer's HTTP cache, cheap — the bot also rebuilds that cache the moment
  // it reveals a card, so 600ms here is the real reveal→pixels latency).
  useEffect(() => SP.sdk.watch(tableId, setSnap, 600), [tableId]);

  // Closing the TAB mid-hand is not the same as refreshing it. This hand's
  // decryption secret lives in sessionStorage, which dies with the tab: without
  // it the player cannot hand over their share, the hand stalls into an
  // accusation, the rescue window expires, and the contract forfeits the chips
  // they had already put in. That is the right answer to a ragequit and a cruel
  // one to a mis-click, so warn while a hand is actually running. Leaving the
  // page also stops answering for the OTHERS at the table, which is reason
  // enough on its own. Between hands there is nothing to lose and no prompt.
  useEffect(() => {
    const on = e => {
      if (!snap || !snap.hand.inProgress || snap.mySeat < 0) return;
      const me = snap.seats[snap.mySeat];
      if (!me || !me.occupied) return;
      e.preventDefault();
      e.returnValue = ""; // required by Chrome/Safari to show the dialog
      return "";
    };
    window.addEventListener("beforeunload", on);
    return () => window.removeEventListener("beforeunload", on);
  }, [snap]);

  // A community card opened locally by the zk agent arrives on its own event,
  // not on a snapshot — without this the card would sit in memory until the
  // next poll and the whole point (showing it before the chain does) is lost.
  const [zkTick, setZkTick] = useState(0);
  useEffect(() => {
    const on = () => setZkTick(n => n + 1);
    window.addEventListener("shinypoker:zk-board", on);
    window.addEventListener("shinypoker:zk-showdown", on); // opened hands, same deal
    return () => {
      window.removeEventListener("shinypoker:zk-board", on);
      window.removeEventListener("shinypoker:zk-showdown", on);
    };
  }, []);

  // The controller decides the whole render mode (chip formatting, seats
  // managed by a tournament vs open sit-down). Resolve it BEFORE first paint -
  // tournament tables used to flash cash-table UI ("+ Sit" seats, wei-formatted
  // blinds) for a second until the slower tournament poll landed.
  useEffect(() => {
    let stop = false;
    SP.sdk.tableController(tableId).then(a => {
      if (!stop) setCtl((a || ZERO_CTL).toLowerCase());
    }).catch(() => {
      if (!stop) setCtl(ZERO_CTL);
    });
    return () => {
      stop = true;
    };
  }, [tableId]);

  // auto-restore an existing email (Privy) session · now and whenever Privy boots
  useEffect(() => {
    const restore = () => SP.sdk.tryRestorePrivy().then(a => {
      if (a) {
        setAddr(a);
        setConnected(true);
        refreshBal();
      }
    }).catch(() => {});
    restore();
    const on = ev => {
      if (ev.detail && ev.detail.authenticated && ev.detail.address) restore();
    };
    document.addEventListener("shinyluck:auth-state", on);
    return () => document.removeEventListener("shinyluck:auth-state", on);
  }, []);

  // wallet balance refresh · sequence-guarded so a slow stale response can't
  // overwrite a newer value (the header briefly "jumping" between balances)
  async function refreshBal() {
    if (!SP.sdk.address) return;
    const seq = ++balSeqRef.current;
    try {
      const b = N(await SP.sdk.balanceOf(SP.sdk.address));
      if (seq === balSeqRef.current) setBal(b);
    } catch {}
  }
  useEffect(() => {
    if (connected) {
      refreshBal();
      const id = setInterval(refreshBal, 4000);
      return () => clearInterval(id);
    }
  }, [connected]);

  // The felt used to run a GridField LED canvas here (plus a scramble wave on
  // each deal and a flash on wins) — a steady per-frame CPU/GPU cost competing
  // with the zk crypto during hands, and the "waves" kept reappearing with
  // every theme change. Gone entirely: the page-wide sp-dust sparks
  // (poker-dust.js, same as the casino menu) are the only ambient motion now.

  // Measure the feltwrap in LAYOUT px (offset*, unaffected by the stage scale
  // transform) and feed the felt shape + seat ring from it. The wrap mounts
  // together with the main tree, so re-attach once loading finishes; resizes
  // (window, bigui toggle) come in through the ResizeObserver.
  useEffect(() => {
    const el = feltWrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const w = el.offsetWidth,
        h = el.offsetHeight;
      if (!w || !h) return;
      const g = feltGeom(w, h);
      el.style.setProperty("--sp-feltside", g.side + "px");
      el.style.setProperty("--sp-feltr", g.r + "px");
      setWrapBox(p => p && p.w === w && p.h === h ? p : {
        w,
        h
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [!snap || ctl === undefined]);

  // fetch my hole cards once per deal · failed attempts retry on a FAST local
  // timer (dealer is still locking entropy) instead of waiting for the next
  // snapshot poll, so the cards land the moment they're available
  useEffect(() => {
    if (snap) dealIdRef.current = String(snap.hand.dealId);
  }, [snap]);

  // The bet slider is a per-DECISION control, not a table setting. It used to
  // be one useState for the whole session, so an amount dragged on the flop
  // came back pre-selected on the turn, on the next hand, and every hand after
  // that — the raise button reads "Raise to" with a figure beside it, and the
  // figure was one the player chose in a spot that no longer exists. Clearing
  // it on every new turn hands the decision back to the legal minimum, which
  // is what an untouched slider is supposed to mean.
  useEffect(() => {
    if (!snap) return;
    const h = snap.hand;
    const key = `${h.dealId}:${h.street}:${h.actingSeat}:${h.actingDeadline}`;
    if (betTurnRef.current !== key) {
      betTurnRef.current = key;
      setBetValue(0);
    }
  }, [snap]);
  useEffect(() => {
    if (!snap || !connected) return;
    const h = snap.hand;
    if (!h.inProgress || snap.mySeat < 0) return;
    const me = snap.seats[snap.mySeat];
    if (!me.inHand) return;
    const key = String(h.dealId);
    if (gotHolesRef.current[key]) return;
    fetchHoles(key, h.dealId);
  }, [snap, connected]);
  async function fetchHoles(key, dealId, attempt = 0) {
    if (gotHolesRef.current[key] || fetchingRef.current || dealIdRef.current !== key) return;
    fetchingRef.current = true;
    try {
      // Sign once per hand; reuse the signature on retries while the dealer
      // finishes locking entropy · so only ONE wallet popup per hand.
      if (!sigCacheRef.current[key]) sigCacheRef.current[key] = await SP.sdk.signHoles(tableId, dealId);
      const r = await SP.sdk.myHoleCards(tableId, dealId, sigCacheRef.current[key]);
      gotHolesRef.current[key] = true;
      setHoles(m => ({
        ...m,
        [key]: r
      }));
      setHeroDealing(true);
      clearTimeout(heroDealRef.current);
      heroDealRef.current = setTimeout(() => setHeroDealing(false), 700);
    } catch (e) {
      if (attempt < 24) {
        // ~12s of quick retries, then the snapshot poll takes over
        clearTimeout(holeRetryRef.current);
        holeRetryRef.current = setTimeout(() => fetchHoles(key, dealId, attempt + 1), 500);
      } else console.warn("hole:", e.message);
    } finally {
      fetchingRef.current = false;
    }
  }

  // keep the session indicator in sync (Privy = always popup-free; injected = once a session is granted)
  useEffect(() => {
    setSessionOn(SP.sdk.popupFree());
  }, [snap, connected]);

  // your-turn sound + PRE-ACTION execution (check/fold, call any, check)
  useEffect(() => {
    if (!snap || snap.mySeat < 0) return;
    const h = snap.hand;
    const myTurn = h.inProgress && h.actingSeat === snap.mySeat && h.street <= ST.RIVER;
    if (!myTurn) return;
    const key = `${h.dealId}:${h.street}:${h.actingDeadline}`;
    if (preActRef.current.key === key) return; // already handled this turn
    preActRef.current.key = key;
    sfx("turn", prefs.sound);
    if (!preAct || busy) return;
    const me2 = snap.seats[snap.mySeat];
    const owe = h.currentBet > me2.committedStreet;
    const sel = preAct;
    setPreAct(null); // one-shot
    if (sel === "checkfold") act(owe ? A.FOLD : A.CHECK);else if (sel === "callany") act(owe ? A.CALL : A.CHECK);else if (sel === "check" && !owe) act(A.CHECK);
  }, [snap]);

  // 1s tick so countdown timers update smoothly
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // one-time hint: what the D / SB / BB chips mean (beginners kept asking)
  useEffect(() => {
    if (!snap || !snap.hand.inProgress) return;
    try {
      if (!localStorage.getItem("sp_hint_dealer")) {
        localStorage.setItem("sp_hint_dealer", "1");
        flash(window.__SPLANG === "ru" ? "Метка D · баттон (дилер): от него идёт раздача и порядок ходов, каждую руку он сдвигается. SB/BB · малый и большой блайнды." : "The D chip marks the dealer button · dealing & betting order rotate from it each hand. SB/BB are the small & big blinds.", 9000);
      }
    } catch {}
  }, [snap && snap.hand.inProgress]);

  // tournament HUD: if this table is controlled by a tournament, poll its state
  // (clock + my registration/seat + finishing places · feeds the HUD, the MTT
  // table switcher, the move-redirect, the bust screen and the final standings)
  useEffect(() => {
    if (!SP.sdk.hasTournaments()) return;
    let stop = false;
    async function poll() {
      try {
        const t = await SP.sdk.tournamentOfTable(tableId);
        if (stop) return;
        if (!t) {
          setTrn(null);
          return;
        }
        const [c, res] = await Promise.all([SP.sdk.tournamentClock(t.id, t.at), SP.sdk.tournamentResults(t.id).catch(() => null)]);
        const nextAt = await SP.sdk.nextLevelAt(t.id, c, t.at); // structure-aware (custom schedules)
        const tables = t.tables && t.tables.length ? t.tables : [t.tableId];
        let reg = false,
          myTable = -1;
        if (SP.sdk.address) {
          reg = await SP.sdk.isRegisteredIn(t.id, t.at).catch(() => false);
          if (reg && t.status === 1) myTable = await SP.sdk.myTournamentSeatTable(t.id, t.at).catch(() => -1);
        }
        // seated-per-table counts for the MTT switcher (one lobby GET covers all)
        let counts = null;
        if (tables.length > 1) {
          try {
            const lob = await SP.sdk.lobbySnapshot();
            if (lob) counts = Object.fromEntries(lob.tables.map(x => [Number(x.id), x.seated]));
          } catch {}
        }
        if (!stop) setTrn({
          ...t,
          ...c,
          nextAt,
          tables,
          reg,
          myTable,
          res,
          counts
        });
      } catch {}
    }
    poll();
    const iv = setInterval(poll, 5000);
    return () => {
      stop = true;
      clearInterval(iv);
    };
  }, [connected, tableId]);

  // resolve on-chain profiles (nickname + avatar) for everyone seated
  const takeProfiles = m => {
    const h = {},
      a2 = {};
    for (const k of Object.keys(m)) {
      h[k] = m[k].handle;
      a2[k] = {
        id: m[k].avatar,
        img: m[k].img
      };
    }
    setNames(p => ({
      ...p,
      ...h
    }));
    setAvs(p => ({
      ...p,
      ...a2
    }));
  };
  useEffect(() => {
    if (!snap) return;
    const addrs = snap.seats.filter(s => !s.empty).map(s => s.player);
    if (addr) addrs.push(addr);
    let stop = false;
    SP.sdk.profilesFor(addrs).then(m => {
      if (!stop) takeProfiles(m);
    }).catch(() => {});
    return () => {
      stop = true;
    };
  }, [snap && snap.seats.filter(s => !s.empty).map(s => s.player).join(","), addr]);
  const nameOf = a => a && names[a.toLowerCase()] || short(a);
  const avOf = a => a && avs[a.toLowerCase()] || {
    id: 0,
    img: null
  };

  // profiles for the final standings (bust/finish events carry addresses only)
  useEffect(() => {
    if (!trn || !trn.res) return;
    const list = trn.res.busts.map(b => b.player).concat(trn.res.winner ? [trn.res.winner.player] : []);
    if (!list.length) return;
    let stop = false;
    SP.sdk.profilesFor(list).then(m => {
      if (!stop) takeProfiles(m);
    }).catch(() => {});
    return () => {
      stop = true;
    };
  }, [trn && trn.res && trn.res.busts.length + ":" + !!(trn.res && trn.res.winner)]);

  // MTT rebalance: the tournament moved my seat to another table → tell me and
  // take me there (the table in ?t=N is fixed at page load, so without this the
  // player is stranded watching a table they no longer sit at). Auto-follow
  // ONLY if I actually held a seat HERE this session · a registered player
  // spying on a sibling table via the switcher must not get yanked away.
  const wasSeatedHereRef = useRef(false);
  useEffect(() => {
    if (snap && snap.mySeat >= 0) wasSeatedHereRef.current = true;
  }, [snap && snap.mySeat]);
  useEffect(() => {
    if (!trn || moveRef.current || !wasSeatedHereRef.current) return;
    if (trn.status === 1 && trn.reg && trn.myTable >= 0 && trn.myTable !== tableId) {
      moveRef.current = true;
      setMovedTo(trn.myTable);
      const dest = trn.myTable;
      setTimeout(() => switchTable(dest), 2600); // in-place switch · no reload
    }
  }, [trn]);

  // detect hand transitions → deal scramble, board flip, winner glow + pot collect
  useEffect(() => {
    if (!snap) return;
    const prev = prevRef.current;
    const h = snap.hand;
    // Count the cards actually ON SCREEN, which includes any this tab opened
    // itself ahead of the chain — otherwise the flip animation would fire late,
    // when the on-chain reveal caught up to a card the player already saw.
    let boardLen = snap.board.length;
    {
      const e = window.__SPZK && window.__SPZK.board ? window.__SPZK.board[String(h.dealId)] : null;
      if (e) while (e[boardLen] !== undefined) boardLen++;
    }
    if (h.inProgress && h.handId !== prev.handId && h.handId > 0) {
      setAnim(a => ({
        ...a,
        dealing: !reducedMo,
        flipFrom: 99,
        winnerSeat: -1
      }));
      clearTimeout(dealTimerRef.current);
      dealTimerRef.current = setTimeout(() => setAnim(a => ({
        ...a,
        dealing: false
      })), prefs.turbo ? 600 : 1300);
      setPreAct(null); // pre-actions never carry across hands
      setSdWin(null);
      clearTimeout(sdTimerRef.current);
      setLastActs({}); // action badges never carry across hands
      // antes are swept straight into the pot on-chain (no bet spot) · show
      // everyone's chips flying to the middle so posting is visible to all
      const hasAnte = trn ? Number(trn.curAnte || 0) > 0 : (snap.cfg.ante || 0n) > 0n;
      if (hasAnte && !reducedMo) {
        setPotFly({
          ts: Date.now(),
          kind: "ante",
          idxs: snap.seats.filter(s => !s.empty && s.inHand).map(s => s.index)
        });
        clearTimeout(potFlyRef.current);
        potFlyRef.current = setTimeout(() => setPotFly(null), 1200);
      }
      sfx("deal", prefs.sound);
    }
    // street advanced → the bets in front of the seats get collected into the
    // pot; fly them to the middle (again: same snapshot diff on every client)
    if (h.inProgress && h.handId === prev.handId && h.street > prev.street && prev.sh && !reducedMo) {
      const idxs = Object.keys(prev.sh).filter(k => prev.sh[k].cs > 0n).map(Number);
      if (idxs.length) {
        setPotFly({
          ts: Date.now(),
          kind: "sweep",
          idxs
        });
        clearTimeout(potFlyRef.current);
        potFlyRef.current = setTimeout(() => setPotFly(null), 1100);
      }
    }
    // last-action badges: diff this snapshot against the previous one to see
    // WHO just did WHAT (fold/check/call/bet/raise/all-in) · the chain has no
    // push feed, so the poll delta is the source of truth
    if (h.inProgress && prev.sh) {
      const sameHand = h.handId === prev.handId;
      const sameStreet = sameHand && h.street === prev.street;
      const acts = {};
      for (const s of snap.seats) {
        if (s.empty) continue;
        const p = prev.sh[s.index];
        if (!p) continue;
        // `deal` stamps the badge with the hand it belongs to · the only thing
        // that may ever clear it is a NEW hand, not a timer
        const dk = String(h.dealId);
        if (sameHand && s.folded && !p.folded) acts[s.index] = {
          kind: "fold",
          ts: Date.now(),
          deal: dk
        };else if (sameHand && s.allIn && !p.allIn) acts[s.index] = {
          kind: "allin",
          ts: Date.now(),
          deal: dk
        };else if (sameStreet && s.committedStreet > p.cs) acts[s.index] = {
          kind: prev.curBet === 0n ? "bet" : s.committedStreet > prev.curBet ? "raise" : "call",
          amt: NV(s.committedStreet),
          ts: Date.now(),
          deal: dk
        };else if (sameStreet && prev.actingSeat === s.index && h.actingSeat !== s.index && s.committedStreet === p.cs && !s.folded && !s.allIn && s.inHand) acts[s.index] = {
          kind: "check",
          ts: Date.now(),
          deal: dk
        };
      }
      if (Object.keys(acts).length) setLastActs(m => ({
        ...m,
        ...acts
      }));
      // THE MUCK.
      // Cards being flung toward the pot is how a table says "that player is
      // out of this hand" without anyone reading anything. It existed, but it
      // was gated on `nowMs - fold.ts < 1400` and `nowMs` only ticks once a
      // second — so whether you saw it depended on where the fold landed
      // inside that second, and often it never rendered at all. Its own timer
      // now owns it, and the hero gets one too (folding your own hand used to
      // just delete the cards).
      const justFolded = Object.keys(acts).filter(i => acts[i].kind === "fold").map(Number);
      if (justFolded.length && !reducedMo) {
        setFoldFx(f => {
          const n = {
            ...f
          };
          for (const i of justFolded) n[i] = Date.now();
          return n;
        });
        setTimeout(() => setFoldFx(f => {
          const n = {
            ...f
          };
          for (const i of justFolded) delete n[i];
          return n;
        }), 760);
      }
    }
    if (boardLen > prev.boardLen) setAnim(a => ({
      ...a,
      flipFrom: prev.boardLen
    }));
    if (!h.inProgress && prev.inProgress) {
      let winner = -1,
        best = 0n;
      for (const s of snap.seats) {
        const d = s.stack - (prev.stacks[s.index] || 0n);
        if (d > best) {
          best = d;
          winner = s.index;
        }
      }
      // EVERY client gets the winner + amount (banner). Only the chip-flight
      // motion itself respects reduced-motion · before, that flag silently
      // swallowed the whole payout announcement.
      if (winner >= 0) {
        setAnim(a => ({
          ...a,
          winnerSeat: winner,
          won: NV(best)
        }));
        clearTimeout(winTimerRef.current);
        winTimerRef.current = setTimeout(() => setAnim(a => ({
          ...a,
          winnerSeat: -1
        })), 3200);
        // showdown already played the win sound; only fold-wins chime here
        if (winner === snap.mySeat && !(sdWinRef.current && sdWinRef.current.seat === winner)) sfx("win", prefs.sound);
      }
      // hold the showdown banner through the settle beat, then clear
      clearTimeout(sdTimerRef.current);
      sdTimerRef.current = setTimeout(() => setSdWin(null), 6000);
    }
    const stacks = {},
      sh = {};
    snap.seats.forEach(s => {
      stacks[s.index] = s.stack;
      if (!s.empty) sh[s.index] = {
        cs: s.committedStreet,
        folded: s.folded,
        allIn: s.allIn
      };
    });
    prevRef.current = {
      handId: h.handId,
      boardLen,
      inProgress: h.inProgress,
      street: h.street,
      curBet: h.currentBet,
      actingSeat: h.actingSeat,
      stacks,
      sh
    };
  }, [snap, zkTick]); // zkTick: a locally-opened board card is a transition too

  // At showdown, fetch opponents' revealed hole cards (public once every share
  // is in). Two things this has to survive, both of which cost us a whole
  // tournament's worth of showdowns:
  //   1. The cards only become readable when the dealer's markShowdownReady
  //      lands — one of the LAST transactions before the settle — so the first
  //      few attempts legitimately come back "not ready".
  //   2. A slow client can still be fetching when the hand ends. Keying the
  //      fetch off the LIVE hand meant that once the pot moved, the request was
  //      abandoned and the seats never opened at all.
  // So the target deal (and who was in it — `inHand` is cleared by the settle)
  // is remembered and retried for a few seconds past the end of the hand.
  const sdTargetRef = useRef(null);
  const sdFetchRef = useRef(false);
  useEffect(() => {
    if (!snap || !SP.sdk.dealerRead) return;
    const h = snap.hand;
    if (h.inProgress && h.street === ST.SHOWDOWN) {
      const key = String(h.dealId);
      if (!sdTargetRef.current || sdTargetRef.current.key !== key) {
        sdTargetRef.current = {
          key,
          dealId: h.dealId,
          seats: snap.seats.filter(s => !s.empty && s.inHand).map(s => s.index),
          until: Date.now() + 15000
        };
      }
    }
    const tgt = sdTargetRef.current;
    if (!tgt || sdFetchRef.current || reveals[tgt.key] || Date.now() > tgt.until) return;
    sdFetchRef.current = true;
    (async () => {
      try {
        if (!(await SP.sdk.dealerRead.isShowdownReady(tgt.dealId))) return;
        const out = {};
        for (const i of tgt.seats) out[i] = await SP.sdk.revealedHole(tgt.dealId, i);
        setReveals(m => ({
          ...m,
          [tgt.key]: out
        }));
      } catch {} finally {
        sdFetchRef.current = false;
      }
    })();
  }, [snap]);

  // the instant reveals arrive at showdown, rank the hands CLIENT-side and
  // announce the winner · on-chain settlement lands a few seconds later, and
  // before this the table just sat silent with open cards
  useEffect(() => {
    sdWinRef.current = sdWin;
  }, [sdWin]);
  useEffect(() => {
    if (!snap) return;
    const h = snap.hand;
    if (!h.inProgress || h.street !== ST.SHOWDOWN) return;
    const key = String(h.dealId);
    // Same two sources as the felt: hands this tab opened from the relayed
    // shares, and the chain's copy. Whichever is there first announces the
    // winner — waiting for the chain is what left the table silent with the
    // hand already decided.
    const local = window.__SPZK && window.__SPZK.theirs && window.__SPZK.theirs[key] || null;
    const rv = {};
    if (local) for (const k of Object.keys(local)) rv[Number(k)] = local[k].cards;
    // MY OWN HAND IS PART OF THE SHOWDOWN.
    // `theirs` is, by name and by construction, the OPPONENTS' hands — the
    // hero's cards never travel through the relay, they are fetched privately.
    // Ranking `rv` alone therefore ranked the table with the hero missing from
    // it and announced the best OPPONENT as the winner: a player holding a
    // straight was told the pair across the table had won, and stayed told it
    // for the two seconds the chain's own reveal took to arrive and silently
    // correct the banner. Announcing the wrong winner of a real pot is the
    // worst thing this screen can do, so the hero goes in with everyone else.
    const mine = holes[key];
    const meSeat = snap.mySeat;
    if (mine && Array.isArray(mine.cards) && meSeat >= 0) {
      const me = snap.seats[meSeat];
      if (me && me.inHand && !me.folded) rv[meSeat] = mine.cards;
    }
    if (reveals[key]) for (const k of Object.keys(reveals[key])) rv[Number(k)] = reveals[key][k];
    // the board may also be ahead of the snapshot (locally opened cards)
    const bd = snap.board.slice();
    const eb = window.__SPZK && window.__SPZK.board ? window.__SPZK.board[key] : null;
    if (eb) for (let i = bd.length; i < 5 && eb[i] !== undefined; i++) bd.push(eb[i]);
    if (bd.length < 5 || !Object.keys(rv).length || sdWin && sdWin.dealId === key) return;
    // A VERDICT OVER A PARTIAL TABLE IS A GUESS.
    // Hands arrive one at a time — the hero's are already in hand, each
    // opponent's lands as its shares are relayed — and ranking whoever has
    // shown up so far crowns the wrong player for as long as it takes the rest
    // to appear. Both directions of that were real: with the hero missing, the
    // best opponent was announced over a straight; with only the hero present,
    // the hero "won" against nobody. So wait until every seat still in the hand
    // has its cards, and if one never comes, say nothing and let the chain's
    // own settle announce it a beat later.
    const liveSeats = snap.seats.filter(s => !s.empty && s.inHand && !s.folded).map(s => s.index);
    if (!liveSeats.length || liveSeats.some(i => !rv[i])) return;
    let seat = -1,
      best = -1,
      tie = false;
    for (const k of Object.keys(rv)) {
      const ev = SP.handEval(rv[k].concat(bd));
      if (!ev) continue;
      if (ev.score > best) {
        best = ev.score;
        seat = Number(k);
        tie = false;
      } else if (ev.score === best) tie = true;
    }
    if (seat < 0) return;
    setSdWin({
      dealId: key,
      seat,
      tie,
      comboEn: SP.handName(rv[seat].concat(bd))
    });
    if (seat === snap.mySeat) sfx("win", prefs.sound);
    // `holes`: my own cards can land AFTER the showdown opens (the private
    // fetch retries), and the verdict must be recomputed when they do.
  }, [snap, reveals, zkTick, holes]); // zkTick: a locally opened hand decides the winner too

  function flash(msg, ms = 3000) {
    setToast(msg);
    setTimeout(() => setToast(null), ms);
  }
  async function tx(label, fn) {
    // the clicked button owns the spinner until this settles
    const done = SPPress.claim();
    setBusy(true);
    try {
      await fn();
      // NO SUCCESS TOAST. Every one of these actions already shows its own
      // result: the badge on your seat, the seat you now occupy, the stack
      // that grew, the lobby you land in. A tick floating over the felt after
      // each of them was the most-seen and least-useful thing on the screen.
      // Failures still speak — those are the ones you cannot see.
      await refreshBal();
      return true;
    } catch (e) {
      flash(label + " ✗ " + SP.pokerError(e), 5000);
      console.error(e);
      return false;
    } finally {
      setBusy(false);
      done();
    }
  }

  // optimistic action bar: cleared as soon as the chain hands the turn onward
  // (or right away if the tx reverted, so the buttons come back)
  useEffect(() => {
    if (!pendingAct || !snap) return;
    const h = snap.hand;
    if (!h.inProgress || String(h.dealId) !== pendingAct.dealId || h.street !== pendingAct.street || h.actingSeat !== snap.mySeat) setPendingAct(null);
  }, [snap]);
  async function connect() {
    try {
      const a = await SP.sdk.connect();
      setAddr(a);
      setConnected(true);
      refreshBal();
      // brand-new email wallets start empty · guide funding so they can play
      try {
        if ((await SP.sdk.walletBalance()) < SP.parseEther("0.02")) setModal({
          type: "fund"
        });
      } catch {}
    } catch (e) {
      if (e && e.message !== "cancelled") flash(e.message || "connect failed", 5000);
    }
  }
  const act = async (action, amount = 0) => {
    sfx("chip", prefs.sound);
    // optimistic: swap the buttons for a "sent" strip immediately · the tx is
    // headless and Somnia confirms fast, so waiting on the snapshot felt laggy
    if (snap && snap.hand.inProgress) setPendingAct({
      dealId: String(snap.hand.dealId),
      street: snap.hand.street
    });
    const ok = await tx(["Fold", "Check", "Call", "Bet", "Raise", "All-in"][action], () => SP.sdk.act(tableId, action, amount, !!trn));
    if (!ok) setPendingAct(null);
    return ok;
  };

  /// LEAVING HAS TO BE ONE DECISION, NOT A RACE.
  /// The contract will not let you stand up while you are in a hand (it would
  /// erase the chips that hand has already committed), and pre-deal starts the
  /// next one a second or two after the pot moves — so a player pressing Leave
  /// between hands kept missing the window and the table simply never let them
  /// out. The honest way out was closing the tab, which is worse for everyone:
  /// the seat then squats until the dealer's idle sweep reclaims it.
  ///
  /// So Leave now states an INTENTION and the client carries it out:
  ///   1. sit out at once — whatever else happens, no new hand deals you in;
  ///   2. fold the moment it is your turn, so the hand you are in ends for you;
  ///   3. stand up as soon as the contract allows it, and go back to the lobby.
  /// Not in a hand? Then it is a single transaction and you are gone.
  async function startLeave() {
    if (trn) return; // tournament seats belong to the tournament
    const me = seats[mySeat];
    const inHandNow = hand.inProgress && me && (me.inHand || me.folded || me.committedStreet > 0n);
    if (!inHandNow) {
      const ok = await tx("Leave", () => SP.sdk.leave(tableId));
      if (ok) location.href = "lobby";
      return;
    }
    setLeaving(true);
    flash(SPT("Leaving · you'll be folded and stood up when this hand ends"), 5000);
    if (me && !me.sittingOut) await tx("Sit out", () => SP.sdk.sitOut(tableId, true));
  }
  function cancelLeave() {
    setLeaving(false);
    leaveTxRef.current = false;
    flash(SPT("Staying at the table"), 2500);
  }
  // …and the part that actually carries it out, on every snapshot.
  useEffect(() => {
    if (!leaving || !snap || snap.mySeat < 0 || trn) return;
    const h = snap.hand,
      me = snap.seats[snap.mySeat];
    if (!me) return;
    const stillIn = h.inProgress && (me.inHand || me.folded || me.committedStreet > 0n);
    if (stillIn) {
      // fold as soon as the turn is ours · nothing else can end our part of it
      if (h.inProgress && h.actingSeat === snap.mySeat && h.street <= ST.RIVER && !busy && !leaveTxRef.current) {
        leaveTxRef.current = true;
        act(A.FOLD).finally(() => {
          leaveTxRef.current = false;
        });
      }
      return;
    }
    if (leaveTxRef.current || busy) return;
    leaveTxRef.current = true;
    tx("Leave", () => SP.sdk.leave(tableId)).then(ok => {
      if (ok) location.href = "lobby";else leaveTxRef.current = false;
    }).catch(() => {
      leaveTxRef.current = false;
    });
  }, [snap, leaving]);

  /// LePoker-style: move to another table of the event IN PLACE · no page
  /// reload. Resets every per-table piece of state; the pollers re-key off
  /// tableId; the URL stays shareable via replaceState.
  function switchTable(tid) {
    if (tid === tableId) return;
    setSnap(null);
    setCtl(undefined);
    setHoles({});
    setReveals({});
    setSdWin(null);
    setPendingAct(null);
    setLastActs({});
    setPotFly(null);
    setPreAct(null);
    setBetValue(0);
    setAnim({
      dealing: false,
      flipFrom: 99,
      winnerSeat: -1,
      won: 0
    });
    setMovedTo(null);
    setModal(null);
    moveRef.current = false;
    wasSeatedHereRef.current = false;
    gotHolesRef.current = {};
    boardsRef.current = {};
    prevRef.current = {
      handId: 0,
      boardLen: 0,
      inProgress: false,
      stacks: {}
    };
    [dealTimerRef, winTimerRef, sdTimerRef, potFlyRef, holeRetryRef].forEach(r => clearTimeout(r.current));
    try {
      history.replaceState(null, "", "table?t=" + tid);
    } catch {}
    setTableId(tid);
  }
  if (!snap || ctl === undefined) return /*#__PURE__*/React.createElement("div", {
    className: "center-load"
  }, "Loading table\u2026");
  const {
    cfg,
    hand,
    seats,
    mySeat
  } = snap;
  const maxSeats = cfg.maxSeats;
  const dealKey = String(hand.dealId);
  // freeze the last non-empty board per deal: after settle the live board
  // empties while revealed cards + the winner banner are still on screen -
  // recomputing combos against an empty board briefly showed nonsense
  // ("High Card" right after "Two Pair" won)
  if (snap.board.length) boardsRef.current = {
    [dealKey]: snap.board
  };
  const sdBoard = snap.board.length ? snap.board : boardsRef.current[dealKey] || snap.board;
  // THE REVEAL HAS TO OUTLIVE THE SETTLE. `hand.inProgress` goes false the
  // instant the pot is awarded, and every open card was gated on it — so the
  // showdown was wiped at exactly the moment the winner banner appeared, and a
  // hand ended with an empty felt and money moving for no visible reason. The
  // banner itself is already held through the settle beat (sdWin, 6s / winner
  // glow, 3.2s) and the board is frozen above for the same reason; the cards
  // now ride that same beat. A new hand resets both, so nothing leaks forward.
  const settleHold = anim.winnerSeat >= 0 || !!(sdWin && sdWin.dealId === dealKey);
  // Opened hands, from whichever source got there first. This tab decrypts them
  // from the relayed shares the moment the showdown starts (zk-agent), and the
  // chain's own copy lands a beat later; both are checked against the same
  // on-chain ciphertext commitments, so either is authoritative. Merging is what
  // stops a showdown from depending on a per-seat chain read that can simply
  // fail — which is how a hand used to end with no cards and no winner at all.
  const sdCards = (() => {
    const local = window.__SPZK && window.__SPZK.theirs && window.__SPZK.theirs[dealKey] || null;
    const chain = reveals[dealKey] || null;
    if (!local && !chain) return null;
    const okc = c => Array.isArray(c) && c.length === 2 && c.every(n => Number.isInteger(n) && n >= 0 && n < 52);
    const out = {};
    if (local) for (const k of Object.keys(local)) {
      if (okc(local[k].cards)) out[Number(k)] = local[k].cards;
    }
    // …and the hero, for the same reason as the verdict above: this map is what
    // `winUsed` reads to work out WHICH five cards won, so without it the
    // highlight had nothing of the hero's to highlight.
    const meObj = holes[dealKey];
    if (meObj && okc(meObj.cards) && snap.mySeat >= 0) {
      const me = snap.seats[snap.mySeat];
      if (me && me.inHand && !me.folded) out[snap.mySeat] = meObj.cards;
    }
    if (chain) for (const k of Object.keys(chain)) {
      if (okc(chain[k])) out[Number(k)] = chain[k];
    }
    return Object.keys(out).length ? out : null;
  })();
  const sdHold = settleHold && !!sdCards;
  // WHO WON — one answer, computed once, used by every part of the screen.
  // It used to be re-derived inline in four places and only ONE of them checked
  // that the verdict belonged to the hand on screen, so a stale winner from the
  // previous hand could keep a seat lit. The deal check is part of the answer.
  const winSeat = anim.winnerSeat >= 0 ? anim.winnerSeat : sdWin && sdWin.dealId === dealKey ? sdWin.seat : -1;
  const winAmt = anim.winnerSeat >= 0 && anim.won > 0 ? CHIPS ? fmtChips(anim.won) : fmtMoney(anim.won) : null;
  // the winning combination's exact five cards · the UI highlights them and
  // dims everything else (board cards and winner holes that play no part)
  const winUsed = (() => {
    if (winSeat < 0 || !sdCards || !sdCards[winSeat]) return null;
    const ev = SP.handEval(sdCards[winSeat].concat(sdBoard));
    return ev && ev.used ? {
      seat: winSeat,
      set: new Set(ev.used)
    } : null;
  })();
  const myHoleObj = hand.inProgress || settleHold ? holes[dealKey] : null;
  const myHole = myHoleObj ? myHoleObj.cardsStr : null;
  // How many board cards this street owes, and whether any are still in flight.
  // The cards are decrypted co-operatively by the players and proven on-chain,
  // so there is a real (small) window where the street has opened and the card
  // has not landed. Naming that window is the difference between "the site is
  // broken" and "it is dealing".
  const boardDue = hand.inProgress ? hand.street === ST.FLOP ? 3 : hand.street === ST.TURN ? 4 : hand.street >= ST.RIVER ? 5 : 0 : 0;
  // Cards this tab already opened itself from the relayed shares (zk-agent.js),
  // ahead of the on-chain reveal. Each was checked against the on-chain
  // ciphertext commitment and every share against its sender's key, so this is
  // the same card the chain is about to publish — just ~5 blocks sooner. The
  // chain's copy always wins once it lands.
  const early = hand.inProgress && window.__SPZK && window.__SPZK.board ? window.__SPZK.board[dealKey] || null : null;
  const shownBoard = snap.board.slice();
  if (early) {
    for (let i = shownBoard.length; i < boardDue; i++) {
      if (early[i] === undefined) break; // contiguous only — never a gap in the row
      shownBoard.push(early[i]);
    }
  }
  // The LIVE board empties the instant the pot is awarded — so the winner used
  // to be announced over a bare felt, with the hand that won it already gone.
  // The frozen copy (sdBoard) rides the settle beat, like the open cards do.
  if (!shownBoard.length && settleHold && sdBoard.length) shownBoard.push(...sdBoard);
  const revealing = boardDue > shownBoard.length;
  const board = shownBoard.map(SP.intToCardStr);
  // combo label only from the flop · preflop "High Card" is pure noise for a
  // beginner ("why does it say ten-high before any cards are open?")
  // reads shownBoard, so the combo label appears together with the cards
  // instead of a beat later when the chain catches up
  const bestHand = myHoleObj && shownBoard.length >= 3 ? SP.handName(myHoleObj.cards.concat(shownBoard)) : "";
  const heroEval = bestHand ? SP.handEval(myHoleObj.cards.concat(shownBoard)) : null;

  // Blind-position markers (like the D button): HU → the button IS the small
  // blind; multiway → SB/BB are the next in-hand seats clockwise of the button.
  const {
    sbSeat,
    bbSeat
  } = (() => {
    const out = {
      sbSeat: -1,
      bbSeat: -1
    };
    if (!snap || !snap.hand.inProgress) return out;
    const ih = snap.seats.filter(x => !x.empty && x.inHand).map(x => x.index).sort((a, b) => a - b);
    if (ih.length < 2) return out;
    const btn = Number(snap.hand.button);
    const next = i => {
      const gt = ih.find(x => x > i);
      return gt !== undefined ? gt : ih[0];
    };
    if (ih.length === 2) {
      out.sbSeat = btn;
      out.bbSeat = next(btn);
    } else {
      out.sbSeat = next(btn);
      out.bbSeat = next(next(btn));
    }
    return out;
  })();
  const markerFor = idx => {
    if (!snap.hand.inProgress) return null;
    if (idx === Number(snap.hand.button)) return "dealer";
    if (idx === sbSeat) return "sb";
    if (idx === bbSeat) return "bb";
    return null;
  };
  // rotate so my seat sits at the bottom
  CHIPS = !!trn || ctl !== ZERO_CTL; // controller ≠ zero → chip units, even before the trn poll lands
  const mobileUI = window.innerWidth <= 760; // nowMs re-render keeps this fresh across rotations
  const POSSET = mobileUI ? POS_M : POS;
  const positions = !mobileUI && wrapBox && seatRing(maxSeats, wrapBox.w, wrapBox.h) // desktop: seats ON the measured rail
  || POSSET[maxSeats] || (maxSeats < 6 ? POSSET[6] : POSSET[9]);
  const view = i => mySeat >= 0 ? (i - mySeat + maxSeats) % maxSeats : i % maxSeats;
  const seatPos = i => positions[view(i)] || positions[0];
  const now = Math.floor(nowMs / 1000);
  const showdown = hand.inProgress && hand.street === ST.SHOWDOWN;
  const showdownView = showdown || sdHold; // reveals stay up through the settle

  // live big blind: tournament levels raise it mid-game while the table cfg is
  // cached · bb-counts must follow the CURRENT level, not the opening one
  const curBB = trn ? Number(trn.curBb) : NV(cfg.bigBlind);
  const bbOf = stack => curBB > 0 ? Math.round(NV(stack) / curBB * 10) / 10 : null;

  // tournament life-cycle screens (bust / final standings), derived each render
  // from the 5s tournament poll. A busted seat is vacated by reportBust, so
  // "registered + running + no seat anywhere" ⇔ I'm out and my place is final.
  const RUv = window.__SPLANG === "ru";
  const myAddrLc = addr ? addr.toLowerCase() : null;
  const trnFinished = !!(trn && trn.status >= 2);
  const trnBusted = !!(trn && trn.status === 1 && trn.reg && trn.myTable === -1 && mySeat < 0);
  const myBust = trn && trn.res && myAddrLc ? trn.res.busts.find(b => b.player.toLowerCase() === myAddrLc) : null;
  const standings = trn && trn.res ? (trn.res.winner ? [{
    player: trn.res.winner.player,
    place: 1,
    prize: trn.res.winner.prize
  }] : []).concat([...trn.res.busts].sort((a, b) => a.place - b.place)) : [];
  const iWonTrn = !!(trn && trn.res && trn.res.winner && myAddrLc && trn.res.winner.player.toLowerCase() === myAddrLc);
  const ordinal = n => {
    const s = ["th", "st", "nd", "rd"],
      v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };
  const medal = p => p === 1 ? "🥇" : p === 2 ? "🥈" : p === 3 ? "🥉" : null;
  // dismissals persist per tournament for the tab session · the screens must
  // not re-pop on every sibling table the player opens afterwards
  const seen = k => {
    try {
      return trn && sessionStorage.getItem(`sp_${k}seen_${trn.id}`) === "1";
    } catch {
      return false;
    }
  };
  const markSeen = k => {
    try {
      if (trn) sessionStorage.setItem(`sp_${k}seen_${trn.id}`, "1");
    } catch {}
  };

  // WHAT EVERYONE DID, FOR AS LONG AS IT MATTERS.
  // The badges used to evaporate after three seconds, which is shorter than a
  // single decision: by the time the action came back round to you, the felt
  // had forgotten that the player to your right had raised. A hand is the
  // natural life of this information — it is exactly what you are reading the
  // table for — so the last action stays on its seat until the next hand
  // begins, the way a live dealer leaves the bet in front of you.
  const ACT_LBL = {
    fold: "Fold",
    check: "Check",
    call: "Call",
    bet: "Bet",
    raise: "Raise",
    allin: "All-in"
  };
  const actFor = idx => {
    const a = lastActs[idx];
    if (!a || a.deal !== dealKey) return null; // never carry an action into the next hand
    if (a.kind === "fold") return (hand.inProgress || settleHold) && seats[idx] && seats[idx].folded ? a : null;
    return hand.inProgress || settleHold ? a : null;
  };
  const actLabel = a => SPT(ACT_LBL[a.kind]) + (a.amt ? " " + (CHIPS ? fmtChips(a.amt) : fmtMoney(a.amt)) : "");
  return /*#__PURE__*/React.createElement("div", {
    className: "scaler",
    id: "scaler"
  }, /*#__PURE__*/React.createElement("div", {
    className: "app",
    "data-dir": theme,
    "data-deck": deck,
    "data-anim": reducedMo ? "off" : "on",
    "data-turbo": prefs.turbo ? "1" : "0",
    "data-bigui": prefs.bigui ? "1" : "0"
  }, /*#__PURE__*/React.createElement("header", {
    className: "topbar"
  }, /*#__PURE__*/React.createElement("div", {
    className: "group"
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 8,
      cursor: "pointer"
    },
    title: "Back to lobby",
    onClick: () => location.href = "lobby"
  }, /*#__PURE__*/React.createElement(SparkLogo, {
    size: 24
  }), /*#__PURE__*/React.createElement("span", {
    className: "wordmark",
    style: {
      fontSize: 17
    }
  }, "shiny", /*#__PURE__*/React.createElement("span", {
    className: "accent"
  }, "poker")))), /*#__PURE__*/React.createElement("div", {
    className: "switcher"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => location.href = SP.POKER_CONFIG.casinoUrl
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot"
  }), "ShinyLuck"), /*#__PURE__*/React.createElement("button", {
    className: "on"
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot"
  }), "Poker")), /*#__PURE__*/React.createElement("div", {
    className: "sep"
  }), /*#__PURE__*/React.createElement("div", {
    className: "tableid"
  }, /*#__PURE__*/React.createElement("span", {
    className: "stakes"
  }, CHIPS ? /*#__PURE__*/React.createElement(ChipMark, {
    size: 14
  }) : /*#__PURE__*/React.createElement(SomiCoin, {
    size: 14
  }), /*#__PURE__*/React.createElement("b", {
    className: "tnum"
  }, CHIPS ? `${fmtChips(NV(cfg.smallBlind))} / ${fmtChips(NV(cfg.bigBlind))}` : `${NV(cfg.smallBlind)} / ${NV(cfg.bigBlind)}`)), /*#__PURE__*/React.createElement("span", {
    className: "sub"
  }, "NLHE \xB7 ", maxSeats, "-max \xB7 ", SPT("Hand"), " ", /*#__PURE__*/React.createElement("span", {
    className: "tnum"
  }, "#", hand.handId))), /*#__PURE__*/React.createElement("div", {
    className: "spacer"
  }), connected && mySeat >= 0 && !trn && /*#__PURE__*/React.createElement("button", {
    className: "topupbtn",
    disabled: busy,
    title: SPT("Add chips to your stack"),
    onClick: () => setModal({
      type: "topup",
      stack: NV(seats[mySeat].stack)
    })
  }, /*#__PURE__*/React.createElement("span", {
    className: "ic"
  }, ChromeIcons.plus), SPT("Top up")), /*#__PURE__*/React.createElement("button", {
    className: "iconbtn",
    title: SPT("Settings"),
    onClick: () => setShowSettings(s => !s)
  }, ChromeIcons.gear), connected && mySeat >= 0 && (trn ? /*#__PURE__*/React.createElement("button", {
    className: "iconbtn leavebtn",
    title: SPT("Back to tournament"),
    disabled: busy,
    onClick: () => location.href = "tournament?id=" + trn.id
  }, ChromeIcons.leave) : /*#__PURE__*/React.createElement("button", {
    className: "iconbtn leavebtn" + (leaving ? " pending" : ""),
    title: leaving ? SPT("Leaving after this hand · click to stay") : SPT("Leave table"),
    onClick: () => leaving ? cancelLeave() : startLeave()
  }, ChromeIcons.leave))), showSettings && /*#__PURE__*/React.createElement(SettingsPanel, {
    t: prefs,
    set: setPref,
    dir: theme,
    setDir: setTheme,
    onClose: () => setShowSettings(false),
    seat: connected && mySeat >= 0 ? {
      sittingOut: seats[mySeat].sittingOut,
      busy,
      toggle: () => tx(seats[mySeat].sittingOut ? "Sit in" : "Sit out", () => SP.sdk.sitOut(tableId, !seats[mySeat].sittingOut))
    } : null,
    session: null /* Privy-only → always headless; no session key to manage */
  }), trn && (() => {
    const lsb = Number(trn.curSb),
      lbb = Number(trn.curBb),
      lante = Number(trn.curAnte || 0);
    const nextIn = trn.nextAt ? Math.max(0, trn.nextAt - now) : null;
    const mm = nextIn != null ? Math.floor(nextIn / 60) : 0,
      ss = nextIn != null ? String(nextIn % 60).padStart(2, "0") : "00";
    const multi = trn.tables && trn.tables.length > 1;
    return /*#__PURE__*/React.createElement("div", {
      className: "trn-hud"
    }, /*#__PURE__*/React.createElement("span", {
      className: "tag"
    }, SPT("TOURNAMENT"), " \xB7 ", multi ? "MTT" : "SNG", " #", trn.id), /*#__PURE__*/React.createElement("span", null, SPT("Level"), " ", /*#__PURE__*/React.createElement("b", {
      className: "tnum"
    }, trn.level + 1)), /*#__PURE__*/React.createElement("span", null, SPT("Blinds"), " ", /*#__PURE__*/React.createElement("b", {
      className: "tnum"
    }, fmtChips(lsb), " / ", fmtChips(lbb), lante ? ` (${SPT("ante")} ${fmtChips(lante)})` : "")), trn.status === 1 && nextIn != null && nextIn > 0 && /*#__PURE__*/React.createElement("span", null, SPT("Next level"), " ", /*#__PURE__*/React.createElement("b", {
      className: "tnum"
    }, mm, ":", ss)), trn.status === 1 && nextIn != null && nextIn === 0 && /*#__PURE__*/React.createElement("span", {
      className: "tag"
    }, SPT("Level up between hands")), trn.status === 1 && nextIn == null && /*#__PURE__*/React.createElement("span", {
      className: "tag"
    }, SPT("Final level")), /*#__PURE__*/React.createElement("span", null, SPT("Players"), " ", /*#__PURE__*/React.createElement("b", {
      className: "tnum"
    }, trn.remaining, "/", trn.registered)), /*#__PURE__*/React.createElement("span", null, SPT("Prize"), " ", /*#__PURE__*/React.createElement("b", {
      className: "tnum"
    }, Number(SP.fmt(trn.pool, 4)), " ", SP.NETWORK.currency.symbol)), /*#__PURE__*/React.createElement("span", null, SPT("Split"), " ", /*#__PURE__*/React.createElement("b", {
      className: "tnum"
    }, trn.payoutBps.map(b => b / 100 + "%").join(" / "))), multi && /*#__PURE__*/React.createElement("span", {
      style: {
        display: "inline-flex",
        gap: 6,
        alignItems: "center"
      }
    }, trn.tables.map((tid, i) => /*#__PURE__*/React.createElement("button", {
      key: tid,
      onClick: () => switchTable(tid),
      title: tid === tableId ? null : SPT("Switch to this table"),
      style: {
        cursor: tid === tableId ? "default" : "pointer",
        fontFamily: "var(--mono)",
        fontSize: 11,
        padding: "3px 9px",
        borderRadius: 999,
        border: "1px solid " + (tid === tableId ? "var(--accent, #D9B970)" : "var(--line-2, rgba(255,255,255,0.14))"),
        background: tid === tableId ? "var(--accent-12, rgba(217,185,112,.12))" : "transparent",
        color: tid === tableId ? "var(--accent-soft, #F4DD9E)" : "var(--muted, #8F8C85)"
      }
    }, SPT("Table"), " ", i + 1, trn.counts && trn.counts[tid] != null ? ` · ${trn.counts[tid]}` : ""))), trn.status === 2 && /*#__PURE__*/React.createElement("span", {
      className: "done"
    }, SPT("FINISHED")));
  })(), /*#__PURE__*/React.createElement("div", {
    className: "mainrow"
  }, /*#__PURE__*/React.createElement("div", {
    className: "feltwrap scanlines",
    ref: feltWrapRef
  }, /*#__PURE__*/React.createElement("div", {
    className: "feltglow"
  }), /*#__PURE__*/React.createElement("div", {
    className: "felt"
  }, /*#__PURE__*/React.createElement("div", {
    className: "feltmark",
    "aria-hidden": "true",
    "data-no-i18n": true
  }, /*#__PURE__*/React.createElement(SparkMark, {
    className: "fm-spark"
  }), /*#__PURE__*/React.createElement("span", {
    className: "fm-word"
  }, "SHINYLUCK")), /*#__PURE__*/React.createElement("div", {
    className: "center"
  }, anim.dealing && /*#__PURE__*/React.createElement("span", {
    className: "zkbadge shuffling"
  }, /*#__PURE__*/React.createElement("span", {
    className: "chk"
  }, ChromeIcons.shield), SPT("shuffling · commitment sealed on-chain")), /*#__PURE__*/React.createElement(Board, {
    cards: board,
    deckMode: deck,
    flipFrom: anim.flipFrom,
    due: boardDue,
    dim: winUsed ? shownBoard.map(c => !winUsed.set.has(c)) : null
  }), revealing && /*#__PURE__*/React.createElement("div", {
    className: "revealnote"
  }, SPT("Revealing")), hand.inProgress ? /*#__PURE__*/React.createElement(Pot, {
    pot: NV(hand.pot),
    chips: CHIPS
  }) : anim.winnerSeat >= 0 || sdWin ? null : /*#__PURE__*/React.createElement("div", {
    className: "pot"
  }, /*#__PURE__*/React.createElement("div", {
    className: "potmain"
  }, /*#__PURE__*/React.createElement("span", {
    className: "k"
  }, seats.filter(s => !s.empty && !s.sittingOut).length >= 2 ? SPT("Next hand starting…") /* players ARE here · we're waiting on the dealer, say so */ : SPT("Waiting for players"))))), (anim.winnerSeat >= 0 || sdWin) && (() => {
    const settled = anim.winnerSeat >= 0;
    const wSeat = settled ? anim.winnerSeat : sdWin.seat;
    const rvW = sdCards && sdCards[wSeat];
    const comboEn = rvW ? SP.handName(rvW.concat(sdBoard)) : sdWin && sdWin.seat === wSeat ? sdWin.comboEn : null;
    // "You win" must mean YOU. `mySeat` is -1 for anyone not in a
    // seat — a busted player watching the rest of the tournament, a
    // spectator, someone who just walked up — and -1 === -1 made the
    // banner congratulate every one of them on a pot they had no
    // part in. The name is now always supplied when it wasn't us, so
    // the banner can never fall through to "You win" by accident.
    const iWon = mySeat >= 0 && mySeat === wSeat;
    const played = mySeat >= 0 && !!holes[dealKey]; // I was dealt into this hand
    const wName = seats[wSeat] && !seats[wSeat].empty ? nameOf(seats[wSeat].player) : `${SPT("Seat")} ${wSeat}`;
    return /*#__PURE__*/React.createElement(WinBanner, {
      won: settled ? CHIPS ? fmtChips(anim.won) : fmtMoney(anim.won) : null,
      lose: played && !iWon,
      name: iWon ? null : wName,
      pending: !settled,
      unit: CHIPS ? SPT("chips") : "SOMI",
      hand: comboEn ? SPTHand(comboEn) : ""
    });
  })()), /*#__PURE__*/React.createElement("div", {
    className: "feltvignette"
  }), hand.inProgress && seats.map(s => {
    if (s.empty || s.index === mySeat) return null;
    if (showdown && sdCards && sdCards[s.index]) return null; // flipped up in the Seat
    // driven by foldFx's own 760ms timer, not by the 1s clock tick
    const mucking = !s.inHand && !!foldFx[s.index];
    if (!s.inHand && !mucking) return null;
    const pos = seatPos(s.index);
    return /*#__PURE__*/React.createElement(HoleBacks, {
      key: "b" + s.index,
      pos: pos,
      deal: anim.dealing && s.inHand && !showdown,
      delay: 300 + s.index * 120,
      muck: mucking,
      mx: (50 - pos.x) * 4,
      my: (43 - pos.y) * 5
    });
  }), seats.map(s => {
    if (s.index === mySeat) return null; // hero is shown in the herozone
    const pos = seatPos(s.index);
    if (s.empty) {
      if (trn || ctl !== ZERO_CTL) return null; // tournament seats are managed by the tournament
      return /*#__PURE__*/React.createElement("div", {
        key: s.index,
        className: "seat",
        style: {
          left: pos.x + "%",
          top: pos.y + "%"
        }
      }, /*#__PURE__*/React.createElement("button", {
        className: "emptyseat",
        onClick: () => connected ? setModal({
          type: "sit",
          seat: s.index
        }) : connect()
      }, /*#__PURE__*/React.createElement("span", {
        className: "plus"
      }, "+"), /*#__PURE__*/React.createElement("span", null, connected ? SPT("Sit") : SPT("Connect"))));
    }
    const isMe = s.index === mySeat;
    const active = hand.inProgress && hand.actingSeat === s.index && hand.street <= ST.RIVER;
    const rev = showdownView && sdCards && sdCards[s.index] ? sdCards[s.index].map(SP.intToCardStr) : null;
    return /*#__PURE__*/React.createElement(Seat, {
      key: s.index,
      player: {
        hero: isMe,
        name: nameOf(s.player),
        avId: avOf(s.player).id,
        avImg: avOf(s.player).img
      },
      data: {
        stack: NV(s.stack),
        bbstacks: prefs.bbstacks,
        bbval: bbOf(s.stack),
        ...(CHIPS ? {
          chips: NV(s.stack),
          bb: Math.max(0, Math.round(NV(s.stack) / Math.max(1, curBB)))
        } : {}),
        // "WAITING" under a seat the instant a hand ends is both
        // untrue (nobody is waiting, the hand is over) and, sat
        // under a green glow, it reads as WINNING. The result beat
        // owns the seats; ordinary states resume with the next hand.
        status: settleHold ? "" : s.allIn ? SPT("all-in") : s.folded ? SPT("folded") : s.sittingOut ? SPT("sitting out") : hand.inProgress && s.inHand ? "" : SPT("waiting"),
        folded: s.folded,
        allin: s.allIn,
        winner: winSeat >= 0 && s.index === winSeat,
        // Everyone who did NOT win steps back for the result beat,
        // so the winner is the only lit thing on the felt and does
        // not have to be identified by reading a line of text.
        dimmed: settleHold && winSeat >= 0 && s.index !== winSeat,
        won: winSeat >= 0 && s.index === winSeat ? winAmt : null,
        timer: Number(cfg.actionTimeout),
        combo: rev ? SPTHand(SP.handName(sdCards[s.index].concat(sdBoard))) : null,
        comboCat: rev ? (SP.handEval(sdCards[s.index].concat(sdBoard)) || {}).cat : null,
        lastAct: actFor(s.index) ? {
          kind: lastActs[s.index].kind,
          text: actLabel(lastActs[s.index])
        } : null
      },
      pos: pos,
      active: active,
      marker: markerFor(s.index),
      deckMode: deck,
      revealCards: rev,
      revealAnim: !reducedMo,
      revealDim: rev && winUsed && winUsed.seat === s.index ? sdCards[s.index].map(c => !winUsed.set.has(c)) : null
    });
  }), hand.inProgress && seats.map(s => !s.empty && s.committedStreet > 0n ? /*#__PURE__*/React.createElement(BetChips, {
    key: "c" + s.index,
    pos: seatPos(s.index),
    amount: NV(s.committedStreet),
    chips: CHIPS,
    slide: !reducedMo,
    fromSeat: true
  }) : null), mySeat >= 0 && /*#__PURE__*/React.createElement("div", {
    className: "herozone"
  }, (hand.inProgress && (seats[mySeat].inHand || seats[mySeat].folded) || settleHold && myHole) && /*#__PURE__*/React.createElement("div", {
    className: "hole peek" + (foldFx[mySeat] ? " muck" : "")
  }, myHole ? myHole.map((c, i) => /*#__PURE__*/React.createElement(Card, {
    key: dealKey + i,
    c: c,
    folded: seats[mySeat].folded,
    dim: !!(winUsed && winUsed.seat === mySeat && myHoleObj && !winUsed.set.has(myHoleObj.cards[i])),
    className: heroDealing ? "deal" : "",
    style: heroDealing ? {
      "--dy": "-220px",
      "--dr": (i ? 4 : -2) + "deg",
      animationDelay: i * 80 + "ms"
    } : undefined
  })) : seats[mySeat].inHand ? [/*#__PURE__*/React.createElement(Card, {
    key: "0",
    back: true
  }), /*#__PURE__*/React.createElement(Card, {
    key: "1",
    back: true
  })] : null), myHole && bestHand && !seats[mySeat].folded && /*#__PURE__*/React.createElement("div", {
    className: "herocombo",
    style: heroEval ? comboStyle(heroEval.cat) : undefined
  }, SPTHand(bestHand)), /*#__PURE__*/React.createElement("div", {
    className: "heroinfo" + (hand.inProgress && hand.actingSeat === mySeat ? " active" : "") + (seats[mySeat].allIn ? " allin" : "") + (seats[mySeat].folded ? " folded" : "") + (seats[mySeat].sittingOut ? " sitout" : "") + (winSeat === mySeat ? " winner" : "") + (settleHold && winSeat >= 0 && winSeat !== mySeat ? " dimmed" : "")
  }, winSeat === mySeat && /*#__PURE__*/React.createElement("span", {
    className: "crown",
    "aria-hidden": "true"
  }, "\uD83D\uDC51"), seats[mySeat].sittingOut && /*#__PURE__*/React.createElement("button", {
    className: "sitinseat",
    disabled: busy,
    title: SPT("Sit in"),
    onClick: () => tx("Sit in", () => SP.sdk.sitOut(tableId, false))
  }, SPT("SIT IN")), /*#__PURE__*/React.createElement(AvatarIcon, {
    av: avOf(addr).id,
    img: avOf(addr).img,
    name: nameOf(addr)
  }), /*#__PURE__*/React.createElement("div", {
    className: "meta"
  }, /*#__PURE__*/React.createElement("span", {
    className: "nm"
  }, "YOU \xB7 ", nameOf(addr)), /*#__PURE__*/React.createElement("span", {
    className: "stack tnum"
  }, prefs.bbstacks && bbOf(seats[mySeat].stack) != null ? /*#__PURE__*/React.createElement(React.Fragment, null, bbOf(seats[mySeat].stack), /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, "BB")) : /*#__PURE__*/React.createElement(React.Fragment, null, CHIPS ? /*#__PURE__*/React.createElement(ChipMark, {
    size: 15
  }) : /*#__PURE__*/React.createElement(SomiCoin, {
    size: 15
  }), CHIPS ? fmtChips(NV(seats[mySeat].stack)) : fmtMoney(NV(seats[mySeat].stack))))), /*#__PURE__*/React.createElement("div", {
    className: "hmark"
  }, markerFor(mySeat) && /*#__PURE__*/React.createElement(Marker, {
    kind: markerFor(mySeat)
  })), winSeat === mySeat ? /*#__PURE__*/React.createElement("span", {
    className: "wonchip"
  }, winAmt ? "+" + winAmt : SPT("WINNER")) : actFor(mySeat) ? /*#__PURE__*/React.createElement("span", {
    className: "actchip inbar " + lastActs[mySeat].kind
  }, actLabel(lastActs[mySeat])) : /*#__PURE__*/React.createElement("span", {
    className: "hstatus"
  }, settleHold ? "" : seats[mySeat].allIn ? SPT("all-in") : seats[mySeat].folded ? SPT("folded") : seats[mySeat].sittingOut ? SPT("sitting out") : ""))), anim.winnerSeat >= 0 && !reducedMo && /*#__PURE__*/React.createElement(FlyChips, {
    wrapRef: feltWrapRef,
    toX: seatPos(anim.winnerSeat).x,
    toY: seatPos(anim.winnerSeat).y
  }), potFly && hand.inProgress && potFly.idxs.map((i, k) => {
    const p = seatPos(i);
    const from = potFly.kind === "sweep" ? {
      x: p.x + (50 - p.x) * 0.34,
      y: p.y + (46 - p.y) * 0.34
    } // bet-chip spot
    : {
      x: p.x,
      y: p.y
    }; // ante: straight from the seat
    return /*#__PURE__*/React.createElement(FlyToPot, {
      key: potFly.ts + "-" + i,
      wrapRef: feltWrapRef,
      fromX: from.x,
      fromY: from.y,
      delay: k * 60
    });
  })), /*#__PURE__*/React.createElement("button", {
    className: "railfab",
    title: SPT("chat"),
    onClick: () => setRailOpen(true)
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.8"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M21 12a8 8 0 0 1-8 8H4l2.2-2.6A8 8 0 1 1 21 12z"
  }))), /*#__PURE__*/React.createElement(LiveSideRail, {
    key: tableId,
    tableId: tableId,
    snap: snap,
    connected: connected,
    mySeat: mySeat,
    mobileOpen: railOpen,
    onClose: () => setRailOpen(false),
    nameOf: nameOf
  })), /*#__PURE__*/React.createElement("div", {
    className: "barwrap" + (revealing ? " revealing" : "")
  }, renderBar()), movedTo != null && /*#__PURE__*/React.createElement("div", {
    className: "lt-modalbg",
    style: {
      zIndex: 340
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "lt-modal",
    style: {
      width: "min(430px, 92vw)",
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 34,
      lineHeight: 1
    }
  }, "\uD83D\uDD00"), /*#__PURE__*/React.createElement("h3", {
    style: {
      marginTop: 10
    }
  }, RUv ? "Вас пересадили за другой стол" : "You've been moved to another table"), /*#__PURE__*/React.createElement("p", {
    className: "note"
  }, RUv ? `Балансировка столов: ваше место теперь за столом #${movedTo}. Сейчас перенесём…` : `Table balancing: your seat is now at table #${movedTo}. Taking you there…`), /*#__PURE__*/React.createElement("button", {
    className: "pill primary",
    style: {
      width: "100%",
      marginTop: 10
    },
    onClick: () => switchTable(movedTo)
  }, RUv ? "Перейти сейчас →" : "Go now →"))), trnBusted && !bustHidden && !seen("bust") && movedTo == null && /*#__PURE__*/React.createElement("div", {
    className: "lt-modalbg",
    style: {
      zIndex: 320
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "lt-modal",
    style: {
      width: "min(440px, 92vw)",
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 36,
      lineHeight: 1
    }
  }, myBust && myBust.prize > 0n ? "💰" : "🃏"), /*#__PURE__*/React.createElement("h3", {
    style: {
      marginTop: 10
    }
  }, RUv ? "Вы выбыли из турнира" : "You're out of the tournament"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--mono)",
      fontSize: 21,
      color: "var(--accent-soft, #F4DD9E)",
      margin: "4px 0 6px"
    }
  }, myBust ? RUv ? `${myBust.place}-е место из ${trn.registered}` : `${ordinal(myBust.place)} of ${trn.registered}` : RUv ? "Определяем ваше место…" : "Finalizing your place…"), myBust && myBust.prize > 0n ? /*#__PURE__*/React.createElement("p", {
    className: "note",
    style: {
      color: "var(--win, #57d9a3)"
    }
  }, RUv ? `Приз ${N(myBust.prize)} ${SP.NETWORK.currency.symbol} уже зачислен на ваш баланс в кассе.` : `Prize ${N(myBust.prize)} ${SP.NETWORK.currency.symbol} · already credited to your Cashier balance.`) : /*#__PURE__*/React.createElement("p", {
    className: "note"
  }, RUv ? "В этот раз без приза · удачи в следующем!" : "No prize this time · better luck in the next one!"), /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      marginTop: 14
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "pill",
    onClick: () => {
      markSeen("bust");
      setBustHidden(true);
    }
  }, RUv ? "Наблюдать финал" : "Watch the finish"), /*#__PURE__*/React.createElement("button", {
    className: "pill primary",
    onClick: () => {
      markSeen("bust");
      location.href = "tournament?id=" + trn.id;
    }
  }, RUv ? "К турниру" : "Tournament page")), /*#__PURE__*/React.createElement("button", {
    className: "pill",
    style: {
      width: "100%",
      marginTop: 8
    },
    onClick: () => location.href = "lobby"
  }, RUv ? "В лобби" : "Back to lobby"))), trnFinished && !finalHidden && !seen("final") && standings.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "lt-modalbg",
    style: {
      zIndex: 320
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "lt-modal",
    style: {
      width: "min(520px, 94vw)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      fontSize: 36,
      lineHeight: 1
    }
  }, "\uD83C\uDFC6"), /*#__PURE__*/React.createElement("h3", {
    style: {
      textAlign: "center",
      marginTop: 10
    }
  }, iWonTrn ? RUv ? "Поздравляем · вы выиграли турнир!" : "Congratulations · you won the tournament!" : RUv ? "Турнир завершён" : "Tournament finished"), trn.res.winner && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      fontFamily: "var(--mono)",
      fontSize: 14.5,
      color: "var(--accent-soft, #F4DD9E)",
      marginBottom: 12
    }
  }, RUv ? "Победитель" : "Winner", ": ", /*#__PURE__*/React.createElement("b", null, nameOf(trn.res.winner.player)), " \xB7 ", N(trn.res.winner.prize), " ", SP.NETWORK.currency.symbol), /*#__PURE__*/React.createElement("div", {
    style: {
      maxHeight: 280,
      overflowY: "auto",
      border: "1px solid var(--line-2, rgba(255,255,255,0.14))",
      borderRadius: 10
    }
  }, standings.map((r, i) => {
    const me = myAddrLc && r.player.toLowerCase() === myAddrLc;
    return /*#__PURE__*/React.createElement("div", {
      key: r.place,
      style: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "7px 12px",
        borderTop: i === 0 ? "none" : "1px solid var(--hair, rgba(255,255,255,.06))",
        background: me ? "var(--accent-12, rgba(217,185,112,.12))" : r.place <= 3 ? "rgba(217,185,112,.05)" : "transparent"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        width: 36,
        fontFamily: "var(--mono)",
        fontSize: 13,
        color: r.place <= 3 ? "var(--accent-soft, #F4DD9E)" : "var(--muted, #8F8C85)"
      }
    }, medal(r.place) || "#" + r.place), /*#__PURE__*/React.createElement(AvatarIcon, {
      av: avOf(r.player).id,
      img: avOf(r.player).img,
      name: nameOf(r.player),
      size: 22,
      style: {
        borderRadius: 6
      }
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        fontFamily: "var(--mono)",
        fontSize: 13,
        color: "var(--text, #e6e6ee)"
      }
    }, nameOf(r.player), me ? RUv ? " · вы" : " · you" : ""), /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: "var(--mono)",
        fontSize: 13,
        color: r.prize > 0n ? "var(--win, #57d9a3)" : "var(--muted, #8F8C85)"
      }
    }, r.prize > 0n ? `+${N(r.prize)} ${SP.NETWORK.currency.symbol}` : "-"));
  })), /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      marginTop: 14
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "pill",
    onClick: () => {
      markSeen("final");
      setFinalHidden(true);
    }
  }, RUv ? "Посмотреть стол" : "View the table"), /*#__PURE__*/React.createElement("button", {
    className: "pill primary",
    onClick: () => {
      markSeen("final");
      location.href = "lobby";
    }
  }, RUv ? "В лобби" : "Back to lobby")))), toast && /*#__PURE__*/React.createElement("div", {
    className: "lt-toast"
  }, toast), modal && /*#__PURE__*/React.createElement(Modal, {
    kind: modal,
    close: () => setModal(null),
    sdk: SP.sdk,
    tableId: tableId,
    cfg: cfg,
    bal: bal,
    tx: tx,
    refresh: refreshBal
  })));
  function renderBar() {
    if (!connected) return /*#__PURE__*/React.createElement(StatusStrip, {
      text: SPT("Sign in to play"),
      sub: SPT("Email login → instant Somnia wallet, no popups"),
      accent: "var(--accent-soft)"
    });
    if (mySeat < 0) {
      if (trnBusted) return /*#__PURE__*/React.createElement(StatusStrip, {
        text: RUv ? "Вы выбыли · наблюдаете" : "You're out · observing",
        sub: myBust ? RUv ? `${myBust.place}-е место из ${trn.registered}` : `You finished ${ordinal(myBust.place)} of ${trn.registered}` : "",
        accent: "var(--muted)"
      });
      // spying on a sibling MTT table while my own seat lives elsewhere
      if (trn && trn.status === 1 && trn.reg && trn.myTable >= 0 && trn.myTable !== tableId) {
        return /*#__PURE__*/React.createElement("div", {
          className: "actionbar",
          style: {
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 8
          }
        }, /*#__PURE__*/React.createElement("div", {
          style: {
            fontFamily: "var(--label)",
            fontSize: 13,
            letterSpacing: ".1em",
            textTransform: "uppercase",
            color: "var(--accent-soft)"
          }
        }, RUv ? `Здесь вы наблюдаете · ваше место за столом #${trn.myTable}` : `You're observing · your seat is at table #${trn.myTable}`), /*#__PURE__*/React.createElement("button", {
          className: "pill",
          onClick: () => switchTable(trn.myTable)
        }, RUv ? "К своему столу →" : "Back to my table →"));
      }
      return trn || ctl !== ZERO_CTL ? /*#__PURE__*/React.createElement(StatusStrip, {
        text: SPT("Tournament table · you're observing"),
        sub: SPT("Seats are assigned by the tournament; register on its page to play"),
        accent: "var(--muted)"
      }) : /*#__PURE__*/React.createElement(StatusStrip, {
        text: SPT("Take an empty seat to join"),
        sub: SPT("Click a “+ Sit” spot around the table"),
        accent: "var(--muted)"
      });
    }
    const me = seats[mySeat];
    const myTurn = hand.inProgress && hand.actingSeat === mySeat && hand.street <= ST.RIVER;
    // action already sent · hide the buttons instantly instead of leaving them
    // greyed-out until the snapshot confirms the turn moved on
    if (myTurn && pendingAct && pendingAct.dealId === dealKey && pendingAct.street === hand.street) {
      return /*#__PURE__*/React.createElement(StatusStrip, {
        text: SPT("Action sent") + " ✓",
        sub: SPT("Confirming on-chain…"),
        accent: "var(--accent-soft)"
      });
    }
    if (!myTurn) {
      // Sitting out used to read as "Waiting for the next hand" · identical to
      // a normal wait, so a player dealt out at the start of a tournament just
      // saw a table that never included them. Name the state and put the way
      // back into the same strip.
      if (me.sittingOut) {
        return /*#__PURE__*/React.createElement("div", {
          className: "actionbar",
          style: {
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 8
          }
        }, /*#__PURE__*/React.createElement("div", {
          style: {
            fontFamily: "var(--label)",
            fontSize: 13,
            letterSpacing: ".1em",
            textTransform: "uppercase",
            color: "var(--accent)"
          }
        }, SPT("You're sitting out")), /*#__PURE__*/React.createElement("div", {
          style: {
            fontFamily: "var(--body)",
            fontSize: 12.5,
            color: "var(--muted)"
          }
        }, SPT("You won't be dealt into hands until you sit back in")), /*#__PURE__*/React.createElement("button", {
          className: "pill primary",
          disabled: busy,
          onClick: () => tx("Sit in", () => SP.sdk.sitOut(tableId, false))
        }, SPT("Sit in")));
      }
      const text = hand.inProgress ? hand.street === ST.SHOWDOWN ? SPT("Showdown · settling on-chain") : SPT("Waiting for your turn") : SPT("Waiting for the next hand");
      const showPre = hand.inProgress && me.inHand && !me.folded && !me.allIn && hand.street <= ST.RIVER;
      // Waiting is most of a hand, so the panel that fills it is worth as much
      // care as the acting one: same card, same rhythm, and it says what your
      // hand is while you wait rather than leaving the space blank.
      if (!showPre) {
        return /*#__PURE__*/React.createElement("div", {
          className: "actionbar"
        }, /*#__PURE__*/React.createElement("div", {
          className: "actbar narrow waiting"
        }, /*#__PURE__*/React.createElement("div", {
          className: "waitline"
        }, text)));
      }
      return /*#__PURE__*/React.createElement("div", {
        className: "actionbar"
      }, /*#__PURE__*/React.createElement("div", {
        className: "actbar prebar"
      }, /*#__PURE__*/React.createElement("div", {
        className: "prehead"
      }, /*#__PURE__*/React.createElement("span", {
        className: "ttl"
      }, SPT("Pre-select your move")), bestHand && !me.folded && /*#__PURE__*/React.createElement("span", {
        className: "youhave"
      }, /*#__PURE__*/React.createElement("span", {
        className: "k"
      }, SPT("Best")), /*#__PURE__*/React.createElement("b", null, SPTHand(bestHand)))), /*#__PURE__*/React.createElement("div", {
        className: "actrow actions"
      }, [["checkfold", SPT("Check") + " / " + SPT("Fold")], ["callany", SPT("Call") + " " + (window.__SPLANG === "ru" ? "всегда" : "Any")], ["check", SPT("Check")]].map(([k, l]) =>
      /*#__PURE__*/
      // The armed state is the gold fill, NOT a "✓ " prefix: the prefix
      // made the button wider, which slid its neighbours sideways — so
      // the tap meant to CANCEL an armed pre-action landed on the next
      // one and armed that instead. Same label, same width, always.
      React.createElement("button", {
        key: k,
        className: "abtn pre" + (preAct === k ? " armed" : ""),
        "aria-pressed": preAct === k,
        onClick: () => setPreAct(preAct === k ? null : k)
      }, /*#__PURE__*/React.createElement("span", {
        className: "lbl"
      }, l)))), /*#__PURE__*/React.createElement("div", {
        className: "waitline"
      }, preAct ? SPT("Pre-action armed · fires instantly on your turn") : text)));
    }
    const cur = hand.currentBet,
      committed = me.committedStreet;
    const toCallW = cur > committed ? cur - committed : 0n;
    const minRaiseToW = cur === 0n ? cfg.bigBlind : cur + hand.minRaise;
    // EFFECTIVE-STACK cap: never offer sizes beyond what any live opponent can
    // actually match · betting 10k into a lone 7k stack is legal on-chain (the
    // excess comes back) but reads wrong at the table, so the UI caps at the
    // biggest opponent's street total instead.
    const opps = seats.filter(s => !s.empty && s.index !== mySeat && s.inHand && !s.folded);
    const effCapW = opps.reduce((m, s) => {
      const v = s.committedStreet + s.stack;
      return v > m ? v : m;
    }, 0n);
    // Chips only matter if SOMEONE can still put more in. An opponent who is
    // already all-in has nothing left to match, so raising past the current bet
    // can only hand the excess straight back to me · offering a 10k shove at a
    // lone all-in short stack is the table asking for a bet that cannot exist.
    const raisableW = opps.reduce((m, s) => {
      if (s.allIn || s.stack === 0n) return m;
      const v = s.committedStreet + s.stack;
      return v > m ? v : m;
    }, 0n);
    const myMaxW = committed + me.stack;
    const maxToW = effCapW > 0n && effCapW < myMaxW ? effCapW > minRaiseToW ? effCapW : minRaiseToW < myMaxW ? minRaiseToW : myMaxW : myMaxW;
    // the call NEVER costs more than my stack · an over-shove call is an all-in
    const callW = toCallW < me.stack ? toCallW : me.stack;
    const minN = NV(minRaiseToW),
      maxN = NV(maxToW),
      call = NV(callW),
      pot = NV(hand.pot);
    const canCheck = toCallW === 0n;
    const isBet = cur === 0n;
    const callIsAllIn = !canCheck && toCallW >= me.stack;
    const canRaise = me.stack > toCallW && maxToW > cur && maxN > minN && raisableW > cur;
    const bv = Math.min(maxN, Math.max(minN, betValue || minN));

    // A CLICK MUST SEND WHAT THE PLAYER SAW.
    // One button carries both CHECK and CALL (its label swaps in place), and the
    // bar itself swaps shape when a raise stops being possible. A snapshot that
    // lands between the eye and the finger therefore used to turn a check into a
    // call — silently, irreversibly, for real money. The same hole swallowed the
    // second tap of an impatient double-click: it landed on the NEXT turn's bar,
    // where that position meant something else entirely.
    // So the bar's meaning is stamped with the moment it last changed, and a
    // click that arrives before the player could have read it is refused and
    // explained instead of being executed as a different action. Folding is
    // guarded too — a mis-tap that folds a made hand costs just as much.
    const turnKey = `${dealKey}:${hand.street}:${hand.actingDeadline}`;
    const meaning = `${canCheck ? "check" : callIsAllIn ? "allin" : "call:" + call}|${canRaise ? "raise" : "-"}`;
    const g = barGuardRef.current;
    if (g.turn !== turnKey || g.meaning !== meaning) barGuardRef.current = {
      turn: turnKey,
      meaning,
      since: Date.now()
    };
    const GUARD_MS = 600;
    const settled = () => {
      if (Date.now() - barGuardRef.current.since >= GUARD_MS) return true;
      flash(window.__SPLANG === "ru" ? "Стол только что изменился — посмотрите и нажмите ещё раз" : "The table just changed — check it and press again", 2600);
      return false;
    };
    const onFold = () => {
      if (settled()) act(A.FOLD);
    };
    const onCheckCall = () => {
      if (settled()) act(canCheck ? A.CHECK : callIsAllIn ? A.ALLIN : A.CALL);
    };
    const onRaise = v => {
      if (settled()) act(isBet ? A.BET : A.RAISE, Math.min(maxN, Math.max(minN, v)));
    };
    if (!canRaise) {
      const secs = Math.max(0, hand.actingDeadline - now);
      const pct = Math.max(0, Math.min(1, secs / (Number(cfg.actionTimeout) || 30)));
      return /*#__PURE__*/React.createElement("div", {
        className: "actionbar"
      }, /*#__PURE__*/React.createElement("div", {
        className: "actbar narrow" + (secs <= 8 ? " urgent" : "")
      }, /*#__PURE__*/React.createElement("div", {
        className: "acttimer"
      }, /*#__PURE__*/React.createElement("i", {
        style: {
          width: pct * 100 + "%"
        }
      })), /*#__PURE__*/React.createElement("div", {
        className: "actrow actions"
      }, /*#__PURE__*/React.createElement("button", {
        className: "abtn fold",
        disabled: busy,
        onClick: onFold
      }, /*#__PURE__*/React.createElement("span", {
        className: "key"
      }, "F"), /*#__PURE__*/React.createElement("span", {
        className: "lbl"
      }, SPT("Fold"))), /*#__PURE__*/React.createElement("button", {
        className: "abtn call",
        disabled: busy,
        onClick: onCheckCall
      }, /*#__PURE__*/React.createElement("span", {
        className: "key"
      }, "C"), /*#__PURE__*/React.createElement("span", {
        className: "lbl"
      }, canCheck ? SPT("Check") : callIsAllIn ? SPT("All-in") : SPT("Call")), !canCheck && /*#__PURE__*/React.createElement("span", {
        className: "amt tnum"
      }, fmtMoney(call))), me.stack > 0n && !canCheck && !callIsAllIn && raisableW > cur && /*#__PURE__*/React.createElement("button", {
        className: "abtn allin",
        disabled: busy,
        onClick: () => {
          if (settled()) act(A.ALLIN);
        }
      }, /*#__PURE__*/React.createElement("span", {
        className: "lbl"
      }, SPT("All-in")), /*#__PURE__*/React.createElement("span", {
        className: "amt tnum"
      }, fmtMoney(NV(effCapW > 0n && effCapW < myMaxW ? effCapW : myMaxW)))))));
    }
    const actionData = {
      toCall: call,
      minRaise: minN,
      potForBet: pot,
      heroStack: maxN,
      chips: CHIPS,
      best: SPTHand(bestHand) || "-",
      outs: "-",
      potOdds: canCheck ? "-" : Math.round(call / (pot + call) * 100) + "%",
      raiseLabel: isBet ? SPT("Bet") : SPT("Raise to"),
      canCheck,
      step: NV(cfg.bigBlind) || (CHIPS ? 1 : 0.01),
      symbol: CHIPS ? SPT("chips") : SP.NETWORK.currency.symbol,
      timer: Math.max(0, hand.actingDeadline - now),
      timerTotal: Number(cfg.actionTimeout)
    };
    const onAllIn = () => {
      if (settled()) act(A.ALLIN);
    };
    return /*#__PURE__*/React.createElement(ActionBar, {
      action: actionData,
      onFold: onFold,
      onCheckCall: onCheckCall,
      onRaise: onRaise,
      onAllIn: onAllIn,
      betValue: bv,
      setBetValue: setBetValue
    });
  }
}

/* live side rail: real chat (via dealer bot), on-chain hand history, private notes */
function LiveSideRail({
  tableId,
  snap,
  connected,
  mySeat,
  mobileOpen,
  onClose,
  nameOf
}) {
  const [tab, setTab] = useState("chat");
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState("");
  const [hands, setHands] = useState(null);
  const [notes, setNotes] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("sp_notes") || "{}");
    } catch {
      return {};
    }
  });
  const [commit, setCommit] = useState(null);
  const sinceRef = useRef(0);
  const bodyRef = useRef(null);
  useEffect(() => {
    let stop = false;
    async function poll() {
      try {
        const list = await SP.sdk.getChat(tableId, sinceRef.current);
        if (!stop && list.length) {
          sinceRef.current = list[list.length - 1].id;
          setMsgs(m => [...m, ...list].slice(-60));
        }
      } catch {}
    }
    poll();
    const iv = setInterval(poll, 2500);
    return () => {
      stop = true;
      clearInterval(iv);
    };
  }, []);
  useEffect(() => {
    if (tab === "chat" && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [msgs, tab]);
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const h = await SP.sdk.recentHands(tableId);
        if (!stop) setHands(h);
      } catch {
        if (!stop) setHands([]);
      }
    };
    load();
    const iv = setInterval(load, 30000);
    return () => {
      stop = true;
      clearInterval(iv);
    };
  }, []);
  useEffect(() => {
    if (!snap || !snap.hand.inProgress) return;
    let stop = false;
    SP.sdk.dealCommit(snap.hand.dealId).then(c => {
      if (!stop) setCommit(c);
    }).catch(() => {});
    return () => {
      stop = true;
    };
  }, [snap && String(snap.hand.dealId), snap && snap.hand.street]);
  async function send() {
    const text = input.trim();
    if (!text || !connected || mySeat < 0) return;
    setInput("");
    try {
      await SP.sdk.sendChat(tableId, text);
    } catch (e) {
      console.warn("chat:", e.message);
    }
  }
  const saveNote = (a, patch) => setNotes(n => {
    const next = {
      ...n,
      [a]: {
        ...(n[a] || {}),
        ...patch
      }
    };
    try {
      localStorage.setItem("sp_notes", JSON.stringify(next));
    } catch {}
    return next;
  });
  const opponents = snap ? snap.seats.filter(s => !s.empty && s.index !== mySeat) : [];
  const shh = h => h ? h.slice(0, 10) + "…" + h.slice(-8) : "";
  return /*#__PURE__*/React.createElement("aside", {
    className: "siderail" + (mobileOpen ? " open" : "")
  }, /*#__PURE__*/React.createElement("div", {
    className: "railtabs"
  }, /*#__PURE__*/React.createElement("button", {
    className: "railclose",
    onClick: onClose,
    title: "Close"
  }, "\u2715"), ["chat", "hands", "notes"].map(t2 => /*#__PURE__*/React.createElement("button", {
    key: t2,
    className: tab === t2 ? "on" : "",
    onClick: () => setTab(t2)
  }, SPT(t2)))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "9px 12px",
      borderBottom: "1px solid var(--line)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "tag"
  }, tab === "chat" ? SPT("table chat · dealer feed") : tab === "hands" ? SPT("hand history · on-chain") : SPT("private player notes"))), /*#__PURE__*/React.createElement("div", {
    className: "railbody",
    ref: bodyRef
  }, tab === "chat" && (msgs.length === 0 ? /*#__PURE__*/React.createElement("div", {
    className: "chatline dealer"
  }, SP.sdk.zkLayer ? SPT("Welcome · live on Somnia. zkShuffle dealing: only your browser can see your cards.") : SPT("Welcome · live on Somnia. Provably-fair commit-reveal dealing.")) : msgs.map(m => /*#__PURE__*/React.createElement("div", {
    key: m.id,
    className: "chatline" + (m.dealer ? " dealer" : "")
  }, !m.dealer && /*#__PURE__*/React.createElement("span", {
    className: "who"
  }, m.addr && nameOf ? nameOf(m.addr) : m.who), m.text))), tab === "hands" && (hands == null ? /*#__PURE__*/React.createElement("div", {
    className: "chatline dealer"
  }, "Loading on-chain history\u2026") : hands.length === 0 ? /*#__PURE__*/React.createElement("div", {
    className: "chatline dealer"
  }, "No settled hands yet at this table.") : hands.map((h2, i) => {
    const who = snap && snap.seats[h2.seat] && !snap.seats[h2.seat].empty ? nameOf ? nameOf(snap.seats[h2.seat].player) : short(snap.seats[h2.seat].player) : "seat " + h2.seat;
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      className: "hhrow"
    }, /*#__PURE__*/React.createElement("span", {
      className: "st"
    }, "#", h2.handId), /*#__PURE__*/React.createElement("span", {
      className: "act"
    }, who, " won ", /*#__PURE__*/React.createElement("b", {
      className: "tnum"
    }, CHIPS ? Number(h2.amount) : Number(SP.fmt(h2.amount, 6))), " \xB7 ", h2.kind));
  })), tab === "notes" && /*#__PURE__*/React.createElement("div", null, opponents.length === 0 && /*#__PURE__*/React.createElement("div", {
    className: "chatline dealer"
  }, "No opponents seated yet."), opponents.map(s => {
    const n = notes[s.player.toLowerCase()] || {};
    return /*#__PURE__*/React.createElement("div", {
      key: s.index,
      style: {
        padding: "8px 4px",
        borderBottom: "1px solid var(--hair)"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginBottom: 5
      }
    }, ["#ef5a6f", "#e8c15a", "#46d39a", "#D9B970"].map(c => /*#__PURE__*/React.createElement("span", {
      key: c,
      onClick: () => saveNote(s.player.toLowerCase(), {
        tag: n.tag === c ? null : c
      }),
      style: {
        width: 12,
        height: 12,
        borderRadius: "50%",
        background: c,
        cursor: "pointer",
        opacity: n.tag === c ? 1 : 0.35,
        outline: n.tag === c ? "1.5px solid #fff" : "none"
      }
    })), /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: "var(--label)",
        fontSize: 11.5,
        color: n.tag || "var(--text-2)"
      }
    }, nameOf ? nameOf(s.player) : short(s.player))), /*#__PURE__*/React.createElement("input", {
      placeholder: "Add a note\u2026",
      defaultValue: n.text || "",
      onBlur: e => saveNote(s.player.toLowerCase(), {
        text: e.target.value
      }),
      style: {
        width: "100%",
        background: "rgba(255,255,255,.04)",
        border: "1px solid var(--line-2)",
        color: "var(--text)",
        borderRadius: 7,
        padding: "6px 8px",
        fontFamily: "var(--label)",
        fontSize: 12
      }
    }));
  }))), tab === "chat" && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      padding: "8px 10px",
      borderTop: "1px solid var(--line)"
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: input,
    onChange: e => setInput(e.target.value),
    onKeyDown: e => e.key === "Enter" && send(),
    placeholder: connected && mySeat >= 0 ? SPT("Say something…") : SPT("Sit down to chat"),
    disabled: !connected || mySeat < 0,
    style: {
      flex: 1,
      background: "rgba(255,255,255,.04)",
      border: "1px solid var(--line-2)",
      color: "var(--text)",
      borderRadius: 7,
      padding: "7px 9px",
      fontFamily: "var(--label)",
      fontSize: 12
    }
  }), /*#__PURE__*/React.createElement("button", {
    className: "pill",
    onClick: send,
    disabled: !connected || mySeat < 0
  }, SPT("Send"))), /*#__PURE__*/React.createElement("div", {
    className: "pfwidget"
  }, /*#__PURE__*/React.createElement("div", {
    className: "pfhead"
  }, /*#__PURE__*/React.createElement("span", {
    className: "ttl"
  }, ChromeIcons.shield, " ", SPT(SP.sdk.zkLayer ? "provably fair · zkShuffle" : "provably fair · commit-reveal"))), SP.sdk.zkLayer ? /*#__PURE__*/React.createElement("div", {
    className: "commit"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    className: "lab"
  }, "deal"), " ", commit && commit.dealId ? "#" + BigInt(commit.dealId).toString(16).slice(0, 14) + "…" : "- waiting for a hand -"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "lab"
  }, "cards"), " ", commit && commit.revealed ? "showdown proofs verified on-chain ✓" : "player-encrypted · every reveal proven")) : /*#__PURE__*/React.createElement("div", {
    className: "commit"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    className: "lab"
  }, "commit"), " ", commit ? shh(commit.seedHash) : "- waiting for a hand -"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "lab"
  }, "deck"), " ", commit && commit.revealed ? "revealed & verified on-chain ✓" : "sealed pre-deal · reveal post-hand"))));
}

/* sit / cashier modal */
function Modal({
  kind,
  close,
  sdk,
  tableId,
  cfg,
  bal,
  tx,
  refresh
}) {
  // THE PANEL STAYS UP UNTIL THE CHAIN ANSWERS.
  // It used to close the instant you pressed the button and only then send the
  // transaction — so the two-to-four seconds of sitting down (a balance read, a
  // deposit if you were short, then sitDown itself) happened against an empty
  // screen with nothing at all to say it was working. Now the button spins in
  // place, the panel names the wait, and it closes when the seat is actually
  // yours. A refusal leaves the panel open so the amount can be changed.
  const [txBusy, setTxBusy] = useState(false);
  const runTx = async (label, fn) => {
    if (txBusy) return false;
    setTxBusy(true);
    try {
      const ok = await tx(label, fn);
      if (ok) close();
      return ok;
    } finally {
      setTxBusy(false);
    }
  };
  const minE = Number(SP.fmt(cfg.minBuyIn, 4)),
    maxE = Number(SP.fmt(cfg.maxBuyIn, 4));
  const bbE = Number(SP.fmt(cfg.bigBlind, 4));
  // What you can actually add: the table's ceiling minus what you already have,
  // and never more than your room balance.
  const topMax = kind.type === "topup" ? Math.max(0, Math.min(maxE - (kind.stack || 0), bal)) : 0;
  const [amt, setAmt] = useState(kind.type === "sit" ? String(Math.min(maxE, bal || maxE)) : kind.type === "topup" ? String(Math.max(0, Math.min(maxE - (kind.stack || 0), bal))) : "1");
  const amtNum = parseFloat(amt) || 0;
  const amtOk = amtNum >= minE && amtNum <= maxE && amtNum <= bal;
  const topOk = amtNum > 0 && amtNum <= topMax;
  const round = v => Math.round(Math.min(maxE, Math.max(minE, v)) * 10000) / 10000;
  // the four sizes people actually pick, in big blinds like every poker room
  const buyPresets = [{
    k: SPT("Min"),
    v: round(minE)
  }, {
    k: "20BB",
    v: round(bbE * 20)
  }, {
    k: "40BB",
    v: round(bbE * 40)
  }, {
    k: SPT("Max"),
    v: round(Math.min(maxE, bal || maxE))
  }].filter((p, i, a) => a.findIndex(q => Math.abs(q.v - p.v) < 1e-9) === i);
  const tr = v => Math.round(Math.min(topMax, Math.max(0, v)) * 10000) / 10000;
  const topPresets = [{
    k: "20BB",
    v: tr(bbE * 20)
  }, {
    k: "40BB",
    v: tr(bbE * 40)
  }, {
    k: SPT("Max"),
    v: tr(topMax)
  }].filter((p, i, a) => p.v > 0 && a.findIndex(q => Math.abs(q.v - p.v) < 1e-9) === i);
  const [wd, setWd] = useState(String(bal));
  const [walletBal, setWalletBal] = useState(null);
  useEffect(() => {
    sdk.walletBalance().then(b => setWalletBal(Number(SP.fmt(b, 6)))).catch(() => {});
  }, []);
  const stop = e => e.stopPropagation();
  const sym = SP.NETWORK.currency.symbol;
  const lowWallet = walletBal != null && walletBal < 0.05;
  const isTestnet = SP.NETWORK.chainId === 50312;
  const copyAddr = () => {
    try {
      navigator.clipboard.writeText(sdk.address);
    } catch {}
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "lt-modalbg",
    onClick: close
  }, /*#__PURE__*/React.createElement("div", {
    className: "lt-modal",
    onClick: stop
  }, kind.type === "sit" ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("h3", null, SPT("Sit at seat"), " ", kind.seat), /*#__PURE__*/React.createElement("div", {
    className: "buyrows"
  }, /*#__PURE__*/React.createElement("div", {
    className: "buyrow"
  }, /*#__PURE__*/React.createElement("span", null, SPT("Game")), /*#__PURE__*/React.createElement("b", null, "NLHE ", Number(SP.fmt(cfg.smallBlind, 4)), "/", Number(SP.fmt(cfg.bigBlind, 4)))), /*#__PURE__*/React.createElement("div", {
    className: "buyrow"
  }, /*#__PURE__*/React.createElement("span", null, SPT("Available")), /*#__PURE__*/React.createElement("b", {
    className: "tnum"
  }, /*#__PURE__*/React.createElement(SomiCoin, {
    size: 13
  }), fmtMoney(bal)))), /*#__PURE__*/React.createElement("div", {
    className: "buyamt" + (amtOk ? "" : " bad")
  }, /*#__PURE__*/React.createElement("span", {
    className: "coin"
  }, /*#__PURE__*/React.createElement(SomiCoin, {
    size: 20
  })), /*#__PURE__*/React.createElement("input", {
    className: "buybig tnum",
    value: amt,
    onChange: e => setAmt(e.target.value),
    inputMode: "decimal"
  }), /*#__PURE__*/React.createElement("span", {
    className: "unit"
  }, sym)), /*#__PURE__*/React.createElement("div", {
    className: "buyslider",
    style: {
      "--fill": maxE > minE ? Math.max(0, Math.min(1, (Math.min(maxE, Math.max(minE, amtNum)) - minE) / (maxE - minE))) : 1
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "end tnum"
  }, fmtMoney(minE)), /*#__PURE__*/React.createElement("input", {
    type: "range",
    min: minE,
    max: maxE,
    step: Math.max(0.0001, (maxE - minE) / 200),
    value: Math.min(maxE, Math.max(minE, amtNum)),
    onChange: e => setAmt(String(Number(e.target.value)))
  }), /*#__PURE__*/React.createElement("span", {
    className: "end hi tnum"
  }, fmtMoney(maxE))), /*#__PURE__*/React.createElement("div", {
    className: "buypresets"
  }, buyPresets.map(p => /*#__PURE__*/React.createElement("button", {
    key: p.k,
    className: Math.abs(amtNum - p.v) < 1e-9 ? "on" : "",
    onClick: () => setAmt(String(p.v))
  }, p.k))), !amtOk && /*#__PURE__*/React.createElement("p", {
    className: "note",
    style: {
      color: "var(--danger)"
    }
  }, SPT("Buy-in"), ": ", fmtMoney(minE), "\u2013", fmtMoney(maxE), " ", sym), /*#__PURE__*/React.createElement("div", {
    className: "row"
  }, /*#__PURE__*/React.createElement("button", {
    className: "pill primary buycta",
    disabled: !amtOk || txBusy,
    onClick: async () => {
      await runTx("Take seat", async () => {
        // one game at a time: block sitting here while seated anywhere
        // else (cash or a running tournament table)
        const other = await sdk.seatedTableAt(tableId);
        if (other >= 0) throw new Error(window.__SPLANG === "ru" ? `Вы уже играете за столом #${other} · сначала покиньте его` : `You're already playing at table #${other} · leave it first`);
        const need = SP.parseEther(amt);
        const have = await sdk.balanceOf(sdk.address);
        if (have < need) await sdk.deposit(SP.fmt(need - have, 6));
        await sdk.sitDown(tableId, kind.seat, amt);
        // injected wallets: grant a session key so actions need no popup.
        // Privy email wallets are already headless · nothing to do.
        if (sdk.backend === "injected" && !sdk.hasSession()) await sdk.activateSession();
      });
    }
  }, SPT("Sit down"))), txBusy && /*#__PURE__*/React.createElement("p", {
    className: "buywait"
  }, SPT("Confirming on-chain · this takes a moment"))) : kind.type === "topup" ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("h3", null, SPT("Add chips")), /*#__PURE__*/React.createElement("div", {
    className: "buyrows"
  }, /*#__PURE__*/React.createElement("div", {
    className: "buyrow"
  }, /*#__PURE__*/React.createElement("span", null, SPT("Your stack")), /*#__PURE__*/React.createElement("b", {
    className: "tnum"
  }, /*#__PURE__*/React.createElement(SomiCoin, {
    size: 13
  }), fmtMoney(kind.stack))), /*#__PURE__*/React.createElement("div", {
    className: "buyrow"
  }, /*#__PURE__*/React.createElement("span", null, SPT("Available")), /*#__PURE__*/React.createElement("b", {
    className: "tnum"
  }, /*#__PURE__*/React.createElement(SomiCoin, {
    size: 13
  }), fmtMoney(bal))), /*#__PURE__*/React.createElement("div", {
    className: "buyrow"
  }, /*#__PURE__*/React.createElement("span", null, SPT("Table max")), /*#__PURE__*/React.createElement("b", {
    className: "tnum"
  }, /*#__PURE__*/React.createElement(SomiCoin, {
    size: 13
  }), fmtMoney(maxE)))), /*#__PURE__*/React.createElement("div", {
    className: "buyamt" + (topOk ? "" : " bad")
  }, /*#__PURE__*/React.createElement("span", {
    className: "coin"
  }, /*#__PURE__*/React.createElement(SomiCoin, {
    size: 20
  })), /*#__PURE__*/React.createElement("input", {
    className: "buybig tnum",
    value: amt,
    onChange: e => setAmt(e.target.value),
    inputMode: "decimal"
  }), /*#__PURE__*/React.createElement("span", {
    className: "unit"
  }, sym)), /*#__PURE__*/React.createElement("div", {
    className: "buyslider",
    style: {
      "--fill": topMax > 0 ? Math.max(0, Math.min(1, Math.min(topMax, Math.max(0, amtNum)) / topMax)) : 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "end tnum"
  }, "0"), /*#__PURE__*/React.createElement("input", {
    type: "range",
    min: 0,
    max: topMax,
    step: Math.max(0.0001, topMax / 200),
    value: Math.min(topMax, Math.max(0, amtNum)),
    onChange: e => setAmt(String(Number(e.target.value)))
  }), /*#__PURE__*/React.createElement("span", {
    className: "end hi tnum"
  }, fmtMoney(topMax))), /*#__PURE__*/React.createElement("div", {
    className: "buypresets"
  }, topPresets.map(p => /*#__PURE__*/React.createElement("button", {
    key: p.k,
    className: Math.abs(amtNum - p.v) < 1e-9 ? "on" : "",
    onClick: () => setAmt(String(p.v))
  }, p.k))), topMax <= 0 && /*#__PURE__*/React.createElement("p", {
    className: "note"
  }, SPT("You're already at this table's maximum stack.")), topMax > 0 && !topOk && /*#__PURE__*/React.createElement("p", {
    className: "note",
    style: {
      color: "var(--danger)"
    }
  }, SPT("Up to"), " ", fmtMoney(topMax), " ", sym), /*#__PURE__*/React.createElement("div", {
    className: "row"
  }, /*#__PURE__*/React.createElement("button", {
    className: "pill primary buycta",
    disabled: !topOk || txBusy,
    onClick: () => {
      runTx("Top up", () => sdk.topUp(tableId, amt)).then(ok => {
        if (ok) refresh();
      });
    }
  }, SPT("Add chips"))), txBusy && /*#__PURE__*/React.createElement("p", {
    className: "buywait"
  }, SPT("Confirming on-chain · this takes a moment"))) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("h3", null, kind.type === "fund" ? "Fund your wallet" : "Cashier"), /*#__PURE__*/React.createElement("p", {
    className: "note"
  }, "Wallet ", /*#__PURE__*/React.createElement("b", {
    className: "mono"
  }, short(sdk.address)), " \xB7 ", walletBal == null ? "…" : walletBal.toFixed(3), " ", sym, " \xA0|\xA0 In-room ", /*#__PURE__*/React.createElement("b", null, bal.toFixed(3)), " ", sym), lowWallet && /*#__PURE__*/React.createElement("div", {
    className: "fundbox"
  }, /*#__PURE__*/React.createElement("div", {
    className: "fh"
  }, "Low ", sym, " balance \xB7 you need ", sym, " to buy in and cover gas."), /*#__PURE__*/React.createElement("div", {
    className: "fa"
  }, /*#__PURE__*/React.createElement("span", {
    className: "mono"
  }, sdk.address), /*#__PURE__*/React.createElement("button", {
    className: "pill",
    onClick: copyAddr
  }, "copy")), /*#__PURE__*/React.createElement("div", {
    className: "note",
    style: {
      marginTop: 6
    }
  }, "Send ", sym, " to this address from any wallet or exchange."), /*#__PURE__*/React.createElement("div", {
    className: "note",
    style: {
      marginTop: 8
    }
  }, "Then deposit below and take a seat.")), /*#__PURE__*/React.createElement("label", null, "Deposit (wallet \u2192 room)"), /*#__PURE__*/React.createElement("input", {
    value: amt,
    onChange: e => setAmt(e.target.value)
  }), /*#__PURE__*/React.createElement("div", {
    className: "row"
  }, /*#__PURE__*/React.createElement("button", {
    className: "pill primary",
    disabled: txBusy,
    onClick: () => {
      runTx("Deposit", () => sdk.deposit(amt)).then(ok => {
        if (ok) refresh();
      });
    }
  }, "Deposit")), /*#__PURE__*/React.createElement("label", null, "Withdraw (room \u2192 wallet)"), /*#__PURE__*/React.createElement("input", {
    value: wd,
    onChange: e => setWd(e.target.value)
  }), /*#__PURE__*/React.createElement("div", {
    className: "row"
  }, /*#__PURE__*/React.createElement("button", {
    className: "pill",
    disabled: txBusy,
    onClick: () => {
      runTx("Withdraw", () => sdk.withdraw(wd)).then(ok => {
        if (ok) refresh();
      });
    }
  }, "Withdraw")))));
}

/* ---- scale-to-fit stage (from the design) ---- */
// Bound once - see the same fix in poker-lobby-app.jsx. This one mattered most:
// it is the screen people sit on for hours, so the leaked resize handlers piled
// up the longest.
let _tableScaleBound = false;
function mountScale() {
  const scaler = document.getElementById("scaler");
  if (!scaler) return;
  const app = scaler.querySelector(".app");
  if (!app) return;
  function fit() {
    const embedNow = document.documentElement.classList.contains("sp-embed");
    let big = false;
    try {
      big = !!JSON.parse(localStorage.getItem("sp_prefs") || "{}").bigui;
    } catch (e) {}
    const key = window.innerWidth + "x" + window.innerHeight + "|" + (embedNow ? 1 : 0) + "|" + (big ? 1 : 0);
    if (app.dataset.slFit === key) return; // remounted nodes carry no marker
    app.dataset.slFit = key;
    if (window.innerWidth <= 760) {
      // fluid mobile layout (mobile.css) - no stage scaling
      app.style.transform = "";
      app.style.position = "";
      app.style.top = "";
      app.style.left = "";
      app.style.width = "";
      app.style.height = "";
      scaler.style.width = "";
      scaler.style.height = "";
      return;
    }
    // The TABLE must fit BOTH axes · a player has to see their own seat at the
    // bottom without scrolling. The canvas ASPECT follows the viewport (width
    // stretches between sane poker proportions) so the scaled stage fills the
    // screen edge-to-edge instead of leaving dead side bands on 16:9.
    // Shrink the canvas, let the scale-up compensate: same fit, everything
    // bigger, less on screen. What used to be the "Larger interface" setting
    // (1.18) is now the DEFAULT — players read the table at a glance and the
    // old baseline was simply too small — and the setting goes further still
    // for anyone who needs it. Kept well under the point where the fixed-height
    // chrome (top bar, tournament strip, action bar) would start eating the
    // felt: at 1.34 the felt still gets ~580 of the 746px canvas.
    const availW = window.innerWidth - 16;
    const availH = window.innerHeight - (embedNow ? 16 : 84);
    const k = big ? 1.34 : 1.18;
    const H = Math.round(1000 / k);
    const W = Math.round(Math.min(2.05 * H, Math.max(1.45 * H, availW / Math.max(1, availH) * H)));
    const s = Math.min(availW / W, availH / H);
    app.style.width = W + "px";
    app.style.height = H + "px";
    app.style.transform = `scale(${s})`;
    app.style.transformOrigin = "top left";
    app.style.position = "absolute";
    app.style.top = "0";
    app.style.left = "0";
    scaler.style.width = W * s + "px";
    scaler.style.height = H * s + "px";
  }
  fit();
  if (!_tableScaleBound) {
    _tableScaleBound = true;
    window.addEventListener("resize", () => mountScale());
  }
}
function boot() {
  ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(LiveTable, null));
  setInterval(mountScale, 400);
  setTimeout(mountScale, 80);
}
if (window.SP) boot();else window.addEventListener("sp:ready", boot, {
  once: true
});