// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SlotBase} from "./SlotBase.sol";
import {ClusterLib} from "../../lib/ClusterLib.sol";

/// @title ClusterModule — SUGAR.LAB (7×7 cluster pays, tumble cascades)
/// @notice Pay-table math + the Charge Meter ported from Casino v14, so RTP is
///         unchanged at ~96.4%. The agent-driven Bonus Mode boost is NOT ported
///         (agent layer dropped in v15). The Charge Meter is a per-player
///         accumulator with a hidden random threshold; crossing it rolls a
///         weighted cash reward the player claims separately.
contract ClusterModule is SlotBase {
    uint16 public constant GAME_ID = 6; // CLUSTER

    uint256 public maxMultX100 = 30000;
    uint256 public payBoostX100 = 332;
    uint256 internal constant BOOST_BASE = 332;
    uint256 internal constant BASE_RTP_BPS = 9228;
    uint256 internal constant BOOST_HARDCAP = 356; // ~99% RTP ceiling

    // ── Charge Meter ────────────────────────────────────────────────────────
    mapping(address => uint256) public chargeMeter;          // basis 100
    mapping(address => uint256) public chargeMeterThreshold; // basis 100, 18000..30000
    mapping(address => uint256) public chargeMeterReward;    // pending, wei
    mapping(address => uint8)   public chargeMeterCycle;

    event PayBoostSet(uint256 boostX100, uint16 reportedRtpBps);
    event ChargeMeterBumped(address indexed player, uint256 newCharge, uint256 threshold);
    event ChargeMeterTriggered(address indexed player, uint8 rewardId, uint256 amount, uint8 cycle);
    event ChargeRewardClaimed(address indexed player, uint256 amount);

    constructor(address _vault, address _loyalty) SlotBase(_vault, _loyalty) {}

    function gameId() external pure returns (uint16) { return GAME_ID; }
    function houseEdgeBps() external pure returns (uint16) { return 0; } // math is the edge

    function reportedRtpBps() public view returns (uint16) {
        return uint16((BASE_RTP_BPS * payBoostX100) / BOOST_BASE);
    }

    function setPayBoost(uint256 boostX100) external onlyOwner {
        require(boostX100 > 0 && boostX100 <= BOOST_HARDCAP, "boost");
        payBoostX100 = boostX100;
        emit PayBoostSet(boostX100, reportedRtpBps());
    }

    function setMaxMult(uint256 multX100) external onlyOwner {
        require(multX100 >= 100, "mult");
        maxMultX100 = multX100;
    }

    function _maxPayout(uint256 stake) internal view override returns (uint256) {
        return (stake * maxMultX100) / 100;
    }

    function _spinResolve(address player, uint256 stake, bytes32 randomness, bool freeSpin)
        internal
        override
        returns (uint256 payout, bytes memory resultData)
    {
        ClusterLib.ResolveResult memory rr = ClusterLib.resolve(randomness);
        uint256 raw = (stake * rr.totalPayoutX100 * payBoostX100) / 10_000;
        uint256 capped = (stake * maxMultX100) / 100;
        payout = raw > capped ? capped : raw;
        _bumpChargeMeter(player, stake, payout == 0, randomness);
        resultData = abi.encode(rr.finalGrid, rr.totalPayoutX100, rr.scatterCount, rr.cascadeDepth, freeSpin);
    }

    // ── Charge Meter (v14 parity) ───────────────────────────────────────────

    function _initChargeThreshold(address player, bytes32 r) internal {
        if (chargeMeterThreshold[player] == 0) {
            chargeMeterThreshold[player] =
                18000 + (uint256(keccak256(abi.encode(r, player, "th0"))) % 12001);
        }
    }

    function _bumpChargeMeter(address player, uint256 stake, bool missed, bytes32 randomness) internal {
        if (player == address(0)) return;
        _initChargeThreshold(player, randomness);
        uint256 base = 220 + (stake * 350) / (50 * 1e18);
        if (base > 600) base = 600;
        uint256 miss = missed ? 120 : 0;
        uint256 noise = uint256(keccak256(abi.encode(randomness, player, "noise"))) % 150;
        uint256 nc = chargeMeter[player] + base + miss + noise;

        if (nc >= chargeMeterThreshold[player]) {
            uint256 roll = uint256(keccak256(abi.encode(randomness, player, "reward"))) % 98;
            uint8 rewardId;
            uint256 rewardAmount;
            uint256 stakeBasis = stake == 0 ? 1e15 : stake;
            if (roll < 38)      { rewardId = 1; rewardAmount = stakeBasis * 3; }
            else if (roll < 63) { rewardId = 2; rewardAmount = stakeBasis * 8; }
            else if (roll < 75) { rewardId = 3; rewardAmount = stakeBasis * 18; }
            else if (roll < 83) { rewardId = 4; rewardAmount = stakeBasis * 3; }
            else if (roll < 89) { rewardId = 5; rewardAmount = stakeBasis * 12; }
            else if (roll < 93) { rewardId = 6; rewardAmount = stakeBasis * 45; }
            else if (roll < 97) { rewardId = 7; rewardAmount = stakeBasis * 5; }
            else                { rewardId = 8; rewardAmount = stakeBasis * 120; }

            // Cap at 1% of the pool so a jackpot on a dust stake can't run away.
            uint256 cap = vault.freeBankroll() / 100;
            if (rewardAmount > cap) rewardAmount = cap;

            chargeMeterReward[player] += rewardAmount;
            chargeMeterCycle[player] += 1;
            chargeMeter[player] = 0;
            chargeMeterThreshold[player] =
                18000 + (uint256(keccak256(abi.encode(randomness, player, "th"))) % 12001);
            emit ChargeMeterTriggered(player, rewardId, rewardAmount, chargeMeterCycle[player]);
        } else {
            chargeMeter[player] = nc;
            emit ChargeMeterBumped(player, nc, chargeMeterThreshold[player]);
        }
    }

    /// @notice Pull the accrued Charge Meter reward. Credited through the Vault,
    ///         so it is budget- and solvency-clamped like any other payout.
    function claimChargeReward() external nonReentrant {
        uint256 amt = chargeMeterReward[msg.sender];
        if (amt == 0) revert InvalidBet("no charge reward");
        chargeMeterReward[msg.sender] = 0;
        uint256 credited = vault.creditFromModule(msg.sender, 0, amt);
        emit ChargeRewardClaimed(msg.sender, credited);
    }

    function getChargeMeter(address player)
        external
        view
        returns (uint256 current, uint256 threshold, uint256 pendingReward, uint8 cycle)
    {
        return (chargeMeter[player], chargeMeterThreshold[player], chargeMeterReward[player], chargeMeterCycle[player]);
    }
}
