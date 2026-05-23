// VAULT.7 — on-chain slot frontend.
//
// The reel animation, ticker, particles & big-win overlay are unchanged from
// the original `slots/game.js` design. The only swap: instead of an in-memory
// SlotEngine producing the result, we call placeSlotsBet → poll for the
// BetSettled event → decode the on-chain grid into the same shape the UI
// expects, then run the same animations against the real result.
//
// resultData layout (from Casino + Vault7Lib):
//   abi.encode(uint8[15] grid, uint256 lineMult, uint8 scatterCount,
//              uint256 scatterPayX100, bool isFreeSpin)
//
//   grid[col * 3 + row] = symbol ID:
//     0=E, 1=D, 2=F, 3=A (low) — 4=COIN, 5=BOLT (mid) — 6=CRYS, 7=DIAM (high)
//     8=WILD, 9=SCAT

import { ethers } from "/vendor/ethers.bundle.js";
import { SL, connect } from "../wallet.js";
import { CONFIG } from "../config.js";
import { provider, fetchRecentLogs } from "../rpc.js";
import {
  $, $$, setText, populateFairPanel, clearFairServer, friendlyError,
  pollForSettle, fmtSTT, explorerTxUrl,
} from "./_base.js";
import { validateStake } from "../errors.js";

const SLOTS = 2;
const ID_TO_NAME = ["E", "D", "F", "A", "COIN", "BOLT", "CRYS", "DIAM", "WILD", "SCAT"];
const SYMBOLS = {
  WILD: { id: "WILD", glyph: "∞", kind: "wild" },
  DIAM: { id: "DIAM", glyph: "◆", kind: "high" },
  CRYS: { id: "CRYS", glyph: "⬢", kind: "high" },
  BOLT: { id: "BOLT", glyph: "⚡", kind: "mid"  },
  COIN: { id: "COIN", glyph: "⬣", kind: "mid"  },
  A:    { id: "A",    glyph: "A", kind: "low"  },
  F:    { id: "F",    glyph: "F", kind: "low"  },
  D:    { id: "D",    glyph: "D", kind: "low"  },
  E:    { id: "E",    glyph: "E", kind: "low"  },
  SCAT: { id: "SCAT", glyph: "✦", kind: "scat" },
};
// Per-reel "fake" symbols shown during the scroll animation (cosmetic only,
// the final 3 cells per reel are the on-chain grid).
const REEL_STRIPS = [
  ["E","D","F","A","COIN","E","F","D","BOLT","A","E","F","COIN","D","CRYS","E","F","A","D","BOLT","E","F","D","WILD","A","COIN","E","D","DIAM","F","A","E","SCAT","D","F","A","E","BOLT","D","F"],
  ["F","D","E","A","BOLT","F","D","E","COIN","A","D","F","E","BOLT","A","CRYS","D","E","F","A","BOLT","D","E","COIN","F","DIAM","A","D","E","F","WILD","A","D","SCAT","E","F","A","D","BOLT","E"],
  ["D","E","F","BOLT","A","D","F","COIN","E","A","D","CRYS","F","E","A","BOLT","D","F","WILD","E","A","COIN","D","F","DIAM","E","A","D","BOLT","F","SCAT","E","A","D","F","CRYS","E","A","BOLT","D"],
  ["F","A","D","E","COIN","F","A","D","BOLT","E","F","A","CRYS","D","E","F","A","D","BOLT","E","F","A","WILD","D","COIN","E","F","A","DIAM","D","E","F","SCAT","A","D","E","F","BOLT","A","D"],
  ["E","F","A","D","BOLT","E","F","A","COIN","D","E","F","A","BOLT","D","CRYS","E","F","A","D","BOLT","E","F","COIN","A","D","DIAM","E","F","A","WILD","D","E","SCAT","F","A","D","E","BOLT","F"],
];
const PAYLINES = [
  [1,1,1,1,1], [0,0,0,0,0], [2,2,2,2,2],
  [0,1,2,1,0], [2,1,0,1,2],
  [1,0,0,0,1], [1,2,2,2,1],
  [0,0,1,2,2], [2,2,1,0,0],
  [1,0,1,0,1], [1,2,1,2,1],
  [0,1,0,1,0], [2,1,2,1,2],
  [0,1,1,1,0], [2,1,1,1,2],
  [1,1,0,1,1], [1,1,2,1,1],
  [0,2,0,2,0], [2,0,2,0,2],
  [0,1,2,2,2],
];

