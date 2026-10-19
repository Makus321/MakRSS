// Комментарии к статьям.
//
// Поддержаны два сайта:
//  * Хабр — открытый JSON-API https://habr.com/kek/v2/articles/<id>/comments/;
//  * Mobile-Review — обычный WordPress с открытым REST API
//    (/all/wp-json/wp/v2/comments?post=<id>), идентификатор статьи находим по слагу.
// Для остальных сайтов провайдер не находится, и кнопка не показывается.

const HABR_COMMENTS = (id, limit) => `https://habr.com/kek/v2/articles/${id}/comments/?fl=ru&hl=ru&sort=asc&withDeleted=false&offset=0&limit=${limit}`;
const HABR_ARTICLE = (id) => `https://habr.com/kek/v2/articles/${id}/?fl=ru&hl=ru`;

// Mobile-Review — WordPress с открытым REST API (живёт под /all/).
const WP_API = 'https://mobile-review.com/all/wp-json/wp/v2';

// Tolstoy Comments — виджет комментариев, который стоит на Mobile-Review.
// У него есть обычный REST-адрес, который отдаёт и число комментариев, и сами
// комментарии: /api/chatpage/first?siteid=<сайт>&url=<адрес статьи>&format=1
const TOLSTOY_API = 'https://web.tolstoycomments.com/api/chatpage/first';
const TOLSTOY_SITES = { 'mobile-review.com': 4388 };

function tolstoySiteFor(link) {
  try {
    const host = new URL(link).hostname.replace(/^www\./, '');
    return TOLSTOY_SITES[host] ?? null;
  } catch { return null; }
}

/** Tolstoy присылает текст с экранированными сущностями — раскрываем основные. */
const decodeEntities = (html) => String(html ?? '')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#0?39;|&apos;/g, "'")
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&');

const tolstoyUrl = (siteid, link) =>
  `${TOLSTOY_API}?siteid=${siteid}&hash=null&url=${encodeURIComponent(link)}&sort=0&format=1`;

async function tolstoayFetch(link, httpGet) {
  const siteid = tolstoySiteFor(link);
  if (!siteid) throw new Error('сайт не поддерживается');
  const res = await httpGet(tolstoyUrl(siteid, link), { accept: 'application/json', timeout: 25000 });
  if (!res.ok) throw new Error(`Tolstoy вернул HTTP ${res.status}`);
  let payload;
  try { payload = JSON.parse(res.text); } catch { throw new Error('Tolstoy вернул не JSON'); }
  return payload?.data ?? {};
}

/** Только число комментариев — для счётчика в шапке статьи. */
async function loadTolstoyCount(link, httpGet) {
  const data = await tolstoayFetch(link, httpGet);
  const total = Number(data?.chat?.count_comment_all);
  if (!Number.isFinite(total)) throw new Error('счётчик комментариев не найден');
  return total;
}

/** Ветки комментариев: корневые плюс первый ответ на каждый. */
async function loadTolstoy(link, httpGet) {
  const data = await tolstoayFetch(link, httpGet);
  const chat = data.chat ?? {};
  const list = Array.isArray(data.comments) ? data.comments : [];
  const toNode = (comment, depth) => ({
    id: String(comment.id),
    depth,
    author: comment.user?.name || comment.user?.nick || 'гость',
    isPostAuthor: Boolean(comment.user?.admin),
    date: comment.data_create ?? null,
    score: Number(comment.raiting?.val) || 0,
    votes: Number(comment.raiting?.val) || 0,
    html: decodeEntities(String(comment.text_template ?? '').replace(/<br\s*\/?>/gi, '<br>')),
    children: comment.answer_comment && depth < 3
      ? [toNode({ ...comment.answer_comment, answer_comment: null }, depth + 1)]
      : [],
  });
  const threads = list.map((comment) => toNode(comment, 0));
  return {
    provider: 'tolstoy',
    providerTitle: 'Обсуждение на сайте',
    articleId: String(chat.hash ?? ''),
    articleUrl: chat.url ?? link,
    total: Number(chat.count_comment_all) || countNodes(threads),
    count: countNodes(threads),
    threads,
  };
}

