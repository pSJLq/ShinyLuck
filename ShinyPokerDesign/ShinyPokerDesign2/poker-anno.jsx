/* Annotation overlay + legend + review HUD. Exports to window. */

/* Annotation definitions: anchor to [data-anno] elements, classify on-chain layer */
const ANNOTATIONS = [
  { sel: "switcher", kind: "off", text: "Product switch · off-chain (shared session carries over)", at: "bottom" },
  { sel: "wallet", kind: "chain", text: "Balance read from escrow contract · on-chain", at: "bottom" },
  { sel: "session", kind: "session", text: "Session key — signs actions locally, no popup", at: "bottom" },
  { sel: "blinds", kind: "chain", text: "Blinds & hand state · on-chain", at: "bottom" },
  { sel: "actions", kind: "session", text: "Fold/Call/Raise → session-key tx (no wallet popup)", at: "top" },
  { sel: "bet", kind: "off", text: "Bet sizing UI · off-chain until you confirm", at: "top" },
  { sel: "pf", kind: "chain", text: "zkShuffle commit/reveal · verifiable on-chain", at: "left" },
  { sel: "tx", kind: "chain", text: "Pot settlement broadcast · on-chain (background)", at: "left" },
];

function AnnotationLayer({ enabled, container, containerRef, defs }) {
  const [pins, setPins] = React.useState([]);
  const list = defs || ANNOTATIONS;
  React.useEffect(() => {
    if (!enabled) { setPins([]); return; }
    let raf, stop = false;
    const getEl = () => (containerRef && containerRef.current) || container;
    const compute = () => {
      const cont = getEl();
      if (!cont) return false;
      const box = cont.getBoundingClientRect();
      if (!box.width || !box.height) return false;
      const out = [];
      list.forEach(a => {
        const el = cont.querySelector(`[data-anno="${a.sel}"]`);
        if (!el) return;
        const r = el.getBoundingClientRect();
        out.push({
          ...a,
          left: ((r.left - box.left) + r.width / 2) / box.width * 100,
          top: a.at === "top" ? (r.top - box.top) / box.height * 100
             : a.at === "bottom" ? (r.bottom - box.top) / box.height * 100
             : (r.top - box.top + r.height / 2) / box.height * 100,
          leftEdge: (r.left - box.left) / box.width * 100,
          rightEdge: (r.right - box.left) / box.width * 100,
        });
      });
      setPins(out);
      return true;
    };
    const tick = () => { if (stop) return; if (!compute()) raf = requestAnimationFrame(tick); };
    tick();
    const id = setInterval(compute, 500);
    return () => { stop = true; if (raf) cancelAnimationFrame(raf); clearInterval(id); };
  }, [enabled, list]);

  if (!enabled) return null;
  return (
    <div className="annoLayer">
      {pins.map((p, i) => {
        let style, tr;
        if (p.at === "right") { style = { left: p.rightEdge + "%", top: p.top + "%" }; tr = "translate(4%,-50%)"; }
        else if (p.at === "left") { style = { left: p.leftEdge + "%", top: p.top + "%" }; tr = "translate(-104%,-50%)"; }
        else { style = { left: p.left + "%", top: p.top + "%" };
          tr = p.at === "top" ? "translate(-50%,-130%)" : p.at === "bottom" ? "translate(-50%,30%)" : "translate(-50%,-50%)"; }
        return (
          <div key={i} className={"anno " + p.kind} style={{ ...style, transform: tr }}>
            <span className="pin"><span className="d" />{p.text}</span>
          </div>
        );
      })}
      <div className="annoLegend">
        <div className="lh">On-chain transparency</div>
        <div className="lr"><span className="sw chain" /> On-chain action (tx / state)</div>
        <div className="lr"><span className="sw session" /> Session-key action (no popup)</div>
        <div className="lr"><span className="sw off" /> Off-chain UI</div>
      </div>
    </div>
  );
}

/* Review HUD — meta controls outside the product (not part of ShinyPoker UI) */
function ReviewHUD({ dir, setDir, state, setState, anno, setAnno, deck, setDeck, onDeal, dealing, turbo, setTurbo }) {
  return (
    <div className="hud">
      <a href="ShinyPoker Lobby.html" className="hgroup" style={{ textDecoration: "none" }}><button>Lobby</button></a>
      <a href="ShinyPoker Cashier.html" className="hgroup" style={{ textDecoration: "none" }}><button>Cashier</button></a>
      <div className="hsep" />
      <div className="hgroup">
        {[["a", "Term"], ["b", "Prem"], ["c", "Grid"]].map(([k, l]) => (
          <button key={k} className={dir === k ? "on" : ""} onClick={() => setDir(k)}>{l}</button>
        ))}
      </div>
      <div className="hsep" />
      <div className="hgroup">
        {STATE_ORDER.map(s => {
          const lbl = { yourturn: "Turn", allin: "All-in", win: "Win", lose: "Lose", disconnected: "Disc." }[s];
          return <button key={s} className={state === s ? "on" : ""} onClick={() => setState(s)}>{lbl}</button>;
        })}
      </div>
      <div className="hsep" />
      {onDeal && (
        <button className={"dealbtn" + (dealing ? " busy" : "")} onClick={onDeal} title="Replay deal animation">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v4h4"/></svg>
          Deal
        </button>
      )}
      {setTurbo && (
        <label className={"htoggle" + (turbo ? " on" : "")} onClick={() => setTurbo(!turbo)}>
          <span className="sw"><i /></span> Turbo
        </label>
      )}
      <div className="hsep" />
      <label className={"htoggle" + (anno ? " on" : "")} onClick={() => setAnno(!anno)}>
        <span className="sw"><i /></span> Notes
      </label>
      <label className={"htoggle" + (deck === "4" ? " on" : "")} onClick={() => setDeck(deck === "4" ? "2" : "4")}>
        <span className="sw"><i /></span> 4-clr
      </label>
    </div>
  );
}

Object.assign(window, { AnnotationLayer, ReviewHUD, ANNOTATIONS });