const STAKE_PRESETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5];
let stakeIdx = 3;
let isSpinning = false;
let totalSpinsSession = 0;
let totalWagered = 0;
let totalWon = 0;
let autoRemaining = 0;
let useFreeSpinNext = false;       // toggled by FS button
let lastFreeSpinsAvailable = 0;

const fmt = (n) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function cellHTML(symId) {
  const s = SYMBOLS[symId];
  return `<div class="cell kind-${s.kind}" data-sym="${symId}">
    <div class="glyph">
      <span class="sym sym-${s.id}">${s.glyph}</span>
    </div>
  </div>`;
}

function buildReels() {
  const root = $("#reels");
  root.innerHTML = "";
  for (let c = 0; c < 5; c++) {
    const reel = document.createElement("div");
    reel.className = "reel";
    reel.dataset.col = c;
    const strip = document.createElement("div");
    strip.className = "reel-strip";
    strip.dataset.col = c;
    const init = REEL_STRIPS[c].slice(0, 3);
    for (const s of init) {
      const w = document.createElement("div");
      w.innerHTML = cellHTML(s);
      strip.appendChild(w.firstElementChild);
    }
    reel.appendChild(strip);
    root.appendChild(reel);
  }
  sizeReels();
}
function sizeReels() {
  const reels = $$(".reel", $("#reels"));
  if (!reels.length) return;
  let w = reels[0].clientWidth;
  // First-paint guard: clientWidth can be 0 if the reels container hasn't
  // been laid out yet. Wait one frame and retry — without this the strip
  // heights collapse and the symbols end up at wildly different scales,
  // which is the "reels are scattered" bug.
  if (w === 0) { requestAnimationFrame(sizeReels); return; }
  const cellH = Math.round(w);
  for (const r of reels) {
    r.style.height   = (cellH * 3) + "px";
    r.style.overflow = "hidden"; // belt-and-braces; slots.css should set this too
    $$(".cell", r).forEach((c) => c.style.height = cellH + "px");
  }
}
window.addEventListener("resize", () => { if (!isSpinning) sizeReels(); });

// ---------- helpers ----------

function gridToNames(gridIds) {
  // gridIds layout: [col*3 + row]
  const cols = [];
  for (let c = 0; c < 5; c++) {
    cols.push([
      ID_TO_NAME[Number(gridIds[c * 3 + 0])],
      ID_TO_NAME[Number(gridIds[c * 3 + 1])],
      ID_TO_NAME[Number(gridIds[c * 3 + 2])],
    ]);
  }
  return cols; // [col][row]
}

function decodeWinningCells(grid) {
  // Replay payline-eval to figure out which cells the contract paid out,
  // matching exactly the Vault7Lib resolver. WILD substitution applies.
  const wins = [];
  for (let li = 0; li < PAYLINES.length; li++) {
    const pl = PAYLINES[li];
    const seq = pl.map((row, col) => grid[col][row]);
    let anchor = null;
    for (const s of seq) if (s !== "WILD" && s !== "SCAT") { anchor = s; break; }
    let count = 0;
    const cells = [];
    if (!anchor) {
      // all-wild line
      let i = 0;
      while (i < 5 && seq[i] === "WILD") { count++; cells.push([i, pl[i]]); i++; }
      anchor = "WILD";
    } else {
      for (let i = 0; i < seq.length; i++) {
        const s = seq[i];
        if (s === anchor || s === "WILD") { count++; cells.push([i, pl[i]]); }
        else break;
      }
    }
    if (count >= 3 && anchor !== "SCAT") wins.push({ line: li, sym: anchor, count, cells });
  }
  // scatters anywhere
  const scatCells = [];
  let scatCount = 0;
  for (let c = 0; c < 5; c++) for (let r = 0; r < 3; r++) {
    if (grid[c][r] === "SCAT") { scatCount++; scatCells.push([c, r]); }
  }
  return { wins, scatCount, scatCells };
}

