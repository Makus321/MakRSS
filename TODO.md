# Полный аудит и TODO по исправлению ошибок — `rss-reader`

**Дата аудита:** 2026-11-27  
**Объём проверки:** весь проект — `server.mjs`, `reader-core.mjs`, `lib/*.mjs` (14 модулей), `public/*` (7 файлов), `deploy/*`, `tools/*`, `test/*`, `package.json`, `.gitignore`, существующие `TODO*.md` и `*AUDIT*.md`.  
**Текущее состояние автотестов:** 44 / 44 проходят (`node --test --test-isolation=none test/*.test.mjs`), `node --check` по всем `.js`/`.mjs` без ошибок.

---

## Сводка по приоритетам

| Приоритет | Кол-во | Фокус |
|---|---:|---|
| **P0 — Критические** | 12 | Утечка root-пароля в git, удалённый DoS, SSRF и обход IPv6-фильтра, Stored/Reflected XSS, отзыв сессий, поломка деплоя/публикации |
| **P1 — Высокие** | 25 | Поломка Basic Auth, потеря данных при гонках `Store`/`Users`, OOM DoS, Fever API, UI/SW гонки и утечки, нулевое покрытие тестами |
| **P2 — Средние** | 24 | Ошибки парсинга RSS/Atom/LJ/Telegram, кэши и ETag, валидация ввода, мобильная вёрстка, админка, конфиги |
| **P3 — Низкие** | 10 | Доступность (a11y), мёртвый код, мелкие баги `imagesize`/`habr-now`/`xml`, архивация старых TODO, техдолг |

---

## P0 — Критические (исправлять в первую очередь)

### Безопасность, утечки и удалённый DoS

- [x] **P0.1. Утечка реальных root-доступов VPS в индексе git**
  - **Где:** `rus-host.txt:1-3`, `.gitignore:5`
  - **Проблема:** Файл содержит IP, логин `root` и пароль в открытом виде. Несмотря на запись в `.gitignore`, файл уже отслеживается git (`git ls-files` его возвращает).
  - **Исправление:** Немедленно сменить root-пароль на VPS (перевести вход на SSH-ключи), удалить файл из индекса (`git rm --cached rss-reader/rus-host.txt`) и при необходимости вычистить историю git.
  - **Решение владельца (2026-11-27):** не делаем — пароль VPS и историю `watchfaces` не трогаем.

- [x] **P0.2. Удалённый DoS (краш Node.js одним HTTP-запросом без авторизации)**
  - **Где:** `server.mjs:470-475`, `reader-core.mjs:3983-3985`, `lib/traffic.mjs:36`
  - **Проблема:** `new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)` вызывается **до** `try/catch` внутри `async function onRequest`. Невалидный заголовок `Host` (например `Host: bad host`) бросает `TypeError [ERR_INVALID_URL]` → `UnhandledPromiseRejection` → падение процесса.
  - **Исправление:** Перенести разбор URL и `trackTraffic` внутрь `try/catch`, парсить `req.url` с фиксированной базой `'http://localhost'`, при ошибке возвращать `400 Bad Request`. В `lib/traffic.mjs:36` также обернуть `new URL(...)` в `try/catch`.
  - **Сделано (2026-11-27, коммит `01f74fc`):** разбор адреса перенесён в `try/catch` с фиксированной базой `http://localhost` (Host больше не влияет на разбор пути), при мусоре — `400 Bad Request`; в `lib/traffic.mjs` разбор тоже защищён и при ошибке запрос считается как `OTHER`. Проверено на сервере: `GET http://[ HTTP/1.1` → `400`, служба `active`, обычный запрос → `200`.

- [x] **P0.3. SSRF в `httpGetOnce` и `httpGetBinary` (обход `net-guard.mjs`)**
  - **Где:** `reader-core.mjs:394`, `reader-core.mjs:1845`
  - **Проблема:** Обе функции вызывают `fetch(url, { redirect: 'follow' })` напрямую вместо `safeFetch`. Через `/api/discover`, `/api/feeds`, `/api/opml`, `fetchFullText` (`reader-core.mjs:1090`) и `/api/favicon` (`reader-core.mjs:1889, 1913`) можно обращаться к `127.0.0.1`, LAN и `169.254.169.254` (включая 302-редирект).
  - **Исправление:** Заменить `fetch` в `httpGetOnce` и `httpGetBinary` на `safeFetch` (с возвратом `finalUrl` из последнего редиректа).
  - **Сделано (2026-11-27):** `httpGetOnce` и `httpGetBinary` переведены на `safeFetch` (редиректы проверяются пошагово, адрес — по резолву); `safeFetch` теперь запоминает финальный адрес (`finalUrlOf`), чтобы относительные ссылки считались от реального URL. Проверено на сервере: `/api/img?u=http://127.0.0.1/` → **403**, `/api/video?u=http://127.0.0.1/` → **403**, `/api/discover` с `http://127.0.0.1/` → `ok:false, «адрес в приватной сети»`.


