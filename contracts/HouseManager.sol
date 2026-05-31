// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Casino} from "./Casino.sol";
import {SomniaEventHandler} from "@somnia-chain/reactivity-contracts/contracts/SomniaEventHandler.sol";
import {SomniaExtensions} from "@somnia-chain/reactivity-contracts/contracts/interfaces/SomniaExtensions.sol";
import {
    IAgentRequester,
    IAgentRequesterHandler,
    ILLMAgent,
    IJsonApiAgent,
    IParseWebsiteAgent,
    Response,
    Request,
    ResponseStatus,
    ConsensusType
} from "./interfaces/ISomniaAgent.sol";

/// @title HouseManager (reactive)
/// @notice Acts as Casino's `houseManager` authority AND as a SomniaEventHandler
///         that the Somnia Reactivity precompile (0x0100) can invoke directly.
///         Two reactive paths:
///           1. BetSettled events from Casino → recompute defaultMaxBet
///              proportional to bankroll. This is the per-event reflex; it
///              fires every time a player settles a bet.
///           2. A self-rescheduling hourly cron → snapshot bankroll, decide on
///              Bonus Mode / RTP adjustments / pause-hot-games, log reasoning.
///         The off-chain agent key (hmAgent) is still allowed for fallback /
///         manual operations (admin panel "force pause", etc.), but the
///         reactive paths are the primary autonomy mechanism.
contract HouseManager is SomniaEventHandler, Ownable, IAgentRequesterHandler {
    Casino public immutable casino;
    address public hmAgent;

    // -------------------------------------------------------------------
    // Somnia Agent Platform integration - autonomous on-chain agent chain
    // -------------------------------------------------------------------
    // Two-stage chain triggered by the hourly Reactivity cron:
    //
    //   Stage 1 (JSON API Agent) - fetchUint(competitorFeedUrl,
    //     "slots_rtp_avg_bps" | "cluster_rtp_avg_bps", 0) → average RTP
    //     of competing online casinos in basis points (e.g. 9533 = 95.33%).
    //     Fetched from a public JSON feed that aggregates RTP data from
    //     casino-review sites (askgamblers.com, casinoguru.com,
    //     gambling.com - manually reviewed sample of Stake, BC.game,
    //     Wink, Roobet, etc.). Anyone can audit or replace the feed URL
    //     via `setCompetitorFeedUrl`.
    //
    //   Stage 2 (LLM Inference Agent) - given (our_rtp, bankroll,
    //     1h_bankroll_change, competitor_avg_rtp), pick ONE of {LOWER,
    //     HOLD, RAISE, BIG_BONUS}. inferString + allowedValues guarantees
    //     a parseable answer. Majority consensus on byte-identical output
    //     (deterministic Qwen3-30B with temperature=0).
    //
    //   HM applies the decision via casino.adjustSlotRTP / activateBonusMode.
    //   If our RTP is below competitor avg → LLM tends to RAISE. Above →
    //   tends to LOWER. The agent has full freedom; reasoning is on-chain.
    //
    // Critical pricing (from somnia-chain/agentathon references/agents.json):
    //   - JSON API Agent: 0.03 STT per worker × 3 = 0.09 + 0.03 reserve = 0.12 STT
    //   - LLM Inference:  0.07 STT per worker × 3 = 0.21 + 0.03 reserve = 0.24 STT
    //   Full hourly chain = 2 JSON + 2 LLM = ~0.72 STT/hour, ~17 STT/day.
    //   48 STT funding (32 floor + 16 buffer) = ~2.5 days unattended runway.
    //
    // Earlier version used 0.001 STT per worker and ConsensusType.NUMERIC -
    // both wrong. Platform took the reserve, runners saw perAgentBudget=0,
    // ignored the request, timed out silently. Documented "most common
    // footgun". Fixed here.
    IAgentRequester public agentPlatform;
    uint256 public llmAgentId   = 12847293847561029384;
    uint256 public jsonAgentId  = 13174292974160097713;
    uint256 public parseAgentId = 12875401142070969085;
    uint256 public llmPricePerWorker   = 0.07 ether;
    uint256 public jsonPricePerWorker  = 0.03 ether;
    uint256 public parsePricePerWorker = 0.05 ether;
    uint8   public agentSubcommitteeSize = 3;
    uint16  public minRtpBps = 8500;   // 85.00% floor
    uint16  public maxRtpBps = 9700;   // 97.00% ceiling

    // News-driven Bonus Mode trigger via Parse Website Agent. Every hourly
    // tick we ask the agent to extract the latest crypto headline from a
    // configured URL (e.g. cryptopanic.com / coindesk). The headline goes
    // straight into an LLM Inference call with allowedValues = [BIG_BONUS,
    // HOLD]: bullish news → activate Bonus Mode 60 min, neutral → skip.
    // Cheap (~0.15 + 0.24 STT per tick) AND uses the 3rd agent type so the
    // economics widget on the lobby shows all four platform tracks active.
    string public newsFeedUrl = "https://jsonblob.com/api/jsonBlob/019e555c-25db-7e74-a62d-31c135e87539";
    string public newsCssSelector = "$.headline_top";
    mapping(uint256 => bool)   public pendingNewsParse;
    mapping(uint256 => string) public pendingNewsHeadline; // requestId → headline awaiting LLM verdict
    string  public lastNewsHeadline;
    uint256 public lastNewsHeadlineTs;
    event NewsHeadlineRequested(uint256 indexed requestId, string url);
    event NewsHeadlineResolved(uint256 indexed requestId, string headline);
    event NewsBonusDecisionRequested(uint256 indexed requestId, string headline);
    event NewsBonusDecisionResolved(uint256 indexed requestId, string decision);

    // Tick cadence. Lower = more events visible on the lobby but more STT
    // burnt per day. 1800 = 30 min. Owner-settable so we can dial up
    // (`setHourlyTickIntervalSeconds(900)` = every 15 min) for showcases or
    // dial down for quiet periods. Hardcoded floor of 300s prevents runaway.
    uint256 public hourlyTickIntervalSeconds = 1800;

    // Smart-skip threshold for RTP analysis. If |bankroll Δ% in last hour|
    // is below this, don't fire the LLM call - nothing meaningful to decide.
    // bps = basis points (100 = 1%). Default 100 = "skip if change < 1%".
    uint16 public rtpAnalysisSkipBps = 100;

    // ShinyLuck Competitor RTP Research feed - public JSON endpoint.
    // Owner-updatable. Keys this contract reads:
    //   slots_rtp_avg_bps   (uint)  - average RTP across competitor slot games
    //   cluster_rtp_avg_bps (uint)  - average RTP across competitor cluster games
    string public competitorFeedUrl = "https://jsonblob.com/api/jsonBlob/019e555c-25db-7e74-a62d-31c135e87539";

    // Per-requestId routing. analysisGame = SLOTS+1 | CLUSTER+1 (so 0 means
    // "no entry"). competitorGame mirror serves the JSON-API leg.
    mapping(uint256 => uint8) public pendingAnalysisGame;
    mapping(uint256 => uint8) public pendingCompetitorGame;

    // Last-fetched competitor RTP per game, in basis points. Used as input
    // to the next LLM decision. Stale window enforced by the hourly cron.
    mapping(uint8 => uint256) public lastCompetitorRtpBps; // gameId → bps
    mapping(uint8 => uint256) public lastCompetitorRtpTs;  // gameId → ts seconds

    event AgentPlatformSet(address indexed platform, uint256 llmAgentId, uint256 jsonAgentId);
    event CompetitorFeedUrlSet(string url);
    event CompetitorRtpRequested(uint256 indexed requestId, uint8 indexed game, string url);
    event CompetitorRtpResolved(uint256 indexed requestId, uint8 indexed game, uint256 rtpBps);
    event RtpAnalysisRequested(uint256 indexed requestId, uint8 indexed game, uint16 ourRtpBps, int256 bankrollChangeBps, uint256 competitorRtpBps);
    event RtpAnalysisResolved(uint256 indexed requestId, uint8 indexed game, uint16 oldRtpBps, uint16 newRtpBps, string decision, string sample);
    event AgentRequestSkipped(string indexed kind, string reason);

    // -------------------------------------------------------------------
    // Player Agent dispatcher - on-chain LLM decisions per active player
    // -------------------------------------------------------------------
    //
    // Each hourly tick, HM iterates the first MAX_PLAYERS_PER_TICK active
    // players from PlayerAgentRegistry. For each one, it fires a Somnia
    // LLM Inference request with their permittedGamesMask + remaining
    // daily budget + vault balance and forces the LLM to reply with one
    // of the allowedValues:
    //   SKIP | DICE_0.1 | DICE_0.5 | SLOTS_0.5 | CLUSTER_0.5 | PLINKO_0.5 | ROULETTE_0.5
    //
    // The callback decodes the decision and calls registry.executeBet on
    // behalf of the player from their AgentVault. Fully on-chain - no
    // off-chain executor required.
    //
    // Cost-bounded: capped at MAX_PLAYERS_PER_TICK per tick so a busy
    // demo doesn't drain HM's STT buffer. Adjustable via setter.

    /// @notice PlayerAgentRegistry that HM dispatches bets through. HM must
    ///         also be in registry.executors (set via registry.addExecutor).
    address public playerRegistry;
    uint8   public maxPlayersPerTick = 5;
    /// @notice Share of the per-player LLM-call cost that the casino subsidises.
    ///         0 = user pays 100% (default; spam-proof). 5000 = 50/50 split
    ///         (promo periods). 10000 = casino pays 100% (legacy demo mode).
    ///         Anything above 10000 is rejected by the setter.
    uint16  public agentDecisionSubsidyBps = 0;
    /// @notice requestId → packed (player address << 8) | gameOptionsCount.
    ///         Stored so handleResponse routes correctly without scanning.
    mapping(uint256 => address) public pendingPlayerDecision;

    event PlayerRegistrySet(address indexed registry);
    event PlayerDecisionRequested(uint256 indexed requestId, address indexed player, uint256 vaultBalance, uint256 spentTodayWei, uint256 dailyLimitWei);
    event PlayerDecisionResolved(uint256 indexed requestId, address indexed player, string decision, uint8 game, uint256 stakeWei, uint256 betId, bool placed);

    // BetSettled topic0: keccak256("BetSettled(uint256,address,uint8,bool,uint256,bytes32,bytes32,bytes32,bytes32,uint256,bytes)")
    // We don't hardcode the literal hash here - instead we compare emitter
    // to casino and trust the subscription filter to route only BetSettled.
    // (The setup-reactivity.js script registers a filter that includes the
    // exact topic0; if any other event slips through, _onEvent just ignores.)

    // Hourly bankroll ring buffer (last 24 hourly samples).
    uint256[24] private _hourlyBankroll;
    uint256[24] private _hourlyTs;
    uint8 private _ringIdx;
    uint256 public lastHourlyTickTs;

    // Subscription IDs we own (so admin can refund / re-create them later).
    uint256 public betSettledSubId;
    uint256 public hourlyCronSubId;

    event HmAgentUpdated(address indexed prev, address indexed next);
    event ReactiveBetSettledHandled(uint256 newMaxBet, uint256 freeBankroll);
    event ReactiveHourlyTick(uint256 freeBankrollNow, int256 changeBps);
    event ReasoningRequested(string action, int256 changeBps, uint256 freeBankroll, uint256 timestamp);
    event SubscriptionFunded(uint256 amount);
    event SubscriptionCreated(uint256 indexed subId, string kind);

    error NotHmAgent();

    modifier onlyAgent() {
        if (msg.sender != hmAgent) revert NotHmAgent();
        _;
    }

    constructor(address casino_, address hmAgent_) Ownable(msg.sender) {
        casino = Casino(payable(casino_));
        hmAgent = hmAgent_;
        emit HmAgentUpdated(address(0), hmAgent_);
    }

    receive() external payable {
        if (msg.value > 0) emit SubscriptionFunded(msg.value);
    }

    function setHmAgent(address next) external onlyOwner {
        emit HmAgentUpdated(hmAgent, next);
        hmAgent = next;
    }

    // ---------------------------------------------------------------------
    // Reactive path (Somnia validators → 0x0100 precompile → _onEvent)
    // ---------------------------------------------------------------------

    function _onEvent(
        address emitter,
        bytes32[] calldata eventTopics,
        bytes calldata /* data */
    ) internal override {
        if (eventTopics.length == 0) return;

        // The reactivity precompile delivers Schedule pings with topic[0] ==
        // ISomniaReactivityPrecompile.Schedule.selector and the scheduled
        // timestamp in topic[1]. Treat anything whose emitter is the
        // precompile itself as a cron tick; anything from casino with a
        // BetSettled-shaped payload as a per-bet reflex.
        if (emitter == SomniaExtensions.SOMNIA_REACTIVITY_PRECOMPILE_ADDRESS) {
            _onHourlyTick();
            _rescheduleHourlyTick();
            return;
        }
        if (emitter == address(casino)) {
            _onBetSettled();
            return;
        }
        // Unknown emitter - ignore.
    }

    function _onBetSettled() internal {
        // Recompute defaultMaxBet from free bankroll. Casino caps incoming
        // values at freeBankroll/100, so passing the same number twice is a
        // no-op. We re-emit only when the change is significant (≥5%) to
        // avoid spamming events.
        uint256 free = casino.freeBankroll();
        uint256 newMaxBet = free / 100;
        // The casino currently scopes per-game max bets, not a single global
        // default. We tune the most-played one (DICE) as a proxy for the
        // "house aggressiveness" knob. Same value gets applied to all games
        // by the hourly tick when needed.
        uint256 current = casino.gameMaxBet(Casino.GameType.DICE);
        if (!_isSignificant(newMaxBet, current)) return;
        try casino.setGameMaxBet(Casino.GameType.DICE, newMaxBet) {
            emit ReactiveBetSettledHandled(newMaxBet, free);
        } catch {
            // Casino reverted - likely Casino is paused or value exceeded
            // bankroll/100 (rounding edge). Swallow so the reactive
            // invocation doesn't burn gas + drop the subscription.
        }
    }

    function _onHourlyTick() internal {
        uint256 nowTs = block.timestamp;
        uint256 free = casino.freeBankroll();

        // Sample into the ring buffer.
        _hourlyBankroll[_ringIdx] = free;
        _hourlyTs[_ringIdx]       = nowTs;
        uint8 prevIdx = _ringIdx == 0 ? 23 : _ringIdx - 1;
        _ringIdx = (_ringIdx + 1) % 24;
        lastHourlyTickTs = nowTs;

        uint256 hourAgo = _hourlyBankroll[prevIdx];
        if (hourAgo == 0) {
            emit ReactiveHourlyTick(free, 0);
            return; // not enough data yet
        }

        // changeBps = (free - hourAgo) * 10000 / hourAgo
        int256 freeS    = int256(free);
        int256 hourAgoS = int256(hourAgo);
        int256 changeBps = ((freeS - hourAgoS) * 10000) / hourAgoS;

        // Decide. Order matters - first matching branch wins.
        // Big growth → lower slot RTP (more retentive).
        // Mild growth → activate bonus mode (more generous, keep players engaged).
        // Mild drop  → raise slot RTP (rebuild trust).
        // Big drop   → pause hot games (protect bankroll).
        if (changeBps > 1500) {
            try casino.adjustSlotRTP(uint8(Casino.GameType.SLOTS), 9000, "auto: bankroll growth >15%") {} catch {}
            try casino.adjustSlotRTP(uint8(Casino.GameType.CLUSTER), 9000, "auto: bankroll growth >15%") {} catch {}
            // Roulette has a fixed math edge (can't flex RTP), so the agent's
            // lever here is the per-round max bet: tighten it to 2% of free
            // bankroll on strong growth (more retentive, caps tail risk).
            try casino.setGameMaxBet(Casino.GameType.ROULETTE, (free * 200) / 10000) {} catch {}
            emit ReasoningRequested("LOWER_SLOT_RTP", changeBps, free, nowTs);
        } else if (changeBps > 1000) {
            try casino.activateBonusMode(60, "auto: bankroll growth >10%, rewarding players") {} catch {}
            emit ReasoningRequested("BONUS_MODE", changeBps, free, nowTs);
        } else if (changeBps < -2000) {
            try casino.pauseGame(Casino.GameType.CRASH) {} catch {}
            try casino.pauseGame(Casino.GameType.CLUSTER) {} catch {}
            try casino.pauseGame(Casino.GameType.SLOTS) {} catch {}
            // Roulette can't lower RTP to protect the bankroll, so on a hard
            // drop the agent pauses it alongside the other hot games.
            try casino.pauseGame(Casino.GameType.ROULETTE) {} catch {}
            emit ReasoningRequested("PAUSE_HOT_GAMES", changeBps, free, nowTs);
        } else if (changeBps < -1000) {
            try casino.adjustSlotRTP(uint8(Casino.GameType.SLOTS), 9400, "auto: bankroll drop >10%, rebuilding trust") {} catch {}
            try casino.adjustSlotRTP(uint8(Casino.GameType.CLUSTER), 9400, "auto: bankroll drop >10%, rebuilding trust") {} catch {}
            // Loosen roulette's max bet back up (5% of free bankroll) to keep
            // it inviting while we rebuild trust on the slot side.
            try casino.setGameMaxBet(Casino.GameType.ROULETTE, (free * 500) / 10000) {} catch {}
            emit ReasoningRequested("RAISE_SLOT_RTP", changeBps, free, nowTs);
        }

        emit ReactiveHourlyTick(free, changeBps);

        // Two-stage autonomous agent chain, fired in parallel:
        //   1. JSON API Agent × 2 - fetches competitor avg RTP for SLOTS
        //      and CLUSTER from the public research feed
        //   2. LLM Inference Agent × 2 - picks the decision per game,
        //      reading the freshest competitor RTP cached in storage
        // All four fire here. The JSON callbacks land first (~30s) and
        // update lastCompetitorRtpBps[game]. The LLM callbacks land after
        // (~60s) and read that fresh value. Order isn't guaranteed but the
        // LLM tolerates "competitorRtp = 0" with a graceful fallback
        // ("unknown - research feed not yet fetched") in the prompt.
        try this.requestCompetitorRtp(uint8(Casino.GameType.SLOTS))    {} catch {}
        try this.requestCompetitorRtp(uint8(Casino.GameType.CLUSTER))  {} catch {}
        // Roulette too - the LLM compares our fixed 94.74% (5.26% edge) against
        // the competitor benchmark and the result feeds the agent's max-bet /
        // pause decisions above, so the autonomous house reasons about roulette
        // every hour like it does the slots.
        try this.requestCompetitorRtp(uint8(Casino.GameType.ROULETTE)) {} catch {}
        // Stage 3: ask the Parse Website Agent for the latest crypto news
        // headline. The callback fires an LLM Inference to decide BIG_BONUS
        // vs HOLD - bullish headlines auto-activate Bonus Mode 60 min.
        try this.requestNewsHeadline() {} catch {}
        try this.requestRtpAnalysis(uint8(Casino.GameType.SLOTS))     {} catch {}
        try this.requestRtpAnalysis(uint8(Casino.GameType.CLUSTER))   {} catch {}

        // Player Agent dispatch: ask the LLM to pick a move for each
        // active player, capped at maxPlayersPerTick to keep cost bounded.
        // Each player decision is its own createRequest - they're cheaper
        // than the RTP analyses (one call per player vs full prompt).
        if (playerRegistry != address(0)) {
            try IPlayerAgentRegistryMin(playerRegistry).getActivePlayers(0, uint256(maxPlayersPerTick))
                returns (address[] memory players)
            {
                for (uint256 i; i < players.length; i++) {
                    try this.requestPlayerDecision(players[i]) {} catch {}
                }
            } catch {}
        }
    }

    /// @dev Library `defaultSubscriptionOptions()` returns priorityFeePerGas=0
    ///      which the somnia-devrel SKILL.md explicitly calls out as broken -
    ///      validators silently skip subscriptions with zero tip ("no error,
    ///      no warning"). emrestay's reactivity examples uniformly use
    ///      2 gwei priority + 10 gwei max + 500k gas limit. Following that
    ///      convention here so our cron actually fires.
    function _opts() internal pure returns (SomniaExtensions.SubscriptionOptions memory) {
        return SomniaExtensions.SubscriptionOptions({
            priorityFeePerGas: 2_000_000_000,   // 2 gwei
            maxFeePerGas:      10_000_000_000,  // 10 gwei
            gasLimit:          3_000_000        // generous for our cross-contract HM logic
        });
    }

    function _rescheduleHourlyTick() internal {
        // One-shot schedule for the configured interval (default 30 min).
        // The next handler invocation calls us back to re-schedule, giving
        // a self-perpetuating cron without any off-chain keeper.
        // SubscriptionOwner balance check requires ≥ 32 STT, so we silently
        // skip if the balance ever drops below that.
        if (address(this).balance < SomniaExtensions.SUBSCRIPTION_OWNER_MINIMUM_BALANCE) {
            return;
        }
        SomniaExtensions.SubscriptionOptions memory opts = _opts();
        uint256 nextMs = (block.timestamp + hourlyTickIntervalSeconds) * 1000 + 1;
        try this.scheduleHourly(nextMs, opts) returns (uint256 subId) {
            hourlyCronSubId = subId;
            emit SubscriptionCreated(subId, "hourly-cron-renew");
        } catch {
            // Reschedule failed - operator can call rebootHourlyTick() manually.
        }
    }

    /// @dev Wrapper so that the schedule call can be guarded by a try/catch.
    function scheduleHourly(uint256 timestampMillis, SomniaExtensions.SubscriptionOptions memory opts)
        external
        returns (uint256 subId)
    {
        require(msg.sender == address(this) || msg.sender == owner() || msg.sender == hmAgent, "not authorised");
        subId = SomniaExtensions.scheduleSubscriptionAtTimestamp(address(this), timestampMillis, opts);
    }

    // ---------------------------------------------------------------------
    // Owner-controlled subscription lifecycle
    // ---------------------------------------------------------------------

    /// @notice Owner-only initial subscription creation. Called once after
    ///         deployment + funding (HM must hold ≥ 32 STT for the precompile
    ///         to accept the subscribe call).
    function bootstrapReactivity() external onlyOwner {
        require(address(this).balance >= SomniaExtensions.SUBSCRIPTION_OWNER_MINIMUM_BALANCE, "fund first (>=32 STT)");
        if (hourlyCronSubId != 0) revert("already bootstrapped");
        SomniaExtensions.SubscriptionOptions memory opts = _opts();
        // First tick fires 60s from now so we don't have to wait the full
        // interval to see the agent chain start producing events.
        uint256 nextMs = (block.timestamp + 60) * 1000 + 1;
        hourlyCronSubId = SomniaExtensions.scheduleSubscriptionAtTimestamp(address(this), nextMs, opts);
        emit SubscriptionCreated(hourlyCronSubId, "hourly-cron-initial");
    }

    /// @notice Owner-only registration of the BetSettled subscription.
    ///         Stores the subscription id reported by the precompile.
    function setBetSettledSubId(uint256 subId) external onlyOwner {
        betSettledSubId = subId;
        emit SubscriptionCreated(subId, "bet-settled");
    }

    /// @notice Owner-only initial subscription to Casino's BetSettled events.
    ///         HM becomes the subscription owner; HM's balance pays for each
    ///         reactive invocation. `topic0` must equal keccak256 of the full
    ///         BetSettled signature - passed in from JS to avoid re-computing
    ///         it on-chain.
    function subscribeToBetSettled(address emitter, bytes32 topic0) external onlyOwner returns (uint256 subId) {
        require(address(this).balance >= SomniaExtensions.SUBSCRIPTION_OWNER_MINIMUM_BALANCE, "fund first (>=32 STT)");
        SomniaExtensions.SubscriptionFilter memory filter = SomniaExtensions.SubscriptionFilter({
            eventTopics: [topic0, bytes32(0), bytes32(0), bytes32(0)],
            origin:  address(0),
            emitter: emitter
        });
        SomniaExtensions.SubscriptionOptions memory opts = _opts();
        subId = SomniaExtensions.subscribe(address(this), filter, opts);
        betSettledSubId = subId;
        emit SubscriptionCreated(subId, "bet-settled");
    }

    function rebootHourlyTick() external onlyOwner {
        SomniaExtensions.SubscriptionOptions memory opts = _opts();
        // Reboot fires in 60s so the operator sees activity immediately
        // after calling this instead of waiting up to a full interval.
        uint256 nextMs = (block.timestamp + 60) * 1000 + 1;
        hourlyCronSubId = SomniaExtensions.scheduleSubscriptionAtTimestamp(address(this), nextMs, opts);
        emit SubscriptionCreated(hourlyCronSubId, "hourly-cron-reboot");
    }

    /// @notice Owner can rescue stuck balance (e.g. before redeploy). Cancels
    ///         active reactive subscriptions first to avoid stranding gas.
    function withdrawTo(address payable to, uint256 amount) external onlyOwner {
        require(amount > 0 && amount <= address(this).balance, "bad amount");
        (bool ok, ) = to.call{ value: amount }("");
        require(ok, "transfer failed");
    }

    function cancelSubscription(uint256 subId) external onlyOwner {
        SomniaExtensions.unsubscribe(subId);
        if (subId == betSettledSubId) betSettledSubId = 0;
        if (subId == hourlyCronSubId) hourlyCronSubId = 0;
    }

    // ---------------------------------------------------------------------
    // Manual / off-chain agent path (back-compat with existing tests + admin)
    // ---------------------------------------------------------------------

    function setGameMaxBet(Casino.GameType game, uint256 amount) external onlyAgent {
        casino.setGameMaxBet(game, amount);
    }

    function pauseGame(Casino.GameType game) external onlyAgent {
        casino.pauseGame(game);
    }

    function unpauseGame(Casino.GameType game) external onlyAgent {
        casino.unpauseGame(game);
    }

    function activateBonusMode(uint256 durationMinutes, string calldata reasoning) external onlyAgent {
        casino.activateBonusMode(durationMinutes, reasoning);
    }

    function recordReasoning(string calldata thought) external onlyAgent {
        casino.recordReasoning(thought);
    }

    function adjustSlotRTP(uint8 game, uint16 newRtpBps, string calldata reasoning) external onlyAgent {
        casino.adjustSlotRTP(game, newRtpBps, reasoning);
    }

    function provisionSeedHashes(bytes32[] calldata hashes) external onlyAgent {
        casino.provisionSeedHashes(hashes);
    }

    function triggerThemeRotation(string calldata name, string[5] calldata symbols) external onlyAgent {
        casino.triggerThemeRotation(name, symbols);
    }

    // ---------------------------------------------------------------------
    // Read helpers
    // ---------------------------------------------------------------------

    struct CasinoSnapshot {
        uint256 freeBankroll;
        uint256 lockedReserve;
        uint256 totalPendingWithdrawals;
        uint256 totalBets;
        uint256 seedAvailable;
        uint256 bonusModeUntil;
        bool[7]  paused;
        uint256[7] maxBets;
    }

    function snapshot() external view returns (CasinoSnapshot memory s) {
        s.freeBankroll = casino.freeBankroll();
        s.lockedReserve = casino.lockedReserve();
        s.totalPendingWithdrawals = casino.totalPendingWithdrawals();
        s.totalBets = casino.totalBets();
        (uint256 total, uint256 consumed,) = casino.seedPoolStatus();
        s.seedAvailable = total - consumed;
        s.bonusModeUntil = casino.bonusModeUntil();
        for (uint8 i; i < 7; i++) {
            s.paused[i] = casino.gamePaused(Casino.GameType(i));
            s.maxBets[i] = casino.gameMaxBet(Casino.GameType(i));
        }
    }

    function getHourlyBankroll() external view returns (uint256[24] memory bankroll, uint256[24] memory timestamps, uint8 idx) {
        return (_hourlyBankroll, _hourlyTs, _ringIdx);
    }

    function _isSignificant(uint256 a, uint256 b) private pure returns (bool) {
        if (a == b) return false;
        if (b == 0) return a > 0;
        uint256 diff = a > b ? a - b : b - a;
        return (diff * 100) / b >= 5;
    }

    // ---------------------------------------------------------------------
    // Somnia LLM Agent path - autonomous on-chain RTP analysis
    // ---------------------------------------------------------------------

    /// @notice Owner wires up the platform + agent IDs. Required ONCE
    ///         before hourly tick can dispatch any agent requests.
    function setAgentPlatform(address platform_, uint256 llmAgentId_) external onlyOwner {
        agentPlatform = IAgentRequester(platform_);
        llmAgentId = llmAgentId_;
        emit AgentPlatformSet(platform_, llmAgentId_, jsonAgentId);
    }

    function setAgentIds(uint256 llmAgentId_, uint256 jsonAgentId_) external onlyOwner {
        llmAgentId = llmAgentId_;
        jsonAgentId = jsonAgentId_;
        emit AgentPlatformSet(address(agentPlatform), llmAgentId_, jsonAgentId_);
    }

    function setAgentPricing(uint256 llmPerWorker_, uint256 jsonPerWorker_, uint8 subSize_) external onlyOwner {
        require(subSize_ > 0 && subSize_ <= 9, "subSize");
        llmPricePerWorker = llmPerWorker_;
        jsonPricePerWorker = jsonPerWorker_;
        agentSubcommitteeSize = subSize_;
    }

    function setRtpBounds(uint16 minBps, uint16 maxBps) external onlyOwner {
        require(minBps >= 7500 && maxBps <= 9900 && minBps < maxBps, "bounds");
        minRtpBps = minBps;
        maxRtpBps = maxBps;
    }

    /// @notice Quote the total deposit (reserve + reward pot) for one LLM call.
    ///         Formula per docs.somnia.network: reserve + pricePerWorker × subSize.
    ///         Sending only the reserve makes perAgentBudget=0 → runners skip
    ///         the request → timeout. Always fund the full amount.
    function quoteLlmCost() public view returns (uint256) {
        if (address(agentPlatform) == address(0)) return 0;
        return agentPlatform.getRequestDeposit() + llmPricePerWorker * agentSubcommitteeSize;
    }

    function quoteJsonCost() public view returns (uint256) {
        if (address(agentPlatform) == address(0)) return 0;
        return agentPlatform.getRequestDeposit() + jsonPricePerWorker * agentSubcommitteeSize;
    }

    function quoteParseCost() public view returns (uint256) {
        if (address(agentPlatform) == address(0)) return 0;
        return agentPlatform.getRequestDeposit() + parsePricePerWorker * agentSubcommitteeSize;
    }

    function setNewsFeed(string calldata url, string calldata selector) external onlyOwner {
        newsFeedUrl = url;
        newsCssSelector = selector;
    }

    function setHourlyTickIntervalSeconds(uint256 s) external onlyOwner {
        require(s >= 300 && s <= 86400, "300s..1day");
        hourlyTickIntervalSeconds = s;
    }

    function setRtpAnalysisSkipBps(uint16 bps) external onlyOwner {
        require(bps <= 5000, "max 50%");
        rtpAnalysisSkipBps = bps;
    }

    function setCompetitorFeedUrl(string calldata url) external onlyOwner {
        competitorFeedUrl = url;
        emit CompetitorFeedUrlSet(url);
    }

    // ---------------------------------------------------------------------
    // STAGE 1 - JSON API Agent fetches REAL competitor RTP from research feed
    // ---------------------------------------------------------------------

    /// @notice Trigger a fresh competitor-RTP fetch via the JSON API Agent
    ///         for the given game (SLOTS=2 | CLUSTER=6). The agent reads
    ///         the configured research feed URL and extracts the
    ///         {slots,cluster}_rtp_avg_bps field.
    function requestCompetitorRtp(uint8 game) public {
        require(msg.sender == address(this) || msg.sender == owner() || msg.sender == hmAgent, "auth");
        if (address(agentPlatform) == address(0)) {
            emit AgentRequestSkipped("competitor-rtp", "platform-not-wired");
            return;
        }
        string memory selector;
        if (game == uint8(Casino.GameType.SLOTS))      selector = "slots_rtp_avg_bps";
        else if (game == uint8(Casino.GameType.CLUSTER)) selector = "cluster_rtp_avg_bps";
        else { emit AgentRequestSkipped("competitor-rtp", "game-not-supported"); return; }
        uint256 cost = quoteJsonCost();
        if (address(this).balance < cost + SomniaExtensions.SUBSCRIPTION_OWNER_MINIMUM_BALANCE) {
            emit AgentRequestSkipped("competitor-rtp", "insufficient-balance");
            return;
        }
        // fetchUint(url, selector, decimals=0) → integer at JSONPath selector.
        bytes memory payload = abi.encodeWithSelector(
            IJsonApiAgent.fetchUint.selector,
            competitorFeedUrl,
            selector,
            uint8(0)
        );
        uint256 requestId = agentPlatform.createRequest{value: cost}(
            jsonAgentId,
            address(this),
            this.handleResponse.selector,
            payload
        );
        pendingCompetitorGame[requestId] = game + 1;
        emit CompetitorRtpRequested(requestId, game, competitorFeedUrl);
    }

    // -------------------------------------------------------------------
    // STAGE 3 - Parse Website Agent: extract latest crypto headline,
    // then feed to LLM Inference to decide BIG_BONUS vs HOLD.
    // -------------------------------------------------------------------

    function requestNewsHeadline() public {
        require(msg.sender == address(this) || msg.sender == owner() || msg.sender == hmAgent, "auth");
        if (address(agentPlatform) == address(0)) {
            emit AgentRequestSkipped("news-parse", "platform-not-wired");
            return;
        }
        if (bytes(newsFeedUrl).length == 0) {
            emit AgentRequestSkipped("news-parse", "url-not-set");
            return;
        }
        uint256 cost = quoteParseCost();
        if (address(this).balance < cost + SomniaExtensions.SUBSCRIPTION_OWNER_MINIMUM_BALANCE) {
            emit AgentRequestSkipped("news-parse", "insufficient-balance");
            return;
        }
        bytes memory payload = abi.encodeWithSelector(
            IParseWebsiteAgent.parseText.selector,
            newsFeedUrl,
            newsCssSelector,
            uint8(0)
        );
        uint256 requestId = agentPlatform.createRequest{value: cost}(
            parseAgentId,
            address(this),
            this.handleResponse.selector,
            payload
        );
        pendingNewsParse[requestId] = true;
        emit NewsHeadlineRequested(requestId, newsFeedUrl);
    }

    function _requestNewsBonusDecision(string memory headline) internal {
        if (address(agentPlatform) == address(0)) return;
        uint256 cost = quoteLlmCost();
        if (address(this).balance < cost + SomniaExtensions.SUBSCRIPTION_OWNER_MINIMUM_BALANCE) {
            emit AgentRequestSkipped("news-bonus", "insufficient-balance");
            return;
        }
        string memory prompt = string(abi.encodePacked(
            "Crypto news headline: \"", headline, "\". ",
            "If the market sentiment is strongly bullish (e.g. ATH, halving, ETF approval, ",
            "major rally, regulatory clarity), reply BIG_BONUS to activate a 60-minute ",
            "generous payout window for casino users. Otherwise reply HOLD."
        ));
        string memory system = "You are a casino marketing trigger. Reply EXACTLY one word from the allowed values. Be conservative: BIG_BONUS only for clearly euphoric headlines.";
        string[] memory allowed = new string[](2);
        allowed[0] = "BIG_BONUS";
        allowed[1] = "HOLD";
        bytes memory payload = abi.encodeWithSelector(
            ILLMAgent.inferString.selector,
            prompt, system, false, allowed
        );
        uint256 requestId = agentPlatform.createRequest{value: cost}(
            llmAgentId, address(this), this.handleResponse.selector, payload
        );
        pendingNewsHeadline[requestId] = headline;
        emit NewsBonusDecisionRequested(requestId, headline);
    }

    // ---------------------------------------------------------------------
    // STAGE 2 - LLM Inference Agent picks a decision for the given game
    // ---------------------------------------------------------------------

    /// @notice Dispatch an LLM-driven decision for SLOTS / CLUSTER. Uses the
    ///         latest market signal (from JSON API stage) plus current
    ///         bankroll + 1h delta. inferString with allowedValues is the
    ///         safest pattern - output is constrained to one of:
    ///         LOWER | HOLD | RAISE | BIG_BONUS.
    function requestRtpAnalysis(uint8 game) public {
        require(msg.sender == address(this) || msg.sender == owner() || msg.sender == hmAgent, "auth");
        if (address(agentPlatform) == address(0)) {
            emit AgentRequestSkipped("rtp-analysis", "platform-not-wired");
            return;
        }
        if (game != uint8(Casino.GameType.SLOTS) && game != uint8(Casino.GameType.CLUSTER)) {
            emit AgentRequestSkipped("rtp-analysis", "game-not-adjustable");
            return;
        }
        uint256 cost = quoteLlmCost();
        if (address(this).balance < cost + SomniaExtensions.SUBSCRIPTION_OWNER_MINIMUM_BALANCE) {
            emit AgentRequestSkipped("rtp-analysis", "insufficient-balance");
            return;
        }

        uint16 currentRtp = casino.getReportedRTP(game);
        uint256 free = casino.freeBankroll();
        int256 changeBps;
        {
            uint8 prevIdx = _ringIdx == 0 ? 23 : _ringIdx - 1;
            uint256 hourAgo = _hourlyBankroll[prevIdx];
            if (hourAgo > 0) {
                changeBps = ((int256(free) - int256(hourAgo)) * 10000) / int256(hourAgo);
            }
        }

        // Smart-skip: if bankroll barely moved AND competitor RTP is close
        // to ours, there's nothing meaningful to ask the LLM about. Saves
        // 0.24 STT per skipped tick. Configurable via rtpAnalysisSkipBps.
        uint256 absChange = changeBps < 0 ? uint256(-changeBps) : uint256(changeBps);
        uint256 competitorRtp = lastCompetitorRtpBps[game];
        uint256 rtpGap = competitorRtp > 0
            ? (competitorRtp > currentRtp ? competitorRtp - currentRtp : currentRtp - competitorRtp)
            : uint256(rtpAnalysisSkipBps) + 1; // unknown competitor → always run
        if (absChange < uint256(rtpAnalysisSkipBps) && rtpGap < uint256(rtpAnalysisSkipBps)) {
            emit AgentRequestSkipped("rtp-analysis", "no-meaningful-change");
            return;
        }

        string memory prompt = _buildDecisionPrompt(game, currentRtp, free, changeBps, competitorRtp);
        string memory system = "You are the autonomous RTP regulator for ShinyLuck on Somnia. Reply with EXACTLY one word from the allowed values. Your goal is to be competitive: if our RTP is materially below competitor average, RAISE. If significantly above, LOWER. HOLD if within 0.5%. BIG_BONUS only when bankroll grew strongly AND competitors are loosening too. Protect bankroll first.";

        string[] memory allowed = new string[](4);
        allowed[0] = "LOWER";
        allowed[1] = "HOLD";
        allowed[2] = "RAISE";
        allowed[3] = "BIG_BONUS";

        bytes memory payload = abi.encodeWithSelector(
            ILLMAgent.inferString.selector,
            prompt,
            system,
            false,    // chainOfThought - false keeps cost down + faster
            allowed
        );

        uint256 requestId = agentPlatform.createRequest{value: cost}(
            llmAgentId,
            address(this),
            this.handleResponse.selector,
            payload
        );
        pendingAnalysisGame[requestId] = game + 1; // +1 so 0 means "no entry"
        emit RtpAnalysisRequested(requestId, game, currentRtp, changeBps, competitorRtp);
    }

    /// @notice Single callback handles BOTH agent flavours - JSON API
    ///         (competitor RTP) + LLM (decision). Dispatches by which
    ///         pending mapping the requestId is in.
    function handleResponse(
        uint256 requestId,
        Response[] memory responses,
        ResponseStatus status,
        Request memory /* details */
    ) external override {
        require(msg.sender == address(agentPlatform), "wrong caller");

        // News-parse callback? (Parse Website Agent returned the headline)
        if (pendingNewsParse[requestId]) {
            delete pendingNewsParse[requestId];
            if (status != ResponseStatus.Success || responses.length == 0) {
                emit AgentRequestSkipped("news-parse", "no-consensus");
                return;
            }
            string memory headline;
            try this.tryDecodeString(responses[0].result) returns (string memory s) { headline = s; }
            catch { emit AgentRequestSkipped("news-parse", "decode-failed"); return; }
            if (bytes(headline).length == 0) {
                emit AgentRequestSkipped("news-parse", "empty-headline");
                return;
            }
            lastNewsHeadline = headline;
            lastNewsHeadlineTs = block.timestamp;
            emit NewsHeadlineResolved(requestId, headline);
            // Fire stage 2: LLM decides BIG_BONUS vs HOLD on this headline.
            _requestNewsBonusDecision(headline);
            return;
        }

        // News-bonus callback? (LLM verdict on the headline)
        if (bytes(pendingNewsHeadline[requestId]).length != 0) {
            string memory headline = pendingNewsHeadline[requestId];
            delete pendingNewsHeadline[requestId];
            if (status != ResponseStatus.Success || responses.length == 0) {
                emit AgentRequestSkipped("news-bonus", "no-consensus");
                return;
            }
            string memory decision;
            try this.tryDecodeString(responses[0].result) returns (string memory s) { decision = s; }
            catch { emit AgentRequestSkipped("news-bonus", "decode-failed"); return; }
            emit NewsBonusDecisionResolved(requestId, decision);
            if (keccak256(bytes(decision)) == keccak256(bytes("BIG_BONUS"))) {
                try casino.activateBonusMode(60, string(abi.encodePacked(
                    "LLM: news-driven Bonus Mode -- ", headline
                ))) {} catch { emit AgentRequestSkipped("news-bonus", "casino-rejected"); }
            }
            return;
        }

        // Player-decision callback? (LLM picked SKIP / GAME_STAKE)
        address pending = pendingPlayerDecision[requestId];
        if (pending != address(0)) {
            delete pendingPlayerDecision[requestId];
            if (status != ResponseStatus.Success || responses.length == 0) {
                emit AgentRequestSkipped("player-decision", "no-consensus");
                emit PlayerDecisionResolved(requestId, pending, "NO_CONSENSUS", 0, 0, 0, false);
                return;
            }
            string memory decision;
            try this.tryDecodeString(responses[0].result) returns (string memory s) { decision = s; }
            catch {
                emit AgentRequestSkipped("player-decision", "decode-failed");
                emit PlayerDecisionResolved(requestId, pending, "DECODE_FAIL", 0, 0, 0, false);
                return;
            }
            (uint8 g, uint256 stake, uint256 betId, bool placed) = _applyPlayerDecision(requestId, pending, decision);
            emit PlayerDecisionResolved(requestId, pending, decision, g, stake, betId, placed);
            return;
        }

        // Competitor-RTP callback?
        uint8 competitorEntry = pendingCompetitorGame[requestId];
        if (competitorEntry != 0) {
            uint8 game = competitorEntry - 1;
            delete pendingCompetitorGame[requestId];
            if (status != ResponseStatus.Success || responses.length == 0) {
                emit AgentRequestSkipped("competitor-rtp", "no-consensus");
                return;
            }
            try this.tryDecodeUint(responses[0].result) returns (uint256 v) {
                // Clamp to sane RTP range so a malformed/spammed feed can't
                // poison decisions. 80%-100% is the only realistic band.
                if (v < 8000 || v > 10000) { emit AgentRequestSkipped("competitor-rtp", "out-of-range"); return; }
                lastCompetitorRtpBps[game] = v;
                lastCompetitorRtpTs[game]  = block.timestamp;
                emit CompetitorRtpResolved(requestId, game, v);
            } catch {
                emit AgentRequestSkipped("competitor-rtp", "decode-failed");
            }
            return;
        }

        // RTP-decision callback?
        uint8 entry = pendingAnalysisGame[requestId];
        if (entry == 0) return; // unknown / already handled
        uint8 game = entry - 1;
        delete pendingAnalysisGame[requestId];

        if (status != ResponseStatus.Success || responses.length == 0) {
            emit AgentRequestSkipped("rtp-analysis", "no-consensus");
            return;
        }

        // Majority consensus → all responses byte-identical. Decode the first.
        string memory decision;
        try this.tryDecodeString(responses[0].result) returns (string memory s) { decision = s; }
        catch { emit AgentRequestSkipped("rtp-analysis", "decode-failed"); return; }

        uint16 oldRtp = casino.getReportedRTP(game);
        uint16 newRtp = oldRtp;
        bytes32 decH = keccak256(bytes(decision));

        if      (decH == keccak256(bytes("RAISE"))) {
            newRtp = _clampBps(uint16(uint256(oldRtp) + 150));
        } else if (decH == keccak256(bytes("LOWER"))) {
            uint256 lowered = oldRtp > 150 ? uint256(oldRtp) - 150 : uint256(oldRtp);
            newRtp = _clampBps(uint16(lowered));
        } else if (decH == keccak256(bytes("BIG_BONUS"))) {
            // Activate Bonus Mode for 60 min in addition to leaving RTP alone.
            try casino.activateBonusMode(60, "LLM agent: BIG_BONUS decision") {} catch {}
        }
        // HOLD or unrecognized → leave RTP untouched.

        string memory sample = decision;
        if (newRtp != oldRtp) {
            try casino.adjustSlotRTP(game, newRtp, "LLM consensus via Somnia Agent Platform") {}
            catch { emit AgentRequestSkipped("rtp-analysis", "casino-rejected"); return; }
        }
        emit RtpAnalysisResolved(requestId, game, oldRtp, newRtp, decision, sample);
    }

    function _clampBps(uint16 v) internal view returns (uint16) {
        if (v < minRtpBps) return minRtpBps;
        if (v > maxRtpBps) return maxRtpBps;
        return v;
    }

    function tryDecodeInt(bytes calldata b) external pure returns (int256) {
        return abi.decode(b, (int256));
    }
    function tryDecodeUint(bytes calldata b) external pure returns (uint256) {
        return abi.decode(b, (uint256));
    }
    function tryDecodeString(bytes calldata b) external pure returns (string memory) {
        return abi.decode(b, (string));
    }

    function _buildDecisionPrompt(
        uint8 game,
        uint16 currentRtp,
        uint256 freeWei,
        int256 changeBps,
        uint256 competitorRtp
    ) internal pure returns (string memory) {
        string memory gameName = game == uint8(Casino.GameType.SLOTS) ? "VAULT.7 slots" : "SUGAR.LAB cluster";
        string memory compStr = competitorRtp == 0
            ? "unknown (research feed not yet fetched)"
            : string(abi.encodePacked(_bps2pct(uint16(competitorRtp)), "%"));
        return string(abi.encodePacked(
            "Decide RTP for ", gameName, ". Our RTP: ", _bps2pct(currentRtp), "%.",
            " Competitor average RTP (live from research feed): ", compStr, ".",
            " Free bankroll: ", _wei2eth(freeWei), " STT.",
            " 1h bankroll change: ", _signedBps2pct(changeBps), "%.",
            " Action: RAISE = +1.5% RTP. LOWER = -1.5% RTP. HOLD = no change.",
            " BIG_BONUS = activate 60min Bonus Mode for a generous payout window."
        ));
    }

    function _u2s(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 tmp = v; uint8 digits;
        while (tmp != 0) { digits++; tmp /= 10; }
        bytes memory buf = new bytes(digits);
        while (v != 0) { digits--; buf[digits] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(buf);
    }

    function _bps2pct(uint16 bps) internal pure returns (string memory) {
        // 9200 → "92.00"
        uint256 whole = uint256(bps) / 100;
        uint256 frac  = uint256(bps) % 100;
        bytes memory fracStr = bytes(_u2s(frac));
        if (fracStr.length == 1) fracStr = abi.encodePacked("0", fracStr);
        return string(abi.encodePacked(_u2s(whole), ".", fracStr));
    }

    function _signedBps2pct(int256 bps) internal pure returns (string memory) {
        if (bps == 0) return "0.00";
        string memory sign = bps < 0 ? "-" : "+";
        uint256 abs = uint256(bps < 0 ? -bps : bps);
        return string(abi.encodePacked(sign, _bps2pct(uint16(abs))));
    }

    function _wei2eth(uint256 wei_) internal pure returns (string memory) {
        // Truncate to whole STT for prompt brevity (1e18 → "1").
        return _u2s(wei_ / 1e18);
    }

    // =====================================================================
    // Player Agent dispatcher
    // =====================================================================

    function setPlayerRegistry(address registry) external onlyOwner {
        playerRegistry = registry;
        emit PlayerRegistrySet(registry);
    }

    function setMaxPlayersPerTick(uint8 n) external onlyOwner {
        require(n > 0 && n <= 20, "range");
        maxPlayersPerTick = n;
    }

    function setAgentDecisionSubsidyBps(uint16 bps) external onlyOwner {
        require(bps <= 10000, "max 100%");
        agentDecisionSubsidyBps = bps;
    }

    /// @notice Fire one Somnia LLM Inference request for the given player.
    ///         The agent picks ONE of {SKIP, DICE_0.1, SLOTS_0.5, CLUSTER_0.5,
    ///         PLINKO_0.5, ROULETTE_0.5} given the player's permittedGamesMask
    ///         + remaining daily budget + vault balance. handleResponse
    ///         routes back here, decodes the decision, and calls
    ///         registry.executeBet from the player's vault.
    function requestPlayerDecision(address player) public {
        require(msg.sender == address(this) || msg.sender == owner() || msg.sender == hmAgent, "auth");
        if (playerRegistry == address(0) || address(agentPlatform) == address(0)) {
            emit AgentRequestSkipped("player-decision", "not-wired");
            return;
        }
        uint256 cost = quoteLlmCost();
        // Split the cost. userShare comes from the player's vault BEFORE
        // we hit the agent platform - spam-proof: a player with an empty
        // vault simply gets skipped and the casino burns nothing.
        uint256 casinoShare = (cost * agentDecisionSubsidyBps) / 10000;
        uint256 userShare = cost - casinoShare;
        // HM still needs to hold the FULL `cost` at the moment of createRequest
        // (we forward the combined value). After collectAgentFee, the vault
        // tops HM up by `userShare`; we just need HM to already cover
        // `casinoShare` + the Reactivity floor.
        if (address(this).balance < casinoShare + SomniaExtensions.SUBSCRIPTION_OWNER_MINIMUM_BALANCE) {
            emit AgentRequestSkipped("player-decision", "insufficient-casino-share");
            return;
        }

        // Fetch permission + vault balance for the prompt.
        (address pAddr, address vault, , uint256 dailyLimit, uint256 totalLimit, uint8 mask, bool active, uint256 spentToday, uint256 spentTotal, )
            = _readPermission(player);
        if (!active || pAddr == address(0)) {
            emit AgentRequestSkipped("player-decision", "inactive");
            return;
        }
        uint256 vaultBal = vault.balance;
        if (vaultBal < userShare) {
            emit AgentRequestSkipped("player-decision", "insufficient-vault-budget");
            return;
        }
        uint256 remainingDaily = dailyLimit > spentToday ? dailyLimit - spentToday : 0;

        string memory prompt = _buildPlayerPrompt(mask, remainingDaily, dailyLimit, spentTotal, totalLimit, vaultBal);
        string memory system = "You are an autonomous betting strategist for a single user. Reply with EXACTLY one word from the allowed values. SKIP means do not play this tick. Otherwise pick a game and stake the user has permitted that fits the remaining daily budget and vault balance. Be conservative: do not pick a stake larger than 30% of vault balance or remaining daily budget.";

        string[] memory allowed = _buildAllowedValues(mask);

        bytes memory payload = abi.encodeWithSelector(
            ILLMAgent.inferString.selector,
            prompt,
            system,
            false,
            allowed
        );

        // Collect the user's share from their vault BEFORE firing the
        // request. If the call reverts (vault drained mid-tick, weird
        // proxy issue) we skip silently rather than burning the casino's
        // share on a request we can't fully fund.
        if (userShare > 0) {
            try IPlayerAgentRegistryMin(playerRegistry).collectAgentFee(player, userShare) {}
            catch {
                emit AgentRequestSkipped("player-decision", "collect-fee-failed");
                return;
            }
        }

        uint256 requestId = agentPlatform.createRequest{value: cost}(
            llmAgentId,
            address(this),
            this.handleResponse.selector,
            payload
        );
        pendingPlayerDecision[requestId] = player;
        emit PlayerDecisionRequested(requestId, player, vaultBal, spentToday, dailyLimit);
    }

    /// @dev Builds the per-player prompt with all the context the LLM needs
    ///      to choose game + stake.
    function _buildPlayerPrompt(
        uint8 mask,
        uint256 remainingDailyWei,
        uint256 dailyLimitWei,
        uint256 spentTotalWei,
        uint256 totalLimitWei,
        uint256 vaultBalWei
    ) internal pure returns (string memory) {
        return string(abi.encodePacked(
            "Decide one action for an on-chain casino agent.",
            " Permitted games (1=allowed) DICE:", _b(mask, 0),
            " CRASH:", _b(mask, 1),
            " SLOTS:", _b(mask, 2),
            " MINES:", _b(mask, 3),
            " PLINKO:", _b(mask, 4),
            " ROULETTE:", _b(mask, 5),
            " CLUSTER:", _b(mask, 6),
            ". Remaining daily budget: ", _wei2eth(remainingDailyWei),
            "/", _wei2eth(dailyLimitWei), " STT.",
            " Spent total ", _wei2eth(spentTotalWei),
            "/", _wei2eth(totalLimitWei), " STT.",
            " Vault balance ", _wei2eth(vaultBalWei), " STT.",
            " Pick SKIP if budget too tight or vault too low; otherwise pick a game+stake from the allowed list."
        ));
    }

    function _b(uint8 mask, uint8 bit) internal pure returns (string memory) {
        return ((mask >> bit) & 1) == 1 ? "1" : "0";
    }

    /// @dev Build the allowedValues list for the LLM. Always includes SKIP
    ///      plus the permitted-game options at fixed stakes (small + medium).
    function _buildAllowedValues(uint8 mask) internal pure returns (string[] memory) {
        // Worst case: SKIP + 5 games * 2 stakes = 11. Cluster + Slots also.
        string[] memory all = new string[](12);
        uint256 n;
        all[n++] = "SKIP";
        if (((mask >> 0) & 1) == 1) { all[n++] = "DICE_0.1";    all[n++] = "DICE_0.5"; }
        if (((mask >> 2) & 1) == 1) { all[n++] = "SLOTS_0.5";   }
        if (((mask >> 4) & 1) == 1) { all[n++] = "PLINKO_0.5";  }
        if (((mask >> 5) & 1) == 1) { all[n++] = "ROULETTE_0.5";}
        if (((mask >> 6) & 1) == 1) { all[n++] = "CLUSTER_0.5"; }
        // Trim to actual length.
        string[] memory out = new string[](n);
        for (uint256 i; i < n; i++) out[i] = all[i];
        return out;
    }

    /// @dev Apply an LLM decision. Decodes "GAME_STAKE" → game id + stake wei,
    ///      builds calldata for the matching place*Bet entrypoint, and calls
    ///      registry.executeBet on behalf of the player. Returns the betId
    ///      (0 if SKIP or decoding failed) and a flag indicating whether a
    ///      bet was actually placed.
    function _applyPlayerDecision(uint256 requestId, address player, string memory decision)
        internal returns (uint8 game, uint256 stakeWei, uint256 betId, bool placed)
    {
        bytes32 h = keccak256(bytes(decision));
        if (h == keccak256(bytes("SKIP"))) return (0, 0, 0, false);

        bytes memory cs = abi.encodePacked(uint256(keccak256(abi.encodePacked(player, requestId, block.timestamp))));

        if (h == keccak256(bytes("DICE_0.1"))) { game = 0; stakeWei = 0.1 ether; }
        else if (h == keccak256(bytes("DICE_0.5"))) { game = 0; stakeWei = 0.5 ether; }
        else if (h == keccak256(bytes("SLOTS_0.5"))) { game = 2; stakeWei = 0.5 ether; }
        else if (h == keccak256(bytes("PLINKO_0.5"))) { game = 4; stakeWei = 0.5 ether; }
        else if (h == keccak256(bytes("ROULETTE_0.5"))) { game = 5; stakeWei = 0.5 ether; }
        else if (h == keccak256(bytes("CLUSTER_0.5"))) { game = 6; stakeWei = 0.5 ether; }
        else return (0, 0, 0, false);

        bytes memory cd;
        if (game == 0) {
            // placeDiceBet(uint8 target, bool over, bytes32 clientSeed)
            cd = abi.encodeWithSignature("placeDiceBet(uint8,bool,bytes32)", uint8(60), true, bytes32(cs));
        } else if (game == 2) {
            // placeSlotsBet(bytes32 clientSeed, bool useFreeSpin)
            cd = abi.encodeWithSignature("placeSlotsBet(bytes32,bool)", bytes32(cs), false);
        } else if (game == 4) {
            // placeplinkoBet(uint8 risk, bytes32 clientSeed) - risk 1 = medium
            cd = abi.encodeWithSignature("placeplinkoBet(uint8,bytes32)", uint8(1), bytes32(cs));
        } else if (game == 5) {
            // placeRouletteBets((uint8 kind,uint8 number,uint96 amount)[])
            // Single RED bet (kind=1) at the full stake.
            cd = abi.encodeWithSignature(
                "placeRouletteBets((uint8,uint8,uint96)[])",
                _singleRouletteBet(uint8(1), uint8(0), uint96(stakeWei))
            );
        } else if (game == 6) {
            cd = abi.encodeWithSignature("placeClusterBet(bytes32,bool)", bytes32(cs), false);
        }

        // Try executeBet. Wrap in try/catch so a per-player failure (e.g.
        // empty vault, game paused, daily limit hit at race) doesn't kill
        // the cron loop or the LLM-callback handler.
        try IPlayerAgentRegistryMin(playerRegistry).executeBet(player, game, stakeWei, cd) returns (uint256 id) {
            betId = id;
            placed = true;
        } catch {
            placed = false;
        }
    }

    /// @dev Workaround: encode a typed [(uint8,uint8,uint96)] tuple array
    ///      with a single entry. Solidity can't directly take a literal
    ///      inline tuple array as calldata, so we build a 1-element memory
    ///      array of the typed struct here.
    struct RouletteBet { uint8 kind; uint8 number; uint96 amount; }
    function _singleRouletteBet(uint8 kind, uint8 number, uint96 amount)
        internal pure returns (RouletteBet[] memory arr)
    {
        arr = new RouletteBet[](1);
        arr[0] = RouletteBet({kind: kind, number: number, amount: amount});
    }

    /// @dev Bridge interface for the registry. Only the bits HM needs.
    ///      Stays here (instead of importing the registry) so HM compiles
    ///      independently of the registry's exact ABI evolution.
    function _readPermission(address player) internal view returns (
        address pAddr, address vault, bytes32 strategyHash,
        uint256 dailyLimit, uint256 totalLimit, uint8 mask, bool active,
        uint256 spentToday, uint256 spentTotal, uint64 lastResetDay
    ) {
        (bool ok, bytes memory data) = playerRegistry.staticcall(
            abi.encodeWithSignature("permissions(address)", player)
        );
        if (!ok || data.length < 32 * 10) return (address(0), address(0), bytes32(0), 0, 0, 0, false, 0, 0, 0);
        (pAddr, vault, strategyHash, dailyLimit, totalLimit, mask, active, spentToday, spentTotal, lastResetDay) =
            abi.decode(data, (address, address, bytes32, uint256, uint256, uint8, bool, uint256, uint256, uint64));
    }
}

/// @dev Minimal registry interface used by HouseManager. Lives outside the
///      contract so HM doesn't pull the full PlayerAgentRegistry into its
///      bytecode just for one function selector.
interface IPlayerAgentRegistryMin {
    function executeBet(address player, uint8 game, uint256 amount, bytes calldata casinoCalldata)
        external returns (uint256 betId);
    function getActivePlayers(uint256 offset, uint256 limit)
        external view returns (address[] memory);
    function activePlayerCount() external view returns (uint256);
    /// @notice Pulls `amount` STT from the player's AgentVault into the
    ///         caller's balance to cover the user's share of the LLM cost.
    ///         Caller must be in registry.executors.
    function collectAgentFee(address player, uint256 amount) external;
}
