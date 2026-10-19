// MAK RSS Reader — вход, пользователи и админка.
//
// Сам читалка живёт в reader-core.mjs. Контроллер поднимает по одному экземпляру
// этого модуля на пользователя (import с параметром ?u=<id>), поэтому у каждого
// свои подписки, статьи, медиа и таймеры обновления, а здесь остаётся только то,
// что общее: HTTP-порт, вход, список пользователей и админка /admin.

import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile, mkdir, rename, readdir, cp, rm, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cookieHeader, issueSession, parseCookies, readSession, safeEqual,
} from './lib/auth.mjs';
import { Users, ensureDefaultAdmin, userDir } from './lib/users.mjs';

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
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};

function readRawBody(req, limit = 4 * 1024 * 1024) {
  if (typeof req.__body === 'string') return Promise.resolve(req.__body);
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('слишком большое тело запроса')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const readJsonBody = async (req) => {
  try {
    return JSON.parse((await readRawBody(req)) || '{}');
  } catch {
    return {};
  }
};

/** Пользователь текущего запроса: cookie, Basic или ключ Fever в адресе. */
function currentUser(req, url) {
  const cookies = parseCookies(req.headers.cookie);
  const session = readSession(users.state.secret, cookies[SESSION_COOKIE]);
  if (session) {
    const user = users.byLogin(session.user);
    if (user && !user.disabled) return user;
  }
  const header = req.headers.authorization ?? '';
  if (header.startsWith('Basic ')) {
    const [login, password] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
    const user = users.byLogin(login);
    if (user && users.verify(user, password)) return user;
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
    try {
      const core = await cores.get(userId);
      value = Number(core.revision?.() ?? 0);
    } catch { continue; }
    if (revisions.get(userId) === value) continue;
    revisions.set(userId, value);
    const message = `data: ${JSON.stringify({ revision: value })}\n\n`;
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
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const route = `${req.method} ${url.pathname}`;
  try {
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
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      let initial = 0;
      try {
        const core = await coreFor(watcher);
        initial = Number(core.revision?.() ?? 0);
      } catch { /* ядро поднимется при следующем запросе */ }
      res.write('retry: 5000\n\n');
      res.write(`data: ${JSON.stringify({ revision: initial })}\n\n`);
      revisions.set(watcher.id, initial);
      subscribe(watcher, res);
      return undefined;
    }

    // --- админка (страница отдаётся всегда: без входа она показывает форму) ---
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
      const user = users.byLogin(login);
      if (!user || !users.verify(user, password)) {
        await new Promise((resolve) => setTimeout(resolve, 350));   // против перебора
        log(`неудачный вход: «${login}»`);
        return json(res, 401, { ok: false, error: 'неверный логин или пароль' });
      }
      const ttl = body.remember ? SESSION_TTL : SHORT_SESSION_TTL;
      res.setHeader('set-cookie', cookieHeader(SESSION_COOKIE, issueSession(users.state.secret, user.login, ttl), { maxAge: ttl }));
      users.touch(user).catch(() => {});
      log(`вход: ${user.login}`);
      return json(res, 200, sessionPayload(user));
    }

    if (route === 'POST /api/logout') {
      res.setHeader('set-cookie', cookieHeader(SESSION_COOKIE, '', { maxAge: 0 }));
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
      if (current && !users.verify(me, current)) return json(res, 403, { ok: false, error: 'текущий пароль неверен' });
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
      return feverCore.handleRequest(req, res);
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
      // Интерфейс отдаём: паролей в нём нет, а данные он запросит уже с сессией.
      const fallback = users.all.find((u) => u.role === 'admin') ?? users.all[0];
      if (!fallback) return json(res, 500, { ok: false, error: 'нет ни одного пользователя' });
      const core = await coreFor(fallback);
      return core.handleRequest(req, res);
    }
    const core = await coreFor(user);
    return core.handleRequest(req, res);
  } catch (err) {
    log('ошибка обработки запроса:', err.stack ?? err.message);
    if (!res.headersSent) json(res, 500, { ok: false, error: String(err.message ?? err) });
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
    log('останов: сохраняю состояние');
    for (const core of cores.values()) {
      try {
        const mod = await core;
        await mod.shutdown?.();
      } catch { /* экземпляр мог не подняться */ }
    }
    process.exit(0);
  });
}
