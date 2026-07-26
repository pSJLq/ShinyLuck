# ShinyLuck Casino v15 — modular, mainnet-grade architecture

> Goal: a casino at the quality bar of a serious platform (Stake-tier), where new
> games are added over time WITHOUT redeploying the core or migrating the
> bankroll, every piece fits well under the EVM 24 KB code limit, and the money
> is protected by hard, auditable invariants. Poker is out of scope (separate
> product). Agents / HouseManager are dropped (this is a pure casino).

Status: DESIGN. Nothing deployed. Mainnet deploy is strictly post-event
(poker event Wed 2026-07-29). v14 monolith stays live on testnet until v15 is
built, tested, and audited.

---

## 1. Why we're changing anything

Casino v14 is a single 1981-line contract = **43 300 bytes of runtime code (176%
of the 24 576-byte EIP-170 limit)**. It bundles the vault, the RNG, the risk
limits AND the full logic of all 7 games inline. Consequences:

- Over the standard EVM contract-size limit (Somnia testnet doesn't enforce it,
  mainnet must be assumed to — standard Spurious-Dragon rule).
- Adding a game means redeploying the whole thing and **migrating the entire
  bankroll** to the new address — risky, expensive, downtime.
- One game's bug lives in the same contract as everyone's money.
- Deploy gas scales with size; a 43 KB contract is very expensive to deploy.

v15 fixes all four by separating **the money (permanent) from the games
(pluggable)**.

## 2. Components

```
                 players ─┐        ┌─ reveal/settle bot
                          ▼        ▼
   ┌───────────────────────────────────────────────────────────┐
   │                        CasinoVault  (Core)                 │
   │  PERMANENT ADDRESS. Holds 100% of the bankroll.            │
   │  • bankroll accounting + freeBankroll()                    │
   │  • bet registry (Bet records, ids, per-player index)       │
   │  • pull-payment claims (winnings withdrawn by player)      │
   │  • RNG: commit-reveal seed pool + randomness derivation    │
   │  • risk limits: maxBetBps, maxExposureBps, per-game caps,  │
   │    global + per-game pause                                 │
   │  • game registry: register / activate / deactivate modules │
   │  • money primitives callable ONLY by registered modules:   │
   │      escrowStake(), credit(), refund()                     │
   │  Logic upgradeable behind a proxy + owner TIMELOCK.        │
   └───────┬───────────────┬───────────────┬───────────────────┘
           │ IGameModule    │               │
     ┌─────▼─────┐   ┌──────▼──────┐  ┌──────▼──────┐      ┌───────────┐
     │DiceModule │   │ MinesModule │  │RouletteMod. │  ……  │ <NewGame> │
     │ ~2-3 KB   │   │  ~medium    │  │  payout tbl │      │  module   │
     └───────────┘   └─────────────┘  └─────────────┘      └───────────┘
   Each game is its own contract with its own storage. Add anytime by
   deploying it and calling vault.registerGame(module). Never touches money
   or other games.
```

### CasinoVault (the Core)
Small, stable, rarely-changed. It is the ONLY contract that ever holds funds.
It exposes:
- Player/public reads: `freeBankroll()`, `getBet(id)`, `claim()`, seed status.
- Owner/admin: risk limits, pause, `registerGame`, `setGameActive`, RTP report.
- **Module-only primitives** (the trust boundary): `openBet()`, `escrowStake()`,
  `credit(player, amount)`, `refund(betId)`, `drawRandomness(betId, seed)`.
  These revert unless `msg.sender` is a registered, active module.

### IGameModule (the plug interface)
Every game implements a tiny interface so the Vault can talk to it uniformly for
the shared steps, while the module is free to add its OWN game-specific external
functions (mines picks, round settles, etc.):

```solidity
interface IGameModule {
    function gameId() external view returns (uint16);
    function houseEdgeBps() external view returns (uint16);
    // Vault calls this at settlement with the revealed randomness; module
    // returns the gross payout (0 = player lost). Module never moves money.
    function resolve(uint256 betId, bytes32 randomness, bytes calldata params)
        external returns (uint256 payout);
}
```

### Game modules
Each is a standalone contract holding only its own game state, calling Vault
primitives for money + randomness. Examples of what moves out of the monolith:
- **DiceModule** — `_dicePayout`, target/over validation. Tiny.
- **SlotsModule (VAULT.7)** — Vault7 math, charge meter, free spins, bonus buy.
- **ClusterModule (SUGAR.LAB)** — cluster math.
- **MinesModule** — hidden-layout Merkle root/proof, pick/resolve/cashout/
  finalize (multi-step; keeps the anti-peek pick→resolve flow from v14).
