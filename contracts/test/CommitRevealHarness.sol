// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CommitReveal} from "../CommitReveal.sol";

/// @notice Test-only harness exposing CommitReveal library functions externally.
contract CommitRevealHarness {
    function isRevealable(uint256 commitBlock) external view returns (bool) {
        return CommitReveal.isRevealable(commitBlock);
    }

    function isExpired(uint256 commitBlock) external view returns (bool) {
        return CommitReveal.isExpired(commitBlock);
    }

    function checkRevealable(uint256 commitBlock) external view {
        CommitReveal.requireRevealable(commitBlock);
    }

    function checkSeed(bytes32 serverSeed, bytes32 committedHash) external pure {
        CommitReveal.requireSeedMatches(serverSeed, committedHash);
    }

    function hashServerSeed(bytes32 serverSeed) external pure returns (bytes32) {
        return CommitReveal.hashServerSeed(serverSeed);
    }

    function derive(
        bytes32 serverSeed,
        bytes32 clientSeed,
        uint256 commitBlock,
        uint256 nonce
    ) external view returns (bytes32) {
        return CommitReveal.deriveRandomness(serverSeed, clientSeed, commitBlock, nonce);
    }

    function revealDelay() external pure returns (uint256) {
        return CommitReveal.REVEAL_DELAY;
    }

    function blockhashWindow() external pure returns (uint256) {
        return CommitReveal.BLOCKHASH_WINDOW;
    }
}
