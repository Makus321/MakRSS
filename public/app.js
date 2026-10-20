/* Читалка: слева дерево подписок, справа список статей.
   Статья раскрывается прямо в списке; если текста нет — он докачивается по клику. */

const $ = (sel) => document.querySelector(sel);
const PREF_KEY = 'rss.prefs';
// Раз в час читалка в фоне просит сервер докачать полные тексты и прогревает
// кэш статей — чтобы при плохой связи они открывались из памяти.
const WARM_INTERVAL_MS = 60 * 60 * 1000;
const WARM_KEY = 'rss.warmedAt';
const WIDTH_KEY = 'rss.widths';
const COLLAPSE_KEY = 'rss.collapsed';

const state = {
  data: { feeds: [], folders: [], items: [], counts: { all: 0, unread: 0, starred: 0 }, fetching: {} },
  settings: { authEnabled: false, envAuth: false, user: '', fever: null, fetchFull: true, defaultView: 'compact-thumb', defaultLines: 4, defaultWidth: 100, telegram: {} },
  session: { authRequired: false, authenticated: true },
  view: { type: 'unread', id: null },   // unread | starred | feed | folder (all — только как запасной)
  snapshot: null,                       // состав списка, зафиксированный при входе в ленту
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
    readOnExpand: true, readOnScroll: true, readOnFinish: false,
    treeFilter: 'all',
    unreadOnly: true,
    width: 0,                             // ширина текста: своя на каждом устройстве (0 — ещё не задана)
  },
  collapsed: new Set(),                 // свёрнутые папки
  collapsedItems: new Set(),            // статьи, свёрнутые вручную
  expandedItems: new Set(),             // статьи, раскрытые вручную
  commentsOnly: new Set(),              // раскрыты только комментарии, без текста статьи
  bodies: new Map(),                    // id -> { content, fullHtml, note }
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

const plural = (n, one, few, many) => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
};

function toast(message, isError = false, place = 'bottom') {
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
const FONT_VARIANTS = new Set(['system', 'condensed', 'book', 'mono', 'cursive', 'tight', 'airy', 'display']);
const fontVariant = (value) => (FONT_VARIANTS.has(value) ? value : 'system');

/** Сенсорный экран (телефон, планшет, раскладной) или узкое окно. */
function isTouchDevice() {
  return window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(max-width: 560px)').matches;
}

// Выбор размера шрифта на телефоне применяется на ступень крупнее.
const MOBILE_FONT_STEP = {
  // дерево подписок (12 / 13 / 16.5 / 20)
  '12px': '14px',
  '13px': '14.5px',
  '16.5px': '20px',
  '20px': '24px',
  // текст статьи и краткий вид (13 / 14.5 / 18 / 22)
  '14.5px': '18px',
  '18px': '22px',
  '22px': '26px',
};

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
  const bigger = (value, fallback) => {
    const size = fontPx(value, fallback);
    if (!mobile) return size;
    return MOBILE_FONT_STEP[size] ?? size;
  };
  // Остальной интерфейс подстраивается под размер шрифта дерева (13px — обычный).
  const treeSize = parseFloat(bigger(state.prefs.fontTree, '13px')) || 13;
  document.documentElement.style.setProperty('--ui-scale', String(Math.max(0.8, Math.min(1.6, treeSize / 13))));
  root.style.setProperty('--font-tree', bigger(state.prefs.fontTree, '13px'));
  root.style.setProperty('--font-article', bigger(state.prefs.fontArticle, '14.5px'));
  root.style.setProperty('--font-excerpt', bigger(state.prefs.fontExcerpt, '14.5px'));
  $('#list').classList.toggle('comfortable', state.prefs.density === 'comfortable');
  // «Невидимые рамки» — минималистичный вид: у карточек и панелей рамок нет,
  // остаётся только подсветка активной статьи.
  document.body.classList.toggle('no-borders', state.prefs.borders === false);
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

// ---------------------------------------------------------------------- API

async function api(path, body, options = {}) {
  const init = body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
  if (options.signal) init.signal = options.signal;
  const res = await fetch(path, init);
  const payload = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (res.status === 401 && payload.authRequired) {
    state.session.authenticated = false;
    showLogin();
  }
  if (!res.ok && payload.ok !== false) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload;
}

/** Принять новое состояние и запомнить его ревизию (для дешёвых опросов). */
/** Годится ли ответ в состояние: в нём обязательно должен быть массив статей. */
const looksLikeData = (data) => Boolean(data) && Array.isArray(data.items) && Array.isArray(data.feeds);

const rememberData = (data) => {
  if (!looksLikeData(data)) return false;         // ответ без данных (нет сети, кэш) — не трогаем состояние
  // Отметки о прочтении, сделанные без сети, важнее того, что пришло с сервера.
  applyPendingReads(data.items);
  state.data = data;
  state.revision = data?.revision ?? state.revision;
  return true;
};

const applyPayload = (payload) => { if (payload?.data && rememberData(payload.data)) render(); };

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
const viewFolder = () => state.data.folders.find((f) => f.id === state.view.id) ?? null;
const feedById = (id) => state.data.feeds.find((f) => f.id === id) ?? null;

/** Режим показа для канала: своя настройка либо общая по умолчанию. */
const feedMode = (feedId) => feedById(feedId)?.view ?? state.settings.defaultView ?? 'compact-thumb';

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
}

/** Текст самой статьи — по нему работают фильтры ленты. Название ленты не в счёт:
 *  иначе фильтр «Видео» в ленте «…и видео приколы» скрывал бы все статьи сразу.
 *  У постов Telegram заголовок — это имя канала, поэтому смотрим только текст. */
