import { readFile, writeFile } from 'node:fs/promises';

const dir = process.argv[2];
const file = dir + '/lib/comments.mjs';
let src = await readFile(file, 'utf8');
const report = [];

const LJ_BLOCK = [
  '',
  '// --- LiveJournal -------------------------------------------------------',
  '// Отдельного публичного API у ЖЖ нет: XML-RPC getcomments требует входа,',
  '// внутренний /__api/ отвечает "Auth Missed". Зато в HTML страницы поста уже',
  '// лежит массив комментариев — его и разбираем. Запрос только по кнопке.',
  "const ljPageUrl = (link) => String(link ?? '').replace(/#.*$/, '') + (String(link ?? '').includes('?') ? '&' : '?') + 'format=light';",
  '',
  '/** Достаёт массив комментариев из HTML: "comments": [ … ]. */',
  'function ljCommentsJson(html) {',
  '  const text = String(html ?? "");',
  '  const marker = text.indexOf(\'"comments":\');',
  '  if (marker < 0) return [];',
  '  const start = text.indexOf("[", marker);',
  '  if (start < 0) return [];',
  '  let depth = 0;',
  '  let inString = false;',
  '  let escaped = false;',
  '  for (let i = start; i < text.length; i += 1) {',
  '    const ch = text[i];',
  '    if (inString) {',
  '      if (escaped) escaped = false;',
  '      else if (ch === "\\\\") escaped = true;',
  '      else if (ch === \'"\') inString = false;',
  '      continue;',
  '    }',
  '    if (ch === \'"\') { inString = true; continue; }',
  '    if (ch === "[") depth += 1;',
  '    else if (ch === "]") {',
  '      depth -= 1;',
  '      if (!depth) {',
  '        try {',
  '          const parsed = JSON.parse(text.slice(start, i + 1));',
  '          return Array.isArray(parsed) ? parsed : [];',
  '        } catch { return []; }',
  '      }',
  '    }',
  '  }',
  '  return [];',
  '}',
  '',
  '/** Приводит комментарии ЖЖ к общему виду (автор, дата, текст, ветки). */',
  'function ljCommentMap(items) {',
  '  const map = {};',
  '  for (const item of items ?? []) {',
  '    const id = String(item?.talkid ?? "");',
  '    if (!id || item?.deleted) continue;',
  '    map[id] = {',
  '      id,',
  '      author: { alias: String(item.poster || item.uname || "гость") },',
  '      isPostAuthor: Boolean(item.commenter_is_poster),',
  '      timePublished: item.ctime || null,',
  '      message: String(item.article ?? ""),',
  '      children: [],',
  '      parent: String(item.parent ?? 0),',
  '    };',
  '  }',
  '  for (const node of Object.values(map)) {',
  '    const parent = map[node.parent];',
  '    if (parent) parent.children.push(node.id);',
  '  }',
  '  return map;',
  '}',
  '',
  '/** Общее число комментариев со страницы поста. */',
  'function ljTotal(html) {',
  '  const match = /(\\d[\\d\\s]*)\\s*(?:коммент|comment)/i.exec(String(html ?? ""));',
  '  if (!match) return null;',
  '  const value = Number(match[1].replace(/\\s/g, ""));',
  '  return Number.isFinite(value) ? value : null;',
  '}',
  '',
  'async function loadLivejournal(link, httpGet) {',
  '  const res = await httpGet(ljPageUrl(link), { accept: "text/html,application/xhtml+xml", timeout: 30000 });',
  '  if (!res.ok) throw new Error("ЖЖ вернул HTTP " + res.status);',
  '  const items = ljCommentsJson(res.text);',
  '  const comments = ljCommentMap(items);',
  '  const roots = Object.values(comments)',
  '    .filter((node) => !node.parent || node.parent === "0" || !comments[node.parent])',
  '    .map((node) => node.id);',
  '  const threads = buildThreads(comments, roots);',
  '  return {',
  '    provider: "livejournal",',
  '    providerTitle: "ЖЖ",',
  '    articleId: link,',
  '    articleUrl: String(link ?? ""),',
  '    total: ljTotal(res.text) ?? Object.keys(comments).length,',
  '    count: countNodes(threads),',
  '    threads,',
  '  };',
  '}',
  '',
  'export function commentsProviderFor(feed, item) {',
].join('\n');

if (src.includes('loadLivejournal')) {
  report.push('уже вставлено');
} else {
  const marker = 'export function commentsProviderFor(feed, item) {';
  if (!src.includes(marker)) { console.log('не найден комментарий-провайдер'); process.exit(1); }
  src = src.replace(marker, LJ_BLOCK);

  // регистрация провайдера внутри функции
  const registerAnchor = "  if (isIxbt(link)) {";
  if (!src.includes(registerAnchor)) { console.log('не найдено место регистрации ixbt'); process.exit(1); }
  src = src.replace(registerAnchor, [
    '  if (/livejournal\\.(com|ru)/i.test(link)) {',
    '    return {',
    '      name: "livejournal",',
    '      articleId: link,',
    '      load: (httpGet) => loadLivejournal(link, httpGet),',
    '    };',
    '  }',
    registerAnchor,
  ].join('\n'));
  report.push('ok — провайдер ЖЖ зарегистрирован');
}

await writeFile(file, src, 'utf8');
console.log(report.join('\n'));
