// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CommitReveal} from "../../CommitReveal.sol";
import {IGameBase, ICasinoVaultModule} from "../IGameModule.sol";
import {SlotLoyalty} from "./SlotLoyalty.sol";
import {GameGate} from "./GameGate.sol";

/// @title SlotBase — shared spin lifecycle for ShinyLuck v15 slot modules
/// @notice Slots are module-entry games (not plain single-shot) because a FREE
///         spin carries no msg.value: there is nothing to escrow, yet it must
///         still settle and pay. This base owns the spin record, the
///         commit-reveal wiring and the money calls; each concrete slot only
///         implements `_spinResolve` (its pay-table math). Holds no funds.
abstract contract SlotBase is IGameBase, GameGate, Ownable, ReentrancyGuard {
    ICasinoVaultModule public immutable vault;
    SlotLoyalty public immutable loyalty;

    /// @dev Notional stake a free spin is scored against (v14 parity).
    uint256 internal constant FREE_SPIN_REFERENCE_STAKE = 0.001 ether;
    /// @dev Line payouts are doubled during a free spin (v14 parity).
    uint256 internal constant FREE_SPIN_MULT_X100 = 200;

    struct Spin {
        address player;
        uint96  amount;      // notional stake for a free spin
        uint8   status;      // 0 open, 1 settled, 2 refunded
        bool    freeSpin;
        bool    buyBonus;
        uint64  commitBlock;
        uint64  nonce;
        uint256 seedIdx;
        bytes32 clientSeed;
        bytes32 randomness;
        uint128 payout;
    }
    Spin[] internal _spins;

    event SpinPlaced(uint256 indexed betId, address indexed player, uint256 amount, bool freeSpin, bool buyBonus);
    event SpinSettled(uint256 indexed betId, address indexed player, bool won, uint256 payout, bytes32 randomness, bytes32 serverSeed, bytes resultData);
    event SpinRefunded(uint256 indexed betId, string reason);

    error InvalidBet(string reason);
    error BetNotFound();
    error BetAlreadySettled();

    constructor(address _vault, address _loyalty) Ownable(msg.sender) {
        require(_vault != address(0) && _loyalty != address(0), "addr=0");
        vault = ICasinoVaultModule(_vault);
        loyalty = SlotLoyalty(_loyalty);
    }

    /// @dev Concrete slot implements its pay-table math here. Must NOT move
    ///      money; the base credits through the Vault (which clamps).
    function _spinResolve(address player, uint256 stake, bytes32 randomness, bool freeSpin)
        internal
        virtual
        returns (uint256 payout, bytes memory resultData);

    /// @dev Worst-case payout for this stake (for the Vault's exposure check).
    function _maxPayout(uint256 stake) internal view virtual returns (uint256);

    // ── play ────────────────────────────────────────────────────────────────

    function placeSpin(bytes32 clientSeed, bool useFreeSpin)
        external
        payable
        nonReentrant
        returns (uint256 betId)
    {
        return _place(clientSeed, useFreeSpin, false);
    }

    /// @notice Buy Bonus: the player pays a premium stake and it settles as one
    ///         high-variance spin at that elevated amount (v14 parity).
    function buyBonus(bytes32 clientSeed) external payable nonReentrant returns (uint256 betId) {
        return _place(clientSeed, false, true);
    }

    function _place(bytes32 clientSeed, bool useFreeSpin, bool isBuyBonus) internal returns (uint256 betId) {
        _requireOpen(vault);
        uint256 stake;
        if (useFreeSpin) {
            if (msg.value != 0) revert InvalidBet("free spin takes no value");
            loyalty.consumeFreeSpin(msg.sender);   // reverts if none available
            stake = FREE_SPIN_REFERENCE_STAKE;     // notional only
        } else {
            if (msg.value == 0) revert InvalidBet("zero stake");
            stake = msg.value;
            vault.escrowStake{value: msg.value}(msg.sender, _maxPayout(stake));
            loyalty.recordSpin(msg.sender, stake);
        }

        (uint256 seedIdx, ) = vault.reserveSeed();
        betId = _spins.length;
        _spins.push(Spin({
            player: msg.sender,
            amount: uint96(stake),
            status: 0,
            freeSpin: useFreeSpin,
            buyBonus: isBuyBonus,
            commitBlock: uint64(block.number),
            nonce: uint64(betId),
            seedIdx: seedIdx,
            clientSeed: clientSeed,
            randomness: bytes32(0),
            payout: 0
        }));
        emit SpinPlaced(betId, msg.sender, stake, useFreeSpin, isBuyBonus);
    }

    /// @notice Permissionless settle (gated on the committed seed hash).
    function settleSpin(uint256 betId, bytes32 serverSeed) external nonReentrant {
        if (betId >= _spins.length) revert BetNotFound();
        Spin storage s = _spins[betId];
        if (s.status != 0) revert BetAlreadySettled();
        if (CommitReveal.isExpired(s.commitBlock)) { _refund(betId, "expired blockhash"); return; }
        CommitReveal.requireRevealable(s.commitBlock);

        bytes32 stored = vault.revealSeed(s.seedIdx, serverSeed);
        bytes32 randomness = CommitReveal.deriveRandomness(stored, s.clientSeed, s.commitBlock, s.nonce);
        (uint256 payout, bytes memory resultData) = _spinResolve(s.player, s.amount, randomness, s.freeSpin);

        s.status = 1;
        s.randomness = randomness;
        uint256 credited = payout > 0 ? vault.creditFromModule(s.player, betId, payout) : 0;
        s.payout = uint128(credited);
        // A free spin has no stake to beat, so ANY payout is a win.
        bool won = s.freeSpin ? credited > 0 : credited >= s.amount && credited > 0;
        emit SpinSettled(betId, s.player, won, credited, randomness, stored, resultData);
    }

    function refundExpired(uint256 betId) external nonReentrant {
        if (betId >= _spins.length) revert BetNotFound();
        Spin storage s = _spins[betId];
        if (s.status != 0) revert BetAlreadySettled();
        if (!CommitReveal.isExpired(s.commitBlock)) revert InvalidBet("not expired");
        _refund(betId, "expired blockhash");
    }

    function _refund(uint256 betId, string memory reason) internal {
        Spin storage s = _spins[betId];
        s.status = 2;
        if (s.freeSpin) {
            // Nothing was paid — hand the free spin back instead of cash.
            loyalty.restoreFreeSpin(s.player);
        } else {
            vault.refundFromModule(s.player, s.amount);
        }
        emit SpinRefunded(betId, reason);
    }

    // ── views ───────────────────────────────────────────────────────────────
    function totalSpins() external view returns (uint256) { return _spins.length; }
    function getSpin(uint256 betId) external view returns (Spin memory) {
        if (betId >= _spins.length) revert BetNotFound();
        return _spins[betId];
    }
}
