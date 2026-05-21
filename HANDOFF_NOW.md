# ShinyLuck — Handoff (выжимка)

**Что проект:** on-chain казино на Somnia Testnet для Somnia Agentathon. 7 игр (Dice, Crash, Slots [Vault7], Mines, Plinko, Roulette, Cluster [Sugar.Lab]). Email-логин через Privy embedded wallet, **ноль popup'ов** на транзакции, commit-reveal scheme с reveal-bot.

**Юзер:** ukraine.ru@outlook.com, носитель русского. На Windows: `D:\Рабочий стол\ShinyLuck`. Раздражается на повторные баги — **читай реальный код перед действиями, не угадывай**.

---

## Состояние СЕЙЧАС

### Контракты (somniaTestnet, chainId 50312)
```
casino                0x0d397E36215Fb534F0dE4E279f505dEC3F63E4B6
houseManager          0x8864e2B29D1dd1A9969d6182095776Ab0D26DC4A
playerAgentRegistry   0xb61fA312A83cadd836eC0bF90493A9d62AC9F747
agentQuorumVerifier   0xe83cA2b91216A038f3825CE1F5131f3133f0fA2C
deployer              0x3fFa302E620492C8Fb43426a0e54E537C0d937A6
```

### Балансы (последний snapshot)
```
deployer       1.07 STT
casino        56.25 STT free, 0 locked, 50 STT в pending owner-withdraw
HM            29.97 STT (НИЖЕ 32 STT precompile floor — но reveal-bot работает off-chain, не критично)
всего        ~87 STT
```

### Игры
- Все 7 unpaused
- Buy-bonus в слотах **не доступен** (требует ~600 STT bankroll, у нас 56)
- Обычные spins работают, max stake ≈ 0.022 STT (clamped by payout cap)

### Сервисы
- `npm run dev:play` (frontend + reveal-bot, БЕЗ demo-bot) — task id текущей сессии `bkoteddb8`
- Frontend: http://localhost:8080/
- reveal-bot `POLL_MS=300ms`, WS-subscribed

---

## Что недавно сделано (топ → bottom = новые → старые)

```
perf(privy): bypass useSendTransaction → use EIP-1193 directly (~2s faster place)
perf: WS-pushed BetSettled + tighter polls + per-step spin timing logs
fix(slots): grid-template-columns minmax(0, 1fr) — была главная причина "fly up"
fix(slots): play() гард _userInitiated — отказ запускать вне spin()
fix(slots): static reels до клика + native cursor на slot-страницах
fix(slots): clientHeight=0 trap, min-height safety net
fix(slots): glyph-shuffle вместо strip-translate
feat: _refund-expired + _diag-seeds — recovery tooling
fix(slots): restore data-sound button, absolute paths, чистый URL
fix(slots): poll для SL.address на page-to-page navigation
P0: contract-exact slot replay (ClusterLib + Vault7Lib)
fix(privy): embedded wallet self-heal + zero-popup
P0 hotfix: Privy flat-array loginMethods + NaN guards в crash
```

---

## Перф (последние замеры пользователя)

**Было:** `[sugar] spin total 7891ms (clamp 171ms · place 4825ms · wait 2733ms · receipt 162ms)`

**Bottleneck — `place` (4.8s)**, потому что React-хук Privy `useSendTransaction` добавлял ~2s оверхеда (свой gas estimation/policy check) поверх подписи в iframe.

**Сейчас (после fast-path):** `wallet.getEthereumProvider().request({method: 'eth_sendTransaction'})` — подпись по-прежнему в iframe Privy (security boundary), broadcast напрямую в RPC, без React-хука. Ожидаемо: **place ~2.5-3s**, **общий spin ~5.5s**.

**Floor:**
- `REVEAL_DELAY = 3 блока × 1.2s = 3.6s` (зашит в `CommitReveal.sol`)
- Можно опустить до 1 редеплоем — даст ещё **-2.4s** → итого **~3s**

---

## Открытое — что юзер ждёт от тебя

1. **Юзер сейчас тестирует Privy fast-path.** Ждёт от него новый замер `[sugar] spin total ...`. Если new place < 3000ms — успех, профит достигнут.
2. **24h timer на owner-withdraw 50 STT уже идёт** (запустил `scheduleOwnerWithdraw(50)` несколько минут назад). Через сутки можно:
   - `npx hardhat run scripts/_claim-owner-withdraw.js --network somniaTestnet`
   - Поменять `REVEAL_DELAY` в `CommitReveal.sol` с 3 на 1
   - Редеплой → новый casino + HM
   - Top up из claim'нутых 50 STT
   - Обновить `frontend/lib/config.js` адресами
   - Финальный spin time ~3s

   **Сегодня редеплой не делать** — deployer пустой (1.07 STT), 50 STT в casino заблокированы 24h timelock'ом.

