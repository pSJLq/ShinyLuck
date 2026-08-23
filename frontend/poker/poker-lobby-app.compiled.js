/* AUTO-GENERATED from poker-lobby-app.jsx by scripts/build-poker-jsx.js — do NOT edit. */
/* ShinyPoker · LIVE lobby. Design look (lobby.css) driven by on-chain tables
   via window.SP. Cash tab is live; other tabs are flagged coming-soon. */
// `var`, not `const`: the cashier and the page app both bind these and now
// share one global script scope — a second `const` would kill the page.
var {
  useState: uS,
  useEffect: uE,
  useRef: uR
} = React;
// Render modals to <body> so they escape the scaled/transformed .app (a CSS
// transform makes position:fixed resolve against .app, not the viewport).
// `var`, not `const`: the lobby loads this file alongside another that
// defines the same two helpers, and as plain scripts they share one global
// scope — a duplicate `const` is a SyntaxError that blanks the page.
var Portal = ({
  children
}) => window.ReactDOM && ReactDOM.createPortal ? ReactDOM.createPortal(children, document.body) : children;
// Little circular "?" with a hover explanation (native title tooltip).
var Hint = ({
  text
}) => /*#__PURE__*/React.createElement("span", {
  title: text,
  style: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 14,
    height: 14,
    borderRadius: "50%",
    border: "1px solid var(--muted)",
    color: "var(--muted)",
    fontSize: 9,
    cursor: "help",
    marginLeft: 5,
    verticalAlign: "middle"
  }
}, "?");
const Ln = wei => Number(SP.fmt(wei, 6));
const lshort = a => a && a !== "0x0000000000000000000000000000000000000000" ? a.slice(0, 6) + "…" + a.slice(-4) : "";
const stakeOf = bb => bb <= 0.05 ? "micro" : bb <= 1 ? "low" : bb <= 5 ? "mid" : "high";

