/* ShinyLuck Predictions - site view (/predictions).
 * Parimutuel markets on X events, resolved by Somnia on-chain agent consensus.
 * Reads go through a plain RPC provider; writes go through the shell's shared
 * Privy signer (same wallet as casino/poker - no browser extension needed).
 * Market creation is curator-only and lives outside this view. */

import { ethers as E } from "/vendor/ethers.bundle.js";
import { SL, connect } from "./wallet.js";

const CFG = {
  chainId: 50312,
  rpc: "https://api.infra.testnet.somnia.network",
  predictionMarket: "0x8AA8E7D6D89b4D6a9C9a43C0f4Fa5a547a7974E5",
  xOracleResolver: "0x4bfdCA75c535c6feE61A27209bbDFe215792de09",
  agentsExplorer: "https://agents.testnet.somnia.network",
};

const PM_ABI = [
  "function marketCount() view returns (uint256)",
  "function getMarket(uint256) view returns (tuple(address creator,uint64 closeTs,uint64 resolveDeadline,uint8 nOutcomes,uint8 winner,uint8 state,uint8 template,uint16 platformFeeBps,uint16 creatorFeeBps,uint256 creatorBond,uint256 total) m, string question, string[] outcomeLabels)",
  "function getPools(uint256) view returns (uint256[8])",
  "function getSpec(uint256) view returns (tuple(string primaryUrl,string primarySelector,string secondaryUrl,string secondarySelector,string criteria,uint256[] bucketBounds,string[] raceUrls,string[] raceSelectors,uint256 raceThreshold))",
  "function claimableOf(uint256,address) view returns (uint256)",
  "function claimed(uint256,address) view returns (bool)",
  "function bet(uint256,uint8) payable",
  "function claim(uint256)",
  "function owner() view returns (address)",
  "function curatedMode() view returns (bool)",
  "function allowedCreators(address) view returns (bool)",
  "function creationFee() view returns (uint256)",
  "function creatorBondAmount() view returns (uint256)",
  "function createMarket(uint8 template,string question,string[] outcomeLabels,uint64 closeTs,uint64 resolveDeadline,tuple(string primaryUrl,string primarySelector,string secondaryUrl,string secondarySelector,string criteria,uint256[] bucketBounds,string[] raceUrls,string[] raceSelectors,uint256 raceThreshold) spec) payable returns (uint256)",
  "event BetPlaced(uint256 indexed marketId, address indexed player, uint8 outcome, uint256 amount)",
];

// View-calls only: the public RPC caps eth_getLogs at 1000 blocks, so
// provenance lives in resolver state, not log scans.
const RES_ABI = [
  "function getRound(uint256) view returns (uint32 seq, bool active, uint8 fired, uint8 received, uint8 roundsUsed, uint8[8] votes, uint256[8] raw)",
  "function getVoteMeta(uint256) view returns (uint256[8] requestIds, uint256[8] agentIds, uint32[8] responded, uint32[8] agreed)",
  "function oracleBaseUrl() view returns (string)",
  "function subSize() view returns (uint8)",
];

const AGENT_NAMES = {
  "13174292974160097713": "JSON API",
  "12847293847561029384": "LLM Inference",
  "12875401142070969085": "LLM Parse Website",
};
const VOTE_ABSTAIN = 255, VOTE_PENDING = 254, VOTE_MEASURED = 253;
const TEMPLATES = ["Tweet metric", "Followers", "Posts/day", "Freeform", "Race"];
// gold-first categorical palette validated for this dark surface
const SERIES = ["#C98500", "#3987E5", "#D55181", "#008300", "#9085E9", "#E66767", "#199E70", "#D95926"];

let provider, pmRead, resolverRead, pmWrite;
let detailId = null, tradeSel = 0, oracleBase = "", subSizeVal = 3;
let blockTsCache = new Map();
// "active" hides settled markets (Resolved/Voided) so the board shows what
// you can still bet on; "all" is the full archive with its receipts.
let filterMode = "active";

const $ = (id) => document.getElementById(id);
const fmt = (wei) => Number(E.formatEther(wei)).toLocaleString(undefined, { maximumFractionDigits: 4 });
const pctOf = (pool, total) => (total > 0n ? Number((pool * 10000n) / total) / 100 : 0);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const acct = () => (SL && SL.address) || null;

function toast(msg, kind = "") {
  const t = $("ptoast");
  if (!t) return;
  t.textContent = msg;
  t.className = "show " + kind;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = ""), kind === "err" ? 6000 : 3500);
}

// payout per 1 STT staked on an outcome; extraStake simulates the bettor's own
// addition (their bet joins the pool, the losing side is unchanged)
function payoutPerUnit(total, pool, feeBps, extraStake = 0n) {
  const p = pool + extraStake, t = total + extraStake;
  if (p === 0n) return null;
  const fees = ((t - p) * feeBps) / 10000n;
  return Number(((t - fees) * 10000n) / p) / 10000;
}

async function init() {
  provider = new E.JsonRpcProvider(CFG.rpc);
  pmRead = new E.Contract(CFG.predictionMarket, PM_ABI, provider);
  resolverRead = new E.Contract(CFG.xOracleResolver, RES_ABI, provider);
  resolverRead.oracleBaseUrl().then((b) => { oracleBase = b; }).catch(() => {});
  resolverRead.subSize().then((s) => { subSizeVal = Number(s); }).catch(() => {});
  await renderMarkets();
  refreshCreateRights();
  setInterval(() => {
    if (detailId === null && $("tab-create").style.display === "none") renderMarkets();
    else if (detailId !== null) renderDetail(detailId, { keepChart: true });
  }, 12000);
}

// the shell tells us when the shared wallet connects
document.addEventListener("shinyluck:connected", () => {
  pmWrite = null;
  refreshCreateRights();
  if (detailId === null) renderMarkets(); else renderDetail(detailId, { keepChart: true });
});