- **PlinkoModule** — payout tables.
- **CrashModule** — round lifecycle + `_crashPoint`.
- **RouletteModule** — round lifecycle + payout/wins tables.

## 3. Money-safety invariants (the part the audit lives on)

1. **All funds live in the Vault. Modules never custody value.** A module only
   ever asks the Vault to `credit`/`refund`; the Vault checks caller is a
   registered active module AND that the amount respects risk limits.
2. **Per-bet exposure is capped in the Vault, not the module.** `maxBetBps` (max
   stake as a fraction of freeBankroll) and `maxExposureBps` (max single payout)
   are enforced by the Vault on every `credit`, so even a buggy/hostile module
   cannot pay out more than the Vault authorizes.
3. **A game is deactivated by flipping a registry flag** (`setGameActive(id,
   false)`), never by moving money. Deactivation stops new bets; in-flight bets
   still settle/refund.
4. **Pull-payment for winnings.** Winners `claim()` from the Vault; settlement
   only credits an internal balance. No push transfers during settle.
5. **Registry is owner-gated + timelocked.** Adding/removing a module can never
   be instant-rugged; it goes through the same timelock as core upgrades.

## 3b. Threat model: adding games safely (who can add, blast radius)

The single most dangerous idea in a plugin-game casino is "a contract that can
move house money." v15 answers three questions explicitly:

**Who can add a game?** ONLY the owner (a multisig for launch), and only through
the timelock. `registerGame` is access-controlled. A stranger CANNOT attach a
contract to the bankroll. Independently, an UNregistered contract that calls any
Vault money primitive (`credit`/`escrowStake`/`refund`) reverts — the Vault
checks `msg.sender` is a registered, active module. Two walls: registration is
closed, and even calling the money functions is closed.

**What if WE register a buggy or hostile game by mistake?** Blast radius is
bounded, not open:
- **Per-game budget (allowance).** The Vault holds a dedicated bankroll
  allowance per game and tracks that game's net exposure. `credit` reverts once
  a game's net payout would exceed its allowance. A new/experimental game starts
  with a SMALL budget; you raise it through the timelock as trust grows. The most
  any single game can cost — even a 100%-to-player "guaranteed win" — is its
  allowance, never the whole vault.
- **Per-bet payout cap** (`maxExposureBps`) on top, so no single bet drains even
  the game's budget in one shot.
- **Modules never custody funds** — they only request bounded credits tied to a
  bet they opened with an escrowed stake. Whole classes of bugs removed.
- **Modules are plain contracts, not facets** — no delegatecall, so a module can
  never corrupt Vault storage (the reason Diamond was rejected).
- **Timelock + instant kill.** Registration/upgrades are timelocked (a window to
  spot a bad module before it goes live even if a key leaks); a live game is
  killed instantly with `setGameActive(id,false)` — a flag flip, no migration.

**Residual care item (not a blocker):** the per-bet and per-game caps must be
sized to let legitimate high-multiplier wins pay (crash 1000x, slot jackpots)
while protecting the bankroll — standard max-payout-vs-bankroll casino math,
computed per game at registration.

## 3c. Per-game cashiers (settlement isolation)

Each game settles from its **own cashier wallet**, derived deterministically
from `CASHIER_MASTER_KEY` at deploy time and written into the manifest.

**Why this matters more than throughput.** A nonce queue belongs to a WALLET,
not a contract. With one signer settling all seven games, a single stuck or
reverting transaction stalls every game behind it in the queue. One cashier per
game = one nonce lane per game: if Mines wedges, Dice, slots and roulette keep
settling normally.

**Throughput headroom (measured 2026-07-24, Somnia testnet).** A single EOA
sustained **~81 tx/s** (200/200 mined, 0 failures, up to 64 contiguous-nonce txs
in one block); the block gas limit (15 G) fits ~13 000 settles. So:

| load | settles/s needed | verdict |
|---|---|---|
| 100 players in ONE per-bet game (1 bet/3s) | ~33 | one lane is enough |
| 100 players in EACH of 5 per-bet games | ~165 | needs several lanes |

