// Тесты разбора лент: RSS 2.0 и Atom дают статьи с заголовком, ссылкой и id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, looksLikeFeed, itemId, htmlToText } from '../lib/feed.mjs';

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Пример ленты</title>
  <link>https://example.com/</link>
  <item>
    <title>Первая статья</title>
    <link>https://example.com/one</link>
    <pubDate>Mon, 23 Nov 2026 10:00:00 +0300</pubDate>
    <description><![CDATA[<p>Краткий текст первой</p>]]></description>
    <guid>https://example.com/one</guid>
  </item>
  <item>
    <title>Вторая статья</title>
    <link>https://example.com/two</link>
    <description>Краткий текст второй</description>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Атом-лента</title>
  <updated>2026-11-23T10:00:00Z</updated>
  <entry>
    <title>Запись Atom</title>
    <link href="https://example.com/atom-1"/>
    <id>urn:uuid:1234</id>
    <updated>2026-11-23T09:00:00Z</updated>
    <summary>Краткое содержание записи</summary>
  </entry>
</feed>`;

test('RSS: две статьи, заголовок ленты и ссылки на месте', () => {
  const parsed = parseFeed(RSS, 'https://example.com/rss', 'feed1');
  assert.ok(parsed, 'лента должна разобраться');
  assert.equal(parsed.kind, 'feed');
  assert.equal(parsed.meta.title, 'Пример ленты');
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].title, 'Первая статья');
  assert.equal(parsed.items[0].link, 'https://example.com/one');
  assert.ok(parsed.items[0].id, 'у статьи должен быть id');
  assert.ok(parsed.items[1].id, 'у второй статьи тоже');
  assert.notEqual(parsed.items[0].id, parsed.items[1].id, 'id статей не должны совпадать');
  assert.ok(parsed.items[0].excerpt.includes('Краткий текст первой'), 'анонс должен попасть в excerpt');
});

test('Atom: запись с href и summary', () => {
  const parsed = parseFeed(ATOM, 'https://example.com/atom', 'feed2');
  assert.ok(parsed, 'атом-лента должна разобраться');
  assert.equal(parsed.meta.title, 'Атом-лента');
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].title, 'Запись Atom');
  assert.equal(parsed.items[0].link, 'https://example.com/atom-1');
});

test('не-лента не считается лентой', () => {
  assert.equal(looksLikeFeed('<html><body>обычная страница</body></html>'), false);
  assert.equal(looksLikeFeed(RSS), true);
});

test('id статьи стабилен для одного ключа и различается для разных', () => {
  const a = itemId('feed1', 'https://example.com/one');
  const b = itemId('feed1', 'https://example.com/one');
  const c = itemId('feed1', 'https://example.com/two');
  const d = itemId('feed2', 'https://example.com/one');
  assert.equal(a, b, 'один ключ — один id');
  assert.notEqual(a, c, 'разные ссылки — разные id');
  assert.notEqual(a, d, 'разные ленты — разные id');
});

test('htmlToText убирает разметку и скрипты', () => {
  const text = htmlToText('<p>обычный <b>текст</b></p><script>alert(1)</script>');
  assert.ok(text.includes('обычный'), 'текст должен остаться');
  assert.ok(!text.includes('<p>'), 'теги должны исчезнуть');
  assert.ok(!/alert\(1\)/.test(text), 'содержимое script не должно попадать в текст');
});
