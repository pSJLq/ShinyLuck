// account.html - supports two modes:
//   - owner mode  (no ?address param, or ?address matches connected wallet)
//                  → full UI: claim button, deposits/withdrawals from own events,
//                    write-capable actions
//   - read-only   (?address=0x… and either no wallet connected or the address
//                  belongs to someone else)
//                  → identical reads, but write buttons hidden, "READ-ONLY"
//                    pill displayed, share button surfaced
//
// All log queries flow through lib/rpc.js → raw eth_getLogs to dodge ethers v6
// BAD_DATA on Somnia. Recent activity comes from a 200k-block backwards-scan
// with early-exit at the requested row count; cold start is < 3s on a fresh
// page load when the cache is warm.

import { ethers } from "/vendor/ethers.bundle.js";
import { SL, connect, shortAddr } from "./wallet.js";
import { CONFIG } from "./config.js";
import { provider, fetchLogs, fetchRecentLogs, fetchDeploymentBlock } from "./rpc.js";
import "./ui.js"; // side-effect: injects `.sl-styled-input` + toast/modal CSS

const GAME_NAMES = ["DICE","CRASH","VAULT.7","MINES","PLINKO","ROULETTE","SUGAR.LAB"];
const ZERO = "0x0000000000000000000000000000000000000000";
// 20k blocks ≈ 7 hours on Somnia. Was 200k → cold-start scan took 30s+.
// Scan the FULL history since deployment. With fetchLogs now doing 8
// parallel chunk fetches, even 700K+ blocks complete in 3-5s. Account
// page shows the user's entire on-chain footprint, not just a window.
// (account.js's refresh clamps to max(deploymentBlock, head-LOOKBACK),
// so we set the lookback above any realistic deploy age; clamp picks
// deploymentBlock and scans from there.)
const LOOKBACK = 10_000_000;
const EXPLORER = "https://shannon-explorer.somnia.network";

let viewAddress = null;          // address being viewed (may differ from SL.address)
let isReadOnly = true;           // true if not the connected wallet
const cache = { settled: [], placed: [], deposits: [], claims: [] };

// Pagination state per tab. Page is reset to 0 on every fresh refresh so
// new bets surface immediately; the user explicitly navigates back via the
// pager buttons. 15 rows per page keeps the panel compact (no scrolling
// inside the page).
const PAGE_SIZE = 15;
const _page = { bets: 0, deposits: 0, withdrawals: 0, receipts: 0 };

/// Mount or update a pager strip directly after the given <table> element.
/// Wires Prev / Next buttons that call `onChange(newPageIdx)`.
function mountPager(parentPanel, totalRows, pageIdx, onChange) {
  let pager = parentPanel.querySelector(".sl-pager");
  if (!pager) {
    pager = document.createElement("div");
    pager.className = "sl-pager";
    parentPanel.appendChild(pager);
  }
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
  const safeIdx = Math.min(pageIdx, totalPages - 1);
  if (totalRows <= PAGE_SIZE) { pager.style.display = "none"; return; }
  pager.style.display = "flex";
  pager.innerHTML = `
    <button data-pg-prev ${safeIdx <= 0 ? "disabled" : ""}>← PREV</button>
    <span>PAGE ${safeIdx + 1} / ${totalPages} · ${totalRows} total</span>
    <button data-pg-next ${safeIdx >= totalPages - 1 ? "disabled" : ""}>NEXT →</button>
  `;
  pager.querySelector("[data-pg-prev]").onclick = () => onChange(Math.max(0, safeIdx - 1));
  pager.querySelector("[data-pg-next]").onclick = () => onChange(Math.min(totalPages - 1, safeIdx + 1));
}

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