// Three separate components poll the tournament list on the same 4s cadence.
// Un-shared, that is three independent chain reads per cycle - and each one
// then fired one isRegisteredIn per tournament SEQUENTIALLY, so a connected
// wallet looking at ten tournaments drove ~23 awaited reads every 4 seconds.
// One in-flight read is shared for a beat; actions bust it so a freshly
// created or joined tournament still shows up immediately.
let _trnCache = {
  at: 0,
  p: null
};
function trnList() {
  const now = Date.now();
  if (_trnCache.p && now - _trnCache.at < 3000) return _trnCache.p;
  _trnCache = {
    at: now,
    p: SP.sdk.tournaments().catch(e => {
      _trnCache = {
        at: 0,
        p: null
      };
      throw e;
    })
  };
  return _trnCache.p;
}
function bustTrnCache() {
  _trnCache = {
    at: 0,
    p: null
  };
}
// registration lookups run together instead of one-at-a-time
async function regMap(ts) {
  const pairs = await Promise.all(ts.map(async t => [t.id, await SP.sdk.isRegisteredIn(t.id)]));
  const m = {};
  for (const [id, v] of pairs) m[id] = v;
  return m;
}
function LobbyApp() {
  // Language is owned by the casino's Settings · repaint the WHOLE tree when it
  // changes so every SPT() below re-runs at once. It has to sit on the root:
  // the lobby's own stats live here, and a tab-level hook would leave them
  // waiting on the 4s poll to catch up (measured: ~2s of stale labels).
  const [, setLangTick] = uS(0);
  uE(() => {
    const on = () => setLangTick(n => n + 1);
    window.addEventListener("sp-lang-changed", on);
    return () => window.removeEventListener("sp-lang-changed", on);
  }, []);

  // footer/nav deep-links: lobby?tab=tournaments|cash
  const [tab, setTab] = uS(() => {
    const t = new URLSearchParams(location.search).get("tab");
    return ["cash", "tournaments"].includes(t) ? t : "cash";
  });
  const [rows, setRows] = uS([]);
  const [loaded, setLoaded] = uS(false);
  const [connected, setConnected] = uS(false);
  const [addr, setAddr] = uS(null);
  const [bal, setBal] = uS(0);
  const [stake, setStake] = uS("all");
  const [size, setSize] = uS("all");
  const [trnCount, setTrnCount] = uS(0);
  const [trnSeated, setTrnSeated] = uS(0);
  const [showCreate, setShowCreate] = uS(false);
  const [showCashier, setShowCashier] = uS(false);
  // try/catch, not a bare read: in a framed WKWebView (Telegram on iOS with
  // tracking prevention on) `localStorage` THROWS instead of returning null.
  // Thrown from a state initializer, that blanks the whole lobby with no error
  // on screen — the exact failure §26 chased. poker-boot.js also shims the
  // whole object; this is the second lock on the same door.
  const [theme] = uS(() => {
    try {
      return localStorage.getItem("sp_theme") || "b";
    } catch (e) {
      return "b";
    }
  });

  // Ambient backdrop is poker-dust.js now (six composited sparks) instead of a
  // GridField canvas repainting thousands of cells every frame at 16% opacity.

  // restore Privy session
  uE(() => {
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
  async function refreshBal() {
    if (SP.sdk.address) {
      try {
        setBal(Ln(await SP.sdk.balanceOf(SP.sdk.address)));
      } catch {}
    }
  }

  // Deep-link: the table/tournament headers send the wallet chip here (lobby?cashier=1).
  uE(() => {
    if (connected && new URLSearchParams(location.search).get("cashier") === "1") {
      setShowCashier(true);
      history.replaceState(null, "", "lobby");
    }
  }, [connected]);

  // poll live tables
  uE(() => {
    let stop = false;
    async function load() {
      try {
        let out;
        // dealer cache first: ONE GET for the whole lobby instead of ~5 RPC
        // calls per table per client · the difference between 20 and 200 users
        const lob = await SP.sdk.lobbySnapshot();
        if (lob && Array.isArray(lob.tables)) {
          out = lob.tables.filter(r => r.controller === "0x0000000000000000000000000000000000000000").map(r => ({
            id: Number(r.id),
            sb: Ln(BigInt(r.smallBlind)),
            bb: Ln(BigInt(r.bigBlind)),
            size: Number(r.maxSeats),
            seated: Number(r.seated),
            pot: Ln(BigInt(r.pot || 0)),
            inHand: !!r.inHand,
            rake: Number(r.rakeBps) / 100,
            cap: Ln(BigInt(r.rakeCap || 0)),
            stake: stakeOf(Ln(BigInt(r.bigBlind)))
          }));
        } else {
          const n = await SP.sdk.tableCount();
          out = [];
          for (let t = 0; t < n; t++) {
            const [cfg, hand, seats, ctl] = await Promise.all([SP.sdk.getTable(t), SP.sdk.getHand(t), SP.sdk.getSeats(t), SP.sdk.tableController(t)]);
            if (ctl && ctl !== "0x0000000000000000000000000000000000000000") continue; // hide tournament-controlled tables from the cash list
            out.push({
              id: t,
              sb: Ln(cfg.smallBlind),
              bb: Ln(cfg.bigBlind),
              size: cfg.maxSeats,
              seated: seats.filter(s => !s.empty).length,
              pot: Ln(hand.pot),
              inHand: hand.inProgress,
              rake: cfg.rakeBps / 100,
              cap: Ln(cfg.rakeCap),
              stake: stakeOf(Ln(cfg.bigBlind))
            });
          }
        }
        if (!stop) {
          setRows(out);
          setLoaded(true);
        }
        if (SP.sdk.hasTournaments()) {
          try {
            const ts = await trnList();
            if (!stop) {
              setTrnCount(ts.filter(t => t.status <= 1).length);
              setTrnSeated(ts.filter(t => t.status === 1).reduce((a, t) => a + t.remaining, 0)); // tournament players count as seated
            }
          } catch {}
        }
      } catch (e) {
        if (!stop) setLoaded(true);
      }
    }
    load();
    const iv = setInterval(load, 4000);
    return () => {
      stop = true;
      clearInterval(iv);
    };
  }, []);
  async function connect() {
    try {
      const a = await SP.sdk.connect();
      setAddr(a);
      setConnected(true);
      refreshBal();
    } catch (e) {
      if (e && e.message !== "cancelled") alert(e.message || "connect failed");
    }
  }
  let cash = rows;
  if (stake !== "all") cash = cash.filter(r => r.stake === stake);
  if (size !== "all") cash = cash.filter(r => String(r.size) === size);
  const totalSeated = rows.reduce((a, r) => a + r.seated, 0);
  const running = rows.filter(r => r.inHand).length;
  const sym = SP.NETWORK.currency.symbol;
  return /*#__PURE__*/React.createElement("div", {
    className: "scaler",
    id: "scaler"
  }, /*#__PURE__*/React.createElement("div", {
    className: "app lobby",
    "data-dir": theme,
    "data-deck": "4"
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
    title: "Home",
    onClick: () => location.href = "/poker/"
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
    className: "spacer"
  }), connected ? /*#__PURE__*/React.createElement("div", {
    className: "wallet",
    style: {
      cursor: "pointer"
    },
    title: "Cashier \xB7 nickname",
    onClick: () => setShowCashier(true)
  }, /*#__PURE__*/React.createElement(BraceLogo, {
    size: 16
  }), /*#__PURE__*/React.createElement("span", {
    className: "bal tnum"
  }, fmtMoney(bal)), /*#__PURE__*/React.createElement("span", {
    className: "net"
  }, lshort(addr))) : /*#__PURE__*/React.createElement("button", {
    className: "metapill",
    style: {
      cursor: "pointer",
      color: "var(--accent-soft)",
      borderColor: "var(--accent-32)",
      background: "var(--accent-12)"
    },
    onClick: connect
  }, SPT("Connect Wallet"))), showCashier && connected && /*#__PURE__*/React.createElement(CashierModal, {
    close: () => setShowCashier(false),
    addr: addr,
    bal: bal,
    refresh: refreshBal
  }), /*#__PURE__*/React.createElement("div", {
    className: "lobbyhead"
  }, /*#__PURE__*/React.createElement("div", {
    className: "lobbytabs"
  }, [["cash", "Cash"], ["tournaments", "Tournaments"]].map(([k, l]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    className: tab === k ? "on" : "",
    onClick: () => setTab(k)
  }, l, /*#__PURE__*/React.createElement("span", {
    className: "ct tnum"
  }, k === "cash" ? cash.length : SP.sdk.hasTournaments() ? trnCount : "soon")))), /*#__PURE__*/React.createElement("div", {
    className: "statstrip"
  }, /*#__PURE__*/React.createElement("div", {
    className: "stat"
  }, /*#__PURE__*/React.createElement("span", {
    className: "k"
  }, /*#__PURE__*/React.createElement("span", {
    className: "live"
  }), SPT("Players seated")), /*#__PURE__*/React.createElement("span", {
    className: "v count tnum"
  }, totalSeated + trnSeated)), /*#__PURE__*/React.createElement("div", {
    className: "stat"
  }, /*#__PURE__*/React.createElement("span", {
    className: "k"
  }, SPT("Tables")), /*#__PURE__*/React.createElement("span", {
    className: "v tnum"
  }, rows.length)), /*#__PURE__*/React.createElement("div", {
    className: "stat",
    title: "Tables with a hand being dealt right now"
  }, /*#__PURE__*/React.createElement("span", {
    className: "k"
  }, SPT("Hands in play")), /*#__PURE__*/React.createElement("span", {
    className: "v tnum"
  }, running)))), /*#__PURE__*/React.createElement("div", {
    className: "subbar"
  }, tab === "cash" ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
    className: "filterlabel"
  }, SPT("Stakes")), /*#__PURE__*/React.createElement("div", {
    className: "chipset"
  }, [["all", "All"], ["micro", "Micro"], ["low", "Low"], ["mid", "Mid"], ["high", "High"]].map(([k, l]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    className: stake === k ? "on" : "",
    onClick: () => setStake(k)
  }, l))), /*#__PURE__*/React.createElement("span", {
    className: "filterlabel"
  }, SPT("Size")), /*#__PURE__*/React.createElement("div", {
    className: "chipset"
  }, [["all", "All"], ["6", "6-max"], ["9", "9-max"], ["2", "Heads-up"]].map(([k, l]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    className: size === k ? "on" : "",
    onClick: () => setSize(k)
  }, l))), /*#__PURE__*/React.createElement("div", {
    className: "spacerflex"
  })) : tab === "tournaments" && SP.sdk.hasTournaments() ?
  /*#__PURE__*/
  /* The line that used to sit here ("Single-table tournaments ·
     buy-in or sponsored pools") described the feature to someone who
     had already chosen it, in the row where they were looking for
     something to click. */
  React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "spacerflex"
  }), /*#__PURE__*/React.createElement("button", {
    className: "cta",
    onClick: () => connected ? setShowCreate(true) : connect()
  }, "+ ", SPT("Create tournament"))) : /*#__PURE__*/React.createElement("span", {
    className: "filterlabel"
  }, SPT("Scheduled tournaments"))), /*#__PURE__*/React.createElement("div", {
    className: "lobbybody"
  }, /*#__PURE__*/React.createElement("div", {
    className: "listscroll"
  }, tab === "tournaments" && SP.sdk.hasTournaments() ? /*#__PURE__*/React.createElement(TournamentsTab, {
    connected: connected,
    connect: connect,
    addr: addr,
    onCount: setTrnCount,
    showCreate: showCreate,
    closeCreate: () => setShowCreate(false)
  }) : tab !== "cash" ? /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      padding: "70px 20px",
      color: "var(--muted)",
      fontFamily: "var(--label)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 30,
      marginBottom: 10
    }
  }, "\u2660"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--mono)",
      fontSize: 18,
      color: "var(--text)"
    }
  }, "Tournaments \xB7 coming soon"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8,
      fontSize: 13
    }
  }, SPT("Cash NLHE is live now."))) : !loaded ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 50,
      color: "var(--muted)",
      fontFamily: "var(--label)",
      textAlign: "center"
    }
  }, SPT("Loading tables…")) : cash.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 50,
      color: "var(--muted)",
      fontFamily: "var(--label)",
      textAlign: "center"
    }
  }, SPT("No tables match your filters.")) :
  /*#__PURE__*/
  /* cash tables as mini-felt cards: a plan-view oval with the
     actual seat occupancy around it and the live pot in the
     middle · the row list read like a spreadsheet */
  React.createElement("div", {
    className: "tgrid"
  }, cash.map(r => {
    const full = r.seated >= r.size;
    const sizeLabel = r.size === 2 ? "Heads-up" : r.size + "-max";
    const suit = ["♠", "♥", "♦", "♣"][r.id % 4];
    const red = r.id % 4 === 1 || r.id % 4 === 2;
    const tilt = r.id * 47 % 22 - 11; // deterministic per table · no two cards sit identical
    const seats = Array.from({
      length: r.size
    }, (_, i) => {
      const a = Math.PI / 2 + i / r.size * Math.PI * 2; // clockwise from the bottom seat
      return {
        x: 50 + 43 * Math.cos(a),
        y: 50 + 38 * Math.sin(a),
        on: i < r.seated
      };
    });
    return /*#__PURE__*/React.createElement("a", {
      key: r.id,
      className: "tcard" + (r.inHand ? " live" : ""),
      href: "table?t=" + r.id
    }, /*#__PURE__*/React.createElement("div", {
      className: "tc-top"
    }, /*#__PURE__*/React.createElement("span", {
      className: "tc-stakes tnum"
    }, r.sb, " / ", r.bb, /*#__PURE__*/React.createElement("span", {
      className: "u"
    }, sym)), /*#__PURE__*/React.createElement("span", {
      className: "tc-tags"
    }, /*#__PURE__*/React.createElement("span", {
      className: "gametag"
    }, "NLHE"), /*#__PURE__*/React.createElement("span", {
      className: "tc-size"
    }, sizeLabel))), /*#__PURE__*/React.createElement("div", {
      className: "tc-felt"
    }, /*#__PURE__*/React.createElement("span", {
      className: "tc-suit",
      style: {
        transform: `translate(-50%, -52%) rotate(${tilt}deg)`,
        color: red ? "rgba(190,80,80,.075)" : "rgba(217,185,112,.07)"
      }
    }, suit), seats.map((s, i) => /*#__PURE__*/React.createElement("span", {
      key: i,
      className: "tc-seat" + (s.on ? " on" : ""),
      style: {
        left: s.x + "%",
        top: s.y + "%"
      }
    })), /*#__PURE__*/React.createElement("div", {
      className: "tc-center"
    }, r.inHand ? /*#__PURE__*/React.createElement(React.Fragment, null, r.pot > 0 && /*#__PURE__*/React.createElement("span", {
      className: "tc-pot tnum"
    }, r.pot.toFixed(2), /*#__PURE__*/React.createElement("span", {
      className: "u"
    }, sym)), /*#__PURE__*/React.createElement("span", {
      className: "tc-live"
    }, /*#__PURE__*/React.createElement("span", {
      className: "dot"
    }), SPT("hand in play"))) : /*#__PURE__*/React.createElement("span", {
      className: "tc-wait"
    }, r.seated > 0 ? SPT("waiting for players") : SPT("open table")))), /*#__PURE__*/React.createElement("div", {
      className: "tc-bottom"
    }, /*#__PURE__*/React.createElement("span", {
      className: "tc-rake",
      title: `${SPT("Rake")} ${r.rake}% · ${SPT("cap")} ${r.cap} ${sym} · ${SPT("nothing is taken when the hand ends before the flop")}`
    }, SPT("Rake"), " ", /*#__PURE__*/React.createElement("b", null, r.rake, "%")), /*#__PURE__*/React.createElement("span", {
      className: "tc-actions"
    }, full ? /*#__PURE__*/React.createElement("span", {
      className: "btn-sm full"
    }, SPT("Full · watch")) : /*#__PURE__*/React.createElement("span", {
      className: "btn-sm join"
    }, r.seated === 0 ? SPT("Take a seat") : `${SPT("Join")} · ${r.seated}/${r.size}`))));
  }))))));
}