async function writeContract() {
  if (!acct()) await connect();
  if (!SL.signer) throw new Error("Wallet not connected");
  if (!pmWrite) pmWrite = new E.Contract(CFG.predictionMarket, PM_ABI, SL.signer);
  return pmWrite;
}

// ---------- grid ----------
function stateBadge(m, now) {
  const st = Number(m.state);
  if (st === 1) return ["Resolved", "resolved"];
  if (st === 2) return ["Voided", "voided"];
  if (now >= Number(m.closeTs)) return ["Resolving", "closing"];
  return ["Open", "open"];
}

// Renders overlap (the 12s refresh outlives a slow RPC pass), so a stale run
// must never paint over a newer one - that is what made the Active/All switch
// look dead: the pre-click render finished last and restored the old list.
let renderGen = 0;

async function renderMarkets() {
  const gen = ++renderGen;
  let count;
  try { count = Number(await pmRead.marketCount()); } catch (e) { return; }
  if (gen !== renderGen) return;
  if (!count) { $("marketList").innerHTML = '<div class="empty">No markets yet.</div>'; return; }
  // fetch in parallel - sequential awaits took ~20s for 23 markets
  const ids = Array.from({ length: count }, (_, i) => count - 1 - i);
  const built = await Promise.all(ids.map((id) => marketCard(id).catch(() => null)));
  if (gen !== renderGen) return;
  const cards = [];
  let settled = 0;
  for (const card of built) {
    if (!card) continue;
    if (card.settled) settled++;
    if (filterMode === "all" || !card.settled) cards.push(card.html);
  }
  const cnt = $("fCount");
  if (cnt) cnt.textContent = settled ? `(${settled} settled)` : "";
  if (!cards.length) {
    $("marketList").innerHTML = `<div class="empty">No open markets right now.<br>Switch to <b>All</b> to browse ${settled} settled market${settled === 1 ? "" : "s"} and their agent receipts.</div>`;
    return;
  }
  $("marketList").innerHTML = cards.join("");
  document.querySelectorAll("[data-open]").forEach((c) => {
    c.onclick = () => openDetail(Number(c.dataset.open), 0);
  });
  document.querySelectorAll("[data-bet-open]").forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const [id, i] = b.dataset.betOpen.split("-").map(Number);
      openDetail(id, i);
    };
  });
}

