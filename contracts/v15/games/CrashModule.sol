// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CommitReveal} from "../../CommitReveal.sol";
import {IGameBase, ICasinoVaultModule} from "../IGameModule.sol";
import {GameGate} from "./GameGate.sol";

/// @title CrashModule — ShinyLuck v15 (round-based, module-entry)
/// @notice Ported from Casino v14 crash. ONE settle serves every player in the
///         round, which is why round games scale to any number of players at
///         constant cost. The bustabit curve is unchanged: P(cp >= m) =
///         (1-edge)/m, so cashing out at ANY target has EV = 99%.
///         Holds no funds — stakes and payouts go through the Vault's
///         module-gated primitives. Rounds are opened on demand (permissionless)
///         so the house burns no gas on empty rounds.
contract CrashModule is IGameBase, GameGate, Ownable, ReentrancyGuard {
    uint16 public constant GAME_ID = 1; // CRASH
    uint16 public constant HOUSE_EDGE_BPS = 100; // 99% RTP (Stake parity)

    uint256 public constant CRASH_ROUND_TIMEOUT = 5 minutes;
    uint256 public constant CRASH_MIN_AUTOCASHOUT = 101;
    uint256 public constant CRASH_MAX_AUTOCASHOUT = 10000;
    uint256 public constant MAX_BET_WINDOW = 30 seconds;

    ICasinoVaultModule public immutable vault;
    uint256 public betWindow = 18 seconds;

    struct Round {
        uint64 roundId;
        uint64 betWindowEnd;
        uint64 commitBlock;
        uint32 seedIdx;
        bool   settled;
        uint16 crashPointX100;
        bytes32 serverSeed;
        address[] bettors;
    }
    struct Bet {
        uint96 amount;
        uint16 autoCashoutX100;
        uint16 cashoutMultX100;
        bool   resolved;
    }

    Round[] private _rounds;
    mapping(uint256 => mapping(address => Bet)) public bets;
    uint256 public currentRoundId;
    bool private _hasOpenRound;

    event RoundStarted(uint256 indexed roundId, uint256 betWindowEnd, uint256 commitBlock, uint256 seedIdx);
    event BetPlaced(uint256 indexed roundId, address indexed player, uint256 amount, uint256 autoCashoutX100);
    event CashoutRequested(uint256 indexed roundId, address indexed player, uint256 multX100);
    event RoundSettled(uint256 indexed roundId, uint256 crashPointX100, bytes32 serverSeed, bytes32 randomness, bytes32 blockHash);
    event PlayerSettled(uint256 indexed roundId, address indexed player, bool won, uint256 payout, uint256 effectiveMultX100);
    event RoundRefunded(uint256 indexed roundId, string reason);

    error RoundNotFound();
    error RoundClosed();
    error RoundAlreadySettled();
    error RoundNotSettleable();
    error InvalidBet(string reason);
    error BetNotFound();
    error BetAlreadySettled();
    error CashoutTooLow();

    constructor(address _vault) Ownable(msg.sender) {
        require(_vault != address(0), "vault=0");
        vault = ICasinoVaultModule(_vault);
    }

    function gameId() external pure returns (uint16) { return GAME_ID; }
    function houseEdgeBps() external pure returns (uint16) { return HOUSE_EDGE_BPS; }

    function setBetWindow(uint256 secs) external onlyOwner {
        require(secs > 0 && secs <= MAX_BET_WINDOW, "window");
        betWindow = secs;
    }

    /// @notice Open a round. Permissionless + on-demand: the first player who
    ///         wants to bet opens it, so no gas is burned cycling empty rounds.
    function startRound() external nonReentrant {
        _requireOpen(vault);
        if (_hasOpenRound) revert RoundClosed();
        (uint256 seedIdx, ) = vault.reserveSeed();
        _rounds.push();
        Round storage r = _rounds[_rounds.length - 1];
        r.roundId = uint64(_rounds.length - 1);
        r.betWindowEnd = uint64(block.timestamp + betWindow);
        r.commitBlock = uint64(block.number);
        r.seedIdx = uint32(seedIdx);
        currentRoundId = r.roundId;
        _hasOpenRound = true;
        emit RoundStarted(r.roundId, r.betWindowEnd, r.commitBlock, seedIdx);
    }

    function placeBet(uint256 autoCashoutX100) external payable nonReentrant {
        _requireOpen(vault);
        if (!_hasOpenRound || _rounds.length == 0) revert RoundNotFound();
        if (autoCashoutX100 != 0 &&
            (autoCashoutX100 < CRASH_MIN_AUTOCASHOUT || autoCashoutX100 > CRASH_MAX_AUTOCASHOUT))
            revert InvalidBet("autoCashout");
        Round storage r = _rounds[currentRoundId];
        if (block.timestamp >= r.betWindowEnd) revert RoundClosed();
        if (msg.value == 0) revert InvalidBet("zero stake");

        Bet storage cb = bets[r.roundId][msg.sender];
        // One bet per player per round (a second would overwrite autoCashout).
        if (cb.amount != 0) revert InvalidBet("already bet this round");

        uint256 maxPayout = (msg.value * (autoCashoutX100 == 0 ? CRASH_MAX_AUTOCASHOUT : autoCashoutX100)) / 100;
        if (maxPayout < msg.value) revert InvalidBet("payout < stake");
        vault.escrowStake{value: msg.value}(msg.sender, maxPayout);

        r.bettors.push(msg.sender);
        cb.amount = uint96(msg.value);
        cb.autoCashoutX100 = uint16(autoCashoutX100);
        emit BetPlaced(r.roundId, msg.sender, msg.value, autoCashoutX100);
    }

    /// @notice Manual cashout request (recorded; validated against the crash
    ///         point at settle).
    function requestCashout(uint256 multX100) external nonReentrant {
        if (!_hasOpenRound || _rounds.length == 0) revert RoundNotFound();
        Round storage r = _rounds[currentRoundId];
        if (block.timestamp < r.betWindowEnd) revert RoundClosed();
        if (r.settled) revert RoundAlreadySettled();
        if (multX100 < CRASH_MIN_AUTOCASHOUT) revert CashoutTooLow();
        // Bound it like autoCashout: the value is stored in a uint16, so an
        // unchecked request both truncates silently and asks for a payout the
        // round never escrowed exposure for.
        if (multX100 > CRASH_MAX_AUTOCASHOUT) revert InvalidBet("cashout too high");
        Bet storage cb = bets[r.roundId][msg.sender];
        if (cb.amount == 0) revert BetNotFound();
        if (cb.cashoutMultX100 != 0) revert BetAlreadySettled();
        cb.cashoutMultX100 = uint16(multX100);
        emit CashoutRequested(r.roundId, msg.sender, multX100);
    }

    /// @notice Permissionless settle (gated on the committed seed hash).
    function settleRound(uint256 roundId, bytes32 serverSeed) external nonReentrant {
        if (roundId >= _rounds.length) revert RoundNotFound();
        Round storage r = _rounds[roundId];
        if (r.settled) revert RoundAlreadySettled();
        if (block.timestamp < r.betWindowEnd) revert RoundClosed();
        if (CommitReveal.isExpired(r.commitBlock)) { _refundRound(roundId, "expired blockhash"); return; }
        CommitReveal.requireRevealable(r.commitBlock);

        bytes32 stored = vault.revealSeed(r.seedIdx, serverSeed);
        bytes32 blockHash = blockhash(uint256(r.commitBlock) + CommitReveal.REVEAL_DELAY);
        bytes32 randomness = keccak256(abi.encodePacked(stored, blockHash, r.roundId));
        uint256 cp = _crashPoint(randomness);
        r.crashPointX100 = uint16(cp > type(uint16).max ? type(uint16).max : cp);
        r.serverSeed = stored;
        r.settled = true;
        _hasOpenRound = false;
        emit RoundSettled(r.roundId, cp, stored, randomness, blockHash);

        for (uint256 i; i < r.bettors.length; i++) {
            address p = r.bettors[i];
            Bet storage cb = bets[r.roundId][p];
            if (cb.resolved) continue;
            cb.resolved = true;
            // Auto and manual are two exit points on the SAME rising curve, so
            // the one that fires first is the SMALLER multiplier — that is the
            // one the player actually got out at.
            //
            // Taking the larger (what this did) was wrong twice over: a player
            // who clicked out at 2x was paid their 5x auto, and — because
            // `placeBet` escrows exposure from `autoCashoutX100` alone — a bet
            // with auto=1.01x reserved 1.01x of exposure while a later manual
            // request could still claim up to 100x, walking straight past the
            // Vault's per-bet exposure cap.
            uint256 autoX = cb.autoCashoutX100;
            uint256 manualX = cb.cashoutMultX100;
            uint256 target = (autoX > 0 && manualX > 0)
                ? (autoX < manualX ? autoX : manualX)
                : (autoX > 0 ? autoX : manualX);
            uint256 effective = (target > 0 && target <= cp) ? target : 0;
            if (effective > 0) {
                uint256 payout = (uint256(cb.amount) * effective) / 100;
                uint256 credited = vault.creditFromModule(p, r.roundId, payout);
                emit PlayerSettled(r.roundId, p, true, credited, effective);
            } else {
                emit PlayerSettled(r.roundId, p, false, 0, 0);
            }
        }
    }

    function refundRound(uint256 roundId) external nonReentrant {
        if (roundId >= _rounds.length) revert RoundNotFound();
        Round storage r = _rounds[roundId];
        if (r.settled) revert RoundAlreadySettled();
        if (block.timestamp < r.betWindowEnd + CRASH_ROUND_TIMEOUT &&
            !CommitReveal.isExpired(r.commitBlock)) revert RoundNotSettleable();
        _refundRound(roundId, "round timeout");
    }

    function _refundRound(uint256 roundId, string memory reason) internal {
        Round storage r = _rounds[roundId];
        for (uint256 i; i < r.bettors.length; i++) {
            address p = r.bettors[i];
            Bet storage cb = bets[r.roundId][p];
            if (cb.resolved) continue;
            cb.resolved = true;
            vault.refundFromModule(p, cb.amount);
        }
        r.settled = true;
        _hasOpenRound = false;
        emit RoundRefunded(roundId, reason);
    }

    /// @dev Bustabit curve, identical to v14: P(cp >= m) = (1 - edge)/m.
    function _crashPoint(bytes32 randomness) internal pure returns (uint256) {
        uint256 e = 1 << 52;
        uint256 h = uint256(randomness) % e;
        uint256 num = 10000 - HOUSE_EDGE_BPS;
        uint256 cp = (num * e) / (100 * (e - h));
        return cp < 100 ? 100 : cp;
    }

    // ── views ───────────────────────────────────────────────────────────────
    function totalRounds() external view returns (uint256) { return _rounds.length; }
    function hasOpenRound() external view returns (bool) { return _hasOpenRound; }
    function getRound(uint256 roundId) external view returns (
        uint64 id, uint64 betWindowEnd, uint64 commitBlock, uint32 seedIdx,
        bool settled, uint16 crashPointX100, bytes32 serverSeed, uint256 bettorCount
    ) {
        if (roundId >= _rounds.length) revert RoundNotFound();
        Round storage r = _rounds[roundId];
        return (r.roundId, r.betWindowEnd, r.commitBlock, r.seedIdx, r.settled,
                r.crashPointX100, r.serverSeed, r.bettors.length);
    }
    function getBettors(uint256 roundId) external view returns (address[] memory) {
        if (roundId >= _rounds.length) revert RoundNotFound();
        return _rounds[roundId].bettors;
    }
    function getBet(uint256 roundId, address player) external view returns (Bet memory) {
        return bets[roundId][player];
    }
}
