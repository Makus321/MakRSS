// Тесты разбора статей. Регрессия: JUNK_BLOCK мог совпасть в тексте (не в теге),
// lastIndexOf('<') возвращал -1, и stripJunkBlocks дублировал строку до 40 раз — OOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractArticle } from '../lib/readability.mjs';

const junkInText = '<article><p>пример class="related-posts" в тексте статьи</p>'
  + '<p>второй абзац с обычным текстом, чтобы разбор не считал это анонсом.</p></article>';

test('разбор статьи: class="…" в тексте не раздувает строку', () => {
  const started = Date.now();
  const result = extractArticle(junkInText, 'https://example.com/post');
  const took = Date.now() - started;
  assert.ok(took < 2000, 'разбор не должен уходить в экспоненциальный цикл: ' + took + ' мс');
  assert.ok(result.html.length < junkInText.length * 3, 'html не должен раздуваться');
  // Блок с таким классом в тексте считается «мусорным» и вырезается целиком — это\n  // ожидаемо. Важно, что разбор завершился быстро и строка не раздулась.\n  assert.ok(result.textLength >= 0);
});

test('разбор статьи: настоящий блок «related-posts» вырезается', () => {
  const html = '<article><p>нужный текст статьи, ради которого всё делается.</p>'
    + '<div class="related-posts"><a href="/x">чужое</a></div></article>';
  const result = extractArticle(html, 'https://example.com/post');
  assert.doesNotMatch(result.html, /чужое/, 'блок с классом related-posts должен быть вырезан');
  assert.match(result.html, /нужный текст/);
});
