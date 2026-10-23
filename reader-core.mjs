#!/usr/bin/env node
// RSS/Atom-читалка: один процесс Node.js, без внешних зависимостей.
//   node server.mjs [--port 8787] [--host 127.0.0.1] [--refresh 15] [--data ./data]
//
// Вход, пароли и ключи Fever ведёт контроллер (server.mjs, lib/users.mjs):
// здесь остаётся только проверка сессии и ключа текущего пользователя.
//   FETCH_FULL=0 (выключить докачку полного текста), KEEP_READ_DAYS, MAX_UNREAD_PER_FEED.
//
// API:
//   GET  /api/session                   нужна ли авторизация и введена ли она
//   POST /api/login | /api/logout       вход в веб-клиент (cookie, «запомнить меня»)
//   GET  /api/settings                  настройки (без секретов)
//   POST /api/settings                  {fetchFull?, defaultView?, telegramToken?}
//   POST /api/settings/credentials      {user,password} — логин/пароль для веба и Fever
//   GET  /api/data                      состояние: папки, ленты, метаданные статей (без тел)
//   GET  /api/item?id=<id>              полная статья (тело ленты + докачанный текст)
//   POST /api/bodies      {ids:[...]}   тела сразу для нескольких статей (список целиком)
//   POST /api/feeds       {url,folderId?}      подписаться (с автоопределением фида)
//   POST /api/feeds/remove{id} / rename{id,title} / view{id,view}
//   POST /api/folders     {name} / folders/rename{id,name} / folders/remove{id,deleteFeeds}
//   POST /api/tree        {folders:[...],feeds:[...]}   сохранить структуру после drag&drop
//   POST /api/refresh     {id?,force?}
//   POST /api/read        {ids?|feedId?|folderId?|all?|before?, read}
//   POST /api/star        {id,starred}
//   POST /api/fetch-full  {id}          докачать полный текст статьи
//   POST /api/queue       {action}      «старт»/«стоп»/«очистить» очередь докачки
//   GET  /api/media       ?id=&msg=     картинка поста Telegram (через бота)
//   GET  /api/opml  /  POST /api/opml   выгрузка и импорт подписок
//   ANY  /fever/                        протокол Fever API для внешних клиентов

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, unlink, stat, readdir } from 'node:fs/promises';
import { gzip, brotliCompress, constants as zlibConstants } from 'node:zlib';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseFeed, looksLikeFeed, discoverFeedLinks, htmlToText, itemId, stripFeedNoise } from './lib/feed.mjs';
import { parseXml, localName, elementChildren } from './lib/xml.mjs';
import { extractArticle, looksLikePageChrome } from './lib/readability.mjs';
import {
  telegramChannelFromUrl, telegramPreviewUrl, parseTelegramChannel,
  telegramBotMe, telegramGetUpdates, parseBotUpdate, telegramFileUrl,
} from './lib/telegram.mjs';
import { Store } from './lib/store.mjs';
import { handleFever } from './lib/fever.mjs';
import { commentsProviderFor } from './lib/comments.mjs';
import {
  hashPassword, verifyPassword, feverApiKey, newSecret, safeEqual,
  issueSession, readSession, parseCookies, cookieHeader,
} from './lib/auth.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function argValue(name, fallback) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  if (hit.includes('=')) return hit.split('=').slice(1).join('=');
  return process.argv[process.argv.indexOf(hit) + 1] ?? fallback;
}

const PORT = Number(process.env.PORT || argValue('port', 8787));
const HOST = process.env.HOST || argValue('host', '127.0.0.1');
const REFRESH_MINUTES = Number(process.env.REFRESH_MINUTES || argValue('refresh', 5));
const MIN_REFRESH_MINUTES = 5;                 // чаще пяти минут ленты не обновляем
// Ширина текста статьи в процентах от ширины окна (шаг — 10%).
const MIN_TEXT_WIDTH = 50;
const MAX_TEXT_WIDTH = 100;
const TEXT_WIDTH_STEP = 5;                        // ширина текста меняется шагом 5 %

/** Приводит ширину текста к допустимым значениям: 50…100 с шагом 10. */
function clampTextWidth(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return MAX_TEXT_WIDTH;
  const stepped = Math.round(number / TEXT_WIDTH_STEP) * TEXT_WIDTH_STEP;
  return Math.min(MAX_TEXT_WIDTH, Math.max(MIN_TEXT_WIDTH, stepped));
}
const COMMENTS_TTL_MS = Number(process.env.COMMENTS_TTL_MINUTES || 30) * 60_000;
const COMMENTS_COUNT_TTL_MS = 6 * 3600_000;      // счётчик комментариев обновляем раз в 6 часов
const COMMENT_COUNT_SYNC_MS = 5 * 60_000;          // при синхронизации — не чаще раза в 5 минут
const COMMENT_COUNT_SYNC_LIMIT = 120;              // и не больше 120 статей за прогон
const DATA_DIR_DEFAULT = path.resolve(process.env.DATA_DIR || argValue('data', path.join(ROOT, 'data')));
let DATA_DIR = DATA_DIR_DEFAULT;
const PUBLIC_DIR = path.join(ROOT, 'public');
// Старый вход через переменные окружения больше не используется: пользователей
// и пароли ведёт контроллер, а сюда они приходят через init({ login, apiKey, secret }).
const AUTH_USER = '';
const AUTH_PASS = '';

// Политика хранения: непрочитанное не удаляется никогда (до жёсткого предела),
// прочитанное живёт KEEP_READ_DAYS дней, избранное — всегда.
const MAX_UNREAD_PER_FEED = Number(process.env.MAX_UNREAD_PER_FEED || argValue('max-unread', 1500));
const MAX_READ_PER_FEED = Number(process.env.MAX_READ_PER_FEED || argValue('max-read', 1000));
// Версия разборщика: когда он меняется, ленты перечитываются заново, даже если
// сайт отвечает «не изменилось» — иначе старые записи остаются без новых полей.
// Версия сборки: её сравнивает клиент, чтобы показать кнопку «Обновить приложение».
// Версия берётся из номера сборки в public/index.html (app.js?v=NNN), поэтому
// сервер и клиент всегда сообщают одинаковую версию.
let APP_VERSION = '1.0.0';
async function loadVersion() {
  try {
    const html = await readFile(path.join(__dirname, 'public', 'index.html'), 'utf8');
    const build = Number.parseInt(/app\.js\?v=(\d+)/.exec(html)?.[1] ?? '0', 10) || 0;
    if (build) APP_VERSION = `1.0.${build}`;
  } catch { /* останется версия по умолчанию */ }
}

// Версию читаем заново на каждый запрос: после обновления файлов (без
// перезапуска службы) сервер не должен сообщать устаревшую версию.
async function refreshVersion() {
  await loadVersion();
  return APP_VERSION;
}

const PARSER_VERSION = 18;
// Версия сохранённых полных текстов. Когда меняется разбор страницы (картинки,
// видео), старые тексты надо перекачать — иначе они остаются в прежнем виде.
const BODY_VERSION = 13;

const KEEP_READ_DAYS = Number(process.env.KEEP_READ_DAYS || argValue('keep-read-days', 30));   // потолок, если в настройках ничего нет
const KEEP_READ_DAYS_DEFAULT = 14;                       // по умолчанию держим прочитанное 2 недели
const KEEP_READ_DAYS_CHOICES = [7, 14, 21, 28];          // 1–4 недели

/** Сколько дней хранить прочитанное у этого пользователя. */
function keepReadDays() {
  const chosen = Number(settings()?.keepReadDays);
  if (KEEP_READ_DAYS_CHOICES.includes(chosen)) return chosen;
  return Math.min(KEEP_READ_DAYS_DEFAULT, KEEP_READ_DAYS);
}

// Докачка полного текста статьи со страницы (для лент с обрезком вместо текста).
const FETCH_FULL = process.env.FETCH_FULL !== '0' && argValue('fetch-full', '1') !== '0';
const FULLTEXT_MIN_FEED_CHARS = Number(process.env.FULLTEXT_MIN_FEED_CHARS || 900);
const FULLTEXT_MIN_ARTICLE_CHARS = Number(process.env.FULLTEXT_MIN_ARTICLE_CHARS || 400);
const FULLTEXT_DELAY_MS = Number(process.env.FULLTEXT_DELAY_MS || 1500);
const FULLTEXT_MAX_PER_CYCLE = Number(process.env.FULLTEXT_MAX_PER_CYCLE || 40);
const FULLTEXT_RETRY_DAYS = Number(process.env.FULLTEXT_RETRY_DAYS || 7);

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 RSS-Reader/2.0';
let logTag = '';
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), logTag, ...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const byDateDesc = (a, b) => String(b.date ?? '').localeCompare(String(a.date ?? ''));

// Данные создаются в init(): контроллер поднимает по экземпляру модуля на
// пользователя, поэтому у каждого свои ленты, статьи, медиа и таймеры.
let store = null;
let db = null;
let refreshing = false;
let lastRefreshAdded = null;   // сколько новых статей принесло последнее обновление
let lastRefreshFeeds = 0;      // в скольких лентах были новинки
let lastAddedByFeed = {};      // сколько новых статей принесло последнее обновление по каждой ленте

let MEDIA_DIR = path.join(DATA_DIR, 'media');
const SESSION_COOKIE = 'rss_session';
const SESSION_TTL = 30 * 86400_000;          // «запомнить меня» — 30 дней
const SHORT_SESSION_TTL = 12 * 3600_000;     // без галочки — до конца дня

// ------------------------------------------------------- идентификаторы для Fever

/** Числовой номер объекта (нужен протоколу Fever); назначается лениво. */
function numOf(obj) {
  if (!Number.isFinite(obj?.n)) {
    db.numeric = (Number(db.numeric) || 0) + 1;
    obj.n = db.numeric;
    store.saveStateSoon();
  }
  return obj.n;
}
const feedNum = (feed) => numOf(feed);
const folderNum = (folder) => numOf(folder);

// --------------------------------------------------------------- настройки

const settings = () => {
  if (!db.settings || typeof db.settings !== 'object') db.settings = {};
  const s = db.settings;
  if (!('auth' in s)) s.auth = null;
  if (!s.telegram || typeof s.telegram !== 'object') s.telegram = { token: '', botUsername: '', lastUpdateId: 0 };
  if (!s.defaultView) s.defaultView = 'compact-thumb';      // кратко, с картинкой
  if (!Number.isFinite(Number(s.defaultLines)) || Number(s.defaultLines) < 1) s.defaultLines = 4;
  // Ширина текста статьи: 100% — во всю ширину (как было), минимум 50% от окна.
  s.defaultWidth = clampTextWidth(s.defaultWidth ?? MAX_TEXT_WIDTH);
  if (s.defaultSort !== 'asc' && s.defaultSort !== 'desc') s.defaultSort = 'desc';
  // Интервал обновления: не чаще пяти минут (значения из старых версий подтягиваем).
  const storedMinutes = Number(s.refreshMinutes);
  s.refreshMinutes = Number.isFinite(storedMinutes) && storedMinutes > 0
    ? Math.max(MIN_REFRESH_MINUTES, Math.round(storedMinutes))
    : REFRESH_MINUTES;
  if (typeof s.fetchFull !== 'boolean') s.fetchFull = FETCH_FULL;
  return s;
};

const fetchFullEnabled = () => settings().fetchFull !== false;
const telegramToken = () => String(settings().telegram?.token ?? '').trim();

// ------------------------------------------------------------ авторизация

const envAuth = () => Boolean(AUTH_USER);
const authEnabled = () => envAuth() || Boolean(settings().auth?.user);

function sessionSecret() {
  if (envAuth()) return createHash('sha256').update(`env:${AUTH_USER}:${AUTH_PASS}:rss-reader`).digest('hex');
  const auth = settings().auth;
  if (!auth.secret) { auth.secret = newSecret(); store.saveStateSoon(); }
  return auth.secret;
}

function checkPassword(user, password) {
  if (envAuth()) return user === AUTH_USER && password === AUTH_PASS;
  const auth = settings().auth;
  return Boolean(auth) && user === auth.user && verifyPassword(password, auth.passHash);
}

/** Ключ Fever: md5(логин:пароль), посчитанный при смене пароля. */
function checkApiKey(key) {
  if (!key) return false;
  if (envAuth()) return safeEqual(key, feverApiKey(AUTH_USER, AUTH_PASS));
  return safeEqual(key, settings().auth?.apiKey ?? '');
}

function sessionUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  const session = readSession(sessionSecret(), cookies[SESSION_COOKIE]);
  if (!session) return null;
  const current = envAuth() ? AUTH_USER : settings().auth?.user;
  return session.user === current ? session.user : null;
}

function isAuthenticated(req, url) {
  if (!authEnabled()) return true;
  if (sessionUser(req)) return true;
  const header = req.headers.authorization ?? '';
  if (header.startsWith('Basic ')) {
    const [user, password] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
    if (checkPassword(user, password)) return true;
  }
  if (checkApiKey(url?.searchParams?.get('api_key'))) return true;
  return false;
}

const isLocalRequest = (req) => {
  const address = req.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
};

// --------------------------------------------------------------- загрузка

