// Извлечение основного текста статьи из HTML-страницы.
// Специально без DOM-парсера: HTML в интернете редко корректный XML, поэтому
// работает «сбор урожая» — берём осмысленные блоки (абзацы, списки, цитаты,
// заголовки), отбрасываем навигацию и рекламу, сохраняя порядок документа.

import { decodeEntities } from './xml.mjs';
import { stripFeedNoise } from './feed.mjs';

const BLOCK_RE = /<(p|h1|h2|h3|h4|h5|blockquote|pre|ul|ol|table|figure)\b([^>]*)>([\s\S]*?)<\/\1>/gi;

// Навигация, подвалы и прочий «обвес» страницы. Точные совпадения — для коротких
// пунктов меню, префиксные — для рекламных врезок в начале абзаца.
const JUNK_EXACT = /^\s*(сейчас на главной|на главной сейчас|сейчас читают|читают сейчас|популярное|самое читаемое|читайте также|главное за день|новости партнёров|реклама|читать также|читайте также|материалы по теме|подписывайтесь|подпишитесь|комментарии|поделиться|источник|share|advertisement|sponsored|related articles|sign up|subscribe|читайте нас:?|приложения жж|компания|продукты|комьюнити|выбрать язык|политика конфиденциальности|пользовательское соглашение|на информационном ресурсе применяются рекомендательные технологии в соответствии с правилами|помощь|зарегистрироваться|войти|войти по cбер id|нет аккаунта\?|категория:?|жж видео|lj video|главная|топ|интересное|english|deutsch|follow us:?|applications|products|community|choose language|adult content|recommend this entry|has been recommended|send news)\s*$/i;
const JUNK_PREFIX = /^\s*(реклама|читать также|читайте также|материалы по теме|новости партнёров|подписывайтесь|подпишитесь|комментари|обсуждени|поделиться|источник|share|advertisement|sponsored|related articles|sign up|subscribe|если у вас не работает один из способов авторизации)/i;

// Рубрики-разделители: всё, что идёт в статье ниже такой строки, — подборка
// чужих материалов (у ixbt.games это «Сейчас на главной» и сетка анонсов).
const JUNK_HEADING = /^\s*(сейчас на главной|на главной|на главной сейчас|сейчас читают|читают сейчас|популярное|самое читаемое|самое популярное|читайте также|читайте по теме|по теме|ещё по теме|еще по теме|другие новости|новости по теме|главное за день|новости партнёров|рекомендуем|вам может понравиться)\s*:?\s*$/i;

