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

const GAME_NAMES = ["DICE","CRASH","SLOTS","MINES","PLINKO","ROULETTE"];
const ZERO = "0x0000000000000000000000000000000000000000";
const LOOKBACK = 200_000;
const EXPLORER = "https://shannon-explorer.somnia.network";

let viewAddress = null;          // address being viewed (may differ from SL.address)
let isReadOnly = true;           // true if not the connected wallet
const cache = { settled: [], placed: [], deposits: [], claims: [] };

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }
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
  body.innerHTML = "";
  if (settled.length === 0) {
    body.innerHTML = `<tr><td class="dim" colspan="6">no settled bets in window</td></tr>`;
    return;
  }
  const slice = settled.slice(0, 50);
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
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td><a href="${explorerTx(ev.transactionHash)}" target="_blank" rel="noopener" class="dim" style="color:var(--fg-mute);">#${ev.args.betId}</a></td>` +
      `<td><span class="game-tag">${game}</span></td>` +
      `<td>${stake} STT</td>` +
      `<td>${won ? "won" : "lost"}</td>` +
      `<td>${mult}</td>` +
      `<td style="color:${pnlColor}">${pnlText}</td>`;
    body.appendChild(tr);
  }
}

function renderEventTable(bodySel, events, valueExtract) {
  const body = $(bodySel);
  body.innerHTML = "";
  if (events.length === 0) {
    body.innerHTML = `<tr><td class="dim" colspan="3">no events in window</td></tr>`;
    return;
  }
  for (const ev of events) {
    const wei = valueExtract(ev);
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="dim">${ev.blockNumber}</td>` +
      `<td><a href="${explorerTx(ev.transactionHash)}" target="_blank" rel="noopener" style="color:var(--cyan);">${ev.transactionHash.slice(0,10)}…</a></td>` +
      `<td>${fmtSTT(wei)} STT</td>`;
    body.appendChild(tr);
  }
}

function renderReceipts(settled) {
  const body = $("[data-sl-acc-receipts-body]");
  body.innerHTML = "";
  if (settled.length === 0) {
    body.innerHTML = `<tr><td class="dim" colspan="5">no settled bets in window</td></tr>`;
    return;
  }
  for (const ev of settled.slice(0, 50)) {
    const game = GAME_NAMES[Number(ev.args.game)] || "?";
    const won = ev.args.won;
    const payout = BigInt(ev.args.payout);
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>#${ev.args.betId}</td>` +
      `<td><span class="game-tag">${game}</span></td>` +
      `<td>${fmtSTT(payout)} STT</td>` +
      `<td style="color:${won ? 'var(--green)' : 'var(--red)'}">${won ? "WON" : "LOST"}</td>` +
      `<td><a href="fair.html?betId=${ev.args.betId}" data-link style="color:var(--cyan);">open receipt →</a></td>`;
    body.appendChild(tr);
  }
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
  const fromBlock = Math.max(dep || head - LOOKBACK, head - LOOKBACK);

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

  // Tabs
  renderBetsTab(mySettled, stakeByBet);
  renderEventTable("[data-sl-acc-withdrawals-body]", myClaims,
                   (ev) => BigInt(ev.args.amount));
  renderEventTable("[data-sl-acc-deposits-body]", myDeposits,
                   (ev) => BigInt(ev.args.amount));
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
  // first render straight away (read-only profile doesn't need connection)
  refresh().catch((e) => console.warn("[acc] initial refresh:", e.message));
  document.addEventListener("shinyluck:connected", () => refresh().catch(() => {}));

  $("[data-sl-acc-copy]")?.addEventListener("click", async () => {
    const text = viewAddress || SL.address || "";
    if (text && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      const btn = $("[data-sl-acc-copy]");
      const old = btn.textContent;
      btn.textContent = "✓ copied";
      setTimeout(() => { btn.textContent = old; }, 1500);
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
    try {
      await navigator.clipboard.writeText(addr);
      const b = $("[data-sl-acc-copy-receive]");
      const old = b.textContent;
      b.textContent = "✓ copied";
      setTimeout(() => { b.textContent = old; }, 1500);
    } catch (_) {}
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