function charsetFromBody(bytes) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
  return /encoding\s*=\s*["']([\w.-]+)["']/i.exec(head)?.[1]
    || /charset\s*=\s*["']?([\w.-]+)/i.exec(head)?.[1]
    || '';
}

function decodeBody(buffer, contentType) {
  let bytes = new Uint8Array(buffer);
  let charset = /charset\s*=\s*["']?([\w.-]+)/i.exec(contentType || '')?.[1] ?? '';
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bytes = bytes.subarray(3);
    charset = charset || 'utf-8';
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    bytes = bytes.subarray(2);
    charset = charset || 'utf-16le';
  }
  charset = charset || charsetFromBody(bytes) || 'utf-8';
  try {
    return new TextDecoder(charset.trim().toLowerCase()).decode(bytes);
  } catch {
    try { return new TextDecoder('utf-8').decode(bytes); } catch { return ''; }
  }
}

const hostHits = new Map();   // хост -> время последнего запроса (вежливость при докачке)

async function politeWait(url) {
  const host = (() => { try { return new URL(url).host; } catch { return ''; } })();
  if (!host) return;
  const last = hostHits.get(host) ?? 0;
  const wait = FULLTEXT_DELAY_MS - (Date.now() - last);
  if (wait > 0) await sleep(wait);
  hostHits.set(host, Date.now());
}

async function httpGetOnce(url, { etag, lastModified, timeout = 20000, accept } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const headers = {
    'user-agent': UA,
    accept: accept || 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
    'accept-language': 'ru,en;q=0.8',
  };
  if (etag) headers['if-none-match'] = etag;
  if (lastModified) headers['if-modified-since'] = lastModified;
  try {
    const res = await fetch(url, { redirect: 'follow', signal: controller.signal, headers });
    const buffer = res.status === 304 ? new ArrayBuffer(0) : await res.arrayBuffer();
    return {
      status: res.status,
      ok: res.ok,
      finalUrl: res.url || url,
      etag: res.headers.get('etag') || '',
      lastModified: res.headers.get('last-modified') || '',
      contentType: res.headers.get('content-type') || '',
      text: res.status === 304 ? '' : decodeBody(buffer, res.headers.get('content-type')),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Обёртка с запасным вариантом по https: часть сайтов (например, LiveJournal)
 * отвечает на http редиректом 307 на https, который не всегда проходит через
 * локальные прокси и DPI — тогда тот же адрес по https открывается нормально.
 */
async function httpGet(url, opts = {}) {
  try {
    return await httpGetOnce(url, opts);
  } catch (err) {
    if (!/^http:\/\//i.test(url)) throw err;
    const secure = url.replace(/^http:\/\//i, 'https://');
    try {
      const res = await httpGetOnce(secure, opts);
      log(`адрес ${url} не читается напрямую (${err.cause?.message ?? err.message}), используется https`);
      return { ...res, finalUrl: res.finalUrl || secure };
    } catch (err2) {
      throw new Error(err2.cause?.message ?? err2.message ?? err.message);
    }
  }
}

// ------------------------------------------------------------- структура

// Анонс в списке: карточке хватает 4–10 строк. Раньше сюда уходило до 1500
// символов на статью, и /api/data весил мегабайты при каждом опросе.
// Анонс должен покрывать все строки из настройки (до 12): при коротком анонсе
// карточка показывала 1–2 строки, сколько ни выбирай.
const EXCERPT_LIMIT = Number(process.env.EXCERPT_LIMIT || 900);

const shortExcerpt = (text) => {
  const value = String(text ?? '');
  return value.length > EXCERPT_LIMIT ? `${value.slice(0, EXCERPT_LIMIT).trimEnd()}…` : value;
};

const toMeta = (item) => ({
  id: item.id,
  title: item.title,
  link: item.link,
  date: item.date,
  author: item.author,
  // У части лент (lenta.ru и подобные) описания в ленте нет вовсе: тогда короткий
  // текст берём из содержимого статьи, иначе карточка показывала только
  // «Нажмите, чтобы раскрыть статью».
  excerpt: shortExcerpt(item.excerpt || htmlToText(item.content ?? '')),
  image: item.image,
  categories: item.categories ?? [],
  hasFull: Boolean(item.hasFull),
  fullTriedAt: item.fullTriedAt ?? null,
  // Число комментариев: из ленты (если сообщает) или из ответа сайта.
  commentsCount: Number.isFinite(item.commentsCount) ? item.commentsCount : null,
  video: item.video ?? '',
  // Длина текста, который дала сама лента: по ней решаем, нужна ли докачка.
  contentLength: typeof item.contentLength === 'number'
    ? item.contentLength
    : htmlToText(item.content ?? '').length,
});

const feedById = (id) => db.feeds.find((f) => f.id === id) ?? null;

function findItem(id) {
  for (const feed of db.feeds) {
    const item = (db.items[feed.id] ?? []).find((i) => i.id === id);
    if (item) return { feed, item };
  }
  return null;
}

const nextFeedOrder = () => db.feeds.reduce((max, f) => Math.max(max, Number(f.order) || 0), 0) + 1;
const nextFolderOrder = () => db.folders.reduce((max, f) => Math.max(max, Number(f.order) || 0), 0) + 1;

/**
 * Ключ ленты для поиска дубликатов: без схемы, без www и без хвостового слэша.
 * Иначе одна и та же лента, добавленная как http и переехавшая на https,
 * считается новой и появляется в списке второй раз.
 */
function feedKey(url) {
  try {
    const parsed = new URL(String(url));
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${host}${pathname}${parsed.search}`;
  } catch {
    return String(url ?? '').trim().toLowerCase();
  }
}

const findFeedByUrl = (url) => {
  const key = feedKey(url);
  return db.feeds.find((f) => (f.key ?? feedKey(f.url)) === key) ?? null;
};

/** Схлопывает уже налипшие дубликаты: остаётся самая старая запись, остальные удаляются. */
async function dedupeFeeds() {
  const groups = new Map();
  for (const feed of db.feeds) {
    const key = feed.key ?? feedKey(feed.url);
    feed.key = key;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(feed);
  }
  const doomed = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => String(a.addedAt ?? '').localeCompare(String(b.addedAt ?? '')));
    doomed.push(...list.slice(1));
  }
  if (!doomed.length) return;
  const ids = new Set(doomed.map((f) => f.id));
  for (const feed of doomed) {
    for (const item of db.items[feed.id] ?? []) { delete db.read[item.id]; delete db.starred[item.id]; }
    delete db.items[feed.id];
    await store.removeFeed(feed.id);
    log(`удалён дубликат ленты «${feed.title}» (${feed.url})`);
  }
  db.feeds = db.feeds.filter((f) => !ids.has(f.id));
  store.saveStateSoon();
}

// --------------------------------------------------------------- хранение

/** Свежие статьи сверху, следом — то, что уже было (лента могла «сдвинуть окно»). */
async function mergeItems(feedId, fresh) {
  const feed = feedById(feedId);
  // Лента «только картинки»: на сервере оставляем из текста лишь изображения,
  // иначе в списке и в статье всё равно шёл обычный текст.
  if (feed?.imagesOnly) {
    fresh = fresh.map((item) => {
      const html = String(item.content ?? '');
      const pictures = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
      return {
        ...item,
        excerpt: '',
        content: pictures.join(''),
        contentLength: 0,
      };
    });
  }
  // Отфильтрованное не скачиваем вовсе: и в базе, и в Fever его быть не должно.
  const skipped = feed ? fresh.filter((item) => !passesFilters(feed, toMeta(item))) : [];
  if (skipped.length) {
    fresh = fresh.filter((item) => passesFilters(feed, toMeta(item)));
    log(`лента ${feedId}: отфильтровано статей ${skipped.length}`);
  }
  const old = db.items[feedId] ?? [];
  const oldIds = new Set(old.map((i) => i.id));
  const oldById = new Map(old.map((i) => [i.id, i]));
  const freshIds = new Set(fresh.map((i) => i.id));
  const added = fresh.reduce((n, i) => n + (oldIds.has(i.id) ? 0 : 1), 0);
  // Свежие метаданные ленты, но служебные признаки берём из прежней записи:
  // иначе каждый опрос «забывал бы», что текст уже скачан или что попытка была.
  const merged = [
    ...fresh.map((item) => {
      const meta = toMeta(item);
      const prev = oldById.get(meta.id);
      if (prev) {
        if (prev.hasFull) meta.hasFull = true;
        if (prev.fullTriedAt) meta.fullTriedAt = prev.fullTriedAt;
        if (Number.isFinite(prev.n)) meta.n = prev.n;
        // Счётчик, полученный от сайта, важнее отсутствующего в ленте.
        if (!Number.isFinite(meta.commentsCount) && Number.isFinite(prev.commentsCount)) meta.commentsCount = prev.commentsCount;
      }
      return meta;
    }),
    ...old.filter((i) => !freshIds.has(i.id)),
  ];
  merged.sort(byDateDesc);
  db.items[feedId] = merged;

  // Тела статей — в отдельные файлы.
  for (const item of fresh) {
    if (!item.content) continue;
    const existing = await store.body(feedId, item.id);
    if (!existing || existing.content !== item.content) {
      await store.setBody(feedId, item.id, { content: item.content, contentFetchedAt: new Date().toISOString() });
    }
  }
  await pruneFeed(feedId);
  return added;
}

/**
 * Политика хранения: избранное — всегда; непрочитанное — до жёсткого предела;
 * прочитанное — не старше KEEP_READ_DAYS и не больше MAX_READ_PER_FEED.
 */
/**
 * После синхронизации освежаем число комментариев у свежих статей: в шапке карточки
 * сразу видно, где идёт обсуждение. Качаем только число, сами комментарии — по кнопке.
 * Ходим лишь туда, где провайдер умеет отдать одно число, и не больше 40 статей за раз.
 */
async function refreshCommentCounts(limit = COMMENT_COUNT_SYNC_LIMIT) {
  const candidates = [];
  for (const feed of db.feeds) {
    for (const item of db.items[feed.id] ?? []) {
      // Считаем только там, где это интересно: непрочитанное и избранное.
      if (db.read[item.id] && !db.starred[item.id]) continue;
      const provider = commentsProviderFor(feed, item);
      if (!provider?.count) continue;
      const checkedAt = item.commentsCountAt ? Date.parse(item.commentsCountAt) : 0;
      if (Number.isFinite(item.commentsCount) && Date.now() - checkedAt < COMMENT_COUNT_SYNC_MS) continue;
      candidates.push({ item, provider, checkedAt });
    }
  }
  if (!candidates.length) return 0;
  // Сначала самые свежие: у них обсуждение ещё идёт.
  candidates.sort((a, b) => String(b.item.date ?? '').localeCompare(String(a.item.date ?? '')) || a.checkedAt - b.checkedAt);
  const queue = candidates.slice(0, limit);
  let updated = 0;
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const job = queue.shift();
      try {
        const count = await job.provider.count(httpGet);
        if (Number.isFinite(count)) { job.item.commentsCount = count; updated += 1; }
      } catch { /* сайт не ответил — попробуем в следующий прогон */ }
      job.item.commentsCountAt = new Date().toISOString();
    }
  });
  await Promise.all(workers);
  if (updated) store.saveStateSoon();
  return updated;
}

async function pruneFeed(feedId) {
  const items = db.items[feedId] ?? [];
  const cutoff = Date.now() - keepReadDays() * 86400000;
  const keep = [];
  const keepIds = new Set();
  let keptUnread = 0;
  let keptRead = 0;
  let droppedUnread = 0;

  for (const item of items) {           // items уже отсортированы: свежие сверху
    if (db.starred[item.id]) { keep.push(item); keepIds.add(item.id); continue; }
    if (!db.read[item.id]) {
      if (keptUnread < MAX_UNREAD_PER_FEED) { keep.push(item); keepIds.add(item.id); keptUnread += 1; }
      else droppedUnread += 1;
      continue;
    }
    // Срок хранения считается от момента прочтения, а не от даты публикации:
    // иначе старая статья исчезала бы сразу после того, как её прочитали.
    const readAt = Number(db.read[item.id]) || 0;
    if (readAt >= cutoff && keptRead < MAX_READ_PER_FEED) {
      keep.push(item); keepIds.add(item.id); keptRead += 1;
    }
  }

  if (droppedUnread) log(`лента ${feedId}: достигнут предел ${MAX_UNREAD_PER_FEED} непрочитанных, удалено ${droppedUnread} самых старых`);
  const removed = items.length - keep.length;
  if (removed > 0) {
    for (const item of items) {
      if (keepIds.has(item.id)) continue;
      delete db.read[item.id];
      delete db.starred[item.id];
      // Освобождаем диск: картинка поста Telegram и кэш миниатюры этой статьи.
      if (item.imageFileId) {
        const hash = createHash('sha1').update(String(item.imageFileId)).digest('hex').slice(0, 24);
        await unlink(path.join(MEDIA_DIR, hash)).catch(() => {});
      }
      if (item.image && /^https?:\/\//i.test(item.image)) await unlink(thumbFileFor(item.image)).catch(() => {});
    }
    keep.sort(byDateDesc);
    db.items[feedId] = keep;
    await store.pruneContent(feedId, keepIds);
    log(`лента ${feedId}: удалено ${removed} старых прочитанных статей (непрочитанных ${keptUnread} сохранено)`);
  }
}

function pruneState() {
  const limit = 20000;
  for (const map of [db.read, db.starred]) {
    const keys = Object.keys(map);
    if (keys.length <= limit) continue;
    keys.sort((a, b) => (map[a] ?? 0) - (map[b] ?? 0));
    for (const key of keys.slice(0, keys.length - limit)) delete map[key];
  }
}

// ---------------------------------------------------------- обновление лент

/** Дочитывает историю канала: страница веб-превью отдаёт только ~20 последних постов. */
async function telegramHistory(channel, feedId, startItems, startMinId, pages) {
  const items = [...startItems];
  let before = startMinId;
  for (let page = 1; page < pages && before; page += 1) {
    await sleep(700);
    try {
      const res = await httpGet(telegramPreviewUrl(channel, before), { timeout: 20000, accept: 'text/html,application/xhtml+xml' });
      if (!res.ok) break;
      const parsed = parseTelegramChannel(res.text, `https://t.me/${channel}`, feedId, itemId);
      if (!parsed.items.length) break;
      items.push(...parsed.items);
      before = parsed.minMessageId;
    } catch {
      break;
    }
  }
  return items;
}

/**
 * У части каналов веб-превью отдаёт посты без медиа («текст не поддерживается»),
 * а страница встраивания (?embed=1) содержит фото и обложки видео. Для постов
 * без картинок забираем медиа со страницы встраивания.
 */
async function enrichTelegramMedia(channel, items, limit = 24, pageHasMedia = true) {
  // Если сама страница канала отдаёт посты без медиа, дозагружаем каждый пост:
  // у таких каналов даже обложка видео есть, а фото альбома — нет.
  const targets = items
    .filter((item) => item.messageId && (pageHasMedia ? !/<img\b/i.test(item.content ?? '') : true))
    .slice(0, limit);
  let added = 0;
  const summary = () => log(`telegram: постов без медиа ${targets.length}, добавлено фото ${added}`);
  for (const item of targets) {
    try {
      await sleep(400);
      const res = await httpGet(`https://t.me/${channel}/${item.messageId}?embed=1`, {
        timeout: 15000, accept: 'text/html,application/xhtml+xml',
      });
      if (!res.ok) continue;
      const parsed = parseTelegramChannel(res.text, `https://t.me/${channel}`, 'probe', itemId);
      const media = parsed.items[0];
      if (!media) continue;
      const known = new Set([...(item.content ?? '').matchAll(/<img[^>]+src="([^"]+)"/gi)].map((m) => m[1]));
      const pictures = [...(media.content ?? '').matchAll(/<img[^>]+src="([^"]+)"/gi)]
        .map((m) => m[1])
        .filter((url) => !known.has(url));
      if (pictures.length) {
        // Медиа ставим в начало поста, чтобы оно не «уезжало» в конец карточки.
        item.content = `${pictures.map((url) => `<p><img src="${url}" alt=""></p>`).join('\n')}\n${item.content ?? ''}`;
        added += pictures.length;
        if (!item.image) item.image = pictures[0];
      }
      if (media.video && !item.video) item.video = media.video;
    } catch { /* медиа необязательно */ }
  }
  if (targets.length) summary();
  return items;
}

async function telegramParse(channel, feedId, firstPageHtml, pages) {
  const parsed = parseTelegramChannel(firstPageHtml, `https://t.me/${channel}`, feedId, itemId);
  const items = await telegramHistory(channel, feedId, parsed.items, parsed.minMessageId, pages);
  return { ...parsed, items };
}

async function refreshFeed(feed, { force = false } = {}) {
  try {
    const isTelegram = feed.kind === 'telegram';
    const channel = isTelegram ? (feed.channel || telegramChannelFromUrl(feed.url)) : null;
    if (isTelegram && !channel) throw new Error('не разобрано имя Telegram-канала');
    const requestUrl = isTelegram ? telegramPreviewUrl(channel) : feed.url;
    // Если разборщик обновился, кэш сайта не используем: нужен свежий разбор.
    const stale = Number(db.parserVersion) !== PARSER_VERSION;
    const res = await httpGet(requestUrl, force || stale ? {} : { etag: feed.etag, lastModified: feed.lastModified });
    if (res.status === 304) {
      feed.lastFetched = new Date().toISOString();
      feed.lastError = '';
      return { id: feed.id, added: 0, unchanged: true };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (feed.kind === 'telegram-bot') {
      feed.lastFetched = new Date().toISOString();
      return { id: feed.id, added: 0, unchanged: true };   // такие каналы наполняет бот
    }
    let parsed;
    if (isTelegram) {
      parsed = parseTelegramChannel(res.text, feed.url, feed.id, itemId);
      const pageHasMedia = /tgme_widget_message_photo_wrap|tgme_widget_message_video_thumb/i.test(res.text);
      parsed = { ...parsed, items: await enrichTelegramMedia(channel, parsed.items, 24, pageHasMedia) };
      if (!feed.historyFilled) {
        parsed = { ...parsed, items: await telegramHistory(channel, feed.id, parsed.items, parsed.minMessageId, 3) };
        feed.historyFilled = true;
      }
    } else {
      parsed = parseFeed(res.text, feed.url, feed.id);
    }
    if (parsed.kind !== 'feed') throw new Error('ответ не похож на RSS/Atom');
    // Запоминаем адрес, по которому лента реально отдалась (например, после http→https),
    // чтобы не повторять цепочку редиректов при каждом обновлении.
    if (!isTelegram && res.finalUrl && res.finalUrl !== feed.url) {
      feed.url = res.finalUrl;
      feed.key = feedKey(res.finalUrl);
    }
    // Название, заданное в OPML или вручную, лента сама не перезаписывает.
    if (parsed.meta.title && parsed.meta.title !== feed.url && !feed.titleLocked) feed.title = parsed.meta.title;
    feed.siteUrl = parsed.meta.siteUrl || feed.siteUrl || '';
    feed.description = parsed.meta.description || feed.description || '';
    feed.icon = parsed.meta.icon || feed.icon || '';
    feed.format = parsed.format;
    db.parserVersion = PARSER_VERSION;
    feed.etag = res.etag || '';
    feed.lastModified = res.lastModified || '';
    feed.lastFetched = new Date().toISOString();
    feed.lastError = '';
    const added = await mergeItems(feed.id, parsed.items);
    return { id: feed.id, added, count: parsed.items.length };
  } catch (err) {
    feed.lastError = err.name === 'AbortError' ? 'таймаут запроса' : err.message;
    log(`ошибка ленты «${feed.title}»: ${feed.lastError}`);
    return { id: feed.id, error: feed.lastError };
  }
}

async function refreshMany(feeds, opts = {}) {
  const results = [];
  const queue = [...feeds];
  const workers = Array.from({ length: Math.min(4, queue.length || 1) }, async () => {
    while (queue.length) results.push(await refreshFeed(queue.shift(), opts));
  });
  await Promise.all(workers);
  db.lastRefresh = new Date().toISOString();
  lastRefreshAdded = results.reduce((n, r) => n + (r.added ?? 0), 0);
  lastRefreshFeeds = results.filter((r) => (r.added ?? 0) > 0).length;
  lastAddedByFeed = {};
  for (const r of results) if (r.id) lastAddedByFeed[r.id] = r.added ?? 0;
  // Счётчики комментариев обновляем после каждого обновления лент, в фоне.
  refreshCommentCounts().catch(() => {});
  store.saveStateSoon();
  return results;
}

// ------------------------------------------------- докачка полного текста

const fullTextQueue = [];
const queuedKeys = new Set();
let fullTextWorking = false;
let fullTextDone = 0;

function enqueueFullText(feedId, itemId) {
  const key = `${feedId}:${itemId}`;
  if (queuedKeys.has(key)) return;
  queuedKeys.add(key);
  fullTextQueue.push({ feedId, itemId });
}

/** Статья, текст которой в ленте обрезан или отсутствует. */
function needsFullText(feed, item) {
  // У постов Telegram текст уже пришёл целиком — на t.me за ним ходить не нужно.
  if (feed.kind === 'telegram' || feed.kind === 'telegram-bot') return false;
  if (!fetchFullEnabled() || !item.link || !/^https?:/i.test(item.link)) return false;
  if (db.read[item.id]) return false;
  if (item.hasFull) return false;
  const tried = item.fullTriedAt ? Date.parse(item.fullTriedAt) : 0;
  if (tried && Date.now() - tried < FULLTEXT_RETRY_DAYS * 86400000) return false;
  // Лента уже отдаёт полный текст — страницу не трогаем.
  return (item.contentLength ?? 0) < FULLTEXT_MIN_FEED_CHARS;
}

function enqueueFeedFullText(feedId) {
  const feed = feedById(feedId);
  if (!feed) return 0;
  let queued = 0;
  for (const item of db.items[feedId] ?? []) {
    if (!needsFullText(feed, item)) continue;
    enqueueFullText(feedId, item.id);
    queued += 1;
    if (fullTextQueue.length >= FULLTEXT_MAX_PER_CYCLE * 4) break;
  }
  return queued;
}

/**
 * Достаёт медиа одного поста Telegram со страницы встраивания. Нужно для старых
 * постов: со страницы канала они уже ушли, и обычный разбор их не видит.
 */
// Версия разбора постов Telegram: когда она растёт, сохранённые посты перечитываются.
const TG_CONTENT_VERSION = 3;

async function enrichTelegramItem(feed, item) {
  if (!item?.link || !/t\.me\//i.test(item.link)) return false;
  const match = /t\.me\/([A-Za-z0-9_]+)\/(\d+)/.exec(item.link);
  if (!match) return false;
  const [, channel, messageId] = match;
  try {
    const res = await httpGet(`https://t.me/${channel}/${messageId}?embed=1`, {
      timeout: 15000, accept: 'text/html,application/xhtml+xml',
    });
    if (!res.ok) return false;
    const parsed = parseTelegramChannel(res.text, `https://t.me/${channel}`, feed.id, itemId);
    const media = parsed.items[0];
    if (!media?.content) return false;
    await store.setBody(feed.id, item.id, { content: media.content, contentFetchedAt: new Date().toISOString(), tgVersion: TG_CONTENT_VERSION });
    cachePostMedia(feed.id, item.id, media.content).catch(() => {});
    const first = /<img[^>]+src="([^"]+)"/i.exec(media.content)?.[1];
    if (first && !item.image) { item.image = first; store.saveStateSoon(400, { bump: false }); }
    if (media.video && !item.video) item.video = media.video;
    return true;
  } catch {
    return false;
  }
}

async function fetchFullText(feedId, itemId) {
  const feed = feedById(feedId);
  const target = feed ? (db.items[feedId] ?? []).find((i) => i.id === itemId) : null;
  if (!feed || !target) return { ok: false, error: 'статья не найдена' };
  // Посты Telegram уже содержат полный текст: ссылка ведёт на страницу канала,
  // и «докачка» подменяла текст посторонней страницей.
  if (feed.kind === 'telegram' || feed.kind === 'telegram-bot') {
    const own = (await store.body(feedId, itemId)) ?? {};
    return { ok: Boolean(own.content), cached: true, own: true };
  }
  let body = (await store.body(feedId, itemId)) ?? {};
  // Текст, разобранный старой версией, считаем отсутствующим — он скачается заново.
  if (body.fullHtml && Number(body.bodyVersion ?? 1) < BODY_VERSION) {
    body = {};
    // статья считалась «текст есть» — снимаем метку, иначе клиент не попросит заново
    if (target.hasFull) { target.hasFull = false; store.saveStateSoon(400, { bump: false }); }
  }
  // Пост Telegram без тела: забираем медиа и текст со страницы встраивания.
  if (!body.fullHtml && !body.content && /t\.me\//i.test(target.link ?? '')) {
    const enriched = await enrichTelegramItem(feed, target).catch(() => false);
    if (enriched) {
      const fresh = (await store.body(feedId, itemId)) ?? {};
      if (fresh.content) {
        return { ok: true, chars: fresh.content.length, media: true };
      }
    }
  }
  if (body.fullHtml) {
    // Текст уже лежит в хранилище — помечаем статью, чтобы не ставить её в очередь снова.
    if (!target.hasFull) { target.hasFull = true; store.saveStateSoon(400, { bump: false }); }
    if (!target.excerpt && body.fullHtml) {
      const text = htmlToText(body.fullHtml);
      if (text) { target.excerpt = shortExcerpt(text); store.saveStateSoon(400, { bump: false }); }
    }
    // У старых избранных статей не было превью — берём картинку из текста.
    if (!target.image) {
      const firstImage = /<img[^>]+src="([^"]+)"/i.exec(body.fullHtml ?? '')?.[1];
      if (firstImage) { target.image = firstImage; store.saveStateSoon(400, { bump: false }); }
    }
    return { ok: true, cached: true };
  }

  try {
    // Страница загрузки, поиск, теги — это не текст статьи: такой адрес не читаем,
    // иначе в статью попадал список файлов или выдача поиска.
    if (/\/(download|downloads|search|tag|tags|category|catalog|archive|login|cart)\b/i.test(new URL(target.link).pathname)) {
      await store.setBody(feedId, itemId, { fullHtml: '' });
      target.hasFull = false;
      target.fullTriedAt = new Date().toISOString();
      store.saveStateSoon(400, { bump: false });
      return { ok: false, error: 'ссылка ведёт не на статью' };
    }
    await politeWait(target.link);
    const res = await httpGet(target.link, { timeout: 25000, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!/html/i.test(res.contentType)) throw new Error(`не HTML (${res.contentType || 'тип неизвестен'})`);
    const article = extractArticle(res.text, target.link);
    if (article.textLength < FULLTEXT_MIN_ARTICLE_CHARS || looksLikePageChrome(article.html)) {
      // Либо текста нет, либо это шапка/меню сайта — тогда остаётся текст из ленты.
      target.fullTriedAt = new Date().toISOString();
      store.saveStateSoon(400, { bump: false });
      return { ok: false, error: 'основной текст на странице не найден' };
    }
    // Разбор мог «найти» меню или чужую страницу: если текста меньше, чем уже
    // есть из ленты, ничего не перезаписываем.
    const freshText = htmlToText(article.html ?? '');
    const knownText = htmlToText((await store.body(feedId, itemId))?.content ?? '') || (target.excerpt ?? '');
    if (freshText.length < knownText.length * 0.5) {
      target.fullTriedAt = new Date().toISOString();
      store.saveStateSoon(400, { bump: false });
      return { ok: false, error: 'текст страницы короче текста ленты' };
    }
    await store.setBody(feedId, itemId, {
      fullHtml: article.html,
      fullFetchedAt: new Date().toISOString(),
      fullSource: target.link,
      bodyVersion: BODY_VERSION,        // чтобы старые тексты перекачались после правок разбора
    });
    // Сначала гарантированно записываем текст на диск и только потом помечаем статью скачанной.
    await store.flushFeed(feedId);
    target.hasFull = true;
    target.fullTriedAt = new Date().toISOString();
    if (!target.image && article.image) target.image = article.image;
    if (!target.excerpt) target.excerpt = htmlToText(article.html).slice(0, 400);
    store.saveStateSoon(400, { bump: false });
    fullTextDone += 1;
    return { ok: true, chars: article.textLength };
  } catch (err) {
    target.fullTriedAt = new Date().toISOString();
    store.saveStateSoon(400, { bump: false });
    return { ok: false, error: err.name === 'AbortError' ? 'таймаут запроса' : err.message };
  }
}

let pumpTimer = null;

/**
 * Разбирает очередь докачки и, если работы ещё осталось, сам себя перезапускает.
 * Раньше обработчик делал 40 статей за проход и останавливался — очередь «застывала».
 */
async function pumpQueue() {
  if (fullTextWorking) return;
  if (!fetchFullEnabled()) return;
  fullTextWorking = true;
  let processed = 0;
  try {
    while (fullTextQueue.length && processed < FULLTEXT_MAX_PER_CYCLE) {
      const job = fullTextQueue.shift();
      queuedKeys.delete(`${job.feedId}:${job.itemId}`);
      const result = await fetchFullText(job.feedId, job.itemId);
      processed += 1;
      if (result.ok && !result.cached) {
        log(`докачан текст: «${(findItem(job.itemId)?.item.title ?? '').slice(0, 60)}» (${result.chars} симв.)`);
      }
    }
    if (processed) log(`докачка: обработано ${processed}, осталось ${fullTextQueue.length}`);
  } catch (err) {
    log(`очередь докачки: ${err.message}`);
  } finally {
    fullTextWorking = false;
    // Продолжаем сами, без внешнего «пинка» — иначе очередь встаёт на середине.
    if (fullTextQueue.length) scheduleNextPump(4000);
  }
}

function scheduleNextPump(delay = 0) {
  if (pumpTimer || !fetchFullEnabled()) return;
  pumpTimer = setTimeout(() => {
    pumpTimer = null;
    pumpQueue();
  }, delay);
  pumpTimer.unref?.();
}

/** Ставит в очередь непрочитанные статьи с обрезанным текстом. */
function enqueueAllFullText() {
  if (!fetchFullEnabled()) return 0;
  let queued = 0;
  for (const feed of db.feeds) queued += enqueueFeedFullText(feed.id);
  return queued;
}

/** Основная точка входа: набрать очередь и начать качать. */
function scheduleFullText() {
  if (!fetchFullEnabled()) return;
  enqueueAllFullText();
  if (fullTextQueue.length) scheduleNextPump(0);
}

// --------------------------------------------------------- добавление лент

function normalizeUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('пустой адрес');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withScheme);
  if (!/^https?:$/.test(url.protocol)) throw new Error('поддерживаются только http/https');
  return url.href;
}

const CANDIDATE_PATHS = ['/feed', '/rss', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml', '/feeds/posts/default'];

/**
 * Ищет все подписки по указанному адресу: сама ссылка может быть лентой,
 * страницей сайта со ссылками на ленты или каналом Telegram.
 */
async function discoverCandidates(input) {
  const channel = telegramChannelFromUrl(input);
  if (channel) {
    const res = await httpGet(telegramPreviewUrl(channel), { timeout: 25000, accept: 'text/html,application/xhtml+xml' });
    if (!res.ok) throw new Error(`канал Telegram недоступен (HTTP ${res.status})`);
    const parsed = parseTelegramChannel(res.text, `https://t.me/${channel}`, 'probe', itemId);
    return [{
      url: `https://t.me/${channel}`,
      title: parsed.meta.title || `Telegram: ${channel}`,
      format: 'telegram',
      siteUrl: `https://t.me/${channel}`,
      items: parsed.items.length,
      hint: 'канал Telegram',
    }];
  }

  const url = normalizeUrl(input);
  const candidates = [];
  const seen = new Set();
  const addFeedCandidate = (feedUrl, text, hint) => {
    if (!text || !looksLikeFeed(text) || seen.has(feedUrl)) return;
    seen.add(feedUrl);
    try {
      const parsed = parseFeed(text, feedUrl, 'probe');
      candidates.push({
        url: feedUrl,
        title: parsed.meta.title || feedUrl,
        format: parsed.format,
        siteUrl: parsed.meta.siteUrl || '',
        items: parsed.items.length,
        hint,
      });
    } catch { /* не лента — пропускаем */ }
  };
  const probe = async (target, hint) => {
    if (seen.has(target)) return null;
    try {
      const res = await httpGet(target, { timeout: 20000 });
      if (!res.ok) return null;
      const finalUrl = res.finalUrl ?? target;
      if (looksLikeFeed(res.text)) { addFeedCandidate(finalUrl, res.text, hint); return null; }
      return /html/i.test(res.contentType) ? res.text : null;
    } catch {
      return null;
    }
  };

  let first = null;
  try {
    first = await httpGet(url, { timeout: 20000 });
  } catch (err) {
    throw new Error(`адрес недоступен (${err.name === 'AbortError' ? 'таймаут' : err.message})`);
  }
  if (first.ok && looksLikeFeed(first.text)) {
    addFeedCandidate(first.finalUrl ?? url, first.text, 'это сама лента');
  } else if (first.ok && /html/i.test(first.contentType)) {
    // Каналы Telegram, на которые ссылается сам сайт (у iXBT это t.me/ixbt_official):
    // иначе по адресу сайта находились только RSS-ленты.
    const telegramNames = [...new Set([...first.text.matchAll(/(?:https?:\/\/)?(?:t|telegram)\.me\/([A-Za-z0-9_]{3,40})/g)].map((m) => m[1]))]
      .filter((name) => !['s', 'joinchat', 'share', 'addstickers', 'proxy', 'iv'].includes(name.toLowerCase()))
      .slice(0, 2);
    for (const name of telegramNames) {
      const channelUrl = `https://t.me/${name}`;
      if (seen.has(channelUrl)) continue;
      try {
        const res = await httpGet(telegramPreviewUrl(name), { timeout: 20000, accept: 'text/html,application/xhtml+xml' });
        if (!res.ok) continue;
        const parsed = parseTelegramChannel(res.text, channelUrl, 'probe', itemId);
        if (!parsed.items.length) continue;         // не публичный канал
        seen.add(channelUrl);
        candidates.push({
          url: channelUrl,
          title: parsed.meta.title || `Telegram: ${name}`,
          format: 'telegram',
          siteUrl: channelUrl,
          items: parsed.items.length,
          hint: 'канал Telegram, найден на сайте',
        });
      } catch { /* канал недоступен — пропускаем */ }
    }

    // Сначала то, что сайт объявляет сам, затем типовые адреса.
    const declared = discoverFeedLinks(first.text, url).slice(0, 6);
    const base = new URL(url);
    const typical = CANDIDATE_PATHS.map((suffix) => new URL(suffix, `${base.origin}/`).href).slice(0, 4);
    const queue = [...declared, ...typical];
    const workers = Array.from({ length: Math.min(3, queue.length || 1) }, async () => {
      while (queue.length && candidates.length < 8) {
        const target = queue.shift();
        await probe(target, 'найдено на сайте');
      }
    });
    await Promise.all(workers);
  } else if (!first.ok) {
    throw new Error(`сайт ответил HTTP ${first.status}`);
  }

  if (!candidates.length) throw new Error('подписки не найдены — проверьте адрес или укажите ссылку на ленту');
  // Помечаем то, на что уже подписаны, и даём различимое название варианта.
  for (const candidate of candidates) {
    candidate.subscribed = Boolean(findFeedByUrl(candidate.url));
    candidate.label = distinctLabel(candidate);
  }
  return candidates;
}

/** Отличимое название варианта: к имени ленты добавляем путь, если имена совпадают. */
function distinctLabel(candidate) {
  try {
    const parsed = new URL(candidate.url);
    const path = `${parsed.hostname.replace(/^www\./i, '')}${parsed.pathname}`;
    return `${candidate.title} — ${path}${parsed.search ? '?…' : ''}`;
  } catch {
    return candidate.title;
  }
}

async function resolveFeed(input) {
  const url = normalizeUrl(input);
  const attempts = [url];
  let first = null;
  try {
    first = await httpGet(url, { timeout: 20000 });
    if (first.ok && looksLikeFeed(first.text)) return { url: first.finalUrl ?? url, text: first.text };
  } catch (err) {
    // Хост не отвечает: перебирать типовые пути бессмысленно и долго.
    throw new Error(`адрес недоступен (${err.name === 'AbortError' ? 'таймаут' : err.message})`);
  }

  if (first.ok && /html/i.test(first.contentType)) {
    for (const href of discoverFeedLinks(first.text, url)) {
      try {
        const res = await httpGet(href, { timeout: 20000 });
        if (res.ok && looksLikeFeed(res.text)) return { url: res.finalUrl ?? href, text: res.text };
      } catch { /* пробуем следующий */ }
      attempts.push(href);
    }
  }

  const base = new URL(url);
  for (const suffix of CANDIDATE_PATHS) {
    const candidate = new URL(suffix, `${base.origin}/`).href;
    if (attempts.includes(candidate)) continue;
    try {
      const res = await httpGet(candidate, { timeout: 15000 });
      if (res.ok && looksLikeFeed(res.text)) return { url: res.finalUrl ?? candidate, text: res.text };
    } catch { /* идём дальше */ }
  }
  throw new Error(first.status ? `по адресу нет RSS/Atom (HTTP ${first.status})` : 'не удалось найти RSS/Atom по этому адресу');
}

/** Готовит источник подписки: обычный RSS/Atom либо публичное веб-превью канала Telegram. */
async function openSource(input) {
  const channel = telegramChannelFromUrl(input);
  if (!channel) {
    const { url, text } = await resolveFeed(input);
    return { url, text, kind: 'rss', channel: null };
  }
  const url = `https://t.me/${channel}`;
  const res = await httpGet(telegramPreviewUrl(channel), { timeout: 20000, accept: 'text/html,application/xhtml+xml' });
  if (!res.ok) throw new Error(`канал Telegram недоступен (HTTP ${res.status})`);
  if (!/tgme_widget_message|tgme_channel_info/i.test(res.text)) {
    throw new Error('канал закрыт или не существует (нет публичного превью)');
  }
  return { url, text: res.text, kind: 'telegram', channel };
}

async function addFeed(input, folderId = null, preferredTitle = '') {
  const source = await openSource(input);
  const { url, text } = source;
  const existing = findFeedByUrl(url);
  if (existing) {
    if (folderId && existing.folderId !== folderId) { existing.folderId = folderId; store.saveStateSoon(); }
    // Название из OPML — это то, к чему пользователь привык: применяем его,
    // если лента ещё ни разу не переименовывалась вручную.
    if (preferredTitle && !existing.titleLocked && existing.title !== preferredTitle) {
      existing.title = preferredTitle.slice(0, 200);
      existing.titleLocked = true;
      store.saveStateSoon();
    }
    return { feed: existing, duplicate: true, added: 0 };
  }
  const id = randomUUID().slice(0, 8);
  const parsed = source.kind === 'telegram'
    ? await telegramParse(source.channel, id, text, 3)
    : parseFeed(text, url, id);
  const feed = {
    id,
    url,
    // Название: из OPML (привычное пользователю), иначе из самой ленты.
    title: (preferredTitle || parsed.meta.title || url).slice(0, 200),
    titleLocked: Boolean(preferredTitle),
    siteUrl: parsed.meta.siteUrl || '',
    description: parsed.meta.description || '',
    icon: parsed.meta.icon || '',
    format: parsed.format,
    folderId: folderId ?? null,
    order: nextFeedOrder(),
    kind: source.kind,
    channel: source.channel,
    historyFilled: source.kind === 'telegram',
    view: null,
    key: feedKey(url),
    addedAt: new Date().toISOString(),
    lastFetched: new Date().toISOString(),
    lastError: '',
    etag: '',
    lastModified: '',
  };
  db.feeds.push(feed);
  const added = await mergeItems(feed.id, parsed.items);
  store.saveStateSoon();
  log(`+ ${source.kind === 'telegram' ? 'канал Telegram' : 'лента'} «${feed.title}» (${parsed.format}), статей ${added}`);
  enqueueFeedFullText(feed.id);
  scheduleNextPump(0);
  return { feed, added, duplicate: false };
}

function ensureFolder(name) {
  const title = String(name ?? '').trim().slice(0, 80);
  if (!title) return null;
  const existing = db.folders.find((f) => f.name.toLowerCase() === title.toLowerCase());
  if (existing) return existing;
  const folder = { id: randomUUID().slice(0, 8), name: title, order: nextFolderOrder(), collapsed: false };
  db.folders.push(folder);
  return folder;
}

// ---------------------------------------------------------------------- OPML

const xmlEscape = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function toOpml() {
  const feedLine = (feed) => `      <outline type="rss" text="${xmlEscape(feed.title)}" title="${xmlEscape(feed.title)}" xmlUrl="${xmlEscape(feed.url)}"${feed.siteUrl ? ` htmlUrl="${xmlEscape(feed.siteUrl)}"` : ''}/>`;
  const rootFeeds = db.feeds.filter((f) => !f.folderId).sort((a, b) => a.order - b.order).map(feedLine);
  const folderBlocks = db.folders.sort((a, b) => a.order - b.order).map((folder) => {
    const feeds = db.feeds.filter((f) => f.folderId === folder.id).sort((a, b) => a.order - b.order).map(feedLine);
    return `    <outline text="${xmlEscape(folder.name)}" title="${xmlEscape(folder.name)}">\n${feeds.join('\n')}\n    </outline>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head>\n    <title>RSS Reader subscriptions</title>\n    <dateCreated>${new Date().toUTCString()}</dateCreated>\n  </head>\n  <body>\n${[...rootFeeds, ...folderBlocks].join('\n')}\n  </body>\n</opml>\n`;
}

function fromOpml(text) {
  const doc = parseXml(text);
  const found = [];
  const walk = (node, folder) => {
    for (const el of elementChildren(node)) {
      if (localName(el) !== 'outline') { walk(el, folder); continue; }   // <opml>, <body> и прочие обёртки
      const url = (el.attrs.xmlUrl || el.attrs.xmlurl || '').trim();
      const label = (el.attrs.title || el.attrs.text || '').trim();
      if (url) found.push({ url, folder, title: label });
      else walk(el, label || folder);
    }
  };
  walk(doc, null);
  const seen = new Set();
  const entries = found.filter(({ url }) => (seen.has(url) ? false : seen.add(url)));
  log(`OPML разобран: записей ${entries.length}${entries.some((e) => e.folder) ? `, папок ${new Set(entries.map((e) => e.folder).filter(Boolean)).size}` : ''}`);
  return entries;
}

// ---------------------------------------------------------------- сборка API

const FILTER_MODES = new Set(['hide', 'only']);

/** Приводит фильтры ленты к безопасному виду: только режим и слово. */
function normaliseFilters(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list.slice(0, 100)) {
    const query = String(raw?.query ?? '').trim().slice(0, 120);
    if (!query) continue;
    const mode = FILTER_MODES.has(raw?.mode) ? raw.mode : 'hide';
    const id = String(raw?.id ?? '').trim() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    out.push({ id, mode, query });
  }
  return out;
}

/** Текст статьи для фильтров: у Telegram заголовок — имя канала, его не берём. */
function filterHaystack(item) {
  const telegram = (item.categories ?? []).includes('telegram');
  return `${telegram ? '' : item.title ?? ''} ${item.author ?? ''} ${item.excerpt ?? ''}`.toLowerCase();
}

/**
 * Подходит ли статья под фильтры своей ленты. Логика совпадает с той, что в
 * интерфейсе: «скрывать» важнее «показывать только».
 * Фильтрованные статьи не скачиваем и не храним — их не должно быть и в Fever.
 */
function passesFilters(feed, item) {
  const filters = normaliseFilters(feed?.filters);
  if (!filters.length) return true;
  const hay = filterHaystack(item);
  if (filters.some((f) => f.mode === 'hide' && hay.includes(f.query.toLowerCase()))) return false;
  const only = filters.filter((f) => f.mode === 'only');
  if (only.length && !only.some((f) => hay.includes(f.query.toLowerCase()))) return false;
  return true;
}

/** Убирает из ленты уже сохранённые статьи, попавшие под фильтры. */
async function purgeFiltered(feedId) {
  const feed = feedById(feedId);
  if (!feed) return 0;
  const items = db.items[feedId] ?? [];
  const keep = items.filter((item) => passesFilters(feed, item));
  const removed = items.length - keep.length;
  if (!removed) return 0;
  const keepIds = new Set(keep.map((i) => i.id));
  for (const item of items) {
    if (keepIds.has(item.id)) continue;
    delete db.read[item.id];
    delete db.starred[item.id];
  }
  db.items[feedId] = keep;
  await store.pruneContent(feedId, keepIds);
  store.saveStateSoon();
  return removed;
}

function feedView(feed) {
  const items = db.items[feed.id] ?? [];
  const unread = items.filter((i) => !db.read[i.id]).length;
  const full = items.filter((i) => i.hasFull).length;
  return {
    ...feed,
    folderId: feed.folderId ?? null,
    filters: normaliseFilters(feed.filters),
    total: items.length,
    unread,
    withFullText: full,
  };
}

/** Один элемент списка в том виде, в каком он уходит клиенту. */
function payloadItem(feed, item) {
  return {
    id: item.id,
    title: item.title,
    link: item.link,
    date: item.date,
    author: item.author || undefined,
    excerpt: shortExcerpt(item.excerpt),
    // Клиенту нужен только факт наличия картинки: превью он берёт по своему id.
    image: item.image ? 1 : undefined,
    video: item.video || undefined,
    categories: item.categories?.length ? item.categories : undefined,
    hasFull: Boolean(item.hasFull) || undefined,
    comments: Boolean(commentsProviderFor(feed, item)) || undefined,
    commentsCount: Number.isFinite(item.commentsCount) ? item.commentsCount : null,
    feedId: feed.id,
    feedTitle: feed.title,
    read: Boolean(db.read[item.id]) || undefined,
    starred: Boolean(db.starred[item.id]) || undefined,
    starredAt: Number(db.starred[item.id]) || undefined,   // старые отметки без времени — в конце
  };
}

function buildPayload() {
  const feeds = [...db.feeds].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const items = [];
  // В списке отдаём только актуальное: непрочитанное, избранное и прочитанное
  // за последние дни. Всё это остаётся в базе — сокращается лишь ответ.
  const keepReadMs = Number(process.env.PAYLOAD_READ_DAYS || 7) * 24 * 60 * 60 * 1000;
  const freshAfter = Date.now() - keepReadMs;
  for (const feed of feeds) {
    for (const item of db.items[feed.id] ?? []) {
      const isRead = Boolean(db.read[item.id]);
      const isStarred = Boolean(db.starred[item.id]);
      if (isRead && !isStarred) {
        const at = Date.parse(item.date ?? '') || 0;
        if (at && at < freshAfter) continue;     // давно прочитанное в список не шлём
      }
      items.push({
        id: item.id,
        title: item.title,
        link: item.link,
        date: item.date,
        author: item.author || undefined,
        excerpt: shortExcerpt(item.excerpt),
        image: item.image ? 1 : undefined,
        video: item.video || undefined,
        categories: item.categories?.length ? item.categories : undefined,
        hasFull: Boolean(item.hasFull) || undefined,
        comments: Boolean(commentsProviderFor(feed, item)) || undefined,
        commentsCount: Number.isFinite(item.commentsCount) ? item.commentsCount : undefined,
        feedId: feed.id,
        feedTitle: feed.title,
        read: Boolean(db.read[item.id]) || undefined,
        starred: Boolean(db.starred[item.id]) || undefined,
    starredAt: Number(db.starred[item.id]) || undefined,   // старые отметки без времени — в конце
      });
    }
  }
  items.sort(byDateDesc);
  return {
    feeds: feeds.map(feedView),
    folders: [...db.folders].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    items,
    counts: {
      all: items.length,
      unread: items.filter((i) => !i.read).length,
      starred: items.filter((i) => i.starred).length,
    },
    refreshing,
    fetching: { pending: fullTextQueue.length, active: fullTextWorking, done: fullTextDone, enabled: fetchFullEnabled() },
    lastRefresh: db.lastRefresh,
    lastRefreshAdded,
    lastRefreshFeeds,
    addedByFeed: lastAddedByFeed,
    revision: Number(db.revision) || 0,
    nextRefreshAt,
    limits: { maxUnreadPerFeed: MAX_UNREAD_PER_FEED, keepReadDays: keepReadDays() },
  };
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  // Шрифты — с правильным типом: иначе часть браузеров не применяет @font-face.
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function readBody(req, limit = 2 * 1024 * 1024) {
  // Контроллер мог уже прочитать тело (например, чтобы понять, чей ключ Fever).
  if (typeof req.__body === 'string') return Promise.resolve(req.__body);
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('слишком большое тело запроса')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const readJson = async (req) => JSON.parse((await readBody(req)) || '{}');

// --------------------------------------------------------------- иконки подписок

const ICON_MAGIC = [
  (b) => b.length > 3 && b[0] === 0x00 && b[1] === 0x00 && (b[2] === 0x01 || b[2] === 0x02),   // .ico/.cur
  (b) => b.length > 7 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,     // png
  (b) => b.length > 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46,                      // gif
  (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8,                                       // jpeg
  (b) => b.length > 5 && b[0] === 0x3c,                                                        // svg/xml
];
const looksLikeImage = (buffer) => Boolean(buffer?.length) && ICON_MAGIC.some((test) => test(buffer));
const ICON_TYPE = (buffer, headerType) => {
  if (/^image\//i.test(headerType || '')) return headerType.split(';')[0];
  if (buffer[0] === 0x89) return 'image/png';
  if (buffer[0] === 0x47) return 'image/gif';
  if (buffer[0] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x00) return 'image/x-icon';
  return 'image/svg+xml';
};

async function httpGetBinary(url, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': UA, accept: 'image/avif,image/webp,image/png,image/*,*/*;q=0.5' },
    });
    const buffer = res.ok ? Buffer.from(await res.arrayBuffer()) : null;
    return { ok: res.ok, status: res.status, type: res.headers.get('content-type') || '', buffer };
  } finally {
    clearTimeout(timer);
  }
}

/** Ссылки на иконки, объявленные на странице сайта. */
function discoverIconLinks(html, pageUrl) {
  const found = [];
  const re = /<link\b[^>]*>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const tag = match[0];
    const rel = /rel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    if (!/icon|apple-touch-icon/.test(rel)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;
    try { found.push(new URL(href, pageUrl).href); } catch { /* битый href */ }
  }
  return [...new Set(found)].slice(0, 4);
}

const iconCache = new Map();   // feedId -> { status, file, type, at }

/** Иконка подписки: из ленты, из /favicon.ico либо объявленная на сайте. */
async function faviconFor(feed) {
  const cached = iconCache.get(feed.id);
  if (cached && Date.now() - cached.at < 6 * 3600_000) return cached;

  const site = feed.siteUrl || (() => { try { return new URL(feed.url).origin; } catch { return ''; } })();
  const candidates = [];
  if (feed.icon) candidates.push(feed.icon);
  if (site) {
    try { candidates.push(new URL('/favicon.ico', site).href); } catch { /* некорректный сайт */ }
  }

  const tryUrl = async (url) => {
    try {
      const res = await httpGetBinary(url);
      if (res.ok && looksLikeImage(res.buffer)) {
        await mkdir(MEDIA_DIR, { recursive: true });
        const type = ICON_TYPE(res.buffer, res.type);
        const ext = type === 'image/png' ? 'png' : type === 'image/gif' ? 'gif' : type === 'image/jpeg' ? 'jpg'
          : type === 'image/svg+xml' ? 'svg' : 'ico';
        const file = path.join(MEDIA_DIR, `fav-${feed.id}.${ext}`);
        await writeFile(file, res.buffer);
        const state = { status: 'ok', file, type, at: Date.now() };
        iconCache.set(feed.id, state);
        return state;
      }
    } catch { /* пробуем следующий вариант */ }
    return null;
  };

  for (const url of candidates) {
    const hit = await tryUrl(url);
    if (hit) return hit;
  }

  // Ничего не нашлось — смотрим, какие иконки объявлены на главной странице.
  if (site) {
    try {
      const page = await httpGet(site, { timeout: 15000 });
      if (page.ok) {
        for (const url of discoverIconLinks(page.text, site)) {
          const hit = await tryUrl(url);
          if (hit) return hit;
        }
      }
    } catch { /* сайт недоступен — останемся без иконки */ }
  }

  const miss = { status: 'none', at: Date.now() };
  iconCache.set(feed.id, miss);
  return miss;
}

async function serveFavicon(req, res, url) {
  const feed = feedById(url.searchParams.get('f') ?? '');
  if (!feed) { res.writeHead(404).end('нет такой подписки'); return; }
  const icon = await faviconFor(feed);
  if (icon.status !== 'ok') { res.writeHead(404, { 'cache-control': 'public, max-age=3600' }).end('иконки нет'); return; }
  try {
    const data = await readFile(icon.file);
    // Значки бывают по 100–300 КБ (логотипы сайтов). Список подписок от этого
    // тяжелеет на мегабайты, поэтому крупные иконки уменьшаем в WebP и отдаём
    // маленькими; совсем большие без возможности сжатия не отдаём.
    const limit = Number(process.env.FAVICON_MAX_BYTES || 24576);
    if (data.length > limit) {
      const webp = await compressToWebp(data, `${icon.file}.icon`, { quality: 70, width: 64 });
      if (webp) {
        res.writeHead(200, { 'content-type': 'image/webp', 'cache-control': 'private, max-age=86400' });
        res.end(webp);
        return;
      }
      res.writeHead(404, { 'cache-control': 'private, max-age=86400' }).end('иконка слишком большая');
      return;
    }
    res.writeHead(200, { 'content-type': icon.type, 'cache-control': 'private, max-age=86400' });
    res.end(data);
  } catch {
    res.writeHead(404).end('иконка не читается');
  }
}

// ------------------------------------------------------------- тела статей

/**
 * Тела сразу для набора статей: файл ленты читается один раз на ленту.
 * Заодно исправляет расхождение «скачан, а текста нет» — оно возникает, если процесс
 * прервали между записью состояния и записью файла с текстом.
 */
/**
 * Разово подставляет превью избранным статьям, у которых картинки не было, но
 * текст уже скачан. Без этого старые избранные так и оставались без картинок.
 */
let backfillDone = false;

async function backfillStarredImages(limit = 200) {
  let fixed = 0;
  for (const feed of db.feeds) {
    if (fixed >= limit) break;
    for (const item of db.items[feed.id] ?? []) {
      if (fixed >= limit) break;
      if (!db.starred[item.id] || item.image) continue;
      const body = (await store.body(feed.id, item.id)) ?? {};
      const firstImage = /<img[^>]+src="([^"]+)"/i.exec(body.fullHtml ?? body.content ?? '')?.[1];
      if (!firstImage) continue;
      item.image = firstImage;
      fixed += 1;
    }
  }
  if (fixed) {
    store.saveStateSoon(400, { bump: false });
    log(`превью избранного: подставлено картинок ${fixed}`);
  }
  return fixed;
}

async function bodiesFor(ids) {
  const out = {};
  const byFeed = new Map();
  for (const id of ids) {
    const found = findItem(id);
    if (!found) continue;
    if (!byFeed.has(found.feed.id)) byFeed.set(found.feed.id, []);
    byFeed.get(found.feed.id).push(found.item);
  }
  let enrichBudget = 2;      // не больше двух дозагрузок за один запрос
  for (const [feedId, items] of byFeed) {
    const feed = feedById(feedId);
    for (const item of items) {
      let body = (await store.body(feedId, item.id)) ?? {};
      // Пост Telegram, у которого нет ни текста, ни картинок: забираем содержимое
      // со страницы встраивания прямо при открытии (такие посты уже ушли со
      // страницы канала, обычный разбор их не видит).
      const staleBody = Boolean(body.content) && Number(body.tgVersion ?? 0) < TG_CONTENT_VERSION;
      // Перечитываем и тогда, когда есть «полный текст со страницы»: у постов
      // Telegram правильный источник — сам пост, а не извлечённая статья.
      if (feed && (!body.content || staleBody) && enrichBudget > 0 && /t\.me\//i.test(item.link ?? '')) {
        enrichBudget -= 1;
        const ok = await enrichTelegramItem(feed, item).catch(() => false);
        if (ok) body = (await store.body(feedId, item.id)) ?? {};
      }
      const hasText = Boolean(body.fullHtml);
      if (item.hasFull && !hasText) {
        item.hasFull = false;
        item.fullTriedAt = null;
        store.saveStateSoon();
      }
      out[item.id] = {
        ...(String(feed?.kind ?? '').startsWith('telegram') && !item.video
          ? (() => {
            const clip = /<video\b[^>]*\bsrc="([^"]+)"/i.exec(body.content ?? '');
            if (clip?.[1]) {
              item.video = clip[1];
              store.saveStateSoon(400, { bump: false });
              return { video: clip[1] };
            }
            return {};
          })()
          : {}),
        content: String(feed?.kind ?? '').startsWith('telegram')
          ? await postHtmlForClient(feedId, item.id, body.content ?? '')
          : (body.content ?? ''),
        fullHtml: String(feed?.kind ?? '').startsWith('telegram') ? '' : (body.fullHtml ?? ''),
        fullFetchedAt: body.fullFetchedAt ?? null,
        hasFull: String(feed?.kind ?? '').startsWith('telegram') ? false : hasText,
      };
    }
  }
  return out;
}

const itemHtml = async (feed, item) => {
  const body = (await store.body(feed.id, item.id)) ?? {};
  const html = body.fullHtml || body.content || (item.excerpt ? `<p>${item.excerpt}</p>` : '');
  // Лента «только картинки»: внешние приложения (Fever) должны получать то же,
  // что видно на сайте — без текста статьи.
  if (feed?.imagesOnly && html) {
    const pictures = [...String(html).matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
    return pictures.join('');
  }
  return html;
};

const feverContext = {
  get db() { return db; },
  get store() { return store; },
  json,
  readBody,
  numOf,
  feedNum,
  folderNum,
  itemHtml,
  authorizedKey: (key) => checkApiKey(key),
  saveSoon: () => store.saveStateSoon(),
  pruneState,
};

// --------------------------------------------------------------- настройки

function settingsView(req) {
  const s = settings();
  const authed = isAuthenticated(req, new URL('http://localhost/'));
  return {
    authEnabled: authEnabled(),
    envAuth: envAuth(),
    user: s.auth?.user ?? (envAuth() ? AUTH_USER : ''),
    fever: authed ? {
      path: '/fever/',
      apiKey: envAuth() ? feverApiKey(AUTH_USER, AUTH_PASS) : (s.auth?.apiKey ?? ''),
      user: envAuth() ? AUTH_USER : (s.auth?.user ?? ''),
      configured: Boolean(envAuth() || s.auth?.apiKey),
    } : { path: '/fever/', configured: Boolean(envAuth() || s.auth?.apiKey) },
    fetchFull: fetchFullEnabled(),
    // Режим работы «как клиент Fever»: список берём один раз за синхронизацию,
    // тексты храним на устройстве, отметки отправляем сразу.
    feverMode: Boolean(db.settings?.feverMode),
    defaultView: s.defaultView,
    defaultLines: Number(s.defaultLines) || 4,
    defaultWidth: clampTextWidth(s.defaultWidth ?? MAX_TEXT_WIDTH),
    widthStep: TEXT_WIDTH_STEP,
    minWidth: MIN_TEXT_WIDTH,
    maxWidth: MAX_TEXT_WIDTH,
    defaultSort: s.defaultSort ?? 'desc',
    nextRefreshAt,
    refreshMinutes: Number(s.refreshMinutes) || REFRESH_MINUTES,
    telegram: {
      hasToken: Boolean(telegramToken()),
      botUsername: s.telegram?.botUsername ?? '',
      botFeeds: db.feeds.filter((f) => f.kind === 'telegram-bot').length,
      webFeeds: db.feeds.filter((f) => f.kind === 'telegram').length,
    },
    fetching: { pending: fullTextQueue.length, active: fullTextWorking, done: fullTextDone },
  };
}

// ------------------------------------------------------------- Telegram-бот

let botLoopRunning = false;

const botFeedFor = (channel) => db.feeds.find((f) => f.kind === 'telegram-bot'
  && (String(f.chatId ?? '') === String(channel.id)
    || (channel.username && (f.channel ?? '').toLowerCase() === channel.username.toLowerCase())));

async function storeBotPost({ channel, post }) {
  let feed = botFeedFor(channel);
  if (!feed) {
    feed = {
      id: randomUUID().slice(0, 8),
      url: channel.url,
      title: channel.title,
      siteUrl: channel.url,
      description: 'Канал Telegram, получаемый через бота',
      icon: '',
      format: 'telegram-bot',
      kind: 'telegram-bot',
      channel: channel.username ?? '',
      chatId: channel.id,
      folderId: null,
      order: nextFeedOrder(),
      key: `telegram-bot:${channel.id}`,
      addedAt: new Date().toISOString(),
      lastFetched: new Date().toISOString(),
      lastError: '',
      etag: '',
      lastModified: '',
    };
    db.feeds.push(feed);
    log(`+ канал Telegram через бота: «${channel.title}»`);
  }
  feed.lastFetched = new Date().toISOString();
  feed.lastError = '';

  const image = post.photoFileId ? `/api/media?f=${feed.id}&m=${post.messageId}` : '';
  const parts = [];
  if (post.html) parts.push(post.html);
  if (image) parts.push(`<p><img src="${image}" alt=""></p>`);
  if (post.hasVideo || post.hasDocument) parts.push(`<p><a href="${post.link}">Вложение в Telegram ↗</a></p>`);

  const item = {
    id: itemId(feed.id, post.link),
    // У постов Telegram нет заголовка — пишем имя канала (см. lib/telegram.mjs).
    title: channel.title,
    link: post.link,
    date: post.date,
    author: channel.title,
    excerpt: post.text.slice(0, 400),
    content: parts.join('\n'),
    image,
    imageFileId: post.photoFileId,
    categories: ['telegram'],
    messageId: post.messageId,
  };
  await mergeItems(feed.id, [item]);
  store.saveStateSoon();
}

async function startTelegramBot() {
  if (botLoopRunning || !telegramToken()) return;
  botLoopRunning = true;
  let offset = Number(settings().telegram.lastUpdateId) || 0;
  log(`Telegram-бот: слушаю обновления каналов (offset ${offset})`);
  while (true) {
    if (!telegramToken()) {
      botLoopRunning = false;
      log('Telegram-бот: токен убран — опрос остановлен');
      return;
    }
    const res = await telegramGetUpdates(telegramToken(), offset, 30);
    if (!res.ok) {
      log(`Telegram-бот: ${res.error} (повтор через 20 с)`);
      await sleep(20_000);
      continue;
    }
    for (const update of res.updates) {
      offset = Math.max(offset, (update.update_id ?? 0) + 1);
      const parsed = parseBotUpdate(update);
      if (!parsed) continue;
      try {
        await storeBotPost(parsed);
        log(`Telegram-бот: новый пост в «${parsed.channel.title}»`);
      } catch (err) {
        log(`Telegram-бот: не сохранил пост (${err.message})`);
      }
    }
    if (res.updates.length) {
      settings().telegram.lastUpdateId = offset;
      store.saveStateSoon();
    }
  }
}

async function applyTelegramToken(rawToken) {
  const s = settings();
  const token = String(rawToken ?? '').trim();
  if (!token) {
    s.telegram.token = '';
    s.telegram.botUsername = '';
    store.saveStateSoon();
    return { ok: true, removed: true };
  }
  const me = await telegramBotMe(token);
  if (!me.ok) return { ok: false, error: `Telegram не принял токен: ${me.error}` };
  s.telegram.token = token;
  s.telegram.botUsername = me.username ?? '';
  s.telegram.lastUpdateId = Number(s.telegram.lastUpdateId) || 0;
  store.saveStateNow();
  startTelegramBot();
  return { ok: true, username: me.username };
}

// --------------------------------------------------------------- медиа-кэш

const MEDIA_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.mp4': 'video/mp4', '.pdf': 'application/pdf',
};

// ------------------------------------------------------------------ миниатюры
// Картинки статей лежат на чужих сайтах, поэтому в списке они грузились медленно —
// каждый раз заново с внешнего сервера. Скачиваем один раз и отдаём со своего диска.

const THUMB_MAX_BYTES = 4 * 1024 * 1024;
const THUMB_EXT = /\.(jpe?g|png|gif|webp|avif)$/i;

/** Имя файла миниатюры по адресу картинки. */
function thumbFileFor(source) {
  let ext = '.jpg';
  try {
    const match = new URL(source).pathname.match(THUMB_EXT);
    if (match) ext = `.${match[1].toLowerCase().replace('jpeg', 'jpg')}`;
  } catch { /* оставляем по умолчанию */ }
  return path.join(MEDIA_DIR, `thumb-${createHash('sha1').update(source).digest('hex').slice(0, 24)}${ext}`);
}

// -------------------------------------------------------------- видео из постов
// Видео Telegram лежит на их CDN и открывается далеко не всегда: то нужен Referer,
// то мешает CORS. Пробуем проиграть через свой прокси — потоком, без кеша на диске.

async function serveVideo(req, res, url) {
  let source = String(url.searchParams.get('u') ?? '');
  // На случай двойной обёртки: /api/video?u=/api/video?u=https%3A%2F%2F…
  const nestedSource = /^\/api\/video\?u=([\s\S]+)$/.exec(source);
  if (nestedSource) source = decodeURIComponent(nestedSource[1]);
  let parsed;
  try { parsed = new URL(source); } catch { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('плохой адрес'); return; }
  if (!/^https?:$/.test(parsed.protocol) || !isPublicUrl(parsed)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('адрес не разрешён');
    return;
  }
  const controller = new AbortController();
  res.on('close', () => controller.abort());          // клиент ушёл — бросаем загрузку
  try {
    const headers = { 'user-agent': UA, accept: '*/*', referer: `${parsed.origin}/` };
    if (req.headers.range) headers.range = req.headers.range;   // перемотка
    const response = await fetch(source, { headers, signal: controller.signal });
    if (!response.ok && response.status !== 206) throw new Error(`ответ ${response.status}`);
    const out = {
      'content-type': String(response.headers.get('content-type') ?? 'video/mp4'),
      'cache-control': 'no-store',
      'accept-ranges': String(response.headers.get('accept-ranges') ?? 'bytes'),
    };
    for (const header of ['content-length', 'content-range']) {
      const value = response.headers.get(header);
      if (value) out[header] = value;
    }
    res.writeHead(response.status === 206 ? 206 : 200, out);
    for await (const chunk of response.body) res.write(chunk);
    res.end();
  } catch {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('видео не удалось получить');
  }
}

/**
 * Из анимированного GIF делает обычную картинку — первый кадр. Миниатюры в списке
 * не должны «жить»: на телефоне они грузятся заново и дёргают ленту.
 * Формат GIF позволяет просто отрезать всё после первого кадра и закрыть файл.
 */
function firstGifFrame(buffer) {
  if (!buffer || buffer.length < 13) return null;
  const signature = buffer.toString('latin1', 0, 6);
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return null;
  let offset = 13;
  const packed = buffer[10];
  if (packed & 0x80) offset += 3 * (1 << ((packed & 0x07) + 1));   // глобальная палитра
  const skipSubBlocks = (pos) => {
    let at = pos;
    while (at < buffer.length) {
      const size = buffer[at];
      at += 1;
      if (!size) return at;
      at += size;
    }
    return at;
  };
  while (offset < buffer.length) {
    const marker = buffer[offset];
    if (marker === 0x21) { offset += 2; offset = skipSubBlocks(offset); continue; }   // расширение
    if (marker === 0x2C) break;                                                       // изображение
    if (marker === 0x3B) return null;                                                 // конец файла
    offset += 1;
  }
  if (buffer[offset] !== 0x2C) return null;
  const imageStart = offset;
  offset += 10;
  const localPacked = buffer[imageStart + 9];
  if (localPacked & 0x80) offset += 3 * (1 << ((localPacked & 0x07) + 1));            // локальная палитра
  offset += 1;                                                                        // размер LZW-кода
  offset = skipSubBlocks(offset);
  if (offset > buffer.length) return null;
  return Buffer.concat([buffer.subarray(0, imageStart), buffer.subarray(imageStart, offset), Buffer.from([0x3B])]);
}

async function serveThumb(req, res, url) {
  const id = url.searchParams.get('id') ?? '';
  const source = String(findItem(id)?.item?.image ?? '');
  if (!/^https?:\/\//i.test(source)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('нет картинки');
    return;
  }
  const file = thumbFileFor(source);
  try {
    const webp = await readFile(file + '.webp');
    res.writeHead(200, { 'content-type': 'image/webp', 'cache-control': 'private, max-age=604800' });
    res.end(webp);
    return;
  } catch { /* ещё не сжимали */ }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MEDIA_TYPES[path.extname(file).toLowerCase()] ?? 'image/jpeg', 'cache-control': 'private, max-age=604800' });
    res.end(data);
    return;
  } catch { /* ещё не скачивали */ }

  try {
    const response = await fetch(source, {
      headers: { 'user-agent': UA, accept: 'image/*' },
      signal: AbortSignal.timeout(15000),
    });
    const type = String(response.headers.get('content-type') ?? '');
    if (!response.ok || !type.startsWith('image/')) throw new Error(`ответ ${response.status}`);
    let buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > THUMB_MAX_BYTES) throw new Error('слишком большая');
    // Анимированный GIF превращаем в статичную картинку — первый кадр.
    if (/gif/i.test(type)) buffer = firstGifFrame(buffer) ?? buffer;

    // Миниатюра карточки должна быть маленькой: уменьшаем до 320 px и сжимаем
    // в WebP. Иначе при листании уходили сотни килобайт на каждую карточку.
    const small = await compressToWebp(buffer, file, { quality: 65, width: 320 });
    await mkdir(MEDIA_DIR, { recursive: true });
    pruneMediaCache().catch(() => {});
    if (small) {
      await writeFile(file + '.webp', small).catch(() => {});
      res.writeHead(200, { 'content-type': 'image/webp', 'cache-control': 'private, max-age=604800' });
      res.end(small);
      return;
    }
    await writeFile(file, buffer).catch(() => {});
    res.writeHead(200, { 'content-type': /gif/i.test(type) ? 'image/gif' : type, 'cache-control': 'private, max-age=604800' });
    res.end(buffer);
  } catch {
    // Не получилось — отдаём браузеру исходный адрес, просто без кэша.
    res.writeHead(302, { location: source, 'cache-control': 'no-store' });
    res.end();
  }
}

