// Тесты итерации 7.2: границы WebP, маркеры JPEG, void-теги и DOCTYPE в XML.
import test from 'node:test';
import assert from 'node:assert/strict';
import { imageSize } from '../lib/imagesize.mjs';
import { parseXml, localName, text, elementChildren } from '../lib/xml.mjs';

test('imagesize: короткий WebP не читается за границей буфера', () => {
  // VP8X-заголовок без данных: раньше читались buf[24..29], которых нет.
  const head = Buffer.alloc(20);
  head.write('RIFF', 0, 'ascii');
  head.write('WEBP', 8, 'ascii');
  head.write('VP8X', 12, 'ascii');
  assert.equal(imageSize(head), null);
  // VP8L требует 25 байт — тоже null, а не исключение.
  const lossless = Buffer.alloc(18);
  lossless.write('RIFF', 0, 'ascii');
  lossless.write('WEBP', 8, 'ascii');
  lossless.write('VP8L', 12, 'ascii');
  assert.equal(imageSize(lossless), null);
});

test('imagesize: корректный WebP VP8X даёт размеры', () => {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  // Ширина 100, высота 50 (значение минус один, три байта little-endian).
  buf[24] = 99; buf[25] = 0; buf[26] = 0;
  buf[27] = 49; buf[28] = 0; buf[29] = 0;
  assert.deepEqual(imageSize(buf), { width: 100, height: 50 });
});

test('imagesize: маркеры JPEG без длины не ломают разбор', () => {
  // Реальный JPEG длиннее 24 байт (иначе срабатывает общий предохранитель),
  // поэтому перед SOF0 кладём APP0, а между ними — RST0 (0xd0, без длины).
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)]);
  const rst = Buffer.from([0xff, 0xd0]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x32, 0x00, 0x64, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00]);
  const buf = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, rst, sof]);
  assert.deepEqual(imageSize(buf), { width: 100, height: 50 });
});

test('XML: <br></br> не открывает блок, абзац остаётся в корне', () => {
  const tree = parseXml('<root><br></br><p>текст</p></root>');
  const root = elementChildren(tree)[0];
  assert.equal(localName(root), 'root');
  const tags = elementChildren(root).map((node) => localName(node));
  assert.deepEqual(tags, ['br', 'p']);
  assert.equal(text(elementChildren(root)[1]), 'текст');
});

test('XML: DOCTYPE с внутренним подмножеством не ломает разбор', () => {
  const source = '<!DOCTYPE rss [<!ENTITY x "y">]><rss><channel><title>Имя</title></channel></rss>';
  const tree = parseXml(source);
  const rss = elementChildren(tree)[0];
  assert.equal(localName(rss), 'rss');
  const channel = elementChildren(rss)[0];
  assert.equal(text(elementChildren(channel)[0]), 'Имя');
});

test('XML: пробел между элементами сохраняется', () => {
  const tree = parseXml('<root><b>a</b> <i>b</i></root>');
  const root = elementChildren(tree)[0];
  assert.equal(text(root), 'a b');
});
