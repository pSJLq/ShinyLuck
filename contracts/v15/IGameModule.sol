// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IGameBase — the minimum every ShinyLuck v15 game declares.
/// @notice Just enough for the Vault registry to bind a module to a gameId.
///         Single-shot games extend this with IGameModule; module-entry games
///         (Mines/Crash/Roulette) implement only this + their own functions.
interface IGameBase {
    function gameId() external view returns (uint16);
}

/// @title IGameModule — the plug interface for SINGLE-SHOT games.
/// @notice A single-shot module is a PASSIVE calculator: the CasinoVault calls
///         into it, never the other way around. It holds no funds and cannot
///         move money — it only validates params and returns numbers the Vault
///         then bounds by its own risk limits. Registering a game grants ZERO
///         ability to initiate a transfer.
interface IGameModule is IGameBase {
    /// @notice House edge in basis points, for display/telemetry only.
    function houseEdgeBps() external view returns (uint16);

    /// @notice Validate `params` and return the maximum payout this stake could
    ///         win. Pure logic, no state change, no value. Called by the Vault
    ///         at placement so it can enforce exposure limits. MUST revert on
    ///         invalid params.
    function quote(address player, uint256 stake, bytes calldata params)
        external
        view
        returns (uint256 maxPayout);

    /// @notice Compute the outcome from the revealed randomness. Called by the
    ///         Vault at settlement. Returns gross payout (0 = lost), a display
    ///         `won` flag, and opaque result data. MUST NOT move money; the
    ///         Vault clamps the returned payout before crediting.
    function resolve(
        uint256 betId,
        uint256 stake,
        bytes32 randomness,
        bytes calldata params
    ) external returns (uint256 payout, bool won, bytes memory resultData);
}

/// @title ICasinoVaultModule — the narrow money/seed primitives the Vault
///        exposes to REGISTERED modules only (for module-entry games: Mines,
///        Crash, Roulette). Every primitive re-checks the caller is a
///        registered module and applies the same budget/solvency/exposure
///        clamps as the single-shot path. A module can still never move more
///        than the Vault authorizes.
interface ICasinoVaultModule {
    /// @notice Reserve the next commit-reveal seed. Returns its index + hash.
    function reserveSeed() external returns (uint256 idx, bytes32 hash);

    /// @notice Reveal a reserved seed (verifies it against the committed hash).
    function revealSeed(uint256 idx, bytes32 serverSeed) external returns (bytes32 seed);

    /// @notice Escrow a player's stake (sent as msg.value) into the Vault,
    ///         enforcing the stake caps + exposure cap for this game.
    function escrowStake(address player, uint256 maxPayout) external payable;

    /// @notice Credit a player a payout, clamped by the game's budget and pool
    ///         solvency. Returns the amount actually credited.
    function creditFromModule(address player, uint256 betId, uint256 amount)
        external
        returns (uint256 credited);

    /// @notice Return a player's stake (refund / fraud compensation). Not
    ///         budget-clamped — it only ever gives back what was staked.
    function refundFromModule(address player, uint256 amount) external;

    /// @notice Funds available to back bets (balance minus owed winnings).
    function freeBankroll() external view returns (uint256);

    /// @notice `gameId + 1` for a registered module, 0 for anything else.
    ///         Asking by address (not a hardcoded id) means a module that has
    ///         been de-registered also learns it must stop.
    function moduleGameIdPlus1(address module) external view returns (uint16);

    /// @notice Registry flag: is this game accepting new bets?
    /// @dev    The Vault checks this itself on `placeBet`, but a module-entry
    ///         game never goes through `placeBet` — so unless the module asks,
    ///         `setGameActive(id,false)` does not stop it. Every module-entry
    ///         game MUST gate its own entry point on this.
    function gameActive(uint16 id) external view returns (bool);

    /// @notice Global kill switch (`pauseAll`). Same reasoning as `gameActive`:
    ///         the Vault's own `whenNotPaused` never runs for module entry.
    function paused() external view returns (bool);
}