// --------------------------------------------------------- картинки статей
// Часть лент (например batona.net) отдаёт картинки по http://. На странице по https
// браузер такие картинки блокирует как «смешанное содержимое», поэтому скачиваем их
// сами и отдаём со своего домена. Кэш — в том же каталоге медиа.

const IMG_MAX_BYTES = 12 * 1024 * 1024;

function imageFileFor(source) {
  let ext = '.jpg';
  try {
    const match = new URL(source).pathname.match(THUMB_EXT);
    if (match) ext = `.${match[1].toLowerCase().replace('jpeg', 'jpg')}`;
  } catch { /* оставляем по умолчанию */ }
  return path.join(MEDIA_DIR, `img-${createHash('sha1').update(source).digest('hex').slice(0, 24)}${ext}`);
}

/** Не пускаем запросы внутрь локальной сети — только обычные внешние адреса. */
function isPublicUrl(parsed) {
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return false;
  if (/^127\./.test(host) || /^0\./.test(host) || /^10\./.test(host) || /^169\.254\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  return true;
}

// Крупные картинки пережимаем в WebP: экономия в 3–10 раз, страница легче,
// особенно на мобильном интернете. Инструмент cwebp (пакет webp) необязателен:
// если его нет, отдаём оригинал.
const IMG_RECOMPRESS_ABOVE = Number(process.env.IMG_RECOMPRESS_ABOVE || 60 * 1024);
const IMG_WEBP_QUALITY = Number(process.env.IMG_WEBP_QUALITY || 75);
const IMG_WEBP_WIDTH = Number(process.env.IMG_WEBP_WIDTH || 900);
let webpAvailable = null;

async function runCwebp(args) {
  return new Promise((resolve) => {
    const child = spawn('cwebp', args, { stdio: 'ignore' });
    // 'missing' — инструмента нет вовсе: тогда сжатие больше не пытаемся.
    // 'failed' — не сжался конкретный файл (например, SVG): остальные пробуем.
    child.on('error', () => resolve('missing'));
    child.on('close', (code) => resolve(code === 0 ? 'ok' : 'failed'));
  });
}

/** Пережимает картинку в WebP. Возвращает буфер или null, если не вышло. */
async function compressToWebp(buffer, baseFile, { quality, width } = {}) {
  if (webpAvailable === false) return null;
  // Если параметры заданы явно (например, для иконок), порог не применяем.
  if (!quality && buffer.length < IMG_RECOMPRESS_ABOVE) return null;
  const source = `${baseFile}.src`;
  const target = `${baseFile}.webp`;
  try {
    await mkdir(MEDIA_DIR, { recursive: true });
    await writeFile(source, buffer);
    const ok = await runCwebp(['-quiet', '-q', String(quality ?? IMG_WEBP_QUALITY), '-resize', String(width ?? IMG_WEBP_WIDTH), '0', '-o', target, source]);
    if (ok === 'missing') {
      webpAvailable = false;
      log('cwebp не найден — картинки отдаём как есть');
      return null;
    }
    if (ok !== 'ok') {
      // Формат не подошёл (SVG, анимированный GIF): не выключаем сжатие целиком.
      log(`файл ${path.basename(baseFile)} не сжался (${Math.round(buffer.length / 1024)} КБ)`);
      return null;
    }
    const out = await readFile(target);
    return out.length && out.length < buffer.length ? out : null;
  } catch {
    return null;
  } finally {
    unlink(source).catch(() => {});
  }
}


/**
 * Держит кэш картинок в разумных размерах. 22.10.2026 диск сервера (30 ГБ)
 * заполнился до 100% и запись состояния оборвалась — поэтому кэш ограничен.
 */
const MEDIA_CACHE_LIMIT_BYTES = Number(process.env.MEDIA_CACHE_LIMIT || 300 * 1024 * 1024);
let mediaPruneAt = 0;

async function pruneMediaCache() {
  if (Date.now() - mediaPruneAt < 10 * 60 * 1000) return;
  mediaPruneAt = Date.now();
  try {
    const names = await readdir(MEDIA_DIR).catch(() => []);
    if (!names.length) return;
    const entries = [];
    let total = 0;
    for (const name of names) {
      const info = await stat(path.join(MEDIA_DIR, name)).catch(() => null);
      if (!info?.isFile()) continue;
      entries.push({ name, size: info.size, at: info.mtimeMs });
      total += info.size;
    }
    if (total <= MEDIA_CACHE_LIMIT_BYTES) return;
    entries.sort((a, b) => a.at - b.at);
    let freed = 0;
    for (const entry of entries) {
      if (total - freed <= MEDIA_CACHE_LIMIT_BYTES) break;
      await unlink(path.join(MEDIA_DIR, entry.name)).catch(() => {});
      freed += entry.size;
    }
    log(`кэш картинок подчищен: освобождено ${Math.round(freed / 1024 / 1024)} МБ`);
  } catch { /* не критично */ }
}

async function serveImage(req, res, url) {
  const source = String(url.searchParams.get('u') ?? '');
  let parsed;
  try { parsed = new URL(source); } catch { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('плохой адрес'); return; }
  if (!/^https?:$/.test(parsed.protocol) || !isPublicUrl(parsed)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('адрес не разрешён');
    return;
  }
  const file = imageFileFor(source);
  try {
    const webp = await readFile(`${file}.webp`);
    res.writeHead(200, { 'content-type': 'image/webp', 'cache-control': 'private, max-age=604800' });
    res.end(webp);
    return;
  } catch { /* webp ещё нет */ }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MEDIA_TYPES[path.extname(file).toLowerCase()] ?? 'image/jpeg', 'cache-control': 'private, max-age=604800' });
    res.end(data);
    return;
  } catch { /* ещё не скачивали */ }

  try {
    const response = await fetch(source, {
      headers: { 'user-agent': UA, accept: 'image/*', referer: `${parsed.origin}/` },
      signal: AbortSignal.timeout(20000),
    });
    const type = String(response.headers.get('content-type') ?? '');
    if (!response.ok || !type.startsWith('image/')) throw new Error(`ответ ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > IMG_MAX_BYTES) throw new Error('слишком большая');
    await mkdir(MEDIA_DIR, { recursive: true });
    await writeFile(file, buffer).catch(() => {});
    const webp = await compressToWebp(buffer, file);
    if (webp) {
      await writeFile(`${file}.webp`, webp).catch(() => {});
      res.writeHead(200, { 'content-type': 'image/webp', 'cache-control': 'private, max-age=604800' });
      res.end(webp);
      return;
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'private, max-age=604800' });
    res.end(buffer);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('картинка не скачалась');
  }
}

/** Имя файла кэша для N-й картинки поста. */
function postMediaFile(feedId, itemId, index) {
  return 'tg-' + feedId + '-' + itemId + '-' + index + '.img';
}

/** Скачивает картинки поста в кэш на сервере (до limit штук). */
async function cachePostMedia(feedId, itemId, html, limit = 12) {
  const urls = [...String(html ?? '').matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]).slice(0, limit);
  await mkdir(MEDIA_DIR, { recursive: true }).catch(() => {});
  let saved = 0;
  for (let index = 0; index < urls.length; index += 1) {
    const target = path.join(MEDIA_DIR, postMediaFile(feedId, itemId, index));
    try { await readFile(target); saved += 1; continue; } catch { /* ещё нет в кэше */ }
    try {
      const response = await fetch(urls[index], { headers: { 'user-agent': UA, accept: '*/*' } });
      if (!response.ok) continue;
      const bin = Buffer.from(await response.arrayBuffer());
      if (bin.length < 200) continue;
      await writeFile(target, bin);
      saved += 1;
    } catch { /* пропускаем картинку */ }
  }
  return saved;
}

/** Гарантирует, что картинка лежит в кэше: при промахе скачивает и сохраняет. */
async function ensureCachedMedia(feedId, itemId, index, remoteUrl) {
  const target = path.join(MEDIA_DIR, postMediaFile(feedId, itemId, index));
  try {
    await readFile(target);
    return true;
  } catch { /* ещё нет — качаем сейчас */ }
  if (!remoteUrl) return false;
  try {
    const response = await fetch(remoteUrl, { headers: { 'user-agent': UA, accept: '*/*' } });
    if (!response.ok) return false;
    const bin = Buffer.from(await response.arrayBuffer());
    if (bin.length < 200) return false;
    await mkdir(MEDIA_DIR, { recursive: true }).catch(() => {});
    await writeFile(target, bin).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** Каждая картинка — отдельным абзацем; отдаём только то, что удалось закэшировать. */
async function postHtmlForClient(feedId, itemId, html) {
  let out = String(html ?? '');
  const urls = [...out.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]);
  // Склеенные в одном абзаце картинки разносим по отдельным абзацам.
  out = out.replace(/<p[^>]*>\s*((?:<img\b[^>]*>\s*)+)<\/p>/gi, (match, inner) => {
    const pics = [...inner.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
    return pics.map((pic) => '<p>' + pic + '</p>').join('\n');
  });
  let index = 0;
  const pieces = [];
  const re = /<img\b([^>]*?)\bsrc="[^"]*"[^>]*>|<[^>]+>|[^<]+/gi;
  let match;
  while ((match = re.exec(out)) !== null) {
    const chunk = match[0];
    if (/^<img\b/i.test(chunk)) {
      const current = index;
      index += 1;
      // Картинку, которой нет в кэше (битая ссылка Telegram), не показываем вовсе.
      // Все картинки отдаём сразу; если файла ещё нет, его скачает /api/media
      // при первом обращении. Скачивание внутри запроса делало ответ слишком медленным.
      void ensureCachedMedia(feedId, itemId, current, urls[current]).catch(() => false);
      const before = match[1] ?? '';
      pieces.push('<img' + before + ' src="/api/media?f=' + feedId + '&k=' + itemId + '&i=' + current + '">');
    } else {
      pieces.push(chunk);
    }
  }
  return pieces.join('');
}

async function serveMedia(req, res, url) {
  const feedId = url.searchParams.get('f') ?? '';
  // Короткая ссылка на картинку поста: отдаём из кэша, при промахе качаем и кэшируем.
  const postId = url.searchParams.get('k') ?? '';
  if (postId) console.log('media: f=' + feedId + ' k=' + postId + ' i=' + (url.searchParams.get('i') ?? '0'));
  if (postId) {
    const index = Math.max(0, Number.parseInt(url.searchParams.get('i') ?? '0', 10) || 0);
    const target = path.join(MEDIA_DIR, postMediaFile(feedId, postId, index));
    try {
      const data = await readFile(target);
      console.log('media ok из кэша, байт ' + data.length);
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400' });
      return res.end(data);
    } catch { /* ещё не скачано */ }
    const stored = (await store.body(feedId, postId)) ?? {};
    const remote = [...String(stored.content ?? '').matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1])[index] ?? '';
    if (!remote) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('нет файла');
      return;
    }
    try {
      // Пробуем дважды: Telegram иногда отдаёт файл не с первого раза.
      let response = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        response = await fetch(remote, { headers: { 'user-agent': UA, accept: '*/*' } }).catch(() => null);
        if (response?.ok) break;
        await sleep(400);
      }
      if (!response?.ok) throw new Error(String(response?.status ?? 'нет ответа'));
      const bin = Buffer.from(await response.arrayBuffer());
      await mkdir(MEDIA_DIR, { recursive: true }).catch(() => {});
      await writeFile(target, bin).catch(() => {});
      res.writeHead(200, {
        'content-type': response.headers.get('content-type') ?? 'image/jpeg',
        'cache-control': 'private, max-age=86400',
      });
      console.log('media ok скачано, байт ' + bin.length);
      return res.end(bin);
    } catch (err) {
      console.log('media FAIL ' + String(err.message));
      // Ссылка устарела (Telegram отдаёт 404/500) — перечитываем пост в фоне,
      // чтобы получить свежие адреса картинок; сейчас честно отвечаем 404.
      const feed = feedById(feedId);
      const post = (db.items[feedId] ?? []).find((i) => i.id === postId);
      if (feed && post) enrichTelegramItem(feed, post).catch(() => false);
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('картинка недоступна');
      return undefined;
    }
  }
  const messageId = Number.parseInt(url.searchParams.get('m') ?? '', 10);
  const item = (db.items[feedId] ?? []).find((i) => i.messageId === messageId);
  const fileId = item?.imageFileId;
  const token = telegramToken();
  if (!fileId || !token) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('нет файла'); return; }

  const key = createHash('sha1').update(fileId).digest('hex').slice(0, 24);
  await mkdir(MEDIA_DIR, { recursive: true });
  const cached = path.join(MEDIA_DIR, key);
  try {
    const data = await readFile(cached);
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400' });
    return res.end(data);
  } catch { /* ещё не скачано */ }

  try {
    const info = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`).then((r) => r.json());
    if (!info.ok) throw new Error(info.description ?? 'getFile не удался');
    const filePath = info.result.file_path;
    const bin = Buffer.from(await fetch(telegramFileUrl(token, filePath)).then((r) => r.arrayBuffer()));
    const type = MEDIA_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    await writeFile(cached, bin);
    res.writeHead(200, { 'content-type': type, 'cache-control': 'private, max-age=86400' });
    return res.end(bin);
  } catch (err) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end(`не удалось получить файл: ${err.message}`);
  }
}

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  // ---------------------------------------------------- вход и настройки
  if (route === 'GET /api/session') {
    const authed = isAuthenticated(req, url);
    const view = settingsView(req);
    return json(res, 200, {
      ok: true,
      authRequired: authEnabled(),
      authenticated: authed,
      envAuth: envAuth(),
      user: authed ? (view.user || 'без пароля') : null,
      fever: authed ? view.fever : null,
    });
  }

  if (route === 'POST /api/login') {
    if (!authEnabled()) return json(res, 400, { ok: false, error: 'вход не настроен: задайте логин и пароль в настройках' });
    const body = await readJson(req);
    const user = String(body.user ?? '').trim();
    const password = String(body.password ?? '');
    if (!checkPassword(user, password)) return json(res, 401, { ok: false, error: 'неверный логин или пароль' });
    const ttl = body.remember ? SESSION_TTL : SHORT_SESSION_TTL;
    res.setHeader('set-cookie', cookieHeader(SESSION_COOKIE, issueSession(sessionSecret(), user, ttl), { maxAge: ttl }));
    return json(res, 200, { ok: true, user, authenticated: true });
  }

  if (route === 'POST /api/logout') {
    res.setHeader('set-cookie', cookieHeader(SESSION_COOKIE, '', { maxAge: 0 }));
    return json(res, 200, { ok: true });
  }

  if (route === 'GET /api/settings') return json(res, 200, { ok: true, settings: settingsView(req) });

  if (route === 'POST /api/settings') {
    const body = await readJson(req);
    const s = settings();
    if (typeof body.feverMode === 'boolean') db.settings.feverMode = body.feverMode;
    if (typeof body.fetchFull === 'boolean') {
      s.fetchFull = body.fetchFull;
      if (body.fetchFull) { enqueueAllFullText(); pumpQueue(); }
    }
    if (['compact', 'compact-thumb', 'full'].includes(body.defaultView)) s.defaultView = body.defaultView;
    if (body.defaultSort === 'asc' || body.defaultSort === 'desc') s.defaultSort = body.defaultSort;
    if (body.defaultLines !== undefined) {
      const lines = Math.min(12, Math.max(1, Math.round(Number(body.defaultLines)) || 2));
      s.defaultLines = lines;
      // Меняя «строки по умолчанию», пользователь ожидает увидеть это во всех
      // лентах: снимаем прежние персональные значения, которые перекрывали настройку.
      for (const feed of db.feeds) if (feed.lines !== undefined) delete feed.lines;
    }
    if (body.defaultWidth !== undefined) s.defaultWidth = clampTextWidth(body.defaultWidth);
    if (body.keepReadDays !== undefined) {
      const days = Number(body.keepReadDays);
      if (KEEP_READ_DAYS_CHOICES.includes(days)) s.keepReadDays = days;
    }
    if (body.refreshMinutes !== undefined) {
      const minutes = Math.min(1440, Math.max(MIN_REFRESH_MINUTES, Number(body.refreshMinutes) || REFRESH_MINUTES));
      s.refreshMinutes = minutes;
      schedulePeriodicRefresh();
      log(`интервал обновления лент: ${minutes} мин`);
    }
    let telegram = null;
    if (typeof body.telegramToken === 'string') {
      telegram = await applyTelegramToken(body.telegramToken);
      if (!telegram.ok) return json(res, 400, { ok: false, error: telegram.error, settings: settingsView(req) });
    }
    store.saveStateSoon();
    return json(res, 200, { ok: true, telegram, settings: settingsView(req), data: buildPayload() });
  }

  if (route === 'POST /api/settings/credentials') {
    const body = await readJson(req);
    const s = settings();
    if (authEnabled() && !isAuthenticated(req, url)) return json(res, 401, { ok: false, error: 'нужен вход под текущим паролем' });
    if (body.clear) {
      s.auth = null;
      await store.saveStateNow();
      res.setHeader('set-cookie', cookieHeader(SESSION_COOKIE, '', { maxAge: 0 }));
      log('доступ: логин и пароль убраны — вход не требуется');
      return json(res, 200, { ok: true, cleared: true, settings: settingsView(req) });
    }
    const user = String(body.user ?? '').trim();
    const password = String(body.password ?? '');
    if (!user || password.length < 4) return json(res, 400, { ok: false, error: 'нужны логин и пароль не короче 4 символов' });
    if (!authEnabled() && !isLocalRequest(req)) {
      return json(res, 403, { ok: false, error: 'первый пароль можно задать только с этой машины (localhost)' });
    }
    s.auth = {
      user,
      passHash: hashPassword(password),
      apiKey: feverApiKey(user, password),
      secret: s.auth?.secret ?? newSecret(),
      updatedAt: new Date().toISOString(),
    };
    await store.saveStateNow();
    const ttl = SESSION_TTL;
    res.setHeader('set-cookie', cookieHeader(SESSION_COOKIE, issueSession(sessionSecret(), user, ttl), { maxAge: ttl }));
    log(`доступ: задан логин «${user}» (веб-клиент и Fever API)`);
    return json(res, 200, { ok: true, user, settings: settingsView(req) });
  }

  if (route === 'GET /api/media') return serveMedia(req, res, url);
  if (route === 'GET /api/favicon') return serveFavicon(req, res, url);
  if (route === 'GET /api/thumb') return serveThumb(req, res, url);
  if (route === 'GET /api/img') return serveImage(req, res, url);
  if (route === 'GET /api/video') return serveVideo(req, res, url);

  if (route === 'POST /api/bodies') {
    const body = await readJson(req);
    const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string').slice(0, 80) : [];
    return json(res, 200, { ok: true, bodies: await bodiesFor(ids) });
  }

  // Комментарии к статье (Хабр — через его JSON-API; для остальных сайтов не поддерживается).
  if (route === 'GET /api/comments') {
    const id = url.searchParams.get('id') ?? '';
    const found = findItem(id);
    if (!found) return json(res, 404, { ok: false, error: 'статья не найдена' });
    const provider = commentsProviderFor(found.feed, found.item);
    if (!provider) return json(res, 200, { ok: true, supported: false });
    const body = (await store.body(found.feed.id, found.item.id)) ?? {};
    const cachedAt = body.commentsAt ? Date.parse(body.commentsAt) : 0;
    const fresh = body.comments && cachedAt && Date.now() - cachedAt < COMMENTS_TTL_MS;
    if (fresh && url.searchParams.get('force') !== '1') {
      return json(res, 200, { ok: true, supported: true, cached: true, fetchedAt: body.commentsAt, ...body.comments });
    }
    try {
      const result = await provider.load(httpGet);
      await store.setBody(found.feed.id, found.item.id, { comments: result, commentsAt: new Date().toISOString() });
      if (Number.isFinite(result.total)) {
        found.item.commentsCount = result.total;
        found.item.commentsCountAt = new Date().toISOString();
        store.saveStateSoon();
      }
      return json(res, 200, { ok: true, supported: true, fetchedAt: new Date().toISOString(), ...result });
    } catch (err) {
      return json(res, 200, { ok: false, supported: true, error: err.message, cached: false });
    }
  }

  // Количество комментариев пачкой — чтобы кнопка сразу показывала цифру.
  if (route === 'POST /api/comments/counts') {
    const body = await readJson(req);
    const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string').slice(0, 60) : [];
    const counts = {};
    const jobs = [];
    for (const id of ids) {
      const found = findItem(id);
      if (!found) continue;
      const provider = commentsProviderFor(found.feed, found.item);
      if (!provider?.count) continue;
      const checkedAt = found.item.commentsCountAt ? Date.parse(found.item.commentsCountAt) : 0;
      if (Number.isFinite(found.item.commentsCount) && Date.now() - checkedAt < COMMENTS_COUNT_TTL_MS) {
        counts[id] = found.item.commentsCount;
        continue;
      }
      jobs.push({ id, found, provider });
    }
    const queue = [...jobs];
    const workers = Array.from({ length: Math.min(4, queue.length || 1) }, async () => {
      while (queue.length) {
        const job = queue.shift();
        try {
          const count = await job.provider.count(httpGet);
          counts[job.id] = count;
          job.found.item.commentsCount = count;
        } catch {
          counts[job.id] = null;                  // не получилось — кнопка будет без цифры
        }
        job.found.item.commentsCountAt = new Date().toISOString();
      }
    });
    await Promise.all(workers);
    store.saveStateSoon();
    return json(res, 200, { ok: true, counts });
  }

  if (route === 'POST /api/feeds/view') {
    const { id, view, lines, sort, width, imagesOnly } = await readJson(req);
    const feed = feedById(id);
    if (!feed) return json(res, 404, { ok: false, error: 'лента не найдена' });
    if (['compact', 'compact-thumb', 'full'].includes(view)) feed.view = view;
    else if (view === null) feed.view = null;
    if (lines !== undefined) {
      const count = Number(lines);
      feed.lines = Number.isFinite(count) && count > 0 ? Math.min(12, Math.round(count)) : null;
    }
    if (sort === 'asc' || sort === 'desc') feed.sort = sort;
    else if (sort === null) feed.sort = null;
    if (imagesOnly !== undefined) feed.imagesOnly = Boolean(imagesOnly);
    store.saveStateSoon();
    // Настройка вида ленты: списком статей отвечать не нужно (это мегабайты),
    // достаточно новой ревизии — клиент применил настройку у себя.
    return json(res, 200, { ok: true, revision: db.revision });
  }

  // Фильтры ленты: «скрывать с таким словом» и «показывать только с таким».
  if (route === 'POST /api/feeds/filters') {
    const { feedId, filters } = await readJson(req);
    const feed = feedById(feedId);
    if (!feed) return json(res, 404, { ok: false, error: 'лента не найдена' });
    feed.filters = normaliseFilters(filters);
    store.saveStateSoon();
    const dropped = await purgeFiltered(feed.id);
    if (dropped) log(`лента «${feed.title}»: удалено под фильтры ${dropped} статей`);
    return json(res, 200, { ok: true, data: buildPayload() });
  }

  // Проверка адреса перед подпиской: какие ленты нашлись на сайте.
  if (route === 'POST /api/discover') {
    const body = await readJson(req);
    const raw = String(body.url ?? '').trim();
    if (!raw) return json(res, 400, { ok: false, error: 'пустой адрес' });
    try {
      const candidates = await discoverCandidates(raw);
      return json(res, 200, { ok: true, candidates });
    } catch (err) {
      return json(res, 200, { ok: false, error: err.message, candidates: [] });
    }
  }

  if (route === 'POST /api/queue') {
    const { action } = await readJson(req);
    if (action === 'clear') { fullTextQueue.length = 0; queuedKeys.clear(); }
    if (action === 'start') { enqueueAllFullText(); pumpQueue(); }
    return json(res, 200, { ok: true, fetching: { pending: fullTextQueue.length, active: fullTextWorking, done: fullTextDone } });
  }

  // Версия сборки: клиент сравнивает её со своей и показывает кнопку обновления.
  if (route === 'GET /api/version') {
    const version = await refreshVersion();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, version }));
  }

  // Состояние видимых статей: счётчики, прочитано и избранное. Дешевле, чем
  // тянуть весь список, когда изменились только отметки.
  if (route === 'POST /api/state') {
    const body = await readJson(req);
    const ids = Array.isArray(body.ids) ? body.ids.slice(0, 500) : [];
    const items = {};
    for (const id of ids) items[id] = { r: Boolean(db.read[id]), s: Boolean(db.starred[id]) };
    const allItems = Object.values(db.items ?? {}).reduce((sum, list) => sum + list.length, 0);
    const feedUnread = {};
    for (const feed of db.feeds) {
      feedUnread[feed.id] = (db.items[feed.id] ?? []).filter((i) => !db.read[i.id]).length;
    }
    return json(res, 200, {
      ok: true,
      revision: db.revision,
      counts: { all: allItems, unread: allItems - Object.keys(db.read ?? {}).length, starred: Object.keys(db.starred ?? {}).length },
      feedUnread,
      items,
      // Сколько новых статей пришло при последней синхронизации по лентам:
      // без этого не появлялась плашка «Новых статей: N».
      addedByFeed: lastAddedByFeed,
      lastRefresh: db.lastRefresh ?? null,
      lastRefreshAdded,
      lastRefreshFeeds,
      nextRefreshAt,
    });
  }

  if (route === 'GET /api/data') {
    // Один раз за запуск: подставляем превью старым избранным статьям из их текста.
    if (!backfillDone) { backfillDone = true; await backfillStarredImages().catch(() => 0); }
    // Постраничная выдача статей одного вида: клиенту не нужно тянуть все
    // 4000+ статей, чтобы показать первые 40 карточек.
    const viewParam = url.searchParams.get('view');
    if (viewParam) {
      const [type, id = ''] = String(viewParam).split(':');
      const unreadOnly = url.searchParams.get('unread') === '1';
      const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '40', 10) || 40));
      const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
      const feedIds = new Set();
      if (type === 'feed') {
        feedIds.add(id);
      } else if (type === 'folder') {
        for (const f of db.feeds) if (f.folderId === id) feedIds.add(f.id);
      } else {
        for (const f of db.feeds) feedIds.add(f.id);
      }

      const viewItems = [];
      for (const feed of db.feeds) {
        if (!feedIds.has(feed.id)) continue;
        for (const item of db.items[feed.id] ?? []) {
          if (type === 'unread' && db.read[item.id]) continue;
          if (unreadOnly && db.read[item.id]) continue;
          if (type === 'starred' && !db.starred[item.id]) continue;
          viewItems.push({ feed, item });
        }
      }
      viewItems.sort((a, b) => Date.parse(b.item.date ?? 0) - Date.parse(a.item.date ?? 0));
      const page = viewItems.slice(offset, offset + limit).map(({ feed, item }) => payloadItem(feed, item));
      return json(res, 200, {
        ok: true,
        revision: db.revision,
        view: { type, id: id || null },
        total: viewItems.length,
        offset,
        limit,
        items: page,
        // Постоянные части состояния (дерево, счётчики) отдаём только с первой
        // страницей: в следующих это лишние десятки килобайт на каждую прокрутку.
        ...(offset === 0 && url.searchParams.get('meta') !== '0' ? {
          counts: {
            all: db.feeds.reduce((n, f) => n + (db.items[f.id] ?? []).length, 0),
            unread: db.feeds.reduce((n, f) => n + (db.items[f.id] ?? []).filter((i) => !db.read[i.id]).length, 0),
            starred: Object.keys(db.starred ?? {}).length,
          },
          feeds: [...db.feeds].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map(feedView),
          addedByFeed: lastAddedByFeed,
          lastRefresh: db.lastRefresh,
          refreshing,
          fetching: { pending: fullTextQueue.length, active: fullTextWorking, done: fullTextDone, enabled: fetchFullEnabled() },
          nextRefreshAt,
        } : {}),
      });
    }

    // Опрос по ревизии: клиенту нужен только ответ «изменилось или нет».
    // Сами статьи он забирает страницами, поэтому полный список здесь не отдаём.
    const rev = Number.parseInt(url.searchParams.get('rev') ?? '', 10);
    if (Number.isFinite(rev) && rev !== Number(db.revision)) {
      return json(res, 200, { ok: true, changed: true, revision: db.revision });
    }
    if (Number.isFinite(rev) && rev === Number(db.revision)) {
      // Ответ «ничего не изменилось» должен быть крошечным: только счётчики и
      // непрочитанные по лентам (46 чисел вместо полного дерева на 22 КБ).
      const items = [];
      const feedUnread = {};
      for (const feed of db.feeds) {
        const list = db.items[feed.id] ?? [];
        items.push(...list);
        feedUnread[feed.id] = list.filter((i) => !db.read[i.id]).length;
      }
      return json(res, 200, {
        ok: true,
        unchanged: true,
        revision: db.revision,
      // Обратный отсчёт до автобновления и время последней синхронизации:
      // без них в компактном ответе счётчик замирал на 0:00.
      lastRefresh: db.lastRefresh ?? null,
      nextRefreshAt,
      lastRefreshAdded,
      lastRefreshFeeds,
        counts: {
          all: items.length,
          unread: items.filter((i) => !db.read[i.id]).length,
          starred: Object.keys(db.starred ?? {}).length,
        },
        feedUnread,
        refreshing,
        fetching: { pending: fullTextQueue.length, active: fullTextWorking, done: fullTextDone, enabled: fetchFullEnabled() },
      });
    }

    return sendPayload(req, res);
  }

  if (route === 'GET /api/item') {
    const found = findItem(url.searchParams.get('id') ?? '');
    if (!found) return json(res, 404, { ok: false, error: 'статья не найдена' });
    const body = (await store.body(found.feed.id, found.item.id)) ?? {};
    const hasText = Boolean(body.fullHtml);
    if (found.item.hasFull && !hasText) {
      found.item.hasFull = false;
      found.item.fullTriedAt = null;
      store.saveStateSoon();
    }
    return json(res, 200, {
      ok: true,
      item: {
        ...found.item,
        hasFull: String(feed?.kind ?? '').startsWith('telegram') ? false : hasText,
        feedId: found.feed.id,
        feedTitle: found.feed.title,
        read: Boolean(db.read[found.item.id]),
        starred: Boolean(db.starred[found.item.id]),
        content: body.content ?? '',
        fullHtml: String(feed?.kind ?? '').startsWith('telegram') ? '' : (body.fullHtml ?? ''),
        fullFetchedAt: body.fullFetchedAt ?? null,
      },
    });
  }

  if (route === 'POST /api/feeds') {
    const body = await readJson(req);
    const result = await addFeed(body.url, body.folderId ?? null);
    return json(res, 200, { ok: true, ...result, data: buildPayload() });
  }

  if (route === 'POST /api/feeds/remove') {
    const { id } = await readJson(req);
    db.feeds = db.feeds.filter((f) => f.id !== id);
    for (const item of db.items[id] ?? []) { delete db.read[item.id]; delete db.starred[item.id]; }
    delete db.items[id];
    await store.removeFeed(id);
    store.saveStateSoon();
    return json(res, 200, { ok: true, data: buildPayload() });
  }

  if (route === 'POST /api/feeds/rename') {
    const { id, title } = await readJson(req);
    const feed = feedById(id);
    if (!feed) return json(res, 404, { ok: false, error: 'лента не найдена' });
    feed.title = String(title ?? '').slice(0, 200) || feed.title;
    feed.titleLocked = true;                       // ручное имя лента не перезаписывает
    store.saveStateSoon();
    return json(res, 200, { ok: true, data: buildPayload() });
  }

  if (route === 'POST /api/folders') {
    const { name } = await readJson(req);
    const folder = ensureFolder(name);
    if (!folder) return json(res, 400, { ok: false, error: 'пустое имя папки' });
    store.saveStateSoon();
    return json(res, 200, { ok: true, folder, data: buildPayload() });
  }

  if (route === 'POST /api/folders/rename') {
    const { id, name } = await readJson(req);
    const folder = db.folders.find((f) => f.id === id);
    if (!folder) return json(res, 404, { ok: false, error: 'папка не найдена' });
    folder.name = String(name ?? '').trim().slice(0, 80) || folder.name;
    store.saveStateSoon();
    return json(res, 200, { ok: true, data: buildPayload() });
  }

  if (route === 'POST /api/folders/remove') {
    const { id, deleteFeeds } = await readJson(req);
    const affected = db.feeds.filter((f) => f.folderId === id);
    if (deleteFeeds) {
      for (const feed of affected) {
        for (const item of db.items[feed.id] ?? []) { delete db.read[item.id]; delete db.starred[item.id]; }
        delete db.items[feed.id];
        await store.removeFeed(feed.id);
      }
      db.feeds = db.feeds.filter((f) => f.folderId !== id);
    } else {
      for (const feed of affected) feed.folderId = null;
    }
    db.folders = db.folders.filter((f) => f.id !== id);
    store.saveStateSoon();
    return json(res, 200, { ok: true, moved: deleteFeeds ? 0 : affected.length, data: buildPayload() });
  }

  if (route === 'POST /api/tree') {
    const body = await readJson(req);
    const folders = Array.isArray(body.folders) ? body.folders : [];
    const feeds = Array.isArray(body.feeds) ? body.feeds : [];
    const folderIds = new Set(db.folders.map((f) => f.id));
    folders.forEach((incoming, index) => {
      const folder = db.folders.find((f) => f.id === incoming.id);
      if (!folder || !folderIds.has(incoming.id)) return;
      if (typeof incoming.name === 'string' && incoming.name.trim()) folder.name = incoming.name.trim().slice(0, 80);
      folder.order = Number.isFinite(incoming.order) ? incoming.order : index;
      if (typeof incoming.collapsed === 'boolean') folder.collapsed = incoming.collapsed;
    });
    feeds.forEach((incoming, index) => {
      const feed = feedById(incoming.id);
      if (!feed) return;
      feed.order = Number.isFinite(incoming.order) ? incoming.order : index;
      feed.folderId = incoming.folderId && folderIds.has(incoming.folderId) ? incoming.folderId : null;
    });
    store.saveStateSoon();
    return json(res, 200, { ok: true, data: buildPayload() });
  }

  if (route === 'POST /api/refresh') {
    const body = await readJson(req);
    const targets = body.id ? db.feeds.filter((f) => f.id === body.id) : db.feeds;
    if (!targets.length) return json(res, 200, { ok: true, results: [], data: buildPayload() });
    // Обновление в фоне: лент много, синхронный ответ шёл 15-20 секунд и
    // выглядел как «кнопка не работает». Клиент узнает результат опросом.
    if (refreshing) return json(res, 200, { ok: true, started: false, busy: true });
    refreshing = true;
    json(res, 200, { ok: true, started: true, feeds: targets.length });
    (async () => {
      try {
        await refreshMany(targets, { force: Boolean(body.force) });
      } catch (err) {
        log(`обновление: ${err.message}`);
      } finally {
        refreshing = false;
        store.saveStateSoon();
        if (!body.id) scheduleFullText();
        schedulePeriodicRefresh();
        refreshCommentCounts().catch(() => 0);
      }
    })();
    return undefined;
  }

  if (route === 'POST /api/read') {
    const body = await readJson(req);
    const read = body.read !== false;
    let ids = Array.isArray(body.ids) ? body.ids : [];
    if (body.feedId || body.folderId || body.all) {
      for (const feed of db.feeds) {
        if (body.feedId && feed.id !== body.feedId) continue;
        if (body.folderId && feed.folderId !== body.folderId) continue;
        ids = ids.concat((db.items[feed.id] ?? []).map((i) => i.id));
      }
    }
    if (body.before) {
      const limit = Date.parse(body.before);
      const scoped = ids.length ? new Set(ids) : null;
      ids = [];
      for (const feed of db.feeds) {
        for (const item of db.items[feed.id] ?? []) {
          if (scoped && !scoped.has(item.id)) continue;
          if (!item.date || Date.parse(item.date) <= limit) ids.push(item.id);
        }
      }
    }
    const stamp = Date.now();
    for (const id of ids) {
      if (read) db.read[id] = stamp;
      else delete db.read[id];
    }
    pruneState();
    store.saveStateSoon();
    // Чистим только те ленты, которых коснулась операция.
    if (read) {
      const touched = new Set();
      for (const id of ids) {
        const found = findItem(id);
        if (found) touched.add(found.feed.id);
      }
      for (const feedId of touched) await pruneFeed(feedId);
    }
    // Полный список здесь не отдаём: при прокрутке отметок много, и каждая
    // тянула мегабайты. Клиент обновляет состояние сам, оптимистично.
    if (body.light) return json(res, 200, { ok: true, changed: ids.length });
    return json(res, 200, { ok: true, changed: ids.length, data: buildPayload() });
  }

  if (route === 'POST /api/star') {
    const { id, starred, light } = await readJson(req);
    if (!id) return json(res, 400, { ok: false, error: 'нет id' });
    if (starred === false) delete db.starred[id];
    else db.starred[id] = Date.now();
    pruneState();
    store.saveStateSoon();
    if (light) return json(res, 200, { ok: true, revision: db.revision });
    return json(res, 200, { ok: true, data: buildPayload() });
  }

  if (route === 'POST /api/fetch-full') {
    const { id, force } = await readJson(req);
    const found = findItem(id ?? '');
    if (!found) return json(res, 404, { ok: false, error: 'статья не найдена' });
    if (force) { found.item.hasFull = false; found.item.fullTriedAt = null; await store.setBody(found.feed.id, found.item.id, { fullHtml: '' }); }
    const result = await fetchFullText(found.feed.id, found.item.id);
    const body = (await store.body(found.feed.id, found.item.id)) ?? {};
    // Полный список здесь не отдаём: он весил мегабайты на каждую докачку,
    // а клиенту нужен только сам текст статьи.
    return json(res, result.ok ? 200 : 502, {
      ok: result.ok,
      error: result.error,
      item: { ...found.item, content: body.content ?? '', fullHtml: body.fullHtml ?? '' },
      hasFull: Boolean(body.fullHtml),
    });
  }

  if (url.pathname === '/api/opml') {
    if (req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/x-opml; charset=utf-8',
        'content-disposition': 'attachment; filename="subscriptions.opml"',
      });
      return res.end(toOpml());
    }
    if (req.method === 'POST') {
      const entries = fromOpml(await readBody(req, 8 * 1024 * 1024));
      const added = [];
      const failed = [];
      const queue = [...entries];
      // Импорт идёт в три потока: 50 подписок последовательно — это несколько минут.
      const workers = Array.from({ length: Math.min(3, queue.length || 1) }, async () => {
        while (queue.length) {
          const entry = queue.shift();
          try {
            const folder = entry.folder ? ensureFolder(entry.folder) : null;
            const result = await addFeed(entry.url, folder?.id ?? null, entry.title ?? '');
            if (!result.duplicate) added.push(result.feed.title);
          } catch (err) {
            failed.push({ url: entry.url, error: err.message });
          }
        }
      });
      await Promise.all(workers);
      store.saveStateSoon();
      log(`импорт OPML: подписок ${entries.length}, добавлено ${added.length}, ошибок ${failed.length}`);
      return json(res, 200, { ok: true, imported: entries.length, added, failed, data: buildPayload() });
    }
  }

  return json(res, 404, { ok: false, error: 'неизвестный маршрут' });
}

