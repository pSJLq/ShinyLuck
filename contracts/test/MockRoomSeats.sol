// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test-only stand-in for PokerRoom's seat view. Lets ZkTableDealer's
///      folded-seat gate in {accusationAllowed} be exercised in isolation by
///      setting a seat's `inHand` flag directly, without playing a full hand.
contract MockRoomSeats {
    struct SeatHand {
        bool inHand;
        bool folded;
        bool allIn;
        bool hasActed;
        uint128 committedStreet;
        uint128 committedTotal;
    }

    mapping(uint256 => mapping(uint8 => SeatHand)) private _sh;

    function setInHand(uint256 tableId, uint8 seat, bool v) external {
        _sh[tableId][seat].inHand = v;
    }

    function getSeatHand(uint256 tableId, uint8 seat) external view returns (SeatHand memory) {
        return _sh[tableId][seat];
    }

    // ---- stand-in for PokerRoom.resolveShowdown ----------------------------
    // Lets the dealer's in-transaction settle be observed, and — with
    // `settleReverts` — lets the fallback be proven: a room that refuses must
    // never undo a valid, proven reveal.
    uint256 public settleCalls;
    uint256 public lastSettledTable;
    bool public settleReverts;

    function setSettleReverts(bool v) external { settleReverts = v; }

    function resolveShowdown(uint256 tableId) external {
        require(!settleReverts, "settle refused");
        settleCalls++;
        lastSettledTable = tableId;
    }
}
