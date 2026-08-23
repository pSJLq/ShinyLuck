/* AUTO-GENERATED from poker-seats.jsx by scripts/build-poker-jsx.js — do NOT edit. */
/* Seats, markers, bet chips, board, pot. Exports to window. */

function ChipStack({
  n = 3,
  color = "var(--accent)"
}) {
  return /*#__PURE__*/React.createElement("span", {
    className: "stackimg"
  }, Array.from({
    length: n
  }).map((_, i) => /*#__PURE__*/React.createElement("span", {
    key: i,
    className: "chipdot",
    style: {
      borderColor: color,
      background: "rgba(217,185,112,0.25)"
    }
  })));
}
function Marker({
  kind
}) {
  const map = {
    dealer: "D",
    sb: "SB",
    bb: "BB"
  };
  const tip = {
    dealer: SPT("Dealer button"),
    sb: SPT("Small blind"),
    bb: SPT("Big blind")
  };
  return /*#__PURE__*/React.createElement("span", {
    className: "btnmark " + kind,
    title: tip[kind]
  }, map[kind]);
}

/* Combo badge palette by hand strength: pale for weak hands, gold/premium for
   monsters · so a beginner instantly reads how big the hand is. Index = the
   evaluator's category (0 high card … 8 straight flush / royal). */
const COMBO_TIERS = [{
  bg: "rgba(255,255,255,.05)",
  bd: "rgba(255,255,255,.16)",
  fg: "var(--muted, #8F8C85)"
}, {
  bg: "rgba(255,255,255,.07)",
  bd: "rgba(255,255,255,.24)",
  fg: "var(--text-2, #c9c9d4)"
}, {
  bg: "rgba(190,200,215,.10)",
  bd: "rgba(190,200,215,.35)",
  fg: "#dfe6f2"
}, {
  bg: "rgba(70,211,154,.12)",
  bd: "rgba(70,211,154,.4)",
  fg: "#46d39a"
}, {
  bg: "rgba(70,211,154,.16)",
  bd: "rgba(70,211,154,.6)",
  fg: "#5fe3ab"
}, {
  bg: "rgba(232,193,90,.13)",
  bd: "rgba(232,193,90,.42)",
  fg: "var(--gold, #e8c15a)"
}, {
  bg: "rgba(232,193,90,.18)",
  bd: "rgba(232,193,90,.6)",
  fg: "#f0cc6e"
}, {
  bg: "rgba(239,90,111,.16)",
  bd: "rgba(239,90,111,.55)",
  fg: "#ff8d9d"
}, {
  bg: "linear-gradient(90deg, rgba(232,193,90,.32), rgba(255,220,130,.22))",
  bd: "#e8c15a",
  fg: "#ffe9ad",
  glow: "0 0 14px rgba(232,193,90,.5)"
}];
function comboStyle(cat) {
  const t = COMBO_TIERS[Math.max(0, Math.min(8, cat == null ? 0 : cat))];
  return {
    background: t.bg,
    borderColor: t.bd,
    color: t.fg,
    boxShadow: t.glow || "none"
  };
}
function TimerRing({
  seconds = 18
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "timerbar"
  }, /*#__PURE__*/React.createElement("i", {
    style: {
      animation: `deplete ${seconds}s linear forwards`
    }
  }));
}

/* Compact chip amounts: 1500 → "1.5k", 2100000 → "2.1M". Values past the T
   range only exist on blind-overflow debris events · show short scientific
   ("1.5e24") instead of a 17-digit smear. */