/* ---------------- Tournaments (live) ---------------- */
const TRN_COLS = "1.5fr 1.2fr 1.2fr 0.9fr 0.9fr 1.2fr";
function TournamentsTab({
  connected,
  connect,
  addr,
  onCount,
  showCreate,
  closeCreate
}) {
  const [list, setList] = uS(null);
  const [mine, setMine] = uS({}); // id -> isRegistered
  const [busy, setBusy] = uS(false);
  const [msg, setMsg] = uS(null);
  const [showPast, setShowPast] = uS(false);
  const sym = SP.NETWORK.currency.symbol;
  function flash(m) {
    setMsg(m);
    setTimeout(() => setMsg(null), 4000);
  }
  async function load() {
    try {
      const ts = await trnList();
      ts.reverse(); // newest first
      setList(ts);
      onCount(ts.filter(t => t.status <= 1).length);
      if (SP.sdk.address) {
        setMine(await regMap(ts));
      }
    } catch (e) {
      console.warn("trn load:", e.message);
      setList([]);
    }
  }
  uE(() => {
    load();
    const iv = setInterval(load, 4000);
    return () => clearInterval(iv);
  }, [connected]);
  // Language is owned by the casino's Settings · repaint when it changes so
  // SPT() below re-runs with the new one (no reload).
  const [, setLangTick] = uS(0);
  uE(() => {
    const on = () => setLangTick(n => n + 1);
    window.addEventListener("sp-lang-changed", on);
    return () => window.removeEventListener("sp-lang-changed", on);
  }, []);
  async function act(label, fn) {
    // the clicked button owns the spinner until this settles
    const done = SPPress.claim();
    setBusy(true);
    try {
      await fn();
      bustTrnCache();
      await load();
    } // no success toast · the row updates itself
    catch (e) {
      flash(label + " ✗ " + SP.pokerError(e));
      console.error(e);
    } finally {
      setBusy(false);
      done();
    }
  }
  const fmtSplit = bps => bps.map(b => b / 100 + "%").join(" / ");
  // Private (approval) tournaments are invite-by-link · list them only for their host.
  const visible = (list || []).filter(t => !t.approvalRequired || addr && t.creator.toLowerCase() === addr.toLowerCase());
  // A finished tournament cannot be joined, watched or acted on — it is a
  // receipt. Twelve of them above the one event you could actually enter is
  // what made this page unreadable, so they fold away behind a count.
  const open = visible.filter(t => t.status <= 1);
  const past = visible.filter(t => t.status > 1);
  const rowsShown = showPast ? open.concat(past) : open;
  return /*#__PURE__*/React.createElement(React.Fragment, null, msg && /*#__PURE__*/React.createElement("div", {
    className: "lt-toast",
    style: {
      bottom: 60
    }
  }, msg), showCreate && /*#__PURE__*/React.createElement(CreateTournamentModal, {
    close: closeCreate,
    onDone: () => {
      closeCreate();
      load();
    },
    act: act,
    busy: busy
  }), list == null ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 50,
      color: "var(--muted)",
      fontFamily: "var(--label)",
      textAlign: "center"
    }
  }, SPT("Loading tournaments…")) : visible.length === 0 ? /*#__PURE__*/React.createElement("div", {
    className: "emptystate"
  }, /*#__PURE__*/React.createElement("div", {
    className: "glyph"
  }, "\u2660"), /*#__PURE__*/React.createElement("div", {
    className: "ttl"
  }, SPT("No tournaments yet")), /*#__PURE__*/React.createElement("div", {
    className: "sub"
  }, SPT("Be the first · create one with your own buy-in, prize pool and payout split."))) : /*#__PURE__*/React.createElement("div", {
    className: "dtable"
  }, open.length === 0 && /*#__PURE__*/React.createElement("div", {
    className: "emptystate tight"
  }, /*#__PURE__*/React.createElement("div", {
    className: "ttl"
  }, SPT("Nothing running right now")), /*#__PURE__*/React.createElement("div", {
    className: "sub"
  }, SPT("Create one, or look through what has already been played."))), rowsShown.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "dthead",
    style: {
      gridTemplateColumns: TRN_COLS
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "h"
  }, SPT("Tournament")), /*#__PURE__*/React.createElement("span", {
    className: "h"
  }, SPT("Buy-in")), /*#__PURE__*/React.createElement("span", {
    className: "h"
  }, SPT("Prize pool")), /*#__PURE__*/React.createElement("span", {
    className: "h c"
  }, SPT("Entrants")), /*#__PURE__*/React.createElement("span", {
    className: "h"
  }, SPT("Status")), /*#__PURE__*/React.createElement("span", {
    className: "h r"
  }, SPT("Action"))), rowsShown.map(t => {
    const cost = t.buyIn + t.fee;
    const statusCls = ["registering", "running", "finished", "finished"][t.status];
    const reg = mine[t.id];
    const isCreator = addr && t.creator.toLowerCase() === addr.toLowerCase();
    return /*#__PURE__*/React.createElement("div", {
      key: t.id,
      className: "drow" + (t.status > 1 ? " past" : ""),
      style: {
        gridTemplateColumns: TRN_COLS
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "cell-tname"
    }, /*#__PURE__*/React.createElement("span", {
      className: "nm"
    }, "SNG #", t.id, " \xB7 ", t.maxPlayers, "-max"), /*#__PURE__*/React.createElement("span", {
      className: "meta"
    }, /*#__PURE__*/React.createElement("span", null, Number(t.startStack), " chips"), /*#__PURE__*/React.createElement("span", null, "by ", t.creator.slice(0, 6), "\u2026"), t.pool > t.buyIn * BigInt(t.registered) && /*#__PURE__*/React.createElement("span", {
      className: "bnt"
    }, "\u25C6 sponsored"), t.hostBps > 0 && /*#__PURE__*/React.createElement("span", {
      className: "bnt",
      style: {
        color: "var(--gold, #e8c15a)"
      }
    }, "\u2605 host ", t.hostBps / 100, "%"), t.approvalRequired && /*#__PURE__*/React.createElement("span", {
      className: "bnt"
    }, "\u25CF private"), isCreator && t.pendingCount > 0 && /*#__PURE__*/React.createElement("span", {
      className: "bnt"
    }, t.pendingCount, " applied"))), /*#__PURE__*/React.createElement("div", {
      className: "buyincell"
    }, cost > 0n ? /*#__PURE__*/React.createElement("span", {
      className: "bi tnum"
    }, Number(SP.fmt(cost, 4)), /*#__PURE__*/React.createElement("span", {
      className: "u"
    }, sym)) : /*#__PURE__*/React.createElement("span", {
      className: "bi free"
    }, SPT("Free")), /*#__PURE__*/React.createElement("span", {
      className: "split"
    }, SPT("payout"), " ", fmtSplit(t.payoutBps))), /*#__PURE__*/React.createElement("div", {
      className: "prizecell"
    }, t.pool > 0n ? /*#__PURE__*/React.createElement("span", {
      className: "pp tnum"
    }, Number(SP.fmt(t.pool, 4)), /*#__PURE__*/React.createElement("span", {
      className: "u"
    }, sym)) : /*#__PURE__*/React.createElement("span", {
      className: "pp empty"
    }, SPT("no entries yet"))), /*#__PURE__*/React.createElement("div", {
      className: "regcell tnum"
    }, t.registered, "/", t.maxPlayers, t.status === 1 && /*#__PURE__*/React.createElement("span", {
      className: "u"
    }, t.remaining, " left")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
      className: "statuschip " + statusCls
    }, SP.TRN_STATUS[t.status])), /*#__PURE__*/React.createElement("div", {
      className: "rowactions"
    }, /*#__PURE__*/React.createElement("a", {
      className: "btn-sm",
      href: "tournament?id=" + t.id
    }, SPT("View")), t.status === 0 && t.approvalRequired && !isCreator && /*#__PURE__*/React.createElement("a", {
      className: "btn-sm join",
      href: "tournament?id=" + t.id
    }, SPT("Apply")), t.status === 0 && !t.approvalRequired && !connected && /*#__PURE__*/React.createElement("button", {
      className: "btn-sm join",
      onClick: connect
    }, SPT("Connect")), t.status === 0 && !t.approvalRequired && connected && !reg && /*#__PURE__*/React.createElement("button", {
      className: "btn-sm join",
      disabled: busy,
      onClick: () => act("Register", () => SP.sdk.registerTournament(t.id, cost))
    }, SPT("Register")), t.status === 0 && !t.approvalRequired && connected && reg && /*#__PURE__*/React.createElement("button", {
      className: "btn-sm",
      disabled: busy,
      onClick: () => act("Unregister", () => SP.sdk.unregisterTournament(t.id))
    }, SPT("Unregister")), t.status === 0 && connected && isCreator && t.registered >= 2 && /*#__PURE__*/React.createElement("button", {
      className: "btn-sm join",
      disabled: busy,
      onClick: () => act("Start", () => SP.sdk.startTournament(t.id))
    }, SPT("Start")), t.status === 1 && /*#__PURE__*/React.createElement("a", {
      className: "btn-sm join",
      href: "table?t=" + t.tableId
    }, reg ? SPT("Play") + " →" : SPT("Observe"))));
  }), past.length > 0 && /*#__PURE__*/React.createElement("button", {
    className: "pasttoggle",
    onClick: () => setShowPast(v => !v)
  }, showPast ? SPT("Hide finished") : SPT("Show finished") + " (" + past.length + ")")));
}