/// Robust clipboard write: tries navigator.clipboard first, then falls back to
/// a hidden <textarea> + execCommand path so the button still works on http://
/// origins (navigator.clipboard requires a secure context, and on Windows
/// localhost some browsers still flake). Returns boolean.
async function copyToClipboard(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* fall through to legacy */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed; top:-9999px; left:-9999px;";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}
function fmtSTT(wei) {
  if (typeof wei !== "bigint") wei = BigInt(wei);
  const eth = Number(ethers.formatEther(wei));
  if (eth >= 1000) return eth.toFixed(0);
  if (eth >= 1) return eth.toFixed(2);
  if (eth >= 0.01) return eth.toFixed(3);
  return eth.toFixed(4);
}
function dayKey(ts) { return Math.floor(ts / 86400) * 86400; }
function explorerTx(h)   { return `${EXPLORER}/tx/${h}`; }
function explorerAddr(a) { return `${EXPLORER}/address/${a}`; }

// ---------------------------------------------------------------------------
// URL-driven viewer / owner switch
// ---------------------------------------------------------------------------

function readViewAddress() {
  try {
    // Pretty URL form: /u/0xabc…
    const m = location.pathname.match(/^\/u\/(0x[0-9a-fA-F]{40})\/?$/);
    if (m) return m[1].toLowerCase();
    // Legacy / shared link form: /account.html?address=0xabc…
    const url = new URL(location.href);
    const q = url.searchParams.get("address");
    if (!q) return null;
    if (!/^0x[0-9a-fA-F]{40}$/.test(q)) return null;
    return q.toLowerCase();
  } catch (_) { return null; }
}

function bindMode() {
  const queryAddr = readViewAddress();
  if (queryAddr) {
    viewAddress = queryAddr;
    isReadOnly = !SL.address || SL.address.toLowerCase() !== queryAddr;
  } else if (SL.address) {
    viewAddress = SL.address.toLowerCase();
    isReadOnly = false;
  } else {
    viewAddress = null;
    isReadOnly = true;
  }
  document.body.classList.toggle("read-only", isReadOnly);
  const pill = $("[data-sl-acc-readonly]");
  if (pill) pill.style.display = (queryAddr && isReadOnly) ? "inline-block" : "none";
  if (viewAddress) {
    $("[data-sl-acc-addr-short]").innerHTML =
      `${viewAddress.slice(0,6)}…<span style="color:var(--cyan)">${viewAddress.slice(-4)}</span>`;
    $("[data-sl-acc-addr-full]").textContent = viewAddress;
    const recvAddr = $("[data-sl-acc-receive-addr]");
    if (recvAddr) recvAddr.textContent = viewAddress;
    const faucet = $("[data-sl-acc-faucet]");
    if (faucet) faucet.href = `https://testnet.somnia.network/faucet?address=${viewAddress}`;
    const xlink = $("[data-sl-acc-explorer]");
    if (xlink) xlink.href = explorerAddr(viewAddress);
    const share = $("[data-sl-acc-share]");
    if (share) share.href = `${location.origin}/u/${viewAddress}`;
    const crumb = $("[data-sl-acc-crumb]");
    if (crumb) crumb.textContent = isReadOnly ? `Profile · ${viewAddress.slice(0,6)}…${viewAddress.slice(-4)}` : "Account";
    // (pretty /u/<addr> URLs require server-side rewrite - temporarily off
    // until we self-host with nginx or run a small router; keep the
    // canonical /account.html?address=… form for now.)
  } else {
    $("[data-sl-acc-addr-short]").textContent = "connect wallet";
    $("[data-sl-acc-addr-full]").textContent = "-";
  }
}

// ---------------------------------------------------------------------------
// Contract handle
// ---------------------------------------------------------------------------

const CASINO_ABI = [
  "function pendingWithdrawals(address) view returns (uint256)",
  "function getPlayerBets(address) view returns (uint256[])",
  "function getBet(uint256) view returns (tuple(address player,uint96 amount,uint8 game,uint8 status,uint64 commitBlock,uint64 nonce,uint256 seedIdx,bytes32 clientSeed,bytes params,bytes32 randomness,uint128 payout,bool won))",
  "event BetPlaced(uint256 indexed betId,address indexed player,uint8 indexed game,uint256 amount,bytes32 clientSeed,uint256 commitBlock,uint256 seedIdx,bytes params)",
  "event BetSettled(uint256 indexed betId,address indexed player,uint8 indexed game,bool won,uint256 payout,bytes32 randomness,bytes32 serverSeed,bytes32 clientSeed,bytes32 blockHash,uint256 nonce,bytes resultData)",
  "event WithdrawalClaimed(address indexed player,uint256 amount)",
  "event WithdrawalCredited(address indexed player,uint256 amount)",
  "event BankrollDeposited(address indexed from,uint256 amount)",
];

let _casino = null;
function casinoRO() {
  if (!_casino) {
    _casino = new ethers.Contract(CONFIG.casino, CASINO_ABI, provider());
  }
  return _casino;
}

let _historicalCasinos = null;

// In-memory cache for historical-event reads. Keyed by `${address}::${event}`.
// Frozen casino events (any contract that is NOT the current one) get cached
// for the whole session - they can't change. The current casino's events
// always refetch so new bets appear on the next 15 s tick.
const _historyCache = new Map();
function _historyFetch(entry, eventName, from, to) {
  if (!entry.isCurrent) {
    const key = `${entry.contract.target}::${eventName}`;
    const cached = _historyCache.get(key);
    if (cached) return cached;
    const p = fetchLogs(entry.contract, eventName, from, to);
    _historyCache.set(key, p);
    // If the fetch rejects, drop the cached promise so a later refresh can retry.
    p.catch(() => _historyCache.delete(key));
    return p;
  }
  return fetchLogs(entry.contract, eventName, from, to);
}
/// Build read-only Contract handles for every historical casino deployment,
/// sorted oldest → newest. Account aggregates events across all of them so
/// users see their full lifetime history (not just since the latest redeploy).
function historicalCasinos() {
  if (_historicalCasinos) return _historicalCasinos;
  const list = Array.isArray(CONFIG.historicalCasinos) ? CONFIG.historicalCasinos : [];
  const seen = new Set();
  const withCurrent = [...list];
  if (CONFIG.casino && !list.some((e) => e.address.toLowerCase() === CONFIG.casino.toLowerCase())) {
    withCurrent.push({ address: CONFIG.casino, deploymentBlock: 0 });
  }
  const out = [];
  for (const entry of withCurrent) {
    const lower = entry.address.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push({
      contract: new ethers.Contract(entry.address, CASINO_ABI, provider()),
      deploymentBlock: entry.deploymentBlock || 0,
      isCurrent: lower === (CONFIG.casino || "").toLowerCase(),
    });
  }
  out.sort((a, b) => a.deploymentBlock - b.deploymentBlock);
  _historicalCasinos = out;
  return _historicalCasinos;
}

// ---------------------------------------------------------------------------
// Stats / chart computation
// ---------------------------------------------------------------------------

function renderTopline(nativeBal, pending, pnl, betCount) {
  $("[data-sl-acc-balance]").textContent = fmtSTT(nativeBal);
  $("[data-sl-acc-pending]").textContent = fmtSTT(pending);
  const pnlEl = $("[data-sl-acc-pnl]");
  pnlEl.textContent = (pnl >= 0n ? "+ " : "− ") + fmtSTT(pnl < 0n ? -pnl : pnl) + " STT";
  pnlEl.style.color = pnl >= 0n ? "var(--green)" : "var(--red)";
  $("[data-sl-acc-bets]").textContent = `${betCount} bets · all-time`;
}

async function buildPnLChart(settled, stakeByBet) {
  // Daily cumulative P&L for the last 30 days. Need block→timestamp resolution
  // for each settled event; ethers' getBlock is the cheapest way and we cap
  // it at the events we actually have (rather than 30 separate getBlock calls).
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - 30 * 86400;
  const byDay = new Map();
  // bulk-fetch block timestamps via batch (sequential - provider doesn't
  // expose a true batch API, but the events are usually < 100)
  const uniqueBlocks = [...new Set(settled.map((ev) => ev.blockNumber))];
  const tsByBlock = new Map();
  await Promise.all(uniqueBlocks.map(async (n) => {
    try {
      const blk = await provider().getBlock(n);
      if (blk) tsByBlock.set(n, blk.timestamp);
    } catch (_) {}
  }));
  for (const ev of settled) {
    const ts = tsByBlock.get(ev.blockNumber);
    if (!ts || ts < cutoff) continue;
    // Same `${addr}::${betId}` key as the refresh() builder uses.
    const stake = BigInt(stakeByBet.get(`${ev.__addr || ""}::${ev.args.betId.toString()}`) || 0n);
    const delta = ev.args.won ? (BigInt(ev.args.payout) - stake) : -stake;
    const key = dayKey(ts);
    byDay.set(key, (byDay.get(key) || 0n) + delta);
  }
  // Build cumulative series across the last 30 day-buckets.
  const days = [];
  for (let d = 29; d >= 0; d--) {
    const k = dayKey(nowSec - d * 86400);
    const delta = byDay.get(k) || 0n;
    const prev = days.length ? days[days.length - 1].cum : 0n;
    days.push({ day: k, delta, cum: prev + delta });
  }
  // Render as SVG path.
  const W = 800, H = 200, padT = 14, padB = 24;
  const innerH = H - padT - padB;
  const values = days.map((d) => Number(ethers.formatEther(d.cum)));
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values, 0.001);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / 29) * W;
    const y = padT + (1 - (v - min) / range) * innerH;
    return { x, y, v };
  });
  const linePath = pts.map((p, i) => (i === 0 ? `M${p.x.toFixed(1)},${p.y.toFixed(1)}` : `L${p.x.toFixed(1)},${p.y.toFixed(1)}`)).join(" ");
  const fillPath = `${linePath} L${pts[pts.length - 1].x.toFixed(1)},${H - padB} L0,${H - padB} Z`;
  const chart = $("[data-sl-acc-chart]");
  if (chart) {
    chart.querySelector(".acc-chart-fill").setAttribute("d", fillPath);
    chart.querySelector(".acc-chart-line").setAttribute("d", linePath);
    chart.querySelector("[data-sl-acc-chart-max]").textContent = "+" + max.toFixed(2);
    chart.querySelector("[data-sl-acc-chart-min]").textContent = min.toFixed(2);
    const axis = chart.querySelector("[data-sl-acc-chart-axis]");
    axis.innerHTML = "";
    // Sparse weekly tick labels
    for (let i = 0; i < days.length; i += 7) {
      const d = new Date(days[i].day * 1000);
      const txt = `${d.getMonth() + 1}/${d.getDate()}`;
      const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
      t.setAttribute("x", (i / 29) * W);
      t.setAttribute("y", H - 6);
      t.setAttribute("class", "acc-chart-axis");
      t.textContent = txt;
      axis.appendChild(t);
    }
  }
}

