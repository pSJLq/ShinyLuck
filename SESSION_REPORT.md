# ShinyLuck — Финальная сессия перед Somnia Agentathon

**Дата:** 2026-05-20
**Ветка:** `loving-clarke-fab184` (worktree)
**Последний коммит:** `6ab69b2 P0: contract-exact slot replay + design restore + connect-only mount`

---

## 1. Что исправлено в этой сессии (P0)

### 1.1 Sugar — итог блокчейна теперь совпадает с анимацией
**Проблема:** "Могут выпасть кубики и показаться приз, но на самом деле его нету."
**Корень:** `decodeSugarLabResult` рисовал свою фейковую сетку, контракт же гонит keccak-цепочку (`ClusterLib.resolve`).
**Фикс:** `frontend/lib/slot-decoders.js` теперь — **точный JS-репликатор контракта**:

- `_initialGrid(randomness)` — keccak256(abi.encode(seed,"COL",col,"ROW",row)) → `_pickSymbol(chunk)` по весам из `ClusterLib.SYM_WEIGHTS`.
- `_findAndPay(grid)` — BFS flood-fill, тот же payout-table (`_clusterPayX100`) что в Solidity.
- `_tumble(grid, removed, rr)` — гравитация + досыпка через `_hashRRColRow(rr, depth, col, row)`.
- В конце сверяется с эмитнутым `finalGrid` из `BetSettled`. Если расходится — выводится `[slot-decoders] sugar replay mismatch` в консоль, но **не блокирует UI**.

Аналогично для Vault7: `VAULT_REEL_STRIPS` (5×40), `VAULT_PAYLINES` (20 линий), `_vaultPayX100` (PAYTABLE_X100), `_scatterPayX100`.

### 1.2 Vault7 — визуал восстановлен из `slots-from-design/`
**Проблема:** "В Vaul ты испортил визуал слотов, вернись к тому дизайну что я скинул."
**Фикс:** `frontend/games/vault7/api.js` и `frontend/games/sugar/api.js` полностью перезалиты из `slots-from-design/<game>/api.js`. Поверх — **минимально-инвазивные патчи**:

- `nav-bar` блок: `style="display:none"` (используется глобальный nav из `partials.js`).
- Старая jackpot-плашка скрыта (`#jackpot-ticker { display:none }`).
- `_fakeTicker` → empty-state "No spins yet — be the first."
- `_jackpotDrift()` → no-op (CPU-нагрузка убрана).
- `spin()` оптимистично запускает `this.animator.startSpinning()` сразу после клика — анимация стартует **до** того, как `placeCluster` вернёт `betId`.

### 1.3 Connect-prompt вместо demo-mode
**Проблема:** "Почему если кошелек не подключен то там написано 1000 стт и работает без блокчейна?"
**Фикс:** `frontend/games/{sugar,vault7}/index.html` переписаны:

- Слот **не монтируется** пока не пришёл `shinyluck:connected`.
- Виден полупрозрачный оверлей с надписью "Sign in to play on Somnia Testnet."
- При появлении `SL.address` оверлей скрывается, монтируется `new SugarSlot/Vault7Slot(..., { mode:'production', turbo:true })`.

### 1.4 Курсор на слот-страницах
**Проблема:** "В sugar лагает, на других страницах нормально."
**Корень:** Кастомный курсор с trailing-ring интерполируется в RAF; на слотах было ещё штук пять `setInterval` (jackpotDrift, fakeTicker, marquee), которые ели тот же кадр.
**Фикс:** В обоих slot-`index.html`:
```css
html, body { cursor: auto !important; }
.cursor-dot, .cursor-ring { display: none !important; }
```
Только для `/games/sugar` и `/games/vault7`. На остальных страницах кастомный курсор работает как раньше.

### 1.5 Максимальная скорость спина
**Что было:** 7 секунд от клика до начала падения.
**Что сделано:**
- `JsonRpcProvider.pollingInterval = 1000ms` (`frontend/lib/wallet.js`).
- `reveal-bot` `POLL_MS = 800ms` по умолчанию.
- Оптимистичный старт анимации до получения `betId` (см. 1.2) — UX-латентность ≈ 0.
- `turbo: true` пробрасывается и в конструктор, и явно через `currentSlot.animator.setTurbo(true)`.

Реальная задержка теперь: `placeBet` подпись (~200ms) + 3 блока reveal-delay (~3.6 сек на Somnia) + ~800ms polling. Это **bound by chain**, не фронтом.

### 1.6 Recovery-скрипты
Появились два новых:

- `scripts/_full-reset.js` — `npm run` после circuit-breaker tripa. Распаузит все 7 игр, опционально докинет `TOPUP_STT=N` STT в bankroll, выведет `freeBankroll`/`lockedReserve`/effective max cluster stake.
- `scripts/_drain-hm-partial.js` — выводит из HM bond ровно столько STT в deployer, чтобы deployer ≥ 8 STT. Уважает 30 STT floor (precompile minimum).

Использованы в этой сессии: HM был раздут до 32 STT, deployer высох до 0.01 STT, drain-hm-partial выдал 1.88 STT — операции возобновились.

