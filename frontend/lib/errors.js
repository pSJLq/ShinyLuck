// Centralized revert / custom-error decoder for the ShinyLuck frontend.
//
// ethers v6 surfaces custom errors as `e.shortMessage === "execution reverted (unknown custom error)"`
// unless the contract ABI exported to the Contract instance includes the error
// signatures. We embed the full Casino error catalogue here so revert messages
// like `InvalidBet("autoCashout")` display as readable text everywhere.
//
// Usage:
//   import { friendlyError } from "./errors.js";
//   try { ... } catch (e) { setStatus(friendlyError(e)); }

import { ethers } from "https://esm.sh/ethers@6.13.2";

const ERROR_FRAGMENTS = [
  "error NotHouseManager()",
  "error GameIsPaused()",
  "error InvalidGame()",
  "error InvalidBet(string reason)",
  "error NoSeedAvailable()",
  "error BetNotFound()",
  "error BetAlreadySettled()",
  "error BankrollInsufficient()",
  "error BetTooLarge()",
  // Round-based games (Crash / Roulette) — these were missing and caused
  // the "unknown custom error" toasts on placeCrashBet / settle paths.
  "error RoundNotFound()",
  "error RoundClosed()",
  "error RoundNotSettleable()",
  "error RoundAlreadySettled()",
  "error CashoutTooLow()",
  "error TooManyBets()",
  "error RevealTooEarly(uint256 currentBlock, uint256 earliestBlock)",
  "error RevealExpired(uint256 currentBlock, uint256 latestBlock)",
  "error InvalidServerSeed()",
  "error NotHmAgent()",
  // PlayerAgentRegistry / AgentVault / AgentQuorumVerifier (best effort)
  "error NotAgent()",
  "error LimitExceeded(uint256 attempted, uint256 cap)",
  "error AgentInactive()",
  "error GameNotAllowed()",
  "error TimelockNotReady(uint256 readyAt)",
  "error CircuitBreakerActive()",
  "error VaultInsufficient()",
  "error AlreadyRegistered()",
  "error NotRegistered()",
  "error NotRelayer()",
  "error DailyLimitExceeded()",
  "error TotalLimitExceeded()",
  "error ZeroAmount()",
  "error InvalidLimits()",
  "error NotPlayer()",
  "error NotRegistry()",
  "error TransferFailed()",
  "error InsufficientBalance()",
];

/// Human-readable rewrites for the `reason` string inside `InvalidBet(...)`.
/// Keys match the literal strings used in Casino.sol `revert InvalidBet(...)`.
const INVALID_BET_REASONS = {
  "autoCashout":      "Auto-cashout must be between 1.01× and 100×",
  "target":           "Dice target must be between 2 and 98",
  "mineCount":        "Mines count must be between 1 and 24",
  "cell oob":         "That cell is off the board",
  "already opened":   "Cell already opened this round",
  "not player":       "Only the bet owner can act on this round",
  "seed not revealed":"Server seed not yet revealed — wait a moment",
  "busted":           "Round is over — start a new one",
  "nothing opened":   "Open at least one cell before cashing out",
  "risk":             "Plinko risk must be low / medium / high",
  "kind":             "Unsupported roulette bet type",
  "number":           "Roulette number must be 0–36",
  "zero stake":       "Stake must be greater than 0",
  "stake too small":  "Stake is too small — increase it",
  "payout < stake":   "Internal: payout less than stake (math bug — please report)",
  "not expired":      "This bet hasn't expired yet",
  "already bet this round": "You already placed a bet in this crash round — wait for it to settle",
  "no bets":          "Roulette: add at least one bet to the cart",
  "value sum":        "Roulette: msg.value doesn't match the sum of bet amounts",
  "no free spins":    "You don't have any free spins available",
  "free spin: send 0":"Free spins require a 0-STT call — clear the stake field",
};

let _iface = null;
function iface() {
  if (!_iface) _iface = new ethers.Interface(ERROR_FRAGMENTS);
  return _iface;
}

