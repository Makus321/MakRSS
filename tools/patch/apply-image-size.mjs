import { readFile, writeFile } from 'node:fs/promises';

const dir = process.argv[2];
const corePath = dir + '/reader-core.mjs';
let core = await readFile(corePath, 'utf8');
const report = [];

// 1. Размер картинки читается из рядом лежащего файла .json
if (!core.includes('async function cachedMediaSize')) {
  const helper = [
    '/** Размер картинки из кэша: нужен, чтобы место под неё резервировалось сразу. */',
    'async function cachedMediaSize(feedId, itemId, index) {',
    '  try {',
    '    const raw = await readFile(path.join(MEDIA_DIR, postMediaFile(feedId, itemId, index) + ".json"), "utf8");',
    '    const parsed = JSON.parse(raw);',
    '    if (Number(parsed?.width) > 0 && Number(parsed?.height) > 0) {',
    '      return { width: Number(parsed.width), height: Number(parsed.height) };',
    '    }',
    '  } catch { /* размера ещё нет */ }',
    '  return null;',
    '}',
    '',
    'async function postHtmlForClient(feedId, itemId, html) {',
  ].join('\n');
  const marker = 'async function postHtmlForClient(feedId, itemId, html) {';
  if (!core.includes(marker)) { console.log('не найден postHtmlForClient'); process.exit(1); }
  core = core.replace(marker, helper);
  report.push('ok — функция чтения размера');
}

// 2. При выдаче картинки подставляем width/height
const oldPush = "      pieces.push('<img' + before + ' src=\"/api/media?f=' + feedId + '&k=' + itemId + '&i=' + current + '\">');";
if (core.includes(oldPush)) {
  const newPush = [
    "      const known = await cachedMediaSize(feedId, itemId, current);",
    "      const dimension = known ? ' width=\"' + known.width + '\" height=\"' + known.height + '\"' : '';",
    "      pieces.push('<img' + before + ' src=\"/api/media?f=' + feedId + '&k=' + itemId + '&i=' + current + '\"' + dimension + '>');",
  ].join('\n');
  core = core.replace(oldPush, newPush);
  report.push('ok — размер подставляется в разметку');
} else {
  report.push('НЕ найдена строка выдачи картинки');
}

// 3. Размер сохраняется при кэшировании (оба места: предзагрузка и первый запрос)
const writeCalls = [...core.matchAll(/await writeFile\(target, bin\)(\.catch\(\(\) => \{\}\))?;/g)];
let added = 0;
for (const call of writeCalls) {
  const anchor = call[0];
  const extra = '\n      const size = imageSize(bin);\n      if (size) await writeFile(target + ".json", JSON.stringify(size)).catch(() => {});';
  if (core.includes(anchor + extra.trim().slice(0, 20))) continue;
  core = core.replace(anchor, anchor + extra);
  added += 1;
}
report.push('ok — сохранение размера добавлено в ' + added + ' мест');

await writeFile(corePath, core, 'utf8');
console.log(report.join('\n'));
