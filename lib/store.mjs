// Хранилище читалки, разделённое на две части:
//   state.json          — папки, ленты, метаданные статей, прочитано/избранное (маленький, пишется часто)
//   content/<feed>.json — тела статей (большие, пишутся только при изменениях и читаются по требованию)
// Такое разделение позволяет хранить полные тексты статей, не переписывая весь
// файл состояния на каждое действие и не держа всё в памяти.

import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

// Предел сохранённого HTML статьи (символов). Больше — обрезаем.
const BODY_LIMIT = Number(process.env.BODY_LIMIT || 200000);


const EMPTY_STATE = () => ({ version: 2, folders: [], feeds: [], items: {}, read: {}, starred: {}, lastRefresh: null });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Поля статьи, которые живут в state.json (без тел). */
// Поля статьи, которые живут в state.json (без тел). Всё, чего здесь нет,
// при загрузке состояния ВЫБРАСЫВАЕТСЯ (stripMeta), поэтому список должен
// включать каждое поле, которое пишет reader-core.mjs.
const META_FIELDS = [
  'id', 'title', 'link', 'date', 'author', 'excerpt', 'image', 'categories',
  'hasFull', 'fullTriedAt', 'contentLength', 'n', 'messageId', 'imageFileId',
  'commentsCount', 'commentsCountAt',
  // Время появления статьи: по нему считается «(+N)» в дереве.
  'addedAt',
  // Ссылка на видео из постов Telegram.
  'video',
  // Отметки прочитанных комментариев.
  'commentsSeenMaxId', 'commentsSeenCount', 'commentsSeenAt',
  // Когда последний раз пытались достать обложку (защита от повторов).
  'coverTriedAt',
];

const stripMeta = (item) => {
  const meta = {};
  for (const field of META_FIELDS) if (item[field] !== undefined) meta[field] = item[field];
  return meta;
};

/** Все открытые хранилища: нужны, чтобы при остановке службы дописать состояние. */
const liveStores = new Set();
let writeSeq = 0;               // счётчик для уникальных имён временных файлов

// Аварийное сохранение всех хранилищ: state.json И тела статей (content/*.json).
// Раньше здесь были собственные обработчики SIGTERM/SIGINT с process.exit(0),
// которые сохраняли только состояние, обрывали остановку в server.mjs и теряли
// несохранённые тела статей. Останавливает процесс только server.mjs.
export async function flushAllStores() {
  for (const store of liveStores) {
    try {
      await store.flush({ bump: false });
    } catch { /* при остановке важнее не мешать остальным */ }
  }
}
export class Store {
  constructor(dataDir, log = () => {}, options = {}) {
    this.dataDir = dataDir;
    this.writeQueues = new Map();   // file -> Promise: очередь записи на каждый файл
    this.feedLoads = new Map();     // feedId -> Promise загрузки: защита от гонки чтения
    this.contentDir = path.join(dataDir, 'content');
    this.stateFile = path.join(dataDir, 'state.json');
    this.legacyFile = path.join(dataDir, 'db.json');
    this.log = log;
    this.state = EMPTY_STATE();
    // Ленты без подписки (витрина «Читают сейчас»): их статьи живут в state.items,
    // но самой ленты в state.feeds нет — иначе чистка ниже их бы удаляла.
    this.virtualFeeds = new Set(options.virtualFeeds ?? []);
    this.openFeeds = new Map();   // feedId -> Map(itemId -> body)
    this.dirtyFeeds = new Set();
    this.feedTimers = new Map();
    this.stateTimer = null;
    liveStores.add(this);
    this.maxOpenFeeds = 12;
  }

