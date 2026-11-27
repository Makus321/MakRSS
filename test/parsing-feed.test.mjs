// Тесты итерации 7.1: разбор RSS/Atom и проверка доменов.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, htmlToText } from '../lib/feed.mjs';
import { commentsProviderFor } from '../lib/comments.mjs';

test('htmlToText: угловые скобки из сущностей не пропадают', () => {
  // Регрессия: сущности раскрывались до вырезания тегов, и «std::vector<int>»
  // исчезал как будто это тег.
  assert.equal(htmlToText('Шаблон std::vector&lt;int&gt; в тексте'), 'Шаблон std::vector<int> в тексте');
  assert.equal(htmlToText('<p>a &lt;b&gt; c</p>'), 'a <b> c');
});

const RSS_WITH_ATOM_LINK = `<?xml version="1.0"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:slash="http://purl.org/rss/1.0/modules/slash/">
<channel>
  <title>Лента</title>
  <atom:link href="https://example.com/feed.xml" rel="self" type="application/rss+xml"/>
  <link>https://example.com/</link>
  <item>
    <title>Статья</title>
    <atom:link href="https://example.com/self.xml"/>
    <link>https://example.com/post/1</link>
    <comments>https://example.com/post/1#comments</comments>
    <slash:comments>5</slash:comments>
    <description>Текст статьи</description>
  </item>
</channel>
</rss>`;

test('RSS: <atom:link> не подменяет ссылку статьи и сайта', () => {
  const parsed = parseFeed(RSS_WITH_ATOM_LINK, 'https://example.com/feed.xml', 'feed1');
  assert.equal(parsed.meta.siteUrl, 'https://example.com/');
  assert.equal(parsed.items[0].link, 'https://example.com/post/1');
});

test('RSS: число комментариев берётся из <slash:comments>, а не из ссылки', () => {
  const parsed = parseFeed(RSS_WITH_ATOM_LINK, 'https://example.com/feed.xml', 'feed1');
  assert.equal(parsed.items[0].commentsCount, 5);
});

const ATOM_TEXT = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom</title>
  <entry>
    <title>Запись</title>
    <link href="https://example.com/a/1"/>
    <content type="text">Пример &lt;tag&gt; в тексте</content>
    <updated>2026-11-27T10:00:00Z</updated>
  </entry>
</feed>`;

test('Atom: type="text" экранируется, разметка не выполняется', () => {
  const parsed = parseFeed(ATOM_TEXT, 'https://example.com/atom', 'feed2');
  const content = parsed.items[0].content;
  assert.match(content, /&lt;tag&gt;/, 'угловые скобки должны быть экранированы: ' + content);
  assert.doesNotMatch(content, /<tag>/, 'тег не должен попасть в разметку');
});

test('провайдер комментариев: домен проверяется по hostname', () => {
  const feed = { id: 'f', url: 'https://example.com/feed', title: 'лента' };
  // Подстрока habr.com в пути или параметре не должна включать провайдера.
  assert.equal(commentsProviderFor(feed, { link: 'https://evil.example/?ref=habr.com' }), null);
  assert.equal(commentsProviderFor(feed, { link: 'https://not-habr.com/post/1' }), null);
  const habr = commentsProviderFor({ ...feed, url: '' }, { link: 'https://habr.com/ru/articles/123456/' });
  assert.equal(habr?.name, 'habr');
});
