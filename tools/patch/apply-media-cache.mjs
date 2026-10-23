import { readFile, writeFile } from 'node:fs/promises';

const dir = process.argv[2];
const corePath = dir + '/reader-core.mjs';
const insert = await readFile(dir + '/tools/patch/media-cache-insert.js.txt', 'utf8');
const head = await readFile(dir + '/tools/patch/media-cache-head.js.txt', 'utf8');
let core = await readFile(corePath, 'utf8');
const report = [];

const serveMarker = 'async function serveMedia(req, res, url) {';
if (core.includes('postHtmlForClient')) {
  report.push('уже применено');
} else {
  if (!core.includes(serveMarker)) { console.log('serveMedia не найден'); process.exit(1); }
  core = core.replace(serveMarker, insert.trimEnd());

  const oldHead = "  const feedId = url.searchParams.get('f') ?? '';";
  if (!core.includes(oldHead)) { console.log('начало serveMedia не найдено'); process.exit(1); }
  core = core.replace(oldHead, head.trimEnd());
  report.push('ok — serveMedia отдаёт из кэша');

  const bodiesOld = '        content: body.content ?? \'\',';
  if (!core.includes(bodiesOld)) { console.log('выдача content не найдена'); process.exit(1); }
  core = core.replace(bodiesOld,
    '        content: isTelegramFeed ? postHtmlForClient(feedId, item.id, body.content ?? \'\') : (body.content ?? \'\'),');
  report.push('ok — тела постов отдаются с короткими ссылками');

  const enrichAnchor = '    await store.setBody(feed.id, item.id, { content: media.content, contentFetchedAt: new Date().toISOString() });';
  if (core.includes(enrichAnchor)) {
    core = core.replace(enrichAnchor, enrichAnchor + '\n    cachePostMedia(feed.id, item.id, media.content).catch(() => {});');
    report.push('ok — картинки кэшируются при дозагрузке поста');
  } else {
    report.push('дозагрузка не найдена — кэш заполнится по первому запросу');
  }
}

await writeFile(corePath, core, 'utf8');
console.log(report.join('\n'));
