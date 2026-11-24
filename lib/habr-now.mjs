// «Читают сейчас» с Хабра.
//
// Хабр рисует этот блок из публичного JSON (страница HTML его не содержит):
//   GET https://habr.com/kek/v2/articles/most-reading/?fl=ru&hl=ru
//   -> { articleIds: [...10], articleRefs: { id: { titleHtml, statistics, ... } } }
// Авторизация не нужна, ответ отдаётся с нашего сервера. Порядок в articleIds —
// хабровский («кто читается прямо сейчас»), поэтому НЕ пересортировываем: иначе
// список не совпадёт с тем, что человек видит на сайте.
//
// Кэш один на процесс: список одинаков для всех пользователей. TTL — 10 минут,
// повторный запрос ревалидируется по ETag (обычно приходит 304 и трафика нет).
import { safeFetch } from './net-guard.mjs';

const ENDPOINT = 'https://habr.com/kek/v2/articles/most-reading/?fl=ru&hl=ru';
// Запасной источник: тот же набор данных в общем списке, но там статистика есть
// у каждой статьи — при поломке блока считаем «самое читаемое» сами.
const FALLBACK = 'https://habr.com/kek/v2/articles/all/?fl=ru&hl=ru&page=1&perPage=20';
const TTL_MS = 10 * 60 * 1000;
const KEEP_STALE_MS = 60 * 60 * 1000;
const MAX_BYTES = 512 * 1024;
const USER_AGENT = 'Mozilla/5.0 (compatible; MakRSS/1.0; +https://rss.letsplay.today)';
const LIMIT = 10;

const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", laquo: '«', raquo: '»',
  mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', trade: '™', deg: '°',
  middot: '·', times: '×', minus: '−', plus: '+', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
};

/** Раскрывает HTML-мнемоники: в titleHtml приходят &laquo;, &nbsp;, &#171; и т. п. */
export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    if (code[0] === '#') {
      const hex = code[1] === 'x' || code[1] === 'X';
      const num = hex ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(num) && num > 0 && num <= 0x10ffff ? String.fromCodePoint(num) : whole;
    }
    const known = ENTITIES[code.toLowerCase()];
    return known ?? whole;
  });
}

/** Заголовок без разметки и с нормальными пробелами. */
export function plainText(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Одна статья из ответа Хабра в нашем виде. */
export function articleItem(id, ref) {
  const stats = ref?.statistics ?? {};
  const hubs = (ref?.hubs ?? []).map((hub) => hub?.alias).filter(Boolean).slice(0, 3);
  const image = String(ref?.leadData?.imageUrl ?? '');
  const num = (value) => (Number.isFinite(value) ? value : undefined);
  return {
    id: `habr-now-${id}`,
    title: plainText(ref?.titleHtml) || `Статья ${id}`,
    link: `https://habr.com/ru/articles/${id}/`,
    date: ref?.timePublished ?? ref?.plannedPublishTime ?? new Date().toISOString(),
    author: ref?.author?.alias ?? '',
    excerpt: plainText(ref?.leadData?.textHtml ?? ''),
    image: /^https?:\/\//i.test(image) ? image : '',
    categories: hubs,
    // 👁 сколько всего прочитали (это же число Хабр показывает у себя)
    readers: num(stats.readingCount),
    // сколько читают прямо сейчас
    currentlyReading: num(stats.readers),
    commentsCount: num(stats.commentsCount),
    readingTime: num(ref?.readingTime),
    hasFull: false,
  };
}

/**
 * Разбирает ответ Хабра. `sorted` включаем только для запасного источника:
 * там статьи идут по времени, и «самое читаемое» надо выбрать самим.
 */
export function parseMostReading(text, { sorted = false } = {}) {
  const data = JSON.parse(text);
  const ids = Array.isArray(data?.articleIds) ? data.articleIds : [];
  const refs = data?.articleRefs ?? {};
  let items = ids.map((id) => (refs[id] ? articleItem(id, refs[id]) : null)).filter(Boolean);
  if (sorted) {
    items = items
      .slice()
      .sort((a, b) => (b.currentlyReading ?? 0) - (a.currentlyReading ?? 0) || (b.readers ?? 0) - (a.readers ?? 0));
  }
  return items.slice(0, LIMIT);
}

/** Читает тело ответа не больше limit байт: чужой ответ не должен съесть память. */
async function readLimitedText(response, limit) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error(`ответ больше ${limit} байт`);
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new Error(`ответ больше ${limit} байт`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

const state = { items: [], fetchedAt: 0, etag: '', error: '', inFlight: null };

async function fetchJson(url, etag) {
  const headers = { 'user-agent': USER_AGENT, accept: 'application/json' };
  if (etag) headers['if-none-match'] = etag;
  const response = await safeFetch(url, { timeoutMs: 15000, headers });
  if (response.status === 304) return { notModified: true };
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await readLimitedText(response, MAX_BYTES);
  return { text, etag: response.headers.get('etag') ?? '' };
}

export function isMostReadingFresh() {
  return Date.now() - state.fetchedAt < TTL_MS;
}

export function cachedMostReading() {
  return state;
}

/**
 * Обновляет список. Возвращает текущее состояние кэша.
 * Ошибки не пробрасывает: блок не критичен, при сбое показываем прошлый список
 * (до часа), а совсем старый — выбрасываем, чтобы не показывать «новости» недельной давности.
 */
export async function fetchMostReading({ force = false } = {}) {
  if (!force && isMostReadingFresh() && state.items.length) return state;
  if (state.inFlight) return state.inFlight;
  state.inFlight = (async () => {
    try {
      const main = await fetchJson(ENDPOINT, state.etag);
      if (main.notModified) {
        state.fetchedAt = Date.now();
        state.error = '';
        return state;
      }
      const items = parseMostReading(main.text);
      if (!items.length) throw new Error('пустой список');
      state.items = items;
      state.etag = main.etag;
      state.fetchedAt = Date.now();
      state.error = '';
      return state;
    } catch (err) {
      state.error = err?.message ?? String(err);
      try {
        const alt = await fetchJson(FALLBACK, '');
        const items = alt.text ? parseMostReading(alt.text, { sorted: true }) : [];
        if (items.length) {
          state.items = items;
          state.etag = '';
          state.fetchedAt = Date.now();
          state.error = '';
          return state;
        }
      } catch { /* оставляем прошлый список */ }
      if (Date.now() - state.fetchedAt > KEEP_STALE_MS) state.items = [];
      return state;
    } finally {
      state.inFlight = null;
    }
  })();
  return state.inFlight;
}
