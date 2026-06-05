// Real-time agent activity dashboard for the lobby's [03] "Somnia agents"
// section. Replaces the random-noise activity bars from app.js with actual
// on-chain event-driven visualisation. Designed to show judges that the
// agent layer is doing real work, not theatre.
//
// What each card surfaces:
//
//   HOUSE MANAGER AGENT  (autonomous, the showpiece)
//     - 28-bucket activity bar: ReactiveBetSettledHandled + ReactiveHourlyTick
//       + RtpAnalysisRequested/Resolved events in the last 28 minutes
//     - Live "thinking" ticker pulling the latest prompt / decision string
//       from RtpAnalysisRequested + ReasoningRequested + ReasoningLog events
//     - Stats: reasoning logs in 24h, Bonus Mode flag, live bankroll
//
//   LLM INFERENCE AGENT
//     - 28-bucket bar: QuorumResult events in last 28 minutes (per bet)
//     - Live ticker rotates the latest LLM `sample` text (its actual output)
//     - Stats: quorum config, total verifications today, success ratio
//
//   JSON API + PARSE WEBSITE
//     - Show "registered, awaiting v2 binding" honestly - no fake activity
//     - Bars dim, "QUEUED" label
//
// The whole thing wakes up via WS push (no polling beyond the initial cold
// fetch). Falls back to a 30s poll if WS isn't available.

import { ethers } from "/vendor/ethers.bundle.js";
import { CONFIG } from "./config.js";
import { provider, wsProvider, fetchDeploymentBlock } from "./rpc.js";

const ZERO = "0x0000000000000000000000000000000000000000";

// We deliberately do NOT use the rpc.js `fetchLogs` here - its Shannon
// Explorer primary path is CORS-blocked from vercel.app, and the RPC
// fallback through ethers JsonRpcProvider gets killed by v6's auto-batch
// (chunked queries get joined into one batch that exceeds the 1000-block
// per-call limit). Same workaround as in cost-ledger.js: raw fetch direct
// to the Somnia public RPC, manual chunking.
const RPC_URL = "https://api.infra.testnet.somnia.network";
async function rawGetLogsHttp(addr, topic0, from, to) {
  try {
    const resp = await fetch(RPC_URL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method: "eth_getLogs",
        params: [{
          address: addr, topics: [topic0],
          fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16),
        }],
      }),
    });
    if (!resp.ok) return [];
    const j = await resp.json();
    if (j.error) return [];
    return j.result || [];
  } catch (_) { return []; }
}
async function rawLogsRange(addr, topic0, from, to) {
  const CHUNK = 900;
  const PARALLEL = 8;
  const ranges = [];
  for (let s = from; s <= to; s += CHUNK) ranges.push([s, Math.min(s + CHUNK - 1, to)]);
  const out = [];
  for (let i = 0; i < ranges.length; i += PARALLEL) {
    const batch = ranges.slice(i, i + PARALLEL);
    const results = await Promise.all(batch.map(([s, e]) => rawGetLogsHttp(addr, topic0, s, e)));
    for (const r of results) out.push(...r);
  }
  return out;
}
async function rawFetchLogs(contract, eventName, from, to) {
  const topic0 = contract.interface.getEvent(eventName).topicHash;
  const raws = await rawLogsRange(contract.target, topic0, from, to);
  return raws.map((r) => {
    try {
      const parsed = contract.interface.parseLog({ topics: r.topics, data: r.data });
      return {
        name: parsed.name, args: parsed.args,
        blockNumber: parseInt(r.blockNumber, 16),
        transactionHash: r.transactionHash,
        logIndex: parseInt(r.logIndex, 16),
      };
    } catch (_) { return null; }
  }).filter(Boolean);
}
const ACTIVITY_BUCKETS = 28;
const BUCKET_MS = 60_000; // 1-minute buckets → 28-min activity window

