# ShinyLuck → Somnia mainnet readiness

Status of the move off testnet (STT, chainId 50312) to Somnia mainnet
(SOMI, chainId 5031). Updated 2026-07-23.

## 🔴 BLOCKER #1 — contract size (EIP-170) + deploy gas

Somnia testnet does NOT enforce the 24 576-byte runtime code cap, so these
deploy there today. Mainnet must be assumed to enforce it (standard EVM), and
separately Somnia charges **3125 gas/byte** of deployed bytecode (15.6× the
200 on Ethereum — per docs.somnia.network), so oversized contracts are also
absurdly expensive to deploy even if the cap were lifted.

Measured runtime bytecode (2026-07-23, after Casino v14):

| contract      | runtime | over 24 KB by | deploy gas @3125/byte |
|---------------|--------:|--------------:|----------------------:|
| **Casino**        | 43 300 | +18 724 | ~135 M |
| **HouseManager**  | 39 867 | +15 291 | ~125 M |
| **PokerRoom**     | 28 987 |  +4 411 |  ~91 M |
| PokerTournament   | 16 782 |    ok   |    —   |
| ZkTableDealer     | 12 047 |    ok   |    —   |
| (everything else) |  <10 K |    ok   |    —   |

The sizes above are ALREADY compiled with the strongest size settings the
toolchain offers — `hardhat.config.js` runs `viaIR: true` + `optimizer runs: 1`
on Casino/HouseManager today. So the free compiler lever is spent; shrinking
needs real code movement. Options, least→most invasive (**needs a user call on
approach** — this is an architecture decision, not a mechanical edit):

1. **Extract logic into libraries** (as Vault7Lib/ClusterLib already are).
   Move the Mines/Crash/Roulette resolvers + Merkle math + roulette payout
   tables + the Vault7/Cluster glue into `library` files → their code lives at
   separate deployed addresses, off Casino's runtime. Biggest single lever for
   Casino; keeps the same external ABI + one Casino address. Moderate refactor.
2. **Split by concern.** Casino → CasinoCore (escrow/bankroll/settle) +
   per-game modules behind an interface; HouseManager likewise. Cleanest
   long-term, largest change, touches deploy scripts + bot + frontend addresses.
3. **Proxy/diamond (EIP-2535).** Facets per game under one address; unlimited
   size. Most powerful, most complexity/audit surface — probably overkill here.

Recommendation: (1) library extraction for Casino + HouseManager; PokerRoom
(only +4.4 KB over) likely also lands via library extraction of its heaviest
paths. Do NOT attempt before the 2026-07-29 event — it's a redeploy + full
re-audit + bankroll migration, strictly post-event.

Reality check on effort: Casino must lose ~19 KB (44%) of runtime. That is a
large, careful refactor with a full re-test + re-audit, not a quick pass.

## 🟡 Bankroll / money

- Mainnet bankroll must be funded in **SOMI**, not STT. Size it to the max-bet
  policy (`maxBetBps` 1% of freeBankroll, `maxExposureBps`). Current testnet
  bankroll 67 STT → max bet ~0.67; mainnet sizing is a business decision.
- `PROFIT_WALLET` / owner-withdraw timelock (`OWNER_WITHDRAW_DELAY`) — reset to
  real values for mainnet (testnet runs delay 0 for convenience).
- Poker: room bankroll + tournament escrow are player-funded; the coordinator
  main wallet needs SOMI gas + the self-refuel/profit-sweep thresholds re-tuned
  for real token value.

## 🟢 Already mainnet-ready / parameterized

- **Two-network config exists.** `frontend/lib/shinyluck-sdk.js` +
  `frontend/poker/poker-config.js` both carry `somniaMainnet` (chainId 5031,
  api.infra.mainnet endpoints). Deploy scripts take `--network`.
- **RPC proxy** (`scripts/rpc-proxy.js`) upstreams are env-driven
  (`RPC_UPSTREAMS`) — point at mainnet gateways + Ankr mainnet and it works
  unchanged. Add mainnet WS to the Caddy `/rpc/ws` route.
- **Game math** verified honest (`scripts/verify-game-math.js`): Dice 99%,
  Crash 99%, Plinko 99%, Mines 98.8%, slots/cluster per STATS.md. RTP is not a
  mainnet blocker.
- Provably-fair commit-reveal + the Mines hidden-layout Merkle scheme are
  chain-agnostic.

## Deploy checklist (when the size blocker is cleared, post-event)

1. Shrink Casino/HouseManager/PokerRoom < 24 KB (see options); full test suite
   green; re-run `/code-review ultra` on the diff.
2. Fresh mainnet deploy of ALL contracts (new addresses); NEW deployer key
   (never reuse a testnet key that has signed on a public testnet).
3. Fund bankroll in SOMI; set real timelock + profit wallet.
4. Point frontend config + reveal-bot + poker dealer manifests at mainnet
   addresses; rpc-proxy `RPC_UPSTREAMS` → mainnet.
5. Live smoke: one dice bet, one mines round, one poker hand, one crash round
   end-to-end on mainnet before opening the doors.
