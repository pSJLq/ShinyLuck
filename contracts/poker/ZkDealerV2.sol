// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ZkVerify} from "./ZkVerify.sol";

/// @title ZkDealerV2 — on-chain mental-poker card layer for ShinyPoker (v2, EXPERIMENTAL).
/// @notice The trustless successor to CommitRevealDealer. The deck is encrypted
///         under the TABLE's aggregate key; every player shuffles it themselves;
///         a hole card is decrypted only by its owner. This contract verifies
///         the cryptography ON-CHAIN, during the hand:
///           • openDeal   — verifies each player's Schnorr key proof, aggregates
///                          the table key. A rogue key can't join.
///           • setDeck    — records the fully-shuffled encrypted deck.
///           • revealShare — verifies each Chaum–Pedersen decryption share; a
///                          forged share reverts on-chain, so no one can feed a
///                          player a wrong card or peek at another's.
///           • checkRemask — the shuffle-audit primitive: anyone can re-derive a
///                          shuffle stage on-chain and prove a cheat.
///         Proofs come from frontend/poker/zk-bn254.js unchanged (same BN254
///         curve, same Fiat–Shamir encoding). NOT yet wired to escrow/slashing
///         or to live tables — see docs/ZKSHUFFLE-V2-SPEC.md.
contract ZkDealerV2 {
    using ZkVerify for ZkVerify.G1Point;

    struct Deal {
        uint8 k; // players
        bool open;
        bool deckSet;
        ZkVerify.G1Point X; // aggregate table key = Σ seat pubkeys
    }

    mapping(uint256 => Deal) private _deal;
    mapping(uint256 => ZkVerify.G1Point[]) private _seatKey; // per-seat pubkey X_i
    mapping(uint256 => ZkVerify.G1Point[]) private _deckA; // 52 ciphertext A components
    mapping(uint256 => ZkVerify.G1Point[]) private _deckB; // 52 ciphertext B components
    // cardIdx => sharerSeat => decryption share d (verified before storage)
    mapping(uint256 => mapping(uint16 => mapping(uint8 => ZkVerify.G1Point))) private _share;

    event DealOpened(uint256 indexed dealId, uint8 players, uint256 keyX, uint256 keyY);
    event DeckSet(uint256 indexed dealId);
    event ShareRevealed(uint256 indexed dealId, uint16 indexed cardIdx, uint8 indexed sharerSeat);

    error AlreadyOpen();
    error NotOpen();
    error BadLength();
    error BadProof();
    error BadRange();
    error DeckAlready();
    error DeckMissing();

    // ---- canonical Fiat–Shamir domains (must match zk-bn254 test/lab) -------
    /// Minimal uint→decimal (avoids an OZ dep that needs a Cancun opcode).
    function _u(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 n = v;
        uint256 len;
        while (n != 0) { len++; n /= 10; }
        bytes memory b = new bytes(len);
        while (v != 0) { b[--len] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(b);
    }

    function keyDomain(uint256 dealId, uint256 seat) public pure returns (string memory) {
        return string.concat("SPZK:", _u(dealId), ":key:", _u(seat));
    }

    function shareDomain(uint256 dealId, uint256 cardIdx, uint256 seat) public pure returns (string memory) {
        return string.concat("SPZK:", _u(dealId), ":share:", _u(cardIdx), ":", _u(seat));
    }

    // ---- lifecycle ----------------------------------------------------------

    /// Open a deal: verify every player's Schnorr proof-of-knowledge for their
    /// pubkey (blocks rogue-key attacks), then aggregate the table key on-chain.
    function openDeal(
        uint256 dealId,
        ZkVerify.G1Point[] calldata pubkeys,
        ZkVerify.G1Point[] calldata R,
        uint256[] calldata s
    ) external {
        if (_deal[dealId].open) revert AlreadyOpen();
        uint256 k = pubkeys.length;
        if (k < 2 || k > 10 || R.length != k || s.length != k) revert BadLength();

        ZkVerify.G1Point memory X = ZkVerify.G1Point(0, 0);
        for (uint256 i = 0; i < k; i++) {
            if (!ZkVerify.verifySchnorr(keyDomain(dealId, i), pubkeys[i], R[i], s[i])) revert BadProof();
            _seatKey[dealId].push(pubkeys[i]);
            X = ZkVerify.add(X, pubkeys[i]);
        }
        _deal[dealId] = Deal({k: uint8(k), open: true, deckSet: false, X: X});
        emit DealOpened(dealId, uint8(k), X.x, X.y);
    }

    /// Record the fully-shuffled encrypted deck (52 ElGamal ciphertexts). The
    /// shuffle proofs themselves are enforced by the audit primitive below.
    function setDeck(uint256 dealId, ZkVerify.G1Point[] calldata A, ZkVerify.G1Point[] calldata B) external {
        Deal storage d = _deal[dealId];
        if (!d.open) revert NotOpen();
        if (d.deckSet) revert DeckAlready();
        if (A.length != 52 || B.length != 52) revert BadLength();
        for (uint256 i = 0; i < 52; i++) {
            _deckA[dealId].push(A[i]);
            _deckB[dealId].push(B[i]);
        }
        d.deckSet = true;
        emit DeckSet(dealId);
    }

    /// Submit a decryption share for card `cardIdx` from seat `sharerSeat`,
    /// verified on-chain against the stored ciphertext and that seat's pubkey.
    /// A forged share reverts — the whole point of v2.
    function revealShare(
        uint256 dealId,
        uint16 cardIdx,
        uint8 sharerSeat,
        ZkVerify.G1Point calldata dShare,
        ZkVerify.G1Point calldata R1,
        ZkVerify.G1Point calldata R2,
        uint256 s
    ) external {
        Deal storage d = _deal[dealId];
        if (!d.deckSet) revert DeckMissing();
        if (cardIdx >= 52 || sharerSeat >= d.k) revert BadRange();
        ZkVerify.G1Point memory A = _deckA[dealId][cardIdx];
        ZkVerify.G1Point memory X = _seatKey[dealId][sharerSeat];
        if (!ZkVerify.verifyChaumPedersen(shareDomain(dealId, cardIdx, sharerSeat), A, X, dShare, R1, R2, s)) {
            revert BadProof();
        }
        _share[dealId][cardIdx][sharerSeat] = dShare;
        emit ShareRevealed(dealId, cardIdx, sharerSeat);
    }

    // ---- shuffle audit primitive (dispute) ---------------------------------

    /// Re-derive one shuffle stage on-chain: does remask(prev[perm[k]], rho[k])
    /// equal the claimed output for every card? A cheating shuffler is caught
    /// here deterministically. `X` is the table key (from getDeal).
    function checkStage(
        ZkVerify.G1Point calldata X,
        ZkVerify.G1Point[] calldata prevA,
        ZkVerify.G1Point[] calldata prevB,
        uint16[] calldata perm,
        uint256[] calldata rho,
        ZkVerify.G1Point[] calldata outA,
        ZkVerify.G1Point[] calldata outB
    ) external view returns (bool ok, uint256 firstBadCard) {
        uint256 n = perm.length;
        if (prevA.length != n || prevB.length != n || rho.length != n || outA.length != n || outB.length != n) {
            return (false, type(uint256).max);
        }
        for (uint256 i = 0; i < n; i++) {
            uint256 from = perm[i];
            (ZkVerify.G1Point memory eA, ZkVerify.G1Point memory eB) =
                ZkVerify.remask(prevA[from], prevB[from], X, rho[i]);
            if (!ZkVerify.eq(eA, outA[i]) || !ZkVerify.eq(eB, outB[i])) return (false, i);
        }
        return (true, 0);
    }

    // ---- read-only verifiers (eth_call: prove a proof verifies on-chain with
    //      no gas and no wallet — the zk-lab uses these live) ----------------
    function verifyKeygenProof(string calldata domain, ZkVerify.G1Point calldata X, ZkVerify.G1Point calldata R, uint256 s)
        external
        view
        returns (bool)
    {
        return ZkVerify.verifySchnorr(domain, X, R, s);
    }

    function verifyShareProof(
        string calldata domain,
        ZkVerify.G1Point calldata A,
        ZkVerify.G1Point calldata X,
        ZkVerify.G1Point calldata d,
        ZkVerify.G1Point calldata R1,
        ZkVerify.G1Point calldata R2,
        uint256 s
    ) external view returns (bool) {
        return ZkVerify.verifyChaumPedersen(domain, A, X, d, R1, R2, s);
    }

    // ---- views --------------------------------------------------------------
    function getDeal(uint256 dealId) external view returns (uint8 k, bool open, bool deckSet, ZkVerify.G1Point memory X) {
        Deal storage d = _deal[dealId];
        return (d.k, d.open, d.deckSet, d.X);
    }

    function seatKey(uint256 dealId, uint8 seat) external view returns (ZkVerify.G1Point memory) {
        return _seatKey[dealId][seat];
    }

    function ciphertext(uint256 dealId, uint16 cardIdx)
        external
        view
        returns (ZkVerify.G1Point memory A, ZkVerify.G1Point memory B)
    {
        return (_deckA[dealId][cardIdx], _deckB[dealId][cardIdx]);
    }

    function share(uint256 dealId, uint16 cardIdx, uint8 sharerSeat)
        external
        view
        returns (ZkVerify.G1Point memory)
    {
        return _share[dealId][cardIdx][sharerSeat];
    }
}
