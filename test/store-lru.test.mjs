// Тесты хранилища: LRU-вытеснение не должно терять несохранённые тела статей.
// Регрессия P0.1: при открытии 13-й ленты самая старая удалялась из кэша без записи
// на диск, и отложенный таймер молча терял все тексты этой ленты.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';

async function makeStore({ maxOpenFeeds } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rss-lru-'));
  const store = new Store(dir, () => {});
  await store.init();
  if (maxOpenFeeds) store.maxOpenFeeds = maxOpenFeeds;
  return { dir, store };
}

const feedId = (n) => `feed${n}`;

function addFeed(store, id) {
  store.state.feeds.push({ id, url: `https://example.com/${id}`, title: id, kind: 'rss' });
  store.state.items[id] = [{ id: `${id}-item`, title: 'Статья', link: `https://example.com/${id}/1` }];
  store.saveStateSoon();
}

test('тела статей выживают при вытеснении из кэша', async () => {
  const { dir, store } = await makeStore({ maxOpenFeeds: 2 });
  try {
    // Три ленты, у каждой есть текст статьи. Кэш вмещает только две.
    for (const id of [feedId(1), feedId(2), feedId(3)]) {
      addFeed(store, id);
      await store.setBody(id, `${id}-item`, { fullHtml: `<p>Текст статьи ${id}</p>` });
    }
    await store.flush({ bump: false });

    for (const id of [feedId(1), feedId(2), feedId(3)]) {
      const raw = await readFile(path.join(dir, 'content', `${id}.json`), 'utf8');
      const parsed = JSON.parse(raw);
      assert.ok(parsed[`${id}-item`], `текст ленты ${id} должен остаться на диске`);
      assert.match(parsed[`${id}-item`].fullHtml, /Текст статьи/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('вытеснение не оставляет ленту «грязной» навсегда', async () => {
  const { dir, store } = await makeStore({ maxOpenFeeds: 1 });
  try {
    addFeed(store, feedId(1));
    await store.setBody(feedId(1), `${feedId(1)}-item`, { fullHtml: '<p>Первый</p>' });
    // Открываем вторую ленту: первая должна быть сохранена и вытеснена.
    addFeed(store, feedId(2));
    await store.setBody(feedId(2), `${feedId(2)}-item`, { fullHtml: '<p>Второй</p>' });

    assert.equal(store.dirtyFeeds.size, 1, 'грязной должна остаться только открытая лента');
    assert.ok(!store.dirtyFeeds.has(feedId(1)), 'сохранённая лента не должна считаться грязной');

    await store.flush({ bump: false });
    const first = JSON.parse(await readFile(path.join(dir, 'content', `${feedId(1)}.json`), 'utf8'));
    assert.match(first[`${feedId(1)}-item`].fullHtml, /Первый/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('flush сохраняет все открытые ленты и очищает список грязных', async () => {
  const { dir, store } = await makeStore({ maxOpenFeeds: 12 });
  try {
    for (let n = 1; n <= 4; n += 1) {
      addFeed(store, feedId(n));
      await store.setBody(feedId(n), `${feedId(n)}-item`, { fullHtml: `<p>Текст ${n}</p>` });
    }
    await store.flush({ bump: false });
    assert.equal(store.dirtyFeeds.size, 0, 'после flush грязных лент быть не должно');
    for (let n = 1; n <= 4; n += 1) {
      const parsed = JSON.parse(await readFile(path.join(dir, 'content', `${feedId(n)}.json`), 'utf8'));
      assert.ok(parsed[`${feedId(n)}-item`], `лента ${n} должна быть на диске`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
