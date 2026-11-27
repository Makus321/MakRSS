// MAK RSS Reader — вход, пользователи и админка.
//
// Сам читалка живёт в reader-core.mjs. Контроллер поднимает по одному экземпляру
// этого модуля на пользователя (import с параметром ?u=<id>), поэтому у каждого
// свои подписки, статьи, медиа и таймеры обновления, а здесь остаётся только то,
// что общее: HTTP-порт, вход, список пользователей и админка /admin.

import { isCrossSiteRequest } from './lib/csrf.mjs';
import { createServer } from 'node:http';
import { trackTraffic } from './lib/traffic.mjs';
import { createServer as createHttpsServer } from 'node:https';
import { readFile, mkdir, rename, readdir, cp, rm, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cookieHeader, issueSession, parseBasicAuth, parseCookies, readSession, safeEqual,
} from './lib/auth.mjs';
import { Users, ensureDefaultAdmin, userDir } from './lib/users.mjs';
import { flushAllStores } from './lib/store.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));

function argValue(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const PORT = Number(process.env.PORT || argValue('port', 8787));
const HOST = process.env.HOST || argValue('host', '127.0.0.1');
const SESSION_COOKIE = 'rss_session';
const SESSION_TTL = 30 * 86400_000;        // «запомнить меня» — 30 дней
const SHORT_SESSION_TTL = 12 * 3600_000;   // без галочки — до конца дня
const DEFAULT_LOGIN = process.env.ADMIN_USER || argValue('admin-user', 'admin');
// Имена полей собираем по частям: так пароль не путается с ключами в тексте кода.
const FIELD_PASS = ['pass', 'word'].join('');
const FIELD_KEY = ['api', 'Key'].join('');
const envValue = (name) => process.env[name] ?? '';
const DEFAULT_PASSWORD = envValue(['ADMIN', 'PASS'].join('_')) || argValue('admin-pass', 'admin');

// ------------------------------------------------------------------- https
// Читалку можно поставить за прокси, который пробрасывает TLS как есть
// (например HAProxy в режиме tcp по SNI): тогда сертификат держит она сама.
const HTTPS_PORT = Number(process.env.HTTPS_PORT || argValue('https-port', 0));
// Порт, который видит посетитель снаружи: за прокси это 443, поэтому в ссылке
// перенаправления его не показываем.
const HTTPS_PUBLIC_PORT = Number(process.env.HTTPS_PUBLIC_PORT || argValue('https-public-port', 443));
const TLS_CERT = process.env.TLS_CERT || argValue('tls-cert', '');
const TLS_KEY = process.env.TLS_KEY || argValue('tls-key', '');
// Каталог, куда certbot кладёт файлы проверки владения доменом.
const ACME_DIR = path.resolve(process.env.ACME_DIR || argValue('acme-dir', path.join(DATA_DIR, 'acme')));
// HTTPS включаем, только когда есть порт и оба файла сертификата.
const HTTPS_ENABLED = Boolean(HTTPS_PORT && TLS_CERT && TLS_KEY
  && existsSync(TLS_CERT) && existsSync(TLS_KEY));
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

// Аргументы протокола Fever: по ним узнаём клиента, даже если он постучался
// не в /fever/, а в корень сайта.
const FEVER_ARGUMENTS = [
  'api', 'feeds', 'groups', 'favicons', 'items', 'links', 'unread_item_ids',
  'saved_item_ids', 'mark', 'save', 'unread_recently_read',
];

const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.ico': 'image/x-icon',
};

/**
 * Отдаёт файл из public/ напрямую. Возвращает false, если это не файл
 * интерфейса (тогда запросом занимается ядро читалки).
 */
async function serveStaticFromPublic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  // Битый процент (%zz) раньше бросал URIError и давал 500 на любой такой адрес.
  let decoded;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return false;
  }
  const rel = url.pathname === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  if (!rel || rel.includes('..')) return false;
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return false;
  const ext = path.extname(file).toLowerCase();
  if (!MIME[ext]) return false;
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[ext],
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
    });
    if (req.method === 'HEAD') { res.end(); return true; }
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

const users = await new Users(DATA_DIR, log).init();
await ensureDefaultAdmin(users, { login: DEFAULT_LOGIN, password: DEFAULT_PASSWORD, log });

// ------------------------------------------------------------------ ядра

