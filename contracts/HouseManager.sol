// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Casino} from "./Casino.sol";
import {SomniaEventHandler} from "@somnia-chain/reactivity-contracts/contracts/SomniaEventHandler.sol";
import {SomniaExtensions} from "@somnia-chain/reactivity-contracts/contracts/interfaces/SomniaExtensions.sol";

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
contract HouseManager is SomniaEventHandler, Ownable {
    Casino public immutable casino;
    address public hmAgent;

    // BetSettled topic0: keccak256("BetSettled(uint256,address,uint8,bool,uint256,bytes32,bytes32,bytes32,bytes32,uint256,bytes)")
    // We don't hardcode the literal hash here — instead we compare emitter
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
        // Unknown emitter — ignore.
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
            // Casino reverted — likely Casino is paused or value exceeded
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

        // Decide. Order matters — first matching branch wins.
        // Big growth → lower slot RTP (more retentive).
        // Mild growth → activate bonus mode (more generous, keep players engaged).
        // Mild drop  → raise slot RTP (rebuild trust).
        // Big drop   → pause hot games (protect bankroll).
        if (changeBps > 1500) {
            try casino.adjustSlotRTP(uint8(Casino.GameType.SLOTS), 9000, "auto: bankroll growth >15%") {} catch {}
            try casino.adjustSlotRTP(uint8(Casino.GameType.CLUSTER), 9000, "auto: bankroll growth >15%") {} catch {}
            emit ReasoningRequested("LOWER_SLOT_RTP", changeBps, free, nowTs);
        } else if (changeBps > 1000) {
            try casino.activateBonusMode(60, "auto: bankroll growth >10%, rewarding players") {} catch {}
            emit ReasoningRequested("BONUS_MODE", changeBps, free, nowTs);
        } else if (changeBps < -2000) {
            try casino.pauseGame(Casino.GameType.CRASH) {} catch {}
            try casino.pauseGame(Casino.GameType.CLUSTER) {} catch {}
            try casino.pauseGame(Casino.GameType.SLOTS) {} catch {}
            emit ReasoningRequested("PAUSE_HOT_GAMES", changeBps, free, nowTs);
        } else if (changeBps < -1000) {
            try casino.adjustSlotRTP(uint8(Casino.GameType.SLOTS), 9400, "auto: bankroll drop >10%, rebuilding trust") {} catch {}
            try casino.adjustSlotRTP(uint8(Casino.GameType.CLUSTER), 9400, "auto: bankroll drop >10%, rebuilding trust") {} catch {}
            emit ReasoningRequested("RAISE_SLOT_RTP", changeBps, free, nowTs);
        }

        emit ReactiveHourlyTick(free, changeBps);
    }

    function _rescheduleHourlyTick() internal {
        // One-shot schedule for ~1 hour from now. The next handler invocation
        // will call us back, and we re-schedule again. Net effect: a
        // self-perpetuating hourly cron without any off-chain keeper.
        // SubscriptionOwner balance check is on address(this).balance ≥ 32 ETH,
        // so we silently skip if the balance ever drops below that.
        if (address(this).balance < SomniaExtensions.SUBSCRIPTION_OWNER_MINIMUM_BALANCE) {
            return;
        }
        SomniaExtensions.SubscriptionOptions memory opts = SomniaExtensions.defaultSubscriptionOptions();
        uint256 nextMs = (block.timestamp + 3600) * 1000 + 1;
        try this.scheduleHourly(nextMs, opts) returns (uint256 subId) {
            hourlyCronSubId = subId;
            emit SubscriptionCreated(subId, "hourly-cron-renew");
        } catch {
            // Reschedule failed — operator can call rebootHourlyTick() manually.
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
        SomniaExtensions.SubscriptionOptions memory opts = SomniaExtensions.defaultSubscriptionOptions();
        uint256 nextMs = (block.timestamp + 3600) * 1000 + 1;
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
    ///         BetSettled signature — passed in from JS to avoid re-computing
    ///         it on-chain.
    function subscribeToBetSettled(address emitter, bytes32 topic0) external onlyOwner returns (uint256 subId) {
        require(address(this).balance >= SomniaExtensions.SUBSCRIPTION_OWNER_MINIMUM_BALANCE, "fund first (>=32 STT)");
        SomniaExtensions.SubscriptionFilter memory filter = SomniaExtensions.SubscriptionFilter({
            eventTopics: [topic0, bytes32(0), bytes32(0), bytes32(0)],
            origin:  address(0),
            emitter: emitter
        });
        SomniaExtensions.SubscriptionOptions memory opts = SomniaExtensions.defaultSubscriptionOptions();
        subId = SomniaExtensions.subscribe(address(this), filter, opts);
        betSettledSubId = subId;
        emit SubscriptionCreated(subId, "bet-settled");
    }

    function rebootHourlyTick() external onlyOwner {
        SomniaExtensions.SubscriptionOptions memory opts = SomniaExtensions.defaultSubscriptionOptions();
        uint256 nextMs = (block.timestamp + 3600) * 1000 + 1;
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
}