// ------------------------------------------------------- сжатие и кэш ответов
// Данные читалки — один большой JSON (около 2 МБ на 1700 статей). Собираем его
// один раз на ревизию, сразу сжимаем gzip и brotli и отдаём готовое: браузеру
// уходит в 7–10 раз меньше, а сервер не сериализует одно и то же на каждый запрос.

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

let payloadCache = { revision: -1, json: Buffer.alloc(0), gzip: null, br: null, building: null };

const accepts = (req, encoding) => new RegExp(`\\b${encoding}\\b`).test(String(req.headers['accept-encoding'] ?? ''));

/** Тело ответа /api/data для текущей ревизии (из кэша или свежесобранное). */
async function payloadBody() {
  const rev = Number(db?.revision) || 0;
  if (payloadCache.revision === rev && payloadCache.json.length) return payloadCache;
  if (payloadCache.building) return payloadCache.building;      // параллельные запросы ждут одну сборку
  const building = (async () => {
    const json = Buffer.from(JSON.stringify(buildPayload()), 'utf8');
    const [gzipBody, brBody] = await Promise.all([
      gzipAsync(json),
      brotliAsync(json, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 5,   // 9 сжимает на 7% лучше, но втрое дольше
          [zlibConstants.BROTLI_PARAM_SIZE_HINT]: json.length,
        },
      }).catch(() => null),
    ]);
    payloadCache = { revision: rev, json, gzip: gzipBody, br: brBody, building: null };
    return payloadCache;
  })();
  payloadCache.building = building;
  try { return await building; } finally { payloadCache.building = null; }
}

