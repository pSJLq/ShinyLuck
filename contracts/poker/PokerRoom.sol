// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IPokerDealer} from "./IPokerDealer.sol";
import {PokerHandEval} from "./PokerHandEval.sol";

/// @title PokerRoom
/// @notice Maximally on-chain No-Limit Texas Hold'em for ShinyPoker on Somnia.
///         One contract hosts many cash tables. EVERY chip movement — buy-in,
///         blinds/antes, each betting action, pots/side-pots, rake, payouts — is
///         on-chain state. The card layer is delegated to a swappable
///         {IPokerDealer} so the secrecy model (commit-reveal → zkShuffle/VRF)
///         can change without touching the engine or the UI.
///
/// @dev    Money model (mirrors ShinyLuck's Casino escrow):
///           - `balance[player]`   in-room bankroll, idle (not at a table).
///           - `Seat.stack`        chips in play at a seat.
///           - payouts credit `Seat.stack` / `balance` (internal), never send
///             ether on the hot path; only {withdraw} sends ether, under
///             nonReentrant. This keeps the betting path reentrancy-free.
///
///         This file (part 1) establishes the data model, escrow, table admin
///         and seating. Hand lifecycle, the betting state machine, pots/rake and
///         showdown are layered on top in the engine sections that follow.
contract PokerRoom is Ownable, ReentrancyGuard, Pausable {
    using Address for address payable;

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    uint8 public constant MAX_SEATS = 9;

    // Streets of a hand.
    uint8 internal constant STREET_PREFLOP = 0;
    uint8 internal constant STREET_FLOP = 1;
    uint8 internal constant STREET_TURN = 2;
    uint8 internal constant STREET_RIVER = 3;
    uint8 internal constant STREET_SHOWDOWN = 4;
    uint8 internal constant STREET_IDLE = 255; // no hand in progress

    uint8 internal constant NO_SEAT = 255;

    /// @dev A player's move on their turn. BET opens a street (currentBet == 0);
    ///      RAISE increases an existing bet; ALLIN pushes the whole stack and is
    ///      interpreted as a call / bet / raise depending on context.
    enum ActionType {
        FOLD,
        CHECK,
        CALL,
        BET,
        RAISE,
        ALLIN
    }

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @dev Immutable-ish per-table parameters. Owner-configured at creation.
    struct TableConfig {
        uint8 maxSeats; // 2 (heads-up), 6, or 9
        uint128 smallBlind;
        uint128 bigBlind;
        uint128 ante; // 0 for a plain cash game
        uint128 minBuyIn;
        uint128 maxBuyIn;
        uint16 rakeBps; // e.g. 250 = 2.5% of each pot
        uint128 rakeCap; // hard cap on rake per hand ("no flop, no drop" handled in engine)
        uint32 actionTimeout; // seconds a player has to act before timeout-fold
        bool active;
    }

    /// @dev A seat at a table. `stack` is the chips currently in play.
    struct Seat {
        address player;
        uint128 stack;
        bool occupied;
        bool sittingOut; // not dealt into new hands
        uint64 sitInHandId; // first handId this seat is eligible to be dealt
        uint64 sitOutSince; // when sittingOut was set (0 = playing); parked-seat kick basis
    }

    /// @dev Transient per-seat state for the in-progress hand. Reset each hand.
    struct SeatHand {
        bool inHand; // was dealt in and has not folded
        bool folded;
        bool allIn;
        bool hasActed; // has acted since the last aggressive action this street
        uint128 committedStreet; // chips committed on the current street
        uint128 committedTotal; // chips committed across the whole hand (side-pot math)
    }

    /// @dev The single in-progress hand for a table.
    struct Hand {
        uint64 handId;
        uint8 street; // STREET_*
        uint8 button; // seat index of the dealer button
        uint8 actingSeat; // whose turn it is to act
        uint8 aggressorSeat; // seat of the last bet/raise; closing the action returns here
        uint8 numInHand; // players not folded
        uint128 currentBet; // highest `committedStreet` this street
        uint128 minRaise; // minimum legal raise increment (>= bigBlind)
        uint128 pot; // chips swept from completed streets (excludes current-street commits)
        uint64 actingDeadline; // unix ts when the acting player's time expires
        uint256 dealId; // handle from the IPokerDealer for this hand
        bool inProgress;
    }

    // ---------------------------------------------------------------------
    // Storage — escrow
    // ---------------------------------------------------------------------

    mapping(address => uint256) public balance; // idle in-room bankroll
    mapping(address => uint256) public pendingWithdrawals; // pull-payment fallback
    uint256 public totalPendingWithdrawals;

    // ---------------------------------------------------------------------
    // Storage — tables / seats / hands
    // ---------------------------------------------------------------------

    TableConfig[] internal _tables;
    mapping(uint256 => mapping(uint8 => Seat)) internal _seats; // tableId => seat => Seat
    mapping(uint256 => Hand) internal _hands; // tableId => current hand
    mapping(uint256 => mapping(uint8 => SeatHand)) internal _seatHands; // tableId => seat => SeatHand
    mapping(uint256 => uint64) public handCounter; // tableId => hands started
    // tableId => player => (seatIndex + 1); 0 means "not seated here".
    mapping(uint256 => mapping(address => uint8)) internal _seatOf;
    mapping(uint256 => uint8) internal _lastButton; // tableId => previous dealer-button seat
    // Consecutive TIMEOUT folds/checks per seat (any voluntary action resets it).
    // Once it reaches KICK_AFTER the dealer/operator may kick the seat — an AFK
    // player can't squat a cash seat blinding away forever.
    mapping(uint256 => mapping(uint8 => uint16)) public timeoutStreak;

    // ---------------------------------------------------------------------
    // Storage — collected rake
    // ---------------------------------------------------------------------

    uint256 public rakeCollected; // owner-withdrawable accrued rake

    // ---------------------------------------------------------------------
    // Storage — auth / dealer
    // ---------------------------------------------------------------------

    IPokerDealer public dealer;
    address public dealerOperator; // off-chain dealer bot, may drive timeouts / advance streets
    // Additional operator worker keys: the dealer bot runs several signers so
    // hot tables don't queue behind one nonce. Same trust level as dealerOperator.
    mapping(address => bool) public isOperator;

    // Session keys: a player authorizes a hot in-browser key to take betting
    // actions for them without a wallet popup. The key can ONLY call act() — it
    // cannot sit, leave, top up, withdraw, or move escrow — so the most it can
    // ever risk is the chips already at the seat.
    mapping(address => address) public sessionKeyOf; // player => session key
    mapping(address => address) public sessionOwnerOf; // session key => player

    // Tournament tables: a controller (the PokerTournament contract) seats players
    // with chips, advances blinds, and removes busted seats. Cash tables have no
    // controller (address(0)) and behave exactly as before — all tournament logic
    // is gated on tableController being set.
    address public tournamentFactory; // may create controlled tables
    mapping(uint256 => address) public tableController; // tableId => controller (0 = cash)

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event Deposited(address indexed player, uint256 amount, uint256 newBalance);
    event Withdrawn(address indexed player, uint256 amount);
    event WithdrawalCredited(address indexed player, uint256 amount); // pull-payment fallback
    event WithdrawalClaimed(address indexed player, uint256 amount);

    event TableCreated(uint256 indexed tableId, uint8 maxSeats, uint128 smallBlind, uint128 bigBlind);
    event TableConfigUpdated(uint256 indexed tableId);
    event DealerUpdated(address indexed prev, address indexed next);
    event DealerOperatorUpdated(address indexed prev, address indexed next);
    event OperatorSet(address indexed op, bool enabled);
    event SessionKeySet(address indexed player, address indexed key, uint256 funded);
    event SessionKeyRevoked(address indexed player, address indexed key);
    event TournamentFactoryUpdated(address indexed prev, address indexed next);
    event ControlledTableCreated(uint256 indexed tableId, address indexed controller);
    event TournamentSeated(uint256 indexed tableId, uint8 indexed seat, address indexed player, uint128 chips);
    event SeatRemoved(uint256 indexed tableId, uint8 indexed seat, address indexed player);
    event BlindsUpdated(uint256 indexed tableId, uint128 smallBlind, uint128 bigBlind, uint128 ante);
    event DepositedFor(address indexed player, uint256 amount);

    event PlayerSeated(uint256 indexed tableId, uint8 indexed seat, address indexed player, uint128 buyIn);
    event PlayerLeft(uint256 indexed tableId, uint8 indexed seat, address indexed player, uint128 stackReturned);
    event PlayerKicked(uint256 indexed tableId, uint8 indexed seat, address indexed player, uint128 stackReturned);
    event PlayerToppedUp(uint256 indexed tableId, uint8 indexed seat, address indexed player, uint128 amount);
    event SitOutToggled(uint256 indexed tableId, uint8 indexed seat, address indexed player, bool sittingOut);

    event HandStarted(uint256 indexed tableId, uint64 indexed handId, uint8 button, uint256 dealId);
    event AntePosted(uint256 indexed tableId, uint8 indexed seat, uint128 amount);
    event BlindPosted(uint256 indexed tableId, uint8 indexed seat, uint128 amount, bool isBig);
    event ActionTurn(uint256 indexed tableId, uint64 indexed handId, uint8 seat, uint64 deadline);
    event PlayerActed(
        uint256 indexed tableId,
        uint64 indexed handId,
        uint8 seat,
        uint8 action,
        uint128 paid,
        uint128 committedStreet,
        uint128 stack
    );
    event StreetAdvanced(uint256 indexed tableId, uint64 indexed handId, uint8 street, uint128 pot);
    event ShowdownReached(uint256 indexed tableId, uint64 indexed handId, uint128 pot);
    event HandSettled(uint256 indexed tableId, uint64 indexed handId, uint8 winnerSeat, uint128 amountWon, uint128 rake);
    event HandCancelled(uint256 indexed tableId, uint64 indexed handId);
    event HandCancelledPenalized(uint256 indexed tableId, uint64 indexed handId, uint8 offenderSeat, uint128 forfeited);
    event PotWinner(uint256 indexed tableId, uint64 indexed handId, uint8 potIndex, uint8 seat, uint128 amount);
    event ShowdownSettled(uint256 indexed tableId, uint64 indexed handId, uint128 rake);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotDealer();
    error NotDealerOrOperator();
    error TableInactive();
    error BadConfig();
    error BadSeat();
    error SeatTaken();
    error AlreadySeated();
    error NotSeated();
    error InsufficientBalance();
    error BuyInOutOfRange();
    error MaxStackExceeded();
    error InHand();
    error NotIdle();
    error ZeroAmount();
    error TransferFailed();
    error HandAlreadyInProgress();
    error NoHandInProgress();
    error NotEnoughPlayers();
    error NotYourTurn();
    error IllegalAction();
    error BelowMinBet();
    error BelowMinRaise();
    error InsufficientChips();
    error TooEarly();
    error ShowdownNotReady();
    error InvalidSessionKey();
    error NotFactory();
    error NotController();
    error ControlledTable();

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyDealer() {
        if (msg.sender != address(dealer)) revert NotDealer();
        _;
    }

    modifier onlyDealerOrOperator() {
        if (msg.sender != address(dealer) && msg.sender != dealerOperator && !isOperator[msg.sender]) {
            revert NotDealerOrOperator();
        }
        _;
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setDealer(IPokerDealer newDealer) external onlyOwner {
        emit DealerUpdated(address(dealer), address(newDealer));
        dealer = newDealer;
    }

    function setDealerOperator(address op) external onlyOwner {
        emit DealerOperatorUpdated(dealerOperator, op);
        dealerOperator = op;
    }

    /// @notice Enable/disable an additional operator worker key.
    function setOperator(address op, bool on) external onlyOwner {
        isOperator[op] = on;
        emit OperatorSet(op, on);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Create a cash table. Returns its id (index into `_tables`).
    function createTable(TableConfig calldata cfg) external onlyOwner returns (uint256 tableId) {
        if (cfg.maxSeats < 2 || cfg.maxSeats > MAX_SEATS) revert BadConfig();
        if (cfg.bigBlind == 0 || cfg.smallBlind == 0 || cfg.smallBlind > cfg.bigBlind) revert BadConfig();
        if (cfg.minBuyIn < cfg.bigBlind || cfg.maxBuyIn < cfg.minBuyIn) revert BadConfig();
        if (cfg.rakeBps > 1000) revert BadConfig(); // hard ceiling 10%
        if (cfg.actionTimeout == 0) revert BadConfig();

        tableId = _tables.length;
        _tables.push(cfg);
        _hands[tableId].street = STREET_IDLE;
        emit TableCreated(tableId, cfg.maxSeats, cfg.smallBlind, cfg.bigBlind);
    }

    /// @notice Update a table's parameters. Disallowed while a hand is running so
    ///         live pot/blind math can't shift under players.
    function updateTable(uint256 tableId, TableConfig calldata cfg) external onlyOwner {
        _requireTable(tableId);
        if (_hands[tableId].inProgress) revert InHand();
        if (cfg.maxSeats < 2 || cfg.maxSeats > MAX_SEATS) revert BadConfig();
        if (cfg.bigBlind == 0 || cfg.smallBlind == 0 || cfg.smallBlind > cfg.bigBlind) revert BadConfig();
        if (cfg.minBuyIn < cfg.bigBlind || cfg.maxBuyIn < cfg.minBuyIn) revert BadConfig();
        if (cfg.rakeBps > 1000) revert BadConfig();
        if (cfg.actionTimeout == 0) revert BadConfig();
        _tables[tableId] = cfg;
        emit TableConfigUpdated(tableId);
    }

    /// @notice Owner withdraws accrued rake.
    function withdrawRake(address to, uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0 || amount > rakeCollected) revert ZeroAmount();
        rakeCollected -= amount;
        payable(to).sendValue(amount);
    }

    // ---------------------------------------------------------------------
    // Tournament tables — controlled by the PokerTournament contract
    // ---------------------------------------------------------------------

    modifier onlyController(uint256 tableId) {
        if (msg.sender == address(0) || msg.sender != tableController[tableId]) revert NotController();
        _;
    }

    function setTournamentFactory(address f) external onlyOwner {
        emit TournamentFactoryUpdated(tournamentFactory, f);
        tournamentFactory = f;
    }

    /// @notice The tournament factory opens a table it will fully manage (seat
    ///         players with chips, advance blinds, remove busted seats).
    function createControlledTable(TableConfig calldata cfg) external returns (uint256 tableId) {
        if (msg.sender != tournamentFactory) revert NotFactory();
        if (cfg.maxSeats < 2 || cfg.maxSeats > MAX_SEATS) revert BadConfig();
        if (cfg.bigBlind == 0 || cfg.smallBlind == 0 || cfg.smallBlind > cfg.bigBlind) revert BadConfig();
        if (cfg.actionTimeout == 0) revert BadConfig();
        tableId = _tables.length;
        _tables.push(cfg);
        _hands[tableId].street = STREET_IDLE;
        tableController[tableId] = msg.sender;
        emit TableCreated(tableId, cfg.maxSeats, cfg.smallBlind, cfg.bigBlind);
        emit ControlledTableCreated(tableId, msg.sender);
    }

    /// @notice Seat a tournament player with `chips` (no escrow movement).
    function seatPlayerWithChips(uint256 tableId, uint8 seat, address player, uint128 chips)
        external
        onlyController(tableId)
    {
        TableConfig storage cfg = _tables[tableId];
        if (seat >= cfg.maxSeats) revert BadSeat();
        if (_seatOf[tableId][player] != 0) revert AlreadySeated();
        Seat storage s = _seats[tableId][seat];
        if (s.occupied) revert SeatTaken();
        s.player = player;
        s.stack = chips;
        s.occupied = true;
        s.sittingOut = false;
        s.sitInHandId = handCounter[tableId] + 1;
        _seatOf[tableId][player] = seat + 1;
        emit TournamentSeated(tableId, seat, player, chips);
    }

    /// @notice Remove a (busted) seat. Not allowed for a seat with chips in the
    ///         live hand (deleting its SeatHand would orphan money in the pot).
    function removeSeat(uint256 tableId, uint8 seat) external onlyController(tableId) {
        Seat storage s = _seats[tableId][seat];
        address player = s.player;
        SeatHand storage sh = _seatHands[tableId][seat];
        if (_hands[tableId].inProgress && (sh.inHand || sh.folded || sh.committedTotal > 0)) revert InHand();
        delete _seats[tableId][seat];
        delete _seatHands[tableId][seat];
        if (player != address(0)) _seatOf[tableId][player] = 0;
        emit SeatRemoved(tableId, seat, player);
    }

    /// @notice Raise the blinds (tournament level-up). Between hands only.
    function setBlinds(uint256 tableId, uint128 sb, uint128 bb, uint128 ante) external onlyController(tableId) {
        if (_hands[tableId].inProgress) revert InHand();
        if (bb == 0 || sb == 0 || sb > bb) revert BadConfig();
        TableConfig storage cfg = _tables[tableId];
        cfg.smallBlind = sb;
        cfg.bigBlind = bb;
        cfg.ante = ante;
        emit BlindsUpdated(tableId, sb, bb, ante);
    }

    /// @notice Credit a player's in-room balance on their behalf (e.g. a
    ///         tournament prize payout from the pool).
    function depositFor(address player) external payable {
        if (msg.value == 0) revert ZeroAmount();
        balance[player] += msg.value;
        emit DepositedFor(player, msg.value);
    }

    // ---------------------------------------------------------------------
    // Escrow — deposit / withdraw
    // ---------------------------------------------------------------------

    /// @notice Deposit SOMI into your idle in-room bankroll.
    function deposit() external payable whenNotPaused {
        if (msg.value == 0) revert ZeroAmount();
        balance[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value, balance[msg.sender]);
    }

    /// @notice Withdraw idle bankroll back to your wallet. Chips in play at a seat
    ///         must be returned to bankroll first via {leaveTable}.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balance[msg.sender];
        if (amount > bal) revert InsufficientBalance();
        balance[msg.sender] = bal - amount;
        emit Withdrawn(msg.sender, amount);
        payable(msg.sender).sendValue(amount);
    }

    /// @notice Claim funds parked in the pull-payment fallback (used only when a
    ///         direct credit path ever needs to defer to a pull).
    function claimWithdrawal() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert ZeroAmount();
        pendingWithdrawals[msg.sender] = 0;
        totalPendingWithdrawals -= amount;
        emit WithdrawalClaimed(msg.sender, amount);
        payable(msg.sender).sendValue(amount);
    }

    // ---------------------------------------------------------------------
    // Seating
    // ---------------------------------------------------------------------

    /// @notice Sit at an empty seat with a buy-in drawn from your bankroll.
    function sitDown(uint256 tableId, uint8 seat, uint128 buyIn) external whenNotPaused {
        TableConfig storage cfg = _requireTable(tableId);
        if (tableController[tableId] != address(0)) revert ControlledTable(); // tournament table — seats managed by the tournament
        if (seat >= cfg.maxSeats) revert BadSeat();
        if (_seatOf[tableId][msg.sender] != 0) revert AlreadySeated();

        Seat storage s = _seats[tableId][seat];
        if (s.occupied) revert SeatTaken();
        if (buyIn < cfg.minBuyIn || buyIn > cfg.maxBuyIn) revert BuyInOutOfRange();
        if (balance[msg.sender] < buyIn) revert InsufficientBalance();

        balance[msg.sender] -= buyIn;
        s.player = msg.sender;
        s.stack = buyIn;
        s.occupied = true;
        s.sittingOut = false;
        // Eligible to be dealt into the next hand that starts.
        s.sitInHandId = handCounter[tableId] + 1;
        _seatOf[tableId][msg.sender] = seat + 1;
        timeoutStreak[tableId][seat] = 0;

        emit PlayerSeated(tableId, seat, msg.sender, buyIn);
    }

    /// @notice Top up your stack between hands, capped at the table maxBuyIn.
    function topUp(uint256 tableId, uint128 amount) external whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (tableController[tableId] != address(0)) revert ControlledTable();
        uint8 seat = _mySeat(tableId);
        TableConfig storage cfg = _tables[tableId];
        SeatHand storage sh = _seatHands[tableId][seat];
        if (_hands[tableId].inProgress && sh.inHand) revert InHand();
        Seat storage s = _seats[tableId][seat];
        if (uint256(s.stack) + amount > cfg.maxBuyIn) revert MaxStackExceeded();
        if (balance[msg.sender] < amount) revert InsufficientBalance();
        balance[msg.sender] -= amount;
        s.stack += amount;
        emit PlayerToppedUp(tableId, seat, msg.sender, amount);
    }

    /// @notice Stand up. Returns your stack to bankroll. Not allowed while you are
    ///         live in the current hand — fold or wait for it to finish first.
    function leaveTable(uint256 tableId) external {
        if (tableController[tableId] != address(0)) revert ControlledTable();
        uint8 seat = _mySeat(tableId);
        SeatHand storage sh = _seatHands[tableId][seat];
        // Anyone dealt into the LIVE hand (even folded) must wait for it to end:
        // deleting their SeatHand mid-hand would erase committedStreet/Total and
        // corrupt the pot & side-pot accounting (their chips would be lost).
        if (_hands[tableId].inProgress && (sh.inHand || sh.folded || sh.committedTotal > 0)) revert InHand();

        uint128 stack = _standUp(tableId, seat, msg.sender);
        emit PlayerLeft(tableId, seat, msg.sender, stack);
    }

    /// @dev Return the seat's stack to the player's bankroll and free the seat.
    function _standUp(uint256 tableId, uint8 seat, address player) internal returns (uint128 stack) {
        stack = _seats[tableId][seat].stack;
        balance[player] += stack;
        delete _seats[tableId][seat];
        delete _seatHands[tableId][seat];
        _seatOf[tableId][player] = 0;
        delete timeoutStreak[tableId][seat];
    }

    /// @notice Toggle sitting out (you keep your seat & stack but aren't dealt in).
    function setSitOut(uint256 tableId, bool sittingOut) external {
        uint8 seat = _mySeat(tableId);
        Seat storage s = _seats[tableId][seat];
        s.sittingOut = sittingOut;
        s.sitOutSince = sittingOut ? uint64(block.timestamp) : 0;
        if (!sittingOut) {
            // Re-entering: eligible from the next hand, idle strikes forgiven.
            s.sitInHandId = handCounter[tableId] + 1;
            timeoutStreak[tableId][seat] = 0;
        }
        emit SitOutToggled(tableId, seat, msg.sender, sittingOut);
    }

    /// @notice Operator marks a seat idle: its owner is unresponsive to the card
    ///         protocol (v2 hands need every player's live crypto), so sit them
    ///         out — hands stop waiting on them — and count a strike toward
    ///         {kickIdle}. The flag only affects FUTURE deals; it never touches
    ///         the live hand's accounting.
    function sitOutIdle(uint256 tableId, uint8 seat) external onlyDealerOrOperator {
        Seat storage s = _seats[tableId][seat];
        if (!s.occupied) revert NotSeated();
        s.sittingOut = true;
        if (s.sitOutSince == 0) s.sitOutSince = uint64(block.timestamp);
        timeoutStreak[tableId][seat] += 1;
        emit SitOutToggled(tableId, seat, s.player, true);
    }

    /// @notice Kick an AFK seat: after KICK_AFTER consecutive timeout-folds the
    ///         dealer/operator stands the player up between hands. Their remaining
    ///         stack goes back to their in-room balance (their funds are theirs —
    ///         what the AFK squat cost them is the blinds they already lost).
    ///         Cash tables only; tournaments handle idle stacks via the blinds.
    function kickIdle(uint256 tableId, uint8 seat) external onlyDealerOrOperator nonReentrant {
        if (tableController[tableId] != address(0)) revert ControlledTable();
        Seat storage s = _seats[tableId][seat];
        if (!s.occupied) revert NotSeated();
        // AFK = 3 straight timeouts/protocol strikes, OR parked sitting-out for
        // 10+ minutes (a sat-out seat accrues no strikes — it isn't dealt in —
        // so without the time basis it could squat a cash seat forever).
        bool struck = timeoutStreak[tableId][seat] >= 3;
        bool parked = s.sittingOut && s.sitOutSince != 0 && block.timestamp > uint256(s.sitOutSince) + 600;
        if (!struck && !parked) revert NotIdle();
        SeatHand storage sh = _seatHands[tableId][seat];
        if (_hands[tableId].inProgress && (sh.inHand || sh.folded || sh.committedTotal > 0)) revert InHand();

        address player = s.player;
        uint128 stack = _standUp(tableId, seat, player);
        emit PlayerKicked(tableId, seat, player, stack);
    }

    // ---------------------------------------------------------------------
    // Session keys
    // ---------------------------------------------------------------------

    /// @notice Authorize a hot key to take betting actions on your behalf (no
    ///         wallet popup per action), optionally funding it with gas via
    ///         msg.value. The key is restricted to act() only.
    function setSessionKey(address key) external payable nonReentrant {
        if (key == address(0) || sessionOwnerOf[key] != address(0)) revert InvalidSessionKey();
        address prev = sessionKeyOf[msg.sender];
        if (prev != address(0)) sessionOwnerOf[prev] = address(0);
        sessionKeyOf[msg.sender] = key;
        sessionOwnerOf[key] = msg.sender;
        if (msg.value > 0) payable(key).sendValue(msg.value);
        emit SessionKeySet(msg.sender, key, msg.value);
    }

    /// @notice Revoke your session key. After this it can no longer act for you.
    function revokeSessionKey() external {
        address key = sessionKeyOf[msg.sender];
        if (key == address(0)) revert InvalidSessionKey();
        sessionKeyOf[msg.sender] = address(0);
        sessionOwnerOf[key] = address(0);
        emit SessionKeyRevoked(msg.sender, key);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function tableCount() external view returns (uint256) {
        return _tables.length;
    }

    function getTable(uint256 tableId) external view returns (TableConfig memory) {
        _requireTable(tableId);
        return _tables[tableId];
    }

    function getSeat(uint256 tableId, uint8 seat) external view returns (Seat memory) {
        return _seats[tableId][seat];
    }

    function getHand(uint256 tableId) external view returns (Hand memory) {
        return _hands[tableId];
    }

    /// @notice Cheap "is a hand running" check (for the tournament controller).
    function handInProgress(uint256 tableId) external view returns (bool) {
        return _hands[tableId].inProgress;
    }

    function getSeatHand(uint256 tableId, uint8 seat) external view returns (SeatHand memory) {
        return _seatHands[tableId][seat];
    }

    /// @notice Seat index of `player` at a table, or 255 if not seated.
    function seatOf(uint256 tableId, address player) external view returns (uint8) {
        uint8 s = _seatOf[tableId][player];
        return s == 0 ? NO_SEAT : s - 1;
    }

    // ---------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------

    function _requireTable(uint256 tableId) internal view returns (TableConfig storage cfg) {
        if (tableId >= _tables.length) revert TableInactive();
        cfg = _tables[tableId];
        if (!cfg.active) revert TableInactive();
    }

    function _mySeat(uint256 tableId) internal view returns (uint8) {
        return _seatOfAddr(tableId, msg.sender);
    }

    function _seatOfAddr(uint256 tableId, address who) internal view returns (uint8) {
        uint8 s = _seatOf[tableId][who];
        if (s == 0) revert NotSeated();
        return s - 1;
    }

    // =====================================================================
    // Engine — hand lifecycle
    // =====================================================================

    /// @notice Begin a new hand. Driven by the dealer operator (off-chain dealer
    ///         bot) once >=2 eligible players are seated and no hand is running.
    ///         Rotates the button, posts antes + blinds, binds a deck via the
    ///         {IPokerDealer}, and opens preflop action.
    function startHand(uint256 tableId)
        external
        whenNotPaused
        nonReentrant
        onlyDealerOrOperator
        returns (uint64)
    {
        _requireTable(tableId);
        Hand storage h = _hands[tableId];
        if (h.inProgress) revert HandAlreadyInProgress();

        TableConfig storage cfg = _tables[tableId];
        bool firstHand = (handCounter[tableId] == 0);
        uint64 nextHandId = handCounter[tableId] + 1;

        uint8[] memory elig = _eligibleSeats(tableId, cfg.maxSeats, nextHandId);
        if (elig.length < 2) revert NotEnoughPlayers();

        // Wipe last hand's per-seat state for the whole table.
        for (uint8 i = 0; i < cfg.maxSeats; i++) {
            delete _seatHands[tableId][i];
        }

        uint8 button = _nextButton(tableId, cfg.maxSeats, nextHandId, firstHand);

        h.handId = nextHandId;
        h.button = button;
        h.street = STREET_PREFLOP;
        h.pot = 0;
        h.currentBet = 0;
        h.minRaise = cfg.bigBlind;
        h.aggressorSeat = NO_SEAT;
        h.inProgress = true;

        uint8 dealt = 0;
        for (uint256 i = 0; i < elig.length; i++) {
            _seatHands[tableId][elig[i]].inHand = true;
            dealt++;
        }
        h.numInHand = dealt;

        handCounter[tableId] = nextHandId;
        _lastButton[tableId] = button;

        if (cfg.ante > 0) _postAntes(tableId, elig, cfg.ante);
        if (tableController[tableId] != address(0)) _postDeadBlinds(tableId, cfg);
        uint8 bbSeat = _postBlinds(tableId, elig, button, cfg);

        // First to act preflop is the next eligible actor left of the big blind.
        uint8 first = _nextToAct(tableId, bbSeat);
        h.actingSeat = first;
        h.actingDeadline = uint64(block.timestamp) + cfg.actionTimeout;

        // Bind the deck. dealer == 0 is allowed for engine unit tests.
        h.dealId = address(dealer) == address(0)
            ? 0
            : dealer.startHand(tableId, nextHandId, dealt, elig);

        emit HandStarted(tableId, nextHandId, button, h.dealId);
        emit ActionTurn(tableId, nextHandId, first, h.actingDeadline);
        return nextHandId;
    }

    // =====================================================================
    // Engine — player actions
    // =====================================================================

    /// @notice Take your turn. `amount` is the *raise-to* total for BET/RAISE
    ///         (ignored for FOLD/CHECK/CALL/ALLIN).
    function act(uint256 tableId, ActionType action, uint128 amount) external whenNotPaused nonReentrant {
        Hand storage h = _hands[tableId];
        if (!h.inProgress || h.street > STREET_RIVER) revert NoHandInProgress();
        // Resolve the acting player — msg.sender may be their authorized session key.
        address actor = sessionOwnerOf[msg.sender];
        if (actor == address(0)) actor = msg.sender;
        uint8 seat = _seatOfAddr(tableId, actor);
        if (seat != h.actingSeat) revert NotYourTurn();
        timeoutStreak[tableId][seat] = 0; // voluntary action — the player is alive
        _doAction(tableId, seat, action, amount);
    }

    /// @notice Permissionless: once the acting player's clock expires, anyone (in
    ///         practice the dealer operator) can fold them — or check them down if
    ///         they owe nothing — so a stalled seat can't freeze the table.
    function timeoutAct(uint256 tableId) external nonReentrant {
        Hand storage h = _hands[tableId];
        if (!h.inProgress || h.street > STREET_RIVER) revert NoHandInProgress();
        if (block.timestamp <= h.actingDeadline) revert TooEarly();
        uint8 seat = h.actingSeat;
        SeatHand storage sh = _seatHands[tableId][seat];
        timeoutStreak[tableId][seat] += 1;
        uint128 toCall = h.currentBet > sh.committedStreet ? h.currentBet - sh.committedStreet : 0;
        _doAction(tableId, seat, toCall == 0 ? ActionType.CHECK : ActionType.FOLD, 0);
    }

    function _doAction(uint256 tableId, uint8 seat, ActionType action, uint128 amount) internal {
        Hand storage h = _hands[tableId];
        Seat storage s = _seats[tableId][seat];
        SeatHand storage sh = _seatHands[tableId][seat];
        uint128 stackBefore = s.stack;
        uint128 cur = h.currentBet;
        uint128 toCall = cur > sh.committedStreet ? cur - sh.committedStreet : 0;

        if (action == ActionType.FOLD) {
            sh.folded = true;
            sh.inHand = false;
            sh.hasActed = true;
            h.numInHand -= 1;
        } else if (action == ActionType.CHECK) {
            if (toCall != 0) revert IllegalAction();
            sh.hasActed = true;
        } else if (action == ActionType.CALL) {
            if (toCall == 0) revert IllegalAction();
            uint128 pay = toCall <= s.stack ? toCall : s.stack;
            _commitStreet(tableId, seat, pay);
            sh.hasActed = true;
        } else if (action == ActionType.BET) {
            if (cur != 0) revert IllegalAction(); // a bet already exists — use RAISE
            _aggress(tableId, seat, amount);
        } else if (action == ActionType.RAISE) {
            if (cur == 0) revert IllegalAction(); // nothing to raise — use BET
            _aggress(tableId, seat, amount);
        } else {
            // ALLIN
            uint128 target = sh.committedStreet + s.stack;
            if (target > cur) {
                _aggress(tableId, seat, target);
            } else {
                _commitStreet(tableId, seat, s.stack); // all-in call (short)
                sh.hasActed = true;
            }
        }

        emit PlayerActed(tableId, h.handId, seat, uint8(action), stackBefore - s.stack, sh.committedStreet, s.stack);
        _progressAfterAction(tableId);
    }

    /// @dev Apply a bet/raise to `target` (the player's new committedStreet total).
    function _aggress(uint256 tableId, uint8 seat, uint128 target) internal {
        Hand storage h = _hands[tableId];
        TableConfig storage cfg = _tables[tableId];
        Seat storage s = _seats[tableId][seat];
        SeatHand storage sh = _seatHands[tableId][seat];
        uint128 cur = h.currentBet;

        if (target <= cur || target <= sh.committedStreet) revert IllegalAction();
        uint128 additional = target - sh.committedStreet;
        if (additional > s.stack) revert InsufficientChips();
        bool allIn = (additional == s.stack);
        uint128 raiseBy = target - cur;

        if (!allIn) {
            if (cur == 0) {
                if (target < cfg.bigBlind) revert BelowMinBet();
            } else {
                if (raiseBy < h.minRaise) revert BelowMinRaise();
            }
        }

        _commitStreet(tableId, seat, additional);

        // A full bet/raise (or any opening bet) reopens the action; a short all-in
        // raise does not force already-acted players to act again.
        bool fullRaise = (cur == 0) || (raiseBy >= h.minRaise);
        h.currentBet = target;
        if (fullRaise) {
            uint128 mr = (cur == 0) ? target : raiseBy;
            if (mr < cfg.bigBlind) mr = cfg.bigBlind;
            h.minRaise = mr;
            _resetHasActedExcept(tableId, seat);
        }
        h.aggressorSeat = seat;
        sh.hasActed = true;
    }

    // =====================================================================
    // Engine — street / round progression
    // =====================================================================

    function _progressAfterAction(uint256 tableId) internal {
        Hand storage h = _hands[tableId];
        // Everyone but one player folded — the hand is over immediately, no matter
        // where in the street we are.
        if (h.numInHand == 1) {
            _completeStreet(tableId);
            return;
        }
        uint8 next = _nextToAct(tableId, h.actingSeat);
        if (next != NO_SEAT) {
            h.actingSeat = next;
            h.actingDeadline = uint64(block.timestamp) + _tables[tableId].actionTimeout;
            emit ActionTurn(tableId, h.handId, next, h.actingDeadline);
            return;
        }
        _completeStreet(tableId);
    }

    function _completeStreet(uint256 tableId) internal {
        Hand storage h = _hands[tableId];
        TableConfig storage cfg = _tables[tableId];
        uint8 n = cfg.maxSeats;

        // Sweep this street's commitments into the pot and clear per-street flags.
        for (uint8 i = 0; i < n; i++) {
            SeatHand storage sh = _seatHands[tableId][i];
            if (sh.committedStreet > 0) {
                h.pot += sh.committedStreet;
                sh.committedStreet = 0;
            }
            sh.hasActed = false;
        }
        h.currentBet = 0;
        h.minRaise = cfg.bigBlind;
        h.aggressorSeat = NO_SEAT;

        if (h.numInHand == 1) {
            _endFoldWin(tableId);
            return;
        }
        if (h.street == STREET_RIVER) {
            _toShowdown(tableId);
            return;
        }

        if (_canStillBet(tableId)) {
            h.street += 1;
            uint8 first = _nextToAct(tableId, h.button);
            h.actingSeat = first;
            h.actingDeadline = uint64(block.timestamp) + cfg.actionTimeout;
            emit StreetAdvanced(tableId, h.handId, h.street, h.pot);
            emit ActionTurn(tableId, h.handId, first, h.actingDeadline);
        } else {
            // Fewer than two players can act — run the remaining streets out with
            // no betting, then go to showdown.
            while (h.street < STREET_RIVER) {
                h.street += 1;
                emit StreetAdvanced(tableId, h.handId, h.street, h.pot);
            }
            _toShowdown(tableId);
        }
    }

    function _endFoldWin(uint256 tableId) internal {
        Hand storage h = _hands[tableId];
        uint8 n = _tables[tableId].maxSeats;
        uint8 winner = NO_SEAT;
        for (uint8 i = 0; i < n; i++) {
            if (_seatHands[tableId][i].inHand) {
                winner = i;
                break;
            }
        }
        uint128 pot = h.pot;
        // "No flop, no drop": only rake once a flop has been dealt.
        uint128 rake = h.street >= STREET_FLOP ? _rake(tableId, pot) : 0;
        uint128 won = pot - rake;
        rakeCollected += rake;
        _seats[tableId][winner].stack += won;
        emit HandSettled(tableId, h.handId, winner, won, rake);
        _clearHand(tableId);
    }

    function _toShowdown(uint256 tableId) internal {
        Hand storage h = _hands[tableId];
        h.street = STREET_SHOWDOWN;
        h.actingSeat = NO_SEAT;
        h.actingDeadline = 0;
        emit ShowdownReached(tableId, h.handId, h.pot);
        // Multiway distribution happens in resolveShowdown() (next engine section)
        // once the dealer has revealed and proven the cards.
    }

    /// @notice Emergency escape hatch: abort the current hand and refund every
    ///         seat's full contribution back to its stack. For hands the dealer
    ///         can no longer serve (entropy expired past the 256-block blockhash
    ///         window, lost seed after a bot restart) — without this the table
    ///         would be stuck in SHOWDOWN forever with the pot locked. Dealer/
    ///         operator only; same trust level as dealing itself.
    function cancelHand(uint256 tableId) external onlyDealerOrOperator nonReentrant {
        Hand storage h = _hands[tableId];
        if (!h.inProgress) revert NoHandInProgress();
        uint8 n = _tables[tableId].maxSeats;
        for (uint8 i = 0; i < n; i++) {
            SeatHand storage sh = _seatHands[tableId][i];
            uint128 c = sh.committedTotal;
            if (c > 0) _seats[tableId][i].stack += c;
            delete _seatHands[tableId][i];
        }
        emit HandCancelled(tableId, h.handId);
        _clearHand(tableId);
    }

    /// @notice Cancel the current hand but FORFEIT `offenderSeat`'s committed
    ///         chips to the other committed seats (pro-rata), refunding everyone
    ///         else in full. For a seat whose owner abandoned the v2 card
    ///         protocol mid-hand (withheld decryption shares): the hand cannot
    ///         complete without them, but walking away must never be cheaper
    ///         than folding — otherwise closing the tab in a lost pot would be
    ///         free insurance. The forfeit goes to PLAYERS only; the operator
    ///         gains nothing. The offender is also sat out with a strike.
    function cancelHandPenalized(uint256 tableId, uint8 offenderSeat) external onlyDealerOrOperator nonReentrant {
        Hand storage h = _hands[tableId];
        if (!h.inProgress) revert NoHandInProgress();
        uint128 forfeit = _seatHands[tableId][offenderSeat].committedTotal;
        if (forfeit == 0) revert NotIdle(); // nothing committed — use plain cancelHand
        uint8 n = _tables[tableId].maxSeats;

        // Refund every other committed seat + measure their combined stake.
        uint128 othersTotal = 0;
        for (uint8 i = 0; i < n; i++) {
            if (i == offenderSeat) continue;
            uint128 c = _seatHands[tableId][i].committedTotal;
            if (c > 0) {
                _seats[tableId][i].stack += c;
                othersTotal += c;
            }
        }
        // Distribute the forfeit pro-rata over those seats (dust to the last).
        if (othersTotal > 0) {
            uint128 left = forfeit;
            uint8 last = 0;
            for (uint8 i = 0; i < n; i++) {
                if (i == offenderSeat) continue;
                uint128 c = _seatHands[tableId][i].committedTotal;
                if (c == 0) continue;
                uint128 share = uint128((uint256(forfeit) * c) / othersTotal);
                _seats[tableId][i].stack += share;
                left -= share;
                last = i;
            }
            _seats[tableId][last].stack += left;
        } else {
            _seats[tableId][offenderSeat].stack += forfeit; // no one to award — refund
        }
        for (uint8 i = 0; i < n; i++) delete _seatHands[tableId][i];

        Seat storage off = _seats[tableId][offenderSeat];
        if (off.occupied) {
            off.sittingOut = true;
            if (off.sitOutSince == 0) off.sitOutSince = uint64(block.timestamp);
            timeoutStreak[tableId][offenderSeat] += 1;
        }
        emit HandCancelledPenalized(tableId, h.handId, offenderSeat, forfeit);
        _clearHand(tableId);
    }

    function _clearHand(uint256 tableId) internal {
        Hand storage h = _hands[tableId];
        h.inProgress = false;
        h.street = STREET_IDLE;
        h.actingSeat = NO_SEAT;
        h.actingDeadline = 0;
        h.currentBet = 0;
        h.pot = 0;
    }

    // =====================================================================
    // Engine — internal helpers
    // =====================================================================

    function _commitStreet(uint256 tableId, uint8 seat, uint128 amount) internal {
        if (amount == 0) return;
        Seat storage s = _seats[tableId][seat];
        SeatHand storage sh = _seatHands[tableId][seat];
        s.stack -= amount; // caller guarantees amount <= stack
        sh.committedStreet += amount;
        sh.committedTotal += amount;
        if (s.stack == 0) sh.allIn = true;
    }

    /// @dev Next seat after `fromSeat` (clockwise) that still owes action this
    ///      street, or NO_SEAT if the round is complete.
    function _nextToAct(uint256 tableId, uint8 fromSeat) internal view returns (uint8) {
        Hand storage h = _hands[tableId];
        uint8 n = _tables[tableId].maxSeats;
        uint128 cur = h.currentBet;
        for (uint8 k = 1; k <= n; k++) {
            uint8 seat = uint8((uint16(fromSeat) + k) % n);
            SeatHand storage sh = _seatHands[tableId][seat];
            if (sh.inHand && !sh.folded && !sh.allIn) {
                if (!sh.hasActed || sh.committedStreet < cur) return seat;
            }
        }
        return NO_SEAT;
    }

    function _canStillBet(uint256 tableId) internal view returns (bool) {
        uint8 n = _tables[tableId].maxSeats;
        uint8 c = 0;
        for (uint8 i = 0; i < n; i++) {
            SeatHand storage sh = _seatHands[tableId][i];
            if (sh.inHand && !sh.folded && !sh.allIn) c++;
            if (c >= 2) return true;
        }
        return false;
    }

    function _resetHasActedExcept(uint256 tableId, uint8 except) internal {
        uint8 n = _tables[tableId].maxSeats;
        for (uint8 i = 0; i < n; i++) {
            if (i == except) continue;
            SeatHand storage sh = _seatHands[tableId][i];
            if (sh.inHand && !sh.folded && !sh.allIn) sh.hasActed = false;
        }
    }

    function _eligibleSeats(uint256 tableId, uint8 maxSeats, uint64 handId) internal view returns (uint8[] memory) {
        uint8 cnt = 0;
        for (uint8 i = 0; i < maxSeats; i++) {
            if (_isEligible(tableId, i, handId)) cnt++;
        }
        uint8[] memory out = new uint8[](cnt);
        uint8 j = 0;
        for (uint8 i = 0; i < maxSeats; i++) {
            if (_isEligible(tableId, i, handId)) out[j++] = i;
        }
        return out;
    }

    function _isEligible(uint256 tableId, uint8 seat, uint64 handId) internal view returns (bool) {
        Seat storage s = _seats[tableId][seat];
        return s.occupied && !s.sittingOut && s.stack > 0 && s.sitInHandId <= handId;
    }

    function _nextButton(uint256 tableId, uint8 maxSeats, uint64 handId, bool firstHand) internal view returns (uint8) {
        if (firstHand) {
            for (uint8 i = 0; i < maxSeats; i++) {
                if (_isEligible(tableId, i, handId)) return i;
            }
        }
        uint8 prev = _lastButton[tableId];
        for (uint8 k = 1; k <= maxSeats; k++) {
            uint8 seat = uint8((uint16(prev) + k) % maxSeats);
            if (_isEligible(tableId, seat, handId)) return seat;
        }
        return prev; // unreachable while >=2 players are eligible
    }

    function _nextEligAfter(uint8[] memory elig, uint8 seat) internal pure returns (uint8) {
        uint256 idx = 0;
        for (uint256 i = 0; i < elig.length; i++) {
            if (elig[i] == seat) {
                idx = i;
                break;
            }
        }
        return elig[(idx + 1) % elig.length];
    }

    function _postAntes(uint256 tableId, uint8[] memory elig, uint128 ante) internal {
        Hand storage h = _hands[tableId];
        for (uint256 i = 0; i < elig.length; i++) {
            uint8 seat = elig[i];
            Seat storage s = _seats[tableId][seat];
            SeatHand storage sh = _seatHands[tableId][seat];
            uint128 amt = ante <= s.stack ? ante : s.stack;
            if (amt == 0) continue;
            s.stack -= amt;
            sh.committedTotal += amt;
            h.pot += amt;
            if (s.stack == 0) sh.allIn = true;
            emit AntePosted(tableId, seat, amt);
        }
    }

    /// @dev Tournament blind-off: a sitting-out seat can't be dealt in (a v2
    ///      hand needs its owner's live crypto) but its stack must still pay to
    ///      play — post a dead big blind straight into the pot each hand so an
    ///      absent stack drains and busts instead of stalling the event forever.
    ///      Routed through committedTotal so cancelHand refunds it correctly.
    function _postDeadBlinds(uint256 tableId, TableConfig storage cfg) internal {
        Hand storage h = _hands[tableId];
        uint8 n = cfg.maxSeats;
        for (uint8 i = 0; i < n; i++) {
            Seat storage s = _seats[tableId][i];
            if (!s.occupied || !s.sittingOut || s.stack == 0) continue;
            uint128 amt = cfg.bigBlind <= s.stack ? cfg.bigBlind : s.stack;
            s.stack -= amt;
            _seatHands[tableId][i].committedTotal += amt;
            h.pot += amt;
            emit AntePosted(tableId, i, amt); // dead money, ante-equivalent
        }
    }

    function _postBlinds(uint256 tableId, uint8[] memory elig, uint8 button, TableConfig storage cfg)
        internal
        returns (uint8 bbSeat)
    {
        uint8 sbSeat;
        if (elig.length == 2) {
            // Heads-up: the button is the small blind and acts first preflop.
            sbSeat = button;
            bbSeat = elig[0] == button ? elig[1] : elig[0];
        } else {
            sbSeat = _nextEligAfter(elig, button);
            bbSeat = _nextEligAfter(elig, sbSeat);
        }

        Hand storage h = _hands[tableId];

        uint128 sbStack = _seats[tableId][sbSeat].stack;
        uint128 sbAmt = cfg.smallBlind <= sbStack ? cfg.smallBlind : sbStack;
        _commitStreet(tableId, sbSeat, sbAmt);
        emit BlindPosted(tableId, sbSeat, sbAmt, false);

        uint128 bbStack = _seats[tableId][bbSeat].stack;
        uint128 bbAmt = cfg.bigBlind <= bbStack ? cfg.bigBlind : bbStack;
        _commitStreet(tableId, bbSeat, bbAmt);
        emit BlindPosted(tableId, bbSeat, bbAmt, true);

        // The big blind sets the line to match even if posted short (all-in).
        h.currentBet = cfg.bigBlind;
        h.minRaise = cfg.bigBlind;
        h.aggressorSeat = bbSeat;
    }

    function _rake(uint256 tableId, uint128 pot) internal view returns (uint128) {
        if (tableController[tableId] != address(0)) return 0; // tournaments take their fee at registration, not per pot
        TableConfig storage cfg = _tables[tableId];
        uint256 r = (uint256(pot) * cfg.rakeBps) / 10000;
        if (r > cfg.rakeCap) r = cfg.rakeCap;
        return uint128(r);
    }

    // =====================================================================
    // Engine — showdown (side-pots + on-chain hand evaluation)
    // =====================================================================

    /// @notice Settle a hand that has reached showdown. Permissionless once the
    ///         dealer has revealed and proven the cards, so the table can never
    ///         stall waiting on one caller. Builds the main pot + side pots from
    ///         each seat's total contribution, ranks the live hands on-chain, and
    ///         pays each pot to its best eligible hand(s), splitting ties.
    function resolveShowdown(uint256 tableId) external nonReentrant {
        Hand storage h = _hands[tableId];
        if (!h.inProgress || h.street != STREET_SHOWDOWN) revert NoHandInProgress();
        if (address(dealer) == address(0) || !dealer.isShowdownReady(h.dealId)) revert ShowdownNotReady();
        _settleShowdown(tableId);
    }

    function _settleShowdown(uint256 tableId) internal {
        Hand storage h = _hands[tableId];
        TableConfig storage cfg = _tables[tableId];
        uint8 n = cfg.maxSeats;

        // 1. Score each live seat's 7 cards; snapshot per-seat contributions.
        //    Defense-in-depth vs a lying isShowdownReady: an unrevealed card
        //    (255) must never reach the evaluator — it would misrank the seat.
        uint8[5] memory board = dealer.boardCards(h.dealId);
        if (board[4] > 51) revert ShowdownNotReady();
        uint32[] memory scores = new uint32[](n);
        uint128[] memory contrib = new uint128[](n);
        bool[] memory live = new bool[](n);
        for (uint8 i = 0; i < n; i++) {
            SeatHand storage sh = _seatHands[tableId][i];
            contrib[i] = sh.committedTotal;
            if (sh.inHand) {
                live[i] = true;
                (uint8 c0, uint8 c1) = dealer.holeCards(h.dealId, i);
                if (c0 > 51 || c1 > 51) revert ShowdownNotReady();
                uint8[7] memory cs = [c0, c1, board[0], board[1], board[2], board[3], board[4]];
                scores[i] = PokerHandEval.eval7(cs);
            }
        }

        // 2. Peel contribution layers into main + side pots, awarding each.
        uint128 accRake = 0;
        uint8 potIndex = 0;
        while (true) {
            // Smallest positive remaining contribution defines the next layer.
            uint128 m = type(uint128).max;
            for (uint8 i = 0; i < n; i++) {
                if (contrib[i] > 0 && contrib[i] < m) m = contrib[i];
            }
            if (m == type(uint128).max) break;

            bool[] memory inLayer = new bool[](n);
            uint128 layer = 0;
            uint32 best = 0;
            uint8 nc = 0; // contributors to this layer
            for (uint8 i = 0; i < n; i++) {
                if (contrib[i] > 0) {
                    inLayer[i] = true;
                    nc++;
                    layer += m;
                    contrib[i] -= m;
                    if (live[i] && scores[i] > best) best = scores[i];
                }
            }

            // A single-contributor layer is an uncalled all-in overlay: return it
            // to its owner with no rake — it was never a contested pot.
            if (nc < 2) {
                for (uint8 i = 0; i < n; i++) {
                    if (inLayer[i]) {
                        _seats[tableId][i].stack += layer;
                        emit PotWinner(tableId, h.handId, potIndex, i, layer);
                        break;
                    }
                }
                potIndex++;
                continue;
            }

            // Rake this contested layer, sharing the per-hand cap across all pots.
            uint128 r = uint128((uint256(layer) * cfg.rakeBps) / 10000);
            if (accRake + r > cfg.rakeCap) r = cfg.rakeCap - accRake;
            accRake += r;
            uint128 payable_ = layer - r;

            // Count winners (live contributors holding the best score).
            uint8 winners = 0;
            for (uint8 i = 0; i < n; i++) {
                if (inLayer[i] && live[i] && scores[i] == best) winners++;
            }

            if (winners == 0) {
                // Defensive: a contested layer with no live contender cannot occur
                // in normal play. Refund the lowest-seat contributor.
                for (uint8 i = 0; i < n; i++) {
                    if (inLayer[i]) {
                        _seats[tableId][i].stack += payable_;
                        emit PotWinner(tableId, h.handId, potIndex, i, payable_);
                        break;
                    }
                }
            } else {
                uint128 share = payable_ / winners;
                uint128 rem = payable_ - share * winners;
                // Award in seat order starting left of the button so odd chips go
                // to the earliest-position winner, as in live poker.
                for (uint8 k = 1; k <= n; k++) {
                    uint8 i = uint8((uint16(h.button) + k) % n);
                    if (inLayer[i] && live[i] && scores[i] == best) {
                        uint128 amt = share;
                        if (rem > 0) {
                            amt += 1;
                            rem -= 1;
                        }
                        _seats[tableId][i].stack += amt;
                        emit PotWinner(tableId, h.handId, potIndex, i, amt);
                    }
                }
            }
            potIndex++;
        }

        rakeCollected += accRake;
        emit ShowdownSettled(tableId, h.handId, accRake);
        _clearHand(tableId);
    }
}