// Event signatures must match HouseManager.sol byte-for-byte - the keccak256
// topic0 hash includes the full signature (indexed + non-indexed). An
// outdated tail (e.g. missing `competitorRtpBps`, swapping signers/workers
// for decision/sample) → wrong topic0 → eth_getLogs and provider.on filter
// silently return nothing.
const HM_ABI = [
  "event ReactiveBetSettledHandled(uint256 newMaxBet, uint256 freeBankroll)",
  "event ReactiveHourlyTick(uint256 freeBankrollNow, int256 changeBps)",
  "event ReasoningRequested(string action, int256 changeBps, uint256 freeBankroll, uint256 timestamp)",
  "event RtpAnalysisRequested(uint256 indexed requestId, uint8 indexed game, uint16 ourRtpBps, int256 bankrollChangeBps, uint256 competitorRtpBps)",
  "event RtpAnalysisResolved(uint256 indexed requestId, uint8 indexed game, uint16 oldRtpBps, uint16 newRtpBps, string decision, string sample)",
  "event AgentRequestSkipped(string indexed kind, string reason)",
  // gen-14: per-player inferToolsChat Player Agent. PlayerDecisionResolved is
  // the umbrella outcome (SKIP / TOOL_PLACEBET / DONE / DECODE_FAIL); the LLM
  // itself decided the game+stake by yielding a placeBet on-chain tool call.
  "event PlayerDecisionResolved(uint256 indexed requestId, address indexed player, string decision, uint8 game, uint256 stakeWei, uint256 betId, bool placed)",
  "event PlayerAgentToolCall(uint256 indexed requestId, address indexed player, uint8 game, uint256 stakeWei, uint256 betId, bool placed)",
];
const VERIFIER_ABI = [
  "event QuorumRequested(uint256 indexed betId, uint256 indexed requestId, address indexed requester)",
  "event QuorumResult(uint256 indexed betId, uint256 indexed requestId, bytes32 expected, uint8 signers, uint8 totalWorkers, uint8 level, uint8 status, string sampleResponse)",
];
const CASINO_REASONING_ABI = [
  "event ReasoningLog(string thought, uint256 timestamp)",
  "event BonusModeActivated(uint256 until, string reasoning)",
  "event RtpAdjusted(uint8 indexed game, uint16 oldRtpBps, uint16 newRtpBps, string reasoning)",
];

const GAME_NAMES = ["DICE", "CRASH", "VAULT.7", "MINES", "PLINKO", "ROULETTE", "SUGAR.LAB"];

// Public Somnia agent platform explorer - each createRequest produces a
// receipt indexed by requestId. Linking to these from our UI is the cheapest
// proof-of-work: judges can click any HM/LLM decision in our dashboard and
// land on the official Somnia page showing the prompt, the elected
// subcommittee, the byte-identical worker responses, and the consensus
// status. No need to trust our rendering - the receipt is the source of
// truth.
const RECEIPT_BASE = "https://agents.testnet.somnia.network/receipts/";
function receiptLink(requestId) {
  if (requestId === undefined || requestId === null) return "";
  const id = typeof requestId === "bigint" ? requestId.toString() : String(requestId);
  return ` <a href="${RECEIPT_BASE}${id}" target="_blank" rel="noopener" class="sl-receipt-link" title="View official Somnia agent platform receipt for request ${id}">[receipt ↗]</a>`;
}

// Per-agent event buckets: { lastEvents: [{tsMs, label}], buckets: number[28] }
const state = {
  hm:   { buckets: new Array(ACTIVITY_BUCKETS).fill(0), thoughts: [], reasoningCount24h: 0 },
  llm:  { buckets: new Array(ACTIVITY_BUCKETS).fill(0), thoughts: [], totalQuorum: 0, okQuorum: 0 },
  json: { buckets: new Array(ACTIVITY_BUCKETS).fill(0) },
  parse:{ buckets: new Array(ACTIVITY_BUCKETS).fill(0) },
};

function bucketIndex(tsMs) {
  const now = Date.now();
  const age = now - tsMs;
  if (age < 0 || age >= ACTIVITY_BUCKETS * BUCKET_MS) return -1;
  // Rightmost bar = now; leftmost = oldest.
  return ACTIVITY_BUCKETS - 1 - Math.floor(age / BUCKET_MS);
}

// Unified cross-agent stream (newest-first), rendered into the lobby's
// [data-sl-agent-stream]. Every agent event funnels here so a visitor sees ALL
// autonomous decisions in one live feed, not split across four cards.
const STREAM_CAP = 40;
const _stream = [];   // { agentKey, tsMs, label }
const STREAM_TAG = { hm: "HOUSE MGR", llm: "LLM", json: "JSON API", parse: "NEWS" };
const STREAM_COLOR = { hm: "var(--red)", llm: "var(--purple)", json: "var(--cyan)", parse: "var(--amber, #f59e0b)" };

