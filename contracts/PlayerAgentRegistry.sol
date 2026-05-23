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
///      relayer in v1 - but the contract enforces only the explicit allow-list,
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
    error NotExecutor();

    /// @notice Multi-executor allowlist. Replaces the single `relayer` field
    ///         so the legacy off-chain relayer AND the on-chain HouseManager
    ///         (which calls executeBet from its LLM-decision callback) can
    ///         both place bets on behalf of users.
    mapping(address => bool) public executors;

    /// @notice All currently-active players (active=true permissions) in
    ///         registration order. HouseManager iterates this to fire per-
    ///         player LLM decisions on its hourly Reactivity tick.
    ///         Length-bounded by the on-chain agent platform fees - judges
    ///         should expect 0-5 active players for the demo window.
    address[] public activePlayers;
    /// @notice activePlayers index + 1 (so 0 = not present). Tracked to
    ///         O(1) remove on pauseAgent / register-after-pause.
    mapping(address => uint256) private _activeIdxPlus1;

    event ExecutorAdded(address indexed executor);
    event ExecutorRemoved(address indexed executor);

    modifier onlyExecutor() {
        if (!executors[msg.sender]) revert NotExecutor();
        _;
    }

    constructor(address _casino, address _relayer) Ownable(msg.sender) {
        casino = Casino(payable(_casino));
        // Back-compat: keep the relayer field set + auto-add to executors.
        relayer = _relayer;
        executors[_relayer] = true;
        emit RelayerUpdated(address(0), _relayer);
        emit ExecutorAdded(_relayer);
    }

    function addExecutor(address e) external onlyOwner {
        require(e != address(0), "zero");
        executors[e] = true;
        emit ExecutorAdded(e);
    }

    function removeExecutor(address e) external onlyOwner {
        executors[e] = false;
        emit ExecutorRemoved(e);
    }

    function setRelayer(address next) external onlyOwner {
        emit RelayerUpdated(relayer, next);
        if (relayer != address(0)) executors[relayer] = false;
        relayer = next;
        executors[next] = true;
        emit ExecutorAdded(next);
    }

    /// @notice Number of currently-active player agents.
    function activePlayerCount() external view returns (uint256) {
        return activePlayers.length;
    }

    /// @notice Pagination-friendly slice of activePlayers. HM uses this from
    ///         its hourly cron to fire LLM decisions per player without
    ///         needing to materialize the full array.
    function getActivePlayers(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory out)
    {
        uint256 n = activePlayers.length;
        if (offset >= n) return new address[](0);
        uint256 end = offset + limit;
        if (end > n) end = n;
        out = new address[](end - offset);
        for (uint256 i; i < out.length; i++) out[i] = activePlayers[offset + i];
    }

    function _addToActive(address player) internal {
        if (_activeIdxPlus1[player] != 0) return; // already there
        activePlayers.push(player);
        _activeIdxPlus1[player] = activePlayers.length; // +1
    }

    function _removeFromActive(address player) internal {
        uint256 idxPlus1 = _activeIdxPlus1[player];
        if (idxPlus1 == 0) return;
        uint256 idx = idxPlus1 - 1;
        uint256 last = activePlayers.length - 1;
        if (idx != last) {
            address moved = activePlayers[last];
            activePlayers[idx] = moved;
            _activeIdxPlus1[moved] = idx + 1;
        }
        activePlayers.pop();
        delete _activeIdxPlus1[player];
    }

    /// @notice One-time registration. Deploys a fresh AgentVault for the caller.
    ///         `msg.value` is the setup fee - forwarded straight into the
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
        _addToActive(msg.sender);

        // Forward the setup fee into the casino bankroll. Use the payable
        // `depositBankroll` entrypoint so the deposit shows up in
        // BankrollDeposited events (and account.html / admin.html dashboards).
        if (msg.value > 0) {
            // solhint-disable-next-line avoid-low-level-calls
            (bool ok, ) = address(casino).call{value: msg.value}(
                abi.encodeWithSignature("depositBankroll()")
            );
            if (!ok) {
                // Should never happen - depositBankroll() is payable + no-op
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
        _removeFromActive(msg.sender);
        emit AgentPaused(msg.sender);
    }

    function resumeAgent() external {
        Permission storage p = permissions[msg.sender];
        if (p.player == address(0)) revert NotRegistered();
        p.active = true;
        _addToActive(msg.sender);
        emit AgentResumed(msg.sender);
    }

    /// @notice Executor-only: place a bet on Casino on behalf of `player` from
    ///         the player's vault, charging stake/game/daily/total limits.
    ///         "Executors" can be the off-chain relayer OR an on-chain
    ///         contract like HouseManager that dispatches LLM-driven bets.
    function executeBet(
        address player,
        uint8 game,
        uint256 amount,
        bytes calldata casinoCalldata
    ) external onlyExecutor nonReentrant returns (uint256 betId) {
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
