/* Seats, markers, bet chips, board, pot. Exports to window. */

function ChipStack({ n = 3, color = "var(--accent)" }) {
  return (
    <span className="stackimg">
      {Array.from({ length: n }).map((_, i) => (
        <span key={i} className="chipdot" style={{ borderColor: color, background: "rgba(110,110,237,0.25)" }} />
      ))}
    </span>
  );
}

function Marker({ kind }) {
  const map = { dealer: "D", sb: "SB", bb: "BB" };
  return <span className={"btnmark " + kind}>{map[kind]}</span>;
}

function TimerRing({ seconds = 18 }) {
  return <div className="timerbar"><i style={{ animation: `deplete ${seconds}s linear forwards` }} /></div>;
}

function fmtChips(n) { return n >= 1000 ? (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + "k" : String(n); }

function Seat({ player, data, pos, active, marker, deckMode, revealCards, revealAnim }) {
  const cls = ["seat"];
  if (player.hero) cls.push("hero");
  if (active) cls.push("active");
  if (data.folded) cls.push("folded");
  if (data.allin) cls.push("allin");
  if (data.winner) cls.push("winner");
  if (data.disc) cls.push("disc");
  if (data.sittingout) cls.push("sittingout");
  const name = data.name || player.name;
  const chipMode = data.chips != null;
  return (
    <div className={cls.join(" ")} style={{ left: pos.x + "%", top: pos.y + "%" }}>
      <div className="seatcard">
        {data.bounty && <span className="bountytag">◆{data.bounty}</span>}
        <div className="avatar">
          {player.av}
          <span className="ava-grid" />
        </div>
        <div className="seatinfo">
          <div className="nm">{player.hero ? "YOU" : name}</div>
          {chipMode
            ? <div className="stack tnum">{fmtChips(data.chips)}<span className="bbcount"> · {data.bb}bb</span></div>
            : <div className="stack tnum">{data.stack.toFixed(1)}<span className="u">SOMI</span></div>}
          <div className="status">{data.status}</div>
        </div>
        {marker && <Marker kind={marker} />}
        {active && !data.disc && <TimerRing seconds={18} />}
      </div>
      {revealCards && (
        <div className="hole" style={{ justifyContent: "center", marginTop: 6, transform: "scale(0.62)", transformOrigin: "top center" }}>
          {revealCards.map((c, i) => <Card key={i} c={c} className={revealAnim ? "reveal" : ""}
            style={revealAnim ? { animationDelay: (i * 130) + "ms" } : undefined} />)}
        </div>
      )}
    </div>
  );
}

function BetChips({ pos, amount, chips, slide, fromSeat }) {
  if (!amount) return null;
  const x = pos.x + (50 - pos.x) * 0.34;
  const y = pos.y + (46 - pos.y) * 0.34;
  const csx = fromSeat ? ((pos.x - 50) * 0.9) + "px" : "0px";
  const csy = fromSeat ? ((pos.y - 46) * 0.9) + "px" : "0px";
  return (
    <div className={"betchips" + (slide ? " slide" : "")} style={{ position: "absolute", left: x + "%", top: y + "%", transform: "translate(-50%,-50%)", "--csx": csx, "--csy": csy }}>
      <ChipStack n={amount > 20 ? 4 : amount > 5 ? 3 : 2} />
      <span className="amt tnum">{chips ? fmtChips(amount) : amount.toFixed(amount % 1 ? 1 : 0)}</span>
    </div>
  );
}

function Board({ cards = [], deckMode, dealing, flipFrom = 99 }) {
  const slots = [];
  for (let i = 0; i < 5; i++) {
    if (cards[i]) {
      const isNew = i >= flipFrom;
      slots.push(<Card key={i} c={cards[i]} className={isNew ? "flip" : ""}
        style={isNew ? { animationDelay: ((i - flipFrom) * 80) + "ms" } : undefined} />);
    } else {
      slots.push(<div key={i} className="slot empty" />);
    }
  }
  return <div className="board">{slots}</div>;
}

/* face-down hole cards dealt to in-hand opponents */
function HoleBacks({ pos, deal, delay }) {
  return (
    <div className="seatbacks" style={{ position: "absolute", left: pos.x + "%", top: (pos.y - 9) + "%", transform: "translate(-50%,-50%)", zIndex: 7, display: "flex", gap: 3 }}>
      <Card back className={deal ? "deal" : ""} style={deal ? { "--dy": "-160px", "--dr": "-6deg", animationDelay: delay + "ms", width: 30, height: 42 } : { width: 30, height: 42 }} />
      <Card back className={deal ? "deal" : ""} style={deal ? { "--dy": "-160px", "--dr": "6deg", animationDelay: (delay + 60) + "ms", width: 30, height: 42 } : { width: 30, height: 42 }} />
    </div>
  );
}

function Pot({ pot, sidePots = [], chips }) {
  return (
    <div className="pot">
      <div className="potmain">
        <span className="k">Total pot</span>
        <span className="v tnum">{chips ? fmtChips(pot) : pot.toFixed(pot % 1 ? 1 : 0)}</span>
        <span className="u">{chips ? "chips" : "SOMI"}</span>
      </div>
      {sidePots.length > 0 && (
        <div className="sides">
          {sidePots.map((s, i) => (
            <span key={i} className="side">{s.label} <b className="tnum">{s.v.toFixed(0)}</b></span>
          ))}
        </div>
      )}
    </div>
  );
}

Object.assign(window, { Seat, BetChips, Board, Pot, ChipStack, TimerRing, Marker, fmtChips, HoleBacks });
