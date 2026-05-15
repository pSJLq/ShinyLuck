# demo-bot

Tiny script that keeps ShinyLuck's Live Feed alive during demo videos and
judge reviews by placing small random bets from a roster of pre-funded
testnet wallets.

**Do not run against mainnet.** This bot is a demo aid only.

## Setup

1. Generate 5–10 testnet wallets and fund each with enough STT for ~50 bets
   plus gas (e.g., 0.5 STT each).
2. `cp .env.example .env`, fill `CASINO_ADDRESS` and the comma-separated
   `WALLET_KEYS` (private keys, no `0x` prefix needed).
3. `npm install && npm start`.

The bot sleeps a random interval between `MIN_INTERVAL` and `MAX_INTERVAL`
seconds, picks a random wallet, picks a random game (Dice / Crash / Slots /
Plinko / Roulette — Mines is multi-step and skipped), and submits a random
stake between `MIN_STAKE` and `MAX_STAKE` STT. Bets settle automatically when
the house service reveals seeds (or when the bot itself triggers reveal in
follow-up versions).
