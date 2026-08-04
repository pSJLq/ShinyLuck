/* AUTO-GENERATED from poker-tournament-app.jsx by scripts/build-poker-jsx.js — do NOT edit. */
/* ShinyPoker · Tournament detail page. The invite-link target
   (tournament?id=N): info + countdown + blind structure + prize/split, and the
   approval flow · applicants apply with their on-chain nickname, the host
   approves/rejects. Fully on-chain via window.SP. Mirrors the lobby chrome. */
// `var`, not `const`: the cashier and the page app both bind these and now
// share one global script scope — a second `const` would kill the page.
var {
  useState: uS,
  useEffect: uE
} = React;
const sym = () => SP.NETWORK.currency.symbol;
const N4 = w => Number(SP.fmt(w, 4));
const tshort = a => a && a !== "0x0000000000000000000000000000000000000000" ? a.slice(0, 6) + "…" + a.slice(-4) : "";
const qId = () => {
  const v = parseInt(new URLSearchParams(location.search).get("id"), 10);
  return Number.isNaN(v) ? null : v;
};
const ZERO = "0x0000000000000000000000000000000000000000";
// Styled input matching the site (bare <input> outside .lt-modal gets browser default white).
const INP = {
  background: "var(--panel, #141420)",
  border: "1px solid var(--line)",
  color: "var(--text)",
  borderRadius: 8,
  padding: "8px 10px",
  fontFamily: "var(--mono)",
  fontSize: 13,
  outline: "none"
};