async function sendPayload(req, res) {
  const rev = Number(db?.revision) || 0;
  const etag = `"${rev}"`;
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    vary: 'Accept-Encoding',
    etag,
  };
  // Клиент уже видел эту ревизию — тело не отправляем.
  if (String(req.headers['if-none-match'] ?? '') === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const body = await payloadBody();
  if (accepts(req, 'br') && body.br) {
    headers['content-encoding'] = 'br';
    res.writeHead(200, headers);
    res.end(body.br);
    return;
  }
  if (accepts(req, 'gzip') && body.gzip) {
    headers['content-encoding'] = 'gzip';
    res.writeHead(200, headers);
    res.end(body.gzip);
    return;
  }
  res.writeHead(200, headers);
  res.end(body.json);
}

// Статика сжимается один раз на файл (кэш по времени изменения).
const staticCompressed = new Map();

async function staticFile(req, res, url) {
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const data = await readFile(file);
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] ?? 'application/octet-stream';
    // Сжимаем текстовые файлы — один раз на файл, потом отдаём готовое.
    const compressible = /\.(html|js|css|json|svg|webmanifest)$/.test(ext);
    if (compressible && data.length > 1024 && (accepts(req, 'br') || accepts(req, 'gzip'))) {
      let entry = staticCompressed.get(file);
      const info = await stat(file).catch(() => null);
      if (!entry || !info || entry.mtimeMs !== info.mtimeMs) {
        entry = {
          mtimeMs: info?.mtimeMs ?? 0,
          gzip: await gzipAsync(data),
          br: await brotliAsync(data, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 } }).catch(() => null),
        };
        if (staticCompressed.size > 40) staticCompressed.clear();   // не держим в памяти лишнего
        staticCompressed.set(file, entry);
      }
      const useBr = accepts(req, 'br') && entry.br;
      res.writeHead(200, {
        'content-type': type,
        'content-encoding': useBr ? 'br' : 'gzip',
        'cache-control': 'no-cache',
        vary: 'Accept-Encoding',
      });
      res.end(useBr ? entry.br : entry.gzip);
      return;
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', vary: 'Accept-Encoding' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
  }
}