// ---------- contract reads ----------

let _casinoRO = null;
function casinoRO() {
  if (!_casinoRO) {
    const abi = [
      "function freeSpinsAvailable(address) view returns (uint256)",
      "function getPlayerSlotState(address) view returns (uint64 total,uint64 earned,uint64 used,uint256 toNext)",
      "function gameMaxBet(uint8) view returns (uint256)",
      "function houseEdgeBps(uint8) view returns (uint256)",
      "event BetSettled(uint256 indexed betId,address indexed player,uint8 indexed game,bool won,uint256 payout,bytes32 randomness,bytes32 serverSeed,bytes32 clientSeed,bytes32 blockHash,uint256 nonce,bytes resultData)",
    ];
    _casinoRO = new ethers.Contract(CONFIG.casino, abi, provider());
  }
  return _casinoRO;
}

async function refreshLoyalty() {
  if (!SL.address) {
    setText("#loyaltyRemain", "150");
    $("#loyaltyBar").style.width = "0%";
    setText("#freeSpinsCount", "0");
    return;
  }
  try {
    const c = casinoRO();
    const [free, [tot, earned, used, toNext]] = await Promise.all([
      c.freeSpinsAvailable(SL.address),
      c.getPlayerSlotState(SL.address),
    ]);
    lastFreeSpinsAvailable = Number(free);
    setText("#freeSpinsCount", String(lastFreeSpinsAvailable));
    const totalSpins = Number(tot);
    // Loyalty bar — fills with each paid spin. No numbers exposed to the
    // player; the reward is a surprise drop when the bar completes.
    const progress = (totalSpins % 150) / 150 * 100;
    const bar = $("#loyaltyBar");
    if (bar) bar.style.width = progress.toFixed(1) + "%";
    const badge = $("#freeSpinsBadge");
    if (badge) {
      if (lastFreeSpinsAvailable > 0) badge.classList.add("show");
      else badge.classList.remove("show");
    }
    // Highlight the use-free-spin shortcut button when spins are available.
    const fsBtn = $("#turboBtn");
    if (fsBtn) {
      fsBtn.classList.toggle("active", lastFreeSpinsAvailable > 0);
      fsBtn.title = lastFreeSpinsAvailable > 0
        ? "Free spin available — click SPIN to use it"
        : "Keep playing to unlock free spins";
    }
  } catch (e) { console.warn("[vault7] loyalty:", e.message); }
}

async function refreshGameMeta() {
  try {
    const c = casinoRO();
    const [maxBet, edge] = await Promise.all([
      c.gameMaxBet(SLOTS),
      c.houseEdgeBps(SLOTS),
    ]);
    setText(`[data-sl="maxBet"][data-game="slots"]`, fmtSTT(maxBet) + " STT");
    setText(`[data-sl="houseEdge"][data-game="slots"]`, (Number(edge) / 100).toFixed(2) + "%");
  } catch (_) {}
}

async function refreshBalance() {
  if (!SL.address) { setText("#balance", "—"); return; }
  try {
    const bal = await provider().getBalance(SL.address);
    setText("#balance", fmtSTT(bal));
  } catch (_) {}
}

// ---------- UI ----------

function updateUI() {
  const stake = STAKE_PRESETS[stakeIdx];
  setText("#stakeVal", stake.toFixed(2));
  setText("#totalBet", stake.toFixed(2));
  setText("#statSpins", String(totalSpinsSession));
  setText("#statWagered", fmt(totalWagered));
  setText("#statWon", fmt(totalWon));
  $("#turboBtn").classList.toggle("active", useFreeSpinNext && lastFreeSpinsAvailable > 0);
  const spinBtn = $("#spinBtn");
  if (useFreeSpinNext && lastFreeSpinsAvailable > 0) {
    spinBtn.querySelector("span").textContent = "FREE SPIN";
    spinBtn.classList.add("bonus");
  } else {
    spinBtn.querySelector("span").textContent = isSpinning ? "SPINNING…" : "SPIN";
    spinBtn.classList.remove("bonus");
  }
}