/* ---------------- Sit & Go (live, one-click presets on the tournament engine) ---------------- */
const SNG_PRESETS = [{
  name: "Heads-Up Duel",
  structure: "turbo",
  players: 2,
  buyIn: "0.5",
  fee: "0.05",
  stack: 1500,
  sb: 10,
  bb: 20,
  levelMin: 4,
  split: [10000]
}, {
  name: "Hyper 6-Max",
  structure: "hyper",
  players: 6,
  buyIn: "0.5",
  fee: "0.05",
  stack: 1000,
  sb: 25,
  bb: 50,
  levelMin: 3,
  split: [6500, 3500]
}, {
  name: "9-Max Standard",
  structure: "regular",
  players: 9,
  buyIn: "0.3",
  fee: "0.03",
  stack: 1500,
  sb: 10,
  bb: 20,
  levelMin: 5,
  split: [5000, 3000, 2000]
}];
const SPIN_MULTIS = [{
  x: 2
}, {
  x: 3
}, {
  x: 5
}, {
  x: 10
}, {
  x: 25
}, {
  x: 120
}, {
  x: 1000
}];
function SngTab({
  connected,
  connect,
  addr
}) {
  const [open, setOpen] = uS(null); // registering tournaments
  const [mine, setMine] = uS({});
  const [busy, setBusy] = uS(false);
  const [msg, setMsg] = uS(null);
  const [display, setDisplay] = uS(SPIN_MULTIS[2]);
  const sym = SP.NETWORK.currency.symbol;
  function flash(m) {
    setMsg(m);
    setTimeout(() => setMsg(null), 4000);
  }
  async function load() {
    try {
      const ts = (await trnList()).filter(t => t.status === 0).reverse();
      setOpen(ts);
      if (SP.sdk.address) setMine(await regMap(ts));
    } catch (e) {
      setOpen([]);
    }
  }
  uE(() => {
    load();
    const iv = setInterval(load, 4000);
    return () => clearInterval(iv);
  }, [connected]);
  // Language is owned by the casino's Settings · repaint when it changes so
  // SPT() below re-runs with the new one (no reload).
  const [, setLangTick] = uS(0);
  uE(() => {
    const on = () => setLangTick(n => n + 1);
    window.addEventListener("sp-lang-changed", on);
    return () => window.removeEventListener("sp-lang-changed", on);
  }, []);

  // spin reel · pure eye-candy teaser while Spin SNG awaits on-chain randomness
  uE(() => {
    const iv = setInterval(() => setDisplay(SPIN_MULTIS[Math.floor(Math.random() * SPIN_MULTIS.length)]), 1400);
    return () => clearInterval(iv);
  }, []);
  async function act(label, fn) {
    // the clicked button owns the spinner until this settles
    const done = SPPress.claim();
    setBusy(true);
    try {
      await fn();
      bustTrnCache();
      await load();
    } // no success toast · the row updates itself
    catch (e) {
      flash(label + " ✗ " + SP.pokerError(e));
      console.error(e);
    } finally {
      setBusy(false);
      done();
    }
  }

  /// One click: create the SNG from the preset AND take the first seat.
  const quickStart = p => act("Create & join " + p.name, async () => {
    await SP.sdk.createTournament({
      buyInEth: p.buyIn,
      feeEth: p.fee,
      maxPlayers: p.players,
      startStack: p.stack,
      sbStart: p.sb,
      bbStart: p.bb,
      levelDur: p.levelMin * 60,
      payoutBps: p.split,
      sponsorEth: 0
    });
    const id = (await SP.sdk.tournamentCount()) - 1;
    const t = await SP.sdk.tournamentInfo(id);
    await SP.sdk.registerTournament(id, t.buyIn + t.fee);
  });
  return /*#__PURE__*/React.createElement("div", {
    className: "sngsplit"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "dtable",
    style: {
      border: "1px solid var(--line)",
      borderRadius: 12,
      overflow: "hidden",
      alignSelf: "stretch"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "dthead",
    style: {
      gridTemplateColumns: "1.4fr 0.8fr 0.8fr 0.9fr",
      position: "static"
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "h"
  }, "Quick Sit & Go"), /*#__PURE__*/React.createElement("span", {
    className: "h"
  }, "Buy-in"), /*#__PURE__*/React.createElement("span", {
    className: "h c"
  }, SPT("Format")), /*#__PURE__*/React.createElement("span", {
    className: "h r"
  }, SPT("Action"))), SNG_PRESETS.map(p => /*#__PURE__*/React.createElement("div", {
    key: p.name,
    className: "sngrow",
    style: {
      gridTemplateColumns: "1.4fr 0.8fr 0.8fr 0.9fr"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "cell-tname"
  }, /*#__PURE__*/React.createElement("span", {
    className: "nm"
  }, p.name), /*#__PURE__*/React.createElement("span", {
    className: "meta"
  }, /*#__PURE__*/React.createElement("span", null, p.structure), /*#__PURE__*/React.createElement("span", null, p.stack, " chips"), /*#__PURE__*/React.createElement("span", null, "payout ", p.split.map(b => b / 100 + "%").join("/")))), /*#__PURE__*/React.createElement("div", {
    className: "buyincell"
  }, /*#__PURE__*/React.createElement("span", {
    className: "bi tnum",
    style: {
      fontSize: 13
    }
  }, (parseFloat(p.buyIn) + parseFloat(p.fee)).toFixed(2), /*#__PURE__*/React.createElement("span", {
    className: "u"
  }, sym)), /*#__PURE__*/React.createElement("span", {
    className: "split"
  }, /*#__PURE__*/React.createElement("b", null, p.buyIn), "+", p.fee, " fee")), /*#__PURE__*/React.createElement("div", {
    className: "sizetag",
    style: {
      textAlign: "center"
    }
  }, p.players === 2 ? "Heads-up" : p.players + "-max"), /*#__PURE__*/React.createElement("div", {
    className: "rowactions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-sm join",
    disabled: busy,
    onClick: () => connected ? quickStart(p) : connect()
  }, connected ? "Create & join" : "Connect"))))), /*#__PURE__*/React.createElement("div", {
    className: "dtable",
    style: {
      border: "1px solid var(--line)",
      borderRadius: 12,
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "dthead",
    style: {
      gridTemplateColumns: "1.4fr 0.8fr 0.8fr 0.9fr",
      position: "static"
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "h"
  }, SPT("Open seats · join now")), /*#__PURE__*/React.createElement("span", {
    className: "h"
  }, "Buy-in"), /*#__PURE__*/React.createElement("span", {
    className: "h c"
  }, SPT("Seats")), /*#__PURE__*/React.createElement("span", {
    className: "h r"
  }, SPT("Action"))), open == null ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 24,
      color: "var(--muted)",
      fontFamily: "var(--label)",
      textAlign: "center"
    }
  }, "Loading\u2026") : open.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 24,
      color: "var(--muted)",
      fontFamily: "var(--label)",
      textAlign: "center"
    }
  }, "No open Sit & Go right now \xB7 start one above.") : open.map(t => {
    const cost = t.buyIn + t.fee;
    return /*#__PURE__*/React.createElement("div", {
      key: t.id,
      className: "sngrow",
      style: {
        gridTemplateColumns: "1.4fr 0.8fr 0.8fr 0.9fr"
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "cell-tname"
    }, /*#__PURE__*/React.createElement("span", {
      className: "nm"
    }, "SNG #", t.id), /*#__PURE__*/React.createElement("span", {
      className: "meta"
    }, /*#__PURE__*/React.createElement("span", null, Number(t.startStack), " chips"), /*#__PURE__*/React.createElement("span", null, "pool ", Number(SP.fmt(t.pool, 4)), " ", sym))), /*#__PURE__*/React.createElement("div", {
      className: "buyincell"
    }, /*#__PURE__*/React.createElement("span", {
      className: "bi tnum",
      style: {
        fontSize: 13
      }
    }, Number(SP.fmt(cost, 4)), /*#__PURE__*/React.createElement("span", {
      className: "u"
    }, sym))), /*#__PURE__*/React.createElement("div", {
      className: "seatdots",
      style: {
        justifyContent: "center"
      }
    }, Array.from({
      length: t.maxPlayers
    }).map((_, i) => /*#__PURE__*/React.createElement("span", {
      key: i,
      className: "sd" + (i < t.registered ? " on" : "")
    })), /*#__PURE__*/React.createElement("span", {
      className: "lbl"
    }, t.registered, "/", t.maxPlayers)), /*#__PURE__*/React.createElement("div", {
      className: "rowactions"
    }, !connected ? /*#__PURE__*/React.createElement("button", {
      className: "btn-sm join",
      onClick: connect
    }, SPT("Connect")) : mine[t.id] ? /*#__PURE__*/React.createElement("button", {
      className: "btn-sm",
      disabled: busy,
      onClick: () => act("Unregister", () => SP.sdk.unregisterTournament(t.id))
    }, SPT("Unregister")) : /*#__PURE__*/React.createElement("button", {
      className: "btn-sm join",
      disabled: busy,
      onClick: () => act("Register", () => SP.sdk.registerTournament(t.id, cost))
    }, SPT("Register"))));
  }))), /*#__PURE__*/React.createElement("div", {
    className: "spincard"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sptop"
  }, /*#__PURE__*/React.createElement("div", {
    className: "t"
  }, "\u25C6 Spin & Go"), /*#__PURE__*/React.createElement("div", {
    className: "s"
  }, "3-handed hyper turbo with a random prize multiplier revealed at seating \xB7 powered by the same provably-fair on-chain randomness as the deck. Coming soon.")), /*#__PURE__*/React.createElement("div", {
    className: "spinreel"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--mono)",
      fontSize: 54,
      fontWeight: 700,
      color: "var(--accent-soft)"
    }
  }, "\xD7", display.x), /*#__PURE__*/React.createElement("button", {
    className: "spinbtn",
    disabled: true
  }, "Spin \xB7 soon"))), msg && /*#__PURE__*/React.createElement("div", {
    className: "lt-toast",
    style: {
      bottom: 60
    }
  }, msg));
}

