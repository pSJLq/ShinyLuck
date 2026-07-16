// ShinyPoker · lobby: list live cash tables, link into each.
import { ShinyPoker, fmt } from "./poker-sdk.js";
import { POKER_CONFIG, NETWORK } from "./poker-config.js";

const sdk = new ShinyPoker();

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

function header() {
  return el("header", { class: "topbar" }, [
    el("div", { class: "brand", html: 'Shiny<b>Poker</b>' }),
    el("div", { class: "switcher" }, [
      el("a", { href: POKER_CONFIG.casinoUrl }, "Casino"),
      el("span", { class: "on" }, "Poker"),
    ]),
    el("div", { class: "spacer" }),
    el("div", { class: "net-badge", html: `<span class="dot"></span>${NETWORK.currency.symbol} · ${NETWORK.name}` }),
  ]);
}

function seatsDots(filled, max) {
  const wrap = el("span", { class: "seatsdot" });
  for (let i = 0; i < max; i++) wrap.append(el("i", { class: i < filled ? "on" : "" }));
  return wrap;
}

async function boot() {
  document.body.append(header());
  const main = el("div", { class: "lobby" }, [el("h1", { html: 'Cash <b>tables</b>' })]);
  document.body.append(main);

  if (!POKER_CONFIG.pokerRoom) {
    main.append(el("p", { class: "sub" }, "No deployment yet · run scripts/deploy-poker.js, then reload."));
    return;
  }

  let count = 0;
  try { count = await sdk.tableCount(); } catch (e) {
    main.append(el("p", { class: "sub" }, "Could not reach the room contract. Check the network / RPC."));
    return;
  }
  if (!count) { main.append(el("p", { class: "sub" }, "No tables open yet.")); return; }

  const tbl = el("table", { class: "tbl" }, [
    el("thead", {}, el("tr", {}, ["#", "Stakes", "Game", "Seats", "Pot now", ""].map((h) => el("th", {}, h)))),
  ]);
  const body = el("tbody");
  tbl.append(body);
  main.append(tbl);

  for (let t = 0; t < count; t++) {
    const [cfg, hand, seats] = await Promise.all([sdk.getTable(t), sdk.getHand(t), sdk.getSeats(t)]);
    const filled = seats.filter((s) => !s.empty).length;
    body.append(el("tr", {}, [
      el("td", { class: "mono" }, String(t)),
      el("td", { class: "mono" }, `${fmt(cfg.smallBlind)}/${fmt(cfg.bigBlind)} ${NETWORK.currency.symbol}`),
      el("td", {}, `NLHE ${cfg.maxSeats}-max`),
      el("td", {}, [seatsDots(filled, cfg.maxSeats), el("span", { class: "sub" }, ` ${filled}/${cfg.maxSeats}`)]),
      el("td", { class: "mono" }, hand.inProgress ? `${fmt(hand.pot)}` : "-"),
      el("td", {}, el("a", { class: "btn btn-primary", href: `table?t=${t}` }, filled >= cfg.maxSeats ? "Observe" : "Join →")),
    ]));
  }
}

boot();
