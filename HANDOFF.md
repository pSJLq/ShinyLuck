# ShinyLuck — Handoff для следующего Клода

**Кому:** следующий Клод, который продолжит подготовку Somnia Agentathon submission.
**От:** Клод, работавший в worktree `loving-clarke-fab184`, сессия закончилась 2026-05-20.
**Юзер:** ukraine.ru@outlook.com — носитель русского. Раздражён несколькими подряд циклами "исправил → сломал → исправил". Считай каждое сообщение прямой инструкцией; **думай перед действием**, не угадывай.

---

## 0. Чем проект является (одной строкой)

On-chain казино на Somnia Testnet с email-логином через Privy Embedded Wallet и агент-ботами, играющими автономно по commit-reveal схеме. Семь игр (Dice / Crash / Slots / Mines / Plinko / Roulette / Cluster), фронт — статика на :8080. Хардкодного UI нет — все балансы/ставки/выплаты читаются ончейн.

Submission Somnia Agentathon. Дедлайн скоро. Хакатон-критерии: provably fair, agent-native, low-friction UX. Каждая ошибка визуала или взаимодействия — минус балл.

---

## 1. Состояние проекта (на момент handoff'а)

### 1.1 Контракты
- Сеть: **somniaTestnet** (chainId 50312, RPC `https://dream-rpc.somnia.network`)
- Адреса: `deployments/somniaTestnet.json`
  - `casino` 0x0d397E36215Fb534F0dE4E279f505dEC3F63E4B6
  - `houseManager` 0x8864e2B29D1dd1A9969d6182095776Ab0D26DC4A
  - `playerAgentRegistry`, `agentQuorumVerifier` — есть, не трогать.
- Deployer: 0x3fFa302E620492C8Fb43426a0e54E537C0d937A6 (приватник в .env)
- **Бюджет STT почти выбит.** Backup-кошелёк юзера был ~500 STT, сейчас на всём проекте ~87 STT.

### 1.2 Текущий бюджет (свежий `_balcheck.js`)
```
deployer               1.76 STT
casino                 55.95 STT (из них locked=54.44, pendingWithdraw=0.44, free=1.07)
houseManager           30.0  STT (precompile floor — нельзя ниже)
TOTAL                  87.7  STT
```
**Free bankroll 1.07 STT** — игроку доступны только микро-ставки. Это потому что куча пендинг-бетов от demo-bot'а не зарезолвилась.

### 1.3 Что юзер увидит сейчас, если откроет браузер
- Главная: http://localhost:8080/ — все игры, email-логин через Privy.
- Dice / Crash / Mines / Plinko / Roulette — должны работать.
- **Sugar / Vault7** — после моего последнего фикса (commit `21911fc`) должны нормально маунтиться при подключённом кошельке.
- Все игры **unpaused** (я только что запустил `_full-reset.js`).

### 1.4 Что НЕ работает / временно ограничено
- **Buy-bonus в обоих слотах** — требует ~600 STT свободного банкролла; сейчас 1 STT. Фронт ловит, кидает toast "Buy bonus needs ~X STT bankroll, casino has Y STT".
- **Ставки >~0.0004 STT в Cluster** — clamped из-за `freeBankroll / 2500`. Восстановится когда reveal-bot закроет 54 STT pending.

---

## 2. Что было сделано в этой сессии (по коммитам, новейшие сверху)

```
21911fc  fix(slots): restore data-sound button + absolute paths + clean URLs
0d15daf  fix(slots): poll for SL.address so cross-page navigation auto-mounts
6ab69b2  P0: contract-exact slot replay + design restore + connect-only mount
6c00bdd  fix(slots+chrome): unpause + gate-removal + contract-exact grid + speed-up
a062c03  feat: favicon (user dropped Luck.ico in frontend/)
78a36df  feat: unified header/footer + optimistic spin + faster poll
42fce8e  fix(slots): payout-cap clamp + smaller stake presets + buy-bonus bankroll check
ce567a6  fix(privy): self-heal embedded wallet creation + wait for address
b896959  fix(privy): embedded wallet for zero-popup UX + modal close + logo 404
5cf233d  hotfix: Privy flat-array loginMethods + lobby crash-preview NaN
```

Узловые решения:

### 2.1 Privy: cross-app → embedded wallet
**Было:** cross-app login на Somnia Provider App ID `cm8d9yzp2013kkr612h8ymoq8`. На каждую транзакцию popup "Approve transaction" на `privy.somnia.network` — не подавляется с нашей стороны.
**Стало:** embedded wallet (`createOnLogin: 'users-without-wallets'`) + `embeddedWallets.showWalletUIs: false` per-call. **Ноль popup'ов**. Trade-off: адрес app-scoped, не Global Wallet (для хакатона ОК).
**Privy App ID:** `cmp9pb26g01py0cjlks1njki1` (наше) — в `frontend/lib/config.js`.
**Файлы:** `frontend/lib/privy-entry.jsx`, `frontend/lib/wallet.js`, `frontend/lib/privy-signer.js`.

### 2.2 Слоты: contract-exact JS replay
**Корневая проблема:** локальный decoder рисовал свой random grid, контракт же гонит детерминированную keccak-цепочку (`ClusterLib.resolve()`, `Vault7Lib.resolve()`). Юзер видел приз на сетке, который в реальности не выпал.
**Решение:** `frontend/lib/slot-decoders.js` — полная JS-реплика обоих контрактов. Ключевое:
- `_pickSymbol(chunk)` — те же `SYM_WEIGHTS` что в ClusterLib.
- `_hashRR / _hashRRDepth / _hashRRColRow` — `keccak256(abi.encode(...))` совпадает с Solidity-вычислением.
- `_initialGrid(randomness)` → `_findAndPay(g)` BFS → `_tumble(g, removed, rr)` — full cycle.
- В конце sanity-check против эмитнутого `BetSettled.finalGrid`. Если расходится — `console.warn` (не блокирует UI).

**Для Vault7:** `VAULT_REEL_STRIPS` (5×40), `VAULT_PAYLINES` (20 линий), `_vaultPayX100` (PAYTABLE_X100), `_scatterPayX100`. Те же константы что в `Vault7Lib.sol`.

⚠ **Если контракт когда-то обновишь — синхронизируй `slot-decoders.js`!**

### 2.3 Слот-страницы: connect-prompt вместо demo
**Было:** Без кошелька слот показывал mock-баланс 1000 STT и работал офлайн.
**Стало:** `index.html` показывает оверлей "Sign in to play" пока не выстрелит `shinyluck:connected`. Маунт строго в production-режиме.

### 2.4 Слот-страницы: robust mount-trigger
**Корень:** `shinyluck:connected` мог пролетать ДО регистрации обработчика на новой странице (при page-to-page navigation). `setTimeout(1500)` fallback был слишком коротким + глотал ошибки.
**Решение:** poll каждые 250ms на 30s, плюс listener'ы на `shinyluck:connected` И `shinyluck:auth-state`, плюс `tryMount()` сразу при загрузке. Prompt скрывается СРАЗУ когда маунт стартует, возвращается на фейле.

### 2.5 Курсор-лаг на sugar
**Было:** Кастомный курсор с trailing ring + куча setInterval'ов в слоте (`_fakeTicker`, `_jackpotDrift`) → курсор лагает.
**Стало:** На `/games/sugar/` и `/games/vault7/`:
```css
html, body { cursor: auto !important; }
.cursor-dot, .cursor-ring { display: none !important; }
```
Только на слот-страницах. На остальных кастомный курсор как был.

### 2.6 Recovery-инструменты
- `scripts/_full-reset.js` — распаузит все 7 игр, опционально `TOPUP_STT=N` пополнит банкролл.
- `scripts/_drain-hm-partial.js` — выкачает STT из HM bond в deployer, если последний высох (уважает 30 STT floor).
- `scripts/_balcheck.js` — балансы всех адресов + casino lockedReserve / freeBankroll / pendingWithdraw.
- `scripts/_dev-reveal-bot.js` — выбирает свежий seeds-файл для reveal-bot'а (исключая `-pool.json`).

### 2.7 Слот-визуал: restore из `slots-from-design/`
Юзер дал готовый дизайн в `slots-from-design/{sugar,vault7}/`. Я в какой-то момент его сломал, потом restored. **НЕ ПЕРЕПИСЫВАЙ `api.js`** — там 600+ строк отрендеренного HTML/CSS, любая правка в `_render()` рискует выбить элемент, который ждёт `_wireControls()` (как было с `data-sound`). Если надо что-то спрятать — `style="display:none"` на родителе, не удаление элемента.