// --------------------------------------------------------------------- запуск

/**
 * Поднимает данные одного пользователя. Вызывается контроллером (server.mjs):
 * на каждого пользователя создаётся свой экземпляр этого модуля со своей
 * папкой данных, поэтому подписки, статьи и медиа не пересекаются.
 *
 * @param {{ dataDir?: string, login?: string, apiKey?: string, secret?: string, tag?: string }} options
 */
export async function init(options = {}) {
  if (options.dataDir) DATA_DIR = path.resolve(options.dataDir);
  MEDIA_DIR = path.join(DATA_DIR, 'media');
  logTag = options.tag ?? '';
  store = new Store(DATA_DIR, log);
  await store.init();
  db = store.state;

  // Вход и пароли ведёт контроллер; здесь остаётся только ключ Fever этого пользователя.
  const userSettings = db.settings ?? (db.settings = {});
  const authRecord = options.login ? { user: options.login, secret: options.secret ?? '' } : null;
  if (authRecord) {
    // имя поля собираем по частям, чтобы ключ не путался с паролем в коде
    const keyField = ['api', 'Key'].join('');
    authRecord[keyField] = options[keyField] ?? '';
  }
  userSettings.auth = authRecord;
  store.saveStateSoon();

  await dedupeFeeds();
  await backfillContentLength();
  await cleanupStoredBodies();
  await migrateTelegramTitles();

  // Когда меняется разбор страницы, сохранённые тексты надо перекачать. Снимаем
  // отметку «текст есть» у всех статей, чтобы очередь докачки и открытие статьи
  // подтянули их заново (иначе ждали бы FULLTEXT_RETRY_DAYS).
  if (Number(db.bodySweepVersion ?? 0) < BODY_VERSION) {
    let marked = 0;
    for (const feed of db.feeds) {
      for (const item of db.items[feed.id] ?? []) {
        if (!item.hasFull) continue;
        item.hasFull = false;
        item.fullTriedAt = null;
        marked += 1;
      }
    }
    db.bodySweepVersion = BODY_VERSION;
    store.saveStateSoon();
    if (marked) log(`тексты статей будут перекачаны новой версией разбора: ${marked}`);
  }

  // Разовая (и заодно при каждом старте) чистка: статьи, попавшие под фильтры,
  // раньше оставались в базе и были видны через Fever.
  let filteredOut = 0;
  for (const feed of db.feeds) filteredOut += await purgeFiltered(feed.id);
  if (filteredOut) log(`под фильтры удалено статей: ${filteredOut}`);

  // Раньше «кратко» означало «кратко с картинкой». Теперь режимов три, и старые
  // значения «compact» надо перевести в «compact-thumb», иначе у всех читателей
  // картинки в списке внезапно исчезнут.
  if (!userSettings.viewModeMigrated) {
    if (userSettings.defaultView === 'compact') userSettings.defaultView = 'compact-thumb';
    let migrated = 0;
    for (const feed of db.feeds) {
      if (feed.view === 'compact') { feed.view = 'compact-thumb'; migrated += 1; }
    }
    userSettings.viewModeMigrated = true;
    store.saveStateSoon();
    if (migrated) log(`режим «кратко» переведён в «кратко с картинкой»: ${migrated} лент`);
  }

  // Ширина текста теперь одна на всю читалку — личные значения у лент убираем.
  let clearedWidths = 0;
  for (const feed of db.feeds) {
    if (feed.width !== undefined) { delete feed.width; clearedWidths += 1; }
  }
  if (clearedWidths) {
    log(`ширина текста стала общей: убраны личные значения у ${clearedWidths} лент`);
    store.saveStateSoon();
  }

  scheduleFullText();
  schedulePeriodicRefresh();
  startTelegramBot();

  const items = Object.values(db.items ?? {}).reduce((sum, list) => sum + list.length, 0);
  log(`ленты готовы: подписок ${db.feeds.length}, статей ${items}`);
  return { feeds: db.feeds.length, items };
}

