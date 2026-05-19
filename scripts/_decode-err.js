const { keccak256, toUtf8Bytes } = require("ethers");
const TARGET = "0xb0a6baa5";
const errs = [
  "InvalidBet(string)", "BetTooLarge()", "BankrollInsufficient()", "NoSeedAvailable()",
  "NotHouseManager()", "InvalidGame()", "BetNotOpen()", "BetExpired()", "AlreadySettled()",
  "SeedAlreadyRevealed()", "InvalidSeedReveal()", "CircuitBreakerOpen()", "RouletteInvalidBet(string)",
  "GamePaused()", "EnforcedPause()", "NotOwner()", "Unauthorized()",
  "OwnableUnauthorizedAccount(address)", "ReentrancyGuardReentrantCall()",
  "RtpOutOfBand(uint16,uint16)", "RouletteRoundNotOpen()", "RouletteRoundClosed()",
  "MaxBetsPerRoundExceeded()", "RoundInvalidBet(string)", "RoundClosed()",
  "Refunded(uint256,string)", "DepositTooSmall()", "PausedAll()",
];
for (const e of errs) {
  const sel = keccak256(toUtf8Bytes(e)).slice(0, 10);
  const marker = sel === TARGET ? "  <<< MATCH" : "";
  console.log(sel, e, marker);
}
