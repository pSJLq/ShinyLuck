const { keccak256, toUtf8Bytes } = require("ethers");
const TARGET = process.argv[2] || "0x61bc0a1e";
const errs = [
  // Casino.sol errors
  "NotHouseManager()", "GameIsPaused()", "InvalidGame()", "InvalidBet(string)",
  "NoSeedAvailable()", "BetNotFound()", "BetAlreadySettled()",
  "BankrollInsufficient()", "BetTooLarge()", "RoundNotFound()", "RoundClosed()",
  "RoundNotSettleable()", "RoundAlreadySettled()", "CashoutTooLow()", "TooManyBets()",
  // OpenZeppelin / Solidity standard
  "OwnableUnauthorizedAccount(address)", "EnforcedPause()",
  "ReentrancyGuardReentrantCall()", "OwnableInvalidOwner(address)",
  // Roulette
  "RouletteInvalidBet(string)", "RouletteRoundNotOpen()", "RouletteRoundClosed()",
  // Other guesses
  "Pausable__Paused()", "Refunded(uint256,string)", "GameNotLive()",
];
console.log(`Looking for ${TARGET}\n`);
for (const e of errs) {
  const sel = keccak256(toUtf8Bytes(e)).slice(0, 10);
  const marker = sel === TARGET ? "  <<< MATCH" : "";
  if (sel === TARGET) console.log(sel, e, marker);
}
if (!errs.some(e => keccak256(toUtf8Bytes(e)).slice(0, 10) === TARGET)) {
  console.log("No match in known list. Selector dump:");
  for (const e of errs) console.log(`  ${keccak256(toUtf8Bytes(e)).slice(0, 10)}  ${e}`);
}
