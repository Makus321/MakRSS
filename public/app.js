/* Читалка: слева дерево подписок, справа список статей.
   Статья раскрывается прямо в списке; если текста нет — он докачивается по клику. */

const $ = (sel) => document.querySelector(sel);

/** id статьи в CSS-селекторе: экранируем, иначе спецсимволы ломают querySelector. */
function cssId(value) {
  const raw = String(value ?? '');
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(raw) : raw.replace(/"/g, '\"');
}
/**
 * Ручные решения пользователя по отметкам. Объявлены в самом начале: их читают
 * функции, которые вызываются при старте, — раньше объявления ниже приводили
 * к ошибке «Cannot access before initialization» и скрипт не запускался.
 */
const manualRead = new Map();
/** Прочитанные нами статьи остаются в списке до смены ленты: иначе они исчезают сразу после отметки. */
const keepReadVisible = new Set();
/** Копии прочитанных статей: если сервер пришлёт данные без них, всё равно покажем. */
const keepReadItems = new Map();

// в ленте, список не пересобираем — держим их у себя до клика в дереве или «Показать».
const heldItems = new Map();
/** Фавиконы, которые сервер не отдал: повторно не запрашиваем. */
const faviconFailed = new Set();
window.__faviconFailed = (feedId) => { faviconFailed.add(feedId); };        // id → прочитано/непрочитано (приоритет над автоматикой)
const pendingUnstar = new Set();     // снятые в «Избранном», но показываемые до смены раздела

/**
 * Окно подтверждения вместо window.confirm: в установленном приложении на
 * телефоне системный confirm может не показываться, и действие выполнялось
 * без вопроса.
 */
function askConfirm(title, text) {
  return new Promise((resolve) => {
    const modal = $('#confirm-modal');
    if (!modal) { resolve(window.confirm(text)); return; }
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    modal.hidden = false;
    const done = (answer) => {
      modal.hidden = true;
      $('#confirm-yes').removeEventListener('click', yes);
      $('#confirm-no').removeEventListener('click', no);
      modal.removeEventListener('click', backdrop);
      resolve(answer);
    };
    const yes = () => done(true);
    const no = () => done(false);
    const backdrop = (event) => { if (event.target === modal) done(false); };
    $('#confirm-yes').addEventListener('click', yes);
    $('#confirm-no').addEventListener('click', no);
    modal.addEventListener('click', backdrop);
  });
}

/**
 * Окно ввода вместо window.prompt: в установленном приложении на телефоне
 * системный prompt может не показываться, и действие выполнялось с пустым
 * значением. Возвращает null, если пользователь отказался.
 */
function askPrompt(title, text, initial = '') {
  return new Promise((resolve) => {
    const modal = $('#prompt-modal');
    if (!modal) { resolve(window.prompt(text, initial)); return; }
    const input = $('#prompt-input');
    $('#prompt-title').textContent = title;
    $('#prompt-text').textContent = text;
    input.value = initial;
    modal.hidden = false;
    const done = (answer) => {
      modal.hidden = true;
      $('#prompt-ok').removeEventListener('click', ok);
      $('#prompt-cancel').removeEventListener('click', cancel);
      input.removeEventListener('keydown', keys);
      modal.removeEventListener('click', backdrop);
      if (answer !== null) input.value = '';
      resolve(answer);
    };
    const ok = () => done(input.value);
    const cancel = () => done(null);
    const backdrop = (event) => { if (event.target === modal) done(null); };
    // Enter подтверждает, Esc отменяет — так же, как системный prompt.
    const keys = (event) => {
      if (event.key === 'Enter') { event.preventDefault(); ok(); }
      else if (event.key === 'Escape') { event.preventDefault(); cancel(); }
    };
    $('#prompt-ok').addEventListener('click', ok);
    $('#prompt-cancel').addEventListener('click', cancel);
    input.addEventListener('keydown', keys);
    modal.addEventListener('click', backdrop);
    // Выделяем текст: чаще всего нужно заменить, а не дописать.
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

const PREF_KEY = 'rss.prefs';
// Раз в час читалка в фоне просит сервер докачать полные тексты и прогревает
// кэш статей — чтобы при плохой связи они открывались из памяти.
const WIDTH_KEY = 'rss.widths';
const COLLAPSE_KEY = 'rss.collapsed';

const state = {
  data: { feeds: [], folders: [], items: [], counts: { all: 0, unread: 0, starred: 0 }, fetching: {} },
  settings: { authEnabled: false, envAuth: false, user: '', fever: null, fetchFull: true, defaultView: 'compact-thumb', defaultLines: 4, defaultWidth: 100, telegram: {} },
  session: { authRequired: false, authenticated: true },
  view: { type: 'unread', id: null },   // unread | starred | feed | folder (all — только как запасной)
  snapshot: null,                       // состав списка, зафиксированный при входе в ленту
    lightboxShare: null,                  // картинка в просмотре: адрес и подпись для «Поделиться»
  activeId: null,                       // статья, на которой сейчас рамка
  framedIds: new Set(),                 // статьи, на которых рамка уже побывала в этом разделе
  query: '',
  unreadOnly: false,
  sort: 'date',
  prefs: {
    // Значения по умолчанию для нового клиента: тёмная тема, «Кратко», 4 строки,
    // дата по убыванию, только непрочитанные, отметка при прокрутке.
    theme: 'dark', paletteDark: 'graphite', paletteLight: 'day', background: 'palette', density: 'compact', thumbs: true,
    fontTree: '13px', fontArticle: '14.5px', fontExcerpt: '14.5px', fontFamily: 'system', lineHeight: 'normal',
    borders: true,
  tint: 'interface',                      // 'interface' — акцент на фоне ленты, 'articles' — на панели и карточках
    uiScale: 1,                            // размер системных надписей и диалогов
    imageWrap: false,                      // узкие картинки в статье обтекаются текстом
    readOnExpand: true, readOnScroll: true, readOnFinish: false,
    swipeNext: true,                      // свайп влево: переход к следующей статье (можно выключить)
    treeFilter: 'all',
    unreadOnly: true,
    width: 0,                             // ширина текста: своя на каждом устройстве (0 — ещё не задана)
  },
  collapsed: new Set(),                 // свёрнутые папки
  collapsedItems: new Set(),            // статьи, свёрнутые вручную
  expandedItems: new Set(),             // статьи, раскрытые вручную
  commentsOnly: new Set(),              // раскрыты только комментарии, без текста статьи
  bodies: new Map(),                    // id -> { content, fullHtml, note }
  bodyTries: new Map(),   // сколько раз просили текст статьи (пустой ответ не окончателен)
  comments: new Map(),                  // id -> { loading, ok, total, count, threads, error }
  selectedId: null,
  limit: 10,                     // сначала показываем 10 карточек, остальное — по прокрутке
  resetScroll: false,                   // сбросить прокрутку при следующей отрисовке
  drag: null,
  loadingBodies: false,
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** Компактное число для меток: 40447 -> «40 тыс.», 1200 -> «1,2 тыс.», 2500000 -> «2,5 млн». */
const shortNumber = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '';
  const round = (x) => (Math.round(x * 10) / 10).toString().replace('.', ',');
  if (n < 1000) return String(Math.round(n));
  if (n < 1000000) return `${n >= 100000 ? Math.round(n / 1000) : round(n / 1000)} тыс.`;
  return `${round(n / 1000000)} млн`;
};

const plural = (n, one, few, many) => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
};

/** Сетевые сбои не показываем всплывашкой: при плохой связи их десятки. */
function isNetworkError(message) {
  return /failed to fetch|networkerror|load failed|fetch failed|aborted|timeout|нет сети и кэша|err_/i.test(String(message ?? ''));
}

function toast(message, isError = false, place = 'bottom') {
  if (isError && isNetworkError(message)) return;
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast${isError ? ' err' : ''}${place === 'top' ? ' top' : ''}`;
  el.hidden = false;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 2500);
}

// --------------------------------------------------------------------- темы

function applyTheme() {
  const wanted = state.prefs.theme;
  const system = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = wanted === 'auto' ? system : wanted;
  applyPalette();
}

/** Цветовая гамма выбирается отдельно для тёмной и светлой темы. */
function applyPalette() {
  const dark = document.documentElement.dataset.theme !== 'light';
  document.documentElement.dataset.palette = dark
    ? (state.prefs.paletteDark || 'graphite')
    : (state.prefs.paletteLight || 'day');
  // Фон: «theme» — чистый белый или чёрный, «palette» — цвет выбранной гаммы.
  document.documentElement.dataset.bg = state.prefs.background === 'theme' ? 'theme' : 'palette';
}

/** Явный выбор темы: светлая, тёмная или «как в системе». */
function setThemeChoice(choice) {
  state.prefs.theme = choice === 'auto' ? 'auto' : choice;
  savePrefs();
  applyTheme();
}

function cycleTheme() {
  const order = ['dark', 'light', 'auto'];
  state.prefs.theme = order[(order.indexOf(state.prefs.theme) + 1) % order.length];
  savePrefs();
  applyTheme();
  if ($('#set-theme')) $('#set-theme').value = state.prefs.theme;
  toast(`Тема: ${{ dark: 'тёмная', light: 'светлая', auto: 'как в системе' }[state.prefs.theme]}`, false, 'top');
}

function loadPrefs() {
  try { Object.assign(state.prefs, JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}')); } catch { /* по умолчанию */ }
  try { state.collapsed = new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]')); } catch { state.collapsed = new Set(); }
  // После кнопки «Обновить приложение» возвращаем сохранённые настройки вида:
  // браузер мог почистить хранилище вместе с кэшами.
  try {
    const kept = JSON.parse(sessionStorage.getItem('rss.prefs.keep') ?? '{}');
    for (const [key, value] of Object.entries(kept)) {
      if (value && localStorage.getItem(key) === null) localStorage.setItem(key, value);
    }
    if (kept['rss.prefs' ]) {
      const own = JSON.parse(localStorage.getItem('rss.prefs') ?? '{}');
      Object.assign(state.prefs, JSON.parse(kept['rss.prefs']), own);
      localStorage.setItem('rss.prefs', JSON.stringify(state.prefs));
    }
    sessionStorage.removeItem('rss.prefs.keep');
  } catch { /* не критично */ }
  // Размеры шрифта храним в виде «13px»: старые настройки держали число.
  state.prefs.fontTree = fontPx(state.prefs.fontTree, '13px');
  state.prefs.fontArticle = fontPx(state.prefs.fontArticle, '14.5px');
  state.prefs.fontExcerpt = fontPx(state.prefs.fontExcerpt, '14.5px');
  // Раньше у краткого вида была своя сетка размеров (11.5/12.5/16/19.5). Если в
  // настройках сохранено такое значение, оно и рисовалось — при том что в списке
  // показывался ближайший новый пункт. Переводим старые значения в новые.
  const excerptMigration = { '11.5px': '13px', '12.5px': '14.5px', '16px': '18px', '19.5px': '22px' };
  if (excerptMigration[state.prefs.fontExcerpt]) {
    state.prefs.fontExcerpt = excerptMigration[state.prefs.fontExcerpt];
  }
  const articleMigration = { '11.5px': '13px', '12.5px': '14.5px', '16px': '18px', '19.5px': '22px' };
  if (articleMigration[state.prefs.fontArticle]) {
    state.prefs.fontArticle = articleMigration[state.prefs.fontArticle];
  }
  // Один раз переводим старые галочки в новый выбор «по клику / при прокрутке»:
  // раньше по умолчанию была включена только «при раскрытии», и отметка при
  // прокрутке не работала вовсе.
  if (!state.prefs.readModeSet) {
    state.prefs.readOnExpand = true;
    state.prefs.readOnScroll = true;
    state.prefs.readModeSet = true;
  }
  // Фильтр «только непрочитанные» переживает перезагрузку страницы.
  state.unreadOnly = Boolean(state.prefs.unreadOnly);
  applyTheme();
  applyVisualPrefs();
  watchMobileFonts();
}

/** Размер шрифта в виде «13px»: принимает и число, и строку, и «13 px». */
function fontPx(value, fallback) {
  const num = parseFloat(String(value ?? '').replace(',', '.').replace(/[^0-9.]/g, ''));
  return Number.isFinite(num) && num > 0 ? `${num}px` : fallback;
}

/** Выбирает в списке ближайший размер шрифта — вместо добавления пункта «13px». */
function setFontSelect(select, value) {
  const target = parseFloat(fontPx(value, '0'));
  let best = null;
  let bestDelta = Infinity;
  for (const option of select.options) {
    const size = parseFloat(option.value);
    const delta = Number.isFinite(size) ? Math.abs(size - target) : Infinity;
    if (delta < bestDelta) { bestDelta = delta; best = option; }
  }
  if (best) select.value = best.value;
}

/** Шрифты и плотность — переменными CSS, чтобы применялись мгновенно. */
/** Допустимые наборы шрифта интерфейса (должны совпадать с CSS). */
const FONT_VARIANTS = new Set(['system', 'condensed', 'book', 'mono', 'cursive', 'tight', 'airy', 'comfortable', 'charter', 'thin', 'soft', 'display']);
const fontVariant = (value) => (FONT_VARIANTS.has(value) ? value : 'system');

/** Сенсорный экран (телефон, планшет, раскладной) или узкое окно. */
function isTouchDevice() {
  return window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(max-width: 560px)').matches;
}

// Выбор размера шрифта на телефоне применяется на ступень крупнее.

function applyVisualPrefs() {
  const root = document.documentElement;
  // Семейство шрифта — атрибутом на :root, остальные значения берутся из CSS.
  document.documentElement.dataset.font = fontVariant(state.prefs.fontFamily);
  document.documentElement.dataset.line = state.prefs.lineHeight || 'normal';
  // На телефоне тот же выбор означает шрифт на ступень крупнее: на узком экране
  // обычные размеры читаются заметно мельче, чем на мониторе.
  // «Телефон» — это сенсорный экран, а не узкое окно: у раскладных телефонов
  // в разложенном виде ширина большая, но шрифты должны остаться крупными.
  const mobile = isTouchDevice();
  // На сенсорном экране те же ступени читаются мельче, поэтому прибавляем шаг
  // к выбранному значению (пользователь видит в списке реальные пиксели).
  const bigger = (value, fallback, extra = 3.5) => {
    const size = parseFloat(fontPx(value, fallback)) || 14.5;
    if (!mobile) return `${size}px`;
    return `${Math.round((size + extra) * 10) / 10}px`;
  };
  // Остальной интерфейс подстраивается под размер шрифта дерева (13px — обычный).
  const treeSize = parseFloat(bigger(state.prefs.fontTree, '13px', 1.5)) || 13;
  // Интерфейс (кнопки, подписи, окна) растёт умеренно: иначе на телефоне поля
  // и подписи выглядят разного размера. Крупный текст статьи задаётся отдельно.
  // Масштаб интерфейса — отдельная настройка, а не производная от размера дерева.
  // Системные надписи на ступеньку крупнее прежнего: коэффициент 1.08 применяем
  // ко всем вариантам выбора, чтобы привычные ступени сохранились.
  const uiScale = Math.max(0.85, Math.min(1.6, (Number(state.prefs.uiScale) || 1) * 1.08));
  document.documentElement.style.setProperty('--ui-scale', String(uiScale));
  root.style.setProperty('--font-tree', bigger(state.prefs.fontTree, '13px', 1.5));
  root.style.setProperty('--font-article', bigger(state.prefs.fontArticle, '14.5px'));
  root.style.setProperty('--font-excerpt', bigger(state.prefs.fontExcerpt, '14.5px'));
  $('#list').classList.toggle('comfortable', state.prefs.density === 'comfortable');
  // «Невидимые рамки» — минималистичный вид: у карточек и панелей рамок нет,
  // остаётся только подсветка активной статьи.
  document.body.classList.toggle('no-borders', state.prefs.borders === false);
  // Куда идёт акцент темы: на фон ленты или на панель и карточки.
  document.documentElement.dataset.tint = state.prefs.tint === 'articles' ? 'articles' : 'interface';
}

// Поворот телефона или изменение ширины окна меняет ступень — пересчитываем.
let mobileQuery = null;
function watchMobileFonts() {
  mobileQuery = window.matchMedia('(pointer: coarse), (max-width: 560px)');
  const onChange = () => applyVisualPrefs();
  if (mobileQuery.addEventListener) mobileQuery.addEventListener('change', onChange);
  else if (mobileQuery.addListener) mobileQuery.addListener(onChange);
}

const saveCollapsed = () => localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...state.collapsed]));
const savePrefs = () => localStorage.setItem(PREF_KEY, JSON.stringify(state.prefs));

// Полный сброс клиента по ссылке вида /?reset=1: чистит кэши, локальные данные
// и перезагружает приложение. Нужен, когда в ленте остаются «мёртвые» карточки.
const resetRequested = new URLSearchParams(location.search).get('reset') === '1';
if (resetRequested) {
  (async () => {
    try {
      for (const name of await caches.keys()) await caches.delete(name);
      for (const key of Object.keys(localStorage)) if (key.startsWith('rss.')) localStorage.removeItem(key);
      sessionStorage.clear();
      const registrations = await navigator.serviceWorker?.getRegistrations?.() ?? [];
      for (const registration of registrations) await registration.unregister();
    } catch { /* не критично */ }
    location.replace(location.pathname);
  })();
}


// ---------------------------------------------------------------------- API

async function api(path, body, options = {}) {
  const init = body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
  if (options.signal) init.signal = options.signal;
  const res = await fetch(path, init);
  // Объём ответа считаем по длине тела: нужен для подвала, когда открывают ленту.
  const responseBytes = Number(res.headers.get('content-length')) || 0;
  const payload = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (res.status === 401 && payload.authRequired) {
    state.session.authenticated = false;
    showLogin();
  }
  if (!res.ok && payload.ok !== false) throw new Error(payload.error || `HTTP ${res.status}`);
  if (path.startsWith('/api/items') && res.ok) {
    state.listBytes = responseBytes || new TextEncoder().encode(JSON.stringify(payload)).length;
    updateFooterStats();
  }
  return payload;
}

/** Принять новое состояние и запомнить его ревизию (для дешёвых опросов). */
/** Годится ли ответ в состояние: в нём обязательно должен быть массив статей. */
const looksLikeData = (data) => Boolean(data) && Array.isArray(data.items) && Array.isArray(data.feeds);

/**
 * Настройки внешнего вида применяются сразу, а на сервер уходят в очереди:
 * при плохой связи интерфейс не ждёт ответа, но изменения не теряются.
 */
const pendingSettings = { patch: {}, timer: null, busy: false };

/**
 * Настройка ленты: сразу меняем объект ленты у себя и отправляем на сервер.
 * Сервер отвечает только ревизией (без данных), поэтому без локального
 * применения настройка вступала в силу лишь на следующем полном опросе.
 */
async function applyFeedSetting(patch) {
  const feed = viewFeed();
  if (!feed) return;
  Object.assign(feed, patch);
  try {
    const answer = await api('/api/feeds/view', { id: feed.id, ...patch });
    if (Number.isFinite(answer?.revision)) state.revision = answer.revision;
  } catch (err) {
    toast(err.message, true);
  }
}

function pushSettings(patch) {
  Object.assign(pendingSettings.patch, patch);
  clearTimeout(pendingSettings.timer);
  pendingSettings.timer = setTimeout(flushSettings, 400);
}

async function flushSettings() {
  if (pendingSettings.busy) return;
  const patch = pendingSettings.patch;
  if (!Object.keys(patch).length) return;
  if (!navigator.onLine) { pendingSettings.timer = setTimeout(flushSettings, 5000); return; }
  pendingSettings.patch = {};
  pendingSettings.busy = true;
  try {
    for (const [key, value] of Object.entries(patch)) {
      await api('/api/settings', { [key]: value });
    }
  } catch {
    // не получилось — вернём в очередь и попробуем позже
    Object.assign(pendingSettings.patch, patch);
    pendingSettings.timer = setTimeout(flushSettings, 8000);
  } finally {
    pendingSettings.busy = false;
  }
}

window.addEventListener('online', () => flushSettings());

const rememberData = (data) => {
  if (!looksLikeData(data)) return false;         // ответ без данных (нет сети, кэш) — не трогаем состояние

  if (data.serverVersion) state.serverVersion = data.serverVersion;
  if (data.serverBuild) state.serverBuild = data.serverBuild;
  // Отметки о прочтении, сделанные без сети, важнее того, что пришло с сервера.
  // Пока открыта витрина, серверная ротация не должна менять список на экране:
  // ушедшие статьи запоминаем и показываем дальше, новые придут по «Показать».
  const virtualView = virtualFeedView();
  if (virtualView && Array.isArray(data.items)) {
    const freshIds = new Set(data.items.filter((item) => item.feedId === state.view.id).map((item) => item.id));
    for (const item of state.data.items ?? []) {
      if (item.feedId !== state.view.id || freshIds.has(item.id)) continue;
      heldItems.set(item.id, item);
    }
    for (const id of [...heldItems.keys()]) if (freshIds.has(id)) heldItems.delete(id);
  }
  applyPendingReads(data.items);
  state.data = data;
  state.revision = data?.revision ?? state.revision;
  // Версия состава статей: по ней отличаем «изменились только отметки» от
  // «появились новые статьи» — во втором случае нужен полный список.
  if (Number.isFinite(data?.itemsRevision)) state.itemsRevision = data.itemsRevision;
  return true;
};

const applyPayload = (payload) => { if (payload?.data && rememberData(payload.data)) render(); };

/**
 * Постраничная загрузка статей текущего вида. Раньше клиент забирал весь список
 * (тысячи статей, ~1 МБ), хотя показывал первые 40 карточек.
 */
// Постраничная загрузка временно выключена: при выборе ленты и после
// синхронизации список и дерево теряли данные. Включать обратно только после
// проверки кликов по дереву и синхронизации в браузере.
const PAGED_DATA = false;
const PAGE_SIZE = 20;

function viewParam() {
  const { type, id } = state.view ?? {};
  return id ? `${type}:${id}` : String(type ?? 'unread');
}

// ------------------------------------------- история ленты постранично
// Общий ответ /api/data не содержит прочитанное старше PAYLOAD_READ_DAYS (7 дней):
// это экономит трафик, но из-за этого «Все» показывало только недавние статьи.
// Здесь догружаем полный список раздела страницами: /api/data?view=… отдаёт всё.
let historyOffset = 0;
let historyTotal = null;
let historyDone = false;
let historyBusy = false;
const HISTORY_PAGE = 200;

/** Начинаем историю заново: другой раздел или другой фильтр. */
function resetHistory() {
  historyOffset = 0;
  historyTotal = null;
  historyDone = false;
}

/**
 * Порядок «старые сверху». Его задаёт селектор «Порядок» (Дата: возрастание),
 * и от него же зависит, с какой стороны догружается история архива.
 */
function ascendingOrder() {
  return sortDir() === 'asc';
}

/**
 * Одна страница истории текущего раздела.
 * Обычный порядок — от свежих к старым (offset растёт). Архивный — от самых старых
 * к новым (offset убывает), чтобы первая карточка была самой старой.
 * Возвращает число новых статей (0 — если больше нечего или режим не тот).
 */
async function loadHistoryPage() {
  if (historyBusy || historyDone) return 0;
  if (unreadModeFor()) return 0;                 // в «непрочитанных» ничего не обрезается
  const type = state.view?.type;
  if (type !== 'feed' && type !== 'folder') return 0;
  historyBusy = true;
  try {
    // Первый вызов: узнаём общее число статей раздела, чтобы в архивном режиме
    // сразу встать на самый старый край.
    if (!Number.isFinite(historyTotal)) {
      const probe = new URLSearchParams({ view: viewParam(), limit: '1', offset: '0', meta: '0' });
      const info = await api(`/api/data?${probe.toString()}`);
      historyTotal = Number(info?.total) || 0;
      historyOffset = ascendingOrder() ? Math.max(0, historyTotal - HISTORY_PAGE) : 0;
    }
    const offset = Math.max(0, Math.min(historyOffset, Math.max(0, historyTotal - 1)));
    const query = new URLSearchParams({
      view: viewParam(),
      limit: String(HISTORY_PAGE),
      offset: String(offset),
      meta: '0',
    });
    const payload = await api(`/api/data?${query.toString()}`);
    const page = payload?.items ?? [];
    const seen = new Set((state.data.items ?? []).map((item) => item.id));
    let added = 0;
    for (const item of page) {
      if (seen.has(item.id)) continue;
      state.data.items.push(item);
      seen.add(item.id);
      added += 1;
    }
    if (Number.isFinite(Number(payload?.total))) historyTotal = Number(payload.total);
    if (ascendingOrder()) {
      historyOffset = offset - HISTORY_PAGE;
      if (historyOffset < 0) {
        historyOffset = 0;
        if (offset === 0) historyDone = true;
      }
    } else {
      historyOffset = offset + page.length;
      if (!page.length || historyOffset >= (historyTotal || 0)) historyDone = true;
    }
    // Состав раздела вырос: снимок и заморозку сбрасываем, иначе список
    // остаётся прежним (ключ вида не менялся) и новые карточки не появляются.
    state.snapshot = null;
    state.listFrozen = false;
    return added;
  } catch {
    return 0;
  } finally {
    historyBusy = false;
  }
}

const viewRequests = new Map();      // ключ → время последнего запроса

async function fetchView({ reset = false } = {}) {
  const offset = reset ? 0 : Number(state.viewOffset ?? 0);
  // Один и тот же запрос мог уйти несколько раз за кадр (перерисовка, прокрутка,
  // смена вида). Повторяем не чаще раза в 1,5 с и никогда — параллельно.
  const key = `${viewParam()}:${offset}`;
  const last = viewRequests.get(key) ?? 0;
  if (!reset && Date.now() - last < 1500) return false;
  if (state.viewLoading && !reset) return false;
  viewRequests.set(key, Date.now());
  state.viewLoading = true;
  try {
    return await fetchViewInner(offset, reset);
  } finally {
    state.viewLoading = false;
  }
}

async function fetchViewInner(offset, reset) {
  const query = new URLSearchParams({
    view: viewParam(),
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (unreadModeFor()) query.set('unread', '1');
  // Дерево и счётчики уже есть — не тянем их с каждой страницей.
  if (state.data?.feeds?.length) query.set('meta', '0');
  let payload;
  try {
    payload = await api(`/api/data?${query}`);
  } catch {
    return false;
  }
  if (!payload || !Array.isArray(payload.items)) return false;

  const items = reset ? [] : [...(state.data.items ?? [])];
  const seen = new Set(items.map((item) => item.id));
  for (const item of payload.items) if (!seen.has(item.id)) items.push(item);

  state.viewOffset = offset + payload.items.length;
  state.viewTotal = Number(payload.total) || items.length;
  state.data = {
    ...state.data,
    items,
    feeds: payload.feeds ?? state.data.feeds,
    counts: payload.counts ?? state.data.counts,
    fetching: payload.fetching ?? state.data.fetching,
    addedByFeed: payload.addedByFeed ?? state.data.addedByFeed,
    refreshing: payload.refreshing ?? state.data.refreshing,
    lastRefresh: payload.lastRefresh ?? state.data.lastRefresh,
    lastRefreshAdded: payload.lastRefreshAdded ?? state.data.lastRefreshAdded,
    lastRefreshFeeds: payload.lastRefreshFeeds ?? state.data.lastRefreshFeeds,
    revision: payload.revision ?? state.data.revision,
  };
  state.revision = payload.revision ?? state.revision;
  // Версия состава статей: по ней потом отличаем «изменились только отметки»
  // от «появились новые статьи, нужен полный список».
  if (Number.isFinite(payload.itemsRevision)) state.itemsRevision = payload.itemsRevision;
  applyPendingReads(state.data.items);
  // Сервер удалил статьи (лимит хранения) — убираем их и из локальных списков,
  // иначе карточки остаются на экране, хотя данных о них уже нет.
  if (Array.isArray(payload.items) && state.snapshot?.ids && !virtualFeedView()) {
    const alive = new Set(state.data.items.map((i) => i.id));
    for (const id of [...state.snapshot.ids]) if (!alive.has(id)) state.snapshot.ids.delete(id);
    for (const id of [...keepReadVisible]) if (!alive.has(id)) { keepReadVisible.delete(id); keepReadItems.delete(id); }
  }
  // Снимок видимых статей пересобираем: он мог быть построен до прихода страницы
  // (тогда в нём не было ни одной статьи, и список оставался пустым).
  // Снимок НЕ обнуляем: смену ленты и «показать новые» обрабатывает resetSnapshot().
  if (reset && !state.snapshot) state.snapshot = null;
  return true;
}

// -------------------------------------------------------------------- время

function timeAgo(iso) {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(diff)) return '';
  if (diff < 60) return 'только что';
  if (diff < 3600) return `${Math.floor(diff / 60)} мин`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} ч`;
  if (diff < 172800) return 'вчера';
  if (diff < 604800) return `${Math.floor(diff / 86400)} дн`;
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

const fullDate = (iso) => (iso
  ? new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : 'дата неизвестна');

function dayLabel(iso) {
  if (!iso) return 'Без даты';
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Сегодня';
  if (d.toDateString() === new Date(Date.now() - 86400000).toDateString()) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

// ------------------------------------------------------------------ выборка

const viewFeed = () => state.data.feeds.find((f) => f.id === state.view.id) ?? null;

/** Текущая лента — виртуальная («Читают сейчас»)? У неё свои правила показа. */
const virtualFeedView = () => (state.view.type === 'feed' ? Boolean(feedById(state.view.id)?.virtual) : false);
const viewFolder = () => state.data.folders.find((f) => f.id === state.view.id) ?? null;
const feedById = (id) => state.data.feeds.find((f) => f.id === id) ?? null;

/** Режим показа для канала: своя настройка либо общая по умолчанию. */
const feedMode = (feedId) => feedById(feedId)?.view ?? state.settings.defaultView ?? 'compact-thumb';

/**
 * Вид карточек у ТЕКУЩЕГО раздела: в ленте — её настройка, в «Избранном» и прочих
 * разделах — общий вид из шапки. Раньше везде бралась настройка ленты статьи, и в
 * избранном выбор вида ни на что не влиял.
 */
const viewMode = () => (state.view.type === 'feed'
  ? feedMode(state.view.id)
  : (state.settings.defaultView ?? 'compact-thumb'));

/** Порядок статей: у каждого канала свой, иначе общий из настроек. */
const sortDir = () => (state.view.type === 'feed'
  ? (viewFeed()?.sort ?? state.settings.defaultSort ?? 'desc')
  : (state.settings.defaultSort ?? 'desc'));

/** Ключ текущего вида: смена ленты, фильтра или поиска пересобирает список. */
const viewKey = () => JSON.stringify({
  view: state.view,
  unread: unreadModeFor(),
  query: state.query.trim().toLowerCase(),
});

/** Забыть снимок списка: при следующей отрисовке он соберётся заново. */
function resetSnapshot() {
  state.snapshot = null;
  keepReadVisible.clear();
  keepReadItems.clear();
  // Явное действие (смена ленты, обновление, «показать новые») — размораживаем,
  // после сборки снимка лента снова замирает до следующего явного действия.
  state.listFrozen = false;
}

/** Текст самой статьи — по нему работают фильтры ленты. Название ленты не в счёт:
 *  иначе фильтр «Видео» в ленте «…и видео приколы» скрывал бы все статьи сразу.
 *  У постов Telegram заголовок — это имя канала, поэтому смотрим только текст. */
function articleHaystack(item) {
  const telegram = (item.categories ?? []).includes('telegram');
  // Автор — часть текста статьи для фильтров: по нему удобно скрывать или
  // наоборот оставлять материалы конкретного человека (есть у Mobile-Review).
  return `${telegram ? '' : item.title ?? ''} ${item.author ?? ''} ${item.excerpt ?? ''}`.toLowerCase();
}

/** Текст для поиска: к тексту статьи добавляем ленту и категории — так ищут и по ленте. */
function searchHaystack(item) {
  return `${articleHaystack(item)} ${item.feedTitle ?? ''} ${(item.categories ?? []).join(' ')}`.toLowerCase();
}

/** Фильтры ленты: какие слова скрывать и какие показывать только. */
const feedFilters = (feedId) => feedById(feedId)?.filters ?? [];

/** Глобальная настройка «показывать только непрочитанные» — значение по умолчанию. */
const unreadDefault = () => state.prefs.unreadOnly !== false;

/** Для текущего вида: true — показывать только непрочитанные. */
function unreadModeFor(view = state.view) {
  if (view.type === 'unread') return true;
  if (view.type === 'starred') return false;
  if (view.type === 'feed') {
    // «Читают сейчас» показывает все десять всегда: прочитанное просто
    // приглушается, как в блоке на самом Хабре. Пустого списка не бывает.
    if (feedById(view.id)?.virtual) return false;
    const saved = state.prefs.feedUnread?.[view.id];
    return typeof saved === 'boolean' ? saved : unreadDefault();
  }
  return unreadDefault();
}

/** Подходит ли статья под фильтры своей ленты. */
function passesFeedFilters(item) {
  const filters = feedFilters(item.feedId);
  if (!filters.length) return true;
  const hay = articleHaystack(item);
  const hide = filters.filter((f) => f.mode === 'hide' && hay.includes(String(f.query).toLowerCase()));
  if (hide.length) return false;
  const only = filters.filter((f) => f.mode === 'only');
  if (only.length && !only.some((f) => hay.includes(String(f.query).toLowerCase()))) return false;
  return true;
}

/** Статьи вида без учёта прочитанного — из них собирается снимок. */
function itemsOfView() {
  const q = state.query.trim().toLowerCase();
  const list = state.data.items.filter((item) => {
    if (state.view.type === 'feed' && item.feedId !== state.view.id) return false;
    if (state.view.type === 'folder' && feedById(item.feedId)?.folderId !== state.view.id) return false;
    if (state.view.type === 'starred' && !item.starred && !pendingUnstar.has(item.id)) return false;
    if (!passesFeedFilters(item)) return false;          // фильтры, сохранённые для ленты
    if (q && !searchHaystack(item).includes(q)) return false;
    return true;
  });
  // В «Избранном» порядок — по времени добавления в избранное, а не по дате поста.
  // Витрина: догружаем статьи, которые сервер уже заменил, но человек их видел.
  if (state.view.type === 'feed' && heldItems.size && feedById(state.view.id)?.virtual) {
    const shown = new Set(list.map((item) => item.id));
    for (const [id, item] of heldItems) {
      if (shown.has(id) || item.feedId !== state.view.id) continue;
      list.push(item);
    }
    list.sort((a, b) => (Date.parse(b.date ?? 0) || 0) - (Date.parse(a.date ?? 0) || 0));
  }
  if (state.view.type === 'starred') {
    return list.sort((a, b) => (Number(b.starredAt) || 0) - (Number(a.starredAt) || 0));
  }
  return list;
}

/**
 * Статьи списка. Пока вы работаете с лентой, состав не меняется: прочитанная
 * статья остаётся на месте и просто становится прочитанной, а новые статьи,
 * пришедшие за это время, не вклиниваются в список — они ждут кнопки «показать
 * новые» и появляются при переходе в другую ленту. Так новые статьи не сдвигают
 * текст под курсором и не помечаются прочитанными, пока их никто не видел.
 */
function visibleItems() {
  const key = viewKey();
  const onlyUnread = unreadModeFor();
  // Снимка может не быть вовсе (его сбрасывают при догрузке и при смене раздела),
  // поэтому проверяем null раньше флага «заморожено», иначе падало на .ids.
  // Пустой снимок пересобираем всегда: он мог быть построен до прихода данных
  // (тогда в нём ноль статей), и «замороженный» список оставался пустым навсегда.
  const snapshotEmpty = !state.snapshot || !state.snapshot.ids || state.snapshot.ids.size === 0;
  if (snapshotEmpty || (!state.listFrozen && state.snapshot.key !== key)) {
    state.snapshot = {
      key,
      // Снимок — это то, что видно сейчас: в режиме «только непрочитанные»
      // в него попадают непрочитанные статьи.
      // В «только непрочитанные» снимок собирается из непрочитанных, но уже
      // показанные статьи не выкидываем: иначе после отметки «прочитано» лента
      // прыгала к следующей, а всё прочитанное исчезало безвозвратно.
      ids: (() => {
        const fresh = itemsOfView().filter((item) => !onlyUnread || !item.read).map((item) => item.id);
        const ids = new Set(fresh);
        const previous = state.snapshot?.ids;
        if (previous) {
          const stillHere = new Set(itemsOfView().map((item) => item.id));
          for (const id of previous) if (stillHere.has(id)) ids.add(id);
        }
        return ids;
      })(),
    };
  }
  // Снимок собран — замораживаем ленту: пока читаете, новые статьи в список не
  // вставляются, иначе отметки «прочитано» уезжали на соседнюю статью.
  state.listFrozen = true;
  const snapshot = state.snapshot.ids;
  const items = itemsOfView().filter((item) => snapshot.has(item.id) || keepReadVisible.has(item.id));
  // Если данные с сервера пришли без только что прочитанной статьи — берём копию.
  for (const [id, copy] of keepReadItems) {
    if (!items.some((item) => item.id === id)) items.push(copy);
  }
  // В «Избранном» порядок — по дате добавления в избранное (как и разделители
  // дней), в остальных лентах — по дате публикации.
  if (state.view.type === 'starred') {
    return items.sort((a, b) => (Number(b.starredAt) || 0) - (Number(a.starredAt) || 0));
  }
  const direction = ascendingOrder() ? 1 : -1;
  return items.sort((a, b) => {
    const left = a.date ?? '';
    const right = b.date ?? '';
    if (!left && !right) return 0;
    if (!left) return 1;               // статьи без даты — всегда в конце
    if (!right) return -1;
    return direction * left.localeCompare(right);
  });
}

// ---------------------------------------------------------------- отрисовка

/**
 * Служебная строка для ?debug=1: сколько статей пришло с сервера, сколько
 * осталось после фильтров и режима «непрочитанные», какой снимок списка и
 * сколько карточек нарисовано. Вызывается ПОСЛЕ renderList(), иначе цифры врут.
 */
function renderDebugInfo() {
  if (!DEBUG) return;
  const sub = document.querySelector('#view-sub');
  if (!sub) return;
  const inView = state.data.items.filter((item) => state.view.type !== 'feed' || item.feedId === state.view.id);
  const afterFilters = inView.filter((item) => passesFeedFilters(item) && (!unreadModeFor() || !item.read));
  const shown = state.snapshot?.ids?.size ?? 0;
  const cards = document.querySelectorAll('#list .article').length;
  sub.textContent += ` · в ленте ${inView.length}, после фильтров ${afterFilters.length}, снимок ${shown}, карточек ${cards}`;
}

function render() {
  renderSidebar();
  renderToolbar();
  renderList();
  renderDebugInfo();
}

const badge = (unread, added = 0) => {
  const fresh = added > 0 ? ` <span class="badge-new">(+${added > 999 ? '999+' : added})</span>` : '';
  if (!unread && !fresh) return '';
  return `<span class="badge">${unread > 999 ? '999+' : unread}${fresh}</span>`;
};

function renderSidebar() {
  renderTreeFilter();
  const { feeds: rawFeeds, folders } = state.data;
  // Счётчики считаем сами: скрытые фильтрами статьи не должны попадать в дерево,
  // иначе у ленты навсегда висит число, которого в списке не видно.
  const perFeed = new Map();
  let unreadAll = 0;
  let starredAll = 0;
  for (const item of state.data.items) {
    if (!passesFeedFilters(item)) continue;
    if (item.starred) starredAll += 1;
    const row = perFeed.get(item.feedId) ?? { unread: 0, total: 0 };
    row.total += 1;
    if (!item.read) { row.unread += 1; unreadAll += 1; }
    perFeed.set(item.feedId, row);
  }
  // Числа в дереве считаем по данным клиента: они всегда совпадают с тем, что
  // видно в списке (серверный счётчик считает по своей копии базы).
  const feeds = rawFeeds.map((feed) => ({
    ...feed,
    // Число непрочитанных — по данным клиента: серверный счётчик считает по
    // своей копии базы и может отличаться от того, что реально видно в списке
    // (например, статью скрыл фильтр ленты уже после подсчёта).
    unread: perFeed.get(feed.id)?.unread ?? (Number.isFinite(feed.unread) ? feed.unread : 0),
    total: perFeed.get(feed.id)?.total ?? feed.total ?? 0,
  }));
  $('#badge-unread').textContent = unreadAll || '';
  $('#badge-starred').textContent = starredAll || '';
  $('#feed-count').textContent = feeds.length ? `${feeds.length}` : '';
  for (const btn of document.querySelectorAll('.nav-item')) btn.classList.toggle('active', state.view.type === btn.dataset.view);
  updateFooterStats();   // числа в подвале — сразу после отрисовки дерева

  const feedRow = (feed) => {
    const active = state.view.type === 'feed' && state.view.id === feed.id;
    const letter = (feed.title || '?').trim().charAt(0).toUpperCase();
    return `<li><div class="row feed-row${active ? ' active' : ''}${feed.virtual ? ' virtual-row' : ''}${feed.lastError ? ' warn' : ''}"
        data-feed-row="${esc(feed.id)}" draggable="${feed.virtual ? 'false' : 'true'}" title="${esc(feed.lastError || feed.url)}">
      <span class="fav" aria-hidden="true">
        <span class="fav-letter">${feed.virtual ? '◷' : esc(letter)}</span>
        ${feed.virtual || faviconFailed.has(feed.id) ? '' : `<img src="/api/favicon?f=${esc(feed.id)}" alt="" loading="lazy">`}
      </span>
      <span class="row-name${feed.unread ? ' unread' : ''}">${esc(feed.title)}</span>
      ${feed.virtual ? '<span class="row-tag">витрина</span>' : ''}
      ${feed.virtual ? '' : `<span class="row-actions">
        <button data-feed-rename="${esc(feed.id)}" title="Переименовать">✎</button>
        <button class="del" data-feed-del="${esc(feed.id)}" title="Отписаться">×</button>
      </span>`}
      ${badge(
      // В режиме «Все» показываем, сколько статей всего, иначе — сколько непрочитанных.
      state.prefs.feedUnread?.[feed.id] === false ? feed.total : feed.unread,
      // «(+N)» считаем по фактическим данным клиента: счётчик сервера живёт в памяти
      // и переживает чистку, из-за чего в дереве было «1 (+1)», а список пустой.
      state.data.addedByFeed?.[feed.id] ?? 0,
    )}
    </div></li>`;
  };

  let html = '';
  const visibleFeeds = (list) => (state.prefs.treeFilter === 'unread'
    // Оставляем ленты с непрочитанным, текущую и те, у которых выбрано «показывать
    // все»: иначе лента с нулём непрочитанных пропадала из дерева.
    // «Читают сейчас» не скрываем никогда: это витрина Хабра, а не счётчик
    // непрочитанного — когда всё прочитано, она должна оставаться на месте.
    ? list.filter((f) => f.unread > 0 || f.id === state.view.id || f.virtual || state.prefs.feedUnread?.[f.id] === false)
    : list);

  for (const folder of folders) {
    const children = visibleFeeds(feeds.filter((f) => f.folderId === folder.id));
    if (state.prefs.treeFilter === 'unread' && !children.length) continue;
    const unread = children.reduce((n, f) => n + f.unread, 0);
    const collapsed = state.collapsed.has(folder.id);
    const active = state.view.type === 'folder' && state.view.id === folder.id;
    html += `<li>
      <div class="row folder-row${active ? ' active' : ''}" data-folder-row="${esc(folder.id)}" draggable="true" title="Папка: ${esc(folder.name)}">
        <button class="caret" data-toggle="${esc(folder.id)}" title="${collapsed ? 'Развернуть' : 'Свернуть'}">${collapsed ? '▸' : '▾'}</button>
        <span class="row-name">${esc(folder.name)}</span>
        ${badge(unread)}
        <span class="row-actions">
          <button data-folder-rename="${esc(folder.id)}" title="Переименовать">✎</button>
          <button class="del" data-folder-del="${esc(folder.id)}" title="Удалить папку">×</button>
        </span>
      </div>
      ${collapsed ? '' : `<ul>${children.map(feedRow).join('') || '<li><div class="row row-sub" style="padding-left:22px">пусто</div></li>'}</ul>`}
    </li>`;
  }
  html += visibleFeeds(feeds.filter((f) => !f.folderId)).map(feedRow).join('');
  // Хвост дерева: сюда можно бросить подписку, чтобы поставить её в конец списка.
  html += `<li><div class="row tree-tail" data-tail="root">перетащите сюда — встанет в конец списка</div></li>`;
  $('#tree').innerHTML = html || `<li><div class="row row-sub" style="padding:8px">${state.prefs.treeFilter === 'unread' && feeds.length
    ? 'Все подписки прочитаны — новые появятся здесь.'
    : 'Подписок нет — добавьте адрес выше.'}</div></li>`;
  $('#refresh-all').classList.toggle('spin', Boolean(state.data.refreshing));
}

function renderToolbar() {
  const titles = { all: 'Все статьи', unread: 'Непрочитанные', starred: 'Избранное' };
  let title = titles[state.view.type];
  if (state.view.type === 'feed') title = viewFeed()?.title ?? 'Лента';
  if (state.view.type === 'folder') title = `Папка: ${viewFolder()?.name ?? ''}`;
  $('#view-title').textContent = title;

  // Считаем ВСЕ статьи раздела, а не только показанные карточки: иначе в шапке
  // «3 статьи», а в дереве 4 — список-то выдаётся порциями.
  // В шапке показываем ТЕ ЖЕ числа, что в дереве (их считает сервер): иначе
  // получалось «в дереве 5, в ленте 4» из-за того, что список приходит порциями.
  const curFeed = state.view.type === 'feed' ? viewFeed() : null;
  const viewItems = itemsOfView().filter((item) => !unreadModeFor() || !item.read);
  const items = viewItems;
  // Числа в шапке совпадают с деревом (там серверные счётчики), а про новые статьи,
  // которые ещё ждут кнопку «Показать», говорит отдельная приписка.
  // Числа шапки берём из тех же данных, что и список: иначе в шапке «2 статьи»,
  // а карточек 1 — серверный счётчик считался по своей копии базы.
  const unreadShown = viewItems.filter((i) => !i.read).length;
  const unread = unreadShown;
  const totalShown = unreadModeFor() ? unreadShown : viewItems.length;
  const pendingNew = pendingNewCount();
  // «Читают сейчас» живёт своей жизнью: показываем, что список живой и когда ждать обновления.
  const virtualNote = virtualFeedView() ? ` · список обновляется каждые 10 минут` + (unreadShown ? '' : ', всё прочитано') : '';
  const listNote = pendingNew > 0
    ? ` · новых: ${pendingNew} — нажмите «Показать»`
    : '';
  // «3 мин назад», но «только что» и «вчера» — уже готовые слова, «назад» к ним не идёт.
  const ago = timeAgo(state.data.lastRefresh);
  const refreshed = state.data.lastRefresh
    ? `обновлено ${/^\d/.test(ago) ? `${ago} назад` : ago}`
    : 'ещё не обновлялось';
  // Итог последнего обновления — только в сводных разделах: в ленте про новые
  // статьи уже сказано выше, повторять одним и тем же числом незачем.
  const added = state.view.type === 'feed'
    ? ''
    : (Number.isFinite(state.data.lastRefreshAdded)
      ? `, новых: ${state.data.lastRefreshAdded}${state.data.lastRefreshFeeds ? ` в ${state.data.lastRefreshFeeds} ${plural(state.data.lastRefreshFeeds, 'ленте', 'лентах', 'лентах')}` : ''}`
      : '');
  $('#view-sub').textContent = `${totalShown} ${plural(totalShown, 'статья', 'статьи', 'статей')}, ${unread} ${plural(unread, 'непрочитанная', 'непрочитанные', 'непрочитанных')} · ${refreshed}${added}${listNote}${virtualNote}`;
  // Режим «Непрочитанные / Все» — только для текущей ленты.
  $('#unread-mode').value = unreadModeFor() ? 'unread' : 'all';
  $('#unread-mode-wrap').hidden = state.view.type === 'starred';
  $('#view-refresh').classList.toggle('spin', Boolean(state.data.refreshing));

  const mode = viewMode();
  const modeSelect = $('#view-switch');
  if (modeSelect) modeSelect.value = mode;
  const lines = Math.min(12, Math.max(1, Number(
    state.view.type === 'feed' ? (viewFeed()?.lines ?? state.settings.defaultLines ?? 2) : (state.settings.defaultLines ?? 2),
  )));
  $('#lines-select').value = String(lines);
  // Ширина текста — общая для всех лент.
  const textWidthValue = textWidth();
  $('#width-value').textContent = `${textWidthValue}%`;
  $('#width-minus').disabled = textWidthValue <= (Number(state.settings.minWidth) || 50);
  $('#width-plus').disabled = textWidthValue >= (Number(state.settings.maxWidth) || 100);
  $('#sort-select').value = sortDir();
  const selected = state.data.items.find((i) => i.id === state.selectedId);
  // Переходы активны только когда статья раскрыта — иначе кнопки «есть, а ничего не делают».
  // Стрелки работают всегда, когда есть выбранная статья: они просто прокручивают
  // список к соседней, раскрывать её не нужно.
  $('#prev-item').disabled = !selected;
  $('#next-item').disabled = !selected;
  // Кнопка видна всегда, когда есть выбранная статья: для лент без комментариев — неактивна.
  $('#comments-top').hidden = !selected;
  $('#comments-top').disabled = !selected?.comments;
  if (selected) {
    $('#comments-top').textContent = Number.isFinite(selected.commentsCount) && selected.commentsCount > 0
      ? `Комментарии (${selected.commentsCount})`
      : 'Комментарии';
  }
  $('#view-switch').title = state.view.type === 'feed'
    ? 'Как показывать статьи этого канала'
    : 'Режим по умолчанию (выберите канал, чтобы задать ему отдельно)';

  // Счётчик «докачка: N» убран из интерфейса: он обновлялся постоянно и
  // перерисовывал панель, из-за чего сворачивалось видео и мигала рамка.
  // Прогресс по-прежнему виден в настройках, где он нужен для контроля.
  // «Только картинки» — настройка отдельной ленты, в общих видах её не показываем.
  const feedNow = state.view.type === 'feed' ? viewFeed() : null;
  $('#images-only-wrap').hidden = !feedNow;
  setSelectValue($('#images-only'), feedNow?.imagesOnly ? 'yes' : 'no');
  renderFilterRow();
  renderNewRow();
}

/**
 * Сколько новых статей пришло в текущий раздел уже после того, как список был
 * зафиксирован. Раньше здесь суммировались серверные счётчики по всем лентам —
 * поэтому плашка «Новых статей» всплывала и в сводных разделах, и считала чужие
 * ленты, а кнопка «Показать» не могла ничего показать.
 */
function pendingNewCount() {
  const ids = state.snapshot?.ids;
  if (!state.listFrozen || !(ids instanceof Set) || !ids.size) return 0;
  return itemsOfView().filter((item) => !item.read && !ids.has(item.id)).length;
}

/** Полоска «пришли новые статьи»: показываем, но в список не добавляем. */
function renderNewRow() {
  const row = $('#new-row');
  if (!row) return;
  const count = pendingNewCount();
  // Плашка возвращается, только когда новых статей стало больше, чем в момент
  // закрытия: отметки «прочитано» её не оживляют.
  if (state.newRowClosedTotal !== null && count > state.newRowClosedTotal) {
    state.newRowClosedTotal = null;
  }
  row.hidden = count === 0
    || (state.newRowClosedTotal !== null && count <= state.newRowClosedTotal);
  if (!count) return;
  $('#new-text').textContent = `Новых статей: ${count}`;
}

$('#new-close').addEventListener('click', () => {
  // Запоминаем, сколько новых статей было в этот момент: плашка не вернётся, пока
  // их не станет больше. Отметки «прочитано» её не оживляют.
  state.newRowClosedTotal = pendingNewCount();
  $('#new-row').hidden = true;
});

// «Показать» делает ровно то же, что клик по этой ленте в дереве: раздел
// открывается заново, список собирается с нуля и встаёт наверх.
$('#new-show').addEventListener('click', () => {
  state.newRowClosedTotal = null;
  switchView({ ...state.view });
});

/** Полоска под поиском: превратить запрос в фильтр текущей ленты. */
function renderFilterRow() {
  const row = $('#filter-row');
  if (!row) return;
  const query = state.query.trim();
  const isFeed = state.view.type === 'feed';
  row.hidden = !query;
  // Счётчик фильтров обновляем всегда, даже без поискового запроса:
  // раньше эта строка стояла после `if (!query) return;` и число не показывалось.
  const total = state.data.feeds.reduce((sum, feed) => sum + (feed.filters?.length ?? 0), 0);
  $('#filters-btn').textContent = total ? `Фильтры (${total})` : 'Фильтры';
  if (!query) return;
  $('#filter-term').textContent = query;
  $('#filter-hide').disabled = !isFeed;
  $('#filter-only').disabled = !isFeed;
  $('#filter-hint').textContent = isFeed ? '' : 'фильтр задаётся для отдельной ленты';
}

function isExpanded(item) {
  if (state.collapsedItems.has(item.id)) return false;
  if (state.expandedItems.has(item.id)) return true;
  return viewMode() === 'full';
}

/**
 * Ширина текста статьи. Настраивается отдельно на каждом устройстве — как тема:
 * на телефоне удобно уже, на большом экране шире. Пока своё значение не задано,
 * берётся общее из настроек учётной записи.
 */
function textWidth() {
  const min = Number(state.settings.minWidth) || 50;
  const max = Number(state.settings.maxWidth) || 100;
  const saved = Number(state.prefs.width);
  const value = Number.isFinite(saved) && saved > 0 ? saved : Number(state.settings.defaultWidth ?? max);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : max;
}

/**
 * Узкие картинки в тексте статьи пускаем в обтекание: текст идёт рядом, а не
 * ждёт под картинкой. Широкие оставляем как есть — им нужна вся строка.
 * Решение принимаем по реальной ширине файла после загрузки.
 */
function layoutArticleImages(root = document) {
  const wrap = Boolean(state.prefs.imageWrap);
  for (const img of root.querySelectorAll('.a-body img, .comment-body img')) {
    const apply = () => {
      if (!wrap) { img.classList.remove('wrap-left'); return; }
      const container = img.closest('.a-body, .comment-body');
      if (!container) return;
      const containerWidth = container.clientWidth || 1;
      const natural = img.naturalWidth || 0;
      // Обтекание — только для одиночной картинки: если рядом другие, они
      // налезали друг на друга, и казалось, что видна лишь первая.
      const block = img.closest('p, figure, div') ?? img.parentElement;
      const hasNeighbour = Boolean(
        block?.previousElementSibling?.querySelector?.('img')
        || block?.nextElementSibling?.querySelector?.('img'),
      );
      // Картинки постов Telegram идут из кэша сервера (/api/media) и всегда во всю ширину — без обтекания.
      const fromCache = (img.getAttribute('src') ?? '').startsWith('/api/media');
      if (!fromCache && !hasNeighbour && natural && natural < containerWidth * 0.6) img.classList.add('wrap-left');
      else img.classList.remove('wrap-left');
    };
    if (img.complete) apply();
    else img.addEventListener('load', apply, { once: true });
  }
}

/**
 * Кнопка «Смотреть видео»: подставляет плеер по нажатию. Так статья не тянет
 * внешние скрипты и видео, пока их не попросили.
 */
function setupEmbeds(root = document) {
  for (const box of root.querySelectorAll('.embed-box[data-embed]')) {
    if (box.dataset.ready) continue;
    box.dataset.ready = '1';
    box.addEventListener('click', (event) => {
      if (!event.target.closest('.embed-play')) return;
      const src = box.dataset.embed;
      if (!src) return;
      const frame = document.createElement('iframe');
      frame.src = src;
      frame.loading = 'lazy';
      frame.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
      frame.allowFullscreen = true;
      frame.className = 'embed-frame';
      box.replaceChildren(frame);
    });
  }
}

/**
 * Служебная строка в конце статьи: сколько картинок и видео в тексте.
 * Показываем только ненулевые значения, иначе строки нет вовсе.
 */
function showMediaCounters() {
  for (const card of document.querySelectorAll('.article[data-item]')) {
    const body = card.querySelector('.a-body');
    if (!body) continue;
    const imgs = body.querySelectorAll('img').length;
    const vids = body.querySelectorAll('video').length;
    let badge = card.querySelector('.media-debug');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'media-debug';
      body.append(badge);
    }
    const parts = [];
    if (imgs > 0) parts.push('картинок ' + imgs);
    if (vids > 0) parts.push('видео ' + vids);
    badge.textContent = parts.length ? 'в тексте: ' + parts.join(', ') : '';
    badge.hidden = parts.length === 0;
  }
}

function bodyHtml(item) {
  const body = state.bodies.get(item.id);
  if (!body) {
    // Пока текст едет, показываем то, что уже есть в ленте: пустой спиннер
    // хуже короткого текста — статья остаётся читаемой даже при сбое загрузки.
    return item.excerpt
      ? `<div class="read-text"><div class="a-note">загружаю текст…</div><p>${esc(item.excerpt)}</p></div>`
      : '<div class="a-loading">Загрузка текста…</div>';
  }
  // Колонка текста внутри карточки: сама ширина задана карточке (--read-width).
  const column = (inner) => `<div class="read-text">${inner}</div>`;
  const note = body.note ? `<div class="a-note">${esc(body.note)}</div>` : '';
  // Если «тело» статьи — это тот же текст, что в анонсе (так бывает у Telegram
  // и коротких новостей), в полном виде он выглядел дублем. Сравниваем начало.
  const normalise = (text) => String(text ?? '').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
  // Если «полный текст со страницы» оказался короче текста из ленты — значит
  // со страницы вытащили не статью (404, «читайте также»). Берём то, что длиннее.
  const fullLen = String(body.fullHtml ?? '').length;
  const feedLen = String(body.content ?? '').length;
  const bodySource = (fullLen >= feedLen ? body.fullHtml : body.content) || body.content || '';
  const bodyHead = normalise(bodySource).slice(0, 80);
  const excerptHead = normalise(item.excerpt).slice(0, 80);
  const sameAsExcerpt = Boolean(bodyHead && excerptHead) && (bodyHead.startsWith(excerptHead) || excerptHead.startsWith(bodyHead));
  // Текст совпал с анонсом — сам текст в полной статье не дублируем, но медиа
  // (картинки и видео) из него оставляем: иначе статья выглядела бы пустой.
  // В лентах «только картинки» слоты не делаем: там свои изображения.
  const imagesOnlyFeed = Boolean(feedById(item.feedId)?.imagesOnly);
  let html = sanitize(bodySource, item.link, { slot: !imagesOnlyFeed });
  if (sameAsExcerpt && !body.fullHtml) {
    // Текст совпал с анонсом — сам текст в полной статье не дублируем, но медиа
    // оставляем. Раньше здесь выдёргивались только теги <img>, а к этому моменту
    // картинки уже «ленивые»: вместо тега стоит .img-slot с data-src, внутри —
    // скрытый <img> без src. В итоге в теле оставался невидимый слот, и карточка
    // открывалась пустой (посты LiveJournal «картинка + подпись»).
    const media = html.match(/<div class="img-slot"[\s\S]*?<\/div>|<div class="embed-box"[\s\S]*?<\/div>|<figure[\s\S]*?<\/figure>|<(?:img|video)\b[^>]*>/gi) ?? [];
    // Медиа нет — оставляем текст: пустое тело хуже, чем повтор анонса,
    // который в раскрытой карточке всё равно скрыт.
    if (media.length) html = media.join('\n');
  }
  // Бывает, что от сайта пришёл только текст без разметки (или одна разметка без
  // текста). Тогда карточка выглядела пустой — подставляем текст как абзац.
  if (!String(html ?? '').replace(/<[^>]*>/g, ' ').trim()) {
    const plain = String(body.fullHtml || body.content || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // Не подставляем тот же текст, что уже показан в кратком виде: в полной
    // статье он выглядел дублем.
    const head = String(item.excerpt ?? '').slice(0, 60).trim();
    const duplicate = head && plain.startsWith(head);
    if (plain && !duplicate) {
      html = `<p>${plain.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>`;
    }
  }
  // Лента «только картинки»: разметка сайта не нужна, оставляем сами изображения.
  if (feedById(item.feedId)?.imagesOnly && html) {
    const sources = [...new Set([...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]))];
    if (!sources.length) return column(note || '<div class="a-note">В этой статье нет картинок.</div>');
    const pictures = sources.map((src) => `<p class="img-alone"><img src="${esc(src)}" alt="" loading="lazy"></p>`).join('');
    return column(note + pictures);
  }
  // В ленте бывает картинка, которой нет в докачанном тексте — показываем её сверху.
  if (html && body.fullHtml && item.image && !/<img\b/i.test(html)) {
    html = `<p class="img-alone"><img src="${esc(imageSrc(item))}" alt="" loading="lazy"></p>${html}`;
  }
  if (html) {
    // Видео: кнопка на каждый ролик поста, а не только на первый. Сами теги
    // <video> из текста убираем — вместо них кнопки, которые включают прокси.
    const bodyVideos = [...String(html).matchAll(/<video\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)].map((m) => m[1]);
    // Чистка разметки уже завернула адрес в наш прокси — снимаем обёртку,
    // иначе кнопка завернёт его второй раз и сервер ответит «400».
    const unwrap = (src) => {
      const nested = /^\/api\/video\?u=([\s\S]+)$/.exec(src);
      return nested ? decodeURIComponent(nested[1]) : src;
    };
    const videoList = bodyVideos.map(unwrap);
    // Видео из текста не вынимаем: санитайзер сам превращает его в плеер.
    const videoSources = bodyVideos.length ? [] : (item.video ? [unwrap(item.video)] : []);
    const video = videoSources
      .map((src) => `<div class="a-video"><button class="btn primary" data-video="${esc(src)}">▶ Просмотреть видео</button>
          <span class="note">видео проигрывается через прокси и не сохраняется</span></div>`)
      .join('');
    return column(note + html + video);
  }
  const kind = feedById(item.feedId)?.kind;
  const fetchable = item.link && kind !== 'telegram' && kind !== 'telegram-bot';
  const videoOnly = item.video
    ? `<div class="a-video"><button class="btn primary" data-video="${esc(item.video)}">▶ Просмотреть видео</button></div>`
    : '';
  return column(note || videoOnly || `<div class="a-note">${fetchable
    ? 'Текста нет — нажмите «Докачать текст» в начале статьи, чтобы скачать его со страницы.'
    : 'В этой ленте текста нет — откройте оригинал.'}</div>`);
}

/** «+N» у счётчика комментариев: сколько добавилось после прошлой отметки. */
function commentDelta(item) {
  const total = Number(item.commentsCount);
  const seen = Number(item.commentsSeenCount);
  if (!Number.isFinite(total) || !Number.isFinite(seen) || seen <= 0) return '';
  const diff = total - seen;
  return diff > 0 ? ` <b class="comment-delta">+${diff}</b>` : '';
}
/**
 * Рейтинг комментария (Хабр и подобные): у положительного ставим «+», у
 * отрицательного знак уже есть. Раньше «+» приписывался всегда и выходило «+-3».
 */
function scoreLabel(score) {
  const num = Number(score);
  if (!Number.isFinite(num) || !num) return '';
  return num > 0 ? `+${num}` : String(num);
}
/** Блок комментариев в конце статьи. */
function commentsHtml(item) {
  if (!item.comments) return '';
  const known = Number.isFinite(item.commentsCount) ? ` (${item.commentsCount})` : '';
  const loaded = state.comments.get(item.id);
  if (!loaded) {
    return `<div class="a-comments"><div class="a-comments-head">
      <button class="btn" data-comments="${esc(item.id)}">Показать комментарии${known}</button>
      <span class="note">${item.commentsCount > 0 ? 'есть обсуждение — загрузится с сайта' : 'загружаются с сайта по запросу'}</span>
    </div></div>`;
  }
  if (loaded.loading) return '<div class="a-comments"><div class="a-loading">Загружаю комментарии…</div></div>';
  if (!loaded.ok) {
    return `<div class="a-comments"><div class="a-comments-head">
      <button class="btn" data-comments="${esc(item.id)}">Повторить</button>
      <span class="note">не удалось получить: ${esc(loaded.error ?? 'ошибка')}</span>
    </div></div>`;
  }
  // Новые комментарии: сервер уже сравнил их с вашей отметкой «дочитано до id N».
  const newSet = new Set((loaded.newIds ?? []).map(String));
  const render = (nodes) => nodes.map((node) => {
    // Удержанные подсветки продолжают светиться и после перерисовки списка.
    const isNew = newSet.has(String(node.id))
      || commentHighlightHold.has(commentHoldKey(item.id, String(node.id)));
    return `
    <div class="comment${isNew ? ' is-new' : ''}" data-comment-id="${esc(String(node.id))}" style="margin-left:${Math.min(node.depth, 6) * 14}px"${isNew ? ` data-comment-new="${esc(String(node.id))}"` : ''}>
      <div class="comment-head">
        <span class="comment-author">${esc(node.author)}</span>
        <span>${esc(timeAgo(node.date))}</span>
        ${scoreLabel(node.score) ? `<span class="comment-score${Number(node.score) < 0 ? ' neg' : ''}">${scoreLabel(node.score)}</span>` : ''}
        ${isNew ? '<span class="comment-new-chip">новый</span>' : ''}
      </div>
      <div class="comment-body">${sanitize(node.html, node.link ?? item.link)}</div>
      ${render(node.children ?? [])}
    </div>`;
  }).join('');
  const total = Number.isFinite(loaded.total) ? loaded.total : loaded.count;
  const newCount = newSet.size;
  const maxShownId = (() => {
    let max = 0;
    const walk = (nodes) => {
      for (const node of nodes ?? []) {
        const num = Number(node.id);
        if (Number.isFinite(num) && num > max) max = num;
        walk(node.children);
      }
    };
    walk(loaded.threads);
    return max;
  })();
  // Кнопку показываем всегда, когда показано больше, чем отмечено: это и первая
  // отметка (когда её ещё нет), и «догнать» после новых комментариев.
  const seenButton = maxShownId > (Number(loaded.seenMax) || 0)
    ? `<button class="btn" data-comments-seen="${esc(item.id)}" data-max-id="${maxShownId}">Отметить прочитанными</button>`
    : '';
  const jumpButton = newCount
    ? `<button class="btn" data-comments-jump="${esc(item.id)}">К первому новому</button>`
    : '';
  return `<div class="a-comments" data-comments-block="${esc(item.id)}">
    <div class="a-comments-head">
      <button class="btn" data-comments="${esc(item.id)}">Обновить</button>
      ${jumpButton}
      ${seenButton}
      <span class="note">комментариев на сайте: ${total}${loaded.count !== total ? `, показано ${loaded.count}` : ''}${newCount ? ` · <b class="comments-new-count">новых: ${newCount}</b>` : ''}${loaded.cached ? ' (из кэша)' : ''}</span>
    </div>
    <div class="a-comments-list">${loaded.threads?.length ? render(loaded.threads) : '<div class="note">Комментариев пока нет.</div>'}</div>
    ${loaded.hasMore
      ? `<div class="a-comments-more"><button class="btn" data-comments-more="${esc(item.id)}" data-page="${Number(loaded.page ?? 1) + 1}">Загрузить далее</button></div>`
      : (loaded.page > 1 ? '<div class="a-comments-more"><span class="note">Других комментариев нет.</span></div>' : '')}
  </div>`;
}

/** Загружает комментарии к статье (по кнопке в конце статьи). */
async function loadComments(id, force = false, options = {}) {
  const previous = state.comments.get(id);
  const page = Number(options.page) || 0;
  if (!page) {
    state.comments.set(id, { loading: true });
    if (!patchComments(id)) patchCard(id);
  }
  try {
    const query = `/api/comments?id=${encodeURIComponent(id)}${force ? '&force=1' : ''}${page ? `&page=${page}` : ''}`;
    const payload = await api(query);
    if (!payload.supported) {
      state.comments.delete(id);
      // Список не пересобираем: обновляем только этот блок, иначе лента прыгает.
      if (!patchComments(id)) renderList();
      return;
    }
    if (page > 1 && previous) {
      // Догрузка следующей страницы: добавляем только новые комментарии.
      const known = new Set();
      const collect = (nodes) => {
        for (const node of nodes ?? []) { known.add(String(node.id)); collect(node.children); }
      };
      collect(previous.threads);
      const added = (payload.threads ?? []).filter((node) => !known.has(String(node.id)));
      state.comments.set(id, {
        ...previous,
        ...payload,
        threads: [...(previous.threads ?? []), ...added],
        // Новинки объединяем: страницы считают их от одной и той же отметки.
        newIds: [...new Set([...(previous.newIds ?? []), ...(payload.newIds ?? [])])],
        hasMore: added.length > 0 && Boolean(payload.hasMore),
        nothingNew: added.length === 0,
      });
    } else {
      state.comments.set(id, { loading: false, ...payload });
    }
    const item = state.data.items.find((i) => i.id === id);
    if (item && Number.isFinite(payload.total)) item.commentsCount = payload.total;
    // Новых по id нет, а счётчик сайта больше отмеченного — значит разница
    // накопилась из скрытых и удалённых комментариев. Выравниваем цифру, чтобы
    // «+N» в карточке не висело вечно.
    if (item && !(payload.newIds ?? []).length) {
      const shownMax = maxCommentId(state.comments.get(id)?.threads);
      const seenMax = Number(state.comments.get(id)?.seenMax) || 0;
      const siteCount = Number(item.commentsCount);
      if (shownMax && seenMax >= shownMax && Number.isFinite(siteCount) && siteCount > (Number(item.commentsSeenCount) || 0)) {
        item.commentsSeenCount = siteCount;
        api('/api/comments/seen', { id, maxId: seenMax, count: siteCount }).catch(() => {});
      }
    }
    // На сайте комментариев больше, чем на первой странице: новые могли оказаться
    // на следующих, поэтому догружаем сами (не больше двух страниц за раз).
    const shown = Number(state.comments.get(id)?.count ?? 0);
    const total = Number(state.comments.get(id)?.total ?? payload.total ?? 0);
    const pageNow = Number(options.page) || 1;
    if (pageNow < 3 && total > shown && state.comments.get(id)?.hasMore) {
      autoMoreComments.add(id);
      await loadComments(id, false, { page: pageNow + 1 });
      autoMoreComments.delete(id);
      return;
    }
  } catch (err) {
    state.comments.set(id, { ...(previous ?? {}), loading: false, ok: false, error: err.message });
  }
  // Обновляем только блок комментариев: карточка и список остаются на месте.
  if (!patchComments(id)) patchCard(id);
}

// Статьи, у которых прямо сейчас догружаются следующие страницы комментариев.
const autoMoreComments = new Set();

// Открытые комментарии устарели: на сайте больше, чем загружено. Обновляем сами,
// иначе «+5» в карточке есть, а «перейти к новым» не появляется — в памяти
// лежит старый список без этих комментариев.
const commentsStaleChecked = new Set();
function refreshStaleComments() {
  for (const [id, loaded] of state.comments) {
    if (!loaded?.ok || loaded.loading) continue;
    const item = state.data.items.find((i) => i.id === id);
    if (!item) continue;
    const site = Number(item.commentsCount);
    const shown = Number(loaded.count);
    if (!Number.isFinite(site) || !Number.isFinite(shown) || site <= shown) continue;
    // На каждое новое значение счётчика — одна попытка обновления: иначе при
    // счётчике, который считает и удалённые, запросы шли бы бесконечно.
    if (loaded.refreshedForCount === site) continue;
    if (commentsStaleChecked.has(id)) continue;
    loaded.refreshedForCount = site;
    commentsStaleChecked.add(id);
    setTimeout(() => commentsStaleChecked.delete(id), 60000);
    loadComments(id, true);
  }
}
/** Максимальный id среди комментариев — до него и двигаем отметку «прочитано». */
function maxCommentId(nodes) {
  let max = 0;
  const walk = (list) => {
    for (const node of list ?? []) {
      const num = Number(node.id);
      if (Number.isFinite(num) && num > max) max = num;
      walk(node.children);
    }
  };
  walk(nodes);
  return max;
}

// Сколько держать подсветку «нового» после того, как комментарий попал на экран.
// Раньше она снималась мгновенно (трекер прокрутки сразу отмечал прочитанным),
// и было непонятно, что именно нового в статье.
const COMMENT_HIGHLIGHT_HOLD_MS = 5000;
const commentHighlightHold = new Map(); // `${articleId}:${commentId}` → до какого момента держим

const commentHoldKey = (articleId, commentId) => `${articleId}:${commentId}`;

/** Снимает подсветку с уже отрисованного комментария и убирает его из «удержания». */
function dropCommentHighlight(articleId, commentId) {
  commentHighlightHold.delete(commentHoldKey(articleId, commentId));
  const block = document.querySelector(`.a-comments[data-comments-block="${cssId(articleId)}"]`);
  const node = block?.querySelector(`.comment[data-comment-id="${cssId(String(commentId))}"]`);
  if (!node) return;
  node.classList.remove('is-new');
  node.removeAttribute('data-comment-new');
  node.querySelector(':scope > .comment-head .comment-new-chip')?.remove();
}

/** Держит подсветку 5 секунд, потом плавно снимает. Повторный вызов не плодит таймеры. */
function holdCommentHighlight(articleId, commentId) {
  const key = commentHoldKey(articleId, commentId);
  if (commentHighlightHold.has(key)) return;
  commentHighlightHold.set(key, Date.now() + COMMENT_HIGHLIGHT_HOLD_MS);
  setTimeout(() => dropCommentHighlight(articleId, commentId), COMMENT_HIGHLIGHT_HOLD_MS);
}

/** Явная отметка «прочитано» снимает подсветку сразу — ждать пять секунд незачем. */
function clearCommentHolds(articleId) {
  for (const key of [...commentHighlightHold.keys()]) {
    if (key.startsWith(`${articleId}:`)) {
      dropCommentHighlight(articleId, key.slice(String(articleId).length + 1));
    }
  }
}

/**
 * Отмечает комментарии прочитанными до maxId.
 * silent — без перерисовки списка (используется при прокрутке): подсветка снимается
 * не сразу, а через COMMENT_HIGHLIGHT_HOLD_MS, чтобы успеть увидеть, что было новым.
 */
async function markCommentsSeen(id, maxId, options = {}) {
  const loaded = state.comments.get(id);
  const max = maxId || maxCommentId(loaded?.threads);
  if (!max) return;
  const before = (loaded?.newIds ?? []).length;
  // Оставляем «новыми» только те, что ещё не дочитаны: отметка двигается вперёд
  // постепенно, вместе с прокруткой.
  if (loaded) {
    loaded.newIds = (loaded.newIds ?? []).filter((x) => Number(x) > max);
    loaded.seenMax = Math.max(Number(loaded.seenMax) || 0, max);
  }
  const item = state.data.items.find((i) => i.id === id);
  if (item) {
    item.commentsSeenMaxId = Math.max(Number(item.commentsSeenMaxId) || 0, max);
    // Чтобы «+N» в карточке сразу уменьшилось: число на момент отметки берём из
    // загруженного списка, а не ждём перезагрузки страницы.
    if (Number(loaded?.count)) item.commentsSeenCount = Number(loaded.count);
  }
  const left = loaded?.newIds?.length ?? 0;
    // Счётчик в карточке обновляем сразу: иначе «+N» висит до перезагрузки.
    const chip = document.querySelector(`.article[data-item="${cssId(id)}"] .comment-chip`);
    if (chip && Number.isFinite(Number(item?.commentsCount))) {
      chip.textContent = `💬 ${item.commentsCount}`;
      if (left) chip.insertAdjacentHTML("beforeend", ` <b class="comment-delta">+${left}</b>`);
    }
  if (options.silent) {
    const block = document.querySelector(`.a-comments[data-comments-block="${id}"]`);
    if (block) {
      for (const node of block.querySelectorAll('.comment.is-new')) {
        const num = Number(node.dataset.commentId);
        if (!Number.isFinite(num) || num > max) continue;
        // Подсветку не снимаем сразу: держим COMMENT_HIGHLIGHT_HOLD_MS, чтобы было
        // видно, какие комментарии новые. Отметка при этом уже сохранена.
        holdCommentHighlight(id, num);
      }
      const counter = block.querySelector('.comments-new-count');
      if (left && counter) counter.textContent = `новых: ${left}`;
      if (!left) {
        for (const btn of block.querySelectorAll('[data-comments-seen], [data-comments-jump]')) btn.remove();
        if (counter) counter.remove();
      }
    }
  } else {
    clearCommentHolds(id);
    renderList();
    if (before) toast('Отмечено прочитанным');
  }
  try {
    const payload = await api('/api/comments/seen', { id, maxId: max, count: Number(loaded?.count) || undefined });
    if (Number.isFinite(payload?.revision)) state.revision = payload.revision;
  } catch { /* отметка не критична, повторим при следующем открытии */ }
}

// Долистали комментарии до конца — считаем их прочитанными.
// Отмечаем прочитанное по мере прокрутки: всё, что уже ушло выше нижнего края
// экрана, считаем прочитанным. Так отметка двигается постепенно — и «К первому
// новому» в следующий раз ведёт дальше, а не к тем же комментариям.
let commentsSeenStamp = 0;
function trackCommentsProgress() {
  if (Date.now() - commentsSeenStamp < 400) return;
  for (const block of document.querySelectorAll('.a-comments[data-comments-block]')) {
    const id = block.dataset.commentsBlock;
    const loaded = state.comments.get(id);
    if (!loaded?.ok || loaded.loading) continue;
    const seen = Number(loaded.seenMax) || 0;
    // Считаем прочитанным только то, что реально побывало на экране. Раньше
    // брали всё, что выше нижнего края, — и при переходе к новым комментариям
    // они мгновенно «прочитывались», не успев показаться.
    let visibleMax = 0;
    for (const node of block.querySelectorAll('.comment[data-comment-id]')) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      const num = Number(node.dataset.commentId);
      if (Number.isFinite(num) && num > visibleMax) visibleMax = num;
    }
    if (!visibleMax || visibleMax <= seen) continue;
    commentsSeenStamp = Date.now();
    markCommentsSeen(id, visibleMax, { silent: true });
  }
}

// Именно capture: список статей прокручивается внутри #list, а такие события
// до window не всплывают — раньше обработчик не срабатывал вовсе.
document.addEventListener('scroll', trackCommentsProgress, { capture: true, passive: true });
document.getElementById('list')?.addEventListener('scroll', trackCommentsProgress, { passive: true });

// Счётчики комментариев: показываем цифру до нажатия, чтобы было видно, есть ли смысл открывать.
const countsRequested = new Set();

async function requestCommentCounts() {
  const ids = visibleItems()
    .slice(0, state.limit)
    .filter((i) => i.comments && !Number.isFinite(i.commentsCount) && !countsRequested.has(i.id))
    .map((i) => i.id)
    .slice(0, 40);
  if (!ids.length) return;
  for (const id of ids) countsRequested.add(id);
  try {
    const payload = await api('/api/comments/counts', { ids });
    let changed = false;
    for (const [id, count] of Object.entries(payload.counts ?? {})) {
      const item = state.data.items.find((i) => i.id === id);
      if (!item) continue;
      if (Number.isFinite(count)) { item.commentsCount = count; changed = true; }
    }
    if (changed) { for (const id of Object.keys(payload.counts ?? {})) patchCard(id); }
  } catch { /* счётчики не критичны */ }
}

/** Переключение вида: список открывается с начала, состояние чтения сбрасывается. */
function switchView(view) {
  state.view = view;
  // Раздел «Непрочитанные» включает фильтр, «Все статьи» и «Избранное» — выключают;
  // в ленте и папке галочка остаётся такой, какой её поставил пользователь.
  if (view.type === 'unread') state.prefs.unreadOnly = true;
  else if (view.type === 'all') state.prefs.unreadOnly = false;
  state.limit = 10;
  state.resetScroll = true;
  state.expandedItems.clear();
  state.commentsOnly.clear();
  state.collapsedItems.clear();
  state.selectedId = null;
  // Перешли в другую ленту — плашка «новые статьи» больше не актуальна:
  // у каждого раздела свой счётчик, при возврате он посчитается заново.
  state.newRowClosedTotal = null;
  if ($('#new-row')) $('#new-row').hidden = true;
  manualRead.clear();                   // в другой ленте ручные отметки больше не приоритет
  pendingUnstar.clear();                // и снятые в избранном карточки больше не держим
  state.framedIds.clear();              // в новом разделе рамка ещё ни на чём не была
  resetSnapshot();                      // в новой ленте список собирается заново
  heldItems.clear();                    // новый раздел — показываем свежий состав, без «удержанных»
  // «Читают сейчас» — живой блок: при открытии сразу спрашиваем Хабр.
  // Иначе до десяти минут показывали бы вчерашний состав, а статьи,
  // ушедшие из блока на сайте, оставались бы в ленте.
  if (state.view.type === 'feed' && feedById(state.view.id)?.virtual) {
    api('/api/habr-now/refresh', {}).then(() => {
      // Список открыли — метку «(+N)» больше не держим: новое уже на экране.
      if (state.data.addedByFeed) delete state.data.addedByFeed[state.view.id];
      return loadData({ poll: false });
    }).catch(() => {});
  }
  state.viewOffset = 0;
  state.viewTotal = 0;
  resetHistory();
  // Порядок «старые сверху»: подтягиваем старый край архива, чтобы первой
  // карточкой была самая старая. При «новые сверху» старое придёт при прокрутке.
  if (ascendingOrder()) {
    loadHistoryPage().then((added) => { if (added) { state.limit = 10; render(); } });
  }
  if (PAGED_DATA) {
    // Догружаем первую страницу нового вида: раньше здесь был уже весь список.
    fetchView({ reset: true }).then((ok) => { if (ok) render(); });
  }
  // Панель подписок закрываем только на сенсорных экранах (там это выдвижное
  // меню). На компьютере с узким окном дерево должно оставаться на месте.
  if (window.matchMedia('(pointer: coarse)').matches) openTree(false);
  userScrolled = false;                 // без прокрутки мышь ещё не трогали
  userScrollAt = 0;
  ignoreScrollUntil = Date.now() + 900;
  scrollBaseline = 0;
  // Запоминаем, где мы были: после перезагрузки страницы или обновления
  // вернёмся в ту же ленту с тем же фильтром.
  state.prefs.view = { type: view.type, id: view.id ?? null };
  savePrefs();
  // Свежие статьи могли не дойти до клиента: подтягиваем их перед отрисовкой.
  // В новой ленте может не быть нужного числа статей: догружаем по количеству.
  // Пересобираем раздел наверняка: список мог отстать от сервера (в дереве 5, в ленте 4).
  render();
  state.snapshot = null;                 // снимок строим заново из свежих данных
  state.listFrozen = false;
  // Засекаем окно измерения: сколько трафика ушло на открытие этой ленты.
  // Новая лента — новый отсчёт: считаем всё, что придёт после этого момента.
  state.traffic.label = viewFeed?.()?.title ?? viewFolder?.()?.name ?? '';
  state.traffic.from = performance.now();
  state.traffic.total = 0;
  state.traffic.list = 0;
  state.traffic.images = 0;
  state.traffic.bodies = 0;
  // Пока раздел догружается, показываем заглушку: иначе сначала рисовался
  // неполный список, а через секунду статьи вставлялись сверху и сразу
  // помечались прочитанными, потому что оказывались выше линии чтения.
  state.loadingView = true;
  render();
  showLoader('Загружаю ленту…');   // затемнение со спиннером вместо надписи вверху
  ensureViewItems(0, true).then(() => {
    hideLoader();
    state.loadingView = false;
    // Снимок сбрасываем ещё раз ПОСЛЕ ответа: иначе список уже заморожен и
    // догруженные статьи в него не попадут (в шапке 1, а карточек нет).
    state.snapshot = null;
    state.listFrozen = false;
    // Список новой ленты показываем с самого верха: при переключении оставался
    // прежний scrollTop, и первая карточка уезжала под шапку.
    state.resetScroll = true;
    render();
    const listEl = $('#list');
    if (listEl) listEl.scrollTop = 0;
    const paneEl = document.querySelector('.list-pane');
    if (paneEl) paneEl.scrollTop = 0;
  }).catch(() => { hideLoader(); state.loadingView = false; render(); });
}

/** Восстанавливает раздел, в котором пользователь был до перезагрузки. */
function restoreView() {
  const saved = state.prefs.view;
  if (!saved || typeof saved !== 'object') return false;
  const type = String(saved.type ?? '');
  if (type === 'feed') {
    if (!feedById(saved.id)) return false;
    switchView({ type: 'feed', id: saved.id });
    return true;
  }
  if (type === 'folder') {
    if (!state.data.folders.some((f) => f.id === saved.id)) return false;
    switchView({ type: 'folder', id: saved.id });
    return true;
  }
  if (type === 'unread' || type === 'starred') {
    switchView({ type, id: null });
    return true;
  }
  // «Все статьи» из навигации убрано — возвращаемся в «Непрочитанные».
  if (type === 'all') {
    switchView({ type: 'unread', id: null });
    return true;
  }
  return false;
}

/** Панель внутри раскрытой статьи — только то, что относится к самой статье. */
function articleNavHtml(item) {
  const kind = feedById(item.feedId)?.kind;
  const fetchable = Boolean(item.link) && kind !== 'telegram' && kind !== 'telegram-bot';
  if (!fetchable || item.hasFull) return '';
  return `<div class="a-nav"><button class="btn" data-fetch="${esc(item.id)}">Докачать текст</button></div>`;
}

/** Адрес картинки для списка: чужие картинки идут через наш кэш, свои — как есть. */
function imageSrc(item) {
  const source = String(item?.image ?? '');
  if (!source) return '';
  if (source.startsWith('/api/')) return source;
  return `/api/thumb?id=${encodeURIComponent(item.id)}`;
}

function articleHtml(item) {
  const commentsOnly = state.commentsOnly.has(item.id);
  const expanded = isExpanded(item) || commentsOnly;
  const mode = viewMode();
  const kind = feedById(item.feedId)?.kind;
  const body = state.bodies.get(item.id);
  const bodyEmpty = Boolean(body) && !(body.fullHtml || body.content);
  const downloaded = item.hasFull && !bodyEmpty;
  const feed = feedById(item.feedId);
  const lines = Math.min(12, Math.max(1, Number(feed?.lines ?? state.settings.defaultLines ?? 2)));
  // Ширина задаётся карточке целиком — сужается и текст, и заголовок.
  const width = textWidth();
  // Если наша миниатюра не отдалась (сайт закрыл доступ, истёк токен), пробуем
  // загрузить картинку напрямую — без этого карточка оставалась совсем без картинки.
  // Миниатюра карточки идёт через /api/thumb: сервер отдаёт уменьшенный кадр,
  // иначе при листании качались полноразмерные фотографии.
  const thumbSource = state.prefs.thumbs && item.image ? imageSrc(item) : '';
  const thumb = thumbSource
    ? `<img class="a-thumb" src="${esc(imageSrc(item))}" alt="" loading="lazy"
         referrerpolicy="no-referrer"
        data-thumb="1">`
    : '';
  // Картинка показывается только в «Кратко»: от этого зависит отступ текста слева.
  const hasThumb = Boolean(thumb) && mode === 'compact-thumb';
  // Заголовок — ссылка на оригинал: открывается в новой вкладке. Раскрытие — по краткому тексту.
  const title = item.link
    ? `<a href="${esc(item.link)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>`
    : esc(item.title);
  // has-title: у карточки есть заголовок. По нему в кратком виде решается,
  // нужен ли отступ справа под плавающие кнопки.
  const hasTitle = Boolean(String(item.title ?? '').trim());
  return `<article class="article ${item.read ? 'read' : 'unread'} ${mode}${hasTitle ? ' has-title' : ''}${hasThumb ? ' has-thumb' : ''}${expanded ? ' expanded' : ''}${item.id === state.selectedId ? ' selected' : ''}" style="--read-width:${width}%;--excerpt-lines:${lines}" data-item="${esc(item.id)}">
    <div class="a-rail">
      <div class="a-actions">
        <button data-star="${esc(item.id)}" class="${item.starred ? 'on' : ''}" title="В избранное (s)">${item.starred ? '★' : '☆'}</button>
        <button data-read="${esc(item.id)}" data-value="${item.read ? '0' : '1'}" title="Прочитано/непрочитано (m)">${item.read ? '●' : '○'}</button>
        <button data-share="${esc(item.id)}" class="a-share" title="Поделиться ссылкой"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="currentColor"><circle cx="6" cy="12" r="2.5"/><circle cx="17" cy="5.5" r="2.5"/><circle cx="17" cy="18.5" r="2.5"/><path d="M8.2 10.8 L14.8 6.8 M8.2 13.2 L14.8 17.2" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"/></svg></button>
        <button data-next="${esc(item.id)}" class="a-next" title="Следующая статья">↓</button>
      </div>
    </div>
    <div class="a-head">
      ${thumb}
      <div class="a-main">
        <h3 class="a-title">${title}</h3>
        <div class="a-meta">
          <span class="src">${esc(item.feedTitle)}</span>
          <span data-time="${esc(item.date ?? '')}">${esc(timeAgo(item.date))}</span>
          ${item.author && item.author !== item.feedTitle ? `<span>${esc(item.author)}</span>` : ''}
          ${downloaded ? '<span class="flag">скачан</span>' : ''}
          ${item.read ? '<span class="flag read-mark">✓ прочитано</span>' : ''}
          ${Number.isFinite(item.readers) ? `<span class="flag" title="Сколько раз статью прочитали на Хабре">👁 ${shortNumber(item.readers)}</span>` : ''}
          ${item.comments
            ? (Number.isFinite(item.commentsCount)
              ? `<button class="flag comment-chip${item.commentsCount ? '' : ' empty'}" data-comments="${esc(item.id)}" data-comments-only="1" title="Показать комментарии, не раскрывая статью">💬 ${item.commentsCount}${commentDelta(item)}</button>`
              : `<button class="flag comment-chip empty" data-comments="${esc(item.id)}" data-comments-only="1" title="Проверить комментарии">💬</button>`)
            : ''}
        </div>
        ${expanded ? '' : `<p class="a-excerpt" style="--excerpt-lines:${lines}">${esc(item.excerpt || 'Нажмите, чтобы раскрыть статью')}</p>`}
      </div>
    </div>
    <div class="a-body">${expanded
      ? (commentsOnly
        ? commentsHtml(item) + '<div class="a-end" data-end="' + esc(item.id) + '"></div>'
        : articleNavHtml(item) + bodyHtml(item) + commentsHtml(item) + '<div class="a-end" data-end="' + esc(item.id) + '"></div>')
      : ''}</div>
  </article>`;
}

/**
 * Пока кнопка мыши нажата, список не перерисовываем: иначе узел под курсором
 * успевает замениться и нажатие теряется (кнопка «не реагирует»).
 */
let pointerDown = false;
let renderPending = false;
/** Куда рамку поставили принудительно (переход по кнопке, вход в ленту) и до каких пор. */
let activePin = { id: null, until: 0 };
/** Последняя активная статья и положение списка на тот момент (защита от мигания). */
let activeMeta = { id: null, scrollTop: -1 };

/**
 * Есть ли в ленте выделенный текст. Пока он есть, список не пересобираем совсем:
 * ни по опросу, ни по живым событиям, ни по догрузке. Выделение — работа человека,
 * и терять его из-за фонового обновления нельзя. Дерево и плашка «Новых статей»
 * при этом обновляются: по ним видно, что пора пересобрать ленту вручную.
 */
function listSelectionActive() {
  const sel = window.getSelection?.();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return false;
  const node = sel.anchorNode;
  if (!node) return false;
  const el = node.nodeType === 1 ? node : node.parentElement;
  return Boolean(el?.closest?.('#list'));
}

/** Выделение сняли — выполняем отложенную перерисовку ленты (одну). */
let selectionFlushTimer = null;
document.addEventListener('selectionchange', () => {
  if (!state.deferredRender || listSelectionActive()) return;
  clearTimeout(selectionFlushTimer);
  selectionFlushTimer = setTimeout(() => {
    if (!state.deferredRender || listSelectionActive() || pointerDown || state.scrolling) return;
    state.deferredRender = false;
    renderList();
  }, 150);
});

/**
 * Снимает выделение в ленте. Нужно перед действиями пользователя, которые всё
 * равно пересобирают список (вид, фильтр, порядок, строки, ширина, настройки):
 * иначе «висящее» выделение блокировало перерисовку, и в ленте оставалось старое
 * содержимое — например, после переключения «Непрочитанные → Все».
 */
function dropListSelection() {
  if (!listSelectionActive()) return;
  window.getSelection()?.removeAllRanges();
}

// Клик вне ленты и любое переключение контрола — это явное действие: выделение
// больше не защищаем, иначе пользователь не увидит результат своего же выбора.
document.addEventListener('click', (event) => {
  if (!event.target.closest?.('#list')) dropListSelection();
}, true);
document.addEventListener('change', () => dropListSelection(), true);

/** Ставит рамку на конкретную статью и держит её, пока список не тронут руками. */
function pinActive(id, ms = 1500) {
  activePin = { id: id ?? null, until: Date.now() + ms };
}

/** Верхняя граница видимой части списка — под липкой полосой с датой. */
function contentTopY(list) {
  const listRect = list.getBoundingClientRect();
  const sep = list.querySelector('.day-sep');
  const sepHeight = sep ? Math.max(0, sep.getBoundingClientRect().height - 8) : 0;
  return listRect.top + sepHeight;
}

document.addEventListener('mousedown', () => { pointerDown = true; }, true);
document.addEventListener('mouseup', () => {
  pointerDown = false;
  // Ждём завершения события click (оно идёт сразу после mouseup), иначе
  // обработчик нажатия получит уже заменённый узел и нажатие потеряется.
  // Если в ленте осталось выделение (его только что протянули мышью), перерисовку
  // не делаем: ждём, пока выделение снимут — иначе оно исчезало бы сразу после drag.
  if (renderPending) setTimeout(() => {
    if (!renderPending || listSelectionActive()) return;
    renderPending = false;
    renderList();
  }, 0);
}, true);

state.filling = false;

/**
 * Если после отрисовки список короче экрана, прокручивать нечего и догрузка по
 * прокрутке не сработает — значит порцию надо увеличить сразу.
 */
/**
 * Пока картинка грузится, держим под неё место заглушкой — иначе текст прыгает,
 * когда изображения догружаются. Как только картинка пришла, заглушка снимается.
 */
/**
 * Широкая картинка (по пропорции кадра) должна занимать всю ширину текста, как на
 * сайте, а не половину ряда. Такие ряды ставим в столбик.
 */
/**
 * Если шапка карточки (заголовок, автор, метки) по высоте короче картинки,
 * краткий текст начинается под картинкой, а не справа от неё под заголовком.
 */

/** Пустые обёртки в ряду (<figure> без картинки) — лишняя ячейка, убираем. */
function dropEmptyRowCells(row) {
  for (const cell of [...row.children]) {
    if (!cell.querySelector('img, video')) cell.remove();
  }
}

function markWideRow(row, images) {
  const wide = images.some((img) => img.naturalWidth && img.naturalHeight
    && img.naturalWidth / img.naturalHeight >= 1.5);
  row.classList.toggle('wide', wide);
}

function holdImageSpace(root) {
  // Картинкам статьи НЕ ставим заглушку с принудительными пропорциями: вокруг
  // реального изображения она создавала блок, который после загрузки схлопывался,
  // и картинка «исчезала». Место резервирует сам <img> (у него задана высота).
  for (const img of root.querySelectorAll('.a-body img, .comment-body img')) {
    // Картинки в «местах под картинку» грузятся своим кодом.
    if (img.hasAttribute('data-lazy-img') || img.closest('.img-slot')) continue;
    if (img.dataset.hold === '1' || img.complete) continue;
    img.dataset.hold = '1';
  }
  for (const row of root.querySelectorAll('.img-row')) {
    const images = [...row.querySelectorAll('img')];
    if (!images.length) continue;
    const done = () => {
      if (images.every((img) => img.complete)) {
      row.classList.add('ready');
      row.classList.remove('waiting');
      dropEmptyRowCells(row);
      markWideRow(row, images);
    }
    };
    if (images.every((img) => img.complete)) row.classList.add('ready');
    else {
      row.classList.add('waiting');
      for (const img of images) img.addEventListener('load', done), img.addEventListener('error', done);
      // Если картинки так и не пришли, через 3 секунды освобождаем место:
      // иначе в статье оставалось большое белое поле.
      setTimeout(() => {
        if (!row.classList.contains('waiting')) return;
        row.classList.add('ready');
        row.classList.remove('waiting');
        for (const img of images) if (!img.naturalWidth) img.classList.add('broken');
      }, 3000);
    }
  }
}

/** Просит сервер докачать тексты и складывает статьи в кэш service worker. */
/** Режим «как клиент Fever»: работает только синхронизация, без подгрузки. */
function feverMode() {
  return Boolean(state.settings?.feverMode);
}

function fillViewport() {
  if (state.filling) return;
  const listEl = $('#list');
  if (!listEl) return;
  const total = visibleItems().length;
  if (state.limit >= total) return;
  if (listEl.scrollHeight > listEl.clientHeight + 120) return;
  state.filling = true;
  // Дозагрузка не должна сдвигать ленту: запоминаем позицию и высоту и после
  // перерисовки возвращаем прокрутку туда же.
  const beforeHeight = listEl.scrollHeight;
  const beforeTop = listEl.scrollTop;
  state.limit = Math.min(total, state.limit + 10);
  renderList();
  const grown = $('#list');
  if (grown && beforeTop > 0) {
    grown.scrollTop = beforeTop + Math.max(0, grown.scrollHeight - beforeHeight);
  }
  state.filling = false;
  fillViewport();
}

/**
 * Пока список прокручивается, фоновые задачи (перерисовка, догрузка тел, опрос
 * сервера, счётчики комментариев, прогрев кэша) не запускаются: они отнимают
 * кадры и дают рывки. Всё отложенное выполняется, когда прокрутка затихла.
 */
function beginScrollWork() {
  state.scrolling = true;
  clearTimeout(state.scrollIdleTimer);
  state.scrollIdleTimer = setTimeout(() => {
    state.scrolling = false;
    flushScrollWork();
  }, 220);
}

/** Выполняет то, что отложили на время прокрутки. */
function flushScrollWork() {
  if (state.scrolling) return;
  if (state.deferredRender) { state.deferredRender = false; renderList(); }
  if (state.deferredBodies) { state.deferredBodies = false; ensureBodiesNeeded(); }
  if (state.deferredPoll) { state.deferredPoll = false; loadData({ poll: true }); }
}

/**
 * Картинка не загрузилась — помечаем и убираем её, чтобы не оставалось
 * пустого места «под рисунок». Заодно убираем опустевшие абзацы.
 */
function markBrokenImages(root = document) {
  for (const img of root.querySelectorAll('.a-body img, .comment-body img')) {
    // У картинки в слоте ещё нет src — проверка сочла бы её битой и скрыла.
    if (img.hasAttribute('data-lazy-img') || img.closest('.img-slot')) continue;
    if (img.dataset.brokenCheck === '1') continue;
    img.dataset.brokenCheck = '1';
    const kill = () => {
      img.classList.add('broken');
      const box = img.closest('p, figure');
      if (box && !box.textContent.trim() && !box.querySelector('img:not(.broken), video, iframe')) box.classList.add('empty-box');
    };
    if (img.complete && img.naturalWidth === 0) kill();
    else img.addEventListener('error', kill, { once: true });
  }
}

/**
 * Догружает обложки для карточек без картинки: по одной, не чаще раза в 1.5 с,
 * только для видимых карточек. Сервер достаёт картинку из текста статьи.
 */
const coverQueue = [];
let coverBusy = false;
function queueCoverFetches() {
  // Работаем только в виде «кратко + картинка»: в других видах миниатюры не нужны.
  if (!document.querySelector('#list .article.compact-thumb')) return;
  for (const item of visibleItems().slice(0, state.limit)) {
    if (item.image || item.coverAsked) continue;
    if (String(feedById(item.feedId)?.kind ?? '').startsWith('telegram')) continue;
    item.coverAsked = true;
    coverQueue.push(item.id);
  }
  pumpCoverQueue();
}

async function pumpCoverQueue() {
  if (coverBusy) return;
  const id = coverQueue.shift();
  if (!id) return;
  coverBusy = true;
  try {
    const res = await api(`/api/cover?id=${encodeURIComponent(id)}`);
    if (res?.image) {
      const item = state.data.items.find((i) => i.id === id);
      if (item) { item.image = res.image; patchCard(id); }
    }
  } catch { /* обложка не критична */ }
  coverBusy = false;
  if (coverQueue.length) setTimeout(pumpCoverQueue, 1500);
}

/**
 * Перерисовывает ОДНУ карточку, не трогая остальной список. Пока человек читает
 * ленту, список пересобираться не должен: полная перерисовка сбрасывала позицию
 * и «проматывала» статьи в прочитанные.
 */
/**
 * Перерисовывает только блок комментариев в карточке, не трогая список.
 * Полная пересборка (renderList) сбрасывала прокрутку, и лента прыгала вверх.
 */
function patchComments(id) {
  if (listSelectionActive()) return false;   // внутри ленты выделение — не трогаем
  const row = document.querySelector(`#list .article[data-item="${cssId(id)}"]`);
  const item = state.data.items.find((i) => i.id === id);
  if (!row || !item) return false;
  const block = row.querySelector('.a-comments');
  if (!block) return false;
  const holder = document.createElement('div');
  holder.innerHTML = commentsHtml(item);
  const fresh = holder.firstElementChild;
  if (!fresh) return false;
  const list = $('#list');
  const top = block.getBoundingClientRect().top;
  block.replaceWith(fresh);
  const after = row.querySelector('.a-comments');
  if (after && list) {
    const delta = after.getBoundingClientRect().top - top;
    if (Math.abs(delta) > 1) list.scrollTop += delta;
  }
  return true;
}


function patchCard(id) {
  if (listSelectionActive()) return false;   // внутри ленты выделение — не трогаем
  const row = document.querySelector(`#list .article[data-item="${cssId(id)}"]`);
  const item = state.data.items.find((i) => i.id === id);
  if (!row || !item) return false;
  const list = $('#list');
  const top = row.getBoundingClientRect().top;
  const holder = document.createElement('div');
  holder.innerHTML = articleHtml(item);
  const fresh = holder.firstElementChild;
  if (!fresh) return false;
  row.replaceWith(fresh);
  const after = document.querySelector(`#list .article[data-item="${cssId(id)}"]`);
  if (after && list) {
    const delta = after.getBoundingClientRect().top - top;
    if (Math.abs(delta) > 1) list.scrollTop += delta;   // сохраняем позицию чтения
  }
  return true;
}

function renderList() {
  // Диагностика перерисовок: при ?debug=1 пишем стек вызовов, чтобы по факту
  // видеть, кто пересобирает ленту (опрос, события, действия, догрузка).
  if (DEBUG) {
    (window.__renderLog ||= []).push({
      at: Date.now(),
      selection: (window.getSelection()?.toString() ?? '').length,
      stack: (new Error().stack ?? '').split('\n').slice(2, 7).map((line) => line.trim().replace(/^at /, '')).join(' ← '),
    });
    if (window.__renderLog.length > 200) window.__renderLog.shift();
  }
  // Пока раздел догружается, вместо списка показываем заглушку.
  if (state.loadingView) {
    const loadingEl = $('#list');
    if (loadingEl) loadingEl.innerHTML = '<div class="a-loading">Загружаю статьи…</div>';
    // снимок не трогаем: список построится после загрузки
    ignoreScrollUntil = Date.now() + 900;
    return;
  }
  // Выделил текст в ленте — список не меняем совсем: ни по опросу, ни по событиям,
  // ни по догрузке. Всё, что пришло, выполним, когда выделение снимут. Дерево и
  // плашка «Новых статей» обновляются отдельно, по ним и видно, что пора обновить.
  if (listSelectionActive()) { state.deferredRender = true; return; }
  if (pointerDown) { renderPending = true; return; }
  if (state.scrolling) { state.deferredRender = true; return; }
  const listEl = $('#list');
  // Панель списка иногда оказывается прокрученной (см. scrollInList): у неё нет
  // полосы прокрутки, и шапка с поиском оставалась за краем экрана до перезагрузки.
  const paneEl = document.querySelector('.list-pane');
  if (paneEl && paneEl.scrollTop) paneEl.scrollTop = 0;
  // При смене ленты/папки список показываем с начала — от новых статей.
  const reset = state.resetScroll;
  state.resetScroll = false;
  // Запоминаем «якорь»: видимые статьи с их положением на экране. После перерисовки
  // выравниваем список по первой из них, которая осталась, — иначе он «сам листается».
  let anchors = [];
  if (!reset) {
    const listTop = listEl.getBoundingClientRect().top;
    const listBottom = listEl.getBoundingClientRect().bottom;
    for (const row of listEl.querySelectorAll('.article[data-item]')) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom < listTop + 4) continue;            // уже выше экрана
      if (rect.top > listBottom) break;                    // ниже экрана — дальше смысла нет
      anchors.push([row.dataset.item, rect.top]);
    }
  }
  const emptyEl = $('#empty-state');
  const all = visibleItems();

  if (!state.data.feeds.length) {
    listEl.innerHTML = '';
    emptyEl.hidden = false;
    emptyEl.innerHTML = 'Подписок пока нет.<br>Нажмите «＋ подписка» слева — адрес проверится, и можно выбрать нужные ленты.';
    return;
  }
  if (!all.length) {
    listEl.innerHTML = '';
    emptyEl.hidden = false;
    emptyEl.textContent = state.query ? 'Ничего не найдено по запросу.' : 'Здесь нет статей.';
    return;
  }
  emptyEl.hidden = true;

  const items = all.slice(0, state.limit);
  let html = '';
  let lastGroup = null;
  for (const item of items) {
    // В «Избранном» разделитель дня — дата добавления в избранное, а не дата поста.
    const groupDate = state.view.type === 'starred' && item.starredAt
      ? new Date(Number(item.starredAt)).toISOString()
      : item.date;
    const group = dayLabel(groupDate);
    if (group !== lastGroup) { html += `<div class="day-sep">${esc(group)}</div>`; lastGroup = group; }
    html += articleHtml(item);
  }
  if (all.length > items.length) html += `<div class="a-loading">показано ${items.length} из ${all.length} — прокрутите ниже</div>`;
  listEl.innerHTML = html;
  if (reset) listEl.scrollTop = 0;
  else {
    // Берём первый якорь, который после перерисовки на месте: если статью
    // убрали из списка, выравниваемся по следующей видимой.
    for (const [id, top] of anchors) {
      const again = listEl.querySelector(`.article[data-item="${cssId(id)}"]`);
      if (!again) continue;
      listEl.scrollTop += again.getBoundingClientRect().top - top;
      break;
    }
  }
  // Сразу после перерисовки ничего не помечаем прочитанным — только по реальной прокрутке.
  ignoreScrollUntil = Date.now() + 700;
  positionArticleActions();
  scrollBaseline = listEl.scrollTop;
  if (state.manualUnread) state.manualUnread.lastTop = listEl.scrollTop;
  // Вход в ленту/раздел: рамка — на верхней статье, а не на той, что попала под линию чтения.
  if (reset) pinActive(listEl.querySelector('.article[data-item]')?.dataset.item ?? null);
  ensureBodiesNeeded();
  setupReadObservers();
  requestCommentCounts();
  fillViewport();          // если карточек меньше экрана — догружаем сразу
  holdImageSpace(listEl);  // заглушки на месте ещё не загруженных картинок
  setupImageSlots(listEl); // места под картинки: автоподгрузка и кнопка на случай отказа
  markBrokenImages(listEl); // пустое место от не загрузившихся картинок
  queueCoverFetches();    // карточки без обложки — догружаем по одной
  // Класс text-under-thumb больше не переключается: он менял высоту карточки
  // после загрузки превью, из-за чего лента прыгала. Теперь это задаёт CSS.
  updateActiveArticle();
  refreshStaleComments();  // открытые комментарии догоняют счётчик сайта

  layoutArticleImages();
  // Служебная строка «сколько медиа» нужна только при разборе проблем: в обычной
  // жизни она занимает место под текстом статьи.
  if (DEBUG) showMediaCounters();
  setupEmbeds();
}

/** Обновляет только отметки времени, не трогая остальной список. */
function refreshTimes() {
  for (const el of $('#list').querySelectorAll('[data-time]')) {
    const iso = el.dataset.time;
    if (iso) el.textContent = timeAgo(iso);
  }
}

/**
 * Подсвечивает статью, которая читается сейчас: это верхняя видимая карточка.
 * Если список не прокручивали, а просто перерисовали (подгрузился текст, картинка),
 * рамка остаётся на прежней статье — так она не моргает.
 */
/** Числа в подвале: сколько статей считаем прочитанными и сколько отметок в очереди. */
function updateFooterStats() {
  const label = document.querySelector('#sidebar-version');
  if (!label) return;
  const styleTag = document.querySelector('link[rel="stylesheet"]');
  const styleVersion = /v=(\d+)/.exec(styleTag?.href ?? '')?.[1] ?? '?';
  const pendingCount = pendingReads.size;
  const traffic = state.traffic ?? { total: 0, list: 0, images: 0, bodies: 0, label: '' };
  const problem = state.listError || state.lastError || state.refreshError || '';
  // title приходит из данных (ошибки лент, названия), поэтому экранируем: иначе
  // кавычка в тексте ломала разметку подвала.
  const icon = (mark, title, extra = '') => `<span class="foot-ico${extra}" title="${esc(title)}">${mark}</span>`;
  // Только версия разбора (без «1.»): она меняется, когда меняется разбор текста.
  const parseVersion = String(state.serverVersion ?? '').split('.').pop() || '?';
  // Время сборки сервера: по нему видно, что серверные правки уже на месте.
  const serverBuildAt = state.serverBuild ? new Date(state.serverBuild) : null;
  const serverBuildText = serverBuildAt && !Number.isNaN(serverBuildAt.getTime())
    ? serverBuildAt.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '';
  const versionTitle = esc('Клиент ' + APP_VERSION + ', стили ' + styleVersion + ', версия разбора ' + parseVersion
    + (serverBuildText ? ', сервер обновлён ' + serverBuildText : ''));
  const trafficTitle = esc('Трафик ленты' + (traffic.label ? ` «${traffic.label}»` : '') + ': '
    + sizeLabel(traffic.total) + ' (данные ' + sizeLabel(traffic.list)
    + ', тексты ' + sizeLabel(traffic.bodies)
    + ', картинки ' + sizeLabel(traffic.images) + ')');
  label.innerHTML = `<span title="${versionTitle}">` + APP_VERSION + '.' + styleVersion + '.' + parseVersion + '</span>'
    + ' · ' + icon('⇣', trafficTitle) + ' ' + sizeLabel(traffic.total)
    + ' · ' + icon('⇅', 'Отметок в очереди на отправку') + ' ' + pendingCount
    + ' · ' + (problem
      ? icon('⚠', 'Ошибка: ' + problem, ' warn')
      : icon('✓', 'Ошибок нет', ' ok'));
}

/** Байты в короткую подпись: 812 Б, 24 КБ, 1.8 МБ. */
// ------- учёт трафика: сколько реально пришло по сети за сессию -------
// Берём transferSize из Performance API: это сжатый размер с учётом кэша
// (повторный ответ из кэша даёт 0, то есть трафика не было).
// Учёт трафика текущего раздела: считаем ВСЁ, что приходит после открытия
// ленты, — данные, картинки, тексты. При переключении ленты счётчик с нуля.
state.traffic = { from: 0, total: 0, list: 0, images: 0, bodies: 0, label: '' };
function noteTraffic(entry) {
  const bytes = Number(entry.transferSize) || 0;
  if (!bytes || !state.traffic.from) return;
  if (entry.startTime < state.traffic.from) return;   // загружено до открытия ленты
  const url = entry.name || '';
  state.traffic.total += bytes;
  if (url.includes('/api/items') || url.includes('/api/data')) state.traffic.list += bytes;
  else if (url.includes('/api/bodies')) state.traffic.bodies += bytes;
  else if (/\.(webp|jpe?g|png|gif|avif)(\?|$)/i.test(url) || url.includes('/api/cover') || url.includes('/api/media')) state.traffic.images += bytes;
  updateFooterStats();
}
try {
  new PerformanceObserver((list) => { for (const entry of list.getEntries()) noteTraffic(entry); })
    .observe({ type: 'resource', buffered: true });
} catch { /* старый браузер — обойдёмся без учёта */ }

function sizeLabel(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' Б';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' КБ';
  return (n / (1024 * 1024)).toFixed(1) + ' МБ';
}
function updateActiveArticle() {
  const list = $('#list');
  if (!list) return;
  const listRect = list.getBoundingClientRect();
  const scrollNow = list.scrollTop;
  // Граница видимой части списка — под липкой полосой с датой.
  const lineY = contentTopY(list);
  // Собираем только те статьи, что реально видны на экране: подсвечивать статью,
  // до которой ещё не домотали, нельзя — иначе рамка «убегала» вниз и та статья
  // отмечалась прочитанной, хотя её ещё никто не видел.
  const visible = [];
  for (const row of list.querySelectorAll('.article[data-item]')) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom < listRect.top + 16) continue;     // уже ушла выше экрана
    if (rect.top > listRect.bottom - 4) break;         // ещё ниже экрана
    visible.push({ row, rect });
  }
  // Площадь видимой части статьи — по ней выбираем, что читается сейчас.
  const visibleArea = (entry) => Math.max(0,
    Math.min(entry.rect.bottom, listRect.bottom) - Math.max(entry.rect.top, contentTopY(list)));
  // Активная — статья, пересекающая линию чтения. Правила по порядку:
  //  1) если рамку только что поставили (вход в ленту, кнопка «Следующая») — она там;
  //  2) если список не прокручивали, а перерисовали — не двигаем (иначе мигает);
  //  3) если текущая статья ещё пересекает линию — остаётся текущей (гистерезис,
  //     иначе короткая первая карточка сразу уступала бы место второй);
  //  4) иначе — статья под линией.
  let lineTarget = null;
  for (const entry of visible) {
    if (entry.rect.top >= lineY - 1) { lineTarget = entry; break; }
  }
  if (!lineTarget) lineTarget = visible[visible.length - 1] ?? null;
  const pinned = activePin.id && Date.now() < activePin.until
    ? visible.find(({ row }) => row.dataset.item === activePin.id) ?? null
    : null;
  const current = activeMeta.id
    ? visible.find(({ row }) => row.dataset.item === activeMeta.id) ?? null
    : null;
  const keep = current && activeMeta.scrollTop === scrollNow;

  // Среди видимых берём самую крупную на экране: у длинных раскрытых статей это
  // та, которую читают, и рамка не перескакивает на следующую слишком рано.
  // Активная — верхняя карточка, которая видна достаточно, чтобы её читали.
  // Для коротких карточек это первая видимая (иначе рамка «перепрыгивала» через
  // одну), для длинных раскрытых — та, что занимает заметную часть экрана.
  let best = null;
  for (const entry of visible) {
    const area = visibleArea(entry);
    const height = Math.max(1, entry.rect.height);
    if (area >= Math.min(height * 0.35, 140)) { best = entry; break; }
  }
  if (!best) best = lineTarget ?? visible[0] ?? null;
  const target = pinned ?? (keep ? current : best);
  const activeId = target ? target.row.dataset.item : null;
  // Отмечаем всё, что уже пролистано: низ статьи поднялся выше линии чтения.
  // Так работает при любой прокрутке (колесо, палец, клавиши, перетаскивание
  // полосы) и не зависит от того, успела ли переехать рамка.
  // Отмечаем только по свежей прокрутке человека: после пересборки карточки могут
  // «прыгнуть» выше линии чтения, и раньше они разом уходили в прочитанные.
  const scrolledRecently = Date.now() >= ignoreScrollUntil && Date.now() - userScrollAt < 1500;
  if (state.prefs.readOnScroll && scrolledRecently) {
    for (const entry of visible) {
      if (entry.rect.top >= lineY - 1) continue;   // ещё не спряталась под шапку
      const id = entry.row.dataset.item;
      const item = state.data.items.find((i) => i.id === id);
      if (item && !item.read) markReadOnce(id, true);
    }
  }
  // Дополнительное правило: рамка перешла на статью — она тоже прочитана.
  // activeMeta.id здесь ещё хранит прежнюю статью: ниже он обновится.
  // Рамка перешла на статью — она прочитана, но только если рамку сдвинула
  // прокрутка пользователя, а не вход в ленту или кнопка «Следующая».
  const fromUserScroll = Date.now() - userScrollAt < 900 && Date.now() >= activePin.until;
  if (state.prefs.readOnScroll && fromUserScroll
    && activeMeta.id && activeMeta.id !== activeId && activeId) {
    markReadOnce(activeId, true);   // внутри markReadOnce ручные отметки уже учтены
  }
  // Плавающие кнопки — у активной статьи (той, что сейчас читается), даже если
  // лента раскрывает статьи по умолчанию и «выбранной» никто не назначал.

  positionArticleActions();   // ставим кнопки сразу, без промежуточного кадра

  for (const row of list.querySelectorAll('.article.active')) {
    if (row.dataset.item !== activeId) row.classList.remove('active');
  }
  // Запоминаем, на какой статье рамка: по ней же поставится отметка о прочтении,
  // если после этого список поедет.
  state.activeId = activeId;
  if (activeId) state.framedIds.add(activeId);
  // Запоминаем положение списка: если перерисовка не сдвинула его, рамку не меняем.
  activeMeta = { id: activeId, scrollTop: scrollNow };
  if (!activeId) return;
  const target2 = list.querySelector(`.article[data-item="${cssId(activeId)}"]`);
  if (target2 && !target2.classList.contains('active')) target2.classList.add('active');
}

