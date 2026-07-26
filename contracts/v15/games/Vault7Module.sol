// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SlotBase} from "./SlotBase.sol";
import {Vault7Lib} from "../../lib/Vault7Lib.sol";

/// @title Vault7Module — VAULT.7 slot (5×3, 20 paylines, WILD + SCATTER)
/// @notice Pay-table math ported from Casino v14 (Vault7Lib + the same boost /
///         cap constants), so RTP is unchanged at ~96.4%. The agent-driven
///         Bonus Mode additive boost is NOT ported (agent layer dropped in v15);
///         RTP is tuned by the owner via setPayBoost within hard bounds that
///         keep the house edge positive.
contract Vault7Module is SlotBase {
    uint16 public constant GAME_ID = 2; // SLOTS

    /// @dev Hard cap on a single payout, basis 100 (300× stake).
    uint256 public maxMultX100 = 30000;
    /// @dev Pay-table boost, basis 100. 560 is the value at which RTP was
    ///      measured; the hard cap keeps RTP strictly under 100%.
    uint256 public payBoostX100 = 560;
    uint256 internal constant BOOST_BASE = 560;
    uint256 internal constant BASE_RTP_BPS = 9107;
    uint256 internal constant BOOST_HARDCAP = 608; // ~99% RTP ceiling

    event PayBoostSet(uint256 boostX100, uint16 reportedRtpBps);

    constructor(address _vault, address _loyalty) SlotBase(_vault, _loyalty) {}

    function gameId() external pure returns (uint16) { return GAME_ID; }
    function houseEdgeBps() external pure returns (uint16) { return 0; } // math is the edge

    /// @notice Reported RTP in bps, derived from the live boost.
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

    function _spinResolve(address, uint256 stake, bytes32 randomness, bool freeSpin)
        internal
        view
        override
        returns (uint256 payout, bytes memory resultData)
    {
        uint256 freeMult = freeSpin ? FREE_SPIN_MULT_X100 : 100;
        // edge=0: the pay table IS the edge. Boost is applied after, then capped.
        (uint256 p, uint8[15] memory grid, uint256 lineMult, uint8 scatterCount, uint256 scatterPay) =
            Vault7Lib.resolve(stake, randomness, 0, freeMult);
        payout = (p * payBoostX100) / 100;
        uint256 cap = (stake * maxMultX100) / 100;
        if (payout > cap) payout = cap;
        resultData = abi.encode(grid, lineMult, scatterCount, scatterPay, freeSpin);
    }
}
