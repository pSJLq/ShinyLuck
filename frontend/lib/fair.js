// fair.html - latest receipt, live flow-step previews, browser-side
// keccak256 verifier modal. All log reads go through lib/rpc.js.
//
// Public URL contract: /fair.html?betId=N - focuses on a specific bet
// (used by account.html → "open receipt →" link). Without the param, we
// render the most-recent BetSettled in the window.

import { ethers } from "/vendor/ethers.bundle.js";
import { CONFIG } from "./config.js";
import { provider, wsProvider, fetchLogs, fetchDeploymentBlock } from "./rpc.js";
import { vaultAddress, deploymentBlock as v15DeployBlock } from "./casino-sources.js";

// The live casino is the v15 Vault. `CONFIG.casino` is the frozen v14
// monolith, and its BetSettled takes `uint8 indexed game` where v15 takes
// `uint16 indexed gameId` — different topic0, so the old ABI matched nothing
// here and the page sat on "no settled bets in window yet" forever.
const VAULT_ADDR = vaultAddress();

const GAMES = ["DICE","CRASH","VAULT.7","MINES","PLINKO","ROULETTE","SUGAR.LAB"];
const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = "0x" + "0".repeat(64);
// Fast path only. This used to be described as "≈ 7 hours", which was true at
// 1.2s blocks; Somnia now produces a block every 0.100s (measured), so the same
// 20k covers about 33 MINUTES of chain. Dice and Plinko settle far less often
// than that, so the page sat on "no settled bets in window yet" indefinitely.
// The window is kept because a log carries the settle tx hash; when it comes up
// empty we rebuild the receipt from Vault state instead (receiptFromState).
const LOOKBACK = 20_000;
// CommitReveal.REVEAL_DELAY - the randomness mixes in blockhash(commitBlock + 1).
const REVEAL_DELAY = 1;
const EXPLORER = "https://shannon-explorer.somnia.network";

function $(s) { return document.querySelector(s); }
function fmtAddr(a) { return `${a.slice(0,6)}…${a.slice(-4)}`; }
function fmtSTT(wei) {
  if (typeof wei !== "bigint") wei = BigInt(wei);
  const eth = Number(ethers.formatEther(wei));
  if (eth >= 1) return eth.toFixed(2);
  if (eth >= 0.01) return eth.toFixed(3);
  return eth.toFixed(4);
}
function explorerTx(h)   { return `${EXPLORER}/tx/${h}`; }
function readQueryBetId() {
  try { return new URL(location.href).searchParams.get("betId"); } catch (_) { return null; }
}

const casinoAbi = [
  "event BetPlaced(uint256 indexed betId,address indexed player,uint16 indexed gameId,uint256 amount,bytes32 clientSeed,uint256 commitBlock,uint256 seedIdx,bytes params)",
  "event BetSettled(uint256 indexed betId,address indexed player,uint16 indexed gameId,bool won,uint256 payout,bytes32 randomness,bytes32 serverSeed,bytes32 clientSeed,bytes32 blockHash,uint256 nonce,bytes resultData)",
  "function seedHashes(uint256) view returns (bytes32)",
  "function seedPoolStatus() view returns (uint256 total,uint256 consumed,uint256 available)",
  "function totalBets() view returns (uint256)",
  "function revealedSeed(uint256) view returns (bytes32)",
  "function getBet(uint256) view returns (tuple(address player,uint96 amount,uint16 gameId,uint8 status,uint64 commitBlock,uint64 nonce,uint256 seedIdx,bytes32 clientSeed,bytes params,bytes32 randomness,uint128 payout,bool won))",
];

let lastReceipt = null;   // the BetSettled args we last rendered

function deriveExpectedRandomness({ serverSeed, clientSeed, blockHash, nonce }) {
  // Mirror of CommitReveal.deriveRandomness:
  //   keccak256(abi.encodePacked(serverSeed, clientSeed, futureHash, nonce))
  return ethers.solidityPackedKeccak256(
    ["bytes32", "bytes32", "bytes32", "uint256"],
    [serverSeed, clientSeed, blockHash, nonce]
  );
}

