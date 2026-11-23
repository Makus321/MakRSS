#!/usr/bin/env node
// Счётчики сборки в одном месте: версия клиента (app.js), версия стилей и
// версия кэша оболочки в sw.js.
//
//   node tools/bump-version.mjs            поднять все три на 1
//   node tools/bump-version.mjs --check    только показать текущие значения
//   node tools/bump-version.mjs --set 350 --style 200
//
// Ручная правка трёх чисел в двух файлах — источник ошибок: забыли sw.js,
// и браузер держит старый app.js из кэша.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INDEX = path.join(ROOT, 'public', 'index.html');
const SW = path.join(ROOT, 'public', 'sw.js');

const args = process.argv.slice(2);
const check = args.includes('--check');
const getNum = (flag) => {
  const at = args.indexOf(flag);
  if (at < 0) return null;
  const value = Number.parseInt(args[at + 1] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : null;
};

const index = await readFile(INDEX, 'utf8');
const sw = await readFile(SW, 'utf8');

const appMatch = /app\.js\?v=(\d+)/.exec(index);
const styleMatch = /style\.css\?v=(\d+)/.exec(index);
const cacheMatch = /const CACHE = 'rss-shell-v(\d+)'/.exec(sw);
if (!appMatch || !styleMatch || !cacheMatch) {
  console.error('не нашёл номера версий: проверьте public/index.html и public/sw.js');
  process.exit(1);
}

const current = {
  app: Number(appMatch[1]),
  style: Number(styleMatch[1]),
  cache: Number(cacheMatch[1]),
};

if (check) {
  console.log(`клиент: ${current.app}, стили: ${current.style}, кэш оболочки: ${current.cache}`);
  process.exit(0);
}

const next = {
  app: getNum('--set') ?? current.app + 1,
  style: getNum('--style') ?? current.style + 1,
  cache: current.cache + 1,
};

const nextIndex = index
  .replace(/app\.js\?v=\d+/, `app.js?v=${next.app}`)
  .replace(/style\.css\?v=\d+/, `style.css?v=${next.style}`);
const nextSw = sw.replace(/const CACHE = 'rss-shell-v\d+'/, `const CACHE = 'rss-shell-v${next.cache}'`);

await writeFile(INDEX, nextIndex, 'utf8');
await writeFile(SW, nextSw, 'utf8');

console.log(`было:  клиент ${current.app}, стили ${current.style}, кэш ${current.cache}`);
console.log(`стало: клиент ${next.app}, стили ${next.style}, кэш ${next.cache}`);
