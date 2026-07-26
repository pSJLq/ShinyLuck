// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title SlotLoyalty — free-spin counters shared by every slot module
/// @notice In v14 the loyalty counters were GLOBAL across VAULT.7 + SUGAR.LAB
///         (any slot spin counts toward the same 150-spin bonus). v15 splits
///         those games into separate modules, so the shared state lives here
///         and both modules are authorized to write it. Bookkeeping only — this
///         contract never holds or moves funds.
contract SlotLoyalty is Ownable {
    uint256 public constant SPINS_PER_BONUS = 150;
    uint256 public constant FREE_SPINS_PER_BONUS = 5;
    /// @dev Floor stake that progresses the counter — stops a dust-spam attack
    ///      from farming free spins for free.
    uint256 public constant LOYALTY_MIN_STAKE = 0.001 ether;

    struct State {
        uint64 totalSpins;
        uint64 freeSpinsEarned;
        uint64 freeSpinsUsed;
    }
    mapping(address => State) public playerState;
    mapping(address => bool) public authorized; // slot modules

    event ModuleAuthorized(address indexed module, bool allowed);
    event FreeSpinsEarned(address indexed player, uint64 totalSpins, uint64 freeSpinsEarned);
    event FreeSpinConsumed(address indexed player, address indexed module);

    error NotAuthorized();
    error NoFreeSpins();

    modifier onlyAuthorized() {
        if (!authorized[msg.sender]) revert NotAuthorized();
        _;
    }

    constructor() Ownable(msg.sender) {}

    function setModule(address module, bool allowed) external onlyOwner {
        authorized[module] = allowed;
        emit ModuleAuthorized(module, allowed);
    }

    function available(address p) public view returns (uint256) {
        State memory s = playerState[p];
        return s.freeSpinsEarned > s.freeSpinsUsed ? s.freeSpinsEarned - s.freeSpinsUsed : 0;
    }

    /// @notice Count a paid spin toward the loyalty bonus.
    function recordSpin(address player, uint256 stake) external onlyAuthorized {
        if (stake < LOYALTY_MIN_STAKE) return;
        State storage s = playerState[player];
        s.totalSpins += 1;
        if (s.totalSpins % SPINS_PER_BONUS == 0) {
            s.freeSpinsEarned += uint64(FREE_SPINS_PER_BONUS);
            emit FreeSpinsEarned(player, s.totalSpins, s.freeSpinsEarned);
        }
    }

    function consumeFreeSpin(address player) external onlyAuthorized {
        if (available(player) == 0) revert NoFreeSpins();
        playerState[player].freeSpinsUsed += 1;
        emit FreeSpinConsumed(player, msg.sender);
    }

    /// @notice Give a consumed free spin back (used when a free spin's bet is
    ///         refunded — the player never paid a stake to return).
    function restoreFreeSpin(address player) external onlyAuthorized {
        State storage s = playerState[player];
        if (s.freeSpinsUsed > 0) s.freeSpinsUsed -= 1;
    }

    function getPlayerSlotState(address p)
        external
        view
        returns (uint64 total, uint64 earned, uint64 used, uint256 toNext)
    {
        State memory s = playerState[p];
        uint256 rem = SPINS_PER_BONUS - (uint256(s.totalSpins) % SPINS_PER_BONUS);
        return (s.totalSpins, s.freeSpinsEarned, s.freeSpinsUsed, rem);
    }
}
