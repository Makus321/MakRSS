// Тесты медиа-типов: SVG и HTML с нашего origin недопустимы.
import test from 'node:test';
import assert from 'node:assert/strict';
import { safeImageType, safeVideoType, NOSNIFF, SAFE_IMAGE_TYPES } from '../lib/media-types.mjs';

test('safeImageType: растровые форматы проходят, SVG и html — нет', () => {
  for (const type of ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/x-icon']) {
    assert.equal(safeImageType(type), type, 'должен пропускаться: ' + type);
  }
  for (const type of ['image/svg+xml', 'text/html', 'application/javascript', '']) {
    assert.equal(safeImageType(type), 'application/octet-stream', 'должен замениться: ' + type);
  }
  assert.equal(safeImageType('image/png; charset=binary'), 'image/png');
  assert.equal(safeImageType(undefined), 'application/octet-stream');
});

test('safeVideoType: только video/*', () => {
  assert.equal(safeVideoType('video/mp4'), 'video/mp4');
  assert.equal(safeVideoType('video/webm; codecs=vp9'), 'video/webm');
  for (const type of ['text/html', 'application/xhtml+xml', 'image/svg+xml', '']) {
    assert.equal(safeVideoType(type), 'application/octet-stream', 'должен замениться: ' + type);
  }
});

test('в allowlist картинок нет svg', () => {
  assert.equal(SAFE_IMAGE_TYPES.has('image/svg+xml'), false);
  assert.deepEqual(NOSNIFF, { 'x-content-type-options': 'nosniff' });
});
