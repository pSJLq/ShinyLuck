// account.html — supports two modes:
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

import { ethers } from "https://esm.sh/ethers@6.13.2";
import { SL, connect, shortAddr } from "./wallet.js";
import { CONFIG } from "./config.js";
import { provider, fetchLogs, fetchRecentLogs, fetchDeploymentBlock } from "./rpc.js";
import "./ui.js"; // side-effect: injects `.sl-styled-input` + toast/modal CSS

const GAME_NAMES = ["DICE","CRASH","VAULT.7","MINES","PLINKO","ROULETTE","SUGAR.LAB"];
const ZERO = "0x0000000000000000000000000000000000000000";
// 20k blocks ≈ 7 hours on Somnia. Was 200k → cold-start scan took 30s+.
const LOOKBACK = 20_000;
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
    // (pretty /u/<addr> URLs require server-side rewrite — temporarily off
    // until we self-host with nginx or run a small router; keep the
    // canonical /account.html?address=… form for now.)
  } else {
    $("[data-sl-acc-addr-short]").textContent = "connect wallet";
    $("[data-sl-acc-addr-full]").textContent = "—";
  }
}

// ---------------------------------------------------------------------------
// Contract handle
// ---------------------------------------------------------------------------

let _casino = null;
function casinoRO() {
  if (!_casino) {
    _casino = new ethers.Contract(CONFIG.casino, [
      "function pendingWithdrawals(address) view returns (uint256)",
      "function getPlayerBets(address) view returns (uint256[])",
      "function getBet(uint256) view returns (tuple(address player,uint96 amount,uint8 game,uint8 status,uint64 commitBlock,uint64 nonce,uint256 seedIdx,bytes32 clientSeed,bytes params,bytes32 randomness,uint128 payout,bool won))",
      "event BetPlaced(uint256 indexed betId,address indexed player,uint8 indexed game,uint256 amount,bytes32 clientSeed,uint256 commitBlock,uint256 seedIdx,bytes params)",
      "event BetSettled(uint256 indexed betId,address indexed player,uint8 indexed game,bool won,uint256 payout,bytes32 randomness,bytes32 serverSeed,bytes32 clientSeed,bytes32 blockHash,uint256 nonce,bytes resultData)",
      "event WithdrawalClaimed(address indexed player,uint256 amount)",
      "event WithdrawalCredited(address indexed player,uint256 amount)",
      "event BankrollDeposited(address indexed from,uint256 amount)",
    ], provider());
  }
  return _casino;
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
  $("[data-sl-acc-bets]").textContent = `${betCount} bets · last ${LOOKBACK} blocks`;
}