function pushEvent(agentKey, tsMs, label) {
  const s = state[agentKey];
  if (!s) return;
  const i = bucketIndex(tsMs);
  if (i >= 0) s.buckets[i] = (s.buckets[i] || 0) + 1;
  if (label && s.thoughts) {
    s.thoughts.push({ tsMs, label });
    if (s.thoughts.length > 12) s.thoughts.shift();
  }
  // Feed the unified stream too (dedup by agent+ts+label so the cold-start
  // scan and the live WS path don't double-insert the same event).
  if (label) {
    const uid = `${agentKey}:${tsMs}:${label}`;
    if (!_stream.some((e) => e.uid === uid)) {
      _stream.push({ agentKey, tsMs, label, uid });
      _stream.sort((a, b) => b.tsMs - a.tsMs);
      if (_stream.length > STREAM_CAP) _stream.length = STREAM_CAP;
    }
  }
}

function renderStream() {
  const body = document.querySelector("[data-sl-agent-stream]");
  if (!body) return;
  if (_stream.length === 0) return; // keep the "connecting…" placeholder
  const fmtAgo = (ts) => {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    return Math.floor(s / 3600) + "h ago";
  };
  body.innerHTML = _stream.map((e) => (
    `<div class="agent-stream-row">` +
      `<span class="agent-stream-tag" style="color:${STREAM_COLOR[e.agentKey] || "var(--fg-mute)"};border-color:${STREAM_COLOR[e.agentKey] || "var(--line)"}">${STREAM_TAG[e.agentKey] || e.agentKey}</span>` +
      `<span class="agent-stream-label">${e.label}</span>` +
      `<span class="agent-stream-ago">${fmtAgo(e.tsMs)}</span>` +
    `</div>`
  )).join("");
}

// ---------------------------------------------------------------------------
// Card rendering
// ---------------------------------------------------------------------------

function renderBar(cardEl, buckets, color) {
  let bar = cardEl.querySelector(".agent-bar");
  if (!bar) return;
  // Lazy-create the 28 spans on first paint, then just update heights/classes.
  if (bar.children.length !== ACTIVITY_BUCKETS) {
    bar.innerHTML = Array.from({ length: ACTIVITY_BUCKETS }, () => "<span></span>").join("");
  }
  const max = Math.max(1, ...buckets);
  const cells = bar.children;
  for (let i = 0; i < ACTIVITY_BUCKETS; i++) {
    const cell = cells[i];
    const v = buckets[i] || 0;
    // 3px floor so empty buckets still show the rail, 26px ceiling.
    const h = 3 + Math.round((v / max) * 23);
    cell.style.height = h + "px";
    cell.classList.toggle("on", v > 0);
  }
  if (color) bar.style.color = color;
}

function mountThoughtTicker(cardEl, agentKey, accent) {
  // Single rotating line that fades between the latest agent "thoughts".
  // Inserted right above the .agent-bar so the visual order is:
  // header → desc → chips → stats → ticker → bar.
  let host = cardEl.querySelector(".sl-agent-thought");
  if (!host) {
    host = document.createElement("div");
    host.className = "sl-agent-thought";
    host.dataset.agent = agentKey;
    host.innerHTML = `
      <span class="sl-thought-label">CURRENT THOUGHT</span>
      <div class="sl-thought-line">awaiting first event…</div>
    `;
    if (accent) host.style.setProperty("--accent", accent);
    const bar = cardEl.querySelector(".agent-bar");
    if (bar) cardEl.insertBefore(host, bar);
    else cardEl.appendChild(host);
  }
}

function updateThoughtTicker(cardEl, agentKey) {
  const host = cardEl.querySelector(`.sl-agent-thought[data-agent="${agentKey}"]`);
  if (!host) return;
  const line = host.querySelector(".sl-thought-line");
  if (!line) return;
  const s = state[agentKey];
  if (!s || !s.thoughts || s.thoughts.length === 0) {
    line.textContent = "awaiting first event…";
    line.classList.remove("sl-thought-fresh");
    return;
  }
  const next = s.thoughts[s.thoughts.length - 1];
  if (line.dataset.tsMs === String(next.tsMs)) return; // no change since last paint
  line.dataset.tsMs = String(next.tsMs);
  // innerHTML so the embedded [receipt ↗] anchor renders as a real link.
  // Labels are built from internal hmLabelFor/llmLabelFor/casinoLabelFor
  // helpers - no user input - so we don't sanitise here.
  line.innerHTML = next.label;
  // Brief flash so the user notices the swap.
  line.classList.remove("sl-thought-fresh");
  void line.offsetWidth; // force reflow so the animation re-fires
  line.classList.add("sl-thought-fresh");
}

