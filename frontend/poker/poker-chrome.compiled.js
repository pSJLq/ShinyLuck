/* AUTO-GENERATED from poker-chrome.jsx by scripts/build-poker-jsx.js — do NOT edit. */
/* ShinyPoker chrome: top bar, side rail, action bar, annotations, HUD, overlays. */

const I = {
  gear: /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.6"
  }, /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "3"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"
  })),
  leave: /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.7"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M16 17l5-5-5-5"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M21 12H9"
  })),
  lock: /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.7"
  }, /*#__PURE__*/React.createElement("rect", {
    x: "4",
    y: "11",
    width: "16",
    height: "9",
    rx: "2"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M8 11V7a4 4 0 0 1 8 0v4"
  })),
  plus: /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.8"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M12 5v14M5 12h14"
  })),
  shield: /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.6"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5z"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M9 12l2 2 4-4"
  })),
  check: /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2.2"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M20 6L9 17l-5-5"
  })),
  pause: /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.7"
  }, /*#__PURE__*/React.createElement("rect", {
    x: "6",
    y: "5",
    width: "4",
    height: "14",
    rx: "1"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "14",
    y: "5",
    width: "4",
    height: "14",
    rx: "1"
  }))
};

/* ---------------- Top bar ---------------- */
function TopBar({
  scene,
  product,
  onProduct,
  onSettings,
  deckMode,
  balance,
  mode = "table",
  onDeposit,
  wrongNetwork,
  roomLabel
}) {
  return /*#__PURE__*/React.createElement("header", {
    className: "topbar"
  }, /*#__PURE__*/React.createElement("div", {
    className: "group"
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 8
    }
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
    className: "switcher",
    "data-anno": "switcher"
  }, /*#__PURE__*/React.createElement("button", {
    className: product === "casino" ? "on casino" : "",
    onClick: () => onProduct && onProduct("casino")
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot"
  }), "ShinyLuck"), /*#__PURE__*/React.createElement("button", {
    className: product === "poker" ? "on" : "",
    onClick: () => onProduct && onProduct("poker")
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot"
  }), "Poker")), /*#__PURE__*/React.createElement("div", {
    className: "sep"
  }), mode === "table" ? /*#__PURE__*/React.createElement("div", {
    className: "group",
    "data-anno": "blinds"
  }, /*#__PURE__*/React.createElement("span", {
    className: "metapill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "k"
  }, "NLHE"), /*#__PURE__*/React.createElement("b", null, "6-MAX")), /*#__PURE__*/React.createElement("span", {
    className: "metapill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "k"
  }, "Blinds"), /*#__PURE__*/React.createElement("b", null, "0.5 / 1")), /*#__PURE__*/React.createElement("span", {
    className: "metapill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "k"
  }, "Hand"), /*#__PURE__*/React.createElement("b", null, "#", scene.hand))) : /*#__PURE__*/React.createElement("div", {
    className: "group"
  }, /*#__PURE__*/React.createElement("span", {
    className: "metapill"
  }, /*#__PURE__*/React.createElement("span", {
    className: "k"
  }, "Room"), /*#__PURE__*/React.createElement("b", null, roomLabel || "LOBBY"))), /*#__PURE__*/React.createElement("div", {
    className: "spacer"
  }), mode === "table" && /*#__PURE__*/React.createElement("button", {
    className: "iconbtn",
    title: "Add chips / top-up"
  }, I.plus), mode === "lobby" && /*#__PURE__*/React.createElement("button", {
    className: "metapill",
    "data-anno": "deposit",
    onClick: onDeposit,
    style: {
      cursor: "pointer",
      gap: 7,
      height: 34,
      color: "var(--accent-soft)",
      borderColor: "var(--accent-32)",
      background: "var(--accent-12)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 13,
      height: 13
    }
  }, I.plus), " Deposit"), mode === "table" && /*#__PURE__*/React.createElement("div", {
    className: "session",
    "data-anno": "session",
    title: "Table session active \xB7 fold/call/raise without a wallet popup"
  }, /*#__PURE__*/React.createElement("span", {
    className: "pulse"
  }), /*#__PURE__*/React.createElement("span", {
    className: "lock"
  }, I.lock), /*#__PURE__*/React.createElement("span", null, "session active \xB7 cap 50")), /*#__PURE__*/React.createElement("div", {
    className: "wallet" + (wrongNetwork ? " wrongnet" : ""),
    "data-anno": "wallet"
  }, /*#__PURE__*/React.createElement(BraceLogo, {
    size: 16
  }), /*#__PURE__*/React.createElement("span", {
    className: "bal tnum"
  }, fmtMoney(balance)), /*#__PURE__*/React.createElement("span", {
    className: "net"
  }, wrongNetwork ? "Wrong network" : "Somnia")), /*#__PURE__*/React.createElement("button", {
    className: "iconbtn",
    title: "Settings",
    onClick: onSettings
  }, I.gear), mode === "table" && /*#__PURE__*/React.createElement("button", {
    className: "iconbtn leavebtn",
    title: "Leave table"
  }, I.leave));
}

