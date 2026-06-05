# ShinyLuck

**Agent-native on-chain casino on Somnia.** Submission for the Somnia Agentathon.

> The house is a quorum of autonomous AI agents. Every reel stop, every dice roll, every roulette spin is the `keccak256` of three numbers anyone can audit. House RTP is adjusted hourly by an LLM agent that pulls live competitor data via Somnia's JSON API Agent - no off-chain script, no admin key, fully on-chain.

**Live demo:** https://shiny-luck.vercel.app/ (or run locally with `npm run dev:play` → http://localhost:8080)
**Explorer:** [HouseManager on Shannon Explorer](https://shannon-explorer.somnia.network/address/0xAa41ea7fDF9B38Ab5c5bB0F6d4A3Fc81B2906C5D) - watch `RtpAnalysisRequested` / `RtpAnalysisResolved` / `PlayerDecisionRequested` / `PlayerDecisionResolved` events fire hourly

---

## The pitch

Most on-chain "AI casinos" use AI for flavor text. We made the AI **actually run the house**:

1. Every hour Somnia's Reactivity precompile (`0x0100`) wakes our `HouseManager.sol`.
2. HM calls the **JSON API Agent** (`id 13174292974160097713`) to fetch live competitor RTPs from a public research feed.
3. HM calls the **LLM Inference Agent** (`id 12847293847561029384`, Qwen3-30B) with a prompt that includes our RTP, bankroll, 1h delta, and the just-fetched competitor data. The agent returns one of `LOWER / HOLD / RAISE / BIG_BONUS`.
4. 3 validator workers reach Majority consensus on byte-identical output. The platform calls back into HM, which applies the decision via `casino.adjustSlotRTP()`.

Every casino-**economic** decision - RTP moves, news-driven bonus windows, and player-agent bets - is made on-chain by Somnia Agents, with no oracle middleware in the decision path. (An off-chain keeper handles only operational plumbing - refilling the server-seed pool and nudging per-game max-bet UI caps - and never makes an economic or betting decision; see *Honest disclaimers* below.) Cost of the on-chain loop: ~0.72 STT per hour. Verifiable on explorer event-by-event.

Plus:

- **Agent Quorum Verifier** - independent 3-of-4 LLM committee re-derives the `keccak256` for every settled bet (defence-in-depth on the randomness layer)
- **Player Agents** - users register an `AgentVault` + permitted-games mask + daily/total limits. Every hourly tick HouseManager iterates active players and fires a per-user Somnia LLM Inference request: agent reads the user's mask + remaining budget + vault balance and replies one of `[SKIP, DICE_0.1, SLOTS_0.5, CLUSTER_0.5, PLINKO_0.5, ROULETTE_0.5]`. Callback applies via `registry.executeBet` from the vault. Fully on-chain - no off-chain bot required. **Each LLM tick (~0.24 STT) is pulled from the user's own vault** before dispatch via `registry.collectAgentFee` - an empty vault means the request is skipped and zero STT burned, so spam attacks (1000 empty agents) cost the casino nothing. Owner can subsidise via `setAgentDecisionSubsidyBps` (0 = user pays 100%, 5000 = 50/50, 10000 = casino pays).
- **7 provably-fair games** in one `Casino.sol` - Dice, Crash, Vault.7 (slots), Mines, Plinko, Roulette, Sugar.Lab (cluster pays)
- **~2 s bet latency** - Privy embedded wallet signs in-iframe, we broadcast through our own RPC, reveal-bot reacts via Somnia WebSocket push (no polling)
- **Lifetime stats across redeploys** - frontend aggregates `BetSettled` events across all historical Casino contracts (auto-rotated on each `npm run deploy:testnet`)

---

## Architecture

```
                                     ┌────────────────────────────────┐
                                     │   Somnia Agent Platform        │
                                     │   0x037Bb9C7…6776 (testnet)    │
                                     │                                │
                                     │   ┌──────────────────────┐     │
                                     │   │ JSON API Agent       │     │
                                     │   │ id 13174292…7713     │     │
                                     │   └──────────┬───────────┘     │
                                     │              │                 │
                                     │   ┌──────────▼───────────┐     │
                                     │   │ LLM Inference Agent  │     │
                                     │   │ id 12847293…9384     │     │
                                     │   │ Qwen3-30B, temp=0    │     │
                                     │   └──────────────────────┘     │
                                     └──────────┬─────────────────────┘
                                                │ createRequest / handleResponse
   Reactivity precompile  ──Schedule──►   ┌────▼─────────────────┐
   0x0100                                 │  HouseManager.sol    │  ──► casino.adjustSlotRTP
                                          │  hourly cron handler │  ──► casino.activateBonusMode
                                          └──────────┬───────────┘
                                                     │
                  ┌─────────────────────┐  reactive  │
                  │   Casino.sol        │ ──events──►│
                  │   7 game types      │            │
                  │   commit-reveal RNG │   apply ◄──┘
                  └─────────────────────┘
                          │
        BetPlaced/Settled │ events
                          ▼
                  ┌─────────────────────┐                ┌─────────────────────┐
                  │ AgentQuorumVerifier │                │ PlayerAgentRegistry │
                  │ (3-of-4 LLM workers │                │ + AgentVault        │
                  │  re-derive bet RNG) │                │ (user agent strats) │
                  └─────────────────────┘                └─────────────────────┘
```

## Stack

- **Solidity 0.8.30** - `Casino.sol`, `HouseManager.sol`, `AgentQuorumVerifier.sol`, `PlayerAgentRegistry.sol`
- **Hardhat 2.22** for compile / deploy / verify
- **ethers.js v6** in the frontend SDK + agent-service
- **Privy** embedded wallet (email login) - frontend bundles privy-react via esbuild
- **Vanilla HTML/CSS/ES-modules** in the static site - no framework, no build for the UI
- **`@somnia-chain/reactivity-contracts`** Solidity bindings for the on-chain pub/sub
- **Somnia infra RPC** `https://api.infra.testnet.somnia.network` (canonical, per first-party examples)

## Project layout

```
contracts/
  Casino.sol                 7 games, commit-reveal RNG, pull-payment ledger
  HouseManager.sol           Reactivity handler + Agent Platform requester
  AgentQuorumVerifier.sol    3-of-4 LLM committee re-derives bet RNG
  PlayerAgentRegistry.sol    user agents, allowed-games mask, daily/total limits
  AgentVault.sol             per-user fund-isolated vault
  CommitReveal.sol           server-seed commit/reveal lib (REVEAL_DELAY=1)
  lib/                       game math (Vault7Lib, ClusterLib, etc.)
  interfaces/ISomniaAgent.sol  canonical IAgentRequester (vendored from agentathon)

scripts/
  deploy.js                  deploys + verifies + auto-rotates historicalCasinos
  setup-reactivity.js        funds HM 48 STT, bootstraps hourly cron + BetSettled sub
  _test-llm-rtp-chain.js     E2E verification of the JSON → LLM → Casino chain
  _recover-stt-before-redeploy.js  drain old casinos before redeploy

frontend/                    static site, served by scripts/_dev-frontend.js
  SomniaLuck.html            lobby
  games/sugar/               flagship 7×7 cluster-pays slot
  games/dice.html            simplest game, fastest spin
  games/{crash,mines,plinko,roulette,vault7}/  beta (TESTING tape overlay)
  lib/
    shinyluck-sdk.js         ethers v6 wrapper for the SDK
    privy-signer.js          custom AbstractSigner - split sign + broadcast
    livedata.js              lobby live stats + WS subscriptions
    agent-activity.js        real-time agent dashboard, reads chain events
    rpc.js                   shared provider + Shannon Explorer log indexer
  vendor/                    pre-built privy + ethers bundles

agent-service/
  index.js                   HTTP API for player-agents
  hm-cron.js                 off-chain HM agent (writes recordReasoning narration)
  strategies/executor.js     places bets per registered strategy
```

## Deployed contracts (Somnia Testnet)

All contracts verified on Shannon Explorer.

| Contract              | Address                                                            |
| --------------------- | ------------------------------------------------------------------ |
| Casino                | [`0xd5dB5F85aDe7e1A6296e15F8E5eB897b24241833`](https://shannon-explorer.somnia.network/address/0xd5dB5F85aDe7e1A6296e15F8E5eB897b24241833) |
| HouseManager          | [`0xAa41ea7fDF9B38Ab5c5bB0F6d4A3Fc81B2906C5D`](https://shannon-explorer.somnia.network/address/0xAa41ea7fDF9B38Ab5c5bB0F6d4A3Fc81B2906C5D) |
| AgentQuorumVerifier   | [`0x2FD122E635B6987da4aC4949D88bAcB8b48a9ddF`](https://shannon-explorer.somnia.network/address/0x2FD122E635B6987da4aC4949D88bAcB8b48a9ddF) |
| PlayerAgentRegistry   | [`0x1aC0D7ddF243ca887e54E4E99545d662c5e08ceC`](https://shannon-explorer.somnia.network/address/0x1aC0D7ddF243ca887e54E4E99545d662c5e08ceC) |
| SomniaAgentPlatform   | [`0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776`](https://shannon-explorer.somnia.network/address/0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776) |
| Reactivity precompile | `0x0000000000000000000000000000000000000100`                       |

## Setup

```bash
git clone <this-repo>
cd ShinyLuck
npm install
cd agent-service && npm install && cd ..

cp .env.example .env
# Edit .env:
#   PRIVATE_KEY=<your deployer EOA private key, 32-byte hex without 0x>
#   RPC_TESTNET=https://api.infra.testnet.somnia.network
#   Privy_App_Id=<your Privy app id>

# Compile + deploy + verify (auto-writes frontend/lib/config.js + agent-service/.env)
npx hardhat compile
npm run deploy:testnet

# Bootstrap Reactivity (funds HM 48 STT, creates hourly cron + BetSettled sub)
npx hardhat run scripts/setup-reactivity.js --network somniaTestnet

# Verify the full agent chain end-to-end
npx hardhat run scripts/_test-llm-rtp-chain.js --network somniaTestnet
```

## Run locally

```bash
npm run dev:play
# Starts:
#   FRONTEND  http://localhost:8080
#   REVEAL    WS-push reveal-bot
#   AGENT     player-agent API (:3001)
#   HMCRON    off-chain HM narration cron
```

Open http://localhost:8080, connect email via Privy, switch to Somnia testnet (auto), get STT from [the faucet](https://testnet.somnia.network/), play.

## Watching the agent chain on-chain

Every hour the HM emits 4 events you can grep in Shannon Explorer:

1. `CompetitorRtpRequested(requestId, game, url)` - JSON API agent dispatched
2. `CompetitorRtpResolved(requestId, game, rtpBps)` - 3 workers reached Majority
3. `RtpAnalysisRequested(requestId, game, ourRtpBps, bankrollChangeBps, competitorRtpBps)` - LLM agent dispatched with full context
4. `RtpAnalysisResolved(requestId, game, oldRtpBps, newRtpBps, decision, sample)` - LLM consensus on `LOWER/HOLD/RAISE/BIG_BONUS`, applied via `casino.adjustSlotRTP()`

Plus per-bet:

- `ReactiveBetSettledHandled` - HM's per-`BetSettled` reflex (re-sizes maxBet)
- `QuorumResult` from AgentQuorumVerifier (3-of-4 LLM workers re-derive randomness)

## Honest disclaimers

- **The 7 games:** Sugar.Lab and Dice are production-quality. The other 5 (Crash, Vault.7, Mines, Plinko, Roulette) settle correctly on-chain but have rough UI - marked with a yellow "TESTING" hazard tape so users don't expect polished visuals.
- **The competitor RTP feed:** currently hosted on `jsonblob.com` (anonymous, owner-replaceable via `HouseManager.setCompetitorFeedUrl()`). Numbers are manually curated from public casino-review sites (askgamblers, casinoguru, gambling.com). On mainnet we'd self-host with a CI-updated CDN.
- **Money path is on commit-reveal:** the LLM Inference Agent only adjusts the *published* RTP - actual randomness is `keccak256(serverSeed ‖ clientSeed ‖ blockhash ‖ nonce)`, on-chain, no AI in the path. AgentQuorumVerifier is defence-in-depth on randomness, not its source.
- **No mainnet deploy yet** - every testnet redeploy ID is appended to `historicalCasinos` so user lifetime stats survive.
- **Off-chain components (full disclosure):** two services run off-chain - the bet-settlement *reveal-bot* (reveals the committed server seed so a bet can settle) and an operational *House keeper* (`agent-service/hm-cron.js`: refills the seed pool, nudges max-bet UI caps). Neither makes a betting or RTP decision - the economic brain (RTP, news bonus, player bets) is 100% on-chain via Somnia Agents. The reveal-bot is the one live-uptime dependency for settlement.
- **Owner-withdraw timelock disabled on testnet:** `Casino.OWNER_WITHDRAW_DELAY = 0` so the operator can reclaim STT between redeploys. Mainnet restores the 24h timelock - a load-bearing mitigation against a compromised owner key. Until then the owner key is a trusted party for the bankroll.

## License

MIT

---

# ShinyLuck (русская версия)

**Agent-native on-chain казино на Somnia.** Сабмишен для Somnia Agentathon.

> Дом - это автономный AI-агент. Каждая остановка барабана, каждый бросок кубика, каждый спин рулетки - это `keccak256` от трёх чисел, которые любой может проверить. RTP казик каждый час подбирает LLM-агент, который через JSON API Agent тащит реальные RTP конкурентов с публичного research-фида - никакого off-chain скрипта, никакого админского ключа, всё на цепи.

**Живое демо:** https://shiny-luck.vercel.app/ (или локально через `npm run dev:play` → http://localhost:8080)
**Explorer:** [HouseManager на Shannon Explorer](https://shannon-explorer.somnia.network/address/0xAa41ea7fDF9B38Ab5c5bB0F6d4A3Fc81B2906C5D) - каждый час летят `RtpAnalysisRequested` / `RtpAnalysisResolved`

---

## Питч

Большинство «AI-казино on-chain» используют AI для генерации flavor-текста. Мы сделали так чтобы AI **реально управлял домом**:

1. Каждый час Reactivity precompile Somnia (`0x0100`) будит наш `HouseManager.sol`.
2. HM зовёт **JSON API Agent** (`id 13174292974160097713`), который тащит свежие RTP конкурентов с публичного research-фида.
3. HM зовёт **LLM Inference Agent** (`id 12847293847561029384`, Qwen3-30B) с промптом где есть наш RTP, банкролл, дельта за час и только что полученные данные конкурентов. Агент возвращает одно из `LOWER / HOLD / RAISE / BIG_BONUS`.
4. 3 валидатора достигают Majority-консенсуса (байт-в-байт одинаковый ответ). Платформа делает callback в HM, который применяет решение через `casino.adjustSlotRTP()`.

Каждое казино-**экономическое** решение - изменение RTP, news-driven бонус-окна и ставки player-агентов - принимается on-chain агентами Somnia, без oracle-middleware в пути решения. (Off-chain keeper делает только операционную сантехнику - рефилл пула server-seed'ов и подгон UI-кэпов max-bet - и никогда не принимает экономических или ставочных решений; см. *Честно* ниже.) Стоимость on-chain петли: ~0.72 STT в час. Каждый шаг проверяется в эксплорере по событиям.

Плюс:

- **Agent Quorum Verifier** - независимый комитет 3-из-4 LLM-воркеров переcчитывает `keccak256` для каждой ставки (защита в глубину на randomness-слое)
- **Player Agents** - `PlayerAgentRegistry` + `AgentVault` позволяют пользователю отдать relayer'у (или прямо HouseManager'у через on-chain LLM) право делать ставки в строгих дневных/тотальных лимитах, средства изолированы в vault-контракте. **Каждый LLM-tick (~0.24 STT) списывается из vault'а самого юзера** через `registry.collectAgentFee` до отправки запроса в Agent Platform - пустой vault значит запрос скипнут и ноль сожжённых STT, поэтому спам-атака (1000 пустых агентов) стоит казино ноль. Owner может субсидировать через `setAgentDecisionSubsidyBps` (0 = юзер платит 100%, 5000 = 50/50, 10000 = казино платит)
- **7 provably-fair игр** в одном `Casino.sol` - Dice, Crash, Vault.7 (слоты), Mines, Plinko, Roulette, Sugar.Lab (cluster pays)
- **~2 сек задержка ставки** - Privy embedded-wallet подписывает в iframe, мы броадкастим через свой RPC, reveal-bot реагирует на Somnia WebSocket push (никакого polling)
- **Lifetime статистика переживает редеплои** - фронтенд аггрегирует `BetSettled` события по всем историческим casino-контрактам (`historicalCasinos` ротируется автоматом на каждом `npm run deploy:testnet`)

## Деплоенные контракты (Somnia Testnet)

Все 4 контракта верифицированы на Shannon Explorer.

| Контракт              | Адрес                                                              |
| --------------------- | ------------------------------------------------------------------ |
| Casino                | [`0xd5dB5F85aDe7e1A6296e15F8E5eB897b24241833`](https://shannon-explorer.somnia.network/address/0xd5dB5F85aDe7e1A6296e15F8E5eB897b24241833) |
| HouseManager          | [`0xAa41ea7fDF9B38Ab5c5bB0F6d4A3Fc81B2906C5D`](https://shannon-explorer.somnia.network/address/0xAa41ea7fDF9B38Ab5c5bB0F6d4A3Fc81B2906C5D) |
| AgentQuorumVerifier   | [`0x2FD122E635B6987da4aC4949D88bAcB8b48a9ddF`](https://shannon-explorer.somnia.network/address/0x2FD122E635B6987da4aC4949D88bAcB8b48a9ddF) |
| PlayerAgentRegistry   | [`0x1aC0D7ddF243ca887e54E4E99545d662c5e08ceC`](https://shannon-explorer.somnia.network/address/0x1aC0D7ddF243ca887e54E4E99545d662c5e08ceC) |
| SomniaAgentPlatform   | [`0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776`](https://shannon-explorer.somnia.network/address/0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776) |
| Reactivity precompile | `0x0000000000000000000000000000000000000100`                       |

## Сетап

```bash
git clone <this-repo>
cd ShinyLuck
npm install
cd agent-service && npm install && cd ..

cp .env.example .env
# Заполни .env:
#   PRIVATE_KEY=<приватный ключ деплоера, hex без 0x>
#   RPC_TESTNET=https://api.infra.testnet.somnia.network
#   Privy_App_Id=<id твоего Privy app>

# Скомпилировать + задеплоить + верифицировать
npx hardhat compile
npm run deploy:testnet

# Бутстрап Reactivity (топит HM 48 STT, создаёт hourly cron + BetSettled sub)
npx hardhat run scripts/setup-reactivity.js --network somniaTestnet

# Проверить всю agent-цепочку end-to-end
npx hardhat run scripts/_test-llm-rtp-chain.js --network somniaTestnet
```

## Запуск локально

```bash
npm run dev:play
# Поднимает:
#   FRONTEND  http://localhost:8080
#   REVEAL    reveal-bot с WS-push
#   AGENT     player-agent API (:3001)
#   HMCRON    off-chain HM narration cron
```

Открой http://localhost:8080, залогинься email'ом через Privy, переключись на Somnia testnet (автоматом), возьми STT из [крана](https://testnet.somnia.network/), играй.

## Что смотреть в эксплорере

Каждый час HM эмитит 4 события которые ты увидишь в Shannon Explorer:

1. `CompetitorRtpRequested(requestId, game, url)` - JSON API agent ушёл за данными
2. `CompetitorRtpResolved(requestId, game, rtpBps)` - 3 воркера достигли Majority
3. `RtpAnalysisRequested(requestId, game, ourRtpBps, bankrollChangeBps, competitorRtpBps)` - LLM agent ушёл с полным контекстом
4. `RtpAnalysisResolved(requestId, game, oldRtpBps, newRtpBps, decision, sample)` - LLM-консенсус на `LOWER/HOLD/RAISE/BIG_BONUS`, применено через `casino.adjustSlotRTP()`

Плюс на каждую ставку:

- `ReactiveBetSettledHandled` - HM-рефлекс на каждую `BetSettled` (подгоняет maxBet)
- `QuorumResult` от AgentQuorumVerifier (3-из-4 LLM-воркеров переcчитывают randomness)

## Честно

- **7 игр:** Sugar.Lab и Dice - production-quality, отполированы. Остальные 5 (Crash, Vault.7, Mines, Plinko, Roulette) корректно settle on-chain, но визуал черновой - помечены жёлтой «TESTING» лентой чтобы юзер не ожидал полированной графики. Играть в них пока сложно из-за визуальных багов.
- **Competitor RTP feed:** сейчас хостится на `jsonblob.com` (анонимный, owner может переключить через `HouseManager.setCompetitorFeedUrl()`). Числа собраны вручную с публичных casino-review сайтов (askgamblers, casinoguru, gambling.com). Для мейннета развернём свой CI-обновляемый CDN.
- **Деньги идут через commit-reveal:** LLM Inference Agent меняет только *опубликованный* RTP - фактический randomness это `keccak256(serverSeed ‖ clientSeed ‖ blockhash ‖ nonce)` на цепи, без AI в money-path. AgentQuorumVerifier - это защита в глубину на randomness, не его источник.
- **Мейннет деплоя пока нет** - каждый testnet редеплой добавляется в `historicalCasinos` чтобы lifetime-статистика юзеров переживала.
- **Off-chain компоненты (полное раскрытие):** off-chain работают два сервиса - *reveal-bot* для settle'а ставок (раскрывает закоммиченный server seed) и операционный *House keeper* (`agent-service/hm-cron.js`: рефилл пула сидов, подгон UI-кэпов max-bet). Ни один из них не принимает ставочных или RTP решений - экономический мозг (RTP, news-bonus, ставки игроков) полностью on-chain через агентов Somnia. Reveal-bot - единственная зависимость по аптайму для settle'а.
- **Таймлок вывода отключён на тестнете:** `Casino.OWNER_WITHDRAW_DELAY = 0`, чтобы оператор мог забирать STT между редеплоями. На мейннете возвращается 24h timelock - load-bearing защита от скомпрометированного ключа владельца. До тех пор ключ владельца - доверенная сторона для банкролла.

## Лицензия

MIT