function injectStyles() {
  if (document.getElementById("sl-agent-activity-styles")) return;
  const s = document.createElement("style");
  s.id = "sl-agent-activity-styles";
  s.textContent = `
    .sl-agent-thought {
      margin-top: 14px;
      padding: 10px 12px;
      background: rgba(255,255,255,0.02);
      border-left: 3px solid var(--accent, var(--cyan));
      font-family: var(--mono);
      min-height: 56px;
    }
    .sl-agent-thought .sl-thought-label {
      display: block;
      font-size: 9px;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: var(--fg-mute);
      margin-bottom: 6px;
    }
    .sl-agent-thought .sl-thought-line {
      font-size: 11.5px;
      line-height: 1.45;
      color: var(--fg);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      transition: color .4s ease;
    }
    .sl-agent-thought .sl-thought-line.sl-thought-fresh {
      animation: sl-thought-flash 1.4s ease-out;
    }
    @keyframes sl-thought-flash {
      0%   { color: var(--accent, var(--cyan)); text-shadow: 0 0 12px var(--accent, var(--cyan)); }
      50%  { color: var(--accent, var(--cyan)); }
      100% { color: var(--fg); text-shadow: none; }
    }
    /* Inline deep-link to the official Somnia agent platform receipt for a
       given requestId. Tiny + slightly subdued so it doesn't dominate the
       sentence, but obvious enough that judges/users notice "oh, I can click
       through to the actual platform". */
    .sl-receipt-link {
      color: var(--cyan);
      text-decoration: none;
      font-size: 10px;
      letter-spacing: 0.5px;
      padding: 1px 4px;
      border: 1px solid var(--line, rgba(255,255,255,.12));
      border-radius: 3px;
      margin-left: 4px;
      white-space: nowrap;
      vertical-align: middle;
      transition: background 120ms, border-color 120ms;
    }
    .sl-receipt-link:hover {
      background: rgba(34, 211, 238, .14);
      border-color: var(--cyan);
    }
    /* Live indicator next to agent dot when events are firing */
    .sl-agent-pulse {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
      margin-left: 6px;
      box-shadow: 0 0 6px currentColor;
      animation: sl-pulse 1.4s ease-in-out infinite;
    }
    @keyframes sl-pulse {
      0%, 100% { opacity: .35; transform: scale(.9); }
      50%      { opacity: 1;   transform: scale(1.15); }
    }
  `;
  document.head.appendChild(s);
}

function findCardByAgentKey(key) {
  // Each card has a <b data-sl-agent-id="<key>"> inside. Use that as anchor.
  const idEl = document.querySelector(`[data-sl-agent-id="${key}"]`);
  return idEl ? idEl.closest(".agent-card") : null;
}

function paintActivePulse(cardEl, active) {
  const head = cardEl.querySelector(".agent-head h3");
  if (!head) return;
  const existing = head.querySelector(".sl-agent-pulse");
  if (active && !existing) {
    const pulse = document.createElement("span");
    pulse.className = "sl-agent-pulse";
    head.appendChild(pulse);
  } else if (!active && existing) {
    existing.remove();
  }
}

const AGENT_COLORS = {
  hm:    "var(--red, #ef4444)",
  llm:   "var(--purple-2, #b794ff)",
  json:  "var(--cyan, #22d3ee)",
  parse: "var(--amber, #f59e0b)",
};

function renderAll() {
  renderStream();
  for (const key of Object.keys(state)) {
    const card = findCardByAgentKey(key);
    if (!card) continue;
    renderBar(card, state[key].buckets, AGENT_COLORS[key]);
    if (key === "hm" || key === "llm") {
      mountThoughtTicker(card, key, AGENT_COLORS[key]);
      updateThoughtTicker(card, key);
    }
    // "Active" = any event in the last 5 minutes of buckets.
    const recentActivity = state[key].buckets.slice(-5).reduce((a, b) => a + b, 0);
    paintActivePulse(card, recentActivity > 0);
  }
}

// HM-specific stats refresh - Reasoning logs / 24h column + correct
// status colours.
function updateHmStats() {
  const card = findCardByAgentKey("hm");
  if (!card) return;
  const reasoningCell = card.querySelector('[data-sl-agent-stats="hm"] .agent-stat:first-child .v');
  if (reasoningCell) reasoningCell.textContent = state.hm.reasoningCount24h;
}

function updateLlmStats() {
  const card = findCardByAgentKey("llm");
  if (!card) return;
  // Find the "Money path" stat (3rd one) - repurpose to show "calls 24h".
  const stats = card.querySelectorAll(".agent-stat");
  if (stats.length >= 3) {
    const cell = stats[2].querySelector(".v");
    const lbl  = stats[2].querySelector(".l");
    if (lbl)  lbl.textContent = "Quorum calls / 24h";
    if (cell) cell.textContent = state.llm.totalQuorum > 0
      ? `${state.llm.okQuorum}/${state.llm.totalQuorum}`
      : "0";
  }
}

