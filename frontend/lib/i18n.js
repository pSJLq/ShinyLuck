/* ============================================================================
   Site-wide language for ShinyLuck (casino shell, lobby, games) and ShinyPoker.
   ONE switch, in casino Settings · the poker table used to carry its own, which
   only ever reached the 83 strings on that one page.

   WHY A TEXT-NODE WALKER, not data-i18n on every element:
   the casino is hand-written HTML built in ~8 files with no framework, and its
   labels are also produced at runtime (wins feeds, profile drawer, game chrome).
   Tagging ~170 places by hand would miss every string added later; walking text
   nodes with a MutationObserver picks those up for free.

   WHAT IT DOES NOT TOUCH — deliberately:
     · anything not in the dictionary (so /docs and /fair prose stay English,
       which is what we want: prose split across inline tags would translate as
       fragments and read as broken Russian)
     · [data-no-i18n] subtrees · player nicknames live there. A player named
       "Bets" must not become "Ставки".
     · inputs, code/mono, <head>, script/style
   ========================================================================== */

export const LANGS = { en: "English", ru: "Русский" };
const KEY = "sl-lang";

/* ---------------------------------------------------------------- dictionary */
/* Keys are the exact English source strings. UI labels only. */
const RU = {
  // ---- shell: nav, footer, chrome ----
  "Casino": "Казино",
  "Poker": "Покер",
  "Lobby": "Лобби",
  "Profile": "Профиль",
  "Settings": "Настройки",
  "Docs": "Документация",
  "Leaderboard": "Лидеры",
  "Provably Fair": "Честная игра",
  "Provably fair": "Честная игра",
  "Contracts": "Контракты",
  "Information": "Информация",
  "ZK Lab": "ZK-лаборатория",
  "Follow": "Подписаться на",
  "on X": "в X",
  "Follow & turn on notifications": "Подписаться и включить уведомления",
  "SOON": "СКОРО",
  "NFTs": "NFT",
  "Predictions": "Прогнозы",

  // ---- wallet / profile drawer ----
  "Connect Wallet": "Подключить кошелёк",
  "connect wallet": "подключить кошелёк",
  "Disconnect wallet": "Отключить кошелёк",
  "Wallet balance": "Баланс кошелька",
  "Poker balance": "Баланс покера",
  "Unclaimed winnings": "Невостребованный выигрыш",
  "Claim": "Забрать",
  "Deposit address": "Адрес пополнения",
  "Top up": "Пополнить",
  "To wallet": "На кошелёк",
  "Withdraw": "Вывести",
  "Deposit": "Пополнить",
  "Amount": "Сумма",
  "Copy": "Копировать",
  "Close": "Закрыть",
  "Save": "Сохранить",
  "Set a nickname": "Задать ник",
  "Choose a nickname": "Выберите ник",
  "Edit nickname": "Изменить ник",
  "Upload": "Загрузить",
  "Moves between wallet and poker settle instantly on Somnia.":
    "Переводы между кошельком и покером проходят мгновенно в Somnia.",

  // ---- infofi (mindshare board) ----
  // The three view-switch labels and the legend. Account names themselves are
  // never translated: the treemap and the tables sit under data-no-i18n.
  "Everyone": "Все",
  "Projects": "Проекты",
  "Users": "Пользователи",
  "Ecosystem project": "Проект экосистемы",
  "Community voice": "Голос сообщества",

  // ---- settings modal ----
  "Audio": "Звук",
  "Sound": "Звук",
  "Sound FX": "Звуковые эффекты",
  "Sound FX volume": "Громкость звуковых эффектов",
  "Volume": "Громкость",
  "Toggle sound": "Включить или выключить звук",
  "Language": "Язык",
  "Interface language across the casino and poker.": "Язык интерфейса в казино и покере.",
  "ON": "ВКЛ",
  "OFF": "ВЫКЛ",
  "Reel spins, wins, and interaction feedback in the slots.":
    "Вращение барабанов, выигрыши и отклик интерфейса в слотах.",
  "Audio is synthesized in your browser · there is no music track, so this is the one mix that matters.":
    "Звук синтезируется прямо в браузере · музыкальной дорожки нет, так что это единственный микс, который важен.",

  // ---- lobby: feeds & tables ----
  "Latest wins": "Последние выигрыши",
  "Biggest wins": "Крупнейшие выигрыши",
  "Top players": "Лучшие игроки",
  "Latest Games Played": "Последние игры",
  "Last 24 Hours": "За 24 часа",
  "Last 7 Days": "За 7 дней",
  "Last 30 Days": "За 30 дней",
  "All Time": "За всё время",
  "GAME": "ИГРА",
  "PLAYER": "ИГРОК",
  "PAYOUT": "ВЫПЛАТА",
  "TIME": "ВРЕМЯ",
  "RANK": "МЕСТО",
  "BET": "СТАВКА",
  "BETS": "СТАВКИ",
  "WAGERED": "ПОСТАВЛЕНО",
  "Wagered": "Поставлено",
  "FAVOURITE": "ЛЮБИМАЯ",
  "HALL OF FAME": "ЗАЛ СЛАВЫ",
  "FLOOR": "ЗАЛ",
  "LIVE": "ЛАЙВ",
  "BETA": "БЕТА",
  "READY": "ГОТОВО",
  "Players": "Игроки",
  "Bets": "Ставки",
  "Bankroll": "Банкролл",
  "Players ranked": "Игроков в рейтинге",
  "Bets settled": "Ставок рассчитано",
  "The floor · ranked": "Зал · рейтинг",
  "Stay in the loop": "Оставайтесь в курсе",
  "Follow & turn on notifications": "Подписаться и включить уведомления",
  "loading on-chain wins…": "загрузка выигрышей…",

  // ---- promo slides (headings are split around a gold <span>) ----
  "ShinyPoker · Host & Earn": "SHINYPOKER · ПРОВОДИ И ЗАРАБАТЫВАЙ",
  "Host a tournament,": "Проведите турнир,",
  "earn up to 10%": "зарабатывайте до 10%",
  "Gather players into your own tournament and take a host cut of the prize pool · paid out on-chain.":
    "Соберите игроков в свой турнир и получите долю организатора от призового фонда · выплата в блокчейне.",
  "Every bet": "Каждая ставка",
  "verifiable on-chain": "проверяема в блокчейне",
  "ON-CHAIN · CASINO + POKER": "В БЛОКЧЕЙНЕ · КАЗИНО + ПОКЕР",
  "Trust is the luxury.": "Доверие - вот роскошь.",
  "Create a tournament": "Создать турнир",
  "no wins in this window yet": "в этом периоде выигрышей пока нет",
  "no wins yet · be the first": "выигрышей пока нет · будьте первым",
  "nothing here yet": "здесь пока пусто",
  "block": "блок",
  "finality": "финальность",

  // ---- games chrome ----
  "Bet amount": "Сумма ставки",
  "Place bet": "Сделать ставку",
  "Bet": "Ставка",
  "Balance": "Баланс",
  "Max bet": "Макс. ставка",
  "Max win": "Макс. выигрыш",
  "Win": "Выигрыш",
  "Draw": "Ничья",
  "Win chance": "Шанс выигрыша",
  "WIN CHANCE": "ШАНС ВЫИГРЫША",
  "House edge": "Преимущество казино",
  "Profit on win": "Прибыль при выигрыше",
  "Target": "Цель",
  "Dice target": "Цель",
  "Direction": "Направление",
  "ROLL OVER": "БОЛЬШЕ",
  "ROLL UNDER": "МЕНЬШЕ",
  "RECENT ROLLS": "ПОСЛЕДНИЕ БРОСКИ",
  "Raise stake": "Увеличить ставку",
  "Lower stake": "Уменьшить ставку",
  "How it works": "Как это работает",

  // ---- provably-fair widget labels (its prose stays English) ----
  "Client seed": "Клиентский сид",
  "Server seed (after reveal)": "Серверный сид (после раскрытия)",
  "Bet ID / Nonce": "ID ставки / Nonce",
  "Commit": "Коммит",
  "VERIFY IN BROWSER": "ПРОВЕРИТЬ В БРАУЗЕРЕ",
  "verify in browser": "проверить в браузере",
  "copy receipt": "копировать квитанцию",
};

