#!/usr/bin/env node
// Иконки приложения (PWA) — рисуем сами, без внешних библиотек:
// оранжевый квадрат со скруглением и белый значок RSS.
// Запуск: node tools/make-icons.mjs
//
//   public/icon-192.png           значок 192×192 со скруглением
//   public/icon-512.png           то же в 512×512
//   public/icon-maskable-512.png  без скругления, значок в «безопасной зоне» (Android)
//   public/apple-touch-icon.png   180×180 для iOS (скругление делает система)

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const ACCENT = [249, 115, 22];      // #f97316 — как в логотипе читалки
const WHITE = [255, 255, 255];

// ------------------------------------------------------------------ PNG

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

/** Собирает PNG из массива RGBA-пикселей. */
function png(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;                                   // фильтр 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;          // бит на канал
  ihdr[9] = 6;          // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ рисунок

/** Значок RSS: точка и две дуги, растущие вправо-вверх от неё. */
function glyph(x, y, scale) {
  const cx = 0.5 + (0.26 - 0.5) * scale;
  const cy = 0.5 + (0.74 - 0.5) * scale;
  const dx = x - cx;
  const dy = y - cy;                       // экран: вниз — плюс
  const dist = Math.hypot(dx, dy);
  const arc = dx >= -0.02 * scale && dy <= 0.02 * scale;   // четверть вправо-вверх
  const dot = dist <= 0.078 * scale;
  const ring = (r) => arc && Math.abs(dist - r * scale) <= 0.036 * scale;
  return dot || ring(0.20) || ring(0.355);
}

function draw(size, { rounded, glyphScale }) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = rounded ? size * 0.2 : 0;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const x = (px + 0.5) / size;
      const y = (py + 0.5) / size;
      // скругление квадрата: вне угловых окружностей пиксель прозрачный
      if (radius > 0) {
        const rx = Math.min(px + 0.5, size - px - 0.5);
        const ry = Math.min(py + 0.5, size - py - 0.5);
        if (rx < radius && ry < radius) {
          const d = Math.hypot(radius - rx, radius - ry);
          if (d > radius) continue;
        }
      }
      const color = glyph(x, y, glyphScale) ? WHITE : ACCENT;
      const at = (py * size + px) * 4;
      rgba[at] = color[0];
      rgba[at + 1] = color[1];
      rgba[at + 2] = color[2];
      rgba[at + 3] = 255;
    }
  }
  return png(size, size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
const files = [
  ['icon-192.png', draw(192, { rounded: true, glyphScale: 1 })],
  ['icon-512.png', draw(512, { rounded: true, glyphScale: 1 })],
  ['icon-maskable-512.png', draw(512, { rounded: false, glyphScale: 0.76 })],
  ['apple-touch-icon.png', draw(180, { rounded: false, glyphScale: 0.86 })],
];
for (const [name, data] of files) {
  writeFileSync(path.join(OUT_DIR, name), data);
  console.log(`${name}: ${(data.length / 1024).toFixed(1)} КБ`);
}