// ---------------------------------------------------------------------------
// Cold-start fetch - populate buckets from the last 30 minutes of logs
// ---------------------------------------------------------------------------

async function coldStart() {
  if (!CONFIG.houseManager || CONFIG.houseManager === ZERO) return;
  const head = await provider().getBlockNumber();
  // 24 hours of blocks at ~400 ms each = 216k blocks. The hourly cron can
  // stall for hours at a time (subscription edge cases), so a 30-min window
  // misses everything when activity is sparse. The chart's 28-min bucket
  // window still shows only recent buckets, but the "current thought"
  // ticker needs a fresh-enough event to feel alive on cold load.
  const dayBack = Math.max(0, head - Math.ceil((24 * 60 * 60 * 1000) / 400));
  const from = dayBack;

  // HouseManager contract handle (read-only).
  const hm = new ethers.Contract(CONFIG.houseManager, HM_ABI, provider());

  // Pull all HM events for the last 30 min in parallel.
  let events = [];
  try {
    const [reflex, tick, reasoning, rtpReq, rtpRes, rtpSkip, playerDec] = await Promise.all([
      rawFetchLogs(hm, "ReactiveBetSettledHandled", from, head).catch(() => []),
      rawFetchLogs(hm, "ReactiveHourlyTick",        from, head).catch(() => []),
      rawFetchLogs(hm, "ReasoningRequested",        from, head).catch(() => []),
      rawFetchLogs(hm, "RtpAnalysisRequested",      from, head).catch(() => []),
      rawFetchLogs(hm, "RtpAnalysisResolved",       from, head).catch(() => []),
      rawFetchLogs(hm, "AgentRequestSkipped",        from, head).catch(() => []),
      rawFetchLogs(hm, "PlayerDecisionResolved",     from, head).catch(() => []),
    ]);
    events = [reflex, tick, reasoning, rtpReq, rtpRes, rtpSkip, playerDec].flat();
  } catch (e) { console.warn("[agent-activity] HM cold-start:", e.message); }

  // Need timestamps. Use block.timestamp via a small batch read; cap at the
  // unique blocks so we don't waste calls.
  const blocks = [...new Set(events.map((e) => e.blockNumber))];
  const tsByBlock = new Map();
  await Promise.all(blocks.map(async (b) => {
    try { const blk = await provider().getBlock(b); if (blk) tsByBlock.set(b, blk.timestamp * 1000); }
    catch (_) {}
  }));

  for (const ev of events) {
    const tsMs = tsByBlock.get(ev.blockNumber) || (Date.now() - 1000);
    pushEvent(hmEventAgentKey(ev), tsMs, hmLabelFor(ev));
  }
  // Paint immediately so the HM card flips from "awaiting first event…" to
  // the latest decision the moment HM data is in - don't wait for the slow
  // casino + verifier chains that follow (those add up to ~10s of fetches
  // on a cold cache).
  renderAll();
  updateHmStats();

  // 24-hour reasoning count - pulled separately because the bucket window
  // is only 28 minutes. Sum BOTH the on-chain HM ReasoningRequested events
  // AND the off-chain hm-cron's ReasoningLog events emitted on the Casino.
  try {
    const r24 = await rawFetchLogs(hm, "ReasoningRequested", dayBack, head).catch(() => []);
    state.hm.reasoningCount24h = r24.length;
  } catch (_) {}
  // Casino-side ReasoningLog (from off-chain hm-cron narration).
  if (CONFIG.casino && CONFIG.casino !== ZERO) {
    const casino = new ethers.Contract(CONFIG.casino, CASINO_REASONING_ABI, provider());
    try {
      const [logs, bonus, rtp] = await Promise.all([
        rawFetchLogs(casino, "ReasoningLog", from, head).catch(() => []),
        rawFetchLogs(casino, "BonusModeActivated", from, head).catch(() => []),
        rawFetchLogs(casino, "RtpAdjusted", from, head).catch(() => []),
      ]);
      const allEv = [...logs, ...bonus, ...rtp];
      const newBlocks = [...new Set(allEv.map((e) => e.blockNumber).filter((b) => !tsByBlock.has(b)))];
      await Promise.all(newBlocks.map(async (b) => {
        try { const blk = await provider().getBlock(b); if (blk) tsByBlock.set(b, blk.timestamp * 1000); }
        catch (_) {}
      }));
      for (const ev of allEv) {
        const tsMs = tsByBlock.get(ev.blockNumber) || Date.now();
        pushEvent("hm", tsMs, casinoLabelFor(ev));
      }
      // Bump 24h counter with the off-chain narration too.
      const logs24 = await rawFetchLogs(casino, "ReasoningLog", dayBack, head).catch(() => []);
      state.hm.reasoningCount24h += logs24.length;
    } catch (e) { console.warn("[agent-activity] casino cold-start:", e.message); }
  }

  // Verifier (LLM Inference) events.
  if (CONFIG.agentVerifier && CONFIG.agentVerifier !== ZERO) {
    const ver = new ethers.Contract(CONFIG.agentVerifier, VERIFIER_ABI, provider());
    try {
      const qr = await rawFetchLogs(ver, "QuorumResult", from, head).catch(() => []);
      const qrBlocks = [...new Set(qr.map((e) => e.blockNumber).filter((b) => !tsByBlock.has(b)))];
      await Promise.all(qrBlocks.map(async (b) => {
        try { const blk = await provider().getBlock(b); if (blk) tsByBlock.set(b, blk.timestamp * 1000); }
        catch (_) {}
      }));
      for (const ev of qr) {
        const tsMs = tsByBlock.get(ev.blockNumber) || Date.now();
        pushEvent("llm", tsMs, llmLabelFor(ev));
      }
      const qr24 = await rawFetchLogs(ver, "QuorumResult", dayBack, head).catch(() => []);
      state.llm.totalQuorum = qr24.length;
      state.llm.okQuorum = qr24.filter((e) => Number(e.args.level) === 2).length;
    } catch (e) { console.warn("[agent-activity] verifier cold-start:", e.message); }
  }

  renderAll();
  updateHmStats();
  updateLlmStats();
}

