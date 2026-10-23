// Подписка на каналы Telegram двумя способами:
//  1) веб-превью https://t.me/s/<канал> — работает для публичных каналов без настройки,
//     поддерживает постраничную подгрузку истории через ?before=<id>;
//  2) Bot API — если в настройках задан токен бота, он получает новые посты каналов,
//     где добавлен администратором (для чужих публичных каналов этот путь не работает).

import { decodeEntities } from './xml.mjs';

/** Достаёт имя канала из ссылки t.me или из закодированной строки, которую выгружает внешний клиент. */
export function telegramChannelFromUrl(input) {
  let raw = String(input ?? '');
  if (/%[0-9A-Fa-f]{2}/.test(raw)) {
    try { raw = decodeURIComponent(raw); } catch { /* оставляем как есть */ }
  }
  const match = /(?:https?:\/\/)?t\.me\/(?:s\/)?([A-Za-z0-9_]{4,64})/i.exec(raw);
  if (!match) return null;
  const name = match[1];
  if (['joinchat', 'share', 'iv', 's'].includes(name.toLowerCase())) return null;
  return name;
}

export const telegramPreviewUrl = (channel, before = null) => `https://t.me/s/${channel}${before ? `?before=${before}` : ''}`;
export const telegramPostUrl = (channel, messageId) => `https://t.me/${channel}/${messageId}`;
export const telegramFileUrl = (token, filePath) => `https://api.telegram.org/file/bot${token}/${filePath}`;

/** Вырезает содержимое div с указанным классом, считая вложенные div (без DOM-парсера). */
function extractDiv(html, classPart, from = 0) {
  const re = new RegExp(`<div[^>]*class="[^"]*${classPart}[^"]*"[^>]*>`, 'i');
  const match = re.exec(html.slice(from));
  if (!match) return '';
  const start = from + match.index + match[0].length;
  let depth = 1;
  let i = start;
  while (i < html.length && depth > 0) {
    const nextOpen = html.indexOf('<div', i);
    const nextClose = html.indexOf('</div>', i);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) { depth += 1; i = nextOpen + 4; } else {
      depth -= 1;
      if (depth === 0) return html.slice(start, nextClose);
      i = nextClose + 6;
    }
  }
  return html.slice(start, i);
}

const stripTags = (html) => decodeEntities(String(html ?? '')
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' '))
  .trim();

/** Эмодзи из превью — это картинки вида //telegram.org/img/emoji/40/F09F909F.png.
 *  Имя файла — код символа в UTF-8, поэтому возвращаем настоящий эмодзи. */
const EMOJI_IMG_RE = /<img[^>]*src="(?:\/\/|https?:\/\/)telegram\.org\/img\/emoji\/\d+\/([0-9A-Fa-f]+)\.png"[^>]*>/gi;