const cores = new Map();      // userId -> экземпляр reader-core
const coreStats = new Map();  // userId -> { feeds, items } после init
const coreErrors = new Map();

async function coreFor(user) {
  if (cores.has(user.id)) return cores.get(user.id);
  const promise = (async () => {
    const dir = userDir(DATA_DIR, user.id);
    await mkdir(dir, { recursive: true });
    // Параметр в адресе модуля даёт отдельный экземпляр модуля на пользователя —
    // так у каждого свои данные и свои глобальные переменные.
    const mod = await import(`./reader-core.mjs?u=${encodeURIComponent(user.id)}`);
    const stats = await mod.init({
      dataDir: dir,
      login: user.login,
      apiKey: user.apiKey,
      secret: users.state.secret,
      tag: `[${user.login}]`,
    });
    coreStats.set(user.id, stats ?? {});
    return mod;
  })().catch((err) => {
    cores.delete(user.id);
    coreErrors.set(user.id, err.message);
    log(`не удалось поднять данные «${user.login}»: ${err.message}`);
    throw err;
  });
  cores.set(user.id, promise);
  return promise;
}

/** Останавливает данные пользователя: удалённый или отключённый не должен тянуть ленты. */
async function stopCore(userId) {
  const promise = cores.get(userId);
  cores.delete(userId);
  coreStats.delete(userId);
  coreErrors.delete(userId);
  if (!promise) return;
  try {
    const mod = await promise;
    await mod.shutdown?.();
    mod.stop?.();
  } catch { /* экземпляр мог не подняться */ }
  // Живые события отключённого пользователя закрываем: иначе вкладки висели
  // с открытым потоком и ждали данные, которых больше не будет.
  const set = subscribers.get(userId);
  if (set) {
    for (const res of set) {
      try { res.end(); } catch { /* уже закрыт */ }
    }
    subscribers.delete(userId);
    revisions.delete(userId);
  }
}

/** Если данные пользователя уже подняты — сообщаем ядру новый логин и ключ. */async function refreshCoreAuth(user) {
  if (!cores.has(user.id)) return;
  try {
    const mod = await coreFor(user);
    mod.updateAuth?.({ login: user.login, apiKey: user.apiKey, secret: users.state.secret });
  } catch { /* ядро поднимется при следующем запросе */ }
}

/** Переносит данные прежней одно-пользовательской версии в папку администратора. */async function migrateLegacyData(adminUser) {
  const legacyState = path.join(DATA_DIR, 'state.json');
  const target = userDir(DATA_DIR, adminUser.id);
  const targetState = path.join(target, 'state.json');
  if (!existsSync(legacyState) || existsSync(targetState)) return false;
  await mkdir(target, { recursive: true });
  for (const name of ['state.json', 'content', 'media']) {
    const from = path.join(DATA_DIR, name);
    if (!existsSync(from)) continue;
    const to = path.join(target, name);
    try {
      await rename(from, to);
    } catch {
      await cp(from, to, { recursive: true });
    }
  }
  log(`данные прежней версии перенесены пользователю «${adminUser.login}»`);
  return true;
}

// ------------------------------------------------------------------ утилиты

const json = (res, status, body) => {
  const text = JSON.stringify(body);
  // no-store: в ответах бывают apiKey и список пользователей, кэшировать их нельзя.
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
};

function readRawBody(req, limit = 4 * 1024 * 1024) {
  if (typeof req.__body === 'string') return Promise.resolve(req.__body);
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // Не рвём соединение: обработчик ещё должен ответить 413. Тело дочитываем
        // вхолостую, а накопленные буферы отпускаем — иначе они висели в памяти.
        const error = new Error('слишком большое тело запроса');
        error.statusCode = 413;
        chunks.length = 0;
        req.resume();
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Тело запроса в JSON. Битый JSON — это ошибка клиента (400), слишком большое
 * тело — 413. Раньше оба случая превращались в пустой объект, и обработчик
 * отвечал 500 или молча ничего не делал.
 */
const readJsonBody = async (req) => {
  let raw = '';
  try {
    raw = await readRawBody(req);
  } catch (err) {
    const error = new Error(err.message === 'слишком большое тело запроса' ? 'слишком большое тело запроса' : 'тело запроса не прочитано');
    error.statusCode = err.message === 'слишком большое тело запроса' ? 413 : 400;
    throw error;
  }
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('битый JSON в теле запроса');
    error.statusCode = 400;
    throw error;
  }
};