// ---------------------------------------------------------------------------
// Tab rendering
// ---------------------------------------------------------------------------

function renderBetsTab(settled, stakeByBet) {
  const body = $("[data-sl-acc-bets-body]");
  const panel = body?.closest('[data-sl-acc-tab-panel="bets"]');
  body.innerHTML = "";
  if (settled.length === 0) {
    body.innerHTML = `<tr><td class="dim" colspan="6">no settled bets in window</td></tr>`;
    if (panel) mountPager(panel, 0, 0, () => {});
    return;
  }
  // Clamp page to the available range - defensive against stale state.
  const totalPages = Math.max(1, Math.ceil(settled.length / PAGE_SIZE));
  if (_page.bets >= totalPages) _page.bets = 0;
  const start = _page.bets * PAGE_SIZE;
  const slice = settled.slice(start, start + PAGE_SIZE);
  for (const ev of slice) {
    const game = GAME_NAMES[Number(ev.args.game)] || "?";
    const stakeWei = BigInt(stakeByBet.get(`${ev.__addr || ""}::${ev.args.betId.toString()}`) || 0n);
    const stake = stakeWei > 0n ? fmtSTT(stakeWei) : "-";
    const won = ev.args.won;
    const payout = BigInt(ev.args.payout);
    let mult = "-";
    if (stakeWei > 0n && payout > 0n) {
      const x100 = (payout * 100n) / stakeWei;
      mult = (Number(x100) / 100).toFixed(2) + "×";
    }
    // Net P&L = payout - stake. The contract sets `won=true` whenever
    // payout > 0, but in cluster/slot games a "win" can still be smaller
    // than the stake (partial-payout cascade) - that's a net loss for the
    // player. Show the actual delta + sign instead of a hardcoded
    // ± stake. Zero-payout (won=false) collapses naturally to −stake.
    const net = payout - stakeWei;
    let pnlText, pnlColor;
    if (net > 0n)      { pnlText = "+ " + fmtSTT(net);  pnlColor = "var(--green)"; }
    else if (net < 0n) { pnlText = "− " + fmtSTT(-net); pnlColor = "var(--red)"; }
    else               { pnlText = "0";                  pnlColor = "var(--fg-mute)"; }
    const gId = Number(ev.args.game);
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td><a href="${explorerTx(ev.transactionHash)}" target="_blank" rel="noopener" class="tbl-dim" style="color:var(--fg-mute);">#${ev.args.betId}</a></td>` +
      `<td><span class="game-tag g-${gId}">${game}</span></td>` +
      `<td class="tbl-dim">${stake} STT</td>` +
      `<td>${won ? "won" : "lost"}</td>` +
      `<td class="tbl-dim">${mult}</td>` +
      `<td style="color:${pnlColor}">${pnlText}</td>`;
    body.appendChild(tr);
  }
  if (panel) mountPager(panel, settled.length, _page.bets, (idx) => {
    _page.bets = idx;
    renderBetsTab(settled, stakeByBet);
  });
}

