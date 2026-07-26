// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CommitReveal} from "../../CommitReveal.sol";
import {IGameBase, ICasinoVaultModule} from "../IGameModule.sol";
import {GameGate} from "./GameGate.sol";

/// @title RouletteModule — ShinyLuck v15 (round-based, module-entry)
/// @notice American wheel (0, 1..36, 00 encoded as 37) ported from Casino v14.
///         38 outcomes, both zeros lose outside bets → the classic 5.26% edge.
///         Up to 5 bets per player per round; ONE settle serves the whole round.
///         Holds no funds — money flows through the Vault's module primitives.
///         v14's agent-driven Bonus Mode boost is intentionally NOT ported
///         (the agent layer is dropped in v15).
contract RouletteModule is IGameBase, GameGate, Ownable, ReentrancyGuard {
    uint16 public constant GAME_ID = 5; // ROULETTE
    uint16 public constant HOUSE_EDGE_BPS = 526; // American wheel

    uint256 public constant ROUND_TIMEOUT = 5 minutes;
    uint8   public constant MAX_BETS_PER_PLAYER = 5;
    uint256 public constant MAX_BET_WINDOW = 30 seconds;

    ICasinoVaultModule public immutable vault;
    uint256 public betWindow = 18 seconds;

    enum BetKind { STRAIGHT, RED, BLACK, EVEN, ODD, LOW, HIGH, DOZEN_1, DOZEN_2, DOZEN_3 }

    uint64 internal constant RED_MASK =
        (uint64(1) << 1) | (uint64(1) << 3) | (uint64(1) << 5) |
        (uint64(1) << 7) | (uint64(1) << 9) | (uint64(1) << 12) |
        (uint64(1) << 14) | (uint64(1) << 16) | (uint64(1) << 18) |
        (uint64(1) << 19) | (uint64(1) << 21) | (uint64(1) << 23) |
        (uint64(1) << 25) | (uint64(1) << 27) | (uint64(1) << 30) |
        (uint64(1) << 32) | (uint64(1) << 34) | (uint64(1) << 36);

    struct BetInput {
        uint8  kind;
        uint8  number;   // for STRAIGHT: 0..37 (37 = "00")
        uint96 amount;
    }
    struct Round {
        uint64 roundId;
        uint64 betWindowEnd;
        uint64 commitBlock;
        uint32 seedIdx;
        bool   settled;
        uint8  resultNumber;
        bytes32 serverSeed;
        address[] bettors;
    }

    Round[] private _rounds;
    mapping(uint256 => mapping(address => BetInput[])) public roundBets;
    uint256 public currentRoundId;
    bool private _hasOpenRound;

    event RoundStarted(uint256 indexed roundId, uint256 betWindowEnd, uint256 commitBlock, uint256 seedIdx);
    event BetPlaced(uint256 indexed roundId, address indexed player, uint8 kind, uint8 number, uint256 amount);
    event RoundSettled(uint256 indexed roundId, uint8 resultNumber, bytes32 serverSeed, bytes32 randomness);
    event PlayerSettled(uint256 indexed roundId, address indexed player, bool won, uint256 totalStake, uint256 payout);
    event RoundRefunded(uint256 indexed roundId, string reason);

    error RoundNotFound();
    error RoundClosed();
    error RoundAlreadySettled();
    error RoundNotSettleable();
    error InvalidBet(string reason);
    error TooManyBets();

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

    function placeBets(BetInput[] calldata newBets) external payable nonReentrant {
        _requireOpen(vault);
        if (!_hasOpenRound || _rounds.length == 0) revert RoundNotFound();
        Round storage r = _rounds[currentRoundId];
        if (block.timestamp >= r.betWindowEnd) revert RoundClosed();
        if (newBets.length == 0) revert InvalidBet("no bets");
        BetInput[] storage list = roundBets[r.roundId][msg.sender];
        if (list.length + newBets.length > MAX_BETS_PER_PLAYER) revert TooManyBets();

        uint256 total = 0;
        uint256 maxPayout = 0;
        for (uint256 i; i < newBets.length; i++) {
            BetInput calldata b = newBets[i];
            if (b.amount == 0) revert InvalidBet("zero stake");
            if (b.kind > uint8(BetKind.DOZEN_3)) revert InvalidBet("kind");
            if (b.kind == uint8(BetKind.STRAIGHT) && b.number > 37) revert InvalidBet("number");
            total += b.amount;
            maxPayout += uint256(b.amount) * _multiplier(b.kind);
            list.push(b);
        }
        if (total != msg.value) revert InvalidBet("value sum");
        vault.escrowStake{value: msg.value}(msg.sender, maxPayout);

        if (list.length == newBets.length) r.bettors.push(msg.sender);
        for (uint256 i; i < newBets.length; i++) {
            emit BetPlaced(r.roundId, msg.sender, newBets[i].kind, newBets[i].number, newBets[i].amount);
        }
    }

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
        uint8 result = uint8(uint256(randomness) % 38);
        r.resultNumber = result;
        r.serverSeed = stored;
        r.settled = true;
        _hasOpenRound = false;
        emit RoundSettled(r.roundId, result, stored, randomness);

        for (uint256 i; i < r.bettors.length; i++) {
            address p = r.bettors[i];
            BetInput[] storage pb = roundBets[r.roundId][p];
            uint256 totalStake = 0;
            uint256 totalPayout = 0;
            for (uint256 j; j < pb.length; j++) {
                totalStake += pb[j].amount;
                if (_wins(pb[j].kind, pb[j].number, result)) {
                    totalPayout += uint256(pb[j].amount) * _multiplier(pb[j].kind);
                }
            }
            if (totalPayout > 0) {
                uint256 credited = vault.creditFromModule(p, r.roundId, totalPayout);
                emit PlayerSettled(r.roundId, p, true, totalStake, credited);
            } else {
                emit PlayerSettled(r.roundId, p, false, totalStake, 0);
            }
        }
    }

    function refundRound(uint256 roundId) external nonReentrant {
        if (roundId >= _rounds.length) revert RoundNotFound();
        Round storage r = _rounds[roundId];
        if (r.settled) revert RoundAlreadySettled();
        if (block.timestamp < r.betWindowEnd + ROUND_TIMEOUT &&
            !CommitReveal.isExpired(r.commitBlock)) revert RoundNotSettleable();
        _refundRound(roundId, "round timeout");
    }

    function _refundRound(uint256 roundId, string memory reason) internal {
        Round storage r = _rounds[roundId];
        for (uint256 i; i < r.bettors.length; i++) {
            address p = r.bettors[i];
            BetInput[] storage pb = roundBets[r.roundId][p];
            uint256 totalStake = 0;
            for (uint256 j; j < pb.length; j++) totalStake += pb[j].amount;
            if (totalStake > 0) vault.refundFromModule(p, totalStake);
        }
        r.settled = true;
        _hasOpenRound = false;
        emit RoundRefunded(roundId, reason);
    }

    function _multiplier(uint8 kind) internal pure returns (uint256) {
        if (kind == uint8(BetKind.STRAIGHT)) return 36;
        if (kind == uint8(BetKind.DOZEN_1) || kind == uint8(BetKind.DOZEN_2) || kind == uint8(BetKind.DOZEN_3)) return 3;
        return 2;
    }

    function _wins(uint8 kind, uint8 target, uint8 result) internal pure returns (bool) {
        if (result > 37) return false;
        if (kind == uint8(BetKind.STRAIGHT)) return result == target;
        // American wheel: BOTH 0 and 00 lose every outside bet — that is the
        // 5.26% edge (vs 2.70% on a single-zero European wheel).
        if (result == 0 || result == 37) return false;
        if (kind == uint8(BetKind.RED))   return ((RED_MASK >> result) & 1) == 1;
        if (kind == uint8(BetKind.BLACK)) return ((RED_MASK >> result) & 1) == 0;
        if (kind == uint8(BetKind.EVEN))  return result % 2 == 0;
        if (kind == uint8(BetKind.ODD))   return result % 2 == 1;
        if (kind == uint8(BetKind.LOW))   return result >= 1 && result <= 18;
        if (kind == uint8(BetKind.HIGH))  return result >= 19 && result <= 36;
        if (kind == uint8(BetKind.DOZEN_1)) return result >= 1 && result <= 12;
        if (kind == uint8(BetKind.DOZEN_2)) return result >= 13 && result <= 24;
        if (kind == uint8(BetKind.DOZEN_3)) return result >= 25 && result <= 36;
        return false;
    }

    // ── views ───────────────────────────────────────────────────────────────
    function totalRounds() external view returns (uint256) { return _rounds.length; }
    function hasOpenRound() external view returns (bool) { return _hasOpenRound; }
    function getRound(uint256 roundId) external view returns (
        uint64 id, uint64 betWindowEnd, uint64 commitBlock, uint32 seedIdx,
        bool settled, uint8 resultNumber, bytes32 serverSeed, uint256 bettorCount
    ) {
        if (roundId >= _rounds.length) revert RoundNotFound();
        Round storage r = _rounds[roundId];
        return (r.roundId, r.betWindowEnd, r.commitBlock, r.seedIdx, r.settled,
                r.resultNumber, r.serverSeed, r.bettors.length);
    }
    function getBettors(uint256 roundId) external view returns (address[] memory) {
        if (roundId >= _rounds.length) revert RoundNotFound();
        return _rounds[roundId].bettors;
    }
    function getBets(uint256 roundId, address player) external view returns (BetInput[] memory) {
        return roundBets[roundId][player];
    }
}