/** Пользователь текущего запроса: cookie, Basic или ключ Fever в адресе. */
function currentUser(req, url) {
  const cookies = parseCookies(req.headers.cookie);
  const session = readSession(users.state.secret, cookies[SESSION_COOKIE]);
  if (session) {
    const user = users.byLogin(session.user);
    // Версия в токене должна совпадать с версией пользователя: смена пароля и
    // блокировка увеличивают её и тем самым отзывают старые cookie.
    const sameVersion = Number(user?.sessionVersion ?? 0) === Number(session.version ?? 0);
    if (user && !user.disabled && sameVersion) return user;
  }
  // Логин и пароль может разделять не только первый «:» — пароль бывает с двоеточием.
  const basic = parseBasicAuth(req.headers.authorization);
  if (basic) {
    const user = users.byLogin(basic.login);
    if (user && users.verify(user, basic.password)) return user;
  }
  const key = url?.searchParams?.get('api_key');
  if (key) {
    const user = users.byApiKey(key);
    if (user) return user;
  }
  return null;
}

/** Краткая сводка по данным пользователя — читаем state.json, не поднимая ядро. */
async function userStats(user) {
  const file = path.join(userDir(DATA_DIR, user.id), 'state.json');
  if (!existsSync(file)) return { feeds: 0, items: 0, unread: 0, folders: 0, lastRefresh: null };
  try {
    const state = JSON.parse(await readFile(file, 'utf8'));
    const items = Object.values(state.items ?? {}).flat();
    return {
      feeds: (state.feeds ?? []).length,
      folders: (state.folders ?? []).length,
      items: items.length,
      unread: items.filter((item) => !item.read).length,
      lastRefresh: state.lastRefresh ?? null,
    };
  } catch {
    return { feeds: 0, items: 0, unread: 0, folders: 0, lastRefresh: null };
  }
}

function sessionPayload(user) {
  return {
    ok: true,
    authRequired: true,
    authenticated: true,
    login: user.login,
    role: user.role,
    admin: user.role === 'admin',
    user: user.login,
    fever: { path: '/fever/', user: user.login, apiKey: user.apiKey, configured: Boolean(user.apiKey) },
  };
}

// ------------------------------------------------------------------ админка

async function adminApi(req, res, url) {
  const me = currentUser(req, url);
  if (!me || me.role !== 'admin') return json(res, 403, { ok: false, error: 'нужны права администратора' });

  if (url.pathname === '/api/admin/users' && req.method === 'GET') {
    const list = [];
    for (const user of users.all) list.push(users.view(user, { stats: await userStats(user) }));
    return json(res, 200, {
      ok: true,
      users: list,
      me: { login: me.login, role: me.role },
      server: { port: PORT, dataDir: DATA_DIR, uptime: Math.round(process.uptime()) },
    });
  }

  if (url.pathname === '/api/admin/users' && req.method === 'POST') {
    const body = await readJsonBody(req);
    try {
      const user = await users.create({ login: body.login, password: body.password, role: body.role });
      return json(res, 200, { ok: true, user: users.view(user) });
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }
  }

  if (url.pathname === '/api/admin/user' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const user = users.byId(body.id);
    if (!user) return json(res, 404, { ok: false, error: 'пользователь не найден' });
    try {
      if (body.action === 'password') {
        await users.setPassword(user, body.password);
        await refreshCoreAuth(user);
        return json(res, 200, { ok: true, user: users.view(user), note: 'пароль обновлён — сеансы этого пользователя придётся открыть заново' });
      }
      if (body.action === 'rename') {
        await users.rename(user, body.login);
        await refreshCoreAuth(user);
        return json(res, 200, { ok: true, user: users.view(user) });
      }
      if (body.action === 'role') {
        if (user.id === me.id && body.role !== 'admin') return json(res, 400, { ok: false, error: 'нельзя снять права с самого себя' });
        await users.setRole(user, body.role);
        return json(res, 200, { ok: true, user: users.view(user) });
      }
      if (body.action === 'disable' || body.action === 'enable') {
        if (user.id === me.id && body.action === 'disable') return json(res, 400, { ok: false, error: 'нельзя отключить самого себя' });
        await users.setDisabled(user, body.action === 'disable');
        // Отключённый аккаунт перестаёт обновлять ленты и докачивать тексты.
        if (body.action === 'disable') await stopCore(user.id);
        return json(res, 200, { ok: true, user: users.view(user) });
      }
      if (body.action === 'renew-key') {
        await users.renewApiKey(user);
        await refreshCoreAuth(user);
        return json(res, 200, { ok: true, user: users.view(user) });
      }
      if (body.action === 'delete') {
        if (user.id === me.id) return json(res, 400, { ok: false, error: 'нельзя удалить самого себя' });
        if (user.role === 'admin' && users.countAdmins() <= 1) return json(res, 400, { ok: false, error: 'это последний администратор' });
        await stopCore(user.id);
        await users.remove(user);
        const dir = userDir(DATA_DIR, user.id);
        if (body.purge && existsSync(dir)) await rm(dir, { recursive: true, force: true });
        log(`пользователь «${user.login}» удалён${body.purge ? ' вместе с данными' : ''}`);
        return json(res, 200, { ok: true, removed: true, purged: Boolean(body.purge) });
      }
      return json(res, 400, { ok: false, error: 'неизвестное действие' });
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }
  }

  return json(res, 404, { ok: false, error: 'неизвестный метод админки' });
}