function setFlowPreviews(settledEv, placedEv) {
  if (!settledEv) return;
  const a = settledEv.args;
  // Step 1: hash of the active serverSeed for this slot. We can't look up the
  // seedHashes index without a separate read; use keccak256(serverSeed) as the
  // canonical reveal-time hash (matches what was committed).
  const hash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [a.serverSeed]));
  const el1 = $("[data-sl-fair-hash]"); if (el1) el1.textContent = hash.slice(0, 14) + "…" + hash.slice(-4);
  // Step 2: client seed
  const el2 = $("[data-sl-fair-client]");
  if (el2) el2.textContent = a.clientSeed.slice(0, 10) + "…" + a.clientSeed.slice(-4);
  // Step 4: tx. A receipt rebuilt from state (see receiptFromState) has no
  // settle tx to point at - fall back to the Vault's own explorer page rather
  // than throwing on a null hash.
  const tx = settledEv.transactionHash;
  const el4 = $("[data-sl-fair-tx]");
  if (el4) {
    el4.textContent = tx ? tx.slice(0, 10) + "…" + tx.slice(-4) : "read from contract state";
    el4.href = tx ? explorerTx(tx) : `${EXPLORER}/address/${VAULT_ADDR}`;
  }
  // Receipt-actions explorer link
  const xa = $("[data-sl-fair-explorer]");
  if (xa) xa.href = tx ? explorerTx(tx) : `${EXPLORER}/address/${VAULT_ADDR}`;
}

function setReceipt(settledEv) {
  lastReceipt = settledEv;
  const tgt = $("[data-sl-receipt]");
  if (!tgt) return;
  if (!settledEv) {
    tgt.innerHTML = '<span class="dim">no settled bets in window yet - place one and come back.</span>';
    return;
  }
  const a = settledEv.args;
  // v15's BetSettled names this arg `gameId` (v14 called it `game`), so reading
  // `a.game` gave NaN and every receipt printed "game ?".
  const game = GAMES[Number(a.gameId)] || "?";
  const payout = a.payout > 0n ? ethers.formatEther(a.payout) : "0";
  // Actually re-derive it here instead of printing a decorative tick: this is
  // the fairness page, so the line has to be the result of a real comparison.
  const reDerived = deriveExpectedRandomness({
    serverSeed: a.serverSeed, clientSeed: a.clientSeed, blockHash: a.blockHash, nonce: a.nonce,
  });
  const ok = reDerived.toLowerCase() === a.randomness.toLowerCase();
  tgt.innerHTML = `<span class="k">bet_id</span>            <span class="v">${a.betId.toString()}</span>
<span class="k">player</span>            <span class="v">${a.player}</span>
<span class="k">game</span>              <span class="v">${game.toLowerCase()}</span>
<span class="k">entropy_block</span>     <span class="v">${settledEv.blockNumber}</span>
<span class="k">client_seed</span>       <span class="v">${a.clientSeed}</span>
<span class="k">server_seed</span>       <span class="v">${a.serverSeed}</span>
<span class="k">block_hash</span>        <span class="v">${a.blockHash}</span>
<span class="k">nonce</span>             <span class="v">${a.nonce}</span>

<span class="c">// reveal phase ─────────────────────────────────────</span>
<span class="k">randomness</span>        <span class="v">${a.randomness}</span>
<span class="k">won</span>               <span class="${a.won ? 'green' : 'dim'}">${a.won}</span>
<span class="k">payout</span>            <span class="green">${payout} STT</span>

<span class="c">// verify locally (browser-side) ────────────────────</span>
<span class="dim">$ </span><span class="cmd">expected = keccak256(serverSeed ‖ clientSeed ‖ blockHash ‖ nonce)</span>
<span class="k">expected</span>          <span class="v">${reDerived}</span>
${ok
  ? '<span class="green">✓ on-chain randomness matches the off-chain re-hash</span>'
  : '<span style="color:var(--red)">✗ MISMATCH - do not trust this receipt, please report it</span>'}`;

  const meta = $("[data-sl-receipt-meta]");
  if (meta) meta.textContent = `betId ${a.betId} · player ${fmtAddr(a.player)} · ${game}`;
}

