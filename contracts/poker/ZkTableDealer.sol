// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPokerDealer} from "./IPokerDealer.sol";
import {ZkVerify} from "./ZkVerify.sol";

/// @title ZkTableDealer — the LIVE zkShuffle v2 card layer (IPokerDealer).
/// @notice A drop-in dealer for PokerRoom where cards are NOT derived from a
///         seed a dealer knows (v1) but decrypted from a mentally-shuffled,
///         ElGamal-encrypted deck. Every card the room ever reads is proven
///         on-chain: the coordinator posts a card together with the players'
///         decryption shares, and this contract verifies each Chaum–Pedersen
///         share AND that the shares actually decrypt that ciphertext to that
///         card. The coordinator (dealer bot) therefore CANNOT lie about a card
///         and CANNOT learn a hole card before showdown — it only relays the
///         shares players broadcast; the owner completes their own decryption
///         off-chain. This is what makes v2 trustless where v1 was not.
///
///         Per-hand flow (coordinator drives, players' browsers do the crypto):
///           1. prepareDeal  — register each seat's pubkey (Schnorr-verified),
///                             aggregate the table key, commit the shuffled deck
///                             (keccak per in-play ciphertext — cheaper than
///                             storing points; reveals re-supply them and are
///                             checked against the commitment).
///           2. room.startHand → startHand() binds the pre-prepared deal after
///                             verifying the seat set ELEMENT-WISE.
///           3. revealBoardCard — as each street closes, the board card is
///                             decrypted by ALL players' shares (public), verified.
///           4. revealHoleCards — at showdown each live seat's two cards are
///                             decrypted (all shares now public), verified; the
///                             room then ranks them exactly as with v1.
///
///         A per-deal bitmask rejects the same card value being revealed twice
///         (a malicious shuffle that duplicated an in-play card is caught the
///         moment the second copy shows; the hand cancels instead of settling
///         wrong). Full zk shuffle arguments remain the R2 upgrade.
contract ZkTableDealer is IPokerDealer {
    using ZkVerify for ZkVerify.G1Point;

    address public owner;
    address public room; // PokerRoom (only it calls startHand)
    // Coordinator worker keys (the dealer bot posts with several signers so hot
    // tables don't share one nonce queue). Any of them may drive any deal.
    mapping(address => bool) public isCoordinator;

    struct Deal {
        bool exists;
        bool bound; // room.startHand called
        uint8 playerCount;
        uint256 tableId;
        uint64 handId;
        ZkVerify.G1Point aggKey; // Σ pubkeys
        uint8 boardCount;
        bool showdownReady;
        uint8[5] board;
        uint64 revealedMask; // bit per card value 0..51 — dupe guard
    }

    // dealId => deal
    mapping(uint256 => Deal) private _deal;
    mapping(uint256 => uint8[]) private _seats;
    mapping(uint256 => ZkVerify.G1Point[]) private _pubkey; // participant i's pubkey
    // keccak256(A.x, A.y, B.x, B.y) per in-play ciphertext (2k hole + 5 board).
    // 1 slot instead of 4 per card; reveals pass the points in calldata.
    mapping(uint256 => bytes32[]) private _ctHash;
    mapping(uint256 => mapping(uint8 => uint8[2])) private _hole; // seat => [c0,c1]
    mapping(uint256 => mapping(uint8 => bool)) private _holeSet;
    // (tableId,handId) => dealId, so the room's startHand finds the prepared deal
    mapping(uint256 => mapping(uint64 => uint256)) private _byHand;

    event CoordinatorSet(address indexed coordinator, bool enabled);
    event DealPrepared(uint256 indexed dealId, uint256 indexed tableId, uint8 players);
    event HandBound(uint256 indexed dealId, uint256 indexed tableId, uint64 handId);
    event BoardRevealed(uint256 indexed dealId, uint8 count);
    event HoleRevealed(uint256 indexed dealId, uint8 seat);

    error NotOwner();
    error NotRoom();
    error NotCoordinator();
    error BadLength();
    error BadProof();
    error NotPrepared();
    error AlreadyBound();
    error BadCard();
    error BadStreet();
    error BadCiphertext();
    error DupeCard();
    error SeatMismatch();

    constructor(address room_, address coordinator_) {
        owner = msg.sender;
        room = room_;
        isCoordinator[coordinator_] = true;
        emit CoordinatorSet(coordinator_, true);
    }

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyRoom() { if (msg.sender != room) revert NotRoom(); _; }
    modifier onlyCoordinator() { if (!isCoordinator[msg.sender]) revert NotCoordinator(); _; }

    function setRoom(address r) external onlyOwner { room = r; }

    /// @notice Enable/disable a coordinator worker key.
    function setCoordinator(address c, bool on) external onlyOwner {
        isCoordinator[c] = on;
        emit CoordinatorSet(c, on);
    }

    // ---- canonical Fiat–Shamir domains (match zk-bn254.js) -----------------
    function _u(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 n = v; uint256 len;
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

    function _hashCt(ZkVerify.G1Point calldata A, ZkVerify.G1Point calldata B) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(A.x, A.y, B.x, B.y));
    }

    // ---- 1. prepare the deal (coordinator, before room.startHand) -----------
    function prepareDeal(
        uint256 dealId,
        uint256 tableId,
        uint64 handId,
        uint8[] calldata seats,
        ZkVerify.G1Point[] calldata pubkeys,
        ZkVerify.G1Point[] calldata R,
        uint256[] calldata s,
        ZkVerify.G1Point[] calldata deckA,
        ZkVerify.G1Point[] calldata deckB
    ) external onlyCoordinator {
        if (_deal[dealId].exists) revert AlreadyBound();
        uint256 k = pubkeys.length;
        if (k < 2 || k > 10 || seats.length != k || R.length != k || s.length != k) revert BadLength();
        // Only the IN-PLAY ciphertexts are committed/revealed: 2k hole + 5 board.
        // The rest of the 52-card deck is never decrypted (undealt cards stay
        // encrypted forever) — cheaper AND stronger (nothing extra is exposed).
        if (deckA.length != 2 * k + 5 || deckB.length != 2 * k + 5) revert BadLength();

        ZkVerify.G1Point memory agg = _verifyKeys(dealId, pubkeys, R, s);
        for (uint256 i = 0; i < deckA.length; i++) {
            _ctHash[dealId].push(keccak256(abi.encodePacked(deckA[i].x, deckA[i].y, deckB[i].x, deckB[i].y)));
        }
        for (uint256 i = 0; i < k; i++) _seats[dealId].push(seats[i]);

        Deal storage d = _deal[dealId];
        d.exists = true;
        d.playerCount = uint8(k);
        d.tableId = tableId;
        d.handId = handId;
        d.aggKey = agg;
        _byHand[tableId][handId] = dealId;
        emit DealPrepared(dealId, tableId, uint8(k));
    }

    function _verifyKeys(
        uint256 dealId,
        ZkVerify.G1Point[] calldata pubkeys,
        ZkVerify.G1Point[] calldata R,
        uint256[] calldata s
    ) private returns (ZkVerify.G1Point memory agg) {
        agg = ZkVerify.G1Point(0, 0);
        for (uint256 i = 0; i < pubkeys.length; i++) {
            if (!ZkVerify.verifySchnorr(keyDomain(dealId, i), pubkeys[i], R[i], s[i])) revert BadProof();
            _pubkey[dealId].push(pubkeys[i]);
            agg = ZkVerify.add(agg, pubkeys[i]);
        }
    }

    // ---- 2. IPokerDealer.startHand: bind the prepared deal ------------------
    function startHand(uint256 tableId, uint64 handId, uint8 playerCount, uint8[] calldata seats)
        external
        onlyRoom
        returns (uint256 dealId)
    {
        dealId = _byHand[tableId][handId];
        Deal storage d = _deal[dealId];
        if (!d.exists) revert NotPrepared();
        if (d.bound) revert AlreadyBound();
        if (d.playerCount != playerCount || _seats[dealId].length != seats.length) revert BadLength();
        // Element-wise: a seat set that changed between prepareDeal and the
        // room's deal (someone sat down/left in the gap) must NOT bind — the
        // participant→seat mapping would be corrupted and reveals would credit
        // the wrong seats. The coordinator just re-prepares with the fresh set.
        uint8[] storage ps = _seats[dealId];
        for (uint256 i = 0; i < seats.length; i++) {
            if (ps[i] != seats[i]) revert SeatMismatch();
        }
        d.bound = true;
        emit HandBound(dealId, tableId, handId);
    }

    // ---- 3/4. verified card reveal -----------------------------------------
    /// Decrypt ciphertext #cardIdx (supplied in calldata, checked against the
    /// prepareDeal commitment) with the per-participant shares and prove it
    /// equals `claimedCard`. Reverts unless the ciphertext matches the
    /// commitment, every Chaum–Pedersen share is valid AND
    /// B − Σshares == (claimedCard+1)·G.
    function _verifyDecrypt(
        uint256 dealId,
        uint16 cardIdx,
        uint8 claimedCard,
        ZkVerify.G1Point calldata A,
        ZkVerify.G1Point calldata B,
        ZkVerify.G1Point[] calldata d,
        ZkVerify.G1Point[] calldata R1,
        ZkVerify.G1Point[] calldata R2,
        uint256[] calldata s
    ) private view {
        uint256 k = _pubkey[dealId].length;
        if (claimedCard >= 52 || d.length != k || R1.length != k || R2.length != k || s.length != k) revert BadLength();
        if (_hashCt(A, B) != _ctHash[dealId][cardIdx]) revert BadCiphertext();
        ZkVerify.G1Point memory acc = ZkVerify.G1Point(0, 0); // Σ shares
        for (uint256 i = 0; i < k; i++) {
            if (!ZkVerify.verifyChaumPedersen(shareDomain(dealId, cardIdx, i), A, _pubkey[dealId][i], d[i], R1[i], R2[i], s[i])) {
                revert BadProof();
            }
            acc = ZkVerify.add(acc, d[i]);
        }
        // M = B − Σshares ; a card j encodes point (j+1)·G
        ZkVerify.G1Point memory M = ZkVerify.add(B, ZkVerify.neg(acc));
        ZkVerify.G1Point memory expect = ZkVerify.mul(ZkVerify.gen(), uint256(claimedCard) + 1);
        if (!ZkVerify.eq(M, expect)) revert BadCard();
    }

    /// @dev Reject a card value showing up twice in one deal — the cheap,
    ///      always-on tripwire against a duplicated-card shuffle.
    function _markRevealed(Deal storage deal, uint8 card) private {
        uint64 bit = uint64(1) << card;
        if (deal.revealedMask & bit != 0) revert DupeCard();
        deal.revealedMask |= bit;
    }

    /// Reveal one board card (all k players' shares → public card). Board deck
    /// indices follow the deal convention: 2*k + boardSlot. `ct` = [A, B].
    function revealBoardCard(
        uint256 dealId,
        uint8 boardSlot,
        uint8 claimedCard,
        ZkVerify.G1Point[] calldata ct,
        ZkVerify.G1Point[] calldata d,
        ZkVerify.G1Point[] calldata R1,
        ZkVerify.G1Point[] calldata R2,
        uint256[] calldata s
    ) external onlyCoordinator {
        Deal storage deal = _deal[dealId];
        if (!deal.exists) revert NotPrepared();
        if (boardSlot > 4 || boardSlot != deal.boardCount) revert BadStreet();
        if (ct.length != 2) revert BadLength();
        uint16 cardIdx = uint16(2 * deal.playerCount + boardSlot);
        _verifyDecrypt(dealId, cardIdx, claimedCard, ct[0], ct[1], d, R1, R2, s);
        _markRevealed(deal, claimedCard);
        deal.board[boardSlot] = claimedCard;
        deal.boardCount = boardSlot + 1;
        emit BoardRevealed(dealId, deal.boardCount);
    }

    /// Reveal a seat's two hole cards at showdown (now that seat's own share is
    /// also public). deckIdx for participant p: 2*p and 2*p+1.
    /// `cts` = [A0, B0, A1, B1]; proof arrays: [card0 shares..., card1 shares...].
    function revealHoleCards(
        uint256 dealId,
        uint8 participant,
        uint8 seatIndex,
        uint8[2] calldata cards,
        ZkVerify.G1Point[] calldata cts,
        ZkVerify.G1Point[] calldata d,
        ZkVerify.G1Point[] calldata R1,
        ZkVerify.G1Point[] calldata R2,
        uint256[] calldata s
    ) external onlyCoordinator {
        Deal storage deal = _deal[dealId];
        if (!deal.exists) revert NotPrepared();
        uint256 k = deal.playerCount;
        if (cts.length != 4 || d.length != 2 * k) revert BadLength();
        // card 0 uses d[0..k), card 1 uses d[k..2k)
        _verifyDecrypt(dealId, uint16(2 * participant), cards[0], cts[0], cts[1], d[0:k], R1[0:k], R2[0:k], s[0:k]);
        _verifyDecrypt(dealId, uint16(2 * participant + 1), cards[1], cts[2], cts[3], d[k:2 * k], R1[k:2 * k], R2[k:2 * k], s[k:2 * k]);
        _markRevealed(deal, cards[0]);
        _markRevealed(deal, cards[1]);
        _hole[dealId][seatIndex] = cards;
        _holeSet[dealId][seatIndex] = true;
        emit HoleRevealed(dealId, seatIndex);
    }

    /// Mark the hand ready to settle once the board is complete and every seat
    /// the room needs has been revealed (coordinator asserts after posting all;
    /// the room independently re-checks every card it reads is 0..51).
    function markShowdownReady(uint256 dealId) external onlyCoordinator {
        _deal[dealId].showdownReady = true;
    }

    // ---- IPokerDealer views -------------------------------------------------
    function boardRevealedCount(uint256 dealId) external view returns (uint8) {
        return _deal[dealId].boardCount;
    }
    function isShowdownReady(uint256 dealId) external view returns (bool) {
        return _deal[dealId].showdownReady;
    }
    function boardCards(uint256 dealId) external view returns (uint8[5] memory out) {
        Deal storage d = _deal[dealId];
        for (uint8 i = 0; i < 5; i++) out[i] = i < d.boardCount ? d.board[i] : 255;
    }
    function holeCards(uint256 dealId, uint8 seatIndex) external view returns (uint8 c0, uint8 c1) {
        if (!_holeSet[dealId][seatIndex]) return (255, 255);
        uint8[2] memory h = _hole[dealId][seatIndex];
        return (h[0], h[1]);
    }

    // ---- abandonment accusations: legitimacy check + on-chain self-rescue ---
    // PokerRoom's accuse→rescue→penalize flow leans on the dealer for the two
    // things only the dealer knows: (a) whether the accused share is one the
    // protocol LEGITIMATELY needs right now — otherwise a malicious operator
    // could weaponize accusations to force early on-chain disclosure of shares
    // (own hole cards pre-showdown, future board cards) — and (b) whether a
    // posted rescue share is genuine. A verified rescue share is STORED so the
    // coordinator can consume it: self-rescue doesn't just clear the accused,
    // it delivers the withheld share, so a "rescue then keep stalling" griefer
    // is simply forced to hand over the shares one accusation at a time.

    struct RescuedShare {
        bool exists;
        ZkVerify.G1Point d;
        ZkVerify.G1Point R1;
        ZkVerify.G1Point R2;
        uint256 s;
    }
    // dealId => cardIdx => participant => rescued share
    mapping(uint256 => mapping(uint16 => mapping(uint8 => RescuedShare))) private _rescued;

    event ShareRescued(uint256 indexed dealId, uint16 indexed cardIdx, uint8 participant);

    /// @dev The deal's participant index for a room seat, or NOT_FOUND.
    uint256 private constant NOT_FOUND = type(uint256).max;
    function _participantOf(uint256 dealId, uint8 seat) private view returns (uint256) {
        uint8[] storage seats = _seats[dealId];
        for (uint256 i = 0; i < seats.length; i++) {
            if (seats[i] == seat) return i;
        }
        return NOT_FOUND;
    }

    /// @notice Is accusing `seat` of withholding the share for `cardIdx` a
    ///         legitimate protocol demand at `street` (room's STREET_* value)?
    ///         - the accuser must supply the REAL ciphertext (A,B) matching the
    ///           deal's on-chain commitment — the accusation itself then carries
    ///           everything the accused needs to compute the share and
    ///           self-rescue (an accuser can never make rescue impossible by
    ///           withholding the ciphertext);
    ///         - the seat must be a participant of the deal (a dead-blind seat
    ///           that was never dealt in owes no shares);
    ///         - a seat's OWN hole ciphertexts may only be demanded at showdown
    ///           (street 4) — earlier, forcing them on-chain would expose the
    ///           player's live cards to everyone;
    ///         - a board ciphertext may only be demanded once its street closed
    ///           (slot < dueCount(street)) — otherwise sequential accusations
    ///           across all seats would decrypt future board cards early;
    ///         - other players' hole ciphertexts are always fair game (those
    ///           shares are pre-collected before the hand even starts).
    function accusationAllowed(
        uint256 dealId,
        uint8 seat,
        uint16 cardIdx,
        uint8 street,
        ZkVerify.G1Point calldata A,
        ZkVerify.G1Point calldata B
    ) external view returns (bool) {
        Deal storage deal = _deal[dealId];
        if (!deal.exists) return false;
        uint256 k = deal.playerCount;
        if (cardIdx >= 2 * k + 5) return false;
        if (_hashCt(A, B) != _ctHash[dealId][cardIdx]) return false;
        uint256 p = _participantOf(dealId, seat);
        if (p == NOT_FOUND) return false;
        if (cardIdx >= 2 * k) {
            // board slot: due once its street's betting round has closed
            uint16 slot = cardIdx - uint16(2 * k);
            uint16 due = street == 1 ? 3 : street == 2 ? 4 : street >= 3 ? 5 : 0;
            return slot < due;
        }
        uint256 ownerP = cardIdx / 2;
        if (ownerP == p) return street == 4; // own holes: showdown only
        return true; // someone else's holes: pre-collected, nothing new leaks
    }

    /// @notice Verify and RECORD `seat`'s decryption share for `cardIdx` — the
    ///         self-rescue path, called by the room's {proveResponsive}. Returns
    ///         true iff (A,B) matches the deal's ciphertext commitment AND the
    ///         Chaum–Pedersen proof verifies against the seat's per-hand pubkey.
    function rescueShare(
        uint256 dealId,
        uint8 seat,
        uint16 cardIdx,
        ZkVerify.G1Point calldata A,
        ZkVerify.G1Point calldata B,
        ZkVerify.G1Point calldata d,
        ZkVerify.G1Point calldata R1,
        ZkVerify.G1Point calldata R2,
        uint256 s
    ) external onlyRoom returns (bool) {
        Deal storage deal = _deal[dealId];
        if (!deal.exists) return false;
        if (cardIdx >= _ctHash[dealId].length) return false;
        uint256 p = _participantOf(dealId, seat);
        if (p == NOT_FOUND) return false;
        if (_hashCt(A, B) != _ctHash[dealId][cardIdx]) return false;
        if (!ZkVerify.verifyChaumPedersen(shareDomain(dealId, cardIdx, p), A, _pubkey[dealId][p], d, R1, R2, s)) {
            return false;
        }
        _rescued[dealId][cardIdx][uint8(p)] = RescuedShare(true, d, R1, R2, s);
        emit ShareRescued(dealId, cardIdx, uint8(p));
        return true;
    }

    /// @notice A share posted via self-rescue, for the coordinator to consume
    ///         (verified on-chain at rescue time).
    function rescuedShare(uint256 dealId, uint16 cardIdx, uint8 participant)
        external
        view
        returns (bool exists, ZkVerify.G1Point memory d, ZkVerify.G1Point memory R1, ZkVerify.G1Point memory R2, uint256 s)
    {
        RescuedShare storage r = _rescued[dealId][cardIdx][participant];
        return (r.exists, r.d, r.R1, r.R2, r.s);
    }

    // extra views for the coordinator/clients
    function dealIdForHand(uint256 tableId, uint64 handId) external view returns (uint256) {
        return _byHand[tableId][handId];
    }
    function pubkey(uint256 dealId, uint8 i) external view returns (ZkVerify.G1Point memory) {
        return _pubkey[dealId][i];
    }
    /// @notice Commitment of in-play ciphertext #cardIdx — clients verify the
    ///         relayed deck against these before providing any shares.
    function ctHash(uint256 dealId, uint16 cardIdx) external view returns (bytes32) {
        return _ctHash[dealId][cardIdx];
    }
    function dealInfo(uint256 dealId)
        external
        view
        returns (bool exists, bool bound, uint8 playerCount, uint256 tableId, uint64 handId, uint8[] memory seats)
    {
        Deal storage d = _deal[dealId];
        return (d.exists, d.bound, d.playerCount, d.tableId, d.handId, _seats[dealId]);
    }
}