3. **Sugar replay mismatch** — есть warning `[slot-decoders] sugar replay mismatch vs on-chain finalGrid` в консоли. Не блокер (UI берёт авторитетный grid с контракта), но `slot-decoders.js` не точно реплицирует ClusterLib. Если будет время — нужно сверить константы. Скорее всего разъехались `CLUSTER_PAY_BOOST_X100` или `SYM_WEIGHTS`.

---

## Грабли (важные)

1. **STT supply конечен** — backup кошелёк был ~500 STT, осталось ~87. **Не редеплой и не сжигай газ без необходимости.** Запланируй gas заранее через `scripts/_balcheck.js`.
2. **Privy iframe** — embedded wallet ключи в iframe Privy. Любая security политика их (например, "Require user gesture") сломает наш zero-popup flow.
3. **REVEAL_DELAY=3** — это минимум через 3 блока после place tx. Reveal-bot должен быть жив для settle.
4. **dev:all** запускает demo-bot который **ест банкролл и тригерит circuit breaker**. Используй `dev:play` для тестов юзером.
5. **Браузер кэширует JS агрессивно.** Сервер сейчас отдаёт `Cache-Control: no-store` для JS/CSS/HTML, но если меняешь `api.js`/`animation.js` — бампи `?v=N` в `frontend/games/{sugar,vault7}/index.html`.
6. **Все 5 пар `_userInitiated` guards** в `animation.js` и `api.js` для обоих слотов. play() и _spinToGrid отказываются работать без флага. **Не убирай** — защита от rogue caller (race conditions, stale promises).
7. **CSS grid:** ВЕЗДЕ `repeat(N, minmax(0, 1fr))`, а не `repeat(N, 1fr)`. Иначе один колонка может сожрать всю ширину.
8. **Privy App ID:** `cmp9pb26g01py0cjlks1njki1` (в `frontend/lib/config.js`).

---

## Ключевые файлы

```
contracts/Casino.sol                 — основной контракт, circuit-breaker, owner-withdraw
contracts/CommitReveal.sol           — REVEAL_DELAY=3, BLOCKHASH_WINDOW=256
contracts/games/ClusterLib.sol       — sugar 7×7 cascade
contracts/games/Vault7Lib.sol        — vault7 5×3 / 20 paylines
deployments/somniaTestnet.json       — адреса
frontend/lib/wallet.js               — Privy connect + auto-reattach + 500ms polling
frontend/lib/privy-entry.jsx         — Privy React shell, EIP-1193 fast path
frontend/lib/privy-signer.js         — ethers Signer обёртка
frontend/lib/shinyluck-sdk.js        — place*/waitForSettle (WS-raced)
frontend/lib/slot-decoders.js        — contract-exact JS replay
frontend/lib/casino-limits.js        — clampStake by payout cap
frontend/games/sugar/{index.html,api.js,animation.js,styles.css}
frontend/games/vault7/{index.html,api.js,animation.js,styles.css}
scripts/reveal-bot.js                — POLL_MS=300ms default
scripts/_dev-{frontend,reveal-bot}.js
scripts/_full-reset.js               — unpause all + topup
scripts/_drain-hm-partial.js
scripts/_refund-expired.js           — освобождает locked reserve от expired bets
scripts/_diag-seeds.js / _diag-paused.js / _balcheck.js
scripts/_schedule-owner-withdraw.js  — schedule 50 STT pull
scripts/_claim-owner-withdraw.js     — claim после 24h
package.json                         — dev:play (без demo-bot), dev:all (с demo-bot)
```

---

## Команды

```bash
# стартовать всё (рекомендуется для теста юзером)
npm run dev:play

# полная демо-сценография (включая demo-bot — ест банкролл!)
npm run dev:all

# восстановление
npx hardhat run scripts/_full-reset.js --network somniaTestnet
npx hardhat run scripts/_refund-expired.js --network somniaTestnet

# через 24h, для редеплоя:
npx hardhat run scripts/_claim-owner-withdraw.js --network somniaTestnet
# поменять REVEAL_DELAY 3→1 в CommitReveal.sol
npx hardhat run scripts/deploy.js --network somniaTestnet
# обновить frontend/lib/config.js с новыми адресами
# top up new casino из вернувшихся 50 STT
```

---

## Сообщения юзеру (стиль)

- Раздражается на повторные баги → перед изменением **читай файл реально**, не угадывай по памяти
- Не люит "сейчас исправлю" без действия — сначала делай, потом репортируй
- Когда что-то меняешь — пиши: **что изменил**, **почему**, **что должно поменяться**, **что делать ему**
- Длинные объяснения OK когда нужны, но короче — лучше
- Не используй emoji если не попросит

🤖 Generated with [Claude Code](https://claude.com/claude-code)
