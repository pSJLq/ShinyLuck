// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IGameModule} from "../IGameModule.sol";

/// @title PlinkoModule — ShinyLuck v15 (single-shot)
/// @notice Ported byte-for-byte from Casino v14 plinko. The ball path is 16
///         binary steps from the randomness; the number of 1-bits picks the
///         landing slot (0..16). Edge is baked into the payout tables. gameId 4
///         matches the v14 GameType numbering the reveal bot branches on.
contract PlinkoModule is IGameModule {
    uint16 public constant GAME_ID = 4; // PLINKO
    uint16 public constant HOUSE_EDGE_BPS = 150; // display only; edge is in tables

    address public immutable vault;

    constructor(address _vault) {
        require(_vault != address(0), "vault=0");
        vault = _vault;
    }

    function gameId() external pure returns (uint16) { return GAME_ID; }
    function houseEdgeBps() external pure returns (uint16) { return HOUSE_EDGE_BPS; }

    /// @dev PLINKO params: (uint8 risk) in {0,1,2}.
    function quote(address, uint256 stake, bytes calldata params)
        external
        pure
        returns (uint256 maxPayout)
    {
        uint8 risk = abi.decode(params, (uint8));
        require(risk <= 2, "risk");
        return (stake * _maxX100(risk)) / 100;
    }

    function resolve(uint256, uint256 stake, bytes32 randomness, bytes calldata params)
        external
        pure
        returns (uint256 payout, bool won, bytes memory resultData)
    {
        uint8 risk = abi.decode(params, (uint8));
        uint256 r = uint256(randomness);
        uint8 slot = 0;
        for (uint8 i; i < 16; i++) if ((r >> i) & 1 == 1) slot++;
        uint32 payX100 = _payoutAt(risk, slot);
        payout = (stake * payX100) / 100;
        won = payout >= stake;
        resultData = abi.encode(uint16(r & 0xFFFF), slot, payX100);
    }

    function _payoutAt(uint8 risk, uint8 slot) internal pure returns (uint32) {
        if (risk == 0) {
            uint32[17] memory t = [
                uint32(1600), 900, 200, 140, 140, 120, 110, 100, 50,
                100, 110, 120, 140, 140, 200, 900, 1600
            ];
            return t[slot];
        }
        if (risk == 1) {
            uint32[17] memory t = [
                uint32(11000), 4100, 1000, 500, 300, 150, 100, 50, 30,
                50, 100, 150, 300, 500, 1000, 4100, 11000
            ];
            return t[slot];
        }
        uint32[17] memory th = [
            uint32(100000), 13000, 2600, 900, 400, 200, 20, 20, 20,
            20, 20, 200, 400, 900, 2600, 13000, 100000
        ];
        return th[slot];
    }

    function _maxX100(uint8 risk) internal pure returns (uint256) {
        if (risk == 0) return 1600;
        if (risk == 1) return 11000;
        return 100000;
    }
}
