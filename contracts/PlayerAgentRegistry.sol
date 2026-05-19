// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Casino} from "./Casino.sol";
import {AgentVault} from "./AgentVault.sol";

/// @title PlayerAgentRegistry
/// @notice On-chain permissions store for player-agents. Each player registers
///         once, gets a fresh AgentVault, and grants an off-chain relayer the
///         right to place bets on their behalf within stake/game/per-day limits.
///
/// @dev v1 only allows single-decision games (Dice, Slots, Plinko, Roulette).
///      Mines/Crash require multi-step flows and are not supported by the
///      relayer in v1 — but the contract enforces only the explicit allow-list,
///      so a player could authorize them too at their own risk.
contract PlayerAgentRegistry is Ownable, ReentrancyGuard {
    Casino public immutable casino;
    address public relayer;

    struct Permission {
        address player;
        AgentVault vault;
        bytes32 strategyHash;
        uint256 dailyLimit;     // wei
        uint256 totalLimit;     // wei
        uint8 allowedGamesMask; // bit i = 1 ⇒ GameType(i) allowed
        bool active;
        uint256 spentToday;
        uint256 spentTotal;
        uint64 lastResetDay;
    }

    mapping(address => Permission) public permissions;

    event RelayerUpdated(address indexed prev, address indexed next);
    event AgentRegistered(
        address indexed player,
        address indexed vault,
        bytes32 strategyHash,
        uint256 dailyLimit,
        uint256 totalLimit,
        uint8 allowedGamesMask
    );
    event AgentParamsUpdated(
        address indexed player,
        uint256 dailyLimit,
        uint256 totalLimit,
        uint8 allowedGamesMask,
        bytes32 strategyHash
    );
    event AgentPaused(address indexed player);
    event AgentResumed(address indexed player);
    event BetExecuted(
        address indexed player,
        address indexed vault,
        uint8 game,
        uint256 amount,
        uint256 betId
    );

    error AlreadyRegistered();
    error NotRegistered();
    error NotRelayer();
    error AgentInactive();
    error GameNotAllowed();
    error DailyLimitExceeded();
    error TotalLimitExceeded();
    error ZeroAmount();
    error InvalidLimits();

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert NotRelayer();
        _;
    }

    constructor(address _casino, address _relayer) Ownable(msg.sender) {
        casino = Casino(payable(_casino));
        relayer = _relayer;
        emit RelayerUpdated(address(0), _relayer);
    }

    function setRelayer(address next) external onlyOwner {
        emit RelayerUpdated(relayer, next);
        relayer = next;
    }

    /// @notice One-time registration. Deploys a fresh AgentVault for the caller.
    ///         `msg.value` is the setup fee — forwarded straight into the
    ///         casino bankroll as a deposit (no separate treasury contract in
    ///         v1; HM can later schedule a withdraw of profit via the timelock).
    function registerAgent(
        bytes32 strategyHash,
        uint256 dailyLimit,
        uint256 totalLimit,
        uint8 allowedGamesMask
    ) external payable nonReentrant returns (address vaultAddr) {
        if (permissions[msg.sender].player != address(0)) revert AlreadyRegistered();
        if (dailyLimit == 0 || totalLimit == 0 || allowedGamesMask == 0) revert InvalidLimits();
        if (dailyLimit > totalLimit) revert InvalidLimits();

        AgentVault vault = new AgentVault(msg.sender, address(this), address(casino));
        permissions[msg.sender] = Permission({
            player: msg.sender,
            vault: vault,
            strategyHash: strategyHash,
            dailyLimit: dailyLimit,
            totalLimit: totalLimit,
            allowedGamesMask: allowedGamesMask,
            active: true,
            spentToday: 0,
            spentTotal: 0,
            lastResetDay: uint64(block.timestamp / 1 days)
        });
        vaultAddr = address(vault);

        // Forward the setup fee into the casino bankroll. Use the payable
        // `depositBankroll` entrypoint so the deposit shows up in
        // BankrollDeposited events (and account.html / admin.html dashboards).
        if (msg.value > 0) {
            // solhint-disable-next-line avoid-low-level-calls
            (bool ok, ) = address(casino).call{value: msg.value}(
                abi.encodeWithSignature("depositBankroll()")
            );
            if (!ok) {
                // Should never happen — depositBankroll() is payable + no-op
                // beyond the event. If it does, revert to keep accounting tight.
                revert("setup-fee forward failed");
            }
        }
        emit AgentRegistered(msg.sender, vaultAddr, strategyHash, dailyLimit, totalLimit, allowedGamesMask);
    }

    function updateAgentParams(
        uint256 dailyLimit,
        uint256 totalLimit,
        uint8 allowedGamesMask,
        bytes32 strategyHash
    ) external {
        Permission storage p = permissions[msg.sender];
        if (p.player == address(0)) revert NotRegistered();
        if (dailyLimit == 0 || totalLimit == 0 || allowedGamesMask == 0) revert InvalidLimits();
        if (dailyLimit > totalLimit) revert InvalidLimits();
        p.dailyLimit = dailyLimit;
        p.totalLimit = totalLimit;
        p.allowedGamesMask = allowedGamesMask;
        p.strategyHash = strategyHash;
        emit AgentParamsUpdated(msg.sender, dailyLimit, totalLimit, allowedGamesMask, strategyHash);
    }

    function pauseAgent() external {
        Permission storage p = permissions[msg.sender];
        if (p.player == address(0)) revert NotRegistered();
        p.active = false;
        emit AgentPaused(msg.sender);
    }

    function resumeAgent() external {
        Permission storage p = permissions[msg.sender];
        if (p.player == address(0)) revert NotRegistered();
        p.active = true;
        emit AgentResumed(msg.sender);
    }

    /// @notice Relayer-only: place a bet on Casino on behalf of `player` from
    ///         the player's vault, charging stake/game/daily/total limits.
    function executeBet(
        address player,
        uint8 game,
        uint256 amount,
        bytes calldata casinoCalldata
    ) external onlyRelayer nonReentrant returns (uint256 betId) {
        if (amount == 0) revert ZeroAmount();
        Permission storage p = permissions[player];
        if (p.player == address(0)) revert NotRegistered();
        if (!p.active) revert AgentInactive();
        if (((p.allowedGamesMask >> game) & 1) == 0) revert GameNotAllowed();

        uint64 today = uint64(block.timestamp / 1 days);
        if (today != p.lastResetDay) {
            p.spentToday = 0;
            p.lastResetDay = today;
        }
        if (p.spentToday + amount > p.dailyLimit) revert DailyLimitExceeded();
        if (p.spentTotal + amount > p.totalLimit) revert TotalLimitExceeded();
        p.spentToday += amount;
        p.spentTotal += amount;

        bytes memory ret = p.vault.executeBet(amount, casinoCalldata);
        if (ret.length >= 32) {
            betId = abi.decode(ret, (uint256));
        }
        emit BetExecuted(player, address(p.vault), game, amount, betId);
    }

    function getPermission(address player) external view returns (Permission memory) {
        return permissions[player];
    }

    function isGameAllowed(address player, uint8 game) external view returns (bool) {
        return ((permissions[player].allowedGamesMask >> game) & 1) == 1;
    }
}
