// Тесты разбора блока «Читают сейчас»: мнемоники, разметка, статистика, порядок.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, plainText, parseMostReading, articleItem } from '../lib/habr-now.mjs';

test('decodeEntities раскрывает именованные и числовые мнемоники', () => {
  assert.equal(decodeEntities('Рынок&nbsp;найма &laquo;ИТ&raquo;'), 'Рынок найма «ИТ»');
  assert.equal(decodeEntities('&#171;ёж&#187; &#x41; &#65;'), '«ёж» A A');
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;'), 'a & b <c> "d" \'e\'');
  // Неизвестную мнемонику оставляем как есть, чтобы не терять текст.
  assert.equal(decodeEntities('&unknown; &'), '&unknown; &');
});

test('plainText убирает теги и лишние пробелы', () => {
  assert.equal(plainText('<b>Жирный</b>\n  заголовок  &mdash;  тут'), 'Жирный заголовок — тут');
  assert.equal(plainText(null), '');
});

test('articleItem переносит статистику и строит ссылку', () => {
  const item = articleItem('1110976', {
    titleHtml: 'Рынок найма в&nbsp;ИТ',
    timePublished: '2026-11-23T16:43:00+00:00',
    author: { alias: 'bissquit' },
    hubs: [{ alias: 'dev_management' }, { alias: 'ai' }, { alias: 'research' }, { alias: 'extra' }],
    leadData: { imageUrl: 'https://habrastorage.org/x.jpg' },
    readingTime: 12,
    statistics: { readingCount: 40447, readers: 33675, commentsCount: 344 },
  });
  assert.equal(item.id, 'habr-now-1110976');
  assert.equal(item.title, 'Рынок найма в ИТ');
  assert.equal(item.link, 'https://habr.com/ru/articles/1110976/');
  assert.equal(item.image, 'https://habrastorage.org/x.jpg');
  assert.deepEqual(item.categories, ['dev_management', 'ai', 'research']);
  assert.equal(item.readers, 40447);
  assert.equal(item.currentlyReading, 33675);
  assert.equal(item.commentsCount, 344);
  assert.equal(item.readingTime, 12);
  assert.equal(item.hasFull, false);
});

test('articleItem не тащит небезопасные картинки и пустые поля', () => {
  const item = articleItem('1', { titleHtml: '', leadData: { imageUrl: 'javascript:alert(1)' } });
  assert.equal(item.title, 'Статья 1');
  assert.equal(item.image, '');
  assert.equal(item.readers, undefined);
});

test('parseMostReading сохраняет хабровский порядок и берёт 10', () => {
  const ids = Array.from({ length: 12 }, (_, i) => String(100 + i));
  const refs = {};
  for (const id of ids) refs[id] = { titleHtml: `Статья ${id}`, statistics: { readingCount: Number(id) } };
  const items = parseMostReading(JSON.stringify({ articleIds: ids, articleRefs: refs }));
  assert.equal(items.length, 10);
  assert.deepEqual(items.map((i) => i.id), ids.slice(0, 10).map((id) => `habr-now-${id}`));
});

test('parseMostReading: запасной источник сортирует по читающим сейчас', () => {
  const refs = {
    1: { titleHtml: 'Малая', statistics: { readingCount: 99999, readers: 5 } },
    2: { titleHtml: 'Большая', statistics: { readingCount: 10, readers: 900 } },
  };
  const sorted = parseMostReading(JSON.stringify({ articleIds: ['1', '2'], articleRefs: refs }), { sorted: true });
  assert.deepEqual(sorted.map((i) => i.title), ['Большая', 'Малая']);
});

test('parseMostReading пропускает статьи без данных', () => {
  const items = parseMostReading(JSON.stringify({ articleIds: ['1', '2'], articleRefs: { 1: { titleHtml: 'Есть' } } }));
  assert.deepEqual(items.map((i) => i.title), ['Есть']);
});
