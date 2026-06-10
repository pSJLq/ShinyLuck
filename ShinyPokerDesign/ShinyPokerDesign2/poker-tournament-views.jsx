/* ShinyPoker — Tournament Table HUD. Reuses table components; adds tournament overlay. */

const { useState: useStateT, useRef: useRefT, useEffect: useEffectT } = React;

const TI = {
  trophy: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M6 4h12v3a6 6 0 0 1-12 0z"/><path d="M6 5H3v2a3 3 0 0 0 3 3M18 5h3v2a3 3 0 0 1-3 3M9 16h6M10 16l-.5 4M14 16l.5 4M8 20h8"/></svg>,
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M20 6L9 17l-5-5"/></svg>,
  users: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 6a3 3 0 0 1 0 6M18 13.5a5.5 5.5 0 0 1 3.5 5.5"/></svg>,
  clock: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>,
};

/* tournament meta */
const TRN = {
  name: "Somnia Sunday Major", id: "t1",
  level: 12, sb: 600, bb: 1200, ante: 150, nextSec: 272,
  playersLeft: 213, playersTotal: 478,
  rank: 47, chips: 38500, avgStack: 52100, bb: 32,
  prizePool: 50000, paid: 27, escrow: "0x9F3a…Tourney50K",
  bountyPer: 5, kos: 3,
  ladder: [
    ["1st", 9250], ["2nd", 6800], ["3rd", 5400], ["4-6", 3100], ["7-12", 1800],
    ["13-18", 1300], ["19-27", 1050], ["ITM", "in the money"], ["28-36", 720], ["37-54", 540],
  ],
};

/* base 6-max tournament table (chip stacks) */
const TRN_SEATS = {
  0: { chips: 38500, bb: 32, status: "to act", bet: 0, bounty: 3 },
  1: { chips: 88200, bb: 73, status: "folded", folded: true },
  2: { chips: 21000, bb: 17, status: "all-in 21k", allin: true, bet: 21000 },
  3: { chips: 54100, bb: 45, status: "call 1.2k", bet: 1200, name: "degenqueen.somi", bounty: 5 },
  4: { chips: 15400, bb: 12, status: "folded", folded: true },
  5: { chips: 132000, bb: 110, status: "folded", folded: true, name: "chipleader.somi" },
};

const TRN_PLAYERS = [
  { id: 0, name: "you.somi", av: "Y", hero: true },
  { id: 1, name: "nakamoto.somi", av: "N" },
  { id: 2, name: "0x7f3a…b21d", av: "7" },
  { id: 3, name: "degenqueen.somi", av: "D" },
  { id: 4, name: "0x9c4e…01af", av: "9" },
  { id: 5, name: "chipleader.somi", av: "C" },
];

const TRN_STATES = ["running", "bubble", "break", "final", "bust"];

function fmtClock(s) { const m = Math.floor(s / 60); return m + ":" + String(Math.floor(s % 60)).padStart(2, "0"); }
function fmtK(n) { return n >= 1000 ? (n / 1000).toFixed(n % 1000 ? 1 : 0) + "k" : String(n); }

/* ---------------- top strip ---------------- */
function TrnTopStrip({ now, state }) {
  const left = state === "final" ? 6 : state === "bubble" ? 28 : TRN.playersLeft;
  const nextSec = Math.max(0, TRN.nextSec - (now % TRN.nextSec || 0));
  return (
    <div className="trnstrip" data-anno="trnstrip">
      <div className="tcell tname">
        <span className="nm">{TI.trophy && ""}{TRN.name}</span>
        <span className="sub">{state === "final" ? "Final Table" : "NLHE · " + fmtK(TRN.prizePool) + " GTD"}</span>
      </div>
      <div className="tcell">
        <span className="k">Level</span>
        <span className="v">{state === "final" ? 24 : TRN.level}</span>
      </div>
      <div className="tcell">
        <span className="k">Blinds · Ante</span>
        <span className="v">{TRN.sb}/{TRN.bb} <span className="u">· {TRN.ante}</span></span>
      </div>
      <div className="tcell">
        <span className="k">Next level</span>
        <span className="v gold">{fmtClock(state === "break" ? 180 : nextSec)}</span>
      </div>
      <div className="tcell">
        <span className="k">{TI.users && ""}Players left</span>
        <span className="v">{left}<span className="u">/ {TRN.playersTotal}</span></span>
      </div>
      <div className="tcell">
        <span className="k">Your rank</span>
        <span className="v acc">#{state === "final" ? 4 : TRN.rank}</span>
      </div>
      <div className="tcell">
        <span className="k">Your stack</span>
        <span className="v">{fmtK(TRN.chips)} <span className="u">· {TRN.bb}bb</span></span>
      </div>
      <div className="spacer tcell" />
      <button className="rebuy bounty" data-anno="bounty">◆ {TRN.kos} KOs · {TRN.kos * TRN.bountyPer} SOMI</button>
      <button className="rebuy" data-anno="rebuy">+ Re-entry · 21.5 SOMI</button>
    </div>
  );
}

