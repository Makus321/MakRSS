// Тест: статьи виртуальной ленты переживают загрузку состояния.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';

const state = {
  feeds: [{ id: 'real', url: 'https://example.com/rss', title: 'Лента' }],
  folders: [],
  items: {
    real: [{ id: 'real-1', title: 'Обычная', link: 'https://example.com/1' }],
    'habr-now': [{ id: 'habr-now-1', title: 'Витрина', link: 'https://habr.com/ru/articles/1/' }],
    orphan: [{ id: 'orphan-1', title: 'Мусор', link: 'https://example.com/x' }],
  },
  read: {},
  starred: {},
};

async function load(options) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rss-virtual-'));
  await writeFile(path.join(dir, 'state.json'), JSON.stringify(state), 'utf8');
  const store = new Store(dir, () => {}, options);
  await store.init();
  return { dir, store };
}

test('статьи витрины остаются после перезагрузки состояния', async () => {
  const { dir, store } = await load({ virtualFeeds: ['habr-now'] });
  try {
    assert.equal(store.state.items['habr-now']?.length, 1, 'статьи витрины удалены');
    assert.equal(store.state.items.real?.length, 1);
    assert.equal(store.state.items.orphan, undefined, 'мусор без ленты должен удаляться');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('без указания виртуальных лент статьи-сироты удаляются как раньше', async () => {
  const { dir, store } = await load();
  try {
    assert.equal(store.state.items['habr-now'], undefined);
    assert.equal(store.state.items.real?.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