// Фразы-маркеры «обвеса» страницы (шапка, меню языков, подвал). Достаточно
// специфичные, чтобы не задеть предложения самой статьи.
const JUNK_SENTENCE = /(follow us:|applications\s+products|products\s+community|choose language|выбрать язык|приложения жж|компания\s+продукты|комьюнити|privacy policy.{0,40}user agreement|политика конфиденциальности.{0,60}пользовательское соглашение|if this type of authorization|если у вас не работает один из способов авторизации|рекомендательные технологии в соответствии с правилами|нет аккаунта\?|no account\?|зарегистрироваться\s+войти|recommend this entry|has been recommended|send news|journal information|adult content notice|to continue, you must confirm|if you don't want to see this message again|warn me before displaying|информация об этом журнале|цена размещения|социальный капитал|в друзьях у|минимальная ставка|посмотреть все предложения|жж видео|lj video)/i;

/** Выбрасывает из готовых блоков «обвес»: целиком — заголовки меню, по предложениям — абзацы. */
function stripJunkSentences(html) {
  return String(html).replace(/<(p|h[1-6]|li|blockquote)\b([^>]*)>([\s\S]*?)<\/\1>/gi, (whole, tag, attrs, inner) => {
    const text = htmlToText(inner);
    if (!text) return whole;
    if (JUNK_EXACT.test(text)) return '';                      // блок целиком — пункт меню
    if (!JUNK_SENTENCE.test(text)) return whole;
    if (/^h[1-6]$/i.test(tag)) return '';                      // заголовок-обвес убираем целиком
    const kept = text
      .split(/(?<=[.!?…])\s+/)
      .filter((sentence) => !JUNK_SENTENCE.test(sentence) && sentence.trim().length > 15);
    const rest = kept.join(' ').trim();
    return rest.length >= 40 ? `<p>${rest.replace(/[<>]/g, '')}</p>` : '';
  });
}

const KEEP_ATTRS = new Set(['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'datetime']);

const htmlToText = (html) => decodeEntities(String(html ?? '')
  .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' '))
  .trim();

function absolutize(url, base) {
  const raw = String(url ?? '').trim();
  if (!raw || /^(data:|mailto:|#)/i.test(raw)) return raw;
  try { return new URL(raw, base).href; } catch { return raw; }
}

/** Чистит HTML блока: убирает опасное, оставляет только безопасные атрибуты. */
function cleanBlock(html, base) {
  let out = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|iframe|svg|form|input|button|select|textarea|audio|canvas|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(script|style|iframe|link|meta|input|br)\b[^>]*>/gi, (tag) => (/^<br/i.test(tag) ? '<br>' : ' '));

  // Ссылка вокруг картинки — просто обёртка: снимаем её, иначе вёрстка
  // обращается с картинкой как со строчной ссылкой и она «схлопывается».
  out = out.replace(/<a\b[^>]*>\s*(<img\b[^>]*>)\s*<\/a>/gi, '$1');

  out = out.replace(/<([a-z0-9-]+)((?:\s+[^>]*)?)\/?>/gi, (match, tag, rawAttrs) => {
    const attrs = [];
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
    let m;
    while ((m = re.exec(rawAttrs)) !== null) {
      const name = m[1].toLowerCase();
      if (!KEEP_ATTRS.has(name)) continue;
      let value = m[3] ?? m[4] ?? m[5] ?? '';
      if (name === 'href' || name === 'src') value = absolutize(value, base);
      if ((name === 'href' || name === 'src') && !/^(https?:|data:image\/|mailto:|#)/i.test(value)) continue;
      attrs.push(`${name}="${value.replace(/"/g, '&quot;')}"`);
    }
    return `<${tag.toLowerCase()}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
  });
  return out.trim();
}

const linkTextLength = (html) => {
  let total = 0;
  const re = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) total += htmlToText(m[1]).length;
  return total;
};

function isUsefulBlock(tag, html) {
  const text = htmlToText(html);
  if (JUNK_EXACT.test(text) || JUNK_PREFIX.test(text)) return false;
  const hasImage = /<img\b/i.test(html);
  if (tag === 'figure' || tag === 'table') return text.length >= 60 || hasImage;
  // Заголовки оставляем даже короткие («ИИнга», «Итоги»): раньше порог в 8
  // символов съедал названия разделов.
  if (/^h[1-5]$/.test(tag)) return text.length >= 1 && text.length <= 200;
  // Список ссылок (меню, языки, «читайте нас») — не текст статьи.
  const linkLength = linkTextLength(html);
  if (text.length && linkLength / text.length > 0.6) return false;
  const links = (html.match(/<a\b/gi) ?? []).length;
  if (links >= 6 && text.length < 200) return false;
  if (tag === 'ul' || tag === 'ol') return text.length >= 150;
  if (text.length < 40 && !hasImage) return false;
  return true;
}

/** Похоже ли извлечённое на «обвес» страницы (меню, шапка, подвал), а не на статью. */
export function looksLikePageChrome(html) {
  const text = htmlToText(html);
  if (!text) return true;
  const markers = /(Главная Топ Интересное|Follow us:|CHOOSE LANGUAGE|ВЫБРАТЬ ЯЗЫК|Цена размещения|Длительность \d+ час|LJ Video|ЖЖ Видео|Информация об этом журнале|Политика конфиденциальности|Recommend this entry|Journal information|Приложения ЖЖ|рекомендательные технологии)/i;
  if (!markers.test(text)) return false;
  // Если «обвес» занимает заметную долю текста — доверять такому извлечению нельзя.
  const junkShare = text.split(/(?<=[.!?…])\s+/).filter((s) => markers.test(s)).join(' ').length / text.length;
  return text.length < 1200 || junkShare > 0.25;
}

/** Блоки-«анонсы» на страницах статей: чужие карточки, похожие материалы, подписки.
 *  Их разметку узнаём по классам и убираем до извлечения текста — иначе в читалку
 *  попадают заголовки и описания других статей (так было на Mobile-Review).
 *  Берём только заведомо «анонсные» классы: слишком общие (banner, advert, social)
 *  могут оказаться обёрткой вокруг всей статьи. */
const JUNK_BLOCK = /class="[^"]*(external-links|simple-block|related-posts|yarpp|teaser|newsletter|now-reading|nowreading|popular|trending|read-also|most-read)[^"]*"/i;
/** Блок крупнее этого — почти наверняка обёртка, а не анонс: не трогаем. */
const JUNK_MAX_BYTES = 30000;

function stripJunkBlocks(html) {
  let result = html;
  for (let guard = 0; guard < 40; guard += 1) {
    const match = JUNK_BLOCK.exec(result);
    if (!match) break;
    // Находим начало элемента с этим классом и его закрывающий тег с учётом вложенности.
    const start = result.lastIndexOf('<', match.index);
    const openTag = /^<([a-zA-Z0-9]+)/.exec(result.slice(start));
    if (!openTag) { result = result.slice(0, start) + result.slice(start + 1); continue; }
    const tag = openTag[1].toLowerCase();
    const openRe = new RegExp(`<${tag}\\b`, 'gi');
    const closeRe = new RegExp(`</${tag}\\s*>`, 'gi');
    let depth = 0;
    let end = result.length;
    let cursor = start;
    while (cursor < result.length) {
      openRe.lastIndex = cursor;
      closeRe.lastIndex = cursor;
      const nextOpen = openRe.exec(result);
      const nextClose = closeRe.exec(result);
      if (!nextClose) break;
      if (nextOpen && nextOpen.index < nextClose.index) { depth += 1; cursor = nextOpen.index + 1; } else {
        depth -= 1;
        cursor = nextClose.index + nextClose[0].length;
        if (depth === 0) { end = cursor; break; }
      }
    }
    if (end - start > JUNK_MAX_BYTES) break;      // это обёртка, а не анонс
    result = result.slice(0, start) + result.slice(Math.min(end, result.length));
  }
  return result;
}

/**
 * Достаёт заголовок и основной текст страницы.
 * @returns {{ title: string, html: string, textLength: number, image: string }}
 */
/**
 * Дополняет разобранный текст тем, что разбор пропустил:
 *  — картинки, лежащие в <div> (а не в абзацах) — иначе у сайтов вроде ixbt.games
 *    в статье остаются единицы изображений;
 *  — встроенные видео: прямой адрес .mp4 из данных страницы (играется нашим плеером,
 *    в том числе через прокси).
 */
/**
 * Сайты часто кладут картинку в <div>, а разбор понимает только <figure>. Такой
 * блок превращаем в <figure> прямо в исходной странице — тогда картинка встаёт
 * на своё место в тексте, а не сваливается в конец.
 */
function promoteImageBlocks(html) {
  return html.replace(/<div\b([^>]*)>((?:(?!<div\b)[\s\S])*?)<\/div>/gi, (whole, attrs, inner) => {
    if (!/<img\b/i.test(inner)) return whole;
    if (/<p\b|<h[1-6]\b|<ul\b|<table\b|<figure\b/i.test(inner)) return whole;
    const textOnly = inner.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').trim();
    if (textOnly.length > 40) return whole;                 // подпись/текст — не только картинка
    if (/logo|icon|avatar|sprite|pixel/i.test(inner)) return whole;
    return `<figure${attrs}>${inner}</figure>`;
  });
}

function addMissedMedia(html, source, base, heroImage = '') {
  const seen = new Set([...html.matchAll(/<img\b[^>]*src="([^"]+)"/gi)].map((m) => m[1]));
  const extras = [];

  // Адрес видео лежит в данных страницы в JSON — со слэшами, экранированными как \/.
  // Заглавная картинка (og:image) часто лежит вне текста статьи: если её нет
  // в разобранном тексте, показываем в начале — иначе статья без иллюстрации.
  let hero = '';
  if (heroImage) {
    const src = absolutize(heroImage, base);
    if (/^https?:/i.test(src) && !html.includes(src)) {
      // Заглавная картинка ставится ПЕРВОЙ: иначе при раскрытии она оказывалась
      // в конце статьи и «перескакивала» вниз.
      hero = `<figure><img src="${src.replace(/"/g, '&quot;')}" alt=""></figure>\n`;
    }
  }

  const rawVideo = /"(?:video_url|streaming_url|mp4_url)"\s*:\s*"([^"]+\.mp4[^"]*)"/i.exec(source)?.[1];
  if (rawVideo) {
    const src = rawVideo.replace(/\\\//g, '/').replace(/^\/\//, 'https://');
    if (/^https?:/i.test(src) && !html.includes(src)) {
      extras.push(`<figure><video controls preload="none" playsinline src="${src}"></video></figure>`);
    }
  }

  return extras.length || hero ? `${hero}${html}\n${extras.join('\n')}` : html;
}

/** Находит закрывающий </div> для открытого на позиции start (с учётом вложенности). */
function matchingDivEnd(html, start) {
  let depth = 0;
  const re = /<div\b|<!--[\s\S]*?-->|<\/div>/gi;
  re.lastIndex = start;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[0].startsWith('<!--')) continue;
    if (m[0] === '</div>') {
      depth -= 1;
      if (depth === 0) return m.index + m[0].length;
    } else depth += 1;
  }
  return -1;
}

/**
 * Убирает служебные рубрики вместе с их содержимым: «Сейчас на главной»,
 * «Читайте также» и подобные — под ними сайты показывают сетку чужих анонсов.
 */
function stripHeadingSections(html) {
  let result = html;
  for (let guard = 0; guard < 6; guard += 1) {
    const heading = /<h[1-4]\b[^>]*>\s*(сейчас на главной|на главной сейчас|сейчас читают|читают сейчас|самое читаемое|самое популярное|читайте также|читайте по теме|ещё по теме|еще по теме|другие новости|новости по теме|новости партнёров|вам может понравиться)\s*:?\s*<\/h[1-4]>/i.exec(result);
    if (!heading) break;
    // После заголовка идёт сетка карточек — её и убираем вместе с заголовком.
    const after = heading.index + heading[0].length;
    const gridAt = result.indexOf('<div', after);
    if (gridAt < 0) break;
    // Сетка должна идти сразу за заголовком (между ними только пробелы).
    if (result.slice(after, gridAt).trim()) break;
    const end = matchingDivEnd(result, gridAt);
    if (end < 0) break;
    result = result.slice(0, heading.index) + result.slice(end);
  }
  return result;
}

export function extractArticle(pageHtml, baseUrl = '') {
  const markEmbeds = (raw) => String(raw).replace(
    /<[^>]+\bdata-(?:embed-url|video-src)="([^"]+)"[^>]*>/gi,
    (match, url) => {
      const id = /(?:youtube\.com\/embed\/|youtu\.be\/|youtube\.com\/watch\?v=)([\w-]{6,})/i.exec(url)?.[1];
      if (id) return `<p>Видео к этой новости: смотреть видео youtube:${id}</p>`;
      return /^https?:/i.test(url) ? `<p>Видео к этой новости: смотреть видео embed:${url}</p>` : match;
    },
  );
  // Плееры: <iframe>/<video> вырезаются при очистке, поэтому заранее оставляем
  // от них текстовую заметку — клиент превращает её в кнопку «открыть видео».
  const markPlayers = (raw) => String(raw)
    .replace(/<iframe\b[^>]*\bsrc=["']([^"']+)["'][^>]*>(?:[\s\S]*?<\/iframe>)?/gi, (match, url) => {
      const href = String(url).replace(/&#0*38;|&amp;/gi, '&');
      if (/adriver|doubleclick|googlesyndication|an\.yandex\.ru/i.test(href)) return ' ';
      const id = /(?:youtube\.com\/embed\/|youtube-nocookie\.com\/embed\/|youtu\.be\/)([\w-]{6,})/i.exec(href)?.[1];
      if (id) return `<p>Видео к этой новости: смотреть видео youtube:${id}</p>`;
      return /^https?:/i.test(href) ? `<p>Видео к этой новости: смотреть видео embed:${href}</p>` : ' ';
    })
    .replace(/<video\b[^>]*>[\s\S]*?<\/video>/gi, (block) => {
      const href = /\bsrc=["']([^"']+)["']/i.exec(block)?.[1]
        ?? /<source\b[^>]*\bsrc=["']([^"']+)["']/i.exec(block)?.[1]
        ?? '';
      return /^https?:/i.test(href) ? `<p>Видео к этой новости: смотреть видео embed:${href}</p>` : ' ';
    });
  const source = promoteImageBlocks(stripJunkBlocks(stripHeadingSections(markPlayers(markEmbeds(pageHtml ?? '')))));
  const pick = (re) => {
    const m = re.exec(source);
    return m ? htmlToText(m[1]) : '';
  };
  const title = pick(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
    || pick(/<meta[^>]+name=["']twitter:title["'][^>]*content=["']([^"']+)["']/i)
    || pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const image = (() => {
    const m = /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i.exec(source)
      || /<meta[^>]+name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i.exec(source);
    return m ? absolutize(m[1], baseUrl) : '';
  })();

  const body = source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|template|nav|footer|header|aside|form)\b[\s\S]*?<\/\1>/gi, ' ')
    // Снимаем обёртки <div>: так абзацы перестают быть вложенными друг в друга
    // и извлекаются независимо, без риска «съесть» содержимое.
    .replace(/<\/?div\b[^>]*>/gi, ' ');

  const kept = [];
  let totalText = 0;
  BLOCK_RE.lastIndex = 0;
  let match;
  while ((match = BLOCK_RE.exec(body)) !== null) {
    const [raw, tag, , inner] = match;
    const text = htmlToText(inner);
    totalText += text.length;
    if (!isUsefulBlock(tag.toLowerCase(), inner)) continue;
    kept.push({ index: match.index, html: cleanBlock(`<${tag}>${inner}</${tag}>`, baseUrl), text });
  }

  // Текст, лежащий прямо в <div> без абзацев: берём отдельные текстовые узлы —
  // это естественные строки страницы, поэтому меню и подвал отсеиваются по длине.
  let leftover = '';
  if (kept.reduce((n, b) => n + b.text.length, 0) < totalText * 0.6) {
    const withoutBlocks = body.replace(BLOCK_RE, ' ');
    const segments = withoutBlocks
      .replace(/<[^>]+>/g, '\u0000')
      .split('\u0000')
      .map((chunk) => htmlToText(chunk))
      .filter((chunk) => chunk.length >= 60
        && !JUNK_EXACT.test(chunk)
        && !JUNK_PREFIX.test(chunk)
        && /[.!?…]/.test(chunk));
    if (segments.length) leftover = segments.map((chunk) => `<p>${chunk.replace(/[<>]/g, '')}</p>`).join('\n');
  }

  const useful = kept;

  // Подряд идущие картинки собираем в один блок .img-row: вёрстка раскладывает их
  // в несколько колонок, если по ширине помещается больше одной. Без этого узкие
  // кадры шли по одному и статью приходилось долго прокручивать.
  const grouped = [];
  let run = [];
  const flushRun = () => {
    if (run.length >= 2) {
      grouped.push(`<div class="img-row">${run.join('')}</div>`);
    } else {
      grouped.push(...run);
    }
    run = [];
  };
  for (const block of useful) {
    const onlyImage = /<img\b/i.test(block.html) && block.text.length === 0;
    if (onlyImage) run.push(block.html);
    else { flushRun(); grouped.push(block.html); }
  }
  flushRun();

  let html = stripJunkSentences(stripFeedNoise(grouped.join('\n') + (leftover ? `\n${leftover}` : '')));

  // Запасной разбор: у части сайтов (например, LiveJournal) текст лежит внутри
  // <article> с обёртками, и основной проход отбрасывает его целиком. Тогда
  // берём абзацы и картинки прямо из статьи.
  if (htmlToText(html).length < 200) {
    const container = /<article\b[\s\S]*?<\/article>/i.exec(source)?.[0]
      ?? /<div[^>]+class=["'][^"']*(?:entry-content|post-content|article-body|story-body)[^"']*["'][\s\S]*?<\/div>/i.exec(source)?.[0]
      ?? '';
    if (container) {
      const blocks = [...container.matchAll(/<(p|h2|h3|blockquote|figure|img)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi)]
        .map((m) => m[0]);
      const cleaned = blocks
        .map((block) => cleanBlock(block, baseUrl))
        .filter((block) => /<img\b/i.test(block) || htmlToText(block).length >= 40);
      const fallback = stripJunkSentences(stripFeedNoise(cleaned.join('\n')));
      if (htmlToText(fallback).length > htmlToText(html).length) html = fallback;
    }
  }

  const withMedia = addMissedMedia(html, source, baseUrl, image);
  const textLength = htmlToText(html).length;
  return { title, html: withMedia, textLength, image };
}
