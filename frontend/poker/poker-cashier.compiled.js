/* AUTO-GENERATED from poker-cashier.jsx by scripts/build-poker-jsx.js — do NOT edit. */
/* ShinyPoker · shared Cashier modal (+ Portal/Hint helpers). Loaded by the
   lobby AND the tournament page (babel scripts run in isolated scopes, so
   cross-page components must be exported through window · same pattern as
   poker-cards.jsx). Keep this file self-contained. */
// `var`, not `const`: the cashier and the page app both bind these and now
// share one global script scope — a second `const` would kill the page.
var {
  useState: uS,
  useEffect: uE
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

/* Cashier: wallet↔poker balance, nickname, cash-out, owner fee withdrawals. */
function CashierModal({
  close,
  addr,
  bal,
  refresh
}) {
  const sym = SP.NETWORK.currency.symbol;
  const [tab, setTab] = uS("deposit");
  const [amt, setAmt] = uS("");
  const [wbal, setWbal] = uS(0);
  const [handle, setHandle] = uS("");
  const [nick, setNick] = uS("");
  const [av, setAv] = uS(0); // my on-chain preset avatar id
  const [avImg, setAvImg] = uS(null); // my uploaded on-chain image (data URI)
  const [pendAv, setPendAv] = uS(null); // preset picked before the first nickname save
  const [upl, setUpl] = uS(null); // { bytes, dataUri } compressed, ready to upload
  const [rake, setRake] = uS(0n);
  const [trnFees, setTrnFees] = uS(0n);
  const [isOwner, setIsOwner] = uS(false);
  const [busy, setBusy] = uS(false);
  const [msg, setMsg] = uS(null);
  const [sendTo, setSendTo] = uS("");
  const [sendAmt, setSendAmt] = uS("");
  const flash = m => {
    setMsg(m);
    setTimeout(() => setMsg(null), 4000);
  };
  async function refreshAll() {
    try {
      setWbal(Number(SP.fmt(await SP.sdk.walletBalance(), 4)));
    } catch {}
    try {
      const m = await SP.sdk.profilesFor([addr]);
      const p = m[addr.toLowerCase()];
      setHandle(p.handle);
      setAv(p.avatar);
      setAvImg(p.img);
    } catch {}
    try {
      const o = await SP.sdk.roomOwner();
      const own = !!addr && o.toLowerCase() === addr.toLowerCase();
      setIsOwner(own);
      if (own) {
        setRake(await SP.sdk.rakeCollected());
        setTrnFees(await SP.sdk.trnFeesCollected());
      }
    } catch {}
    if (refresh) refresh();
  }
  uE(() => {
    refreshAll();
  }, []);
  async function run(label, fn) {
    // the clicked button owns the spinner until this settles
    const done = SPPress.claim();
    setBusy(true);
    try {
      await fn();
      flash(label + " ✓");
      setAmt("");
      setNick("");
      await refreshAll();
    } catch (e) {
      flash(label + " ✗ " + (e?.shortMessage || e?.reason || e?.message || "").replace(/execution reverted:?/i, "").slice(0, 70));
      console.error(e);
    } finally {
      setBusy(false);
      done();
    }
  }
  // The casino's feeds (Latest/Biggest wins) cache profiles for 30 min in
  // localStorage · this cashier lives in an iframe, so a storage write is how
  // an avatar or nickname changed here reaches them without a reload.
  const bumpProfile = () => {
    try {
      localStorage.setItem("sl.profiles.bump", String(addr).toLowerCase() + ":" + Date.now());
    } catch (_) {}
  };
  const stop = e => e.stopPropagation();
  const amtOk = parseFloat(amt) > 0;
  const nickOk = nick.trim().length >= 3;
  return /*#__PURE__*/React.createElement(Portal, null, /*#__PURE__*/React.createElement("div", {
    className: "lt-modalbg",
    onClick: close
  }, /*#__PURE__*/React.createElement("div", {
    className: "lt-modal",
    onClick: stop,
    style: {
      width: "min(430px,94vw)",
      maxHeight: "92vh",
      overflowY: "auto"
    }
  }, /*#__PURE__*/React.createElement("h3", null, "Cashier"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 24,
      margin: "2px 0 10px"
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--label)",
      fontSize: 10,
      textTransform: "uppercase",
      letterSpacing: ".08em",
      color: "var(--muted)"
    }
  }, "Wallet"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--mono)",
      fontSize: 18,
      color: "var(--text)"
    }
  }, wbal, " ", sym)), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--label)",
      fontSize: 10,
      textTransform: "uppercase",
      letterSpacing: ".08em",
      color: "var(--muted)"
    }
  }, "Poker balance"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--mono)",
      fontSize: 18,
      color: "var(--accent-soft)"
    }
  }, Number(bal).toFixed(4), " ", sym))), /*#__PURE__*/React.createElement("p", {
    className: "note",
    style: {
      marginTop: -4,
      marginBottom: 10
    }
  }, "Wallet = your on-chain ", sym, ". Poker balance = ", sym, " you moved into the game to buy in."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      marginBottom: 12,
      padding: "8px 10px",
      borderRadius: 8,
      background: "var(--accent-08, rgba(217,171,74,.08))"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--label)",
      fontSize: 10,
      textTransform: "uppercase",
      letterSpacing: ".08em",
      color: "var(--muted)",
      whiteSpace: "nowrap"
    }
  }, "Your address"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--mono)",
      fontSize: 11,
      color: "var(--text)",
      flex: 1,
      overflow: "hidden",
      textOverflow: "ellipsis"
    }
  }, addr), /*#__PURE__*/React.createElement("button", {
    className: "btn-sm",
    onClick: () => {
      navigator.clipboard?.writeText(addr);
      flash("Address copied · send STT here to top up");
    }
  }, "Copy")), /*#__PURE__*/React.createElement("label", null, "Nickname", handle ? /*#__PURE__*/React.createElement(React.Fragment, null, " \xB7 current ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: "var(--text)"
    }
  }, handle)) : ""), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: nick,
    onChange: e => setNick(e.target.value),
    placeholder: handle || "Set a nickname (3–20)",
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("button", {
    className: "btn-sm join",
    disabled: busy || !nickOk,
    onClick: () => run(handle ? "Nickname changed" : "Nickname set", async () => {
      await SP.sdk.setProfile(nick.trim(), pendAv != null ? pendAv : av);
      if (pendAv != null) {
        setAv(pendAv);
        setPendAv(null);
      }
      bumpProfile();
    })
  }, handle ? "Change" : "Set")), /*#__PURE__*/React.createElement("label", null, "Avatar ", /*#__PURE__*/React.createElement(Hint, {
    text: "Lives fully ON-CHAIN \xB7 no server. Upload your own picture (compressed to ~96px in your browser, a few KB of gas) or pick a preset. Everyone at the table sees it."
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 12,
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement(AvatarIcon, {
    av: pendAv != null ? pendAv : av,
    img: upl ? upl.dataUri : avImg,
    name: handle || addr,
    size: 56,
    style: {
      borderRadius: 12
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("label", {
    className: "btn-sm",
    style: {
      cursor: "pointer",
      margin: 0
    }
  }, "\uD83D\uDCF7 Choose photo\u2026", /*#__PURE__*/React.createElement("input", {
    type: "file",
    accept: "image/*",
    style: {
      display: "none"
    },
    onChange: async e => {
      const f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!f) return;
      try {
        setUpl(await SPCompressAvatar(f));
      } catch (err) {
        flash(err.message);
      }
    }
  })), upl && /*#__PURE__*/React.createElement("button", {
    className: "btn-sm join",
    disabled: busy,
    onClick: () => run("Avatar uploaded on-chain", async () => {
      await SP.sdk.setAvatarImage(upl.bytes);
      setAvImg(upl.dataUri);
      setUpl(null);
      bumpProfile();
    })
  }, "Upload \xB7 ", (upl.bytes.length / 1024).toFixed(1), " KB"), avImg && !upl && /*#__PURE__*/React.createElement("button", {
    className: "btn-sm",
    disabled: busy,
    onClick: () => run("Photo removed", async () => {
      await SP.sdk.clearAvatarImage();
      setAvImg(null);
      bumpProfile();
    })
  }, "Remove photo")), /*#__PURE__*/React.createElement("span", {
    className: "note",
    style: {
      margin: 0
    }
  }, upl ? "Preview · press Upload to store it on-chain (~0.02 STT gas)" : avImg ? "Your photo lives on-chain · it overrides the presets below" : "Or pick a preset · free with your nickname:"))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexWrap: "wrap",
      gap: 6,
      marginBottom: 12
    }
  }, window.SP_AVATARS.map((g, id) => {
    const cur = pendAv != null ? pendAv : av;
    const sel = cur === id && !avImg && !upl;
    return /*#__PURE__*/React.createElement("button", {
      key: id,
      type: "button",
      disabled: busy,
      title: id === 0 ? "Auto" : g,
      onClick: () => {
        if (handle) run("Avatar set", async () => {
          await SP.sdk.setProfile(handle, id);
          setAv(id);
          setPendAv(null);
          bumpProfile();
        });else {
          setPendAv(id);
          flash("Picked · saves with your nickname");
        }
      },
      style: {
        padding: 0,
        background: "transparent",
        cursor: "pointer",
        borderRadius: 9,
        border: sel ? "2px solid var(--accent, #d9ab4a)" : "2px solid transparent"
      }
    }, /*#__PURE__*/React.createElement(AvatarIcon, {
      av: id,
      name: handle || addr,
      size: 34,
      style: {
        borderRadius: 7
      }
    }));
  })), /*#__PURE__*/React.createElement("div", {
    className: "chipset",
    style: {
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: tab === "deposit" ? "on" : "",
    onClick: () => setTab("deposit")
  }, "Deposit"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: tab === "withdraw" ? "on" : "",
    onClick: () => setTab("withdraw")
  }, "Withdraw")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: amt,
    onChange: e => setAmt(e.target.value),
    placeholder: `Amount (${sym})`,
    style: {
      flex: 1
    }
  }), tab === "deposit" ? /*#__PURE__*/React.createElement("button", {
    className: "btn-sm join",
    disabled: busy || !amtOk,
    onClick: () => run("Deposit", () => SP.sdk.deposit(amt))
  }, "Deposit") : /*#__PURE__*/React.createElement("button", {
    className: "btn-sm join",
    disabled: busy || !amtOk,
    onClick: () => run("Withdraw", () => SP.sdk.withdraw(amt))
  }, "Withdraw")), /*#__PURE__*/React.createElement("p", {
    className: "note"
  }, "Deposit moves ", sym, " into your poker balance to buy in; withdraw sends idle balance back to your wallet."), /*#__PURE__*/React.createElement("label", {
    style: {
      marginTop: 6
    }
  }, "Cash out \xB7 send ", sym, " to another address ", /*#__PURE__*/React.createElement(Hint, {
    text: "Send STT out of your poker wallet to any external address (an exchange, another wallet\u2026)."
  })), /*#__PURE__*/React.createElement("input", {
    value: sendTo,
    onChange: e => setSendTo(e.target.value),
    placeholder: "0x\u2026 recipient address",
    style: {
      marginBottom: 6
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: sendAmt,
    onChange: e => setSendAmt(e.target.value),
    placeholder: `Amount (${sym})`,
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("button", {
    className: "btn-sm",
    disabled: busy || !(parseFloat(sendAmt) > 0) || !/^0x[0-9a-fA-F]{40}$/.test(sendTo.trim()),
    onClick: () => run("Sent", () => SP.sdk.sendNative(sendTo.trim(), sendAmt))
  }, "Send")), isOwner && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10,
      paddingTop: 12,
      borderTop: "1px solid var(--line)"
    }
  }, /*#__PURE__*/React.createElement("label", null, "Owner \xB7 cash rake (10%)"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--mono)",
      fontSize: 16,
      color: "var(--text)",
      flex: 1
    }
  }, Number(SP.fmt(rake, 6)), " ", sym), /*#__PURE__*/React.createElement("button", {
    className: "btn-sm",
    disabled: busy || rake === 0n,
    onClick: () => run("Rake withdrawn", () => SP.sdk.withdrawAllRake(addr))
  }, "Withdraw to wallet")), /*#__PURE__*/React.createElement("label", {
    style: {
      marginTop: 8
    }
  }, "Owner \xB7 tournament fees (10%)"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--mono)",
      fontSize: 16,
      color: "var(--text)",
      flex: 1
    }
  }, Number(SP.fmt(trnFees, 6)), " ", sym), /*#__PURE__*/React.createElement("button", {
    className: "btn-sm",
    disabled: busy || trnFees === 0n,
    onClick: () => run("Fees withdrawn", () => SP.sdk.withdrawAllTrnFees(addr))
  }, "Withdraw to wallet"))), /*#__PURE__*/React.createElement("div", {
    className: "row",
    style: {
      marginTop: 14,
      justifyContent: "space-between"
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "pill",
    style: {
      color: "var(--danger-soft, #ef8f8f)"
    },
    onClick: () => {
      if (SP.sdk.signOut) SP.sdk.signOut().finally(() => location.reload());else location.reload();
    }
  }, "Disconnect wallet"), /*#__PURE__*/React.createElement("button", {
    className: "pill",
    onClick: close
  }, "Close")), msg && /*#__PURE__*/React.createElement("div", {
    className: "lt-toast",
    style: {
      bottom: 60
    }
  }, msg))));
}
Object.assign(window, {
  CashierModal
});