/* ---------------- Side rail ---------------- */
function SideRail() {
  const [tab, setTab] = React.useState("chat");
  return /*#__PURE__*/React.createElement("aside", {
    className: "siderail",
    "data-anno": "rail"
  }, /*#__PURE__*/React.createElement("div", {
    className: "railtabs"
  }, ["chat", "hands", "notes"].map(t => /*#__PURE__*/React.createElement("button", {
    key: t,
    className: tab === t ? "on" : "",
    onClick: () => setTab(t)
  }, t))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "9px 12px",
      borderBottom: "1px solid var(--line)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "tag"
  }, tab === "chat" ? "table chat · dealer feed" : tab === "hands" ? "hand history · #4821" : "player notes & tags")), /*#__PURE__*/React.createElement("div", {
    className: "railbody"
  }, tab === "chat" && CHAT.map((c, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: "chatline" + (c.dealer ? " dealer" : "")
  }, !c.dealer && /*#__PURE__*/React.createElement("span", {
    className: "who"
  }, c.who), c.t)), tab === "hands" && HISTORY.map((h, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: "hhrow"
  }, /*#__PURE__*/React.createElement("span", {
    className: "st"
  }, h.st), /*#__PURE__*/React.createElement("span", {
    className: "act"
  }, h.act))), tab === "notes" && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "hhrow"
  }, /*#__PURE__*/React.createElement("span", {
    className: "st",
    style: {
      color: "var(--danger-soft)"
    }
  }, "RED"), /*#__PURE__*/React.createElement("span", {
    className: "act"
  }, "degenqueen.somi \xB7 ", /*#__PURE__*/React.createElement("span", {
    className: "dim"
  }, "3-bets light, c-bets 80%+"))), /*#__PURE__*/React.createElement("div", {
    className: "hhrow"
  }, /*#__PURE__*/React.createElement("span", {
    className: "st",
    style: {
      color: "var(--win)"
    }
  }, "GREEN"), /*#__PURE__*/React.createElement("span", {
    className: "act"
  }, "nakamoto.somi \xB7 ", /*#__PURE__*/React.createElement("span", {
    className: "dim"
  }, "tight / folds to aggression"))), /*#__PURE__*/React.createElement("div", {
    className: "hhrow"
  }, /*#__PURE__*/React.createElement("span", {
    className: "st",
    style: {
      color: "var(--accent-soft)"
    }
  }, "NOTE"), /*#__PURE__*/React.createElement("span", {
    className: "act"
  }, "blockwizard.somi \xB7 ", /*#__PURE__*/React.createElement("span", {
    className: "dim"
  }, "straddles every BTN"))), /*#__PURE__*/React.createElement("div", {
    className: "chatinput"
  }, /*#__PURE__*/React.createElement("input", {
    placeholder: "Add a note\u2026"
  })))), /*#__PURE__*/React.createElement("div", {
    className: "pfwidget",
    "data-anno": "pf"
  }, /*#__PURE__*/React.createElement("div", {
    className: "pfhead"
  }, /*#__PURE__*/React.createElement("span", {
    className: "ttl"
  }, I.shield, " provably fair \xB7 zkShuffle"), /*#__PURE__*/React.createElement("span", {
    className: "zkbadge",
    style: {
      padding: "3px 8px"
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "chk"
  }, I.check), "Verify")), /*#__PURE__*/React.createElement("div", {
    className: "commit"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    className: "lab"
  }, "deal"), " #8af3c1d9e7b2\u2026"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "lab"
  }, "cards"), " player-encrypted \xB7 every reveal proven"))));
}

/* ---------------- Action bar (your turn) ----------------
   One card, two rows: how much on top, what to do underneath. The old bar
   spread four unrelated clusters across the full width — helper chips at the
   far left, a timer ring in the middle of the sizing controls, buttons at the
   far right — so the two things a player actually does (pick a size, press an
   action) were the two furthest apart. The amounts now live ON the buttons,
   which is also what stops a mis-read: you press a number, not a word. */
