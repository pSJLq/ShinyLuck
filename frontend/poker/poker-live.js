// ShinyPoker — live table controller (vanilla JS over the SDK).
import { ShinyPoker, ACTION, STREET, STREET_NAME, cardLabel, fmt } from "./poker-sdk.js";
import { POKER_CONFIG, NETWORK } from "./poker-config.js";

const sdk = new ShinyPoker();
const tableId = Number(new URLSearchParams(location.search).get("t") || 0);

let lastSnap = null;
let connected = false;
const holeCache = {}; // dealId -> { cards, cardsStr }
let holeFetching = false;
let raiseInput = null;

// Seat ring positions (% of the felt wrapper). Index = seat number; hero is
// rotated to the bottom (seat 0 of the *view*).
const POS = {
  2: [{ x: 50, y: 97 }, { x: 50, y: 5 }],
  6: [{ x: 50, y: 99 }, { x: 7, y: 72 }, { x: 7, y: 26 }, { x: 50, y: 3 }, { x: 93, y: 26 }, { x: 93, y: 72 }],
  9: [{ x: 50, y: 99 }, { x: 18, y: 90 }, { x: 4, y: 56 }, { x: 12, y: 20 }, { x: 36, y: 3 },
      { x: 64, y: 3 }, { x: 88, y: 20 }, { x: 96, y: 56 }, { x: 82, y: 90 }],
};

// ---------- tiny DOM helper ----------
function el(tag, props = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  (Array.isArray(kids) ? kids : [kids]).forEach((c) => c != null && n.append(c.nodeType ? c : document.createTextNode(c)));
  return n;
}
const short = (a) => (a && a !== "0x0000000000000000000000000000000000000000" ? a.slice(0, 6) + "…" + a.slice(-4) : "");
const $ = (id) => document.getElementById(id);

function toast(msg, kind = "") {
  const t = el("div", { class: "toast " + kind }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), kind === "err" ? 6000 : 3200);
}

async function wrapTx(label, fn) {
  const t = el("div", { class: "toast" }, label + "…");
  document.body.append(t);
  try {
    await fn();
    t.remove();
    toast(label + " ✓", "ok");
  } catch (e) {
    t.remove();
    const m = e?.info?.error?.message || e?.shortMessage || e?.reason || e?.message || "failed";
    toast(label + " failed: " + m.replace(/execution reverted:?/i, "").trim(), "err");
    console.error(e);
  }
}

// ---------- card rendering ----------
function cardEl(c, opts = {}) {
  if (c == null || c === 255) return el("div", { class: "card back" + (opts.sm ? " sm" : "") });
  const lab = cardLabel(c);
  return el("div", { class: "card" + (lab.red ? " red" : "") + (opts.sm ? " sm" : "") }, [
    el("span", { class: "r" }, lab.rank),
    el("span", { class: "s" }, lab.suit),
  ]);
}

// ---------- shell ----------
function renderShell() {
  document.body.append(
    el("header", { class: "topbar" }, [
      el("div", { class: "brand", html: 'Shiny<b>Poker</b>' }),
      el("div", { class: "switcher" }, [
        el("a", { class: "", href: POKER_CONFIG.casinoUrl }, "Casino"),
        el("span", { class: "on" }, "Poker"),
      ]),
      el("div", { class: "spacer" }),
      el("div", { class: "net-badge", html: `<span class="dot"></span>${NETWORK.currency.symbol} · ${NETWORK.name}` }),
      el("div", { class: "wallet", id: "wallet" }, [
        el("button", { class: "btn btn-primary", id: "connectBtn", onclick: onConnect }, "Connect Wallet"),
      ]),
    ]),
    el("main", { class: "stage" }, [el("div", { class: "feltwrap", id: "felt" })]),
    el("div", { class: "actionbar", id: "actionbar" }),
  );
  if (!POKER_CONFIG.pokerRoom) {
    $("felt").append(el("div", { class: "center-msg" }, [
      el("h2", {}, "Table not deployed yet"),
      el("p", {}, "Run scripts/deploy-poker.js, then reload. (poker-config.js will be filled in.)"),
    ]));
  }
}

