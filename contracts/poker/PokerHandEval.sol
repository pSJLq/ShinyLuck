// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PokerHandEval
/// @notice On-chain 5-of-7 No-Limit Hold'em hand evaluator. Given a player's 2
///         hole cards + 5 community cards it returns a single comparable score —
///         higher is strictly better, equal means a tie (chop). This keeps
///         showdown ranking fully on-chain and trustless.
///
/// @dev    Card encoding (shared with {IPokerDealer}): a card is 0..51 with
///         rank = card / 4 (0 = deuce … 12 = ace) and suit = card % 4.
///
///         Score layout (24 bits used of a uint32):
///           bits 20-23 : category 0..8 (high card … straight flush)
///           bits 16-19 : primary tiebreak rank
///           bits 12-15 : 2nd tiebreak
///           bits  8-11 : 3rd
///           bits  4-7  : 4th
///           bits  0-3  : 5th
///         Ranks are 0..12 so each nibble holds one. Comparing two scores as
///         plain integers yields the correct poker ordering.
library PokerHandEval {
    uint8 internal constant CAT_STRAIGHT_FLUSH = 8;
    uint8 internal constant CAT_QUADS = 7;
    uint8 internal constant CAT_FULL_HOUSE = 6;
    uint8 internal constant CAT_FLUSH = 5;
    uint8 internal constant CAT_STRAIGHT = 4;
    uint8 internal constant CAT_TRIPS = 3;
    uint8 internal constant CAT_TWO_PAIR = 2;
    uint8 internal constant CAT_PAIR = 1;
    uint8 internal constant CAT_HIGH = 0;

    /// @notice Evaluate the best 5-card hand from 7 cards.
    function eval7(uint8[7] memory cards) internal pure returns (uint32) {
        uint8[13] memory rc; // rank counts
        uint8[4] memory sc; // suit counts
        uint16 rankMask; // bit r set if any card of rank r present
        uint16[4] memory suitRankMask; // per-suit rank bitmask (for flush / straight flush)

        for (uint256 i = 0; i < 7; i++) {
            uint8 c = cards[i];
            uint8 r = c / 4;
            uint8 s = c % 4;
            rc[r] += 1;
            sc[s] += 1;
            rankMask |= uint16(1) << r;
            suitRankMask[s] |= uint16(1) << r;
        }

        // Flush suit (if any).
        int8 flushSuit = -1;
        for (uint8 s = 0; s < 4; s++) {
            if (sc[s] >= 5) {
                flushSuit = int8(s);
                break;
            }
        }

        // Straight flush.
        if (flushSuit >= 0) {
            int8 sfHigh = _straightHigh(suitRankMask[uint8(flushSuit)]);
            if (sfHigh >= 0) return _score(CAT_STRAIGHT_FLUSH, uint8(sfHigh), 0, 0, 0, 0);
        }

        // Classify by rank frequency (scan high → low so first found is highest).
        int8 quad = -1;
        int8 trip1 = -1;
        int8 trip2 = -1;
        int8 pair1 = -1;
        int8 pair2 = -1;
        for (int8 r = 12; r >= 0; r--) {
            uint8 cnt = rc[uint8(r)];
            if (cnt == 4) {
                if (quad < 0) quad = r;
            } else if (cnt == 3) {
                if (trip1 < 0) trip1 = r;
                else if (trip2 < 0) trip2 = r;
            } else if (cnt == 2) {
                if (pair1 < 0) pair1 = r;
                else if (pair2 < 0) pair2 = r;
            }
        }

        // Four of a kind.
        if (quad >= 0) {
            uint8 k = _highestExcept(rankMask, uint8(quad), 255);
            return _score(CAT_QUADS, uint8(quad), k, 0, 0, 0);
        }

        // Full house (trips + best pair, where a second set of trips counts as a pair).
        if (trip1 >= 0 && (pair1 >= 0 || trip2 >= 0)) {
            uint8 pr;
            if (trip2 >= 0 && pair1 >= 0) {
                pr = uint8(pair1) > uint8(trip2) ? uint8(pair1) : uint8(trip2);
            } else if (trip2 >= 0) {
                pr = uint8(trip2);
            } else {
                pr = uint8(pair1);
            }
            return _score(CAT_FULL_HOUSE, uint8(trip1), pr, 0, 0, 0);
        }

        // Flush.
        if (flushSuit >= 0) {
            uint8[5] memory top = _topN(suitRankMask[uint8(flushSuit)], 5, 255, 255);
            return _score(CAT_FLUSH, top[0], top[1], top[2], top[3], top[4]);
        }

        // Straight.
        int8 sHigh = _straightHigh(rankMask);
        if (sHigh >= 0) return _score(CAT_STRAIGHT, uint8(sHigh), 0, 0, 0, 0);

        // Three of a kind.
        if (trip1 >= 0) {
            uint8[5] memory k = _topN(rankMask, 2, uint8(trip1), 255);
            return _score(CAT_TRIPS, uint8(trip1), k[0], k[1], 0, 0);
        }

        // Two pair.
        if (pair1 >= 0 && pair2 >= 0) {
            uint8 k = _highestExcept(rankMask, uint8(pair1), uint8(pair2));
            return _score(CAT_TWO_PAIR, uint8(pair1), uint8(pair2), k, 0, 0);
        }

        // One pair.
        if (pair1 >= 0) {
            uint8[5] memory k = _topN(rankMask, 3, uint8(pair1), 255);
            return _score(CAT_PAIR, uint8(pair1), k[0], k[1], k[2], 0);
        }

        // High card.
        uint8[5] memory hc = _topN(rankMask, 5, 255, 255);
        return _score(CAT_HIGH, hc[0], hc[1], hc[2], hc[3], hc[4]);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /// @dev Highest rank of a 5-in-a-row run present in `mask`, else -1. Handles
    ///      the wheel (A-2-3-4-5), whose high card is the five (rank 3).
    function _straightHigh(uint16 mask) private pure returns (int8) {
        for (int8 top = 12; top >= 4; top--) {
            bool ok = true;
            for (int8 d = 0; d < 5; d++) {
                if ((mask & (uint16(1) << uint8(top - d))) == 0) {
                    ok = false;
                    break;
                }
            }
            if (ok) return top;
        }
        uint16 wheel = (uint16(1) << 12) | (uint16(1) << 0) | (uint16(1) << 1) | (uint16(1) << 2) | (uint16(1) << 3);
        if ((mask & wheel) == wheel) return 3;
        return -1;
    }

    /// @dev Top `count` ranks set in `mask`, skipping ranks `ex1`/`ex2` (255 = none).
    ///      Unused trailing slots are 0.
    function _topN(uint16 mask, uint8 count, uint8 ex1, uint8 ex2) private pure returns (uint8[5] memory out) {
        uint8 filled = 0;
        for (int8 r = 12; r >= 0 && filled < count; r--) {
            uint8 ur = uint8(r);
            if (ur == ex1 || ur == ex2) continue;
            if ((mask & (uint16(1) << ur)) != 0) {
                out[filled] = ur;
                filled++;
            }
        }
    }

    /// @dev Highest rank in `mask` that is not `ex1` or `ex2`.
    function _highestExcept(uint16 mask, uint8 ex1, uint8 ex2) private pure returns (uint8) {
        for (int8 r = 12; r >= 0; r--) {
            uint8 ur = uint8(r);
            if (ur == ex1 || ur == ex2) continue;
            if ((mask & (uint16(1) << ur)) != 0) return ur;
        }
        return 0;
    }

    function _score(uint8 cat, uint8 a, uint8 b, uint8 c, uint8 d, uint8 e) private pure returns (uint32) {
        return (uint32(cat) << 20) | (uint32(a) << 16) | (uint32(b) << 12) | (uint32(c) << 8) | (uint32(d) << 4)
            | uint32(e);
    }
}