/**
 * Плавающие кнопки у открытой статьи. Кнопки «отклеены» от карточки (position: fixed)
 * и живут в координатах экрана: скрипт ставит их под шапкой и не даёт уехать ниже
 * конца карточки. Так работает везде — sticky в Safari ненадёжен.
 */
function positionArticleActions() {
  const list = $('#list');
  if (!list) return;
  const listRect = list.getBoundingClientRect();
  const wantedTop = listRect.top + 48;                  // под шапкой
  const activeId = state.activeId;
  // Проходим по ВСЕМ карточкам: плавает ровно одна — активная, видимая и не уходящая.
  // Остальным возвращаем обычное место внутри карточки.
  for (const actions of list.querySelectorAll('.article[data-item] .a-actions')) {
    const card = actions.closest('.article');
    if (!card) continue;
    const isActive = card.dataset.item === activeId && card.classList.contains('expanded');
    const cardRect = card.getBoundingClientRect();
    const height = actions.offsetHeight || 0;
    const visible = cardRect.bottom > listRect.top + 8 && cardRect.top < listRect.bottom;
    const leaving = cardRect.bottom < listRect.top + 120;
    if (!isActive || !visible || leaving) {
      actions.classList.remove('floating');
      actions.style.position = '';
      actions.style.top = '';
      actions.style.right = '';
      actions.style.left = '';
      actions.style.visibility = '';
      actions.style.display = '';
      continue;
    }
    const lowest = cardRect.bottom - 140 - height;       // «рельс» заканчивается выше конца
    const top = Math.max(listRect.top + 8, Math.min(wantedTop, lowest));
    // Если статью прокрутили вверх так, что её начало ушло за экран,
    // кнопки убираем: иначе они висят «в пустоте» над текстом.
    // Кнопки остаются на месте при прокрутке статьи: скрывать их не нужно,
    // иначе после небольшой прокрутки они «пропадали» и не нажимались.
    actions.style.visibility = 'visible';
    actions.style.pointerEvents = 'auto';
    actions.style.display = '';
    actions.style.position = 'fixed';
    actions.style.top = `${Math.round(top)}px`;
    actions.style.right = `${Math.round(window.innerWidth - listRect.right + 20)}px`;
    actions.style.left = 'auto';
    actions.style.visibility = 'visible';
  }
}

