# ShinyLuck

**On-chain casino + on-chain No-Limit Hold'em poker, one site, one wallet, on Somnia.**

**Live:** https://shinyluck.win · **Network:** Somnia **testnet** (chainId `50312`, token STT)

Every casino bet is a `keccak256` anyone can recompute. Every poker hand is dealt by
mental poker — the deck is shuffled and encrypted by the players themselves, and no
server, including ours, can see a hole card before showdown.

> **This is a testnet deployment.** STT has no monetary value. Nothing here has been
> audited. See [Honest disclaimers](#honest-disclaimers) before reading anything as a
> production claim.

Every number below was read off the live chain on **2026-08-04**, not carried forward
from a previous version of this document.

---

## What is actually running

| | |
| --- | --- |
| **Casino** | 7 games, all live: Dice, Crash, VAULT.7 (slots), Mines, Plinko, Roulette, SUGAR.LAB (cluster pays) |
| **Poker** | 6-max and heads-up cash tables + multi-table tournaments, NLHE, fully on-chain |
| **Wallet** | Privy embedded wallet (email login, no popups). MetaMask only on `/admin` |
| **Bankroll** | 25.9 STT free in the vault → max bet 1 % ≈ 0.26 STT, max payout 20 % ≈ 5.2 STT |
| **Poker escrow** | 10.1 STT held for players across cashier balances and table stacks |
| **Scale so far** | 61 poker tables created, 25 tournaments run |
| **Languages** | English and Russian, switchable site-wide |

Somnia, measured rather than assumed: block time **0.100 s**, baseFee fixed at
**6 gwei**, a transaction lands **5 blocks (~0.55 s)** after broadcast.

### Getting in

There is **no faucet** for this. Somnia testnet STT is handed out by the Somnia team,
not by a public tap, and we do not run one — if the UI ever tells you otherwise, that
is a bug. Log in with an email through Privy, send STT to the address it gives you,
and play.

---

## The site

One origin serves both products. `frontend/index.html` is an SPA shell that owns the
chrome — sidebar, header, footer, settings, profile drawer — and embeds each game and
the poker room as a page inside it. There is no framework and no build step for the
UI; the poker screens are JSX precompiled to plain JS by `scripts/build-poker-jsx.js`.

- **Profiles are on chain.** Nicknames live in `PlayerProfile`, uploaded avatars in
  `AvatarStore`. They show up on the tables, in the win feeds and on the leaderboards.
- **Live feeds.** Latest wins, biggest wins and top players are assembled from chain
  events across the vault, both slot modules, crash, roulette and mines — plus the
  retired module addresses, so swapping a game module does not erase its history.
- **One wallet, one signer.** `lib/privy-signer.js` is a single `AbstractSigner`
  subclass through which every transaction goes, casino and poker alike, including a
  gas pre-flight that fails with a readable message instead of a silent no-op.
- **Pages worth knowing:** `/docs` (how the whole thing works), `/fair` (recompute any
  historical bet yourself), `/zk-lab` (run and verify a shuffle proof in the browser),
  `/poker/provably-fair`, `/poker/responsible` (responsible-gaming information),
  `/admin` (owner only). `/infofi` and `/predictions` are separate side-projects on the
  same origin and touch neither the casino nor the poker contracts.

---

## Casino: a vault that never moves, games that can be replaced

The casino used to be one monolithic `Casino.sol`. It hit 43 KB — 176 % of the 24 KB
contract limit — and every fix meant redeploying the bankroll with it. **v15** splits it:

```
CasinoVault  (permanent address — the whole bankroll, the RNG, risk limits,
 |            the game registry, and the pull-payment ledger)
 ├── DiceModule       single-shot
 ├── CrashModule      round-based
 ├── Vault7Module     slot        ─┐
 ├── MinesModule      multi-step   ├─ SlotLoyalty (free spins shared by both slots)
 ├── PlinkoModule     single-shot  │
 ├── RouletteModule   round-based  │
 └── ClusterModule    slot + charge meter ─┘
```

- Adding a game is `vault.registerGame(id, module, budget)` — **the core is not
  redeployed and the bankroll is not migrated.**
- **Blast radius is a budget.** Each game has its own (5 STT each today); the vault
  clamps any payout beyond it. A broken or malicious module cannot take more than its
  own budget. Modules never hold money, and there is no `delegatecall` anywhere.
- Only the owner can register a game. An unregistered contract calling `credit`
  reverts with `NotModule`.
- Any game can be stopped instantly: `setGameActive(id, false)` for one,
  `pauseAll()` for all seven. The gate sits on every entry point, and it asks the
  vault by module address — so a de-registered module stops taking bets too. Settling,
  cashing out and refunding are deliberately **not** gated: a pause must stop new bets
  without freezing money already at risk.
- This was proven in production, not just in tests: five modules have already been
  swapped on the live chain with the vault and the bankroll untouched.

### Provably fair

```
randomness = keccak256(serverSeed ‖ clientSeed ‖ blockhash(commitBlock+1) ‖ nonce)
```

Not one part is decorative:

- **serverSeed** is committed before the bet and revealed after — it stops a validator
  from grinding a block hash toward an outcome it likes.
- **blockhash** of a block that does not exist yet stops *us* from settling
  selectively. At the moment a bet is placed the result is unknown to everyone,
  the house included.
- **clientSeed** is yours, so you can prove your own input went in.

Winnings are pull-payment (`claim()`), with the UI auto-claiming on an idle debounce so
a fast player never queues a claim in front of their next spin. `/fair` recomputes any
historical bet from chain state — not from a log window — and compares it against the
on-chain result.

### House edge, read from the modules just now

| Game | Edge | Source |
| --- | --- | --- |
| Dice | 1.00 % | `houseEdgeBps=100`, flat across the whole 0.01 %–99.99 % range |
| Crash | 1.00 % | `houseEdgeBps=100` |
| Mines | 1.20 % | `houseEdgeBps=120` |
| Plinko | ~1.0 % | computed from the three payout tables (98.999 / 98.988 / 98.976 % RTP) |
| Roulette | 5.26 % | `houseEdgeBps=526` — double-zero wheel |
| VAULT.7 | see below | slot, no flat edge field |
| SUGAR.LAB | see below | slot, no flat edge field |

**The slots are the one place where the site and reality disagree, and we would rather
say so here than let you find out.** The site publishes 96.42 % (VAULT.7) and 96.38 %
(SUGAR.LAB). Eight independent simulation runs totalling ~32M spins per game, at the
pay-boost values currently on chain (`589` and `340`), measured:

| Game | Site says | Measured | Spread |
| --- | --- | --- | --- |
| VAULT.7 | 96.42 % | **95.7 %** | 95.49–95.86 |
| SUGAR.LAB | 96.38 % | **96.7 %** | 96.43–96.80 |

So VAULT.7 pays about 0.7 points less than advertised. The cause is known: the
`reportedRtpBps()` formula on the module is linear in the pay boost, while the charge
meter contributes ~13.8 % of return and does not scale with it. The fix is one owner
transaction per slot module plus a re-measure; it has not been done yet. Do not treat
the published slot RTP as authoritative.

### The charge meter (SUGAR.LAB)

The one slot mechanic that is not obvious from the screen, so here it is in full. Every
spin adds to a meter: a base of 220–600 scaled by your stake, plus 120 if the spin lost,
plus 0–149 of noise. The threshold is **hidden and random per cycle, between 180.00 and
300.00**. Crossing it rolls a reward of **3× / 8× / 18× / 3× / 12× / 45× / 5× / 120×**
your stake (weighted — 120× is a 1-in-98 roll), capped at 1 % of the free bankroll so a
jackpot on a dust stake cannot run away. The reward lands in a **pending** balance you
claim separately, the meter resets, and a fresh hidden threshold is drawn.

Both slots also share a free-spins ledger (`SlotLoyalty`), so progress on one is not
lost by playing the other.

---

## Poker: zkShuffle v2 (mental poker)

The dealer does not know the cards. There is no seed a server could leak.

1. **Key setup** — each player generates a per-hand BN254 keypair and proves knowledge
   of it (Schnorr). The table key is the sum of the public keys.
2. **Shuffle** — the deck is ElGamal-encrypted and passed player to player. Each
   shuffles and re-masks it and publishes a **Wikström proof** that the output is a
   permutation and re-encryption of the input. The chain verifies the chain of proofs
   before any card is served, and the deal commits to the keccak of the whole proof
   transcript.
3. **Reveal** — a card becomes readable only when *every* player publishes a decryption
   share with a Chaum–Pedersen proof. The contract checks each share and that the shares
   actually decrypt that ciphertext to that card, so the coordinator **cannot lie about
   a card and cannot learn a hole card early**. A per-deal bitmask rejects any card
   value appearing twice — a duplicated-card shuffle cancels the hand instead of
   settling it wrong.
4. **Showdown** — the reveal that completes the showdown also settles the pot in the
   same transaction. Readiness is derived by the contract from the room's own seat
   state, never asserted by the bot. Folded hands are never revealed, ever.

A player who disappears mid-hand can be *accused* on chain, and can answer the
accusation themselves; a verified rescue share is stored and consumed, so stalling just
forces the shares out one accusation at a time. Only shares the protocol legitimately
needs right now can be demanded — you cannot be accused into exposing your own live
cards, or the board's future ones.

Measured on the live network: showdown tail **2 s**, board cards **1–2 s** per street
(and about a second earlier on screen, because the client decrypts locally once it has
the shares), **1–2 s** between hands. The next hand's shuffle is prepared in the
background while the current one is still being played.

**Money:** rake 10 % capped per hand, **zero on tournament tables** and **zero on
pre-flop folds** ("no flop, no drop"). Tournaments take an entry fee plus a 10 % sponsor
fee; a host may take up to 10 %, and only when there is a buy-in.

### Tournaments

Registration with optional approval, scheduled or full-field starts, on-chain seating,
blind levels, table balancing, merges onto a final table and payouts — all in
`PokerTournament.sol`. Your browser follows you when you are moved between tables.

Three presets, all cut from the same 30-level blind ladder (~1.5× per level, doubling
every two to three, antes from level five). A fast structure differs in level length and
entry depth, not in the ladder:

| Preset | Level | Enters at | Depth | To 10 BB |
| --- | --- | --- | --- | --- |
| **Regular** (default) | 8 min | 25/50 | 200 BB | ~112 min |
| Turbo | 5 min | 50/100 | 100 BB | ~55 min |
| Hyper | 3 min | 100/200 | 50 BB | ~24 min |

Starting stack is 10 000 chips in all three, and a host can edit the level table by
hand. Think in **hands, not minutes**: these tables deal roughly one hand a minute, so a
three-minute level is three hands — less than one orbit six-handed.

---

## Deployed contracts (Somnia testnet, chainId 50312)

**Casino v15**

| Contract | Address |
| --- | --- |
| **CasinoVault** | `0x6497D80cCd713F0BD4d8B22CE96Eae0F92EC7Cca` |
| SlotLoyalty | `0xDc75211541dF47D5023ae74A873194ad5296c22a` |
| Dice | `0x531b7BB7076Bb7181f374A5D4E0CEc7a57CBa66B` |
| Crash | `0xb96Fb6e3C6fb82acB448e53a3cb59e09f2B0ABD3` |
| Vault7 | `0xEB0221E338ba0b054571a00282f875f729E69A6A` |
| Mines | `0x3B958cFfe3b282908BdD85E2f8cEAf94CBcc87E8` |
| Plinko | `0x47026C7FF5393BB962f26179FA89E5498F2b29A6` |
| Roulette | `0xEA30b4c708A780A600D8dE792ae0D1F0D1ab37DF` |
| Cluster (SUGAR.LAB) | `0x37d984410718BA70066aE9A897C6DfeC57049dC4` |

**Poker**

| Contract | Address |
| --- | --- |
| **PokerRoom** (holds player funds) | `0xFeF7d1bb6c0DffaB4e13D9b49BBE1F1459266A24` |
| PokerTournament | `0xf2d3785645985618b866594cE6e924Ae35608948` |
| ZkTableDealer (live card layer) | `0xD3a0c2A052D72A26342AA14cf0Fd2cB70B7ceA63` |
| ZkDealerV2 (shuffle verifier, `/zk-lab`) | `0x292Ef0e15fC62613B00c55b0eEAC38279Efdb67D` |
| PlayerProfile (nicknames) | `0x7364E1ED8a07b4659c059fa66D346c42907C3F14` |
| AvatarStore (on-chain avatars) | `0x20c39988b480485aD2a9715c32Ff1866Ea890Ec4` |

The card layer is deliberately replaceable — `room.setDealer(...)` — precisely so the
contract holding player money never has to move. `scripts/_swap-zk-dealer.js` does the
swap and refuses to run while any hand is in flight.

**None of these are verified on Shannon Explorer.** The source in this repository is the
canonical reference; every address above is interactable on chain.

---

## What came before: the agent era (built, shipped, now switched off)

ShinyLuck started as a submission for the **Somnia Agentathon**, and the pitch was that
AI agents *ran the house* rather than narrating it. That was real and it worked:

- `HouseManager.sol` woke hourly via Somnia's Reactivity precompile, fetched competitor
  RTPs through the JSON API Agent, asked an LLM Inference Agent (Qwen3-30B) for
  `LOWER / HOLD / RAISE / BIG_BONUS`, and applied the verdict through
  `casino.adjustSlotRTP()` — on chain, with 3 validator workers agreeing on
  byte-identical output.
- `AgentQuorumVerifier.sol` — an independent 3-of-4 LLM committee re-derived the
  `keccak256` of every settled bet, as defence in depth on the randomness layer.
- `PlayerAgentRegistry.sol` + `AgentVault.sol` — players could register an agent with a
  permitted-games mask and daily limits, and it would bet from its own vault, paying for
  its own LLM tick.

**It is all switched off today** and removed from the UI. The contracts are still on
chain (`Casino` v13 `0x01D31a1a…` holding 7.46 STT, `HouseManager` `0x74f189f4…`,
`AgentQuorumVerifier` `0xaB37e48a…`, `PlayerAgentRegistry` `0x54f68611…`), and the
Solidity is still in `contracts/`. Nothing in the live money path touches them.

Why it was turned off: the hourly agent loop cost ~0.72 STT/hour to run and moved a
number that a spreadsheet moves better, while the parts players actually felt — latency,
fairness, whether a hand finishes — had nothing to do with it. The honest version of the
project turned out to be a fast casino and a real poker room, not an LLM in the payout
path. Players' money was always settled by commit-reveal, never by an agent.

---

## Layout

```
contracts/
  v15/CasinoVault.sol        permanent core: bankroll, RNG, limits, registry, claims
  v15/games/*.sol            one contract per game + SlotBase, GameGate, SlotLoyalty
  poker/PokerRoom.sol        NLHE engine, side pots, on-chain hand evaluation, cashier
  poker/PokerTournament.sol  registration, seating, levels, table merges, payouts
  poker/ZkTableDealer.sol    live mental-poker card layer (IPokerDealer)
  poker/ZkDealerV2.sol       BN254 shuffle-proof verifier behind /zk-lab
  Casino.sol, HouseManager.sol, AgentQuorumVerifier.sol, PlayerAgentRegistry.sol
                             the agent era — on chain, no longer in the money path

frontend/                    static site: no framework, no build step for the UI
  index.html                 SPA shell; games and poker load as embedded pages
  lib/shinyluck-sdk-v15.js   ethers v6 wrapper over the vault + modules
  lib/privy-signer.js        one AbstractSigner for every transaction, casino and poker
  lib/wins.js                win feeds, assembled from six event sources
  lib/i18n.js                site-wide EN/RU
  poker/                     table, lobby and tournament UI (JSX + precompiled output)

scripts/
  deploy-v15.js              casino deploy → writes the manifest and frontend config
  deploy-poker-v2.js         poker deploy
  swap-v15-modules.js        replace a game module on the live chain
  _swap-zk-dealer.js         replace the poker card layer without touching the money
  poker-dealer-bot.js        the coordinator: HTTP relay, snapshots, watchdogs
  build-poker-jsx.js         precompile poker JSX — run after editing any .jsx
  validate-rtp.js            slot RTP simulation (use ≥3M spins; 500k is not enough)

test/                        312 contract tests + browser end-to-end harnesses
deploy/                      Caddyfile, pm2 config, VPS bootstrap
```

## Running it

```bash
npm install
npx hardhat compile

# contract tests — pass the list explicitly: a bare `npx hardhat test` is
# silenced by an .mjs smoke test that exits the process
npx hardhat test $(ls test/*.test.js)

# poker in a REAL browser, against a locally booted stack
# (hardhat node + contracts + dealer bot + web server, injected wallets)
npm i -D playwright --legacy-peer-deps && npx playwright install chromium
npm run test:pages        # the three poker pages boot
npm run test:browser      # cash table, 2 tabs, ~2 min
npm run test:tournament   # a full tournament, 3 tabs, ~5 min
npm run test:mtt          # multi-table: 5 players, 2 tables, moves, merge, ~7 min
# HEADED=1 to watch it play
```

Deployment lives in `deploy/` (Caddy + pm2). The site is static; the only always-on
services are the poker dealer bot and the casino reveal bot.

---

## Honest disclaimers

- **Testnet only.** STT is not money. There is no mainnet deployment.
- **Not audited, and not verified on the explorer.** Read the source here.
- **Published slot RTP is wrong** — see the table above. VAULT.7 pays ~95.7 % while the
  site says 96.42 %. Known, measured, not yet fixed.
- **The owner key is a trusted party.** `OWNER_WITHDRAW_DELAY` is 0 on testnet and there
  is no proxy or timelock in front of the vault. Mainnet requires a timelock and a
  multisig before anything else.
- **`refundFromModule` is not budget-clamped**, which dents the "blast radius = budget"
  invariant for a hypothetical broken module. No live bug — every module refunds exactly
  what it escrowed — but it is a known gap, fixable only by redeploying the vault, which
  is a mainnet job.
- **`PayoutClamped` is not surfaced.** If a game exhausts its budget the payout is
  trimmed silently. Far from binding at current volumes, but it needs to be visible
  before real money.
- **Two off-chain services exist and neither decides an outcome.** The reveal bot
  publishes the committed server seed so a bet can settle; the poker dealer bot relays
  encrypted shares, drives the phase machine and pays gas. Neither can change a card or
  a result — the contracts verify every share and every payout. They are, however, a
  liveness dependency: if they are down, settlement waits.
- **Mobile is not verified.** The layout exists and has a dedicated stylesheet, but the
  browser harness runs a desktop viewport and no one has driven a real hand from a phone.
- **Old bets on retired casino contracts are still claimable** and the profile drawer
  sweeps them; balances are not migrated on redeploy.

## License

MIT
