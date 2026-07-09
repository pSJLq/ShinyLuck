# zkShuffle v2 → production design (2026-07-09)

v2 (Barnett–Smart mental poker on BN254, verified on-chain via EVM precompiles)
becomes the MAIN card layer for all cash tables and tournaments. v1
(commit-reveal) is archived: tag `v1-final-20260709`, live contracts stay
on-chain, addresses kept in the manifest under `v1`.

The core claim we ship: **no one but the player — not the coordinator bot, not
the house — can see a hole card before showdown, and every card that appears on
the felt is proven correct on-chain.** This is true by construction: cards are
ElGamal-encrypted under the aggregate of the PLAYERS' per-hand keys; the bot
holds no key material; the contract verifies every decryption share
(Chaum–Pedersen) and that shares decrypt to exactly the claimed card.

## Per-hand protocol (k players, coordinator = dealer bot)

Phases between hands (happy path ~3–6s, overlaps the winner-banner pause):

1. **KEYS** — each seated client generates a fresh per-hand keypair locally
   (secret never leaves the tab; cached in sessionStorage keyed by
   room/table/deal so F5 mid-hand recovers), sends pubkey + Schnorr PoK to the
   bot (sig-gated like /holes). Deadline 8s → unresponsive seat gets
   `sitOutIdle` (strike + sat out), phase restarts without them (needs ≥2).
2. **SHUFFLE** — sequential relay: bot sends the current 52-ct deck to player
   i, client shuffles+remasks (~200ms), returns. First shuffler sees plaintext
   deck but each later shuffle destroys their knowledge; ≥1 honest shuffler ⇒
   nobody knows the final order. Deadline 8s per player.
3. **HOLE-SHARES pre-collect** — each client sends decryption shares for
   *other players' hole cts only* (never board, never its own). Bot verifies
   proofs, relays: each player ends with k−1 shares per own card → decrypts
   locally, sees own cards instantly. Bot can't decrypt (owner's share
   missing). Board shares are deliberately NOT pre-collected — otherwise the
   bot would know the whole board at deal time.
4. **prepareDeal** on-chain (verifies k Schnorr PoKs, aggregates the table
   key, commits the 2k+5 in-play cts) → `room.startHand` binds it. Betting
   proceeds on the UNCHANGED engine (session keys etc.).
5. **BOARD per street** — when a betting round closes, the bot requests that
   street's board shares from ALL k clients (folded players' clients keep
   answering — automatic, background). Verify → `revealBoardCard` with all k
   shares (contract checks every CP proof + B−Σd == (card+1)·G).
6. **ALL-IN runout** — the moment betting is capped all-in, every client
   auto-releases its remaining board shares AND its own hole shares (cards on
   their backs, standard poker) → the runout completes even if tabs close.
7. **SHOWDOWN** — live players' clients release their own hole shares →
   `revealHoleCards` per seat → `markShowdownReady` → `resolveShowdown`
   (permissionless). FOLD-WIN needs no crypto at all (engine settles without
   the dealer).

## Liveness (the honest trade-offs, pre-threshold-decryption)

- Disconnect BEFORE money is in (keys/shuffle): strike + sit out + redeal
  without them. Free.
- Disconnect MID-HAND (missing board/hole shares): after the share deadline
  the bot calls **`cancelHandPenalized(tableId, offenderSeat)`** — everyone's
  committed chips are refunded EXCEPT the offender's, which are distributed
  pro-rata to the other committed seats. Closing your tab in a lost pot costs
  you exactly what folding would — the ragequit exploit is dead. Offender is
  sat out + struck (3 strikes on cash → kickIdle).
- Trust surface: the operator could falsely blame a seat, but the forfeited
  chips go to the OTHER PLAYERS, never to the operator — abuse requires
  operator+player collusion and is visible on-chain. Strictly better than v1
  (where the bot knew every card). Documented on the provably-fair page.