/// Nickname setter row · shared by the player apply flow AND the host join flow.
function NickRow({
  nick,
  setNick,
  busy,
  run,
  onSet
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 8,
      maxWidth: 380
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--label)",
      fontSize: 12,
      color: "var(--muted)"
    }
  }, "Pick a nickname to enter (3\u201320 letters/digits/_):"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: nick,
    onChange: e => setNick(e.target.value),
    placeholder: "YourName",
    style: {
      ...INP,
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("button", {
    className: "btn-sm join",
    disabled: busy || nick.trim().length < 3,
    onClick: () => run("Nickname set", onSet)
  }, "Set")));
}
function structureLabel(levelDur) {
  if (!levelDur) return "-";
  const m = Math.max(1, Math.round(levelDur / 60));
  const name = levelDur <= 180 ? "Turbo" : levelDur <= 360 ? "Standard" : "Slow";
  return `${name} · ${m} min levels`;
}
function clk(secs) {
  const m = Math.floor(secs / 60),
    s = String(secs % 60).padStart(2, "0");
  return `${m}:${s}`;
}
const Centered = ({
  children
}) => /*#__PURE__*/React.createElement("div", {
  className: "scaler",
  id: "scaler"
}, /*#__PURE__*/React.createElement("div", {
  className: "app lobby"
}, /*#__PURE__*/React.createElement("div", {
  style: {
    position: "absolute",
    inset: 0,
    display: "grid",
    placeItems: "center",
    color: "var(--muted)",
    fontFamily: "var(--label)",
    fontSize: 18
  }
}, children)));
function TournamentPage() {
  const id = qId();
  const [info, setInfo] = uS(null);
  const [clock, setClock] = uS(null);
  const [connected, setConnected] = uS(false);
  const [addr, setAddr] = uS(null);
  const [handle, setHandle] = uS("");
  const [pending, setPending] = uS([]);
  const [players, setPlayers] = uS([]);
  const [myReg, setMyReg] = uS(false);
  const [myPend, setMyPend] = uS(false);
  const [now, setNow] = uS(Math.floor(Date.now() / 1000));
  const [busy, setBusy] = uS(false);
  const [msg, setMsg] = uS(null);
  const [nick, setNick] = uS("");
  const [playTable, setPlayTable] = uS(null);
  const [numTables, setNumTables] = uS(1);
  const [tables, setTables] = uS([]);
  const [results, setResults] = uS(null); // [{addr, place, prize, handle}] · winner first
  const [structure, setStructure] = uS([]);
  const [showStruct, setShowStruct] = uS(false);
  const [showCashier, setShowCashier] = uS(false);
  const [pokerBal, setPokerBal] = uS(0);
  const refreshPokerBal = async () => {
    if (SP.sdk.address) {
      try {
        setPokerBal(Number(SP.fmt(await SP.sdk.balanceOf(SP.sdk.address), 6)));
      } catch {}
    }
  };
  uE(() => {
    if (connected) refreshPokerBal();
  }, [connected]);
  const [theme] = uS(() => localStorage.getItem("sp_theme") || "b");
  const flash = m => {
    setMsg(m);
    setTimeout(() => setMsg(null), 4500);
  };
  uE(() => {
    const iv = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(iv);
  }, []);
  uE(() => {
    const r = () => SP.sdk.tryRestorePrivy().then(a => {
      if (a) {
        setAddr(a);
        setConnected(true);
      }
    }).catch(() => {});
    r();
    const on = e => {
      if (e.detail && e.detail.authenticated && e.detail.address) r();
    };
    document.addEventListener("shinyluck:auth-state", on);
    return () => document.removeEventListener("shinyluck:auth-state", on);
  }, []);
  async function load() {
    if (id == null || !SP.sdk.hasTournaments()) return;
    try {
      const [i, c, pend, plrs] = await Promise.all([SP.sdk.tournamentInfo(id), SP.sdk.tournamentClock(id), SP.sdk.pendingEntries(id), SP.sdk.tournamentPlayers(id)]);
      setInfo(i);
      setClock(c);
      try {
        const tb = await SP.sdk.tournamentTables(id);
        setTables(tb);
        setNumTables(tb.length || 1);
      } catch {}
      try {
        setStructure(await SP.sdk.tournamentStructure(id));
      } catch {}
      // finishing places & prizes (event-only data via the dealer bot indexer)
      if (i.status === 2) {
        try {
          const res = await SP.sdk.tournamentResults(id);
          if (res && (res.winner || res.busts.length)) {
            const rows = (res.winner ? [{
              addr: res.winner.player,
              place: 1,
              prize: res.winner.prize
            }] : []).concat([...res.busts].sort((a, b) => a.place - b.place).map(b => ({
              addr: b.player,
              place: b.place,
              prize: b.prize
            })));
            const m = await SP.sdk.profilesFor(rows.map(r => r.addr));
            setResults(rows.map(r => ({
              ...r,
              ...m[r.addr.toLowerCase()]
            })));
          }
        } catch {}
      }
      const withNames = async list => {
        const real = list.filter(a => a !== ZERO);
        const m = await SP.sdk.profilesFor(real);
        return real.map(a => ({
          addr: a,
          ...m[a.toLowerCase()]
        }));
      };
      setPending(await withNames(pend));
      setPlayers(await withNames(plrs));
      if (SP.sdk.address) {
        const [r1, r2, h] = await Promise.all([SP.sdk.isRegisteredIn(id), SP.sdk.isPendingIn(id), SP.sdk.myHandle()]);
        setMyReg(r1);
        setMyPend(r2);
        setHandle(h);
        if (r1 && i.status === 1) {
          try {
            setPlayTable(await SP.sdk.myTournamentTable(id));
          } catch {}
        }
      }
    } catch (e) {
      console.warn("trn page:", e.message);
    }
  }
  uE(() => {
    load();
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, [connected]);
  async function connect() {
    try {
      const a = await SP.sdk.connect();
      setAddr(a);
      setConnected(true);
      load();
    } catch (e) {
      if (e && e.message !== "cancelled") flash(e.message || "connect failed");
    }
  }
  async function run(label, fn) {
    // the clicked button owns the spinner until this settles
    const done = SPPress.claim();
    setBusy(true);
    try {
      await fn();
      flash(label + " ✓");
      await load();
    } catch (e) {
      flash(label + " ✗ " + (e?.shortMessage || e?.reason || e?.message || "").replace(/execution reverted:?/i, "").slice(0, 90));
      console.error(e);
    } finally {
      setBusy(false);
      done();
    }
  }
  if (id == null) return /*#__PURE__*/React.createElement(Centered, null, "Invalid tournament link.");
  if (!SP.sdk.hasTournaments()) return /*#__PURE__*/React.createElement(Centered, null, "Tournaments are not deployed on this network yet.");
  if (!info) return /*#__PURE__*/React.createElement(Centered, null, "Loading tournament\u2026");
  const cost = info.buyIn + info.fee; // BigInt wei
  const free = cost === 0n;
  const sponsored = info.pool > info.buyIn * BigInt(Math.max(0, info.registered));
  const isCreator = !!addr && info.creator.toLowerCase() === addr.toLowerCase();
  const startTime = clock ? clock.startTime : 0;
  const startsIn = startTime ? Math.max(0, startTime - now) : 0;
  const statusCls = ["registering", "running", "finished", "finished"][info.status];
  const splitStr = info.payoutBps.map(b => b / 100 + "%").join(" / ");
  const sb = clock ? Number(clock.curSb) : 0,
    bb = clock ? Number(clock.curBb) : 0,
    ante = clock ? Number(clock.curAnte) : 0;
  const Stat = ({
    k,
    children
  }) => /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 4
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--label)",
      fontSize: 10,
      letterSpacing: ".08em",
      textTransform: "uppercase",
      color: "var(--muted)"
    }
  }, k), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--mono)",
      fontSize: 16,
      color: "var(--text)"
    }
  }, children));
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
    className: "net"
  }, handle || tshort(addr))) : /*#__PURE__*/React.createElement("button", {
    className: "metapill",
    style: {
      cursor: "pointer",
      color: "var(--accent-soft)",
      borderColor: "var(--accent-32)",
      background: "var(--accent-12)"
    },
    onClick: connect
  }, "Connect Wallet")), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      left: "50%",
      top: 92,
      transform: "translateX(-50%)",
      width: "min(760px, 94%)",
      display: "flex",
      flexDirection: "column",
      gap: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      border: "1px solid var(--line)",
      borderRadius: 14,
      padding: "20px 22px",
      background: "var(--panel, rgba(255,255,255,.02))"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--mono)",
      fontSize: 22,
      fontWeight: 700,
      color: "var(--text)"
    }
  }, "Tournament #", id, " \xB7 ", info.maxPlayers, "-max"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginTop: 8,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "statuschip " + statusCls
  }, SP.TRN_STATUS[info.status]), info.approvalRequired && /*#__PURE__*/React.createElement("span", {
    className: "bnt",
    style: {
      background: "var(--accent-12)",
      color: "var(--accent-soft)",
      padding: "2px 8px",
      borderRadius: 6,
      fontFamily: "var(--label)",
      fontSize: 11
    }
  }, "\u25CF private \xB7 by approval"), sponsored && /*#__PURE__*/React.createElement("span", {
    className: "bnt",
    style: {
      padding: "2px 8px",
      borderRadius: 6,
      fontFamily: "var(--label)",
      fontSize: 11
    }
  }, "\u25C6 sponsored"), free && /*#__PURE__*/React.createElement("span", {
    className: "bnt",
    style: {
      padding: "2px 8px",
      borderRadius: 6,
      fontFamily: "var(--label)",
      fontSize: 11,
      color: "var(--win, #57d9a3)"
    }
  }, "FREE entry"))), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "right"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--label)",
      fontSize: 10,
      textTransform: "uppercase",
      letterSpacing: ".08em",
      color: "var(--muted)"
    }
  }, "Prize pool"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--mono)",
      fontSize: 26,
      fontWeight: 700,
      color: "var(--accent-soft)"
    }
  }, N4(info.pool), " ", sym()), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--label)",
      fontSize: 12,
      color: "var(--muted)"
    }
  }, "split ", splitStr), info.hostBps > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--label)",
      fontSize: 11,
      marginTop: 2,
      color: "var(--gold, #e8c15a)"
    }
  }, "\u2605 ", info.hostBps / 100, "% host reward \xB7 prizes from the remaining ", 100 - info.hostBps / 100, "%"))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 16,
      padding: "10px 14px",
      borderRadius: 10,
      background: "var(--accent-08, rgba(217,171,74,.08))",
      fontFamily: "var(--mono)",
      fontSize: 15,
      color: "var(--text)"
    }
  }, info.status === 0 && startTime > 0 && startsIn > 0 && /*#__PURE__*/React.createElement(React.Fragment, null, "\u23F1 Starts in ", /*#__PURE__*/React.createElement("b", null, clk(startsIn))), info.status === 0 && startTime > 0 && startsIn === 0 && /*#__PURE__*/React.createElement(React.Fragment, null, "\u23F1 Start time reached \xB7 waiting on the host / enough players"), info.status === 0 && startTime === 0 && /*#__PURE__*/React.createElement(React.Fragment, null, "Starts when full or when the host starts it"), info.status === 1 && /*#__PURE__*/React.createElement(React.Fragment, null, "\u25CF In progress \xB7 Level ", clock.level + 1, ", blinds ", sb, "/", bb, ante ? ` (ante ${ante})` : "", numTables > 1 ? ` · ${numTables} tables` : ""), info.status === 2 && /*#__PURE__*/React.createElement(React.Fragment, null, "\uD83C\uDFC1 Finished", results && results[0] && results[0].place === 1 && /*#__PURE__*/React.createElement(React.Fragment, null, " \xB7 \uD83C\uDFC6 ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: "var(--accent-soft)"
    }
  }, results[0].handle || tshort(results[0].addr)), " wins ", N4(results[0].prize), " ", sym())), info.status === 3 && /*#__PURE__*/React.createElement(React.Fragment, null, "Cancelled \xB7 all entries refunded")), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 16,
      display: "grid",
      gridTemplateColumns: "repeat(4, 1fr)",
      gap: 14
    }
  }, /*#__PURE__*/React.createElement(Stat, {
    k: "Buy-in"
  }, free ? "Free" : `${N4(cost)} ${sym()}`, !free && info.fee > 0n ? ` (incl ${N4(info.fee)} fee)` : ""), /*#__PURE__*/React.createElement(Stat, {
    k: "Entrants"
  }, info.registered, "/", info.maxPlayers, info.status === 1 ? ` · ${info.remaining} left` : ""), /*#__PURE__*/React.createElement(Stat, {
    k: "Start stack"
  }, Number(info.startStack), " chips"), /*#__PURE__*/React.createElement(Stat, {
    k: "Blinds"
  }, structure.length ? /*#__PURE__*/React.createElement("span", {
    style: {
      cursor: "pointer",
      textDecoration: "underline dotted",
      textUnderlineOffset: 3
    },
    onClick: () => setShowStruct(v => !v)
  }, structure.length, " levels \xB7 ", Math.round(structure[0].durationSecs / 60), " min \u25BE") : structureLabel(clock && Number(clock.levelDur))))), showStruct && structure.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      border: "1px solid var(--line)",
      borderRadius: 14,
      padding: "14px 22px",
      maxHeight: 260,
      overflowY: "auto"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "36px 1fr 0.6fr 0.6fr",
      gap: 6,
      fontFamily: "var(--label)",
      fontSize: 10,
      textTransform: "uppercase",
      letterSpacing: ".08em",
      color: "var(--muted)",
      padding: "2px 0 6px"
    }
  }, /*#__PURE__*/React.createElement("span", null, "Lv"), /*#__PURE__*/React.createElement("span", null, "Blinds"), /*#__PURE__*/React.createElement("span", null, "Ante"), /*#__PURE__*/React.createElement("span", null, "Min")), structure.map((l, i) => {
    const cur = info.status === 1 && clock && clock.level === i;
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        display: "grid",
        gridTemplateColumns: "36px 1fr 0.6fr 0.6fr",
        gap: 6,
        fontFamily: "var(--mono)",
        fontSize: 13,
        padding: "3px 0",
        color: cur ? "var(--accent-soft)" : "var(--text)",
        background: cur ? "var(--accent-08, rgba(217,171,74,.08))" : "transparent",
        borderRadius: 6
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        color: cur ? "var(--accent-soft)" : "var(--muted)"
      }
    }, i + 1, cur ? " ●" : ""), /*#__PURE__*/React.createElement("span", null, l.sb, " / ", l.bb), /*#__PURE__*/React.createElement("span", null, l.ante || "-"), /*#__PURE__*/React.createElement("span", null, Math.round(l.durationSecs / 60)));
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      border: "1px solid var(--line)",
      borderRadius: 14,
      padding: "18px 22px",
      display: "flex",
      flexDirection: "column",
      gap: 12
    }
  }, info.status === 1 && (tables.length > 1 ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      flexWrap: "wrap",
      alignItems: "center"
    }
  }, myReg && playTable != null && /*#__PURE__*/React.createElement("a", {
    className: "btn-sm join",
    href: "table?t=" + playTable
  }, "Play \u2192"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--label)",
      fontSize: 12,
      color: "var(--muted)"
    }
  }, "Watch:"), tables.map((tid, i2) => /*#__PURE__*/React.createElement("a", {
    key: tid,
    className: "btn-sm",
    href: "table?t=" + tid,
    style: playTable === tid ? {
      borderColor: "var(--accent-32)",
      color: "var(--accent-soft)"
    } : undefined
  }, "Table ", i2 + 1, playTable === tid ? " · yours" : ""))) : /*#__PURE__*/React.createElement("a", {
    className: "btn-sm join",
    style: {
      alignSelf: "flex-start"
    },
    href: "table?t=" + (playTable != null ? playTable : info.tableId)
  }, myReg ? "Play →" : "Observe table")), info.status === 0 && !isCreator && (!connected ? /*#__PURE__*/React.createElement("button", {
    className: "btn-sm join",
    style: {
      alignSelf: "flex-start"
    },
    onClick: connect
  }, "Connect wallet to enter") : myReg ? /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--win, #57d9a3)",
      fontFamily: "var(--mono)"
    }
  }, "\u2713 You're in \xB7 see you at the table") : myPend ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      alignItems: "center",
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--accent-soft)",
      fontFamily: "var(--mono)"
    }
  }, "\u23F3 Application pending \xB7 waiting for the host"), /*#__PURE__*/React.createElement("button", {
    className: "btn-sm",
    disabled: busy,
    onClick: () => run("Withdraw", () => SP.sdk.withdrawApplication(id))
  }, "Withdraw")) : !handle ? /*#__PURE__*/React.createElement(NickRow, {
    nick: nick,
    setNick: setNick,
    busy: busy,
    run: run,
    onSet: async () => {
      await SP.sdk.setProfile(nick.trim(), 0);
      setHandle(nick.trim());
    }
  }) : /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      alignItems: "center",
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-sm join",
    disabled: busy,
    onClick: () => run(info.approvalRequired ? "Application sent" : "Registered", () => SP.sdk.registerTournament(id, cost))
  }, info.approvalRequired ? "Apply to join" : "Register", free ? "" : ` · ${N4(cost)} ${sym()}`), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--label)",
      fontSize: 12,
      color: "var(--muted)"
    }
  }, "as ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: "var(--text)"
    }
  }, handle)))), isCreator && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 10
    }
  }, info.status === 0 && !myReg && (handle ? /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("button", {
    className: "btn-sm join",
    disabled: busy,
    onClick: () => run("Registered", () => SP.sdk.registerTournament(id, cost))
  }, "Join as player", free ? "" : ` · ${N4(cost)} ${sym()}`)) : /*#__PURE__*/React.createElement(NickRow, {
    nick: nick,
    setNick: setNick,
    busy: busy,
    run: run,
    onSet: async () => {
      await SP.sdk.setProfile(nick.trim(), 0);
      setHandle(nick.trim());
    }
  })), info.status === 0 && myReg && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      alignItems: "center",
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--win, #57d9a3)",
      fontFamily: "var(--mono)"
    }
  }, "\u2713 You're in as a player"), /*#__PURE__*/React.createElement("button", {
    className: "btn-sm",
    disabled: busy,
    onClick: () => run("Unregistered", () => SP.sdk.unregisterTournament(id))
  }, "Unregister")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      flexWrap: "wrap",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-sm",
    onClick: () => {
      navigator.clipboard?.writeText(location.origin + "/poker?v=tournament&id=" + id);
      flash("Invite link copied");
    }
  }, "\uD83D\uDD17 Copy invite link"), info.status === 0 && info.registered >= 2 && /*#__PURE__*/React.createElement("button", {
    className: "btn-sm join",
    disabled: busy,
    onClick: () => run("Start", () => SP.sdk.startTournament(id))
  }, "Start now"), info.status === 0 && /*#__PURE__*/React.createElement("button", {
    className: "btn-sm",
    disabled: busy,
    onClick: () => run("Cancelled", () => SP.sdk.cancelTournament(id))
  }, "Cancel & refund"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--label)",
      fontSize: 12,
      color: "var(--muted)"
    }
  }, "You're the host \xB7 share the link so players can apply.")))), isCreator && info.approvalRequired && info.status === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      border: "1px solid var(--line)",
      borderRadius: 14,
      padding: "16px 22px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--mono)",
      fontSize: 15,
      marginBottom: 10,
      color: "var(--text)"
    }
  }, "Applicants (", pending.length, ")"), pending.length === 0 ? /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)",
      fontFamily: "var(--label)",
      fontSize: 13
    }
  }, "No pending applications yet.") : pending.map(p => /*#__PURE__*/React.createElement("div", {
    key: p.addr,
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "8px 0",
      borderTop: "1px solid var(--line)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--mono)",
      color: "var(--text)"
    }
  }, p.handle || tshort(p.addr), " ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)",
      fontSize: 11
    }
  }, p.handle ? tshort(p.addr) : "")), /*#__PURE__*/React.createElement("span", {
    style: {
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-sm join",
    disabled: busy,
    onClick: () => run("Approved", () => SP.sdk.approveEntry(id, p.addr))
  }, "Approve"), /*#__PURE__*/React.createElement("button", {
    className: "btn-sm",
    disabled: busy,
    onClick: () => run("Rejected", () => SP.sdk.rejectEntry(id, p.addr))
  }, "Reject"))))), info.status === 2 && /*#__PURE__*/React.createElement("div", {
    style: {
      border: "1px solid var(--line)",
      borderRadius: 14,
      padding: "16px 22px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--mono)",
      fontSize: 15,
      marginBottom: 10,
      color: "var(--text)"
    }
  }, "Final standings"), results == null ? /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)",
      fontFamily: "var(--label)",
      fontSize: 13
    }
  }, "Results are being indexed \xB7 check back in a moment.") : results.map(r => {
    const me = !!addr && r.addr.toLowerCase() === addr.toLowerCase();
    const medal = r.place === 1 ? "🥇" : r.place === 2 ? "🥈" : r.place === 3 ? "🥉" : null;
    return /*#__PURE__*/React.createElement("div", {
      key: r.place,
      style: {
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 10px",
        borderRadius: 8,
        marginTop: 2,
        background: me ? "var(--accent-12, rgba(217,171,74,.12))" : r.place <= 3 ? "var(--accent-08, rgba(217,171,74,.06))" : "transparent"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        width: 40,
        fontFamily: "var(--mono)",
        fontSize: 14,
        color: r.place <= 3 ? "var(--accent-soft)" : "var(--muted)"
      }
    }, medal || "#" + r.place), /*#__PURE__*/React.createElement(AvatarIcon, {
      av: r.avatar,
      img: r.img,
      name: r.handle || r.addr,
      size: 24,
      style: {
        borderRadius: 6
      }
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        fontFamily: "var(--mono)",
        fontSize: 14,
        color: "var(--text)"
      }
    }, r.handle || tshort(r.addr), me && /*#__PURE__*/React.createElement("b", {
      style: {
        color: "var(--accent-soft)"
      }
    }, " \xB7 you"), /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--muted)",
        fontSize: 11,
        marginLeft: 8
      }
    }, r.handle ? tshort(r.addr) : "")), /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: "var(--mono)",
        fontSize: 14,
        color: r.prize > 0n ? "var(--win, #57d9a3)" : "var(--muted)"
      }
    }, r.prize > 0n ? `+${N4(r.prize)} ${sym()}` : "-"));
  }), results && addr && (() => {
    const mine = results.find(r => r.addr.toLowerCase() === addr.toLowerCase());
    if (!mine) return null;
    return /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 12,
        padding: "10px 14px",
        borderRadius: 10,
        background: "var(--accent-08, rgba(217,171,74,.08))",
        fontFamily: "var(--mono)",
        fontSize: 14,
        color: "var(--text)"
      }
    }, mine.place === 1 ? /*#__PURE__*/React.createElement(React.Fragment, null, "\uD83C\uDFC6 You won this tournament \xB7 ", /*#__PURE__*/React.createElement("b", {
      style: {
        color: "var(--win, #57d9a3)"
      }
    }, N4(mine.prize), " ", sym()), " credited to your poker balance.") : mine.prize > 0n ? /*#__PURE__*/React.createElement(React.Fragment, null, "You finished ", /*#__PURE__*/React.createElement("b", null, "#", mine.place), " and won ", /*#__PURE__*/React.createElement("b", {
      style: {
        color: "var(--win, #57d9a3)"
      }
    }, N4(mine.prize), " ", sym()), " \xB7 credited to your poker balance.") : /*#__PURE__*/React.createElement(React.Fragment, null, "You finished ", /*#__PURE__*/React.createElement("b", null, "#", mine.place), " of ", info.registered, ". Better luck next time!"));
  })()), /*#__PURE__*/React.createElement("div", {
    style: {
      border: "1px solid var(--line)",
      borderRadius: 14,
      padding: "16px 22px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--mono)",
      fontSize: 15,
      marginBottom: 10,
      color: "var(--text)"
    }
  }, "Registered (", players.length, "/", info.maxPlayers, ")"), players.length === 0 ? /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)",
      fontFamily: "var(--label)",
      fontSize: 13
    }
  }, "No players registered yet.") : /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexWrap: "wrap",
      gap: 8
    }
  }, players.map(p => /*#__PURE__*/React.createElement("span", {
    key: p.addr,
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 7,
      fontFamily: "var(--mono)",
      fontSize: 13,
      padding: "4px 10px 4px 5px",
      borderRadius: 8,
      background: "var(--accent-08, rgba(217,171,74,.08))",
      color: "var(--text)"
    }
  }, /*#__PURE__*/React.createElement(AvatarIcon, {
    av: p.avatar,
    img: p.img,
    name: p.handle || p.addr,
    size: 22,
    style: {
      borderRadius: 6
    }
  }), p.handle || tshort(p.addr)))))), showCashier && connected && /*#__PURE__*/React.createElement(CashierModal, {
    close: () => setShowCashier(false),
    addr: addr,
    bal: pokerBal,
    refresh: refreshPokerBal
  }), msg && /*#__PURE__*/React.createElement("div", {
    className: "lt-toast",
    style: {
      bottom: 60
    }
  }, msg)));
}

// Bound once - see the same fix in poker-lobby-app.jsx: a 400ms interval was
// re-registering the resize handler forever, and the fit itself rewrote layout
// styles 2.5x/second even when nothing had moved.
let _trnScaleBound = false;
function mountScaleTrn() {
  const scaler = document.getElementById("scaler");
  if (!scaler) return;
  const app = scaler.querySelector(".app");
  if (!app) return;
  const fit = () => {
    const embedNow = document.documentElement.classList.contains("sp-embed");
    const key = window.innerWidth + "x" + window.innerHeight + "|" + (embedNow ? 1 : 0);
    if (app.dataset.slFit === key) return; // remounted nodes carry no marker
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
  if (!_trnScaleBound) {
    _trnScaleBound = true;
    window.addEventListener("resize", () => mountScaleTrn());
  }
}
function bootTrn() {
  ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(TournamentPage, null));
  setInterval(mountScaleTrn, 400);
  setTimeout(mountScaleTrn, 80);
}
if (window.SP) bootTrn();else window.addEventListener("sp:ready", bootTrn, {
  once: true
});