function articleHaystack(item) {
  const telegram = (item.categories ?? []).includes('telegram');
  return `${telegram ? '' : item.title ?? ''} ${item.excerpt ?? ''}`.toLowerCase();
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
  return state.data.items.filter((item) => {
    if (state.view.type === 'feed' && item.feedId !== state.view.id) return false;
    if (state.view.type === 'folder' && feedById(item.feedId)?.folderId !== state.view.id) return false;
    if (state.view.type === 'starred' && !item.starred) return false;
    if (!passesFeedFilters(item)) return false;          // фильтры, сохранённые для ленты
    if (q && !searchHaystack(item).includes(q)) return false;
    return true;
  });
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
  if (!state.snapshot || state.snapshot.key !== key) {
    state.snapshot = {
      key,
      // Снимок — это то, что видно сейчас: в режиме «только непрочитанные»
      // в него попадают непрочитанные статьи.
      ids: new Set(itemsOfView().filter((item) => !onlyUnread || !item.read).map((item) => item.id)),
    };
  }
  const snapshot = state.snapshot.ids;
  const items = itemsOfView().filter((item) => snapshot.has(item.id));
  const direction = sortDir() === 'asc' ? 1 : -1;
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

function render() {
  renderSidebar();
  renderToolbar();
  renderList();
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
  const feeds = rawFeeds.map((feed) => ({ ...feed, ...(perFeed.get(feed.id) ?? { unread: 0, total: 0 }) }));
  $('#badge-unread').textContent = unreadAll || '';
  $('#badge-starred').textContent = starredAll || '';
  $('#feed-count').textContent = feeds.length ? `${feeds.length}` : '';
  for (const btn of document.querySelectorAll('.nav-item')) btn.classList.toggle('active', state.view.type === btn.dataset.view);

  const feedRow = (feed) => {
    const active = state.view.type === 'feed' && state.view.id === feed.id;
    const letter = (feed.title || '?').trim().charAt(0).toUpperCase();
    return `<li><div class="row feed-row${active ? ' active' : ''}${feed.lastError ? ' warn' : ''}"
        data-feed-row="${esc(feed.id)}" draggable="true" title="${esc(feed.lastError || feed.url)}">
      <span class="fav" aria-hidden="true">
        <span class="fav-letter">${esc(letter)}</span>
        <img src="/api/favicon?f=${esc(feed.id)}" alt="" loading="lazy" onerror="this.remove()">
      </span>
      <span class="row-name${feed.unread ? ' unread' : ''}">${esc(feed.title)}</span>
      <span class="row-actions">
        <button data-feed-rename="${esc(feed.id)}" title="Переименовать">✎</button>
        <button class="del" data-feed-del="${esc(feed.id)}" title="Отписаться">×</button>
      </span>
      ${badge(
      // В режиме «Все» показываем, сколько статей всего, иначе — сколько непрочитанных.
      state.prefs.feedUnread?.[feed.id] === false ? feed.total : feed.unread,
      state.data.addedByFeed?.[feed.id] ?? 0,
    )}
    </div></li>`;
  };

  let html = '';
  const visibleFeeds = (list) => (state.prefs.treeFilter === 'unread'
    ? list.filter((f) => f.unread > 0 || f.id === state.view.id)
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

  const items = visibleItems();
  const unread = items.filter((i) => !i.read).length;
  // «3 мин назад», но «только что» и «вчера» — уже готовые слова, «назад» к ним не идёт.
  const ago = timeAgo(state.data.lastRefresh);
  const refreshed = state.data.lastRefresh
    ? `обновлено ${/^\d/.test(ago) ? `${ago} назад` : ago}`
    : 'ещё не обновлялось';
  const added = Number.isFinite(state.data.lastRefreshAdded)
    ? `, новых: ${state.data.lastRefreshAdded}${state.data.lastRefreshFeeds ? ` в ${state.data.lastRefreshFeeds} ${plural(state.data.lastRefreshFeeds, 'ленте', 'лентах', 'лентах')}` : ''}`
    : '';
  $('#view-sub').textContent = `${items.length} ${plural(items.length, 'статья', 'статьи', 'статей')}, ${unread} ${plural(unread, 'непрочитанная', 'непрочитанные', 'непрочитанных')} · ${refreshed}${added}`;
  // Режим «Непрочитанные / Все» — только для текущей ленты.
  $('#unread-mode').value = unreadModeFor() ? 'unread' : 'all';
  $('#unread-mode-wrap').hidden = state.view.type === 'starred';
  $('#view-refresh').classList.toggle('spin', Boolean(state.data.refreshing));

  const mode = state.view.type === 'feed' ? feedMode(state.view.id) : (state.settings.defaultView ?? 'compact-thumb');
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

  const fetching = state.data.fetching ?? {};
  $('#store-info').textContent = fetching.pending ? `докачка: ${fetching.pending}` : '';
  // «Только картинки» — настройка отдельной ленты, в общих видах её не показываем.
  const feedNow = state.view.type === 'feed' ? viewFeed() : null;
  $('#images-only-wrap').hidden = !feedNow;
  setSelectValue($('#images-only'), feedNow?.imagesOnly ? 'yes' : 'no');
  renderFilterRow();
  renderNewRow();
}

/** Сколько новых статей пришло в текущий вид после того, как его открыли. */
function pendingNewCount() {
  const snapshot = state.snapshot?.ids;
  if (!snapshot) return 0;
  const onlyUnread = unreadModeFor();
  const q = state.query.trim().toLowerCase();
  return state.data.items.filter((item) => {
    if (snapshot.has(item.id)) return false;
    if (state.view.type === 'feed' && item.feedId !== state.view.id) return false;
    if (state.view.type === 'folder' && feedById(item.feedId)?.folderId !== state.view.id) return false;
    if (state.view.type === 'starred' && !item.starred) return false;
    if (!passesFeedFilters(item)) return false;
    if (q && !searchHaystack(item).includes(q)) return false;
    if (onlyUnread && item.read) return false;
    return true;
  }).length;
}

/** Полоска «пришли новые статьи»: показываем, но в список не добавляем. */
function renderNewRow() {
  const row = $('#new-row');
  if (!row) return;
  const count = pendingNewCount();
  row.hidden = count === 0;
  if (!count) return;
  $('#new-text').textContent = `Новых статей: ${count} — в список не добавляю, пока вы здесь.`;
}

$('#new-show').addEventListener('click', () => {
  resetSnapshot();                 // снимок пересобирается — новые статьи попадут в список
  state.resetScroll = true;
  render();
});

/** Полоска под поиском: превратить запрос в фильтр текущей ленты. */
function renderFilterRow() {
  const row = $('#filter-row');
  if (!row) return;
  const query = state.query.trim();
  const isFeed = state.view.type === 'feed';
  row.hidden = !query;
  if (!query) return;
  $('#filter-term').textContent = query;
  $('#filter-hide').disabled = !isFeed;
  $('#filter-only').disabled = !isFeed;
  $('#filter-hint').textContent = isFeed ? '' : 'фильтр задаётся для отдельной ленты';
  const total = state.data.feeds.reduce((sum, feed) => sum + (feed.filters?.length ?? 0), 0);
  $('#filters-btn').textContent = total ? `Фильтры (${total})` : 'Фильтры';
}

function isExpanded(item) {
  if (state.collapsedItems.has(item.id)) return false;
  if (state.expandedItems.has(item.id)) return true;
  return feedMode(item.feedId) === 'full';
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
  let html = sanitize(body.fullHtml || body.content, item.link);
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
    // Пост с видео: кнопка пробует проиграть его через наш прокси (без кеша).
    const video = item.video
      ? `<div class="a-video"><button class="btn primary" data-video="${esc(item.video)}">▶ Просмотреть видео</button>
          <span class="note">видео проигрывается через прокси и не сохраняется</span></div>`
      : '';
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
  const render = (nodes) => nodes.map((node) => `
    <div class="comment" style="margin-left:${Math.min(node.depth, 6) * 14}px">
      <div class="comment-head">
        <span class="comment-author">${esc(node.author)}</span>
        <span>${esc(timeAgo(node.date))}</span>
        ${node.score ? `<span class="comment-score">+${node.score}</span>` : ''}
      </div>
      <div class="comment-body">${sanitize(node.html, node.link ?? item.link)}</div>
      ${render(node.children ?? [])}
    </div>`).join('');
  const total = Number.isFinite(loaded.total) ? loaded.total : loaded.count;
  return `<div class="a-comments">
    <div class="a-comments-head">
      <button class="btn" data-comments="${esc(item.id)}">Обновить</button>
      <span class="note">комментариев на сайте: ${total}${loaded.count !== total ? `, показано ${loaded.count}` : ''}${loaded.cached ? ' (из кэша)' : ''}</span>
    </div>
    <div class="a-comments-list">${loaded.threads?.length ? render(loaded.threads) : '<div class="note">Комментариев пока нет.</div>'}</div>
  </div>`;
}

/** Загружает комментарии к статье (по кнопке в конце статьи). */
async function loadComments(id, force = false) {
  state.comments.set(id, { loading: true });
  renderList();
  try {
    const payload = await api(`/api/comments?id=${encodeURIComponent(id)}${force ? '&force=1' : ''}`);
    if (!payload.supported) { state.comments.delete(id); renderList(); return; }
    state.comments.set(id, { loading: false, ...payload });
    const item = state.data.items.find((i) => i.id === id);
    if (item && Number.isFinite(payload.total)) item.commentsCount = payload.total;
  } catch (err) {
    state.comments.set(id, { loading: false, ok: false, error: err.message });
  }
  renderList();
}

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
    if (changed) renderList();
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
  manualRead.clear();                   // в другой ленте ручные отметки больше не приоритет
  state.framedIds.clear();              // в новом разделе рамка ещё ни на чём не была
  resetSnapshot();                      // в новой ленте список собирается заново
  openTree(false);                      // на телефоне панель подписок закрываем
  userScrolled = false;                 // без прокрутки мышь ещё не трогали
  userScrollAt = 0;
  ignoreScrollUntil = Date.now() + 900;
  scrollBaseline = 0;
  // Запоминаем, где мы были: после перезагрузки страницы или обновления
  // вернёмся в ту же ленту с тем же фильтром.
  state.prefs.view = { type: view.type, id: view.id ?? null };
  savePrefs();
  render();
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
  const mode = feedMode(item.feedId);
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
  const thumbSource = state.prefs.thumbs && item.image ? String(item.image) : '';
  const thumb = thumbSource
    ? `<img class="a-thumb" src="${esc(imageSrc(item))}" alt="" loading="lazy"
         referrerpolicy="no-referrer"
         onerror="if(!this.dataset.fallback){this.dataset.fallback='1';this.src='${esc(thumbSource)}';}else{this.remove();}">`
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
  return `<article class="article ${item.read ? 'read' : 'unread'} ${mode}${hasTitle ? ' has-title' : ''}${hasThumb ? ' has-thumb' : ''}${expanded ? ' expanded' : ''}${item.id === state.selectedId ? ' selected' : ''}" style="--read-width:${width}%" data-item="${esc(item.id)}">
    <div class="a-rail">
      <div class="a-actions">
        <button data-star="${esc(item.id)}" class="${item.starred ? 'on' : ''}" title="В избранное (s)">${item.starred ? '★' : '☆'}</button>
        <button data-read="${esc(item.id)}" data-value="${item.read ? '0' : '1'}" title="Прочитано/непрочитано (m)">${item.read ? '◌' : '✓'}</button>
        <button data-share="${esc(item.id)}" title="Поделиться ссылкой">⇪</button>
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
          ${item.comments && Number.isFinite(item.commentsCount)
            ? `<button class="flag comment-chip${item.commentsCount ? '' : ' empty'}" data-comments="${esc(item.id)}" data-comments-only="1" title="Показать комментарии, не раскрывая статью">💬 ${item.commentsCount}</button>` : ''}
        </div>
      </div>
      <p class="a-excerpt" style="-webkit-line-clamp:${lines}">${esc(item.excerpt || 'Нажмите, чтобы раскрыть статью')}</p>
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
  if (renderPending) setTimeout(() => { if (renderPending) { renderPending = false; renderList(); } }, 0);
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
function holdImageSpace(root) {
  for (const img of root.querySelectorAll('.a-body img, .comment-body img')) {
    if (img.dataset.hold === '1' || img.complete) continue;
    img.dataset.hold = '1';
    img.classList.add('pending');
    img.addEventListener('load', () => { img.classList.remove('pending'); });
    img.addEventListener('error', () => { img.classList.remove('pending'); });
  }
  for (const row of root.querySelectorAll('.img-row')) {
    const images = [...row.querySelectorAll('img')];
    if (!images.length) continue;
    const done = () => {
      if (images.every((img) => img.complete)) { row.classList.add('ready'); row.classList.remove('waiting'); }
    };
    if (images.every((img) => img.complete)) row.classList.add('ready');
    else {
      row.classList.add('waiting');
      for (const img of images) img.addEventListener('load', done), img.addEventListener('error', done);
    }
  }
}

/** Просит сервер докачать тексты и складывает статьи в кэш service worker. */
async function warmArticles(force = false) {
  if (!navigator.onLine || state.scrolling) return;
  const last = Number(localStorage.getItem(WARM_KEY) ?? 0);
  if (!force && Date.now() - last < WARM_INTERVAL_MS) return;
  localStorage.setItem(WARM_KEY, String(Date.now()));
  try {
    await api('/api/queue', { action: 'start' });     // сервер качает полные тексты
  } catch { /* сервер ответит позже */ }
  const ids = visibleItems().slice(0, 30).map((item) => item.id);
  if (!ids.length) return;
  try {
    const res = await fetch('/api/bodies', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (res.ok) await res.clone().json();
  } catch { /* нет сети — попробуем в следующий раз */ }
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: 'warm', urls: ['/api/data'] });
  } catch { /* service worker ещё не готов */ }
}

function fillViewport() {
  if (state.filling) return;
  const listEl = $('#list');
  if (!listEl) return;
  const total = visibleItems().length;
  if (state.limit >= total) return;
  if (listEl.scrollHeight > listEl.clientHeight + 120) return;
  state.filling = true;
  state.limit = Math.min(total, state.limit + 10);
  renderList();
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

function renderList() {
  if (pointerDown) { renderPending = true; return; }
  if (state.scrolling) { state.deferredRender = true; return; }
  const listEl = $('#list');
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
    const group = dayLabel(item.date);
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
      const again = listEl.querySelector(`.article[data-item="${id}"]`);
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
  warmArticles();          // раз в час прогреваем кэш статей
  holdImageSpace(listEl);  // заглушки на месте ещё не загруженных картинок
  updateActiveArticle();
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
  if (state.prefs.readOnScroll) {
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
  const target2 = list.querySelector(`.article[data-item="${activeId}"]`);
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
    actions.classList.add('floating');      // кнопки становятся полупрозрачными
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
function rememberManualUnread(id) {
  state.manualUnread = { id, moved: 0, lastTop: $('#list')?.scrollTop ?? 0 };
}

/** Эту статью сейчас нельзя отмечать прочитанной автоматически? */
function keepManualUnread(id) {
  const manual = state.manualUnread;
  if (!manual || manual.id !== id) return false;
  // Защита снимается, только когда человек реально пролистал дальше: считаем
  // пройденный путь по событиям прокрутки, а не сравниваем позиции — перерисовка
  // списка тоже меняет scrollTop, и раньше защита отключалась сразу.
  if (manual.moved > 220) { state.manualUnread = null; return false; }
  return true;
}

/**
 * Ручные отметки. Нажатие на кнопку «прочитано/непрочитано» — приоритетнее любых
 * автоматических правил (прокрутка, рамка, раскрытие): такие статьи автоматика не
 * трогает вовсе. Приоритет снимается только при переходе в другую ленту.
 */
const manualRead = new Map();

/** Автоматике можно трогать эту статью? */
function autoReadAllowed(id) {
  return !manualRead.has(id);
}

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

for (const type of ['wheel', 'touchmove']) {
  $('#list').addEventListener(type, () => {
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
  if (Date.now() - userScrollAt > 700) return;
  const list = $('#list');
  if (Math.abs(list.scrollTop - scrollBaseline) < 8) return;
  // Отмечаем только пролистанные статьи: низ статьи должен уйти выше линии
  // чтения. Раньше отмечалась просто активная — и прочитанными становились те,
  // которые ещё читаются.
  const activeId = state.activeId;
  if (!activeId) return;
  const item = state.data.items.find((i) => i.id === activeId);
  if (!item || item.read) return;
  const row = list.querySelector(`.article[data-item="${activeId}"]`);
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

async function ensureBodiesNeeded() {
  if (state.loadingBodies) return;
  if (state.scrolling) { state.deferredBodies = true; return; }
  const items = visibleItems().slice(0, state.limit);
  const need = items.filter((i) => isExpanded(i) && !isBodyLoaded(i.id)).map((i) => i.id);
  if (!need.length) return;
  state.loadingBodies = true;
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
    for (const id of need) if (!state.bodies.has(id)) state.bodies.set(id, { content: '', fullHtml: '', loaded: true });
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
  }
}

// ------------------------------------------------------------------ докачка

/** Догружает полный текст статьи со страницы. */
async function fetchFull(id, silent = false) {
  const item = state.data.items.find((i) => i.id === id);
  if (!item) return;
  const previous = state.bodies.get(id) ?? { content: '', fullHtml: '' };
  state.bodies.set(id, { ...previous, note: 'Докачиваю текст со страницы статьи…' });
  renderList();
  try {
    const res = await api('/api/fetch-full', { id });
    if (res.data) rememberData(res.data);
    const fresh = (state.data.items ?? []).find((i) => i.id === id);
    if (fresh) fresh.hasFull = Boolean(res.item?.fullHtml);
    state.bodies.set(id, { content: res.item?.content ?? '', fullHtml: res.item?.fullHtml ?? '', tried: true, loaded: true });
    renderList();
    if (!silent) toast(res.ok ? 'Полный текст докачан' : `Не получилось: ${res.error ?? 'текст не найден'}`, !res.ok);
  } catch (err) {
    state.bodies.set(id, { ...previous, note: `Не удалось докачать: ${err.message}`, loaded: true });
    renderList();
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

/** Показать только комментарии статьи, не раскрывая её текст. */
async function showCommentsOnly(id) {
  const item = state.data.items.find((i) => i.id === id);
  if (!item) return;
  // Другие статьи не сворачиваем — иначе список прыгает.
  state.selectedId = id;
  state.collapsedItems.delete(id);
  state.commentsOnly.add(id);
  renderList();
  const element = document.querySelector(`.article[data-item="${id}"]`);
  if (element) element.scrollIntoView({ block: 'start', behavior: 'smooth' });
  await loadComments(id, Boolean(state.comments.get(id)?.ok));
  const block = document.querySelector(`.article[data-item="${id}"] .a-comments`);
  if (block) block.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
  scrollArticleToTop(document.querySelector(`.article[data-item="${target.id}"]`));
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
async function flushPendingReads() {
  if (!pendingReads.size || !navigator.onLine) return;
  const byValue = new Map([[true, []], [false, []]]);
  for (const [id, read] of pendingReads) byValue.get(read).push(id);
  for (const [read, ids] of byValue) {
    if (!ids.length) continue;
    try {
      const payload = await api('/api/read', { ids, read });
      if (payload?.ok === false) continue;
      for (const id of ids) pendingReads.delete(id);
      savePendingReads();
      if (payload?.data) rememberData(payload.data);
    } catch { /* нет сети — повторим позже */ }
  }
}

loadPendingReads();
window.addEventListener('online', () => { flushPendingReads(); });

async function markRead(ids, read, { silent = false } = {}) {
  if (!ids.length) return;
  // Сразу отмечаем локально и запоминаем в очереди: при плохой связи это главное —
  // интерфейс не должен ждать сервер и не должен «терять» отметку.
  const items = state.data.items ?? [];
  for (const item of items) if (ids.includes(item.id)) item.read = read;
  for (const id of ids) pendingReads.set(id, read);
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
  const row = document.querySelector(`.article[data-item="${id}"]`);
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
    window.prompt('Ссылка на статью:', url);
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

async function toggleStar(id, event) {
  event?.stopPropagation();
  event?.preventDefault();
  const item = state.data.items.find((i) => i.id === id);
  if (!item) return;
  try {
    const payload = await api('/api/star', { id, starred: !item.starred });
    rememberData(payload.data);
    render();
  } catch (err) { toast(err.message, true); }
}

async function refreshFeeds(feedId) {
  $('#refresh-all').classList.add('spin');
  try {
    const payload = await api('/api/refresh', feedId ? { id: feedId } : {});
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
    try {
      applyPayload(await api('/api/feeds/view', { id: state.view.id, view: mode }));
      toast(`Канал показывает статьи: ${modeLabel(mode)}`);
    } catch (err) { toast(err.message, true); }
  } else {
    state.settings.defaultView = mode;
    await api('/api/settings', { defaultView: mode }).catch(() => {});
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
  render();
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
      if (item) markRead([item.id], !item.read).then(() => toast(item.read ? 'Непрочитано' : 'Прочитано'));
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
  if (readBtn) { event.stopPropagation(); markRead([readBtn.dataset.read], readBtn.dataset.value === '1'); return; }
  const fetchBtn = event.target.closest('[data-fetch]');
  if (fetchBtn) { event.stopPropagation(); fetchFull(fetchBtn.dataset.fetch); return; }
  const commentsBtn = event.target.closest('[data-comments]');
  if (commentsBtn) {
    event.stopPropagation();
    const id = commentsBtn.dataset.comments;
    if (commentsBtn.dataset.commentsOnly === '1') { await showCommentsOnly(id); return; }
    const jump = commentsBtn.dataset.jump === '1';
    await loadComments(id, Boolean(state.comments.get(id)?.ok));   // повторное нажатие — обновить
    if (jump) {
      const block = document.querySelector(`.article[data-item="${id}"] .a-comments`);
      if (block) block.scrollIntoView({ block: 'start', behavior: 'smooth' });
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
    for (const actions of document.querySelectorAll('.a-actions.floating')) actions.classList.add('settled');
  }, 260);
  // Догружаем заранее, за экран до конца: иначе видно конец списка и надпись.
  if (el.scrollTop + el.clientHeight > el.scrollHeight - 1200) {
    const total = visibleItems().length;
    if (state.limit < total) { state.limit += 10; renderList(); }
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
  if (renameFeed) {
    const feed = feedById(renameFeed.dataset.feedRename);
    const name = prompt('Название ленты:', feed?.title ?? '');
    if (name?.trim()) {
      try { applyPayload(await api('/api/feeds/rename', { id: feed.id, title: name.trim() })); } catch (err) { toast(err.message, true); }
    }
    return;
  }
  const delFeed = event.target.closest('[data-feed-del]');
  if (delFeed) {
    const feed = feedById(delFeed.dataset.feedDel);
    if (confirm(`Отписаться от «${feed?.title ?? ''}»?`)) {
      try {
        applyPayload(await api('/api/feeds/remove', { id: feed.id }));
        if (state.view.type === 'feed' && state.view.id === feed.id) state.view = { type: 'unread', id: null };
        state.bodies.clear();
        render();
      } catch (err) { toast(err.message, true); }
    }
    return;
  }
  const renameFolder = event.target.closest('[data-folder-rename]');
  if (renameFolder) {
    const folder = state.data.folders.find((f) => f.id === renameFolder.dataset.folderRename);
    const name = prompt('Название папки:', folder?.name ?? '');
    if (name?.trim()) {
      try { applyPayload(await api('/api/folders/rename', { id: folder.id, name: name.trim() })); } catch (err) { toast(err.message, true); }
    }
    return;
  }
  const delFolder = event.target.closest('[data-folder-del]');
  if (delFolder) {
    const folder = state.data.folders.find((f) => f.id === delFolder.dataset.folderDel);
    const count = state.data.feeds.filter((f) => f.folderId === folder.id).length;
    if (!confirm(`Удалить папку «${folder?.name}»?${count ? `\nЛент внутри: ${count} — они вернутся в корень.` : ''}`)) return;
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
  const name = prompt('Название папки:');
  if (!name?.trim()) return;
  try { applyPayload(await api('/api/folders', { name: name.trim() })); } catch (err) { toast(err.message, true); }
});
$('#refresh-all').addEventListener('click', () => refreshFeeds(null));
$('#view-refresh').addEventListener('click', () => refreshFeeds(state.view.type === 'feed' ? state.view.id : null));
// На телефоне кнопка обновления стоит рядом с переключателем темы.
$('#refresh-top').addEventListener('click', () => refreshFeeds(state.view.type === 'feed' ? state.view.id : null));
$('#mark-all').addEventListener('click', async () => {
  const ids = visibleItems().filter((i) => !i.read).map((i) => i.id);
  if (!ids.length) { toast('Непрочитанных нет'); return; }
  const what = state.view.type === 'feed' ? `в ленте «${viewFeed()?.title ?? ''}»`
    : state.view.type === 'folder' ? `в папке «${viewFolder()?.name ?? ''}»`
      : state.view.type === 'starred' ? 'в избранном' : 'во всех подписках';
  if (!confirm(`Отметить прочитанными ${ids.length} ${plural(ids.length, 'статью', 'статьи', 'статей')} ${what}?`)) return;
  await markRead(ids, true);
  resetSnapshot();          // после массовой отметки список пересобирается
  render();
  toast(`Отмечено: ${ids.length}`);
});
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
  resetSnapshot();
  render();
});
// «Только картинки»: у ленты сохраняется на сервере, как режим показа и число строк.
$('#images-only').addEventListener('change', async (event) => {
  if (state.view.type !== 'feed') return;
  try {
    const onlyImages = event.target.value === 'yes';
    applyPayload(await api('/api/feeds/view', { id: state.view.id, imagesOnly: onlyImages }));
    state.bodies.clear();           // текст перерисуем заново — уже без разметки
    render();
    toast(onlyImages ? 'В этой ленте показываются только картинки' : 'Показываю статьи как обычно');
  } catch (err) { toast(err.message, true); }
});
$('#sort-select').addEventListener('change', async (event) => {
  const sort = event.target.value === 'asc' ? 'asc' : 'desc';
  if (state.view.type === 'feed') {
    try { applyPayload(await api('/api/feeds/view', { id: state.view.id, sort })); } catch (err) { toast(err.message, true); }
  } else {
    state.settings.defaultSort = sort;
    await api('/api/settings', { defaultSort: sort }).catch(() => {});
    render();
    toast(sort === 'asc' ? 'Порядок: старые сверху' : 'Порядок: новые сверху');
  }
  renderList();
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
    const block = document.querySelector(`.article[data-item="${id}"] .a-comments`);
    if (block) block.scrollIntoView({ block: 'start', behavior: 'smooth' });
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
    const entered = window.prompt('Слово или фраза для фильтра:', filter.query);
    if (entered === null) return;
    const query = entered.trim();
    if (!query) { toast('Пустое слово — фильтр не изменён', true); return; }
    const mode = window.confirm('ОК — скрывать такие статьи; Отмена — показывать только такие') ? 'hide' : 'only';
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

async function checkAddress() {
  const url = $('#add-input').value.trim();
  const result = $('#add-result');
  if (!url) { result.textContent = 'Введите адрес сайта, страницы или канала'; return; }
  result.textContent = 'Проверяю адрес…';
  $('#add-candidates').innerHTML = '';
  try {
    const payload = await api('/api/discover', { url });
    addCandidates = payload.candidates ?? [];
    if (!payload.ok || !addCandidates.length) {
      result.textContent = payload.error ?? 'Подписки не найдены';
      return;
    }
    result.textContent = `Найдено ${addCandidates.length} ${plural(addCandidates.length, 'подписка', 'подписки', 'подписок')} — отметьте нужные и нажмите «Подписаться».`;
    $('#add-candidates').innerHTML = addCandidates.map((c, index) => `
      <label class="${c.subscribed ? 'subscribed' : ''}">
        <input type="checkbox" data-cand="${index}" ${index === 0 && !c.subscribed ? 'checked' : ''} ${c.subscribed ? 'disabled' : ''}>
        <span>
          <span class="cand-title">${esc(c.label || c.title)}</span><br>
          <span class="cand-sub">${esc(c.format || '')}${c.items ? ` · статей: ${c.items}` : ''}${c.subscribed ? ' · уже подписаны' : (c.hint ? ` · ${esc(c.hint)}` : '')}</span><br>
          <span class="cand-url">${esc(c.url)}</span>
        </span>
      </label>`).join('');
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

$('#add-check').addEventListener('click', checkAddress);
$('#add-candidates').addEventListener('click', async (event) => {
  const row = event.target.closest('.cand');
  if (!row) return;
  const already = row.classList.contains('active');
  for (const other of document.querySelectorAll('#add-candidates .cand')) other.classList.remove('active');
  row.classList.add('active');
  if (already) await subscribeSelected();     // повторный клик по выбранной — подписаться
});

$('#add-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); checkAddress(); } });

$('#lines-select').addEventListener('change', async (event) => {
  const lines = Number(event.target.value) || 2;
  if (state.view.type === 'feed') {
    try { applyPayload(await api('/api/feeds/view', { id: state.view.id, lines })); } catch (err) { toast(err.message, true); }
  } else {
    state.settings.defaultLines = lines;
    await api('/api/settings', { defaultLines: lines }).catch(() => {});
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
  $('#set-default-view').value = s.defaultView ?? 'compact-thumb';
  $('#set-density').value = state.prefs.density;
  setSelectValue($('#set-thumbs'), state.prefs.thumbs ? 'yes' : 'no');
  setSelectValue($('#set-borders'), state.prefs.borders !== false ? 'yes' : 'no');
  setSelectValue($('#set-fetch-full'), s.fetchFull !== false ? 'yes' : 'no');
  $('#set-pass').value = '';
  $('#set-pass-current').value = '';
  $('#set-tg-token').value = '';
  setSelectValue($('#set-font-family'), fontVariant(state.prefs.fontFamily));
  setSelectValue($('#set-line-height'), state.prefs.lineHeight || 'normal');
  setFontSelect($('#set-font-tree'), state.prefs.fontTree);
  setFontSelect($('#set-font-article'), state.prefs.fontArticle);
  setFontSelect($('#set-font-excerpt'), state.prefs.fontExcerpt);
  setSelectValue($('#set-read-mode'), readMode());
  setSelectValue($('#set-keep-days'), String(state.settings.keepReadDays ?? 14));
  setSelectValue($('#set-unread-default'), unreadDefault() ? 'unread' : 'all');
  renderTreeFilter();
  setRefreshSelect(s.refreshMinutes ?? 5);
  $('#refresh-info').textContent = `Сейчас ленты обновляются каждые ${s.refreshMinutes ?? 10} мин.`;
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
  if (account) {
    account.innerHTML = `Вы вошли как <b>${esc(session.login ?? session.user ?? '—')}</b>` +
      (session.role === 'admin' ? ' <span class="flag">администратор</span>' : '') +
      '<br>Пользователей, их пароли и ключи Fever заводит администратор в админке.';
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
      $('#refresh-info').textContent = `Сейчас ленты обновляются каждые ${state.settings.refreshMinutes ?? 10} мин.`;
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
  await api('/api/settings', { defaultView: e.target.value }).catch((err) => toast(err.message, true));
  render();
});
$('#set-density').addEventListener('change', (e) => {
  state.prefs.density = e.target.value;
  $('#list').classList.toggle('comfortable', e.target.value === 'comfortable');
  savePrefs();
});
$('#set-thumbs').addEventListener('change', (e) => { state.prefs.thumbs = e.target.value !== 'no'; savePrefs(); renderList(); });
$('#set-borders').addEventListener('change', (e) => {
  state.prefs.borders = e.target.value !== 'no';
  savePrefs();
  applyVisualPrefs();
  toast(state.prefs.borders ? 'Рамки видимые' : 'Рамки невидимые');
});
$('#set-font-family').addEventListener('change', (e) => { state.prefs.fontFamily = e.target.value; savePrefs(); applyVisualPrefs(); });
$('#set-line-height').addEventListener('change', (e) => { state.prefs.lineHeight = e.target.value; savePrefs(); applyVisualPrefs(); });
$('#set-font-tree').addEventListener('change', (e) => { state.prefs.fontTree = e.target.value; savePrefs(); applyVisualPrefs(); });
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
    $('#refresh-info').textContent = `Сейчас ленты обновляются каждые ${minutes} мин.`;
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
  if (!confirm('Выйти из аккаунта?')) return;
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

function showLogin() {
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
    await loadSettings();
    await loadData();
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

async function loadData({ poll = false } = {}) {
  try {
    const query = poll && state.revision ? `?rev=${state.revision}` : '';
    const payload = await api(`/api/data${query}`);
    if (payload.unchanged) {
      // Ничего не изменилось: обновляем только счётчики и статус докачки.
      if (!Array.isArray(state.data.items)) return;     // состояние ещё не загружено
      if (Array.isArray(payload.feeds)) state.data.feeds = payload.feeds;
      state.data.counts = payload.counts;
      state.data.fetching = payload.fetching;
      state.data.refreshing = payload.refreshing;
      renderSidebar();
      renderToolbar();
      return;
    }
    if (!rememberData(payload)) return;         // ответ без данных не применяем
    render();
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
function startEvents() {
  if (!('EventSource' in window) || events) return;
  try {
    events = new EventSource('/api/events');
  } catch { return; }
  events.onmessage = async (event) => {
    let payload = null;
    try { payload = JSON.parse(event.data); } catch { return; }
    const revision = Number(payload?.revision);
    if (!Number.isFinite(revision) || revision === Number(state.revision)) return;
    await loadData({ poll: true });
  };
  events.onerror = () => {
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
    const mode = state.view.type === 'feed' ? feedMode(state.view.id) : (state.settings.defaultView ?? 'compact-thumb');
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
    if (event.target.closest('#menu-refresh')) { closeHeadMenu(); refreshFeeds(state.view.type === 'feed' ? state.view.id : null); return; }
    if (event.target.closest('#menu-settings')) { closeHeadMenu(); openSettings(); }
  });
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
      try { applyPayload(await api('/api/feeds/view', { id: state.view.id, lines })); } catch (err) { toast(err.message, true); }
    } else {
      state.settings.defaultLines = lines;
      try { await api('/api/settings', { defaultLines: lines }); } catch { /* не критично */ }
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
      // Свайп вправо с левой половины экрана или из уже открытой панели.
      if (open || startX <= window.innerWidth / 2) openTree(true);
      return;
    }
    if (open) { openTree(false); return; }                           // влево: закрыть подписки
    // Свайп влево по правой половине экрана (панель закрыта) — следующая статья.
    if (startX >= window.innerWidth / 2) {
      const id = state.selectedId ?? state.activeId;
      if (id) goRelative(id, 1);
    }
  }, { passive: true });
}

// -------------------------------------------------------- приложение на телефон

/**
 * PWA: сервис-воркер (чтобы приложение открывалось с домашнего экрана и без сети)
 * и кнопка установки. Браузеры Android предлагают установку сами, iOS — только
 * вручную через «Поделиться» → «На экран „Домой“», поэтому там показываем подсказку.
 */
function setupPwa() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname))) {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* без воркера всё работает как раньше */ });
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
  restoreView();          // возвращаемся в ту ленту и с тем фильтром, что были
  startEvents();
}

start();
// Опрашиваем всегда: иначе при раскрытой статье список и время «замирают».
  // Опрос сервера, счётчики и время не мешают прокрутке: пока она идёт,
  // задачи откладываются и выполняются, когда список остановился.
  setInterval(() => {
    if (state.scrolling) { state.deferredPoll = true; return; }
    if (document.hidden) return;
    loadData({ poll: true });
  }, 120_000);
  setInterval(() => {
    if (state.scrolling || document.hidden) return;
    if (state.data.fetching?.pending) { loadData({ poll: true }); renderQueueInfo(); }
  }, 30_000);
  setInterval(() => { if (state.scrolling || document.hidden) return; refreshTimes(); renderToolbar(); }, 60_000);

/** Обратный отсчёт до следующего автообновления лент. */
function updateCountdown() {
  const el = $('#refresh-countdown');
  if (!el) return;
  const at = Number(state.data.nextRefreshAt);
  if (!Number.isFinite(at) || at <= 0) { el.textContent = '—'; return; }
  const left = Math.max(0, at - Date.now());
  const minutes = Math.floor(left / 60000);
  const seconds = Math.floor((left % 60000) / 1000);
  el.textContent = `⏱ ${minutes}:${String(seconds).padStart(2, '0')}`;
}
setInterval(updateCountdown, 1000);
updateCountdown();

// ------------------------------------------------------------- санитайзер

/** Убирает из HTML статьи всё опасное и починяет относительные ссылки. */
function sanitize(html, baseUrl) {
  if (!html) return '';
  const allowed = new Set(['A', 'P', 'BR', 'HR', 'DIV', 'SPAN', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'DEL', 'INS', 'CODE', 'PRE',
    'BLOCKQUOTE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'IMG', 'FIGURE', 'FIGCAPTION', 'PICTURE', 'SOURCE',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION', 'VIDEO', 'AUDIO', 'SUB', 'SUP', 'SMALL', 'MARK',
    'DL', 'DT', 'DD', 'ABBR', 'TIME', 'CITE', 'Q', 'KBD', 'SAMP', 'VAR', 'SECTION', 'ARTICLE', 'ASIDE', 'MAIN']);
  const doc = new DOMParser().parseFromString(`<div id="__root">${html}</div>`, 'text/html');
  const root = doc.getElementById('__root');
  if (!root) return '';
  const resolve = (value) => {
    try { return new URL(value, baseUrl || location.href).href; } catch { return ''; }
  };
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const doomed = [];
  while (walker.nextNode()) {
    const el = walker.currentNode;
    if (!allowed.has(el.tagName) || el.id === '__root') { doomed.push(el); continue; }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name.startsWith('on') || name === 'style' || name === 'srcdoc' || name === 'formaction') {
        el.removeAttribute(attr.name);
      } else if (['href', 'src', 'poster'].includes(name)) {
        const abs = resolve(value);
        if (/^(https?:|mailto:|data:image\/)/i.test(abs) || abs.startsWith(`${location.origin}/api/media`)) {
          // Картинки по http:// на странице https браузер блокирует («смешанное
          // содержимое») — отдаём их через свой прокси. Ссылки не трогаем.
          // Картинки и видео всегда отдаём через свой прокси: он снимает проблему
          // «смешанного содержимого», запрета хотлинков и чужого референта.
          const isMedia = name !== 'href' && /^https?:\/\//i.test(abs);
          const isVideo = el.tagName === 'VIDEO' || el.tagName === 'AUDIO' || el.tagName === 'SOURCE';
          const proxied = isMedia
            ? (isVideo ? `/api/video?u=${encodeURIComponent(abs)}` : `/api/img?u=${encodeURIComponent(abs)}`)
            : abs;
          el.setAttribute(attr.name, proxied);
        } else el.removeAttribute(attr.name);
      } else if (name === 'srcset') {
        const fixed = value.split(',').map((part) => {
          const [url, ...rest] = part.trim().split(/\s+/);
          const abs = resolve(url);
          if (!/^https?:/i.test(abs)) return '';
          const src = /^https?:/i.test(abs) ? `/api/img?u=${encodeURIComponent(abs)}` : abs;
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
  const ownsMedia = (node) => node.nodeType === 1 && node.classList?.contains('img-alone') && !node.classList.contains('img-row');
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

  return root.innerHTML;
}