/** Слаг статьи из адреса вида …/all/articles/<раздел>/<слаг>/ */
function wpSlugOf(link) {
  try {
    const parts = new URL(link).pathname.split('/').filter(Boolean);
    return parts.at(-1) ?? '';
  } catch {
    return '';
  }
}

const wpText = (html) => String(html ?? '').trim();

async function loadWpComments(link, httpGet) {
  const slug = wpSlugOf(link);
  if (!slug) throw new Error('не разобрать адрес статьи');
  const found = await httpGet(`${WP_API}/posts?slug=${encodeURIComponent(slug)}&_fields=id,link`, { accept: 'application/json', timeout: 20000 });
  if (!found.ok) throw new Error(`Сайт вернул HTTP ${found.status}`);
  let posts;
  try { posts = JSON.parse(found.text); } catch { throw new Error('Сайт вернул не JSON'); }
  const post = Array.isArray(posts) ? posts[0] : null;
  if (!post?.id) throw new Error('статья не найдена в API сайта');

  const res = await httpGet(`${WP_API}/comments?post=${post.id}&per_page=100&orderby=date&order=asc`, { accept: 'application/json', timeout: 25000 });
  if (!res.ok) throw new Error(`Комментарии: HTTP ${res.status}`);
  let list;
  try { list = JSON.parse(res.text); } catch { throw new Error('Комментарии вернулись не в JSON'); }

  const byId = new Map();
  for (const comment of Array.isArray(list) ? list : []) {
    byId.set(String(comment.id), {
      id: String(comment.id),
      parent: String(comment.parent ?? 0),
      author: comment.author_name || 'гость',
      date: comment.date ?? null,
      html: wpText(comment.content?.rendered),
    });
  }
  const childrenOf = new Map();
  const roots = [];
  for (const comment of byId.values()) {
    if (comment.parent !== '0' && byId.has(comment.parent)) {
      if (!childrenOf.has(comment.parent)) childrenOf.set(comment.parent, []);
      childrenOf.get(comment.parent).push(comment.id);
    } else roots.push(comment.id);
  }
  const build = (ids, depth) => (depth > 8 ? [] : ids.map((id) => {
    const comment = byId.get(id);
    return {
      id: comment.id,
      depth,
      author: comment.author,
      isPostAuthor: false,
      date: comment.date,
      score: 0,
      votes: 0,
      html: comment.html,
      children: build(childrenOf.get(id) ?? [], depth + 1),
    };
  }));
  const threads = build(roots, 0);
  return {
    provider: 'wordpress',
    providerTitle: 'сайт статьи',
    articleId: String(post.id),
    articleUrl: post.link ?? link,
    total: countNodes(threads),
    count: countNodes(threads),
    threads,
  };
}

const asIds = (value) => {
  if (Array.isArray(value)) return value.map((x) => String(typeof x === 'object' ? x?.id : x)).filter(Boolean);
  if (value && typeof value === 'object') {
    if (Array.isArray(value.ids)) return value.ids.map(String);
    return Object.keys(value);
  }
  return [];
};

const votesOf = (comment) => {
  const raw = comment?.votesCount ?? comment?.votes;
  if (typeof raw === 'number') return raw;
  if (raw && typeof raw === 'object') return (Number(raw.plus) || 0) + (Number(raw.minus) || 0);
  return 0;
};

