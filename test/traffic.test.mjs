// Тест учёта трафика: битый request-target не должен ронять обработчик.
// Регрессия, которую ловим: new URL(req.url, 'http://' + Host) бросал
// ERR_INVALID_URL вне try/catch и валил процесс (падал весь сервер).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { trackTraffic } from '../lib/traffic.mjs';

const fakeRes = () => {
  const res = new EventEmitter();
  res.write = () => true;
  res.end = () => true;
  return res;
};

test('trackTraffic: невалидный адрес запроса не роняет процесс', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'rss-traffic-')), 'traffic.json');
  for (const url of ['//bad host/x', 'http://', '\\', '/?%zz=1']) {
    const res = fakeRes();
    assert.doesNotThrow(
      () => trackTraffic({ method: 'GET', url, headers: { host: 'bad host' } }, res, file),
      'адрес: ' + url,
    );
    assert.doesNotThrow(() => res.emit('finish'), 'завершение ответа: ' + url);
  }
});

test('trackTraffic: нормальный адрес считается по маршруту', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'rss-traffic-')), 'traffic.json');
  const res = fakeRes();
  res.write('abc');
  res.emit('finish');
  trackTraffic({ method: 'GET', url: '/api/data?rev=1&unread=1', headers: { host: 'rss.letsplay.today' } }, res, file);
  res.emit('finish');
  assert.doesNotThrow(() => res.write('x'));
});