---

## 3. Архитектура (что где лежит)

### 3.1 Бекенд (Solidity + scripts)
- `contracts/Casino.sol` — основной контракт, 7 игр, commit-reveal, circuit-breaker (auto-pause при >20% bankroll loss/hour).
- `contracts/HouseManager.sol` — bond pool, выводы.
- `contracts/games/*.sol` — игровая логика.
  - `ClusterLib.sol` — sugar lab (7×7 cluster cascade)
  - `Vault7Lib.sol` — vault7 (5×3 / 20 lines)
- `scripts/deploy.js`, `scripts/topup-seeds.js` — деплой и seeds.
- `scripts/reveal-bot.js` — крутится, ловит `BetPlaced`, через 3 блока вызывает `settleBet` с pre-committed seed. `POLL_MS=800ms`.
- `scripts/demo-bot.js` — агент-бот, делает бет раз в N секунд. **ОН ЕСТ БАНКРОЛЛ.** Если STT критично — выключи.

### 3.2 Фронт (vanilla JS + Privy React bundle)
- `frontend/SomniaLuck.html` — главная (хаб с играми).
- `frontend/games/{dice,crash,mines,plinko,roulette}.html` — простые игры.
- `frontend/games/sugar/` и `frontend/games/vault7/` — слот-папки (index.html + api.js + animation.js + engine.js + styles.css + sound.js).
- `frontend/lib/` — SDK слой:
  - `shinyluck-sdk.js` — основной SDK (place*, waitForSettle, balance reads)
  - `wallet.js` — обёртка над Privy + автоконнект + connect modal
  - `privy-entry.jsx` → собирается esbuild'ом в `frontend/vendor/privy.bundle.js`
  - `privy-signer.js` — ethers Signer-обёртка над `window.ShinyLuckAuth.sendTransaction`
  - `slot-decoders.js` — **contract-exact replay** (см. 2.2)
  - `casino-limits.js` — `clampStake()` по payout-cap (200%/250%/100%)
  - `config.js` — addresses + privyAppId
- `frontend/partials.js` — инжектит общий nav/footer (через `data-mount="nav"` / `data-mount="footer"`). `fixRelative()` ремонтирует пути в шапке/футере в зависимости от глубины страницы.
- `frontend/styles.css` — глобальные стили.

### 3.3 dev:all (как запускать всё)
```bash
npm run dev:all
```
Стартует через `concurrently`:
- `dev:web` → http-server на :8080
- `dev:reveal-bot` → reveal-bot с автоподбором свежего seeds-файла
- `dev:demo-bot` → demo-bot, бет каждые 30+s