function buildPaytable() {
  const list = $("#paytableList");
  if (!list) return;
  const order = ["WILD","DIAM","CRYS","BOLT","COIN","A","F","D","E"];
  const pays = { WILD:800, DIAM:400, CRYS:200, BOLT:100, COIN:60, A:40, F:24, D:16, E:12 };
  list.innerHTML = "";
  for (const id of order) {
    const s = SYMBOLS[id];
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div class="gly sym-${id}">${s.glyph}</div>
      <div class="info">
        <div class="nm">${id}</div>
        <div class="px">×${pays[id]} <span style="color:var(--fg-mute)">5-of-a-kind</span></div>
      </div>`;
    list.appendChild(row);
  }
  const r = document.createElement("div");
  r.className = "row";
  r.style.gridColumn = "1 / -1";
  r.innerHTML = `
    <div class="gly sym-SCAT">✦</div>
    <div class="info">
      <div class="nm">SCATTER · anywhere</div>
      <div class="px">3 → +2× · 4 → +10× · 5 → +50× <span style="color:var(--fg-mute)">stake bonus</span></div>
    </div>`;
  list.appendChild(r);
}

// ---------- spin animation (kept from design) ----------

async function spinAnimation(finalSeq /* [col][row] */) {
  const reels = $$(".reel", $("#reels"));
  const strips = reels.map((r) => $(".reel-strip", r));
  const cellH = reels[0].clientWidth;
  const SCROLL_CELLS = 24;

  for (let c = 0; c < 5; c++) {
    const strip = strips[c];
    strip.style.transition = "none";
    strip.innerHTML = "";
    const total = SCROLL_CELLS + 3;
    for (let i = 0; i < total; i++) {
      const isFinal = i >= SCROLL_CELLS;
      const s = isFinal
        ? finalSeq[c][i - SCROLL_CELLS]
        : REEL_STRIPS[c][Math.floor(Math.random() * REEL_STRIPS[c].length)];
      const w = document.createElement("div");
      w.innerHTML = cellHTML(s);
      const cell = w.firstElementChild;
      cell.style.height = cellH + "px";
      strip.appendChild(cell);
    }
    strip.style.transform = `translateY(0px)`;
    void strip.offsetHeight;
  }

  return new Promise((resolve) => {
    const baseDelay = 130;
    const baseDur = 950;
    let stopped = 0;
    const endY = -(SCROLL_CELLS * cellH);
    for (let c = 0; c < 5; c++) {
      const strip = strips[c];
      const dur = baseDur + c * 220;
      const delay = c * baseDelay;
      setTimeout(() => {
        strip.style.transition = `transform ${dur}ms cubic-bezier(.25, .1, .25, 1.18)`;
        strip.style.transform = `translateY(${endY - cellH * 0.18}px)`;
        setTimeout(() => {
          strip.style.transition = `transform 220ms cubic-bezier(.34, 1.56, .64, 1)`;
          strip.style.transform = `translateY(${endY}px)`;
        }, dur);
        setTimeout(() => {
          strip.style.transition = "none";
          stopped++;
          if (stopped === 5) resolve();
        }, dur + 230);
      }, delay);
    }
  });
}

function clearWinFX() {
  $$(".cell.winning").forEach((el) => el.classList.remove("winning", "scatter-win"));
  $$(".cell.dim").forEach((el) => el.classList.remove("dim"));
  $("#paylineSvg").innerHTML = "";
  $("#winCounter").classList.remove("show");
}

function visibleCells() {
  return $$(".reel-strip", $("#reels")).map((s) => Array.from(s.children).slice(-3));
}

async function showWins(decoded, stake, payoutSTT) {
  const cols = visibleCells();
  const winSet = new Set();
  for (const w of decoded.wins) for (const [c, r] of w.cells) winSet.add(c + "," + r);
  if (decoded.scatCount >= 3) for (const [c, r] of decoded.scatCells) winSet.add(c + "," + r);
  if (winSet.size === 0) return;

  for (let c = 0; c < 5; c++) for (let r = 0; r < 3; r++) {
    if (!winSet.has(c + "," + r)) cols[c][r]?.classList.add("dim");
  }
  for (const w of decoded.wins) for (const [c, r] of w.cells) cols[c][r]?.classList.add("winning");
  if (decoded.scatCount >= 3) for (const [c, r] of decoded.scatCells) cols[c][r]?.classList.add("winning", "scatter-win");

  // paylines
  const svg = $("#paylineSvg");
  const frame = $("#reels").getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${frame.width} ${frame.height}`);
  svg.innerHTML = "";
  for (let i = 0; i < decoded.wins.length; i++) {
    const w = decoded.wins[i];
    const pl = PAYLINES[w.line];
    const pts = [];
    for (let c = 0; c < w.count; c++) {
      const cell = cols[c][pl[c]];
      if (!cell) continue;
      const r = cell.getBoundingClientRect();
      pts.push([r.left + r.width / 2 - frame.left, r.top + r.height / 2 - frame.top]);
    }
    const d = pts.map((p, i) => (i === 0 ? `M${p[0]} ${p[1]}` : `L${p[0]} ${p[1]}`)).join(" ");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.style.animationDelay = (i * 0.12) + "s";
    const k = SYMBOLS[w.sym].kind;
    path.style.stroke = k === "wild" ? "#fff" : (k === "high" ? "var(--cyan)" : (k === "mid" ? "var(--gold)" : "var(--purple)"));
    svg.appendChild(path);
  }

  // win counter
  if (payoutSTT > 0) {
    $("#winCounter").classList.add("show");
    let v = 0;
    const step = Math.max(payoutSTT / 50, 0.001);
    const tick = () => {
      v = Math.min(payoutSTT, v + step);
      setText("#winCounterAmt", fmt(v));
      if (v < payoutSTT) requestAnimationFrame(tick);
    };
    tick();
  }
}