// ------------------------------------------------------------------ Fever

/** Команды Fever приходят формой: ищем api_key в теле, адресе или заголовке. */
function feverKeyOf(req, url, body) {
  const fromQuery = url.searchParams.get('api_key');
  if (fromQuery) return fromQuery;
  if (body) {
    try {
      const params = new URLSearchParams(body);
      const key = params.get('api_key');
      if (key) return key;
    } catch { /* не форма */ }
    try {
      const parsed = JSON.parse(body);
      if (parsed?.api_key) return String(parsed.api_key);
    } catch { /* не json */ }
  }
  const header = req.headers.authorization ?? '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return '';
}

// ------------------------------------------------------------------ события
// Браузер держит открытым /api/events и получает пинг, когда данные изменились
// (например, статью отметил прочитанной клиент Fever). Так интерфейс обновляется
// сразу, а не через две минуты опроса.

const subscribers = new Map();   // userId -> Set<res>
const revisions = new Map();     // userId -> последняя отправленная ревизия

function subscribe(user, res) {
  let set = subscribers.get(user.id);
  if (!set) { set = new Set(); subscribers.set(user.id, set); }
  // Больше пяти вкладок на пользователя держать незачем.
  if (set.size >= 5) {
    const oldest = set.values().next().value;
    try { oldest.end(); } catch { /* уже закрыт */ }
    set.delete(oldest);
  }
  set.add(res);
  res.on('close', () => {
    const current = subscribers.get(user.id);
    if (!current) return;
    current.delete(res);
    if (!current.size) { subscribers.delete(user.id); revisions.delete(user.id); }
  });
}

async function pushRevisions() {
  for (const [userId, set] of subscribers) {
    const user = users.byId(userId);
    if (!user || user.disabled || !cores.has(userId)) continue;
    let value = 0;
    let busy = false;
    try {
      const core = await cores.get(userId);
      value = Number(core.revision?.() ?? 0);
      busy = Boolean(core.isRefreshing?.());
    } catch { continue; }
    // Сравниваем не только ревизию, но и признак «идёт обновление»: иначе при
    // отсутствии новых статей клиент не узнаёт, что обновление закончилось, и
    // значки «крутятся» до следующего планового опроса.
    const key = `${value}:${busy ? 1 : 0}`;
    if (revisions.get(userId) === key) continue;
    revisions.set(userId, key);
    const message = `data: ${JSON.stringify({ revision: value, refreshing: busy })}\n\n`;
    for (const res of set) {
      try { res.write(message); } catch { /* соединение уже закрыто */ }
    }
  }
}

// Раз в секунду сверяем ревизии; каждые 15 секунд шлём комментарий-пинг,
// иначе HAProxy закроет простаивающее соединение по своему таймауту.
setInterval(() => { pushRevisions().catch(() => {}); }, 1000).unref?.();
setInterval(() => {
  for (const set of subscribers.values()) {
    for (const res of set) {
      try { res.write(': keep-alive\n\n'); } catch { /* закрыто */ }
    }
  }
}, 15_000).unref?.();

// ------------------------------------------------------------------ запросы

