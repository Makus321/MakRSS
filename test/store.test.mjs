// Тесты хранилища: служебные поля статей не теряются, ревизия растёт один раз,
// параллельные записи разных постов не затирают друг друга.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';

const FEED = 'deadbeef';

async function makeStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'rss-test-'));
  const store = new Store(dir, () => {});
  await store.init();
  store.state.feeds.push({ id: FEED, url: 'https://example.com/rss', title: 'Тест', kind: 'rss' });
  store.state.items[FEED] = [];
  return { dir, store };
}

/** Добавляет статьи в состояние так же, как это делает ядро: и планирует запись. */
function addItems(store, items) {
  store.state.items[FEED] = [...(store.state.items[FEED] ?? []), ...items];
  store.saveStateSoon();
}

test('служебные поля статьи переживают сохранение и повторную загрузку', async () => {
  const { dir, store } = await makeStore();
  try {
    addItems(store, [{
      id: 'item-1',
      title: 'Статья',
      link: 'https://example.com/1',
      addedAt: '2026-11-23T10:00:00.000Z',
      video: 'https://example.com/v.mp4',
      commentsSeenMaxId: 42,
      commentsSeenCount: 3,
      coverTriedAt: '2026-11-23T10:05:00.000Z',
    }]);
    await store.flush();

    const again = new Store(dir, () => {});
    await again.init();
    const item = again.state.items[FEED].find((i) => i.id === 'item-1');
    assert.ok(item, 'статья должна сохраниться');
    assert.equal(item.addedAt, '2026-11-23T10:00:00.000Z', 'addedAt теряется');
    assert.equal(item.video, 'https://example.com/v.mp4', 'video теряется');
    assert.equal(item.commentsSeenMaxId, 42, 'commentsSeenMaxId теряется');
    assert.equal(item.commentsSeenCount, 3, 'commentsSeenCount теряется');
    assert.equal(item.coverTriedAt, '2026-11-23T10:05:00.000Z', 'coverTriedAt теряется');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('одно изменение — одна единица ревизии, сохранение на диск её не двигает', async () => {
  const { dir, store } = await makeStore();
  try {
    addItems(store, [{ id: 'a', title: 'A', link: 'https://example.com/a' }]);
    const afterChange = store.state.revision;
    await store.flush({ bump: false });        // запись на диск: без нового шага
    assert.equal(store.state.revision, afterChange, 'flush не должен менять ревизию');
    store.saveStateSoon();
    assert.equal(store.state.revision, afterChange + 1, 'одно изменение — ровно +1');
    await store.flush({ bump: false });
    assert.equal(store.state.revision, afterChange + 1, 'flush снова не меняет ревизию');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('восемь параллельных записей разных постов сохраняются все', async () => {
  const { dir, store } = await makeStore();
  try {
    addItems(store, Array.from({ length: 8 }, (_, i) => ({
      id: `p${i}`, title: `Пост ${i}`, link: `https://example.com/${i}`,
    })));
    await Promise.all(Array.from({ length: 8 }, (_, i) => store.setBody(FEED, `p${i}`, { content: `<p>текст ${i}</p>` })));
    await store.flush();

    const files = await readdir(path.join(dir, 'content'));
    const data = JSON.parse(await readFile(path.join(dir, 'content', files[0]), 'utf8'));
    const saved = Object.keys(data).filter((id) => /^p\d$/.test(id));
    assert.equal(saved.length, 8, `сохранилось ${saved.length} из 8 постов`);

    const leftovers = files.filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, [], 'временные файлы не должны оставаться');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('длинный HTML обрезается по границе тега, а не посередине', async () => {
  const { dir, store } = await makeStore();
  try {
    addItems(store, [{ id: 'big', title: 'Большая', link: 'https://example.com/big' }]);
    // Много абзацев: лимит должен сработать на границе `</p>`, а не посреди слова.
    const long = Array.from({ length: 8000 }, (_, i) => `<p>абзац ${i} ${'слово '.repeat(20)}</p>`).join('');
    await store.setBody(FEED, 'big', { fullHtml: long });
    const body = await store.body(FEED, 'big');
    assert.ok(body.fullHtml.length < long.length, 'полный текст должен быть обрезан');
    assert.ok(body.fullHtml.trimEnd().endsWith('</p>'), 'обрезка должна заканчиваться на границе тега');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
