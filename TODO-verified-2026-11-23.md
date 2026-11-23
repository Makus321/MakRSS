# Проверка аудита TODO.md — 23.11.2026

Исходный файл `TODO.md` не изменялся. Это отдельный документ: построчная проверка
каждого пункта по фактическому коду (состояние репозитория: `app.js?v=330`,
`style.css?v=190`, `sw.js` = `rss-shell-v294`).

Обозначения: **ПОДТВ** — проблема есть в коде, **НЕТ** — не подтверждается,
**ЧАСТИЧНО** — суть верна, детали другие.

## P0 — итоги проверки

| Пункт | Статус | Где подтверждено |
|---|---|---|
| P0.1 `feed is not defined` в `GET /api/item` | **ПОДТВ** | `reader-core.mjs:3037,3043` — `String(feed?.kind …)`, переменная `feed` в этой функции не объявлена (в модуле её тоже нет) → `ReferenceError` → HTTP 500 |
| P0.2 `__dirname` в `loadVersion()` | **ПОДТВ** | `reader-core.mjs:124` в `.mjs`; исключение глотается `catch` → `APP_VERSION` остаётся `1.0.0` |
| P0.3 Потеря метаданных при старте (`META_FIELDS`) | **ПОДТВ** | `lib/store.mjs:19-21` список полей; `:138` `map(stripMeta)` при загрузке. В списке нет `addedAt`, `video`, `commentsSeenMaxId`, `commentsSeenCount`, `commentsSeenAt`, `coverTriedAt`, а `reader-core.mjs:517-532` их пишет |
| P0.4 Конфликт `SIGINT`/`SIGTERM` | **ПОДТВ** | `lib/store.mjs:48-49` свои обработчики с `process.exit(0)`; `saveStateNow` пишет только `state.json`, `dirtyFeeds` не сохраняет. `server.mjs:656-668` свой graceful shutdown с `mod.shutdown()` и `store.flush()` (`lib/store.mjs:299`) |
| P0.5 Порча HTML при обрезке | **ПОДТВ** | `lib/store.mjs:251-252` — `safe + 6` независимо от длины найденного тега |
| P0.6 Фиксированный `.tmp` и двойной `revision` | **ПОДТВ** | `lib/store.mjs:171` `${file}.tmp`; `:154` и `:160` — инкремент в обоих методах |
| P0.7 `deploy/install.sh` | **ПОДТВ** | `deploy/install.sh:55-60` — нет `reader-core.mjs`, `public/*` без подкаталогов (`public/fonts/`) |
| P0.8 Комментарии `ixbt.games` | **НЕТ** | `lib/comments.mjs:246-247` уже через `new URL(link).hostname` и `(ixbt\.com|ixbt\.games)` |
| P0.9 Битый HTML `#set-density` | **ПОДТВ** | `public/index.html:271-275` — `<select id="set-density">` без открывающего `<label class="row-line">`, закрывающий `</label>` есть |
| P0.10 Конфликт `searchSubscriptions` / `checkAddress` | **ПОДТВ** | `public/app.js:3664` `#add-check` → `checkAddress()` (`:3586`) рисует `<label><input type="checkbox" data-cand=…>`; `subscribeSelected()` (`:3614`) ищет `.cand.active` → подписка невозможна |
| P0.11 Настройки ленты не применяются сразу | **ПОДТВ**, уточнение | `reader-core.mjs:2793-2812` отдаёт только `{ok, revision}`; клиент `applyPayload(…)` (`app.js:3378,3679`) без данных ничего не меняет. Применяется лишь на следующем опросе `/api/data`, т.е. «до 20 секунд», а не «до перезагрузки» |
| P0.12 Нет `restoreView()`/`startEvents()` после входа | **ПОДТВ** | вызовы только в `start()` (`app.js:4735,4737`); в `submitLogin()` нет; слушатели лайтбокса внутри `startEvents()` → после ручного входа не работают |
| P0.13 `counts.unread` | **ПОДТВ** | `reader-core.mjs:2871` — `allItems - Object.keys(db.read).length` |
| P0.14.1 Тост по `m` | **ПОДТВ** | `app.js:2976` — `markRead()` мутирует `item.read` (`:2655`) до `.then(...)` |
| P0.14.2 `#filters-btn` | **ПОДТВ** | `app.js:913` `if (!query) return;` раньше `:920` обновления счётчика |
| P0.14.3 `onerror` миниатюры | **ПОДТВ** | `app.js:1538` — `this.src = thumbSource`, то есть тот же адрес |
| P0.14.4 Интервал опроса | **ПОДТВ** | `app.js:4752` — `feverMode() ? 60_000 : 20_000` вычисляется при создании интервала |
| P0.14.5 `commentsOnly` без `expandItem` | **ПОДТВ** | `app.js:2493` `showCommentsOnly()` не вызывает `expandItem` |
| P0.14.6 Нет защиты от параллельного `flushPendingReads` | **ПОДТВ** | флага `flushingReads` в коде нет |
| P0.15.1 `isData` для `POST /api/bodies` | **ПОДТВ** | `public/sw.js:52,104` — не-GET отсекается раньше ветки `:117` |
| P0.15.2 `?v=` и `cache.match` без `ignoreSearch` | **ПОДТВ** | `SHELL` (`sw.js:15-25`) содержит `/app.js`, `/style.css`; `index.html:8,558` просит `?v=190` / `?v=330` |
| P0.15.3 Неиспользуемые `negativeCache` / `staleWhileRevalidate` | **ПОДТВ** | объявлены `sw.js:61,84`, вызовов нет |

