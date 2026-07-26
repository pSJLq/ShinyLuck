// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ICasinoVaultModule } from "../IGameModule.sol";

/// @title GameGate — the door check every module-entry game owes the Vault.
///
/// @notice The Vault enforces `gameActive` and `whenNotPaused` on its own
///         `placeBet`, which is the entry path for single-shot games only
///         (Dice, Plinko). Slots, Mines, Crash and Roulette are entered at the
///         MODULE and reach the Vault through `escrowStake` — a primitive with
///         neither check. So `setGameActive(id,false)` and `pauseAll()` stopped
///         two games out of seven, while the architecture advertised them as an
///         instant kill switch for any game.
///
///         Every module that takes money at its own entry point inherits this
///         and calls `_requireOpen(vault)` before touching a stake.
abstract contract GameGate {
    error GameClosed();

    /// @dev Reverts unless this module is still registered, its game is active,
    ///      and the casino is not globally paused. It asks by module ADDRESS,
    ///      so a de-registered module stops accepting bets too — a hardcoded
    ///      game id would keep reading the flag of whatever replaced it.
    ///
    ///      Settlement, cashout and refund paths deliberately do NOT gate on
    ///      this: pausing must stop NEW bets, never strand money already staked.
    function _requireOpen(ICasinoVaultModule v) internal view {
        if (v.paused()) revert GameClosed();
        uint16 gidPlus1 = v.moduleGameIdPlus1(address(this));
        if (gidPlus1 == 0) revert GameClosed();
        if (!v.gameActive(gidPlus1 - 1)) revert GameClosed();
    }
}
