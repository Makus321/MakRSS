// Service worker читалки.
//
// Задачи:
//  1) оболочка (страница, стили, скрипт, шрифты, иконки) — из кэша сразу, чтобы
//     приложение открывалось мгновенно и без сети;
//  2) данные читалки (/api/data, /api/bodies) — «сразу из кэша, потом обновим»:
//     при плохой связи список и тексты статей показываются из памяти;
//  3) картинки и видео — тоже в кэш, чтобы прочитанное открывалось без сети;
//  4) всё остальное (вход, админка, Fever, действия) — только через сеть.

const CACHE = 'rss-shell-v358';   // 195: оболочка перезабирается — иначе старый app.js живёт в кэше
const DATA_CACHE = 'rss-data-v180';
const MEDIA_CACHE = 'rss-media-v151';

const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/fonts/ptsansnarrow-400-cyrillic.woff2',
  '/fonts/ptsansnarrow-400-latin.woff2',
  // /app.js и /style.css НЕ предзагружаем: у них адрес с ?v=NNN, и копия
  // без версии в кэше лишала app.js номера сборки (версия показывалась 1.0).
  // Их сохраняет shellFirst() уже с версией в адресе.
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => { /* часть файлов может быть недоступна — не критично */ }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([CACHE, DATA_CACHE, MEDIA_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.filter((name) => !keep.has(name)).map((name) => caches.delete(name)));
    await self.clients.claim();
    // Сообщаем открытым страницам: оболочка обновилась, можно перезагрузиться.
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) client.postMessage({ type: 'reload' });
  })());
});

  // Список статей НЕ кэшируем: если большой ответ (~8 МБ) обрывался, из кэша
  // возвращалась старая копия, и в ленте оставались карточки удалённых статей.
  // Тела статей кэшируем по-прежнему — иначе не работает чтение офлайн.
const isFavicon = (path) => path === '/api/favicon';   // 404 значка запоминаем, чтобы не спрашивать снова
const isVideo = (path) => path === '/api/video';
// Видео НЕ кэшируем: браузер запрашивает файл частями (Range), а cacheFirst
// отдавал целую копию из кэша — из-за этого плеер не начинал воспроизведение.
const isMedia = (path) => path === '/api/img' || path === '/api/thumb';
const isStatic = (path) => /\.(css|js|png|svg|ico|webmanifest|woff2?|ttf)$/.test(path);

/** Сразу отдаём из кэша, а свежее подтягиваем в фоне. */
/** Неудачную картинку запоминаем, чтобы не запрашивать её снова и снова. */
async function negativeCache(request, cacheName) {
  const cache = await caches.open(cacheName);
  const stored = await cache.match(request);
  if (stored) return stored;
  const response = await fetch(request);
  if (response.status === 404) {
    await cache.put(request, new Response('', { status: 204 })).catch(() => {});
    return new Response('', { status: 404 });
  }
  if (response.ok) await cache.put(request, response.clone()).catch(() => {});
  return response;
}

// Оболочка версионируется через ?v=: кэшируем под точным адресом запроса.
// Версионные файлы ищем ТОЛЬКО точным совпадением: раньше второй поиск шёл с
// ignoreSearch и на новый /app.js?v=400 отдавал из кэша старый /app.js?v=399 —
// поэтому после деплоя браузер продолжал работать на прежней сборке.
async function shellFirst(request) {
  const url = new URL(request.url);
  const versioned = url.searchParams.has('v');
  const cache = await caches.open(CACHE);
  const exact = await cache.match(request);
  if (exact) return exact;
  if (!versioned) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
  }
  const fresh = await fetch(request);
  if (fresh && fresh.ok) {
    cache.put(request, fresh.clone()).catch(() => {});
    if (versioned) await dropOldVersions(cache, url).catch(() => {});
  }
  return fresh;
}

/** Убирает из кэша другие версии того же файла: /app.js?v=399 при запросе v=400. */
async function dropOldVersions(cache, url) {
  const keys = await cache.keys();
  for (const key of keys) {
    const known = new URL(key.url);
    if (known.pathname !== url.pathname) continue;
    if (known.search === url.search) continue;
    await cache.delete(key).catch(() => {});
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh && fresh.ok) cache.put(request, fresh.clone()).catch(() => {});
  return fresh;
}

/** Сразу из кэша (если есть), параллельно обновляем копию. */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((fresh) => {
      if (fresh && fresh.ok) cache.put(request, fresh.clone()).catch(() => {});
      return fresh;
    })
    .catch(() => null);
  if (cached) {
    network.catch(() => {});
    return cached;
  }
  const fresh = await network;
  if (fresh) return fresh;
  throw new Error('нет сети и кэша');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Вход, админка, Fever и всё остальное «действия» — без кэша.
  if (/^\/(fever|admin)/.test(url.pathname)) return;
  // Неудачные значки запоминаем: иначе битый фавикон запрашивался при каждой отрисовке.
  if (isFavicon(url.pathname)) {
    event.respondWith(negativeCache(request, MEDIA_CACHE).catch(() => Response.error()));
    return;
  }
  // Остальные /api/ идут в сеть напрямую: у них своя логика обновления.
  if (/^\/api\//.test(url.pathname) && !isMedia(url.pathname)) return;

  if (isVideo(url.pathname)) return;   // видео — только сеть, без кэша
  if (isMedia(url.pathname)) {
    event.respondWith(cacheFirst(request, MEDIA_CACHE).catch(() => Response.error()));
    return;
  }

  // Оболочка: файлы — из кэша, страницы — с обновлением в фоне.
  event.respondWith((async () => {
    if (request.mode === 'navigate') {
      // Сначала сеть: иначе установленное приложение может долго показывать
      // старую оболочку (страница берётся из кэша, а свежая кладётся «на потом»).
      try {
        const fresh = await fetch(request);
        if (fresh && fresh.ok) {
          const cache = await caches.open(CACHE);
          cache.put('/index.html', fresh.clone()).catch(() => {});
          cache.put(request, fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch {
        const shell = await caches.match('/index.html', { ignoreSearch: true }) ?? await caches.match('/', { ignoreSearch: true }) ?? await caches.match(request, { ignoreSearch: true });
        if (shell) return shell;
        throw new Error('нет сети и кэша');
      }
    }
    if (isStatic(url.pathname)) {
      try {
        return await shellFirst(request);
      } catch {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;
        throw new Error('нет сети и кэша');
      }
    }
    return fetch(request);
  })());
});

// Клиент может попросить «прогреть» статьи на будущее (раз в час).
self.addEventListener('message', (event) => {
  const data = event.data ?? {};
  if (data.type !== 'warm' || !Array.isArray(data.urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(DATA_CACHE);
    for (const url of data.urls.slice(0, 30)) {
      try {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (res.ok) await cache.put(url, res.clone());
      } catch { /* нет сети — попробуем в следующий раз */ }
    }
  })());
});