/** То же, но не чаще одного раза за кадр — прокрутка шлёт события очень часто. */
let activeFrame = null;
function scheduleActiveArticle() {
  if (activeFrame) return;
  activeFrame = requestAnimationFrame(() => {
    activeFrame = null;
    updateActiveArticle();
    positionArticleActions();
  });
}

// ------------------------------------------- автоматическая отметка прочитанного

let listObserver = null;
const seenItems = new Set();
const markedRecently = new Map();   // id → время последней попытки отметки

/**
 * Статья, которую вручную сделали непрочитанной. Автоматические правила не
 * трогают её, пока список не сдвинули с того места, где её отметили.
 */

/** Эту статью сейчас нельзя отмечать прочитанной автоматически? */

/** Автоматике можно трогать эту статью? */
function autoReadAllowed(id) {
  return !manualRead.has(id);
}

/**
 * «Заморозка» ленты на время чтения: пока список не разморожен явно (смена
 * ленты, обновление, кнопка «показать» новые), состав статей не меняется —
 * новые статьи только увеличивают счётчик. Так отметки «прочитано» не могут
 * уехать на соседнюю статью.
 */


/** Статья входит в текущий список (снимок) — только такие можно отмечать. */

function markReadOnce(id, read = true) {
  // Повторные отметки в пределах нескольких секунд не шлём, но и не блокируем
  // статью навсегда: запись «когда пытались» сама устаревает.
  const now = Date.now();
  if (!autoReadAllowed(id)) return;                  // по этой статье решал человек — не спорим
  if (now - (markedRecently.get(id) ?? 0) < 4000) return;
  const item = state.data.items.find((i) => i.id === id);
  if (!item || item.read === read) return;
  markedRecently.set(id, now);
  markRead([id], read, { silent: true }).catch(() => markedRecently.delete(id));
}