Crash and Roulette are near-free at any player count — one settle per round
serves everyone, so their lanes stay idle regardless of how many are playing.

**Mines note:** `commitRoot`/`resolveCell` are owner-gated on the module, so the
deployer transfers MinesModule ownership to the mines cashier — the wallet that
runs that game's loop is the one authorized to drive it.

**Isolation summary — every axis is per-game:** own contract, own state, own
budget (blast radius), own on/off flag, own settlement wallet. One game failing
never touches another game or the bankroll beyond its budget.

## 4. Bet lifecycles (the interface supports all three)

- **Single-shot (Dice/Plinko/Slots/Cluster):** player → `module.play(params)` →
  module calls `vault.openBet(player, stake, gameId, params)` (escrows stake,
  assigns a seed) → bot `vault.revealAndSettle(betId, seed)` → Vault derives
  randomness, calls `module.resolve(...)`, credits payout.
- **Multi-step (Mines):** `module.place()` → bot `module.commitRoot()` →
  player `module.pick(cell)` → bot `module.resolve(cell, proof)` →
  `module.cashout()` / bust → `module.finalize(seed)`. Money still flows only
  through Vault primitives; the anti-peek on-chain-pick guarantee is preserved.
- **Round-based (Crash/Roulette):** module keeps one open round, N players bet
  into it, ONE settle per round serves everyone (this is already how these
  scale to many players — see casino-scaling-measured memory).

## 5. RNG stays shared in the Vault

Commit-reveal (`keccak256(serverSeed ‖ clientSeed ‖ blockhash ‖ nonce)`) and the
seed pool live in the Vault. One pool, one reveal bot, unchanged operational
model. Modules receive the derived `randomness` and never see the seed early.
This keeps every module tiny (pure payout math) and means **the settlement bot
does not change** when we add a game.

## 6. Upgradeability & trust (why "timelock")

The Vault's LOGIC sits behind a proxy so we can fix bugs / evolve settlement over
years **without moving the bankroll** (funds live at the proxy address, which is
permanent). To keep this from being a trust hole (owner could otherwise swap in
malicious logic instantly), every upgrade AND every game (de)registration passes
through an **owner timelock** (e.g. 24-48h delay), ideally an owner that is a
multisig for launch. This is the standard serious-platform posture: upgradeable
for safety, timelocked so players can see changes coming. Modules themselves are
NOT proxies — they're plain contracts, swapped by registry, so no delegatecall /
shared-storage footguns (this is why we are NOT using a Diamond).

## 7. Adding a new game later (the whole point)

1. Write `FooModule` implementing `IGameModule` (+ its own external funcs).
2. `node scripts/verify-game-math.js` to prove RTP.
3. Test against the Vault (unit + integration).
4. Deploy the module (small, cheap).
5. `vault.registerGame(fooModule)` (through timelock).
6. Add the game to the frontend lobby + a page. Done.

No Vault redeploy. No bankroll migration. No downtime for existing games.

## 8. Size budget

- Vault (Core): target < 20 KB. Only vault + registry + RNG + risk + claims.
- Each module: a single game is a few KB; all land well under 24 KB with room
  to spare. Roulette's payout tables are the chunkiest and still fit alone.

## 9. Build phases (mainnet deploy of any of this is strictly post-event)

- **P0 (now, local):** this spec + `IGameModule` interface + `CasinoVault`
  skeleton (state, primitives, registry, risk, RNG) with the money-safety
  boundary. No deploy.
- **P1:** port games to modules one at a time (Dice first as the reference,
  then Slots/Cluster, Mines, Plinko, Crash, Roulette), each with tests pinned
  to v14 math (byte-identical RTP via verify-game-math).
- **P2:** deploy scripts (Vault behind proxy + timelock, register modules),
  bot pointed at Vault (settle path is the same call), frontend registry-aware
  routing.
- **P3:** full test suite green + `/code-review ultra` + external audit of the
  Vault trust boundary. THEN mainnet deploy (fresh addresses, SOMI bankroll,
  real timelock + profit wallet).

## 10. Mainnet checklist delta vs v14

- HouseManager: NOT deployed (agent layer, dropped). One 40 KB blocker gone.
- PokerRoom: out of scope (separate product).
- Only real size blocker was Casino → solved by this split.
- Everything else from docs/MAINNET-READINESS.md §🟡/🟢 still applies (SOMI
  bankroll sizing, real timelock, mainnet RPC upstreams, honest RTP).