function buildReceiptJSON(settledEv) {
  if (!settledEv) return "{}";
  const a = settledEv.args;
  return JSON.stringify({
    betId:       a.betId.toString(),
    player:      a.player,
    game:        GAMES[Number(a.gameId)] || String(a.gameId),
    won:         a.won,
    payoutWei:   a.payout.toString(),
    randomness:  a.randomness,
    serverSeed:  a.serverSeed,
    clientSeed:  a.clientSeed,
    blockHash:   a.blockHash,
    nonce:       a.nonce.toString(),
    txHash:      settledEv.transactionHash,   // null when rebuilt from state
    entropyBlock: settledEv.blockNumber,      // blockhash(commitBlock + 1)
    network:     CONFIG.network,
    casino:      VAULT_ADDR,
  }, null, 2);
}

function openVerifyModal() {
  if (!lastReceipt) return;
  const a = lastReceipt.args;
  const inputs = `serverSeed: ${a.serverSeed}
clientSeed: ${a.clientSeed}
blockHash:  ${a.blockHash}
nonce:      ${a.nonce.toString()}`;
  const expected = deriveExpectedRandomness({
    serverSeed: a.serverSeed,
    clientSeed: a.clientSeed,
    blockHash:  a.blockHash,
    nonce:      a.nonce,
  });
  const match = expected.toLowerCase() === a.randomness.toLowerCase();
  $("[data-sl-verify-inputs]").textContent = inputs;
  $("[data-sl-verify-expected]").textContent = expected;
  $("[data-sl-verify-onchain]").textContent = a.randomness;
  const m = $("[data-sl-verify-match]");
  m.innerHTML = match
    ? `<span style="color:var(--green); font-weight:600;">✓ MATCH - locally derived randomness equals the on-chain value byte-for-byte.</span>`
    : `<span style="color:var(--red); font-weight:600;">✗ MISMATCH - file a bug, this should never happen.</span>`;
  $("[data-sl-verify-modal]").style.display = "flex";
}

// Rebuild a full, verifiable receipt from Vault STATE rather than from a log.
// Every input the verifier needs is public state, so this works for any bet ever
// placed - not just one inside the log window:
//   getBet(id)               → player, gameId, clientSeed, commitBlock, nonce,
//                              randomness, payout, won
//   revealedSeed(seedIdx)    → the server seed that was revealed
//   getBlock(commitBlock + 1) → the block hash that got mixed in
// The one thing state cannot give us is the settle transaction hash, so the
// returned shape carries `transactionHash: null` and callers degrade the link.
async function receiptFromState(casino, betId) {
  const b = await casino.getBet(betId);
  if (Number(b.status) !== 1) return null;   // 0 = pending, 2 = refunded
  const revealBlock = Number(b.commitBlock) + REVEAL_DELAY;
  const [serverSeed, blk] = await Promise.all([
    casino.revealedSeed(b.seedIdx).catch(() => ZERO_HASH),
    provider().getBlock(revealBlock).catch(() => null),
  ]);
  return {
    blockNumber: revealBlock,
    transactionHash: null,
    args: {
      betId: BigInt(betId),
      player: b.player,
      gameId: b.gameId,
      won: b.won,
      payout: b.payout,
      randomness: b.randomness,
      serverSeed,
      clientSeed: b.clientSeed,
      blockHash: blk ? blk.hash : ZERO_HASH,
      nonce: b.nonce,
    },
  };
}

// Newest bet whose status is `settled`, walking back from the counter. Bounded
// so a long tail of pending bets can never turn one page load into hundreds of
// reads. Memoised on the bet counter: it only re-walks when a new bet exists.
let _walkMemo = { total: -1, id: null };
async function newestSettledBetId(casino) {
  const total = Number(await casino.totalBets());
  if (total === _walkMemo.total) return _walkMemo.id;
  let found = null;
  for (let id = total - 1; id >= 0 && id > total - 1 - 25; id--) {
    try {
      const b = await casino.getBet(id);
      if (Number(b.status) === 1) { found = id; break; }
    } catch (_) { break; }
  }
  _walkMemo = { total, id: found };
  return found;
}

