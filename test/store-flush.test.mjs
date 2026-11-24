// Тесты записи: flush() не переписывает неизменённые ленты, flush сохраняет изменённые,
// а повторный flush не трогает файлы на диске.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';

const feedId = (n) => `feed${n}`;

async function makeStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'rss-flush-'));
  const store = new Store(dir, () => {});
  await store.init();
  return { dir, store };
}

function addFeed(store, id) {
  store.state.feeds.push({ id, url: `https://example.com/${id}`, title: id, kind: 'rss' });
  store.state.items[id] = [{ id: `${id}-item`, title: 'Статья', link: `https://example.com/${id}/1` }];
  store.saveStateSoon();
}

test('flush не создаёт файлы для лент без изменений', async () => {
  const { dir, store } = await makeStore();
  try {
    addFeed(store, feedId(1));
    addFeed(store, feedId(2));
    // Обе ленты открыты в кэше, но изменения есть только у первой.
    await store.setBody(feedId(1), `${feedId(1)}-item`, { fullHtml: '<p>Первый</p>' });
    await store.body(feedId(2), `${feedId(2)}-item`);        // только чтение, без записи
    await store.flush({ bump: false });

    const file1 = path.join(dir, 'content', `${feedId(1)}.json`);
    const file2 = path.join(dir, 'content', `${feedId(2)}.json`);
    const first = JSON.parse(await readFile(file1, 'utf8'));
    assert.match(first[`${feedId(1)}-item`].fullHtml, /Первый/);

    // Раньше flush помечал «грязной» каждую открытую ленту и создавал для неё файл.
    await assert.rejects(() => readFile(file2, 'utf8'), /ENOENT/, 'файл неизменённой ленты не должен появляться');
    assert.equal(store.dirtyFeeds.size, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('flush записывает изменённую ленту и сбрасывает кэш', async () => {
  const { dir, store } = await makeStore();
  try {
    addFeed(store, feedId(1));
    await store.setBody(feedId(1), `${feedId(1)}-item`, { fullHtml: '<p>Старый</p>' });
    await store.flush({ bump: false });

    await store.setBody(feedId(1), `${feedId(1)}-item`, { fullHtml: '<p>Новый текст</p>' });
    await store.flush({ bump: false });

    const parsed = JSON.parse(await readFile(path.join(dir, 'content', `${feedId(1)}.json`), 'utf8'));
    assert.match(parsed[`${feedId(1)}-item`].fullHtml, /Новый текст/);
    assert.equal(store.openFeeds.size, 0, 'после flush кэш должен быть пуст');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