## P1 — итоги проверки

| Пункт | Статус | Где подтверждено |
|---|---|---|
| P1.1 SSRF | **ПОДТВ** | `isPublicUrl()` (`reader-core.mjs:2128`) применяется только в двух местах (`:1982`, `:2284`); `fetch(..., redirect: 'follow')` — `:323,1569,2239,2244`; `httpGet`/`serveThumb`/`serveMedia` без проверки |
| P1.2 Path Traversal в `serveMedia()` | **ПОДТВ** | `reader-core.mjs:2330-2332` имя файла = `'tg-' + feedId + '-' + itemId + '-' + index + '.img'` без валидации; `:2440` `path.join(MEDIA_DIR, …)` |
| P1.3 Смена пароля без текущего | **ПОДТВ** | `server.mjs:545` — `if (current && !users.verify(...))` |
| P1.4 XSS | **ПОДТВ** (выборочно) | инлайн `onerror` в `app.js:693,1538`; остальные адреса нужно проверять при правке |
| P1.5 Аутентификация | **ПОДТВ** | `lib/users.mjs:74` сравнение `u.apiKey === needle`; `lib/auth.mjs:72-77` `cookieHeader` без `Secure`; на `/api/login` только `setTimeout(350)` (`server.mjs:518`), rate-limit нет |
| P1.6 Личные данные в скриптах | **не проверял детально** | требует отдельного прохода по `deploy/*`, `tools/*` |

## P2 — итоги проверки (выборочно, по коду)

| Пункт | Статус | Где подтверждено |
|---|---|---|
| P2.1 Динамический `import(...?u=)` на пользователя | **ПОДТВ** | `server.mjs:93` |
| P2.2 Telegram-цикл не останавливается | **ПОДТВ** | `reader-core.mjs:1898` `while (true)`, флага `stopped` нет |
| P2.3 `apiLog` пишет на диск | **ПОДТВ** | `reader-core.mjs:2513-2524` — `DATA_DIR/api-log.txt`, без ротации |
| P2.4 Кэш медиа | **ПОДТВ** | `pruneMediaCache()` вызывается только из `:2094`; `compressToWebp` (`:2156-2180`) пишет `${baseFile}.src` и сразу `.webp`, при неудаче файл остаётся |
| P2.7 SSE-поллинг 1 с | **ПОДТВ** | `server.mjs:386` |
| P2.8 BOM в `lib/traffic.mjs` | **ПОДТВ** | первые байты файла: `EF BB BF` |
| P2.9.4 Анонимная статика поднимает ядро админа | **ПОДТВ** | `server.mjs:592-597` |
| P2.10 `scroll-diag.*` не подключены, observer без `disconnect` | **ПОДТВ** | файлы есть, в `index.html` не упоминаются; `scroll-diag.js:62` создаёт `MutationObserver` без отключения |
| P2.5, P2.6 | **не проверял построчно** | оценка объёма работ отдельно |

