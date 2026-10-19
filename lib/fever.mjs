// Протокол Fever API (https://github.com/bazqux/bazqux-api) — де-факто стандарт
// синхронизации для RSS-клиентов (Reeder, Unread, NetNewsWire, Fiery Feeds и др.).
//
// Клиент обращается POST/GET к /fever/ с параметрами api_key и api.
// Числовые идентификаторы лент и статей протоколу нужны целыми, поэтому
// в объектах хранятся поля n (номер), назначаемые лениво.

const unixSeconds = (iso, fallback = Math.floor(Date.now() / 1000)) => {
  const ms = Date.parse(iso ?? '');
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : fallback;
};

const csv = (numbers) => numbers.join(',');

// Протокол отдаёт статьи порциями: since_id — 50 следующих, max_id — 50 предыдущих,
// with_ids — не больше 50 указанных. Без этого клиент на телефоне захлёбывается
// (при первой синхронизации since_id=0 отдавал бы всю библиотеку разом).
const ITEMS_PER_REQUEST = 50;

/**
 * @param {object} ctx контекст из server.mjs:
 *   { db, store, json, readBody, numOf, feedNum, folderNum, authorizedKey, saveSoon }
 */
export async function handleFever(req, res, url, ctx) {
  const form = new URLSearchParams();
  if (req.method === 'POST') {
    const raw = await ctx.readBody(req, 1024 * 1024);
    for (const [key, value] of new URLSearchParams(raw)) form.set(key, value);
  }
  for (const [key, value] of url.searchParams) if (!form.has(key)) form.set(key, value);

  const apiKey = form.get('api_key') ?? url.searchParams.get('api_key') ?? '';
  const base = { api_version: 3, auth: 0 };

  if (!ctx.authorizedKey(apiKey)) {
    ctx.json(res, 200, base);
    return;
  }

  const { db } = ctx;
  const api = (form.get('api') ?? '').toLowerCase();
  const payload = {
    api_version: 3,
    auth: 1,
    // Обязательное поле ответа: время последнего обновления лент.
    last_refreshed_on_time: unixSeconds(db.lastRefresh),
  };

  const readOf = (id) => Boolean(db.read[id]);
  const savedOf = (id) => Boolean(db.starred[id]);
  const allItems = () => db.feeds.flatMap((feed) => (db.items[feed.id] ?? []).map((item) => ({ feed, item })));

  const itemJson = async (feed, item) => ({
    id: ctx.numOf(item),
    feed_id: ctx.feedNum(feed),
    title: item.title ?? '',
    author: item.author ?? '',
    html: await ctx.itemHtml(feed, item),
    url: item.link ?? '',
    is_saved: savedOf(item.id) ? 1 : 0,
    is_read: readOf(item.id) ? 1 : 0,
    created_on_time: unixSeconds(item.date),
  });

  // ------------------------------------------------------------- чтение
  if (api === 'feeds' || api === 'groups' || form.has('feeds') || form.has('groups')) {
    payload.feeds = db.feeds.map((feed) => ({
      id: ctx.feedNum(feed),
      favicon_id: 0,
      title: feed.title ?? '',
      url: feed.url ?? '',
      site_url: feed.siteUrl ?? '',
      is_spark: 0,
      last_updated_on_time: unixSeconds(feed.lastFetched),
    }));
    payload.groups = db.folders.map((folder) => ({ id: ctx.folderNum(folder), title: folder.name ?? '' }));
    payload.feeds_groups = db.folders.map((folder) => ({
      group_id: ctx.folderNum(folder),
      feed_ids: csv(db.feeds.filter((f) => f.folderId === folder.id).map((f) => ctx.feedNum(f))),
    }));
    // Старый стиль (?api=feeds) отвечает сразу; новый (?feeds=1) копит ответ —
    // клиент вправе запросить ленты и статьи одним вызовом.
    if (api) return ctx.json(res, 200, payload);
  }

  if (api === 'favicons' || form.has('favicons')) {
    // Иконки отдаём пустым списком: клиенты переносят это спокойно,
    // а favicon_id у лент равен нулю.
    payload.favicons = [];
    if (api) return ctx.json(res, 200, payload);
  }

  if (api === 'items' || form.has('items')) {
    const withIds = (form.get('with_ids') ?? '').split(',').map((s) => Number.parseInt(s, 10)).filter(Number.isFinite);
    const sinceId = Number.parseInt(form.get('since_id') ?? '', 10);
    const maxId = Number.parseInt(form.get('max_id') ?? '', 10);
    const all = allItems();
    let chosen;
    if (withIds.length) {
      const wanted = new Set(withIds.slice(0, ITEMS_PER_REQUEST));
      chosen = all.filter(({ item }) => wanted.has(ctx.numOf(item)));
    } else if (Number.isFinite(sinceId)) {
      // «50 следующих» — самые старые из тех, что новее since_id,
      // чтобы клиент двигал since_id вперёд и не терял статьи.
      chosen = all.filter(({ item }) => ctx.numOf(item) > sinceId)
        .sort((a, b) => ctx.numOf(a.item) - ctx.numOf(b.item))
        .slice(0, ITEMS_PER_REQUEST);
    } else if (Number.isFinite(maxId)) {
      chosen = all.filter(({ item }) => ctx.numOf(item) < maxId)
        .sort((a, b) => ctx.numOf(b.item) - ctx.numOf(a.item))
        .slice(0, ITEMS_PER_REQUEST);
    } else {
      chosen = [...all].sort((a, b) => String(b.item.date ?? '').localeCompare(String(a.item.date ?? '')))
        .slice(0, ITEMS_PER_REQUEST);
    }
    chosen.sort((a, b) => ctx.numOf(a.item) - ctx.numOf(b.item));
    payload.items = [];
    for (const { feed, item } of chosen) payload.items.push(await itemJson(feed, item));
    payload.total_items = all.length;
    if (api) return ctx.json(res, 200, payload);
  }

  if (api === 'unread_item_ids' || form.has('unread_item_ids')) {
    payload.unread_item_ids = csv(allItems().filter(({ item }) => !readOf(item.id)).map(({ item }) => ctx.numOf(item)));
    if (api) return ctx.json(res, 200, payload);
  }

  if (api === 'saved_item_ids' || form.has('saved_item_ids')) {
    payload.saved_item_ids = csv(allItems().filter(({ item }) => savedOf(item.id)).map(({ item }) => ctx.numOf(item)));
    if (api) return ctx.json(res, 200, payload);
  }

  if (api === 'links' || form.has('links')) {
    payload.links = [];
    payload.hot_links = [];
    if (api) return ctx.json(res, 200, payload);
  }

  // ------------------------------------------------------------ запись
  // Клиенты кладут команды в тело POST (?api остаётся просто меткой в адресе),
  // поэтому смотрим и на форму, а не только на ?api=mark.
  const isWrite = api === 'mark' || api === 'save'
    || form.has('mark') || form.has('save') || form.has('unread_recently_read');
  if (isWrite) {
    const as = (form.get('as') ?? '').toLowerCase();
    const mark = (api === 'save' || form.has('save')) && !form.has('mark')
      ? 'item'
      : (form.get('mark') ?? 'item').toLowerCase();
    const ids = (form.get('id') ?? '').split(',').map((s) => Number.parseInt(s, 10)).filter(Number.isFinite);
    const stamp = Date.now();
    const byNumber = new Map(allItems().map(({ feed, item }) => [ctx.numOf(item), { feed, item }]));
    // «Недавно прочитанное снова сделать непрочитанным»: протокол даёт для этого
    // отдельный флаг, ограничиваемся последними 30 минутами.
    const unreadRecently = form.get('unread_recently_read') === '1';
    if (unreadRecently) {
      const since = stamp - 30 * 60_000;
      for (const [id, when] of Object.entries(db.read)) {
        if (Number(when) >= since) delete db.read[id];
      }
    }

    if (mark === 'item') {
      for (const number of ids) {
        const entry = byNumber.get(number);
        if (!entry) continue;
        const { item } = entry;
        if (as === 'read') db.read[item.id] = stamp;
        else if (as === 'unread') delete db.read[item.id];
        else if (as === 'saved') db.starred[item.id] = stamp;
        else if (as === 'unsaved') delete db.starred[item.id];
      }
    } else if (mark === 'feed' || mark === 'group') {
      // before — время последней синхронизации клиента: новее него не трогаем,
      // иначе клиент отметил бы прочитанным то, чего ещё не видел.
      const before = Number.parseInt(form.get('before') ?? '', 10);
      const limit = Number.isFinite(before) ? before * 1000 : Infinity;
      // Особые группы протокола: 0 — все ленты, -1 — «sparks» (у нас их нет).
      const allFeeds = mark === 'group' && ids.includes(0);
      const feeds = mark === 'feed'
        ? db.feeds.filter((f) => ids.includes(ctx.feedNum(f)))
        : (allFeeds
          ? [...db.feeds]
          : db.feeds.filter((f) => ids.includes(ctx.folderNum(db.folders.find((x) => x.id === f.folderId) ?? {}))));
      for (const feed of feeds) {
        for (const item of db.items[feed.id] ?? []) {
          const when = Date.parse(item.date ?? '') || 0;
          if (when && when > limit) continue;
          if (as === 'read') db.read[item.id] = stamp;
          else if (as === 'unread') delete db.read[item.id];
        }
      }
    }
    ctx.pruneState?.();
    ctx.saveSoon();
    // Протокол требует вернуть обновлённый список: клиент сразу видит, что отметка
    // дошла до сервера, и не присылает те же статьи повторно.
    if (as === 'saved' || as === 'unsaved') {
      payload.saved_item_ids = csv(allItems().filter(({ item }) => savedOf(item.id)).map(({ item }) => ctx.numOf(item)));
    } else {
      payload.unread_item_ids = csv(allItems().filter(({ item }) => !readOf(item.id)).map(({ item }) => ctx.numOf(item)));
    }
    if (api) return ctx.json(res, 200, payload);
    return ctx.json(res, 200, { ...base, ...payload, auth: 1 });
  }

  // Всё, что запросили, отдаём одним ответом (в том числе если запросов несколько).
  return ctx.json(res, 200, { ...base, ...payload, auth: 1 });
}
