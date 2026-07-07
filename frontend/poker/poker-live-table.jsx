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

// Tiny WebAudio synth — no assets, gated by the sound preference.
let AC = null;
function sfx(kind, on) {
  if (!on) return;
  try {
    AC = AC || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = AC.currentTime;
    const tone = (f, start, dur, g = 0.05, type = "sine") => {
      const o = AC.createOscillator(), ga = AC.createGain();
      o.type = type; o.frequency.value = f;
      ga.gain.setValueAtTime(g, t0 + start);
      ga.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
      o.connect(ga); ga.connect(AC.destination);
      o.start(t0 + start); o.stop(t0 + start + dur + 0.02);
    };
    if (kind === "turn") { tone(660, 0, 0.12, 0.06); tone(880, 0.13, 0.15, 0.06); }
    else if (kind === "deal") { tone(420, 0, 0.05, 0.03, "triangle"); tone(420, 0.07, 0.05, 0.03, "triangle"); }
    else if (kind === "chip") tone(520, 0, 0.05, 0.035, "square");
    else if (kind === "win") { tone(523, 0, 0.12, 0.06); tone(659, 0.12, 0.12, 0.06); tone(784, 0.24, 0.2, 0.07); }
  } catch {}
}

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

// the reverse: chips fly FROM a seat / bet spot INTO the pot — antes at the
// deal and each street's bets being collected. Every client renders this from
// the same snapshot diff, so everyone sees everyone posting.
function FlyToPot({ wrapRef, fromX, fromY, delay = 0 }) {
  const [vec, setVec] = useState(null);
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    setVec({ dx: ((50 - fromX) / 100) * r.width, dy: ((43 - fromY) / 100) * r.height });
  }, []);
  if (!vec) return null;
  return (
    <div className="flychips" style={{ left: fromX + "%", top: fromY + "%" }}>
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className="flychip" style={{ left: Math.cos(i * 2) * 8 + "px", top: Math.sin(i * 2) * 8 + "px", "--ptx": vec.dx + "px", "--pty": vec.dy + "px", animationDelay: delay + i * 45 + "ms" }} />
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
  const [lang, setLangState] = useState(() => window.__SPLANG || "en");
  const setLang = (l) => { window.SPLangSet(l); setLangState(l); }; // re-render → SPT() picks up the new language everywhere
  // persisted table preferences — every toggle here actually works
  const [prefs, setPrefs] = useState(() => {
    const d = { sound: true, deck: "4", turbo: false, reduced: false, bbstacks: false };
    try { return Object.assign(d, JSON.parse(localStorage.getItem("sp_prefs") || "{}")); } catch { return d; }
  });
  const setPref = (k, v) => setPrefs((p) => { const n = { ...p, [k]: v }; try { localStorage.setItem("sp_prefs", JSON.stringify(n)); } catch {} return n; });
  const deck = prefs.deck;
  const [preAct, setPreAct] = useState(null); // "checkfold" | "callany" | "check"
  const preActRef = useRef({ key: null });
  const [showSettings, setShowSettings] = useState(false);
  const [railOpen, setRailOpen] = useState(false); // mobile: side rail as a bottom sheet
  const [betValue, setBetValue] = useState(0);
  const [modal, setModal] = useState(null); // {type, seat}
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sessionOn, setSessionOn] = useState(false);
  const [anim, setAnim] = useState({ dealing: false, flipFrom: 99, winnerSeat: -1, won: 0 });
  const [nowMs, setNowMs] = useState(Date.now());
  const [reveals, setReveals] = useState({}); // dealId -> { seat: [c0,c1] }
  const [sdWin, setSdWin] = useState(null); // showdown winner computed from reveals, BEFORE on-chain settle
  const [pendingAct, setPendingAct] = useState(null); // optimistic: my action tx sent, waiting for the chain
  const [lastActs, setLastActs] = useState({}); // seat -> {kind, amt, ts} — floating action badges
  const [potFly, setPotFly] = useState(null); // {ts, kind: "ante"|"sweep", idxs} — chips flying into the pot
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
  const prevRef = useRef({ handId: 0, boardLen: 0, inProgress: false, stacks: {} });
  const dealTimerRef = useRef(null);
  const winTimerRef = useRef(null);
  const sdTimerRef = useRef(null);
  const potFlyRef = useRef(null);
  const sdWinRef = useRef(null);
  const holeRetryRef = useRef(null);
  const gotHolesRef = useRef({}); // dealId -> true once holes landed (retry-timer guard)
  const dealIdRef = useRef("0");
  const balSeqRef = useRef(0);
  const feltWrapRef = useRef(null);
  const reducedMo = prefs.reduced || !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  const [tableId, setTableId] = useState(SP.tableId); // switchable WITHOUT a page reload (LePoker-style)
  const [ctl, setCtl] = useState(undefined); // table controller: undefined = not resolved yet, zero = cash, else = tournament
  const ZERO_CTL = "0x0000000000000000000000000000000000000000";
  const canvasRef = useRef(null);
  const fieldRef = useRef(null);

  useEffect(() => { localStorage.setItem("sp_theme", theme); }, [theme]);

  // live snapshot poll — the table you're AT polls fast (served from the
  // dealer's HTTP cache, cheap) so actions and reveals feel near-instant.
  useEffect(() => SP.sdk.watch(tableId, setSnap, 900), [tableId]);

  // The controller decides the whole render mode (chip formatting, seats
  // managed by a tournament vs open sit-down). Resolve it BEFORE first paint —
  // tournament tables used to flash cash-table UI ("+ Sit" seats, wei-formatted
  // blinds) for a second until the slower tournament poll landed.
  useEffect(() => {
    let stop = false;
    SP.sdk.tableController(tableId)
      .then((a) => { if (!stop) setCtl((a || ZERO_CTL).toLowerCase()); })
      .catch(() => { if (!stop) setCtl(ZERO_CTL); });
    return () => { stop = true; };
  }, [tableId]);

  // auto-restore an existing email (Privy) session — now and whenever Privy boots
  useEffect(() => {
    const restore = () => SP.sdk.tryRestorePrivy().then((a) => { if (a) { setAddr(a); setConnected(true); refreshBal(); } }).catch(() => {});
    restore();
    const on = (ev) => { if (ev.detail && ev.detail.authenticated && ev.detail.address) restore(); };
    document.addEventListener("shinyluck:auth-state", on);
    return () => document.removeEventListener("shinyluck:auth-state", on);
  }, []);

  // wallet balance refresh — sequence-guarded so a slow stale response can't
  // overwrite a newer value (the header briefly "jumping" between balances)
  async function refreshBal() {
    if (!SP.sdk.address) return;
    const seq = ++balSeqRef.current;
    try { const b = N(await SP.sdk.balanceOf(SP.sdk.address)); if (seq === balSeqRef.current) setBal(b); } catch {}
  }
  useEffect(() => { if (connected) { refreshBal(); const id = setInterval(refreshBal, 4000); return () => clearInterval(id); } }, [connected]);

  // LED grid background on the felt canvas (design motion engine)
  useEffect(() => {
    if (!canvasRef.current || !window.GridField) return;
    if (fieldRef.current) fieldRef.current.destroy();
    const cfg = {
      a: { cell: 15, gap: 4, speed: 0.7, density: 0.5, accent: "#d9ab4a", maxAlpha: 0.55, minBright: 0.02, shape: "square" },
      b: { cell: 17, gap: 6, speed: 0.55, density: 0.42, accent: "#d9ab4a", accent2: "#f2d78a", maxAlpha: 0.5, minBright: 0.015, shape: "dot" },
      c: { cell: 13, gap: 3, speed: 0.6, density: 0.45, accent: "#d9ab4a", maxAlpha: 0.42, minBright: 0.02, shape: "square" },
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

  // fetch my hole cards once per deal — failed attempts retry on a FAST local
  // timer (dealer is still locking entropy) instead of waiting for the next
  // snapshot poll, so the cards land the moment they're available
  useEffect(() => { if (snap) dealIdRef.current = String(snap.hand.dealId); }, [snap]);
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
      // finishes locking entropy — so only ONE wallet popup per hand.
      if (!sigCacheRef.current[key]) sigCacheRef.current[key] = await SP.sdk.signHoles(tableId, dealId);
      const r = await SP.sdk.myHoleCards(tableId, dealId, sigCacheRef.current[key]);
      gotHolesRef.current[key] = true;
      setHoles((m) => ({ ...m, [key]: r }));
      setHeroDealing(true);
      clearTimeout(heroDealRef.current);
      heroDealRef.current = setTimeout(() => setHeroDealing(false), 700);
    } catch (e) {
      if (attempt < 24) { // ~12s of quick retries, then the snapshot poll takes over
        clearTimeout(holeRetryRef.current);
        holeRetryRef.current = setTimeout(() => fetchHoles(key, dealId, attempt + 1), 500);
      } else console.warn("hole:", e.message);
    } finally {
      fetchingRef.current = false;
    }
  }

  // keep the session indicator in sync (Privy = always popup-free; injected = once a session is granted)
  useEffect(() => { setSessionOn(SP.sdk.popupFree()); }, [snap, connected]);

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
    if (sel === "checkfold") act(owe ? A.FOLD : A.CHECK);
    else if (sel === "callany") act(owe ? A.CALL : A.CHECK);
    else if (sel === "check" && !owe) act(A.CHECK);
  }, [snap]);

  // 1s tick so countdown timers update smoothly
  useEffect(() => { const id = setInterval(() => setNowMs(Date.now()), 1000); return () => clearInterval(id); }, []);

  // one-time hint: what the D / SB / BB chips mean (beginners kept asking)
  useEffect(() => {
    if (!snap || !snap.hand.inProgress) return;
    try {
      if (!localStorage.getItem("sp_hint_dealer")) {
        localStorage.setItem("sp_hint_dealer", "1");
        flash(window.__SPLANG === "ru"
          ? "Метка D — баттон (дилер): от него идёт раздача и порядок ходов, каждую руку он сдвигается. SB/BB — малый и большой блайнды."
          : "The D chip marks the dealer button — dealing & betting order rotate from it each hand. SB/BB are the small & big blinds.", 9000);
      }
    } catch {}
  }, [snap && snap.hand.inProgress]);

  // tournament HUD: if this table is controlled by a tournament, poll its state
  // (clock + my registration/seat + finishing places — feeds the HUD, the MTT
  // table switcher, the move-redirect, the bust screen and the final standings)
  useEffect(() => {
    if (!SP.sdk.hasTournaments()) return;
    let stop = false;
    async function poll() {
      try {
        const t = await SP.sdk.tournamentOfTable(tableId);
        if (stop) return;
        if (!t) { setTrn(null); return; }
        const [c, res] = await Promise.all([
          SP.sdk.tournamentClock(t.id, t.at),
          SP.sdk.tournamentResults(t.id).catch(() => null),
        ]);
        const nextAt = await SP.sdk.nextLevelAt(t.id, c, t.at); // structure-aware (custom schedules)
        const tables = t.tables && t.tables.length ? t.tables : [t.tableId];
        let reg = false, myTable = -1;
        if (SP.sdk.address) {
          reg = await SP.sdk.isRegisteredIn(t.id, t.at).catch(() => false);
          if (reg && t.status === 1) myTable = await SP.sdk.myTournamentSeatTable(t.id, t.at).catch(() => -1);
        }
        // seated-per-table counts for the MTT switcher (one lobby GET covers all)
        let counts = null;
        if (tables.length > 1) {
          try { const lob = await SP.sdk.lobbySnapshot(); if (lob) counts = Object.fromEntries(lob.tables.map((x) => [Number(x.id), x.seated])); } catch {}
        }
        if (!stop) setTrn({ ...t, ...c, nextAt, tables, reg, myTable, res, counts });
      } catch {}
    }
    poll();
    const iv = setInterval(poll, 5000);
    return () => { stop = true; clearInterval(iv); };
  }, [connected, tableId]);

  // resolve on-chain profiles (nickname + avatar) for everyone seated
  const takeProfiles = (m) => {
    const h = {}, a2 = {};
    for (const k of Object.keys(m)) { h[k] = m[k].handle; a2[k] = { id: m[k].avatar, img: m[k].img }; }
    setNames((p) => ({ ...p, ...h }));
    setAvs((p) => ({ ...p, ...a2 }));
  };
  useEffect(() => {
    if (!snap) return;
    const addrs = snap.seats.filter((s) => !s.empty).map((s) => s.player);
    if (addr) addrs.push(addr);
    let stop = false;
    SP.sdk.profilesFor(addrs).then((m) => { if (!stop) takeProfiles(m); }).catch(() => {});
    return () => { stop = true; };
  }, [snap && snap.seats.filter((s) => !s.empty).map((s) => s.player).join(","), addr]);
  const nameOf = (a) => (a && names[a.toLowerCase()]) || short(a);
  const avOf = (a) => (a && avs[a.toLowerCase()]) || { id: 0, img: null };

  // profiles for the final standings (bust/finish events carry addresses only)
  useEffect(() => {
    if (!trn || !trn.res) return;
    const list = trn.res.busts.map((b) => b.player).concat(trn.res.winner ? [trn.res.winner.player] : []);
    if (!list.length) return;
    let stop = false;
    SP.sdk.profilesFor(list).then((m) => { if (!stop) takeProfiles(m); }).catch(() => {});
    return () => { stop = true; };
  }, [trn && trn.res && trn.res.busts.length + ":" + !!(trn.res && trn.res.winner)]);

  // MTT rebalance: the tournament moved my seat to another table → tell me and
  // take me there (the table in ?t=N is fixed at page load, so without this the
  // player is stranded watching a table they no longer sit at). Auto-follow
  // ONLY if I actually held a seat HERE this session — a registered player
  // spying on a sibling table via the switcher must not get yanked away.
  const wasSeatedHereRef = useRef(false);
  useEffect(() => { if (snap && snap.mySeat >= 0) wasSeatedHereRef.current = true; }, [snap && snap.mySeat]);
  useEffect(() => {
    if (!trn || moveRef.current || !wasSeatedHereRef.current) return;
    if (trn.status === 1 && trn.reg && trn.myTable >= 0 && trn.myTable !== tableId) {
      moveRef.current = true;
      setMovedTo(trn.myTable);
      const dest = trn.myTable;
      setTimeout(() => switchTable(dest), 2600); // in-place switch — no reload
    }
  }, [trn]);

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
      dealTimerRef.current = setTimeout(() => setAnim((a) => ({ ...a, dealing: false })), prefs.turbo ? 600 : 1300);
      setPreAct(null); // pre-actions never carry across hands
      setSdWin(null); clearTimeout(sdTimerRef.current);
      setLastActs({}); // action badges never carry across hands
      // antes are swept straight into the pot on-chain (no bet spot) — show
      // everyone's chips flying to the middle so posting is visible to all
      const hasAnte = trn ? Number(trn.curAnte || 0) > 0 : (snap.cfg.ante || 0n) > 0n;
      if (hasAnte && !reducedMo) {
        setPotFly({ ts: Date.now(), kind: "ante", idxs: snap.seats.filter((s) => !s.empty && s.inHand).map((s) => s.index) });
        clearTimeout(potFlyRef.current);
        potFlyRef.current = setTimeout(() => setPotFly(null), 1200);
      }
      sfx("deal", prefs.sound);
    }
    // street advanced → the bets in front of the seats get collected into the
    // pot; fly them to the middle (again: same snapshot diff on every client)
    if (h.inProgress && h.handId === prev.handId && h.street > prev.street && prev.sh && !reducedMo) {
      const idxs = Object.keys(prev.sh).filter((k) => prev.sh[k].cs > 0n).map(Number);
      if (idxs.length) {
        setPotFly({ ts: Date.now(), kind: "sweep", idxs });
        clearTimeout(potFlyRef.current);
        potFlyRef.current = setTimeout(() => setPotFly(null), 1100);
      }
    }
    // last-action badges: diff this snapshot against the previous one to see
    // WHO just did WHAT (fold/check/call/bet/raise/all-in) — the chain has no
    // push feed, so the poll delta is the source of truth
    if (h.inProgress && prev.sh) {
      const sameHand = h.handId === prev.handId;
      const sameStreet = sameHand && h.street === prev.street;
      const acts = {};
      for (const s of snap.seats) {
        if (s.empty) continue;
        const p = prev.sh[s.index];
        if (!p) continue;
        if (sameHand && s.folded && !p.folded) acts[s.index] = { kind: "fold", ts: Date.now() };
        else if (sameHand && s.allIn && !p.allIn) acts[s.index] = { kind: "allin", ts: Date.now() };
        else if (sameStreet && s.committedStreet > p.cs)
          acts[s.index] = { kind: prev.curBet === 0n ? "bet" : (s.committedStreet > prev.curBet ? "raise" : "call"), amt: NV(s.committedStreet), ts: Date.now() };
        else if (sameStreet && prev.actingSeat === s.index && h.actingSeat !== s.index && s.committedStreet === p.cs && !s.folded && !s.allIn && s.inHand)
          acts[s.index] = { kind: "check", ts: Date.now() };
      }
      if (Object.keys(acts).length) setLastActs((m) => ({ ...m, ...acts }));
    }
    if (boardLen > prev.boardLen) setAnim((a) => ({ ...a, flipFrom: prev.boardLen }));
    if (!h.inProgress && prev.inProgress) {
      let winner = -1, best = 0n;
      for (const s of snap.seats) { const d = s.stack - (prev.stacks[s.index] || 0n); if (d > best) { best = d; winner = s.index; } }
      if (fieldRef.current) fieldRef.current.flash();
      // EVERY client gets the winner + amount (banner). Only the chip-flight
      // motion itself respects reduced-motion — before, that flag silently
      // swallowed the whole payout announcement.
      if (winner >= 0) {
        setAnim((a) => ({ ...a, winnerSeat: winner, won: NV(best) }));
        clearTimeout(winTimerRef.current);
        winTimerRef.current = setTimeout(() => setAnim((a) => ({ ...a, winnerSeat: -1 })), 3200);
        // showdown already played the win sound; only fold-wins chime here
        if (winner === snap.mySeat && !(sdWinRef.current && sdWinRef.current.seat === winner)) sfx("win", prefs.sound);
      }
      // hold the showdown banner through the settle beat, then clear
      clearTimeout(sdTimerRef.current);
      sdTimerRef.current = setTimeout(() => setSdWin(null), 6000);
    }
    const stacks = {}, sh = {};
    snap.seats.forEach((s) => { stacks[s.index] = s.stack; if (!s.empty) sh[s.index] = { cs: s.committedStreet, folded: s.folded, allIn: s.allIn }; });
    prevRef.current = { handId: h.handId, boardLen, inProgress: h.inProgress, street: h.street, curBet: h.currentBet, actingSeat: h.actingSeat, stacks, sh };
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

  // the instant reveals arrive at showdown, rank the hands CLIENT-side and
  // announce the winner — on-chain settlement lands a few seconds later, and
  // before this the table just sat silent with open cards
  useEffect(() => { sdWinRef.current = sdWin; }, [sdWin]);
  useEffect(() => {
    if (!snap) return;
    const h = snap.hand;
    if (!h.inProgress || h.street !== ST.SHOWDOWN || snap.board.length < 5) return;
    const key = String(h.dealId);
    const rv = reveals[key];
    if (!rv || (sdWin && sdWin.dealId === key)) return;
    let seat = -1, best = -1, tie = false;
    for (const k of Object.keys(rv)) {
      const ev = SP.handEval(rv[k].concat(snap.board));
      if (!ev) continue;
      if (ev.score > best) { best = ev.score; seat = Number(k); tie = false; }
      else if (ev.score === best) tie = true;
    }
    if (seat < 0) return;
    setSdWin({ dealId: key, seat, tie, comboEn: SP.handName(rv[seat].concat(snap.board)) });
    if (seat === snap.mySeat) sfx("win", prefs.sound);
  }, [snap, reveals]);

  function flash(msg, ms = 3000) { setToast(msg); setTimeout(() => setToast(null), ms); }
  async function tx(label, fn) {
    setBusy(true);
    try { await fn(); flash(label + " ✓"); await refreshBal(); return true; }
    catch (e) { flash(label + " ✗ " + (e?.shortMessage || e?.reason || e?.message || "").replace(/execution reverted:?/i, "").slice(0, 80), 5000); console.error(e); return false; }
    finally { setBusy(false); }
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
      const a = await SP.sdk.connect(); setAddr(a); setConnected(true); refreshBal(); flash("Connected ✓");
      // brand-new email wallets start empty — guide funding so they can play
      try { if ((await SP.sdk.walletBalance()) < SP.parseEther("0.02")) setModal({ type: "fund" }); } catch {}
    }
    catch (e) { if (e && e.message !== "cancelled") flash(e.message || "connect failed", 5000); }
  }
  const act = async (action, amount = 0) => {
    sfx("chip", prefs.sound);
    // optimistic: swap the buttons for a "sent" strip immediately — the tx is
    // headless and Somnia confirms fast, so waiting on the snapshot felt laggy
    if (snap && snap.hand.inProgress) setPendingAct({ dealId: String(snap.hand.dealId), street: snap.hand.street });
    const ok = await tx(["Fold", "Check", "Call", "Bet", "Raise", "All-in"][action], () => SP.sdk.act(tableId, action, amount, !!trn));
    if (!ok) setPendingAct(null);
    return ok;
  };

  /// LePoker-style: move to another table of the event IN PLACE — no page
  /// reload. Resets every per-table piece of state; the pollers re-key off
  /// tableId; the URL stays shareable via replaceState.
  function switchTable(tid) {
    if (tid === tableId) return;
    setSnap(null); setCtl(undefined);
    setHoles({}); setReveals({}); setSdWin(null); setPendingAct(null);
    setLastActs({}); setPotFly(null); setPreAct(null); setBetValue(0);
    setAnim({ dealing: false, flipFrom: 99, winnerSeat: -1, won: 0 });
    setMovedTo(null); setModal(null);
    moveRef.current = false; wasSeatedHereRef.current = false;
    gotHolesRef.current = {};
    prevRef.current = { handId: 0, boardLen: 0, inProgress: false, stacks: {} };
    [dealTimerRef, winTimerRef, sdTimerRef, potFlyRef, holeRetryRef].forEach((r) => clearTimeout(r.current));
    try { history.replaceState(null, "", "table?t=" + tid); } catch {}
    setTableId(tid);
  }

  if (!snap || ctl === undefined) return <div className="center-load">Loading table…</div>;

  const { cfg, hand, seats, mySeat } = snap;
  const maxSeats = cfg.maxSeats;
  const board = snap.board.map(SP.intToCardStr);
  const dealKey = String(hand.dealId);
  const myHoleObj = hand.inProgress ? holes[dealKey] : null;
  const myHole = myHoleObj ? myHoleObj.cardsStr : null;
  // combo label only from the flop — preflop "High Card" is pure noise for a
  // beginner ("why does it say ten-high before any cards are open?")
  const bestHand = myHoleObj && snap.board.length >= 3 ? SP.handName(myHoleObj.cards.concat(snap.board)) : "";
  const heroEval = bestHand ? SP.handEval(myHoleObj.cards.concat(snap.board)) : null;

  // Blind-position markers (like the D button): HU → the button IS the small
  // blind; multiway → SB/BB are the next in-hand seats clockwise of the button.
  const { sbSeat, bbSeat } = (() => {
    const out = { sbSeat: -1, bbSeat: -1 };
    if (!snap || !snap.hand.inProgress) return out;
    const ih = snap.seats.filter((x) => !x.empty && x.inHand).map((x) => x.index).sort((a, b) => a - b);
    if (ih.length < 2) return out;
    const btn = Number(snap.hand.button);
    const next = (i) => { const gt = ih.find((x) => x > i); return gt !== undefined ? gt : ih[0]; };
    if (ih.length === 2) { out.sbSeat = btn; out.bbSeat = next(btn); }
    else { out.sbSeat = next(btn); out.bbSeat = next(next(btn)); }
    return out;
  })();
  const markerFor = (idx) => {
    if (!snap.hand.inProgress) return null;
    if (idx === Number(snap.hand.button)) return "dealer";
    if (idx === sbSeat) return "sb";
    if (idx === bbSeat) return "bb";
    return null;
  };
  // rotate so my seat sits at the bottom
  CHIPS = !!trn || ctl !== ZERO_CTL; // controller ≠ zero → chip units, even before the trn poll lands
  const positions = POS[maxSeats] || (maxSeats < 6 ? POS[6] : POS[9]);
  const view = (i) => (mySeat >= 0 ? (i - mySeat + maxSeats) % maxSeats : i % maxSeats);
  const seatPos = (i) => positions[view(i)] || positions[0];
  const now = Math.floor(nowMs / 1000);
  const showdown = hand.inProgress && hand.street === ST.SHOWDOWN;

  // live big blind: tournament levels raise it mid-game while the table cfg is
  // cached — bb-counts must follow the CURRENT level, not the opening one
  const curBB = trn ? Number(trn.curBb) : NV(cfg.bigBlind);
  const bbOf = (stack) => (curBB > 0 ? Math.round((NV(stack) / curBB) * 10) / 10 : null);

  // tournament life-cycle screens (bust / final standings), derived each render
  // from the 5s tournament poll. A busted seat is vacated by reportBust, so
  // "registered + running + no seat anywhere" ⇔ I'm out and my place is final.
  const RUv = window.__SPLANG === "ru";
  const myAddrLc = addr ? addr.toLowerCase() : null;
  const trnFinished = !!(trn && trn.status >= 2);
  const trnBusted = !!(trn && trn.status === 1 && trn.reg && trn.myTable === -1 && mySeat < 0);
  const myBust = trn && trn.res && myAddrLc ? trn.res.busts.find((b) => b.player.toLowerCase() === myAddrLc) : null;
  const standings = trn && trn.res
    ? (trn.res.winner ? [{ player: trn.res.winner.player, place: 1, prize: trn.res.winner.prize }] : []).concat([...trn.res.busts].sort((a, b) => a.place - b.place))
    : [];
  const iWonTrn = !!(trn && trn.res && trn.res.winner && myAddrLc && trn.res.winner.player.toLowerCase() === myAddrLc);
  const ordinal = (n) => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
  const medal = (p) => (p === 1 ? "🥇" : p === 2 ? "🥈" : p === 3 ? "🥉" : null);
  // dismissals persist per tournament for the tab session — the screens must
  // not re-pop on every sibling table the player opens afterwards
  const seen = (k) => { try { return trn && sessionStorage.getItem(`sp_${k}seen_${trn.id}`) === "1"; } catch { return false; } };
  const markSeen = (k) => { try { if (trn) sessionStorage.setItem(`sp_${k}seen_${trn.id}`, "1"); } catch {} };

  // floating action badges: fold sticks for the whole hand, the rest fade after ~3s
  const ACT_LBL = { fold: "Fold", check: "Check", call: "Call", bet: "Bet", raise: "Raise", allin: "All-in" };
  const actFor = (idx) => {
    const a = lastActs[idx];
    if (!a) return null;
    if (a.kind === "fold") return hand.inProgress && seats[idx] && seats[idx].folded ? a : null;
    return nowMs - a.ts < 3000 ? a : null;
  };
  const actLabel = (a) => SPT(ACT_LBL[a.kind]) + (a.amt ? " " + (CHIPS ? a.amt : a.amt.toFixed(2)) : "");

  return (
    <div className="scaler" id="scaler">
      <div className="app" data-dir={theme} data-deck={deck} data-anim={reducedMo ? "off" : "on"} data-turbo={prefs.turbo ? "1" : "0"}>
        {/* top bar */}
        <header className="topbar">
          <div className="group">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }} title="Back to lobby" onClick={() => (location.href = "lobby")}>
              <SparkLogo size={24} />
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
            <span className="metapill"><span className="k">{SPT("Blinds")}</span><b>{CHIPS ? `${fmtChips(NV(cfg.smallBlind))} / ${fmtChips(NV(cfg.bigBlind))}` : `${NV(cfg.smallBlind)} / ${NV(cfg.bigBlind)}`}</b></span>
            <span className="metapill"><span className="k">{SPT("Hand")}</span><b>#{hand.handId}</b></span>
          </div>
          <div className="spacer" />
          {connected ? (
            <>
              <button className="metapill" style={{ cursor: "pointer" }} onClick={() => setModal({ type: "cashier" })}>
                <span className="k">{SPT("Cashier")}</span><b>{bal.toFixed(2)}</b>
              </button>
              {mySeat >= 0 && sessionOn && (
                <div className="session" title="Table session active — acting without a wallet popup">
                  <span className="pulse" /><span className="lock">{ChromeIcons.lock}</span><span>session</span>
                </div>
              )}
              <div className="wallet"><BraceLogo size={16} /><span className="bal tnum">{bal.toFixed(1)}</span><span className="net">{short(addr)}</span></div>
            </>
          ) : (
            <button className="metapill" style={{ cursor: "pointer", color: "var(--accent-soft)", borderColor: "var(--accent-32)", background: "var(--accent-12)" }} onClick={connect}>{SPT("Connect Wallet")}</button>
          )}
          {connected && mySeat >= 0 && (
            <button className="iconbtn" title={seats[mySeat].sittingOut ? SPT("Sit in") : SPT("Sit out")} disabled={busy}
              onClick={() => tx(seats[mySeat].sittingOut ? "Sit in" : "Sit out", () => SP.sdk.sitOut(tableId, !seats[mySeat].sittingOut))}>{ChromeIcons.pause}</button>
          )}
          <button className="iconbtn" title={SPT("Settings")} onClick={() => setShowSettings((s) => !s)}>{ChromeIcons.gear}</button>
          {/* Tournament chips can't be cashed out mid-event (the contract
              blocks leaveTable on controlled tables) — exit to the event page. */}
          {connected && mySeat >= 0 && (trn
            ? <button className="iconbtn leavebtn" title={SPT("Back to tournament")} disabled={busy}
                onClick={() => (location.href = "tournament?id=" + trn.id)}>{ChromeIcons.leave}</button>
            : <button className="iconbtn leavebtn" title={SPT("Leave table")} disabled={busy}
                onClick={() => tx("Leave", () => SP.sdk.leave(tableId))}>{ChromeIcons.leave}</button>)}
        </header>

        {showSettings && (
          <SettingsPanel t={prefs} lang={lang} setLang={setLang}
            set={setPref} dir={theme} setDir={setTheme} onClose={() => setShowSettings(false)}
            session={{
              active: sessionOn, busy,
              label: SP.sdk.backend === "privy" ? "Email wallet · headless (no popups)" : null,
              cap: mySeat >= 0 ? (CHIPS ? fmtChips(NV(seats[mySeat].stack)) : NV(seats[mySeat].stack).toFixed(2)) + " " + (CHIPS ? "chips" : SP.NETWORK.currency.symbol) : null,
              onActivate: SP.sdk.backend === "injected" ? () => tx("Activate session", () => SP.sdk.activateSession()).then(() => setSessionOn(true)) : null,
              onRevoke: SP.sdk.backend === "privy"
                ? () => { SP.sdk.signOut().finally(() => location.reload()); }
                : () => tx("Revoke session", () => SP.sdk.revokeSession()).then(() => setSessionOn(false)),
            }} />
        )}

        {trn && (() => {
          const lsb = Number(trn.curSb), lbb = Number(trn.curBb), lante = Number(trn.curAnte || 0);
          const nextIn = trn.nextAt ? Math.max(0, trn.nextAt - now) : null;
          const mm = nextIn != null ? Math.floor(nextIn / 60) : 0, ss = nextIn != null ? String(nextIn % 60).padStart(2, "0") : "00";
          const multi = trn.tables && trn.tables.length > 1;
          return (
            <div className="trn-hud">
              <span className="tag">{SPT("TOURNAMENT")} · {multi ? "MTT" : "SNG"} #{trn.id}</span>
              <span>{SPT("Level")} <b className="tnum">{trn.level + 1}</b></span>
              <span>{SPT("Blinds")} <b className="tnum">{fmtChips(lsb)} / {fmtChips(lbb)}{lante ? ` (${SPT("ante")} ${fmtChips(lante)})` : ""}</b></span>
              {trn.status === 1 && nextIn != null && nextIn > 0 && <span>{SPT("Next level")} <b className="tnum">{mm}:{ss}</b></span>}
              {trn.status === 1 && nextIn != null && nextIn === 0 && <span className="tag">{SPT("Level up between hands")}</span>}
              {trn.status === 1 && nextIn == null && <span className="tag">{SPT("Final level")}</span>}
              <span>{SPT("Players")} <b className="tnum">{trn.remaining}/{trn.registered}</b></span>
              <span>{SPT("Prize")} <b className="tnum">{Number(SP.fmt(trn.pool, 4))} {SP.NETWORK.currency.symbol}</b></span>
              <span>{SPT("Split")} <b className="tnum">{trn.payoutBps.map((b) => b / 100 + "%").join(" / ")}</b></span>
              {multi && (
                <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                  {trn.tables.map((tid, i) => (
                    <button key={tid} onClick={() => switchTable(tid)}
                      title={tid === tableId ? null : SPT("Switch to this table")}
                      style={{ cursor: tid === tableId ? "default" : "pointer", fontFamily: "var(--mono)", fontSize: 11, padding: "3px 9px", borderRadius: 999,
                        border: "1px solid " + (tid === tableId ? "var(--accent, #d9ab4a)" : "var(--line-2, #3a3a48)"),
                        background: tid === tableId ? "var(--accent-12, rgba(217,171,74,.12))" : "transparent",
                        color: tid === tableId ? "var(--accent-soft, #f2d78a)" : "var(--muted, #9a9aa8)" }}>
                      {SPT("Table")} {i + 1}{trn.counts && trn.counts[tid] != null ? ` · ${trn.counts[tid]}` : ""}
                    </button>
                  ))}
                </span>
              )}
              {trn.status === 2 && <span className="done">{SPT("FINISHED")}</span>}
            </div>
          );
        })()}

        <div className="mainrow">
          <div className="feltwrap scanlines" ref={feltWrapRef}>
            <canvas className="feltcanvas" ref={canvasRef} />
            <div className="feltglow" />
            <div className="felt">
              <div className="center">
                {anim.dealing && <span className="zkbadge shuffling"><span className="chk">{ChromeIcons.shield}</span>{SPT("shuffling — commitment sealed on-chain")}</span>}
                <Board cards={board} deckMode={deck} flipFrom={anim.flipFrom} />
                {hand.inProgress
                  ? <Pot pot={NV(hand.pot)} chips={CHIPS} />
                  : <div className="pot"><div className="potmain"><span className="k">
                      {seats.filter((s) => !s.empty && !s.sittingOut).length >= 2
                        ? SPT("Next hand starting…") /* players ARE here — we're waiting on the dealer, say so */
                        : SPT("Waiting for players")}
                    </span></div></div>}
              </div>
              {(anim.winnerSeat >= 0 || sdWin) && (() => {
                const settled = anim.winnerSeat >= 0;
                const wSeat = settled ? anim.winnerSeat : sdWin.seat;
                const rvW = reveals[dealKey] && reveals[dealKey][wSeat];
                const comboEn = rvW ? SP.handName(rvW.concat(snap.board)) : (sdWin && sdWin.seat === wSeat ? sdWin.comboEn : null);
                const iWon = mySeat === wSeat;
                const played = mySeat >= 0 && !!holes[dealKey]; // I was dealt into this hand
                return <WinBanner
                  won={settled ? (CHIPS ? fmtChips(anim.won) : anim.won.toFixed(2)) : null}
                  lose={played && !iWon}
                  name={!iWon && seats[wSeat] ? nameOf(seats[wSeat].player) : null}
                  pending={!settled}
                  unit={CHIPS ? SPT("chips") : "SOMI"}
                  hand={comboEn ? SPTHand(comboEn) : ""} />;
              })()}
            </div>
            <div className="feltvignette" />

            {/* opponents' face-down cards while in hand; on fold the backs get
                one last render with the muck animation (slide to the pot).
                At SHOWDOWN each seat's backs stay put until ITS revealed cards
                arrive from the chain — the reveal tx can take seconds under
                load, and backs vanishing into nothing read as a glitch */}
            {hand.inProgress && seats.map((s) => {
              if (s.empty || s.index === mySeat) return null;
              if (showdown && reveals[dealKey] && reveals[dealKey][s.index]) return null; // flipped up in the Seat
              const fa = lastActs[s.index];
              const mucking = !s.inHand && fa && fa.kind === "fold" && nowMs - fa.ts < 1400;
              if (!s.inHand && !mucking) return null;
              const pos = seatPos(s.index);
              return <HoleBacks key={"b" + s.index} pos={pos} deal={anim.dealing && s.inHand && !showdown} delay={300 + s.index * 120}
                muck={mucking} mx={(50 - pos.x) * 4} my={(43 - pos.y) * 5} />;
            })}

            {/* seats */}
            {seats.map((s) => {
              if (s.index === mySeat) return null; // hero is shown in the herozone
              const pos = seatPos(s.index);
              if (s.empty) {
                if (trn || ctl !== ZERO_CTL) return null; // tournament seats are managed by the tournament
                return (
                  <div key={s.index} className="seat" style={{ left: pos.x + "%", top: pos.y + "%" }}>
                    <button className="emptyseat" onClick={() => connected ? setModal({ type: "sit", seat: s.index }) : connect()}>
                      <span className="plus">+</span><span>{connected ? SPT("Sit") : SPT("Connect")}</span>
                    </button>
                  </div>
                );
              }
              const isMe = s.index === mySeat;
              const active = hand.inProgress && hand.actingSeat === s.index && hand.street <= ST.RIVER;
              const rev = showdown && reveals[dealKey] && reveals[dealKey][s.index] ? reveals[dealKey][s.index].map(SP.intToCardStr) : null;
              return (
                <Seat key={s.index}
                  player={{ hero: isMe, name: nameOf(s.player), avId: avOf(s.player).id, avImg: avOf(s.player).img }}
                  data={{
                    stack: NV(s.stack),
                    bbstacks: prefs.bbstacks, bbval: bbOf(s.stack),
                    ...(CHIPS ? { chips: NV(s.stack), bb: Math.max(0, Math.round(NV(s.stack) / Math.max(1, curBB))) } : {}),
                    status: s.allIn ? SPT("all-in") : s.folded ? SPT("folded") : s.sittingOut ? SPT("sitting out") : (hand.inProgress && s.inHand ? "" : SPT("waiting")),
                    folded: s.folded, allin: s.allIn, winner: s.index === anim.winnerSeat || (sdWin && sdWin.seat === s.index),
                    timer: Number(cfg.actionTimeout),
                    combo: rev ? SPTHand(SP.handName(reveals[dealKey][s.index].concat(snap.board))) : null,
                    comboCat: rev ? (SP.handEval(reveals[dealKey][s.index].concat(snap.board)) || {}).cat : null,
                    lastAct: actFor(s.index) ? { kind: lastActs[s.index].kind, text: actLabel(lastActs[s.index]) } : null,
                  }}
                  pos={pos} active={active} marker={markerFor(s.index)} deckMode={deck}
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
                {/* after folding your cards stay on the table, grayed — vanishing
                    instantly read as a glitch */}
                {hand.inProgress && (seats[mySeat].inHand || seats[mySeat].folded) && (
                  <div className="hole peek">
                    {myHole
                      ? myHole.map((c, i) => <Card key={dealKey + i} c={c} folded={seats[mySeat].folded} className={heroDealing ? "deal" : ""} style={heroDealing ? { "--dy": "-220px", "--dr": (i ? 4 : -2) + "deg", animationDelay: i * 80 + "ms" } : undefined} />)
                      : (seats[mySeat].inHand ? [<Card key="0" back />, <Card key="1" back />] : null)}
                  </div>
                )}
                {myHole && bestHand && !seats[mySeat].folded && <div className="herocombo" style={heroEval ? comboStyle(heroEval.cat) : undefined}>{SPTHand(bestHand)}</div>}
                <div className={"heroinfo" + (hand.inProgress && hand.actingSeat === mySeat ? " active" : "") + (seats[mySeat].allIn ? " allin" : "") + (seats[mySeat].folded ? " folded" : "") + (mySeat === anim.winnerSeat || (sdWin && sdWin.seat === mySeat) ? " winner" : "")}>
                  {actFor(mySeat) && <span className={"actchip " + lastActs[mySeat].kind}>{actLabel(lastActs[mySeat])}</span>}
                  <AvatarIcon av={avOf(addr).id} img={avOf(addr).img} name={nameOf(addr)} />
                  <div className="meta">
                    <span className="nm">YOU · {nameOf(addr)}</span>
                    <span className="stack tnum">{prefs.bbstacks && bbOf(seats[mySeat].stack) != null
                      ? <React.Fragment>{bbOf(seats[mySeat].stack)}<span className="u">BB</span></React.Fragment>
                      : <React.Fragment>{CHIPS ? fmtChips(NV(seats[mySeat].stack)) : NV(seats[mySeat].stack).toFixed(2)}<span className="u">{CHIPS ? "chips" : SP.NETWORK.currency.symbol}</span></React.Fragment>}</span>
                  </div>
                  <div className="hmark">{markerFor(mySeat) && <Marker kind={markerFor(mySeat)} />}</div>
                  <span className="hstatus">{seats[mySeat].allIn ? SPT("all-in") : seats[mySeat].folded ? SPT("folded") : seats[mySeat].sittingOut ? SPT("sitting out") : ""}</span>
                </div>
              </div>
            )}

            {/* pot collected to the winner (motion only — the banner shows regardless) */}
            {anim.winnerSeat >= 0 && !reducedMo && (
              <FlyChips wrapRef={feltWrapRef} toX={seatPos(anim.winnerSeat).x} toY={seatPos(anim.winnerSeat).y} />
            )}

            {/* chips flying INTO the pot: antes at the deal, bets swept at street end */}
            {potFly && hand.inProgress && potFly.idxs.map((i, k) => {
              const p = seatPos(i);
              const from = potFly.kind === "sweep"
                ? { x: p.x + (50 - p.x) * 0.34, y: p.y + (46 - p.y) * 0.34 } // bet-chip spot
                : { x: p.x, y: p.y }; // ante: straight from the seat
              return <FlyToPot key={potFly.ts + "-" + i} wrapRef={feltWrapRef} fromX={from.x} fromY={from.y} delay={k * 60} />;
            })}
          </div>
          <button className="railfab" title={SPT("chat")} onClick={() => setRailOpen(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21 12a8 8 0 0 1-8 8H4l2.2-2.6A8 8 0 1 1 21 12z"/></svg>
          </button>
          <LiveSideRail key={tableId} tableId={tableId} snap={snap} connected={connected} mySeat={mySeat} mobileOpen={railOpen} onClose={() => setRailOpen(false)} />
        </div>

        {renderBar()}

        {/* MTT rebalance: seat moved to another table → announce + auto-follow */}
        {movedTo != null && (
          <div className="lt-modalbg" style={{ zIndex: 340 }}>
            <div className="lt-modal" style={{ width: "min(430px, 92vw)", textAlign: "center" }}>
              <div style={{ fontSize: 34, lineHeight: 1 }}>🔀</div>
              <h3 style={{ marginTop: 10 }}>{RUv ? "Вас пересадили за другой стол" : "You've been moved to another table"}</h3>
              <p className="note">{RUv
                ? `Балансировка столов: ваше место теперь за столом #${movedTo}. Сейчас перенесём…`
                : `Table balancing: your seat is now at table #${movedTo}. Taking you there…`}</p>
              <button className="pill primary" style={{ width: "100%", marginTop: 10 }} onClick={() => switchTable(movedTo)}>{RUv ? "Перейти сейчас →" : "Go now →"}</button>
            </div>
          </div>
        )}

        {/* busted out: place + prize instead of a silent "you're observing" */}
        {trnBusted && !bustHidden && !seen("bust") && movedTo == null && (
          <div className="lt-modalbg" style={{ zIndex: 320 }}>
            <div className="lt-modal" style={{ width: "min(440px, 92vw)", textAlign: "center" }}>
              <div style={{ fontSize: 36, lineHeight: 1 }}>{myBust && myBust.prize > 0n ? "💰" : "🃏"}</div>
              <h3 style={{ marginTop: 10 }}>{RUv ? "Вы выбыли из турнира" : "You're out of the tournament"}</h3>
              <div style={{ fontFamily: "var(--mono)", fontSize: 21, color: "var(--accent-soft, #f2d78a)", margin: "4px 0 6px" }}>
                {myBust
                  ? (RUv ? `${myBust.place}-е место из ${trn.registered}` : `${ordinal(myBust.place)} of ${trn.registered}`)
                  : (RUv ? "Определяем ваше место…" : "Finalizing your place…")}
              </div>
              {myBust && myBust.prize > 0n
                ? <p className="note" style={{ color: "var(--win, #57d9a3)" }}>{RUv
                    ? `Приз ${N(myBust.prize)} ${SP.NETWORK.currency.symbol} уже зачислен на ваш баланс в кассе.`
                    : `Prize ${N(myBust.prize)} ${SP.NETWORK.currency.symbol} — already credited to your Cashier balance.`}</p>
                : <p className="note">{RUv ? "В этот раз без приза — удачи в следующем!" : "No prize this time — better luck in the next one!"}</p>}
              <div className="row" style={{ marginTop: 14 }}>
                <button className="pill" onClick={() => { markSeen("bust"); setBustHidden(true); }}>{RUv ? "Наблюдать финал" : "Watch the finish"}</button>
                <button className="pill primary" onClick={() => { markSeen("bust"); location.href = "tournament?id=" + trn.id; }}>{RUv ? "К турниру" : "Tournament page"}</button>
              </div>
              <button className="pill" style={{ width: "100%", marginTop: 8 }} onClick={() => (location.href = "lobby")}>{RUv ? "В лобби" : "Back to lobby"}</button>
            </div>
          </div>
        )}

        {/* tournament finished: winner + full standings (players AND observers) */}
        {trnFinished && !finalHidden && !seen("final") && standings.length > 0 && (
          <div className="lt-modalbg" style={{ zIndex: 320 }}>
            <div className="lt-modal" style={{ width: "min(520px, 94vw)" }}>
              <div style={{ textAlign: "center", fontSize: 36, lineHeight: 1 }}>🏆</div>
              <h3 style={{ textAlign: "center", marginTop: 10 }}>
                {iWonTrn
                  ? (RUv ? "Поздравляем — вы выиграли турнир!" : "Congratulations — you won the tournament!")
                  : (RUv ? "Турнир завершён" : "Tournament finished")}
              </h3>
              {trn.res.winner && (
                <div style={{ textAlign: "center", fontFamily: "var(--mono)", fontSize: 14.5, color: "var(--accent-soft, #f2d78a)", marginBottom: 12 }}>
                  {RUv ? "Победитель" : "Winner"}: <b>{nameOf(trn.res.winner.player)}</b> · {N(trn.res.winner.prize)} {SP.NETWORK.currency.symbol}
                </div>
              )}
              <div style={{ maxHeight: 280, overflowY: "auto", border: "1px solid var(--line-2, #3a3a48)", borderRadius: 10 }}>
                {standings.map((r, i) => {
                  const me = myAddrLc && r.player.toLowerCase() === myAddrLc;
                  return (
                    <div key={r.place} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px",
                      borderTop: i === 0 ? "none" : "1px solid var(--hair, rgba(255,255,255,.06))",
                      background: me ? "var(--accent-12, rgba(217,171,74,.12))" : r.place <= 3 ? "rgba(217,171,74,.05)" : "transparent" }}>
                      <span style={{ width: 36, fontFamily: "var(--mono)", fontSize: 13, color: r.place <= 3 ? "var(--accent-soft, #f2d78a)" : "var(--muted, #9a9aa8)" }}>{medal(r.place) || "#" + r.place}</span>
                      <AvatarIcon av={avOf(r.player).id} img={avOf(r.player).img} name={nameOf(r.player)} size={22} style={{ borderRadius: 6 }} />
                      <span style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 13, color: "var(--text, #e6e6ee)" }}>{nameOf(r.player)}{me ? (RUv ? " · вы" : " · you") : ""}</span>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: r.prize > 0n ? "var(--win, #57d9a3)" : "var(--muted, #9a9aa8)" }}>{r.prize > 0n ? `+${N(r.prize)} ${SP.NETWORK.currency.symbol}` : "—"}</span>
                    </div>
                  );
                })}
              </div>
              <div className="row" style={{ marginTop: 14 }}>
                <button className="pill" onClick={() => { markSeen("final"); setFinalHidden(true); }}>{RUv ? "Посмотреть стол" : "View the table"}</button>
                <button className="pill primary" onClick={() => { markSeen("final"); location.href = "lobby"; }}>{RUv ? "В лобби" : "Back to lobby"}</button>
              </div>
            </div>
          </div>
        )}

        {toast && <div className="lt-toast">{toast}</div>}
        {modal && <Modal kind={modal} close={() => setModal(null)} sdk={SP.sdk} tableId={tableId} cfg={cfg} bal={bal} tx={tx} refresh={refreshBal} />}
      </div>
    </div>
  );

  function renderBar() {
    if (!connected) return <StatusStrip text={SPT("Sign in to play")} sub={SPT("Email login → instant Somnia wallet, no popups")} accent="var(--accent-soft)" />;
    if (mySeat < 0) {
      if (trnBusted) return <StatusStrip
        text={RUv ? "Вы выбыли — наблюдаете" : "You're out — observing"}
        sub={myBust ? (RUv ? `${myBust.place}-е место из ${trn.registered}` : `You finished ${ordinal(myBust.place)} of ${trn.registered}`) : ""}
        accent="var(--muted)" />;
      // spying on a sibling MTT table while my own seat lives elsewhere
      if (trn && trn.status === 1 && trn.reg && trn.myTable >= 0 && trn.myTable !== tableId) {
        return (
          <div className="actionbar" style={{ flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}>
            <div style={{ fontFamily: "var(--label)", fontSize: 13, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--accent-soft)" }}>
              {RUv ? `Здесь вы наблюдаете — ваше место за столом #${trn.myTable}` : `You're observing — your seat is at table #${trn.myTable}`}
            </div>
            <button className="pill" onClick={() => switchTable(trn.myTable)}>{RUv ? "К своему столу →" : "Back to my table →"}</button>
          </div>
        );
      }
      return (trn || ctl !== ZERO_CTL)
        ? <StatusStrip text={SPT("Tournament table — you're observing")} sub={SPT("Seats are assigned by the tournament; register on its page to play")} accent="var(--muted)" />
        : <StatusStrip text={SPT("Take an empty seat to join")} sub={SPT("Click a “+ Sit” spot around the table")} accent="var(--muted)" />;
    }
    const me = seats[mySeat];
    const myTurn = hand.inProgress && hand.actingSeat === mySeat && hand.street <= ST.RIVER;
    // action already sent — hide the buttons instantly instead of leaving them
    // greyed-out until the snapshot confirms the turn moved on
    if (myTurn && pendingAct && pendingAct.dealId === dealKey && pendingAct.street === hand.street) {
      return <StatusStrip text={SPT("Action sent") + " ✓"} sub={SPT("Confirming on-chain…")} accent="var(--accent-soft)" />;
    }
    if (!myTurn) {
      const text = hand.inProgress ? (hand.street === ST.SHOWDOWN ? SPT("Showdown — settling on-chain") : SPT("Waiting for your turn")) : SPT("Waiting for the next hand");
      const showPre = hand.inProgress && me.inHand && !me.folded && !me.allIn && hand.street <= ST.RIVER;
      return (
        <div className="actionbar" style={{ flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}>
          {showPre && (
            <div style={{ display: "flex", gap: 8 }}>
              {[["checkfold", SPT("Check") + " / " + SPT("Fold")], ["callany", SPT("Call") + " " + (window.__SPLANG === "ru" ? "всегда" : "Any")], ["check", SPT("Check")]].map(([k, l]) => (
                <button key={k} className="pill" onClick={() => setPreAct(preAct === k ? null : k)}
                  style={preAct === k ? { background: "var(--accent)", borderColor: "var(--accent)", color: "#1b1407" } : undefined}>
                  {preAct === k ? "✓ " : ""}{l}
                </button>
              ))}
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            <div style={{ fontFamily: "var(--label)", fontSize: 13, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--muted)" }}>{text}</div>
            {showPre && preAct && <div style={{ fontFamily: "var(--body)", fontSize: 12.5, color: "var(--muted)" }}>{SPT("Pre-action armed — fires instantly on your turn")}</div>}
          </div>
        </div>
      );
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
            <button className="abtn fold" disabled={busy} onClick={onFold}><span className="key">F</span><span className="lbl">{SPT("Fold")}</span></button>
            <button className="abtn call" disabled={busy} onClick={onCheckCall}><span className="key">C</span><span className="lbl">{canCheck ? SPT("Check") : SPT("Call")}</span>{!canCheck && <span className="amt tnum">{call.toFixed(2)}</span>}</button>
            {me.stack > 0n && !canCheck && <button className="abtn raise" disabled={busy} onClick={() => act(A.ALLIN)}><span className="lbl">{SPT("All-in")}</span><span className="amt tnum">{maxN.toFixed(2)}</span></button>}
          </div>
        </div>
      );
    }
    const actionData = {
      toCall: call, minRaise: minN, potForBet: pot, heroStack: maxN,
      best: SPTHand(bestHand) || "—", outs: "—", potOdds: canCheck ? "—" : Math.round((call / (pot + call)) * 100) + "%",
      raiseLabel: isBet ? SPT("Bet") : SPT("Raise to"), canCheck, step: NV(cfg.bigBlind) || (CHIPS ? 1 : 0.01), symbol: CHIPS ? SPT("chips") : SP.NETWORK.currency.symbol,
      timer: Math.max(0, hand.actingDeadline - now), timerTotal: Number(cfg.actionTimeout),
    };
    return <ActionBar action={actionData} onFold={onFold} onCheckCall={onCheckCall} onRaise={onRaise} betValue={bv} setBetValue={setBetValue} />;
  }
}

/* live side rail: real chat (via dealer bot), on-chain hand history, private notes */
function LiveSideRail({ tableId, snap, connected, mySeat, mobileOpen, onClose }) {
  const [tab, setTab] = useState("chat");
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState("");
  const [hands, setHands] = useState(null);
  const [notes, setNotes] = useState(() => { try { return JSON.parse(localStorage.getItem("sp_notes") || "{}"); } catch { return {}; } });
  const [commit, setCommit] = useState(null);
  const sinceRef = useRef(0);
  const bodyRef = useRef(null);

  useEffect(() => {
    let stop = false;
    async function poll() {
      try {
        const list = await SP.sdk.getChat(tableId, sinceRef.current);
        if (!stop && list.length) { sinceRef.current = list[list.length - 1].id; setMsgs((m) => [...m, ...list].slice(-60)); }
      } catch {}
    }
    poll();
    const iv = setInterval(poll, 2500);
    return () => { stop = true; clearInterval(iv); };
  }, []);
  useEffect(() => { if (tab === "chat" && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }, [msgs, tab]);

  useEffect(() => {
    let stop = false;
    const load = async () => { try { const h = await SP.sdk.recentHands(tableId); if (!stop) setHands(h); } catch { if (!stop) setHands([]); } };
    load();
    const iv = setInterval(load, 30000);
    return () => { stop = true; clearInterval(iv); };
  }, []);

  useEffect(() => {
    if (!snap || !snap.hand.inProgress) return;
    let stop = false;
    SP.sdk.dealCommit(snap.hand.dealId).then((c) => { if (!stop) setCommit(c); }).catch(() => {});
    return () => { stop = true; };
  }, [snap && String(snap.hand.dealId), snap && snap.hand.street]);

  async function send() {
    const text = input.trim();
    if (!text || !connected || mySeat < 0) return;
    setInput("");
    try { await SP.sdk.sendChat(tableId, text); } catch (e) { console.warn("chat:", e.message); }
  }

  const saveNote = (a, patch) => setNotes((n) => { const next = { ...n, [a]: { ...(n[a] || {}), ...patch } }; try { localStorage.setItem("sp_notes", JSON.stringify(next)); } catch {} return next; });
  const opponents = snap ? snap.seats.filter((s) => !s.empty && s.index !== mySeat) : [];
  const shh = (h) => (h ? h.slice(0, 10) + "…" + h.slice(-8) : "");

  return (
    <aside className={"siderail" + (mobileOpen ? " open" : "")}>
      <div className="railtabs">
        <button className="railclose" onClick={onClose} title="Close">✕</button>
        {["chat", "hands", "notes"].map((t2) => <button key={t2} className={tab === t2 ? "on" : ""} onClick={() => setTab(t2)}>{SPT(t2)}</button>)}
      </div>
      <div style={{ padding: "9px 12px", borderBottom: "1px solid var(--line)" }}>
        <span className="tag">{tab === "chat" ? SPT("table chat · dealer feed") : tab === "hands" ? SPT("hand history · on-chain") : SPT("private player notes")}</span>
      </div>
      <div className="railbody" ref={bodyRef}>
        {tab === "chat" && (msgs.length === 0
          ? <div className="chatline dealer">Welcome — live on Somnia. Provably-fair commit-reveal dealing.</div>
          : msgs.map((m) => <div key={m.id} className={"chatline" + (m.dealer ? " dealer" : "")}>{!m.dealer && <span className="who">{m.who}</span>}{m.text}</div>))}
        {tab === "hands" && (hands == null
          ? <div className="chatline dealer">Loading on-chain history…</div>
          : hands.length === 0 ? <div className="chatline dealer">No settled hands yet at this table.</div>
          : hands.map((h2, i) => {
              const who = snap && snap.seats[h2.seat] && !snap.seats[h2.seat].empty ? short(snap.seats[h2.seat].player) : "seat " + h2.seat;
              return <div key={i} className="hhrow"><span className="st">#{h2.handId}</span><span className="act">{who} won <b className="tnum">{CHIPS ? Number(h2.amount) : Number(SP.fmt(h2.amount, 6))}</b> · {h2.kind}</span></div>;
            }))}
        {tab === "notes" && (
          <div>
            {opponents.length === 0 && <div className="chatline dealer">No opponents seated yet.</div>}
            {opponents.map((s) => {
              const n = notes[s.player.toLowerCase()] || {};
              return (
                <div key={s.index} style={{ padding: "8px 4px", borderBottom: "1px solid var(--hair)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                    {["#ef5a6f", "#e8c15a", "#46d39a", "#d9ab4a"].map((c) => (
                      <span key={c} onClick={() => saveNote(s.player.toLowerCase(), { tag: n.tag === c ? null : c })}
                        style={{ width: 12, height: 12, borderRadius: "50%", background: c, cursor: "pointer", opacity: n.tag === c ? 1 : 0.35, outline: n.tag === c ? "1.5px solid #fff" : "none" }} />
                    ))}
                    <span style={{ fontFamily: "var(--label)", fontSize: 11.5, color: n.tag || "var(--text-2)" }}>{short(s.player)}</span>
                  </div>
                  <input placeholder="Add a note…" defaultValue={n.text || ""}
                    onBlur={(e) => saveNote(s.player.toLowerCase(), { text: e.target.value })}
                    style={{ width: "100%", background: "rgba(255,255,255,.04)", border: "1px solid var(--line-2)", color: "var(--text)", borderRadius: 7, padding: "6px 8px", fontFamily: "var(--label)", fontSize: 12 }} />
                </div>
              );
            })}
          </div>
        )}
      </div>
      {tab === "chat" && (
        <div style={{ display: "flex", gap: 6, padding: "8px 10px", borderTop: "1px solid var(--line)" }}>
          <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder={connected && mySeat >= 0 ? SPT("Say something…") : SPT("Sit down to chat")} disabled={!connected || mySeat < 0}
            style={{ flex: 1, background: "rgba(255,255,255,.04)", border: "1px solid var(--line-2)", color: "var(--text)", borderRadius: 7, padding: "7px 9px", fontFamily: "var(--label)", fontSize: 12 }} />
          <button className="pill" onClick={send} disabled={!connected || mySeat < 0}>{SPT("Send")}</button>
        </div>
      )}
      <div className="pfwidget">
        <div className="pfhead">
          <span className="ttl">{ChromeIcons.shield} {SPT("provably fair · commit-reveal")}</span>
        </div>
        <div className="commit">
          <div><span className="lab">commit</span> {commit ? shh(commit.seedHash) : "— waiting for a hand —"}</div>
          <div style={{ marginTop: 4 }}><span className="lab">deck</span> {commit && commit.revealed ? "revealed & verified on-chain ✓" : "sealed pre-deal · reveal post-hand"}</div>
        </div>
      </div>
    </aside>
  );
}

/* sit / cashier modal */
function Modal({ kind, close, sdk, tableId, cfg, bal, tx, refresh }) {
  const minE = Number(SP.fmt(cfg.minBuyIn, 4)), maxE = Number(SP.fmt(cfg.maxBuyIn, 4));
  const [amt, setAmt] = useState(kind.type === "sit" ? String(maxE) : "1");
  const amtNum = parseFloat(amt) || 0;
  const amtOk = amtNum >= minE && amtNum <= maxE;
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
            <h3>{SPT("Sit at seat")} {kind.seat}</h3>
            <p className="note">{SPT("Blinds")} {Number(SP.fmt(cfg.smallBlind, 4))}/{Number(SP.fmt(cfg.bigBlind, 4))} {SP.NETWORK.currency.symbol}. {SPT("Buy-in")} {minE}–{maxE}.</p>
            <label>{SPT("Buy-in")} ({minE}–{maxE} {SP.NETWORK.currency.symbol})</label>
            <input value={amt} onChange={(e) => setAmt(e.target.value)} style={{ borderColor: amtOk ? undefined : "var(--danger, #ef5a6f)" }} />
            {!amtOk && <p className="note" style={{ color: "var(--danger, #ef5a6f)" }}>{SPT("Buy-in")}: {minE}–{maxE} {SP.NETWORK.currency.symbol}</p>}
            <div className="row">
              <button className="pill" onClick={close}>{SPT("Cancel")}</button>
              <button className="pill primary" disabled={!amtOk} onClick={async () => {
                close();
                await tx("Take seat", async () => {
                  // one game at a time: block sitting here while seated anywhere
                  // else (cash or a running tournament table)
                  const other = await sdk.seatedTableAt(tableId);
                  if (other >= 0) throw new Error(window.__SPLANG === "ru"
                    ? `Вы уже играете за столом #${other} — сначала покиньте его`
                    : `You're already playing at table #${other} — leave it first`);
                  const need = SP.parseEther(amt);
                  const have = await sdk.balanceOf(sdk.address);
                  if (have < need) await sdk.deposit(SP.fmt(need - have, 6));
                  await sdk.sitDown(tableId, kind.seat, amt);
                  // injected wallets: grant a session key so actions need no popup.
                  // Privy email wallets are already headless — nothing to do.
                  if (sdk.backend === "injected" && !sdk.hasSession()) await sdk.activateSession();
                });
              }}>{SPT("Take seat")}</button>
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
    if (window.innerWidth <= 760) { // fluid mobile layout (mobile.css) - no stage scaling
      app.style.transform = ""; app.style.position = ""; app.style.top = ""; app.style.left = "";
      scaler.style.width = ""; scaler.style.height = "";
      return;
    }
    const s = Math.min((window.innerWidth - 24) / 1600, (window.innerHeight - 84) / 1000);
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
