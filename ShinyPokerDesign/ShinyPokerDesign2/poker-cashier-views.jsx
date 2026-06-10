/* ShinyPoker — Cashier / Wallet. Shares TopBar, SettingsPanel, AnnotationLayer, GridField. */

const { useState: useStateC, useRef: useRefC, useEffect: useEffectC } = React;

const CI = {
  download: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 3v12M7 11l5 5 5-5M5 21h14"/></svg>,
  upload: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 21V9M7 13l5-5 5 5M5 3h14"/></svg>,
  lock: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>,
  chips: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/></svg>,
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M20 6L9 17l-5-5"/></svg>,
  shield: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5z"/><path d="M9 12l2 2 4-4"/></svg>,
  gas: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="4" y="4" width="9" height="16" rx="1.5"/><path d="M4 10h9M16 8l3 3v6a2 2 0 0 1-4 0V7"/></svg>,
  x: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>,
  alert: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17h.01"/></svg>,
  clock: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>,
};

const TX_HISTORY = [
  { type: "winnings", amt: +49.0, hash: "0x8af3…d21c", time: "2m ago", status: "confirmed" },
  { type: "rake", amt: -0.2, hash: "0x71be…04a9", time: "2m ago", status: "confirmed" },
  { type: "buyin", amt: -100.0, hash: "0x4c1e…b730", time: "18m ago", status: "confirmed" },
  { type: "deposit", amt: +200.0, hash: "0x9f3a…1e7b", time: "1h ago", status: "confirmed" },
  { type: "bounty", amt: +5.0, hash: "0x2dd4…aa31", time: "3h ago", status: "confirmed" },
  { type: "cashout", amt: +84.5, hash: "0xe9aa…77cd", time: "5h ago", status: "confirmed" },
  { type: "buyin", amt: -50.0, hash: "0x55cc…9012", time: "6h ago", status: "confirmed" },
  { type: "withdraw", amt: -120.0, hash: "0xa77b…3f5e", time: "yesterday", status: "confirmed" },
  { type: "winnings", amt: +18.4, hash: "0x12dd…6b8f", time: "yesterday", status: "confirmed" },
  { type: "deposit", amt: +150.0, hash: "0x6b8f…cc1a", time: "2d ago", status: "confirmed" },
];

const TX_TYPES = ["all", "deposit", "withdraw", "buyin", "cashout", "winnings", "rake", "bounty"];
const TYPE_LABEL = { buyin: "buy-in", cashout: "cash-out" };

