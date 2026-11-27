// Проверка CSRF для браузерных запросов: чужой Origin или Sec-Fetch-Site: cross-site.
// Вынесено в модуль, чтобы покрыть тестами: сам server.mjs не импортируется.

/**
 * Браузерный запрос с чужого сайта?
 * Скрипты, curl и клиенты Fever не присылают ни Origin, ни Sec-Fetch-Site — для них false.
 * @param {import('node:http').IncomingMessage} req
 */
export function isCrossSiteRequest(req) {
  const method = String(req.method ?? '').toUpperCase();
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH' && method !== 'DELETE') return false;
  // Браузер сам сообщает, что запрос пришёл с другого сайта. Этот заголовок нельзя
  // подделать из JS, поэтому он надёжнее сравнения Origin.
  const site = String(req.headers?.['sec-fetch-site'] ?? '').toLowerCase();
  if (site === 'cross-site') return true;
  const origin = String(req.headers?.origin ?? '').trim();
  if (!origin) return false;                       // не браузер: curl, скрипты, Fever-клиент
  try {
    const from = new URL(origin).host;
    const host = String(req.headers?.host ?? '').trim();
    return Boolean(host) && from !== host;
  } catch {
    return true;                                   // мусорный Origin — считаем чужим
  }
}