async function onConnect() {
  try {
    await sdk.connect();
    connected = true;
    await refreshWallet();
    toast("Wallet connected", "ok");
    if (lastSnap) render(lastSnap);
  } catch (e) {
    toast(e.message || "connect failed", "err");
  }
}

async function refreshWallet() {
  const w = $("wallet");
  if (!connected) return;
  let bal = 0n;
  try { bal = await sdk.balanceOf(sdk.address); } catch {}
  w.replaceChildren(
    el("div", { class: "bal mono" }, [`${fmt(bal)} `, el("small", {}, NETWORK.currency.symbol + " in room")]),
    el("button", { class: "btn btn-ghost", onclick: openCashier }, "Cashier"),
    el("div", { class: "bal mono", title: sdk.address }, short(sdk.address)),
  );
}

// ---------- main render ----------
function render(snap) {
  lastSnap = snap;
  if (!POKER_CONFIG.pokerRoom) return;
  const felt = $("felt");
  felt.replaceChildren();
  const { cfg, hand, seats, board, mySeat } = snap;

  felt.append(el("div", { class: "felt" }), el("div", { class: "felt-rail" }));

  // center: zk badge, board, pot
  const center = el("div", { class: "center" }, [
    el("div", { class: "zk" }, "Provably fair · commit-reveal ✓"),
    el("div", { class: "board" }, board.length ? board.map((c) => cardEl(c)) : [el("span", { class: "hint" }, hand.inProgress ? "Dealing…" : "Waiting for players")]),
    el("div", { class: "pot mono", html: hand.inProgress ? `Pot <b>${fmt(hand.pot)}</b> ${NETWORK.currency.symbol} · ${STREET_NAME[hand.street] || ""}` : "" }),
  ]);
  felt.append(center);

  const pos = POS[cfg.maxSeats] || POS[6];
  const now = Math.floor(Date.now() / 1000);

  seats.forEach((seat) => {
    const p = pos[seat.index] || { x: 50, y: 50 };
    const isActive = hand.inProgress && hand.actingSeat === seat.index && hand.street <= STREET.RIVER;
    const isMe = mySeat === seat.index;
    const node = el("div", {
      class: "seat" + (isActive ? " active" : "") + (seat.folded ? " folded" : ""),
      style: `left:${p.x}%;top:${p.y}%`,
    });

    if (seat.empty) {
      node.append(el("button", { class: "empty-btn", onclick: () => openSit(seat.index) }, connected ? "Sit here" : "Sit"));
      felt.append(node);
      return;
    }

    const inner = el("div", { class: "seat-inner" });
    // dealer / blind tag
    let tag = null;
    if (hand.inProgress) {
      if (seat.index === hand.button) tag = "D";
      // SB/BB derived: next occupied after button etc. — simplest: mark via blinds not tracked; show D only
    }
    if (tag) inner.append(el("div", { class: "tag " + tag }, tag));

    // hole cards for me (from the bot), backs for others in-hand
    if (hand.inProgress && seat.inHand) {
      if (isMe) {
        const h = holeCache[String(hand.dealId)];
        inner.append(el("div", { class: "hole" }, h ? h.cards.map((c) => cardEl(c, { sm: true })) : [cardEl(255, { sm: true }), cardEl(255, { sm: true })]));
        if (!h && !holeFetching) fetchHole(hand.dealId);
      } else {
        inner.append(el("div", { class: "hole" }, [cardEl(255, { sm: true }), cardEl(255, { sm: true })]));
      }
    }

    inner.append(
      el("div", { class: "nm" }, (isMe ? "You · " : "") + short(seat.player)),
      el("div", { class: "stk mono", html: `${fmt(seat.stack)} <small>${NETWORK.currency.symbol}</small>` }),
      el("div", { class: "status" + (seat.allIn ? " allin" : seat.folded ? " fold" : "") },
        seat.allIn ? "ALL-IN" : seat.folded ? "folded" : seat.sittingOut ? "sitting out" : ""),
    );
    if (seat.committedStreet > 0n) inner.append(el("div", { class: "bet mono" }, `${fmt(seat.committedStreet)} ${NETWORK.currency.symbol}`));
    if (isActive && hand.actingDeadline > now) {
      const frac = Math.max(0, Math.min(1, (hand.actingDeadline - now) / cfg.actionTimeout));
      inner.append(el("div", { class: "timer", style: `width:${frac * 100}%` }));
    }
    node.append(inner);
    felt.append(node);
  });

  renderActions(snap);
}