  /**
   * Читает state.json с повторами. Файл может быть занят синхронизацией или
   * антивирусом: раньше единичная ошибка чтения давала «чистое состояние», и
   * следующая же запись затирала state.json — данные терялись навсегда.
   */
  async #readStateFile() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return JSON.parse(await readFile(this.stateFile, 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        if (attempt === 2) {
          // Не читается — сохраняем копию, чтобы данные можно было восстановить.
          const backup = `${this.stateFile}.broken-${Date.now()}`;
          const moved = await rename(this.stateFile, backup).then(() => true, () => false);
          this.log(moved
            ? `state.json не прочитан (${err.message}); копия сохранена в ${path.basename(backup)}`
            : `state.json не прочитан (${err.message}) и не удалось сохранить копию`);
          return null;
        }
        await sleep(200 * (attempt + 1));
      }
    }
    return null;
  }

  async init() {
    await mkdir(this.contentDir, { recursive: true });
    const parsed = await this.#readStateFile();
    const loaded = parsed !== null;
    if (loaded) this.state = { ...EMPTY_STATE(), ...parsed };
    if (!loaded) await this.migrateLegacy();
    this.normalize();
    const bodies = this.state.feeds.reduce((n, f) => n + (this.state.items[f.id]?.length ?? 0), 0);
    this.log(`состояние: папок ${this.state.folders.length}, лент ${this.state.feeds.length}, статей ${bodies}`);
  }

  /** Переносит старый единый db.json (с телами внутри) в новую раскладку. */
  async migrateLegacy() {
    let legacy = null;
    try {
      legacy = JSON.parse(await readFile(this.legacyFile, 'utf8'));
    } catch {
      return;
    }
    const state = { ...EMPTY_STATE(), ...legacy };
    state.items = {};
    const bodiesByFeed = new Map();
    for (const feed of state.feeds ?? []) {
      const items = legacy.items?.[feed.id] ?? [];
      state.items[feed.id] = items.map((item) => {
        const body = {};
        if (item.content) body.content = item.content;
        if (item.fullHtml) body.fullHtml = item.fullHtml;
        if (item.fullFetchedAt) body.fetchedAt = item.fullFetchedAt;
        if (Object.keys(body).length) {
          if (!bodiesByFeed.has(feed.id)) bodiesByFeed.set(feed.id, {});
          bodiesByFeed.get(feed.id)[item.id] = body;
        }
        return stripMeta(item);
      });
    }
    this.state = state;
    for (const [feedId, bodies] of bodiesByFeed) {
      await writeFile(this.#contentFile(feedId), JSON.stringify(bodies), 'utf8');
    }
    await this.saveStateNow();
    try { await rename(this.legacyFile, `${this.legacyFile}.migrated`); } catch { /* не критично */ }
    this.log(`миграция db.json → state.json + content/ (лент ${state.feeds?.length ?? 0})`);
  }

  normalize() {
    const s = this.state;
    s.folders = Array.isArray(s.folders) ? s.folders : [];
    s.feeds = Array.isArray(s.feeds) ? s.feeds : [];
    s.items = s.items && typeof s.items === 'object' ? s.items : {};
    s.read = s.read && typeof s.read === 'object' ? s.read : {};
    s.starred = s.starred && typeof s.starred === 'object' ? s.starred : {};
    s.numeric = Number(s.numeric) || 0;
    s.settings = s.settings && typeof s.settings === 'object' ? s.settings : {};
    if (!('auth' in s.settings)) s.settings.auth = null;
    if (!s.settings.telegram || typeof s.settings.telegram !== 'object') {
      s.settings.telegram = { token: '', botUsername: '', lastUpdateId: 0 };
    }
    if (!s.settings.defaultView) s.settings.defaultView = 'compact';
    const folderIds = new Set(s.folders.map((f) => f.id));
    s.feeds.forEach((feed, index) => {
      if (feed.folderId && !folderIds.has(feed.folderId)) feed.folderId = null;
      if (feed.folderId === undefined) feed.folderId = null;
      if (typeof feed.order !== 'number') feed.order = index;
    });
    for (const feed of s.feeds) {
      if (!Array.isArray(s.items[feed.id])) s.items[feed.id] = [];
      s.items[feed.id] = s.items[feed.id].map(stripMeta);
    }
    // Метаданные лент без самой ленты больше не нужны.
    const liveIds = new Set(s.feeds.map((f) => f.id));
    for (const feedId of Object.keys(s.items)) {
      if (liveIds.has(feedId) || this.virtualFeeds.has(feedId)) continue;
      delete s.items[feedId];
    }
  }

  // ------------------------------------------------------------- состояние

  /**
   * @param {number} delay
   * @param {{ bump?: boolean }} options bump=false — сохранить, не меняя ревизию:
   *   так делают служебные пометки (например «текст скачан»), чтобы клиент не
   *   перекачивал список статей из-за событий, которых он не увидит.
   */
  saveStateSoon(delay = 400, { bump = true } = {}) {
    // Ревизию поднимаем ЗДЕСЬ и только здесь: раньше её увеличивал и таймер
    // внутри saveStateNow, из-за чего номер прыгал через два.
    if (bump) this.state.revision = (Number(this.state.revision) || 0) + 1;
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.saveStateNow({ bump: false });      // bump уже случился выше
    }, delay);
  }
  async saveStateNow({ bump = true } = {}) {
    if (bump) this.state.revision = (Number(this.state.revision) || 0) + 1;
    const json = JSON.stringify(this.state);
    return this.#writeAtomic(this.stateFile, json, 'state.json');
  }

  /**
   * Атомарная запись с повторами: на Windows файл может быть занят синхронизацией
   * (ownCloud, антивирус) — тогда через паузу пробуем снова, а в крайнем случае
   * пишем напрямую, без замены файла.
   */
  async #writeAtomic(file, json, label) {
    // Записи одного файла выполняем строго по очереди: параллельные вызовы
    // перетирали общий .tmp, второй rename падал с ENOENT и запись терялась.
    const previous = this.writeQueues.get(file) ?? Promise.resolve();
    const task = previous.then(() => this.#writeAtomicNow(file, json, label)).catch(() => false);
    this.writeQueues.set(file, task);
    try {
      return await task;
    } finally {
      if (this.writeQueues.get(file) === task) this.writeQueues.delete(file);
    }
  }

  async #writeAtomicNow(file, json, label) {
    // Уникальное имя временного файла: два процесса записи больше не мешают друг другу.
    const tmp = `${file}.${process.pid}.${(writeSeq += 1)}.tmp`;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await writeFile(tmp, json, 'utf8');
        await rename(tmp, file);
        return true;
      } catch (err) {
        if (attempt === 3) {
          // ВАЖНО: не переписываем файл напрямую — обрыв на середине ломает JSON
          // (так случилось 22.10.2026: state.json превратился в обрезанный).
          // Лучше пропустить сохранение: старые данные целы, запись повторится.
          this.log(`${label}: не сохранён (${err.code ?? err.message}) — прежняя версия оставлена`);
          try { await unlink(tmp); } catch { /* файла могло не быть */ }
          return false;
        }
        await sleep(150 * (attempt + 1));
      }
    }
    return false;
  }

  // ----------------------------------------------------------------- тела

  /** Путь к файлу тел: id приходит из запросов, «../» выпускать нельзя. */
  #contentFile(feedId) {
    const safe = String(feedId ?? '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(safe)) throw new Error('плохой идентификатор ленты');
    return path.join(this.contentDir, safe + '.json');
  }

  async #loadFeed(feedId) {
    if (this.openFeeds.has(feedId)) {
      const cache = this.openFeeds.get(feedId);
      this.openFeeds.delete(feedId);
      this.openFeeds.set(feedId, cache);   // «свежесть» для LRU
      return cache;
    }
    // Параллельные вызовы не должны читать файл каждый по-своему: иначе
    // восемь setBody подряд создавали восемь пустых карт и выживала одна.
    const loading = this.feedLoads.get(feedId);
    if (loading) return loading;
    const task = (async () => {
      let bodies = {};
      try {
        bodies = JSON.parse(await readFile(this.#contentFile(feedId), 'utf8'));
      } catch (err) {
        if (err.code !== 'ENOENT') this.log(`content/${feedId}.json не прочитан: ${err.message}`);
      }
      await this.#makeRoom(feedId);
      this.openFeeds.set(feedId, bodies);
      return bodies;
    })();
    this.feedLoads.set(feedId, task);
    try {
      return await task;
    } finally {
      this.feedLoads.delete(feedId);
    }
  }

  /**
   * Освобождает место в кэше тел, не теряя несохранённое. Сначала вытесняются
   * ленты без изменений. Если все ленты «грязные», самая старая сбрасывается на
   * диск и только затем вытесняется: раньше вытеснение шло вслепую, и запись из
   * отложенного таймера молча пропадала вместе с текстами статей.
   */
  async #makeRoom(incoming) {
    while (this.openFeeds.size >= this.maxOpenFeeds) {
      let victim = null;
      for (const id of this.openFeeds.keys()) {
        if (id !== incoming && !this.dirtyFeeds.has(id)) { victim = id; break; }
      }
      if (victim !== null) {
        this.openFeeds.delete(victim);
        continue;
      }
      // Все открытые ленты с несохранёнными изменениями: сохраняем самую старую.
      let oldest = null;
      for (const id of this.openFeeds.keys()) {
        if (id !== incoming) { oldest = id; break; }
      }
      if (oldest === null) return;
      const saved = await this.#saveFeed(oldest, true);
      if (!saved) {
        // Запись не удалась — вытеснять нельзя: изменения пропали бы молча.
        // Лучше превысить лимит кэша, чем потерять тексты статей.
        this.log(`кэш тел: ${oldest} не сохранён, оставляю в памяти`);
        return;
      }
    }
  }

  async #saveFeed(feedId, drop = false) {
    const bodies = this.openFeeds.get(feedId);
    if (!bodies) {
      // Кэш уже вытеснен, а изменения остались: поднимаем данные с диска, чтобы
      // не потерять их, и только потом считаем ленту чистой.
      if (this.dirtyFeeds.has(feedId)) {
        // Изменения были в вытесненном объекте — восстановить их нельзя.
        // Пишем в журнал и оставляем флаг: падать молча нельзя, иначе тексты
        // просто исчезают без следа в логах.
        this.log(`тела ${feedId}: кэш вытеснен с несохранёнными изменениями — данные потеряны`);
        this.dirtyFeeds.delete(feedId);
      }
      return true;
    }
    if (this.dirtyFeeds.has(feedId)) {
      const ok = await this.#writeAtomic(this.#contentFile(feedId), JSON.stringify(bodies), `content/${feedId}.json`);
      if (ok !== false) this.dirtyFeeds.delete(feedId);
      else this.log(`тела ${feedId}: запись не удалась, повторю позже`);
      if (ok === false) return false;
    }
    const timer = this.feedTimers.get(feedId);
    if (timer) { clearTimeout(timer); this.feedTimers.delete(feedId); }
    if (drop) this.openFeeds.delete(feedId);
    return true;
  }

  #saveFeedSoon(feedId) {
    this.dirtyFeeds.add(feedId);
    if (this.feedTimers.has(feedId)) return;
    // Пишем файл тел не чаще раза в 5 секунд: он большой (десятки мегабайт), а при
    // докачке очередь сохраняет статьи каждые пару секунд — диск захлёбывался
    // перезаписью одного и того же файла. При сбое потеряются только что скачанные
    // тексты, и они докачаются снова.
    this.feedTimers.set(feedId, setTimeout(() => {
      this.feedTimers.delete(feedId);
      this.#saveFeed(feedId).catch(() => {});
    }, 5000));
  }

  /** Останавливает хранилище: дописывает файлы и перестаёт числиться открытым. */
  async close() {
    for (const feedId of [...this.dirtyFeeds]) {
      await this.#saveFeed(feedId).catch(() => false);
    }
    if (this.stateTimer) { clearTimeout(this.stateTimer); this.stateTimer = null; }
    for (const timer of this.feedTimers.values()) clearTimeout(timer);
    this.feedTimers.clear();
    this.openFeeds.clear();
    liveStores.delete(this);
  }

  /** Тело статьи: { content, fullHtml, fetchedAt }. */
  async body(feedId, itemId) {
    const bodies = await this.#loadFeed(feedId);
    return bodies[itemId] ?? null;
  }

  async setBody(feedId, itemId, patch) {
    // Проверяем идентификатор до чтения: иначе ошибка валидации попадала в catch
    // «файла нет» и вызов молча ничего не делал.
    this.#contentFile(feedId);
    const bodies = await this.#loadFeed(feedId);
    // Пока читали файл, ленту могли вытеснить из кэша: тогда запись в этот объект
    // никуда не попадёт. Возвращаем объект в кэш, чтобы изменения не потерялись.
    if (!this.openFeeds.has(feedId)) this.openFeeds.set(feedId, bodies);
    // Ограничиваем размер сохранённого текста: некоторые сайты отдают статьи
    // по мегабайту, а читалке столько не нужно — иначе каждое открытие статьи
    // скачивает этот вес заново.
    if (typeof patch.fullHtml === 'string' && patch.fullHtml.length > BODY_LIMIT) {
      // Режем по последнему закрытому блоку: обрывок тега ломает вёрстку.
      const cut = patch.fullHtml.slice(0, BODY_LIMIT);
      // Режем по концу конкретного закрывающего тега: раньше прибавляли 6
      // символов к любому тегу, из-за чего `</p>` захватывал лишнее, а `</figure>`
      // обрезался посередине. Так обрывок тега больше не ломает вёрстку.
      let safeEnd = -1;
      for (const tag of ['</p>', '</figure>', '</div>']) {
        const at = cut.lastIndexOf(tag);
        if (at >= 0 && at + tag.length > safeEnd) safeEnd = at + tag.length;
      }
      patch = { ...patch, fullHtml: safeEnd > BODY_LIMIT * 0.6 ? cut.slice(0, safeEnd) : cut };
    }
    const body = { ...(bodies[itemId] ?? {}), ...patch };
    bodies[itemId] = body;
    this.#saveFeedSoon(feedId);
    return body;
  }

  /** Немедленно записать тела ленты на диск (нужно перед тем, как отметить статью скачанной). */
  async flushFeed(feedId) {
    const timer = this.feedTimers.get(feedId);
    if (timer) { clearTimeout(timer); this.feedTimers.delete(feedId); }
    this.dirtyFeeds.add(feedId);
    await this.#saveFeed(feedId);
  }

  /** Удаляет тела статей, которых больше нет в ленте. */
  async pruneContent(feedId, keepIds) {
    if (!this.openFeeds.has(feedId)) {
      // Файл ещё не открывали: чистим его на диске, если он есть.
      let bodies;
      try {
        bodies = JSON.parse(await readFile(this.#contentFile(feedId), 'utf8'));
      } catch { return; }
      let removed = 0;
      for (const id of Object.keys(bodies)) if (!keepIds.has(id)) { delete bodies[id]; removed += 1; }
      if (!removed) return;
      this.openFeeds.set(feedId, bodies);
      this.dirtyFeeds.add(feedId);
      await this.#saveFeed(feedId, true);
      return;
    }
    const bodies = this.openFeeds.get(feedId);
    let removed = 0;
    for (const id of Object.keys(bodies)) if (!keepIds.has(id)) { delete bodies[id]; removed += 1; }
    if (removed) this.#saveFeedSoon(feedId);
  }

  async removeFeed(feedId) {
    this.openFeeds.delete(feedId);
    this.dirtyFeeds.delete(feedId);
    const timer = this.feedTimers.get(feedId);
    if (timer) { clearTimeout(timer); this.feedTimers.delete(feedId); }
    try { await unlink(this.#contentFile(feedId)); } catch { /* файла нет */ }
  }

  /** Сбросить всё на диск (остановка процесса). */
  async flush({ bump = true } = {}) {
    if (this.stateTimer) { clearTimeout(this.stateTimer); this.stateTimer = null; }
    await this.saveStateNow({ bump });
    // Пишем только реально изменённые ленты. Раньше каждая открытая лента
    // помечалась «грязной» и переписывалась целиком (десятки мегабайт) даже без
    // изменений — отсюда пила записи на диск при каждом массовом обновлении.
    const feedIds = [...this.openFeeds.keys()];
    for (const feedId of feedIds) {
      await this.#saveFeed(feedId, true);
    }
  }

  /** Сколько тел статей лежит в кэше — для диагностики. */
  cacheInfo() {
    let bodies = 0;
    for (const map of this.openFeeds.values()) bodies += Object.keys(map).length;
    return { feeds: this.openFeeds.size, bodies };
  }
}