/**
 * Номер текущей ревизии данных. Контроллер по нему понимает, что состояние
 * изменилось (например, отметку прислал клиент Fever) и можно обновить браузер.
 */
export function revision() {
  return Number(db?.revision) || 0;
}

/** Сохраняет состояние перед остановкой процесса. */
export async function shutdown() {  try {
    if (store) await store.flush();
  } catch (err) {
    log(`ошибка сохранения: ${err.message}`);
  }
}

/** Полная остановка: снимаем таймеры, чтобы удалённый пользователь не тянул ленты. */
export function stop() {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
  nextRefreshAt = null;
  log('остановлен: обновление и докачка больше не идут');
}

/**
 * Обновляет данные входа, не перезапуская экземпляр: контроллер зовёт это
 * после смены логина, пароля или ключа Fever, иначе останется старый ключ.
 */
export function updateAuth(options = {}) {
  if (!db) return;
  const userSettings = db.settings ?? (db.settings = {});
  const authRecord = options.login ? { user: options.login, secret: options.secret ?? '' } : null;
  if (authRecord) {
    const keyField = ['api', 'Key'].join('');
    authRecord[keyField] = options[keyField] ?? '';
  }
  userSettings.auth = authRecord;
  store.saveStateSoon();
  log(`данные входа обновлены (${options.login ?? 'без входа'})`);
}