function renderEventTable(bodySel, events, valueExtract, pageKey) {
  const body = $(bodySel);
  const panel = body?.closest("[data-sl-acc-tab-panel]");
  body.innerHTML = "";
  if (events.length === 0) {
    // Explain what would land here so the user doesn't think the page is
    // broken. "Deposits" = bankroll contributions (rare); "Withdrawals" =
    // user-initiated claim() calls on the casino's pending balance.
    const hint = pageKey === "withdrawals"
      ? "no withdrawals yet - press <b>Claim</b> on top of this page to withdraw your pending winnings"
      : pageKey === "deposits"
      ? "no bankroll contributions from this wallet - this tab shows when you fund the casino bankroll via depositBankroll()"
      : "no events in window";
    body.innerHTML = `<tr><td class="dim" colspan="3" style="padding: 18px;">${hint}</td></tr>`;
    if (panel && pageKey) mountPager(panel, 0, 0, () => {});
    return;
  }
  const totalPages = Math.max(1, Math.ceil(events.length / PAGE_SIZE));
  if (pageKey && _page[pageKey] >= totalPages) _page[pageKey] = 0;
  const start = (pageKey ? _page[pageKey] : 0) * PAGE_SIZE;
  const slice = pageKey ? events.slice(start, start + PAGE_SIZE) : events;
  for (const ev of slice) {
    const wei = valueExtract(ev);
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="dim">${ev.blockNumber}</td>` +
      `<td><a href="${explorerTx(ev.transactionHash)}" target="_blank" rel="noopener" style="color:var(--cyan);">${ev.transactionHash.slice(0,10)}…</a></td>` +
      `<td>${fmtSTT(wei)} STT</td>`;
    body.appendChild(tr);
  }
  if (panel && pageKey) mountPager(panel, events.length, _page[pageKey], (idx) => {
    _page[pageKey] = idx;
    renderEventTable(bodySel, events, valueExtract, pageKey);
  });
}

function renderReceipts(settled) {
  const body = $("[data-sl-acc-receipts-body]");
  const panel = body?.closest('[data-sl-acc-tab-panel="receipts"]');
  body.innerHTML = "";
  if (settled.length === 0) {
    body.innerHTML = `<tr><td class="dim" colspan="5">no settled bets in window</td></tr>`;
    if (panel) mountPager(panel, 0, 0, () => {});
    return;
  }
  const totalPages = Math.max(1, Math.ceil(settled.length / PAGE_SIZE));
  if (_page.receipts >= totalPages) _page.receipts = 0;
  const start = _page.receipts * PAGE_SIZE;
  for (const ev of settled.slice(start, start + PAGE_SIZE)) {
    const game = GAME_NAMES[Number(ev.args.game)] || "?";
    const won = ev.args.won;
    const payout = BigInt(ev.args.payout);
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="tbl-dim">#${ev.args.betId}</td>` +
      `<td><span class="game-tag g-${Number(ev.args.game)}">${game}</span></td>` +
      `<td class="tbl-dim">${fmtSTT(payout)} STT</td>` +
      `<td style="color:${won ? 'var(--green)' : 'var(--red)'}">${won ? "WON" : "LOST"}</td>` +
      `<td><a href="fair.html?betId=${ev.args.betId}" data-link style="color:var(--cyan);">open receipt →</a></td>`;
    body.appendChild(tr);
  }
  if (panel) mountPager(panel, settled.length, _page.receipts, (idx) => {
    _page.receipts = idx;
    renderReceipts(settled);
  });
}