function fmtChips(n) {
  n = Number(n) || 0;
  if (n >= 1e15) {
    const [m, e] = n.toExponential(1).split("e");
    return m.replace(/\.0$/, "") + "e" + e.replace("+", "");
  }
  if (n >= 1e12) return (n / 1e12).toFixed(n % 1e12 ? 1 : 0) + "T";
  if (n >= 1e9) return (n / 1e9).toFixed(n % 1e9 ? 1 : 0) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + "M";
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + "k";
  return String(n);
}
function Seat({
  player,
  data,
  pos,
  active,
  marker,
  deckMode,
  revealCards,
  revealAnim,
  revealDim
}) {
  const cls = ["seat"];
  if (player.hero) cls.push("hero");
  if (active) cls.push("active");
  if (data.folded) cls.push("folded");
  if (data.allin) cls.push("allin");
  if (data.winner) cls.push("winner");
  if (data.dimmed) cls.push("dimmed");
  if (data.disc) cls.push("disc");
  if (data.sittingout) cls.push("sittingout");
  const name = data.name || player.name;
  const chipMode = data.chips != null;
  return /*#__PURE__*/React.createElement("div", {
    className: cls.join(" "),
    style: {
      left: pos.x + "%",
      top: pos.y + "%"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "seatcard"
  }, data.bounty && /*#__PURE__*/React.createElement("span", {
    className: "bountytag"
  }, "\u25C6", data.bounty), data.lastAct && !data.winner && /*#__PURE__*/React.createElement("span", {
    className: "actchip " + data.lastAct.kind
  }, data.lastAct.text), data.winner && /*#__PURE__*/React.createElement("span", {
    className: "crown",
    "aria-hidden": "true"
  }, "\uD83D\uDC51"), /*#__PURE__*/React.createElement(AvatarIcon, {
    av: player.avId,
    img: player.avImg,
    name: name
  }), /*#__PURE__*/React.createElement("div", {
    className: "seatinfo"
  }, /*#__PURE__*/React.createElement("div", {
    className: "nm"
  }, player.hero ? SPT("YOU") : name), data.bbstacks && data.bbval != null ? /*#__PURE__*/React.createElement("div", {
    className: "stack tnum"
  }, data.bbval, /*#__PURE__*/React.createElement("span", {
    className: "bbcount"
  }, " BB")) : chipMode ? /*#__PURE__*/React.createElement("div", {
    className: "stack tnum"
  }, /*#__PURE__*/React.createElement(ChipMark, {
    size: 13
  }), fmtChips(data.chips)) : /*#__PURE__*/React.createElement("div", {
    className: "stack tnum"
  }, /*#__PURE__*/React.createElement(SomiCoin, {
    size: 13
  }), fmtMoney(data.stack)), data.winner ? /*#__PURE__*/React.createElement("div", {
    className: "wonchip"
  }, data.won ? "+" + data.won : SPT("WINNER")) : /*#__PURE__*/React.createElement("div", {
    className: "status"
  }, data.status)), marker && /*#__PURE__*/React.createElement(Marker, {
    kind: marker
  }), active && !data.disc && /*#__PURE__*/React.createElement(TimerRing, {
    seconds: data.timer || 18
  })), revealCards &&
  /*#__PURE__*/
  /* revealed cards always open toward the TABLE CENTER: above the seat
     for bottom-half seats, below it for top-half seats · otherwise the
     top opponent's cards slide off-screen under the HUD */
  React.createElement("div", {
    className: "seatreveal" + (pos.y < 50 ? " below" : "")
  }, /*#__PURE__*/React.createElement("div", {
    className: "hole",
    style: {
      justifyContent: "center",
      transform: "scale(0.62)",
      transformOrigin: pos.y < 50 ? "top center" : "bottom center"
    }
  }, revealCards.map((c, i) => /*#__PURE__*/React.createElement(Card, {
    key: i,
    c: c,
    dim: !!(revealDim && revealDim[i]),
    className: revealAnim ? "reveal" : "",
    style: revealAnim ? {
      animationDelay: i * 130 + "ms"
    } : undefined
  }))), data.combo && /*#__PURE__*/React.createElement("span", {
    className: "combobadge",
    style: comboStyle(data.comboCat)
  }, data.combo)));
}
function BetChips({
  pos,
  amount,
  chips,
  slide,
  fromSeat
}) {
  if (!amount) return null;
  const x = pos.x + (50 - pos.x) * 0.34;
  const y = pos.y + (46 - pos.y) * 0.34;
  const csx = fromSeat ? (pos.x - 50) * 0.9 + "px" : "0px";
  const csy = fromSeat ? (pos.y - 46) * 0.9 + "px" : "0px";
  return /*#__PURE__*/React.createElement("div", {
    className: "betchips" + (slide ? " slide" : ""),
    style: {
      position: "absolute",
      left: x + "%",
      top: y + "%",
      transform: "translate(-50%,-50%)",
      "--csx": csx,
      "--csy": csy
    }
  }, chips ? /*#__PURE__*/React.createElement(ChipMark, {
    size: 13
  }) : /*#__PURE__*/React.createElement(SomiCoin, {
    size: 13
  }), /*#__PURE__*/React.createElement("span", {
    className: "amt tnum"
  }, chips ? fmtChips(amount) : fmtMoney(amount)));
}