- Tournaments: an AFK/keyless seat is sat out; sitting-out seats on controlled
  tables auto-post a dead big blind each hand (**blind-off**, new in room v3,
  swept into the pot like antes) → stack drains → `reportBust` fires →
  tournaments always terminate. Standard MTT behavior.

## Contract changes

PokerRoom v3 (fresh deploy, engine byte-identical):
- `operators` mapping (+`setOperator(addr,bool)`) beside `dealerOperator` —
  multiple worker keys write in parallel (throughput; the single-key serial
  queue capped at ~10 hot tables).
- `sitOutIdle(tableId, seat)` — onlyDealerOrOperator, not mid-hand for a
  committed seat; sets sittingOut + increments timeoutStreak. `setSitOut(false)`
  resets the streak (player came back).
- `cancelHandPenalized(tableId, offenderSeat)` — as above.
- Blind-off: in `startHand`, on CONTROLLED tables, occupied+sittingOut seats
  with stack>0 post min(bb, stack) dead into the pot via committedTotal (so
  plain `cancelHand` still refunds them correctly).

ZkTableDealer prod:
- `coordinators` mapping (multi-key posting).
- `startHand` verifies the room's seats[] ELEMENT-WISE against the prepared
  deal (length-only today — a seat-set race would corrupt the participant
  mapping).
- **Revealed-card dupe guard**: uint64 bitmask per deal; a second reveal of
  the same card value reverts. Closes the visible half of the "malicious
  shuffler duplicates a card" hole (a dupe among in-play cards is caught at
  reveal; the hand cancels instead of settling wrong). Full shuffle arguments
  (Groth16) remain R2.
- Deck/pubkey storage: measure prepareDeal gas at k=6 in hardhat ×~10 Somnia
  factor; if prohibitive, switch to per-ct hash commitments + calldata reveal.

## Bot

- New `scripts/lib/poker-zk-dealer.js` (sibling of poker-dealer.js): per-table
  session state machine (phases above), verifies EVERY client artifact
  (PoK, share proofs) before accepting; drives prepareDeal/reveals/cancel.
- New HTTP endpoints (same server, same sig-gating): `GET /zk/task?t=&a=`
  (what should this client do now + payload), `POST /zk/key | /zk/shuffle |
  /zk/shares`. Clients poll /zk/task at ~700ms while seated.
- Worker keys: N operator wallets derived from the master key (worker-0..N),
  each a room operator + dealer coordinator, each with its own serial runTx
  queue; tables assigned worker = t mod N. Independent nonce spaces ⇒ ~N×
  write throughput (the 2026-07-06 single-key lesson).
- v1 dealing code path kept intact (manifest without `zkTableDealer` falls
  back) — rollback stays possible.

## Frontend

- New `frontend/poker/zk-agent.js`: background protocol client. No UI of its
  own; hooks SP.sdk auth (session key signs the task posts), sessionStorage
  for per-hand secrets. Computes: keygen, shuffle, shares; verifies relayed
  shares before use; decrypts own holes locally.
- SDK: `myHoleCards()` routes to local zk decryption on v2 tables (config
  carries `zkTableDealer`); board/showdown reveals flow through the SAME
  IPokerDealer views as v1 — the table UI is unchanged.
- provably-fair page rewritten for the v2 trust model (what's proven on-chain,
  what the penalized-cancel is, what R2 adds). The "only you see your cards"
  badge becomes TRUE and goes back on.

## Rollout

Deploy v3 room + ZkTableDealer + PokerTournament (bound to v3) → wire, create
the same cash-table tiers → migrate real-user balances from v1 room
(depositFor, bot stopped, script wallets evacuated first) → register worker
keys → full VPS bot sync → frontend deploy → live E2E (fold-win, showdown,
all-in runout, disconnect-penalty, SNG) → load test → switch shinia.mom.
v1 room/dealer stay live on-chain for stragglers' withdrawals.

Economics: coordinator gas ~0.08–0.2 STT/hand (Somnia meters precompiles ~10×
hardhat). Operator must be funded accordingly for launch day (ask user;
self-refuel from rake continues).