function fmtAmt(n) { return (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(Math.abs(n) % 1 ? 1 : 0); }

/* ---------------- Deposit / Withdraw panel ---------------- */
function DepositWithdraw({ mode, setMode, forcedFlow, balance, escrow }) {
  const [amt, setAmt] = useStateC(mode === "deposit" ? 50 : 20);
  const [quick, setQuick] = useStateC(null);
  const [flow, setFlow] = useStateC("idle"); // idle | sign | pending | confirmed | failed
  const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffectC(() => { if (forcedFlow) setFlow(forcedFlow); }, [forcedFlow]);

  const run = () => {
    if (flow === "sign" || flow === "pending") return;
    setFlow("sign");
    if (reduced) { setFlow("confirmed"); return; }
    setTimeout(() => setFlow("pending"), 850);
    setTimeout(() => setFlow("confirmed"), 2400);
  };
  const reset = () => setFlow("idle");

  const quicks = mode === "deposit" ? [10, 25, 50, 100] : [10, 25, 50, "Max"];
  const isDep = mode === "deposit";
  const stepState = (i) => {
    const order = { idle: -1, sign: 0, pending: 1, confirmed: 2, failed: 0 };
    const cur = order[flow];
    if (flow === "failed") return i === 0 ? "failed" : "";
    if (flow === "confirmed") return "done";
    if (i < cur) return "done";
    if (i === cur) return "active";
    return "";
  };

  return (
    <div className="panel" data-anno="deposit">
      <div className="dwtabs">
        <button className={isDep ? "on" : ""} onClick={() => { setMode("deposit"); reset(); }}>{CI.download} Deposit</button>
        <button className={!isDep ? "on withdraw" : ""} onClick={() => { setMode("withdraw"); reset(); }}>{CI.upload} Withdraw</button>
      </div>

      <div className="flowdir">
        {isDep
          ? <React.Fragment><span className="node">Wallet</span><span className="arrow">→</span><span className="node esc">{CI.lock} Escrow</span></React.Fragment>
          : <React.Fragment><span className="node esc">{CI.lock} Escrow</span><span className="arrow">→</span><span className="node">Wallet</span></React.Fragment>}
      </div>

      <div className="amtinput">
        <span className="somi"><SomiIcon /></span>
        <input type="text" value={amt} onChange={e => { const v = parseFloat(e.target.value); setAmt(isNaN(v) ? 0 : v); setQuick(null); }} />
        <span className="cur">SOMI</span>
      </div>
      <div className="quickamts">
        {quicks.map(q => (
          <button key={q} className={quick === q ? "on" : ""} onClick={() => {
            setQuick(q); setAmt(q === "Max" ? (isDep ? balance : escrow) : q);
          }}>{q === "Max" ? "Max" : q}</button>
        ))}
      </div>

      <div className="gasrow">
        <span className="gk">{CI.gas} Network fee (Somnia)</span>
        <span className="gv">~<b>0.0006</b> SOMI · sub-cent</span>
      </div>
      {!isDep && (
        <div className="gasrow">
          <span className="gk">{CI.clock} Withdrawal delay</span>
          <span className="gv"><b style={{ color: "var(--win)" }}>Instant</b> · no lockup</span>
        </div>
      )}

      {flow === "idle" ? (
        <button className={"dwbtn" + (isDep ? "" : " withdraw")} onClick={run}>
          {isDep ? `Deposit ${amt} SOMI` : `Withdraw ${amt} SOMI`}
          <small>{isDep ? "wallet → escrow · one on-chain signature" : "escrow → wallet · instant on-chain settlement"}</small>
        </button>
      ) : (
        <React.Fragment>
          <div className="stepper">
            {[["Sign", "wallet"], ["Pending", "mempool"], ["Confirmed", "on-chain"]].map(([l, s], i) => (
              <div key={i} className={"step " + stepState(i)}>
                <span className="dot">
                  {stepState(i) === "done" ? CI.check : stepState(i) === "active" ? <span className="spin" /> : stepState(i) === "failed" ? CI.x : (i + 1)}
                </span>
                <span className="lbl">{l}</span>
                <span className="sub">{s}</span>
              </div>
            ))}
          </div>
          <TxStatus flow={flow} amt={amt} isDep={isDep} onReset={reset} onRetry={run} />
        </React.Fragment>
      )}
    </div>
  );
}

function TxStatus({ flow, amt, isDep, onReset, onRetry }) {
  if (flow === "sign") return (
    <div className="txstatusbox pending">
      <div className="ti" style={{ background: "var(--accent-12)", color: "var(--accent-soft)" }}>{CI.lock}</div>
      <div style={{ flex: 1 }}><div className="tt">Awaiting signature…</div><div className="ts">Approve the {isDep ? "deposit" : "withdrawal"} of {amt} SOMI in your wallet</div></div>
    </div>
  );
  if (flow === "pending") return (
    <div className="txstatusbox pending">
      <div className="ti" style={{ background: "var(--accent-12)" }}><span className="step active"><span className="dot" style={{ border: 0, background: "transparent" }}><span className="spin" /></span></span></div>
      <div style={{ flex: 1 }}><div className="tt">Broadcasting to Somnia…</div><div className="ts">Sub-second finality · <a href="#">0x4f…a91 ↗</a></div></div>
    </div>
  );
  if (flow === "confirmed") return (
    <div className="txstatusbox confirmed">
      <div className="ti" style={{ background: "rgba(43,212,128,0.14)", color: "var(--win)" }}>{CI.check}</div>
      <div style={{ flex: 1 }}><div className="tt">{isDep ? "Deposit" : "Withdrawal"} confirmed · {amt} SOMI</div><div className="ts">Settled on-chain · <a href="#">0x4f…a91 ↗</a></div></div>
      <button className="retry" onClick={onReset}>Done</button>
    </div>
  );
  if (flow === "failed") return (
    <div className="txstatusbox failed">
      <div className="ti" style={{ background: "rgba(229,86,42,0.14)", color: "var(--danger-soft)" }}>{CI.alert}</div>
      <div style={{ flex: 1 }}><div className="tt">Transaction failed</div><div className="ts">Reverted · insufficient gas or rejected. No funds moved.</div></div>
      <button className="retry" onClick={onRetry}>Retry</button>
    </div>
  );
  return null;
}

/* ---------------- Transaction history ---------------- */
function TxHistory({ empty }) {
  const [filter, setFilter] = useStateC("all");
  const rows = empty ? [] : TX_HISTORY.filter(t => filter === "all" || t.type === filter);
  return (
    <div className="panel" data-anno="history" style={{ padding: "18px 20px" }}>
      <div className="card-h">On-chain transaction history<span className="spacerflex" /></div>
      <div className="txfilters">
        {TX_TYPES.map(t => (
          <button key={t} className={filter === t ? "on" : ""} onClick={() => setFilter(t)}>{TYPE_LABEL[t] || t}</button>
        ))}
      </div>
      {rows.length === 0 ? (
        <div className="emptystate" style={{ padding: "48px 20px" }}>
          <div className="eicon">{CI.chips}</div>
          <div className="et">{empty ? "No transactions yet" : "No " + filter + " transactions"}</div>
          <div className="es">{empty ? "Your on-chain deposits, buy-ins, winnings and withdrawals will appear here once you start playing." : "Try a different filter to see your history."}</div>
        </div>
      ) : (
        <div className="txtable">
          <div className="txhd">
            <span className="h">Type</span><span className="h r">Amount</span><span className="h">Tx hash</span><span className="h">Time</span><span className="h r">Status</span>
          </div>
          {rows.map((t, i) => (
            <div key={i} className="txrow">
              <span className={"typechip " + t.type}><span className="td" />{TYPE_LABEL[t.type] || t.type}</span>
              <span className={"txamt " + (t.amt >= 0 ? "pos" : "neg")}>{fmtAmt(t.amt)} <span style={{ fontSize: 9, color: "var(--muted)" }}>SOMI</span></span>
              <a className="txhash" href="#">{t.hash} ↗</a>
              <span className="txtime">{t.time}</span>
              <span className={"txstat " + t.status}><span className="d" />{t.status}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- Provably-fair verification center ---------------- */
function VerifyCenter() {
  const [hand, setHand] = useStateC("4821");
  const [verified, setVerified] = useStateC(true);
  return (
    <div className="verifycard" data-anno="verify">
      <div className="verifytop">
        <div className="vi">{CI.shield}</div>
        <div style={{ flex: 1 }}>
          <div className="vt">Provably-fair verification center</div>
          <div className="vs">Re-verify any past hand's zkShuffle commitment &amp; reveal — same proof the table shows live.</div>
        </div>
      </div>
      <div className="verifybody">
        <div className="handpick">
          <div className="hpinput"><span className="hh">HAND #</span><input value={hand} onChange={e => { setHand(e.target.value); setVerified(false); }} /></div>
          <button className="vbtn" onClick={() => setVerified(true)}>Verify hand</button>
        </div>
        {verified && (
          <div className="verifyresult">
            <div className="vrow"><span className="vk">Pre-hand deck commitment</span>
              <span className="vv"><span className="lab">commit</span> 0x8af3c1d9e7b2…d21c4f90 · sealed before deal</span></div>
            <div className="vrow"><span className="vk">Revealed shuffle seed (post-hand)</span>
              <span className="vv"><span className="lab">seed</span> 0x4f1aa9c0…77cd31e2 · matches commitment</span></div>
            <div className="vrow"><span className="vk">Result</span>
              <span className="vv ok">{CI.check} Verified — shuffle was provably fair · no operator saw any hole cards</span></div>
            <div className="steplist">
              <div className="sl"><span className="n">1</span>Players jointly shuffled the deck with zero-knowledge proofs before the deal.</div>
              <div className="sl"><span className="n">2</span>The sealed commitment was published on-chain pre-deal — no one could alter the deck.</div>
              <div className="sl"><span className="n">3</span>After the hand, the seed was revealed and re-hashes to the same commitment. ✓</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { DepositWithdraw, TxHistory, VerifyCenter, CashierIcons: CI, TX_HISTORY });