function bindTabs() {
  $$("[data-sl-acc-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = tab.dataset.slAccTab;
      $$("[data-sl-acc-tab]").forEach((t) => t.classList.toggle("on", t === tab));
      $$("[data-sl-acc-tab-panel]").forEach((p) => {
        p.style.display = p.dataset.slAccTabPanel === name ? "" : "none";
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Main refresh
// ---------------------------------------------------------------------------

async function refresh() {
  bindMode();
  if (!viewAddress) return;
  if (CONFIG.casino === ZERO) return;
  const c = casinoRO();

  // STEP 1 - instant render of balance + pending (2 RPCs, <300ms).
  // These are the numbers the user looks at first; everything else
  // (P&L, bet history) can fill in once the log scan finishes.
  try {
    const [nativeBal0, pending0] = await Promise.all([
      provider().getBalance(viewAddress),
      c.pendingWithdrawals(viewAddress),
    ]);
    $("[data-sl-acc-balance]").textContent = fmtSTT(nativeBal0);
    $("[data-sl-acc-pending]").textContent = fmtSTT(pending0);
  } catch (e) { console.warn("[acc] quick-render failed:", e.message); }

  const head = await provider().getBlockNumber();

  // STEP 2 - aggregate full history across every historical casino. Each
  // contract gets one Shannon Explorer call per event-type, scoped to the
  // (deploymentBlock, next-deploy - 1) range so explorer responses stay
  // under the 1000-log/page limit and we don't waste calls on empty ranges.
  //
  // Why aggregate: 'за всё время' means lifetime, including bets placed on
  // older deployments. The current-only path showed empty history right
  // after each redeploy until a new bet landed.
  const contracts = historicalCasinos();
  const nextDeployBlock = (i) => (i + 1 < contracts.length ? contracts[i + 1].deploymentBlock - 1 : head);

  const allPlaced = [], allSettled = [], allClaims = [], allDeposits = [];
  const perContractFetches = [];
  // Tag fetched events with their source contract address so the BetPlaced →
  // BetSettled stake lookup can use a `${addr}::${betId}` key (betId space
  // is per-contract, so cross-contract aggregation collides without this).
  const tag = (addr) => (evs) => { for (const ev of evs) ev.__addr = addr.toLowerCase(); return evs; };
  contracts.forEach((entry, i) => {
    const from = entry.deploymentBlock || 0;
    const to = nextDeployBlock(i);
    const addr = entry.contract.target;
    // Old casinos are frozen - their event lists never change. Cache them
    // in-memory for the whole session so the 15 s account refresh tick
    // only re-hits the explorer for the CURRENT contract. Saves ~8 HTTP
    // requests per refresh on a 3-deployment history.
    perContractFetches.push(
      _historyFetch(entry, "BetPlaced",        from, to).then(tag(addr)).then((evs) => allPlaced.push(...evs)).catch(() => {}),
      _historyFetch(entry, "BetSettled",       from, to).then(tag(addr)).then((evs) => allSettled.push(...evs)).catch(() => {}),
      _historyFetch(entry, "WithdrawalClaimed",from, to).then(tag(addr)).then((evs) => allClaims.push(...evs)).catch(() => {}),
      // BankrollDeposited may not exist on the deployed casino (old ABI) -
      // swallowed by .catch so the panel still renders the rest.
      _historyFetch(entry, "BankrollDeposited",from, to).then(tag(addr)).then((evs) => allDeposits.push(...evs)).catch(() => {}),
    );
  });

  const [nativeBal, pending] = await Promise.all([
    provider().getBalance(viewAddress),
    c.pendingWithdrawals(viewAddress),
    ...perContractFetches,
  ]);

  const myPlaced = allPlaced.filter((ev) => ev.args.player.toLowerCase() === viewAddress);
  const mySettled = allSettled.filter((ev) => ev.args.player.toLowerCase() === viewAddress);
  const myClaims = allClaims.filter((ev) => ev.args.player.toLowerCase() === viewAddress);
  const myDeposits = allDeposits.filter((ev) => ev.args.from.toLowerCase() === viewAddress);
  mySettled.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);

  // Stake map keyed by `${contractAddress}::${betId}` - betId space is
  // per-contract, so without the address prefix bet #100 on the old casino
  // would silently borrow bet #100's stake from a newer casino.
  const stakeByBet = new Map();
  const stakeKey = (ev) => `${ev.__addr || ""}::${ev.args.betId.toString()}`;
  for (const ev of myPlaced) stakeByBet.set(stakeKey(ev), ev.args.amount);

  // P&L aggregate
  let bets = 0, wins = 0, wagered = 0n, returned = 0n, biggestWin = 0n, streak = 0, longest = 0;
  const byGame = new Map();
  // streak in chronological order
  const chrono = [...mySettled].reverse();
  for (const ev of chrono) {
    bets++;
    const stake = BigInt(stakeByBet.get(stakeKey(ev)) || 0n);
    wagered += stake;
    returned += BigInt(ev.args.payout);
    if (ev.args.won) {
      wins++;
      streak++;
      if (streak > longest) longest = streak;
      const win = BigInt(ev.args.payout) - stake;
      if (win > biggestWin) biggestWin = win;
    } else {
      streak = 0;
    }
    byGame.set(Number(ev.args.game), (byGame.get(Number(ev.args.game)) || 0) + 1);
  }
  const pnl = returned - wagered;

  renderTopline(nativeBal, pending, pnl, bets);

  $("[data-sl-acc-stat-bets]").textContent = bets;
  $("[data-sl-acc-stat-wins]").textContent = wins;
  $("[data-sl-acc-stat-winrate]").textContent = bets > 0 ? ((wins / bets) * 100).toFixed(1) + "%" : "-";
  $("[data-sl-acc-stat-wagered]").textContent = fmtSTT(wagered) + " STT";
  $("[data-sl-acc-stat-returned]").textContent = fmtSTT(returned) + " STT";
  $("[data-sl-acc-stat-biggestwin]").textContent = "+ " + fmtSTT(biggestWin) + " STT";
  $("[data-sl-acc-stat-streak]").textContent = `${longest} W`;

  const fav = $("[data-sl-acc-fav]");
  fav.innerHTML = "";
  if (byGame.size === 0) {
    fav.innerHTML = `<div class="ft" style="opacity:.4;">no bets yet</div>`;
  } else {
    const sorted = [...byGame.entries()].sort((a, b) => b[1] - a[1]);
    for (const [g, n] of sorted) {
      const div = document.createElement("div");
      div.className = "ft";
      div.innerHTML = `${GAME_NAMES[g]}<b>${n}</b>`;
      fav.appendChild(div);
    }
  }

  // Tabs (pagination key drives state per-table)
  renderBetsTab(mySettled, stakeByBet);
  renderEventTable("[data-sl-acc-withdrawals-body]", myClaims,
                   (ev) => BigInt(ev.args.amount), "withdrawals");
  renderEventTable("[data-sl-acc-deposits-body]", myDeposits,
                   (ev) => BigInt(ev.args.amount), "deposits");
  renderReceipts(mySettled);

  // Chart
  await buildPnLChart(mySettled, stakeByBet);

  // Player agent (requires SL.registry, only meaningful for self-mode but
  // we still try if the registry exists on the read-only path).
  if (CONFIG.registry && CONFIG.registry !== ZERO) {
    try {
      const regAbi = [
        "function getPermission(address) view returns (tuple(address player,address vault,bytes32 strategyHash,uint256 dailyLimit,uint256 totalLimit,uint8 allowedGamesMask,bool active,uint256 spentToday,uint256 spentTotal,uint64 lastResetDay))",
      ];
      const reg = new ethers.Contract(CONFIG.registry, regAbi, provider());
      const perm = await reg.getPermission(viewAddress);
      if (perm.player !== ZERO) {
        $("[data-sl-acc-agent-status]").textContent = perm.active ? "ACTIVE" : "PAUSED";
        $("[data-sl-acc-agent-vault]").textContent = shortAddr(perm.vault);
        $("[data-sl-acc-agent-daily]").textContent = fmtSTT(perm.spentToday) + " / " + fmtSTT(perm.dailyLimit) + " STT";
      } else {
        $("[data-sl-acc-agent-status]").textContent = "NOT REGISTERED";
        $("[data-sl-acc-agent-vault]").textContent = "-";
        $("[data-sl-acc-agent-daily]").textContent = "-";
      }
    } catch (e) {
      console.warn("[acc] permission read failed:", e.message);
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  bindTabs();
  bindMode();
  // Page shell is always visible now - refresh() does a quick balance
  // render in <300ms and the full history fills in progressively.

  // The splash loader should stay visible until ALL the data is in. The
  // previous version dispatched `shinyluck:ready` from refresh().finally
  // - but if the user wasn't connected yet, refresh() early-returns
  // (viewAddress is null) and dashed placeholders flash before the
  // `shinyluck:connected` event fires + a second refresh() actually
  // loads the data. Result: splash → dashes → numbers appear ~1-2s later.
  // Sequence we want instead:
  //   1. Splash on.
  //   2. Wait for Privy ready.
  //   3. If authenticated → run refresh() → dispatch ready when DONE.
  //   4. If NOT authenticated → dispatch ready immediately (page shows
  //      "connect wallet" state, no dashes).
  // Safety timeout 10 s either way so the loader never traps the page.
  let readyFired = false;
  const fireReady = () => {
    if (readyFired) return;
    readyFired = true;
    delete document.body.dataset.loading;
    document.dispatchEvent(new CustomEvent("shinyluck:ready"));
  };
  const startInitialLoad = async () => {
    const auth = window.ShinyLuckAuth;
    // Address may need a beat to populate after Privy reports ready.
    let tries = 30; // ~3s
    while (tries-- > 0 && (!auth || !auth.address)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (window.ShinyLuckAuth?.address) {
      try { await refresh(); } catch (e) { console.warn("[acc] initial refresh:", e.message); }
    }
    fireReady();
  };
  startInitialLoad();
  setTimeout(fireReady, 10_000); // safety net
  document.addEventListener("shinyluck:connected", () => refresh().catch(() => {}));

  $("[data-sl-acc-copy]")?.addEventListener("click", async () => {
    const text = viewAddress || SL.address || "";
    const btn = $("[data-sl-acc-copy]");
    if (!text) {
      const { toast } = await import("./ui.js");
      toast("no address yet - connect a wallet first", { kind: "warn" });
      return;
    }
    const ok = await copyToClipboard(text);
    if (ok && btn) {
      const old = btn.textContent;
      btn.textContent = "✓ copied";
      setTimeout(() => { btn.textContent = old; }, 1500);
    } else {
      const { toast } = await import("./ui.js");
      toast("Couldn't copy - copy manually: " + text, { kind: "error", ttl: 8000 });
    }
  });
  $("[data-sl-acc-share]")?.addEventListener("click", async (e) => {
    if (!viewAddress) return;
    e.preventDefault();
    const url = `${location.origin}/u/${viewAddress}`;
    if (navigator.share) {
      try { await navigator.share({ title: "ShinyLuck profile", url }); return; } catch (_) {}
    }
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(url);
      const btn = $("[data-sl-acc-share]");
      const old = btn.textContent;
      btn.textContent = "✓ link copied";
      setTimeout(() => { btn.textContent = old; }, 1800);
    }
  });
  $("[data-sl-acc-claim]")?.addEventListener("click", async () => {
    if (isReadOnly) return;
    await connect();
    try {
      const tx = await SL.casino.claim();
      await tx.wait();
      refresh();
    } catch (e) {
      const { toast } = await import("./ui.js");
      toast(e.shortMessage || e.message, { kind: "error", ttl: 6000 });
    }
  });

  // Receive / send (only meaningful for your own profile).
  $("[data-sl-acc-copy-receive]")?.addEventListener("click", async () => {
    const addr = $("[data-sl-acc-receive-addr]").textContent;
    if (!addr || addr === "-") return;
    const ok = await copyToClipboard(addr);
    const b = $("[data-sl-acc-copy-receive]");
    if (ok && b) {
      const old = b.textContent;
      b.textContent = "✓ copied";
      setTimeout(() => { b.textContent = old; }, 1500);
    } else if (!ok) {
      const { toast } = await import("./ui.js");
      toast("Couldn't copy - copy manually: " + addr, { kind: "error", ttl: 8000 });
    }
  });

  $("[data-sl-acc-send]")?.addEventListener("click", async () => {
    if (isReadOnly) return;
    const to  = $("[data-sl-acc-send-to]").value.trim();
    const amt = $("[data-sl-acc-send-amt]").value.trim();
    const msg = $("[data-sl-acc-send-msg]");
    msg.style.color = "var(--fg-mute)";
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) { msg.textContent = "Invalid address"; msg.style.color = "var(--red)"; return; }
    if (!amt || isNaN(parseFloat(amt)) || parseFloat(amt) <= 0) { msg.textContent = "Invalid amount"; msg.style.color = "var(--red)"; return; }
    try {
      msg.textContent = "Sending…";
      await connect();
      const value = ethers.parseEther(String(amt));
      const tx = await SL.signer.sendTransaction({ to, value });
      msg.textContent = `Pending tx ${tx.hash.slice(0,12)}…`;
      await tx.wait();
      msg.textContent = `✓ Sent ${amt} STT to ${to.slice(0,6)}…${to.slice(-4)}`;
      msg.style.color = "var(--green)";
      $("[data-sl-acc-send-to]").value = "";
      $("[data-sl-acc-send-amt]").value = "";
      refresh();
    } catch (e) {
      msg.textContent = "Failed: " + (e.shortMessage || e.message);
      msg.style.color = "var(--red)";
    }
  });
  setInterval(() => { if (viewAddress) refresh().catch(() => {}); }, 15_000);

  // Real-time WS refresh - subscribe to the CURRENT casino's BetSettled +
  // WithdrawalClaimed + BankrollDeposited events filtered by the viewed
  // address. Any hit → debounced refresh() so the page updates the moment
  // the chain confirms, not on the 15s tick.
  import("./rpc.js").then(({ wsProvider }) => {
    const ws = wsProvider && wsProvider();
    if (!ws || !CONFIG.casino || CONFIG.casino === ZERO) return;
    const c = casinoRO();
    let debounce = null;
    const triggerRefresh = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        if (viewAddress) refresh().catch(() => {});
      }, 350); // bundle multiple events from the same block
    };
    // BetSettled - topic[2] is `player` (indexed). Padded to 32-byte hex.
    const padAddr = (a) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
    const subscribe = (eventName, topicIdx) => {
      try {
        const topic0 = c.interface.getEvent(eventName).topicHash;
        const filter = { address: CONFIG.casino, topics: [topic0] };
        // We can't pre-bind to viewAddress here because it can change after
        // mount (user switches wallet) - match in the handler instead.
        ws.on(filter, (log) => {
          try {
            const parsed = c.interface.parseLog(log);
            const cand = parsed.args.player || parsed.args.from;
            if (!cand || !viewAddress) return;
            if (String(cand).toLowerCase() !== viewAddress) return;
            triggerRefresh();
          } catch (_) {}
        });
      } catch (_) { /* event may not exist on legacy ABI */ }
    };
    subscribe("BetSettled");
    subscribe("WithdrawalClaimed");
    subscribe("BankrollDeposited");
    console.log("[acc] WS subs active for", CONFIG.casino);
  }).catch(() => {});
});
