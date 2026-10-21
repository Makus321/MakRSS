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
const META_FIELDS = [
  'id', 'title', 'link', 'date', 'author', 'excerpt', 'image', 'categories',
  'hasFull', 'fullTriedAt', 'contentLength', 'n', 'messageId', 'imageFileId',
  'commentsCount', 'commentsCountAt',
];

const stripMeta = (item) => {
  const meta = {};
  for (const field of META_FIELDS) if (item[field] !== undefined) meta[field] = item[field];
  return meta;
};

export class Store {
  constructor(dataDir, log = () => {}) {
    this.dataDir = dataDir;
    this.contentDir = path.join(dataDir, 'content');
    this.stateFile = path.join(dataDir, 'state.json');
    this.legacyFile = path.join(dataDir, 'db.json');
    this.log = log;
    this.state = EMPTY_STATE();
    this.openFeeds = new Map();   // feedId -> Map(itemId -> body)
    this.dirtyFeeds = new Set();
    this.feedTimers = new Map();
    this.stateTimer = null;
    this.maxOpenFeeds = 12;
  }

  async init() {
    await mkdir(this.contentDir, { recursive: true });
    let loaded = false;
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, 'utf8'));
      this.state = { ...EMPTY_STATE(), ...parsed };
      loaded = true;
    } catch (err) {
      if (err.code !== 'ENOENT') this.log(`state.json не прочитан (${err.message}), начинаем с чистого состояния`);
    }
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
      await writeFile(path.join(this.contentDir, `${feedId}.json`), JSON.stringify(bodies), 'utf8');
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
    for (const feedId of Object.keys(s.items)) if (!liveIds.has(feedId)) delete s.items[feedId];
  }

  // ------------------------------------------------------------- состояние

  saveStateSoon(delay = 400) {
    this.state.revision = (Number(this.state.revision) || 0) + 1;   // ключ для дешёвого опроса
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => { this.stateTimer = null; this.saveStateNow(); }, delay);
  }

  async saveStateNow() {
    this.state.revision = (Number(this.state.revision) || 0) + 1;
    const json = JSON.stringify(this.state);
    return this.#writeAtomic(this.stateFile, json, 'state.json');
  }

  /**
   * Атомарная запись с повторами: на Windows файл может быть занят синхронизацией
   * (ownCloud, антивирус) — тогда через паузу пробуем снова, а в крайнем случае
   * пишем напрямую, без замены файла.
   */
  async #writeAtomic(file, json, label) {
    const tmp = `${file}.tmp`;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await writeFile(tmp, json, 'utf8');
        await rename(tmp, file);
        return true;
      } catch (err) {
        if (attempt === 3) {
          try {
            await writeFile(file, json, 'utf8');
            this.log(`${label}: записан напрямую (замена файла недоступна: ${err.code ?? err.message})`);
            return true;
          } catch (direct) {
            this.log(`ошибка записи ${label}: ${direct.message}`);
            try { await unlink(tmp); } catch { /* файла могло не быть */ }
            return false;
          }
        }
        await sleep(150 * (attempt + 1));
      }
    }
    return false;
  }

  // ----------------------------------------------------------------- тела

  async #loadFeed(feedId) {
    if (this.openFeeds.has(feedId)) {
      const cache = this.openFeeds.get(feedId);
      this.openFeeds.delete(feedId);
      this.openFeeds.set(feedId, cache);   // «свежесть» для LRU
      return cache;
    }
    let bodies = {};
    try {
      bodies = JSON.parse(await readFile(path.join(this.contentDir, `${feedId}.json`), 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') this.log(`content/${feedId}.json не прочитан: ${err.message}`);
    }
    this.openFeeds.set(feedId, bodies);
    if (this.openFeeds.size > this.maxOpenFeeds) {
      const [oldest] = this.openFeeds.keys();
      if (oldest !== feedId) await this.#saveFeed(oldest, true);
    }
    return bodies;
  }

  async #saveFeed(feedId, drop = false) {
    const bodies = this.openFeeds.get(feedId);
    if (!bodies) return;
    if (this.dirtyFeeds.has(feedId)) {
      await this.#writeAtomic(path.join(this.contentDir, `${feedId}.json`), JSON.stringify(bodies), `content/${feedId}.json`);
      this.dirtyFeeds.delete(feedId);
    }
    const timer = this.feedTimers.get(feedId);
    if (timer) { clearTimeout(timer); this.feedTimers.delete(feedId); }
    if (drop) this.openFeeds.delete(feedId);
  }

  #saveFeedSoon(feedId) {
    this.dirtyFeeds.add(feedId);
    if (this.feedTimers.has(feedId)) return;
    this.feedTimers.set(feedId, setTimeout(() => {
      this.feedTimers.delete(feedId);
      this.#saveFeed(feedId).catch(() => {});
    }, 1000));
  }

  /** Тело статьи: { content, fullHtml, fetchedAt }. */
  async body(feedId, itemId) {
    const bodies = await this.#loadFeed(feedId);
    return bodies[itemId] ?? null;
  }

  async setBody(feedId, itemId, patch) {
    const bodies = await this.#loadFeed(feedId);
    // Ограничиваем размер сохранённого текста: некоторые сайты отдают статьи
    // по мегабайту, а читалке столько не нужно — иначе каждое открытие статьи
    // скачивает этот вес заново.
    if (typeof patch.fullHtml === 'string' && patch.fullHtml.length > BODY_LIMIT) {
      // Режем по последнему закрытому блоку: обрывок тега ломает вёрстку.
      const cut = patch.fullHtml.slice(0, BODY_LIMIT);
      const safe = Math.max(cut.lastIndexOf('</p>'), cut.lastIndexOf('</figure>'), cut.lastIndexOf('</div>'));
      patch = { ...patch, fullHtml: safe > BODY_LIMIT * 0.6 ? cut.slice(0, safe + 6) : cut };
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
        bodies = JSON.parse(await readFile(path.join(this.contentDir, `${feedId}.json`), 'utf8'));
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
    try { await unlink(path.join(this.contentDir, `${feedId}.json`)); } catch { /* файла нет */ }
  }

  /** Сбросить всё на диск (остановка процесса). */
  async flush() {
    if (this.stateTimer) { clearTimeout(this.stateTimer); this.stateTimer = null; }
    await this.saveStateNow();
    const feedIds = [...this.openFeeds.keys()];
    for (const feedId of feedIds) {
      this.dirtyFeeds.add(feedId);
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
