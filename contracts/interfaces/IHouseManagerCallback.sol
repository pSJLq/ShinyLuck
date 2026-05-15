// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IHouseManagerCallback
/// @notice Interface that the Casino exposes for the HouseManager (and
///         indirectly the Somnia House Manager Agent) to drive bankroll policy.
interface IHouseManagerCallback {
    function setMaxBet(uint8 gameType, uint256 amount) external;
    function pauseGame(uint8 gameType) external;
    function unpauseGame(uint8 gameType) external;
    function activateBonusMode(uint256 durationMinutes, string calldata reasoning) external;
    function recordReasoning(string calldata thought) external;
}
