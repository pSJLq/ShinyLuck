// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Vault7Lib
/// @notice The on-chain resolver for VAULT.7 — the 5×3 / 20-payline slot
///         with WILD substitution + SCATTER → free-spin trigger. Mirrors the
///         engine in `slots/engine.js` exactly:
///           • 9 concrete symbols + WILD + SCATTER (11 IDs total)
///           • per-reel weighted strips (so wins feel less repetitive)
///           • 5-of-a-kind payouts in the SYMBOLS table
///           • 3+ scatters trigger 10 / 15 / 20 free spins client-side
///             (this contract only counts scatters; free-spin awards are
///             tracked in Casino.playerSlotState, not here)
///
/// @dev Symbol IDs (must match frontend `Vault7` and `SlotsLib` v1):
///           0 = E (low, "E"-hex)
///           1 = D (low)
///           2 = F (low)
///           3 = A (low)
///           4 = COIN (mid)
///           5 = BOLT (mid)
///           6 = CRYS (high)
///           7 = DIAM (high)
///           8 = WILD
///           9 = SCAT
///
///      Per-reel strips are encoded as `bytes` (one byte per cell). Indices
///      into the strip pick the visible 3-cell window for each reel.
library Vault7Lib {
    uint8 internal constant ROWS = 3;
    uint8 internal constant COLS = 5;
    uint8 internal constant LINES = 20;
    uint8 internal constant WILD = 8;
    uint8 internal constant SCAT = 9;

    /// @notice 5-of-a-kind payouts (basis 100). Returned by `payX100(sym, run)`
    ///         scaled down by `run` (3-of-a-kind = pay5/8 etc).
    function payX100(uint8 sym, uint8 run) internal pure returns (uint256) {
        if (run < 3) return 0;
        // 5-of-a-kind base (×stake basis 100), from slots/engine.js SYMBOLS table.
        // pay5 (×100) values: WILD=80000, DIAM=40000, CRYS=20000, BOLT=10000,
        // COIN=6000, A=4000, F=2400, D=1600, E=1200
        // pay4 (×100):        WILD=20000, DIAM=10000, CRYS=5000,  BOLT=2500,
        // COIN=1500, A=1000, F=600,  D=400,  E=300
        // pay3 (×100):        WILD=5000,  DIAM=2500,  CRYS=1200,  BOLT=800,
        // COIN=500,  A=300,  F=200,  D=150,  E=100
        if (sym == 8) {                          // WILD
            if (run == 3) return 5000;
            if (run == 4) return 20000;
            return 80000;
        }
        if (sym == 7) {                          // DIAM
            if (run == 3) return 2500;
            if (run == 4) return 10000;
            return 40000;
        }
        if (sym == 6) {                          // CRYS
            if (run == 3) return 1200;
            if (run == 4) return 5000;
            return 20000;
        }
        if (sym == 5) {                          // BOLT
            if (run == 3) return 800;
            if (run == 4) return 2500;
            return 10000;
        }
        if (sym == 4) {                          // COIN
            if (run == 3) return 500;
            if (run == 4) return 1500;
            return 6000;
        }
        if (sym == 3) {                          // A
            if (run == 3) return 300;
            if (run == 4) return 1000;
            return 4000;
        }
        if (sym == 2) {                          // F
            if (run == 3) return 200;
            if (run == 4) return 600;
            return 2400;
        }
        if (sym == 1) {                          // D
            if (run == 3) return 150;
            if (run == 4) return 400;
            return 1600;
        }
        if (sym == 0) {                          // E
            if (run == 3) return 100;
            if (run == 4) return 300;
            return 1200;
        }
        return 0;
    }

    /// @dev 20 paylines on a 5×3 board. Each line is 5 row indices (∈ [0..2])
    ///      packed into a uint32 (little-endian, 4 bits per reel). Matches
    ///      the `PAYLINES` array in slots/engine.js exactly.
    function payline(uint8 line) internal pure returns (uint8 r0, uint8 r1, uint8 r2, uint8 r3, uint8 r4) {
        uint32 v;
        if (line == 0)       v = 0x11111;          // 1 1 1 1 1
        else if (line == 1)  v = 0x00000;          // 0 0 0 0 0
        else if (line == 2)  v = 0x22222;          // 2 2 2 2 2
        else if (line == 3)  v = 0x01210;          // 0 1 2 1 0
        else if (line == 4)  v = 0x21012;          // 2 1 0 1 2
        else if (line == 5)  v = 0x10001;          // 1 0 0 0 1
        else if (line == 6)  v = 0x12221;          // 1 2 2 2 1
        else if (line == 7)  v = 0x00122;          // 0 0 1 2 2
        else if (line == 8)  v = 0x22100;          // 2 2 1 0 0
        else if (line == 9)  v = 0x10101;          // 1 0 1 0 1
        else if (line == 10) v = 0x12121;          // 1 2 1 2 1
        else if (line == 11) v = 0x01010;          // 0 1 0 1 0
        else if (line == 12) v = 0x21212;          // 2 1 2 1 2
        else if (line == 13) v = 0x01110;          // 0 1 1 1 0
        else if (line == 14) v = 0x21112;          // 2 1 1 1 2
        else if (line == 15) v = 0x11011;          // 1 1 0 1 1
        else if (line == 16) v = 0x11211;          // 1 1 2 1 1
        else if (line == 17) v = 0x02020;          // 0 2 0 2 0
        else if (line == 18) v = 0x20202;          // 2 0 2 0 2
        else                  v = 0x01222;          // 0 1 2 2 2
        r0 = uint8(v & 0xF);
        r1 = uint8((v >> 4) & 0xF);
        r2 = uint8((v >> 8) & 0xF);
        r3 = uint8((v >> 12) & 0xF);
        r4 = uint8((v >> 16) & 0xF);
    }

    /// @dev Returns a symbol for reel `c` at strip index `idx`. The five reel
    ///      strips are stored inline (40 cells each = 200 bytes total).
    ///      Distribution matches slots/engine.js REEL_STRIPS exactly so the
    ///      empirical RTP target ≈ 96% holds without retuning.
    function reelSymbol(uint8 reel, uint8 idx) internal pure returns (uint8) {
        // Each reel has 40 cells. We encode each strip as a function-local
        // 40-element lookup, returning the symbol at `idx mod 40`.
        idx = idx % 40;
        if (reel == 0) {
            // E D F A COIN E F D BOLT A E F COIN D CRYS E F A D BOLT E F D WILD A COIN E D DIAM F A E SCAT D F A E BOLT D F
            uint8[40] memory s = [
                uint8(0),1,2,3,4,0,2,1,5,3,0,2,4,1,6,0,2,3,1,5,
                       0,2,1,8,3,4,0,1,7,2,3,0,9,1,2,3,0,5,1,2
            ];
            return s[idx];
        }
        if (reel == 1) {
            // F D E A BOLT F D E COIN A D F E BOLT A CRYS D E F A BOLT D E COIN F DIAM A D E F WILD A D SCAT E F A D BOLT E
            uint8[40] memory s = [
                uint8(2),1,0,3,5,2,1,0,4,3,1,2,0,5,3,6,1,0,2,3,
                       5,1,0,4,2,7,3,1,0,2,8,3,1,9,0,2,3,1,5,0
            ];
            return s[idx];
        }
        if (reel == 2) {
            // D E F BOLT A D F COIN E A D CRYS F E A BOLT D F WILD E A COIN D F DIAM E A D BOLT F SCAT E A D F CRYS E A BOLT D
            uint8[40] memory s = [
                uint8(1),0,2,5,3,1,2,4,0,3,1,6,2,0,3,5,1,2,8,0,
                       3,4,1,2,7,0,3,1,5,2,9,0,3,1,2,6,0,3,5,1
            ];
            return s[idx];
        }
        if (reel == 3) {
            // F A D E COIN F A D BOLT E F A CRYS D E F A D BOLT E F A WILD D COIN E F A DIAM D E F SCAT A D E F BOLT A D
            uint8[40] memory s = [
                uint8(2),3,1,0,4,2,3,1,5,0,2,3,6,1,0,2,3,1,5,0,
                       2,3,8,1,4,0,2,3,7,1,0,2,9,3,1,0,2,5,3,1
            ];
            return s[idx];
        }
        // reel == 4
        // E F A D BOLT E F A COIN D E F A BOLT D CRYS E F A D BOLT E F COIN A D DIAM E F A WILD D E SCAT F A D E BOLT F
        uint8[40] memory s = [
            uint8(0),2,3,1,5,0,2,3,4,1,0,2,3,5,1,6,0,2,3,1,
                   5,0,2,4,3,1,7,0,2,3,8,1,0,9,2,3,1,0,5,2
        ];
        return s[idx];
    }

    /// @dev Returns the per-line basis-100 multiplier for `grid` on `line`.
    ///      grid layout: grid[col * 3 + row] = symbol ID (so 15 cells total).
    ///      WILD substitutes for any symbol except SCAT.
    function lineMult(uint8[15] memory grid, uint8 line) internal pure returns (uint256) {
        (uint8 r0, uint8 r1, uint8 r2, uint8 r3, uint8 r4) = payline(line);
        uint8[5] memory rows = [r0, r1, r2, r3, r4];
        // anchor = first non-WILD non-SCAT symbol in the line
        uint8 anchor = WILD;
        for (uint8 c = 0; c < 5; c++) {
            uint8 s = grid[c * 3 + rows[c]];
            if (s != WILD && s != SCAT) { anchor = s; break; }
        }
        // all-wild line → pay as WILD 5-of-a-kind
        if (anchor == WILD) {
            uint8 run = 0;
            for (uint8 c = 0; c < 5; c++) {
                uint8 s = grid[c * 3 + rows[c]];
                if (s == WILD) run++; else break;
            }
            return payX100(WILD, run);
        }
        // count run from reel 0 forward
        uint8 runs = 0;
        for (uint8 c = 0; c < 5; c++) {
            uint8 s = grid[c * 3 + rows[c]];
            if (s == anchor || s == WILD) runs++; else break;
        }
        return payX100(anchor, runs);
    }

    /// @dev Scatter payouts (basis 100). 3/4/5 scatters = 2× / 10× / 50× stake.
    function scatterPayX100(uint8 scatters) internal pure returns (uint256) {
        if (scatters < 3) return 0;
        if (scatters == 3) return 200;
        if (scatters == 4) return 1000;
        return 5000;
    }

    /// @notice Resolves a full spin. Returns total payout (after edge applied),
    ///         the 15-cell symbol grid, summed line multiplier, scatter count,
    ///         and scatter payout.
    function resolve(
        uint256 amount,
        bytes32 randomness,
        uint256 edgeBps,
        uint256 freeSpinMultX100 // 100 = 1×, 200 = 2× during free spins
    )
        internal pure
        returns (
            uint256 payout,
            uint8[15] memory grid,
            uint256 lineMultSum,
            uint8 scatterCount,
            uint256 scatterPayX100Out
        )
    {
        uint256 r = uint256(randomness);
        // Each reel picks a starting index into its 40-cell strip from 8 bits
        // of randomness. Total entropy used: 5 × 8 bits = 40 bits.
        // (start+row is computed in uint256 to avoid uint8+uint8 overflow when
        //  start = 255 — reelSymbol takes the final value mod 40 internally.)
        for (uint8 c = 0; c < 5; c++) {
            uint256 start = (r >> (c * 8)) & 0xFF;
            for (uint8 row = 0; row < 3; row++) {
                uint8 sym = reelSymbol(c, uint8((start + row) % 40));
                grid[c * 3 + row] = sym;
                if (sym == SCAT) scatterCount++;
            }
        }
        // Per-line payouts: stake/20 per line × multiplier basis-100.
        uint256 perLine = amount / LINES;
        for (uint8 line = 0; line < LINES; line++) {
            uint256 mult = lineMult(grid, line);
            lineMultSum += mult;
            payout += (perLine * mult) / 100;
        }
        // Free-spin multiplier applies to line wins.
        if (freeSpinMultX100 > 100) {
            payout = (payout * freeSpinMultX100) / 100;
        }
        // Scatter "anywhere" pay — flat × stake, NOT multiplied by free-spin
        // multiplier (matches engine.js behaviour).
        scatterPayX100Out = scatterPayX100(scatterCount);
        if (scatterPayX100Out > 0) {
            payout += (amount * scatterPayX100Out) / 100;
        }
        // House edge factor on the total payout.
        payout = (payout * (10000 - edgeBps)) / 10000;
    }
}