// ---------- action bar ----------
function renderActions(snap) {
  const bar = $("actionbar");
  bar.replaceChildren();
  const { cfg, hand, seats, mySeat } = snap;

  if (!connected) {
    bar.append(el("div", { class: "hint" }, "Connect your wallet to play."));
    return;
  }
  if (mySeat < 0) {
    bar.append(el("div", { class: "hint" }, "Take an empty seat to join the table."));
    return;
  }
  const me = seats[mySeat];
  // seated controls
  const seatedCtl = el("div", { class: "actionrow" }, [
    el("button", { class: "btn btn-ghost", onclick: () => wrapTx("Leave table", () => sdk.leave(tableId)) }, "Leave"),
    el("button", { class: "btn btn-ghost", onclick: () => wrapTx(me.sittingOut ? "Sit in" : "Sit out", () => sdk.sitOut(tableId, !me.sittingOut)) }, me.sittingOut ? "Sit in" : "Sit out"),
  ]);

  const myTurn = hand.inProgress && hand.actingSeat === mySeat && hand.street <= STREET.RIVER;
  if (!myTurn) {
    bar.append(
      el("div", { class: "hint turn" }, hand.inProgress ? (hand.street === STREET.SHOWDOWN ? "Showdown…" : `Waiting for seat ${hand.actingSeat}…`) : "Waiting for the next hand…"),
      seatedCtl,
    );
    return;
  }

  const cur = hand.currentBet;
  const myCommitted = me.committedStreet;
  const toCall = cur > myCommitted ? cur - myCommitted : 0n;
  const minRaiseTo = cur === 0n ? cfg.bigBlind : cur + hand.minRaise;
  const maxTo = myCommitted + me.stack;

  const row = el("div", { class: "actionrow" });
  // Fold
  row.append(el("button", { class: "btn btn-fold", onclick: () => act(ACTION.FOLD) }, "Fold"));
  // Check / Call
  if (toCall === 0n) row.append(el("button", { class: "btn btn-call", onclick: () => act(ACTION.CHECK) }, "Check"));
  else {
    const allInCall = toCall >= me.stack;
    row.append(el("button", { class: "btn btn-call", onclick: () => act(ACTION.CALL) }, `Call ${fmt(toCall)}${allInCall ? " (all-in)" : ""}`));
  }
  // Bet / Raise (only if you have chips beyond a call and a full raise is possible)
  if (me.stack > toCall && maxTo > cur) {
    const defTo = minRaiseTo < maxTo ? minRaiseTo : maxTo;
    raiseInput = el("input", { type: "number", step: fmt(cfg.bigBlind, 2), min: fmt(minRaiseTo), max: fmt(maxTo), value: fmt(defTo) });
    const isBet = cur === 0n;
    const box = el("div", { class: "raisebox" }, [
      raiseInput,
      el("button", { class: "btn btn-primary", onclick: () => act(isBet ? ACTION.BET : ACTION.RAISE, raiseInput.value) }, isBet ? "Bet" : "Raise to"),
    ]);
    row.append(box);
  }
  // All-in
  if (me.stack > 0n) row.append(el("button", { class: "btn", onclick: () => act(ACTION.ALLIN) }, `All-in ${fmt(maxTo)}`));

  const chips = el("div", { class: "chips" }, [
    quick("½ pot", () => setRaise(cur === 0n ? hand.pot / 2n : myCommitted + toCall + hand.pot / 2n, minRaiseTo, maxTo)),
    quick("Pot", () => setRaise(cur === 0n ? hand.pot : myCommitted + toCall + hand.pot, minRaiseTo, maxTo)),
    quick("Max", () => raiseInput && (raiseInput.value = fmt(maxTo))),
  ]);

  bar.append(el("div", { class: "hint turn" }, "Your turn"), row, chips, seatedCtl);
}

function quick(label, fn) { return el("button", { class: "btn", onclick: fn }, label); }
function setRaise(toWei, minTo, maxTo) {
  if (!raiseInput) return;
  let v = toWei < minTo ? minTo : toWei > maxTo ? maxTo : toWei;
  raiseInput.value = fmt(v);
}