function buildThreads(comments, rootIds, depth = 0) {
  if (depth > 8) return [];
  const nodes = [];
  for (const id of rootIds) {
    const comment = comments[id];
    if (!comment) continue;
    const children = asIds(comment.children ?? comment.replyList);
    nodes.push({
      id: String(id),
      depth,
      author: comment.author?.alias ?? comment.author?.fullname ?? 'гость',
      isPostAuthor: Boolean(comment.isPostAuthor),
      date: comment.timePublished ?? null,
      score: Number(comment.score) || 0,
      votes: votesOf(comment),
      html: comment.message ?? '',
      children: buildThreads(comments, children, depth + 1),
    });
  }
  return nodes;
}

const countNodes = (nodes) => nodes.reduce((n, node) => n + 1 + countNodes(node.children), 0);

async function loadHabr(articleId, httpGet) {
  const res = await httpGet(HABR_COMMENTS(articleId, 200), { accept: 'application/json', timeout: 25000 });
  if (!res.ok) throw new Error(`Хабр вернул HTTP ${res.status}`);
  let payload;
  try {
    payload = JSON.parse(res.text);
  } catch {
    throw new Error('Хабр вернул не JSON (возможно, изменился API)');
  }
  const comments = payload.comments ?? {};
  const roots = Array.isArray(payload.threads) && payload.threads.length
    ? payload.threads.map(String)
    : Object.keys(comments).filter((id) => !comments[id]?.parentId);

  let total = null;
  try {
    const info = await httpGet(HABR_ARTICLE(articleId), { accept: 'application/json', timeout: 20000 });
    if (info.ok) total = JSON.parse(info.text)?.statistics?.commentsCount ?? null;
  } catch { /* счётчик не критичен */ }

  const threads = buildThreads(comments, roots);
  return {
    provider: 'habr',
    providerTitle: 'Хабр',
    articleId,
    articleUrl: `https://habr.com/ru/articles/${articleId}/`,
    total,
    count: countNodes(threads),
    threads,
  };
}

/** Только количество комментариев — для кнопки «показать/не показывать». */
async function loadHabrCount(articleId, httpGet) {
  const info = await httpGet(HABR_ARTICLE(articleId), { accept: 'application/json', timeout: 20000 });
  if (!info.ok) throw new Error(`Хабр вернул HTTP ${info.status}`);
  const payload = JSON.parse(info.text);
  const count = payload?.statistics?.commentsCount;
  if (!Number.isFinite(count)) throw new Error('счётчик комментариев не найден');
  return count;
}

// iXBT — открытый JSON-API комментариев. Нужен номер публикации (target_id),
// он лежит в разметке самой статьи как "publication_id".
const IXBT_TOPIC = 'ixbt_article_announce';
const ixbtTargets = new Map();          // ссылка на статью → номер публикации

function isIxbt(link) {
  try { return /(^|\.)(ixbt\.com|ixbt\.games)$/i.test(new URL(link).hostname); } catch { return false; }
}

async function ixbtTargetId(link, httpGet) {
  const cached = ixbtTargets.get(link);
  if (cached) return cached;
  const res = await httpGet(link, { accept: 'text/html', timeout: 25000 });
  if (!res.ok) throw new Error(`iXBT вернул HTTP ${res.status}`);
  // На ixbt.com тип публикации — ixbt_article_announce, у ixbt.games —
  // universal_publication; берём оба вместе с номером, чтобы не угадывать.
  const id = /"publication_id"\s*:\s*(\d+)/.exec(res.text)?.[1];
  const type = /"publication_type"\s*:\s*"([a-z_]+)"/i.exec(res.text)?.[1] ?? IXBT_TOPIC;
  if (!id) throw new Error('не удалось найти номер публикации iXBT');
  if (ixbtTargets.size > 500) ixbtTargets.clear();
  ixbtTargets.set(link, { id, type });
  return { id, type };
}

