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
}
