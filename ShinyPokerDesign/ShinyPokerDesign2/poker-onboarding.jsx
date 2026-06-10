/* ShinyPoker — Onboarding / wallet-connect flow. Stepped. */

const { useState: useStateO, useEffect: useEffectO } = React;

const OBI = {
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M20 6L9 17l-5-5"/></svg>,
  arrow: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M5 12h14M13 6l6 6-6 6"/></svg>,
  lock: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>,
  zap: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M13 2L3 14h7l-1 8 10-12h-7z"/></svg>,
  shield: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5z"/><path d="M9 12l2 2 4-4"/></svg>,
  spin: <span className="sp-inline" />,
};

const STEPS = ["Connect", "Network", "Deposit", "Session", "Ready"];

function Onboarding() {
  const [step, setStep] = useStateO(0);
  const [connecting, setConnecting] = useStateO(false);
  const [wallet, setWallet] = useStateO(null);
  const [amt, setAmt] = useStateO(50);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function connect(name) {
    setWallet(name); setConnecting(true);
    if (reduced) { setConnecting(false); setStep(1); return; }
    setTimeout(() => { setConnecting(false); setStep(1); }, 1100);
  }

  return (
    <div className="onboard">
      <div className="onboard-card">
        <div className="onboard-top">
          <div className="onboard-logo" dangerouslySetInnerHTML={{ __html: window.SPLogo ? window.SPLogo(22) : "" }} />
          <div className="ob-progress">
            {STEPS.map((s, i) => (
              <div key={s} className={"pstep" + (i < step ? " done" : i === step ? " active" : "")}>
                <span className="pd">{i < step ? OBI.check : (i + 1)}</span>
                <span className="pl">{s}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="onboard-body">
          {step === 0 && (
            <React.Fragment>
              <div className="ob-eyebrow">Step 1 · Connect</div>
              <h2 className="ob-title">Connect your wallet</h2>
              <p className="ob-sub">Non-custodial — you keep your keys. We never hold your funds.</p>
              <div className="wallet-opts">
                {[["🦊", "MetaMask", "Most popular browser wallet"],
                  ["🔗", "WalletConnect", "Scan with any mobile wallet"],
                  ["✦", "Embedded wallet", "Create one in seconds, no extension"]].map(([ic, n, d]) => (
                  <button key={n} className="wallet-opt" onClick={() => connect(n)} disabled={connecting}>
                    <span className="wo-ic">{ic}</span>
                    <span className="wo-m"><span className="wn">{n}</span><span className="wd">{connecting && wallet === n ? "Connecting…" : d}</span></span>
                    <span className="wo-arrow">{connecting && wallet === n ? OBI.spin : OBI.arrow}</span>
                  </button>
                ))}
              </div>
              <div className="ob-skip">By connecting you agree to the <a href="ShinyPoker Terms.html">Terms</a> · 18+ only</div>
            </React.Fragment>
          )}

          {step === 1 && (
            <React.Fragment>
              <div className="ob-eyebrow">Step 2 · Network</div>
              <h2 className="ob-title">Switch to Somnia</h2>
              <p className="ob-sub">ShinyPoker runs on Somnia mainnet. We'll prompt your wallet to switch — one click.</p>
              <div className="netswitch">
                <div className="netcompare">
                  <div className="netbox wrong"><div className="nl">Current</div><div className="nn">Ethereum</div></div>
                  <span className="netarrow">→</span>
                  <div className="netbox right"><div className="nl">Required</div><div className="nn">Somnia Mainnet</div></div>
                </div>
              </div>
              <div className="ob-actions">
                <button className="btn ghost" onClick={() => setStep(0)}>Back</button>
                <button className="btn primary" onClick={() => setStep(2)}>Switch network</button>
              </div>
            </React.Fragment>
          )}

          {step === 2 && (
            <React.Fragment>
              <div className="ob-eyebrow">Step 3 · Deposit</div>
              <h2 className="ob-title">Make your first deposit</h2>
              <p className="ob-sub">Move SOMI into the escrow contract. Sub-cent fee, instant, withdraw any time.</p>
              <div className="amtinput" style={{ marginTop: 22 }}>
                <span className="somi"><SomiIcon /></span>
                <input type="text" value={amt} onChange={e => { const v = parseFloat(e.target.value); setAmt(isNaN(v) ? 0 : v); }} />
                <span className="cur">SOMI</span>
              </div>
              <div className="quickamts">
                {[25, 50, 100, 250].map(q => (
                  <button key={q} className={amt === q ? "on" : ""} onClick={() => setAmt(q)}>{q}</button>
                ))}
              </div>
              <div className="gasrow"><span className="gk">{OBI.zap} Network fee (Somnia)</span><span className="gv">~<b>0.0006</b> SOMI</span></div>
              <div className="ob-actions">
                <button className="btn ghost" onClick={() => setStep(1)}>Back</button>
                <button className="btn primary" onClick={() => setStep(3)}>Deposit {amt} SOMI</button>
              </div>
              <div className="ob-skip"><a href="#" onClick={(e) => { e.preventDefault(); setStep(3); }}>Skip — deposit later</a></div>
            </React.Fragment>
          )}

          {step === 3 && (
            <React.Fragment>
              <div className="ob-eyebrow">Step 4 · Session key</div>
              <h2 className="ob-title">Play without popups</h2>
              <p className="ob-sub">Authorize a capped session key once. Then fold, call and raise instantly — no wallet prompt per hand.</p>
              <div className="sess-explain">
                <div className="sess-feat"><span className="sf-ic">{OBI.zap}</span><div><div className="sf-t">Web2-fast actions</div><div className="sf-d">Your moves are signed locally and settle on-chain in the background.</div></div></div>
                <div className="sess-feat"><span className="sf-ic">{OBI.lock}</span><div><div className="sf-t">Capped &amp; revocable</div><div className="sf-d">Scoped to a spend cap you set. Revoke any time from Settings.</div></div></div>
                <div className="cap-row"><span className="cl">Session spend cap</span><span className="cv tnum">50 SOMI</span></div>
              </div>
              <div className="ob-actions">
                <button className="btn ghost" onClick={() => setStep(2)}>Back</button>
                <button className="btn primary" onClick={() => setStep(4)}>Grant session key</button>
              </div>
            </React.Fragment>
          )}

          {step === 4 && (
            <React.Fragment>
              <div className="ready-check">{OBI.check}</div>
              <h2 className="ob-title" style={{ marginTop: 18 }}>You're ready to play</h2>
              <p className="ob-sub">Everything's set. Your funds are in escrow and your table session is live.</p>
              <div className="ready-summary">
                <div className="rsrow"><span className="rsk">Wallet</span><span className="rsv">{wallet || "MetaMask"} <span className="ok">{OBI.check}</span></span></div>
                <div className="rsrow"><span className="rsk">Network</span><span className="rsv">Somnia Mainnet <span className="ok">{OBI.check}</span></span></div>
                <div className="rsrow"><span className="rsk">Escrow balance</span><span className="rsv tnum">{amt.toFixed(1)} SOMI</span></div>
                <div className="rsrow"><span className="rsk">Session key</span><span className="rsv">cap 50 SOMI · active <span className="ok">{OBI.check}</span></span></div>
              </div>
              <div className="ob-actions">
                <a className="btn primary lg" href="ShinyPoker Lobby.html" style={{ flex: 1 }}>Enter the lobby {OBI.arrow}</a>
              </div>
            </React.Fragment>
          )}
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<Onboarding />);