// The HouseManager contract EMITS these events, but the actor differs: player
// betting decisions are made by the LLM Inference Agent (via inferToolsChat),
// so they belong under the LLM stream/tag, not "HOUSE MGR". Everything else
// (reflex, hourly tick, RTP flex, reasoning) is the House Manager itself.
function hmEventAgentKey(ev) {
  if (ev.name === "PlayerDecisionResolved" || ev.name === "PlayerAgentToolCall") return "llm";
  return "hm";
}

function hmLabelFor(ev) {
  switch (ev.name) {
    case "ReactiveBetSettledHandled":
      return `re-sized maxBet to ${fmtSttFromWei(ev.args.newMaxBet)} STT (bankroll ${fmtSttFromWei(ev.args.freeBankroll)})`;
    case "ReactiveHourlyTick":
      return `hourly tick · bankroll ${fmtSttFromWei(ev.args.freeBankrollNow)} STT · Δ${fmtBps(ev.args.changeBps)}%`;
    case "ReasoningRequested":
      return `${ev.args.action} · Δ${fmtBps(ev.args.changeBps)}% · bankroll ${fmtSttFromWei(ev.args.freeBankroll)} STT`;
    case "RtpAnalysisRequested":
      return `→ asking LLM for ${gameName(ev.args.game)} RTP (our ${fmtBpsPct(ev.args.ourRtpBps)}%, Δ${fmtBps(ev.args.bankrollChangeBps)}%, competitor ${ev.args.competitorRtpBps > 0n ? fmtBpsPct(ev.args.competitorRtpBps) + "%" : "unknown"})${receiptLink(ev.args.requestId)}`;
    case "RtpAnalysisResolved":
      return `← LLM decision "${ev.args.decision}": ${gameName(ev.args.game)} ${fmtBpsPct(ev.args.oldRtpBps)}% → ${fmtBpsPct(ev.args.newRtpBps)}%${receiptLink(ev.args.requestId)}`;
    case "AgentRequestSkipped": {
      // `kind` is indexed bytes32 (string-hashed by event semantics) - ethers
      // surfaces it as a Result. `reason` is the plain string we emitted.
      // Most "skips" are intelligent no-ops (cost-saving smart-skip, the
      // spam-firewall, fixed-edge games) - frame them honestly instead of as
      // errors so the activity feed reads as decisions, not failures.
      const r = String(ev.args.reason || "");
      const friendly = {
        "no-meaningful-change": "RTP held — competitors in band & bankroll flat, no LLM call needed",
        "game-not-adjustable": "roulette uses a fixed-edge model — no RTP flex needed",
        "game-not-supported": "roulette uses a fixed-edge model — no competitor pull needed",
        "insufficient-vault-budget": "player vault below the LLM fee — agent paused (spam-safe)",
        "insufficient-casino-share": "house reserve low — deferring this tick",
        "insufficient-balance": "house reserve low — deferring this tick",
        "collect-fee-failed": "player vault couldn't cover the LLM fee — skipped",
        "no-consensus": "validators didn't reach consensus — skipped",
        "decode-failed": "agent reply didn't parse — skipped",
        "platform-not-wired": "agent platform not configured",
        "not-wired": "player registry not configured",
        "inactive": "player agent is paused",
        "url-not-set": "news feed URL not set",
      };
      return friendly[r] || `request skipped: ${r}`;
    }
    case "PlayerDecisionResolved": {
      // gen-14: the per-player LLM Player Agent (inferToolsChat). It either
      // yielded a placeBet tool call (placed a real bet from the vault) or
      // finished without betting.
      const who = shortAddr(ev.args.player);
      if (ev.args.placed) {
        return `player ${who} agent bet ${fmtSttFromWei(ev.args.stakeWei)} STT on ${gameName(ev.args.game)} (LLM tool call #${ev.args.betId})`;
      }
      const d = String(ev.args.decision || "");
      const why = d === "SKIP" ? "chose to skip this tick"
        : d === "DONE" ? "finished its turn"
        : d === "NO_CONSENSUS" ? "LLM consensus failed - skipped"
        : d === "DECODE_FAIL" ? "tool-call decode failed - skipped"
        : d.toLowerCase();
      return `player ${who} agent ${why}`;
    }
    default:
      return ev.name;
  }
}

