/* ShinyPoker — Cashier shell. */

const { useState: useStateCa, useRef: useRefCa, useEffect: useEffectCa } = React;

const CASH_ANNO = [
  { sel: "switcher", kind: "off", text: "Casino ⇄ Poker · shared wallet & session", at: "bottom" },
  { sel: "wallet", kind: "chain", text: "Escrow balance · read on-chain", at: "bottom" },
  { sel: "escrowbal", kind: "chain", text: "Escrow balance held by contract · on-chain", at: "right" },
  { sel: "inplaybal", kind: "chain", text: "Chips committed at tables · on-chain", at: "left" },
  { sel: "deposit", kind: "chain", text: "Deposit / Withdraw · on-chain tx (wallet signs)", at: "right" },
  { sel: "history", kind: "chain", text: "Every movement is an on-chain tx · explorer-linked", at: "left" },
  { sel: "verify", kind: "chain", text: "zkShuffle commit/reveal · re-verifiable on-chain", at: "left" },
];

const CASH_STATES = ["default", "depositing", "empty", "wrongnet", "insufficient", "failed"];

function Cashier() {
  const [anno, setAnno] = useStateCa(false);
  const [cstate, setCstate] = useStateCa("default");
  const [product, setProduct] = useStateCa("poker");
  const [showSettings, setShowSettings] = useStateCa(false);
  const [dwMode, setDwMode] = useStateCa("deposit");
  const [dir, setDir] = useStateCa(() => localStorage.getItem("sp_theme") || "b");
  const [settings, setSettings] = useStateCa({ sound: true, deck: "4", automuck: true, turbo: false, reduced: false, autoblind: true });
  const setT = (k, v) => setSettings(s => ({ ...s, [k]: v }));
  useEffectCa(() => { localStorage.setItem("sp_theme", dir); }, [dir]);

  const appRef = useRefCa(null);
  const canvasRef = useRefCa(null);
  const fieldRef = useRefCa(null);
  useEffectCa(() => {
    if (!canvasRef.current) return;
    const f = new GridField(canvasRef.current, { cell: 20, gap: 6, speed: 0.38, density: 0.5,
      accent: "#6E6EED", accent2: "#9B9BF4", maxAlpha: 0.7, minBright: 0.01, shape: "square" });
    fieldRef.current = f;
    if (!settings.reduced) f.start(); else f._draw(0);
    return () => f.destroy();
  }, [settings.reduced]);

  const wrongNet = cstate === "wrongnet";
  const insufficient = cstate === "insufficient";
  const escrow = insufficient ? 1.2 : 142.0;
  const inPlay = insufficient ? 0 : 95.5;
  const balance = wrongNet ? 0 : escrow;
  const forcedFlow = cstate === "depositing" ? "pending" : cstate === "failed" ? "failed" : null;
  const emptyHistory = cstate === "empty";

  // force deposit tab when showing a deposit flow
  useEffectCa(() => { if (cstate === "depositing" || cstate === "failed") setDwMode("deposit"); }, [cstate]);

  return (
    <div className="scaler" id="scaler">
      <div className="app cashier" ref={appRef} data-screen-label="Cashier" data-deck={settings.deck}>
        <TopBar mode="lobby" roomLabel="CASHIER" product={product} onProduct={setProduct} balance={balance} wrongNetwork={wrongNet}
          onSettings={() => setShowSettings(s => !s)} onDeposit={() => {}} />
        {showSettings && <SettingsPanel t={settings} set={setT} dir={dir} setDir={setDir} onClose={() => setShowSettings(false)} />}

        <canvas className="cashfield" ref={canvasRef} />

        <div className="cashbody">
          {/* left: balances + deposit/withdraw */}
          <div className="cashleft">
            <div>
              <div className="card-h">Your balances</div>
              <div className="balances">
                <div className="balcard escrow" data-anno="escrowbal">
                  <span className="bchain"><span className="dot" />on-chain</span>
                  <span className="blabel"><span className="ic">{CashierIcons.lock}</span>On-chain balance · escrow</span>
                  <div className="bval tnum">{escrow.toFixed(1)}<span className="u">SOMI</span></div>
                  <div className="bexp">Held in the ShinyPoker escrow contract. Yours to withdraw any time.</div>
                </div>
                <div className="balcard" data-anno="inplaybal">
                  <span className="bchain"><span className="dot" />on-chain</span>
                  <span className="blabel"><span className="ic">{CashierIcons.chips}</span>In play · at tables</span>
                  <div className="bval tnum">{inPlay.toFixed(1)}<span className="u">SOMI</span></div>
                  <div className="bexp">Chips currently committed across your seated tables &amp; tournaments.</div>
                </div>
              </div>
              <div className="baltotal" style={{ marginTop: 14 }}>
                <span className="k">Total bankroll</span>
                <span className="v tnum">{(escrow + inPlay).toFixed(1)} SOMI</span>
              </div>
            </div>

            {insufficient && (
              <div className="balbanner" style={{ margin: 0 }}>
                <div className="bi">{CashierIcons.alert}</div>
                <div><div className="bt">Low balance</div><div className="bs">Deposit more SOMI to buy into tables.</div></div>
              </div>
            )}

            <DepositWithdraw mode={dwMode} setMode={setDwMode} forcedFlow={forcedFlow} balance={escrow} escrow={escrow} />
          </div>

          {/* right: history + verify */}
          <div className="cashright">
            <TxHistory empty={emptyHistory} />
            <VerifyCenter />
          </div>
        </div>

        <AnnotationLayer enabled={anno} containerRef={appRef} defs={CASH_ANNO} />
      </div>

      {/* dev HUD */}
      <div className="hud">
        <a href="ShinyPoker Lobby.html" className="hgroup" style={{ textDecoration: "none" }}><button>← Lobby</button></a>
        <a href="ShinyPoker Table.html" className="hgroup" style={{ textDecoration: "none" }}><button>Table</button></a>
        <div className="hsep" />
        <div className="hgroup">
          {CASH_STATES.map(s => {
            const lbl = { default: "Default", depositing: "Depositing", empty: "Empty", wrongnet: "Net", insufficient: "Low$", failed: "Failed" }[s];
            return <button key={s} className={cstate === s ? "on" : ""} onClick={() => setCstate(s)}>{lbl}</button>;
          })}
        </div>
        <div className="hsep" />
        <label className={"htoggle" + (anno ? " on" : "")} onClick={() => setAnno(!anno)}>
          <span className="sw"><i /></span> Notes
        </label>
      </div>
    </div>
  );
}

function mountScaleCa() {
  const scaler = document.getElementById("scaler");
  if (!scaler) return;
  const app = scaler.querySelector(".app");
  function fit() {
    const pad = 24, topBand = 60;
    const s = Math.min((window.innerWidth - pad) / 1600, (window.innerHeight - topBand - pad) / 1000, 1);
    app.style.transform = `scale(${s})`;
    app.style.transformOrigin = "top left";
    app.style.position = "absolute";
    app.style.top = "0"; app.style.left = "0";
    scaler.style.width = (1600 * s) + "px";
    scaler.style.height = (1000 * s) + "px";
  }
  fit();
  window.addEventListener("resize", fit);
}

ReactDOM.createRoot(document.getElementById("root")).render(<Cashier />);
setTimeout(mountScaleCa, 60);