/** Следит за прокруткой: статья ушла вверх — прочитана; доскроллили до конца — прочитана. */
function setupReadObservers() {
  if (listObserver) { listObserver.disconnect(); listObserver = null; }
  if (!state.prefs.readOnScroll && !state.prefs.readOnFinish) return;
  const root = $('#list');
  listObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const endId = entry.target.dataset.end;
      if (endId) {
        // «До конца» тоже отмечаем только те статьи, на которых была рамка: если
        // раскрыто несколько статей, конец нижней попадал в кадр и она отмечалась
        // прочитанной, хотя её никто не читал.
        if (entry.isIntersecting && state.prefs.readOnFinish && userScrolled
          && Date.now() - userScrollAt < 700 && state.framedIds.has(endId) && seenItems.has(endId)) markReadOnce(endId);
        continue;
      }
      const id = entry.target.dataset.item;
      if (!id) continue;
      if (entry.isIntersecting) seenItems.add(id);
    }
  }, { root, threshold: [0, 0.3, 0.9] });
  for (const el of root.querySelectorAll('.article[data-item]')) listObserver.observe(el);
  for (const el of root.querySelectorAll('[data-end]')) listObserver.observe(el);
}

/**
 * Отметка при прокрутке: статья считается прочитанной, когда её низ поднялся
 * почти к верхнему краю списка, и только после настоящей прокрутки пользователем.
 */
let scrollCheckScheduled = false;
let ignoreScrollUntil = 0;      // после перерисовки ничего не отмечаем
let userScrolled = false;       // листал ли пользователь список сам
let userScrollAt = 0;           // когда это было: отличает прокрутку от скачков вёрстки
let scrollBaseline = 0;   // положение списка на момент последней отрисовки
let scrollSettleTimer = null;   // проверка после остановки прокрутки

// На телефоне после отпускания пальца список ещё катится по инерции: события
// touchmove при этом не приходят, и прокрутка переставала считаться «своей».
// Запоминаем касание и продолжаем считать движение руки свежим.
// Временная диагностика: последняя ошибка клиента видна в подвале.
window.addEventListener('error', (event) => {
  state.lastError = String(event.message ?? 'ошибка').slice(0, 80);
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  state.lastError = String(reason?.message ?? reason ?? 'отказ').slice(0, 80);
});
let lastTouchAt = 0;
document.getElementById('list')?.addEventListener('scroll', () => {
  if (lastTouchAt && Date.now() - lastTouchAt < 1500) userScrollAt = Date.now();
}, { passive: true });
for (const type of ['wheel', 'touchmove', 'touchstart', 'touchend', 'pointerdown']) {
  document.getElementById('list')?.addEventListener(type, () => {
    lastTouchAt = Date.now();
    userScrolled = true;
    userScrollAt = Date.now();
    activePin.until = 0;          // человек сам взялся за список — закрепление снимаем
  }, { passive: true });
}
document.addEventListener('keydown', (event) => {
  if (/^(PageDown|PageUp|ArrowDown|ArrowUp|Home|End| )$/.test(event.key)) {
    userScrolled = true;
    userScrollAt = Date.now();
    activePin.until = 0;
  }
});

function scheduleScrollReadCheck() {
  if (scrollCheckScheduled || !state.prefs.readOnScroll) return;
  scrollCheckScheduled = true;
  requestAnimationFrame(() => {
    scrollCheckScheduled = false;
    checkScrolledPast();
  });
}

function checkScrolledPast() {
  if (!userScrolled) return;
  // Прокрутка должна быть свежей и рукой: скачки вёрстки после перерисовки
  // (выравнивание по якорю) ничего не отмечают.
  if (Date.now() - userScrollAt > 1500) return;
  const list = $('#list');
  if (Math.abs(list.scrollTop - scrollBaseline) < 8) return;
  // Отмечаем только пролистанные статьи: низ статьи должен уйти выше линии
  // чтения. Раньше отмечалась просто активная — и прочитанными становились те,
  // которые ещё читаются.
  const activeId = state.activeId;
  if (!activeId) return;
  const item = state.data.items.find((i) => i.id === activeId);
  if (!item || item.read) return;
  const row = list.querySelector(`.article[data-item="${cssId(activeId)}"]`);
  const rect = row?.getBoundingClientRect();
  if (!rect || rect.top >= contentTopY(list) - 1) return;
  markReadOnce(activeId, true);
}

/** Сигнал «не дольше N мс». В старых Safari нет AbortSignal.timeout — обходимся контроллером. */
function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  if (typeof AbortController === 'undefined') return undefined;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/** Тело считается загруженным только после ответа сервера (loaded: true).
 *  Раньше пустышку клали в кэш заранее — и статья не запрашивалась вовсе. */
const isBodyLoaded = (id) => Boolean(state.bodies.get(id)?.loaded);

/** Подгружает тела раскрытых статей пачкой. */
/** Играет ли сейчас видео в статье — перерисовка списка его бы «схлопнула». */
function videoPlaying() {
  for (const video of document.querySelectorAll('.a-body video, .video-overlay video')) {
    if (!video.paused && !video.ended) return true;
  }
  return false;
}

/** Отложенная перерисовка: сделаем её, когда видео остановится. */
function renderListSoon() {
  if (videoPlaying()) { state.renderAfterVideo = true; return; }
  renderList();
}

document.addEventListener('pause', () => {
  if (!state.renderAfterVideo) return;
  setTimeout(() => { if (!videoPlaying()) { state.renderAfterVideo = false; renderList(); } }, 400);
}, true);

async function ensureBodiesNeeded(force = false) {
  // Режим Fever: при листании тексты не докачиваем вовсе — только когда
  // пользователь сам раскрыл статью (тогда вызывается с force).
  if (feverMode() && !state.bodiesAllowed && !force) return;
  // Если загрузка уже идёт, ждём её, а не выходим сразу: раньше второй вызов
  // (например, из expandItem) возвращался мгновенно, и карточка оставалась
  // с пустым телом — при том что первая загрузка ещё продолжалась.
  if (state.loadingBodies) return state.bodiesPromise ?? undefined;
  if (state.scrolling) { state.deferredBodies = true; return; }
  const items = visibleItems().slice(0, state.limit);
  const need = items.filter((i) => isExpanded(i) && !isBodyLoaded(i.id)).map((i) => i.id);
  if (!need.length) return;
  state.loadingBodies = true;
  state.bodiesPromise = (async () => {
  try {
    // Свой таймаут: зависший запрос раньше оставлял «Загрузка текста…» навсегда.
    state.bodyRetryCount = 0;                 // тела пришли — счётчик повторов сбрасываем
    const payload = await api('/api/bodies', { ids: need.slice(0, 60) }, { signal: timeoutSignal(10000) });
    for (const [id, body] of Object.entries(payload.bodies ?? {})) {
      state.bodies.set(id, { ...body, loaded: true });
      // Сервер сообщает, есть ли реально скачанный текст: правим метку «скачан».
      const item = state.data.items.find((i) => i.id === id);
      if (item) item.hasFull = Boolean(body.hasFull);
    }
    // Пустой ответ не считаем окончательным: сервер мог не успеть, и статья
    // навсегда оставалась «без текста», хотя текст есть. Пробуем до трёх раз.
    for (const id of need) {
      if (state.bodies.has(id)) continue;
      const tries = (state.bodyTries.get(id) ?? 0) + 1;
      state.bodyTries.set(id, tries);
      state.bodies.set(id, { content: '', fullHtml: '', loaded: tries >= 3 });
    }
    renderListSoon();
  } catch (err) {
    // Не ругаемся вслух: текст — не критичная часть, а тост только мешает.
    console.warn('не удалось загрузить текст статей:', err?.message ?? err);
    // Разрешаем повтор: тех, кому ответ не пришёл, спрашиваем снова через 3 секунды.
    for (const id of need) if (!state.bodies.has(id)) state.bodies.delete(id);
    // Повторяем не бесконечно: три попытки, потом ждём следующего раскрытия статьи.
    state.bodyRetryCount = (state.bodyRetryCount ?? 0) + 1;
    if (state.bodyRetryCount <= 3 && !state.bodyRetryTimer) {
      state.bodyRetryTimer = setTimeout(() => {
        state.bodyRetryTimer = null;
        ensureBodiesNeeded();
      }, 3000);
    }
  } finally {
    state.loadingBodies = false;
    state.bodiesPromise = null;
  }
  })();
  return state.bodiesPromise;
}