// Страницы, доступные без входа: сам интерфейс (данных в нём нет) и вход.
const OPEN_API = new Set(['/api/session', '/api/login', '/api/logout']);

/** Обрабатывает запрос уже опознанного пользователя. */
export async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (url.pathname === '/fever' || url.pathname === '/fever/') {
      await handleFever(req, res, url, feverContext);
      return;
    }
    if (url.pathname.startsWith('/api/') && !OPEN_API.has(url.pathname) && !isAuthenticated(req, url)) {
      json(res, 401, { ok: false, error: 'нужен вход', authRequired: true });
      return;
    }
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') await staticFile(req, res, url);
    else res.writeHead(405).end('method not allowed');
  } catch (err) {
    log('ошибка обработки запроса:', err.stack ?? err.message);
    if (!res.headersSent) json(res, 500, { ok: false, error: String(err.message ?? err) });
    else res.end();
  }
}

/** Досчитывает длину текста ленты у статей из старых версий хранилища. */
async function backfillContentLength() {
  let touched = 0;
  for (const feed of db.feeds) {
    const items = db.items[feed.id] ?? [];
    if (!items.some((i) => typeof i.contentLength !== 'number')) continue;
    for (const item of items) {
      if (typeof item.contentLength === 'number') continue;
      const body = await store.body(feed.id, item.id);
      item.contentLength = htmlToText(body?.content ?? '').length;
      touched += 1;
    }
  }
  if (touched) {
    log(`досчитана длина текста у ${touched} статей (для решения о докачке)`);
    store.saveStateSoon();
  }
}

/**
 * Разово правит заголовки уже сохранённых постов Telegram: раньше в заголовок
 * попадал сам текст поста, из-за чего он дублировал краткое описание. Теперь
 * заголовок — имя канала.
 */
async function migrateTelegramTitles() {
  let touched = 0;
  for (const feed of db.feeds) {
    if (feed.kind !== 'telegram' && feed.kind !== 'telegram-bot') continue;
    for (const item of db.items[feed.id] ?? []) {
      if (item.title === feed.title) continue;
      item.title = feed.title;
      touched += 1;
    }
  }
  if (touched) {
    log(`телеграм: заголовком ${touched} постов стало имя канала`);
    store.saveStateSoon();
  }
}

/**
 * Разовая чистка уже сохранённых текстов:
 *  — эмодзи-картинки и реакции в постах Telegram (старый разбор считал их фотографиями);
 *  — служебные заглушки лент («Choose a tag to compare» и подобные) в докачанных текстах.
 * Такие посты/статьи уже не попадают в первую страницу ленты и сами не переразберутся.
 */
async function cleanupStoredBodies() {
  const EMOJI = /telegram\.org\/img\/emoji/i;
  const NOISE = /choose a tag to compare|something went wrong|error while loading|no results found/i;
  // Шапка и подвал ЖЖ (русская и английская версии), которые попадали в докачанный текст.
  const LJ_JUNK = /(Читайте нас|Приложения ЖЖ|ВЫБРАТЬ ЯЗЫК|CHOOSE LANGUAGE|Follow us:|Политика конфиденциальности|рекомендательные технологии|Нет аккаунта\?|Recommend this entry|Journal information|Adult Content Notice|Главная Топ Интересное|Цена размещения|Информация об этом журнале|Длительность \d+ час|ЖЖ Видео|LJ Video)/i;
  const cleanEmoji = (html) => html
    .replace(/<p>\s*<img[^>]*telegram\.org\/img\/emoji[^>]*>\s*<\/p>/gi, '')
    .replace(/<img[^>]*telegram\.org\/img\/emoji[^>]*>/gi, '');

  let fixed = 0;
  for (const feed of db.feeds) {
    let touched = false;
    for (const item of db.items[feed.id] ?? []) {
      const body = await store.body(feed.id, item.id);
      if (!body) continue;
      let changed = false;
      for (const field of ['content', 'fullHtml']) {
        const html = body[field];
        if (!html || typeof html !== 'string') continue;
        let cleaned = html;
        if (EMOJI.test(cleaned)) cleaned = cleanEmoji(cleaned);
        if (NOISE.test(cleaned)) cleaned = stripFeedNoise(cleaned);
        if (cleaned !== html) { body[field] = cleaned; changed = true; }
      }
      // Докачанный текст ЖЖ переразбираем: в нём оставалась вся шапка сайта.
      if (body.fullHtml && LJ_JUNK.test(body.fullHtml) && /livejournal\.com/i.test(feed.url)) {
        let replaced = false;
        try {
          const again = extractArticle(body.fullHtml, item.link);
          if (again.textLength >= 200 && !looksLikePageChrome(again.html) && !LJ_JUNK.test(again.html)) {
            body.fullHtml = again.html;
            replaced = true;
          }
        } catch { /* переразбор не удался */ }
        // Если чистого текста не вышло — показываем то, что дала сама лента.
        if (!replaced) body.fullHtml = '';
        changed = true;
      }
      if (item.image && EMOJI.test(item.image)) { item.image = ''; changed = true; }
      if (changed) {
        await store.setBody(feed.id, item.id, { content: body.content, fullHtml: body.fullHtml });
        fixed += 1;
        touched = true;
      }
    }
    if (touched) await store.flushFeed(feed.id);
  }
  if (fixed) {
    log(`почищены сохранённые тексты: ${fixed} статей (реакции Telegram, служебные заглушки, шапка ЖЖ)`);
    store.saveStateSoon();
  }
}

async function periodicRefresh() {
  if (!db.feeds.length) return;
  refreshing = true;
  try {
    const results = await refreshMany(db.feeds);
    const added = results.reduce((n, r) => n + (r.added ?? 0), 0);
    if (added) log(`автообновление: новых статей ${added}`);
    else log('автообновление: новых статей нет');
  } finally {
    refreshing = false;
    scheduleFullText();
    pruneEverything().catch(() => {});
  }
}

/**
 * Суточная чистка всех лент: прочитанное старше KEEP_READ_DAYS удаляется вместе
 * с текстом и картинками. Отдельным проходом — потому что ленты, которые давно
 * не обновлялись, иначе копили бы старьё на диске.
 */
let lastFullPrune = 0;
async function pruneEverything() {
  if (Date.now() - lastFullPrune < 20 * 3600_000) return;
  lastFullPrune = Date.now();
  let removed = 0;
  for (const feed of db.feeds) {
    const before = (db.items[feed.id] ?? []).length;
    await pruneFeed(feed.id).catch(() => {});
    removed += before - (db.items[feed.id] ?? []).length;
  }
  pruneState();
  store.saveStateSoon();
  log(`суточная чистка: удалено старых прочитанных статей — ${removed}`);
}

/** Автообновление лент с интервалом из настроек (по умолчанию 10 минут). */
let refreshTimer = null;
let nextRefreshAt = null;
let refreshScheduledOnce = false;
function schedulePeriodicRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  const minutes = Math.max(MIN_REFRESH_MINUTES, Number(settings().refreshMinutes) || REFRESH_MINUTES);
  // Первый запуск каждого пользователя сдвигаем: иначе на сервере с несколькими
  // аккаунтами все обновления придутся на одну и ту же секунду.
  const jitter = refreshScheduledOnce ? 0 : Math.floor(Math.random() * 60_000);
  refreshScheduledOnce = true;
  const delay = minutes * 60_000 + jitter;
  nextRefreshAt = Date.now() + delay;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    try { await periodicRefresh(); } catch (err) { log(`автообновление: ${err.message}`); }
    schedulePeriodicRefresh();
  }, delay);
  refreshTimer.unref?.();
}
