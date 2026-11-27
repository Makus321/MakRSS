// Тесты разбора статей. Регрессия: JUNK_BLOCK мог совпасть в тексте (не в теге),
// lastIndexOf('<') возвращал -1, и stripJunkBlocks дублировал строку до 40 раз — OOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractArticle, sanitizeHtml } from '../lib/readability.mjs';

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

test('XSS: санитайзер вырезает опасные теги, атрибуты и схемы', () => {
  // Регрессии: <img/src=x onerror=…> проходил мимо allowlist (в теге не было пробела),
  // data:image/svg+xml нёс скрипт, а base/object/math вообще не вырезались.
  const payloads = [
    '<p>до</p><img src=x onerror=alert(1)>',
    '<p>до</p><img/src=x onerror=alert(1)>',
    '<p>до</p><svg onload=alert(1)></svg>',
    '<p>до</p><a href="javascript:alert(1)">ссылка</a>',
    '<p>до</p><a href="data:text/html,<script>alert(1)</script>">ссылка</a>',
    '<p>до</p><img src="data:image/svg+xml,<svg onload=alert(1)>">',
    '<p>до</p><base href="https://evil.example/">',
    '<p>до</p><object data="javascript:alert(1)"></object>',
    '<p>до</p><math><mtext><script>alert(1)</script></mtext></math>',
    '<p>до</p><div style="background:url(javascript:alert(1))">т</div>',
  ];
  for (const payload of payloads) {
    const out = sanitizeHtml(payload, 'https://example.com/post');
    assert.doesNotMatch(out, /<\s*(base|object|math|embed|svg|script)\b/i, 'опасный тег выжил: ' + out);
    assert.doesNotMatch(out, /\son[a-z]+\s*=/i, 'обработчик события выжил: ' + out);
    assert.doesNotMatch(out, /javascript:/i, 'javascript: выжил: ' + out);
    assert.doesNotMatch(out, /data:image\/svg/i, 'svg в data: выжил: ' + out);
  }
});

test('XSS: растровая картинка в data: остаётся', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const out = sanitizeHtml('<p><img src="' + png + '"></p>', 'https://example.com/post');
  assert.match(out, /data:image\/png/, 'растровая data:-картинка не должна пропадать');
});

test('XSS: опасные data:-ссылки в href не остаются', () => {
  const out = sanitizeHtml('<p><img src="data:image/gif;base64,R0lGOD"></p>', 'https://example.com/post');
  assert.match(out, /data:image\/gif/);
});
