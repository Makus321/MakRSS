// Учёт трафика: сколько байт отдано по каждому маршруту. Нужен для контроля
// объёма между сервером и приложением; на работу читалки не влияет.
import { writeFile } from 'node:fs/promises';

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
      await writeFile(file, JSON.stringify(snapshot), 'utf8');
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
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const route = `${req.method} ${url.pathname}`;
  let bytes = 0;
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  res.write = (chunk, ...rest) => {
    if (chunk) bytes += Buffer.byteLength(chunk);
    return write(chunk, ...rest);
  };
  res.end = (chunk, ...rest) => {
    if (chunk) bytes += Buffer.byteLength(chunk);
    return end(chunk, ...rest);
  };
  res.on('finish', () => {
    const entry = stats.routes[route] ?? (stats.routes[route] = { n: 0, bytes: 0 });
    entry.n += 1;
    entry.bytes += bytes;
    scheduleDump(file);
  });
}