/* ---------------- rank chip (left) ---------------- */
function RankChip({ state }) {
  const itm = state === "final" || state === "itm";
  const bubble = state === "bubble";
  return (
    <div className="rankchip" data-anno="rank">
      <div className="rh">Your position</div>
      <div className="rankbig tnum">#{state === "final" ? 4 : TRN.rank}<span className="of"> / {state === "final" ? 6 : TRN.playersLeft}</span></div>
      <div className="rrow"><span className="rk">Chips</span><span className="rv tnum">{fmtK(TRN.chips)}</span></div>
      <div className="rrow"><span className="rk">vs avg ({fmtK(TRN.avgStack)})</span><span className="rv up tnum">{TRN.bb}bb</span></div>
      {itm
        ? <div className="itmbadge">{TI.check} In the money ✓</div>
        : bubble
          ? <div className="itmbadge bubblebadge">{TI.clock} On the bubble · {TRN.paid + 1} left</div>
          : <div className="rrow"><span className="rk">To the money</span><span className="rv tnum">{TRN.playersLeft - TRN.paid} spots</span></div>}
    </div>
  );
}

/* ---------------- prize ladder rail (right) ---------------- */
function PrizeRail({ state }) {
  return (
    <div className="prizerail" data-anno="prize">
      <div className="ph"><span className="t">Prize ladder</span><span className="pp tnum">{fmtK(TRN.prizePool)} SOMI</span></div>
      <div className="plist">
        {TRN.ladder.map((p, i) => {
          if (p[1] === "in the money") {
            return <div key={i} className={"pr " + (state === "bubble" ? "bubble-line" : "itm-line")}>
              <span className="lbl">{state === "bubble" ? "▲ bubble · " + TRN.paid + " paid" : "▲ in the money · top " + TRN.paid}</span></div>;
          }
          const isYou = (state === "final" && p[0] === "4-6") || (state !== "final" && p[0] === "37-54");
          return (
            <div key={i} className={"pr" + (isYou ? " you" : "")}>
              <span className="pos">{p[0]}</span>
              <span className="amt tnum">{fmtK(p[1])}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- banners ---------------- */
function BreakBanner() {
  return (
    <div className="breakbanner">
      <div className="bk">Tournament break</div>
      <div className="bt tnum">2:58</div>
      <div className="bs">Grab a coffee — play resumes at Level 13.</div>
      <div className="nextlvl">
        <div className="nl"><span className="k">Next blinds</span><span className="v tnum">800 / 1600</span></div>
        <div className="nl"><span className="k">Next ante</span><span className="v tnum">200</span></div>
        <div className="nl"><span className="k">Players left</span><span className="v tnum">213</span></div>
      </div>
    </div>
  );
}

function BubbleStrip() {
  return (
    <div className="bubblestrip">
      <span className="pulse" />
      Hand-for-hand · <b>bubble</b> — {TRN.paid + 1} left, {TRN.paid} paid. Next bust-out is the bubble.
    </div>
  );
}

function FinalTableBadge() { return <div className="finaltable-badge">★ Final Table · 6 left</div>; }

function EliminationScreen() {
  return (
    <div className="elimoverlay">
      <div className="elimcard">
        <div className="etop">
          <div className="efin">You finished</div>
          <div className="epos tnum">47<span className="nth">th</span></div>
          <div className="ewon tnum">+ 18.5 SOMI won</div>
        </div>
        <div className="ebody">
          <div className="erow"><span className="k">Place prize (37–54)</span><span className="v win tnum">+ 18.5 SOMI</span></div>
          <div className="erow"><span className="k">Bounties collected (3 KOs)</span><span className="v gold tnum">+ 15.0 SOMI</span></div>
          <div className="erow"><span className="k">Total cash</span><span className="v win tnum">+ 33.5 SOMI</span></div>
          <div className="paidchip">{TI.check} Auto-paid to your escrow balance on-chain · 0x4f…a91 ↗</div>
        </div>
        <div className="efoot">
          <button className="pill">View hand history</button>
          <button className="pill primary">Back to lobby</button>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { TRN, TRN_SEATS, TRN_PLAYERS, TRN_STATES, TrnTopStrip, RankChip, PrizeRail, BreakBanner, BubbleStrip, FinalTableBadge, EliminationScreen, TournIcons: TI });
