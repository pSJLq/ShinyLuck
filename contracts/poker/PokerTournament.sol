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
    uint64 sitOutSince; // when sittingOut was set (0 = playing) — idle-forfeit basis
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

    /// One blind level in a custom structure (LePoker-style).
    struct Level {
        uint128 sb;
        uint128 bb;
        uint128 ante;
        uint32 durationSecs;
    }

    struct T {
        address creator;
        uint128 buyIn; // per-player, added to the pool
        uint128 fee; // per-player, to the house
        uint128 startStack; // tournament chips per player
        uint128 sbStart;
        uint128 bbStart;
        uint128 curSb; // current blind level values
        uint128 curBb;
        uint128 anteStart;
        uint128 curAnte;
        uint64 startTime; // 0 = manual / when-full; else earliest scheduled start (unix)
        uint128 sponsored; // creator-funded prize
        uint128 pool; // sponsored + sum(buyIns)
        uint64 levelDur; // seconds per blind level
        uint64 startedAt;
        uint16 growthBps; // blind growth per level, e.g. 15000 = ×1.5, 20000 = ×2
        uint16 hostBps; // creator's cut of the final pool (host reward), ≤10%
        bool approvalRequired; // creator screens entries (sponsor-gated events)
        uint8 maxPlayers;
        uint8 seatsPerTable; // players per table (MTT); == field size for single-table
        uint32 actionSecs; // per-action clock (seconds)
        uint8 status;
        uint8 remaining;
        uint8 level;
        uint256 tableId; // == tables[0] (kept for the single-table HUD)
        uint256[] tables; // one entry per controlled table (MTT spans several)
        uint16[] payoutBps; // [6500, 3500, …]; must sum to 10000
        Level[] structure; // custom blind schedule; empty → geometric growthBps/levelDur
        address[] players;
        address[] applicants; // approval mode: who has applied (escrowed)
        mapping(address => bool) registered;
        mapping(address => bool) pending; // applied, awaiting creator approval
        mapping(address => bool) busted;
    }

    uint256 public count;
    mapping(uint256 => T) internal _t;
    uint256 public feeCollected;
    // Mental-poker tables can't deal an absent player dead hands (the deal
    // needs every participant's live key), so an abandoned seat's stack would
    // freeze and block the event from ever finishing. After this many seconds
    // of continuous sit-out the operator may forfeit the seat at its current
    // place; a connected player cancels the countdown any time by sitting in.
    uint64 public idleForfeitSecs = 300;

    event TournamentCreated(uint256 indexed id, address indexed creator, uint128 buyIn, uint128 fee, uint128 sponsored, uint8 maxPlayers);
    event Registered(uint256 indexed id, address indexed player, uint128 pool, uint8 count);
    event Unregistered(uint256 indexed id, address indexed player);
    event Applied(uint256 indexed id, address indexed player);
    event ApplicationRejected(uint256 indexed id, address indexed player);
    event ApplicationWithdrawn(uint256 indexed id, address indexed player);
    event Started(uint256 indexed id, uint256 indexed tableId, uint8 players);
    event LevelUp(uint256 indexed id, uint8 level, uint128 sb, uint128 bb);
    event Busted(uint256 indexed id, address indexed player, uint8 place, uint128 prize);
    event Finished(uint256 indexed id, address indexed winner, uint128 prize);
    event HostPaid(uint256 indexed id, address indexed host, uint128 amount);
    event Cancelled(uint256 indexed id);
    event PlayerMoved(uint256 indexed id, address indexed player, uint256 fromTable, uint256 toTable);
    event ForfeitedIdle(uint256 indexed id, address indexed player, uint8 place);

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
    error NotCreator();
    error NotPending();
    error NotIdleLongEnough();

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

    function setIdleForfeitSecs(uint64 s) external onlyOwner {
        if (s < 60) revert BadParams(); // never a hair-trigger — players get a real window to reconnect
        idleForfeitSecs = s;
    }

    function setRoom(IPokerRoomT r) external onlyOwner {
        room = r;
    }

    /// @dev Creation params bundled in a struct to keep the call clean and avoid
    ///      stack-too-deep as the feature set grows (antes, scheduling, …).
    struct TournamentParams {
        uint128 buyIn;
        uint128 fee;
        uint8 maxPlayers;
        uint8 seatsPerTable; // 0 = single table (<=9 players); else players/table → MTT
        uint128 startStack;
        uint128 sbStart;
        uint128 bbStart;
        uint128 anteStart; // 0 = no ante; grows with the blinds each level
        uint64 levelDur;
        uint16 growthBps;
        uint64 startTime; // 0 = start manually / when full; else earliest start (unix)
        bool approvalRequired;
        uint32 actionSecs; // per-action clock (0 → default 30s)
        uint16[] payoutBps;
        Level[] structure; // if non-empty, overrides geometric sbStart/growthBps/levelDur
        uint16 hostBps; // creator's cut of the final pool (0 = none, max 1000 = 10%);
        // only meaningful for buy-in events — a sponsor "rewarding" himself from
        // his own sponsorship is pointless, so buyIn == 0 forbids it
    }

    /// @notice Create a tournament. Any msg.value is a creator-sponsored prize
    ///         added to the pool — set buyIn=0 + sponsor the pool for a FREE,
    ///         fully-sponsored event. `payoutBps` must sum to 10000 (custom,
    ///         unequal, top-N splits allowed). `growthBps` = blind/ante growth
    ///         per level (15000 = ×1.5, 20000 = ×2). `startTime` (unix) schedules
    ///         the start; 0 = manual/when-full. `approvalRequired` = entries wait
    ///         for the creator's approval (private games).
    function createTournament(TournamentParams calldata p) external payable returns (uint256 id) {
        if (p.maxPlayers < 2 || p.maxPlayers > 45) revert BadParams();
        uint8 tableSize = p.seatsPerTable == 0 ? (p.maxPlayers <= 9 ? p.maxPlayers : 9) : p.seatsPerTable;
        if (tableSize < 2 || tableSize > 9) revert BadParams();
        if (p.startStack == 0) revert BadParams();
        bool hasStruct = p.structure.length > 0;
        if (hasStruct) {
            if (p.structure.length > 40) revert BadParams();
            for (uint256 i = 0; i < p.structure.length; i++) {
                Level calldata lv = p.structure[i];
                if (lv.bb == 0 || lv.sb == 0 || lv.sb > lv.bb || lv.ante > lv.bb || lv.durationSecs < 15) revert BadParams();
            }
        } else {
            if (p.bbStart == 0 || p.sbStart == 0 || p.sbStart > p.bbStart) revert BadParams();
            if (p.anteStart > p.bbStart) revert BadParams();
            if (p.levelDur < 30) revert BadParams();
            if (p.growthBps < 10500 || p.growthBps > 40000) revert BadParams();
        }
        if (p.startTime != 0 && p.startTime <= block.timestamp) revert BadParams();
        if (p.payoutBps.length == 0 || p.payoutBps.length > p.maxPlayers) revert BadParams();
        uint256 sum;
        for (uint256 i = 0; i < p.payoutBps.length; i++) sum += p.payoutBps[i];
        if (sum != 10000) revert BadParams();
        if (p.hostBps > 1000) revert BadParams(); // host reward capped at 10% of the pool
        if (p.hostBps > 0 && p.buyIn == 0) revert BadParams(); // buy-in events only

        id = count++;
        T storage t = _t[id];
        t.creator = msg.sender;
        t.buyIn = p.buyIn;
        t.fee = p.fee;
        t.maxPlayers = p.maxPlayers;
        t.seatsPerTable = tableSize;
        t.startStack = p.startStack;
        t.sbStart = p.sbStart;
        t.bbStart = p.bbStart;
        t.anteStart = p.anteStart;
        t.levelDur = p.levelDur;
        t.growthBps = p.growthBps;
        t.actionSecs = p.actionSecs == 0 ? 30 : (p.actionSecs > 120 ? 120 : p.actionSecs);
        if (hasStruct) {
            for (uint256 i = 0; i < p.structure.length; i++) t.structure.push(p.structure[i]);
            t.curSb = p.structure[0].sb;
            t.curBb = p.structure[0].bb;
            t.curAnte = p.structure[0].ante;
        } else {
            t.curSb = p.sbStart;
            t.curBb = p.bbStart;
            t.curAnte = p.anteStart;
        }
        t.startTime = p.startTime;
        t.approvalRequired = p.approvalRequired;
        t.hostBps = p.hostBps;
        t.sponsored = uint128(msg.value);
        t.pool = uint128(msg.value);
        t.status = REGISTERING;
        for (uint256 i = 0; i < p.payoutBps.length; i++) t.payoutBps.push(p.payoutBps[i]);
        emit TournamentCreated(id, msg.sender, p.buyIn, p.fee, uint128(msg.value), p.maxPlayers);
    }

    /// @notice Register + pay buy-in (+ fee). In approval mode your entry waits
    ///         (escrowed) until the creator approves it — withdraw any time.
    function register(uint256 id) external payable nonReentrant {
        T storage t = _t[id];
        if (t.status != REGISTERING) revert NotRegistering();
        if (t.registered[msg.sender] || t.pending[msg.sender]) revert AlreadyIn();
        if (msg.value != uint256(t.buyIn) + uint256(t.fee)) revert WrongValue();
        if (t.approvalRequired && msg.sender != t.creator) {
            if (t.applicants.length >= 64) revert Full(); // bound refund loops
            t.pending[msg.sender] = true;
            t.applicants.push(msg.sender);
            emit Applied(id, msg.sender);
            return;
        }
        _admit(t, id, msg.sender);
    }

    function _admit(T storage t, uint256 id, address player) internal {
        if (t.players.length >= t.maxPlayers) revert Full();
        t.pool += t.buyIn;
        feeCollected += t.fee;
        t.registered[player] = true;
        t.players.push(player);
        emit Registered(id, player, t.pool, uint8(t.players.length));
    }

    /// @notice Creator approves a pending entry (approval mode).
    function approveEntry(uint256 id, address player) external {
        T storage t = _t[id];
        if (msg.sender != t.creator) revert NotCreator();
        if (t.status != REGISTERING) revert NotRegistering();
        if (!t.pending[player]) revert NotPending();
        t.pending[player] = false;
        _admit(t, id, player);
    }

    /// @notice Creator rejects a pending entry — full refund.
    function rejectEntry(uint256 id, address player) external nonReentrant {
        T storage t = _t[id];
        if (msg.sender != t.creator) revert NotCreator();
        if (!t.pending[player]) revert NotPending();
        t.pending[player] = false;
        payable(player).sendValue(uint256(t.buyIn) + uint256(t.fee));
        emit ApplicationRejected(id, player);
    }

    /// @notice Withdraw your own pending application (works in ANY status, so
    ///         an entry never gets stuck if the event starts/finishes without you).
    function withdrawApplication(uint256 id) external nonReentrant {
        T storage t = _t[id];
        if (!t.pending[msg.sender]) revert NotPending();
        t.pending[msg.sender] = false;
        payable(msg.sender).sendValue(uint256(t.buyIn) + uint256(t.fee));
        emit ApplicationWithdrawn(id, msg.sender);
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
        // Scheduled events: only the creator may start before the scheduled time;
        // the operator/owner (the bot) waits until startTime to kick it off.
        if (t.startTime != 0 && block.timestamp < t.startTime && msg.sender != t.creator) revert NotDue();
        uint8 n = uint8(t.players.length);
        if (n < 2) revert TooFew();

        // Open ceil(n / seatsPerTable) controlled tables (each full-size so the
        // bot can later rebalance/consolidate into them via movePlayer).
        uint8 ts = t.seatsPerTable;
        uint8 numTables = uint8((uint16(n) + ts - 1) / ts);
        for (uint8 j = 0; j < numTables; j++) {
            RoomTableConfig memory cfg = RoomTableConfig({
                maxSeats: ts,
                smallBlind: t.curSb,
                bigBlind: t.curBb,
                ante: t.curAnte,
                minBuyIn: 0,
                maxBuyIn: 0,
                rakeBps: 0,
                rakeCap: 0,
                actionTimeout: t.actionSecs == 0 ? 30 : t.actionSecs,
                active: true
            });
            t.tables.push(room.createControlledTable(cfg));
        }
        // round-robin seating → balanced starting fields across the tables
        uint8[] memory seatIdx = new uint8[](numTables);
        for (uint8 i = 0; i < n; i++) {
            uint8 tj = i % numTables;
            room.seatPlayerWithChips(t.tables[tj], seatIdx[tj], t.players[i], t.startStack);
            seatIdx[tj] += 1;
        }
        t.tableId = t.tables[0];
        t.startedAt = uint64(block.timestamp);
        t.remaining = n;
        t.status = RUNNING;
        emit Started(id, t.tables[0], n);
    }

    /// @notice Raise the blinds when the current level's time has elapsed. Uses
    ///         the custom `structure` if one was set, else geometric `growthBps`.
    function levelUp(uint256 id) external onlyOp {
        T storage t = _t[id];
        if (t.status != RUNNING) revert NotRunning();
        bool custom = t.structure.length > 0;
        if (block.timestamp < t.startedAt + _timeForNextLevel(t)) revert NotDue();
        for (uint256 k = 0; k < t.tables.length; k++) if (room.handInProgress(t.tables[k])) revert HandLive();

        t.level += 1;
        uint128 sb;
        uint128 bb;
        // BLIND CAP: once the big blind covers every chip in play twice, more
        // levels add nothing — every table is all-in-or-fold long before this.
        // Uncapped geometric growth overflowed uint128 in abandoned events and
        // wedged them; all escalation math below saturates at the cap instead.
        uint256 cap = uint256(t.startStack) * t.players.length * 2;
        if (custom && t.level < t.structure.length) {
            Level storage lv = t.structure[t.level];
            sb = lv.sb; bb = lv.bb; t.curAnte = lv.ante;
        } else {
            // Past the end of the schedule (or geometric mode): keep escalating so
            // an abandoned table can't blind-oscillate forever — someone must bust.
            uint16 g = t.growthBps < 10500 ? 15000 : t.growthBps; // structure events may not set growthBps
            uint256 sb256 = (uint256(t.curSb) * g) / 10000;
            uint256 bb256 = (uint256(t.curBb) * g) / 10000;
            if (bb256 <= t.curBb) bb256 = uint256(t.curBb) + 1; // rounding floor — always move up
            if (sb256 <= t.curSb) sb256 = uint256(t.curSb) + 1;
            if (bb256 > cap) bb256 = cap;
            if (sb256 > bb256) sb256 = bb256;
            sb = uint128(sb256);
            bb = uint128(bb256);
            if (t.curAnte > 0) {
                uint256 ante = (uint256(t.curAnte) * g) / 10000;
                if (ante <= t.curAnte) ante = uint256(t.curAnte) + 1; // always move up
                if (ante > cap) ante = cap;
                t.curAnte = uint128(ante);
            }
        }
        t.curSb = sb;
        t.curBb = bb;
        for (uint256 k = 0; k < t.tables.length; k++) room.setBlinds(t.tables[k], sb, bb, t.curAnte);
        emit LevelUp(id, t.level, sb, bb);
    }

    /// @dev Seconds after startedAt when level `t.level+1` becomes due. Custom
    ///      schedules: sum the scheduled durations; levels past the end of the
    ///      schedule (escalation overtime) each last as long as the final level.
    function _timeForNextLevel(T storage t) internal view returns (uint256 req) {
        uint256 n = t.structure.length;
        if (n == 0) return uint256(t.level + 1) * t.levelDur;
        for (uint256 i = 0; i <= t.level && i < n; i++) req += t.structure[i].durationSecs;
        if (t.level + 1 > n) req += (t.level + 1 - n) * t.structure[n - 1].durationSecs;
    }

    /// @notice True when the next blind level is due right now (off-chain driver helper).
    ///         Goes quiet once the blinds hit the cap — further levels are no-ops,
    ///         so the driver shouldn't freeze tables or burn gas for them.
    function dueForLevelUp(uint256 id) external view returns (bool) {
        T storage t = _t[id];
        if (t.status != RUNNING) return false;
        if (t.structure.length == 0 && uint256(t.curBb) >= uint256(t.startStack) * t.players.length * 2) return false;
        return block.timestamp >= t.startedAt + _timeForNextLevel(t);
    }

    /// @notice The custom blind schedule (empty if the event uses geometric growth).
    function structureOf(uint256 id) external view returns (Level[] memory) {
        return _t[id].structure;
    }

    /// @notice Report a busted seat (stack 0). Pays the finisher if in the money,
    ///         and when one player is left pays the winner and ends the event.
    function reportBust(uint256 id, uint8 tableIdx, uint8 seat) external onlyOp nonReentrant {
        T storage t = _t[id];
        if (t.status != RUNNING) revert NotRunning();
        if (tableIdx >= t.tables.length) revert BadParams();
        uint256 tid = t.tables[tableIdx];
        if (room.handInProgress(tid)) revert HandLive();
        RoomSeat memory s = room.getSeat(tid, seat);
        if (s.player == address(0) || !t.registered[s.player] || t.busted[s.player] || s.stack != 0) revert NotBusted();
        _eliminate(t, id, tid, seat, s.player);
    }

    /// @notice Forfeit a seat whose owner abandoned the event. A mental-poker
    ///         table cannot deal an absent player dead hands (every deal needs
    ///         the player's live key), so an abandoned stack never pays blinds,
    ///         never busts, and would block the event from EVER finishing.
    ///         After idleForfeitSecs of continuous sit-out the operator may
    ///         eliminate the seat at its current place (any in-the-money prize
    ///         for that place is still paid). A connected player cancels the
    ///         countdown at any moment by sitting back in — the room resets
    ///         sitOutSince to 0 — so only truly absent seats are forfeitable.
    function forfeitIdle(uint256 id, uint8 tableIdx, uint8 seat) external onlyOp nonReentrant {
        T storage t = _t[id];
        if (t.status != RUNNING) revert NotRunning();
        if (tableIdx >= t.tables.length) revert BadParams();
        uint256 tid = t.tables[tableIdx];
        if (room.handInProgress(tid)) revert HandLive();
        RoomSeat memory s = room.getSeat(tid, seat);
        if (s.player == address(0) || !t.registered[s.player] || t.busted[s.player]) revert NotBusted();
        if (!s.sittingOut || s.sitOutSince == 0 || block.timestamp < uint256(s.sitOutSince) + idleForfeitSecs) {
            revert NotIdleLongEnough();
        }
        emit ForfeitedIdle(id, s.player, t.remaining);
        _eliminate(t, id, tid, seat, s.player);
    }

    /// @dev Shared elimination: assign the current place, pay it if ITM, free
    ///      the seat, and finish the event when one player is left.
    function _eliminate(T storage t, uint256 id, uint256 tid, uint8 seat, address player) internal {
        uint8 place = t.remaining; // this player finishes here (global place, e.g. 18th of 18)
        t.busted[player] = true;
        t.remaining -= 1;
        room.removeSeat(tid, seat);
        _pay(t, id, player, place);

        if (t.remaining == 1) {
            address winner = _lastStanding(t);
            uint128 prize = _prize(t, 1);
            if (prize > 0) room.depositFor{value: prize}(winner);
            // host reward: the creator's cut of the pool, paid once at the finish
            uint128 hostCut = _hostCut(t);
            if (hostCut > 0) {
                room.depositFor{value: hostCut}(t.creator);
                emit HostPaid(id, t.creator, hostCut);
            }
            t.status = FINISHED;
            emit Finished(id, winner, prize);
        }
    }

    /// @notice MTT rebalancing: move a player (with their whole stack) from one
    ///         of the tournament's tables to an EMPTY seat on another. Operator,
    ///         between hands on both tables. Chip-conserving (removeSeat then
    ///         re-seat the same stack) — the bot computes which moves to make to
    ///         keep tables playable and to form the final table.
    function movePlayer(uint256 id, uint8 fromTableIdx, uint8 fromSeat, uint8 toTableIdx, uint8 toSeat) external onlyOp {
        T storage t = _t[id];
        if (t.status != RUNNING) revert NotRunning();
        if (fromTableIdx >= t.tables.length || toTableIdx >= t.tables.length) revert BadParams();
        uint256 fromTid = t.tables[fromTableIdx];
        uint256 toTid = t.tables[toTableIdx];
        if (fromTid == toTid) revert BadParams();
        if (room.handInProgress(fromTid) || room.handInProgress(toTid)) revert HandLive();
        RoomSeat memory from = room.getSeat(fromTid, fromSeat);
        if (from.player == address(0) || t.busted[from.player]) revert NotBusted();
        RoomSeat memory to = room.getSeat(toTid, toSeat);
        if (to.player != address(0)) revert BadParams(); // target seat must be empty
        room.removeSeat(fromTid, fromSeat);
        room.seatPlayerWithChips(toTid, toSeat, from.player, from.stack);
        emit PlayerMoved(id, from.player, fromTid, toTid);
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

    function _hostCut(T storage t) internal view returns (uint128) {
        return uint128((uint256(t.pool) * t.hostBps) / 10000);
    }

    /// @dev Prizes are computed from the pool NET of the host reward, so the
    ///      payout split still describes 100% of what the players compete for.
    function _prize(T storage t, uint8 place) internal view returns (uint128) {
        if (place == 0 || place > t.payoutBps.length) return 0;
        uint256 distributable = uint256(t.pool) - _hostCut(t);
        return uint128((distributable * t.payoutBps[place - 1]) / 10000);
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
            uint16[] memory payoutBps,
            bool approvalRequired,
            uint8 pendingCount
        )
    {
        T storage t = _t[id];
        uint8 pc = 0;
        for (uint256 i = 0; i < t.applicants.length; i++) {
            if (t.pending[t.applicants[i]]) pc++;
        }
        return (t.creator, t.buyIn, t.fee, t.startStack, t.pool, t.maxPlayers, uint8(t.players.length), t.status, t.remaining, t.tableId, t.payoutBps, t.approvalRequired, pc);
    }

    /// @notice Applicants still awaiting the creator's decision.
    function pendingEntries(uint256 id) external view returns (address[] memory out) {
        T storage t = _t[id];
        uint256 n = 0;
        for (uint256 i = 0; i < t.applicants.length; i++) if (t.pending[t.applicants[i]]) n++;
        out = new address[](n);
        uint256 j = 0;
        for (uint256 i = 0; i < t.applicants.length; i++) if (t.pending[t.applicants[i]]) out[j++] = t.applicants[i];
    }

    function isPending(uint256 id, address p) external view returns (bool) {
        return _t[id].pending[p];
    }

    function playersOf(uint256 id) external view returns (address[] memory) {
        return _t[id].players;
    }

    /// @notice The controlled tables this tournament runs on (1 for SNG, several for MTT).
    function tablesOf(uint256 id) external view returns (uint256[] memory) {
        return _t[id].tables;
    }

    /// @notice Level clock for the off-chain driver (compute "level-up due" locally).
    function clock(uint256 id)
        external
        view
        returns (uint64 startedAt, uint8 level, uint64 levelDur, uint128 curSb, uint128 curBb, uint128 curAnte, uint64 startTime)
    {
        T storage t = _t[id];
        return (t.startedAt, t.level, t.levelDur, t.curSb, t.curBb, t.curAnte, t.startTime);
    }

    function isRegistered(uint256 id, address p) external view returns (bool) {
        return _t[id].registered[p];
    }

    /// @notice Creator's host-reward cut of the pool in bps (0 = none).
    function hostBpsOf(uint256 id) external view returns (uint16) {
        return _t[id].hostBps;
    }
}
