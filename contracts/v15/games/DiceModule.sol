// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IGameModule} from "../IGameModule.sol";

/// @title DiceModule — ShinyLuck v15 reference game
/// @notice Passive-module pattern: holds no funds, is never the entry point for
///         money, and only returns numbers the Vault then bounds by its own
///         risk limits. Every future game follows this shape.
///
///         House edge is 100 bps at EVERY win chance, so RTP is exactly 99%
///         whether the player takes a 98% coin-flip or a 0.01% moonshot.
///
/// ### Two parameter shapes
///
/// The original shape is whole-percent (`uint8 target`, roll 1..100), which
/// caps the longest odds at 1% / 99x. Hundredths let a player chase 0.01% at
/// 9900x, so a second shape adds a basis-point target (roll 1..10000).
///
/// They are kept separate rather than migrated because both encode to the same
/// 64 bytes: a cached page sending `target = 50` meaning "50%" would decode as
/// 0.50% under a rescaled reader and silently place a completely different bet.
/// The new shape is 96 bytes and carries a version, so the two can never be
/// confused, and old bets keep settling by the exact math they were placed under.
contract DiceModule is IGameModule {
    uint16 public constant GAME_ID = 0; // DICE

    /// @dev House edge, basis points. Matches v14 `houseEdgeBps(DICE)` = 100.
    uint16 public constant HOUSE_EDGE_BPS = 100;

    /// @dev Basis-point shape: target in [1, 9999]. Which end is usable depends
    ///      on direction — `under 0.01` and `over 99.99` have no winning space,
    ///      and `_payout` rejects those rather than a blanket bound that would
    ///      also ban the perfectly valid `over 0.01` (a 99.99% chance).
    uint32 public constant MIN_TARGET_BPS = 1;
    uint32 public constant MAX_TARGET_BPS = 9999;
    uint8  public constant PARAMS_VERSION = 1;

    address public immutable vault;

    constructor(address _vault) {
        require(_vault != address(0), "vault=0");
        vault = _vault;
    }

    function gameId() external pure returns (uint16) {
        return GAME_ID;
    }

    function houseEdgeBps() external pure returns (uint16) {
        return HOUSE_EDGE_BPS;
    }

    /// @dev Decode either shape. `scale` is the roll's upper bound: 100 for the
    ///      legacy percent bet, 10000 for the basis-point one.
    function _decode(bytes calldata params)
        internal
        pure
        returns (uint256 target, bool over, uint256 scale)
    {
        if (params.length == 64) {
            (uint8 t, bool o) = abi.decode(params, (uint8, bool));
            require(t >= 2 && t <= 98, "target");
            return (uint256(t), o, 100);
        }
        (uint32 t, bool o, uint8 version) = abi.decode(params, (uint32, bool, uint8));
        require(version == PARAMS_VERSION, "params version");
        require(t >= MIN_TARGET_BPS && t <= MAX_TARGET_BPS, "target");
        return (uint256(t), o, 10000);
    }

    /// @dev Winning outcomes out of `scale`. Under wins on a strictly lower
    ///      roll, over on a strictly higher one — the target itself never wins,
    ///      which is where the house edge on the extremes comes from.
    function _winCount(uint256 target, bool over, uint256 scale) internal pure returns (uint256) {
        return over ? scale - target : target - 1;
    }

    function quote(address, uint256 stake, bytes calldata params)
        external
        pure
        returns (uint256 maxPayout)
    {
        (uint256 target, bool over, uint256 scale) = _decode(params);
        return _payout(stake, _winCount(target, over, scale), scale);
    }

    function resolve(uint256, uint256 stake, bytes32 randomness, bytes calldata params)
        external
        pure
        returns (uint256 payout, bool won, bytes memory resultData)
    {
        (uint256 target, bool over, uint256 scale) = _decode(params);
        uint256 roll = (uint256(randomness) % scale) + 1; // 1..scale
        won = over ? roll > target : roll < target;
        if (won) payout = _payout(stake, _winCount(target, over, scale), scale);
        // The legacy shape emitted the bare roll; keep that so old bets decode
        // unchanged. The new one also states its scale, so a reader never has
        // to guess whether "37" means 37% or 0.37%.
        resultData = scale == 100 ? abi.encode(roll) : abi.encode(roll, scale);
    }

    /// @dev `stake × (1 − edge) ÷ P(win)`, with P(win) = winCount / scale.
    ///      Identical to Casino v14 `_dicePayout` on the percent scale.
    function _payout(uint256 bet, uint256 winCount, uint256 scale) internal pure returns (uint256) {
        require(winCount > 0, "no win space");
        return (bet * (10000 - HOUSE_EDGE_BPS) * scale) / (winCount * 10000);
    }
}
