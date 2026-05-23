// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CommitReveal
/// @notice Library for provably-fair RNG using commit-reveal + future blockhash.
/// @dev    Randomness recipe (must match off-chain verifier):
///         keccak256(serverSeed, clientSeed, blockhash(commitBlock + REVEAL_DELAY), nonce)
///
///         REVEAL_DELAY = 1 means the verifier reads blockhash of (commitBlock + 1).
///         Rules (enforced by the consuming contract via the helpers below):
///           - reveal allowed when block.number > commitBlock + REVEAL_DELAY
///             (strict >; on equality blockhash(current block) is 0, which would
///             nullify entropy)
///           - reveal expired when block.number > commitBlock + REVEAL_DELAY + 256
///             (blockhash window is the most recent 256 blocks)
///           - on expiry, the consumer must refund the player and rotate the
///             server seed; expired bets MUST NOT be settled with bogus 0 hash
library CommitReveal {
    /// @notice Number of blocks between commit and the block whose hash is mixed in.
    ///         Was 3 on the initial deploy; trimmed to 1 to cut ~2.4s (2 blocks
    ///         × 1.2s Somnia block time) off the spin loop. Reveal becomes
    ///         possible at commitBlock+2 instead of commitBlock+4. Security is
    ///         unchanged - randomness still pulls from a block whose hash was
    ///         not known at commit time, and the seed commitment remains.
    uint256 internal constant REVEAL_DELAY = 1;

    /// @notice Maximum age (in blocks) of (commitBlock + REVEAL_DELAY) for which
    ///         blockhash(...) is non-zero. EVM exposes the last 256 blocks.
    uint256 internal constant BLOCKHASH_WINDOW = 256;

    error RevealTooEarly(uint256 currentBlock, uint256 earliestBlock);
    error RevealExpired(uint256 currentBlock, uint256 latestBlock);
    error InvalidServerSeed();

    /// @dev True iff the consumer is allowed to call reveal now.
    function isRevealable(uint256 commitBlock) internal view returns (bool) {
        return block.number > commitBlock + REVEAL_DELAY
            && block.number <= commitBlock + REVEAL_DELAY + BLOCKHASH_WINDOW;
    }

    /// @dev True iff the (commitBlock + REVEAL_DELAY) block is older than the
    ///      EVM blockhash window. Consumer must refund and rotate seeds.
    function isExpired(uint256 commitBlock) internal view returns (bool) {
        return block.number > commitBlock + REVEAL_DELAY + BLOCKHASH_WINDOW;
    }

    /// @dev Reverts unless reveal is currently allowed.
    function requireRevealable(uint256 commitBlock) internal view {
        uint256 earliest = commitBlock + REVEAL_DELAY + 1; // strict >
        uint256 latest = commitBlock + REVEAL_DELAY + BLOCKHASH_WINDOW;
        if (block.number < earliest) revert RevealTooEarly(block.number, earliest);
        if (block.number > latest) revert RevealExpired(block.number, latest);
    }

    /// @dev Verifies that keccak256(serverSeed) equals the previously-committed hash.
    function requireSeedMatches(bytes32 serverSeed, bytes32 committedHash) internal pure {
        if (keccak256(abi.encode(serverSeed)) != committedHash) revert InvalidServerSeed();
    }

    /// @dev Pre-commit hash for a server seed. Encoded with abi.encode (length-prefixed)
    ///      so it cannot be confused with raw concatenations elsewhere.
    function hashServerSeed(bytes32 serverSeed) internal pure returns (bytes32) {
        return keccak256(abi.encode(serverSeed));
    }

    /// @dev Derives the final randomness for a bet. Must be called only after
    ///      requireRevealable + requireSeedMatches.
    function deriveRandomness(
        bytes32 serverSeed,
        bytes32 clientSeed,
        uint256 commitBlock,
        uint256 nonce
    ) internal view returns (bytes32) {
        bytes32 futureHash = blockhash(commitBlock + REVEAL_DELAY);
        // futureHash MUST be non-zero here. Belt-and-suspenders check; if this
        // fires, the consumer mis-ordered checks (didn't requireRevealable first).
        require(futureHash != bytes32(0), "CommitReveal: blockhash unavailable");
        return keccak256(abi.encodePacked(serverSeed, clientSeed, futureHash, nonce));
    }
}
