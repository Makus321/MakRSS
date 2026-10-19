// Service worker читалки: кэш оболочки, чтобы приложение открывалось без сети.
// Стратегия — network-first: сначала свежий файл, а если сети нет — то, что уже
// лежит в кэше. Данные и служебные адреса всегда идут с сервера, без кэша.
const CACHE = 'rss-shell-v92';
const SHELL = ['/', '/style.css', '/app.js', '/manifest.webmanifest'];

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
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Данные, Fever и админка — только с сервера.
  if (/^\/(api|fever|admin)/.test(url.pathname)) return;
  event.respondWith((async () => {
    try {
      const fresh = await fetch(request);
      if (fresh && fresh.ok) {
        const copy = fresh.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
      }
      return fresh;
    } catch {
      const cached = await caches.match(request);
      if (cached) return cached;
      if (request.mode === 'navigate') {
        const shell = await caches.match('/');
        if (shell) return shell;
      }
      throw new Error('нет сети и кэша');
    }
  })());
});