/* `due` = how many board cards this street is entitled to. Slots between what
   has arrived and what is due render as face-down cards being turned over,
   because the alternative is what players actually complained about: the
   action moves to you against an empty felt, and nothing on screen says a card
   is on its way — so it reads as "my flop is missing", not "wait a moment". */
function Board({
  cards = [],
  deckMode,
  dealing,
  flipFrom = 99,
  dim,
  due = 0
}) {
  const slots = [];
  for (let i = 0; i < 5; i++) {
    if (cards[i]) {
      const isNew = i >= flipFrom;
      slots.push(/*#__PURE__*/React.createElement(Card, {
        key: i,
        c: cards[i],
        dim: !!(dim && dim[i]),
        className: isNew ? "flip" : "",
        style: isNew ? {
          animationDelay: (i - flipFrom) * 80 + "ms"
        } : undefined
      }));
    } else if (i < due) {
      slots.push(/*#__PURE__*/React.createElement(Card, {
        key: i,
        back: true,
        className: "revealing",
        style: {
          animationDelay: (i - cards.length) * 120 + "ms"
        }
      }));
    } else {
      slots.push(/*#__PURE__*/React.createElement("div", {
        key: i,
        className: "slot empty"
      }));
    }
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "board"
  }, slots);
}

/* face-down hole cards dealt to in-hand opponents; muck=true plays the discard
   fling toward the pot (mx/my = px offset in that direction) after a fold.
   Backs sit on the CENTER side of the seat so top seats don't clip off-screen. */
function HoleBacks({
  pos,
  deal,
  delay,
  muck,
  mx,
  my
}) {
  const cy = pos.y < 50 ? pos.y + 9 : pos.y - 9;
  return /*#__PURE__*/React.createElement("div", {
    className: "seatbacks" + (muck ? " muck" : ""),
    style: {
      position: "absolute",
      left: pos.x + "%",
      top: cy + "%",
      transform: "translate(-50%,-50%)",
      zIndex: 7,
      display: "flex",
      gap: 3,
      "--mx": (mx || 0) + "px",
      "--my": (my == null ? -40 : my) + "px"
    }
  }, /*#__PURE__*/React.createElement(Card, {
    back: true,
    className: deal ? "deal" : "",
    style: deal ? {
      "--dy": "-160px",
      "--dr": "-6deg",
      animationDelay: delay + "ms",
      width: 30,
      height: 42
    } : {
      width: 30,
      height: 42
    }
  }), /*#__PURE__*/React.createElement(Card, {
    back: true,
    className: deal ? "deal" : "",
    style: deal ? {
      "--dy": "-160px",
      "--dr": "6deg",
      animationDelay: delay + 60 + "ms",
      width: 30,
      height: 42
    } : {
      width: 30,
      height: 42
    }
  }));
}
function Pot({
  pot,
  sidePots = [],
  chips
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "pot"
  }, /*#__PURE__*/React.createElement("div", {
    className: "potmain"
  }, /*#__PURE__*/React.createElement("span", {
    className: "k"
  }, SPT("Pot")), chips ? /*#__PURE__*/React.createElement(ChipMark, {
    size: 15
  }) : /*#__PURE__*/React.createElement(SomiCoin, {
    size: 15
  }), /*#__PURE__*/React.createElement("span", {
    className: "v tnum"
  }, chips ? fmtChips(pot) : fmtMoney(pot))), sidePots.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "sides"
  }, sidePots.map((s, i) => /*#__PURE__*/React.createElement("span", {
    key: i,
    className: "side"
  }, s.label, " ", /*#__PURE__*/React.createElement("b", {
    className: "tnum"
  }, fmtMoney(s.v))))));
}
Object.assign(window, {
  Seat,
  BetChips,
  Board,
  Pot,
  ChipStack,
  TimerRing,
  Marker,
  fmtChips,
  HoleBacks,
  comboStyle
});