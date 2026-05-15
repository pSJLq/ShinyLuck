# ShinyLuck — agent-service

Two long-running processes:

| process    | command           | purpose                                                |
|------------|-------------------|--------------------------------------------------------|
| `api`      | `npm run api`     | Express API + player-agent tick scheduler              |
| `hm-cron`  | `npm run hm-cron` | Autonomous House Manager loop (max-bets, bonus, theme) |

## Setup

```bash
cd agent-service
npm install
cp .env.example .env       # fill RELAYER_KEY, HM_PRIVATE_KEY, addresses
```

`scripts/deploy.js` writes addresses into `deployments/somniaTestnet.json`;
copy them into `.env` or symlink them.

You need **two separate hot keys**:

- `RELAYER_KEY` — registered on `PlayerAgentRegistry` as the relayer
  authorized to call `executeBet` on behalf of player agents.
- `HM_PRIVATE_KEY` — registered on `HouseManager` as the `hmAgent`, which
  forwards admin actions to `Casino`.

Both keys should live on the laptop running this service. Top them up with a
small STT balance (≈ 0.1 STT each is plenty for testnet).

## Run

```bash
npm run api       # foreground
npm run hm-cron   # foreground (separate terminal)
```

For persistent background operation, use pm2:

```bash
npm i -g pm2
pm2 start index.js   --name agent-api
pm2 start hm-cron.js --name hm-agent
pm2 save
pm2 startup        # generates a systemd unit (Linux) or launchd plist (macOS)
```

## HM cron — what it does

- **every 5 min**: `setGameMaxBet(g, freeBankroll/100)` for each of the 6
  games (only if the current cap differs). Casino enforces the same
  1%-of-bankroll cap on the bet path, so the HM cap is for UI/UX, not safety.
- **every 60 min**: looks at the bankroll delta over the last hour.
  - `> +10%` → `activateBonusMode(60, reasoning)` — house edge × 0.5
  - `< −20%` → `pauseGame(g)` for all 6 games — operator review
- **every 24 h**: `triggerThemeRotation(name, symbols[5])` — cosmetic only.

Every decision is also recorded on-chain via `recordReasoning(string)` so the
explanation lives next to the action. If `SOMNIA_LLM_URL` is set, HM calls
that endpoint for a more natural reasoning string; otherwise it falls back to
a deterministic one-liner.

State (last-tick timestamps, hour-window bankroll baseline) is persisted to
`./data/hm-state.json` so restarting the cron does not re-fire actions.

## Player-agent API

```
GET  /health
GET  /strategies                 list all
GET  /strategies/:player
GET  /logs/:player?limit=100

POST /strategies
   body: { player, vault, raw, signature }
   signature = personalSign(JSON.stringify({ raw, vault }))

POST /strategies/:player/pause
POST /strategies/:player/resume
```

The scheduler ticks every `TICK_INTERVAL_MS` (default 30s). For each active
strategy it places one bet (subject to dailyLimit / totalLimit / stop
conditions) and reconciles recent `BetSettled` events into per-strategy P&L
stats used for stop-win / stop-loss.

## NL strategy grammar (MVP)

```
play dice for 1 STT, target 60, over, stop after 10 wins, stop loss 5 STT
play roulette red 0.05 STT
play plinko medium 0.1 STT, stop loss 1 STT
play slots 0.05 STT
```

Future: Somnia LLM Inference Agent for free-form text. The contract does
NOT depend on this — the structured form is what the relayer executes.
