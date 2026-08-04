# ShinyLuck

**On-chain casino + on-chain No-Limit Hold'em poker, one site, one wallet, on Somnia.**

**Live:** https://shinyluck.win · **Network:** Somnia **testnet** (chainId `50312`, token STT)

Every casino bet is a `keccak256` anyone can recompute. Every poker hand is dealt by
mental poker — the deck is shuffled and encrypted by the players themselves, and no
server, including ours, can see a hole card before showdown.

> **This is a testnet deployment.** STT has no monetary value. Nothing here has been
> audited. See [Honest disclaimers](#honest-disclaimers) before reading anything as a
> production claim.

Every number in this README was read off the live chain on **2026-08-04**, not copied
from a previous version of the document.

---

## What is actually running

| | |
| --- | --- |
| **Casino** | 7 games, all live: Dice, Crash, VAULT.7 (slots), Mines, Plinko, Roulette, SUGAR.LAB (cluster pays) |
| **Poker** | 6-max and heads-up cash tables + multi-table tournaments, NLHE, fully on-chain |
| **Wallet** | Privy embedded wallet (email login, no popups). MetaMask only on `/admin` |
| **Bankroll** | 25.9 STT free in the vault → max bet 1% ≈ 0.26 STT, max payout 20% ≈ 5.2 STT |
| **Poker escrow** | 10.1 STT held for players across cashier balances and table stacks |
| **Scale** | 61 poker tables created, 25 tournaments run |

Somnia, measured rather than assumed: block time **0.100 s**, baseFee fixed at
**6 gwei**, a transaction lands **5 blocks (~0.55 s)** after broadcast.

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

Winnings are pull-payment (`claim()`), with the UI auto-claiming on an idle debounce
so a fast player never queues a claim in front of their next spin. `/fair` recomputes
any historical bet from chain state and compares it against the on-chain result.

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
3. **Reveal** — a card becomes readable only when *every* player publishes a
   decryption share with a Chaum–Pedersen proof. The contract checks each share and
   that the shares actually decrypt that ciphertext to that card, so the coordinator
   **cannot lie about a card and cannot learn a hole card early**. A per-deal bitmask
   rejects any card value appearing twice — a duplicated-card shuffle cancels the hand
   instead of settling it wrong.
4. **Showdown** — the reveal that completes the showdown also settles the pot in the
   same transaction. Readiness is derived by the contract from the room's own seat
   state, never asserted by the bot. Folded hands are never revealed, ever.

A player who disappears mid-hand can be *accused* on chain, and can answer the
accusation themselves; a verified rescue share is stored and consumed, so stalling
just forces the shares out one accusation at a time.

Measured on the live network: showdown tail **2 s**, board cards **1–2 s** per street
(and about a second earlier on screen, because the client decrypts locally once it has
the shares), **1–2 s** between hands.

**Money:** rake 10 % capped per hand, **zero on tournament tables** and **zero on
pre-flop folds** ("no flop, no drop"). Tournaments take an entry fee plus a 10 %
sponsor fee; a host may take up to 10 %, and only when there is a buy-in.

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

**None of these are verified on Shannon Explorer.** The source in this repository is
the canonical reference; every address above is interactable on chain.

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
  permitted-games mask and daily limits, and it would bet from its own vault, paying
  for its own LLM tick.

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
  poker/                     table, lobby and tournament UI (JSX, precompiled)

scripts/
  deploy-v15.js              casino deploy → writes the manifest and frontend config
  deploy-poker-v2.js         poker deploy
  swap-v15-modules.js        replace a game module on the live chain
  _swap-zk-dealer.js         replace the poker card layer without touching the money
  poker-dealer-bot.js        the coordinator: HTTP relay, snapshots, watchdogs
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
- **Two off-chain services exist and neither decides an outcome.** The reveal bot
  publishes the committed server seed so a bet can settle; the poker dealer bot relays
  encrypted shares, drives the phase machine and pays gas. Neither can change a card or
  a result — the contracts verify every share and every payout. They are, however, a
  liveness dependency: if they are down, settlement waits.
- **Old bets on retired casino contracts are still claimable** and the profile drawer
  sweeps them; balances are not migrated on redeploy.
- The site also serves `/infofi` (a curated X-account board, refreshed nightly) and
  `/predictions` (a parimutuel prediction market, separate codebase). Neither touches
  the casino or poker contracts.

## License

MIT

---
---

# ShinyLuck (русская версия)

**Он-чейн казино + он-чейн покер (NLHE) на одном сайте, с одним кошельком, на Somnia.**

**Живой сайт:** https://shinyluck.win · **Сеть:** Somnia **testnet** (chainId `50312`, STT)

Каждая ставка в казино — это `keccak256`, который может пересчитать кто угодно. Каждая
раздача в покере — mental poker: колоду тасуют и шифруют сами игроки, и ни один сервер,
включая наш, не видит карманные карты до вскрытия.

> **Это тестнет.** STT не имеет денежной ценности, аудита не было. Прежде чем читать
> что-либо как продакшн-заявление, см. [Честные оговорки](#честные-оговорки).

Все цифры в этом файле сняты с живой цепи **2026-08-04**, а не переписаны из прошлой
версии документа.

---

## Что реально работает

| | |
| --- | --- |
| **Казино** | 7 игр, все включены: Dice, Crash, VAULT.7 (слот), Mines, Plinko, Roulette, SUGAR.LAB (кластер-пэйс) |
| **Покер** | кэш-столы 6-max и хедз-ап + мультистоловые турниры, всё он-чейн |
| **Кошелёк** | Privy (вход по почте, без попапов). MetaMask только на `/admin` |
| **Банкролл** | 25.9 STT свободных → макс. ставка 1 % ≈ 0.26 STT, макс. выплата 20 % ≈ 5.2 STT |
| **Эскроу покера** | 10.1 STT игроков: балансы кассы + фишки на столах |
| **Масштаб** | создан 61 стол, проведено 25 турниров |

Somnia — замерено, а не предположено: блок **0.100 с**, baseFee фиксированный
**6 gwei**, транзакция попадает в цепь через **5 блоков (~0.55 с)**.

---

## Казино: сейф, который не двигается, и заменяемые игры

Раньше казино было одним `Casino.sol`. Он дорос до 43 КБ — 176 % от лимита в 24 КБ, —
и любая правка означала редеплой вместе с банкроллом. **v15** это разделяет:

```
CasinoVault  (ПОСТОЯННЫЙ адрес: весь банкролл, RNG, риск-лимиты,
 |            реестр игр и pull-payment для выигрышей)
 ├── DiceModule       одиночная ставка
 ├── CrashModule      раундовая
 ├── Vault7Module     слот         ─┐
 ├── MinesModule      многошаговая  ├─ SlotLoyalty (общие фри-спины на оба слота)
 ├── PlinkoModule     одиночная     │
 ├── RouletteModule   раундовая     │
 └── ClusterModule    слот + шкала заряда ─┘
```

- Добавить игру = `vault.registerGame(id, module, budget)`. **Ядро не редеплоится,
  банкролл не мигрирует.**
- **Радиус поражения — это бюджет.** У каждой игры свой (сейчас 5 STT); Vault режет
  выплату сверх него. Кривой или злой модуль не унесёт больше своего бюджета. Модули
  не хранят денег, `delegatecall` не используется нигде.
- Зарегистрировать игру может только владелец. Незарегистрированный контракт,
  зовущий `credit`, ревертится с `NotModule`.
- Это проверено на проде, а не только в тестах: пять модулей уже заменены на живой
  сети, Vault и банкролл при этом не трогались.

### Provably fair

```
randomness = keccak256(serverSeed ‖ clientSeed ‖ blockhash(commitBlock+1) ‖ nonce)
```

Ни одна часть не декоративна:

- **serverSeed** коммитится до ставки и раскрывается после — это защита от того, что
  валидатор подберёт хеш блока под нужный исход.
- **blockhash** ещё не существующего блока защищает от избирательного сеттла уже с
  нашей стороны: в момент ставки исход не знает НИКТО, включая дом.
- **clientSeed** ваш, поэтому вы можете доказать, что ваш ввод участвовал.

Выигрыши забираются через `claim()`, причём интерфейс клеймит сам по паузе в игре —
чтобы клейм не встал в очередь перед вашим следующим спином. `/fair` пересчитывает
любую историческую ставку из состояния цепи и сверяет с он-чейн результатом.

### Преимущество казино, прочитанное с модулей только что

| Игра | Эдж | Откуда |
| --- | --- | --- |
| Dice | 1.00 % | `houseEdgeBps=100`, ровно столько на всём диапазоне 0.01 %–99.99 % |
| Crash | 1.00 % | `houseEdgeBps=100` |
| Mines | 1.20 % | `houseEdgeBps=120` |
| Plinko | ~1.0 % | посчитан по трём таблицам выплат (RTP 98.999 / 98.988 / 98.976 %) |
| Roulette | 5.26 % | `houseEdgeBps=526` — колесо с двойным зеро |
| VAULT.7 | см. ниже | слот, поля плоского эджа нет |
| SUGAR.LAB | см. ниже | слот, поля плоского эджа нет |

**Слоты — единственное место, где сайт и реальность расходятся, и лучше сказать об
этом здесь, чем дать вам это обнаружить.** Сайт публикует 96.42 % (VAULT.7) и 96.38 %
(SUGAR.LAB). Восемь независимых прогонов, суммарно ~32 млн спинов на игру, при тех
значениях буста, что стоят на цепи (`589` и `340`), дали:

| Игра | Сайт говорит | Измерено | Разброс |
| --- | --- | --- | --- |
| VAULT.7 | 96.42 % | **95.7 %** | 95.49–95.86 |
| SUGAR.LAB | 96.38 % | **96.7 %** | 96.43–96.80 |

То есть VAULT.7 платит примерно на 0.7 пункта меньше заявленного. Причина известна:
формула `reportedRtpBps()` в модуле линейна по бусту, а шкала заряда даёт ~13.8 %
отдачи и от буста не зависит. Чинится одной owner-транзакцией на слот-модуль плюс
перезамер; пока не сделано. Опубликованный RTP слотов авторитетным считать не стоит.

---

## Покер: zkShuffle v2 (mental poker)

Дилер не знает карт. Нет сида, который сервер мог бы слить.

1. **Ключи** — каждый игрок делает ключевую пару BN254 на раздачу и доказывает
   владение ей (Schnorr). Ключ стола — сумма публичных ключей.
2. **Шафл** — колода шифруется ElGamal и передаётся от игрока к игроку. Каждый тасует
   и ремаскирует её и публикует **пруф Wikström**, что результат — перестановка и
   перешифровка входа. Цепь проверяет всю цепочку пруфов ДО выдачи карт, а раздача
   коммитится к keccak всего транскрипта.
3. **Раскрытие** — карта становится читаемой, только когда *каждый* игрок опубликовал
   долю расшифровки с пруфом Chaum–Pedersen. Контракт проверяет каждую долю и то, что
   доли действительно расшифровывают этот шифротекст именно в эту карту, поэтому
   координатор **не может соврать про карту и не может узнать карманную карту раньше
   времени**. Битовая маска на раздачу отвергает повтор значения карты — колода с
   дублем отменяет руку, а не досчитывает её неверно.
4. **Шоудаун** — раскрытие, завершающее вскрытие, в той же транзакции выплачивает
   банк. Готовность выводится контрактом из состояния стола, а не заявляется ботом.
   Сфолдившие руки не раскрываются никогда.

Игрока, пропавшего посреди руки, можно **обвинить** он-чейн, и он может ответить сам;
проверенная доля спасения сохраняется и используется, так что затягивание просто
вынуждает отдавать доли по одной на обвинение.

Замерено на живой сети: хвост шоудауна **2 с**, карты борда **1–2 с** на улицу (и на
экране примерно на секунду раньше, потому что клиент расшифровывает локально, как
только собрал доли), между руками **1–2 с**.

**Деньги:** рейк 10 % с капом на руку, **ноль на турнирных столах** и **ноль на
префлоп-фолдах** («no flop, no drop»). Турниры берут вход плюс 10 % спонсорского
сбора; хост может взять до 10 % и только при наличии бай-ина.

---

## Адреса контрактов (Somnia testnet, chainId 50312)

Таблицы адресов — в английской части выше. Дублировать их здесь значит завести второе
место, где они протухнут.

Карточный слой покера сделан заменяемым намеренно (`room.setDealer(...)`) — именно для
того, чтобы контракт с деньгами игроков никогда не пришлось двигать.
`scripts/_swap-zk-dealer.js` делает замену и отказывается работать, пока идёт хоть
одна раздача.

**Ни один контракт не верифицирован на Shannon Explorer.** Канонический источник —
исходники в этом репозитории; все адреса выше можно дёргать на цепи.

---

## Что было раньше: эпоха агентов (сделано, работало, выключено)

ShinyLuck начинался как заявка на **Somnia Agentathon**, и идея была в том, что ИИ
**управляет казино**, а не пишет флейвор-текст. Это было по-настоящему и работало:

- `HouseManager.sol` просыпался раз в час через прекомпайл Reactivity, тянул RTP
  конкурентов через JSON API Agent, спрашивал LLM Inference Agent (Qwen3-30B) о
  `LOWER / HOLD / RAISE / BIG_BONUS` и применял вердикт через `casino.adjustSlotRTP()`
  — он-чейн, с консенсусом трёх воркеров по побайтово одинаковому ответу.
- `AgentQuorumVerifier.sol` — независимый комитет 3-из-4 LLM перевыводил `keccak256`
  каждой отсеттленной ставки как эшелонированная защита слоя случайности.
- `PlayerAgentRegistry.sol` + `AgentVault.sol` — игрок мог зарегистрировать агента с
  маской разрешённых игр и дневными лимитами, и тот ставил из своего волта, оплачивая
  собственный LLM-тик.

**Сегодня это всё выключено** и убрано из интерфейса. Контракты остались на цепи
(`Casino` v13 `0x01D31a1a…` держит 7.46 STT, `HouseManager` `0x74f189f4…`,
`AgentQuorumVerifier` `0xaB37e48a…`, `PlayerAgentRegistry` `0x54f68611…`), Solidity
лежит в `contracts/`. В живом денежном пути их нет.

Почему выключили: часовой агентный цикл стоил ~0.72 STT в час и двигал число, которое
лучше двигает таблица, — а то, что игроки реально чувствуют (задержки, честность,
доигрывает ли рука до конца), к нему отношения не имело. Честная версия проекта
оказалась быстрым казино и настоящим покер-румом, а не LLM в пути выплаты. Деньги
игроков всегда считал commit-reveal, а не агент.

---

## Запуск

```bash
npm install
npx hardhat compile

# контрактные тесты — список передавать явно: голый `npx hardhat test`
# глушится .mjs-смоуком, который завершает процесс
npx hardhat test $(ls test/*.test.js)

# покер в НАСТОЯЩЕМ браузере против локально поднятого стека
# (hardhat-нода + контракты + дилер-бот + веб-сервер, инжектированные кошельки)
npm i -D playwright --legacy-peer-deps && npx playwright install chromium
npm run test:pages        # три покерные страницы поднимаются
npm run test:browser      # кэш-стол, 2 вкладки, ~2 мин
npm run test:tournament   # полный турнир, 3 вкладки, ~5 мин
npm run test:mtt          # мультистол: 5 игроков, 2 стола, переносы, слияние, ~7 мин
# HEADED=1 — смотреть, как оно играет
```

Деплой живёт в `deploy/` (Caddy + pm2). Сайт статический; постоянно работают только
дилер-бот покера и reveal-бот казино.

---

## Честные оговорки

- **Только тестнет.** STT — не деньги. Майннет-деплоя нет.
- **Аудита не было, на эксплорере не верифицировано.** Читайте исходники здесь.
- **Опубликованный RTP слотов неверен** — см. таблицу выше. VAULT.7 платит ~95.7 %,
  а сайт говорит 96.42 %. Известно, измерено, пока не исправлено.
- **Ключ владельца — доверенная сторона.** `OWNER_WITHDRAW_DELAY` на тестнете равен 0,
  прокси и таймлока перед Vault нет. Для майннета таймлок и мультисиг — первое дело.
- **`refundFromModule` не клампится бюджетом**, что портит инвариант «радиус поражения
  = бюджет игры» для гипотетического кривого модуля. Живого бага нет — все модули
  возвращают ровно то, что взяли в эскроу, — но это известная дыра, чинится только
  редеплоем Vault, то есть на майннете.
- **Есть два офф-чейн сервиса, и ни один не решает исход.** Reveal-бот публикует
  закоммиченный server seed, чтобы ставка могла отсеттлиться; покерный дилер-бот
  ретранслирует зашифрованные доли, ведёт фазовую машину и платит газ. Ни тот, ни
  другой не может изменить карту или результат — контракты проверяют каждую долю и
  каждую выплату. Но это зависимость по живучести: если они лежат, сеттл ждёт.
- **Старые ставки на снятых с эксплуатации контрактах казино по-прежнему клеймятся**,
  и дровер профиля их подметает; при редеплое балансы не мигрируют.
- Сайт также отдаёт `/infofi` (подобранная доска X-аккаунтов, обновляется ночью) и
  `/predictions` (паримутуэльный рынок предсказаний, отдельная кодовая база). Ни то,
  ни другое не трогает контракты казино и покера.

## Лицензия

MIT