function ActionBar({
  action,
  deckMode,
  onFold,
  onCheckCall,
  onRaise,
  onAllIn,
  betValue,
  setBetValue
}) {
  const {
    toCall,
    minRaise,
    potForBet,
    heroStack,
    best,
    potOdds,
    raiseLabel,
    canCheck,
    step,
    symbol,
    chips
  } = action;
  const [active, setActive] = React.useState(null);
  const min = minRaise,
    max = heroStack;
  const fill = max > min ? (betValue - min) / (max - min) * 100 : 100;
  const stepN = step || 0.5;
  const clamp = v => Math.min(max, Math.max(min, v));
  const fmt = v => chips ? fmtChips(Math.round(v)) : fmtMoney(v);
  const quick = [{
    k: SPT("Min"),
    v: minRaise
  }, {
    k: "50%",
    v: round1(potForBet * 0.5 + toCall)
  }, {
    k: "75%",
    v: round1(potForBet * 0.75 + toCall)
  }, {
    k: SPT("Pot"),
    v: round1(potForBet + toCall)
  }].filter(q => clamp(q.v) > min || q.k === SPT("Min"));
  const secsLeft = action.timer;
  const urgent = secsLeft != null && secsLeft <= 8;
  const pct = secsLeft != null ? Math.max(0, Math.min(1, secsLeft / (action.timerTotal || 30))) : 1;
  return /*#__PURE__*/React.createElement("div", {
    className: "actionbar"
  }, /*#__PURE__*/React.createElement("div", {
    className: "actbar" + (urgent ? " urgent" : "")
  }, /*#__PURE__*/React.createElement("div", {
    className: "acttimer"
  }, /*#__PURE__*/React.createElement("i", {
    style: {
      width: pct * 100 + "%"
    }
  })), /*#__PURE__*/React.createElement("div", {
    className: "actrow sizing",
    "data-anno": "bet"
  }, /*#__PURE__*/React.createElement("div", {
    className: "quickchips"
  }, quick.map(q => /*#__PURE__*/React.createElement("button", {
    key: q.k,
    className: active === q.k ? "on" : "",
    onClick: () => {
      setActive(q.k);
      setBetValue(clamp(q.v));
    }
  }, q.k))), /*#__PURE__*/React.createElement("button", {
    className: "nudge",
    title: SPT("Less"),
    onClick: () => {
      setActive(null);
      setBetValue(clamp(betValue - stepN));
    }
  }, "\u2212"), /*#__PURE__*/React.createElement("div", {
    className: "bslider",
    style: {
      "--fill": Math.max(0, Math.min(1, fill / 100))
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "range",
    min: min,
    max: max,
    step: stepN,
    value: betValue,
    onChange: e => {
      setBetValue(parseFloat(e.target.value));
      setActive(null);
    }
  })), /*#__PURE__*/React.createElement("button", {
    className: "nudge",
    title: SPT("More"),
    onClick: () => {
      setActive(null);
      setBetValue(clamp(betValue + stepN));
    }
  }, "+"), /*#__PURE__*/React.createElement("div", {
    className: "betinput"
  }, /*#__PURE__*/React.createElement("input", {
    type: "text",
    value: fmt(betValue),
    "aria-label": SPT("Raise to"),
    onChange: e => {
      const v = SP.num(e.target.value);
      if (e.target.value.trim()) setBetValue(v);
    }
  })), /*#__PURE__*/React.createElement("div", {
    className: "youhave"
  }, /*#__PURE__*/React.createElement("span", {
    className: "k"
  }, SPT("Best")), /*#__PURE__*/React.createElement("b", null, best), potOdds && potOdds !== "-" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
    className: "k"
  }, SPT("Pot odds")), /*#__PURE__*/React.createElement("b", null, potOdds)), secsLeft != null && /*#__PURE__*/React.createElement("span", {
    className: "secs tnum" + (urgent ? " hot" : "")
  }, secsLeft, "s"))), /*#__PURE__*/React.createElement("div", {
    className: "actrow actions",
    "data-anno": "actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "abtn fold",
    onClick: onFold
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, SPT("Fold"))), /*#__PURE__*/React.createElement("button", {
    className: "abtn call",
    onClick: onCheckCall
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, canCheck ? SPT("Check") : SPT("Call")), !canCheck && /*#__PURE__*/React.createElement("span", {
    className: "amt tnum"
  }, fmt(toCall))), /*#__PURE__*/React.createElement("button", {
    className: "abtn raise",
    onClick: () => onRaise(betValue)
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, raiseLabel || SPT("Raise to")), /*#__PURE__*/React.createElement("span", {
    className: "amt tnum"
  }, fmt(betValue))), onAllIn && heroStack > min && /*#__PURE__*/React.createElement("button", {
    className: "abtn allin",
    onClick: onAllIn
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, SPT("All-in")), /*#__PURE__*/React.createElement("span", {
    className: "amt tnum"
  }, fmt(heroStack))))));
}
function round1(n) {
  return Math.round(n * 2) / 2;
}