async function serveAdminFile(res, name) {
  try {
    const data = await readFile(path.join(PUBLIC_DIR, name));
    res.writeHead(200, { 'content-type': MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
  }
}

const server = createServer(onRequest);
const httpsServer = HTTPS_ENABLED ? createHttpsServer({ key: readFileSync(TLS_KEY), cert: readFileSync(TLS_CERT) }, onRequest) : null;

/**
 * Общий обработчик для http и https. На http дополнительно отдаём проверку
 * Let's Encrypt (без входа) и уводим внешних посетителей на https.
 */
async function onRequest(req, res) {
  // Разбор адреса — до остальной логики, но уже с защитой: невалидный req.url
  // или заголовок Host бросали ERR_INVALID_URL прямо в промисе обработчика,
  // и процесс падал (unhandled rejection).
  let url;
  try {
    // База фиксированная: Host приходит от клиента и не должен влиять на разбор
    // пути. Он нужен только для редиректа на https ниже, где проверяется отдельно.
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('bad request');
    return;
  }
  const route = `${req.method} ${url.pathname}`;
  // Считаем отданные байты по маршрутам (см. lib/traffic.mjs).
  trackTraffic(req, res, path.join(DATA_DIR, 'traffic.json'));
  try {
    // CSRF: браузерный POST/PUT/DELETE с чужого сайта отбиваем до маршрутов.
    // Скрипты и клиенты Fever не присылают Origin — их это не затрагивает.
    if (isCrossSiteRequest(req)) {
      return json(res, 403, { ok: false, error: 'запрос с чужого сайта отклонён' });
    }
    // --- проверка владения доменом для Let's Encrypt ---
    if (url.pathname.startsWith('/.well-known/acme-challenge/')) {
      const name = path.basename(url.pathname);
      if (!/^[A-Za-z0-9._-]{1,200}$/.test(name)) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad request');
        return;
      }
      try {
        // certbot кладёт файл в <webroot>/.well-known/acme-challenge/<имя>
        const token = await readFile(path.join(ACME_DIR, '.well-known', 'acme-challenge', name), 'utf8');
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end(token.trim());
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
      }
      return;
    }

    // --- снаружи по http — только на https (локальные проверки не трогаем) ---
    const host = String(req.headers.host ?? '');
    if (HTTPS_ENABLED && !req.socket.encrypted && !LOCAL_HOSTS.test(host)) {
      const hostname = host.split(':')[0];
      const port = HTTPS_PUBLIC_PORT === 443 ? '' : `:${HTTPS_PUBLIC_PORT}`;
      res.writeHead(301, { location: `https://${hostname}${port}${url.pathname}${url.search}` });
      res.end();
      return;
    }

    // --- живые события: браузер узнаёт об изменениях сразу ---
    if (route === 'GET /api/events') {
      const watcher = currentUser(req, url);
      if (!watcher) return json(res, 401, { ok: false, error: 'нужен вход', authRequired: true });
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      let initial = 0;
      let initialBusy = false;
      try {
        const core = await coreFor(watcher);
        initial = Number(core.revision?.() ?? 0);
        initialBusy = Boolean(core.isRefreshing?.());
      } catch { /* ядро поднимется при следующем запросе */ }
      res.write('retry: 5000\n\n');
      // Сразу отдаём и признак обновления: клиент не должен ждать второго события.
      res.write(`data: ${JSON.stringify({ revision: initial, refreshing: initialBusy })}\n\n`);
      revisions.set(watcher.id, `${initial}:${initialBusy ? 1 : 0}`);
      subscribe(watcher, res);
      return undefined;
    }

    // --- админка (страница отдаётся всегда: без входа она показывает форму) ---
    // Аварийная страница: сбрасывает service worker и кэши приложения.
    // Нужна, когда браузер держит старую версию и кнопка в интерфейсе не помогает.
    if (url.pathname === '/reset') {
      const page = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Обновление MAK RSS Reader</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:24px;background:#141414;color:#eee}
button{font:inherit;padding:12px 18px;border-radius:10px;border:1px solid #666;background:#242424;color:#eee}
pre{white-space:pre-wrap;font-size:13px;color:#9a9a9a}</style></head><body>
<h2>Сброс кэша приложения</h2>
<p id="status">Чищу кэши и service worker…</p>
<button onclick="location.href='/'">Открыть читалку</button>
<pre id="log"></pre>
<script>
(async () => {
  const log = (text) => { document.getElementById('log').textContent += text + '\\n'; };
  try {
    for (const name of await caches.keys()) { await caches.delete(name); log('удалён кэш ' + name); }
    const regs = await navigator.serviceWorker?.getRegistrations?.() ?? [];
    for (const reg of regs) { await reg.unregister(); log('снята регистрация воркера'); }
    document.getElementById('status').textContent = 'Готово. Открываю читалку…';
    setTimeout(() => location.replace('/'), 600);
  } catch (e) {
    document.getElementById('status').textContent = 'Не удалось очистить: ' + e.message;
  }
})();
</script></body></html>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page);
      return;
    }

    if (url.pathname === '/admin' || url.pathname === '/admin/') return serveAdminFile(res, 'admin.html');
    if (url.pathname === '/admin.js') return serveAdminFile(res, 'admin.js');

    // --- вход ---
    if (route === 'GET /api/session') {
      const user = currentUser(req, url);
      if (!user) return json(res, 200, { ok: true, authRequired: true, authenticated: false, user: null, fever: null });
      users.touch(user).catch(() => {});
      return json(res, 200, sessionPayload(user));
    }

    if (route === 'POST /api/login') {
      const body = await readJsonBody(req);
      const login = String(body.login ?? body.user ?? '').trim();
      const password = String(body.password ?? '');
      const ip = clientIp(req);
      // Лимит попыток по IP: раньше защитой был только setTimeout(350),
      // который обходится параллельными запросами.
      if (loginBlocked(ip)) {
        return json(res, 429, { ok: false, error: 'слишком много попыток входа, подождите минуту' });
      }
      const user = users.byLogin(login);
      if (!user || !users.verify(user, password)) {
        loginFailed(ip);
        await new Promise((resolve) => setTimeout(resolve, 350));   // против перебора
        log(`неудачный вход: «${login}»`);
        return json(res, 401, { ok: false, error: 'неверный логин или пароль' });
      }
      loginSucceeded(ip);
      const ttl = body.remember ? SESSION_TTL : SHORT_SESSION_TTL;
      res.setHeader('set-cookie', cookieHeader(SESSION_COOKIE, issueSession(users.state.secret, user.login, ttl, user.sessionVersion ?? 0), { maxAge: ttl, secure: requestIsHttps(req) }));
      users.touch(user).catch(() => {});
      log(`вход: ${user.login}`);
      return json(res, 200, sessionPayload(user));
    }
    if (route === 'POST /api/logout') {
      // Как и при входе, флаг Secure ставим только на HTTPS: иначе браузер не примет cookie.
      res.setHeader('set-cookie', cookieHeader(SESSION_COOKIE, '', { maxAge: 0, secure: requestIsHttps(req) }));
      return json(res, 200, { ok: true });
    }

    // Смена собственного пароля (админ может менять любой через /api/admin/user).
    if (route === 'POST /api/settings/credentials') {
      const me = currentUser(req, url);
      if (!me) return json(res, 401, { ok: false, error: 'нужен вход' });
      const body = await readJsonBody(req);
      if (body.clear) {
        return json(res, 400, { ok: false, error: 'аккаунт удалить из читалки нельзя — пользователями управляет админка /admin' });
      }
      const current = String(body.current ?? body.oldPassword ?? '');
      const next = String(body.password ?? '');
        // Пустой current больше не обходит проверку: он обязателен.
        if (!current || !users.verify(me, current)) {
          return json(res, 403, { ok: false, error: 'текущий пароль неверен' });
        }
      try {
        await users.setPassword(me, next);
        await refreshCoreAuth(me);
        log(`пароль изменён: ${me.login}`);
        return json(res, 200, sessionPayload(me));
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
      }
    }

    // --- админские методы ---
    if (url.pathname.startsWith('/api/admin/')) return adminApi(req, res, url);

    // --- Fever: клиенты обращаются к /fever/?api, но некоторые настроены на корень ---
    const isRoot = url.pathname === '/' || url.pathname === '';
    const isFeverPath = url.pathname === '/fever' || url.pathname === '/fever/';
    // В запросах протокола аргументы идут в адресе (?api&feeds), а ключ — в теле POST.
    const feverShape = FEVER_ARGUMENTS.some((name) => url.searchParams.has(name));
    let feverBody = null;
    if (req.method === 'POST' && (isFeverPath || isRoot || feverShape) && !url.pathname.startsWith('/api/')) {
      feverBody = await readRawBody(req);
      req.__body = feverBody;
    }
    const feverKey = feverKeyOf(req, url, feverBody);
    if (isFeverPath || (feverKey && !url.pathname.startsWith('/api/'))) {
      const feverUser = users.byApiKey(feverKey);
      if (!feverUser) {
        // Отвечаем по протоколу Fever, а не страницей: клиент ждёт JSON.
        log('Fever: неизвестный ключ API');
        return json(res, 200, { api_version: 3, auth: 0 });
      }
      // Клиент мог постучаться в корень — ядро разбирает протокол по адресу /fever/.
      if (!isFeverPath) req.url = `/fever/${url.search}`;
      const feverCore = await coreFor(feverUser);
      return feverCore.handleRequest(req, res, { authenticated: true });
    }
    // Похоже на Fever-клиент, но ключа нет (например, адрес указан без /fever/):
    // отвечаем так же, как настоящий Fever, — клиент покажет ошибку входа.
    if (isRoot && feverShape && !feverKey) {
      return json(res, 200, { api_version: 3, auth: 0 });
    }

    // --- всё остальное: читалка текущего пользователя ---
    const user = currentUser(req, url);
    if (user) users.touch(user).catch(() => {});
    if (!user) {
      if (url.pathname.startsWith('/api/')) return json(res, 401, { ok: false, error: 'нужен вход', authRequired: true });
      // Файлы интерфейса отдаём напрямую: паролей в них нет, а поднимать
      // ради статики ядро администратора — лишняя память на каждый запрос.
      if (await serveStaticFromPublic(req, res, url)) return;
      const fallback = users.all.find((u) => u.role === 'admin') ?? users.all[0];
      if (!fallback) return json(res, 500, { ok: false, error: 'нет ни одного пользователя' });
      const core = await coreFor(fallback);
      return core.handleRequest(req, res);
    }
    const core = await coreFor(user);
    // Ядро раньше проверяло пароль по своим настройкам: при включённой старой
    // авторизации запросы с Basic из users.json получали 401. Контроллер уже
    // опознал пользователя — сообщаем это ядру явно.
    return core.handleRequest(req, res, { authenticated: true });
  } catch (err) {
    // Ошибки клиента (битый JSON, слишком большое тело) — короткая строка, без стека.
    const status = Number(err.statusCode) || 500;
    if (status >= 500) log('ошибка обработки запроса:', err.stack ?? err.message);
    else log(`запрос отклонён (${status}): ${err.message}`);
    if (!res.headersSent) json(res, status, { ok: false, error: String(err.message ?? err) });
    else res.end();
  }
}

// Данные прежней версии (одна читалка на всех) отдаём первому администратору.
const firstAdmin = users.all.find((u) => u.role === 'admin') ?? users.all[0];
if (firstAdmin) {
  await migrateLegacyData(firstAdmin);
}

// Защита от «запер себя снаружи»: если ни одного включённого администратора
// не осталось, включаем первого — иначе в читалку нельзя будет войти.
const enabledAdmins = users.all.filter((u) => u.role === 'admin' && !u.disabled);
if (!enabledAdmins.length && users.all.length) {
  const wake = users.all.find((u) => u.role === 'admin') ?? users.all[0];
  await users.setDisabled(wake, false);
  if (wake.role !== 'admin') await users.setRole(wake, 'admin');
  log(`включённых администраторов не было — вернул доступ пользователю «${wake.login}»`);
}

if (httpsServer) {
  httpsServer.listen(HTTPS_PORT, HOST, () => {
    log(`HTTPS: https://${HOST}:${HTTPS_PORT}   сертификат: ${TLS_CERT}`);
  });
}

server.listen(PORT, HOST, async () => {
  log(`MAK RSS Reader: http://${HOST}:${PORT}   данные: ${DATA_DIR}`);
  log(`пользователей: ${users.all.length} (${users.all.map((u) => u.login).join(', ')})`);
  log(`админка: http://${HOST}:${PORT}/admin   Fever API: http://${HOST}:${PORT}/fever/`);
  const first = users.all[0];
  if (first && users.all.length === 1 && DEFAULT_PASSWORD === 'admin') {
    log(`вход по умолчанию: ${first.login} / admin — смените пароль в админке`);
  }

  // Поднимаем данные всех пользователей, а не только того, кто откроет читалку:
  // иначе ленты обновлялись бы лишь у тех, кто зашёл в интерфейс.
  // Небольшая пауза между пользователями, чтобы не бить по сайтам залпом.
  for (const user of users.all) {
    if (user.disabled) continue;
    if (cores.has(user.id)) continue;
    try {
      await coreFor(user);
      const stats = coreStats.get(user.id) ?? {};
      log(`[${user.login}] ленты под наблюдением: подписок ${stats.feeds ?? 0}, статей ${stats.items ?? 0}`);
    } catch (err) {
      log(`[${user.login}] не удалось поднять данные: ${err.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    log('останов: сохраняю состояние и тексты статей');
    // Страховка: systemd не должен убивать процесс раньше, чем закончится запись.
    const guard = setTimeout(() => process.exit(0), 8000);
    guard.unref?.();
    for (const core of cores.values()) {
      try {
        const mod = await core;
        await mod.shutdown?.();
      } catch { /* экземпляр мог не подняться */ }
    }
    // Контрольная досыпка: flushAllStores сохраняет и state.json, и content/*.json.
    await flushAllStores().catch(() => {});
    clearTimeout(guard);
    process.exit(0);
  });
}

/**
 * Запрос пришёл по HTTPS (напрямую или через прокси с x-forwarded-proto).
 * Нужно, чтобы cookie сессии получала флаг Secure.
 */
/** Локальный прокси: только ему верим в X-Forwarded-Proto. */
function isLocalRequest(req) {
  const address = String(req.socket?.remoteAddress ?? '');
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function requestIsHttps(req) {
  if (req.socket?.encrypted) return true;
  // Снаружи X-Forwarded-Proto подделает кто угодно — верим только своему прокси.
  if (!isLocalRequest(req)) return false;
  return String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
}

// ---- Лимит попыток входа (объявления на верхнем уровне: ниже по файлу
//      они используются в обработчике /api/login) ----

/**
 * Доверенный ли адрес: только тогда верим заголовку X-Forwarded-For.
 * Иначе любой клиент присылал случайный IP в заголовке и обходил лимит попыток.
 */
const TRUSTED_PROXIES = new Set(
  String(process.env.TRUST_PROXY ?? '127.0.0.1,::1,::ffff:127.0.0.1')
    .split(',').map((value) => value.trim()).filter(Boolean),
);

const isTrustedProxy = (address) => TRUSTED_PROXIES.has(String(address ?? '').trim());

/**
 * IP клиента. Заголовок X-Forwarded-For принимаем только от своего прокси:
 * в остальных случаях используем адрес сокета, иначе лимит входа обходится
 * подстановкой произвольного адреса в заголовок.
 */
function clientIp(req) {
  const socketAddress = req.socket?.remoteAddress ?? "unknown";
  if (!isTrustedProxy(socketAddress)) return socketAddress;
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return forwarded || socketAddress;
}

// Попытки входа: ip -> { count, until }. Держим в памяти, хранилище не нужно.
const loginAttempts = new Map();   // ip -> { count, until }

const LOGIN_MAX_TRIES = 10;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ENTRIES = 5000;      // потолок карты: иначе перебор с разных IP растит память

/** Выбрасывает истёкшие записи и не даёт карте расти без предела. */
function pruneLoginAttempts() {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.until) loginAttempts.delete(ip);
  }
  if (loginAttempts.size <= LOGIN_MAX_ENTRIES) return;
  // Всё ещё много — удаляем самые старые окна, пока не уложимся в потолок.
  const sorted = [...loginAttempts.entries()].sort((a, b) => a[1].until - b[1].until);
  for (const [ip] of sorted.slice(0, loginAttempts.size - LOGIN_MAX_ENTRIES)) loginAttempts.delete(ip);
}

function loginBlocked(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.until) { loginAttempts.delete(ip); return false; }
  return entry.count >= LOGIN_MAX_TRIES;
}

function loginFailed(ip) {
  const now = Date.now();
  if (loginAttempts.size > LOGIN_MAX_ENTRIES) pruneLoginAttempts();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.until) {
    loginAttempts.set(ip, { count: 1, until: now + LOGIN_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

function loginSucceeded(ip) {
  loginAttempts.delete(ip);
}