// ------------------------------------------------------------------ докачка

/** Догружает полный текст статьи со страницы. */
async function fetchFull(id, silent = false) {
  const item = state.data.items.find((i) => i.id === id);
  if (!item) return;
  const previous = state.bodies.get(id) ?? { content: '', fullHtml: '' };
  state.bodies.set(id, { ...previous, note: 'Докачиваю текст со страницы статьи…' });
  if (!patchCard(id)) renderList();   // только эта карточка — без прыжка ленты
  try {
    // Кнопка «Докачать текст» просит сервер попробовать заново (force): иначе
    // сервер отвечал «недавно пробовали» и ничего не скачивал.
    const res = await api('/api/fetch-full', silent ? { id } : { id, force: true });
    if (res.data) rememberData(res.data);
    const fresh = (state.data.items ?? []).find((i) => i.id === id);
    if (fresh) {
      fresh.hasFull = Boolean(res.item?.fullHtml);
      // Сервер мог достать из статьи картинку-обложку: подставляем её в карточку,
      // иначе миниатюра появлялась только после перезагрузки страницы.
      if (!fresh.image && res.item?.image) fresh.image = res.item.image;
      if (!fresh.excerpt && res.item?.excerpt) fresh.excerpt = res.item.excerpt;
    }
    state.bodies.set(id, { content: res.item?.content ?? '', fullHtml: res.item?.fullHtml ?? '', tried: true, loaded: true });
    if (!patchCard(id)) renderList();   // только эта карточка, без прыжка
    if (!silent) toast(res.ok ? 'Полный текст докачан' : `Не получилось: ${res.error ?? 'текст не найден'}`, !res.ok);
  } catch (err) {
    state.bodies.set(id, { ...previous, note: `Не удалось докачать: ${err.message}`, loaded: true });
    if (!patchCard(id)) renderList();   // только эта карточка, без прыжка
    toast(err.message, true);
  }
}

/** Раскрыть статью: если текста нет — докачать по клику. */
async function expandItem(id) {
  const item = state.data.items.find((i) => i.id === id);
  if (!item) return;
  state.selectedId = id;
  // Ранее раскрытые статьи не закрываем: их сворачивание сдвигало список
  // и место, куда вы только что нажали, уезжало вверх.
  state.commentsOnly.delete(id);
  state.collapsedItems.delete(id);
  state.expandedItems.add(id);
  if (!item.read && state.prefs.readOnExpand && autoReadAllowed(id)) markRead([id], true);
  // Fever: раскрытие статьи пользователем разрешает докачку текстов. Раньше здесь
  // же запускалась загрузка без await, второй вызов ниже выходил по «уже грузим»,
  // и карточка оставалась с пустым телом.
  if (feverMode()) state.bodiesAllowed = true;
  if (!isBodyLoaded(id)) {
    renderList();                       // покажет «Загрузка текста…»
    await ensureBodiesNeeded();
  }
  const body = state.bodies.get(id);
  if (!body?.fullHtml && !body?.content && item.link && !item.hasFull) await fetchFull(id, true);
  renderList();
}

function collapseItem(id) {
  state.expandedItems.delete(id);
  state.commentsOnly.delete(id);
  state.collapsedItems.add(id);
  // Свернул — значит закончил: в фильтре непрочитанных статья больше не удерживается.
  if (state.selectedId === id) state.selectedId = null;
  renderList();
}

/**
 * Прокрутка внутри списка статей.
 * scrollIntoView() прокручивает ВСЕ прокручиваемые предки, включая .list-pane
 * (у него overflow: hidden — полосы прокрутки нет, но программно он крутится).
 * Из-за этого шапка с поиском уезжала вверх и не возвращалась. Поэтому крутим
 * только #list, а панель принудительно держим в нуле.
 */
function scrollInList(element, align = 'start') {
  const list = $('#list');
  const pane = document.querySelector('.list-pane');
  if (pane && pane.scrollTop) pane.scrollTop = 0;
  if (!element || !list) return;
  const listRect = list.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  const inside = rect.top >= listRect.top && rect.bottom <= listRect.bottom;
  if (align === 'nearest' && inside) return;
  let delta = rect.top - listRect.top - 8;
  if (align === 'center') delta = rect.top - listRect.top - (listRect.height - rect.height) / 2;
  if (!Number.isFinite(delta)) return;
  list.scrollTo({ top: Math.max(0, list.scrollTop + delta), behavior: 'smooth' });
}

/** Показать только комментарии статьи, не раскрывая её текст. */
async function showCommentsOnly(id) {
  const item = state.data.items.find((i) => i.id === id);
  if (!item) return;
  // Другие статьи не сворачиваем — иначе список прыгает.
  state.selectedId = id;
  state.collapsedItems.delete(id);
  state.commentsOnly.add(id);
  renderList();
  const element = document.querySelector(`.article[data-item="${cssId(id)}"]`);
  if (element) scrollInList(element, 'start');
  await loadComments(id, Boolean(state.comments.get(id)?.ok));
  const block = document.querySelector(`.article[data-item="${cssId(id)}"] .a-comments`);
  if (block) scrollInList(block, 'nearest');
}

/** Переход к соседней статье: текущую закрываем, следующую только показываем. */
async function goRelative(id, delta) {
  const items = visibleItems();
  const index = items.findIndex((i) => i.id === id);
  if (index < 0) return;
  const target = items[index + delta];
  if (!target) { toast(delta > 0 ? 'Это последняя статья в списке' : 'Это первая статья в списке'); return; }
  state.limit = Math.max(state.limit, Math.min(items.length, Math.max(index, index + delta) + 6));
  // Ничего не раскрываем и не сворачиваем: просто прокручиваем список к соседней
  // статье. Открывать её — отдельное решение пользователя.
  state.selectedId = target.id;
  // Кнопки старой статьи прячем сразу: после прокрутки positionArticleActions
  // вернёт их на место в карточке, а плавать будет только новая статья.
  for (const actions of document.querySelectorAll('.a-actions')) {
    actions.style.position = '';
    actions.style.top = '';
    actions.style.right = '';
    actions.style.left = '';
    actions.style.visibility = '';
    actions.style.display = 'none';
  }
  renderToolbar();
  scrollArticleToTop(document.querySelector(`.article[data-item="${cssId(target.id)}"]`));
}

/**
 * Прокручивает список так, чтобы статья встала ровно под верхними «липкими»
 * полосами (разделитель дня). Без поправки на них заголовок уезжает под полосу
 * и первая строка оказывается обрезанной.
 */
function scrollArticleToTop(el) {
  const list = $('#list');
  if (!list || !el) return;
  const listRect = list.getBoundingClientRect();
  const sep = list.querySelector('.day-sep');
  const sepHeight = sep ? Math.max(0, sep.getBoundingClientRect().height - 8) : 0;
  const top = Math.max(0, list.scrollTop + el.getBoundingClientRect().top - listRect.top - sepHeight - 2);
  // Без плавности: статья должна встать ровно под шапку сразу — как при выборе ленты.
  list.scrollTop = top;
  // Рамка — на этой же статье, как будто выбрали ленту в дереве.
  pinActive(el.dataset.item, 1200);
  activeMeta = { id: el.dataset.item, scrollTop: list.scrollTop };
  updateActiveArticle();
}

// ----------------------------------------------------------------- действия

// Отметки о прочтении при плохой связи: сначала применяем локально и запоминаем
// в очереди, потом отправляем. Нет сети — отправим при первой возможности.
const PENDING_READ_KEY = 'rss.pendingRead';
const pendingReads = new Map();

function loadPendingReads() {
  try {
    const saved = JSON.parse(localStorage.getItem(PENDING_READ_KEY) ?? '[]');
    for (const [id, read] of saved) pendingReads.set(id, Boolean(read));
  } catch { /* по умолчанию пусто */ }
}

function savePendingReads() {
  try { localStorage.setItem(PENDING_READ_KEY, JSON.stringify([...pendingReads])); } catch { /* не критично */ }
}

/** Накладывает неотправленные отметки на статьи, пришедшие с сервера. */
function applyPendingReads(items) {
  if (!pendingReads.size) return;
  for (const item of items) {
    if (pendingReads.has(item.id)) item.read = pendingReads.get(item.id);
  }
}

/** Отправляет накопленные отметки. Без сети просто попробуем позже. */
let flushingReads = false;         // идёт отправка отметок
let flushAgain = false;              // пришли новые, пока шла отправка

async function flushPendingReads() {
  // Параллельные вызовы (опрос + прокрутка + visibilitychange) слали дубли:
  // пока идёт отправка, новые отметки ждут следующего запуска.
  if (flushingReads) { flushAgain = true; return; }
  flushingReads = true;
  try {
    if (!pendingReads.size) return;
    const byValue = new Map([[true, []], [false, []]]);
    for (const [id, read] of pendingReads) byValue.get(read).push(id);
    for (const [read, ids] of byValue) {
      if (!ids.length) continue;
      try {
        const payload = await api('/api/read', { ids, read, light: true });
        if (Number.isFinite(payload?.revision)) state.revision = payload.revision;
        if (payload?.ok === false) continue;
        // Из очереди убираем ТОЛЬКО подтверждённые сервером отметки.
        // Если подтверждения нет (старый ответ, сбой) — оставляем и повторим.
        const confirmed = Array.isArray(payload?.applied) ? new Set(payload.applied) : null;
        const unknown = new Set(Array.isArray(payload?.missing) ? payload.missing : []);
        for (const id of ids) {
          if (!confirmed || confirmed.has(id) || unknown.has(id)) pendingReads.delete(id);
        }
        savePendingReads();
        if (payload?.data) rememberData(payload.data);
        updateFooterStats();   // очередь уменьшилась — показываем сразу
      } catch { /* нет сети — повторим позже */ }
    }
  } finally {
    flushingReads = false;
    if (flushAgain) { flushAgain = false; flushPendingReads().catch(() => {}); }
  }
}

loadPendingReads();
window.addEventListener('online', () => { flushPendingReads(); loadData({ poll: true }).catch(() => {}); });
// На телефоне страница замирает, как только её скрывают: неотправленные отметки
// могли потеряться. Отправляем их при уходе и при возврате, в том числе через
// sendBeacon — он переживает закрытие вкладки.
const flushNow = () => { flushPendingReads().catch(() => {}); };
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (pendingReads.size) {
      for (const [read, ids] of [[true, []], [false, []]]) {
        const list = [...pendingReads].filter(([, value]) => value === read).map(([id]) => id);
        if (!list.length) continue;
        if (read) ids.push(...list);
        try {
          navigator.sendBeacon?.('/api/read', new Blob(
            [JSON.stringify({ ids: list, read, light: true })],
            { type: 'application/json' },
          ));
        } catch { /* отправим при возврате */ }
      }
    }
  } else {
    // Вернулись к вкладке — сразу и отметки, и свежие данные: иначе после
    // обрыва связи клиент висел со старой копией до следующего опроса.
    flushNow();
    if (state.session?.authenticated) loadData({ poll: true }).catch(() => {});
  }
});
window.addEventListener('pagehide', flushNow);

/**
 * Немедленно отражает отметку на кнопке статьи: без этого при прокрутке текст
 * уходил из списка, а кнопка продолжала показывать прежнее состояние.
 */
function syncReadButton(id, read) {
  const row = document.querySelector(`.article[data-item="${cssId(id)}"]`);
  const button = row?.querySelector('[data-read]');
  if (!button) return;
  button.dataset.value = read ? '0' : '1';
  button.textContent = read ? '●' : '○';
  button.title = read ? 'Отметить непрочитанной (m)' : 'Отметить прочитанной (m)';
  row.classList.toggle('read', read);
  row.classList.toggle('unread', !read);
}
async function markRead(ids, read, { silent = false } = {}) {
  if (!ids.length) return;
  // Сразу отмечаем локально и запоминаем в очереди: при плохой связи это главное —
  // интерфейс не должен ждать сервер и не должен «терять» отметку.
  const items = state.data.items ?? [];
  for (const item of items) if (ids.includes(item.id)) item.read = read;
  // Удержанные статьи витрины живут отдельно от state.data — отметку ставим и им.
  for (const item of heldItems.values()) if (ids.includes(item.id)) item.read = read;
  for (const id of ids) syncReadButton(id, read);   // метка на кнопке — сразу
  updateFooterStats();
  for (const id of ids) pendingReads.set(id, read);
  for (const id of ids) {
    if (read) {
      keepReadVisible.add(id);
      const copy = items.find((i) => i.id === id);
      if (copy) keepReadItems.set(id, { ...copy });
    } else {
      keepReadVisible.delete(id);
      keepReadItems.delete(id);
    }
  }
  savePendingReads();
  if (silent) {
    renderSidebar();
    renderToolbar();
    // Строку обновляем точечно, чтобы не перерисовывать весь список при прокрутке.
    for (const id of ids) updateRowReadMark(id, read);
  } else render();
  await flushPendingReads();
}

/** Точечно показывает/снимает отметку «прочитано» у строки списка. */
function updateRowReadMark(id, read) {
  const row = document.querySelector(`.article[data-item="${cssId(id)}"]`);
  if (!row) return;
  row.classList.toggle('read', read);
  row.classList.toggle('unread', !read);
  // Мигания при отметке нет: статья просто становится прочитанной.
  const meta = row.querySelector('.a-meta');
  if (!meta) return;
  const chip = meta.querySelector('.read-mark');
  if (read && !chip) {
    const span = document.createElement('span');
    span.className = 'flag read-mark';
    span.textContent = '✓ прочитано';
    meta.appendChild(span);
  } else if (!read && chip) {
    chip.remove();
  }
}

/**
 * «Поделиться»: на телефоне — системное окно, на компьютере — буфер обмена,
 * а если и это недоступно, показываем адрес, чтобы скопировать вручную.
 */
async function shareItem(id) {
  const item = state.data.items.find((i) => i.id === id);
  if (!item) return;
  const url = item.link || location.href;
  const title = item.title || 'Статья';
  try {
    if (navigator.share) {
      await navigator.share({ title, url });
      return;
    }
  } catch { /* отменили или не поддержано — пробуем скопировать */ }
  try {
    await navigator.clipboard.writeText(url);
    toast('Ссылка скопирована');
  } catch {
    await askPrompt('Ссылка на статью', 'Скопируйте адрес вручную', url);
  }
}

/**
 * «Следующая статья» из плавающих кнопок (на телефоне панель со стрелками свёрнута).
 * Работает так же, как кнопка «Следующая ↓» в панели.
 */
const goNextItem = (id) => goRelative(id, 1);

/**
 * «Просмотреть видео»: подставляем плеер, который тянет видео через наш прокси.
 * Не получилось — говорим об этом и оставляем ссылку на пост в канале.
 */
function playVideo(button) {
  const source = button.dataset.video;
  if (!source) return;
  // Нажали «посмотреть видео» — пост считается прочитанным. Отмечаем точечно,
  // без перерисовки списка, иначе плеер тут же пропал бы вместе с карточкой.
  const article = button.closest('.article[data-item]');
  const id = article?.dataset.item;
  if (id) {
    // Нажали осознанно — снимаем защиту от повторов и отмечаем прочитанным.
    markedRecently.delete(id);
    markReadOnce(id, true);
  }
  const block = button.closest('.a-video') ?? button.parentElement;
  const player = document.createElement('video');
  player.controls = true;
  player.autoplay = true;
  player.playsInline = true;
  player.preload = 'metadata';
  player.className = 'a-video-player';
  player.src = `/api/video?u=${encodeURIComponent(source)}`;
  player.addEventListener('error', () => {
    block.innerHTML = '<div class="a-note">Видео не открылось — посмотрите его в самом канале.</div>';
  });
  if (block) block.replaceChildren(player);
}

/** Обновляет только вид звёздочки: статус и иконку, без перерисовки списка. */
function updateStarVisual(id, starred) {
  const row = document.querySelector(`.article[data-item="${cssId(id)}"]`);
  if (!row) return;
  row.classList.toggle('starred', Boolean(starred));
  for (const button of row.querySelectorAll('[data-star]')) {
    button.classList.toggle('on', Boolean(starred));
    button.textContent = starred ? '★' : '☆';
  }
  const badge = document.querySelector('#badge-starred');
  if (badge) badge.textContent = String(state.data?.counts?.starred ?? '') || '';
}

async function toggleStar(id, event) {
  event?.stopPropagation();
  event?.preventDefault();
  const item = state.data.items.find((i) => i.id === id);
  if (!item) return;
  const next = !item.starred;
  // Сначала показываем результат, потом отправляем: иначе при медленной сети
  // нажатие выглядело как «ничего не произошло».
  item.starred = next;
  // Запоминаем время добавления: по нему «Избранное» сортируется, иначе свежая
  // закладка уезжала вниз списка.
  if (next) item.starredAt = Date.now();
  else delete item.starredAt;
  if (state.data?.counts) {
    state.data.counts.starred = Math.max(0, Number(state.data.counts.starred ?? 0) + (next ? 1 : -1));
  }
  // В «Избранном» новая статья должна появляться сразу.
  if (next && state.view.type === 'starred' && state.snapshot?.ids) state.snapshot.ids.add(item.id);
  // Список не перерисовываем: меняем только статус и иконку, иначе карточка
  // «прыгает» на новое место (особенно при снятии звезды в «Избранном»).
  updateStarVisual(id, next);
  renderToolbar();
  try {
    const payload = await api('/api/star', { id, starred: next, light: true });
    // Сервер может отказать: статья могла быть удалена чисткой. Тогда возвращаем
    // звёздочку и счётчик на место, чтобы «в избранном» не появлялось пустых записей.
    if (payload?.ok === false) {
      item.starred = !next;
      if (state.data?.counts) {
        state.data.counts.starred = Math.max(0, Number(state.data.counts.starred ?? 0) + (next ? -1 : 1));
      }
      state.snapshot?.ids?.delete(id);
      updateStarVisual(id, !next);
      renderToolbar();
      if (payload.missing) {
        // Статьи на сервере уже нет (её убрала чистка прочитанного): убираем и карточку,
        // чтобы не оставалось «мёртвых» записей, которые нельзя ни открыть, ни сохранить.
        state.data.items = (state.data.items ?? []).filter((i) => i.id !== id);
        if (state.snapshot?.ids) state.snapshot.ids.delete(id);
        renderList();
        toast('Статьи уже нет в ленте — карточка убрана', true);
        return;
      }
      toast('Не удалось сохранить избранное', true);
      return;
    }
    if (Number.isFinite(payload?.revision)) state.revision = payload.revision;
    if (payload?.data) rememberData(payload.data);
    // В «Избранном» снятие звезды не перерисовываем сразу: нажатие могло быть
    // случайным, и статья не должна исчезать из-под пальца. Список пересоберётся
    // при переходе в другую ленту или после перезагрузки страницы.
    if (state.view.type === 'starred' && !next) {
      item.starred = false;
      pendingUnstar.add(id);
      const row = document.querySelector(`.article[data-item="${cssId(id)}"]`);
      const button = row?.querySelector('[data-star]');
      if (button) {
        button.classList.remove('on');
        button.textContent = '☆';
      }
      row?.classList.remove('starred');
      renderSidebar();
      renderToolbar();
      return;
    }
    // Список НЕ пересобираем: карточка остаётся на месте, иначе лента прыгает.
    renderSidebar();
    renderToolbar();
  } catch (err) { toast(err.message, true); }
}

async function refreshFeeds(feedId) {
  $('#refresh-all').classList.add('spin');
  try {
    const payload = await api('/api/refresh', feedId ? { id: feedId } : {});
    if (payload.busy) { toast('Обновление уже идёт'); return; }
    if (payload.started) {
      // Сервер обновляет в фоне. Ждём завершения, затем показываем новые статьи:
      // пользователь нажал «обновить» именно чтобы их увидеть.
      toast('Обновляю ленты…');
      const startedAt = Date.now();
      while (Date.now() - startedAt < 90_000) {
        await new Promise((done) => setTimeout(done, 2000));
        const check = await api(`/api/data?rev=${state.revision}`).catch(() => null);
        if (check && check.unchanged && (check.refreshing === false || !check.started)) break;
        if (check && check.changed) break;
      }
      await loadData();
      resetSnapshot();
      render();
      const added = Number(state.data.lastRefreshAdded) || 0;
      toast(added ? `Новых статей: ${added}` : 'Новых статей нет');
      return;
    }
    if (payload.data) rememberData(payload.data);
    const results = payload.results ?? [];
    const added = results.reduce((n, r) => n + (r.added ?? 0), 0);
    const failed = results.filter((r) => r.error);
    render();
    toast(failed.length
      ? `Обновлено, но ${failed.length} ${plural(failed.length, 'лента', 'ленты', 'лент')} с ошибкой`
      : (added ? `Новых статей: ${added}` : 'Новых статей нет'), failed.length > 0);
  } catch (err) { toast(err.message, true); }
  finally { $('#refresh-all').classList.remove('spin'); }
}

/** Человеческая подпись режима показа. */
function modeLabel(mode) {
  if (mode === 'full') return 'полностью';
  if (mode === 'compact-thumb') return 'кратко, с картинкой';
  return 'кратко, без картинки';
}

async function setViewMode(mode) {
  if (state.view.type === 'feed') {
    // Сразу правим ленту локально: сервер отвечает коротко, и без этого меню
    // после повторного открытия показывало старое значение.
    const feed = state.data.feeds.find((f) => f.id === state.view.id);
    if (feed) feed.view = mode;
    try {
       await applyFeedSetting({ view: mode });
      toast(`Канал показывает статьи: ${modeLabel(mode)}`);
      render();
    } catch (err) { toast(err.message, true); }
  } else {
    state.settings.defaultView = mode;
    pushSettings({ defaultView: mode });
    render();
    toast(`Режим по умолчанию: ${modeLabel(mode)}`);
  }
}

async function saveTree() {
  const payload = await api('/api/tree', {
    folders: state.data.folders.map((f, i) => ({ id: f.id, name: f.name, order: i, collapsed: state.collapsed.has(f.id) })),
    feeds: state.data.feeds.map((f, i) => ({ id: f.id, folderId: f.folderId, order: i })),
  });
  if (payload.data) rememberData(payload.data);
  // Интерфейс уже перерисован локально — ждать ответа сервера не нужно.
}

/** Сдвигает ленту на одну позицию внутри её папки: -1 вверх, +1 вниз. */
/** Переименование ленты (используется и кнопкой, и долгим тапом). */
async function renameFeedPrompt(feedId) {
  const feed = feedById(feedId);
  const name = await askPrompt('Название ленты', 'Как подписать ленту в дереве подписок', feed?.title ?? '');
  if (!name?.trim()) return;
  try { applyPayload(await api('/api/feeds/rename', { id: feed.id, title: name.trim() })); }
  catch (err) { toast(err.message, true); }
}

/** Отписка от ленты. */
async function removeFeedPrompt(feedId) {
  const feed = feedById(feedId);
  if (!(await askConfirm('Отписаться', `Отписаться от «${feed?.title ?? ''}»?`))) return;
  try {
    applyPayload(await api('/api/feeds/remove', { id: feed.id }));
    if (state.view.type === 'feed' && state.view.id === feed.id) state.view = { type: 'unread', id: null };
    state.bodies.clear();
    render();
  } catch (err) { toast(err.message, true); }
}

function moveFeed(feedId, folderId, beforeFeedId = null) {
  const feed = state.data.feeds.find((f) => f.id === feedId);
  if (!feed) return;
  feed.folderId = folderId ?? null;
  const rest = state.data.feeds.filter((f) => f.id !== feedId);
  if (beforeFeedId) {
    const index = rest.findIndex((f) => f.id === beforeFeedId);
    rest.splice(index < 0 ? rest.length : index, 0, feed);
  } else if (folderId) {
    const lastIndex = rest.reduce((acc, f, i) => (f.folderId === folderId ? i : acc), -1);
    rest.splice(lastIndex + 1, 0, feed);
  } else {
    rest.push(feed);
  }
  state.data.feeds = rest;
  renderSidebar();                      // сразу показываем новый порядок
  saveTree().catch((err) => toast(err.message, true));
}

// --------------------------------------------------------------- клавиатура

document.addEventListener('keydown', (event) => {
  if (event.target.matches('input, textarea, select')) {
    if (event.key === 'Escape') event.target.blur();
    return;
  }
  const items = visibleItems();
  const index = items.findIndex((i) => i.id === state.selectedId);
  const step = (delta) => {
    if (!items.length) return;
    const base = index < 0 ? (delta > 0 ? -1 : 0) : index;
    const position = Math.min(items.length - 1, Math.max(0, base + delta));
    state.selectedId = items[position].id;
    if (position >= state.limit) state.limit = position + 10;   // догружаем по мере надобности
    renderList();
  };
  switch (event.key) {
    case 'j': case 'n': case 'ArrowDown': event.preventDefault(); step(1); break;
    case 'k': case 'p': case 'ArrowUp': event.preventDefault(); step(-1); break;
    case ' ': event.preventDefault(); if (index >= 0) expandItem(items[index].id); break;
    case 'm': {
      const item = items.find((i) => i.id === state.selectedId);
        // Статус запоминаем ДО markRead: он мутирует item.read, и тост врал.
        if (item) {
          const nextRead = !item.read;
          markRead([item.id], nextRead).then(() => toast(nextRead ? 'Прочитано' : 'Непрочитано'));
        }
      break;
    }
    case 's': if (state.selectedId) toggleStar(state.selectedId); break;
    case 'o': {
      const item = state.data.items.find((i) => i.id === state.selectedId);
      if (item?.link) window.open(item.link, '_blank', 'noopener');
      break;
    }
    case 'u':
      if (state.view.type === 'feed') {
        state.prefs.feedUnread = { ...(state.prefs.feedUnread ?? {}), [state.view.id]: !unreadModeFor() };
      } else {
        state.prefs.unreadOnly = !unreadDefault();
      }
      savePrefs();
      state.view = { ...state.view };
      resetSnapshot();
      render();
      break;
    case 'r': refreshFeeds(null); break;
    case '/': event.preventDefault(); $('#search').focus(); break;
    case 'Escape': {
      if (state.query) { state.query = ''; $('#search').value = ''; render(); }
      else { state.selectedId = null; renderList(); }
      break;
    }
    default: break;
  }
});

// ------------------------------------------------------------------ события

$('#list').addEventListener('click', async (event) => {
  // Картинка в тексте статьи открывается на весь экран. Проверяем раньше
  // ссылок и карточки, иначе клик уводил по ссылке или раскрывал статью.
  const picture = event.target.closest('.a-body img, .comment-body img');
  if (picture) {
    event.preventDefault();
    event.stopPropagation();
    openLightbox(picture);
    return;
  }
  const star = event.target.closest('[data-star]');
  if (star) { toggleStar(star.dataset.star, event); return; }
  const shareBtn = event.target.closest('[data-share]');
  if (shareBtn) { shareItem(shareBtn.dataset.share); return; }
  const videoBtn = event.target.closest('[data-video]');
  if (videoBtn) { event.stopPropagation(); playVideo(videoBtn); return; }
  const readBtn = event.target.closest('[data-read]');
  // Явная отметка «непрочитано» должна держаться, а не отменяться через миг
  // автоматическим правилом прокрутки.
  // Запоминаем решение человека: дальше автоматика эту статью не трогает.
  if (readBtn) manualRead.set(readBtn.dataset.read, readBtn.dataset.value === '1');
  if (readBtn) {
    event.stopPropagation();
    // Отметку ставим точечно: полная перерисовка списка вызывала прыжок ленты.
    const id = readBtn.dataset.read;
    const next = readBtn.dataset.value === '1';
    readBtn.dataset.value = next ? '0' : '1';
    readBtn.textContent = next ? '●' : '○';
    markRead([id], next, { silent: true });
    return;
  }
  const fetchBtn = event.target.closest('[data-fetch]');
  if (fetchBtn) { event.stopPropagation(); fetchFull(fetchBtn.dataset.fetch); return; }
  // «К первому новому» — прокрутка сразу к earliest новому комментарию.
  const jumpNew = event.target.closest('[data-comments-jump]');
  if (jumpNew) {
    event.stopPropagation();
    const block = jumpNew.closest('.a-comments');
    const first = block?.querySelector('.comment.is-new');
    if (first) scrollInList(first, 'center');
    else toast('Новых комментариев нет');
    return;
  }
  // «Отметить прочитанными» — двигаем отметку до максимального показанного id.
  const seenBtn = event.target.closest('[data-comments-seen]');
  if (seenBtn) {
    event.stopPropagation();
    await markCommentsSeen(seenBtn.dataset.commentsSeen, Number(seenBtn.dataset.maxId) || 0);
    return;
  }
  const imgLoad = event.target.closest('[data-img-load]');
  if (imgLoad) {
    event.stopPropagation();
    const slot = imgLoad.closest('.img-slot');
    if (slot) { imgLoad.textContent = 'Загружаю…'; loadSlotImage(slot, true); }
    return;
  }
  const moreBtn = event.target.closest('[data-comments-more]');
  if (moreBtn) {
    event.stopPropagation();
    const id = moreBtn.dataset.commentsMore;
    const page = Number(moreBtn.dataset.page) || 2;
    moreBtn.disabled = true;
    moreBtn.textContent = 'Загружаю…';
    await loadComments(id, false, { page });
    return;
  }
  const commentsBtn = event.target.closest('[data-comments]');
  if (commentsBtn) {
    event.stopPropagation();
    const id = commentsBtn.dataset.comments;
    if (commentsBtn.dataset.commentsOnly === '1') { await showCommentsOnly(id); return; }
    const jump = commentsBtn.dataset.jump === '1';
    await loadComments(id, Boolean(state.comments.get(id)?.ok));   // повторное нажатие — обновить
    if (jump) {
      const block = document.querySelector(`.article[data-item="${cssId(id)}"] .a-comments`);
      if (block) scrollInList(block, 'start');
    }
    return;
  }
  const prevBtn = event.target.closest('[data-prev]');
  if (prevBtn) { event.stopPropagation(); goRelative(prevBtn.dataset.prev, -1); return; }
  const nextBtn = event.target.closest('[data-next]');
  if (nextBtn) {
    event.stopPropagation();
    // Кнопка «↓» в плавающих кнопках открывает следующую статью, стрелка внутри
    // статьи — просто переходит дальше по списку.
    if (nextBtn.classList.contains('a-next')) goNextItem(nextBtn.dataset.next);
    else goRelative(nextBtn.dataset.next, 1);
    return;
  }
  if (event.target.closest('a')) return;
  const article = event.target.closest('[data-item]');
  if (!article || !event.target.closest('.a-head')) return;   // переключаем только по заголовку и краткому тексту
  const id = article.dataset.item;
  const item = state.data.items.find((i) => i.id === id);
  if (!item) return;
  // Были открыты только комментарии — теперь показываем саму статью.
  if (state.commentsOnly.has(id)) {
    state.commentsOnly.delete(id);
    state.collapsedItems.delete(id);
    state.expandedItems.add(id);
    renderList();
    return;
  }
  if (isExpanded(item)) collapseItem(id);
  else expandItem(id);
});

