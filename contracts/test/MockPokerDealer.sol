// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPokerDealer} from "../poker/IPokerDealer.sol";

/// @dev Test-only {IPokerDealer} whose cards are set explicitly by the test. Lets
///      the engine's showdown distribution be exercised with deterministic hands
///      before the real commit-reveal / zkShuffle dealers exist.
contract MockPokerDealer is IPokerDealer {
    uint256 public nextDealId;
    mapping(uint256 => uint8) internal _revealed;
    mapping(uint256 => bool) internal _ready;
    mapping(uint256 => uint8[5]) internal _board;
    mapping(uint256 => mapping(uint8 => uint8[2])) internal _hole;

    function startHand(uint256, uint64, uint8, uint8[] calldata) external returns (uint256 dealId) {
        dealId = ++nextDealId; // 1-based
    }

    function setBoard(uint256 dealId, uint8[5] calldata b) external {
        _board[dealId] = b;
        _revealed[dealId] = 5;
    }

    function setHole(uint256 dealId, uint8 seat, uint8 c0, uint8 c1) external {
        _hole[dealId][seat][0] = c0;
        _hole[dealId][seat][1] = c1;
    }

    function setReady(uint256 dealId, bool v) external {
        _ready[dealId] = v;
    }

    function boardRevealedCount(uint256 dealId) external view returns (uint8) {
        return _revealed[dealId];
    }

    function isShowdownReady(uint256 dealId) external view returns (bool) {
        return _ready[dealId];
    }

    function boardCards(uint256 dealId) external view returns (uint8[5] memory) {
        return _board[dealId];
    }

    function holeCards(uint256 dealId, uint8 seat) external view returns (uint8, uint8) {
        uint8[2] memory h = _hole[dealId][seat];
        return (h[0], h[1]);
    }
}
