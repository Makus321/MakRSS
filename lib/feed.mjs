// Разбор лент: RSS 2.0, RSS 1.0 (RDF), Atom 0.3/1.0.
import { createHash } from 'node:crypto';
import { parseXml, child, children, localName, elementChildren, text, trimmedText, serializeChildren } from './xml.mjs';

export function itemId(feedId, raw) {
  const key = String(raw ?? '');
  return createHash('sha1').update(`${feedId}\u0000${key}`).digest('hex').slice(0, 16);
}

function decodeHtmlEntities(input) {
  return String(input ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&laquo;/gi, '«')
    .replace(/&raquo;/gi, '»')
    .replace(/&hellip;/gi, '…')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

/** Грубое превращение HTML в плоский текст — для превью в списке. */
export function htmlToText(html) {
  return decodeHtmlEntities(String(html ?? ''))
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Служебные заглушки, которые некоторые ленты (например, GitHub releases) кладут
// прямо в текст статьи: «Choose a tag to compare», «No results found» и подобные.
const NOISE_HINT = /choose a tag to compare|something went wrong|error while loading|no results found/i;
const NOISE_LINE = /^(choose a tag to compare|sorry, something went wrong\.?|there was an error while loading\.? please reload this page\.?|no results found|\\+)$/i;
const NOISE_ELEMENT = /<(h[1-6]|p|div|span|section|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi;

/** Убирает из текста статьи служебные заглушки ленты. */
export function stripFeedNoise(html) {
  let out = String(html ?? '');
  if (!NOISE_HINT.test(out)) return out;
  let previous;
  do {
    previous = out;
    // Удаляем блок, весь текст которого — служебная заглушка. Проверка по тексту
    // (а не по вложенности) безопасна: шаблон привязан к началу и концу строки.
    out = out.replace(NOISE_ELEMENT, (whole, tag, inner) => (NOISE_LINE.test(htmlToText(inner)) ? '' : whole));
  } while (out !== previous);
  out = out.replace(new RegExp(`(^|\\n)\\s*(?:${NOISE_HINT.source})\\s*(\\n|$)`, 'gi'), '$1');
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function parseDate(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  // Отсекаем заведомо битые даты (например, год 0000 из кривых генераторов).
  if (d.getUTCFullYear() < 1990 || d.getUTCFullYear() > 2100) return null;
  return d.toISOString();
}

function absolutize(url, base) {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  try { return new URL(raw, base).href; } catch { return raw; }
}

function atomLink(entry, base, rel = 'alternate') {
  const links = children(entry, 'link');
  const pick = links.find((l) => (l.attrs.rel ?? '').toLowerCase() === rel && l.attrs.href)
    ?? links.find((l) => l.attrs.href && !l.attrs.rel);
  if (pick) return absolutize(pick.attrs.href, base);
  const plain = links.find((l) => !l.attrs.href && trimmedText(l));
  return plain ? absolutize(trimmedText(plain), base) : '';
}

function atomContent(entry, base) {
  const node = child(entry, 'content') ?? child(entry, 'summary');
  if (!node) return '';
  const type = (node.attrs.type ?? '').toLowerCase();
  if (type === 'xhtml' || elementChildren(node).length > 0) {
    const html = serializeChildren(node).trim();
    return html || trimmedText(node);
  }
  const raw = text(node).trim();
  if (!raw) return '';
  return type === 'html' || /<\/?[a-z][\s\S]*>/i.test(raw) ? raw : `<p>${raw.replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;
}

function rssContent(item, base) {
  const encoded = child(item, 'encoded');
  const description = child(item, 'description');
  const summary = description ? text(description).trim() : '';
  const full = encoded ? text(encoded).trim() : '';
  const body = full || summary;
  if (!body) return '';
  const isHtml = /<\/?[a-z][\s\S]*>/i.test(body);
  return isHtml ? body : `<p>${body.replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;
}

function pickImage(item, contentHtml, base) {
  const enclosure = children(item, 'enclosure').find((e) => (e.attrs.type ?? '').startsWith('image'));
  if (enclosure?.attrs.url) return absolutize(enclosure.attrs.url, base);
  const media = [...children(item, 'content'), ...children(item, 'thumbnail')]
    .find((n) => n.attrs.url && (!n.attrs.medium || n.attrs.medium === 'image'));
  if (media?.attrs.url) return absolutize(media.attrs.url, base);
  const img = /<img[^>]+src\s*=\s*["']([^"']+)["']/i.exec(contentHtml);
  return img ? absolutize(img[1], base) : '';
}

function normalizeItem(feedId, parts, base) {
  const title = htmlToText(parts.title) || '(без заголовка)';
  const content = stripFeedNoise(parts.content || '');
  const excerpt = (htmlToText(content) || '').slice(0, 400);
  const date = parts.date ?? null;
  const link = parts.link || '';
  const rawId = parts.guid || link || `${title}|${date ?? ''}|${excerpt.slice(0, 80)}`;
  const comments = Number(parts.comments);
  return {
    id: itemId(feedId, rawId),
    title,
    link,
    date,
    author: htmlToText(parts.author || ''),
    excerpt,
    content,
    image: parts.image || '',
    categories: parts.categories ?? [],
    // Некоторые ленты (WordPress) сами сообщают число комментариев — берём его,
    // чтобы счётчик был виден сразу, без запроса к сайту.
    commentsCount: Number.isFinite(comments) && comments >= 0 ? comments : null,
  };
}

/**
 * Разбирает текст фида.
 * @returns {{ kind: 'feed'|'unknown', format: string, meta: object, items: object[] }}
 */
export function parseFeed(xmlText, feedUrl, feedId) {
  const doc = parseXml(xmlText);
  const rootEl = elementChildren(doc).find((n) => !['#document'].includes(localName(n))) ?? elementChildren(doc)[0];
  if (!rootEl) return { kind: 'unknown', format: '', meta: {}, items: [] };

  const root = localName(rootEl);
  const base = feedUrl || '';

  if (root === 'feed') {
    const meta = {
      title: trimmedText(child(rootEl, 'title')) || feedUrl,
      siteUrl: atomLink(rootEl, base, 'alternate') || '',
      description: htmlToText(trimmedText(child(rootEl, 'subtitle'))).slice(0, 300),
      icon: absolutize(child(rootEl, 'icon')?.attrs?.href ?? trimmedText(child(rootEl, 'icon')), base),
    };
    const items = children(rootEl, 'entry').map((entry) => {
      const authorNode = child(entry, 'author');
      const content = atomContent(entry, base);
      const link = atomLink(entry, base) || (child(entry, 'id') && /^https?:/i.test(trimmedText(child(entry, 'id'))) ? trimmedText(child(entry, 'id')) : '');
      return normalizeItem(feedId, {
        title: trimmedText(child(entry, 'title')),
        link,
        guid: trimmedText(child(entry, 'id')),
        date: parseDate(trimmedText(child(entry, 'published')) || trimmedText(child(entry, 'updated')) || trimmedText(child(entry, 'created'))),
        author: authorNode ? trimmedText(child(authorNode, 'name')) : trimmedText(child(entry, 'author')),
        content,
        image: pickImage(entry, content, base),
        categories: children(entry, 'category').map((c) => c.attrs.term || trimmedText(c)).filter(Boolean),
      }, base);
    });
    return { kind: 'feed', format: 'atom', meta, items };
  }

  const isRdf = root === 'rdf' || root === 'rdf:rdf';
  // В RDF каналы и элементы лежат рядом, в RSS 2.0 элементы вложены в <channel>.
  const channel = isRdf ? child(rootEl, 'channel') : child(rootEl, 'channel') ?? rootEl;
  const itemNodes = isRdf ? children(rootEl, 'item') : children(channel, 'item');

  if (root !== 'rss' && !isRdf && itemNodes.length === 0) {
    return { kind: 'unknown', format: root, meta: {}, items: [] };
  }

  const items = itemNodes.map((item) => {
    const content = rssContent(item, base);
    const guidNode = child(item, 'guid');
    const creator = trimmedText(child(item, 'creator')) || trimmedText(child(item, 'author'));
    return normalizeItem(feedId, {
      title: trimmedText(child(item, 'title')),
      link: absolutize(trimmedText(child(item, 'link')), base),
      guid: guidNode ? trimmedText(guidNode) : '',
      date: parseDate(
        trimmedText(child(item, 'pubDate'))
        || trimmedText(child(item, 'date'))
        || trimmedText(child(item, 'published'))
        || trimmedText(child(item, 'updated')),
      ),
      author: creator,
      content,
      image: pickImage(item, content, base),
      categories: children(item, 'category').map((c) => trimmedText(c)).filter(Boolean),
      // Число комментариев, если лента его сообщает (WordPress: <slash:comments>).
      comments: trimmedText(child(item, 'comments')) || (item.attrs?.['slash:comments'] ?? ''),
    }, base);
  });

  const meta = {
    title: trimmedText(child(channel, 'title')) || feedUrl,
    siteUrl: absolutize(trimmedText(child(channel, 'link')), base),
    description: htmlToText(trimmedText(child(channel, 'description'))).slice(0, 300),
    icon: '',
  };
  return { kind: 'feed', format: isRdf ? 'rss1' : 'rss2', meta, items };
}

/** Похоже ли содержимое на ленту (а не на HTML-страницу). */
export function looksLikeFeed(xmlText) {
  const head = String(xmlText ?? '').slice(0, 4000);
  if (!/^\s*(<\?xml|<rss|<feed|<rdf:rdf|<rdf)/i.test(head)) return false;
  return /<(rss|feed|rdf:rdf|channel)\b/i.test(head);
}

/** Ищет <link rel="alternate" type="application/rss+xml"> на HTML-странице. */
export function discoverFeedLinks(html, pageUrl) {
  const found = [];
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const rel = /rel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    const type = /type\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? /href\s*=\s*([^\s"'>]+)/i.exec(tag)?.[1];
    if (!href || !rel.includes('alternate')) continue;
    if (!/rss|atom|xml/.test(type)) continue;
    try { found.push(new URL(href, pageUrl).href); } catch { /* пропускаем битый href */ }
  }
  return [...new Set(found)];
}
