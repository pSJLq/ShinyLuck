# ShinyLuck

Agent-native on-chain casino on Somnia. Submission for Somnia Agentathon
(May 18 – June 7, 2026).

## What it is

- 6 provably-fair games (Dice, Crash, Slots, Mines, Plinko, Roulette) in a
  single `Casino.sol` with a `GameType` enum.
- Randomness via commit-reveal + future blockhash. **No LLM in the money path.**
- **House Manager Agent** (autonomous Somnia agent) tunes max bet, pause/unpause,
  Bonus Mode, and writes on-chain reasoning logs.
- **Player Agents**: users register agents that bet on their behalf within
  daily/total limits, driven by NL strategies parsed via Somnia's LLM Inference
  Agent.
- LLM Inference Agent is used only for flavor text, slot themes, and translating
  HM decisions to human language.

## Stack

- Solidity 0.8.24, Hardhat + hardhat-toolbox
- ethers.js v6 (frontend SDK and agent-service)
- Node.js LTS for off-chain agent service
- Vanilla HTML/CSS/JS frontend (no framework)

## Project layout

```
contracts/         Solidity sources
  interfaces/      external interfaces (Somnia agents, callbacks)
scripts/           deploy / verify scripts
test/              hardhat unit + fuzz tests
frontend/          static site (HTML/CSS/JS)
  games/           per-game pages
  lib/             shinyluck-sdk.js (ethers v6 wrapper)
agent-service/     Node.js service for player-agents (Hetzner VPS)
  strategies/      NL parser + executor
demo-bot/          live-feed bot for demo only
```

## Networks

| Network          | Chain ID | RPC                                    | Native | Explorer                                |
| ---------------- | -------- | -------------------------------------- | ------ | --------------------------------------- |
| Somnia Testnet (Shannon) | 50312 | https://dream-rpc.somnia.network | STT    | https://shannon-explorer.somnia.network |
| Somnia Mainnet   | TBD      | TBD                                    | SOMI   | https://explorer.somnia.network         |

Mainnet entry is commented out in `hardhat.config.js` until final deploy.

## Setup

```bash
npm install
cp .env.example .env
# fill PRIVATE_KEY, RPC_*

npm run compile
npm test
```

Deploy to testnet:

```bash
npm run deploy:testnet
```

## Status

Early scaffolding. Roadmap is split into 20 checkpoints; the project is built
checkpoint-by-checkpoint with manual review between each.

## Security model

- ReentrancyGuard + CEI on every external state-changing function.
- Pull payments via `pendingWithdrawals` + `claim()`.
- 24h timelock on owner profit withdrawal.
- 1%-of-bankroll hard cap per single bet.
- Auto-pause if house loses >20% in an hour.
- 100% test coverage on the critical path (commit, reveal, payout, withdraw)
  plus fuzz tests on blockhash edge cases.

## License

TBD.