/* status strip for non-your-turn states */
function StatusStrip({
  text,
  sub,
  accent
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "actionbar"
  }, /*#__PURE__*/React.createElement("div", {
    className: "actbar narrow waiting"
  }, /*#__PURE__*/React.createElement("div", {
    className: "waitline",
    style: accent ? {
      color: accent,
      fontWeight: 600
    } : undefined
  }, text), sub && /*#__PURE__*/React.createElement("div", {
    className: "waitsub"
  }, sub)));
}

/* ---------------- Banners & overlays ---------------- */
/* name → "<nick> wins" (spectators + when the hero lost see WHO won);
   pending → showdown announced, pot still settling on-chain;
   won → PRE-FORMATTED amount string, shown to EVERYONE (loser & observers
   should also see what the pot paid), red-tinted on a loss. */
function WinBanner({
  hand,
  won,
  lose,
  unit,
  name,
  pending
}) {
  const title = name ? name + " " + SPT("wins") : lose ? SPT("You lose") : SPT("You win");
  // One line, not a stack of three. The felt between the board and the hero's
  // hole cards is about 80px tall, and a three-row banner simply did not fit
  // there — it printed itself over the community cards and over the player's
  // own hand, at the exact moment both of those most need to be readable.
  return /*#__PURE__*/React.createElement("div", {
    className: "winbanner" + (lose ? " lose" : "")
  }, /*#__PURE__*/React.createElement("span", {
    className: "won"
  }, title), hand ? /*#__PURE__*/React.createElement("span", {
    className: "hand"
  }, hand) : null, /*#__PURE__*/React.createElement("span", {
    className: "paid"
  }, pending ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
    className: "chk sp-spin"
  }, I.check), SPT("settling…")) : won != null ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
    className: "chk"
  }, I.check), won, " ", unit || "SOMI") : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
    className: "chk"
  }, I.check), SPT("settled"))));
}
function RunItTwicePrompt({
  onChoose
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "ritprompt"
  }, /*#__PURE__*/React.createElement("div", {
    className: "q"
  }, "Run it twice?", /*#__PURE__*/React.createElement("small", null, "Deal the turn & river on two boards \xB7 split the pot, reduce variance.")), /*#__PURE__*/React.createElement("div", {
    className: "btns"
  }, /*#__PURE__*/React.createElement("button", {
    className: "pill",
    onClick: () => onChoose("once")
  }, "Run once"), /*#__PURE__*/React.createElement("button", {
    className: "pill primary",
    onClick: () => onChoose("twice")
  }, "Run it twice \u2713")));
}
function DiscOverlay({
  field
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "discoverlay"
  }, /*#__PURE__*/React.createElement("div", {
    className: "disccard"
  }, /*#__PURE__*/React.createElement("div", {
    className: "spin"
  }), /*#__PURE__*/React.createElement("div", {
    className: "ttl"
  }, "Reconnecting\u2026"), /*#__PURE__*/React.createElement("div", {
    className: "sub"
  }, "Lost connection to the Somnia node. Re-subscribing to the table's live event stream."), /*#__PURE__*/React.createElement("div", {
    className: "note"
  }, I.lock, " Your hand & chips are safe \xB7 held on-chain. Time-bank auto-protects your action.")));
}
function TxToast() {
  return /*#__PURE__*/React.createElement("div", {
    className: "txtoast",
    "data-anno": "tx"
  }, /*#__PURE__*/React.createElement("span", {
    className: "sp"
  }), /*#__PURE__*/React.createElement("span", null, "Settling pot on-chain\u2026 ", /*#__PURE__*/React.createElement("a", {
    href: "#"
  }, "0x4f\u2026a91 \u2197")));
}

