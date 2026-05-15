// NL → structured strategy parser.
//
// MVP: regex-based parser for the documented grammar:
//   "play <game> for <amount> STT, [target <X>], [over|under], [stop after <N> wins], [stop loss <Y> STT]"
//
// Future: fall back to Somnia LLM Inference Agent for free-form text. The
// agent.html UI passes the raw NL text and the structured form side-by-side
// so the player can confirm.

const GAMES = {
  dice: 0,
  crash: 1,
  slots: 2,       // VAULT.7
  vault7: 2,      // alias
  vault: 2,       // alias
  mines: 3,
  plinko: 4,
  roulette: 5,
  cluster: 6,     // SUGAR.LAB
  sugarlab: 6,    // alias
  sugar: 6,       // alias
};

function parseStrategy(text) {
  if (!text || typeof text !== "string") throw new Error("empty strategy text");
  const t = text.toLowerCase().trim();

  // game
  let game;
  for (const g of Object.keys(GAMES)) {
    if (new RegExp(`\\b${g}\\b`).test(t)) { game = g; break; }
  }
  if (!game) throw new Error("could not detect game");

  // amount in STT
  const amountMatch = t.match(/(\d+(?:\.\d+)?)\s*stt/);
  const betSTT = amountMatch ? parseFloat(amountMatch[1]) : 0.1;

  // dice target
  let target = 50;
  const tMatch = t.match(/(?:target|on)\s+(\d{1,2})/);
  if (tMatch) target = parseInt(tMatch[1], 10);

  // over / under
  const direction = /\bover\b/.test(t) ? "over" : (/\bunder\b/.test(t) ? "under" : "over");

  // stop conditions
  const stopWinsMatch = t.match(/(?:stop|after).*?(\d+).*?(?:win|wins)/);
  const stopLossMatch = t.match(/(?:stop\s*loss|loss).*?(\d+(?:\.\d+)?)\s*stt/);
  const stopWins = stopWinsMatch ? parseInt(stopWinsMatch[1], 10) : 0;
  const stopLossSTT = stopLossMatch ? parseFloat(stopLossMatch[1]) : 0;

  // crash autoCashout
  const autoCashoutMatch = t.match(/(?:auto\s*cashout|cashout\s*at)\s+(\d+(?:\.\d+)?)x?/);
  const autoCashout = autoCashoutMatch ? parseFloat(autoCashoutMatch[1]) : 1.5;

  // plinko risk
  const risk = /\bhigh\b/.test(t) ? 2 : (/\bmedium\b/.test(t) ? 1 : 0);

  // roulette kind
  let rouletteKind = "RED";
  if (/\bblack\b/.test(t)) rouletteKind = "BLACK";
  else if (/\beven\b/.test(t)) rouletteKind = "EVEN";
  else if (/\bodd\b/.test(t)) rouletteKind = "ODD";

  return {
    game,
    gameId: GAMES[game],
    betSTT,
    direction,
    target,
    stopWins,
    stopLossSTT,
    autoCashout,
    risk,
    rouletteKind,
    raw: text,
  };
}

module.exports = { parseStrategy, GAMES };
