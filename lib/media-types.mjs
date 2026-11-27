// Безопасные типы для медиа-прокси: что можно отдавать с нашего origin.
//
// Зачем отдельный модуль: иначе проверить эти правила тестами нельзя — reader-core
// тянет за собой всё хранилище. Здесь только чистые функции.

/** Растровые форматы и иконки: SVG в список не входит — он может нести скрипт. */
export const SAFE_IMAGE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
  // Иконки сайтов: не скриптуемые форматы, иначе часть лент осталась бы без значка.
  'image/x-icon', 'image/vnd.microsoft.icon', 'image/bmp',
]);

/** Тип картинки из allowlist; всё остальное отдаём потоком байт. */
export function safeImageType(raw) {
  const type = String(raw ?? '').split(';')[0].trim().toLowerCase();
  return SAFE_IMAGE_TYPES.has(type) ? type : 'application/octet-stream';
}

/** Видео: только video/* или поток байт — text/html с нашего origin был бы XSS. */
export function safeVideoType(raw) {
  const type = String(raw ?? '').split(';')[0].trim().toLowerCase();
  return /^video\/[a-z0-9.+-]+$/.test(type) ? type : 'application/octet-stream';
}

/** Заголовок, запрещающий браузеру угадывать тип содержимого. */
export const NOSNIFF = { 'x-content-type-options': 'nosniff' };