- [x] **P0.4. Полный обход SSRF-защиты `net-guard.mjs` через IPv4-mapped IPv6**
  - **Где:** `lib/net-guard.mjs:60-70, 87-92`
  - **Проблема:** `new URL('http://[::ffff:127.0.0.1]/')` в Node.js нормализует адрес в `::ffff:7f00:1`. Регулярка `/^::ffff:(\d+\.\d+\.\d+\.\d+)$/` его не ловит — `assertPublicUrl` пропускает loopback и cloud metadata (`::ffff:a9fe:a9fe`). Также не блокируются неканонический loopback (`0:0:0:0:0:0:0:1`), IPv4-compatible (`::7f00:1`), NAT64 (`64:ff9b::/96`), 6to4 (`2002::/16`), Teredo (`2001::/32`), multicast (`ff00::/8`).
  - **Исправление:** Парсить IPv6 в 128-битный `BigInt` и проверять диапазоны битовыми масками (для `::ffff:0:0/96` и `::/96` извлекать младшие 32 бита и прогонять через IPv4-блоклист). Добавить юнит-тесты в `test/net-guard.test.mjs`.
  - **Сделано (2026-11-27):** IPv6 разбирается в 128-битный `BigInt` и проверяется масками: `::ffff:0:0/96`, `::/96`, NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`), 6to4 (`2002::/16`), Teredo (`2001::/32`), ORCHID, `100::/64`, `ff00::/8`, ULA, link-local. Тесты: `::ffff:7f00:1`, `::7f00:1`, `0:0:0:0:0:0:0:1`, `64:ff9b::7f00:1`, `2002:7f00:1::` блокируются, публичные — нет.


- [ ] **P0.5. Reflected / Stored XSS на origin приложения через медиа-прокси (`/api/video`, `/api/img`, `/api/thumb`, `/api/favicon`)**
  - **Где:** `reader-core.mjs:2279-2290` (`serveVideo`), `2609-2623` (`serveImage`), `2365-2385` (`serveThumb`), `1819-1839, 1949-1950` (`serveFavicon`)
  - **Проблема:** `serveVideo` копирует произвольный `Content-Type` от внешнего сервера (можно отдать `text/html` со скриптом на origin читалки). `serveImage`, `serveThumb` и `serveFavicon` пропускают `image/svg+xml` без CSP-песочницы; `ICON_MAGIC` принимает любой файл, начинающийся с `<` (`0x3c`). При `SameSite=Lax` переход по внешней ссылке открывает доступ ко всему origin (включая `/api/session` и `/api/admin/*`).
  - **Исправление:** В `serveVideo` разрешить только `video/*`, `audio/*`, `application/octet-stream` (иначе `415`). В `serveImage`/`serveThumb`/`serveFavicon` запретить `image/svg+xml` и не-иконки. На все медиа-прокси добавить `X-Content-Type-Options: nosniff` и `Content-Security-Policy: default-src 'none'; sandbox`.

- [ ] **P0.6. Stored XSS в серверном HTML-санитайзере статей (`lib/readability.mjs`)**
  - **Где:** `lib/readability.mjs:52-77`
  - **Проблема:** Регулярка на строке 62 требует `\s+` после имени тега, поэтому `<img/src=x/onerror=alert(1)>`, `<svg/onload=alert(2)>`, `<a/href="javascript:alert(1)">` проходят нетронутыми. Чёрный список не блокирует `<base>`, `<object>`, `<embed>`, `<math>`, одиночный `<svg>` и `</script >`. В `href`/`src` разрешён `data:image/svg+xml`.
  - **Исправление:** Переписать `cleanBlock` на полноценный HTML-санитайзер по **белому списку** тегов и атрибутов, декодировать сущности перед проверкой схем URL, запретить `data:image/svg+xml`.

- [ ] **P0.7. Stored XSS в комментариях Tolstoy и отсутствие санитизации в остальных провайдерах**
  - **Где:** `lib/comments.mjs:29-35, 71, 122, 190, 299, 402`
  - **Проблема:** `loadTolstoy` вызывает `decodeEntities(comment.text_template)` без санитизации — экранированный текст `&lt;img src=x onerror=alert(1)&gt;` превращается в живой HTML. Остальные провайдеры (Habr, WordPress, iXBT, LJ) тоже отдают сырой HTML.
  - **Исправление:** В `loadTolstoy` не декодировать `&lt;`/`&gt;` в живые теги (экранировать текст, оставляя только `<br>`), а выход всех провайдеров прогонять через единый allowlist-санитайзер.

- [ ] **P0.8. Stored XSS на клиенте через `sanitize()` + `setupEmbeds()` (атрибут `data-embed` и тег `BUTTON`)**
  - **Где:** `public/app.js:5352-5356, 5474-5507, 1173-1190`
  - **Проблема:** `sanitize()` разрешает `DIV`/`BUTTON` и сохраняет произвольные `class`/`data-*`. Вредоносная статья с `<div class="embed-box" data-embed="javascript:alert(1)"><button class="embed-play">...</button></div>` заставляет `setupEmbeds()` выполнить `frame.src = src` без проверки протокола и без `sandbox`.
  - **Исправление:** В `sanitize()` перевести фильтрацию атрибутов на строгий allowlist по тегам (удалять все `id`, `class`, `data-*` из входного HTML до генерации собственных виджетов). В `setupEmbeds()` проверять `/^https?:\/\//i.test(src)` и задавать `frame.sandbox` + `frame.referrerPolicy = 'no-referrer'`.

- [ ] **P0.9. Stored XSS через невалидированный протокол `item.link` и `data:image/svg+xml` / `/api/` на клиенте**
  - **Где:** `public/app.js:1819-1820, 3050, 3329-3330, 5481-5483`
  - **Проблема:** `item.link` подставляется в `href` и `window.open` без проверки `http:`/`https:` (`javascript:` пройдёт). В `sanitize()` строки `5481-5483` разрешают `data:image/svg+xml` и любые `/api/` пути в `href`/`src`.
  - **Исправление:** Добавить `safeHttpUrl(raw)` и использовать в `articleHtml`, горячей клавише `o` и `shareItem`. В `sanitize()` для `href` оставить только `https?:`/`mailto:`, для `src`/`poster` исключить `data:image/svg+xml` и ограничить внутренние пути только `/api/media` и `/api/video`.

- [ ] **P0.10. Смена пароля не отзывает активные сессии (вопреки сообщению API)**
  - **Где:** `server.mjs:238-243, 322-326, 616-620`, `lib/auth.mjs:37-58`, `lib/users.mjs:148-155`
  - **Проблема:** Сессионный токен `user|expires` подписан единым секретом; при `setPassword` версия токена не меняется, поэтому украденная cookie живёт до 30 дней.
  - **Исправление:** Добавить пользователю `sessionVersion` (инкрементировать в `setPassword` и `setDisabled`), включить её в payload токена `user|ver|expires` и проверять в `currentUser`.

### Деплой и публикация

- [ ] **P0.11. Сломанный деплой в `deploy/install-vps.sh` (инвертированный `SKIP_NODE` и жёсткий путь `/usr/local/bin/node`)**
  - **Где:** `deploy/install-vps.sh:67, 156`
  - **Проблема:** Строка 67: `[[ "$major" -ge 18 && "$SKIP_NODE" != yes ]]` — `SKIP_NODE=yes` наоборот запускает установку Node.js. Строка 156: захардкожен `/usr/local/bin/node`, хотя системный Node часто стоит в `/usr/bin/node` — systemd-юнит падает.
  - **Исправление:** Поменять условие на `[[ "$SKIP_NODE" == yes || "$major" -ge 18 ]]` и определять путь через `NODE_BIN="$(command -v node)"` (как в `deploy/install.sh:29, 111`).

- [x] **P0.12. Ошибки скрипта публикации `tools/publish.ps1`**
  - **Где:** `tools/publish.ps1:22, 48-50, 74, 91-95, 109`
  - **Проблемы:**
    1. `$AuthorEmail = '<EMAIL_8>'` — буквальная заглушка в файле: значение из 9 символов, без `@` (проверено по байтам; это не токен анонимизации).
    2. Строки 91–95 делают `git checkout -- <file>` для всех отсутствующих в `$Stage` файлов — невозможно удалять устаревшие файлы из публичного репо.
    3. `$excludeFiles` не исключает `tools/publish-leaks.txt` и внутренние `TODO*.md` / `*AUDIT*.md` (где есть личный домен).
    4. `bump-version.mjs` вызывается до проверки `-DryRun`, мутируя `index.html` и `sw.js`.
    5. Проверка утечек пропускает `*.ps1`, `*.txt`, `*.json`, `*.service`, `*.example`.
  - **Исправление:** Указать корректный noreply-email; убрать авто-восстановление удалённых файлов (оставить whitelist только для нужных вроде `README`/`LICENSE` если требуется); исключить `publish-leaks.txt` и внутренние аудит-файлы; перенести `bump-version` после `-DryRun`; расширить список расширений в проверке утечек.
  - **Сделано (2026-11-27, коммит `01f74fc` + правки после него):**
    1. заглушка `<EMAIL_8>` убрана: email берётся из `-AuthorEmail` или `git config user.email`, при пустом — понятная ошибка (проверено `-DryRun`: `автор коммита: Makus321 <…>`);
    2. из репозитория теперь можно удалять устаревшие файлы: восстанавливаются только служебные (`LICENSE`, `COPYING`), остальные отсутствующие считаются осознанным удалением;
    3. `publish-leaks.txt` исключён из копии и из сканирования (в нём сами запрещённые строки);
    4. `-DryRun` больше не поднимает номер сборки — рабочая копия не меняется (проверено: версия до и после DryRun одинаковая);
    5. проверка утечек расширена на `*.ps1`, `*.txt`, `*.json`, `*.service`, `*.example`.

---

## P1 — Высокий приоритет (надёжность, гонки, потеря данных, безопасность)

### Сервер и ядро (`server.mjs`, `reader-core.mjs`)

- [ ] **P1.1. Сломана авторизация по HTTP Basic Auth на всех `/api/*` маршрутах ядра**
  - **Где:** `server.mjs:245-249`, `reader-core.mjs:275, 297-298, 3854-3860, 3969-3974, 3990`
  - **Проблема:** `init()` и `updateAuth()` не передают `passHash` в `userSettings.auth`. В результате `server.mjs` пропускает Basic Auth, а `reader-core.mjs:3990` всегда возвращает `401`.
  - **Исправление:** Передавать флаг `{ authenticated: true }` в `core.handleRequest(req, res, opts)` либо прокидывать `passHash`.

- [ ] **P1.2. После `disable` → `enable` пользователя навсегда ломается автообновление лент + утечка `Store`**
  - **Где:** `server.mjs:120, 141-152`, `reader-core.mjs:3812, 3952-3960, 4182`, `lib/store.mjs:43`
  - **Проблема:** `import('./reader-core.mjs?u=<id>')` возвращает кэшированный ESM-модуль со `stopped = true`. `init()` не сбрасывает `stopped`, `refreshScheduledOnce`, `backfillDone`, очереди и кэши; `stop()` не удаляет `Store` из `liveStores`.
  - **Исправление:** В `init()` сбрасывать все модульные флаги/кэши; добавить `store.close()` для удаления из `liveStores`; сериализовать `stopCore`/`coreFor` по `userId`.

- [ ] **P1.3. Новые статьи массово помечаются прочитанными из-за `newestKnown` вместо `oldestKnown`**
  - **Где:** `reader-core.mjs:599-609`
  - **Проблема:** Вычисляется максимальная дата `newestKnown` и для всех лент помечается прочитанной любая новая статья с `t < newestKnown` (разные часовые пояса, отложенная публикация и т.п. молча пропадают из непрочитанных).
  - **Исправление:** Применять правило только при догрузке истории Telegram и сравнивать с `oldestKnown = min(date)`.

- [ ] **P1.4. `cleanStoredBodies()` ошибочно ставит `hasFull = true` для всех обычных статей с анонсом**
  - **Где:** `reader-core.mjs:4074`
  - **Проблема:** Условие `(next.content || next.fullHtml)` срабатывает на обычный RSS-анонс `next.content`, блокируя `needsFullText` и вызывая лишнюю перезапись `content/*.json`.
  - **Исправление:** Проверять только `if (!item.hasFull && next.fullHtml)` и помечать файл контента `dirty` только при реальном изменении тела.

- [ ] **P1.5. Sibling-directory Path Traversal в `staticFile` без авторизации**
  - **Где:** `reader-core.mjs:3764-3767`, `server.mjs:665-669`
  - **Проблема:** `!file.startsWith(PUBLIC_DIR)` не содержит `path.sep`; неавторизованный запрос, не попавший в `serveStaticFromPublic`, пробрасывается в `core.handleRequest` → `staticFile`.
  - **Исправление:** Проверять `file.startsWith(PUBLIC_DIR + path.sep)` и возвращать `404` в `server.mjs` без проброса в `coreFor(fallback)`.

- [ ] **P1.6. Open Redirect через `Host` и поломка редиректа на IPv6**
  - **Где:** `server.mjs:495-502`
  - **Проблема:** `301` строится из сырого `req.headers.host.split(':')[0]` — позволяет Open Redirect на чужой домен и ломает IPv6 `[::1]:8787`.
  - **Исправление:** Использовать настраиваемый `PUBLIC_HOST` или валидировать `URL.hostname` по белому списку.

- [ ] **P1.7. Отсутствует `Cache-Control: no-store` в `json()` в `server.mjs`**
  - **Где:** `server.mjs:184-188, 299-304, 569`
  - **Проблема:** `GET /api/session` и `GET /api/admin/users` (содержат `apiKey`) могут кэшироваться браузером/прокси.
  - **Исправление:** Добавить `'cache-control': 'no-store'` в `json()` в `server.mjs:186`.

- [x] **P1.8. Отсутствие backpressure, таймаута и проверки `response.body` в `serveVideo`**
  - **Где:** `reader-core.mjs:2266-2296`
  - **Проблема:** `for await (...) res.write(chunk)` не ждёт `'drain'` (риск OOM), переданный `controller.signal` отключает дефолтный таймаут `safeFetch`, а `response.body === null` кидает `TypeError` после `writeHead`.
  - **Исправление:** Перейти на `pipeline(Readable.fromWeb(response.body), res)`, комбинировать `AbortSignal.any([controller.signal, AbortSignal.timeout(20000)])`, проверять `if (!response.body)`.
  - **Сделано (2026-11-27):** `serveVideo` отдаёт поток через `pipeline(Readable.fromWeb(...), res)` (с противодавлением), таймаут 20 с через `AbortSignal.any([controller.signal, AbortSignal.timeout(20000)])`, проверка `response.body` до `writeHead`.


- [x] **P1.9. Неограниченный `spawn('cwebp')` без таймаута и гонка временного файла `.webp.tmp`**
  - **Где:** `reader-core.mjs:2437-2483`
  - **Проблема:** Десятки параллельных картинок порождают десятки процессов `cwebp` без таймаута; `tmp` на строке 2456 использует `Date.now()` вместо `webpSeq`, что даёт коллизию при параллельных запросах.
  - **Исправление:** Добавить семафор (2–4 слота), таймаут с `kill('SIGKILL')` (15 с) и использовать один `webpSeq` для `source` и `tmp`.
  - **Сделано (2026-11-27):** не больше двух `cwebp` одновременно (очередь), таймаут 30 с с `SIGKILL`, временный файл `.webp.tmp` получает номер из того же счётчика `webpSeq`, что и `.src` (раньше `Date.now()` совпадал у параллельных картинок).


- [ ] **P1.10. Утечка мёртвых SSE-подписчиков и отсутствие закрытия SSE при отключении пользователя**
  - **Где:** `server.mjs:141-152, 416-449, 505-527`
  - **Проблема:** Разрыв соединения во время `await coreFor(watcher)` оставляет мёртвый `res` в `subscribers` навсегда; `stopCore` не закрывает SSE; `setInterval(pushRevisions, 1000)` может накладываться сам на себя.
  - **Исправление:** Проверять `res.destroyed || res.writableEnded` после `await`; закрывать и чистить `subscribers` в `stopCore`; удалять `res` при ошибке `res.write`; защитить `pushRevisions` флагом `pushing`.

- [ ] **P1.11. Неполный graceful shutdown в `server.mjs`**
  - **Где:** `server.mjs:731-748`
  - **Проблема:** При `SIGINT`/`SIGTERM` не закрываются `server`/`httpsServer`, не вызывается `mod.stop?.()`, нет защиты от повторного сигнала.
  - **Исправление:** Добавить флаг `shuttingDown`, вызывать `server.close()`, `httpsServer?.close()`, `mod.stop?.()`, `mod.shutdown?.()` и `flushAllStores()`.

### Библиотеки (`lib/*.mjs`)

- [ ] **P1.12. SSRF через DNS Rebinding (TOCTOU) в `safeFetch`**
  - **Где:** `lib/net-guard.mjs:79-125`
  - **Проблема:** `assertPublicUrl` делает `dns.lookup`, но `fetch()` затем резолвит домен повторно — при `TTL=0` возможен DNS Rebinding на `127.0.0.1`/`169.254.169.254`.
  - **Исправление:** Передавать в `fetch` кастомный `undici.Agent` с pinning проверенного IP в `connect: { lookup }`.

- [ ] **P1.13. Потеря данных в `Store` при гонках `#saveFeed`/`setBody`, ошибке в `#makeRoom` и `pruneContent`**
  - **Где:** `lib/store.mjs:263-306, 327-349, 360-374`
  - **Проблемы:**
    1. `setBody` во время `await #writeAtomic` перезаписывает данные в памяти, но завершившийся `#saveFeed` сбрасывает `dirtyFeeds` и вытесняет ленту — новые тела теряются.
    2. В `#makeRoom` при ошибке записи (`#writeAtomic` → `false`) строка 305 всё равно удаляет ленту из `openFeeds`, безвозвратно теряя несохранённые данные.
    3. `pruneContent` читает файл напрямую, минуя `feedLoads`, и перезаписывает свежий кэш устаревшей копией.
  - **Исправление:** Ввести счётчик поколений `feedDirtyGen` на каждый `feedId`; не вытеснять `openFeeds` при неуспешной записи; в `pruneContent` использовать `await this.#loadFeed(feedId)`.

- [ ] **P1.14. Уничтожение `users.json` и `state.json` при временной ошибке чтения на старте**
  - **Где:** `lib/users.mjs:29-40`, `lib/store.mjs:81-89`
  - **Проблема:** Любая ошибка чтения кроме `ENOENT` (например `EBUSY`/`EPERM` от антивируса/ownCloud) сбрасывает состояние в пустое и перезаписывает файл на диске (в `users.mjs` ещё и создаёт дефолтного `admin`).
  - **Исправление:** При ошибке не-`ENOENT` делать ретраи и падать с исключением (или бэкапить повреждённый файл `*.corrupt.<ts>`), никогда не перезаписывая существующий файл пустым состоянием.

- [ ] **P1.15. Несовместимость Fever API с составными запросами (`?api=1&...`)**
  - **Где:** `lib/fever.mjs:41, 83, 90, 120, 125, 130, 136`
  - **Проблема:** При `?api=1&groups&feeds&items` или `?api=1&unread_item_ids&mark=item&...` truthy-значение `api` вызывает ранний `return` на первой секции, отбрасывая остальные секции и операции `mark`/`save`.
  - **Исправление:** Считать одиночным режимом только конкретные имена команд из `Set`; выполнять блок записи (`isWrite`) **до** формирования `unread_item_ids`/`saved_item_ids`.

- [x] **P1.16. Экспоненциальный OOM DoS в `stripJunkBlocks`**
  - **Где:** `lib/readability.mjs:127-134, 152`
  - **Проблема:** При совпадении `JUNK_BLOCK` до первого `<` (`start === -1`) строка 133 выполняет `result = result.slice(0, -1) + result.slice(0)`, удваивая строку до 40 раз (`2^40` байт → OOM-краш).
  - **Исправление:** Проверять `if (start < 0) break;` (или сдвигать `lastIndex` вперёд), а при `end - start > JUNK_MAX_BYTES` продолжать поиск вместо `break`.
  - **Сделано (2026-11-27):** если `lastIndexOf('<')` вернул -1 (совпадение класса в тексте, а не в теге), цикл прерывается — раньше `slice(0, -1) + slice(0)` дублировал строку до 40 раз. Тест в `test/readability.test.mjs` (укладывается в 2 с, html не раздувается).


- [x] **P1.17. Необработанный `URIError` в `parseCookies`**
  - **Где:** `lib/auth.mjs:67`
  - **Проблема:** `Cookie: a=%E0%A4%A` бросает необработанный `URIError`.
  - **Исправление:** Обернуть `decodeURIComponent` в `try/catch`.
  - **Сделано (2026-11-27, коммит `01f74fc`):** `parseCookies` при битом проценте (`%zz`) оставляет значение как пришло вместо исключения; тест в `test/auth.test.mjs`. Проверено: запрос с `Cookie: rss_session=%zz` → `200`, служба жива.

- [ ] **P1.18. Расхождение памяти и диска при ошибке `save()` в `Users`**
  - **Где:** `lib/users.mjs:143-191`
  - **Проблема:** Мутирующие методы меняют `this.state.users` до `await this.save()` и не откатывают изменения при ошибке записи.
  - **Исправление:** Сохранять снимок и откатывать состояние в `catch` при сбое `this.save()`.

### Фронтенд и PWA (`public/*`)

- [ ] **P1.19. Фоновый `schedulePoll()` каждые 20 с стирает поля формы входа и ошибку**
  - **Где:** `public/app.js:373-376, 4552-4568, 5279-5304, 5337`
  - **Проблема:** Опрос запускается до авторизации; каждые 20 с приходит 401 → `showLogin()` очищает `#login-user`, `#login-pass`, `#login-error`.
  - **Исправление:** Не запускать `loadData` из таймеров при `!state.session?.authenticated` или открытом `#login-modal`; в `showLogin()` выходить, если модалка уже открыта.

- [ ] **P1.20. `api()` проглатывает HTTP 4xx/5xx при `payload.ok === false`**
  - **Где:** `public/app.js:377, 427, 4233, 4411-4416`
  - **Проблема:** Неверный текущий пароль при смене пароля показывает зелёный тост «Пароль изменён»; `flushSettings` теряет ошибку; `startSettingsRefresh` кладёт `undefined` в `state.settings`.
  - **Исправление:** Выбрасывать ошибку в `api()` при `!res.ok || payload.ok === false` (добавить опцию `{ raw: true }` только для вызовов вроде `/api/star` и `/api/login`, которым нужен разбор ответа).

- [ ] **P1.21. Гонки запросов в `switchView()`, `loadHistoryPage()` и `searchSubscriptions()`**
  - **Где:** `public/app.js:514-567, 1659-1749, 3926-3965`
  - **Проблема:** Нет монотонных токенов/`AbortController`: устаревшие ответы при быстром переключении лент сбрасывают скролл, снимают лоадер чужой ленты, портят `historyOffset`/`historyDone`, удаляют `addedByFeed` у новой ленты и перезаписывают `#add-candidates`.
  - **Исправление:** Добавить `viewToken` + `AbortController` в `switchView`/`loadHistoryPage` и `discoverSeq` + `AbortController` в `searchSubscriptions`.

- [ ] **P1.22. Потеря настроек в `flushSettings()` и бесконечный цикл ретраев в `ensureBodiesNeeded()`**
  - **Где:** `public/app.js:418-436, 2699-2728`
  - **Проблемы:**
    1. `Object.assign(pendingSettings.patch, patch)` перетирает свежие правки старым неудавшимся патчем, а изменения во время `busy` зависают без повторного запуска в `finally`.
    2. `state.bodyRetryCount = 0` стоит **до** `await api('/api/bodies')`, поэтому лимит `<= 3` никогда не достигается (бесконечный опрос каждые 3 с при ошибке).
  - **Исправление:** Делать `pendingSettings.patch = { ...patch, ...pendingSettings.patch }` и дозапускать `flushSettings()` в `finally`; перенести сброс `bodyRetryCount = 0` **после** успешного ответа.

- [ ] **P1.23. `patchCard()` и `patchComments()` не инициализируют слоты картинок и embed-плееры; горячие клавиши и утечки `EventSource`**
  - **Где:** `public/app.js:2127-2168, 3299-3353, 4552-4568, 4951-4965`
  - **Проблемы:**
    1. После `replaceWith(fresh)` в `patchCard`/`patchComments` не вызываются `holdImageSpace`, `setupImageSlots`, `markBrokenImages`, `layoutArticleImages`, `setupEmbeds`.
    2. Глобальный `keydown` не проверяет `ctrlKey/metaKey/altKey` и открытые модалки/лайтбокс (`Ctrl+R`/`Ctrl+S` перехватываются).
    3. `startEvents()` дублирует `document.addEventListener('error', ...)` при перелогине, а `showLogin()` не закрывает `EventSource`.
  - **Исправление:** Вызывать инициализаторы DOM в `patchCard`/`patchComments`; добавить проверку модификаторов и `.modal:not([hidden]), .lightbox:not([hidden])` в `keydown`; вынести `error`-слушатель из `startEvents` и закрывать `events` в `showLogin`.

- [ ] **P1.24. Проблемы Service Worker (`DATA_CACHE`, logout-очистка, перезапись `/index.html`)**
  - **Где:** `public/sw.js:150, 160-170, 191-203`, `public/app.js:4418-4422`
  - **Проблемы:**
    1. `DATA_CACHE` наполняется авторизованными данными через `warm`, но нигде не читается; при logout не чистятся `DATA_CACHE`/`MEDIA_CACHE` и `localStorage['rss.pendingRead']`.
    2. Навигационный обработчик кэширует в `/index.html` любой `fresh.ok` без проверки `pathname`, `!fresh.redirected` и `text/html`.
  - **Исправление:** При logout очищать `DATA_CACHE`/`MEDIA_CACHE` и `rss.pendingRead`; удалить мёртвый `DATA_CACHE`/`warm` (или реально подключить с allowlist); обновлять `/index.html` только для `/` и `/index.html` с `content-type: text/html` и `!fresh.redirected`.

### Инфраструктура, личные данные и тесты

- [ ] **P1.25. Личные данные в репозитории/коде, слабый дефолтный пароль деплоя и нулевое покрытие тестами ключевых модулей**
  - **Где:**
    - Отслеживаются git вопреки `.gitignore`: `bazqux-reader-subscriptions.xml`, `preview/article.png` → убрать через `git rm --cached`.
    - Личный домен/логин в коде: `lib/habr-now.mjs:21` (`rss.letsplay.today`), `public/admin.html:95` (`makushin`).
    - Дефолтный `ADMIN_PASS=admin` и печать пароля в stdout: `deploy/install.sh:85, 139`, `deploy/install-vps.sh:42, 141, 305` → генерировать случайный через `openssl rand -base64 16` при первой установке.
    - `deploy/install-vps.sh:107-110`: `cp -a` поверх без `rm -rf` оставляет удалённые файлы, не копирует `package.json` и не делает `node --check`.
    - **0% покрытия тестами:** `server.mjs`, `reader-core.mjs`, `lib/comments.mjs`, `lib/readability.mjs`, `lib/telegram.mjs`, `lib/fever.mjs`, `lib/xml.mjs`, `lib/traffic.mjs`, `lib/imagesize.mjs`. Написать приоритетные юнит-тесты (в первую очередь на `net-guard` IPv6, `readability` XSS/OOM, `comments` XSS, `fever` `?api=1`, `feed` RSS/Atom, `auth` cookies/sessionVersion, `store` гонки).

---

## P2 — Средний приоритет (логика, парсинг, производительность, UI/админка)

### Сервер и ядро

- [ ] **P2.1. `POST /api/read` принимает произвольные `ids`, вытесняя реальные отметки прочитанного (и `O(N²)`)**
  - **Где:** `reader-core.mjs:3514-3558`
  - **Исправление:** Принимать только существующие `id` (`findItem(id)`), ограничить размер массива `body.ids`, заменить `includes` на `Set`.

- [ ] **P2.2. `db.parserVersion` сбрасывает переразбор после первой же обновлённой ленты**
  - **Где:** `reader-core.mjs:886, 923`
  - **Исправление:** Хранить `feed.parserVersion` индивидуально на каждой ленте.

- [ ] **P2.3. Гонка `ETag` и кэша `/api/data` в `payloadBody` / `sendPayload`**
  - **Где:** `reader-core.mjs:3707-3759`
  - **Исправление:** Отдавать `ETag` из `body.revision`, а не текущего `db.revision`; пересобирать кэш при росте ревизии во время сжатия или смене `refreshing`.

- [ ] **P2.4. Виртуальная лента `habr-now` игнорируется в `POST /api/read`, `GET /api/items` и `GET /api/data?view=...`**
  - **Где:** `reader-core.mjs:3221, 3276, 3516`
  - **Исправление:** Включать `habrNowFeedView()` в список источников в этих трёх обработчиках.

- [ ] **P2.5. `serveMedia` (Telegram Bot): `fetch` без таймаута и неверный `Content-Type` для не-картинок**
  - **Где:** `reader-core.mjs:2827-2837`
  - **Исправление:** Добавить `AbortSignal.timeout(15000)`, проверять `r.ok`, использовать вычисленный `type` вместо `sniffImageType` для видео/документов.

- [ ] **P2.6. Гонки в `startTelegramBot` / `applyTelegramToken`**
  - **Где:** `reader-core.mjs:2172-2225`
  - **Исправление:** Проверять `botStopped` после каждого `await`, сбрасывать `botLoopRunning` в `finally`, прерывать `telegramGetUpdates` через `AbortController` в `stop()`, делать `await store.saveStateNow()` и сбрасывать `lastUpdateId` при смене токена.

- [x] **P2.7. `500` вместо `400`/`413` на битый ввод и утечка `chunks` в `readRawBody`**
  - **Где:** `server.mjs:84, 195-206`, `reader-core.mjs:1800-1810, 2259`
  - **Исправление:** Обернуть `decodeURIComponent` в `try/catch`; в `reader-core.mjs` выставлять `statusCode = 400/413` и проверять, что распарсенный JSON — не-null объект; при превышении лимита в `readRawBody` очищать `chunks` и снимать `data`-слушатель.
  - **Сделано (2026-11-27):** `readJson` возвращает 400 на битый JSON и на не-объект; `readBody`/`readRawBody` помечают переполнение как 413 и освобождают буферы; `handleRequest` в ядре отдаёт код из `err.statusCode`, а не всегда 500; `serveStaticFromPublic` и `serveVideo` больше не падают на `decodeURIComponent`. Проверено: `POST /api/read` с `{bad` → **400** «тело запроса не JSON», `GET /%zz` → **404** (было 500).


- [ ] **P2.8. `X-Forwarded-Proto` без проверки `isTrustedProxy` и отсутствие CSRF-проверки `Origin`/`Content-Type`**
  - **Где:** `server.mjs:754-756, 217-234`, `reader-core.mjs:1810`
  - **Исправление:** В `requestIsHttps` проверять `isTrustedProxy`; на браузерных `POST /api/*` проверять `Origin` или требовать `Content-Type: application/json`.

- [ ] **P2.9. Неограниченный рост `hostHits`/`iconCache`, лишнее чтение диска в `/api/admin/users`, мутация `db.folders`**
  - **Где:** `reader-core.mjs:372, 1462, 1873, 3183-3185`, `server.mjs:259-275`
  - **Исправление:** Ограничить `hostHits`, чистить `iconCache` и `fav-<id>.*` при удалении ленты; в `userStats` брать данные из уже поднятого ядра; в `toOpml` не сортировать `db.folders` на месте; в `POST /api/state` использовать `itemIndex()`.

### Библиотеки (`lib/*.mjs`)

- [ ] **P2.10. Баги парсинга RSS/Atom в `lib/feed.mjs`**
  - **Где:** `lib/feed.mjs:26-34, 86-94, 194, 207, 213`
  - **Проблемы:**
    1. `htmlToText` сначала декодирует сущности, затем режет `<...>`, уничтожая `std::vector&lt;int&gt;`.
    2. `child(node, 'link')` берёт `<atom:link>` вместо `<link>` → пустые `siteUrl` и `item.link`.
    3. `child(item, 'comments')` берёт URL `<comments>` вместо числа `<slash:comments>` → `commentsCount: null`.
    4. Atom `<content type="text">` с `<tag>` трактуется как сырой HTML без экранирования.
  - **Исправление:** Удалять теги до `decodeHtmlEntities`; для RSS `<link>` и `<slash:comments>` учитывать точное имя тега/namespace; экранировать `type="text"`.

- [ ] **P2.11. Мутация счётчика ID в `lib/fever.mjs` при `mark=group` для лент без папки**
  - **Где:** `lib/fever.mjs:183`
  - **Исправление:** Не вызывать `ctx.folderNum({})` для отсутствующей папки — проверять `folder` заранее.

- [ ] **P2.12. Баги HTML-парсинга в `lib/readability.mjs`**
  - **Где:** `lib/readability.mjs:216-225, 400-404`
  - **Исправление:** В `matchingDivEnd` сравнивать `m[0].toLowerCase() === '</div>'`; в fallback `entry-content` использовать `matchingDivEnd`; выделить `<img\b[^>]*>` в отдельную ветку регулярки.

- [ ] **P2.13. Ослабленная проверка домена в `comments.mjs`/`telegram.mjs` и баги парсинга LJ/Telegram**
  - **Где:** `lib/comments.mjs:351-354, 441, 454, 465, 488`, `lib/telegram.mjs:15, 66-79, 151-156, 190-195, 286`
  - **Исправление:** Проверять `new URL(link).hostname` вместо regex по всей строке (`not-t.me` не должен матчиться); в `ljCommentsJson` искать `"comments"\s*:\s*\[` и определять `hasMore` по реальной следующей странице; в `telegram.mjs` чистить HTML через allowlist, экранировать `src`/`poster`, не дублировать текст цитаты при `mainIndex < 0` и сортировать закрывающие entities в LIFO-порядке.

- [ ] **P2.14. Защита от Path Traversal в `Store`/`userDir`, утечка `liveStores`, гонка `removeFeed`**
  - **Где:** `lib/store.mjs:43, 74, 121, 241, 291, 299, 365, 381-387`, `lib/users.mjs:217`
  - **Исправление:** Валидировать `feedId`/`userId` по `/^[A-Za-z0-9_-]{1,64}$/`; добавить `Store.close()`; ставить `unlink` в `removeFeed` в `this.writeQueues`.

- [ ] **P2.15. Блокирующий `scryptSync` без лимита длины пароля и сломанный Fever-ключ при `Users.rename`**
  - **Где:** `lib/auth.mjs:11, 20`, `lib/users.mjs:12, 121-124, 176-185`
  - **Исправление:** Перейти на асинхронный `scrypt`, ограничить длину пароля (8–128 символов); при `rename` обновлять/сбрасывать `apiKey`.

- [ ] **P2.16. Переполнение стека в `lib/xml.mjs` и падение `trackTraffic` на `res.end(cb)`**
  - **Где:** `lib/xml.mjs:54-117, 140-165`, `lib/traffic.mjs:49-56`
  - **Исправление:** Ограничить глубину вложенности в `parseXml` (`MAX_DEPTH = 128`); в `trackTraffic` проверять `typeof chunk !== 'function'` и учитывать `encoding`.

### Фронтенд (`public/app.js`, `style.css`, `index.html`, `admin.*`)

- [ ] **P2.17. `refreshFeeds()` обрывает ожидание через 2 с; `toggleStar()` не откатывается при сетевой ошибке**
  - **Где:** `public/app.js:3120-3184, 3196-3201`
  - **Исправление:** Убрать `|| !check.started` из условия выхода; вынести откат звезды в `rollback()` и вызывать его в `catch`.

- [ ] **P2.18. Краши DOM/рендера: неэкранированный `id` в `markCommentsSeen`, `decodeURIComponent` в `bodyHtml`, отсутствующие проверки на `null` и `localStorage`**
  - **Где:** `public/app.js:340-341, 1288-1291, 1575, 3262, 3271, 3540, 3550, 3797-3798, 4067-4071, 4401-4405, 4904, 5196-5197`, `public/admin.js:175, 180`
  - **Исправление:** Использовать `cssId(id)` на строке 1575; обернуть `decodeURIComponent` и все обращения к `localStorage`/`sessionStorage` в `try/catch`; добавить проверки `if (!item/feed/folder) return`, `try/catch` в `#set-fetch-full` и проверку `res.ok` в `#opml-file`.

- [ ] **P2.19. Баги UI-состояния: пустое дерево в `renderSidebar`, потерянный класс `.floating`, скрытие медленных картинок через 3 с, утечка `dragScrollTimer` и гонки `askConfirm`/`askPrompt`**
  - **Где:** `public/app.js:34-95, 965-968, 1987-2011, 2476-2500, 3659-3668`
  - **Исправление:** Проверять пустоту дерева до добавления `.tree-tail`; добавлять `.floating` при `position = 'fixed'`; не ставить `.broken` по 3-секундному таймауту (только по `error`) и вешать `{ once: true }`; вызывать `stopDragScroll()` на `#drop-hint`; добавить `Escape` в `askConfirm` и отмену предыдущего промиса при повторном открытии модалки.

- [ ] **P2.20. Мобильная вёрстка и жесты**
  - **Где:** `public/app.js:5113-5139`, `public/style.css:891-893, 966-971, 1064, 1080, 1234, 1491-1496`, `public/index.html:5, 15`
  - **Проблемы:**
    1. Свайпы срабатывают поверх модалок/лайтбокса и горизонтальных `<pre>`/`<table>`.
    2. `#prompt-modal #prompt-input` перебивает `font-size: 16px` на iOS (авто-зум).
    3. `.head-tools` скрыт на `<= 900px` без способа открыть поиск/фильтры/сортировку.
    4. Нет `viewport-fit=cover` и `env(safe-area-inset-top)` при `black-translucent` статус-баре.
    5. `.a-head { padding-right: 46px }` на `<= 900px` перебивает `50px` для `<= 560px`/`coarse`.
  - **Исправление:** Игнорировать свайпы при открытых модалках и внутри прокручиваемых элементов; поднять `font-size` у `#prompt-input` на `pointer: coarse`; вернуть доступ к поиску/фильтрам на мобильном; добавить `viewport-fit=cover` и safe-area отступ; выровнять порядок медиа-запросов `.a-head`.

- [ ] **P2.21. Дефекты админки (`admin.html` / `admin.js`)**
  - **Где:** `public/admin.js:88-126, 151-166`, `public/admin.html:78-105, 121`
  - **Проблемы:** Ошибка загрузки при скрытой `#panel` пишется в скрытый `#users-msg`; на 403 стирается класс `err` у `#login-msg`; нет `disabled` на кнопках при запросах (двойной клик); нет `<form>` и Enter на полях логина; остались 4 нативных `prompt()`/`confirm()` (`admin.js:106, 110, 116, 117`).
  - **Исправление:** Показывать ошибки старта в видимом контейнере; передавать `'err'` на 403; блокировать кнопки на время `fetch`; обернуть логин и создание пользователя в `<form>`; заменить `prompt`/`confirm` на встроенные модалки.

### Инфраструктура и конфиги

- [ ] **P2.22. Расхождение дефолтов хранения между `README.md` и скриптами деплоя**
  - **Где:** `deploy/install.sh:101-102`, `deploy/install-vps.sh:145-146` (`1500` / `30` дн.) vs `README.md:329, 337-338` (`3000` / `14` дн.)
  - **Исправление:** Привести значения к единому источнику правды.

- [ ] **P2.23. Фиктивный тест `test/habr-now-meta.test.mjs` и узкий `npm run check`**
  - **Где:** `test/habr-now-meta.test.mjs:5-17`, `package.json:14`
  - **Исправление:** Импортировать реальную логику из рабочего модуля вместо копипасты функции в тест; расширить `npm run check` на все `lib/*.mjs` и `tools/*.mjs`.

- [ ] **P2.24. `deploy/nginx.conf.example` и `deploy/install-vps.sh` (SSE timeout и `curl`)**
  - **Где:** `deploy/nginx.conf.example:24-37`, `deploy/install-vps.sh:277, 280`
  - **Исправление:** Выделить `location /api/events` с `proxy_read_timeout 3600s; proxy_buffering off;`; добавить `--max-time 15` в `curl` внутри `verify()`.

---

## P3 — Низкий приоритет (a11y, граничные случаи, мёртвый код, техдолг)

- [ ] **P3.1. `lib/imagesize.mjs`: выход за границы буфера в WebP `VP8X` и ошибки JPEG-маркеров**
  - **Где:** `lib/imagesize.mjs:7, 11, 17-32, 39-43`
  - **Исправление:** Проверять `buf.length >= 30` для `VP8X`/`VP8 ` и `>= 25` для `VP8L`; в JPEG обрабатывать `0xFF 0xFF`, `0xDA`/`0xD9` и standalone-маркеры; в PNG проверять `width > 0 && height > 0`.

- [ ] **P3.2. `lib/habr-now.mjs`: неверный порядок очистки устаревшего кэша и fallback**
  - **Где:** `lib/habr-now.mjs:160-175`
  - **Исправление:** Сбрасывать устаревший кэш (`KEEP_STALE_MS`) **до** ветки fallback `if (!state.items.length)`.

- [ ] **P3.3. `lib/xml.mjs`: потеря пробельных узлов, закрытие void-тегов (`<br></br>`) и `DOCTYPE` с `[...]`**
  - **Где:** `lib/xml.mjs:64, 69, 89-93, 159-162`
  - **Исправление:** Сохранять пробельные узлы между элементами; не закрывать HTML void-элементы; экранировать `&` в атрибутах.

- [ ] **P3.4. Мелкие утечки ресурсов и недочёты в `lib/*`**
  - **Где:** `lib/traffic.mjs:21-24` (удалять `.tmp` в `catch`), `lib/net-guard.mjs:117-122` и `lib/habr-now.mjs:117-118` (вызывать `response.body?.cancel()` и чистить `Authorization`/`Cookie` при смене origin), `lib/telegram.mjs:227-255, 321` (валидировать токен, не светить его в ошибках, брать `post.text` без HTML-сущностей), `lib/auth.mjs:45` (проверять `parts.length === 2`), `lib/comments.mjs:480-497` (мёртвая ветка `mobile-review.com`), `lib/readability.mjs:175` (квадратичный regex).

- [ ] **P3.5. Доступность (a11y) в `public/index.html` и `public/admin.html`**
  - **Где:** `public/index.html:26-27, 76, 105, 114-212, 524-589`, `public/admin.html:69, 86, 105, 121`, `public/app.js:1828-1831`
  - **Исправление:** Добавить `role="dialog"`, `aria-modal="true"`, `aria-labelledby` и возврат фокуса для модалок; `aria-label` на кнопки-иконки и `<select>`; `role="status"`/`role="alert"` на `#toast`, `#login-error`, `.msg`.

- [ ] **P3.6. Мёртвый код и рассинхрон селекторов во фронтенде и SW**
  - **Где:** `public/style.css:1132`, `public/app.js:1632-1633, 2309, 2319, 5064, 5171, 5195-5200`, `public/sw.js:15-27, 67-70, 118-134, 152`
  - **Исправление:** Удалить мёртвые `#settings-version` и `#menu-update`; убрать двойное экранирование `trafficTitle` (строка 2319); оставить один `scroll`-слушатель `trackCommentsProgress` (на `#list`); удалить `staleWhileRevalidate` и недостижимый `isVideo` в `sw.js`; добавить `/icon-maskable-512.png` в `SHELL`; ограничить размер `MEDIA_CACHE`; сбрасывать `rss.reloaded` и не перезагружать страницу при самой первой установке SW.

- [ ] **P3.7. Мёртвый код и мелкие недочёты в `server.mjs` и `reader-core.mjs`**
  - **Где:** `server.mjs:37-38, 111, 479`, `reader-core.mjs:70-75, 1932, 2849-2876, 2917-2946, 2958-2961`
  - **Исправление:** Удалить дублирующие маршруты авторизации в `reader-core.mjs`, неиспользуемые переменные (`FIELD_PASS`, `FIELD_KEY`, `coreErrors`, `startedAt`/`values`/`filled`); поменять `public` на `private` в `serveFavicon:1932`; запретить `.`/`..` в ACME-имени.

- [ ] **P3.8. Утилиты `tools/*` и кодировка `start.cmd`**
  - **Где:** `tools/fix-encoding.mjs:26-28`, `tools/measure-article.mjs:6-8, 68`, `tools/cdp-traffic.mjs:5, 17-20`, `tools/bump-version.mjs`, `start.cmd`
  - **Исправление:** Добавить проверку аргументов в `fix-encoding.mjs` и `measure-article.mjs`, исправить `height: none` → `height: auto`; почистить ad-hoc пробы в `cdp-traffic.mjs`; перевести `start.cmd` в CRLF (или убрать кириллицу из `rem`).

- [ ] **P3.9. Гигиена репозитория: архивация 7 устаревших TODO/AUDIT-файлов в корне**
  - **Где:** `TODO_231126.md`, `TODO-verified-2026-11-23.md`, `TODO_2026-11-24.md`, `TODO-plan-2026-11-24.md`, `TODO-css-2026-11-25.md`, `CSS_AUDIT_REPORT.md`, `RENDER-AUDIT-2026-11-27.md`
  - **Статус:** `CSS_AUDIT_REPORT.md`, `TODO-css-2026-11-25.md` и `RENDER-AUDIT-2026-11-27.md` полностью закрыты; `TODO_231126.md`, `TODO-verified-2026-11-23.md`, `TODO_2026-11-24.md` и `TODO-plan-2026-11-24.md` устарели или перекрыты этим документом.
  - **Исправление:** Перенести исторические отчёты в `docs/archive/` (и исключить `docs/archive/` из `tools/publish.ps1`), оставив этот `TODO.md` единственным актуальным трекером.

- [ ] **P3.10. Архитектурный техдолг (из прошлых планов, остаётся открытым)**
  - Заменить опрос SSE `setInterval(..., 1000)` (`server.mjs:442`) на event-driven подписку от `Store`.
  - Перевести `reader-core.mjs` (4 203 строки) с динамического `import('./reader-core.mjs?u=...')` на класс `UserReader` и разбить на модули.
  - Разбить `public/app.js` (5 666 строк) на ES-модули.

---

## Рекомендуемый порядок исправления (итерации)

1. **Итерация 1 — Экстренная безопасность и утечки (P0.1–P0.5, P0.10):** сменить пароль VPS и убрать `rus-host.txt`/`bazqux-*.xml`/`preview/` из git; закрыть краш на `new URL`; перевести `httpGetOnce`/`httpGetBinary` на `safeFetch`; исправить IPv6 в `net-guard.mjs`; закрыть XSS в медиа-прокси; добавить `sessionVersion`.
2. **Итерация 2 — XSS-санитайзеры на сервере и клиенте (P0.6–P0.9):** allowlist-санитайзер в `readability.mjs`, `comments.mjs`, `telegram.mjs` и `public/app.js`; проверка протоколов в `setupEmbeds` и `item.link`.
3. **Итерация 3 — Целостность данных и надёжность бэкенда (P1.1–P1.18):** починить `Store` гонки и защиту от перезаписи `users.json`/`state.json`, Basic Auth, `disable→enable`, `newestKnown`, `cleanStoredBodies`, `serveVideo` pipeline, лимит `cwebp`, SSE-утечки, `graceful shutdown`, `fever.mjs`, `stripJunkBlocks` OOM, `parseCookies`.
4. **Итерация 4 — Стабильность фронтенда и PWA (P1.19–P1.24, P2.17–P2.21):** остановить сброс формы входа, починить `api()` ошибки, токены отмены в `switchView`/`loadHistoryPage`/`searchSubscriptions`, `flushSettings`, `ensureBodiesNeeded`, `patchCard`/`patchComments`, горячие клавиши, `sw.js`, мобильную вёрстку и админку.
5. **Итерация 5 — Парсинг, деплой и автотесты (P0.11–P0.12, P1.25, P2.1–P2.16, P2.22–P2.24):** починить `install-vps.sh` и `publish.ps1`, баги `feed.mjs`/`readability.mjs`/`comments.mjs`/`telegram.mjs`/`xml.mjs`, дописать тесты на все критичные модули и расширить `npm run check`.
6. **Итерация 6 — Полировка и гигиена (P3.1–P3.10):** a11y, мёртвый код, `imagesize`/`habr-now`, архивация старых TODO, архитектурный рефакторинг.
