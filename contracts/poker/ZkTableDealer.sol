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
///                             aggregate the table key, store the shuffled deck.
///           2. room.startHand → startHand() binds the pre-prepared deal.
///           3. revealBoardCard — as each street closes, the board card is
///                             decrypted by ALL players' shares (public), verified.
///           4. revealHoleCards — at showdown each live seat's two cards are
///                             decrypted (all shares now public), verified; the
///                             room then ranks them exactly as with v1.
contract ZkTableDealer is IPokerDealer {
    using ZkVerify for ZkVerify.G1Point;

    address public owner;
    address public room; // PokerRoom (only it calls startHand)
    address public coordinator; // dealer bot (posts prepareDeal + reveals)

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
    }

    // dealId => deal
    mapping(uint256 => Deal) private _deal;
    mapping(uint256 => uint8[]) private _seats;
    mapping(uint256 => ZkVerify.G1Point[]) private _pubkey; // participant i's pubkey
    mapping(uint256 => ZkVerify.G1Point[]) private _deckA; // 52 ciphertext A
    mapping(uint256 => ZkVerify.G1Point[]) private _deckB; // 52 ciphertext B
    mapping(uint256 => mapping(uint8 => uint8[2])) private _hole; // seat => [c0,c1]
    mapping(uint256 => mapping(uint8 => bool)) private _holeSet;
    // (tableId,handId) => dealId, so the room's startHand finds the prepared deal
    mapping(uint256 => mapping(uint64 => uint256)) private _byHand;

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

    constructor(address room_, address coordinator_) {
        owner = msg.sender;
        room = room_;
        coordinator = coordinator_;
    }

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyRoom() { if (msg.sender != room) revert NotRoom(); _; }
    modifier onlyCoordinator() { if (msg.sender != coordinator) revert NotCoordinator(); _; }

    function setRoom(address r) external onlyOwner { room = r; }
    function setCoordinator(address c) external onlyOwner { coordinator = c; }

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
        // Only the IN-PLAY ciphertexts are stored/revealed: 2k hole + 5 board.
        // The rest of the 52-card deck is never decrypted (undealt cards stay
        // encrypted forever) — cheaper AND stronger (nothing extra is exposed).
        if (deckA.length != 2 * k + 5 || deckB.length != 2 * k + 5) revert BadLength();

        ZkVerify.G1Point memory agg = _verifyKeys(dealId, pubkeys, R, s);
        _storeDeck(dealId, deckA, deckB);
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

    function _storeDeck(uint256 dealId, ZkVerify.G1Point[] calldata deckA, ZkVerify.G1Point[] calldata deckB) private {
        for (uint256 i = 0; i < deckA.length; i++) { _deckA[dealId].push(deckA[i]); _deckB[dealId].push(deckB[i]); }
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
        d.bound = true;
        emit HandBound(dealId, tableId, handId);
    }

    // ---- 3/4. verified card reveal -----------------------------------------
    /// Decrypt deck ciphertext #cardIdx with the supplied per-participant shares
    /// and prove it equals `claimedCard`. Reverts unless every Chaum–Pedersen
    /// share is valid AND B − Σshares == (claimedCard+1)·G. Returns nothing on
    /// success (state set by callers below).
    function _verifyDecrypt(
        uint256 dealId,
        uint16 cardIdx,
        uint8 claimedCard,
        ZkVerify.G1Point[] calldata d,
        ZkVerify.G1Point[] calldata R1,
        ZkVerify.G1Point[] calldata R2,
        uint256[] calldata s
    ) private view {
        uint256 k = _pubkey[dealId].length;
        if (claimedCard >= 52 || d.length != k || R1.length != k || R2.length != k || s.length != k) revert BadLength();
        ZkVerify.G1Point memory A = _deckA[dealId][cardIdx];
        ZkVerify.G1Point memory acc = ZkVerify.G1Point(0, 0); // Σ shares
        for (uint256 i = 0; i < k; i++) {
            if (!ZkVerify.verifyChaumPedersen(shareDomain(dealId, cardIdx, i), A, _pubkey[dealId][i], d[i], R1[i], R2[i], s[i])) {
                revert BadProof();
            }
            acc = ZkVerify.add(acc, d[i]);
        }
        // M = B − Σshares ; a card j encodes point (j+1)·G
        ZkVerify.G1Point memory M = ZkVerify.add(_deckB[dealId][cardIdx], ZkVerify.neg(acc));
        ZkVerify.G1Point memory expect = ZkVerify.mul(ZkVerify.gen(), uint256(claimedCard) + 1);
        if (!ZkVerify.eq(M, expect)) revert BadCard();
    }

    /// Reveal one board card (all k players' shares → public card). `street`:
    /// 1=flop(→3), 2=turn(→4), 3=river(→5). Board deck indices follow the deal
    /// convention: 2*k + boardSlot.
    function revealBoardCard(
        uint256 dealId,
        uint8 boardSlot,
        uint8 claimedCard,
        ZkVerify.G1Point[] calldata d,
        ZkVerify.G1Point[] calldata R1,
        ZkVerify.G1Point[] calldata R2,
        uint256[] calldata s
    ) external onlyCoordinator {
        Deal storage deal = _deal[dealId];
        if (!deal.exists) revert NotPrepared();
        if (boardSlot > 4 || boardSlot != deal.boardCount) revert BadStreet();
        uint16 cardIdx = uint16(2 * deal.playerCount + boardSlot);
        _verifyDecrypt(dealId, cardIdx, claimedCard, d, R1, R2, s);
        deal.board[boardSlot] = claimedCard;
        deal.boardCount = boardSlot + 1;
        emit BoardRevealed(dealId, deal.boardCount);
    }

    /// Reveal a seat's two hole cards at showdown (now that seat's own share is
    /// also public). deckIdx for seat's participant index p: 2*p and 2*p+1.
    function revealHoleCards(
        uint256 dealId,
        uint8 participant,
        uint8 seatIndex,
        uint8[2] calldata cards,
        // proofs for card0 then card1: arrays laid out [card0 shares..., card1 shares...]
        ZkVerify.G1Point[] calldata d,
        ZkVerify.G1Point[] calldata R1,
        ZkVerify.G1Point[] calldata R2,
        uint256[] calldata s
    ) external onlyCoordinator {
        Deal storage deal = _deal[dealId];
        if (!deal.exists) revert NotPrepared();
        uint256 k = deal.playerCount;
        if (d.length != 2 * k) revert BadLength();
        // card 0 uses d[0..k), card 1 uses d[k..2k)
        _verifyDecrypt(dealId, uint16(2 * participant), cards[0], d[0:k], R1[0:k], R2[0:k], s[0:k]);
        _verifyDecrypt(dealId, uint16(2 * participant + 1), cards[1], d[k:2 * k], R1[k:2 * k], R2[k:2 * k], s[k:2 * k]);
        _hole[dealId][seatIndex] = cards;
        _holeSet[dealId][seatIndex] = true;
        emit HoleRevealed(dealId, seatIndex);
    }

    /// Mark the hand ready to settle once the board is complete and every seat
    /// the room needs has been revealed (coordinator asserts after posting all).
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

    // extra views for the coordinator/clients
    function dealIdForHand(uint256 tableId, uint64 handId) external view returns (uint256) {
        return _byHand[tableId][handId];
    }
    function pubkey(uint256 dealId, uint8 i) external view returns (ZkVerify.G1Point memory) {
        return _pubkey[dealId][i];
    }
    function ciphertext(uint256 dealId, uint16 cardIdx)
        external view returns (ZkVerify.G1Point memory A, ZkVerify.G1Point memory B)
    {
        return (_deckA[dealId][cardIdx], _deckB[dealId][cardIdx]);
    }
}