const DICTS = { ru: RU };

/* ------------------------------------------------------------------- state */
export function lang() {
  try {
    const l = localStorage.getItem(KEY);
    return LANGS[l] ? l : "en";
  } catch (_) { return "en"; }
}

/// Translate a single string (for JS-built text).
export function t(s) {
  const d = DICTS[lang()];
  return d && d[s] != null ? d[s] : s;
}

/* --------------------------------------------------------------- the walker */
// Remember each node's ENGLISH source · without this, switching back to English
// is impossible (the key is gone the moment we overwrite it). We store what we
// WROTE alongside it, because React owns some of these nodes (the poker lobby)
// and will replace their text with something new -- "Connect Wallet" becomes the
// player's address. If we still trusted our remembered source there, we would
// paint the stale label back over live data.
const state = new WeakMap(); // textNode -> { src, out }
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "CODE", "PRE", "TITLE", "HEAD", "SVG"]);

function skipped(el) {
  for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
    if (SKIP_TAGS.has(n.tagName)) return true;
    if (n.hasAttribute && n.hasAttribute("data-no-i18n")) return true;
  }
  return false;
}

function paintTextNode(n) {
  const st = state.get(n);
  // Trust our remembered source only while the node still holds exactly what we
  // last wrote · anything else means the owner replaced the content.
  const src = st && n.nodeValue === st.out ? st.src : n.nodeValue;
  const key = (src || "").trim();
  if (!key || key.length > 120) return;
  const d = DICTS[lang()];
  const hit = d ? d[key] : null;
  if (!hit && !st) return; // never touched, nothing to translate · leave it alone
  const next = hit ? src.replace(key, hit) : src;
  if (n.nodeValue !== next) n.nodeValue = next;
  state.set(n, { src, out: next });
}

