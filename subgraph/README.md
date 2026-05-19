# ShinyLuck Subgraph

Historical-data subgraph for the ShinyLuck on-chain casino. Live (sub-second)
UI updates come from the Somnia Off-chain Reactivity SDK in the frontend; this
subgraph backs the leaderboard, per-player P&L, and account-history pages
where the query needs to aggregate across weeks of bets.

## Entities

| Entity           | Purpose                                                       |
|------------------|---------------------------------------------------------------|
| `Player`         | Per-address aggregates: bets, wagered, paid, net P&L, streak  |
| `Bet`            | Every single bet — place + settle stitched together           |
| `CrashRound`     | Round-based Crash sessions + crash point                      |
| `RouletteRound`  | Round-based Roulette sessions + winning number (0..37, 37=00) |
| `ReasoningLog`   | Autonomous HouseManager Agent decisions                       |
| `RtpAdjustment`  | HM-driven slot RTP flexes (±2% from 9200 baseline)            |
| `BonusModeEvent` | Bonus Mode activations                                        |
| `DailyStats`     | YYYY-MM-DD buckets: bets, wagered, paid, top win              |

## Deploy

The schema + mappings + build (`build/subgraph.yaml`, `build/*.wasm`) are
produced locally; we couldn't auto-deploy via the documented endpoint:

```
https://subgraph.somnia.network/ipfs/  → 405 Method Not Allowed
https://subgraph.somnia.network/api/v0/add → 405 (POST not accepted by gateway)
```

The Ormi-hosted Somnia subgraph endpoint as of 2026-05 appears to be
**read-only** for the public IPFS path — deployment goes through the
authenticated dashboard at https://subgraph.somnia.network/ or via Ormi's
private CLI. Steps to ship from this folder:

```bash
npm install
npm run codegen     # generates AssemblyScript types from the contract ABIs
npm run build
# Then upload build/ via the Ormi dashboard:
#   - log in at https://subgraph.somnia.network/ with the wallet that owns the
#     ORMI_API_KEY in .env
#   - create subgraph "shinyluck/casino"
#   - upload build/subgraph.yaml + build/*.wasm + build/schema.graphql
# OR (preferred when their public IPFS gateway is restored):
ORMI_API_KEY=... npm run deploy:ormi
```

After deploy the GraphQL endpoint is at
`https://subgraph.somnia.network/api/<subgraph-id>`. Update
`frontend/lib/config.js` with the endpoint, and `frontend/lib/leaderboard.js`
will switch from `eth_getLogs` polling to `gquery(...)` calls automatically.

## Re-deploy after contract redeploy

The Casino + HouseManager addresses are pinned in `subgraph.yaml`. After a
contract redeploy:

1. Update `dataSources[*].source.address` and `startBlock` in `subgraph.yaml`.
2. `npm run build && npm run deploy:ormi`.
3. Ormi versions the subgraph automatically; previous versions stay queryable
   until you delete them in the dashboard.
