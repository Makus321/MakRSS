// Тест: отметка «комментарии дочитаны до N» переживает ротацию витрины.
import test from 'node:test';
import assert from 'node:assert/strict';

// Копия логики переноса пометок из refreshHabrNow: проверяем само правило.
const KEEP_META = ['commentsSeenMaxId', 'commentsSeenCount', 'commentsSeenAt', 'commentsCountAt', 'hasFull', 'fullTriedAt', 'coverTriedAt'];

function mergeMeta(prevList, freshList) {
  const prevById = new Map(prevList.map((item) => [item.id, item]));
  return freshList.map((item) => {
    const prev = prevById.get(item.id);
    if (!prev) return { ...item, addedAt: 'new' };
    const merged = { ...item };
    for (const key of KEEP_META) if (prev[key] !== undefined) merged[key] = prev[key];
    return { ...merged, addedAt: 'new' };
  });
}

test('пометки переживают ротацию, новые статьи приходят чистыми', () => {
  const prev = [
    { id: 'a', title: 'Старая A', commentsCount: 10, commentsSeenCount: 10, commentsSeenMaxId: 55, hasFull: true },
    { id: 'b', title: 'Уйдёт', commentsCount: 3, commentsSeenCount: 3, commentsSeenMaxId: 7 },
  ];
  const fresh = [
    { id: 'a', title: 'Старая A', commentsCount: 14 },
    { id: 'c', title: 'Новая C', commentsCount: 1 },
  ];
  const merged = mergeMeta(prev, fresh);
  const a = merged.find((item) => item.id === 'a');
  const c = merged.find((item) => item.id === 'c');
  assert.equal(a.commentsCount, 14, 'счётчик берём свежий');
  assert.equal(a.commentsSeenCount, 10, 'отметка просмотра сохранилась');
  assert.equal(a.commentsSeenMaxId, 55);
  assert.equal(a.hasFull, true);
  assert.equal(c.commentsSeenCount, undefined, 'у новой статьи отметок нет');
  assert.equal(merged.length, 2);
});

test('пометки исчезнувшей статьи не переносятся', () => {
  const prev = [{ id: 'gone', commentsSeenCount: 5, commentsSeenMaxId: 9 }];
  const fresh = [{ id: 'other', commentsCount: 2 }];
  const merged = mergeMeta(prev, fresh);
  assert.equal(merged[0].commentsSeenCount, undefined);
  assert.equal(merged[0].commentsSeenMaxId, undefined);
});