function emojiFromHex(hex) {
  try {
    const bytes = Uint8Array.from(hex.match(/.{2}/g).map((pair) => Number.parseInt(pair, 16)));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

const cleanPostHtml = (html) => String(html)
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  // Реакции (сердечки, огоньки и прочие «плюсики») в текст поста не пускаем.
  .replace(/<i[^>]*tgme_reaction[^>]*>[\s\S]*?<\/i>/gi, ' ')
  .replace(/<span[^>]*tgme_reaction[^>]*>[\s\S]*?<\/span>/gi, ' ')
  .replace(/<div[^>]*tgme_widget_message_reactions[\s\S]*?<\/div>\s*<\/div>/gi, ' ')
  .replace(/<tg-emoji[^>]*>([\s\S]*?)<\/tg-emoji>/gi, '$1')
  .replace(/<tg-spoiler>/gi, '<span>')
  .replace(/<\/tg-spoiler>/gi, '</span>')
  .replace(EMOJI_IMG_RE, (_, hex) => emojiFromHex(hex))
  .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')          // onclick="return confirm(...)" из превью
  .replace(/\s(?:class|data-[a-z-]+|dir|style)="[^"]*"/gi, '')
  .replace(/<br\s*\/?>/gi, '<br>')
  .trim();

/**
 * Разбирает страницу веб-превью канала.
 * @returns {{ kind:'feed', format:'telegram', meta:object, items:object[], minMessageId:number|null }}
 */
/** Ссылка на видео в посте. У разных постов она лежит по-разному: в атрибуте
 *  src у <video>, внутри <source>, в data-атрибутах плеера или прямо в разметке
 *  (репосты). Берём первое, что найдётся. */
function pickVideoUrl(chunk) {
  const decode = (url) => String(url ?? '').replace(/&amp;/g, '&').replace(/&#38;/g, '&');
  const direct = /<video[^>]+src="([^"]+)"/i.exec(chunk)?.[1];
  if (direct) return decode(direct);
  const source = /<source[^>]+src="([^"]+\.mp4[^"]*)"/i.exec(chunk)?.[1];
  if (source) return decode(source);
  const dataAttr = /(?:data-src|data-video)="([^"]+\.mp4[^"]*)"/i.exec(chunk)?.[1];
  if (dataAttr) return decode(dataAttr);
  const any = /(https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*)/i.exec(chunk)?.[1];
  return decode(any || '');
}

/** Все ссылки на видео в посте: у альбомов их несколько. */
function pickVideoUrls(chunk) {
  const decode = (url) => String(url ?? '').replace(/&amp;/g, '&').replace(/&#38;/g, '&');
  const urls = new Set();
  for (const m of String(chunk).matchAll(/<(?:video|source)\b[^>]*\bsrc="([^"]+)"/gi)) {
    if (/\.mp4/i.test(m[1])) urls.add(decode(m[1]));
  }
  for (const m of String(chunk).matchAll(/(?:data-src|data-video)="([^"]+\.mp4[^"]*)"/gi)) {
    urls.add(decode(m[1]));
  }
  for (const m of String(chunk).matchAll(/(https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*)/gi)) {
    urls.add(decode(m[1]));
  }
  return [...urls];
}

export function parseTelegramChannel(html, channelUrl, feedId, itemIdFactory) {
  const channelName = telegramChannelFromUrl(channelUrl) ?? '';
  const titleMatch = /<div class="tgme_channel_info_header_title"[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/i.exec(html)
    ?? /<meta[^>]+property="og:title"[^>]*content="([^"]+)"/i.exec(html);
  const descMatch = /<div class="tgme_channel_info_description"[^>]*>([\s\S]*?)<\/div>/i.exec(html);
  const meta = {
    title: titleMatch ? stripTags(titleMatch[1]) : `Telegram: ${channelName}`,
    siteUrl: `https://t.me/${channelName}`,
    description: descMatch ? stripTags(descMatch[1]).slice(0, 300) : '',
    // Аватар канала — чтобы в дереве была картинка, а не точка.
    icon: /class="tgme_page_photo_image"[^>]*>[\s\S]{0,200}?src="([^"]+)"/i.exec(html)?.[1]
      ?? /<meta[^>]+property="og:image"[^>]*content="([^"]+)"/i.exec(html)?.[1]
      ?? '',
  };

  const positions = [];
  const postRe = /data-post="([^"]+)"/g;
  let match;
  while ((match = postRe.exec(html)) !== null) {
    if (positions.some((p) => p.post === match[1])) continue;
    positions.push({ post: match[1], index: match.index });
  }

  const items = [];
  let minMessageId = null;
  positions.forEach((entry, i) => {
    const chunk = html.slice(entry.index, positions[i + 1]?.index ?? html.length);
    const [channel, messageIdRaw] = entry.post.split('/');
    const messageId = Number.parseInt(messageIdRaw, 10);
    if (Number.isFinite(messageId)) minMessageId = minMessageId === null ? messageId : Math.min(minMessageId, messageId);

    // В ответах и репостах первым идёт текст цитируемого сообщения
    // (js-message_reply_text) — он ещё и обрезан многоточием. Раньше в пост
    // попадал именно он, поэтому было видно только кусок цитаты. Берём основной
    // текст (js-message_text), а цитату добавляем отдельной врезкой.
    const mainIndex = chunk.search(/<div[^>]*class="[^"]*js-message_text[^"]*"/i);
    const textHtml = mainIndex >= 0
      ? extractDiv(chunk, 'tgme_widget_message_text', mainIndex)
      : extractDiv(chunk, 'tgme_widget_message_text');
    const replyIndex = chunk.search(/<a[^>]*class="[^"]*tgme_widget_message_reply[^"]*"/i);
    const quoteHtml = replyIndex >= 0 ? extractDiv(chunk, 'tgme_widget_message_text', replyIndex) : '';
    const quoteAuthor = replyIndex >= 0
      ? stripTags(/<span[^>]*class="[^"]*tgme_widget_message_author_name[^"]*"[^>]*>([\s\S]*?)<\/span>/i
        .exec(chunk.slice(replyIndex, replyIndex + 2000))?.[1] ?? '')
      : '';
    // Фотографии берём только из обёрток фото и видео: у реакций тоже есть
    // background-image, и раньше они попадали в текст поста как «картинки».
    // Эмодзи-картинки (telegram.org/img/emoji) — это кастомные эмодзи в тексте, не фото.
    // Обложка видео лежит не в <a>, а в <i class="tgme_widget_message_video_thumb">,
    // поэтому смотрим любой тег с нужным классом — иначе у постов с видео
    // (в том числе репостов) картинка пропадала совсем.
    const photos = [...chunk.matchAll(/<[a-z]+\b[^>]*>/gi)]
      .map((m) => m[0])
      .filter((tag) => /tgme_widget_message_photo_wrap|tgme_widget_message_video_thumb/i.test(tag))
      .map((tag) => /background-image:url\('([^']+)'\)/i.exec(tag)?.[1])
      .filter((url) => url && !/telegram\.org\/img\/emoji/i.test(url));
    const videos = pickVideoUrls(chunk);
    const video = videos[0] ?? pickVideoUrl(chunk);
    const time = /<time[^>]+datetime="([^"]+)"/i.exec(chunk)?.[1] ?? null;
    const text = stripTags(textHtml);
    if (!text && !photos.length && !video) return;      // служебные сообщения
    if (/tgme_widget_message_service/i.test(chunk) && !text) return;

    const link = telegramPostUrl(channel, messageId);
    const parts = [];
    // Цитата — отдельной врезкой перед текстом: она поясняет, о чём пост.
    if (quoteHtml.trim()) {
      const quoteText = cleanPostHtml(quoteHtml);
      if (quoteText.trim()) parts.push(`<blockquote>${quoteAuthor ? `<b>${quoteAuthor}</b><br>` : ''}${quoteText}</blockquote>`);
    }
    if (textHtml.trim()) parts.push(`<p>${cleanPostHtml(textHtml)}</p>`);
    // Фотографии ставим в текст всегда — и одну тоже: в режиме «Полностью» карточка
    // показывает только текст, и одиночная картинка иначе пропадала совсем.
    if (photos.length) parts.push(photos.map((url) => `<p><img src="${url}" alt=""></p>`).join('\n'));
    // Видео: у поста их может быть несколько (альбом) — выводим каждое отдельным плеером.
    if (videos.length) {
      const poster = photos[0] ?? '';
      parts.push(videos.map((url) => `<p><video src="${url}" controls preload="none"${poster ? ` poster="${poster}"` : ''}></video></p>`).join('\n'));
    }
    // Ссылку на видео оставляем как запасной путь: кнопку «Просмотреть видео»
    // читалка добавляет сама (поле video ниже) и проигрывает видео через прокси.
    // Ссылку на пост не добавляем: он открывается кликом по заголовку в читалке.

    items.push({
      id: itemIdFactory(feedId, link),
      // У постов Telegram нет заголовка: вместо него — имя канала, а сам текст
      // показывается в кратком описании и в статье.
      title: meta.title,
      link,
      date: time && Number.isFinite(Date.parse(time)) ? new Date(time).toISOString() : null,
      author: meta.title,
      // Столько же, сколько у обычных лент: в кратком виде бывает до 10 строк.
      excerpt: text.slice(0, 1500),
      content: parts.join('\n'),
      image: photos[0] ?? '',
      video,                             // прямая ссылка на видео (если пост с видео)
      categories: ['telegram'],
      messageId,
    });
  });

  return { kind: 'feed', format: 'telegram', meta, items, minMessageId };
}