function tierFor(amount, stake) {
  const x = amount / stake;
  if (x >= 50) return "EPIC";
  if (x >= 25) return "MEGA";
  if (x >= 10) return "BIG";
  return null;
}

function burstParticles(n) {
  const canvas = $("#particleCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const parts = [];
  const colors = ["#ffc847","#ff9a3c","#4ee3ff","#b794ff","#fff"];
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = 4 + Math.random() * 9;
    parts.push({ x: w / 2, y: h / 2, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 4, life: 1, size: 2 + Math.random() * 4, color: colors[Math.floor(Math.random() * colors.length)] });
  }
  const tick = () => {
    ctx.clearRect(0, 0, w, h);
    let alive = false;
    for (const p of parts) {
      if (p.life <= 0) continue;
      alive = true;
      p.vy += 0.18; p.x += p.vx; p.y += p.vy; p.life -= 0.012;
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
    }
    if (alive) requestAnimationFrame(tick);
    else ctx.clearRect(0, 0, w, h);
  };
  tick();
}

async function bigWinSequence(amount, stake) {
  const t = tierFor(amount, stake);
  if (!t) return;
  document.body.classList.add(t === "EPIC" ? "shake-3" : t === "MEGA" ? "shake-2" : "shake-1");
  setTimeout(() => document.body.classList.remove("shake-1","shake-2","shake-3"), 800);
  const ov = $("#bigwinOv");
  ov.querySelector(".tier").textContent = t === "BIG" ? "BIG WIN" : t === "MEGA" ? "MEGA WIN" : "EPIC WIN";
  ov.querySelector(".tier").className = "tier " + (t === "MEGA" ? "mega" : t === "EPIC" ? "epic" : "");
  const amtEl = ov.querySelector(".amount");
  ov.classList.add("show");
  burstParticles(t === "EPIC" ? 220 : t === "MEGA" ? 140 : 80);
  let v = 0;
  const dur = t === "EPIC" ? 3200 : t === "MEGA" ? 2400 : 1500;
  const start = performance.now();
  await new Promise((resolve) => {
    const tick = (now) => {
      const p = Math.min(1, (now - start) / dur);
      v = amount * (1 - Math.pow(1 - p, 3));
      amtEl.textContent = "+" + fmt(v);
      if (p < 1) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
  await sleep(t === "EPIC" ? 1200 : 800);
  ov.classList.remove("show");
}

// ---------- Real on-chain ticker (BetSettled events) ----------

const TICKER_MAX = 12;
function pushTicker(row) {
  const list = $("#tickerList");
  if (!list) return;
  const div = document.createElement("div");
  div.className = "ticker-row fresh " + (row.mega ? "mega" : "");
  div.innerHTML = `<div class="who">${row.who}<small>VAULT.7</small></div>
                   <div class="amt">+${fmt(row.amount)}<small>STT</small></div>`;
  list.prepend(div);
  while (list.children.length > TICKER_MAX) list.lastElementChild.remove();
  setTimeout(() => div.classList.remove("fresh"), 800);
}

async function loadTicker() {
  const list = $("#tickerList");
  if (!list) return;
  try {
    const events = await fetchRecentLogs(casinoRO(), "BetSettled", {
      minCount: 12, maxLookback: 100_000,
      filter: (ev) => Number(ev.args.game) === SLOTS && ev.args.won,
    });
    list.innerHTML = "";
    for (const ev of events.slice(0, 12)) {
      const addr = ev.args.player;
      const who = addr.slice(0, 6) + "…" + addr.slice(-4);
      const amount = Number(ethers.formatEther(ev.args.payout));
      pushTicker({ who, amount, mega: amount / STAKE_PRESETS[stakeIdx] >= 25 });
    }
  } catch (e) { console.warn("[vault7] ticker:", e.message); }
}

// ---------- core spin ----------

async function decodeOnChain(resultData) {
  try {
    const [grid, lineMult, scatCount, scatPayX100, isFree] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["uint8[15]", "uint256", "uint8", "uint256", "bool"], resultData);
    return {
      grid: gridToNames(grid),
      lineMult: Number(lineMult),
      scatCount: Number(scatCount),
      scatPayX100: Number(scatPayX100),
      isFree,
    };
  } catch (e) { console.warn("[vault7] decode:", e.message); return null; }
}

async function doSpin() {
  if (isSpinning) return;
  clearWinFX();
  const stake = STAKE_PRESETS[stakeIdx];
  const wantFree = useFreeSpinNext && lastFreeSpinsAvailable > 0;
  isSpinning = true;
  $("#spinBtn").disabled = true;
  $("#stagePill").querySelector("span:last-child").textContent = "PLACING…";
  updateUI();
  try {
    await connect();
    const cs = ethers.hexlify(ethers.randomBytes(32));
    let tx;
    if (wantFree) {
      tx = await SL.casino.placeSlotsBet(cs, true, { value: 0 });
    } else {
      tx = await SL.casino.placeSlotsBet(cs, false, { value: ethers.parseEther(stake.toFixed(6)) });
    }
    const rcpt = await tx.wait();
    // Find BetPlaced for betId
    let betId;
    for (const log of rcpt.logs) {
      try {
        const p = SL.casino.interface.parseLog(log);
        if (p && p.name === "BetPlaced") { betId = p.args.betId; break; }
      } catch (_) {}
    }
    populateFairPanel({ clientSeed: cs, betId, nonce: betId, serverSeed: ethers.ZeroHash, txHash: tx.hash });
    $("#stagePill").querySelector("span:last-child").textContent = "REVEAL…";
    if (!wantFree) {
      totalWagered += stake;
      totalSpinsSession++;
    }

    const settled = await pollForSettle(betId);
    if (!settled || settled.refunded) {
      $("#stagePill").querySelector("span:last-child").textContent = settled?.refunded ? "REFUNDED" : "TIMED OUT";
      setText("#lastWin", settled?.refunded ? "— refunded" : "— timed out");
      $("#lastWin").classList.add("zero");
      return;
    }
    const decoded = await decodeOnChain(settled.args.resultData);
    if (!decoded) { console.warn("[vault7] decode failed"); return; }

    // Animate reels to the on-chain grid
    await spinAnimation(decoded.grid);

    const payoutWei = BigInt(settled.args.payout);
    const payoutSTT = Number(ethers.formatEther(payoutWei));
    totalWon += payoutSTT;
    if (settled.args.won) {
      const winDecoded = decodeWinningCells(decoded.grid);
      await showWins(winDecoded, stake, payoutSTT);
      setText("#lastWin", "+" + fmt(payoutSTT) + " STT");
      $("#lastWin").classList.remove("zero");
      if (decoded.scatCount >= 3) {
        await sleep(500);
        // refresh loyalty (scatter doesn't grant FS on-chain — loyalty does)
      }
    } else {
      setText("#lastWin", "— no win");
      $("#lastWin").classList.add("zero");
    }

    populateFairPanel({
      clientSeed: settled.args.clientSeed,
      betId: settled.args.betId,
      nonce: settled.args.nonce,
      serverSeed: settled.args.serverSeed,
      txHash: settled.transactionHash,
    });
    $("#stagePill").querySelector("span:last-child").textContent = "READY";

    if (payoutSTT > 0 && tierFor(payoutSTT, stake)) {
      await sleep(400);
      await bigWinSequence(payoutSTT, stake);
    }
  } catch (e) {
    console.error("[vault7] spin failed:", e);
    setText("#lastWin", "× " + friendlyError(e));
    $("#lastWin").classList.add("zero");
    $("#stagePill").querySelector("span:last-child").textContent = "ERROR";
  } finally {
    isSpinning = false;
    $("#spinBtn").disabled = false;
    useFreeSpinNext = false;        // FS button is one-shot
    await Promise.all([refreshBalance(), refreshLoyalty()]);
    updateUI();
    // autospin chain
    if (autoRemaining > 0) {
      autoRemaining--;
      $("#autoBtn").querySelector(".lbl").textContent = autoRemaining > 0 ? String(autoRemaining) : "AUTO";
      if (autoRemaining > 0) setTimeout(() => doSpin(), 800);
      else $("#autoBtn").classList.remove("active");
    }
  }
}

// ---------- wire ----------

function init() {
  buildReels();
  buildPaytable();
  updateUI();

  $("#spinBtn").addEventListener("click", () => {
    if (autoRemaining > 0) {
      autoRemaining = 0;
      $("#autoBtn").classList.remove("active");
      $("#autoBtn").querySelector(".lbl").textContent = "AUTO";
      return;
    }
    doSpin();
  });
  $("#stakeUp").addEventListener("click", () => { if (!isSpinning) { stakeIdx = Math.min(STAKE_PRESETS.length - 1, stakeIdx + 1); updateUI(); }});
  $("#stakeDn").addEventListener("click", () => { if (!isSpinning) { stakeIdx = Math.max(0, stakeIdx - 1); updateUI(); }});
  $("#turboBtn").addEventListener("click", () => {
    if (lastFreeSpinsAvailable === 0) return;
    useFreeSpinNext = !useFreeSpinNext;
    updateUI();
  });
  $("#autoBtn").addEventListener("click", () => {
    if (autoRemaining > 0) {
      autoRemaining = 0;
      $("#autoBtn").classList.remove("active");
      $("#autoBtn").querySelector(".lbl").textContent = "AUTO";
      return;
    }
    autoRemaining = 10;
    $("#autoBtn").classList.add("active");
    $("#autoBtn").querySelector(".lbl").textContent = "10";
    if (!isSpinning) doSpin();
  });
  $("#bigwinOv").addEventListener("click", () => $("#bigwinOv").classList.remove("show"));
  $("#fsIntro").addEventListener("click", () => $("#fsIntro").classList.remove("show"));
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !e.repeat) { e.preventDefault(); $("#spinBtn").click(); }
    if (e.code === "ArrowUp") { e.preventDefault(); $("#stakeUp").click(); }
    if (e.code === "ArrowDown") { e.preventDefault(); $("#stakeDn").click(); }
    if (e.key === "f" || e.key === "F") $("#turboBtn").click();
  });

  // Initial reads
  refreshGameMeta();
  refreshBalance();
  refreshLoyalty();
  loadTicker();
  setInterval(() => { refreshBalance(); refreshLoyalty(); }, 12_000);
  setInterval(loadTicker, 20_000);
  document.addEventListener("shinyluck:connected", () => { refreshBalance(); refreshLoyalty(); });
}

document.addEventListener("DOMContentLoaded", init);