async function act(action, amount = 0) {
  const names = { [ACTION.FOLD]: "Fold", [ACTION.CHECK]: "Check", [ACTION.CALL]: "Call", [ACTION.BET]: "Bet", [ACTION.RAISE]: "Raise", [ACTION.ALLIN]: "All-in" };
  await wrapTx(names[action], () => sdk.act(tableId, action, amount));
  refresh();
}

// ---------- hole cards ----------
async function fetchHole(dealId) {
  holeFetching = true;
  try {
    const res = await sdk.myHoleCards(tableId, dealId);
    holeCache[String(dealId)] = res;
    if (lastSnap) render(lastSnap);
  } catch (e) {
    console.warn("hole fetch:", e.message);
  } finally {
    holeFetching = false;
  }
}

// ---------- sit / cashier modals ----------
function modal(title, bodyKids) {
  const bg = el("div", { class: "modal-bg", onclick: (e) => { if (e.target === bg) bg.remove(); } });
  const m = el("div", { class: "modal" }, [el("h3", {}, title), ...bodyKids]);
  bg.append(m);
  document.body.append(bg);
  return bg;
}

async function openSit(seatIndex) {
  if (!connected) return onConnect();
  const cfg = await sdk.getTable(tableId);
  const minE = fmt(cfg.minBuyIn), maxE = fmt(cfg.maxBuyIn);
  const input = el("input", { type: "number", min: minE, max: maxE, step: minE, value: maxE });
  const bg = modal(`Sit at seat ${seatIndex}`, [
    el("div", { class: "note" }, `Blinds ${fmt(cfg.smallBlind)}/${fmt(cfg.bigBlind)} ${NETWORK.currency.symbol}. Buy-in ${minE}–${maxE}. Chips come from your in-room balance; we'll deposit the difference from your wallet if needed.`),
    el("label", {}, "Buy-in"),
    input,
    el("div", { class: "row" }, [
      el("button", { class: "btn btn-ghost", onclick: () => bg.remove() }, "Cancel"),
      el("button", { class: "btn btn-primary", onclick: async () => {
        bg.remove();
        const buyIn = input.value;
        await wrapTx("Take seat", async () => {
          const bal = await sdk.balanceOf(sdk.address);
          const need = (await import("/vendor/ethers.bundle.js")).ethers.parseEther(String(buyIn));
          if (bal < need) await sdk.deposit(fmt(need - bal, 6));
          await sdk.sitDown(tableId, seatIndex, buyIn);
        });
        refresh();
      } }, "Take seat"),
    ]),
  ]);
}

async function openCashier() {
  const bal = await sdk.balanceOf(sdk.address);
  const dep = el("input", { type: "number", min: "0", step: "0.1", value: "5", placeholder: "amount" });
  const wd = el("input", { type: "number", min: "0", step: "0.1", value: fmt(bal), placeholder: "amount" });
  const bg = modal("Cashier", [
    el("div", { class: "note" }, `In-room balance: ${fmt(bal)} ${NETWORK.currency.symbol}. Deposit from your wallet to play; withdraw idle funds anytime (chips in play must be returned via Leave first).`),
    el("label", {}, "Deposit from wallet"),
    dep,
    el("div", { class: "row" }, [el("button", { class: "btn btn-primary", onclick: () => { bg.remove(); wrapTx("Deposit", () => sdk.deposit(dep.value)).then(refreshWallet); } }, "Deposit")]),
    el("label", {}, "Withdraw to wallet"),
    wd,
    el("div", { class: "row" }, [el("button", { class: "btn btn-ghost", onclick: () => { bg.remove(); wrapTx("Withdraw", () => sdk.withdraw(wd.value)).then(refreshWallet); } }, "Withdraw")]),
  ]);
}

// ---------- live loop ----------
async function refresh() {
  try {
    const snap = await sdk.snapshot(tableId);
    render(snap);
    if (connected) refreshWallet();
  } catch (e) {
    console.warn("refresh failed", e);
  }
}

function boot() {
  renderShell();
  if (!POKER_CONFIG.pokerRoom) return;
  sdk.watch(tableId, (snap) => render(snap), 1500);
}
boot();
