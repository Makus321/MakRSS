// Учёт трафика: сколько байт отдано по каждому маршруту. Нужен для контроля
// объёма между сервером и приложением; на работу читалки не влияет.
import { rename, writeFile } from 'node:fs/promises';

let dumpSeq = 0;   // уникальные имена временных файлов статистики

const stats = { since: new Date().toISOString(), routes: {} };
let dumpTimer = null;

function scheduleDump(file) {
  if (dumpTimer) return;
  dumpTimer = setTimeout(async () => {
    dumpTimer = null;
    try {
      const snapshot = { since: stats.since, routes: {} };
      for (const [route, value] of Object.entries(stats.routes)) {
        snapshot.routes[route] = { n: value.n, bytes: value.bytes };
      }
      // Пишем через временный файл: при аварийном завершении не остаётся
      // обрезанный JSON, из-за которого статистика потом не читалась.
      const tmp = `${file}.${process.pid}.${(dumpSeq += 1)}.tmp`;
      await writeFile(tmp, JSON.stringify(snapshot), 'utf8');
      await rename(tmp, file);
    } catch { /* не критично */ }
  }, 2000);
  dumpTimer.unref?.();
}

/**
 * Оборачивает ответ, чтобы посчитать отданные байты.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} file путь для снимка статистики
 */
export function trackTraffic(req, res, file) {
  // Адрес может быть невалидным (битый request-target): статистика не должна
  // ронять обработчик запроса, поэтому разбор защищён и не зависит от Host.
  let pathname = '';
  let search = '';
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    pathname = url.pathname;
    // В ключ включаем параметры запроса: без них не видно, полный список ушёл или страница.
    search = url.search ? '?' + [...url.searchParams.keys()].sort().join('&') : '';
  } catch { /* считаем запрос как OTHER */ }
  // Сканеры и случайные адреса давали тысячи ключей и раздували файл:
  // известные маршруты считаем как есть, всё остальное — одной строкой OTHER.
  const raw = `${req.method} ${pathname}${search}`;
  const interesting = Boolean(pathname) && (pathname.startsWith('/api/') || pathname.startsWith('/fever/')
    || pathname === '/admin' || pathname.startsWith('/admin/')
    || /\.(css|js|png|svg|ico|webmanifest|woff2?|ttf)$/.test(pathname));
  const route = interesting ? raw : `${req.method} OTHER`;
  let bytes = 0;
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  // chunk бывает функцией обратного вызова (res.end(cb)): Buffer.byteLength на ней
  // бросал TypeError и ронял ответ. Считаем только строки и буферы.
  const sizeOf = (chunk) => (typeof chunk === 'string' || Buffer.isBuffer(chunk)
    ? Buffer.byteLength(chunk)
    : 0);
  res.write = (chunk, ...rest) => {
    bytes += sizeOf(chunk);
    return write(chunk, ...rest);
  };
  res.end = (chunk, ...rest) => {
    bytes += sizeOf(chunk);
    return end(chunk, ...rest);
  };
  res.on('finish', () => {
    const known = stats.routes[route];
    if (!known && Object.keys(stats.routes).length >= 500) return;   // защита от распухания файла
    const entry = known ?? (stats.routes[route] = { n: 0, bytes: 0 });
    entry.n += 1;
    entry.bytes += bytes;
    scheduleDump(file);
  });
}
