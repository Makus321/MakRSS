import { readFile, writeFile } from 'node:fs/promises';

const dir = process.argv[2];
const coreFile = dir + '/reader-core.mjs';
const libFile = dir + '/lib/comments.mjs';
let core = await readFile(coreFile, 'utf8');
let lib = await readFile(libFile, 'utf8');
const report = [];

// 1. Провайдер умеет страницы: page=1,2,… и сообщает, есть ли продолжение
if (!lib.includes('function ljPageUrlPage')) {
  lib = lib.replace(
    "const ljPageUrl = (link) => String(link ?? '').replace(/#.*$/, '') + (String(link ?? '').includes('?') ? '&' : '?') + 'format=light';",
    "const ljPageUrl = (link, page = 1) => {\n"
    + "  const clean = String(link ?? '').replace(/#.*$/, '');\n"
    + "  const extra = 'format=light' + (page > 1 ? '&page=' + page : '');\n"
    + "  return clean + (clean.includes('?') ? '&' : '?') + extra;\n"
    + "};",
  );
  lib = lib.replace(
    'async function loadLivejournal(link, httpGet) {\n  const res = await httpGet(ljPageUrl(link),',
    'async function loadLivejournal(link, httpGet, page = 1) {\n  const res = await httpGet(ljPageUrl(link, page),',
  );
  lib = lib.replace(
    '    total: (() => {',
    '    page,\n    hasMore: Object.keys(comments).length > 0 && page < 30,\n    total: (() => {',
  );
  lib = lib.replace(
    '      load: (httpGet) => loadLivejournal(link, httpGet),',
    '      load: (httpGet, options) => loadLivejournal(link, httpGet, Number(options?.page) || 1),',
  );
  await writeFile(libFile, lib, 'utf8');
  report.push('ok — страницы комментариев в провайдере ЖЖ');
}

// 2. Маршрут принимает page и склеивает следующую страницу с уже загруженным
const oldRoute = [
  "    const body = (await store.body(found.feed.id, found.item.id)) ?? {};",
  "    const cachedAt = body.commentsAt ? Date.parse(body.commentsAt) : 0;",
  "    const fresh = body.comments && cachedAt && Date.now() - cachedAt < COMMENTS_TTL_MS;",
  "    if (fresh && url.searchParams.get('force') !== '1') {",
  '      return json(res, 200, { ok: true, supported: true, cached: true, fetchedAt: body.commentsAt, ...body.comments });',
  '    }',
].join('\n');
const newRoute = [
  "    const body = (await store.body(found.feed.id, found.item.id)) ?? {};",
  "    const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);",
  "    const cachedAt = body.commentsAt ? Date.parse(body.commentsAt) : 0;",
  "    const fresh = body.comments && cachedAt && Date.now() - cachedAt < COMMENTS_TTL_MS;",
  "    // Страница 2 и дальше: догружаем к уже сохранённым комментариям.",
  "    if (page > 1 && body.comments) {",
  '      try {',
  '        const more = await provider.load(httpGet, { page });',
  '        const known = new Set();',
  '        const collect = (nodes) => { for (const node of nodes ?? []) { known.add(String(node.id)); collect(node.children); } };',
  '        collect(body.comments.threads);',
  '        const add = (nodes) => (nodes ?? []).filter((node) => !known.has(String(node.id)));',
  '        const merged = {',
  '          ...body.comments,',
  '          threads: [...(body.comments.threads ?? []), ...add(more.threads)],',
  '          count: Number(body.comments.count ?? 0) + more.count,',
  '          page,',
  '          hasMore: Boolean(more.hasMore),',
  '        };',
  '        await store.setBody(found.feed.id, found.item.id, { comments: merged });',
  '        return json(res, 200, { ok: true, supported: true, cached: false, fetchedAt: body.commentsAt, ...merged });',
  '      } catch (err) {',
  '        return json(res, 200, { ok: false, supported: true, error: err.message, cached: true, ...body.comments });',
  '      }',
  '    }',
  "    if (fresh && url.searchParams.get('force') !== '1') {",
  '      return json(res, 200, { ok: true, supported: true, cached: true, fetchedAt: body.commentsAt, ...body.comments });',
  '    }',
].join('\n');
if (core.includes("if (page > 1 && body.comments) {")) {
  report.push('маршрут уже умеет страницы');
} else if (core.includes(oldRoute)) {
  core = core.replace(oldRoute, newRoute);
  core = core.replace('      const result = await provider.load(httpGet);', '      const result = await provider.load(httpGet, { page });');
  await writeFile(coreFile, core, 'utf8');
  report.push('ok — маршрут /api/comments принимает page');
} else {
  report.push('НЕ найден блок маршрута комментариев');
}

console.log(report.join('\n'));
