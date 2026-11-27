// Тесты скриптов установки и конфигов: то, что нельзя проверить в браузере,
// но что дорого ловить на живой установке.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

test('install-vps.sh: SKIP_NODE действительно пропускает установку', () => {
  const script = read('deploy/install-vps.sh');
  // Раньше условие было инвертировано: при SKIP_NODE=yes Node всё равно ставился.
  assert.match(script, /if \[\[ "\$SKIP_NODE" == yes \]\]/);
  assert.doesNotMatch(script, /"\$SKIP_NODE" != yes/);
  // Путь к node берётся из PATH, а не жёстко из /usr/local/bin.
  assert.match(script, /NODE_BIN="\$\(command -v node\)"/);
  // sed подставляет путь из переменной, а не жёсткий /usr/local/bin/node.
  assert.match(script, /s\|__NODE__\|\$NODE_BIN\|/);
});

test('install-vps.sh: не оставляет пароль admin и проверяет синтаксис перед стартом', () => {
  const script = read('deploy/install-vps.sh');
  assert.doesNotMatch(script, /ADMIN_PASS:-admin/);
  assert.match(script, /head -c 18 \/dev\/urandom/);
  assert.match(script, /--check/);
});

test('install.sh: пароль по умолчанию генерируется', () => {
  const script = read('deploy/install.sh');
  assert.doesNotMatch(script, /ADMIN_PASS:-admin/);
  assert.match(script, /head -c 18 \/dev\/urandom/);
});

test('nginx.conf.example: у SSE свои настройки, буферизация выключена', () => {
  const conf = read('deploy/nginx.conf.example');
  assert.match(conf, /location = \/api\/events/);
  assert.match(conf, /proxy_buffering off/);
  assert.match(conf, /proxy_read_timeout 1h/);
});

test('service worker: нет мёртвого DATA_CACHE и чужая страница не кэшируется', () => {
  const sw = read('public/sw.js');
  assert.doesNotMatch(sw, /DATA_CACHE/);
  assert.doesNotMatch(sw, /type !== 'warm'/);
  assert.match(sw, /isShellPage/);
});

test('в коде нет личного домена и логина из подсказки', () => {
  assert.doesNotMatch(read('lib/habr-now.mjs'), /rss\.letsplay\.today/);
  assert.doesNotMatch(read('public/admin.html'), /makushin/);
});
