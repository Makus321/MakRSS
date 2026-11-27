// Комментарии: текст с сайта должен проходить через санитайзер статей.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHtml } from '../lib/readability.mjs';

test('комментарий: обработчики и javascript: вычищаются', () => {
  const raw = '<p>текст</p><img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a>';
  const out = sanitizeHtml(raw, 'https://mobile-review.com/all/post/');
  assert.doesNotMatch(out, /on[a-z]+\s*=/i);
  assert.doesNotMatch(out, /javascript:/i);
  assert.match(out, /текст/);
});
