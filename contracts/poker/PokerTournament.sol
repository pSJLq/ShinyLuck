// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/// Mirrors PokerRoom.TableConfig field order.
struct RoomTableConfig {
    uint8 maxSeats;
    uint128 smallBlind;
    uint128 bigBlind;
    uint128 ante;
    uint128 minBuyIn;
    uint128 maxBuyIn;
    uint16 rakeBps;
    uint128 rakeCap;
    uint32 actionTimeout;
    bool active;
}

struct RoomSeat {
    address player;
    uint128 stack;
    bool occupied;
    bool sittingOut;
    uint64 sitInHandId;
}

interface IPokerRoomT {
    function createControlledTable(RoomTableConfig calldata cfg) external returns (uint256);
    function seatPlayerWithChips(uint256 tableId, uint8 seat, address player, uint128 chips) external;
    function removeSeat(uint256 tableId, uint8 seat) external;
    function setBlinds(uint256 tableId, uint128 sb, uint128 bb, uint128 ante) external;
    function depositFor(address player) external payable;
    function getSeat(uint256 tableId, uint8 seat) external view returns (RoomSeat memory);
    function handInProgress(uint256 tableId) external view returns (bool);
}

/// @title PokerTournament
/// @notice On-chain single-table tournaments (SNG-style) for ShinyPoker. The
///         prize pool can come from player BUY-INS, a creator-SPONSORED pool, or
///         both — and the CREATOR defines the payout split. Play reuses a
///         PokerRoom "controlled" table (tournament chips, rising blinds, busts);
///         finishers are paid from the pool straight into their in-room balance.
contract PokerTournament is Ownable, ReentrancyGuard {
    using Address for address payable;

    IPokerRoomT public room;
    address public operator; // off-chain bot that drives level-ups + bust reports

    uint8 internal constant REGISTERING = 0;
    uint8 internal constant RUNNING = 1;
    uint8 internal constant FINISHED = 2;
    uint8 internal constant CANCELLED = 3;

    struct T {
        address creator;
        uint128 buyIn; // per-player, added to the pool
        uint128 fee; // per-player, to the house
        uint128 startStack; // tournament chips per player
        uint128 sbStart;
        uint128 bbStart;
        uint128 sponsored; // creator-funded prize
        uint128 pool; // sponsored + sum(buyIns)
        uint64 levelDur; // seconds per blind level
        uint64 startedAt;
        uint8 maxPlayers;
        uint8 status;
        uint8 remaining;
        uint8 level;
        uint256 tableId;
        uint16[] payoutBps; // [6500, 3500, …]; must sum to 10000
        address[] players;
        mapping(address => bool) registered;
        mapping(address => bool) busted;
    }

    uint256 public count;
    mapping(uint256 => T) internal _t;
    uint256 public feeCollected;

    event TournamentCreated(uint256 indexed id, address indexed creator, uint128 buyIn, uint128 fee, uint128 sponsored, uint8 maxPlayers);
    event Registered(uint256 indexed id, address indexed player, uint128 pool, uint8 count);
    event Unregistered(uint256 indexed id, address indexed player);
    event Started(uint256 indexed id, uint256 indexed tableId, uint8 players);
    event LevelUp(uint256 indexed id, uint8 level, uint128 sb, uint128 bb);
    event Busted(uint256 indexed id, address indexed player, uint8 place, uint128 prize);
    event Finished(uint256 indexed id, address indexed winner, uint128 prize);
    event Cancelled(uint256 indexed id);

    error NotOperator();
    error BadParams();
    error WrongValue();
    error Full();
    error AlreadyIn();
    error NotIn();
    error NotRegistering();
    error NotRunning();
    error TooFew();
    error HandLive();
    error NotDue();
    error NotBusted();

    constructor(address initialOwner, IPokerRoomT room_) Ownable(initialOwner) {
        room = room_;
    }

    modifier onlyOp() {
        if (msg.sender != operator && msg.sender != owner()) revert NotOperator();
        _;
    }

    function setOperator(address op) external onlyOwner {
        operator = op;
    }

    function setRoom(IPokerRoomT r) external onlyOwner {
        room = r;
    }

    /// @notice Create a tournament. Any msg.value is a creator-sponsored prize
    ///         added to the pool (so one person can fund the whole prize). Set
    ///         buyIn>0 to also collect from players. payoutBps must sum to 10000.
    function createTournament(
        uint128 buyIn,
        uint128 fee,
        uint8 maxPlayers,
        uint128 startStack,
        uint128 sbStart,
        uint128 bbStart,
        uint64 levelDur,
        uint16[] calldata payoutBps
    ) external payable returns (uint256 id) {
        if (maxPlayers < 2 || maxPlayers > 9) revert BadParams();
        if (startStack == 0 || bbStart == 0 || sbStart == 0 || sbStart > bbStart) revert BadParams();
        if (levelDur < 30) revert BadParams();
        if (payoutBps.length == 0 || payoutBps.length > maxPlayers) revert BadParams();
        uint256 sum;
        for (uint256 i = 0; i < payoutBps.length; i++) sum += payoutBps[i];
        if (sum != 10000) revert BadParams();

        id = count++;
        T storage t = _t[id];
        t.creator = msg.sender;
        t.buyIn = buyIn;
        t.fee = fee;
        t.maxPlayers = maxPlayers;
        t.startStack = startStack;
        t.sbStart = sbStart;
        t.bbStart = bbStart;
        t.levelDur = levelDur;
        t.sponsored = uint128(msg.value);
        t.pool = uint128(msg.value);
        t.status = REGISTERING;
        for (uint256 i = 0; i < payoutBps.length; i++) t.payoutBps.push(payoutBps[i]);
        emit TournamentCreated(id, msg.sender, buyIn, fee, uint128(msg.value), maxPlayers);
    }

    /// @notice Register + pay buy-in (+ fee). For a free sponsored tournament set buyIn=fee=0.
    function register(uint256 id) external payable nonReentrant {
        T storage t = _t[id];
        if (t.status != REGISTERING) revert NotRegistering();
        if (t.players.length >= t.maxPlayers) revert Full();
        if (t.registered[msg.sender]) revert AlreadyIn();
        if (msg.value != uint256(t.buyIn) + uint256(t.fee)) revert WrongValue();
        t.pool += t.buyIn;
        feeCollected += t.fee;
        t.registered[msg.sender] = true;
        t.players.push(msg.sender);
        emit Registered(id, msg.sender, t.pool, uint8(t.players.length));
    }

    /// @notice Unregister before the tournament starts; refunds buy-in + fee.
    function unregister(uint256 id) external nonReentrant {
        T storage t = _t[id];
        if (t.status != REGISTERING) revert NotRegistering();
        if (!t.registered[msg.sender]) revert NotIn();
        t.registered[msg.sender] = false;
        uint256 n = t.players.length;
        for (uint256 i = 0; i < n; i++) {
            if (t.players[i] == msg.sender) {
                t.players[i] = t.players[n - 1];
                t.players.pop();
                break;
            }
        }
        t.pool -= t.buyIn;
        if (feeCollected >= t.fee) feeCollected -= t.fee;
        uint256 refund = uint256(t.buyIn) + uint256(t.fee);
        if (refund > 0) payable(msg.sender).sendValue(refund);
        emit Unregistered(id, msg.sender);
    }

    /// @notice Start: open a controlled table, seat everyone with the starting
    ///         stack at level-1 blinds. Creator / operator / owner.
    function start(uint256 id) external nonReentrant {
        T storage t = _t[id];
        if (t.status != REGISTERING) revert NotRegistering();
        if (msg.sender != t.creator && msg.sender != operator && msg.sender != owner()) revert NotOperator();
        uint8 n = uint8(t.players.length);
        if (n < 2) revert TooFew();

        RoomTableConfig memory cfg = RoomTableConfig({
            maxSeats: n,
            smallBlind: t.sbStart,
            bigBlind: t.bbStart,
            ante: 0,
            minBuyIn: 0,
            maxBuyIn: 0,
            rakeBps: 0,
            rakeCap: 0,
            actionTimeout: 45,
            active: true
        });
        uint256 tableId = room.createControlledTable(cfg);
        t.tableId = tableId;
        for (uint8 i = 0; i < n; i++) {
            room.seatPlayerWithChips(tableId, i, t.players[i], t.startStack);
        }
        t.startedAt = uint64(block.timestamp);
        t.remaining = n;
        t.status = RUNNING;
        emit Started(id, tableId, n);
    }

    /// @notice Raise the blinds once the current level's time has elapsed.
    function levelUp(uint256 id) external onlyOp {
        T storage t = _t[id];
        if (t.status != RUNNING) revert NotRunning();
        if (block.timestamp < t.startedAt + uint64(t.level + 1) * t.levelDur) revert NotDue();
        if (room.handInProgress(t.tableId)) revert HandLive();
        t.level += 1;
        uint128 mult = uint128(1) << t.level; // blinds double each level
        uint128 sb = t.sbStart * mult;
        uint128 bb = t.bbStart * mult;
        room.setBlinds(t.tableId, sb, bb, 0);
        emit LevelUp(id, t.level, sb, bb);
    }

    /// @notice Report a busted seat (stack 0). Pays the finisher if in the money,
    ///         and when one player is left pays the winner and ends the event.
    function reportBust(uint256 id, uint8 seat) external onlyOp nonReentrant {
        T storage t = _t[id];
        if (t.status != RUNNING) revert NotRunning();
        if (room.handInProgress(t.tableId)) revert HandLive();
        RoomSeat memory s = room.getSeat(t.tableId, seat);
        address player = s.player;
        if (player == address(0) || !t.registered[player] || t.busted[player] || s.stack != 0) revert NotBusted();

        uint8 place = t.remaining; // this player finishes here (e.g. 9th of 9)
        t.busted[player] = true;
        t.remaining -= 1;
        room.removeSeat(t.tableId, seat);
        _pay(t, id, player, place);

        if (t.remaining == 1) {
            address winner = _lastStanding(t);
            uint128 prize = _prize(t, 1);
            if (prize > 0) room.depositFor{value: prize}(winner);
            t.status = FINISHED;
            emit Finished(id, winner, prize);
        }
    }

    /// @notice Cancel a tournament that never started; refunds buy-ins + sponsor.
    function cancel(uint256 id) external nonReentrant {
        T storage t = _t[id];
        if (t.status != REGISTERING) revert NotRegistering();
        if (msg.sender != t.creator && msg.sender != owner()) revert NotOperator();
        t.status = CANCELLED;
        uint256 each = uint256(t.buyIn) + uint256(t.fee);
        uint256 feesBack = uint256(t.fee) * t.players.length;
        if (feeCollected >= feesBack) feeCollected -= feesBack;
        for (uint256 i = 0; i < t.players.length; i++) {
            if (each > 0) payable(t.players[i]).sendValue(each);
        }
        if (t.sponsored > 0) payable(t.creator).sendValue(t.sponsored);
        t.pool = 0;
        emit Cancelled(id);
    }

    function withdrawFees(address to, uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0 || amount > feeCollected) revert WrongValue();
        feeCollected -= amount;
        payable(to).sendValue(amount);
    }

    function _prize(T storage t, uint8 place) internal view returns (uint128) {
        if (place == 0 || place > t.payoutBps.length) return 0;
        return uint128((uint256(t.pool) * t.payoutBps[place - 1]) / 10000);
    }

    function _pay(T storage t, uint256 id, address player, uint8 place) internal {
        uint128 prize = _prize(t, place);
        if (prize > 0) room.depositFor{value: prize}(player);
        emit Busted(id, player, place, prize);
    }

    function _lastStanding(T storage t) internal view returns (address) {
        for (uint256 i = 0; i < t.players.length; i++) {
            if (!t.busted[t.players[i]]) return t.players[i];
        }
        return address(0);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function info(uint256 id)
        external
        view
        returns (
            address creator,
            uint128 buyIn,
            uint128 fee,
            uint128 startStack,
            uint128 pool,
            uint8 maxPlayers,
            uint8 registered,
            uint8 status,
            uint8 remaining,
            uint256 tableId,
            uint16[] memory payoutBps
        )
    {
        T storage t = _t[id];
        return (t.creator, t.buyIn, t.fee, t.startStack, t.pool, t.maxPlayers, uint8(t.players.length), t.status, t.remaining, t.tableId, t.payoutBps);
    }

    function playersOf(uint256 id) external view returns (address[] memory) {
        return _t[id].players;
    }

    /// @notice Level clock for the off-chain driver (compute "level-up due" locally).
    function clock(uint256 id)
        external
        view
        returns (uint64 startedAt, uint8 level, uint64 levelDur, uint128 sbStart, uint128 bbStart)
    {
        T storage t = _t[id];
        return (t.startedAt, t.level, t.levelDur, t.sbStart, t.bbStart);
    }

    function isRegistered(uint256 id, address p) external view returns (bool) {
        return _t[id].registered[p];
    }
}
