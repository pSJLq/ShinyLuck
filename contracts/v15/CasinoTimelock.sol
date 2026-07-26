// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title CasinoTimelock — the Vault's owner on mainnet
/// @notice Standard OpenZeppelin TimelockController. Making this the owner of
///         CasinoVault means every privileged action (registering a game,
///         changing a game budget, risk limits, scheduling an owner withdraw)
///         must be proposed, wait out the delay, and only then execute. Players
///         can see any change coming, and a stolen owner key cannot instantly
///         drain or attach a malicious game.
///
///         Deployment shape for launch:
///           proposers = [operations multisig]
///           executors = [address(0)]  (anyone may execute once the delay ends)
///           admin     = address(0)     (self-administered, no backdoor)
contract CasinoTimelock is TimelockController {
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) TimelockController(minDelay, proposers, executors, admin) {}
}
