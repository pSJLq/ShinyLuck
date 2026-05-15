// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Casino} from "./Casino.sol";

/// @title HouseManager
/// @notice Authority gate between the off-chain Somnia House Manager Agent
///         and the Casino. The HM Agent (operating off-chain via the Somnia
///         Agent Platform) holds a hot key that signs txs to this contract;
///         this contract is the `houseManager` address registered in Casino.
///
///         Owner can rotate the agent key in case it's compromised.
contract HouseManager is Ownable {
    Casino public immutable casino;
    address public hmAgent;

    event HmAgentUpdated(address indexed prev, address indexed next);
    event ActionForwarded(string action, bytes data);

    error NotHmAgent();

    modifier onlyAgent() {
        if (msg.sender != hmAgent) revert NotHmAgent();
        _;
    }

    constructor(address casino_, address hmAgent_) Ownable(msg.sender) {
        casino = Casino(payable(casino_));
        hmAgent = hmAgent_;
        emit HmAgentUpdated(address(0), hmAgent_);
    }

    function setHmAgent(address next) external onlyOwner {
        emit HmAgentUpdated(hmAgent, next);
        hmAgent = next;
    }

    // ---------------------------------------------------------------------
    // Forwarded admin actions
    // ---------------------------------------------------------------------

    function setGameMaxBet(Casino.GameType game, uint256 amount) external onlyAgent {
        casino.setGameMaxBet(game, amount);
        emit ActionForwarded("setGameMaxBet", abi.encode(game, amount));
    }

    function pauseGame(Casino.GameType game) external onlyAgent {
        casino.pauseGame(game);
        emit ActionForwarded("pauseGame", abi.encode(game));
    }

    function unpauseGame(Casino.GameType game) external onlyAgent {
        casino.unpauseGame(game);
        emit ActionForwarded("unpauseGame", abi.encode(game));
    }

    function activateBonusMode(uint256 durationMinutes, string calldata reasoning)
        external
        onlyAgent
    {
        casino.activateBonusMode(durationMinutes, reasoning);
        emit ActionForwarded("activateBonusMode", abi.encode(durationMinutes, reasoning));
    }

    function recordReasoning(string calldata thought) external onlyAgent {
        casino.recordReasoning(thought);
        emit ActionForwarded("recordReasoning", abi.encode(thought));
    }

    function provisionSeedHashes(bytes32[] calldata hashes) external onlyAgent {
        casino.provisionSeedHashes(hashes);
        emit ActionForwarded("provisionSeedHashes", abi.encode(hashes.length));
    }

    function triggerThemeRotation(string calldata name, string[5] calldata symbols)
        external
        onlyAgent
    {
        casino.triggerThemeRotation(name, symbols);
        emit ActionForwarded("triggerThemeRotation", abi.encode(name));
    }

    // ---------------------------------------------------------------------
    // Convenience: bulk health-check view of casino state
    // ---------------------------------------------------------------------

    struct CasinoSnapshot {
        uint256 freeBankroll;
        uint256 lockedReserve;
        uint256 totalPendingWithdrawals;
        uint256 totalBets;
        uint256 seedAvailable;
        uint256 bonusModeUntil;
        bool[6]  paused;
        uint256[6] maxBets;
    }

    function snapshot() external view returns (CasinoSnapshot memory s) {
        s.freeBankroll = casino.freeBankroll();
        s.lockedReserve = casino.lockedReserve();
        s.totalPendingWithdrawals = casino.totalPendingWithdrawals();
        s.totalBets = casino.totalBets();
        (uint256 total, uint256 consumed,) = casino.seedPoolStatus();
        s.seedAvailable = total - consumed;
        s.bonusModeUntil = casino.bonusModeUntil();
        for (uint8 i; i < 6; i++) {
            s.paused[i] = casino.gamePaused(Casino.GameType(i));
            s.maxBets[i] = casino.gameMaxBet(Casino.GameType(i));
        }
    }
}
