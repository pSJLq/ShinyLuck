// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPokerDealer} from "./IPokerDealer.sol";

/// @title CommitRevealDealer
/// @notice v1 card layer for ShinyPoker: a provably-fair commit-reveal dealer.
///         The deck for each hand is bound to a server seed committed *before*
///         the hand and to a *future* block hash chosen by validators *after* the
///         hand starts — so neither the dealer nor anyone else can predict or
///         grind the deck. At showdown the seed is revealed, the entire 52-card
///         deck is **re-derived and verified on-chain**, and the room reads the
///         resulting cards to rank hands. Anyone can recompute the deck from the
///         revealed seed and prove the deal was honest.
///
/// @dev    Trust note: the off-chain dealer bot computes the deck once the seed
///         and entropy are known, so it *sees* the cards (it must, to deliver
///         each player their encrypted hole cards). It is cryptographically
///         bound and cannot change the deck or the board (a mismatched board
///         reveal makes {revealSeed} revert). The fully-trustless "nobody ever
///         sees a card" upgrade is the zkShuffle dealer (v2) behind this same
///         {IPokerDealer} interface.
///
///         Blockhash-window robustness: a hand can outlast the EVM's 256-block
///         blockhash window, so the bot calls {lockEntropy} right after the hand
///         starts to persist blockhash(commitBlock+REVEAL_DELAY) into storage.
///         Showdown can then re-derive the deck any time later.
///
///         Card encoding matches {IPokerDealer}: 0..51 = rank*4 + suit.
contract CommitRevealDealer is IPokerDealer, Ownable {
    uint256 internal constant REVEAL_DELAY = 1;
    uint256 internal constant BLOCKHASH_WINDOW = 256;

    /// Pre-committed server-seed hashes (keccak256(abi.encode(seed))), provisioned
    /// far in advance so the dealer is locked in before any player or hand exists.
    bytes32[] public seedHashes;
    uint256 public nextHashIndex;

    address public room; // the PokerRoom permitted to start deals
    address public dealerBot; // off-chain dealer permitted to lock entropy / reveal

    struct Deal {
        uint64 handId;
        uint64 tableId;
        uint64 commitBlock;
        uint8 playerCount;
        uint8 boardCount; // how many board cards are currently revealed
        bool entropyLocked;
        bool revealed;
        bytes32 seedHash;
        bytes32 entropy; // persisted blockhash(commitBlock + REVEAL_DELAY)
        bytes32 serverSeed; // revealed at showdown
        uint8[] seats; // dealt-in seats, in deal order
        uint8[5] board;
        mapping(uint8 => uint8[2]) hole; // seat => [card0, card1]
    }

    uint256 public nextDealId;
    mapping(uint256 => Deal) internal _deals;

    event SeedHashesProvisioned(uint256 startIndex, uint256 count);
    event RoomUpdated(address indexed prev, address indexed next);
    event DealerBotUpdated(address indexed prev, address indexed next);
    event DealStarted(uint256 indexed dealId, uint256 indexed tableId, uint64 indexed handId, bytes32 seedHash, uint64 commitBlock);
    event EntropyLocked(uint256 indexed dealId, bytes32 entropy);
    event BoardRevealed(uint256 indexed dealId, uint8 count);
    event SeedRevealed(uint256 indexed dealId, bytes32 serverSeed);

    error NotRoom();
    error NotDealerBot();
    error NoSeeds();
    error AlreadyLocked();
    error NotLocked();
    error AlreadyRevealed();
    error TooEarly();
    error WindowExpired();
    error NoBlockhash();
    error BadSeed();
    error BoardMismatch();
    error BadBoardCount();

    constructor(address initialOwner) Ownable(initialOwner) {}

    modifier onlyRoom() {
        if (msg.sender != room) revert NotRoom();
        _;
    }

    modifier onlyBot() {
        if (msg.sender != dealerBot && msg.sender != owner()) revert NotDealerBot();
        _;
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    function setRoom(address newRoom) external onlyOwner {
        emit RoomUpdated(room, newRoom);
        room = newRoom;
    }

    function setDealerBot(address bot) external onlyOwner {
        emit DealerBotUpdated(dealerBot, bot);
        dealerBot = bot;
    }

    /// @dev Callable by the dealer bot (or owner) so it can keep itself stocked.
    function provisionSeedHashes(bytes32[] calldata hashes) external onlyBot {
        uint256 start = seedHashes.length;
        for (uint256 i = 0; i < hashes.length; i++) {
            seedHashes.push(hashes[i]);
        }
        emit SeedHashesProvisioned(start, hashes.length);
    }

    function seedsRemaining() external view returns (uint256) {
        return seedHashes.length - nextHashIndex;
    }

    // ------------------------------------------------------------------
    // IPokerDealer — hand start
    // ------------------------------------------------------------------

    function startHand(uint256 tableId, uint64 handId, uint8 playerCount, uint8[] calldata seats)
        external
        onlyRoom
        returns (uint256 dealId)
    {
        if (nextHashIndex >= seedHashes.length) revert NoSeeds();
        dealId = ++nextDealId; // 1-based
        Deal storage d = _deals[dealId];
        d.handId = handId;
        d.tableId = uint64(tableId);
        d.commitBlock = uint64(block.number);
        d.playerCount = playerCount;
        d.seedHash = seedHashes[nextHashIndex++];
        d.seats = seats;
        emit DealStarted(dealId, tableId, handId, d.seedHash, d.commitBlock);
    }

    // ------------------------------------------------------------------
    // Dealer bot — entropy, board, reveal
    // ------------------------------------------------------------------

    /// @notice Persist the future block hash that seeds the deck, inside the
    ///         256-block window. The bot calls this immediately after the hand
    ///         starts; after this the deck is fully determined yet still secret
    ///         (the seed stays hidden until showdown).
    function lockEntropy(uint256 dealId) external onlyBot {
        Deal storage d = _deals[dealId];
        if (d.entropyLocked) revert AlreadyLocked();
        uint256 bh = uint256(d.commitBlock) + REVEAL_DELAY;
        if (block.number <= bh) revert TooEarly();
        if (block.number > bh + BLOCKHASH_WINDOW) revert WindowExpired();
        bytes32 hash = blockhash(bh);
        if (hash == bytes32(0)) revert NoBlockhash();
        d.entropy = hash;
        d.entropyLocked = true;
        emit EntropyLocked(dealId, hash);
    }

    /// @notice Post community cards for live display as streets advance. These are
    ///         checked against the on-chain-derived deck at {revealSeed}.
    function revealBoard(uint256 dealId, uint8 count, uint8[5] calldata cards) external onlyBot {
        Deal storage d = _deals[dealId];
        if (count < d.boardCount || count > 5) revert BadBoardCount();
        for (uint8 i = 0; i < count; i++) {
            d.board[i] = cards[i];
        }
        d.boardCount = count;
        emit BoardRevealed(dealId, count);
    }

    /// @notice Reveal the server seed at showdown. Verifies the commitment,
    ///         re-derives the whole deck on-chain, checks any pre-posted board
    ///         matches, and exposes every dealt seat's hole cards + the board for
    ///         the room to rank.
    function revealSeed(uint256 dealId, bytes32 serverSeed) external onlyBot {
        Deal storage d = _deals[dealId];
        if (!d.entropyLocked) revert NotLocked();
        if (d.revealed) revert AlreadyRevealed();
        if (keccak256(abi.encode(serverSeed)) != d.seedHash) revert BadSeed();

        uint8[52] memory deck = _deriveDeck(serverSeed, d.entropy, d.handId, d.tableId);
        uint8 k = d.playerCount;

        // Hole cards: first round one per seat, then a second round.
        for (uint8 i = 0; i < k; i++) {
            uint8 seat = d.seats[i];
            d.hole[seat][0] = deck[i];
            d.hole[seat][1] = deck[k + i];
        }

        // Board: the five cards after the hole cards (burns omitted by design).
        uint8 posted = d.boardCount;
        for (uint8 j = 0; j < 5; j++) {
            uint8 derived = deck[2 * k + j];
            if (j < posted && d.board[j] != derived) revert BoardMismatch();
            d.board[j] = derived;
        }
        d.boardCount = 5;
        d.serverSeed = serverSeed;
        d.revealed = true;
        emit SeedRevealed(dealId, serverSeed);
    }

    // ------------------------------------------------------------------
    // Deck derivation (deterministic; anyone can recompute)
    // ------------------------------------------------------------------

    /// @notice Deterministic Fisher-Yates shuffle of a 52-card deck from the
    ///         revealed seed + locked entropy. Pure, so verifiers and the
    ///         off-chain bot reproduce it exactly.
    function recomputeDeck(bytes32 serverSeed, bytes32 entropy, uint64 handId, uint64 tableId)
        external
        pure
        returns (uint8[52] memory)
    {
        return _deriveDeck(serverSeed, entropy, handId, tableId);
    }

    function _deriveDeck(bytes32 serverSeed, bytes32 entropy, uint64 handId, uint64 tableId)
        internal
        pure
        returns (uint8[52] memory deck)
    {
        for (uint8 i = 0; i < 52; i++) {
            deck[i] = i;
        }
        bytes32 r = keccak256(abi.encode(serverSeed, entropy, handId, tableId));
        for (uint256 i = 51; i > 0; i--) {
            r = keccak256(abi.encode(r, i));
            uint256 j = uint256(r) % (i + 1);
            (deck[i], deck[j]) = (deck[j], deck[i]);
        }
    }

    // ------------------------------------------------------------------
    // IPokerDealer — views
    // ------------------------------------------------------------------

    function boardRevealedCount(uint256 dealId) external view returns (uint8) {
        return _deals[dealId].boardCount;
    }

    function isShowdownReady(uint256 dealId) external view returns (bool) {
        return _deals[dealId].revealed;
    }

    function boardCards(uint256 dealId) external view returns (uint8[5] memory) {
        return _deals[dealId].board;
    }

    function holeCards(uint256 dealId, uint8 seat) external view returns (uint8, uint8) {
        uint8[2] memory hc = _deals[dealId].hole[seat];
        return (hc[0], hc[1]);
    }

    /// @notice Convenience for the verification UI: a deal's revealed metadata.
    function dealInfo(uint256 dealId)
        external
        view
        returns (
            uint64 handId,
            uint64 tableId,
            uint64 commitBlock,
            uint8 playerCount,
            bytes32 seedHash,
            bytes32 entropy,
            bytes32 serverSeed,
            bool revealed,
            uint8[] memory seats
        )
    {
        Deal storage d = _deals[dealId];
        return (d.handId, d.tableId, d.commitBlock, d.playerCount, d.seedHash, d.entropy, d.serverSeed, d.revealed, d.seats);
    }
}