// ONE LADDER, THREE WAYS IN.
// This is the standard tournament progression — blinds up about 1.5x a level,
// doubling every second or third — the same shape the WSOP structure sheets,
// live card rooms and online MTTs all use. A fast structure is NOT a different
// ladder: it is a shorter level and a shallower entry point. That is exactly
// how a turbo differs from a regular event everywhere else, and getting it
// wrong is what made our "Standard" a hyper-turbo by every other name: three
// minutes a level is about three hands here, against the ten-plus a regular
// event gives you, and event #23 reached five big blinds in forty-two minutes.
const LADDER = [[10, 20, 0], [15, 30, 0], [20, 40, 0], [25, 50, 0], [30, 60, 8], [40, 80, 10], [50, 100, 12], [60, 120, 15], [75, 150, 20], [100, 200, 25], [125, 250, 30], [150, 300, 40], [200, 400, 50], [250, 500, 60], [300, 600, 75], [400, 800, 100], [500, 1000, 125], [600, 1200, 150], [800, 1600, 200], [1000, 2000, 250], [1200, 2400, 300], [1500, 3000, 400], [2000, 4000, 500], [2500, 5000, 600], [3000, 6000, 750], [4000, 8000, 1000], [5000, 10000, 1250], [6000, 12000, 1500], [8000, 16000, 2000], [10000, 20000, 2500]];
/// A preset is a slice of the ladder from `fromBB` onward at a fixed level
/// length. Antes wait for the first four levels, as they do everywhere else —
/// they exist to force action once the blinds are worth stealing, not before.
const MK = (mins, fromBB) => {
  const start = LADDER.findIndex(([, bb]) => bb === fromBB);
  return LADDER.slice(start).map(([sb, bb, ante], i) => ({
    sb,
    bb,
    ante: i < 4 ? 0 : ante,
    durationSecs: mins * 60
  }));
};
/// Minutes until a starting stack is worth ten big blinds — the point where an
/// event stops being poker and becomes a shoving contest. The single most
/// useful number a host can see BEFORE creating one.
const shoveAt = (levels, stack) => {
  let t = 0;
  for (const l of levels) {
    t += l.durationSecs;
    if (stack / l.bb <= 10) break;
  }
  return Math.round(t / 60);
};
// Same 10,000 chips in every preset; the speed comes from the level length and
// how deep you start, never from a steeper ladder. Contract caps custom
// structures at 40 levels, and its own blind cap stops anything running away.
const STRUCTURES = {
  regular: {
    label: "Regular",
    stack: 10000,
    mins: 8,
    levels: MK(8, 50)
  },
  // 200 BB
  turbo: {
    label: "Turbo",
    stack: 10000,
    mins: 5,
    levels: MK(5, 100)
  },
  // 100 BB
  hyper: {
    label: "Hyper",
    stack: 10000,
    mins: 3,
    levels: MK(3, 200)
  } //  50 BB
};