## P3/P4

Архитектурные пункты (P3.1-P3.6) и P4 — это плановые работы, не баги; отдельно
подтверждено только `P3.6` частично: `.a-thumb` объявлен 3 раза (`style.css:551,557,1093`),
а не 6, как в аудите.

## Новое, чего в аудите нет

1. **`addedAt` теряется при каждом перезапуске сервера** (следствие P0.3). Это объясняет,
   почему счётчик «(+N)» в дереве вёл себя странно: после рестарта у старых статей
   пропадало время появления.
2. `GET /api/version` перечитывает `index.html` с диска при каждом запросе
   (`refreshVersion()` → `loadVersion()`); после исправления P0.2 стоит кэшировать по `mtime`.
3. `store.flush()` существует (`lib/store.mjs:299`), но из обработчиков сигналов
   `lib/store.mjs` не вызывается вовсе — тела статей теряются даже без гонки.

---

# План исправлений (мой TODO)

Порядок — по риску и по цене. Каждая группа — отдельный деплой с проверкой.

## Итерация 1. Быстрые и безопасные исправления (6 правок, ~30 минут)

- [ ] **T1.1** `reader-core.mjs:3037,3043` — `feed?.kind` → `found.feed?.kind` (P0.1, HTTP 500).
- [ ] **T1.2** `reader-core.mjs:124` — `__dirname` → `PUBLIC_DIR`; версию кэшировать по `mtimeMs` (P0.2).
- [ ] **T1.3** `public/index.html:271` — вернуть `<label class="row-line">Плотность списка` (P0.9).
- [ ] **T1.4** `app.js:2976` — сохранять `const nextRead = !item.read` до `markRead` (P0.14.1).
- [ ] **T1.5** `app.js:913-920` — обновление `#filters-btn` выше `if (!query) return;` (P0.14.2).
- [ ] **T1.6** `app.js:1538` — убрать бессмысленный `onerror`-fallback, скрывать битую миниатюру (P0.14.3).

## Итерация 2. Потеря данных при перезапуске (3 правки, требует проверки на сервере)

- [ ] **T2.1** `lib/store.mjs:19-21` — дополнить `META_FIELDS`: `addedAt`, `video`, `commentsSeenMaxId`, `commentsSeenCount`, `commentsSeenAt`, `coverTriedAt` (P0.3). Проверить: до/после `systemctl restart` поля сохраняются.
- [ ] **T2.2** `lib/store.mjs:48-49` — удалить обработчики сигналов и `process.exit(0)`; в `server.mjs:656` при остановке вызывать `store.flush()` **и** `saveStateNow({bump:false})` для всех ядер (P0.4). Проверить: правка статьи → `restart` → текст и отметки на месте.
- [ ] **T2.3** `lib/store.mjs:251-252` — резать по `index + tag.length` найденного тега (P0.5).

## Итерация 3. Целостность записи и счётчики (4 правки)

- [ ] **T3.1** `lib/store.mjs:171` — уникальные имена `.tmp` (`${file}.${pid}.${seq}.tmp`) + сериализация записи через `Promise`-цепочку (P0.6).
- [ ] **T3.2** `lib/store.mjs:154/160` — инкремент `revision` в одном месте (P0.6). Проверить, что клиент не перестал замечать изменения.
- [ ] **T3.3** `reader-core.mjs:2871` — `counts.unread` как сумма непрочитанных по существующим статьям (P0.13).
- [ ] **T3.4** `app.js:3378,3679,4573,3369` — оптимистично менять `feed.sort/lines/imagesOnly` и `state.revision` (P0.11).

## Итерация 4. Клиент: вход, офлайн, комментарии, SW (5 правок)