$('#list').addEventListener('scroll', (event) => {
  const el = event.target;
  beginScrollWork();                    // фоновые задачи ждут конца прокрутки
  if (state.manualUnread) {
    const step = Math.abs(el.scrollTop - (state.manualUnread.lastTop ?? el.scrollTop));
    state.manualUnread.moved += step;
    state.manualUnread.lastTop = el.scrollTop;
  }
  // Сначала отметка (она смотрит на рамку до этой прокрутки), потом пересчёт рамки.
  scheduleScrollReadCheck();
  scheduleActiveArticle();
  // Дополнительная проверка после остановки: на телефоне последний кадр
  // прокрутки иногда не доходит, и статья оставалась непрочитанной.
  // На телефоне нет курсора: пока идёт прокрутка кнопки полупрозрачные, а как
  // только список остановился — проявляются полностью (см. .settled в стилях).
  for (const actions of document.querySelectorAll('.a-actions.floating')) actions.classList.remove('settled');
  clearTimeout(scrollSettleTimer);
  scrollSettleTimer = setTimeout(() => {
    updateActiveArticle();
    // Кнопки остаются полупрозрачными всегда: текст под ними должен читаться.
    for (const actions of document.querySelectorAll('.a-actions.floating')) actions.classList.remove('settled');
  }, 260);
  // Догружаем заранее, за экран до конца: иначе видно конец списка и надпись.
  if (el.scrollTop + el.clientHeight > el.scrollHeight - 1200) {
    // Событий прокрутки десятки в секунду: без паузы каждое вызывало полную
    // перерисовку списка. Догружаем не чаще, чем раз в 200 мс.
    if (!state.growTimer) {
      state.growTimer = setTimeout(async () => {
        state.growTimer = null;
        const total = visibleItems().length;
        if (state.limit < total) { state.limit = Math.min(total, state.limit + 10); renderList(); return; }
        // Локальные карточки кончились — просим следующую страницу.
        // Раньше каждая перерисовка снова вызывала догрузку и за сессию
        // уходило до сотни запросов вместо десятка.
        if (Date.now() - (state.lastPageAt ?? 0) < 800) return;
        state.lastPageAt = Date.now();
        if (PAGED_DATA) {
          if ((state.viewOffset ?? 0) >= (state.viewTotal ?? 0)) return;
          const ok = await fetchView();
          if (ok) renderList();
          return;
        }
        const added = await loadHistoryPage();
        if (added) {
          // Снимок уже сброшен в loadHistoryPage: visibleItems() соберёт новый,
          // а render() обновит ещё и шапку с деревом.
          state.limit = Math.min(visibleItems().length, state.limit + added);
          render();
        }
      }, 200);
    }
  }
});

$('#view-switch').addEventListener('change', (event) => setViewMode(event.target.value));

$('#tree').addEventListener('click', async (event) => {
  const toggle = event.target.closest('[data-toggle]');
  if (toggle) {
    const id = toggle.dataset.toggle;
    if (state.collapsed.has(id)) state.collapsed.delete(id); else state.collapsed.add(id);
    saveCollapsed();
    renderSidebar();
    return;
  }
  const renameFeed = event.target.closest('[data-feed-rename]');
  if (renameFeed) { renameFeedPrompt(renameFeed.dataset.feedRename); return; }
  const delFeed = event.target.closest('[data-feed-del]');
  if (delFeed) { removeFeedPrompt(delFeed.dataset.feedDel); return; }
  const renameFolder = event.target.closest('[data-folder-rename]');
  if (renameFolder) {
    const folder = state.data.folders.find((f) => f.id === renameFolder.dataset.folderRename);
    const name = await askPrompt('Название папки', 'Как подписать папку в дереве', folder?.name ?? '');
    if (name?.trim()) {
      try { applyPayload(await api('/api/folders/rename', { id: folder.id, name: name.trim() })); } catch (err) { toast(err.message, true); }
    }
    return;
  }
  const delFolder = event.target.closest('[data-folder-del]');
  if (delFolder) {
    const folder = state.data.folders.find((f) => f.id === delFolder.dataset.folderDel);
    const count = state.data.feeds.filter((f) => f.folderId === folder.id).length;
    if (!(await askConfirm('Удалить папку', `Удалить папку «${folder?.name}»?${count ? ` Лент внутри: ${count} — они вернутся в корень.` : ''}`))) return;
    try {
      applyPayload(await api('/api/folders/remove', { id: folder.id, deleteFeeds: false }));
      if (state.view.type === 'folder' && state.view.id === folder.id) state.view = { type: 'unread', id: null };
    } catch (err) { toast(err.message, true); }
    return;
  }
  const feedRow = event.target.closest('[data-feed-row]');
  if (feedRow) {
    switchView({ type: 'feed', id: feedRow.dataset.feedRow });
    return;
  }
  const folderRow = event.target.closest('[data-folder-row]');
  if (folderRow) switchView({ type: 'folder', id: folderRow.dataset.folderRow });
});

$('#tree').addEventListener('dragstart', (event) => {
  const feedEl = event.target.closest('[data-feed-row]');
  const folderEl = event.target.closest('[data-folder-row]');
  if (feedEl) state.drag = { type: 'feed', id: feedEl.dataset.feedRow };
  else if (folderEl) state.drag = { type: 'folder', id: folderEl.dataset.folderRow };
  else return;
  document.body.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', state.drag.id);
});
const clearDropMarks = () => document.querySelectorAll('.drop-target,.drop-before,.drop-after')
  .forEach((el) => el.classList.remove('drop-target', 'drop-before', 'drop-after'));

/** Во время перетаскивания прокручиваем дерево, если курсор у края. */
let dragScrollTimer = null;
function stopDragScroll() {
  if (dragScrollTimer) { clearInterval(dragScrollTimer); dragScrollTimer = null; }
}
function autoScrollTree(clientY) {
  const tree = $('#tree');
  const rect = tree.getBoundingClientRect();
  const zone = 34;
  const speed = clientY < rect.top + zone ? -9 : clientY > rect.bottom - zone ? 9 : 0;
  if (!speed) { stopDragScroll(); return; }
  if (dragScrollTimer) return;
  dragScrollTimer = setInterval(() => { tree.scrollTop += speed; }, 40);
}

$('#tree').addEventListener('dragend', () => {
  state.drag = null;
  document.body.classList.remove('dragging');
  clearDropMarks();
  stopDragScroll();
});
$('#tree').addEventListener('dragover', (event) => {
  if (!state.drag) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  autoScrollTree(event.clientY);
  const target = event.target.closest('[data-tail],[data-folder-row],[data-feed-row]');
  clearDropMarks();
  if (!target) return;
  if (target.dataset.folderRow || target.dataset.tail) { target.classList.add('drop-target'); return; }
  const rect = target.getBoundingClientRect();
  target.classList.add(event.clientY > rect.top + rect.height / 2 ? 'drop-after' : 'drop-before');
});
$('#tree').addEventListener('drop', (event) => {
  if (!state.drag) return;
  event.preventDefault();
  const drag = state.drag;
  const tailTarget = event.target.closest('[data-tail]');
  const feedTarget = event.target.closest('[data-feed-row]');
  const folderTarget = event.target.closest('[data-folder-row]');
  clearDropMarks();
  state.drag = null;
  document.body.classList.remove('dragging');
  stopDragScroll();

  if (drag.type === 'feed') {
    if (tailTarget) {
      moveFeed(drag.id, null);                                   // в самый конец списка
    } else if (feedTarget && feedTarget.dataset.feedRow !== drag.id) {
      const targetFeed = feedById(feedTarget.dataset.feedRow);
      const rect = feedTarget.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      if (after) {
        // Ставим сразу после выбранной ленты: ищем следующую в той же папке.
        const order = state.data.feeds;
        const index = order.findIndex((f) => f.id === targetFeed.id);
        const next = order.slice(index + 1).find((f) => f.folderId === targetFeed.folderId);
        moveFeed(drag.id, targetFeed.folderId ?? null, next?.id ?? null);
      } else {
        moveFeed(drag.id, targetFeed.folderId ?? null, targetFeed.id);
      }
    } else if (folderTarget) {
      moveFeed(drag.id, folderTarget.dataset.folderRow);        // в конец папки
    } else {
      moveFeed(drag.id, null);                                   // в корень
    }
    return;
  }

  if (drag.type === 'folder' && folderTarget && folderTarget.dataset.folderRow !== drag.id) {
    const folder = state.data.folders.find((f) => f.id === drag.id);
    const rest = state.data.folders.filter((f) => f.id !== drag.id);
    const rect = folderTarget.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    let index = rest.findIndex((f) => f.id === folderTarget.dataset.folderRow);
    if (index < 0) index = rest.length;
    rest.splice(after ? index + 1 : index, 0, folder);
    state.data.folders = rest;
    saveTree().catch((err) => toast(err.message, true));
  }
});

const dropHint = $('#drop-hint');
dropHint.addEventListener('dragover', (event) => { event.preventDefault(); dropHint.classList.add('over'); });
dropHint.addEventListener('dragleave', () => dropHint.classList.remove('over'));
dropHint.addEventListener('drop', (event) => {
  event.preventDefault();
  dropHint.classList.remove('over');
  if (state.drag?.type === 'feed') moveFeed(state.drag.id, null);
  state.drag = null;
  document.body.classList.remove('dragging');
});

document.querySelector('.nav').addEventListener('click', (event) => {
  const btn = event.target.closest('.nav-item');
  if (!btn) return;
  switchView({ type: btn.dataset.view, id: null });
});

$('#new-folder').addEventListener('click', async () => {
  const name = await askPrompt('Новая папка', 'Название папки', '');
  if (!name?.trim()) return;
  try { applyPayload(await api('/api/folders', { name: name.trim() })); } catch (err) { toast(err.message, true); }
});
$('#refresh-all').addEventListener('click', () => refreshFeeds(null));
$('#view-refresh').addEventListener('click', () => refreshFeeds(state.view.type === 'feed' ? state.view.id : null));
// На телефоне кнопка обновления стоит рядом с переключателем темы.
$('#refresh-top').addEventListener('click', () => refreshFeeds(state.view.type === 'feed' ? state.view.id : null));
async function markAllInView() {
  const ids = visibleItems().filter((i) => !i.read).map((i) => i.id);
  if (!ids.length) { toast('Непрочитанных нет'); return; }
  const what = state.view.type === 'feed' ? `в ленте «${viewFeed()?.title ?? ''}»`
    : state.view.type === 'folder' ? `в папке «${viewFolder()?.name ?? ''}»`
      : state.view.type === 'starred' ? 'в избранном' : 'во всех подписках';
  if (!(await askConfirm('Прочитать всё', `Отметить прочитанными ${ids.length} ${plural(ids.length, 'статью', 'статьи', 'статей')} ${what}?`))) return;
  await markRead(ids, true);
  resetSnapshot();          // после массовой отметки список пересобирается
  render();
  toast(`Отмечено: ${ids.length}`);
}
$('#mark-all').addEventListener('click', () => markAllInView());

$('#expand-all').addEventListener('click', () => {
  const items = visibleItems().slice(0, state.limit);
  const allExpanded = items.every((i) => isExpanded(i));
  for (const item of items) {
    if (allExpanded) { state.expandedItems.delete(item.id); state.collapsedItems.add(item.id); }
    else { state.collapsedItems.delete(item.id); state.expandedItems.add(item.id); }
  }
  renderList();
});
$('#unread-mode').addEventListener('change', (event) => {
  const onlyUnread = event.target.value !== 'all';
  if (state.view.type === 'feed') {
    state.prefs.feedUnread = { ...(state.prefs.feedUnread ?? {}), [state.view.id]: onlyUnread };
  } else {
    state.prefs.unreadOnly = onlyUnread;      // для папки и общих видов — как значение по умолчанию
  }
  savePrefs();
  state.limit = 10;
  state.view = { ...state.view };             // ключ вида изменится — снимок соберётся заново
  // Пейджинг начинаем заново: фильтр изменился, и старые offset/total от другого
  // режима останавливали догрузку — в «Все» показывались только уже загруженные
  // статьи, а более старые так и не подтягивались.
  state.viewOffset = 0;
  state.viewTotal = 0;
  resetHistory();
  resetSnapshot();
  render();
  // «Все» + порядок «старые сверху»: сразу встаём на старый край архива.
  // При «новые сверху» свежие уже в данных, остальное придёт при прокрутке.
  if (ascendingOrder()) loadHistoryPage().then((added) => { if (added) { state.limit = 10; render(); } });
  if (PAGED_DATA) {
    // Первая страница нового режима: после неё станут известны реальные offset/total,
    // и прокрутка вниз продолжит догружать историю.
    fetchView({ reset: true }).then((ok) => { if (ok) render(); });
  }
});
// «Только картинки»: у ленты сохраняется на сервере, как режим показа и число строк.
$('#images-only').addEventListener('change', async (event) => {
  if (state.view.type !== 'feed') return;
  try {
    const onlyImages = event.target.value === 'yes';
     await applyFeedSetting({ imagesOnly: onlyImages });
    state.bodies.clear();           // текст перерисуем заново — уже без разметки
    render();
    toast(onlyImages ? 'В этой ленте показываются только картинки' : 'Показываю статьи как обычно');
  } catch (err) { toast(err.message, true); }
});
$('#sort-select').addEventListener('change', async (event) => {
  const sort = event.target.value === 'asc' ? 'asc' : 'desc';
  if (state.view.type === 'feed') {
     await applyFeedSetting({ sort });
  } else {
    state.settings.defaultSort = sort;
    pushSettings({ defaultSort: sort });
    render();
    toast(sort === 'asc' ? 'Порядок: старые сверху' : 'Порядок: новые сверху');
  }
  // Порядок сменился — список пересобираем с начала, историю начинаем заново.
  resetSnapshot();
  resetHistory();
  state.limit = 10;
  state.resetScroll = true;
  render();
  // «Старые сверху»: первый экран должен начинаться с самого старого края,
  // иначе видны только недавние статьи из общего ответа сервера.
  if (ascendingOrder()) {
    loadHistoryPage().then((added) => { if (added) { state.limit = 10; render(); } });
  }
});

/** «−» и «+» меняют ширину текста — для этого устройства (на других своя). */
function changeTextWidth(direction) {
  const min = Number(state.settings.minWidth) || 50;
  const max = Number(state.settings.maxWidth) || 100;
  const step = Number(state.settings.widthStep) || 5;
  const current = textWidth();
  const next = Math.min(max, Math.max(min, current + direction * step));
  if (next === current) return;
  state.prefs.width = next;
  savePrefs();
  renderList();
  renderToolbar();
  toast(`Ширина текста: ${next}% — на этом устройстве`);
}

$('#width-minus').addEventListener('click', () => changeTextWidth(-1));
$('#width-plus').addEventListener('click', () => changeTextWidth(1));

$('#prev-item').addEventListener('click', () => { if (state.selectedId) goRelative(state.selectedId, -1); });$('#next-item').addEventListener('click', () => {
  if (state.selectedId) goRelative(state.selectedId, 1);
  else {
    const first = visibleItems()[0];
    if (first) expandItem(first.id);
  }
});
$('#comments-top').addEventListener('click', async () => {
  const id = state.selectedId;
  if (!id) { toast('Сначала выберите статью'); return; }
  const item = state.data.items.find((i) => i.id === id);
  if (isExpanded(item)) {
    await loadComments(id, Boolean(state.comments.get(id)?.ok));
    const block = document.querySelector(`.article[data-item="${cssId(id)}"] .a-comments`);
    if (block) scrollInList(block, 'start');
    return;
  }
  await showCommentsOnly(id);
});
$('#theme-toggle').addEventListener('click', cycleTheme);

let searchTimer = null;
$('#search').addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  const value = event.target.value;
  searchTimer = setTimeout(() => {
    state.query = value;
    state.limit = 10;
    resetSnapshot();          // новый поиск — новый список
    render();
  }, 120);
});

// ------------------------------------------------------- фильтры лент

/** Сохраняет фильтры ленты на сервере и перерисовывает список. */
async function saveFeedFilters(feedId, filters) {
  try {
    const payload = await api('/api/feeds/filters', { feedId, filters });
    if (payload.data) rememberData(payload.data);
    resetSnapshot();
    render();
    renderFiltersList();
  } catch (err) { toast(err.message, true); }
}

/** Делает из поискового запроса фильтр текущей ленты. */
async function addFilterFromSearch(mode) {
  const query = state.query.trim();
  if (!query) return;
  if (state.view.type !== 'feed') { toast('Фильтр задаётся для отдельной ленты', true); return; }
  const feed = viewFeed();
  if (!feed) return;
  const filters = [...(feed.filters ?? []), { id: Date.now().toString(36), mode, query }];
  await saveFeedFilters(feed.id, filters);
  state.query = '';
  $('#search').value = '';
  resetSnapshot();
  render();
  toast(mode === 'hide'
    ? `Статьи со словом «${query}» скрыты в этой ленте`
    : `В этой ленте показываются только статьи со словом «${query}»`);
}

/** Список всех фильтров в окне «Фильтры лент». */
function renderFiltersList() {
  const list = $('#filters-list');
  if (!list) return;
  const feeds = state.data.feeds.filter((feed) => (feed.filters ?? []).length);
  if (!feeds.length) {
    list.innerHTML = '<p class="hint">Пока фильтров нет. Введите запрос в поиск и нажмите «Скрывать такие статьи» или «Показывать только такие».</p>';
    return;
  }
  list.innerHTML = feeds.map((feed) => (feed.filters ?? []).map((filter) => `
    <div class="filter-item" data-feed="${esc(feed.id)}" data-filter="${esc(filter.id)}">
      <span class="mode">${filter.mode === 'hide' ? 'Скрывать' : 'Только'}</span> ${esc(filter.query)}
      <span class="feed-name">в ленте «${esc(feed.title)}»</span>
      <div class="filter-actions">
        <button class="btn" data-filter-edit="1">изменить</button>
        <button class="btn" data-filter-remove="1">удалить</button>
      </div>
    </div>`).join('')).join('');
}

$('#filter-hide').addEventListener('click', () => addFilterFromSearch('hide'));
$('#filter-only').addEventListener('click', () => addFilterFromSearch('only'));

$('#filters-btn').addEventListener('click', () => {
  renderFiltersList();
  $('#filters-modal').hidden = false;
});
$('#filters-close').addEventListener('click', () => { $('#filters-modal').hidden = true; });
$('#filters-modal').addEventListener('click', (event) => {
  if (event.target.id === 'filters-modal') $('#filters-modal').hidden = true;   // клик по фону
});

$('#filters-list').addEventListener('click', async (event) => {
  const block = event.target.closest('.filter-item');
  if (!block) return;
  const feed = state.data.feeds.find((f) => f.id === block.dataset.feed);
  const filter = (feed?.filters ?? []).find((f) => f.id === block.dataset.filter);
  if (!feed || !filter) return;
  if (event.target.closest('[data-filter-remove]')) {
    await saveFeedFilters(feed.id, feed.filters.filter((f) => f.id !== filter.id));
    toast('Фильтр удалён');
    return;
  }
  if (event.target.closest('[data-filter-edit]')) {
    const entered = await askPrompt('Фильтр', 'Слово или фраза для фильтра', filter.query);
    if (entered === null) return;
    const query = entered.trim();
    if (!query) { toast('Пустое слово — фильтр не изменён', true); return; }
    const mode = (await askConfirm('Что делать со статьями', 'Да — скрывать такие статьи, Отмена — показывать только такие')) ? 'hide' : 'only';
    await saveFeedFilters(feed.id, feed.filters.map((f) => (f.id === filter.id ? { ...f, query, mode } : f)));
    toast('Фильтр изменён');
  }
});

// --------------------------------------------------- окно новой подписки

let addCandidates = [];

function openAddDialog() {
  $('#add-input').value = '';
  $('#add-result').textContent = '';
  $('#add-candidates').innerHTML = '';
  addCandidates = [];
  $('#add-modal').hidden = false;
  searchSubscriptions();
  // На телефоне клавиатуру сразу не поднимаем: она закрывает половину экрана,
  // а на iOS из-за фокуса страница ещё и увеличивалась.
  if (!window.matchMedia('(pointer: coarse)').matches) setTimeout(() => $('#add-input').focus(), 50);
}

/**
 * Живой поиск: пока человек печатает, показываем, какие подписки есть по этому
 * адресу — как в других читалках. Первый найденный вариант сразу отмечен, так что
 * достаточно нажать «Добавить».
 */
async function searchSubscriptions() {
  const input = $('#add-input');
  const url = input.value.trim();
  const result = $('#add-result');
  const list = $('#add-candidates');
  if (!url) {
    result.textContent = '';
    list.innerHTML = '';
    addCandidates = [];
    return;
  }
  result.textContent = 'Ищу подписку…';
  list.innerHTML = '';
  addCandidates = [];
  try {
    const payload = await api('/api/discover', { url });
    addCandidates = payload.candidates ?? [];
    if (!payload.ok || !addCandidates.length) {
      result.textContent = payload.error ?? 'Подписки не найдены';
      return;
    }
    result.textContent = addCandidates.length === 1
      ? 'Найдена подписка:'
      : `Найдено ${addCandidates.length} ${plural(addCandidates.length, 'подписка', 'подписки', 'подписок')}:`;
    const firstFree = addCandidates.findIndex((c) => !c.subscribed);
    list.innerHTML = addCandidates.map((c, index) => {
      const hints = [c.format, c.items ? `статей: ${c.items}` : '', c.subscribed ? 'уже подписаны' : (c.hint ?? '')]
        .filter(Boolean).join(' · ');
      const domain = (() => { try { return new URL(c.url).hostname; } catch { return ''; } })();
      return `<div class="cand${c.subscribed ? ' subscribed' : ''}${index === firstFree ? ' active' : ''}"
          data-cand="${index}" title="${esc(c.url)}">
        <div class="cand-title">${esc(c.label || c.title)}</div>
        ${hints ? `<div class="cand-hints">${esc(hints)}</div>` : ''}
        <div class="cand-url">${esc(domain || c.url)}</div>
      </div>`;
    }).join('');
  } catch (err) {
    result.textContent = err.message;
  }
}


async function subscribeSelected() {
  const selected = document.querySelector('#add-candidates .cand.active');
  const chosen = selected
    ? [addCandidates[Number(selected.dataset.cand)]].filter(Boolean)
    : [];
  if (!chosen.length) return;
  $('#add-result').textContent = 'Подписываюсь…';
  const added = [];
  const failed = [];
  for (const candidate of chosen) {
    try {
      const res = await api('/api/feeds', { url: candidate.url });
      if (res.data) rememberData(res.data);
      if (res.duplicate) failed.push(`${candidate.title} — уже добавлена`);
      else added.push(candidate.title);
    } catch (err) {
      failed.push(`${candidate.title}: ${err.message}`);
    }
  }
  render();
  $('#add-result').innerHTML = [
    ...added.map((title) => `добавлено: ${esc(title)}`),
    ...failed.map((title) => `пропущено: ${esc(title)}`),
  ].join('<br>') || 'Ничего не добавлено';
  // Список не убираем: с одного сайта часто нужно подписаться на несколько лент.
  // Перерисовываем его — добавленная станет «уже подписаны», а выбор перейдёт
  // на следующий свободный вариант.
  if (added.length) {
    await searchSubscriptions();
  } else {
    $('#add-candidates').innerHTML = '';
    addCandidates = [];
  }
  const status = $('#add-status');
  if (status) {
    status.className = 'add-status';
    status.textContent = added.length ? `Добавлено подписок: ${added.length}` : '';
  }
  toast(added.length ? `Подписок добавлено: ${added.length}` : 'Ничего не добавлено', !added.length);
}

$('#new-feed').addEventListener('click', openAddDialog);
$('#add-close').addEventListener('click', () => { $('#add-modal').hidden = true; });
$('#add-modal').addEventListener('click', (event) => { if (event.target.id === 'add-modal') $('#add-modal').hidden = true; });
let addTimer = null;
$('#add-input').addEventListener('input', () => {
  clearTimeout(addTimer);
  addTimer = setTimeout(searchSubscriptions, 450);
});

/**
 * Кнопка «Добавить» и Enter работают одинаково: если в результатах поиска
 * уже выбран вариант — подписываемся, иначе запускаем поиск. Раньше кнопка
 * звала checkAddress(), которая рисовала чекбоксы без класса .cand, а
 * subscribeSelected() искал только .cand.active — подписка не оформлялась.
 */
function handleAddButton() {
  if (!$('#add-input').value.trim()) {
    $('#add-result').textContent = 'Введите адрес сайта, страницы или канала';
    $('#add-input').focus();
    return;
  }
  const active = document.querySelector('#add-candidates .cand.active');
  if (active) return subscribeSelected();
  return searchSubscriptions();
}

$('#add-check').addEventListener('click', handleAddButton);
$('#add-candidates').addEventListener('click', async (event) => {
  const row = event.target.closest('.cand');
  if (!row) return;
  const already = row.classList.contains('active');
  for (const other of document.querySelectorAll('#add-candidates .cand')) other.classList.remove('active');
  row.classList.add('active');
  if (already) await subscribeSelected();     // повторный клик по выбранной — подписаться
});

$('#add-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); handleAddButton(); } });

$('#lines-select').addEventListener('change', async (event) => {
  const lines = Number(event.target.value) || 2;
  if (state.view.type === 'feed') {
     await applyFeedSetting({ lines });
    renderList();                             // перерисовать сразу, без ожидания опроса
  } else {
    state.settings.defaultLines = lines;
    pushSettings({ defaultLines: lines });
    render();
    toast(`Показывать строк: ${lines}`);
  }
});

$('#opml-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const status = $('#add-status');
  status.className = 'add-status';
  status.textContent = `Импорт ${file.name}…`;
  try {
    const res = await fetch('/api/opml', { method: 'POST', headers: { 'content-type': 'text/x-opml' }, body: await file.text() });
    const payload = await res.json();
    rememberData(payload.data ?? state.data);
    status.textContent = `Импортировано: ${payload.added?.length ?? 0}${payload.failed?.length ? `, ошибок: ${payload.failed.length}` : ''}`;
    render();
  } catch (err) {
    status.className = 'add-status err';
    status.textContent = err.message;
  } finally {
    event.target.value = '';
  }
});

// ------------------------------------------------------------------ настройки

async function openSettings() {
  // Окно показываем сразу: если сервер отвечает медленно, кнопка не должна
  // выглядеть «мёртвой». Пока данные едут, поля приглушены и видна надпись
  // «загрузка…» — чтобы не казалось, что опции показаны неправильно.
  $('#settings-modal').hidden = false;
  // Строка «когда обновлялся сервер»: видно, что серверные правки уже на месте.
  const buildLabel = document.querySelector('#settings-server-build');
  if (buildLabel) {
    const at = state.serverBuild ? new Date(state.serverBuild) : null;
    if (at && !Number.isNaN(at.getTime())) {
      buildLabel.textContent = 'Сервер обновлён ' + at.toLocaleString('ru-RU', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
      });
      buildLabel.hidden = false;
    } else {
      buildLabel.hidden = true;
    }
  }
  setSettingsLoading(true);
  startSettingsRefresh();
  try {
    const payload = await api('/api/settings');
    if (payload?.settings) state.settings = payload.settings;
  } catch { /* покажем то, что уже есть */ }
  try {
    fillSettingsForm();
  } catch (err) {
    console.error('настройки: не удалось заполнить форму', err);
  } finally {
    setSettingsLoading(false);
  }
}

/** Показывает или скрывает состояние загрузки в окне настроек. */
function setSettingsLoading(loading) {
  const modal = $('#settings-modal');
  modal?.classList.toggle('loading', Boolean(loading));
  const label = $('#settings-loading');
  if (label) label.hidden = !loading;
}

/** Подставляет текущие значения в поля окна настроек. */
function fillSettingsForm() {
  const s = state.settings ?? {};
  $('#set-theme').value = state.prefs.theme;
  $('#set-content-mode').value = s.feverMode ? 'fever' : 'native';
  $('#set-default-view').value = s.defaultView ?? 'compact-thumb';
  $('#set-density').value = state.prefs.density;
  setSelectValue($('#set-thumbs'), state.prefs.thumbs ? 'yes' : 'no');
  setSelectValue($('#set-image-wrap'), state.prefs.imageWrap ? 'yes' : 'no');
  setSelectValue($('#set-swipe-next'), state.prefs.swipeNext === false ? 'no' : 'yes');
  setSelectValue($('#set-borders'), state.prefs.borders !== false ? 'yes' : 'no');
  setSelectValue($('#set-tint'), state.prefs.tint === 'articles' ? 'articles' : 'interface');
  setSelectValue($('#set-fetch-full'), s.fetchFull !== false ? 'yes' : 'no');
  $('#set-pass').value = '';
  $('#set-pass-current').value = '';
  $('#set-tg-token').value = '';
  setSelectValue($('#set-font-family'), fontVariant(state.prefs.fontFamily));
  setSelectValue($('#set-line-height'), state.prefs.lineHeight || 'normal');
  setFontSelect($('#set-font-tree'), state.prefs.fontTree);
  const uiScaleAsPx = (() => {
    const n = Number(state.prefs.uiScale);
    if (!Number.isFinite(n) || n <= 0) return '13px';
    return `${Math.round(n < 6 ? n * 13 : n)}px`;   // старые значения хранились множителем
  })();
  setSelectValue($('#set-ui-scale'), uiScaleAsPx);
  setFontSelect($('#set-font-article'), state.prefs.fontArticle);
  setFontSelect($('#set-font-excerpt'), state.prefs.fontExcerpt);
  setSelectValue($('#set-read-mode'), readMode());
  setSelectValue($('#set-keep-days'), String(state.settings.keepReadDays ?? 14));
  setSelectValue($('#set-unread-default'), unreadDefault() ? 'unread' : 'all');
  renderTreeFilter();
  setRefreshSelect(s.refreshMinutes ?? 5);
  if ($('#refresh-info')) $('#refresh-info').textContent = '';
  $('#set-palette-dark').value = state.prefs.paletteDark;
  $('#set-palette-light').value = state.prefs.paletteLight;
  $('#set-background').value = state.prefs.background === 'theme' ? 'theme' : 'palette';
  renderFeverInfo();
  renderQueueInfo();
  renderTelegramInfo();
}

function renderFeverInfo() {
  const s = state.settings;
  const session = state.session ?? {};
  const account = $('#account-info');
  if (account) account.innerHTML = '';
  // Логин и роль — плашкой в шапке окна, в теле настроек не дублируем.
  const who = $('#settings-who');
  if (who) {
    const login = session.login ?? session.user ?? '';
    who.textContent = login ? `${login}${session.role === 'admin' ? ' · администратор' : ''}` : '';
    who.hidden = !login;
  }
  const adminRow = $('#admin-row');
  if (adminRow) adminRow.hidden = session.role !== 'admin';

  const el = $('#fever-info');
  if (!el) return;
  const key = s.fever?.apiKey ?? session.fever?.apiKey ?? '';
  if (!key) {
    el.textContent = 'Ключ Fever не задан — обратитесь к администратору.';
    return;
  }
  el.innerHTML = `Для внешнего клиента укажите:<br>
    адрес сервера: <code>${esc(location.origin)}/fever/</code><br>
    логин: <code>${esc(s.fever?.user ?? session.login ?? '')}</code><br>
    пароль: тот, под которым вы входите${key ? `<br>ключ API, если клиент его просит: <code>${esc(key)}</code>` : ''}`;
}

function renderQueueInfo() {
  // Один источник правды: свежие данные из настроек, иначе — из последнего опроса списка.
  const f = state.settings.fetching ?? state.data.fetching ?? {};
  $('#queue-info').textContent = f.enabled === false
    ? 'Автоматическая докачка выключена.'
    : `В очереди: ${f.pending ?? 0}${f.active ? ' (идёт загрузка)' : ''}, докачано за сеанс: ${f.done ?? 0}.`;
}

function renderTelegramInfo() {
  const t = state.settings.telegram ?? {};
  const lines = [];
  lines.push(t.hasToken
    ? `Бот подключён${t.botUsername ? `: @${esc(t.botUsername)}` : ''}.`
    : 'Токен бота не задан — публичные каналы читаются через веб-превью t.me.');
  lines.push(`Каналов через бота: ${t.botFeeds ?? 0}, через веб-превью: ${t.webFeeds ?? 0}.`);
  $('#tg-info').innerHTML = lines.join('<br>');
}

$('#open-settings').addEventListener('click', openSettings);
function closeSettings() {
  $('#settings-modal').hidden = true;
  setSettingsLoading(false);
  try { stopSettingsRefresh(); } catch { /* уже остановлено */ }
}

$('#settings-close').addEventListener('click', closeSettings);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#settings-modal').hidden) closeSettings();
});
$('#settings-modal').addEventListener('click', (event) => {
  if (event.target.id === 'settings-modal') closeSettings();
});