// Blind-structure viewer + editor (LePoker-style level table).
function StructureEditor({
  levels,
  onSave,
  close
}) {
  const [rows, setRows] = uS(levels.map(l => ({
    sb: l.sb,
    bb: l.bb,
    ante: l.ante,
    min: Math.max(1, Math.round(l.durationSecs / 60))
  })));
  const upd = (i, k, v) => setRows(r => r.map((row, j) => j === i ? {
    ...row,
    [k]: v
  } : row));
  const del = i => setRows(r => r.length > 1 ? r.filter((_, j) => j !== i) : r);
  const add = () => setRows(r => {
    const last = r[r.length - 1] || {
      sb: 10,
      bb: 20,
      ante: 0,
      min: 5
    };
    return [...r, {
      sb: Number(last.bb),
      bb: Number(last.bb) * 2,
      ante: Math.round(Number(last.bb) / 8),
      min: last.min
    }];
  });
  const save = () => {
    onSave(rows.map(r => ({
      sb: parseInt(r.sb, 10) || 0,
      bb: parseInt(r.bb, 10) || 0,
      ante: parseInt(r.ante, 10) || 0,
      durationSecs: Math.max(15, (parseInt(r.min, 10) || 1) * 60)
    })));
    close();
  };
  const stop = e => e.stopPropagation();
  const inp = {
    width: "100%",
    background: "var(--panel,#141420)",
    border: "1px solid var(--line)",
    color: "var(--text)",
    borderRadius: 6,
    padding: "4px 6px",
    fontFamily: "var(--mono)",
    fontSize: 13
  };
  return /*#__PURE__*/React.createElement(Portal, null, /*#__PURE__*/React.createElement("div", {
    className: "lt-modalbg",
    onClick: close
  }, /*#__PURE__*/React.createElement("div", {
    className: "lt-modal",
    onClick: stop,
    style: {
      width: "min(520px,95vw)",
      maxHeight: "90vh",
      display: "flex",
      flexDirection: "column"
    }
  }, /*#__PURE__*/React.createElement("h3", null, SPT("Blind structure")), /*#__PURE__*/React.createElement("div", {
    style: {
      overflowY: "auto",
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "26px 1.6fr 0.8fr 0.7fr 30px",
      gap: 6,
      fontFamily: "var(--label)",
      fontSize: 10,
      textTransform: "uppercase",
      color: "var(--muted)",
      padding: "4px 0"
    }
  }, /*#__PURE__*/React.createElement("span", null, "Lv"), /*#__PURE__*/React.createElement("span", null, "Blinds"), /*#__PURE__*/React.createElement("span", null, "Ante"), /*#__PURE__*/React.createElement("span", null, SPT("Min")), /*#__PURE__*/React.createElement("span", null)), rows.map((r, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: "grid",
      gridTemplateColumns: "26px 1.6fr 0.8fr 0.7fr 30px",
      gap: 6,
      alignItems: "center",
      padding: "3px 0"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--mono)",
      color: "var(--muted)",
      fontSize: 12
    }
  }, i + 1), /*#__PURE__*/React.createElement("span", {
    style: {
      display: "flex",
      gap: 4,
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("input", {
    style: inp,
    value: r.sb,
    onChange: e => upd(i, "sb", e.target.value)
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)"
    }
  }, "/"), /*#__PURE__*/React.createElement("input", {
    style: inp,
    value: r.bb,
    onChange: e => upd(i, "bb", e.target.value)
  })), /*#__PURE__*/React.createElement("input", {
    style: inp,
    value: r.ante,
    onChange: e => upd(i, "ante", e.target.value)
  }), /*#__PURE__*/React.createElement("input", {
    style: inp,
    value: r.min,
    onChange: e => upd(i, "min", e.target.value)
  }), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "btn-sm",
    style: {
      padding: "2px 6px"
    },
    onClick: () => del(i)
  }, "\u2715"))), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "btn-sm",
    style: {
      marginTop: 8
    },
    onClick: add
  }, "+ Add level")), /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      marginTop: 12
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "pill",
    onClick: close
  }, SPT("Cancel")), /*#__PURE__*/React.createElement("button", {
    className: "pill primary",
    onClick: save
  }, SPT("Save structure"))))));
}
function CreateTournamentModal({
  close,
  onDone,
  act,
  busy
}) {
  const sym = SP.NETWORK.currency.symbol;
  const [f, setF] = uS({
    mode: "buyin",
    buyIn: "0.5",
    fee: "0.05",
    sponsor: "1",
    maxPlayers: "6",
    seatsPerTable: "9",
    startStack: String(STRUCTURES.regular.stack),
    struct: "regular",
    levels: STRUCTURES.regular.levels,
    actionSecs: "30",
    schedule: "open",
    startAt: "",
    priv: false,
    split: "65/35",
    hostReward: false
  });
  const [showStruct, setShowStruct] = uS(false);
  const set = k => e => setF(s => ({
    ...s,
    [k]: e.target.value
  }));
  const pick = (k, v) => () => setF(s => ({
    ...s,
    [k]: v
  }));
  const sponsored = f.mode === "sponsored";
  const splitBps = f.split.split("/").map(s => Math.round(parseFloat(s.trim()) * 100)).filter(n => !isNaN(n));
  const splitOk = splitBps.length > 0 && splitBps.reduce((a, b) => a + b, 0) === 10000;
  const startTime = f.schedule === "scheduled" && f.startAt ? Math.floor(new Date(f.startAt).getTime() / 1000) : 0;
  const scheduleOk = f.schedule === "open" || startTime > Math.floor(Date.now() / 1000) + 60;
  const sponsorOk = !sponsored || SP.num(f.sponsor) > 0;
  // The action clock is enforced here rather than in the contract (which only
  // defaults a 0 to 30s): tournament #23 shipped with our own 15s default and
  // spent 57% of its turns inside the last ten seconds.
  const clockOk = (parseInt(f.actionSecs, 10) || 0) >= 20;
  const ok = splitOk && scheduleOk && sponsorOk && clockOk;
  const stop = e => e.stopPropagation();
  const Seg = ({
    k,
    opts
  }) => /*#__PURE__*/React.createElement("div", {
    className: "chipset",
    style: {
      marginTop: 6
    }
  }, opts.map(([v, l]) => /*#__PURE__*/React.createElement("button", {
    key: v,
    type: "button",
    className: f[k] === v ? "on" : "",
    onClick: pick(k, v)
  }, l)));
  return /*#__PURE__*/React.createElement(Portal, null, /*#__PURE__*/React.createElement("div", {
    className: "lt-modalbg",
    onClick: close
  }, /*#__PURE__*/React.createElement("div", {
    className: "lt-modal",
    onClick: stop,
    style: {
      width: "min(480px,94vw)",
      maxHeight: "92vh",
      overflowY: "auto"
    }
  }, /*#__PURE__*/React.createElement("h3", null, SPT("Create tournament")), showStruct && /*#__PURE__*/React.createElement(StructureEditor, {
    levels: f.levels,
    onSave: lv => setF(s => ({
      ...s,
      levels: lv,
      struct: "custom"
    })),
    close: () => setShowStruct(false)
  }), /*#__PURE__*/React.createElement("label", null, SPT("Prize pool")), /*#__PURE__*/React.createElement(Seg, {
    k: "mode",
    opts: [["buyin", "Buy-in pool"], ["sponsored", "I sponsor it · free entry"]]
  }), sponsored ? /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement("label", null, "Sponsor amount (", sym, ") ", /*#__PURE__*/React.createElement(Hint, {
    text: "You fund the prize pool; entry is free for everyone else. A flat 10% platform fee applies, the same as buy-in events \xB7 90% becomes the prize pool."
  })), /*#__PURE__*/React.createElement("input", {
    value: f.sponsor,
    onChange: set("sponsor")
  }), /*#__PURE__*/React.createElement("p", {
    className: "note",
    style: {
      marginTop: 4
    }
  }, "Free entry \xB7 prize pool gets 90% \xB7 10% platform fee", SP.num(f.sponsor) > 0 ? ` · pool ≈ ${(SP.num(f.sponsor) * 0.9).toFixed(4)} ${sym}` : "")) : /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement("label", null, "Buy-in (", sym, ") ", /*#__PURE__*/React.createElement(Hint, {
    text: "Entry cost per player. 90% builds the prize pool; a flat 10% platform fee goes to the house."
  })), /*#__PURE__*/React.createElement("input", {
    value: f.buyIn,
    onChange: set("buyIn")
  }), /*#__PURE__*/React.createElement("p", {
    className: "note",
    style: {
      marginTop: 4
    }
  }, "Pool gets 90% \xB7 10% platform fee")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 10,
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", null, "Players (2\u201345)"), /*#__PURE__*/React.createElement("input", {
    value: f.maxPlayers,
    onChange: set("maxPlayers")
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", null, "Start stack (chips)"), /*#__PURE__*/React.createElement("input", {
    value: f.startStack,
    onChange: set("startStack")
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", null, "Action time (sec) ", /*#__PURE__*/React.createElement(Hint, {
    text: "Seconds each player has to act before they're auto-folded. This clock starts ON-CHAIN, a moment before your browser can even show you it is your turn \u2014 15s left players with about twelve, and a tournament's worth of rushed clicks and auto-folds. 30s or more is a real decision; below 20s is not offered."
  })), /*#__PURE__*/React.createElement("input", {
    value: f.actionSecs,
    onChange: set("actionSecs"),
    style: {
      borderColor: clockOk ? undefined : "var(--danger,#ef5a6f)"
    }
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", null, "Payout split % ", /*#__PURE__*/React.createElement(Hint, {
    text: "How the prize pool is divided by finishing place. '65/35' \u2192 winner gets 65%, runner-up 35%. '50/30/20' \u2192 top-3 paid: 1st 50%, 2nd 30%, 3rd 20%. Any number of places (up to player count); must add up to 100."
  })), /*#__PURE__*/React.createElement("input", {
    value: f.split,
    onChange: set("split"),
    style: {
      borderColor: splitOk ? undefined : "var(--danger,#ef5a6f)"
    }
  }))), !splitOk && /*#__PURE__*/React.createElement("p", {
    className: "note",
    style: {
      color: "var(--danger,#ef5a6f)"
    }
  }, "Percentages must add up to exactly 100 (e.g. 65/35 or 50/30/20)."), !clockOk && /*#__PURE__*/React.createElement("p", {
    className: "note",
    style: {
      color: "var(--danger,#ef5a6f)"
    }
  }, "Give players at least 20 seconds. The action clock runs on-chain and part of it is spent reaching the browser."), /*#__PURE__*/React.createElement("label", {
    style: {
      marginTop: 10
    }
  }, "Table size ", /*#__PURE__*/React.createElement(Hint, {
    text: "Seats per table. With more players than this it becomes multi-table (MTT) \xB7 the number of tables is calculated automatically."
  })), /*#__PURE__*/React.createElement(Seg, {
    k: "seatsPerTable",
    opts: [["2", "Heads-up"], ["6", "6-max"], ["9", "9-max"]]
  }), /*#__PURE__*/React.createElement("p", {
    className: "note",
    style: {
      marginTop: 4
    }
  }, (() => {
    const ts = parseInt(f.seatsPerTable || "9", 10),
      mp = parseInt(f.maxPlayers || "0", 10);
    const nt = ts > 0 && mp > 0 ? Math.ceil(mp / ts) : 1;
    return nt > 1 ? `⌗ Multi-table: ${nt} tables of up to ${ts}` : `⌗ Single table (${ts}-max)`;
  })()), /*#__PURE__*/React.createElement("label", {
    style: {
      marginTop: 10
    }
  }, "Blind structure ", /*#__PURE__*/React.createElement(Hint, {
    text: "How fast blinds rise. Pick a preset (Slow/Standard/Turbo) or edit the levels yourself."
  })), /*#__PURE__*/React.createElement("div", {
    className: "chipset",
    style: {
      marginTop: 6
    }
  }, ["regular", "turbo", "hyper"].map(k => /*#__PURE__*/React.createElement("button", {
    key: k,
    type: "button",
    className: f.struct === k ? "on" : "",
    onClick: () => setF(s => ({
      ...s,
      struct: k,
      levels: STRUCTURES[k].levels,
      startStack: String(STRUCTURES[k].stack)
    }))
  }, STRUCTURES[k].label)), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: f.struct === "custom" ? "on" : "",
    onClick: () => setF(s => ({
      ...s,
      struct: "custom"
    }))
  }, SPT("Custom"))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      alignItems: "center",
      marginTop: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "note",
    style: {
      flex: 1
    }
  }, f.levels.length, " levels \xB7 start ", f.levels[0] ? f.levels[0].sb + "/" + f.levels[0].bb : "-", " \xB7 ", Math.round((f.levels[0]?.durationSecs || 0) / 60), " min/level \xB7 ", (() => {
    const bb = f.levels[0] ? Number(f.levels[0].bb) : 0,
      st = parseInt(f.startStack || "0", 10);
    return bb > 0 && st > 0 ? `${Math.round(st / bb)} BB deep · ~${shoveAt(f.levels, st)} min to 10 BB` : "";
  })()), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "btn-sm",
    onClick: () => setShowStruct(true)
  }, SPT("View / edit"))), /*#__PURE__*/React.createElement("label", null, "Start ", /*#__PURE__*/React.createElement(Hint, {
    text: "Open = starts when full or when you press Start. Scheduled = starts at a set time with a live countdown for everyone."
  })), /*#__PURE__*/React.createElement(Seg, {
    k: "schedule",
    opts: [["open", "When full / I start"], ["scheduled", "Scheduled time"]]
  }), f.schedule === "scheduled" && /*#__PURE__*/React.createElement("input", {
    type: "datetime-local",
    value: f.startAt,
    onChange: set("startAt"),
    style: {
      marginTop: 6,
      borderColor: scheduleOk ? undefined : "var(--danger,#ef5a6f)"
    }
  }), f.schedule === "scheduled" && /*#__PURE__*/React.createElement("p", {
    className: "note",
    style: {
      marginTop: 4
    }
  }, "Your local time (", Intl.DateTimeFormat().resolvedOptions().timeZone, ") \xB7 everyone sees a live countdown."), f.schedule === "scheduled" && !scheduleOk && /*#__PURE__*/React.createElement("p", {
    className: "note",
    style: {
      color: "var(--danger,#ef5a6f)"
    }
  }, SPT("Pick a time at least a minute in the future.")), !sponsored && /*#__PURE__*/React.createElement("label", {
    style: {
      marginTop: 12,
      display: "flex",
      alignItems: "center",
      gap: 8,
      cursor: "pointer",
      fontFamily: "var(--label)"
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: f.hostReward,
    onChange: e => setF(s => ({
      ...s,
      hostReward: e.target.checked
    })),
    style: {
      width: "auto"
    }
  }), /*#__PURE__*/React.createElement("span", null, "Host reward \xB7 ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: "var(--gold, #e8c15a)"
    }
  }, "5% of the prize pool"), " goes to me for organizing ", /*#__PURE__*/React.createElement(Hint, {
    text: "Paid to you automatically when the tournament finishes. Prizes are split from the remaining 95%. Shown to players on the tournament card."
  }))), /*#__PURE__*/React.createElement("label", {
    style: {
      marginTop: 12,
      display: "flex",
      alignItems: "center",
      gap: 8,
      cursor: "pointer",
      fontFamily: "var(--label)"
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: f.priv,
    onChange: e => setF(s => ({
      ...s,
      priv: e.target.checked
    })),
    style: {
      width: "auto"
    }
  }), "Private \xB7 players apply and I approve each (invite by link)"), /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      marginTop: 14
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "pill",
    onClick: close
  }, SPT("Cancel")), /*#__PURE__*/React.createElement("button", {
    className: "pill primary",
    disabled: busy || !ok,
    onClick: () => act("Create tournament", async () => {
      await SP.sdk.createTournament({
        buyInEth: sponsored ? 0 : (SP.num(f.buyIn) * 0.9).toFixed(6),
        feeEth: sponsored ? 0 : (SP.num(f.buyIn) * 0.1).toFixed(6),
        maxPlayers: parseInt(f.maxPlayers, 10),
        seatsPerTable: parseInt(f.seatsPerTable || "0", 10),
        startStack: parseInt(f.startStack, 10),
        actionSecs: Math.max(20, parseInt(f.actionSecs || "30", 10)),
        structure: f.levels,
        startTime,
        approvalRequired: f.priv,
        payoutBps: splitBps,
        sponsorEth: sponsored ? f.sponsor || 0 : 0,
        hostBps: !sponsored && f.hostReward ? 500 : 0
      });
      const newId = (await SP.sdk.tournamentCount()) - 1;
      location.href = "tournament?id=" + newId; // land on the page (invite link + applicants)
    })
  }, SPT("Create"))))));
}