/* ---------------- Settings popover ---------------- */
const THEME_SWATCHES = [{
  k: "a",
  name: "Terminal",
  bg: "radial-gradient(120% 120% at 50% 30%, rgba(217,185,112,0.18), #08080b 60%)",
  border: "1px solid rgba(255,255,255,0.14)"
}, {
  k: "b",
  name: "Premium",
  bg: "radial-gradient(70% 70% at 50% 35%, #2b2310, #171208 60%, #0d0a05)",
  border: "2px solid rgba(217,185,112,0.5)"
}, {
  k: "c",
  name: "Grid",
  bg: "linear-gradient(180deg,#0e0e11,#0a0a0c)",
  border: "1px solid rgba(255,255,255,0.1)",
  grid: true
}];
function SettingsPanel({
  t,
  set,
  dir,
  setDir,
  onClose,
  session,
  seat
}) {
  // language moved to casino Settings
  const Row = ({
    label,
    children
  }) => /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 16,
      padding: "9px 0",
      borderBottom: "1px solid var(--hair)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--label)",
      fontSize: 12,
      color: "var(--text-2)"
    }
  }, label), children);
  const Sw = ({
    on,
    onClick
  }) => /*#__PURE__*/React.createElement("button", {
    onClick: onClick,
    className: "htoggle" + (on ? " on" : ""),
    style: {
      padding: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "sw"
  }, /*#__PURE__*/React.createElement("i", null)));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      top: 50,
      right: 14,
      zIndex: 60,
      width: 280,
      padding: "12px 14px",
      borderRadius: 12,
      background: "rgba(13,13,18,0.97)",
      border: "1px solid var(--line-2)",
      boxShadow: "0 24px 70px rgba(0,0,0,0.6)",
      backdropFilter: "blur(10px)",
      maxHeight: "calc(100% - 70px)",
      overflowY: "auto"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "tag",
    style: {
      marginBottom: 8
    }
  }, SPT("table settings")), /*#__PURE__*/React.createElement(Row, {
    label: SPT("4-color deck")
  }, /*#__PURE__*/React.createElement(Sw, {
    on: t.deck === "4",
    onClick: () => set("deck", t.deck === "4" ? "2" : "4")
  })), /*#__PURE__*/React.createElement(Row, {
    label: SPT("Stacks in big blinds")
  }, /*#__PURE__*/React.createElement(Sw, {
    on: t.bbstacks,
    onClick: () => set("bbstacks", !t.bbstacks)
  })), /*#__PURE__*/React.createElement(Row, {
    label: SPT("Extra large interface")
  }, /*#__PURE__*/React.createElement(Sw, {
    on: t.bigui,
    onClick: () => set("bigui", !t.bigui)
  })), seat && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "pill",
    disabled: seat.busy,
    onClick: seat.toggle,
    style: {
      width: "100%",
      fontSize: 12,
      padding: "9px 12px"
    }
  }, seat.sittingOut ? SPT("Sit back in") : SPT("Sit out next hand")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--label)",
      fontSize: 10.5,
      color: "var(--muted)",
      marginTop: 6,
      lineHeight: 1.45
    }
  }, seat.sittingOut ? SPT("You keep your seat and your chips while sitting out.") : SPT("Keeps your seat and chips · you are not dealt in until you sit back."))), session && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10,
      padding: "10px 11px",
      borderRadius: 8,
      border: "1px solid var(--accent-32)",
      background: "var(--accent-12)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 7,
      fontFamily: "var(--label)",
      fontSize: 11,
      color: "var(--accent-soft)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 14,
      height: 14,
      display: "inline-flex",
      flexShrink: 0
    }
  }, I.lock), session.label ? session.label : session.active ? "Session key active" + (session.cap != null ? " · cap " + session.cap : "") : "Session key off"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--label)",
      fontSize: 10.5,
      color: "var(--muted)",
      margin: "6px 0 9px"
    }
  }, session.active ? "Fold / call / raise without a wallet popup." : "Grant a table session to act without a popup each time."), /*#__PURE__*/React.createElement("button", {
    className: "pill",
    disabled: session.busy,
    onClick: session.active ? session.onRevoke : session.onActivate,
    style: {
      fontSize: 11,
      padding: "7px 12px",
      width: "100%",
      borderColor: session.active ? "rgba(229,86,42,0.4)" : "var(--accent-32)",
      color: session.active ? "var(--danger-soft)" : "var(--accent-soft)"
    }
  }, session.active ? "Revoke session key" : "Activate session")), /*#__PURE__*/React.createElement("button", {
    className: "pill",
    style: {
      fontSize: 11,
      padding: "7px 12px",
      width: "100%",
      marginTop: 8
    },
    onClick: onClose
  }, SPT("Close")));
}
Object.assign(window, {
  TopBar,
  SideRail,
  ActionBar,
  StatusStrip,
  WinBanner,
  RunItTwicePrompt,
  DiscOverlay,
  TxToast,
  SettingsPanel,
  ChromeIcons: I
});