/** Пока настройки открыты, их показания обновляются — иначе цифры расходятся
 *  с тем, что показывает основное окно. */
let settingsTimer = null;
function startSettingsRefresh() {
  stopSettingsRefresh();
  settingsTimer = setInterval(async () => {
    if ($('#settings-modal').hidden) { stopSettingsRefresh(); return; }
    try {
      state.settings = (await api('/api/settings')).settings;
      // Подтягиваем и основное окно, чтобы счётчики докачки нигде не расходились.
      if (state.settings.fetching) { state.data.fetching = state.settings.fetching; renderToolbar(); }
      renderQueueInfo();
      renderTelegramInfo();
      renderFeverInfo();
      setSelectValue($('#set-fetch-full'), state.settings.fetchFull !== false ? 'yes' : 'no');
      setRefreshSelect(state.settings.refreshMinutes ?? 10);
  if ($('#refresh-info')) $('#refresh-info').textContent = '';
    } catch { /* настройки временно недоступны */ }
  }, 3000);
}
function stopSettingsRefresh() {
  if (settingsTimer) { clearInterval(settingsTimer); settingsTimer = null; }
}

$('#set-theme').addEventListener('change', (e) => { state.prefs.theme = e.target.value; savePrefs(); applyTheme(); });
$('#set-palette-dark').addEventListener('change', (e) => {
  state.prefs.paletteDark = e.target.value;
  savePrefs();
  applyPalette();
});
$('#set-palette-light').addEventListener('change', (e) => {
  state.prefs.paletteLight = e.target.value;
  savePrefs();
  applyPalette();
});
$('#set-background').addEventListener('change', (e) => {
  state.prefs.background = e.target.value === 'theme' ? 'theme' : 'palette';
  savePrefs();
  applyPalette();
  toast(state.prefs.background === 'theme' ? 'Фон темы: белый или чёрный' : 'Фон из выбранной гаммы');
});
$('#set-default-view').addEventListener('change', async (e) => {
  state.settings.defaultView = e.target.value;
  pushSettings({ defaultView: e.target.value });   // сразу применяем, отправляем в очереди
  render();
});
$('#set-content-mode').addEventListener('change', (e) => {
  const mode = e.target.value === 'fever' ? 'fever' : 'native';
  state.settings.feverMode = mode === 'fever';
  pushSettings({ feverMode: state.settings.feverMode });
  render();
});

$('#set-density').addEventListener('change', (e) => {
  state.prefs.density = e.target.value;
  $('#list').classList.toggle('comfortable', e.target.value === 'comfortable');
  savePrefs();
});
$('#set-thumbs').addEventListener('change', (e) => { state.prefs.thumbs = e.target.value !== 'no'; savePrefs(); renderList(); });
  $('#set-image-wrap').addEventListener('change', (e) => {
    state.prefs.imageWrap = e.target.value !== 'no';
    savePrefs();
    renderList();
  });
  $('#set-swipe-next').addEventListener('change', (e) => {
    state.prefs.swipeNext = e.target.value !== 'no';
    savePrefs();
  });
$('#set-borders').addEventListener('change', (e) => {
  state.prefs.borders = e.target.value !== 'no';
  savePrefs();
  applyVisualPrefs();
  toast(state.prefs.borders ? 'Рамки видимые' : 'Рамки невидимые');
});
// Акцент темы: на интерфейсе (фон ленты) или на статьях (панель и карточки).
$('#set-tint').addEventListener('change', (e) => {
  state.prefs.tint = e.target.value === 'articles' ? 'articles' : 'interface';
  savePrefs();
  applyVisualPrefs();
  toast(state.prefs.tint === 'articles' ? 'Акцент на статьях' : 'Акцент на интерфейсе');
});
$('#set-font-family').addEventListener('change', (e) => { state.prefs.fontFamily = e.target.value; savePrefs(); applyVisualPrefs(); });
$('#set-line-height').addEventListener('change', (e) => { state.prefs.lineHeight = e.target.value; savePrefs(); applyVisualPrefs(); });
$('#set-font-tree').addEventListener('change', (e) => { state.prefs.fontTree = e.target.value; savePrefs(); applyVisualPrefs(); });
  $('#set-ui-scale').addEventListener('change', (e) => {
    // Из списка приходит строка вида «15px»: храним множитель от базы 13 px.
    state.prefs.uiScale = Math.max(0.7, Math.min(2, (Number.parseFloat(String(e.target.value)) || 13) / 13));
    savePrefs();
    applyVisualPrefs();
  });
$('#set-font-article').addEventListener('change', (e) => { state.prefs.fontArticle = e.target.value; savePrefs(); applyVisualPrefs(); });
$('#set-font-excerpt').addEventListener('change', (e) => { state.prefs.fontExcerpt = e.target.value; savePrefs(); applyVisualPrefs(); });
/** Какой из трёх вариантов отметки выбран. */
function readMode() {
  if (state.prefs.readOnExpand && state.prefs.readOnScroll) return 'both';
  if (state.prefs.readOnScroll) return 'scroll';
  if (state.prefs.readOnExpand) return 'click';
  return 'scroll';
}

$('#set-keep-days').addEventListener('change', async (event) => {
  const days = Number(event.target.value);
  try {
    const payload = await api('/api/settings', { keepReadDays: days });
    if (payload?.settings) state.settings = payload.settings;
    toast(days === 7 ? 'Прочитанное хранится 1 неделю' : `Прочитанное хранится ${days / 7} нед.`);
  } catch (err) { toast(err.message, true); }
});

$('#set-unread-default').addEventListener('change', (event) => {
  state.prefs.unreadOnly = event.target.value !== 'all';
  savePrefs();
  resetSnapshot();
  render();
});

$('#set-read-mode').addEventListener('change', (e) => {
  const mode = e.target.value;
    // «по клику» — только раскрытие, «при прокрутке» — только уход под шапку,
    // «оба» — и то и другое. Отметка «до конца статьи» больше не используется.
    state.prefs.readOnExpand = mode === 'click' || mode === 'both';
    state.prefs.readOnScroll = mode === 'scroll' || mode === 'both';
    state.prefs.readOnFinish = false;
    state.prefs.readModeSet = true;
  savePrefs();
  setupReadObservers();
});
// Фильтр дерева: две кнопки в шапке списка подписок.
function renderTreeFilter() {
  for (const btn of document.querySelectorAll('#tree-filter button[data-tree]')) {
    btn.classList.toggle('on', btn.dataset.tree === (state.prefs.treeFilter === 'unread' ? 'unread' : 'all'));
  }
}

$('#tree-filter').addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-tree]');
  if (!btn) return;
  state.prefs.treeFilter = btn.dataset.tree === 'unread' ? 'unread' : 'all';
  savePrefs();
  renderTreeFilter();
  renderSidebar();
});
/** Ставит значение в список; если такого пункта нет — добавляет его. */
function setSelectValue(select, value, label) {
  const text = String(value);
  if (![...select.options].some((option) => option.value === text)) {
    const option = document.createElement('option');
    option.value = text;
    option.textContent = label ?? text;
    select.append(option);
  }
  select.value = text;
}

/** Ставит интервал обновления в списке; нестандартное значение добавляет как пункт. */
function setRefreshSelect(minutes) {
  const select = $('#set-refresh');
  const value = String(Math.min(1440, Math.max(1, Math.round(Number(minutes) || 10))));
  if (![...select.options].some((option) => option.value === value)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = `${value} мин`;
    select.append(option);
  }
  select.value = value;
}

$('#set-refresh').addEventListener('change', async (e) => {
  const minutes = Math.min(1440, Math.max(1, Number(e.target.value) || 10));
  try {
    const payload = await api('/api/settings', { refreshMinutes: minutes });
    state.settings = payload.settings;
  if ($('#refresh-info')) $('#refresh-info').textContent = '';
    toast(`Ленты будут обновляться каждые ${minutes} мин`);
  } catch (err) { toast(err.message, true); }
});
$('#set-fetch-full').addEventListener('change', async (e) => {
  const on = e.target.value !== 'no';
  await api('/api/settings', { fetchFull: on });
  toast(on ? 'Докачка включена' : 'Докачка выключена');
});
$('#save-credentials').addEventListener('click', async () => {
  const current = $('#set-pass-current').value;
  const password = $('#set-pass').value;
  if (!password) { toast('Введите новый пароль', true); return; }
  try {
    await api('/api/settings/credentials', { current, password });
    toast('Пароль изменён');
    $('#set-pass').value = '';
    $('#set-pass-current').value = '';
    await openSettings();
  } catch (err) { toast(err.message, true); }
});
$('#logout-btn').addEventListener('click', async () => {
  if (!(await askConfirm('Выход', 'Выйти из аккаунта?'))) return;
  await api('/api/logout', {}).catch(() => {});
  location.reload();
});
$('#queue-start').addEventListener('click', async () => {
  try {
    const payload = await api('/api/queue', { action: 'start' });
    toast(`В очереди: ${payload.fetching.pending}`);
    renderQueueInfo();
  } catch (err) { toast(err.message, true); }
});
$('#queue-clear').addEventListener('click', async () => {
  try {
    await api('/api/queue', { action: 'clear' });
    toast('Очередь очищена');
    renderQueueInfo();
  } catch (err) { toast(err.message, true); }
});
$('#save-tg').addEventListener('click', async () => {
  const token = $('#set-tg-token').value.trim();
  if (!token) { toast('Вставьте токен бота', true); return; }
  try {
    const payload = await api('/api/settings', { telegramToken: token });
    state.settings = payload.settings;
    $('#set-tg-token').value = '';
    renderTelegramInfo();
    toast(payload.telegram?.username ? `Бот подключён: @${payload.telegram.username}` : 'Токен сохранён');
  } catch (err) { toast(err.message, true); }
});
$('#clear-tg').addEventListener('click', async () => {
  try {
    state.settings = (await api('/api/settings', { telegramToken: '' })).settings;
    renderTelegramInfo();
    toast('Токен убран');
  } catch (err) { toast(err.message, true); }
});

// -------------------------------------------------------------------- вход

/**
 * Затемнение со спиннером на всё окно: пока данные не пришли, интерфейс без
 * лент выглядел как «пустое приложение». hideLoader снимает затемнение.
 */
/**
 * Просмотр картинки: клик по изображению в тексте открывает затемнение с картинкой
 * шириной в колонку чтения статьи (на телефоне — во всю ширину экрана).
 * Повторный клик по фону или картинке закрывает; кнопка в правом верхнем углу
 * отдаёт картинку в системное «Поделиться».
 */
function openLightbox(image) {
  const box = $('#lightbox');
  const big = $('#lightbox-img');
  const frame = $('#lightbox-frame');
  if (!box || !big) return;
  // У ленивых картинок адрес лежит в data-src: src может быть заглушкой.
  const src = image.dataset.src || image.currentSrc || image.src || '';
  if (!src) return;
  big.src = src;
  big.alt = image.alt || '';
  // Ширина колонки чтения: та же, что у текста статьи, но не больше окна.
  const column = image.closest('.a-body, .comment-body');
  const limit = Math.max(280, window.innerWidth - 24);
  const width = column ? Math.min(limit, Math.round(column.getBoundingClientRect().width)) : limit;
  if (frame) frame.style.width = width ? `${width}px` : '';
  state.lightboxShare = {
    src,
    title: image.alt || image.title || document.querySelector('#view-title')?.textContent || 'Картинка',
  };
  box.hidden = false;
  document.body.classList.add('lightbox-open');
}

/**
 * Отдаёт картинку из просмотра: сначала как файл (нативный лист «Поделиться»),
 * потом как ссылку, в крайнем случае копирует адрес в буфер.
 */
async function shareLightboxImage() {
  const data = state.lightboxShare;
  if (!data?.src) return;
  const title = String(data.title || 'Картинка').trim();
  try {
    if (navigator.canShare && navigator.share) {
      const response = await fetch(data.src, { credentials: 'include' }).catch(() => null);
      if (response?.ok) {
        const blob = await response.blob();
        const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
        const file = new File([blob], `image.${ext}`, { type: blob.type });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title });
          return;
        }
      }
    }
    if (navigator.share) {
      await navigator.share({ title, url: data.src });
      return;
    }
    await navigator.clipboard.writeText(data.src);
    toast('Ссылка на картинку скопирована');
  } catch (err) {
    if (err?.name === 'AbortError') return;          // пользователь закрыл лист
    toast(`Не удалось поделиться: ${err.message ?? err}`, true);
  }
}

function closeLightbox() {
  const box = $('#lightbox');
  const big = $('#lightbox-img');
  if (!box) return;
  box.hidden = true;
  if (big) big.removeAttribute('src');   // не держим картинку в памяти
  document.body.classList.remove('lightbox-open');
}

function lightboxVisible() {
  const box = $('#lightbox');
  return Boolean(box && !box.hidden);
}


function showLoader(text = 'Загрузка…') {
  const box = $('#app-loader');
  const label = $('#app-loader-text');
  if (label) label.textContent = text;
  if (box) box.hidden = false;
}

function hideLoader() {
  const box = $('#app-loader');
  if (box) box.hidden = true;
}


function showLogin() {
  hideLoader();                     // экран входа показывает себя сам

  // Пока не вошли — интерфейс читалки не показываем, только окно входа.
  document.body.classList.add('logged-out');
  $('#toast').hidden = true;
  $('#login-modal').hidden = false;
  $('#login-user').value = state.settings.user ?? '';
  $('#login-pass').value = '';
  $('#login-error').textContent = '';
  // Фокус — на логине, если он пустой; иначе сразу в пароль. На тач-устройствах
  // не фокусируем ничего, чтобы не выезжала клавиатура и не было авто-зума.
  const userField = $('#login-user');
  if (!window.matchMedia('(pointer: coarse)').matches) {
    setTimeout(() => (userField.value ? $('#login-pass') : userField).focus(), 50);
  }
}

async function submitLogin() {
  const login = ($('#login-user')?.value ?? '').trim();
  const password = $('#login-pass').value;
  const remember = $('#login-remember').checked;
  const errorEl = $('#login-error');
  errorEl.textContent = '';
  // Простая проверка на пустые поля: сервер ответил бы тем же, но лишний запрос не нужен.
  if (!login && !password) { errorEl.textContent = 'Введите логин и пароль'; return; }
  if (!login) { errorEl.textContent = 'Введите логин'; return; }
  if (!password) { errorEl.textContent = 'Введите пароль'; return; }
  try {
    const session = await api('/api/login', { login, password, remember });
    // Сервер отвечает 401 с {ok:false,error} — это не исключение, а обычный ответ,
    // поэтому проверяем его сами: иначе интерфейс успевал мелькнуть и вылезал тост.
    if (!session || session.ok === false || session.error) {
      errorEl.textContent = session?.error || 'Неверный логин или пароль';
      document.body.classList.add('logged-out');
      return;
    }
    state.session = session;
    document.body.classList.remove('logged-out');
    $('#login-modal').hidden = true;
    state.session.authenticated = true;
    showLoader('Загружаю ленты…');      // после входа виден только спиннер
    await loadSettings();
    await loadData();
    hideLoader();
    afterAuthInit();                          // SSE и раздел — сразу после входа
    toast(`Здравствуйте, ${login}`);
  } catch (err) {
    const message = String(err?.message ?? '').trim();
    errorEl.textContent = message && message !== 'undefined' ? message : 'Неверный логин или пароль';
  }
}

$('#login-submit').addEventListener('click', submitLogin);
$('#login-pass').addEventListener('keydown', (event) => { if (event.key === 'Enter') submitLogin(); });

// ---------------------------------------------------------------- загрузка

async function loadSettings() {
  try { state.settings = (await api('/api/settings')).settings; } catch { /* недоступно до входа */ }
}

/**
 * Догружает статьи, появившиеся после последней проверки. Нужен лёгкий путь:
 * полный список весит мегабайты, а новинок обычно единицы.
 */
/**
 * Догружает статьи за последние сутки перед показом раздела: в списке на экране
 * могло не быть свежих статей, и лента открывалась пустой при «+1» в дереве.
 */
/**
 * Догружает столько статей раздела, сколько сейчас показывается на экране.
 * Раньше брали «за сутки» — это и лишний вес, и промахи по количеству.
 */
async function ensureViewItems(expected = 0, force = false) {
  const want = Math.max(20, Number(state.limit) || 20);
  // Если сервер сообщил, сколько статей в разделе, ориентируемся на это число:
  // иначе в ленте оставалось 5 карточек при 7 статьях на сервере.
  const needAtLeast = expected > 0 ? Math.min(expected, want) : want;
  if (!force && itemsOfView().length >= needAtLeast) return 0;
  const params = new URLSearchParams();
  params.set('limit', String(Math.min(300, want)));
  if (state.view.type === 'feed') params.set('feedId', state.view.id);
  else if (state.view.type === 'folder') params.set('folderId', state.view.id);
  else if (state.view.type === 'starred') return 0;      // избранное уже в данных
  if (unreadModeFor()) params.set('unread', '1');
  const merge = (items) => {
    let added = 0;
    for (const item of items ?? []) {
      if (!(state.data.items ?? []).some((i) => i.id === item.id)) { state.data.items.push(item); added += 1; }
    }
    return added;
  };
  try {
    let added = merge((await api(`/api/items?${params.toString()}`))?.items);
    // Если раздел всё ещё пуст, пробуем ещё раз: сервер мог быть занят синхронизацией.
    if (!itemsOfView().length) {
      await new Promise((r) => setTimeout(r, 1500));
      added += merge((await api(`/api/items?${params.toString()}`))?.items);
    }
    return added;
  } catch {
    return 0;
  }
}

/**
 * Один раз после загрузки сверяет карточки с сервером пачками по 500 id:
 * сервер отвечает, каких статей у него уже нет, и мы их убираем. Иначе старые
 * карточки висят пустыми: открыть нельзя, текста нет.
 */
async function verifyItemsOnce() {
  // Без ревизии сверять нечего: иначе `undefined === undefined` глушит проверку навсегда.
  if (!state.revision) return;
  if (state.verifiedRevision === state.revision) return;
  state.verifiedRevision = state.revision;
  const ids = (state.data.items ?? []).map((i) => i.id).slice(0, 3000);
  if (!ids.length) return;
  const gone = new Set();
  for (let from = 0; from < ids.length; from += 500) {
    try {
      const answer = await api('/api/state', { ids: ids.slice(from, from + 500) });
      for (const id of answer?.missing ?? []) gone.add(id);
    } catch { return; }
  }
  if (!gone.size) return;                    // ничего не пропало — перерисовка не нужна
  state.data.items = (state.data.items ?? []).filter((item) => !gone.has(item.id));
  for (const id of gone) { state.snapshot?.ids?.delete(id); keepReadItems.delete(id); }
  resetSnapshot();                           // состав изменился — список собираем заново
  render();
}


async function pullNewItems() {
  if (!Array.isArray(state.data.items) || !state.data.items.length) return 0;
  if (!state.sinceAt) {
    const base = Date.parse(state.data.lastRefresh ?? '') || Date.now();
    state.sinceAt = new Date(base).toISOString();
  }
  try {
    const extra = await api(`/api/since?after=${encodeURIComponent(state.sinceAt)}`);
    let added = 0;
    for (const item of extra?.items ?? []) {
      if (!state.data.items.some((i) => i.id === item.id)) { state.data.items.push(item); added += 1; }
    }
    if (extra?.cursor) state.sinceAt = extra.cursor;
    return added;
  } catch {
    return 0;
  }
}
async function loadData({ poll = false } = {}) {
  try {
    if (PAGED_DATA) {
      if (poll && state.revision) {
        const small = await api(`/api/data?rev=${state.revision}`);
        if (small?.unchanged) {
          if (Array.isArray(small.feeds)) state.data.feeds = small.feeds;
          state.data.counts = small.counts ?? state.data.counts;
          state.data.fetching = small.fetching ?? state.data.fetching;
          state.data.refreshing = small.refreshing ?? state.data.refreshing;
          renderSidebar();
          renderToolbar();
          return;
        }
      }
      const ok = await fetchView({ reset: true });
      if (!ok) return;
      render();
      flushPendingReads();
      return;
    }
    const query = poll && state.revision ? `?rev=${state.revision}` : '';
    let payload;                               // сбой загрузки списка видно в подвале
    try {
      payload = await api(`/api/data${query}`);
      state.listError = '';
    } catch (err) {
      // Раньше сбой молча оставлял старую копию списка: в ленте висели карточки
      // удалённых статей. Теперь причина видна в подвале.
      state.listError = 'список не загрузился: ' + (err?.message ?? err);
      updateFooterStats();
      throw err;
    }
    // Сервер отвечает «изменилось» без данных: тогда грузим список целиком.
    // Без этой ветки клиент навсегда оставался со старой копией состояния —
    // именно поэтому отметки из Fever и новые статьи не доходили.
    if (payload.changed) {
      // Появились или удалились статьи — нужен полный список. Иначе в дереве
      // счётчики растут, а в ленте новых карточек нет: ответ «changed» отдаёт
      // только отметки, и статья «доходила» лишь при следующей полной загрузке.
      if (Number(payload.itemsRevision) !== Number(state.itemsRevision)) return loadData({ poll: false });
      // Изменились отметки или счётчики: тянем только состояние видимых статей,
      // а не весь список (это в десятки раз дешевле).
      const ids = (state.data.items ?? []).map((item) => item.id);
      if (!ids.length) return loadData({ poll: false });
      const state_ = await api('/api/state', { ids });
      if (!state_?.items) return loadData({ poll: false });
      if (Number.isFinite(state_.revision)) state.revision = state_.revision;
      if (state_.serverVersion) state.serverVersion = state_.serverVersion;
  if (state_.serverBuild) state.serverBuild = state_.serverBuild;
      const touched = [];
      for (const item of state.data.items ?? []) {
        const flags = state_.items[item.id];
        if (!flags) continue;
        if (flags.r !== Boolean(item.read)) { item.read = flags.r; touched.push(item.id); }
        if (flags.s !== Boolean(item.starred)) { item.starred = flags.s; touched.push(item.id); }
      }
      // Сервер сообщил, каких статей у него уже нет: убираем их карточки, иначе
      // они висят в ленте пустыми и не открываются («текста нет»).
      if (Array.isArray(state_.missing) && state_.missing.length) {
        const gone = new Set(state_.missing.filter((id) => !keepReadVisible.has(id)));
        if (gone.size) {
          state.data.items = (state.data.items ?? []).filter((item) => !gone.has(item.id));
          for (const id of gone) { state.snapshot?.ids?.delete(id); keepReadItems.delete(id); }
        }
      }
      if (state_.counts) state.data.counts = state_.counts;
      if (state_.feedUnread && Array.isArray(state.data.feeds)) {
        for (const feed of state.data.feeds) {
          const unread = state_.feedUnread[feed.id];
          if (Number.isFinite(unread)) feed.unread = unread;
        }
      }
      if (state_.addedByFeed) state.data.addedByFeed = state_.addedByFeed;
      // Новые статьи НЕ вставляем в список: человек читает ленту, и любая
      // пересборка сдвигала бы её. Показываем плашку «Новых статей: N» — список
      // пересобирается только по нажатию «Показать».
      const prevRefresh = state.data.lastRefreshSeen;
      const freshSync = state_.lastRefresh && state_.lastRefresh !== prevRefresh;
      if (freshSync) {
        state.data.lastRefreshSeen = state_.lastRefresh;
        if (Number(state_.lastRefreshAdded) > 0) {
          state.data.lastRefreshAdded = state_.lastRefreshAdded;
          if (state_.addedByFeed) state.data.addedByFeed = state_.addedByFeed;
        }
        // Забираем только новые статьи: плашка «Новых статей» показывала 0, потому
        // что лёгкий опрос приносит счётчики, но не сами статьи.
        if (prevRefresh) {
          try {
            const extra = await api(`/api/since?after=${encodeURIComponent(prevRefresh)}`);
            for (const item of extra?.items ?? []) {
              if (!(state.data.items ?? []).some((i) => i.id === item.id)) state.data.items.push(item);
            }
          } catch { /* не критично: покажем при следующей полной загрузке */ }
        }
      }
      if (state_.lastRefresh) state.data.lastRefreshSeen = state_.lastRefresh;
      if (state_.lastRefresh) {
        state.data.lastRefreshSeen = state_.lastRefresh;
        if (state.refreshError) { state.refreshError = ''; updateFooterStats(); }
      }
      if (state_.lastRefreshAdded !== undefined) state.data.lastRefreshAdded = state_.lastRefreshAdded;
      if (state_.lastRefreshFeeds !== undefined) state.data.lastRefreshFeeds = state_.lastRefreshFeeds;
      if (state_.lastRefresh !== undefined) state.data.lastRefresh = state_.lastRefresh;
      if (state_.nextRefreshAt !== undefined) state.data.nextRefreshAt = state_.nextRefreshAt;
      // Пересобираем только изменившиеся карточки — остальной список не трогаем.
      for (const id of new Set(touched)) patchCard(id);
      renderSidebar();
      renderToolbar();
      // Новинки приходят отдельным лёгким запросом: иначе плашка их не видит.
      const freshCount = await pullNewItems();
      // Плашку «Новых статей» рисует renderNewRow ниже; сам список не пересобираем,
      // пока лента заморожена — иначе он прыгал под курсором.
      if (freshCount && !(state.listFrozen && state.snapshot)) renderList();
      // Дерево показывает серверное число непрочитанных. Если в данных раздела
      // меньше статей — догружаем недостающие, иначе шапка и дерево расходятся.
      const expected = state.view.type === 'feed' ? Number(viewFeed()?.unread ?? 0) : 0;
      const hadItems = itemsOfView().length > 0;   // пусто ли было до догрузки
      if (expected && itemsOfView().length < expected) {
        const more = await ensureViewItems(expected);
        // Догружаем ТОЛЬКО в данные: список не пересобираем, иначе во время
        // чтения в него вставлялись бы новые статьи и лента прыгала.
        // Отрисовываем лишь когда до этого список был пуст (первый заход в раздел).
        if (!hadItems) { state.listFrozen = false; state.snapshot = null; renderList(); }
      }
      renderNewRow();
      return;
    }
    if (payload.unchanged) {
      // Ничего не изменилось: обновляем только счётчики и статус докачки.
      if (!Array.isArray(state.data.items)) return;     // состояние ещё не загружено
      if (Array.isArray(payload.feeds)) state.data.feeds = payload.feeds;
      // Сервер присылает непрочитанные по лентам компактно (46 чисел вместо дерева).
      if (payload.feedUnread && Array.isArray(state.data.feeds)) {
        for (const feed of state.data.feeds) {
          const unread = payload.feedUnread[feed.id];
          if (Number.isFinite(unread)) feed.unread = unread;
        }
      }
      state.data.counts = payload.counts;
      // Даже когда «ничего не изменилось», в разделе может не хватать статей:
      // список у нас порционный, а дерево показывает серверное число.
      const expectedNow = state.view.type === 'feed' ? Number(viewFeed()?.unread ?? 0) : 0;
      const hadItemsNow = itemsOfView().length > 0;
      if (expectedNow && itemsOfView().length < expectedNow) {
        const moreItems = await ensureViewItems(expectedNow);
        if (!hadItemsNow) { state.listFrozen = false; state.snapshot = null; renderList(); }
      }
      state.data.fetching = payload.fetching;
      state.data.refreshing = payload.refreshing;
      // Время последней синхронизации и отсчёт до следующей: без них счётчик
      // в шапке замирал на «0:00» и казалось, что обновление не идёт.
      if (payload.lastRefresh !== undefined) state.data.lastRefresh = payload.lastRefresh;
      if (payload.nextRefreshAt !== undefined) state.data.nextRefreshAt = payload.nextRefreshAt;
      if (payload.lastRefreshAdded !== undefined) state.data.lastRefreshAdded = payload.lastRefreshAdded;
      if (payload.lastRefreshFeeds !== undefined) state.data.lastRefreshFeeds = payload.lastRefreshFeeds;
      updateCountdown();
      refreshTimes();
      renderSidebar();
      renderToolbar();
      return;
    }
    if (!rememberData(payload)) return;         // ответ без данных не применяем
    verifyItemsOnce();                       // убрать карточки, которых на сервере уже нет
    if (state.listFrozen && state.snapshot) {
      // Лента заморожена: человек читает или листает, состав не менялся.
      // Пересобирать список нельзя — раньше он перерисовывался прямо под курсором
      // при каждом обновлении с сервера (отметки, счётчики, новые статьи).
      // Меняется только то, что вне ленты: дерево, шапка, плашка «Новых статей».
      renderSidebar();
      renderToolbar();
      renderNewRow();
      refreshTimes();
    } else {
      render();
    }
    flushPendingReads();                        // заодно отправим отложенные отметки
  } catch (err) {
    if (state.session.authenticated) toast(err.message, true);
  }
}

function setupSplitter() {
  const widths = { side: 260 };
  try { Object.assign(widths, JSON.parse(localStorage.getItem(WIDTH_KEY) ?? '{}')); } catch { /* по умолчанию */ }
  const apply = () => document.documentElement.style.setProperty('--w-side', `${widths.side}px`);
  apply();
  const el = $('#splitter');
  el.addEventListener('mousedown', (event) => {
    event.preventDefault();
    el.classList.add('dragging');
    const startX = event.clientX;
    const startWidth = widths.side;
    const move = (moveEvent) => {
      widths.side = Math.min(480, Math.max(180, startWidth + (moveEvent.clientX - startX)));
      apply();
    };
    const up = () => {
      el.classList.remove('dragging');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      localStorage.setItem(WIDTH_KEY, JSON.stringify(widths));
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

/**
 * Живые события сервера: если данные изменились не в этой вкладке (например,
 * статью отметил прочитанной клиент Fever на телефоне), список обновляется сразу,
 * без ожидания двухминутного опроса.
 */
let events = null;
/**
 * Всё, что нужно после успешной авторизации: восстановить раздел и включить
 * живые события. Раньше вызывалось только в start(), поэтому после ручного
 * входа не работали ни SSE, ни закрытие лайтбокса до перезагрузки страницы.
 */
function afterAuthInit() {
  // Лайтбокс навешиваем здесь же: после ручного входа start() не вызывается.
  setupLightboxHandlers();
  restoreView();
  startEvents();
}
let lightboxHandlersReady = false;   // слушатели просмотра картинок навешиваем один раз

function setupLightboxHandlers() {
  if (lightboxHandlersReady) return;
  lightboxHandlersReady = true;
  // Просмотр картинки: повторный клик по ней или по затемнению закрывает,
  // Esc — тоже. Так чтение возвращается на то же место: список не сдвигался.
  // Клик по кнопке «поделиться» не должен закрывать просмотр.
  $('#lightbox')?.addEventListener('click', (event) => {
    if (event.target.closest('#lightbox-share')) return;
    event.preventDefault();
    closeLightbox();
  });
  $('#lightbox-share')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    shareLightboxImage();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && lightboxVisible()) { event.preventDefault(); closeLightbox(); }
  });
}

function startEvents() {
  // Ошибки картинок ловим делегированно, без инлайн onerror в разметке.
  document.addEventListener('error', (event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement)) return;
    if (img.dataset.thumb) { img.remove(); return; }
    if (img.closest('#tree')) {
      const row = img.closest('[data-feed-row]');
      if (row?.dataset.feedRow) faviconFailed.add(row.dataset.feedRow);
      img.remove();
    }
  }, true);
  if (!('EventSource' in window) || events) return;
  try {
    events = new EventSource('/api/events');
    // Пока живые события подключены — опрос данных можно делать редким.
    events.onopen = () => { state.eventsReady = true; };
  } catch { return; }
  events.onmessage = async (event) => {
    let payload = null;
    try { payload = JSON.parse(event.data); } catch { return; }
    // Сервер вместе с ревизией присылает признак «идёт обновление». Без него
    // значки крутились до следующего опроса, если новых статей не появилось
    // (ревизия не меняется — сообщать было не о чем).
    if (typeof payload?.refreshing === 'boolean' && payload.refreshing !== Boolean(state.data.refreshing)) {
      state.data.refreshing = payload.refreshing;
      // Значки «обновить» есть и в дереве, и в шапке — обновляем оба места.
      renderSidebar();
      renderToolbar();
      updateFooterStats();
    }
    const revision = Number(payload?.revision);
    if (!Number.isFinite(revision) || revision === Number(state.revision)) return;
    await loadData({ poll: true });
  };
  events.onerror = () => {
    state.eventsReady = false;
    // EventSource переподключается сам; при разрыве продолжаем опрос по таймеру.
  };
}

