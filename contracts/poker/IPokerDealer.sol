// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPokerDealer
/// @notice Swappable card layer for ShinyPoker. The PokerRoom betting engine is
///         entirely card-agnostic during play — it only consults the dealer at
///         hand start (to bind a deck) and at showdown (to read revealed cards).
///         This lets the card-secrecy model be a drop-in module:
///
///           v1  CommitRevealDealer — off-chain dealer commits hash(deckSeed)
///               on-chain at hand start, delivers each player's hole cards
///               privately (encrypted to their wallet) plus a per-player
///               on-chain commitment, and reveals the seed at showdown so the
///               whole deck is reconstructible and verifiable. Provably fair;
///               the dealer technically sees cards.
///           v2  ZkShuffleDealer — mental poker (ElGamal + Groth16); nobody,
///               not even the dealer, ever sees a hole card. Same interface.
///           v2'  VrfDealer — Chainlink VRF v2.5 shuffle; trustless randomness,
///               fast, a fallback if zkShuffle proving is too heavy in practice.
///
///         Cards are encoded 0..51 as (rank * 4 + suit), rank 0..12 = 2..A,
///         suit 0..3 = ♣♦♥♠. 255 = "not yet revealed".
interface IPokerDealer {
    /// @notice Called by the room when a hand begins. The dealer prepares a
    ///         shuffled deck for `playerCount` players seated at `seats` and
    ///         binds a public commitment. Returns an opaque handle the room
    ///         passes back when reading cards.
    /// @dev    MUST be callable only by the registered room.
    function startHand(
        uint256 tableId,
        uint64 handId,
        uint8 playerCount,
        uint8[] calldata seats
    ) external returns (uint256 dealId);

    /// @notice Number of community cards the dealer has revealed so far
    ///         (0 preflop, 3 flop, 4 turn, 5 river). The room gates street
    ///         advancement on this so the off-chain dealer reveals the board in
    ///         lockstep with on-chain betting rounds closing.
    function boardRevealedCount(uint256 dealId) external view returns (uint8);

    /// @notice True once the dealer has revealed every card needed to evaluate a
    ///         showdown (all live hole cards + the 5 board cards) and proven them
    ///         against the hand-start commitment. The room blocks payout until then.
    function isShowdownReady(uint256 dealId) external view returns (bool);

    /// @notice The 5 community cards. Entries beyond `boardRevealedCount` are 255.
    function boardCards(uint256 dealId) external view returns (uint8[5] memory);

    /// @notice A seat's two hole cards. Returns (255,255) until revealed at
    ///         showdown for that seat (folded seats may never be revealed).
    function holeCards(uint256 dealId, uint8 seatIndex)
        external
        view
        returns (uint8 card0, uint8 card1);
}