Сейчас в фоне крутится один такой процесс (id `bgi2w1mxj` — был жив на момент handoff'а; **проверь жив ли он перед стартом нового**, иначе будет conflict на порту 8080).

---

## 4. Что юзер просил и что ещё стоит сделать

### 4.1 Сделано (он подтвердил частично, частично нет)
- ✅ Privy email login без popup'ов
- ✅ Unified nav/footer на всех страницах включая слоты
- ✅ Contract-exact слот results
- ✅ Connect-prompt (нет фейкового баланса 1000 STT)
- ✅ Чистый URL без `/index.html`
- ✅ Курсор не лагает на слотах
- ✅ Recovery-tooling
- ✅ STT-audit script

### 4.2 НЕ сделано / открытое
- ⚠ **Verify в браузере что цикл `connect → spin → settle → balance update` работает full e2e.** Юзер последний раз видел crash при mount, я починил, но он ещё не подтвердил.
- ⚠ **Casino bankroll низкий** — 1.07 STT free. Нужно либо: (a) дождаться пока reveal-bot закроет 54 STT pending; (b) `TOPUP_STT=20 npm run reset` (но deployer всего 1.76 STT — не хватит); (c) `_drain-hm-partial.js` чтобы вытянуть из HM. HM сейчас на floor (30 STT), снять нельзя.
- ⚠ **demo-bot ест банкролл.** Если юзер хочет чистый сценарий для демо-видео — `kill` процесса dev:all и поднять только `dev:web` + `dev:reveal-bot`.
- ⚠ **Vault7 sanity-check в replay не блокирует UI** — если расхождение, юзер видит правильный финал-grid (из контракта), но replay-консоль выдаёт warning. Можно сделать строгий fail. Я этого не делал — не хотел блокировать в случае случайного несинка констант.

### 4.3 Что нужно для submission'а (если ещё не сделано)
- Скриншоты / видео всех 7 игр в работе
- README с инструкцией запуска (`npm run dev:all`)
- Wallet provisioning: убедись, что Privy embedded wallet работает с фрешим email
- Math доказательства (есть `STATS.md` — синк с контрактом)

---

## 5. Грабли и неочевидные вещи

1. **STT supply конечен** — юзер несколько раз подчёркивал. Не делай редеплои без `_balcheck.js` и не сжигай газ просто так.
2. **HouseManager precompile** требует ≥30 STT. Если выкачаешь больше — операция упадёт. `_drain-hm-partial.js` это уважает.
3. **Circuit-breaker** срабатывает при потере >20% bankroll за час. Авто-паузит игру. `_full-reset.js` распаузит. Если бан-ролл падает быстро (от demo-bot'а), будешь часто это видеть.
4. **REVEAL_DELAY=3 блока** ≈ 3.6 секунды на Somnia (block time ~1.2s). Это minimum chain-bound latency для любого спина. Меньше — нельзя.
5. **demo-bot** делает бесплатные spin'ы за счёт casino bankroll. Каждый bet локает `stake × cap` в reserve. С низким банкроллом demo-bot быстро всё съест.
6. **slots-from-design/** — это immutable reference. `frontend/games/{sugar,vault7}/` строилось из него с минимальными патчами. Если правишь api.js — сверяй с slots-from-design.
7. **Privy bundle** (`frontend/vendor/privy.bundle.js`) собирается из `privy-entry.jsx` через esbuild. Команда: `npm run build:privy` (если есть в package.json) или вручную. Если правишь jsx — пересобери.
8. **Embedded wallet адрес** не совпадает с Somnia Global Wallet. Это известный trade-off. Возврат на cross-app — описан в комментариях `privy-entry.jsx` (требует Somnia allowlist).
9. **REVEAL bot выбирает seeds-файл по mtime.** Если у тебя несколько deploy'ев, новые seeds должны быть самыми свежими. Пул-файл `*-pool.json` исключается (см. `_dev-reveal-bot.js`).
10. **На Windows-системе юзера** пути с кириллицей: `D:\Рабочий стол\ShinyLuck`. Используй кавычки в bash или прямые форвард-слеши.

---

## 6. Краткая инструкция для следующего шага

```bash
# 0. Убедись что dev:all не запущен дважды
# (или прибей старый: tasklist | findstr node, taskkill /PID ... /F)

# 1. Стартуй всё
cd "D:/Рабочий стол/ShinyLuck"
npm run dev:all

# 2. Открой http://localhost:8080/ → подключи кошелёк → пройдись по играм
#    Особое внимание: sugar и vault7 (последняя зона проблем)

# 3. Если что-то заклинит:
npx hardhat run scripts/_balcheck.js --network somniaTestnet   # state snapshot
npx hardhat run scripts/_full-reset.js --network somniaTestnet # unpause all

# 4. Если deployer иссяк:
npx hardhat run scripts/_drain-hm-partial.js --network somniaTestnet
```

---

## 7. Стиль общения с юзером

- Он раздражён несколькими подряд циклами "сломал → починил → опять сломал". **Не делай косметических правок** — каждое изменение должно быть оправдано.
- Сначала **читай реальный код** — он несколько раз ловил меня на угадывании.
- Если что-то требует ончейн-op'а — посчитай газ заранее. Юзер чётко считает каждый STT.
- Когда отвечаешь по-русски — пиши коротко и по делу, без литературщины. Когда финальный отчёт — пиши развернуто.
- Длинные плашки "ща исправлю!" без действия его бесят. Сначала действие, потом репортаж.

---

## 8. Файлы которые ОБЯЗАТЕЛЬНО прочитай в начале

1. `SESSION_REPORT.md` (соседний с этим файл) — мой более узкий отчёт по последней сессии
2. `STATS.md` — математика всех игр (RTP, edge, payouts)
3. `deployments/somniaTestnet.json` — адреса
4. `frontend/lib/slot-decoders.js` — contract-exact replay (хрупкая часть)
5. `frontend/lib/wallet.js` — Privy auto-connect (другая хрупкая часть)
6. `contracts/Casino.sol` — кастомные ошибки + circuit-breaker

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
