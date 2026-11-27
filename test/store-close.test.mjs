// Тесты итерации 4: Store.close() и сохранность при ошибке записи.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';

async function makeStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'rss-store4-'));
  const store = new Store(dir, () => {});
  await store.init();
  return { dir, store };
}

test('Store.close(): дописывает тела и не оставляет временных файлов', async () => {
  const { dir, store } = await makeStore();
  try {
    await store.setBody('feed-a', 'item-1', { content: 'текст статьи' });
    await store.close();
    const saved = JSON.parse(await readFile(path.join(dir, 'content', 'feed-a.json'), 'utf8'));
    assert.equal(saved['item-1'].content, 'текст статьи');
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('state.json: нечитаемый файл не затирается, а сохраняется копия', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rss-store4-'));
  try {
    const first = new Store(dir, () => {});
    await first.init();
    first.state.feeds = [{ id: 'f1', title: 'лента' }];
    await first.saveStateNow({ bump: false });
    await first.close();
    // Портим файл и поднимаем новое хранилище: оно должно сохранить копию.
    const file = path.join(dir, 'state.json');
    await writeFile(file, '{ это не json', 'utf8');
    const logs = [];
    const second = new Store(dir, (line) => logs.push(line));
    await second.init();
    const names = await readdir(dir);
    assert.ok(names.some((name) => name.startsWith('state.json.broken-')),
      'должна остаться копия: ' + names.join(', '));
    assert.ok(logs.some((line) => line.includes('state.json')), 'должен быть лог об ошибке');
    await second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
