// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Casino} from "./Casino.sol";

/// @title AgentVault
/// @notice Per-player escrow that funds bets placed by a player-agent. The
///         player owns the assets; the registry may spend up to the player's
///         pre-approved limits via `executeBet`.
contract AgentVault is ReentrancyGuard {
    using Address for address payable;

    address public immutable player;
    address public immutable registry;
    Casino  public immutable casino;

    error NotPlayer();
    error NotRegistry();
    error TransferFailed();
    error InsufficientBalance();

    event Deposited(address indexed from, uint256 amount);
    event WithdrawnToPlayer(uint256 amount);
    event ClaimedFromCasino(uint256 amount);
    event BetExecuted(address indexed casino, uint256 amount, bytes data);

    modifier onlyPlayer() {
        if (msg.sender != player) revert NotPlayer();
        _;
    }
    modifier onlyRegistry() {
        if (msg.sender != registry) revert NotRegistry();
        _;
    }

    constructor(address _player, address _registry, address _casino) {
        player = _player;
        registry = _registry;
        casino = Casino(payable(_casino));
    }

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    function balance() external view returns (uint256) {
        return address(this).balance;
    }

    /// @notice Registry-only: forward `amount` and `casinoCalldata` to Casino.
    /// @dev    The vault becomes the bet's player from Casino's perspective.
    function executeBet(uint256 amount, bytes calldata casinoCalldata)
        external
        onlyRegistry
        nonReentrant
        returns (bytes memory ret)
    {
        if (amount > address(this).balance) revert InsufficientBalance();
        bool ok;
        (ok, ret) = address(casino).call{value: amount}(casinoCalldata);
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
        emit BetExecuted(address(casino), amount, casinoCalldata);
    }

    /// @notice Anyone can pull pending winnings from Casino into the vault.
    function claimFromCasino() external nonReentrant {
        uint256 before = address(this).balance;
        casino.claim();
        uint256 received = address(this).balance - before;
        emit ClaimedFromCasino(received);
    }

    /// @notice Player can withdraw any vault balance back to themselves.
    function withdrawToPlayer(uint256 amount) external onlyPlayer nonReentrant {
        if (amount > address(this).balance) revert InsufficientBalance();
        emit WithdrawnToPlayer(amount);
        payable(player).sendValue(amount);
    }

    function withdrawAll() external onlyPlayer nonReentrant {
        uint256 amt = address(this).balance;
        if (amt == 0) revert InsufficientBalance();
        emit WithdrawnToPlayer(amt);
        payable(player).sendValue(amt);
    }
}
