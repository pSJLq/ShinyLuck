// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {CommitReveal} from "../CommitReveal.sol";
import {IGameBase, IGameModule} from "./IGameModule.sol";

/// @title CasinoVault — ShinyLuck v15 core (money + registry + RNG + risk)
/// @notice The single, permanent holder of the bankroll. Games are separate
///         module contracts registered here; adding a game never redeploys this
///         contract nor migrates the bankroll. See docs/CASINO-V15-ARCHITECTURE.md.
///
///         Trust model: this Vault ORCHESTRATES. For single-shot games the
///         module is a passive calculator the Vault calls into — a module can
///         never initiate a transfer. Every payout a module reports is bounded
///         here by: the per-bet exposure cap, the per-game budget, and a
///         solvency clamp. Registration is owner-gated (owner is a
///         TimelockController + multisig on mainnet).
///
///         P0 skeleton: single-shot flow (Dice) is complete. Multi-step (Mines)
///         and round-based (Crash/Roulette) games are added in P1 via a narrow,
///         module-gated credit primitive (not present yet).
contract CasinoVault is Ownable, ReentrancyGuard, Pausable {
    using Address for address payable;

    // ── RNG (commit-reveal seed pool) ──────────────────────────────────────
    bytes32[] public seedHashes;
    uint256 public nextHashIndex;
    mapping(uint256 => bytes32) public revealedSeed;

    // ── Bets ────────────────────────────────────────────────────────────────
    struct Bet {
        address player;
        uint96  amount;       // wei
        uint16  gameId;
        uint8   status;       // 0 = pending, 1 = settled, 2 = refunded
        uint64  commitBlock;
        uint64  nonce;
        uint256 seedIdx;
        bytes32 clientSeed;
        bytes   params;
        bytes32 randomness;
        uint128 payout;
        bool    won;
    }
    Bet[] private _bets;
    mapping(address => uint256[]) public playerBets;
    uint256 public constant BET_HISTORY_CAP = 200;

    // ── Bankroll (pull-payment) ──────────────────────────────────────────────
    mapping(address => uint256) public pendingWithdrawals;
    uint256 public totalPendingWithdrawals;

    // ── Risk policy ──────────────────────────────────────────────────────────
    // Max stake as a fraction of freeBankroll (bps). 100 = 1%.
    uint256 public maxBetBps = 100;
    // Max single-bet payout as a fraction of freeBankroll (bps). 2000 = 20%.
    // Exposure model (no per-bet escrow): a bet is allowed if its max payout is
    // <= this fraction of the pool, so many concurrent bets never lock funds.
    uint256 public maxExposureBps = 2000;

    // ── Game registry + per-game safety ──────────────────────────────────────
    mapping(uint16 => address) public gameModule;   // gameId => module
    mapping(address => bool)    public isModule;     // registered module set
    mapping(address => uint16)  public moduleGameIdPlus1; // module => gameId+1 (0 = not a module)
    mapping(uint16 => bool)     public gameActive;   // accepting new bets
    mapping(uint16 => uint256)  public gameMaxBet;   // absolute stake cap (0 = none)
    // Per-game budget: the max NET the house will let this game cost it. `gameNet`
    // rises when players win, falls when they lose. Credits are clamped so a
    // game can never bleed the bankroll beyond `gameBudget` — the blast radius
    // of any single game (buggy or hostile) is its budget, not the whole vault.
    mapping(uint16 => uint256)  public gameBudget;
    mapping(uint16 => int256)   public gameNet;

    // ── Owner profit withdraw (timelock; 0 on testnet, real on mainnet) ──────
    uint256 public constant OWNER_WITHDRAW_DELAY = 0;
    struct PendingWithdraw { uint128 amount; uint64 readyAt; }
    PendingWithdraw public ownerWithdrawal;

    // ── Events ────────────────────────────────────────────────────────────────
    event SeedHashesProvisioned(uint256 startIndex, uint256 count);
    event GameRegistered(uint16 indexed gameId, address indexed module, uint256 budget);
    event GameActiveSet(uint16 indexed gameId, bool active);
    event GameBudgetSet(uint16 indexed gameId, uint256 budget);
    event GameMaxBetSet(uint16 indexed gameId, uint256 amount);
    event BankrollDeposited(address indexed from, uint256 amount);
    event BetPlaced(
        uint256 indexed betId, address indexed player, uint16 indexed gameId,
        uint256 amount, bytes32 clientSeed, uint256 commitBlock, uint256 seedIdx, bytes params
    );
    event BetSettled(
        uint256 indexed betId, address indexed player, uint16 indexed gameId,
        bool won, uint256 payout, bytes32 randomness, bytes32 serverSeed,
        bytes32 clientSeed, bytes32 blockHash, uint256 nonce, bytes resultData
    );
    event BetRefunded(uint256 indexed betId, address indexed player, uint256 amount, string reason);
    event PayoutClamped(uint256 indexed betId, uint256 requested, uint256 credited, string reason);
    event ModuleStake(uint16 indexed gameId, address indexed player, uint256 amount);
    event ModuleCredit(uint16 indexed gameId, address indexed player, uint256 betId, uint256 amount);
    event ModuleRefund(uint16 indexed gameId, address indexed player, uint256 amount);
    event WithdrawalCredited(address indexed player, uint256 amount);
    event WithdrawalClaimed(address indexed player, uint256 amount);
    event OwnerWithdrawScheduled(uint256 amount, uint256 readyAt);
    event OwnerWithdrawExecuted(uint256 amount);

    // ── Errors ────────────────────────────────────────────────────────────────
    error GameNotRegistered();
    error GameInactive();
    error InvalidBet(string reason);
    error NoSeedAvailable();
    error BetNotFound();
    error BetAlreadySettled();
    error BetTooLarge();
    error NotModule();

    modifier onlyModule() {
        if (moduleGameIdPlus1[msg.sender] == 0) revert NotModule();
        _;
    }

    /// @dev gameId of the calling module (only valid inside onlyModule).
    function _moduleGid() internal view returns (uint16) {
        return moduleGameIdPlus1[msg.sender] - 1;
    }

    constructor() Ownable(msg.sender) {}

    // ═══════════════════════ Registry / admin ═══════════════════════════════

    /// @notice Register (or replace) the module for a gameId with a starting
    ///         budget. Owner-gated → timelock+multisig on mainnet.
    function registerGame(uint16 id, address module, uint256 budget) external onlyOwner {
        require(module != address(0), "module=0");
        require(IGameBase(module).gameId() == id, "id mismatch");
        address prev = gameModule[id];
        if (prev != address(0)) { isModule[prev] = false; moduleGameIdPlus1[prev] = 0; }
        gameModule[id] = module;
        isModule[module] = true;
        moduleGameIdPlus1[module] = id + 1;
        gameActive[id] = true;
        gameBudget[id] = budget;
        emit GameRegistered(id, module, budget);
    }

    function setGameActive(uint16 id, bool active) external onlyOwner {
        require(gameModule[id] != address(0), "unknown game");
        gameActive[id] = active;
        emit GameActiveSet(id, active);
    }

    function setGameBudget(uint16 id, uint256 budget) external onlyOwner {
        require(gameModule[id] != address(0), "unknown game");
        gameBudget[id] = budget;
        emit GameBudgetSet(id, budget);
    }

    function setGameMaxBet(uint16 id, uint256 amount) external onlyOwner {
        gameMaxBet[id] = amount;
        emit GameMaxBetSet(id, amount);
    }

    function setMaxBetBps(uint256 bps) external onlyOwner {
        require(bps <= 10000, "bps");
        maxBetBps = bps;
    }

    function setMaxExposureBps(uint256 bps) external onlyOwner {
        require(bps > 0 && bps <= 10000, "bps");
        maxExposureBps = bps;
    }

    function pauseAll() external onlyOwner { _pause(); }
    function unpauseAll() external onlyOwner { _unpause(); }

    // ═══════════════════════ RNG seed pool ══════════════════════════════════

    function provisionSeedHashes(bytes32[] calldata hashes) external onlyOwner {
        uint256 start = seedHashes.length;
        for (uint256 i; i < hashes.length; i++) seedHashes.push(hashes[i]);
        emit SeedHashesProvisioned(start, hashes.length);
    }

    function seedPoolStatus() external view returns (uint256 total, uint256 consumed, uint256 available) {
        total = seedHashes.length;
        consumed = nextHashIndex;
        available = total - consumed;
    }

    // ═══════════════════════ Bankroll ═══════════════════════════════════════

    /// @notice Funds available to back bets = balance minus money already owed
    ///         to winners. (Deliberately not minus any per-bet reserve — the
    ///         exposure model needs no escrow.)
    function freeBankroll() public view returns (uint256) {
        uint256 bal = address(this).balance;
        return bal > totalPendingWithdrawals ? bal - totalPendingWithdrawals : 0;
    }

    function depositBankroll() external payable {
        emit BankrollDeposited(msg.sender, msg.value);
    }

    receive() external payable {
        emit BankrollDeposited(msg.sender, msg.value);
    }

    // ═══════════════════════ Bet placement (single-shot) ════════════════════

    /// @notice Place a single-shot bet. Player sends the stake as msg.value
    ///         straight to the Vault; the module never touches the funds. The
    ///         player supplies `clientSeed` (their provably-fair entropy). The
    ///         Vault asks the module to validate params + quote the max payout,
    ///         then enforces the stake caps and the exposure cap.
    function placeBet(uint16 id, bytes32 clientSeed, bytes calldata params)
        external
        payable
        whenNotPaused
        nonReentrant
        returns (uint256 betId)
    {
        address module = gameModule[id];
        if (module == address(0)) revert GameNotRegistered();
        if (!gameActive[id]) revert GameInactive();

        uint256 amount = msg.value;
        if (amount == 0) revert InvalidBet("zero stake");

        uint256 cap = gameMaxBet[id];
        if (cap > 0 && amount > cap) revert BetTooLarge();

        uint256 free = freeBankroll();
        uint256 bpsCap = (free * maxBetBps) / 10000;
        if (bpsCap > 0 && amount > bpsCap) revert BetTooLarge();

        uint256 maxPayout = IGameModule(module).quote(msg.sender, amount, params);
        if (maxPayout < amount) revert InvalidBet("payout < stake");
        uint256 maxExposure = (free * maxExposureBps) / 10000;
        if (maxExposure > 0 && maxPayout > maxExposure) revert BetTooLarge();

        if (nextHashIndex >= seedHashes.length) revert NoSeedAvailable();
        uint256 seedIdx = nextHashIndex++;

        betId = _bets.length;
        _bets.push(Bet({
            player: msg.sender,
            amount: uint96(amount),
            gameId: id,
            status: 0,
            commitBlock: uint64(block.number),
            nonce: uint64(betId),
            seedIdx: seedIdx,
            clientSeed: clientSeed,
            params: params,
            randomness: bytes32(0),
            payout: 0,
            won: false
        }));
        _recordPlayerBet(msg.sender, betId);
        emit BetPlaced(betId, msg.sender, id, amount, clientSeed, block.number, seedIdx, params);
    }

    // ═══════════════════════ Settlement ═════════════════════════════════════

    /// @notice Reveal the server seed and settle a pending bet. Permissionless
    ///         (gated on the committed seed hash, not msg.sender) so any cashier
    ///         can call it. The module computes the payout; the Vault bounds and
    ///         credits it.
    function revealAndSettle(uint256 betId, bytes32 serverSeed) external nonReentrant {
        if (betId >= _bets.length) revert BetNotFound();
        Bet storage bet = _bets[betId];
        if (bet.status != 0) revert BetAlreadySettled();

        if (CommitReveal.isExpired(bet.commitBlock)) { _refund(betId, "expired blockhash"); return; }
        CommitReveal.requireRevealable(bet.commitBlock);

        bytes32 storedSeed = revealedSeed[bet.seedIdx];
        if (storedSeed == bytes32(0)) {
            CommitReveal.requireSeedMatches(serverSeed, seedHashes[bet.seedIdx]);
            revealedSeed[bet.seedIdx] = serverSeed;
            storedSeed = serverSeed;
        }
        _settle(betId, storedSeed);
    }

    function _settle(uint256 betId, bytes32 storedSeed) internal {
        Bet storage bet = _bets[betId];
        bytes32 randomness = CommitReveal.deriveRandomness(
            storedSeed, bet.clientSeed, bet.commitBlock, bet.nonce
        );

        (uint256 payout, bool won, bytes memory resultData) =
            IGameModule(gameModule[bet.gameId]).resolve(betId, bet.amount, randomness, bet.params);

        // Clamp 1 — per-game budget: a game can never cost the house more than
        // its allocated budget (net). payout - stake is the house's loss on this
        // bet; cap it so gameNet stays <= gameBudget.
        {
            int256 headroom = int256(gameBudget[bet.gameId]) - gameNet[bet.gameId];
            int256 maxByBudget = headroom + int256(uint256(bet.amount));
            if (maxByBudget < 0) maxByBudget = 0;
            if (int256(payout) > maxByBudget) {
                emit PayoutClamped(betId, payout, uint256(maxByBudget), "game budget");
                payout = uint256(maxByBudget);
            }
        }

        // Clamp 2 — solvency: never credit more than the pool can actually pay,
        // so claim() can never fail.
        if (payout > 0) {
            uint256 avail = freeBankroll();
            if (payout > avail) {
                emit PayoutClamped(betId, payout, avail, "solvency");
                payout = avail;
            }
        }

        won = won && payout > 0;
        gameNet[bet.gameId] += int256(payout) - int256(uint256(bet.amount));

        bet.status = 1;
        bet.randomness = randomness;
        bet.won = won;
        bet.payout = uint128(payout);

        if (payout > 0) {
            pendingWithdrawals[bet.player] += payout;
            totalPendingWithdrawals += payout;
            emit WithdrawalCredited(bet.player, payout);
        }

        emit BetSettled(
            betId, bet.player, bet.gameId, won, payout, randomness, storedSeed,
            bet.clientSeed, blockhash(bet.commitBlock + CommitReveal.REVEAL_DELAY),
            bet.nonce, resultData
        );
    }

    function refundExpired(uint256 betId) external nonReentrant {
        if (betId >= _bets.length) revert BetNotFound();
        Bet storage bet = _bets[betId];
        if (bet.status != 0) revert BetAlreadySettled();
        if (!CommitReveal.isExpired(bet.commitBlock)) revert InvalidBet("not expired");
        _refund(betId, "expired blockhash");
    }

    function _refund(uint256 betId, string memory reason) internal {
        Bet storage bet = _bets[betId];
        bet.status = 2;
        pendingWithdrawals[bet.player] += bet.amount;
        totalPendingWithdrawals += bet.amount;
        emit WithdrawalCredited(bet.player, bet.amount);
        emit BetRefunded(betId, bet.player, bet.amount, reason);
    }

    // ═══════════════════════ Module-entry primitives ════════════════════════
    // For multi-step (Mines) and round-based (Crash/Roulette) games, where the
    // module is the entry point. Every call is onlyModule and re-applies the
    // same caps as the single-shot path, so a module can never move more than
    // the Vault authorizes. Modules still custody nothing — funds live here.

    /// @notice Reserve the next commit-reveal seed for a module-driven game.
    function reserveSeed() external onlyModule returns (uint256 idx, bytes32 hash) {
        if (nextHashIndex >= seedHashes.length) revert NoSeedAvailable();
        idx = nextHashIndex++;
        hash = seedHashes[idx];
    }

    /// @notice Reveal a reserved seed (verify against its committed hash).
    function revealSeed(uint256 idx, bytes32 serverSeed) external onlyModule returns (bytes32) {
        bytes32 stored = revealedSeed[idx];
        if (stored == bytes32(0)) {
            CommitReveal.requireSeedMatches(serverSeed, seedHashes[idx]);
            revealedSeed[idx] = serverSeed;
            stored = serverSeed;
        }
        return stored;
    }

    /// @notice Escrow a player's stake (msg.value) with the stake + exposure
    ///         caps for the calling module's game.
    function escrowStake(address player, uint256 maxPayout) external payable onlyModule {
        uint16 gid = _moduleGid();
        uint256 amount = msg.value;
        if (amount == 0) revert InvalidBet("zero stake");
        uint256 cap = gameMaxBet[gid];
        if (cap > 0 && amount > cap) revert BetTooLarge();
        uint256 free = freeBankroll();
        uint256 bpsCap = (free * maxBetBps) / 10000;
        if (bpsCap > 0 && amount > bpsCap) revert BetTooLarge();
        uint256 maxExposure = (free * maxExposureBps) / 10000;
        if (maxExposure > 0 && maxPayout > maxExposure) revert BetTooLarge();
        gameNet[gid] -= int256(amount);
        emit ModuleStake(gid, player, amount);
    }

    /// @notice Credit a payout, clamped by the game's budget and pool solvency.
    function creditFromModule(address player, uint256 betId, uint256 amount)
        external
        onlyModule
        returns (uint256 credited)
    {
        uint16 gid = _moduleGid();
        uint256 payout = amount;
        int256 headroom = int256(gameBudget[gid]) - gameNet[gid];
        if (headroom < 0) headroom = 0;
        if (int256(payout) > headroom) {
            emit PayoutClamped(betId, payout, uint256(headroom), "game budget");
            payout = uint256(headroom);
        }
        uint256 avail = freeBankroll();
        if (payout > avail) {
            emit PayoutClamped(betId, payout, avail, "solvency");
            payout = avail;
        }
        gameNet[gid] += int256(payout);
        if (payout > 0) {
            pendingWithdrawals[player] += payout;
            totalPendingWithdrawals += payout;
            emit WithdrawalCredited(player, payout);
        }
        emit ModuleCredit(gid, player, betId, payout);
        return payout;
    }

    /// @notice Return a player's stake (refund / fraud comp). Not budget-clamped.
    function refundFromModule(address player, uint256 amount) external onlyModule {
        uint16 gid = _moduleGid();
        gameNet[gid] += int256(amount);
        pendingWithdrawals[player] += amount;
        totalPendingWithdrawals += amount;
        emit WithdrawalCredited(player, amount);
        emit ModuleRefund(gid, player, amount);
    }

    // ═══════════════════════ Withdrawals (pull) ═════════════════════════════

    function claim() external nonReentrant {
        uint256 amt = pendingWithdrawals[msg.sender];
        require(amt > 0, "nothing to claim");
        pendingWithdrawals[msg.sender] = 0;
        totalPendingWithdrawals -= amt;
        emit WithdrawalClaimed(msg.sender, amt);
        payable(msg.sender).sendValue(amt);
    }

    // ═══════════════════════ Owner profit withdraw ══════════════════════════

    function scheduleOwnerWithdraw(uint256 amount) external onlyOwner {
        require(amount > 0 && amount <= freeBankroll(), "amount");
        ownerWithdrawal = PendingWithdraw({ amount: uint128(amount), readyAt: uint64(block.timestamp + OWNER_WITHDRAW_DELAY) });
        emit OwnerWithdrawScheduled(amount, ownerWithdrawal.readyAt);
    }

    function executeOwnerWithdraw() external onlyOwner nonReentrant {
        PendingWithdraw memory pw = ownerWithdrawal;
        require(pw.amount > 0, "nothing scheduled");
        require(block.timestamp >= pw.readyAt, "timelock");
        require(pw.amount <= freeBankroll(), "exceeds free now");
        delete ownerWithdrawal;
        emit OwnerWithdrawExecuted(pw.amount);
        payable(owner()).sendValue(pw.amount);
    }

    function cancelOwnerWithdraw() external onlyOwner { delete ownerWithdrawal; }

    // ═══════════════════════ Views ══════════════════════════════════════════

    function totalBets() external view returns (uint256) { return _bets.length; }

    function getBet(uint256 betId) external view returns (Bet memory) {
        if (betId >= _bets.length) revert BetNotFound();
        return _bets[betId];
    }

    function getPlayerBets(address player) external view returns (uint256[] memory) {
        return playerBets[player];
    }

    function _recordPlayerBet(address player, uint256 betId) internal {
        uint256[] storage list = playerBets[player];
        if (list.length >= BET_HISTORY_CAP) {
            for (uint256 i = 1; i < list.length; i++) list[i - 1] = list[i];
            list[list.length - 1] = betId;
        } else {
            list.push(betId);
        }
    }
}