// ------------------------------------------------------------ мобильный вид

/** Выдвижная панель подписок (на телефоне). */
function openTree(open) {
  const next = open === undefined ? !document.body.classList.contains('tree-open') : Boolean(open);
  document.body.classList.toggle('tree-open', next);
}

function setupMobile() {
  $('#menu-btn').addEventListener('click', () => openTree());
  $('#tree-backdrop').addEventListener('click', () => openTree(false));
  // На телефоне вторая половина шапки (режим, строки, порядок, ширина, фильтры)
  // скрыта за кнопкой «⋯»: иначе она занимает пол-экрана.
  // Меню «⋯»: тема, вид статей, обновление и настройки — вместо россыпи в шапке.
  const headMenu = $('#head-menu');
  const closeHeadMenu = () => { headMenu.hidden = true; };
  const syncHeadMenu = () => {
    const mode = viewMode();
    const select = $('#menu-view-mode');
    if (select) select.value = mode;
    // Текущие значения «непрочитанные/все» и «строк» — те же, что в шапке.
    const unread = $('#menu-unread');
    if (unread) unread.value = unreadModeFor() ? 'unread' : 'all';
    const linesSelect = $('#menu-lines');
    if (linesSelect) {
      const linesNow = Math.min(12, Math.max(1, Number(
        state.view.type === 'feed' ? (viewFeed()?.lines ?? state.settings.defaultLines ?? 2) : (state.settings.defaultLines ?? 2),
      )));
      linesSelect.value = String(linesNow);
    }
    const chosen = state.prefs.theme === 'auto' ? 'auto' : state.prefs.theme;
    for (const btn of headMenu.querySelectorAll('[data-theme-set]')) {
      btn.classList.toggle('on', btn.dataset.themeSet === chosen);
    }
  };

  $('#tune-btn').addEventListener('click', (event) => {
    event.stopPropagation();
    const open = headMenu.hidden;
    headMenu.hidden = !open;
    if (open) syncHeadMenu();
  });
  headMenu.addEventListener('click', (event) => {
    const themeBtn = event.target.closest('[data-theme-set]');
    if (themeBtn) {
      setThemeChoice(themeBtn.dataset.themeSet);
      syncHeadMenu();
      return;
    }
    if (event.target.closest('#menu-read-all')) { closeHeadMenu(); markAllInView(); return; }
  });
  // Жёсткое обновление: сносим кэши и service worker, чтобы приложение
  // гарантированно загрузило свежую версию (полезно, если оболочка «залипла»).
  const hardReload = async () => {
    toast('Обновляю приложение…');
    // Свои настройки вида (шрифты, строки краткого вида) сохраняем отдельно:
    // обновление не должно их сбрасывать, даже если браузер чистит хранилище.
    const keepPrefs = {};
    try {
      for (const key of Object.keys(localStorage)) if (key.startsWith('rss.') && key !== 'rss.prefs' ) keepPrefs[key] = localStorage.getItem(key);
      keepPrefs['rss.prefs'] = localStorage.getItem('rss.prefs');
      sessionStorage.setItem('rss.prefs.keep', JSON.stringify(keepPrefs));
    } catch { /* не критично */ }
    try {
      for (const name of await caches.keys()) await caches.delete(name);
      const registrations = await navigator.serviceWorker?.getRegistrations?.() ?? [];
      for (const registration of registrations) await registration.unregister();
    } catch { /* не критично */ }
    sessionStorage.removeItem('rss.reloaded');
    location.reload();
  };
  // Кнопка в меню убрана, обработчик оставлен на случай возврата.
  $('#menu-update')?.addEventListener('click', () => { closeHeadMenu(); hardReload(); });
  $('#sidebar-update')?.addEventListener('click', hardReload);

  $('#menu-view-mode')?.addEventListener('change', (event) => {
    setViewMode(event.target.value);
  });
  // «Непрочитанные / Все» — то же, что переключатель в шапке.
  $('#menu-unread')?.addEventListener('change', (event) => {
    const onlyUnread = event.target.value !== 'all';
    if (state.view.type === 'feed') {
      state.prefs.feedUnread = { ...(state.prefs.feedUnread ?? {}), [state.view.id]: onlyUnread };
    } else {
      state.prefs.unreadOnly = onlyUnread;
    }
    savePrefs();
    state.limit = 10;
    state.view = { ...state.view };
    resetSnapshot();
    closeHeadMenu();
    render();
  });
  // «Строк» — как в шапке: запоминается у ленты.
  $('#menu-lines')?.addEventListener('change', async (event) => {
    const lines = Math.min(12, Math.max(1, Number(event.target.value) || 2));
    closeHeadMenu();
    if (state.view.type === 'feed') {
       await applyFeedSetting({ lines });
      renderList();                           // иначе список ждал следующего опроса
    } else {
      state.settings.defaultLines = lines;
      pushSettings({ defaultLines: lines });
      render();
    }
  });
  document.addEventListener('click', (event) => {
    if (headMenu.hidden) return;
    if (event.target.closest('#head-menu') || event.target.closest('#tune-btn')) return;
    closeHeadMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !headMenu.hidden) closeHeadMenu();
  });

  // Свайпы: вправо с левой половины — открыть подписки, влево по открытой панели —
  // закрыть её, влево по правой половине — перейти к следующей статье.
  let startX = 0;
  let startY = 0;
  let startTime = 0;
  let tracking = false;
  document.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1) { tracking = false; return; }
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
    startTime = Date.now();
    tracking = true;
  }, { passive: true });
  document.addEventListener('touchend', (event) => {
    if (!tracking) return;
    tracking = false;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (Date.now() - startTime > 900) return;                       // удержание — не свайп
    if (Math.abs(dx) < 55 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
    const open = document.body.classList.contains('tree-open');
    if (dx > 0) {
      // Свайп вправо из ЛЮБОГО места экрана открывает дерево подписок.
      if (!open) openTree(true);
      return;
    }
    if (open) { openTree(false); return; }                           // влево при открытой панели: закрыть её
    // Влево при закрытой панели — следующая статья.
    if (state.prefs.swipeNext === false) return;   // жест выключен в настройках этого устройства
    const id = state.selectedId ?? state.activeId;
    if (id) goRelative(id, 1);
  }, { passive: true });
}

// -------------------------------------------------------- приложение на телефон

/**
 * PWA: сервис-воркер (чтобы приложение открывалось с домашнего экрана и без сети)
 * и кнопка установки. Браузеры Android предлагают установку сами, iOS — только
 * вручную через «Поделиться» → «На экран „Домой“», поэтому там показываем подсказку.
 */
// Версия приложения: показывается на экране входа и в настройках.
// Версия приложения: 1.0.<номер сборки ресурсов>. Номер берётся из запроса
// к самому app.js (app.js?v=NNN), поэтому версия всегда совпадает со сборкой.
const BUILD = (() => {
  // Номер сборки берём из адреса модуля. Если ответ пришёл из кэша без ?v=
  // (так бывало после смены Service Worker), читаем адрес тега script —
  // он всегда содержит версию.
  const fromUrl = (value) => Number.parseInt(/[?&]v=(\d+)/.exec(String(value ?? ''))?.[1] ?? '0', 10) || 0;
  const direct = fromUrl(import.meta.url ?? '');
  if (direct) return direct;
  const tag = document.querySelector('script[src*="app.js"]');
  return fromUrl(tag?.getAttribute('src') ?? '');
})();

// Диагностика включается ссылкой ?debug=1: служебные строки и счётчики медиа.
const DEBUG = new URLSearchParams(location.search).get('debug') === '1';
const APP_VERSION = `1.${BUILD}`;

function setupPwa() {
  const versionLabel = 'Версия ' + APP_VERSION + ' · обновляется автоматически';
  const versionEl = $('#splash-version');
  if (versionEl) versionEl.textContent = versionLabel;
  const settingsVersion = $('#settings-version');
  if (settingsVersion) settingsVersion.textContent = versionLabel;
  const sidebarVersion = $('#sidebar-version');
  if (sidebarVersion) {
    // Показываем заодно версии стилей и кэша: по ним видно, обновилось ли приложение.
    const styleTag = document.querySelector('link[rel="stylesheet"]');
    const styleVersion = /v=(\d+)/.exec(styleTag?.href ?? '')?.[1] ?? '?';
    // Диагностика: видно, сколько статей клиент считает прочитанными и сколько
    // отметок ещё не ушло на сервер — по этим числам понятно, где теряется состояние.
    const readCount = (state.data.items ?? []).filter((i) => i.read).length;
    const pendingCount = pendingReads.size;
    updateFooterStats();
  }

  // Кнопка «Обновить приложение» нужна только когда браузер уже скачал новую
  // версию, но ещё не переключился на неё. Сравнение версий по сети давало
  // ложные срабатывания, поэтому ориентируемся на состояние service worker.

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname))) {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .catch(() => { /* без воркера всё работает как раньше */ });
    // Новая версия оболочки приходит сама: как только воркер активировался,
    // перезагружаем страницу один раз — иначе в установленном приложении
    // остаётся старая копия и «ничего не меняется».
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'reload' && sessionStorage.getItem('rss.reloaded') !== '1') {
        sessionStorage.setItem('rss.reloaded', '1');
        location.reload();
      }
    });
  }

  const button = $('#install-app');
  const topButton = $('#install-top');
  const show = (visible) => {
    button.hidden = !visible;
    topButton.hidden = !visible;
  };
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  // На iPhone установка только вручную, поэтому подсказку показываем сразу.
  if (isIos && !standalone) show(true);

  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;                 // придержим, чтобы показать по кнопке
    show(true);
  });

  const install = async () => {
    if (installPrompt) {
      installPrompt.prompt();
      const choice = await installPrompt.userChoice.catch(() => null);
      installPrompt = null;
      if (choice?.outcome === 'accepted') show(false);
      return;
    }
    toast(isIos
      ? 'В Safari: «Поделиться» → «На экран „Домой“»'
      : 'Откройте меню браузера и выберите «Установить приложение»');
  };
  button.addEventListener('click', install);
  topButton.addEventListener('click', install);

  window.addEventListener('appinstalled', () => {
    show(false);
    toast('Приложение установлено');
  });
}

async function start() {
  showLoader('Загружаю ленты…');   // пока данных нет, экран не должен пустовать
  loadPrefs();  // Параметры адреса: ?theme=light|dark|auto — удобно для ссылок и проверки вида.
  const params = new URLSearchParams(location.search);
  const themeParam = params.get('theme');
  if (['dark', 'light', 'auto'].includes(themeParam)) { state.prefs.theme = themeParam; applyTheme(); }
  setupSplitter();
  setupMobile();
  setupPwa();
  render();
  try {
    const session = await (await fetch('/api/session')).json();
    state.session = session;
    if (session.user) state.settings.user = session.user;
    if (session.authRequired && !session.authenticated) { showLogin(); return; }
  } catch { /* сервер недоступен */ }
  await loadSettings();
  await loadData();
  afterAuthInit();        // восстановить раздел и включить живые события
  hideLoader();                           // данные пришли — снимаем затемнение
}

if (DEBUG) window.__rssDebug = { state, itemsOfView, visibleItems, renderList, renderToolbar, renderSidebar, updateFooterStats, ensureBodiesNeeded, expandItem, loadData, rememberData, render, viewKey, markCommentsSeen, commentHighlightHold, bodyHtml, sanitize, imageSrc };

start();
let pollTimer = null;              // таймер опроса сервера (перепланируется сам)

// Опрашиваем всегда: иначе при раскрытой статье список и время «замирают».
  // Опрос сервера, счётчики и время не мешают прокрутке: пока она идёт,
  // задачи откладываются и выполняются, когда список остановился.
  // В режиме Fever работаем «по синхронизации»: опрос редкий, без лишнего фона.
  // Опрос с адаптивным шагом: feverMode() читаем НА КАЖДОЙ итерации.
  // Раньше интервал вычислялся один раз при старте скрипта — до загрузки
  // настроек с сервера, поэтому режим Fever не влиял на частоту.
  // С живыми событиями (SSE) изменения приходят сразу, поэтому опрос остаётся
  // только страховкой: иначе простой стоил ~2 КБ в минуту. Если события оборвутся,
  // onerror вернёт обычный интервал опроса.
  const schedulePoll = () => {
    pollTimer = setTimeout(async () => {
      try {
        if (state.scrolling) state.deferredPoll = true;
        else if (!document.hidden) await loadData({ poll: true });
      } catch { /* следующий шаг всё равно назначим */ }
      // Пока идёт обновление, ждать пять минут нельзя: значки должны гаснуть
      // сразу после окончания, поэтому на этот случай шаг короче.
      if (state.data.refreshing) {
        clearTimeout(pollTimer);
        pollTimer = setTimeout(async () => {
          try { await loadData({ poll: true }); } catch { /* повторим */ }
          schedulePoll();
        }, 10_000);
        return;
      }
      schedulePoll();
    }, state.eventsReady ? 300_000 : (feverMode() ? 60_000 : 20_000));
    pollTimer.unref?.();
  };
  schedulePoll();
  setInterval(() => {
    if (feverMode()) return;                       // в Fever очередь не опрашиваем
    if (state.scrolling || document.hidden) return;
    if (state.data.fetching?.pending) { loadData({ poll: true }); renderQueueInfo(); }
  }, 30_000);
  setInterval(() => { if (state.scrolling || document.hidden) return; refreshTimes(); renderToolbar(); }, 60_000);

/** Обратный отсчёт до следующего автообновления лент. */
function updateCountdown() {
  const el = $('#refresh-countdown');
  if (!el) return;
  // Считаем сами: время последней синхронизации + интервал из настроек.
  // Полагаться на серверное nextRefreshAt нельзя — оно могло остаться в
  // прошлом, и тогда счётчик замирал на 0:00.
  const intervalMin = Number(state.settings?.refreshMinutes) || 10;
  const last = Date.parse(state.data.lastRefresh ?? '') || 0;
  const at = Number(state.data.nextRefreshAt) > Date.now()
    ? Number(state.data.nextRefreshAt)
    : (last ? last + intervalMin * 60_000 : 0);
  if (!at) { el.textContent = '—'; return; }
  const left = Math.max(0, at - Date.now());
  const minutes = Math.floor(left / 60_000);
  const seconds = Math.floor((left % 60_000) / 1000);
  // Ноль показываем только мгновение: дальше честно пишем, что идёт обновление.
  // Крутим стрелку только пока обновление реально идёт: раньше она крутилась
  // после нуля бесконечно, если сервер так и не прислал новый отчёт.
  const refreshing = Boolean(state.data.refreshing);
  const justKicked = Date.now() - (state.refreshKickedAt ?? 0) < 90_000;
  const refreshingNow = left === 0 && (refreshing || justKicked);
  // Пока идёт обновление, на месте часов — прочерк: крутится только кнопка рядом,
  // второй «пропеллер» здесь не нужен.
  el.textContent = refreshingNow ? '—' : `⏱ ${minutes}:${String(seconds).padStart(2, '0')}`;
  el.title = refreshingNow ? 'Обновляю ленты…' : 'До следующего обновления лент';
  el.classList.remove('spinning');

  // Отсчёт дошёл до нуля — сразу спрашиваем сервер и, если он ещё не обновил
  // ленты, просим обновить (не чаще раза в минуту).
  if (left === 0 && Date.now() - (state.refreshKickedAt ?? 0) > 60_000) {
    state.refreshKickedAt = Date.now();
    loadData({ poll: true })
      .then(() => api('/api/refresh', { force: false }).then(() => loadData({ poll: true })))
      .catch(() => {});
  }
}
setInterval(updateCountdown, 1000);
updateCountdown();

// ------------------------------------------------------------- санитайзер

/** Убирает из HTML статьи всё опасное и починяет относительные ссылки. */
function sanitize(html, baseUrl, { slot = true } = {}) {
  if (!html) return '';
  const allowed = new Set(['A', 'P', 'BR', 'HR', 'DIV', 'SPAN', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'DEL', 'INS', 'CODE', 'PRE',
    'BLOCKQUOTE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'IMG', 'FIGURE', 'FIGCAPTION', 'PICTURE', 'SOURCE',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION', 'VIDEO', 'AUDIO', 'SUB', 'SUP', 'SMALL', 'MARK',
    'DL', 'DT', 'DD', 'ABBR', 'TIME', 'CITE', 'Q', 'KBD', 'SAMP', 'VAR', 'SECTION', 'ARTICLE', 'ASIDE', 'MAIN',
    'BUTTON']);   // кнопки плееров внутри статьи
  // Плееры в статьях. Раньше тут подставлялся встроенный плеер по нажатию, но
  // такие вставки тяжёлые и часто не работают вне своего сайта. Теперь на месте
  // плеера — кнопка-ссылка: видео открывается в браузере пользователя, наша
  // страница не грузит ни одного кадра.
  // Реклама тоже бывает в iframe — её кнопкой не показываем.
  const isAdEmbed = (url) => /adriver|doubleclick|googlesyndication|an\.yandex\.ru|ad\.mail\.ru/i.test(String(url));
  // Один и тот же плеер может прийти дважды: заметкой embed: из текста и обычной
  // ссылкой ниже. Кнопку показываем только первую.
  const seenEmbeds = new Set();
  const embedLink = (url, title) => {
    const decoded = String(url)
      .replace(/&#0*38;|&amp;/gi, '&')
      .replace(/&quot;/g, '"')
      .trim();
    // Вставляем в href и data-embed только http(s): иначе ссылка вида
    // javascript:… выполнилась бы в контексте читалки.
    if (!/^https?:/i.test(decoded)) return '';
    if (isAdEmbed(decoded)) return '';
    const key = decoded.toLowerCase().replace(/\/+$/, '');
    if (seenEmbeds.has(key)) return '';
    seenEmbeds.add(key);
    const safe = decoded.replace(/"/g, '&quot;');
    // Плеер появляется только по нажатию — до этого никакого трафика.
    // Рядом ссылка на сайт: некоторые плееры (ВК) вне своего сайта не играют.
    return `<div class="embed-box" data-embed="${safe}">`
      + `<button type="button" class="btn embed-play">▶ ${esc(title || 'Смотреть здесь')}</button>`
      + `<a class="embed-alt" href="${safe}" target="_blank" rel="noopener noreferrer">Открыть на сайте</a>`
      + `</div>`;
  };
  html = String(html).replace(/<p[^>]*>[^<]*youtube:([\w-]{6,})[^<]*<\/p>/gi,
    (match, id) => embedLink(`https://www.youtube.com/embed/${id}?autoplay=1`, 'Смотреть видео'));
  html = String(html).replace(/<p[^>]*>[^<]*embed:([^<\s]+)[^<]*<\/p>/gi,
    (match, url) => embedLink(url, 'Смотреть видео'));
  // Обычная ссылка на видео в тексте (YouTube, RuTube, VK, Дзен, OK): превращаем
  // в кнопку плеера. Ограничений по количеству нет — сколько ссылок, столько кнопок.
  const videoEmbedFor = (rawUrl) => {
    const url = String(rawUrl).replace(/&#0*38;|&amp;/gi, '&').trim();
    if (!/^https?:/i.test(url)) return null;
    const youtube = /(?:youtube\.com\/(?:watch\?[^#]*?\bv=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{6,})/i.exec(url)?.[1];
    if (youtube) return { embed: `https://www.youtube.com/embed/${youtube}?autoplay=1`, title: 'Смотреть на YouTube' };
    const rutube = /rutube\.ru\/(?:video|play\/embed)\/([0-9a-f]{16,})/i.exec(url)?.[1];
    if (rutube) return { embed: `https://rutube.ru/play/embed/${rutube}`, title: 'Смотреть на RuTube' };
    if (/vk\.com\/video|vkvideo\.ru\/video/i.test(url)) return { embed: url, title: 'Смотреть во ВКонтакте' };
    if (/dzen\.ru\/video|ok\.ru\/video/i.test(url)) return { embed: url, title: 'Смотреть видео' };
    return null;
  };
  html = String(html).replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (match, href, inner) => {
    const found = videoEmbedFor(href);
    if (!found) return match;
    // Ссылка-картинка (обложка) — не трогаем, иначе вместо неё будет кнопка.
    if (/<img\b/i.test(inner)) return match;
    return embedLink(found.embed, found.title);
  });
  html = String(html).replace(/<iframe\b[^>]*\bsrc=["']([^"']+)["'][^>]*>(?:[\s\S]*?<\/iframe>)?/gi, (match, src) => {
    const id = /(?:youtube\.com\/embed\/|youtube-nocookie\.com\/embed\/|youtu\.be\/)([\w-]{6,})/i.exec(src)?.[1];
    const absolute = /^https?:/i.test(src) ? src : '';
    if (id) return embedLink(`https://www.youtube.com/embed/${id}?autoplay=1`, 'Смотреть на YouTube');
    if (absolute) return embedLink(absolute, 'Открыть видео на сайте');
    return '';
  });
  // Встроенный <video> из ленты: тоже кнопка, а не плеер внутри страницы.
  html = String(html).replace(/<video\b[^>]*>[\s\S]*?<\/video>/gi, (block) => {
    const src = /\bsrc=["']([^"']+)["']/i.exec(block)?.[1]
      ?? /<source\b[^>]*\bsrc=["']([^"']+)["']/i.exec(block)?.[1]
      ?? '';
    if (!/^https?:/i.test(src)) return '';
    // Прямой видеофайл (Telegram, mp4/webm): обычный плеер без предзагрузки —
    // трафик пойдёт только после «play». Через наш прокси, потому что CDN
    // Telegram не отдаёт файл напрямую.
    if (/\.(mp4|webm|ogv|m4v|mov|m3u8)(\?|#|$)/i.test(src)) {
      // Видео Telegram всегда идёт через наш прокси: прямые ссылки CDN
      // привязаны к сессии и у части пользователей не открываются.
      const proxied = `/api/video?u=${encodeURIComponent(src)}`;
      return `<video class="video-inline" controls preload="none" playsinline src="${proxied}"></video>`;
    }    return embedLink(src, 'Открыть видео');
  });
  const doc = new DOMParser().parseFromString(`<div id="__root">${html}</div>`, 'text/html');
  const root = doc.getElementById('__root');
  if (!root) return '';
  const resolve = (value) => {
    try { return new URL(value, baseUrl || location.href).href; } catch { return ''; }
  };
  // Страница статьи уходит на сервер как реферер: часть сайтов отдаёт картинки
  // только запросам со своей страницы (иначе 403 и пустые места в тексте).
  const pageParam = baseUrl ? `&r=${encodeURIComponent(baseUrl)}` : '';
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const doomed = [];
  while (walker.nextNode()) {
    const el = walker.currentNode;
    if (!allowed.has(el.tagName) || el.id === '__root') { doomed.push(el); continue; }
    // Картинкам и видео в тексте не оставляем размеры из разметки: иначе браузер
    // заранее резервирует место, и до загрузки видно белое поле. Пусть место
    // появляется вместе с картинкой.
    // Картинки-счётчики («поделиться», пиксели, маячки аналитики) выбрасываем
    // сразу: места они не занимают, но читалка рисовала под них пустую рамку с
    // кнопкой «Не загрузилась — повторить».
    if (el.tagName === 'IMG') {
      const src = el.getAttribute('src') ?? '';
      const width = Number(el.getAttribute('width') ?? 0);
      const height = Number(el.getAttribute('height') ?? 0);
      const tracker = /(\/(share|pixel|pixel\.gif|counter|count|stat|stats|track|tracker|analytics|beacon|1x1)[\/._-]|(^|\/\/)(mc\.yandex|top-fwz1|tns-counter|www\.tns-counter|b\.scorecardresearch|px\.|counter\.|informer\.))/i;
      if ((width > 0 && width <= 2) || (height > 0 && height <= 2) || tracker.test(src)) {
        doomed.push(el);
        continue;
      }
    }
    if (el.tagName === 'IMG' || el.tagName === 'VIDEO') {
      el.removeAttribute('width');
      el.removeAttribute('height');
    }
    // Грузим картинки по мере прокрутки: иначе статья с сотней картинок
    // отправляет сотню запросов сразу, сайт отвечает отказами, и часть
    // изображений так и не появляется.
    if (el.tagName === 'IMG') {
      el.setAttribute('loading', 'lazy');
      el.setAttribute('decoding', 'async');
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name.startsWith('on') || name === 'style' || name === 'srcdoc' || name === 'formaction') {
        el.removeAttribute(attr.name);
      } else if (['href', 'src', 'poster'].includes(name)) {
        // Свои ссылки (/api/media) оставляем как есть — их не надо ни резолвить, ни проксировать.
        const internal = value.startsWith('/api/');
        const abs = internal ? value : resolve(value);
        if (internal || /^(https?:|mailto:|data:image\/)/i.test(abs) || abs.startsWith(location.origin + '/api/')) {
          // Картинки по http:// на странице https браузер блокирует («смешанное
          // содержимое») — отдаём их через свой прокси. Ссылки не трогаем.
          // Картинки и видео всегда отдаём через свой прокси: он снимает проблему
          // «смешанного содержимого», запрета хотлинков и чужого референта.
          // Внутренние ссылки (/api/media) не оборачиваем повторно в прокси:
          // иначе сервер запрашивал бы сам себя без сессии и получал отказ.
          const isMedia = !internal && name !== 'href' && /^https?:\/\//i.test(abs) && !abs.startsWith(location.origin + '/api/');
          const isVideo = el.tagName === 'VIDEO' || el.tagName === 'AUDIO' || el.tagName === 'SOURCE';
          const proxied = isMedia
            ? (isVideo ? `/api/video?u=${encodeURIComponent(abs)}` : `/api/img?u=${encodeURIComponent(abs)}${pageParam}`)
            : abs;
          el.setAttribute(attr.name, proxied);
        } else el.removeAttribute(attr.name);
      } else if (name === 'srcset') {
        const fixed = value.split(',').map((part) => {
          const [url, ...rest] = part.trim().split(/\s+/);
          const abs = resolve(url);
          if (!/^https?:/i.test(abs)) return '';
          const src = /^https?:/i.test(abs) ? `/api/img?u=${encodeURIComponent(abs)}${pageParam}` : abs;
          return [src, ...rest].join(' ');
        }).filter(Boolean).join(', ');
        if (fixed) el.setAttribute('srcset', fixed); else el.removeAttribute('srcset');
      }
    }
    if (el.tagName === 'A' && el.getAttribute('href')) {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer nofollow');
    }
    if (el.tagName === 'IMG' || el.tagName === 'VIDEO') el.setAttribute('loading', 'lazy');

  }
  for (const el of doomed) el.remove();

  // Одиночную картинку (или видео) в отдельном абзаце показываем по центру.
  for (const block of root.querySelectorAll('p, div, figure')) {
    const children = [...block.children];
    if (!children.length) continue;
    const text = (block.textContent ?? '').replace(/\s+/g, '');
    if (text) continue;
    const onlyMedia = children.every((el) => ['IMG', 'VIDEO', 'PICTURE', 'SOURCE', 'A', 'BR'].includes(el.tagName));
    if (onlyMedia && block.querySelector('img, video')) block.classList.add('img-alone');
  }
  // Подряд идущие картинки собираем в один блок: тогда читалка раскладывает их
  // в несколько колонок, если по ширине помещается больше одной, вместо длинной
  // ленты одиночных картинок.
  // Картинки постов (/api/media) в общий ряд не собираем: каждая остаётся
  // своим абзацем во всю ширину, так они гарантированно видны.
  const ownsMedia = (node) => node.nodeType === 1
    && node.classList?.contains('img-alone')
    && !node.classList.contains('img-row')
    && !node.querySelector('img[src^="/api/media"]');
  let run = [];
  const flush = () => {
    if (run.length < 2) { run = []; return; }
    const row = document.createElement('div');
    row.className = 'img-row';
    row.dataset.count = String(run.length);
    run[0].before(row);
    for (const block of run) {
      for (const media of [...block.querySelectorAll('img, video')]) row.append(media);
      block.remove();
    }
    run = [];
  };
  for (const node of [...root.children]) {
    if (ownsMedia(node)) run.push(node);
    else flush();
  }
  flush();

  // Слоты — только для обычных статей: в лентах «только картинки» изображения
  // собираются отдельно, и подмена <img> на слот оставляла статью без картинок.
  if (slot) slotifyImages(root);
  trimPromoTail(root);
  return root.innerHTML;
}

/**
 * Убирает хвостовые «анонсы» Хабра: заголовок, состоящий из одной ссылки на другую
 * статью, и всё, что идёт после него (пересказ и список таких же ссылок).
 * В самом тексте статьи ссылки не трогаем — только этот концевой блок.
 */
/**
 * Каждую картинку статьи превращаем в «место под картинку» с кнопкой.
 * Пока картинка не пришла, видно рамку с кнопкой «Загрузить картинку» — по клику
 * пробуем ещё раз. Главное правило: превращение делаем ТОЛЬКО в обычных статьях,
 * не в лентах «только картинки» — там клиент сам собирает изображения, и подмена
 * <img> на слот оставляла статью без картинок вовсе.
 */
function slotifyImages(root) {
  for (const img of [...root.querySelectorAll('img')]) {
    const src = img.getAttribute('src') ?? '';
    if (!src || img.closest('.img-slot')) continue;
    if (/^data:/i.test(src)) continue;
    const slot = document.createElement('div');
    slot.className = 'img-slot';
    slot.dataset.src = src;
    const clone = img.cloneNode(false);
    clone.removeAttribute('src');
    // lazy + скрытая картинка = браузер не грузит её вообще: загрузкой управляем сами.
    clone.removeAttribute('loading');
    clone.removeAttribute('decoding');
    clone.setAttribute('data-lazy-img', '1');
    clone.setAttribute('hidden', '');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'img-load';
    button.setAttribute('data-img-load', '1');
    button.textContent = 'Загрузить картинку';
    slot.append(clone, button);
    img.replaceWith(slot);
  }
}

/** Подключает места под картинки: близкие к экрану грузим сами, остальные — по клику. */
let slotObserver = null;
function setupImageSlots(root = document) {
  if (!slotObserver) {
    slotObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        slotObserver.unobserve(entry.target);
        loadSlotImage(entry.target);
      }
    }, { root: $('#list') ?? null, rootMargin: '600px 0px' });
  }
  for (const slot of root.querySelectorAll('.img-slot:not([data-state])')) {
    slot.dataset.state = 'wait';
    slotObserver.observe(slot);
  }
}

/** Грузит картинку в конкретное место. force — повторная попытка по кнопке. */
function loadSlotImage(slot, force = false) {
  const img = slot.querySelector('img[data-lazy-img]');
  const src = slot.dataset.src;
  if (!img || !src) return;
  slot.dataset.state = 'loading';
  if (force) slot.removeAttribute('data-failed');
  img.removeAttribute('loading');
  img.src = force ? `${src}${src.includes('?') ? '&' : '?'}n=${Date.now()}` : src;
  img.onload = () => {
    img.hidden = false;
    img.classList.remove('broken');
    slot.dataset.state = 'ready';
    slot.classList.add('ready');
    const button = slot.querySelector('.img-load');
    if (button) button.remove();
  };
  img.onerror = () => {
    img.hidden = true;
    slot.dataset.state = 'failed';
    slot.setAttribute('data-failed', '1');
    let button = slot.querySelector('.img-load');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'img-load';
      button.setAttribute('data-img-load', '1');
      slot.append(button);
    }
    button.textContent = 'Не загрузилась — повторить';
  };
}
function trimPromoTail(root) {
  const nodes = [...root.children];
  const from = Math.max(0, nodes.length - 12);
  // Идём от начала хвоста вниз: нужен САМЫЙ РАННИЙ заголовок-анонс, иначе
  // вырежется только последняя ссылка, а список останется.
  for (let i = from; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (!/^H[1-4]$/.test(node.tagName)) continue;
    const links = node.querySelectorAll('a');
    if (links.length !== 1) continue;
    const text = node.textContent.replace(/\s+/g, ' ').trim();
    const linkText = links[0].textContent.replace(/\s+/g, ' ').trim();
    if (!text || text !== linkText) continue;              // заголовок целиком из ссылки
    const href = links[0].getAttribute('href') ?? '';
    if (!/\/articles\/\d+/.test(href)) continue;            // ссылка на другую статью
    for (let j = nodes.length - 1; j >= i; j -= 1) nodes[j].remove();
    break;
  }
}