// Bound once. This used to run `window.addEventListener("resize", fit)` on
// every tick of a 400ms interval, so the handler list grew forever — an hour
// on this screen left ~9000 live closures, and every one of them ran on each
// resize. The interval stays (it is what re-fits the stage after React
// remounts a tab), but `fit` now no-ops unless something actually changed, so
// the idle cost is two property reads instead of a layout write 2.5x/second.
let _lobbyScaleBound = false;
function mountScaleLobby() {
  const scaler = document.getElementById("scaler");
  if (!scaler) return;
  const app = scaler.querySelector(".app");
  if (!app) return;
  const fit = () => {
    const embedNow = document.documentElement.classList.contains("sp-embed");
    const key = window.innerWidth + "x" + window.innerHeight + "|" + (embedNow ? 1 : 0);
    // a freshly remounted .app carries no marker, so it always re-fits
    if (app.dataset.slFit === key) return;
    app.dataset.slFit = key;
    if (window.innerWidth <= 760) {
      // fluid mobile layout (mobile.css) - no stage scaling
      app.style.transform = "";
      app.style.position = "";
      app.style.top = "";
      app.style.left = "";
      scaler.style.width = "";
      scaler.style.height = "";
      return;
    }
    // Embedded in the merged site (sp-embed): fill the WIDTH of the frame -
    // the stage scrolls vertically if needed, so no dead side margins.
    const embed = document.documentElement.classList.contains("sp-embed");
    const sW = (window.innerWidth - 24) / 1600;
    // Embedded, scale to WIDTH only: the shell sizes the iframe to whatever
    // height we report, so keying off window.innerHeight would feed back on
    // itself (taller frame → bigger scale → taller frame). Width is stable and
    // the shell page does the scrolling.
    const sH = (window.innerHeight - 84) / 1000;
    const s = embed ? sW : Math.min(sW, sH);
    app.style.transform = `scale(${s})`;
    app.style.transformOrigin = "top left";
    app.style.position = "absolute";
    app.style.top = "0";
    app.style.left = "0";
    scaler.style.width = 1600 * s + "px";
    scaler.style.height = 1000 * s + "px";
  };
  fit();
  if (_lobbyScaleBound) return;
  _lobbyScaleBound = true;
  // re-enter through the mount fn so the handler always re-queries the DOM
  window.addEventListener("resize", () => mountScaleLobby());
}
function bootLobby() {
  ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(LobbyApp, null));
  setInterval(mountScaleLobby, 400);
  setTimeout(mountScaleLobby, 80);
}
if (window.SP) bootLobby();else window.addEventListener("sp:ready", bootLobby, {
  once: true
});