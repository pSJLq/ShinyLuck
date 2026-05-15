// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ClusterLib
/// @notice On-chain resolver for SUGAR.LAB — the 7×7 cluster-pays slot with
///         tumble cascades. Mirrors `slots/cluster-engine.js`:
///           • 7×7 grid of symbols (8 concrete + WILD + SCATTER)
///           • Cluster = 5+ orthogonally-connected same-symbol cells (WILD
///             substitutes for any concrete symbol)
///           • Pay each cluster, remove its cells, gravity-drop the column,
///             refill from a deterministic PRNG, repeat until no clusters
///           • 3+ scatters in the INITIAL grid → free-spin trigger
///             (10 / 15 / 20 free spins for 4 / 5 / 6+ scatters — same as
///             engine.js: scatters >= 4 base, scatters >= 3 retrigger)
///
///         Free-spin sticky multipliers are tracked outside this library —
///         the Casino contract stores them per-player + applies them as a
///         second-pass multiplier on each cascade step.
///
/// @dev   The resolver is `internal` so Solidity inlines the bytecode into
///        Casino — no separate library deployment + linking step required.
///        Trade-off: ~3 KB of code-size growth on Casino. Acceptable for
///        Somnia testnet (allowUnlimitedContractSize: true).
library ClusterLib {
    uint8 internal constant SIZE = 7;
    uint8 internal constant WILD = 8;
    uint8 internal constant SCAT = 9;
    uint8 internal constant MAX_CASCADE = 12;

    // Symbol IDs (must match cluster-engine.js):
    //   0 = L2, 1 = L1, 2 = M3, 3 = M2, 4 = M1
    //   5 = H3, 6 = H2, 7 = H1, 8 = WILD, 9 = SCAT

    /// @notice Symbol distribution (matches cluster-engine.js C_WEIGHTS).
    ///         Total weight = 93.
    ///         L2=18, L1=18, M3=11, M2=11, M1=11, H3=8, H2=7, H1=6, WILD=2, SCAT=1
    function _pickSymbol(uint256 r) internal pure returns (uint8) {
        uint256 v = r % 93;
        if (v < 18) return 0;      // L2  [0..18)
        if (v < 36) return 1;      // L1  [18..36)
        if (v < 47) return 2;      // M3  [36..47)
        if (v < 58) return 3;      // M2  [47..58)
        if (v < 69) return 4;      // M1  [58..69)
        if (v < 77) return 5;      // H3  [69..77)
        if (v < 84) return 6;      // H2  [77..84)
        if (v < 90) return 7;      // H1  [84..90)
        if (v < 92) return 8;      // WILD [90..92)
        return 9;                  // SCAT [92..93)
    }

    /// @dev Cluster payout (basis 100). For a cluster of size `n` of symbol
    ///      `sym`, returns the payout multiplier × stake × 100. Matches
    ///      cluster-engine.js `symbolPay`.
    function _clusterPayX100(uint8 sym, uint256 n) internal pure returns (uint256) {
        if (n < 5) return 0;
        uint256 pay5;
        uint256 pay15;
        if (sym == 0)      { pay5 = 15;  pay15 = 200;  }   // L2
        else if (sym == 1) { pay5 = 20;  pay15 = 300;  }   // L1
        else if (sym == 2) { pay5 = 30;  pay15 = 600;  }   // M3
        else if (sym == 3) { pay5 = 35;  pay15 = 700;  }   // M2
        else if (sym == 4) { pay5 = 40;  pay15 = 800;  }   // M1
        else if (sym == 5) { pay5 = 50;  pay15 = 1200; }   // H3
        else if (sym == 6) { pay5 = 60;  pay15 = 1500; }   // H2
        else if (sym == 7) { pay5 = 80;  pay15 = 2000; }   // H1
        else if (sym == 8) { pay5 = 50;  pay15 = 2500; }   // WILD
        else return 0;                                      // SCAT never pays as a cluster
        uint256 t = n > 15 ? 100 : ((n - 5) * 100) / 10;    // t in 0..100
        uint256 p = pay5 + ((pay15 - pay5) * t) / 100;
        if (n >= 20) p += (n - 19) * 50;                    // big-cluster bonus
        return p;
    }

    struct ResolveResult {
        uint256 totalPayoutX100;   // sum of cluster payouts, basis-100 of stake
        uint8 scatterCount;        // scatters in the INITIAL grid
        uint8 cascadeDepth;        // chain length
        uint8[49] finalGrid;       // grid after all cascades settle
    }

    /// @notice Resolves a full SUGAR.LAB spin. Returns the total payout factor
    ///         (basis-100 of stake) plus the scatter count and final grid.
    ///
    /// @dev    The resolver does NOT apply sticky multipliers — those live
    ///         in Casino because they're per-player free-spin state.
    function resolve(bytes32 randomness)
        internal pure
        returns (ResolveResult memory out)
    {
        bytes32 r = randomness;
        uint8[49] memory g;
        // Initial fill: one PRNG read per cell from 8 bits each.
        // 49 × 8 = 392 bits — we re-hash to get more entropy if needed.
        bytes32 rr = r;
        uint8 rByte = 0;
        for (uint8 i = 0; i < 49; i++) {
            if (rByte >= 32) { rr = keccak256(abi.encode(rr)); rByte = 0; }
            uint256 chunk = uint256(rr) >> (rByte * 8);
            uint8 sym = _pickSymbol(chunk & 0xFFFFFF);     // 24-bit window for diversity
            g[i] = sym;
            if (sym == SCAT) out.scatterCount++;
            rByte++;
        }
        // Cascade chain: find clusters → pay → tumble → refill → repeat.
        for (uint8 depth = 0; depth < MAX_CASCADE; depth++) {
            (uint256 stepX100, uint8[49] memory toRemove) = _findAndPay(g);
            if (stepX100 == 0) break;
            out.totalPayoutX100 += stepX100;
            out.cascadeDepth = depth + 1;
            // Tumble: drop everything above a removed cell, refill from top.
            rr = keccak256(abi.encode(rr, depth));
            _tumble(g, toRemove, rr);
        }
        out.finalGrid = g;
    }

    /// @dev BFS-find all clusters (≥5 connected, WILD substitutes), pay them,
    ///      and return the removal mask (toRemove[i] == 1 iff cell i was won).
    function _findAndPay(uint8[49] memory g)
        internal pure
        returns (uint256 totalX100, uint8[49] memory toRemove)
    {
        bool[49] memory seen;
        uint8[49] memory stack;
        for (uint8 i = 0; i < 49; i++) {
            if (seen[i]) continue;
            uint8 sym = g[i];
            if (sym == SCAT || sym == WILD || sym >= 10) { seen[i] = true; continue; }
            // BFS from cell i; collect all reachable cells matching sym OR WILD.
            uint8 sp = 0;
            stack[sp++] = i;
            seen[i] = true;
            uint8[49] memory cluster;
            uint8 clen = 0;
            while (sp > 0) {
                sp--;
                uint8 cur = stack[sp];
                cluster[clen++] = cur;
                uint8 row = cur / 7;
                uint8 col = cur % 7;
                // up
                if (row > 0) {
                    uint8 n = cur - 7;
                    if (!seen[n] && (g[n] == sym || g[n] == WILD)) {
                        seen[n] = true; stack[sp++] = n;
                    }
                }
                // down
                if (row < 6) {
                    uint8 n = cur + 7;
                    if (!seen[n] && (g[n] == sym || g[n] == WILD)) {
                        seen[n] = true; stack[sp++] = n;
                    }
                }
                // left
                if (col > 0) {
                    uint8 n = cur - 1;
                    if (!seen[n] && (g[n] == sym || g[n] == WILD)) {
                        seen[n] = true; stack[sp++] = n;
                    }
                }
                // right
                if (col < 6) {
                    uint8 n = cur + 1;
                    if (!seen[n] && (g[n] == sym || g[n] == WILD)) {
                        seen[n] = true; stack[sp++] = n;
                    }
                }
            }
            if (clen >= 5) {
                totalX100 += _clusterPayX100(sym, clen);
                for (uint8 k = 0; k < clen; k++) toRemove[cluster[k]] = 1;
            }
        }
    }

    /// @dev Gravity tumble: per column, compact remaining cells to the bottom,
    ///      fill the top with fresh symbols from `rr`.
    function _tumble(uint8[49] memory g, uint8[49] memory toRemove, bytes32 rr) internal pure {
        for (uint8 col = 0; col < 7; col++) {
            uint8[7] memory keep;
            uint8 klen = 0;
            // Bottom-up sweep — keeps relative order for falling cells.
            for (int8 row = 6; row >= 0; row--) {
                uint8 idx = uint8(row) * 7 + col;
                if (toRemove[idx] == 0) keep[klen++] = g[idx];
            }
            // klen cells survive — they occupy rows [7-klen .. 6].
            // The top (7-klen) rows need fresh symbols.
            for (uint8 k = 0; k < klen; k++) {
                uint8 destRow = 6 - k;
                g[destRow * 7 + col] = keep[k];
            }
            uint8 refillCount = 7 - klen;
            for (uint8 r = 0; r < refillCount; r++) {
                bytes32 cellRng = keccak256(abi.encode(rr, col, r));
                g[r * 7 + col] = _pickSymbol(uint256(cellRng) & 0xFFFFFF);
            }
        }
    }
}
