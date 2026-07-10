# zkShuffle v2 — security audit (2026-07-10)

Adversarial review of the whole v2 mental-poker stack after the shuffle-proof
and penalized-cancel hardening. Threat model is deliberately harsh: **the
coordinator bot / the house is assumed malicious**, players may collude, and the
Somnia mempool is public. The bar set for this pass: a cheat should be
*impossible*, not merely *detectable*.

Legend — **[FIXED]** closed this pass (code + tests), **[DOC]** residual risk
accepted & documented, **[OK]** checked, already sound.

---

## 1. Shuffle integrity — can a shuffler rig the deck? **[FIXED]**

Previously only "valid on-curve points" were checked; deck honesty rested on the
classical "≥1 honest shuffler" assumption. Now **every shuffler submits a
Wikström proof of shuffle** (Haenni-Locher-Koenig-Dubuis FC'17 pseudo-code,
Alg 4.3–4.6; the CHVote/Verificatum construction) that its output deck is a
permutation + re-encryption of its input deck — verified by the bot, by **every
client independently** (`/zk/chain`), and committed on-chain (`proofHash`).

- **Substitution / injecting a chosen card**: impossible — a planted ciphertext
  is not a re-encryption of any input, the proof fails. (`ZkShuffleProof.test.js`)
- **Duplication**: impossible pre-reveal (proof fails); `DupeCard` remains as an
  on-chain last line.
- **Knowing the deck order / biasing a card's position**: the final order is the
  composition of all k secret permutations; each proof reveals nothing about its
  permutation. No coalition that excludes a given player can predict that
  player's cards — because **that player is themselves one of the shufflers**.
  The "≥1 honest shuffler" assumption is no longer load-bearing for integrity.
- **Follow-up (2026-07-10 code-review pass): the "my shuffle is in the chain"
  check must survive an F5.** The client pins the output deck of its own shuffle
  and refuses to share unless the served `/zk/chain` contains it — otherwise a
  fully-colluding table + coordinator could drop a player's shuffle and, having
  authored every remaining permutation, know that player's cards. The pin was
  in-memory only, so a mid-hand reload dropped it (and the check was skipped).
  Now the pin (output hash + aggregate key) is persisted to `sessionStorage`
  alongside the shuffle secret and reconstructed after a reload; a participant
  that cannot confirm its own shuffle **refuses to share** rather than proceed.

## 2. Coordinator key substitution — can the house read your cards? **[FIXED]**

*Was the single most serious hole.* Nothing bound a per-hand pubkey to the seat
that generated it. A malicious coordinator could place **its own** key for a
seat in the aggregate, self-produce that seat's "own" decryption share, gather
the other k−1 at hole-share time, and **decrypt that seat's hole cards before
showdown** — defeating the headline claim.

Fixed by a **seat-binding signature**: each client signs its pubkey with its
session key (`ShinyPoker:zk-key:…`); every client, before sharing, recomputes
the aggregate from the posted pubkeys, checks its own key is present, and
verifies each binding against the seat's **on-chain occupant**. A planted key
can't carry the seat's signature ⇒ honest players refuse to share ⇒ the
coordinator never gets the shares it needs. (`ZkKeyBinding.test.js`)

## 3. Share-request manipulation — early card extraction **[FIXED]**

The client trusted the coordinator's requested share indices. A malicious bot
could ask for a player's **own** hole shares, or **future board** shares, early
— and be obeyed, leaking everything.

Fixed by a **client-side secrecy gate** (`mayReleaseShare`, mirrored on-chain in
`accusationAllowed`): share release is gated on the **on-chain hand street**
(read from PokerRoom, never the bot) — own holes only at showdown/all-in runout,
each board card only once its street opened, others' holes always (they decrypt
nothing without the owner). A **folded** player additionally refuses its own-hole
shares even at showdown (no harvesting folded hands). (`ZkShareGate.test.js`)

**Follow-up (2026-07-10 code-review pass): own-hole accusation ⇒ board complete.**
The client only rescues an own-hole accusation once the **full board** is revealed
(its rescue gate). But `accusationAllowed` originally permitted an own-hole
accusation on any `street == 4` — and an **all-in runout lands on street 4 before
the board is dealt**. A malicious operator could therefore accuse an all-in
player's own hole card during the runout, the client would (correctly) refuse to
rescue a not-yet-due hole share, and `cancelHandPenalized` would **steal the
all-in stack**. Closed by additionally requiring `deal.boardCount == 5` for
own-hole accusations, so the on-chain rule matches the client's rescue policy
exactly. (`ZkTableDealer.test.js` — "own-hole accusation … only once the full
board is revealed")

## 4. Mid-hand abandonment / false forfeiture **[FIXED]**

`cancelHandPenalized` used to confiscate an accused seat's chips on a single
un-proven operator call — a compromised worker key could rob an innocent player.
Now forfeiture requires **accuse → on-chain rescue window → un-rescued expiry**;
the accused's client self-rescues from chain state; `accusationAllowed` blocks
accusations for shares not legitimately due (so accusations can't force early
disclosure either). Forfeits go to the other players, never the operator.
(`PokerRoomV3.test.js`, `ZkDealerDriver.test.js`) — see `ZK-V2-PROD.md`.

## 5. Replay / domain separation **[FIXED]**

Fiat–Shamir domains are keyed by `dealId`; a `dealId` collision would let a proof
be replayed across deals. `dealId` is now a **strictly-monotonic process-global
counter** (`ms·4096 + seq`) — no two deals can share one — backed by the on-chain
`_deal[dealId].exists` guard. Per-deal, per-index, per-participant domains
(`SPZK:{dealId}:{kind}:{idx}:{seat}`) keep every proof single-use.

## 6. Multi-seat / player collusion **[DOC]**

Two accounts at one table sharing hole cards off-app is the generic
"multi-accounting" problem of ALL online poker and is **out of scope for
cryptography** — it steals no chips beyond normal soft-collusion edge and is
addressed by the usual operational means (seat limits per identity, collusion
analytics on the public on-chain action log, which v2 makes fully auditable).
Not a protocol break: a colluding pair still cannot see a third player's cards or
rig the deck (§1–3).

## 7. Operator / worker-key blast radius **[DOC]**

The bot runs N worker keys, each a PokerRoom operator + dealer coordinator.
A compromised worker key can **grief but not steal**:

- drive/withhold dealing, `cancelHand` (full refund) → table-level DoS. Inherent
  to any operator-driven dealer; the operator can always just stop dealing.
- `sitOutIdle` ×3 → `kickIdle` a seat (stack returns to that player's **own**
  in-room balance — no funds to the attacker). Disruptive, not theft.
- It **cannot**: forfeit an innocent's chips (§4), read hole cards (§2–3), rig
  the deck (§1), reveal cards without the players' shares, or move escrow (keys
  are `act`/operator-scoped, never `withdraw`).