async function refresh() {
  if (!VAULT_ADDR || VAULT_ADDR === ZERO) return;
  const head = await provider().getBlockNumber();
  // Clamp to the Vault's own age - never scan blocks before it existed.
  const dep = v15DeployBlock();
  const fromBlock = dep > 0 ? Math.max(dep, head - LOOKBACK) : (head - LOOKBACK);

  const casino = new ethers.Contract(VAULT_ADDR, casinoAbi, provider());
  const queryBet = readQueryBetId();

  let target = null;
  // Parallel: the settled-bet window and the live seed-pool counters, so the
  // "Commit" step shows real numbers instead of prose.
  const [settled, pool] = await Promise.all([
    fetchLogs(casino, "BetSettled", fromBlock, head),
    casino.seedPoolStatus().catch(() => null),
  ]);

  const poolEl = $("[data-sl-seed-pool]");
  if (poolEl) {
    poolEl.textContent = pool
      ? `${pool[0]} committed · ${pool[2]} unused`
      : "unavailable";
  }

  let fromLog = null;
  if (queryBet) {
    fromLog = settled.find((ev) => ev.args.betId.toString() === queryBet) || null;
    target = fromLog || await receiptFromState(casino, queryBet).catch(() => null);
  } else if (settled.length > 0) {
    settled.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
    fromLog = settled[0];
    target = fromLog;
  } else {
    const id = await newestSettledBetId(casino).catch(() => null);
    if (id !== null) target = await receiptFromState(casino, id).catch(() => null);
  }

  // When the receipt came from a log, enrich it from state so BOTH paths print
  // the same fields: a log's own `blockNumber` is where the SETTLE landed, while
  // the number that matters for verification is the entropy block whose hash was
  // mixed in. Keep the log's tx hash, take the entropy block from state.
  if (fromLog) {
    const st = await receiptFromState(casino, fromLog.args.betId).catch(() => null);
    if (st) target = { ...st, transactionHash: fromLog.transactionHash };
  }

  setReceipt(target);
  if (target) setFlowPreviews(target);
}

document.addEventListener("DOMContentLoaded", () => {
  // Loading gate - hide page-shell until the first refresh resolves so the
  // user never sees "loading latest receipt…" before real data lands.
  document.body.dataset.loading = "1";
  refresh()
    .catch((e) => console.warn("[fair] initial refresh:", e.message))
    .finally(() => {
      delete document.body.dataset.loading;
      document.dispatchEvent(new CustomEvent("shinyluck:ready"));
    });
  // Slow safety poll (every 30s) as a fallback. The WS subscription below
  // delivers new receipts within ~1s of each settle - no need to spam.
  setInterval(() => refresh().catch(() => {}), 30_000);

  // Real-time receipt updates: subscribe to BetSettled events via WS so the
  // page shows the freshest settled bet within ~1s of it landing on chain.
  // Skipped when the URL pins a specific bet (?betId=…) - that mode shows
  // exactly one historical receipt.
  if (!readQueryBetId()) {
    const ws = wsProvider();
    if (ws) {
      try {
        const casinoAbi = [
          "event BetSettled(uint256 indexed betId,address indexed player,uint16 indexed gameId,bool won,uint256 payout,bytes32 randomness,bytes32 serverSeed,bytes32 clientSeed,bytes32 blockHash,uint256 nonce,bytes resultData)"
        ];
        const c = new ethers.Contract(VAULT_ADDR, casinoAbi, ws);
        const settledTopic = c.interface.getEvent("BetSettled").topicHash;
        ws.on({ address: VAULT_ADDR, topics: [settledTopic] }, () => {
          // Cheap: just re-run refresh() which will pick up the latest
          // settled (it sorts by blockNumber desc and grabs [0]).
          refresh().catch(() => {});
        });
      } catch (e) {
        console.warn("[fair] WS subscribe failed, polling-only:", e.message);
      }
    }
  }

  $("[data-sl-fair-copy]")?.addEventListener("click", async () => {
    const json = buildReceiptJSON(lastReceipt);
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(json);
      const btn = $("[data-sl-fair-copy]");
      const old = btn.textContent;
      btn.textContent = "✓ copied receipt JSON";
      setTimeout(() => { btn.textContent = old; }, 1800);
    } catch (e) { import("./ui.js").then(({ toast }) => toast("Clipboard write failed: " + e.message, { kind: "error" })); }
  });
  $("[data-sl-fair-verify]")?.addEventListener("click", openVerifyModal);
  $("[data-sl-verify-close]")?.addEventListener("click", () => {
    $("[data-sl-verify-modal]").style.display = "none";
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $("[data-sl-verify-modal]").style.display = "none";
  });
});