### 1.7 Fix фоновых задач
**Что ты заметил:** "Что это за фигня запущена в бэкграунд таскс? что за unpause?!"
**Что это было:** Из прошлой сессии висели три stale background-задачи (старый dev-server, старый reveal-bot, скрипт unpause после circuit-breaker tripa). Все убиты.
**Сейчас в фоне:** **один** процесс — `npm run dev:all` (task id `bgi2w1mxj`). Внутри concurrently запускает:
- `dev:web` → http-server на :8080
- `dev:reveal-bot` → reveal-bot с auto-pick свежего seeds файла
- `dev:demo-bot` → агент-бот, делающий бет раз в N секунд для liveness-демонстрации

---

## 2. Текущее состояние

| Параметр | Значение |
|---|---|
| Casino freeBankroll | ~1.5 STT (восстанавливается по мере reveal'а pending бетов) |
| Casino lockedReserve | ~54 STT (зарезервировано под cap × pending) |
| Deployer wallet | ~1.89 STT (после partial-drain из HM) |
| HM bond | ~30 STT (на floor'е) |
| Game pauses | все 7 unpaused |
| reveal-bot | работает, poll=800ms, seeds=`somniaTestnet-1779087219577.json` |
| demo-bot | работает, первый бет через 30s |
| frontend | http://localhost:8080/ |

---

## 3. Что **тебе** нужно проверить в браузере

1. **http://localhost:8080/games/sugar** — крутни 2-3 спина и сверь финальную сетку с тем, что в Block Explorer-е (`BetSettled.finalGrid`). Должно совпадать **пиксель в пиксель**.
2. **http://localhost:8080/games/vault7** — должен выглядеть как `slots-from-design/vault7`, не как промежуточная сломанная версия.
3. На обеих slot-страницах **курсор плавный**, нет лагов.
4. До подключения кошелька оба слота показывают только prompt-карточку, **никаких 1000 STT mock-баланса**.
5. От нажатия "Spin" до начала анимации — **<300ms** (анимация запускается сразу, ждать reveal больше не надо).
6. После reveal-а: баланс обновляется, sugar-charge-meter обновляется, для Vault7 — bonus-features (если выпали) показывают сцену.

---

## 4. Известные ограничения / что НЕ сделано

- **Bankroll низкий.** 1.5 STT free → не все буй-бонусы возможны (vault7 buy-bonus требует ≈40 STT × 75 × 2000 / 100 / 100 = ~600 STT для $0.01 ставки). Фронт это ловит и показывает toast "Buy bonus needs ~X STT bankroll, casino has Y STT" — buy-bonus временно недоступен, обычные спины работают.
- **Reveal-bot НЕ автоматически пополняет bankroll.** Если вся казна уйдёт в выплаты, нужно `TOPUP_STT=20 npm run reset` руками.
- **Demo-bot** бьёт по тем же контрактам, что и ты — он расходует bankroll. Если хочешь чистый stage для записи демо — `kill bgi2w1mxj` и подними `dev:all` без demo-bot (просто `dev:web` + `dev:reveal-bot`).
- **vault7-replay** валидируется sanity-проверкой, но не блокирует UI при mismatch. Если контракт когда-нибудь поменяет PAYTABLE_X100 — будет тихо расходиться. Лечится синком констант.

---

## 5. Изменённые/созданные файлы (для ревью)

```
frontend/lib/slot-decoders.js          — переписан, contract-exact replay
frontend/games/sugar/api.js            — restore + патчи
frontend/games/sugar/index.html        — connect-prompt, no demo
frontend/games/sugar/animation.js      — startSpinning/stopSpinning
frontend/games/vault7/api.js           — restore + патчи
frontend/games/vault7/index.html       — connect-prompt, no demo
frontend/games/vault7/animation.js     — startSpinning/stopSpinning
frontend/lib/casino-limits.js          — PAYOUT_CAP-aware clamp
frontend/lib/wallet.js                 — pollingInterval=1000, embedded Privy
frontend/lib/privy-entry.jsx           — embedded wallet self-heal
frontend/partials.js                   — fixRelative threshold
scripts/_dev-reveal-bot.js             — exclude -pool.json files
scripts/_full-reset.js                 — NEW: unpause + topup
scripts/_drain-hm-partial.js           — NEW: HM bond → deployer
scripts/reveal-bot.js                  — POLL_MS=800ms default
```

---

## 6. Команды для submission video

```bash
# 1. Запустить всё
npm run dev:all

# 2. Если casino сел — пополнить и распаузить
TOPUP_STT=20 npm run reset

# 3. Если deployer высох — вытянуть из HM bond
npx hardhat run scripts/_drain-hm-partial.js --network somniaTestnet
```

---

## 7. Что ещё стоило бы сделать (НЕ блокеры submission'а)

- Перенести `slot-decoders.js` константы (`SYM_WEIGHTS`, `CLUSTER_PAY`, `VAULT_REEL_STRIPS`, `PAYTABLE_X100`) в один `frontend/lib/slot-constants.js` чтоб не дублировать.
- Авто-топап bankroll'а из HM bond когда `freeBankroll < threshold` (можно добавить в reveal-bot).
- E2E-тест: hardhat node + headless-chrome → проверка что JS replay совпадает с on-chain `finalGrid` на 100 случайных сидах.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