const ATTRS = ["title", "aria-label", "placeholder"];
function paintAttrs(el) {
  for (const a of ATTRS) {
    if (!el.hasAttribute || !el.hasAttribute(a)) continue;
    const store = "__sl_" + a;
    const src = el[store] != null ? el[store] : el.getAttribute(a);
    const key = (src || "").trim();
    const d = DICTS[lang()];
    const hit = d ? d[key] : null;
    if (!hit && el[store] == null) continue;
    if (el[store] == null) el[store] = src;
    el.setAttribute(a, hit || src);
  }
}

export function applyI18n(root) {
  const scope = root || document.body;
  if (!scope) return;
  if (scope.nodeType === Node.TEXT_NODE) { if (!skipped(scope.parentElement)) paintTextNode(scope); return; }
  if (scope.nodeType !== Node.ELEMENT_NODE && scope.nodeType !== Node.DOCUMENT_NODE) return;

  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue && n.nodeValue.trim() && !skipped(n.parentElement)
      ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  nodes.forEach(paintTextNode);

  const els = scope.querySelectorAll ? scope.querySelectorAll("[title],[aria-label],[placeholder]") : [];
  els.forEach((el) => { if (!skipped(el)) paintAttrs(el); });
}

/* ------------------------------------------------------- switching + wiring */
export function setLang(l) {
  const next = LANGS[l] ? l : "en";
  try { localStorage.setItem(KEY, next); } catch (_) {}
  // Tell the frames FIRST · walking this document is the slow part, and doing
  // it before the announce made the poker iframe sit on stale labels for the
  // whole walk (measured: ~1s).
  announce(next);
  applyI18n(document.body);
}

function announce(l) {
  const detail = { lang: l };
  try { document.dispatchEvent(new CustomEvent("shinyluck:lang", { detail })); } catch (_) {}
  // Games and the poker table run in iframes on this origin · reach them the
  // same way the sound pref does, so nothing needs a reload.
  try {
    document.querySelectorAll("iframe").forEach((f) => {
      try { f.contentDocument?.dispatchEvent(new CustomEvent("shinyluck:lang", { detail })); } catch (_) {}
    });
  } catch (_) {}
}

let observer = null;
export function startI18n() {
  applyI18n(document.body);
  if (observer || !window.MutationObserver) return;
  // Feeds re-render, drawers mount late, games swap panels · translate whatever
  // shows up rather than asking every author to remember to call us.
  observer = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType === Node.TEXT_NODE) { if (!skipped(n.parentElement)) paintTextNode(n); }
        else if (n.nodeType === Node.ELEMENT_NODE) applyI18n(n);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Another frame (or the shell) changed the language.
  document.addEventListener("shinyluck:lang", () => applyI18n(document.body));
  window.addEventListener("storage", (e) => { if (e.key === KEY) applyI18n(document.body); });
}

if (typeof window !== "undefined") {
  window.SLI18N = { lang, t, setLang, applyI18n, startI18n, LANGS };
  // Self-starting: every casino page is hand-written HTML with a classic
  // <script> chrome (partials.js), which cannot import a module · so the module
  // arms itself rather than waiting to be called.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => startI18n(), { once: true });
  } else {
    startI18n();
  }
}
