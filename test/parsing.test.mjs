// Тесты итерации 7: Fever-команды, пути Store, res.end(callback), глубокая вложенность XML.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { feverCommand } from '../lib/fever.mjs';
import { Store } from '../lib/store.mjs';
import { trackTraffic } from '../lib/traffic.mjs';
import { parseXml, localName } from '../lib/xml.mjs';

const form = (object) => new URLSearchParams(object);

test('Fever: ?api=1 — метка, а не команда', () => {
  // Регрессия: api=1 обрывал ответ после первой секции, и клиент с
  // ?api=1&feeds=1&items=1 не получал статьи.
  assert.equal(feverCommand(form({ api: '1' })), '');
  assert.equal(feverCommand(form({ api: 'feeds' })), 'feeds');
  assert.equal(feverCommand(form({ api: 'ITEMS' })), 'items');
  assert.equal(feverCommand(form({})), '');
});

test('Store: идентификатор ленты не выводит за каталог', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rss-store7-'));
  try {
    const store = new Store(dir, () => {});
    await store.init();
    await assert.rejects(() => store.setBody('../evil', 'x', { content: 'данные' }), /идентификатор/);
    const names = await readdir(dir);
    assert.deepEqual(names.filter((name) => name.includes('evil')), []);
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('traffic: res.end(callback) не падает', () => {
  const res = new EventEmitter();
  res.write = () => true;
  res.end = (chunk, ...rest) => {
    assert.equal(typeof chunk, 'function');
    return true;
  };
  assert.doesNotThrow(() => trackTraffic({ method: 'GET', url: '/', headers: {} }, res, path.join(tmpdir(), 'traffic-test.json')));
  assert.doesNotThrow(() => res.end(() => {}));
});

test('XML: глубокая вложенность не роняет разбор', () => {
  const depth = 3000;
  const source = '<root>' + '<a>'.repeat(depth) + 'текст' + '</a>'.repeat(depth) + '</root>';
  const started = Date.now();
  const tree = parseXml(source);
  const took = Date.now() - started;
  assert.ok(took < 2000, 'разбор должен укладываться в 2 с: ' + took + ' мс');
  assert.equal(localName(tree.children[0]), 'root');
});