async function buildPnLChart(settled, stakeByBet) {
  // Daily cumulative P&L for the last 30 days. Need block→timestamp resolution
  // for each settled event; ethers' getBlock is the cheapest way and we cap
  // it at the events we actually have (rather than 30 separate getBlock calls).
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - 30 * 86400;
  const byDay = new Map();
  // bulk-fetch block timestamps via batch (sequential — provider doesn't
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
    const stake = BigInt(stakeByBet.get(ev.args.betId.toString()) || 0n);
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
  // Clamp page to the available range — defensive against stale state.
  const totalPages = Math.max(1, Math.ceil(settled.length / PAGE_SIZE));
  if (_page.bets >= totalPages) _page.bets = 0;
  const start = _page.bets * PAGE_SIZE;
  const slice = settled.slice(start, start + PAGE_SIZE);
  for (const ev of slice) {
    const game = GAME_NAMES[Number(ev.args.game)] || "?";
    const stakeWei = BigInt(stakeByBet.get(ev.args.betId.toString()) || 0n);
    const stake = stakeWei > 0n ? fmtSTT(stakeWei) : "—";
    const won = ev.args.won;
    const payout = BigInt(ev.args.payout);
    let mult = "—";
    if (stakeWei > 0n && payout > 0n) {
      const x100 = (payout * 100n) / stakeWei;
      mult = (Number(x100) / 100).toFixed(2) + "×";
    }
    let pnlText, pnlColor;
    if (won) { pnlText = "+ " + fmtSTT(payout - stakeWei); pnlColor = "var(--green)"; }
    else     { pnlText = "− " + fmtSTT(stakeWei);          pnlColor = "var(--red)"; }
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
    body.innerHTML = `<tr><td class="dim" colspan="3">no events in window</td></tr>`;
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

  const dep = await fetchDeploymentBlock();
  const head = await provider().getBlockNumber();
  // Clamp to contract age — never scan blocks before deploy.
  const fromBlock = dep > 0 ? Math.max(dep, head - LOOKBACK) : (head - LOOKBACK);

  // All reads in parallel.
  const [nativeBal, pending, placed, settled, claims, deposits] = await Promise.all([
    provider().getBalance(viewAddress),
    c.pendingWithdrawals(viewAddress),
    fetchLogs(c, "BetPlaced",        fromBlock, head),
    fetchLogs(c, "BetSettled",       fromBlock, head),
    fetchLogs(c, "WithdrawalClaimed",fromBlock, head),
    // BankrollDeposited may not exist on the deployed casino (old ABI) —
    // fetchLogs swallows the topic-mismatch case via its inner try/catch,
    // so we just get [] in that case rather than throwing.
    fetchLogs(c, "BankrollDeposited",fromBlock, head).catch(() => []),
  ]);

  const myPlaced = placed.filter((ev) => ev.args.player.toLowerCase() === viewAddress);
  const mySettled = settled.filter((ev) => ev.args.player.toLowerCase() === viewAddress);
  const myClaims = claims.filter((ev) => ev.args.player.toLowerCase() === viewAddress);
  const myDeposits = deposits.filter((ev) => ev.args.from.toLowerCase() === viewAddress);
  mySettled.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);

  const stakeByBet = new Map();
  for (const ev of myPlaced) stakeByBet.set(ev.args.betId.toString(), ev.args.amount);

  // P&L aggregate
  let bets = 0, wins = 0, wagered = 0n, returned = 0n, biggestWin = 0n, streak = 0, longest = 0;
  const byGame = new Map();
  // streak in chronological order
  const chrono = [...mySettled].reverse();
  for (const ev of chrono) {
    bets++;
    const stake = BigInt(stakeByBet.get(ev.args.betId.toString()) || 0n);
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
  $("[data-sl-acc-stat-winrate]").textContent = bets > 0 ? ((wins / bets) * 100).toFixed(1) + "%" : "—";
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
        $("[data-sl-acc-agent-vault]").textContent = "—";
        $("[data-sl-acc-agent-daily]").textContent = "—";
      }
    } catch (e) {
      console.warn("[acc] permission read failed:", e.message);
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  bindTabs();
  bindMode();
  // Loading gate: hide page-shell + splash holds until refresh() lands once.
  document.body.dataset.loading = "1";
  refresh()
    .catch((e) => console.warn("[acc] initial refresh:", e.message))
    .finally(() => {
      delete document.body.dataset.loading;
      document.dispatchEvent(new CustomEvent("shinyluck:ready"));
    });
  document.addEventListener("shinyluck:connected", () => refresh().catch(() => {}));

  $("[data-sl-acc-copy]")?.addEventListener("click", async () => {
    const text = viewAddress || SL.address || "";
    const btn = $("[data-sl-acc-copy]");
    if (!text) {
      const { toast } = await import("./ui.js");
      toast("no address yet — connect a wallet first", { kind: "warn" });
      return;
    }
    const ok = await copyToClipboard(text);
    if (ok && btn) {
      const old = btn.textContent;
      btn.textContent = "✓ copied";
      setTimeout(() => { btn.textContent = old; }, 1500);
    } else {
      const { toast } = await import("./ui.js");
      toast("Couldn't copy — copy manually: " + text, { kind: "error", ttl: 8000 });
    }
  });
  $("[data-sl-acc-share]")?.addEventListener("click", async (e) => {
    if (!viewAddress) return;
    e.preventDefault();
    const url = `${location.origin}${location.pathname.replace(/[^/]+$/, "account.html")}?address=${viewAddress}`;
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
    if (!addr || addr === "—") return;
    const ok = await copyToClipboard(addr);
    const b = $("[data-sl-acc-copy-receive]");
    if (ok && b) {
      const old = b.textContent;
      b.textContent = "✓ copied";
      setTimeout(() => { b.textContent = old; }, 1500);
    } else if (!ok) {
      const { toast } = await import("./ui.js");
      toast("Couldn't copy — copy manually: " + addr, { kind: "error", ttl: 8000 });
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
});