async function marketCard(id) {
  const [m, question, labels] = await pmRead.getMarket(id);
  const pools = await pmRead.getPools(id);
  const total = m.total, now = Math.floor(Date.now() / 1000), state = Number(m.state);
  const [badge, badgeCls] = stateBadge(m, now);
  const canBet = state === 0 && now < Number(m.closeTs);

  const rows = labels.slice(0, 3).map((lbl, i) => {
    const isWin = state === 1 && Number(m.winner) === i;
    const btn = canBet ? `<button class="mini" data-bet-open="${id}-${i}">Bet</button>`
                       : (isWin ? '<span class="winmark">✓</span>' : "");
    return `<div class="mrow ${isWin ? "win" : ""}">
      <span class="dot" style="background:${SERIES[i]}"></span>
      <span class="ml">${esc(lbl)}</span>
      <span class="mp">${pctOf(pools[i], total).toFixed(0)}%</span>
      ${btn}
    </div>`;
  }).join("");
  const more = labels.length > 3 ? `<div class="mrow more">+${labels.length - 3} more outcomes</div>` : "";

  let claimChip = "";
  if (acct() && state !== 0) {
    try {
      const c = await pmRead.claimableOf(id, acct());
      if (c > 0n) claimChip = `<span class="chip gold">Claim ${fmt(c)} STT</span>`;
    } catch (e) {}
  }
  const closeStr = new Date(Number(m.closeTs) * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return {
    settled: state !== 0,
    html: `<div class="mcard" data-open="${id}">
    <div class="mhead"><div class="mico">𝕏</div><h3>${esc(question)}</h3><span class="badge ${badgeCls}">${badge}</span></div>
    <div class="mocs">${rows}${more}</div>
    <div class="mfoot">
      <span>${fmt(total)} STT Vol</span><span>${TEMPLATES[Number(m.template)] || "-"}</span>
      <span>closes ${closeStr}</span>${claimChip}
    </div>
  </div>`,
  };
}

// Active / All filter
document.querySelectorAll("#pFilter button").forEach((b) => {
  b.onclick = () => {
    filterMode = b.dataset.filter;
    document.querySelectorAll("#pFilter button").forEach((x) => x.classList.toggle("on", x === b));
    renderMarkets();
  };
});

// ---------- detail ----------
function showSection(name) {
  $("tab-markets").style.display = name === "markets" ? "" : "none";
  $("tab-detail").style.display = name === "detail" ? "" : "none";
  $("tab-create").style.display = name === "create" ? "" : "none";
  const f = $("pFilter");
  if (f) f.style.display = name === "markets" ? "" : "none";
}

async function openDetail(id, outcome = 0) {
  detailId = id; tradeSel = outcome;
  showSection("detail");
  window.scrollTo({ top: 0, behavior: "smooth" });
  await renderDetail(id);
}

async function renderDetail(id, opts = {}) {
  if (detailId !== id) return;
  let m, question, labels, pools;
  try {
    [m, question, labels] = await pmRead.getMarket(id);
    pools = await pmRead.getPools(id);
  } catch (e) { return; }
  const total = m.total, now = Math.floor(Date.now() / 1000), state = Number(m.state);
  const [badge, badgeCls] = stateBadge(m, now);
  const feeBps = BigInt(m.platformFeeBps) + BigInt(m.creatorFeeBps);

  $("dQuestion").textContent = question;
  $("dBadge").className = "badge " + badgeCls;
  $("dBadge").textContent = badge;
  $("dMeta").innerHTML = [
    `<span><span class="k">#</span>${id}</span>`,
    `<span><span class="k">type</span> ${TEMPLATES[Number(m.template)] || "-"}</span>`,
    `<span><span class="k">pool</span> ${fmt(total)} STT</span>`,
    `<span><span class="k">closes</span> ${new Date(Number(m.closeTs) * 1000).toLocaleString()}</span>`,
  ].join("");
  $("dLegend").innerHTML = labels.map((lbl, i) => `<span class="lg"><i style="background:${SERIES[i]}"></i>${esc(lbl)}</span>`).join("");

  $("dOutcomes").innerHTML = labels.map((lbl, i) => {
    const pct = pctOf(pools[i], total);
    const isWin = state === 1 && Number(m.winner) === i;
    const mult = payoutPerUnit(total, pools[i], feeBps);
    return `<div class="oc ${isWin ? "win" : ""} ${i === tradeSel ? "sel" : ""}" data-sel="${i}">
      <div class="fill" style="width:${pct}%"></div>
      <div class="lbl"><span class="dot" style="background:${SERIES[i]}"></span>${esc(lbl)}${isWin ? " ✓" : ""}</div>
      <div class="pct">${pct.toFixed(1)}%</div>
      <span class="mult ${mult ? "" : "empty"}">${mult ? "×" + mult.toFixed(2) : "first bet"}</span>
      <div class="pct">${fmt(pools[i])} STT</div>
    </div>`;
  }).join("");
  document.querySelectorAll("[data-sel]").forEach((r) => {
    r.onclick = () => { tradeSel = Number(r.dataset.sel); renderDetail(id, { keepChart: true }); };
  });

  $("dFoot").innerHTML =
    `<a href="${CFG.agentsExplorer}" target="_blank" rel="noopener">agent receipts ↗</a>` +
    `<span>parimutuel · fees ${Number(feeBps) / 100}% off the losing pool only</span>`;

  renderTradePanel(m, labels, pools, now);
  renderResolution(id, m, labels).catch(() => {});
  if (!opts.keepChart) await renderChart(id, labels, m, pools);
}

// ---------- trade ----------
function renderTradePanel(m, labels, pools, now) {
  const el = $("dTrade"), state = Number(m.state), total = m.total;
  const feeBps = BigInt(m.platformFeeBps) + BigInt(m.creatorFeeBps);
  const canBet = state === 0 && now < Number(m.closeTs);

  if (canBet) {
    el.innerHTML = `
      <div class="ttitle">Buy · <span class="tname">${esc(labels[tradeSel])}</span></div>
      <div class="tsels">${labels.map((lbl, i) => `<button class="tsel ${i === tradeSel ? "on" : ""}" data-tsel="${i}" style="--c:${SERIES[i]}"><span>${esc(lbl)}</span><b>${pctOf(pools[i], total).toFixed(0)}%</b></button>`).join("")}</div>
      <label class="tam">Amount (STT)<input id="tAmount" type="number" step="0.01" min="0.01" placeholder="0.00" /></label>
      <div class="tchips"><button data-add="0.1">+0.1</button><button data-add="0.5">+0.5</button><button data-add="1">+1</button><button data-add="5">+5</button></div>
      <div class="tsums">
        <div><span>Current payout</span><b id="tOdds"></b></div>
        <div><span>You receive if won</span><b id="tPayout" class="goldtxt">0.00 STT</b></div>
      </div>
      <button class="gold big" id="tBet">Place bet</button>
      <div class="hint">Parimutuel pool: winners split the losing side, fees come off the losing side only. Odds move with every bet until close.</div>`;

    document.querySelectorAll("[data-tsel]").forEach((b) => {
      b.onclick = () => { tradeSel = Number(b.dataset.tsel); renderDetail(detailId, { keepChart: true }); };
    });
    const amountEl = $("tAmount");
    const recalc = () => {
      const v = Number(amountEl.value || 0);
      const stake = v > 0 ? E.parseEther(String(v)) : 0n;
      const per = payoutPerUnit(total, pools[tradeSel], feeBps, stake);
      const perNow = payoutPerUnit(total, pools[tradeSel], feeBps);
      $("tOdds").textContent = perNow ? `×${perNow.toFixed(2)}` : "first bet takes the pool";
      $("tPayout").textContent = v > 0 && per ? `${(v * per).toFixed(4)} STT (×${per.toFixed(2)})` : "0.00 STT";
    };
    amountEl.oninput = recalc;
    document.querySelectorAll("[data-add]").forEach((b) => {
      b.onclick = () => { amountEl.value = (Number(amountEl.value || 0) + Number(b.dataset.add)).toFixed(2); recalc(); };
    });
    recalc();
    $("tBet").onclick = async () => {
      const v = Number(amountEl.value || 0);
      if (!v || v <= 0) { toast("Enter an amount", "err"); return; }
      await doTx($("tBet"), async () => (await writeContract()).bet(detailId, tradeSel, { value: E.parseEther(String(v)) }), "Bet placed");
      renderDetail(detailId);
    };
    return;
  }

  let inner;
  if (state === 0) inner = `<div class="ttitle">Resolving</div><div class="hint">Betting is closed. Somnia agents are measuring the outcome; the market resolves when independent votes agree.</div>`;
  else if (state === 1) inner = `<div class="ttitle">Resolved · <span class="tname">${esc(labels[Number(m.winner)])}</span></div>`;
  else inner = `<div class="ttitle">Voided</div><div class="hint">Could not be resolved before the deadline. Every stake is refundable in full.</div>`;
  el.innerHTML = inner + `<div id="tClaimZone"></div>`;

  if (acct() && state !== 0) {
    pmRead.claimableOf(detailId, acct()).then((c) => {
      if (!$("tClaimZone")) return;
      if (c > 0n) {
        $("tClaimZone").innerHTML = `<button class="gold big" id="tClaim">Claim ${fmt(c)} STT</button>`;
        $("tClaim").onclick = () => doTx($("tClaim"), async () => (await writeContract()).claim(detailId), "Claimed").then(() => renderDetail(detailId));
      } else {
        $("tClaimZone").innerHTML = `<div class="hint">Nothing to claim on this wallet.</div>`;
      }
    }).catch(() => {});
  } else if (!acct()) {
    $("tClaimZone").innerHTML = `<div class="hint">Connect your wallet to claim winnings.</div>`;
  }
}

// ---------- resolution provenance ----------
const resolveUrl = (u) => (u && !u.startsWith("http") ? oracleBase + u : u);
const urlHost = (u) => { try { return new URL(u).host; } catch (e) { return u; } };
const urlPath = (u) => { try { const p = new URL(u); return (p.pathname + p.search).slice(0, 44); } catch (e) { return ""; } };

function sourceCards(t, spec, labels) {
  if (t === 3) return [0, 1, 2].map(() => ({ kind: "LLM", url: "", note: "answers an outcome label from the criteria" }));
  if (t === 4) {
    const cards = [{ kind: "JSON", url: resolveUrl(spec.primaryUrl), sel: spec.primarySelector, note: "x-oracle winner index" }];
    spec.raceUrls.forEach((u, i) => cards.push({ kind: spec.raceSelectors[i] ? "JSON" : "PARSE", url: u, sel: spec.raceSelectors[i] || "", note: labels[i] }));
    return cards;
  }
  const cards = [{ kind: "JSON", url: resolveUrl(spec.primaryUrl), sel: spec.primarySelector, note: "x-oracle mirror" }];
  if (t === 0) cards.push({ kind: "JSON", url: spec.secondaryUrl, sel: spec.secondarySelector, note: "independent public source" });
  else if (spec.secondaryUrl) cards.push({ kind: "PARSE", url: spec.secondaryUrl, sel: "", note: "LLM page extraction" });
  return cards;
}

const CONSENSUS_RULES = {
  0: "Both independent JSON reads must land in the same outcome bucket.",
  1: "The x-oracle read and the page extraction must land in the same bucket.",
  2: "The x-oracle read and the page extraction must land in the same bucket.",
  3: "2 of 3 independent LLM votes must return the same outcome label.",
  4: "The x-oracle's winner index must equal the argmax the chain recomputes itself from the independent per-contender measurements.",
};

async function renderResolution(id, m, labels) {
  const box = $("dResolution");
  if (!box || !resolverRead) return;
  const t = Number(m.template), state = Number(m.state);
  let spec, round, meta;
  try {
    [spec, round, meta] = await Promise.all([pmRead.getSpec(id), resolverRead.getRound(id), resolverRead.getVoteMeta(id)]);
  } catch (e) { return; }
  if (detailId !== id) return;

  const voteHtml = sourceCards(t, spec, labels).map((c, i) => {
    const requestId = meta.requestIds[i], fired = requestId !== 0n;
    const agent = fired ? (AGENT_NAMES[meta.agentIds[i].toString()] || "Agent")
                        : ({ JSON: "JSON API", PARSE: "LLM Parse Website", LLM: "LLM Inference" })[c.kind];
    let status = ["wait", "waiting"], valueHtml = '<span class="vv pending">-</span>';
    if (fired) {
      const o = Number(round.votes[i]);
      if (o === VOTE_PENDING) { status = ["run", "running"]; valueHtml = '<span class="vv pending">measuring…</span>'; }
      else if (o === VOTE_ABSTAIN) { status = ["bad", "no data"]; valueHtml = '<span class="vv abstain">could not read the source</span>'; }
      else if (o === VOTE_MEASURED) { status = ["ok", "complete"]; valueHtml = `<span class="vv num">${Number(round.raw[i]).toLocaleString()}</span>`; }
      else if (o < labels.length) { status = ["ok", "complete"]; valueHtml = `<span class="vv ok">${esc(labels[o])}</span>`; }
    }
    const reads = c.kind === "JSON" ? `reads <code>${esc(c.sel)}</code>${c.note ? " · " + esc(c.note) : ""}`
      : c.kind === "PARSE" ? `AI extracts the value from the page${c.note ? " · " + esc(c.note) : ""}`
      : "AI answers one of the outcomes from the resolution criteria";
    const nResp = Number(meta.responded[i] || 0);
    const statHtml = nResp > 0 ? `<span class="vstat">${nResp}/${subSizeVal} validators · ${Number(meta.agreed[i])} agreed</span>` : "<span></span>";
    const receipt = fired ? `<a class="receipt" href="${CFG.agentsExplorer}/receipts/${requestId}" target="_blank" rel="noopener">Receipt ↗</a>` : "";
    const srcLine = c.url
      ? `<a class="vsrc" href="${esc(c.url)}" target="_blank" rel="noopener" title="${esc(c.url)}"><b>${esc(urlHost(c.url))}</b><span class="path">${esc(urlPath(c.url))}</span></a>`
      : '<div class="vsrc off">no external source</div>';
    return `<div class="vcard">
      <div class="vhead"><span class="chipk">SOURCE ${String(i + 1).padStart(2, "0")}</span><span class="vstatus ${status[0]}">${status[1]}</span></div>
      ${srcLine}<div class="vread">${reads}</div>
      <div class="vagent">⬡ Somnia Agent · ${esc(agent)}</div>
      <div class="vout">${valueHtml}</div>
      <div class="vfoot">${statHtml}${receipt}</div>
    </div>`;
  }).join("");

  let verdict, cls;
  if (state === 1) { verdict = `REACHED · ${esc(labels[Number(m.winner)])}`; cls = "reached"; }
  else if (state === 2) { verdict = "VOIDED · full refunds"; cls = "voided"; }
  else if (round.active) { verdict = "ROUND IN FLIGHT"; cls = "pending"; }
  else if (Number(round.roundsUsed) > 0) { verdict = "NO CONSENSUS YET · retrying"; cls = "failed"; }
  else { verdict = "AWAITING CLOSE"; cls = "pending"; }

  const isSingle = (t === 1 || t === 2) && !spec.secondaryUrl;
  const rule = isSingle
    ? "Single source: resolves from the x-oracle's published measurement. The measurement method is open, the published JSON is permanent, and anyone can re-check the number on X - a mismatch would be publicly provable."
    : (CONSENSUS_RULES[t] || "");

  box.innerHTML = `
    <div class="rz-title">Resolution · verifiable on-chain ${isSingle ? '<span class="rz-single">SINGLE SOURCE</span>' : ""}</div>
    <div class="rz-sub">Every vote is executed by a Somnia validator subcommittee reaching its own consensus; the resolver contract is immutable wiring - the operator cannot dictate a winner, only void for refunds. Click any receipt to verify the raw request, sources and validator responses.</div>
    <div class="rz-votes">${voteHtml}</div>
    <div class="rz-consensus ${cls}">
      <div class="rz-row"><span>Rule</span><b>${rule}</b></div>
      <div class="rz-row"><span>Rounds used</span><b>${round.roundsUsed} / 4</b></div>
      <div class="rz-row"><span>Verdict</span><b class="rz-verdict">${verdict}</b></div>
    </div>`;
}

// ---------- odds chart (from on-chain BetPlaced logs) ----------
async function loadHistory(id, nOutcomes) {
  const events = await pmRead.queryFilter(pmRead.filters.BetPlaced(id));
  const pts = [], pools = new Array(nOutcomes).fill(0n);
  let total = 0n;
  for (const ev of events) {
    if (!blockTsCache.has(ev.blockNumber)) {
      const b = await provider.getBlock(ev.blockNumber);
      blockTsCache.set(ev.blockNumber, b.timestamp);
    }
    pools[Number(ev.args.outcome)] += ev.args.amount;
    total += ev.args.amount;
    pts.push({ t: blockTsCache.get(ev.blockNumber), shares: pools.map((p) => (total > 0n ? Number((p * 10000n) / total) / 100 : 0)) });
  }
  return pts;
}

async function renderChart(id, labels, m, pools) {
  const svg = $("dChart"), tip = $("dTip");
  tip.style.display = "none";
  svg.innerHTML = "";
  let pts, historyOk = true;
  try { pts = await loadHistory(id, labels.length); }
  catch (e) {
    historyOk = false; pts = [];
    if (m.total > 0n) {
      const shares = labels.map((_, i) => pctOf(pools[i], m.total));
      const nowS = Math.floor(Date.now() / 1000);
      pts = [{ t: nowS - 3600, shares }, { t: nowS, shares }];
    }
  }
  if (detailId !== id) return;

  const W = svg.clientWidth || 620, H = 240;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const padL = 8, padR = 74, padT = 10, padB = 22;
  const iw = W - padL - padR, ih = H - padT - padB;
  if (!pts.length) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="cempty">No bets yet - odds appear with the first bet</text>`;
    return;
  }

  const nowT = Math.min(Math.floor(Date.now() / 1000), Number(m.closeTs));
  const t0 = pts[0].t, t1 = Math.max(nowT, pts[pts.length - 1].t + 1);
  const x = (t) => padL + ((t - t0) / Math.max(1, t1 - t0)) * iw;
  const y = (pct) => padT + (1 - pct / 100) * ih;

  let g = "";
  for (const gv of [0, 25, 50, 75, 100]) {
    g += `<line x1="${padL}" y1="${y(gv)}" x2="${padL + iw}" y2="${y(gv)}" class="cgrid"/>`;
    g += `<text x="${padL + iw + 6}" y="${y(gv) + 3}" class="ctick">${gv}%</text>`;
  }
  const ft = (t) => new Date(t * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  g += `<text x="${padL}" y="${H - 6}" class="ctick">${ft(t0)}</text>`;
  g += `<text x="${padL + iw}" y="${H - 6}" text-anchor="end" class="ctick">${ft(t1)}</text>`;
  if (!historyOk) g += `<text x="${padL + iw / 2}" y="${H - 6}" text-anchor="middle" class="ctick">current odds (history unavailable on this RPC)</text>`;

  labels.forEach((lbl, i) => {
    let d = "";
    pts.forEach((p, k) => {
      const px = x(p.t), py = y(p.shares[i]);
      d += k === 0 ? `M${px.toFixed(1)},${py.toFixed(1)}` : `H${px.toFixed(1)}V${py.toFixed(1)}`;
    });
    d += `H${x(t1).toFixed(1)}`;
    g += `<path d="${d}" fill="none" stroke="${SERIES[i]}" stroke-width="2" stroke-linejoin="round"/>`;
  });
  if (labels.length <= 4) {
    const last = pts[pts.length - 1].shares, placed = [];
    labels.forEach((lbl, i) => {
      let ly = y(last[i]);
      while (placed.some((p) => Math.abs(p - ly) < 12)) ly += 12;
      placed.push(ly);
      g += `<circle cx="${x(t1)}" cy="${y(last[i])}" r="3.2" fill="${SERIES[i]}"/>`;
      g += `<text x="${x(t1) + 7}" y="${ly + 3.5}" class="clabel">${last[i].toFixed(0)}%</text>`;
    });
  }
  g += `<line id="cxLine" x1="0" y1="${padT}" x2="0" y2="${padT + ih}" class="cx" style="display:none"/>`;
  svg.innerHTML = g;

  const wrap = $("dChartWrap");
  wrap.onmousemove = (ev) => {
    const r = wrap.getBoundingClientRect(), mx = ev.clientX - r.left;
    if (mx < padL || mx > padL + iw) { wrap.onmouseleave(); return; }
    const tt = t0 + ((mx - padL) / iw) * (t1 - t0);
    let p = pts[0];
    for (const q of pts) { if (q.t <= tt) p = q; else break; }
    const line = $("cxLine");
    line.setAttribute("x1", mx); line.setAttribute("x2", mx); line.style.display = "";
    tip.style.display = "";
    tip.style.left = Math.min(mx + 12, W - 170) + "px";
    tip.innerHTML = `<div class="tt-t">${new Date(p.t * 1000).toLocaleTimeString()}</div>` +
      labels.map((lbl, i) => `<div class="tt-r"><i style="background:${SERIES[i]}"></i><span>${esc(lbl)}</span><b>${p.shares[i].toFixed(1)}%</b></div>`).join("");
  };
  wrap.onmouseleave = () => {
    tip.style.display = "none";
    const line = $("cxLine");
    if (line) line.style.display = "none";
  };
}

async function doTx(btn, fn, okMsg) {
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = "…";
  try {
    const tx = await fn();
    toast("Submitted " + tx.hash.slice(0, 10) + "…");
    await tx.wait();
    toast(okMsg, "ok");
  } catch (e) {
    toast(e.shortMessage || e.reason || e.message || "Transaction failed", "err");
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
}

$("backBtn").onclick = () => { detailId = null; showSection("markets"); renderMarkets(); };

/* ==================================================================
   CREATE WIZARD
   The contract needs a full Spec (sources, selectors, buckets, the
   machine directive the x-oracle parses). Asking a human for that is
   hostile, so the wizard asks 2-3 plain questions per format and
   builds the rest - then shows exactly what it built before signing.
   ================================================================== */

const synd = (id) => `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=a`;
const tweetId = (s) => {
  const m = String(s || "").match(/status\/(\d+)/) || String(s || "").match(/^(\d{5,25})$/);
  return m ? m[1] : "";
};
const handleOf = (s) => String(s || "").trim().replace(/^@/, "").replace(/^https?:\/\/(x|twitter)\.com\//i, "").split(/[/?]/)[0];
const dstr = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

const FORMATS = [
  {
    id: "viral", title: "Viral tweet", badge: ["dual", "2 SOURCES"],
    desc: "Will a tweet pass N likes by the deadline?",
    fields: [
      { k: "url", label: "Tweet link", ph: "https://x.com/user/status/1234567890" },
      { k: "n", label: "Likes threshold", ph: "50000", type: "number" },
    ],
    question: (v) => `Will this tweet pass ${Number(v.n || 0).toLocaleString()} likes by close?`,
    build: (v, id) => {
      const tid = tweetId(v.url);
      if (!tid) throw new Error("Paste a valid tweet link");
      const n = BigInt(Math.max(1, parseInt(v.n, 10) || 0));
      return {
        template: 0, outcomes: ["NO", "YES"],
        spec: {
          primaryUrl: `${id}.json`, primarySelector: "value",
          secondaryUrl: synd(tid), secondarySelector: "favorite_count",
          criteria: `Like count of the tweet at close | x:tweet=${tid};metric=likes`,
          bucketBounds: [n - 1n], raceUrls: [], raceSelectors: [], raceThreshold: 0,
        },
        sources: ["x-oracle measurement", "X public syndication endpoint (read directly by a second agent)"],
      };
    },
  },
  {
    id: "followers", title: "Follower milestone", badge: ["single", "SINGLE SOURCE"],
    desc: "Will an account reach N followers?",
    fields: [
      { k: "h", label: "Account", ph: "@Somnia_Network" },
      { k: "n", label: "Follower threshold", ph: "431000", type: "number" },
    ],
    question: (v) => `Will @${handleOf(v.h) || "account"} reach ${Number(v.n || 0).toLocaleString()} followers by close?`,
    build: (v, id) => {
      const h = handleOf(v.h);
      if (!h) throw new Error("Enter an account handle");
      const n = BigInt(Math.max(1, parseInt(v.n, 10) || 0));
      return {
        template: 1, outcomes: ["NO", "YES"],
        spec: {
          primaryUrl: `${id}.json`, primarySelector: "value", secondaryUrl: "", secondarySelector: "",
          criteria: `Follower count of @${h} at close | x:user=${h};metric=followers`,
          bucketBounds: [n - 1n], raceUrls: [], raceSelectors: [], raceThreshold: 0,
        },
        sources: ["x-oracle measurement (profile data is behind X's login wall - no public second reader)"],
      };
    },
  },
  {
    id: "posts", title: "Posts on a day", badge: ["single", "SINGLE SOURCE"],
    desc: "How many posts will an account publish on a given UTC day?",
    fields: [
      { k: "h", label: "Account", ph: "@elonmusk" },
      { k: "d", label: "UTC date", ph: "2026-07-21", type: "date" },
    ],
    question: (v) => `How many posts does @${handleOf(v.h) || "account"} publish on ${v.d || "the date"} (UTC)?`,
    build: (v, id) => {
      const h = handleOf(v.h);
      if (!h) throw new Error("Enter an account handle");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v.d || "")) throw new Error("Pick the UTC date");
      return {
        template: 2, outcomes: ["0-9", "10-19", "20+"],
        spec: {
          primaryUrl: `${id}.json`, primarySelector: "value", secondaryUrl: "", secondarySelector: "",
          criteria: `Posts by @${h} dated ${v.d} UTC | x:user=${h};metric=posts;date=${v.d}`,
          bucketBounds: [9n, 19n], raceUrls: [], raceSelectors: [], raceThreshold: 0,
        },
        sources: ["x-oracle measurement (timeline scan)"],
        closeAfter: Date.parse(v.d + "T00:00:00Z") + 86400000 + 600000, // day must be over
        closeNote: "The market must close after that UTC day ends, otherwise the count is not final.",
      };
    },
  },
  {
    id: "word", title: "Wrote a word or tag", badge: ["single", "SINGLE SOURCE"],
    desc: "Will an account post a tweet containing a given word?",
    fields: [
      { k: "h", label: "Account", ph: "@elonmusk" },
      { k: "q", label: "Word or @tag", ph: "Somnia" },
    ],
    question: (v) => `Will @${handleOf(v.h) || "account"} post a tweet containing "${v.q || "word"}"?`,
    build: (v, id) => {
      const h = handleOf(v.h), q = String(v.q || "").trim();
      if (!h) throw new Error("Enter an account handle");
      if (!q) throw new Error("Enter the word or tag to look for");
      const since = dstr(new Date());
      return {
        template: 1, outcomes: ["NO", "YES"],
        spec: {
          primaryUrl: `${id}.json`, primarySelector: "value", secondaryUrl: "", secondarySelector: "",
          criteria: `Own tweets by @${h} containing "${q}" since ${since} | x:user=${h};metric=mentions;q=${q};since=${since}`,
          bucketBounds: [0n], raceUrls: [], raceSelectors: [], raceThreshold: 0,
        },
        sources: [`x-oracle timeline scan of @${h} from ${since} (whole-word match)`],
      };
    },
  },
  {
    id: "reply", title: "Reply under a post", badge: ["single", "SINGLE SOURCE"],
    desc: "Will an account reply in a specific post's conversation?",
    fields: [
      { k: "h", label: "Account", ph: "@ShinyViq" },
      { k: "url", label: "Post link", ph: "https://x.com/user/status/1234567890" },
    ],
    question: (v) => `Will @${handleOf(v.h) || "account"} reply under this post by close?`,
    build: (v, id) => {
      const h = handleOf(v.h), tid = tweetId(v.url);
      if (!h) throw new Error("Enter an account handle");
      if (!tid) throw new Error("Paste a valid post link");
      return {
        template: 1, outcomes: ["NO", "YES"],
        spec: {
          primaryUrl: `${id}.json`, primarySelector: "value", secondaryUrl: "", secondarySelector: "",
          criteria: `Reply by @${h} in conversation ${tid} | x:user=${h};metric=replied;post=${tid}`,
          bucketBounds: [0n], raceUrls: [], raceSelectors: [], raceThreshold: 0,
        },
        sources: [`x-oracle timeline scan of @${h} for that conversation`],
      };
    },
  },
  {
    id: "race", title: "Race: whose tweet wins", badge: ["dual", "AGENT ARGMAX"],
    desc: "Which of these tweets has the most likes at close?",
    race: true,
    question: () => "Which of these tweets has the most likes at close?",
    build: (v, id) => {
      const rows = (v.rows || []).filter((r) => r.label && tweetId(r.url));
      if (rows.length < 2) throw new Error("Add at least 2 contenders with a label and a tweet link");
      if (rows.length > 7) throw new Error("Maximum 7 contenders");
      const ids = rows.map((r) => tweetId(r.url));
      return {
        template: 4, outcomes: [...rows.map((r) => r.label.trim()), "nobody/tie"],
        spec: {
          primaryUrl: `${id}.json`, primarySelector: "winner", secondaryUrl: "", secondarySelector: "",
          criteria: `Like counts at close | x:race;tweets=${ids.join(",")};metric=likes`,
          bucketBounds: [], raceUrls: ids.map(synd), raceSelectors: ids.map(() => "favorite_count"), raceThreshold: 0,
        },
        sources: ["x-oracle winner index", ...ids.map((t) => `X syndication for tweet ${t} (its own agent vote)`)],
        note: "The chain recomputes the argmax from the per-contender votes and requires it to match the oracle. A tie settles to \"nobody/tie\".",
      };
    },
  },
  {
    id: "freeform", title: "Freeform question", badge: ["llm", "3 LLM VOTES"],
    desc: "Any yes/no question answered by 3 independent LLM agents.",
    fields: [
      { k: "q", label: "Question (must be checkable from general knowledge)", ph: "Did Ethereum complete The Merge before 2023?", area: true },
    ],
    question: (v) => String(v.q || "").trim() || "Freeform question",
    build: (v) => {
      const q = String(v.q || "").trim();
      if (q.length < 10) throw new Error("Write the question in full");
      return {
        template: 3, outcomes: ["YES", "NO"],
        spec: {
          primaryUrl: "", primarySelector: "", secondaryUrl: "", secondarySelector: "",
          criteria: `Answer strictly from established fact. ${q}`,
          bucketBounds: [], raceUrls: [], raceSelectors: [], raceThreshold: 0,
        },
        sources: ["3 independent Somnia LLM agents, 2-of-3 must agree"],
        warn: "The LLM agent has NO internet access - it answers from model knowledge. Live X events cannot be resolved this way: the agents return UNRESOLVED and the market voids into refunds.",
      };
    },
  },
];

let wizFmt = null, wizVals = {}, wizQEdited = false, canCreate = false, createCost = 0n;

async function refreshCreateRights() {
  if (!pmRead) return;
  try {
    const [own, curated, fee, bond] = await Promise.all([
      pmRead.owner(), pmRead.curatedMode(), pmRead.creationFee(), pmRead.creatorBondAmount(),
    ]);
    createCost = fee + bond;
    const a = acct();
    canCreate = !curated || (!!a && (a.toLowerCase() === own.toLowerCase() || await pmRead.allowedCreators(a)));
    const btn = $("newBtn");
    if (btn) btn.style.display = canCreate ? "" : "none";
    const cost = $("wizCost");
    if (cost) cost.textContent = Number(E.formatEther(createCost)).toString();
  } catch (e) { /* leave hidden */ }
}

function fmtCard(f) {
  return `<button type="button" class="fmt ${wizFmt && wizFmt.id === f.id ? "on" : ""}" data-fmt="${f.id}">
    <b>${f.title}</b><span>${f.desc}</span><i class="${f.badge[0]}">${f.badge[1]}</i>
  </button>`;
}

function renderWizard() {
  $("fmtGrid").innerHTML = FORMATS.map(fmtCard).join("");
  document.querySelectorAll("[data-fmt]").forEach((b) => {
    b.onclick = () => {
      wizFmt = FORMATS.find((f) => f.id === b.dataset.fmt);
      wizVals = wizFmt.race ? { rows: [{ label: "", url: "" }, { label: "", url: "" }] } : {};
      wizQEdited = false;
      renderWizard();
      renderFields();
      $("wizForm").style.display = "";
      if (!$("wClose").value) setClose(1440);
      updatePreview();
    };
  });
}

function renderFields() {
  const f = wizFmt;
  let html = "";
  if (f.race) {
    html += `<label>Contenders (2-7)</label><div id="raceRows2" class="wiz-fields"></div>
      <button type="button" id="raceAdd2">+ add contender</button>`;
  } else {
    html += f.fields.map((fl) => `<label>${fl.label}
      ${fl.area ? `<textarea data-f="${fl.k}" placeholder="${fl.ph}"></textarea>`
                : `<input data-f="${fl.k}" type="${fl.type || "text"}" placeholder="${fl.ph}" />`}
    </label>`).join("");
  }
  html += `<label>Question shown to players
    <input id="wizQ" type="text" placeholder="auto-generated - edit if you like" />
  </label>`;
  $("wizFields").innerHTML = html;

  document.querySelectorAll("[data-f]").forEach((el) => {
    el.oninput = () => { wizVals[el.dataset.f] = el.value; syncQuestion(); updatePreview(); };
  });
  $("wizQ").oninput = () => { wizQEdited = true; updatePreview(); };
  if (f.race) renderRaceRows();
}

function renderRaceRows() {
  const root = $("raceRows2");
  root.innerHTML = wizVals.rows.map((r, i) => `<div class="racerow">
    <input data-r="${i}" data-rk="label" placeholder="Label, e.g. @elonmusk" value="${(r.label || "").replace(/"/g, "&quot;")}" />
    <input data-r="${i}" data-rk="url" placeholder="https://x.com/user/status/…" value="${(r.url || "").replace(/"/g, "&quot;")}" />
    <button type="button" data-rdel="${i}">×</button>
  </div>`).join("");
  root.querySelectorAll("[data-r]").forEach((el) => {
    el.oninput = () => { wizVals.rows[+el.dataset.r][el.dataset.rk] = el.value; updatePreview(); };
  });
  root.querySelectorAll("[data-rdel]").forEach((b) => {
    b.onclick = () => {
      if (wizVals.rows.length <= 2) return toast("A race needs at least 2 contenders", "err");
      wizVals.rows.splice(+b.dataset.rdel, 1); renderRaceRows(); updatePreview();
    };
  });
  $("raceAdd2").onclick = () => {
    if (wizVals.rows.length >= 7) return toast("Maximum 7 contenders", "err");
    wizVals.rows.push({ label: "", url: "" }); renderRaceRows();
  };
}

function syncQuestion() {
  if (wizQEdited || !wizFmt) return;
  $("wizQ").value = wizFmt.question(wizVals);
}

function setClose(mins) {
  const d = new Date(Date.now() + mins * 60000);
  const pad = (n) => String(n).padStart(2, "0");
  $("wClose").value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function buildDraft() {
  const built = wizFmt.build(wizVals, "<id>");
  const q = ($("wizQ").value || "").trim() || wizFmt.question(wizVals);
  if (q.length > 400) throw new Error("Question is too long (400 characters max)");
  const closeMs = Date.parse($("wClose").value);
  if (!closeMs) throw new Error("Pick when betting closes");
  if (closeMs < Date.now() + 11 * 60000) throw new Error("Closing time must be at least ~11 minutes out");
  if (built.closeAfter && closeMs < built.closeAfter) {
    throw new Error("This market must close after that UTC day ends - move the closing time later");
  }
  return { built, q, closeMs };
}

function updatePreview() {
  const box = $("wizPreview");
  let d;
  try { d = buildDraft(); }
  catch (e) {
    box.innerHTML = `<div class="prow" style="color:var(--fg-faint)">${esc(e.message)}</div>`;
    return;
  }
  const { built, q, closeMs } = d;
  const deadline = new Date(closeMs + 120 * 60000);
  box.innerHTML = `
    <div class="pq">${esc(q)}</div>
    <div class="outs">${built.outcomes.map((o) => `<span>${esc(o)}</span>`).join("")}</div>
    <div class="prow"><b>Closes</b><span>${new Date(closeMs).toLocaleString()} · resolves by ${deadline.toLocaleString()}</span></div>
    <div class="prow"><b>Sources</b><span>${built.sources.map(esc).join(" · ")}</span></div>
    <div class="prow"><b>Directive</b><code>${esc(built.spec.criteria)}</code></div>
    ${built.note ? `<div class="prow"><b></b><span>${esc(built.note)}</span></div>` : ""}
    ${built.warn ? `<div class="warn">${esc(built.warn)}</div>` : ""}`;
}

$("newBtn").onclick = () => {
  detailId = null;
  showSection("create");
  renderWizard();
  window.scrollTo({ top: 0, behavior: "smooth" });
};
$("createBack").onclick = () => { showSection("markets"); renderMarkets(); };
document.querySelectorAll(".wiz-quick button").forEach((b) => {
  b.onclick = () => { setClose(+b.dataset.in); updatePreview(); };
});
$("wClose").oninput = updatePreview;

$("wizSubmit").onclick = async () => {
  let d;
  try { d = buildDraft(); } catch (e) { return toast(e.message, "err"); }
  const btn = $("wizSubmit");
  const label = btn.innerHTML;
  try {
    const c = await writeContract();
    // the oracle publishes to <marketId>.json, so the id must be the one this
    // market is about to get - read it as late as possible
    const nextId = Number(await pmRead.marketCount());
    const built = wizFmt.build(wizVals, nextId);
    const closeTs = Math.floor(d.closeMs / 1000);
    const deadline = closeTs + 120 * 60;
    btn.disabled = true; btn.textContent = "Confirm in wallet…";
    const tx = await c.createMarket(built.template, d.q, built.outcomes, closeTs, deadline, built.spec, { value: createCost });
    toast("Submitted " + tx.hash.slice(0, 10) + "…");
    await tx.wait();
    toast(`Market #${nextId} created`, "ok");
    wizFmt = null; wizVals = {}; wizQEdited = false;
    $("wizForm").style.display = "none";
    showSection("markets");
    filterMode = "active";
    document.querySelectorAll("#pFilter button[data-filter]").forEach((x) => x.classList.toggle("on", x.dataset.filter === "active"));
    renderMarkets();
  } catch (e) {
    toast(e.shortMessage || e.reason || e.message || "Could not create the market", "err");
  } finally {
    btn.disabled = false;
    btn.innerHTML = label;
  }
};

init();
