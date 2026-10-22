// Service worker читалки.
//
// Задачи:
//  1) оболочка (страница, стили, скрипт, шрифты, иконки) — из кэша сразу, чтобы
//     приложение открывалось мгновенно и без сети;
//  2) данные читалки (/api/data, /api/bodies) — «сразу из кэша, потом обновим»:
//     при плохой связи список и тексты статей показываются из памяти;
//  3) картинки и видео — тоже в кэш, чтобы прочитанное открывалось без сети;
//  4) всё остальное (вход, админка, Fever, действия) — только через сеть.

const CACHE = 'rss-shell-v163';
const DATA_CACHE = 'rss-data-v151';
const MEDIA_CACHE = 'rss-media-v151';

const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/fonts/ptsansnarrow-400-cyrillic.woff2',
  '/fonts/ptsansnarrow-400-latin.woff2',
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

const isData = (path) => path === '/api/data' || path === '/api/bodies';
const isMedia = (path) => path === '/api/img' || path === '/api/thumb' || path === '/api/video';
const isStatic = (path) => /\.(css|js|png|svg|ico|webmanifest|woff2?|ttf)$/.test(path);

/** Сразу отдаём из кэша, а свежее подтягиваем в фоне. */
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
  if (/^\/api\//.test(url.pathname) && !isData(url.pathname) && !isMedia(url.pathname)) return;

  if (isMedia(url.pathname)) {
    event.respondWith(cacheFirst(request, MEDIA_CACHE).catch(() => Response.error()));
    return;
  }
  if (isData(url.pathname)) {
    // Если ни кэша, ни сети — отдаём ошибку сети, а не пустой JSON: иначе клиент
    // принимал «{}» за настоящие данные и падал на state.data.items.
    event.respondWith(staleWhileRevalidate(request, DATA_CACHE).catch(() => Response.error()));
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
        const shell = await caches.match('/index.html') ?? await caches.match('/') ?? await caches.match(request);
        if (shell) return shell;
        throw new Error('нет сети и кэша');
      }
    }
    if (isStatic(url.pathname)) {
      try {
        return await cacheFirst(request, CACHE);
      } catch {
        const cached = await caches.match(request);
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