// --------------------------------------------------------------- Bot API

export async function telegramBotMe(token, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: controller.signal });
    const payload = await res.json().catch(() => ({}));
    if (!payload.ok) return { ok: false, error: payload.description ?? `HTTP ${res.status}` };
    return { ok: true, username: payload.result.username, id: payload.result.id, name: payload.result.first_name };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'таймаут' : (err.cause?.message ?? err.message) };
  } finally {
    clearTimeout(timer);
  }
}

export async function telegramGetUpdates(token, offset, timeout = 30) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (timeout + 15) * 1000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ offset, timeout, allowed_updates: ['channel_post', 'edited_channel_post'] }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!payload.ok) return { ok: false, error: payload.description ?? `HTTP ${res.status}` };
    return { ok: true, updates: payload.result ?? [] };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'таймаут' : (err.cause?.message ?? err.message) };
  } finally {
    clearTimeout(timer);
  }
}

const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Преобразует текст с entities (формат Bot API) в HTML. */
export function telegramTextToHtml(text, entities = []) {
  if (!text) return '';
  const utf16ToChars = (index) => [...text.slice(0, index)].length;
  const marks = [];
  for (const entity of entities) {
    const start = utf16ToChars(entity.offset);
    const end = utf16ToChars(entity.offset + entity.length);
    let open = '';
    let close = '';
    if (entity.type === 'bold') { open = '<b>'; close = '</b>'; }
    else if (entity.type === 'italic') { open = '<i>'; close = '</i>'; }
    else if (entity.type === 'underline') { open = '<u>'; close = '</u>'; }
    else if (entity.type === 'strikethrough') { open = '<s>'; close = '</s>'; }
    else if (entity.type === 'spoiler') { open = '<span>'; close = '</span>'; }
    else if (entity.type === 'code') { open = '<code>'; close = '</code>'; }
    else if (entity.type === 'pre') { open = '<pre>'; close = '</pre>'; }
    else if (entity.type === 'blockquote') { open = '<blockquote>'; close = '</blockquote>'; }
    else if (entity.type === 'text_link' && entity.url) { open = `<a href="${entity.url}">`; close = '</a>'; }
    else if (entity.type === 'text_mention' && entity.user?.id) { open = `<a href="tg://user?id=${entity.user.id}">`; close = '</a>'; }
    else continue;
    marks.push({ index: start, open: true, html: open });
    marks.push({ index: end, open: false, html: close });
  }
  marks.sort((a, b) => a.index - b.index || (a.open ? 1 : -1));
  const chars = [...text];
  let out = '';
  let cursor = 0;
  for (const mark of marks) {
    if (mark.index > cursor) out += escapeHtml(chars.slice(cursor, mark.index).join(''));
    out += mark.html;
    cursor = Math.max(cursor, mark.index);
  }
  out += escapeHtml(chars.slice(cursor).join(''));
  return out.replace(/\n/g, '<br>');
}

/** Разбирает обновление Bot API в пост канала. */
export function parseBotUpdate(update) {
  const message = update.channel_post ?? update.edited_channel_post;
  if (!message?.chat || message.chat.type !== 'channel') return null;
  const chat = message.chat;
  const html = telegramTextToHtml(message.text ?? message.caption ?? '', message.entities ?? message.caption_entities ?? []);
  const photos = (message.photo ?? []).map((size) => size.file_id);
  const link = chat.username
    ? telegramPostUrl(chat.username, message.message_id)
    : `https://t.me/c/${String(chat.id).replace(/^-100/, '')}/${message.message_id}`;
  return {
    channel: {
      id: chat.id,
      username: chat.username ?? '',
      title: chat.title ?? (chat.username ? `@${chat.username}` : String(chat.id)),
      url: chat.username ? `https://t.me/${chat.username}` : `https://t.me/c/${String(chat.id).replace(/^-100/, '')}`,
    },
    post: {
      messageId: message.message_id,
      date: new Date((message.date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      html,
      link,
      text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      photoFileId: photos.length ? photos[photos.length - 1] : '',
      hasVideo: Boolean(message.video || message.animation || message.video_note),
      hasDocument: Boolean(message.document),
    },
  };
}