function tryDecodeCustomError(data) {
  if (!data || typeof data !== "string" || data.length < 10) return null;
  try {
    const parsed = iface().parseError(data);
    if (!parsed) return null;
    if (parsed.name === "InvalidBet" && parsed.args && parsed.args[0]) {
      const reason = String(parsed.args[0]);
      return INVALID_BET_REASONS[reason] || `Invalid bet: ${reason}`;
    }
    if (parsed.name === "RevealTooEarly") {
      return `Reveal too early — wait for block ${parsed.args[1]} (current ${parsed.args[0]})`;
    }
    if (parsed.name === "RevealExpired") {
      return "Reveal window expired — the bet will be auto-refunded";
    }
    if (parsed.name === "BankrollInsufficient")  return "House bankroll too low for this stake";
    if (parsed.name === "BetTooLarge")           return "Stake exceeds the per-bet cap (1% of bankroll)";
    if (parsed.name === "GameIsPaused")          return "This game is paused by the House Manager";
    if (parsed.name === "BetAlreadySettled")     return "This bet was already settled";
    if (parsed.name === "BetNotFound")           return "Bet not found on-chain";
    if (parsed.name === "NoSeedAvailable")       return "Seed pool exhausted — HM is refilling, retry shortly";
    if (parsed.name === "InvalidServerSeed")     return "Server seed didn't match its commitment";
    if (parsed.name === "InvalidGame")           return "Wrong settlement path for this game";
    if (parsed.name === "LimitExceeded")         return `Agent limit hit (tried ${parsed.args[0]}, cap ${parsed.args[1]})`;
    if (parsed.name === "AgentInactive")         return "Your player agent is paused";
    if (parsed.name === "GameNotAllowed")        return "Your agent is not authorised for this game";
    if (parsed.name === "RoundNotFound")         return "No open round — wait for the next one";
    if (parsed.name === "RoundClosed")           return "Betting window for this round is closed";
    if (parsed.name === "RoundNotSettleable")    return "Round can't be settled yet — wait for the bet window to close";
    if (parsed.name === "RoundAlreadySettled")   return "This round was already settled";
    if (parsed.name === "CashoutTooLow")         return "Cashout multiplier must be ≥ 1.01×";
    if (parsed.name === "TooManyBets")           return "Maximum bets per round exceeded (5)";
    if (parsed.name === "NotHouseManager")       return "Only the House Manager Agent can do that";
    if (parsed.name === "NotHmAgent")            return "Only the House Manager Agent can do that";
    if (parsed.name === "NotAgent")              return "Only your registered agent can do that";
    if (parsed.name === "TimelockNotReady")      return `Withdrawal locked until ${new Date(Number(parsed.args[0]) * 1000).toLocaleString()}`;
    if (parsed.name === "CircuitBreakerActive")  return "Circuit breaker tripped — house is in cool-off, try later";
    if (parsed.name === "VaultInsufficient")     return "Agent vault has insufficient balance for this bet";
    if (parsed.name === "AlreadyRegistered")     return "You already have a registered agent — withdraw or delete it first";
    if (parsed.name === "NotRegistered")         return "You don't have a registered agent yet";
    if (parsed.name === "NotRelayer")            return "Only the registered relayer can execute this";
    if (parsed.name === "DailyLimitExceeded")    return "Agent's daily limit reached — resets every 24h";
    if (parsed.name === "TotalLimitExceeded")    return "Agent's cumulative limit reached";
    if (parsed.name === "ZeroAmount")            return "Amount must be greater than 0";
    if (parsed.name === "InvalidLimits")         return "Invalid agent limits (daily must be ≤ total)";
    if (parsed.name === "NotPlayer")             return "Only the vault owner can do that";
    if (parsed.name === "NotRegistry")           return "Only the agent registry can call this";
    if (parsed.name === "TransferFailed")        return "STT transfer failed — check vault balance and try again";
    if (parsed.name === "InsufficientBalance")   return "Insufficient balance for this operation";
    if (parsed.args && parsed.args.length > 0) {
      const argStr = parsed.args.map((a) => (typeof a === "bigint" ? a.toString() : String(a))).join(", ");
      return `${parsed.name}(${argStr})`;
    }
    return parsed.name;
  } catch (_) {
    return null;
  }
}

/// Extract a human-readable message from any error object thrown by ethers v6.
/// Falls back through: shortMessage → custom error decode → message → stringify.
export function friendlyError(err) {
  if (!err) return "unknown error";
  // User rejected
  if (err.code === 4001 || err.code === "ACTION_REJECTED") return "rejected in wallet";

  // ethers v6 puts revert data here for CALL_EXCEPTION
  const candidates = [
    err.data,
    err.error?.data,
    err.info?.error?.data,
    err.error?.error?.data,
  ];
  for (const d of candidates) {
    const dec = tryDecodeCustomError(typeof d === "string" ? d : d?.data);
    if (dec) return dec;
  }

  // Generic Error(string) revert reason → ethers exposes as err.reason or shortMessage
  if (err.reason && typeof err.reason === "string") return err.reason;
  if (err.shortMessage) {
    // Filter the noisy "execution reverted (unknown custom error)" wrapper
    if (/unknown custom error/i.test(err.shortMessage)) {
      return tryDecodeCustomError(err.data) || err.shortMessage;
    }
    return err.shortMessage;
  }
  if (err.message) return err.message;
  return String(err);
}

/// Quick check for the most common pre-flight client validations.
export function validateAutoCashout(x) {
  const n = parseFloat(x);
  if (!Number.isFinite(n)) return "auto-cashout must be a number";
  if (n < 1.01) return "auto-cashout must be ≥ 1.01×";
  if (n > 100) return "auto-cashout capped at 100×";
  return null;
}

export function validateStake(s) {
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n <= 0) return "stake must be > 0";
  return null;
}