function casinoLabelFor(ev) {
  switch (ev.name) {
    case "ReasoningLog":
      // The HM cron narrates its decisions here - short string. Clamp.
      return `narrated: "${(ev.args.thought || "").trim().slice(0, 120)}"`;
    case "BonusModeActivated": {
      const minutes = Math.round((Number(ev.args.until) - Date.now() / 1000) / 60);
      const dur = minutes > 0 ? `${minutes} min remaining` : "expired";
      return `Bonus Mode ON · ${dur} · ${ev.args.reasoning}`;
    }
    case "RtpAdjusted":
      return `RTP ${gameName(ev.args.game)}: ${(Number(ev.args.oldRtpBps)/100).toFixed(2)}% → ${(Number(ev.args.newRtpBps)/100).toFixed(2)}% · ${ev.args.reasoning}`;
    default:
      return ev.name;
  }
}

function llmLabelFor(ev) {
  const lvl = Number(ev.args.level);
  const tag = lvl === 2 ? "OK" : lvl === 1 ? "WARN" : "CRIT";
  const sig = `${ev.args.signers}/${ev.args.totalWorkers}`;
  // sampleResponse may contain control characters / very long hex - clamp.
  let sample = (ev.args.sampleResponse || "").trim().slice(0, 90);
  if (!sample) sample = `bet #${ev.args.betId}`;
  return `bet #${ev.args.betId} · ${sig} signers ${tag} · "${sample}"${receiptLink(ev.args.requestId)}`;
}

function fmtSttFromWei(wei) {
  try {
    const eth = Number(ethers.formatEther(wei));
    if (eth >= 100) return eth.toFixed(0);
    if (eth >= 1)   return eth.toFixed(2);
    return eth.toFixed(4);
  } catch { return "?"; }
}
function fmtBps(bps) {
  const n = Number(bps);
  const sign = n >= 0 ? "+" : "−";
  return `${sign}${(Math.abs(n) / 100).toFixed(2)}`;
}
function fmtBpsPct(bps) {
  return (Number(bps) / 100).toFixed(2);
}
function gameName(g) { return GAME_NAMES[Number(g)] || `game#${g}`; }
function shortAddr(a) { const s = String(a || ""); return s.length >= 10 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s; }

// ---------------------------------------------------------------------------
// Real-time subscription via WS (push-path). Falls back to a polling tick.
// ---------------------------------------------------------------------------

