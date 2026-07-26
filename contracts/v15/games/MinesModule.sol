// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CommitReveal} from "../../CommitReveal.sol";
import {IGameBase, ICasinoVaultModule} from "../IGameModule.sol";
import {GameGate} from "./GameGate.sol";

/// @title MinesModule — ShinyLuck v15 (multi-step, module-entry)
/// @notice Hidden-layout Mines ported byte-for-byte from Casino v14. The module
///         is the entry point (player places, picks, cashes out here); it holds
///         all game state but NO funds — every stake/credit/refund goes through
///         the Vault's module-gated primitives, which clamp by budget/solvency.
///         The anti-peek guarantee is preserved: the coordinator only discloses
///         a cell's {isMine, proof} AFTER the player's on-chain pick, and the
///         committed Merkle root is checked against the revealed seed at
///         finalize (fraud → stake refunded on top).
///
///         `owner` is the coordinator (the reveal bot). commitRoot/resolveCell
///         are owner-gated (an open commit would let a griefer plant a garbage
///         root). Everything else is player- or permissionless.
contract MinesModule is IGameBase, GameGate, Ownable, ReentrancyGuard {
    uint16 public constant GAME_ID = 3; // MINES
    uint16 public constant HOUSE_EDGE_BPS = 120;
    uint256 public constant MINES_MAX_MULT_X100 = 10000; // 100x hard cap
    uint256 public constant MINES_PICK_TIMEOUT = 40;      // blocks

    ICasinoVaultModule public immutable vault;

    struct Game {
        address player;
        uint96  amount;
        uint8   status;       // 0 open, 1 settled, 2 refunded
        uint8   mineCount;
        uint8   pendingCell;  // 0 none, else cell+1
        bool    busted;
        bool    finalized;
        uint32  openedBitmap;
        uint64  commitBlock;
        uint64  pickBlock;
        uint64  nonce;
        uint256 seedIdx;
        bytes32 clientSeed;
        bytes32 layoutRoot;
        bytes32 entropyHash;
        bytes32 randomness;
    }
    Game[] private _games;

    event MinesPlaced(uint256 indexed betId, address indexed player, uint256 amount, uint8 mineCount);
    event MinesRootCommitted(uint256 indexed betId, bytes32 root);
    event MinesCellPicked(uint256 indexed betId, uint8 cellIdx);
    event MinesCellOpened(uint256 indexed betId, uint8 cellIdx, uint32 openedBitmap, uint256 multiplierX100);
    event MinesBust(uint256 indexed betId, uint8 cellIdx);
    event MinesCashout(uint256 indexed betId, uint8 cellsOpened, uint256 payout, uint256 multiplierX100);
    event MinesRefunded(uint256 indexed betId, string reason);
    event MinesLayout(uint256 indexed betId, uint32 minesBitmap, bytes32 serverSeed);
    event MinesFraud(uint256 indexed betId, bytes32 committedRoot, bytes32 derivedRoot);

    error InvalidBet(string reason);
    error BetNotFound();
    error BetAlreadySettled();
    error NotCoordinator();

    constructor(address _vault) Ownable(msg.sender) {
        require(_vault != address(0), "vault=0");
        vault = ICasinoVaultModule(_vault);
    }

    function gameId() external pure returns (uint16) { return GAME_ID; }
    function houseEdgeBps() external pure returns (uint16) { return HOUSE_EDGE_BPS; }

    function totalGames() external view returns (uint256) { return _games.length; }
    function getGame(uint256 betId) external view returns (Game memory) {
        if (betId >= _games.length) revert BetNotFound();
        return _games[betId];
    }

    // ─────────────────────────── Play ────────────────────────────────────────

    function placeMinesBet(uint8 mineCount, bytes32 clientSeed)
        external
        payable
        nonReentrant
        returns (uint256 betId)
    {
        _requireOpen(vault);
        if (mineCount < 1 || mineCount > 24) revert InvalidBet("mineCount");
        uint256 maxPayout = (msg.value * MINES_MAX_MULT_X100) / 100;
        (uint256 seedIdx, ) = vault.reserveSeed();
        vault.escrowStake{value: msg.value}(msg.sender, maxPayout);

        betId = _games.length;
        _games.push(Game({
            player: msg.sender,
            amount: uint96(msg.value),
            status: 0,
            mineCount: mineCount,
            pendingCell: 0,
            busted: false,
            finalized: false,
            openedBitmap: 0,
            commitBlock: uint64(block.number),
            pickBlock: 0,
            nonce: uint64(betId),
            seedIdx: seedIdx,
            clientSeed: clientSeed,
            layoutRoot: bytes32(0),
            entropyHash: bytes32(0),
            randomness: bytes32(0)
        }));
        emit MinesPlaced(betId, msg.sender, msg.value, mineCount);
    }

    /// @notice Coordinator commits the hidden layout's Merkle root.
    function commitRoot(uint256 betId, bytes32 root) external onlyOwner nonReentrant {
        if (betId >= _games.length) revert BetNotFound();
        if (root == bytes32(0)) revert InvalidBet("zero root");
        Game storage g = _games[betId];
        if (g.status != 0) revert BetAlreadySettled();
        if (g.layoutRoot != bytes32(0)) revert InvalidBet("root set");
        if (CommitReveal.isExpired(g.commitBlock)) { _refund(betId, "expired blockhash"); return; }
        CommitReveal.requireRevealable(g.commitBlock);
        g.layoutRoot = root;
        g.entropyHash = blockhash(g.commitBlock + CommitReveal.REVEAL_DELAY);
        emit MinesRootCommitted(betId, root);
    }

    /// @notice Player commits to opening a cell (cheap, proof-less). This is
    ///         what makes the layout un-peekable.
    function pickCell(uint256 betId, uint8 cellIdx) external nonReentrant {
        Game storage g = _games[betId];
        if (g.player != msg.sender) revert InvalidBet("not player");
        if (g.status != 0) revert BetAlreadySettled();
        if (g.layoutRoot == bytes32(0)) revert InvalidBet("root not committed");
        if (g.busted) revert InvalidBet("busted");
        if (g.pendingCell != 0) revert InvalidBet("pick pending");
        if (cellIdx >= 25) revert InvalidBet("cell oob");
        if (g.openedBitmap & (uint32(1) << cellIdx) != 0) revert InvalidBet("already opened");
        g.pendingCell = cellIdx + 1;
        g.pickBlock = uint64(block.number);
        emit MinesCellPicked(betId, cellIdx);
    }

    /// @notice Coordinator resolves the pending pick with its Merkle proof.
    function resolveCell(uint256 betId, bool isMine, bytes32 salt, bytes32[] calldata proof)
        external
        onlyOwner
        nonReentrant
    {
        Game storage g = _games[betId];
        if (g.status != 0) revert BetAlreadySettled();
        if (g.pendingCell == 0) revert InvalidBet("no pending pick");
        uint8 cellIdx = g.pendingCell - 1;
        g.pendingCell = 0;
        bytes32 leaf = keccak256(abi.encode(betId, uint256(cellIdx), isMine, salt));
        if (_proofRoot(leaf, cellIdx, proof) != g.layoutRoot) revert InvalidBet("bad proof");
        if (isMine) {
            g.busted = true;
            g.status = 1;
            emit MinesBust(betId, cellIdx);
            return; // stake stays with the house; no credit
        }
        g.openedBitmap |= uint32(1) << cellIdx;
        uint256 multX100 = _multiplierX100(_popcount25(g.openedBitmap), g.mineCount);
        emit MinesCellOpened(betId, cellIdx, g.openedBitmap, multX100);
    }

    /// @notice If the coordinator stalls past the timeout, the player voids the
    ///         whole bet for a full stake refund.
    function cancelPick(uint256 betId) external nonReentrant {
        Game storage g = _games[betId];
        if (g.player != msg.sender) revert InvalidBet("not player");
        if (g.status != 0) revert BetAlreadySettled();
        if (g.pendingCell == 0) revert InvalidBet("no pending pick");
        if (block.number <= uint256(g.pickBlock) + MINES_PICK_TIMEOUT) revert InvalidBet("pick not timed out");
        g.pendingCell = 0;
        _refund(betId, "mines pick timeout");
    }

    function cashout(uint256 betId) external nonReentrant {
        Game storage g = _games[betId];
        if (g.player != msg.sender) revert InvalidBet("not player");
        if (g.status != 0) revert BetAlreadySettled();
        if (g.layoutRoot == bytes32(0)) revert InvalidBet("root not committed");
        if (g.busted) revert InvalidBet("busted");
        if (g.pendingCell != 0) revert InvalidBet("pick pending");
        uint8 k = _popcount25(g.openedBitmap);
        if (k == 0) revert InvalidBet("nothing opened");

        uint256 multX100 = _multiplierX100(k, g.mineCount);
        uint256 payout = (uint256(g.amount) * multX100) / 100;
        g.status = 1;
        vault.creditFromModule(g.player, betId, payout);
        emit MinesCashout(betId, k, payout, multX100);
    }

    /// @notice Post-game transparency + fraud tripwire. Re-derives the layout
    ///         from the revealed seed and rebuilds the root on-chain; a mismatch
    ///         means the committed layout was rigged — logged, and the player's
    ///         stake is refunded on top of whatever already settled.
    function finalize(uint256 betId, bytes32 serverSeed) external nonReentrant {
        Game storage g = _games[betId];
        if (betId >= _games.length) revert BetNotFound();
        if (g.status == 0) revert InvalidBet("game still open");
        if (g.layoutRoot == bytes32(0)) revert InvalidBet("no root");
        if (g.finalized) revert InvalidBet("finalized");
        g.finalized = true;

        bytes32 stored = vault.revealSeed(g.seedIdx, serverSeed);
        bytes32 randomness = keccak256(abi.encodePacked(stored, g.clientSeed, g.entropyHash, uint256(g.nonce)));
        g.randomness = randomness;
        uint32 bitmap = _selectMines(randomness, g.mineCount);
        bytes32 derived = _layoutRoot(betId, bitmap, stored);
        if (derived != g.layoutRoot) {
            emit MinesFraud(betId, g.layoutRoot, derived);
            vault.refundFromModule(g.player, g.amount);
        }
        emit MinesLayout(betId, bitmap, stored);
    }

    function _refund(uint256 betId, string memory reason) internal {
        Game storage g = _games[betId];
        g.status = 2;
        vault.refundFromModule(g.player, g.amount);
        emit MinesRefunded(betId, reason);
    }

    // ─────────────────────────── Merkle + math (ported v14) ──────────────────

    function _salt(bytes32 serverSeed, uint256 betId, uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encode(serverSeed, betId, i));
    }

    function _layoutRoot(uint256 betId, uint32 bitmap, bytes32 serverSeed) internal pure returns (bytes32) {
        bytes32[32] memory nodes;
        for (uint256 i; i < 25; i++) {
            bool isMine = bitmap & (uint32(1) << i) != 0;
            nodes[i] = keccak256(abi.encode(betId, i, isMine, _salt(serverSeed, betId, i)));
        }
        for (uint256 i = 25; i < 32; i++) nodes[i] = keccak256(abi.encode(betId, i));
        uint256 width = 32;
        while (width > 1) {
            for (uint256 i; i < width / 2; i++) nodes[i] = keccak256(abi.encodePacked(nodes[2 * i], nodes[2 * i + 1]));
            width /= 2;
        }
        return nodes[0];
    }

    function _proofRoot(bytes32 leaf, uint256 index, bytes32[] calldata proof) internal pure returns (bytes32) {
        if (proof.length != 5) return bytes32(0);
        bytes32 node = leaf;
        for (uint256 i; i < 5; i++) {
            node = index & 1 == 1
                ? keccak256(abi.encodePacked(proof[i], node))
                : keccak256(abi.encodePacked(node, proof[i]));
            index >>= 1;
        }
        return node;
    }

    function _popcount25(uint32 x) internal pure returns (uint8 c) {
        for (uint8 i; i < 25; i++) if (x & (uint32(1) << i) != 0) c++;
    }

    function _multiplierX100(uint8 k, uint8 mines) internal pure returns (uint256) {
        if (k == 0) return 100;
        uint256 num = 1;
        uint256 den = 1;
        for (uint8 i; i < k; i++) {
            num *= (25 - uint256(i));
            den *= (25 - uint256(mines) - uint256(i));
            uint256 gg = _gcd(num, den);
            num /= gg; den /= gg;
        }
        uint256 multX100 = (num * (10000 - HOUSE_EDGE_BPS) * 100) / (den * 10000);
        if (multX100 > MINES_MAX_MULT_X100) multX100 = MINES_MAX_MULT_X100;
        if (multX100 < 100) multX100 = 100;
        return multX100;
    }

    function _gcd(uint256 a, uint256 b) internal pure returns (uint256) {
        while (b != 0) { (a, b) = (b, a % b); }
        return a;
    }

    function _selectMines(bytes32 randomness, uint8 mineCount) internal pure returns (uint32) {
        uint32 bits = 0;
        uint8[25] memory cells;
        for (uint8 i; i < 25; i++) cells[i] = i;
        uint8 remaining = 25;
        bytes32 r = randomness;
        for (uint8 i; i < mineCount; i++) {
            r = keccak256(abi.encode(r, i));
            uint8 idx = uint8(uint256(r) % remaining);
            bits |= uint32(1) << cells[idx];
            cells[idx] = cells[remaining - 1];
            remaining--;
        }
        return bits;
    }
}
