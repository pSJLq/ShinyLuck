// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PokerHandEval} from "../poker/PokerHandEval.sol";

/// @dev Test-only wrapper so the pure evaluator library can be unit-tested.
contract PokerEvalHarness {
    function score(uint8[7] calldata cards) external pure returns (uint32) {
        uint8[7] memory m;
        for (uint256 i = 0; i < 7; i++) m[i] = cards[i];
        return PokerHandEval.eval7(m);
    }
}