- [ ] **T4.1** `app.js` — общая `afterAuthInit()`: `restoreView()` + `startEvents()`; слушатели лайтбокса вынести в `start()` (P0.12).
- [ ] **T4.2** `app.js:4752` — адаптивный `setTimeout`-цикл опроса с перечитыванием `feverMode()` (P0.14.4).
- [ ] **T4.3** `app.js:2493` — `showCommentsOnly()` вызывает `expandItem()` (P0.14.5).
- [ ] **T4.4** `app.js:2580` — флаг `flushingReads` и повторный запуск при новых отметках (P0.14.6).
- [ ] **T4.5** `public/sw.js` — `ignoreSearch: true` для оболочки, `negativeCache` для `/api/favicon`, убрать мёртвую ветку `isData` (P0.15).

## Итерация 5. Окно добавления подписки (1 правка, UX)

- [ ] **T5.1** `app.js:3586-3674` — убрать `checkAddress()`, оставить живой поиск; `Enter`/«Добавить»: есть `.cand.active` → подписка, иначе поиск (P0.10).

## Итерация 6. Безопасность (по возрастанию объёма)

- [ ] **T6.1** `reader-core.mjs:2434-2440` — валидировать `f`/`k` шаблоном `/^[A-Za-z0-9_-]{1,64}$/` + проверка `path.resolve(...).startsWith(MEDIA_DIR)` (P1.2).
- [ ] **T6.2** `server.mjs:545` — обязательная проверка текущего пароля (P1.3).
- [ ] **T6.3** `lib/users.mjs:74` `safeEqual`; `lib/auth.mjs` `Secure` при HTTPS; не логировать пароль; rate-limit на `/api/login` по IP (P1.5).
- [ ] **T6.4** XSS: экранирование в `lib/telegram.mjs`, проверка схемы в `embedLink()`, `esc(title)` в подвале, замена инлайн `onerror` на делегированные слушатели, `CSS.escape` для id (P1.4).
- [ ] **T6.5** единый `safeFetch()`: резолв IP, блок приватных диапазонов, ручные редиректы ≤5 с повторной проверкой; применить в `httpGet`, `serveThumb`, `serveMedia`, `cachePostMedia` (P1.1). Отдельная итерация с тестами.

## Итерация 7. Производительность и чистка

- [ ] **T7.1** Удалить `apiLog()`/`API_LOG_FILE` и шумные `console.log` в `serveMedia()` (P2.3).
- [ ] **T7.2** `pruneMediaCache()` во всех точках записи; атомарный `.webp.tmp` с удалением при неудаче; `Content-Type` по magic bytes (P2.4).
- [ ] **T7.3** Остановка Telegram-бота (`AbortController` + флаг), таймауты и лимит размера во всех `fetch()` (P2.2, P2.5).
- [ ] **T7.4** `Map`-индексы `itemIndex` на сервере и `itemsById/feedsById` на клиенте (P2.6).
- [ ] **T7.5** SSE по событиям вместо 1-секундного опроса; убрать лишние `render()` в `switchView`; статика без поднятия ядра админа; `cleanupVersion` (P2.7, P2.9).
- [ ] **T7.6** BOM в `lib/traffic.mjs`/`.gitignore`/`publish.ps1`; нормализация неизвестных маршрутов в `OTHER`; судьба `scroll-diag.*` (P2.8, P2.10).

## Итерация 8. Архитектура и инфраструктура (долгий горизонт)

- [ ] **T8.1** Класс `UserReader` вместо `import(?u=)`, вынос `lib/http.mjs`, `lib/media.mjs`, `lib/sync.mjs`, `lib/fulltext.mjs`, `lib/api.mjs` (P2.1, P3.1-P3.3).
- [ ] **T8.2** Декомпозиция `public/app.js` на модули `public/js/*` (P3.4).
- [ ] **T8.3** Кастомные `askPrompt()`/`askConfirm()` вместо нативных диалогов (P3.5).
- [ ] **T8.4** Ревизия `style.css`: дубли, конфликтующие медиа-запросы, мёртвые классы (P3.6).
- [ ] **T8.5** `deploy/install.sh`: копировать `reader-core.mjs`, `cp -a` для `lib/` и `public/` (P0.7).
- [ ] **T8.6** Автоверсионирование `?v=`/`rss-shell-vN` (P4.2), `package.json` + тесты `node --test` (P4.4), актуализация `README.md` (P4.3), удаление мёртвого кода и `tools/patch/*` (P4.1), перенос персональных данных из скриптов (P1.6).
