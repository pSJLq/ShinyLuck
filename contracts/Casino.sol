// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {CommitReveal} from "./CommitReveal.sol";
import {Vault7Lib} from "./lib/Vault7Lib.sol";
import {ClusterLib} from "./lib/ClusterLib.sol";

/// @title Casino
/// @notice Single-contract implementation of all 6 ShinyLuck games. RNG is
///         provably fair via commit-reveal + future blockhash.
///
/// @dev Game flavours:
///        DICE / MINES / PLINKO / SLOTS  — per-bet (commit-reveal each call).
///        CRASH    — round-based: 30s open betting window, then a single
///                   crashPoint is revealed for everyone in the round.
///        ROULETTE — round-based: 30s window with up to 5 multi-bets per
///                   player, a single result number resolves all of them.
///
///      Round-based games still bind to a server-seed slot consumed via
///      `provisionSeedHashes` so the proofs match the per-bet flow. The
///      round's randomness is derived from
///        keccak256(seed ‖ roundId ‖ blockhash(roundCommitBlock + 3))
///      and each player's bet within the round inherits that randomness.
contract Casino is Ownable, ReentrancyGuard, Pausable {
    using Address for address payable;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum GameType {
        DICE,
        CRASH,
        SLOTS,      // VAULT.7 — 5×3, 20 paylines, WILD + SCATTER
        MINES,
        PLINKO,
        ROULETTE,
        CLUSTER     // SUGAR.LAB — 7×7 cluster pays, tumble cascades
    }

    /// @dev DICE params: target in [2,98], direction (0 = under, 1 = over).
    /// @dev Used only by per-bet games (Dice/Slots/Mines/Plinko). Round-
    ///      based games (Crash, Roulette) keep their own structs below.
    struct Bet {
        address player;
        uint96  amount;          // wei
        GameType game;
        uint8   status;          // 0 = pending, 1 = settled, 2 = refunded
        uint64  commitBlock;
        uint64  nonce;
        uint256 seedIdx;
        bytes32 clientSeed;
        bytes   params;
        bytes32 randomness;
        uint128 payout;
        bool    won;
    }

    // ---------------------------------------------------------------------
    // Storage — RNG
    // ---------------------------------------------------------------------

    bytes32[] public seedHashes;
    uint256 public nextHashIndex;
    mapping(uint256 => bytes32) public revealedSeed;

    // ---------------------------------------------------------------------
    // Storage — Bets (per-bet flow)
    // ---------------------------------------------------------------------

    Bet[] private _bets;
    mapping(address => uint256[]) public playerBets;
    uint256 public constant BET_HISTORY_CAP = 200;

    // ---------------------------------------------------------------------
    // Storage — bankroll / policy
    // ---------------------------------------------------------------------

    uint256 public lockedReserve;
    mapping(address => uint256) public pendingWithdrawals;
    uint256 public totalPendingWithdrawals;

    mapping(GameType => bool) public gamePaused;
    mapping(GameType => uint256) public gameMaxBet;

    uint256 public maxBetBps = 100;

    uint256 public bonusModeUntil;

    uint256 public hourStartTimestamp;
    uint256 public hourStartBankroll;
    uint256 public constant CIRCUIT_BREAKER_LOSS_BPS = 2000;

    // ---------------------------------------------------------------------
    // Storage — auth
    // ---------------------------------------------------------------------

    address public houseManager;

    // ---------------------------------------------------------------------
    // Storage — owner timelock
    // ---------------------------------------------------------------------

    uint256 public constant OWNER_WITHDRAW_DELAY = 24 hours;
    struct PendingWithdraw { uint128 amount; uint64 readyAt; }
    PendingWithdraw public ownerWithdrawal;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event SeedHashesProvisioned(uint256 startIndex, uint256 count);
    event HouseManagerUpdated(address indexed prev, address indexed next);
    event GameMaxBetSet(GameType indexed game, uint256 amount);
    event GamePaused(GameType indexed game, bool paused);
    event BonusModeActivated(uint256 until, string reasoning);
    event ReasoningLog(string thought, uint256 timestamp);
    event CircuitBreakerTripped(uint256 hourStartBankroll, uint256 currentBankroll);
    event BankrollDeposited(address indexed from, uint256 amount);

    event BetPlaced(
        uint256 indexed betId,
        address indexed player,
        GameType indexed game,
        uint256 amount,
        bytes32 clientSeed,
        uint256 commitBlock,
        uint256 seedIdx,
        bytes params
    );
    event BetSettled(
        uint256 indexed betId,
        address indexed player,
        GameType indexed game,
        bool won,
        uint256 payout,
        bytes32 randomness,
        bytes32 serverSeed,
        bytes32 clientSeed,
        bytes32 blockHash,
        uint256 nonce,
        bytes resultData
    );
    event BetRefunded(uint256 indexed betId, address indexed player, uint256 amount, string reason);

    event WithdrawalCredited(address indexed player, uint256 amount);
    event WithdrawalClaimed(address indexed player, uint256 amount);

    event OwnerWithdrawScheduled(uint256 amount, uint256 readyAt);
    event OwnerWithdrawExecuted(uint256 amount);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotHouseManager();
    error GameIsPaused();
    error InvalidGame();
    error InvalidBet(string reason);
    error NoSeedAvailable();
    error BetNotFound();
    error BetAlreadySettled();
    error BankrollInsufficient();
    error BetTooLarge();
    error RoundNotFound();
    error RoundClosed();
    error RoundNotSettleable();
    error RoundAlreadySettled();
    error CashoutTooLow();
    error TooManyBets();

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyHouseManager() {
        if (msg.sender != houseManager) revert NotHouseManager();
        _;
    }

    modifier whenGameLive(GameType g) {
        if (gamePaused[g]) revert GameIsPaused();
        _;
    }

    constructor(address initialHouseManager) Ownable(msg.sender) {
        houseManager = initialHouseManager;
        gameMaxBet[GameType.DICE]     = 10 ether;
        gameMaxBet[GameType.CRASH]    = 10 ether;
        gameMaxBet[GameType.SLOTS]    = 5 ether;
        gameMaxBet[GameType.MINES]    = 10 ether;
        gameMaxBet[GameType.PLINKO]   = 10 ether;
        gameMaxBet[GameType.ROULETTE] = 10 ether;
        gameMaxBet[GameType.CLUSTER]  = 5 ether;

        hourStartTimestamp = block.timestamp;
        hourStartBankroll = 0;
    }

    // ---------------------------------------------------------------------
    // Free-spin loyalty programme
    //
    // Every 150 placed slot/cluster bets earn the player +5 guaranteed free
    // spins. Free spins are bookkept on-chain — no off-chain trust. The
    // counters are global across SLOTS + CLUSTER (any slot spin counts).
    //
    // Free-spin redemption: when `useFreeSpin=true` is passed to
    // placeSlotsBet / placeClusterBet, the contract:
    //   1. Verifies the player has ≥ 1 available free spin
    //   2. Deducts one from the player's earned pool
    //   3. Skips the stake transfer (msg.value must be 0)
    //   4. Applies VAULT7_FREE_SPIN_MULT_X100 (2× for SLOTS) on the resolver
    //   5. Records the bet so it still settles via the normal reveal path
    // ---------------------------------------------------------------------

    struct PlayerSlotState {
        uint64 totalSpins;
        uint64 freeSpinsEarned;
        uint64 freeSpinsUsed;
    }
    mapping(address => PlayerSlotState) public playerSlotState;

    uint256 public constant SPINS_PER_BONUS = 150;
    uint256 public constant FREE_SPINS_PER_BONUS = 5;
    uint256 internal constant VAULT7_FREE_SPIN_MULT_X100 = 200; // 2× during free spins
    uint256 internal constant FREE_SPIN_REFERENCE_STAKE = 0.001 ether; // 0.001 STT notional
    /// @dev Floor stake that actually progresses the loyalty counter — keeps
    ///      a 20-wei spam attack from earning free spins for free.
    uint256 internal constant LOYALTY_MIN_STAKE = 0.001 ether;

    event FreeSpinsEarned(address indexed player, uint64 totalSpins, uint64 freeSpinsEarned);
    event FreeSpinConsumed(address indexed player, uint256 indexed betId, GameType game);

    function freeSpinsAvailable(address p) public view returns (uint256) {
        PlayerSlotState memory s = playerSlotState[p];
        return s.freeSpinsEarned > s.freeSpinsUsed ? s.freeSpinsEarned - s.freeSpinsUsed : 0;
    }

    function getPlayerSlotState(address p) external view returns (uint64 total, uint64 earned, uint64 used, uint256 toNext) {
        PlayerSlotState memory s = playerSlotState[p];
        total = s.totalSpins; earned = s.freeSpinsEarned; used = s.freeSpinsUsed;
        toNext = SPINS_PER_BONUS - (uint256(s.totalSpins) % SPINS_PER_BONUS);
    }

    /// @dev Caller passes the actual stake — only spins above LOYALTY_MIN_STAKE
    ///      tick the counter so a 20-wei dust-spam can't farm free spins.
    function _tickSlotCounter(address player, uint256 stake) internal {
        if (stake < LOYALTY_MIN_STAKE) return;
        PlayerSlotState storage st = playerSlotState[player];
        st.totalSpins += 1;
        if (st.totalSpins % SPINS_PER_BONUS == 0) {
            st.freeSpinsEarned += uint64(FREE_SPINS_PER_BONUS);
            emit FreeSpinsEarned(player, st.totalSpins, st.freeSpinsEarned);
        }
    }

    // ---------------------------------------------------------------------
    // Bankroll
    // ---------------------------------------------------------------------

    function freeBankroll() public view returns (uint256) {
        uint256 b = address(this).balance;
        uint256 sub = lockedReserve + totalPendingWithdrawals;
        return b > sub ? b - sub : 0;
    }

    receive() external payable { emit BankrollDeposited(msg.sender, msg.value); }
    function depositBankroll() external payable { emit BankrollDeposited(msg.sender, msg.value); }

    // ---------------------------------------------------------------------
    // House manager admin
    // ---------------------------------------------------------------------

    function setHouseManager(address hm) external onlyOwner {
        emit HouseManagerUpdated(houseManager, hm);
        houseManager = hm;
    }

    function setGameMaxBet(GameType g, uint256 amount) external {
        if (msg.sender != houseManager && msg.sender != owner()) revert NotHouseManager();
        // Hard ceiling: HM (or owner) may never set maxBet above 1% of free
        // bankroll. Belt-and-suspenders alongside the per-bet check in
        // `_openBet`.
        uint256 cap = freeBankroll() / 100;
        if (amount > cap && cap > 0) amount = cap;
        gameMaxBet[g] = amount;
        emit GameMaxBetSet(g, amount);
    }

    function setMaxBetBps(uint256 bps) external onlyOwner {
        require(bps > 0 && bps <= 1000, "bps out of range");
        maxBetBps = bps;
    }

    function pauseGame(GameType g) external {
        if (msg.sender != houseManager && msg.sender != owner()) revert NotHouseManager();
        gamePaused[g] = true;
        emit GamePaused(g, true);
    }

    function unpauseGame(GameType g) external {
        if (msg.sender != houseManager && msg.sender != owner()) revert NotHouseManager();
        gamePaused[g] = false;
        emit GamePaused(g, false);
    }

    function pauseAll() external onlyOwner { _pause(); }
    function unpauseAll() external onlyOwner { _unpause(); }

    function activateBonusMode(uint256 durationMinutes, string calldata reasoning) external {
        if (msg.sender != houseManager && msg.sender != owner()) revert NotHouseManager();
        require(durationMinutes > 0 && durationMinutes <= 24 * 60, "duration");
        uint256 until = block.timestamp + durationMinutes * 1 minutes;
        bonusModeUntil = until;
        emit BonusModeActivated(until, reasoning);
    }

    function recordReasoning(string calldata thought) external {
        if (msg.sender != houseManager && msg.sender != owner()) revert NotHouseManager();
        emit ReasoningLog(thought, block.timestamp);
    }

    function bonusModeActive() public view returns (bool) {
        return block.timestamp < bonusModeUntil;
    }

    // ---------------------------------------------------------------------
    // Seed pool
    // ---------------------------------------------------------------------

    function provisionSeedHashes(bytes32[] calldata hashes) external {
        if (msg.sender != houseManager && msg.sender != owner()) revert NotHouseManager();
        require(hashes.length > 0, "empty");
        uint256 startIdx = seedHashes.length;
        for (uint256 i; i < hashes.length; i++) {
            require(hashes[i] != bytes32(0), "zero hash");
            seedHashes.push(hashes[i]);
        }
        emit SeedHashesProvisioned(startIdx, hashes.length);
    }

    function seedPoolStatus() external view returns (uint256 total, uint256 consumed, uint256 available) {
        total = seedHashes.length;
        consumed = nextHashIndex;
        available = total - consumed;
    }

    // ---------------------------------------------------------------------
    // Bet storage helpers
    // ---------------------------------------------------------------------

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
            for (uint256 i; i + 1 < list.length; i++) list[i] = list[i + 1];
            list.pop();
        }
        list.push(betId);
    }

    // ---------------------------------------------------------------------
    // House edge
    // ---------------------------------------------------------------------

    function houseEdgeBps(GameType g) public view returns (uint256 bps) {
        if (g == GameType.DICE)        bps = 100;
        else if (g == GameType.CRASH)  bps = 300;
        else if (g == GameType.SLOTS)  bps = 396;   // VAULT.7 — RTP 96.04%
        else if (g == GameType.MINES)  bps = 120;
        else if (g == GameType.PLINKO) bps = 150;
        else if (g == GameType.ROULETTE) bps = 270;
        else if (g == GameType.CLUSTER)  bps = 350; // SUGAR.LAB — RTP 96.50%

        if (bonusModeActive()) bps = bps / 2;
    }

    // =====================================================================
    // DICE  (per-bet)
    // =====================================================================

    function placeDiceBet(uint8 target, bool over, bytes32 clientSeed)
        external payable nonReentrant whenNotPaused whenGameLive(GameType.DICE)
        returns (uint256 betId)
    {
        if (target < 2 || target > 98) revert InvalidBet("target");
        uint256 winChance = over ? uint256(100 - target) : uint256(target - 1);
        uint256 maxPayout = _dicePayout(msg.value, winChance);
        bytes memory params = abi.encode(target, over);
        return _openBet(GameType.DICE, msg.value, clientSeed, maxPayout, params);
    }

    function _dicePayout(uint256 bet, uint256 winChance) internal view returns (uint256) {
        uint256 edge = houseEdgeBps(GameType.DICE);
        return (bet * (10000 - edge)) / (winChance * 100);
    }

    // =====================================================================
    // SLOTS — VAULT.7  (5×3 / 20 paylines / WILD + SCATTER)
    // =====================================================================
    //   Symbol IDs (matches Vault7Lib + slots/engine.js):
    //     0..3 = LOW fruits (E, D, F, A — different per-reel weights)
    //     4..5 = MID bonus  (COIN, BOLT)
    //     6..7 = HIGH       (CRYS, DIAM)
    //     8    = WILD
    //     9    = SCATTER
    //
    //   Pay table (5-of-a-kind, basis 100):
    //       E  =  1200    D  =  1600   F  =  2400   A  =  4000
    //     COIN =  6000  BOLT = 10000  CRYS = 20000  DIAM = 40000
    //     WILD = 80000
    //
    //   3+ SCATTER anywhere → +2× / +10× / +50× stake instant bonus.
    //   During player's free spins (consumed via `useFreeSpin=true`) line
    //   payouts are doubled (×2 multiplier).
    //
    //   Hard payout cap = 2000× stake.

    /// @dev Hard cap on a single VAULT.7 payout, basis 100.
    uint256 internal constant VAULT7_MAX_MULT_X100 = 200000;

    /// @notice Place a VAULT.7 spin. `useFreeSpin=true` consumes one of the
    ///         player's earned free spins (msg.value must be 0 in that case)
    ///         and applies the in-resolver 2× multiplier.
    function placeSlotsBet(bytes32 clientSeed, bool useFreeSpin)
        external payable nonReentrant whenNotPaused whenGameLive(GameType.SLOTS)
        returns (uint256 betId)
    {
        if (useFreeSpin) {
            if (freeSpinsAvailable(msg.sender) == 0) revert InvalidBet("no free spins");
            if (msg.value != 0) revert InvalidBet("free spin: send 0");
            playerSlotState[msg.sender].freeSpinsUsed += 1;
            uint256 maxFree = (FREE_SPIN_REFERENCE_STAKE * VAULT7_MAX_MULT_X100) / 100;
            return _openFreeSpinBet(GameType.SLOTS, FREE_SPIN_REFERENCE_STAKE, clientSeed, maxFree, abi.encode(true));
        }
        if (msg.value == 0) revert InvalidBet("zero stake");
        if (msg.value < 20) revert InvalidBet("stake too small");
        _tickSlotCounter(msg.sender, msg.value);
        uint256 maxPayout = (msg.value * VAULT7_MAX_MULT_X100) / 100;
        return _openBet(GameType.SLOTS, msg.value, clientSeed, maxPayout, abi.encode(false));
    }

    // =====================================================================
    // CLUSTER — SUGAR.LAB  (7×7 cluster pays · tumble cascades)
    // =====================================================================

    /// @dev Hard cap on a single SUGAR.LAB payout, basis 100.
    uint256 internal constant CLUSTER_MAX_MULT_X100 = 250000;

    function placeClusterBet(bytes32 clientSeed, bool useFreeSpin)
        external payable nonReentrant whenNotPaused whenGameLive(GameType.CLUSTER)
        returns (uint256 betId)
    {
        if (useFreeSpin) {
            if (freeSpinsAvailable(msg.sender) == 0) revert InvalidBet("no free spins");
            if (msg.value != 0) revert InvalidBet("free spin: send 0");
            playerSlotState[msg.sender].freeSpinsUsed += 1;
            uint256 maxFree = (FREE_SPIN_REFERENCE_STAKE * CLUSTER_MAX_MULT_X100) / 100;
            return _openFreeSpinBet(GameType.CLUSTER, FREE_SPIN_REFERENCE_STAKE, clientSeed, maxFree, abi.encode(true));
        }
        if (msg.value == 0) revert InvalidBet("zero stake");
        if (msg.value < 20) revert InvalidBet("stake too small");
        _tickSlotCounter(msg.sender, msg.value);
        uint256 maxPayout = (msg.value * CLUSTER_MAX_MULT_X100) / 100;
        return _openBet(GameType.CLUSTER, msg.value, clientSeed, maxPayout, abi.encode(false));
    }

    /// @dev Like _openBet but doesn't escrow a user-provided stake (used by
    ///      free spins). Reserves the full max payout from bankroll because
    ///      no user contribution is in the pot.
    function _openFreeSpinBet(
        GameType g,
        uint256 stake,
        bytes32 clientSeed,
        uint256 maxPayout,
        bytes memory params
    ) internal returns (uint256 betId) {
        uint256 free = freeBankroll();
        if (maxPayout > free) revert BankrollInsufficient();
        if (nextHashIndex >= seedHashes.length) revert NoSeedAvailable();
        uint256 seedIdx = nextHashIndex++;
        _circuitBreakerTick();
        betId = _bets.length;
        _bets.push(Bet({
            player: msg.sender,
            amount: uint96(stake),
            game: g,
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
        lockedReserve += maxPayout;
        _recordPlayerBet(msg.sender, betId);
        emit BetPlaced(betId, msg.sender, g, stake, clientSeed, block.number, seedIdx, params);
        emit FreeSpinConsumed(msg.sender, betId, g);
    }

    struct SlotsTheme {
        string name;
        string[5] symbols;
        uint256 setAt;
    }
    SlotsTheme private _slotsTheme;
    event SlotsThemeChanged(string name, string[5] symbols, uint256 timestamp);

    function getSlotsTheme()
        external view
        returns (string memory name, string[5] memory symbols, uint256 setAt)
    {
        return (_slotsTheme.name, _slotsTheme.symbols, _slotsTheme.setAt);
    }

    function triggerThemeRotation(string calldata name, string[5] calldata symbols) external {
        if (msg.sender != houseManager && msg.sender != owner()) revert NotHouseManager();
        _slotsTheme.name = name;
        for (uint256 i; i < 5; i++) _slotsTheme.symbols[i] = symbols[i];
        _slotsTheme.setAt = block.timestamp;
        emit SlotsThemeChanged(name, symbols, block.timestamp);
    }

    // =====================================================================
    // MINES  (per-bet · unchanged from v0.7)
    // =====================================================================

    uint256 public constant MINES_MAX_MULT_X100 = 10000;

    struct MinesState {
        uint8  mineCount;
        uint32 openedBitmap;
        uint32 minesBitmap;
        bool   seedRevealed;
        bool   busted;
    }
    mapping(uint256 => MinesState) public minesState;

    event MinesSeedRevealed(uint256 indexed betId, uint32 minesBitmap);
    event MinesCellOpened(uint256 indexed betId, uint8 cellIdx, uint32 openedBitmap, uint256 multiplierX100);
    event MinesBust(uint256 indexed betId, uint8 cellIdx, uint32 minesBitmap);
    event MinesCashout(uint256 indexed betId, uint8 cellsOpened, uint256 payout, uint256 multiplierX100);

    function placeMinesBet(uint8 mineCount, bytes32 clientSeed)
        external payable nonReentrant whenNotPaused whenGameLive(GameType.MINES)
        returns (uint256 betId)
    {
        if (mineCount < 1 || mineCount > 24) revert InvalidBet("mineCount");
        uint256 maxPayout = (msg.value * MINES_MAX_MULT_X100) / 100;
        bytes memory params = abi.encode(mineCount);
        betId = _openBet(GameType.MINES, msg.value, clientSeed, maxPayout, params);
        minesState[betId].mineCount = mineCount;
    }

    function revealMinesSeed(uint256 betId, bytes32 serverSeed) external nonReentrant {
        if (betId >= _bets.length) revert BetNotFound();
        Bet storage bet = _bets[betId];
        if (bet.game != GameType.MINES) revert InvalidGame();
        if (bet.status != 0) revert BetAlreadySettled();

        if (CommitReveal.isExpired(bet.commitBlock)) { _refund(betId, "expired blockhash"); return; }
        CommitReveal.requireRevealable(bet.commitBlock);

        bytes32 storedSeed = revealedSeed[bet.seedIdx];
        if (storedSeed == bytes32(0)) {
            CommitReveal.requireSeedMatches(serverSeed, seedHashes[bet.seedIdx]);
            revealedSeed[bet.seedIdx] = serverSeed;
            storedSeed = serverSeed;
        }
        bytes32 randomness = CommitReveal.deriveRandomness(storedSeed, bet.clientSeed, bet.commitBlock, bet.nonce);
        bet.randomness = randomness;

        MinesState storage ms = minesState[betId];
        ms.minesBitmap = _selectMines(randomness, ms.mineCount);
        ms.seedRevealed = true;
        emit MinesSeedRevealed(betId, ms.minesBitmap);
    }

    function openMinesCell(uint256 betId, uint8 cellIdx) external nonReentrant {
        Bet storage bet = _bets[betId];
        MinesState storage ms = minesState[betId];
        if (bet.game != GameType.MINES) revert InvalidGame();
        if (bet.player != msg.sender) revert InvalidBet("not player");
        if (bet.status != 0) revert BetAlreadySettled();
        if (!ms.seedRevealed) revert InvalidBet("seed not revealed");
        if (ms.busted) revert InvalidBet("busted");
        if (cellIdx >= 25) revert InvalidBet("cell oob");
        uint32 mask = uint32(1) << cellIdx;
        if (ms.openedBitmap & mask != 0) revert InvalidBet("already opened");
        if (ms.minesBitmap & mask != 0) {
            ms.busted = true;
            bet.status = 1; bet.won = false; bet.payout = 0;
            uint256 reserveAdd = _maxPayoutOf(bet) - bet.amount;
            lockedReserve -= reserveAdd;
            emit MinesBust(betId, cellIdx, ms.minesBitmap);
            _emitSettled(betId, revealedSeed[bet.seedIdx], bet.randomness, false, 0,
                abi.encode(uint8(0), ms.openedBitmap, ms.minesBitmap, true));
            return;
        }
        ms.openedBitmap |= mask;
        uint256 multX100 = _minesMultiplierX100(_popcount25(ms.openedBitmap), ms.mineCount);
        emit MinesCellOpened(betId, cellIdx, ms.openedBitmap, multX100);
    }

    function cashoutMines(uint256 betId) external nonReentrant {
        Bet storage bet = _bets[betId];
        MinesState storage ms = minesState[betId];
        if (bet.game != GameType.MINES) revert InvalidGame();
        if (bet.player != msg.sender) revert InvalidBet("not player");
        if (bet.status != 0) revert BetAlreadySettled();
        if (!ms.seedRevealed) revert InvalidBet("seed not revealed");
        if (ms.busted) revert InvalidBet("busted");
        uint8 k = _popcount25(ms.openedBitmap);
        if (k == 0) revert InvalidBet("nothing opened");

        uint256 multX100 = _minesMultiplierX100(k, ms.mineCount);
        uint256 payout = (uint256(bet.amount) * multX100) / 100;

        bet.status = 1; bet.won = true; bet.payout = uint128(payout);
        uint256 reserveAdd = _maxPayoutOf(bet) - bet.amount;
        lockedReserve -= reserveAdd;
        pendingWithdrawals[bet.player] += payout;
        totalPendingWithdrawals += payout;
        emit WithdrawalCredited(bet.player, payout);
        emit MinesCashout(betId, k, payout, multX100);
        _emitSettled(betId, revealedSeed[bet.seedIdx], bet.randomness, true, payout,
            abi.encode(k, ms.openedBitmap, ms.minesBitmap, false));
    }

    function _popcount25(uint32 x) internal pure returns (uint8 c) {
        for (uint8 i; i < 25; i++) if (x & (uint32(1) << i) != 0) c++;
    }

    function _minesMultiplierX100(uint8 k, uint8 mines) internal view returns (uint256) {
        if (k == 0) return 100;
        uint256 edge = houseEdgeBps(GameType.MINES);
        uint256 num = 1;
        uint256 den = 1;
        for (uint8 i; i < k; i++) {
            num *= (25 - uint256(i));
            den *= (25 - uint256(mines) - uint256(i));
            uint256 g = _gcd(num, den);
            num /= g; den /= g;
        }
        uint256 multX100 = (num * (10000 - edge) * 100) / (den * 10000);
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

    // =====================================================================
    // PLINKO  (per-bet · unchanged)
    // =====================================================================

    function placeplinkoBet(uint8 risk, bytes32 clientSeed)
        external payable nonReentrant whenNotPaused whenGameLive(GameType.PLINKO)
        returns (uint256 betId)
    {
        if (risk > 2) revert InvalidBet("risk");
        uint256 maxPayout = (msg.value * _plinkoMaxX100(risk)) / 100;
        bytes memory params = abi.encode(risk);
        return _openBet(GameType.PLINKO, msg.value, clientSeed, maxPayout, params);
    }

    function _plinkoPayoutAt(uint8 risk, uint8 slot) internal pure returns (uint32) {
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

    function _plinkoMaxX100(uint8 risk) internal pure returns (uint256) {
        if (risk == 0) return 1600;
        if (risk == 1) return 11000;
        return 100000;
    }

    // =====================================================================
    // CRASH  (round-based)
    // =====================================================================

    uint256 public constant CRASH_BET_WINDOW = 30 seconds;
    uint256 public constant CRASH_ROUND_TIMEOUT = 5 minutes;
    uint256 public constant CRASH_MIN_AUTOCASHOUT = 101;
    uint256 public constant CRASH_MAX_AUTOCASHOUT = 10000;

    struct CrashRound {
        uint64 roundId;
        uint64 betWindowEnd;     // block.timestamp
        uint64 commitBlock;      // block.number when the round opened
        uint32 seedIdx;
        bool   settled;
        uint16 crashPointX100;   // set on settle
        bytes32 serverSeed;      // revealed on settle
        address[] bettors;
    }
    struct CrashBet {
        uint96  amount;
        uint16  autoCashoutX100;   // 0 if manual-only
        uint16  cashoutMultX100;   // 0 until player requests
        bool    resolved;
    }
    CrashRound[] private _crashRounds;
    mapping(uint256 => mapping(address => CrashBet)) public crashBets;
    uint256 public currentCrashRoundId; // type uint256 (matches public getter), +1 past last
    bool    private _hasOpenCrashRound;

    event CrashRoundStarted(uint256 indexed roundId, uint256 betWindowEnd, uint256 commitBlock, uint256 seedIdx);
    event CrashBetPlaced(uint256 indexed roundId, address indexed player, uint256 amount, uint256 autoCashoutX100);
    event CrashCashoutRequested(uint256 indexed roundId, address indexed player, uint256 multX100);
    event CrashRoundSettled(uint256 indexed roundId, uint256 crashPointX100, bytes32 serverSeed, bytes32 randomness, bytes32 blockHash);
    event CrashRoundRefunded(uint256 indexed roundId, string reason);

    /// @notice Anyone (typically the HM cron) can open a new round. There can
    ///         be at most one open round at a time.
    function startCrashRound() external whenNotPaused whenGameLive(GameType.CRASH) {
        if (_hasOpenCrashRound) revert RoundClosed();
        if (nextHashIndex >= seedHashes.length) revert NoSeedAvailable();
        uint32 seedIdx = uint32(nextHashIndex++);
        uint64 commitBlock = uint64(block.number);
        uint64 betWindowEnd = uint64(block.timestamp + CRASH_BET_WINDOW);
        _crashRounds.push();
        CrashRound storage r = _crashRounds[_crashRounds.length - 1];
        r.roundId = uint64(_crashRounds.length - 1);
        r.betWindowEnd = betWindowEnd;
        r.commitBlock = commitBlock;
        r.seedIdx = seedIdx;
        currentCrashRoundId = r.roundId;
        _hasOpenCrashRound = true;
        emit CrashRoundStarted(r.roundId, betWindowEnd, commitBlock, seedIdx);
    }

    function placeCrashBet(uint256 autoCashoutX100)
        external payable nonReentrant whenNotPaused whenGameLive(GameType.CRASH)
    {
        if (!_hasOpenCrashRound || _crashRounds.length == 0) revert RoundNotFound();
        if (autoCashoutX100 != 0 &&
            (autoCashoutX100 < CRASH_MIN_AUTOCASHOUT || autoCashoutX100 > CRASH_MAX_AUTOCASHOUT))
            revert InvalidBet("autoCashout");
        CrashRound storage r = _crashRounds[currentCrashRoundId];
        if (block.timestamp >= r.betWindowEnd) revert RoundClosed();
        if (msg.value == 0) revert InvalidBet("zero stake");
        // Per-game cap + 1% bankroll cap
        if (gameMaxBet[GameType.CRASH] > 0 && msg.value > gameMaxBet[GameType.CRASH]) revert BetTooLarge();
        uint256 free = freeBankroll();
        uint256 bpsCap = (free * maxBetBps) / 10000;
        if (bpsCap > 0 && msg.value > bpsCap) revert BetTooLarge();
        // Reserve up to MAX_AUTOCASHOUT × stake (worst-case payout for this player).
        uint256 maxPayout = (msg.value * (autoCashoutX100 == 0 ? CRASH_MAX_AUTOCASHOUT : autoCashoutX100)) / 100;
        if (maxPayout < msg.value) revert InvalidBet("payout < stake");
        uint256 reserveAdd = maxPayout - msg.value;
        if (reserveAdd > free + msg.value) revert BankrollInsufficient();
        lockedReserve += reserveAdd;

        CrashBet storage cb = crashBets[r.roundId][msg.sender];
        // One bet per player per round. Allowing a second placeCrashBet would
        // overwrite the autoCashout while keeping a stale reserve from the
        // first one → lockedReserve underflow at settle.
        if (cb.amount != 0) revert InvalidBet("already bet this round");
        r.bettors.push(msg.sender);
        cb.amount = uint96(msg.value);
        cb.autoCashoutX100 = uint16(autoCashoutX100);
        emit CrashBetPlaced(r.roundId, msg.sender, msg.value, autoCashoutX100);
    }

    function requestCashout(uint256 multX100)
        external nonReentrant whenGameLive(GameType.CRASH)
    {
        if (!_hasOpenCrashRound || _crashRounds.length == 0) revert RoundNotFound();
        CrashRound storage r = _crashRounds[currentCrashRoundId];
        if (block.timestamp < r.betWindowEnd) revert RoundClosed(); // betting still open
        if (r.settled) revert RoundAlreadySettled();
        if (multX100 < CRASH_MIN_AUTOCASHOUT) revert CashoutTooLow();
        CrashBet storage cb = crashBets[r.roundId][msg.sender];
        if (cb.amount == 0) revert BetNotFound();
        if (cb.cashoutMultX100 != 0) revert BetAlreadySettled();
        cb.cashoutMultX100 = uint16(multX100);
        emit CrashCashoutRequested(r.roundId, msg.sender, multX100);
    }

    /// @notice Anyone (typically reveal-bot) can settle once the bet window
    ///         has closed and the future blockhash is available.
    function settleCrashRound(uint256 roundId, bytes32 serverSeed) external nonReentrant {
        if (roundId >= _crashRounds.length) revert RoundNotFound();
        CrashRound storage r = _crashRounds[roundId];
        if (r.settled) revert RoundAlreadySettled();
        if (block.timestamp < r.betWindowEnd) revert RoundClosed();
        if (CommitReveal.isExpired(r.commitBlock)) {
            _refundCrashRound(roundId, "expired blockhash");
            return;
        }
        CommitReveal.requireRevealable(r.commitBlock);
        bytes32 stored = revealedSeed[r.seedIdx];
        if (stored == bytes32(0)) {
            CommitReveal.requireSeedMatches(serverSeed, seedHashes[r.seedIdx]);
            revealedSeed[r.seedIdx] = serverSeed;
            stored = serverSeed;
        }
        bytes32 blockHash = blockhash(uint256(r.commitBlock) + CommitReveal.REVEAL_DELAY);
        bytes32 randomness = keccak256(abi.encodePacked(stored, blockHash, r.roundId));
        uint256 cp = _crashPoint(randomness);
        r.crashPointX100 = uint16(cp > type(uint16).max ? type(uint16).max : cp);
        r.serverSeed = stored;
        r.settled = true;
        _hasOpenCrashRound = false;
        emit CrashRoundSettled(r.roundId, cp, stored, randomness, blockHash);

        // Resolve every player in the round.
        for (uint256 i; i < r.bettors.length; i++) {
            address p = r.bettors[i];
            CrashBet storage cb = crashBets[r.roundId][p];
            if (cb.resolved) continue;
            cb.resolved = true;
            uint256 stake = cb.amount;
            uint256 maxReserveMult = cb.autoCashoutX100 == 0 ? CRASH_MAX_AUTOCASHOUT : cb.autoCashoutX100;
            uint256 reservedMax = (stake * maxReserveMult) / 100;
            uint256 reserveAdd = reservedMax - stake;
            lockedReserve -= reserveAdd;
            uint256 effective = 0;
            if (cb.autoCashoutX100 > 0 && cb.autoCashoutX100 <= cp) effective = cb.autoCashoutX100;
            if (cb.cashoutMultX100 > 0 && cb.cashoutMultX100 <= cp && cb.cashoutMultX100 > effective)
                effective = cb.cashoutMultX100;
            if (effective > 0) {
                uint256 payout = (stake * effective) / 100;
                pendingWithdrawals[p] += payout;
                totalPendingWithdrawals += payout;
                emit WithdrawalCredited(p, payout);
                emit BetSettled(uint256(r.roundId), p, GameType.CRASH, true, payout,
                    randomness, stored, bytes32(0), blockHash, r.roundId,
                    abi.encode(cp, effective));
            } else {
                emit BetSettled(uint256(r.roundId), p, GameType.CRASH, false, 0,
                    randomness, stored, bytes32(0), blockHash, r.roundId,
                    abi.encode(cp, uint256(0)));
            }
        }
        _circuitBreakerTick();
    }

    /// @notice Anyone can call once the blockhash window for the round has
    ///         lapsed without a settle; refunds every bettor.
    function refundCrashRound(uint256 roundId) external nonReentrant {
        if (roundId >= _crashRounds.length) revert RoundNotFound();
        CrashRound storage r = _crashRounds[roundId];
        if (r.settled) revert RoundAlreadySettled();
        if (block.timestamp < r.betWindowEnd + CRASH_ROUND_TIMEOUT &&
            !CommitReveal.isExpired(r.commitBlock)) revert RoundNotSettleable();
        _refundCrashRound(roundId, "round timeout");
    }

    function _refundCrashRound(uint256 roundId, string memory reason) internal {
        CrashRound storage r = _crashRounds[roundId];
        for (uint256 i; i < r.bettors.length; i++) {
            address p = r.bettors[i];
            CrashBet storage cb = crashBets[r.roundId][p];
            if (cb.resolved) continue;
            cb.resolved = true;
            uint256 stake = cb.amount;
            uint256 maxReserveMult = cb.autoCashoutX100 == 0 ? CRASH_MAX_AUTOCASHOUT : cb.autoCashoutX100;
            uint256 reservedMax = (stake * maxReserveMult) / 100;
            uint256 reserveAdd = reservedMax - stake;
            lockedReserve -= reserveAdd;
            pendingWithdrawals[p] += stake;
            totalPendingWithdrawals += stake;
            emit WithdrawalCredited(p, stake);
        }
        r.settled = true;
        _hasOpenCrashRound = false;
        emit CrashRoundRefunded(roundId, reason);
    }

    function totalCrashRounds() external view returns (uint256) { return _crashRounds.length; }

    function getCrashRound(uint256 roundId) external view returns (
        uint64 id, uint64 betWindowEnd, uint64 commitBlock, uint32 seedIdx,
        bool settled, uint16 crashPointX100, bytes32 serverSeed, uint256 bettorCount
    ) {
        if (roundId >= _crashRounds.length) revert RoundNotFound();
        CrashRound storage r = _crashRounds[roundId];
        return (r.roundId, r.betWindowEnd, r.commitBlock, r.seedIdx, r.settled,
                r.crashPointX100, r.serverSeed, r.bettors.length);
    }

    function getCrashBettors(uint256 roundId) external view returns (address[] memory) {
        if (roundId >= _crashRounds.length) revert RoundNotFound();
        return _crashRounds[roundId].bettors;
    }

    function getCrashBet(uint256 roundId, address player) external view returns (CrashBet memory) {
        return crashBets[roundId][player];
    }

    function _crashPoint(bytes32 randomness) internal view returns (uint256) {
        uint256 e = 1 << 52;
        uint256 h = uint256(randomness) % e;
        uint256 num = 10000 - houseEdgeBps(GameType.CRASH);
        if (h % 33 == 0) return 100;
        uint256 cp = (num * e) / (100 * (e - h));
        return cp < 100 ? 100 : cp;
    }

    // =====================================================================
    // ROULETTE  (round-based · up to 5 bets per player per round)
    // =====================================================================

    uint256 public constant ROULETTE_BET_WINDOW = 30 seconds;
    uint256 public constant ROULETTE_ROUND_TIMEOUT = 5 minutes;
    uint8   public constant ROULETTE_MAX_BETS_PER_PLAYER = 5;

    enum RouletteBetKind {
        STRAIGHT, RED, BLACK, EVEN, ODD, LOW, HIGH, DOZEN_1, DOZEN_2, DOZEN_3
    }

    uint64 internal constant RED_MASK =
        (uint64(1) << 1) | (uint64(1) << 3) | (uint64(1) << 5) |
        (uint64(1) << 7) | (uint64(1) << 9) | (uint64(1) << 12) |
        (uint64(1) << 14) | (uint64(1) << 16) | (uint64(1) << 18) |
        (uint64(1) << 19) | (uint64(1) << 21) | (uint64(1) << 23) |
        (uint64(1) << 25) | (uint64(1) << 27) | (uint64(1) << 30) |
        (uint64(1) << 32) | (uint64(1) << 34) | (uint64(1) << 36);

    struct RouletteBetInput {
        uint8  kind;    // RouletteBetKind cast
        uint8  number;  // for straight
        uint96 amount;
    }

    struct RouletteRound {
        uint64 roundId;
        uint64 betWindowEnd;
        uint64 commitBlock;
        uint32 seedIdx;
        bool   settled;
        uint8  resultNumber;
        bytes32 serverSeed;
        address[] bettors;
    }

    RouletteRound[] private _rouletteRounds;
    mapping(uint256 => mapping(address => RouletteBetInput[])) public rouletteBets;
    uint256 public currentRouletteRoundId;
    bool    private _hasOpenRouletteRound;

    event RouletteRoundStarted(uint256 indexed roundId, uint256 betWindowEnd, uint256 commitBlock, uint256 seedIdx);
    event RouletteBetPlaced(uint256 indexed roundId, address indexed player, uint8 kind, uint8 number, uint256 amount);
    event RouletteRoundSettled(uint256 indexed roundId, uint8 resultNumber, bytes32 serverSeed, bytes32 randomness);
    event RouletteRoundRefunded(uint256 indexed roundId, string reason);

    function startRouletteRound() external whenNotPaused whenGameLive(GameType.ROULETTE) {
        if (_hasOpenRouletteRound) revert RoundClosed();
        if (nextHashIndex >= seedHashes.length) revert NoSeedAvailable();
        uint32 seedIdx = uint32(nextHashIndex++);
        _rouletteRounds.push();
        RouletteRound storage r = _rouletteRounds[_rouletteRounds.length - 1];
        r.roundId = uint64(_rouletteRounds.length - 1);
        r.betWindowEnd = uint64(block.timestamp + ROULETTE_BET_WINDOW);
        r.commitBlock = uint64(block.number);
        r.seedIdx = seedIdx;
        currentRouletteRoundId = r.roundId;
        _hasOpenRouletteRound = true;
        emit RouletteRoundStarted(r.roundId, r.betWindowEnd, r.commitBlock, seedIdx);
    }

    function placeRouletteBets(RouletteBetInput[] calldata bets)
        external payable nonReentrant whenNotPaused whenGameLive(GameType.ROULETTE)
    {
        if (!_hasOpenRouletteRound || _rouletteRounds.length == 0) revert RoundNotFound();
        RouletteRound storage r = _rouletteRounds[currentRouletteRoundId];
        if (block.timestamp >= r.betWindowEnd) revert RoundClosed();
        if (bets.length == 0) revert InvalidBet("no bets");
        RouletteBetInput[] storage list = rouletteBets[r.roundId][msg.sender];
        if (list.length + bets.length > ROULETTE_MAX_BETS_PER_PLAYER) revert TooManyBets();
        uint256 total = 0;
        uint256 reserveAdd = 0;
        for (uint256 i; i < bets.length; i++) {
            RouletteBetInput calldata b = bets[i];
            if (b.amount == 0) revert InvalidBet("zero stake");
            if (b.kind > uint8(RouletteBetKind.DOZEN_3)) revert InvalidBet("kind");
            if (b.kind == uint8(RouletteBetKind.STRAIGHT) && b.number > 36) revert InvalidBet("number");
            total += b.amount;
            uint256 mult = _rouletteMultiplier(b.kind);
            uint256 maxPayout = uint256(b.amount) * mult;
            reserveAdd += (maxPayout - b.amount);
            list.push(b);
        }
        if (total != msg.value) revert InvalidBet("value sum");
        // Stake & bankroll caps applied to the *sum* (treat one tx as one bet
        // for cap purposes — multi-bet is convenience, not a way to dodge caps).
        if (gameMaxBet[GameType.ROULETTE] > 0 && total > gameMaxBet[GameType.ROULETTE]) revert BetTooLarge();
        uint256 free = freeBankroll();
        uint256 bpsCap = (free * maxBetBps) / 10000;
        if (bpsCap > 0 && total > bpsCap) revert BetTooLarge();
        if (reserveAdd > free + total) revert BankrollInsufficient();
        lockedReserve += reserveAdd;
        if (list.length == bets.length) r.bettors.push(msg.sender);
        for (uint256 i; i < bets.length; i++) {
            emit RouletteBetPlaced(r.roundId, msg.sender, bets[i].kind, bets[i].number, bets[i].amount);
        }
    }

    function settleRouletteRound(uint256 roundId, bytes32 serverSeed) external nonReentrant {
        if (roundId >= _rouletteRounds.length) revert RoundNotFound();
        RouletteRound storage r = _rouletteRounds[roundId];
        if (r.settled) revert RoundAlreadySettled();
        if (block.timestamp < r.betWindowEnd) revert RoundClosed();
        if (CommitReveal.isExpired(r.commitBlock)) { _refundRouletteRound(roundId, "expired blockhash"); return; }
        CommitReveal.requireRevealable(r.commitBlock);
        bytes32 stored = revealedSeed[r.seedIdx];
        if (stored == bytes32(0)) {
            CommitReveal.requireSeedMatches(serverSeed, seedHashes[r.seedIdx]);
            revealedSeed[r.seedIdx] = serverSeed;
            stored = serverSeed;
        }
        bytes32 blockHash = blockhash(uint256(r.commitBlock) + CommitReveal.REVEAL_DELAY);
        bytes32 randomness = keccak256(abi.encodePacked(stored, blockHash, r.roundId));
        uint8 result = uint8(uint256(randomness) % 37);
        r.resultNumber = result;
        r.serverSeed = stored;
        r.settled = true;
        _hasOpenRouletteRound = false;
        emit RouletteRoundSettled(r.roundId, result, stored, randomness);

        for (uint256 i; i < r.bettors.length; i++) {
            address p = r.bettors[i];
            RouletteBetInput[] storage bets = rouletteBets[r.roundId][p];
            uint256 totalStake = 0;
            uint256 totalPayout = 0;
            for (uint256 j; j < bets.length; j++) {
                totalStake += bets[j].amount;
                uint256 mult = _rouletteMultiplier(bets[j].kind);
                uint256 reserveAdd = uint256(bets[j].amount) * mult - bets[j].amount;
                lockedReserve -= reserveAdd;
                if (_rouletteWins(bets[j].kind, bets[j].number, result)) {
                    totalPayout += uint256(bets[j].amount) * mult;
                }
            }
            if (totalPayout > 0) {
                pendingWithdrawals[p] += totalPayout;
                totalPendingWithdrawals += totalPayout;
                emit WithdrawalCredited(p, totalPayout);
                emit BetSettled(uint256(r.roundId), p, GameType.ROULETTE, true, totalPayout,
                    randomness, stored, bytes32(0), blockHash, r.roundId,
                    abi.encode(result, totalStake, totalPayout));
            } else {
                emit BetSettled(uint256(r.roundId), p, GameType.ROULETTE, false, 0,
                    randomness, stored, bytes32(0), blockHash, r.roundId,
                    abi.encode(result, totalStake, uint256(0)));
            }
        }
        _circuitBreakerTick();
    }

    function refundRouletteRound(uint256 roundId) external nonReentrant {
        if (roundId >= _rouletteRounds.length) revert RoundNotFound();
        RouletteRound storage r = _rouletteRounds[roundId];
        if (r.settled) revert RoundAlreadySettled();
        if (block.timestamp < r.betWindowEnd + ROULETTE_ROUND_TIMEOUT &&
            !CommitReveal.isExpired(r.commitBlock)) revert RoundNotSettleable();
        _refundRouletteRound(roundId, "round timeout");
    }

    function _refundRouletteRound(uint256 roundId, string memory reason) internal {
        RouletteRound storage r = _rouletteRounds[roundId];
        for (uint256 i; i < r.bettors.length; i++) {
            address p = r.bettors[i];
            RouletteBetInput[] storage bets = rouletteBets[r.roundId][p];
            uint256 totalStake = 0;
            for (uint256 j; j < bets.length; j++) {
                totalStake += bets[j].amount;
                uint256 mult = _rouletteMultiplier(bets[j].kind);
                uint256 reserveAdd = uint256(bets[j].amount) * mult - bets[j].amount;
                lockedReserve -= reserveAdd;
            }
            pendingWithdrawals[p] += totalStake;
            totalPendingWithdrawals += totalStake;
            emit WithdrawalCredited(p, totalStake);
        }
        r.settled = true;
        _hasOpenRouletteRound = false;
        emit RouletteRoundRefunded(roundId, reason);
    }

    function totalRouletteRounds() external view returns (uint256) { return _rouletteRounds.length; }

    function getRouletteRound(uint256 roundId) external view returns (
        uint64 id, uint64 betWindowEnd, uint64 commitBlock, uint32 seedIdx,
        bool settled, uint8 resultNumber, bytes32 serverSeed, uint256 bettorCount
    ) {
        if (roundId >= _rouletteRounds.length) revert RoundNotFound();
        RouletteRound storage r = _rouletteRounds[roundId];
        return (r.roundId, r.betWindowEnd, r.commitBlock, r.seedIdx, r.settled,
                r.resultNumber, r.serverSeed, r.bettors.length);
    }

    function getRouletteBettors(uint256 roundId) external view returns (address[] memory) {
        if (roundId >= _rouletteRounds.length) revert RoundNotFound();
        return _rouletteRounds[roundId].bettors;
    }

    function getRouletteBets(uint256 roundId, address player) external view returns (RouletteBetInput[] memory) {
        return rouletteBets[roundId][player];
    }

    function _rouletteMultiplier(uint8 kind) internal pure returns (uint256) {
        if (kind == uint8(RouletteBetKind.STRAIGHT)) return 36;
        if (kind == uint8(RouletteBetKind.DOZEN_1) ||
            kind == uint8(RouletteBetKind.DOZEN_2) ||
            kind == uint8(RouletteBetKind.DOZEN_3)) return 3;
        return 2;
    }

    function _rouletteWins(uint8 kind, uint8 target, uint8 result) internal pure returns (bool) {
        if (result > 36) return false;
        if (kind == uint8(RouletteBetKind.STRAIGHT)) return result == target;
        if (result == 0) return false;
        if (kind == uint8(RouletteBetKind.RED))   return ((RED_MASK >> result) & 1) == 1;
        if (kind == uint8(RouletteBetKind.BLACK)) return ((RED_MASK >> result) & 1) == 0;
        if (kind == uint8(RouletteBetKind.EVEN))  return result % 2 == 0;
        if (kind == uint8(RouletteBetKind.ODD))   return result % 2 == 1;
        if (kind == uint8(RouletteBetKind.LOW))   return result >= 1 && result <= 18;
        if (kind == uint8(RouletteBetKind.HIGH))  return result >= 19 && result <= 36;
        if (kind == uint8(RouletteBetKind.DOZEN_1)) return result >= 1 && result <= 12;
        if (kind == uint8(RouletteBetKind.DOZEN_2)) return result >= 13 && result <= 24;
        if (kind == uint8(RouletteBetKind.DOZEN_3)) return result >= 25 && result <= 36;
        return false;
    }

    // =====================================================================
    // Generic per-bet open / reveal / refund (shared by Dice/Slots/Mines/Plinko)
    // =====================================================================

    function _openBet(
        GameType g,
        uint256 amount,
        bytes32 clientSeed,
        uint256 maxPayout,
        bytes memory params
    ) internal returns (uint256 betId) {
        if (amount == 0) revert InvalidBet("zero stake");
        uint256 cap = gameMaxBet[g];
        if (cap > 0 && amount > cap) revert BetTooLarge();

        uint256 free = freeBankroll();
        uint256 bpsCap = (free * maxBetBps) / 10000;
        if (bpsCap > 0 && amount > bpsCap) revert BetTooLarge();

        if (maxPayout < amount) revert InvalidBet("payout < stake");
        uint256 reserveAdd = maxPayout - amount;
        if (reserveAdd > free + amount) revert BankrollInsufficient();

        if (nextHashIndex >= seedHashes.length) revert NoSeedAvailable();
        uint256 seedIdx = nextHashIndex++;

        _circuitBreakerTick();

        betId = _bets.length;
        _bets.push(Bet({
            player: msg.sender,
            amount: uint96(amount),
            game: g,
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
        lockedReserve += reserveAdd;
        _recordPlayerBet(msg.sender, betId);

        emit BetPlaced(betId, msg.sender, g, amount, clientSeed, block.number, seedIdx, params);
    }

    function revealAndSettle(uint256 betId, bytes32 serverSeed) external nonReentrant {
        if (betId >= _bets.length) revert BetNotFound();
        Bet storage bet = _bets[betId];
        if (bet.status != 0) revert BetAlreadySettled();
        if (bet.game == GameType.MINES) revert InvalidGame();
        // CRASH / ROULETTE settle through their round paths, not here.
        if (bet.game == GameType.CRASH || bet.game == GameType.ROULETTE) revert InvalidGame();

        if (CommitReveal.isExpired(bet.commitBlock)) { _refund(betId, "expired blockhash"); return; }
        CommitReveal.requireRevealable(bet.commitBlock);

        bytes32 storedSeed = revealedSeed[bet.seedIdx];
        if (storedSeed == bytes32(0)) {
            CommitReveal.requireSeedMatches(serverSeed, seedHashes[bet.seedIdx]);
            revealedSeed[bet.seedIdx] = serverSeed;
            storedSeed = serverSeed;
        }

        _settle(betId, storedSeed);
        _circuitBreakerTick();
    }

    /// @dev Was this bet placed as a free spin? Encoded in bet.params for
    ///      SLOTS and CLUSTER as the first abi-encoded bool.
    function _isFreeSpin(Bet storage bet) internal view returns (bool) {
        if (bet.game != GameType.SLOTS && bet.game != GameType.CLUSTER) return false;
        if (bet.params.length < 32) return false;
        // First 32 bytes of an abi.encode(bool) is the bool padded.
        bytes memory p = bet.params;
        return uint256(bytes32(p)) != 0;
    }

    function _settle(uint256 betId, bytes32 storedSeed) internal {
        Bet storage bet = _bets[betId];
        bytes32 randomness = CommitReveal.deriveRandomness(storedSeed, bet.clientSeed, bet.commitBlock, bet.nonce);
        (bool won, uint256 payout, bytes memory resultData) = _resolve(bet, randomness);

        bet.status = 1; bet.randomness = randomness; bet.won = won; bet.payout = uint128(payout);
        // Free-spin bets reserved the FULL maxPayout (no user contribution).
        // Regular bets reserved maxPayout - stake.
        uint256 reserveRelease = _isFreeSpin(bet)
            ? _maxPayoutOf(bet)
            : _maxPayoutOf(bet) - bet.amount;
        lockedReserve -= reserveRelease;
        if (won && payout > 0) {
            pendingWithdrawals[bet.player] += payout;
            totalPendingWithdrawals += payout;
            emit WithdrawalCredited(bet.player, payout);
        }
        _emitSettled(betId, storedSeed, randomness, won, payout, resultData);
    }

    function _emitSettled(
        uint256 betId, bytes32 storedSeed, bytes32 randomness,
        bool won, uint256 payout, bytes memory resultData
    ) internal {
        Bet storage bet = _bets[betId];
        emit BetSettled(
            betId, bet.player, bet.game, won, payout,
            randomness, storedSeed, bet.clientSeed,
            blockhash(bet.commitBlock + CommitReveal.REVEAL_DELAY),
            bet.nonce, resultData
        );
    }

    function _resolve(Bet storage bet, bytes32 randomness)
        internal view
        returns (bool won, uint256 payout, bytes memory resultData)
    {
        if (bet.game == GameType.DICE) {
            (uint8 target, bool over) = abi.decode(bet.params, (uint8, bool));
            uint256 roll = (uint256(randomness) % 100) + 1;
            won = over ? roll > target : roll < target;
            if (won) {
                uint256 winChance = over ? uint256(100 - target) : uint256(target - 1);
                payout = _dicePayout(bet.amount, winChance);
            }
            resultData = abi.encode(roll);
            return (won, payout, resultData);
        }
        if (bet.game == GameType.SLOTS) {
            bool useFreeSpin = _isFreeSpin(bet);
            uint256 freeMult = useFreeSpin ? VAULT7_FREE_SPIN_MULT_X100 : 100;
            (uint256 p, uint8[15] memory grid, uint256 lineMult, uint8 scatterCount, uint256 scatterPay) =
                Vault7Lib.resolve(bet.amount, randomness, houseEdgeBps(GameType.SLOTS), freeMult);
            payout = p;
            // For a free spin, ANY non-zero payout is a "win" (we don't have a
            // stake to compare against on the user side).
            won = useFreeSpin ? (payout > 0) : (payout >= bet.amount);
            resultData = abi.encode(grid, lineMult, scatterCount, scatterPay, useFreeSpin);
            return (won, payout, resultData);
        }
        if (bet.game == GameType.CLUSTER) {
            ClusterLib.ResolveResult memory rr = ClusterLib.resolve(randomness);
            // ClusterLib.totalPayoutX100 is basis-100 of stake. Apply house edge.
            uint256 stake = bet.amount;
            uint256 edge = houseEdgeBps(GameType.CLUSTER);
            uint256 raw = (stake * rr.totalPayoutX100) / 100;
            uint256 capped = (stake * CLUSTER_MAX_MULT_X100) / 100;
            payout = (raw * (10000 - edge)) / 10000;
            if (payout > capped) payout = capped;
            bool useFreeSpin = _isFreeSpin(bet);
            won = useFreeSpin ? (payout > 0) : (payout >= bet.amount);
            resultData = abi.encode(rr.finalGrid, rr.totalPayoutX100, rr.scatterCount, rr.cascadeDepth, useFreeSpin);
            return (won, payout, resultData);
        }
        if (bet.game == GameType.PLINKO) {
            uint8 risk = abi.decode(bet.params, (uint8));
            uint256 r = uint256(randomness);
            uint8 slot = 0;
            for (uint8 i; i < 16; i++) if ((r >> i) & 1 == 1) slot++;
            uint32 payX100 = _plinkoPayoutAt(risk, slot);
            payout = (uint256(bet.amount) * payX100) / 100;
            won = payout >= bet.amount;
            resultData = abi.encode(uint16(r & 0xFFFF), slot, payX100);
            return (won, payout, resultData);
        }
        revert InvalidGame();
    }

    function _maxPayoutOf(Bet storage bet) internal view returns (uint256) {
        if (bet.game == GameType.DICE) {
            (uint8 target, bool over) = abi.decode(bet.params, (uint8, bool));
            uint256 winChance = over ? uint256(100 - target) : uint256(target - 1);
            return _dicePayout(bet.amount, winChance);
        }
        if (bet.game == GameType.SLOTS)   return (uint256(bet.amount) * VAULT7_MAX_MULT_X100) / 100;
        if (bet.game == GameType.CLUSTER) return (uint256(bet.amount) * CLUSTER_MAX_MULT_X100) / 100;
        if (bet.game == GameType.MINES)  return (uint256(bet.amount) * MINES_MAX_MULT_X100) / 100;
        if (bet.game == GameType.PLINKO) {
            uint8 risk = abi.decode(bet.params, (uint8));
            return (uint256(bet.amount) * _plinkoMaxX100(risk)) / 100;
        }
        revert InvalidGame();
    }

    function _refund(uint256 betId, string memory reason) internal {
        Bet storage bet = _bets[betId];
        bet.status = 2;
        uint256 maxPayout = _maxPayoutOf(bet);
        bool isFree = _isFreeSpin(bet);
        // Free-spin reserves the FULL maxPayout (no user stake in the pot).
        uint256 reserveRelease = isFree ? maxPayout : maxPayout - bet.amount;
        lockedReserve -= reserveRelease;
        if (isFree) {
            // Player didn't actually pay anything — give the free spin back
            // instead of crediting a stake refund.
            playerSlotState[bet.player].freeSpinsUsed -= 1;
            emit BetRefunded(betId, bet.player, 0, reason);
            return;
        }
        pendingWithdrawals[bet.player] += bet.amount;
        totalPendingWithdrawals += bet.amount;
        emit WithdrawalCredited(bet.player, bet.amount);
        emit BetRefunded(betId, bet.player, bet.amount, reason);
    }

    function refundExpired(uint256 betId) external nonReentrant {
        if (betId >= _bets.length) revert BetNotFound();
        Bet storage bet = _bets[betId];
        if (bet.status != 0) revert BetAlreadySettled();
        if (!CommitReveal.isExpired(bet.commitBlock)) revert InvalidBet("not expired");
        _refund(betId, "expired blockhash");
    }

    // ---------------------------------------------------------------------
    // Withdrawals (pull payments)
    // ---------------------------------------------------------------------

    function claim() external nonReentrant {
        uint256 amt = pendingWithdrawals[msg.sender];
        require(amt > 0, "nothing to claim");
        pendingWithdrawals[msg.sender] = 0;
        totalPendingWithdrawals -= amt;
        emit WithdrawalClaimed(msg.sender, amt);
        payable(msg.sender).sendValue(amt);
    }

    // ---------------------------------------------------------------------
    // Owner profit withdraw (24h timelock)
    // ---------------------------------------------------------------------

    function scheduleOwnerWithdraw(uint256 amount) external onlyOwner {
        require(amount > 0, "zero");
        require(amount <= freeBankroll(), "exceeds free");
        ownerWithdrawal = PendingWithdraw({
            amount: uint128(amount),
            readyAt: uint64(block.timestamp + OWNER_WITHDRAW_DELAY)
        });
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

    // ---------------------------------------------------------------------
    // Circuit breaker
    // ---------------------------------------------------------------------

    function _circuitBreakerTick() internal {
        uint256 nowTs = block.timestamp;
        uint256 bankroll = freeBankroll();
        if (hourStartTimestamp == 0) { hourStartTimestamp = nowTs; hourStartBankroll = bankroll; return; }
        if (nowTs - hourStartTimestamp >= 1 hours) { hourStartTimestamp = nowTs; hourStartBankroll = bankroll; return; }
        if (
            hourStartBankroll > 0 && bankroll < hourStartBankroll &&
            (hourStartBankroll - bankroll) * 10000 / hourStartBankroll >= CIRCUIT_BREAKER_LOSS_BPS
        ) {
            for (uint8 i; i < 6; i++) { gamePaused[GameType(i)] = true; emit GamePaused(GameType(i), true); }
            emit CircuitBreakerTripped(hourStartBankroll, bankroll);
            hourStartTimestamp = nowTs; hourStartBankroll = bankroll;
        }
    }
}