function subscribeRealtime() {
  const ws = wsProvider();
  if (!ws || !CONFIG.houseManager || CONFIG.houseManager === ZERO) {
    // Poll fallback: re-cold-start every 30s. Cheap because Shannon
    // Explorer indexes everything.
    setInterval(() => { coldStart().catch(() => {}); }, 30_000);
    return;
  }
  const hm = new ethers.Contract(CONFIG.houseManager, HM_ABI, ws);
  const ver = (CONFIG.agentVerifier && CONFIG.agentVerifier !== ZERO)
    ? new ethers.Contract(CONFIG.agentVerifier, VERIFIER_ABI, ws)
    : null;

  // Subscribe to each event topic via the CONTRACT instance, not the raw
  // provider. ethers v6 only accepts ProviderEvent-shaped filters on
  // provider.on() (string name | {address, topics}); a DeferredTopicFilter
  // from contract.filters[name]() must be passed to contract.on() instead -
  // otherwise it throws INVALID_ARGUMENT "unknown ProviderEvent".
  const subscribeHm = (name) => {
    try {
      hm.on(name, (...args) => {
        const ev = args[args.length - 1]; // EventPayload, has .log + .args
        try {
          const log = ev.log || ev;
          const parsedArgs = ev.args || hm.interface.parseLog(log).args;
          const synthetic = { name, args: parsedArgs, blockNumber: log.blockNumber };
          pushEvent(hmEventAgentKey(synthetic), Date.now(), hmLabelFor(synthetic));
          if (name === "ReasoningRequested") state.hm.reasoningCount24h++;
          renderAll();
          updateHmStats();
        } catch (e) { /* parse fail; ignore */ }
      });
    } catch (e) { /* event missing on older HM - skip */ }
  };
  ["ReactiveBetSettledHandled", "ReactiveHourlyTick", "ReasoningRequested",
   "RtpAnalysisRequested", "RtpAnalysisResolved", "AgentRequestSkipped",
   "PlayerDecisionResolved"]
    .forEach(subscribeHm);

  if (ver) {
    try {
      ver.on("QuorumResult", (...args) => {
        const ev = args[args.length - 1];
        try {
          const log = ev.log || ev;
          const parsedArgs = ev.args || ver.interface.parseLog(log).args;
          const synthetic = { name: "QuorumResult", args: parsedArgs, blockNumber: log.blockNumber };
          pushEvent("llm", Date.now(), llmLabelFor(synthetic));
          state.llm.totalQuorum++;
          if (Number(parsedArgs.level) === 2) state.llm.okQuorum++;
          renderAll();
          updateLlmStats();
        } catch (e) { /* ignore */ }
      });
    } catch (_) {}
  }

  // Casino-side narration from the off-chain hm-cron loop. These are the
  // most frequent events while the demo is live (every 5 min for maxBet
  // adjustments + ad-hoc bonus mode / RTP changes).
  if (CONFIG.casino && CONFIG.casino !== ZERO) {
    const casino = new ethers.Contract(CONFIG.casino, CASINO_REASONING_ABI, ws);
    const subscribeCasino = (name) => {
      try {
        casino.on(name, (...args) => {
          const ev = args[args.length - 1];
          try {
            const log = ev.log || ev;
            const parsedArgs = ev.args || casino.interface.parseLog(log).args;
            const synthetic = { name, args: parsedArgs, blockNumber: log.blockNumber };
            pushEvent("hm", Date.now(), casinoLabelFor(synthetic));
            if (name === "ReasoningLog") state.hm.reasoningCount24h++;
            renderAll();
            updateHmStats();
          } catch (_) {}
        });
      } catch (_) {}
    };
    ["ReasoningLog", "BonusModeActivated", "RtpAdjusted"].forEach(subscribeCasino);
  }
}

// Roll the buckets every minute so old activity scrolls off the left edge.
function startBucketScroller() {
  setInterval(() => {
    for (const key of Object.keys(state)) {
      state[key].buckets.shift();
      state[key].buckets.push(0);
    }
    renderAll();
  }, BUCKET_MS);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function boot() {
  // Only run on pages that actually have agent cards (lobby + docs).
  if (!document.querySelector(".agent-card")) return;
  injectStyles();
  // Render once with empty buckets so the bars appear immediately while
  // the cold-start fetch is in flight.
  renderAll();
  // For JSON / Parse - those agents have no v1 chain wiring. Render a single
  // "queued" thought so the cards don't look broken.
  for (const key of ["json", "parse"]) {
    const card = findCardByAgentKey(key);
    if (card) {
      mountThoughtTicker(card, key, AGENT_COLORS[key]);
      const host = card.querySelector(`.sl-agent-thought[data-agent="${key}"] .sl-thought-line`);
      if (host) host.textContent = "registered with Somnia Agent Platform - awaiting v2 binding";
    }
  }
  coldStart().catch((e) => console.warn("[agent-activity] coldStart:", e.message));
  subscribeRealtime();
  startBucketScroller();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