async function ixbtPayload(link, httpGet) {
  const target = await ixbtTargetId(link, httpGet);
  const host = /ixbt\.games$/i.test(link) ? 'ixbt.games' : 'www.ixbt.com';
  const url = `https://${host}/api/comments?target_id=${target.id}&target_type=${target.type}`;
  const res = await httpGet(url, { accept: 'application/json', timeout: 25000 });
  if (!res.ok) throw new Error(`Комментарии iXBT: HTTP ${res.status}`);
  let payload;
  try { payload = JSON.parse(res.text); } catch { throw new Error('iXBT вернул не JSON'); }
  return payload?.data ?? {};
}

async function loadIxbtCount(link, httpGet) {
  const data = await ixbtPayload(link, httpGet);
  const count = Number(data.count ?? data.comments?.length ?? 0);
  if (!Number.isFinite(count)) throw new Error('счётчик комментариев не найден');
  return count;
}

async function loadIxbt(link, httpGet) {
  const data = await ixbtPayload(link, httpGet);
  const list = Array.isArray(data.comments) ? data.comments : [];
  const byId = new Map();
  for (const comment of list) {
    byId.set(String(comment.comment_id), {
      id: String(comment.comment_id),
      parent: comment.comment_pid ? String(comment.comment_pid) : null,
      author: comment.author?.name || comment.author?.nick || 'гость',
      isPostAuthor: Boolean(comment.user_is_author),
      date: comment.comment_date ?? null,
      score: Number(comment.comment_rating) || 0,
      html: String(comment.comment_text ?? ''),
    });
  }
  const childrenOf = new Map();
  const roots = [];
  for (const comment of byId.values()) {
    if (comment.parent && byId.has(comment.parent)) {
      if (!childrenOf.has(comment.parent)) childrenOf.set(comment.parent, []);
      childrenOf.get(comment.parent).push(comment.id);
    } else roots.push(comment.id);
  }
  const build = (ids, depth) => (depth > 8 ? [] : ids.map((id) => {
    const comment = byId.get(id);
    return {
      id: comment.id,
      depth,
      author: comment.author,
      isPostAuthor: comment.isPostAuthor,
      date: comment.date,
      score: comment.score,
      votes: comment.score,
      html: comment.html,
      children: build(childrenOf.get(id) ?? [], depth + 1),
    };
  }));
  const threads = build(roots, 0);
  return {
    provider: 'ixbt',
    providerTitle: 'Обсуждение на iXBT',
    articleId: '',
    articleUrl: link,
    total: Number(data.count) || countNodes(threads),
    count: countNodes(threads),
    threads,
  };
}

/** Подбирает провайдера комментариев для статьи; null — если такого нет. */
export function commentsProviderFor(feed, item) {
  const link = String(item?.link ?? '');
  if (/habr\.com/i.test(link) || /habr\.com/i.test(feed?.url ?? '')) {
    const id = /(?:articles|post)\/(\d+)/.exec(link)?.[1] ?? /(?:articles|post)\/(\d+)/.exec(feed?.url ?? '')?.[1];
    if (id) {
      return {
        name: 'habr',
        articleId: id,
        load: (httpGet) => loadHabr(id, httpGet),
        count: (httpGet) => loadHabrCount(id, httpGet),
      };
    }
  }
  if (isIxbt(link)) {
    return {
      name: 'ixbt',
      articleId: link,
      load: (httpGet) => loadIxbt(link, httpGet),
      count: (httpGet) => loadIxbtCount(link, httpGet),
    };
  }
  if (tolstoySiteFor(link)) {
    return {
      name: 'tolstoy',
      articleId: link,
      load: (httpGet) => loadTolstoy(link, httpGet),
      count: (httpGet) => loadTolstoyCount(link, httpGet),
    };
  }
  if (/mobile-review\.com/i.test(link) || /mobile-review\.com/i.test(feed?.url ?? '')) {
    const slug = wpSlugOf(link);
    if (slug) {
      return {
        name: 'wordpress',
        articleId: slug,
        load: (httpGet) => loadWpComments(link, httpGet),
      };
    }
  }
  return null;
}

export { loadHabr };