Mitigation is operational: fund workers minimally, monitor `HandCancelled*` /
`SitOutToggled` rates, rotate keys via `setOperator`/`setCoordinator` (owner).
Net: the multi-key design widens the *griefing* surface vs v1's single key but
**not** the theft or secrecy surface — those are now cryptographically closed.

## 8. Mempool / front-running **[DOC]**

`revealBoardCard` carries the plaintext card in calldata; a mempool watcher sees
the next board card ~1 block before it mines. Betting on a street is engine-open
the moment the prior street closes, so in the narrow window between street-close
and the reveal landing, a watcher could `act()` with foreknowledge.

Severity low: the coordinator reveals promptly (window is sub-second), everyone
sees the card the instant it mines, and betting rounds run over the
`actionTimeout`. **Recommended hardening** (not shipped — adds a dealer
`staticcall` to the hot `act()` path): gate post-flop `act()` on
`dealer.boardRevealedCount(dealId) >= boardCountForStreet(street)` so betting
can't open before the card is on-chain and public to all simultaneously.

## 9. HTTP / auth layer **[DOC]**

The `/zk/*` calls are gated by a per-deal signature (`ShinyPoker:zk:{t}:{dealId}`,
session-key-signed). It authenticates the caller but is static per deal, so an
eavesdropper on the (HTTPS) channel could replay it. Impact is bounded: every
artifact is cryptographically verified, so a replayer without the seat's secret
can forge **nothing** — not a share (needs the secret), not a key (needs the
seat-binding signature, §2). Worst case is spam. `readBody` caps payloads at
1.5 MB and every point is `assertValidity`-checked, so malformed/oversized
payloads are rejected cheaply. **Recommended**: add a nonce/expiry to the zk auth
message and per-IP rate-limiting at Caddy for the `/zk/*` and `/chat` POSTs
(DoS hygiene for 200–300 concurrent users). No secrecy/integrity dependency.

## 10. Supply chain — self-hosted `noble-bn254.js` **[DOC]**

The BN254 bundle is **self-hosted** (no third-party CDN), so there is no
cross-origin tampering vector; SRI would only matter behind a CDN. Residual risk
is server compromise, under which *all* served JS is compromised regardless —
addressed by host integrity, not SRI. If the bundle is ever moved to a CDN, pin
it with a subresource-integrity hash (or an import-map integrity entry).

## 11. On-chain settlement defenses **[OK]**

- `resolveShowdown` re-checks every card it reads is 0–51 and rejects unrevealed
  (255) even if the dealer lies via `markShowdownReady` → premature settle
  reverts (`ShowdownNotReady`).
- Reveals are `onlyCoordinator` **and** require valid all-k Chaum–Pedersen shares
  + `B−Σd == (card+1)·G` — a coordinator key alone reveals nothing.
- Betting engine (pots/side-pots/rake) is byte-identical to the audited v1 and
  independent of the card layer (`IPokerDealer`), so this pass adds no
  betting-path surface.
- `setDealer`/`setOperator`/owner remain centralization/governance points
  (carried from v1, pre-mainnet item) — acceptable for a single-operator testnet
  house; a timelock/multisig on `owner` is the mainnet follow-up.

---

## Verdict

The catastrophic vectors — deck rigging, the house reading hole cards, theft via
false accusation, cross-deal replay — are **closed cryptographically and covered
by tests** (226 passing). Residuals (§6–10) are bounded griefing / generic
multi-accounting / low-severity timing, each with a documented operational
mitigation and, where relevant, a sketched on-chain hardening. A self-review
`/code-review` pass (2026-07-10) surfaced two further theft/secrecy holes at the
seams between the fixes above — the all-in own-hole forfeiture (§4 follow-up) and
the F5-dropped shuffle pin (§1 follow-up) — both now closed and tested.

**External review recommendation:** the shuffle argument (§1) is a from-scratch
implementation of published production ZK crypto. It follows the reference
pseudo-code line-by-line and passes an adversarial test suite, which is strong
empirical assurance — but before the *absolute* "provably fair" claim is
marketed on real value, it should get an independent cryptographer's eyes and/or
a `/code-review ultra` pass as a second line. This is prudence about
self-implemented crypto, not a known defect.
