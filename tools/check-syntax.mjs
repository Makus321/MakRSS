// Проверка синтаксиса всех .js/.mjs проекта — вместо двух файлов в npm run check.
import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'data', '.git', 'rss-mirror', 'preview']);

/** Все js/mjs файлы проекта, кроме служебных каталогов. */
function collect(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collect(full, found);
    } else if (/\.(mjs|js)$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

const files = collect(ROOT).sort();
let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed += 1;
    console.error(`\n${path.relative(ROOT, file)}:`);
    console.error((result.stderr || result.stdout || '').trim());
  }
}
if (failed) {
  console.error(`\nошибок синтаксиса: ${failed} из ${files.length}`);
  process.exit(1);
}
console.log(`синтаксис в порядке: ${files.length} файлов`);
