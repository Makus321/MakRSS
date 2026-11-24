// Тесты сверки статей по ссылке (отметки «прочитано» между лентой и блоком).
import test from 'node:test';
import assert from 'node:assert/strict';
import { linkKey, itemsWithLinks } from '../lib/read-link.mjs';

test('linkKey: схема, www и хвостовой слэш не важны', () => {
  assert.equal(linkKey('https://habr.com/ru/articles/1110976/'), 'habr.com/ru/articles/1110976');
  assert.equal(linkKey('http://www.habr.com/ru/articles/1110976'), 'habr.com/ru/articles/1110976');
  assert.equal(linkKey('HTTPS://HABR.COM/ru/articles/1110976///'), 'habr.com/ru/articles/1110976');
});

test('linkKey: параметры запроса различают статьи', () => {
  assert.equal(linkKey('https://habr.com/ru/articles/1/?a=1'), 'habr.com/ru/articles/1?a=1');
  assert.notEqual(linkKey('https://habr.com/ru/articles/1/?a=1'), linkKey('https://habr.com/ru/articles/1/'));
});

test('linkKey: пустое и мусорное значение не ломает сверку', () => {
  assert.equal(linkKey(''), '');
  assert.equal(linkKey(null), '');
  assert.equal(linkKey('не ссылка'), '');
  assert.equal(linkKey('javascript:alert(1)'), '');
});

test('itemsWithLinks находит статьи в нескольких списках', () => {
  const feed = [
    { id: 'a', link: 'https://habr.com/ru/articles/11/' },
    { id: 'b', link: 'https://habr.com/ru/articles/22/' },
  ];
  const block = [
    { id: 'habr-now-22', link: 'https://habr.com/ru/articles/22' },
    { id: 'habr-now-33', link: 'https://habr.com/ru/articles/33/' },
  ];
  const keys = new Set([linkKey('http://www.habr.com/ru/articles/22')]);
  const found = itemsWithLinks([feed, block], keys);
  assert.deepEqual(found.map((i) => i.id), ['b', 'habr-now-22']);
});

test('itemsWithLinks без ключей ничего не возвращает', () => {
  assert.deepEqual(itemsWithLinks([[{ id: 'a', link: 'https://x.ru/1' }]], new Set()), []);
  assert.deepEqual(itemsWithLinks([[]], new Set(['x.ru/1'])), []);
});
