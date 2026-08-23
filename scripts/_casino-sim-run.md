# Casino load rig — how to re-run it

Answers "how many people can spin VAULT.7 / SUGAR.LAB / dice at once before the
house settle bot falls behind". Runs entirely locally: no prod contracts, no
real STT, nothing touching the VPS.

The rig is a local chain mining at **101ms** (Somnia's measured block time) with
a proxy that adds the **real RPC round trip** (65ms, measured with curl from the
VPS) to every call — so the settle bot's send→confirm loop takes the same
wall-clock time it takes in production. Calibration check: one player alone gets
a result in ~1.4s on the rig vs ~1.8s measured on prod.

## Run it

Four terminals (or background jobs), from the repo root:

```bash
npx hardhat --config hardhat.sim.config.js node
```

```bash
node scripts/_rpc-lag-proxy.js
```

Deploy a throwaway casino to the local node. **It rewrites
`frontend/lib/config.js` and `frontend/agent-manifest.json`** — restore both
afterwards with `git checkout --`:

```bash
SEED_MASTER_KEY=0x1111111111111111111111111111111111111111111111111111111111111111 INITIAL_BANKROLL_ETH=66 SEED_BATCH_SIZE=200 npx hardhat --config hardhat.sim.config.js run scripts/deploy.js --network localhost
```

```bash
cp deployments/localhost.json deployments/simlag.json
```

Start the settle bot against the lag proxy (prod-like env: agents off, crash
paused, roulette on-demand):

```bash
SIM_BOT_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 SEED_MASTER_KEY=0x1111111111111111111111111111111111111111111111111111111111111111 POLL_MS=100 QUORUM_EVERY=0 AGENT_WATCHDOG=0 PLAYER_TICK_MS=0 ROUND_GAMES=roulette KEEP_PAUSED=1 WS_URL=ws://127.0.0.1:8545 SETTLE_CONCURRENCY=12 npx hardhat --config hardhat.sim.config.js run scripts/reveal-bot.js --network simlag
```

Then the swarm:

```bash
SIM_MANIFEST=simlag PLAYERS=50 MINUTES=3 THINK_MS=4000 STAKE=0.01 node scripts/_casino-load-test.js
```

`SETTLE_CONCURRENCY=1` reproduces the old serial settle behaviour for an A/B.

## Reading the result

The number that matters is **REFUNDED (expired, no result)**: a bet the bot
failed to settle inside the 256-block (~26s) blockhash window can only be
refunded, and the player sees a spin that never resolved. Anything above zero
means the house is over capacity.

## Rig limits (don't misread these as casino limits)

- Placement tops out around **9-13 spins/s** — the single-threaded local node
  and the simulated wallets share one machine. Above that, players start seeing
  `could not coalesce error`, which is the harness, not the casino.
- The bot gets a whole CPU here; on the VPS it shares 1 vCPU with the poker
  dealer, so real settle throughput will be somewhat lower.

## Read-only prod probe

`node scripts/_casino-probe.js` prints live RPC latency per method, block time,
bankroll, per-game stake caps and the bot's gas balance. It sends no
transactions.
