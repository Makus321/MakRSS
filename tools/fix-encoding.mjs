// Восстановление файлов, испорченных перекодировкой UTF-8 → CP1251 → UTF-8.
// Обратная операция: символы → байты windows-1251 → декодирование как UTF-8.
import { readFile, writeFile } from 'node:fs/promises';

const decode1251 = new TextDecoder('windows-1251');
const charToByte = new Map();
for (let byte = 0; byte < 256; byte += 1) {
  const ch = decode1251.decode(new Uint8Array([byte]));
  if (ch.length === 1 && ch !== '\uFFFD' && !charToByte.has(ch)) charToByte.set(ch, byte);
}

/** Один шаг раскодировки. Возвращает null, если символ не из windows-1251. */
function step(text) {
  const bytes = [];
  for (const ch of text) {
    const byte = charToByte.get(ch);
    if (byte === undefined) return null;
    bytes.push(byte);
  }
  return new TextDecoder('utf-8').decode(Buffer.from(bytes));
}

const looksNormal = (text) => /Кратко|Настройки|Подписки/.test(text);
const countBroken = (text) => (text.match(/\uFFFD/g) ?? []).length;

const file = process.argv[2];
const out = process.argv[3];
let text = (await readFile(file, 'utf8')).replace(/^\uFEFF/, '').replace(/\uFEFF/g, '');
if (looksNormal(text)) {
  console.log('файл уже в порядке, правка не нужна');
  process.exit(0);
}
for (let pass = 1; pass <= 4; pass += 1) {
  const next = step(text);
  if (next === null) { console.log(`шаг ${pass}: символ вне windows-1251 — дальше нельзя`); break; }
  text = next;
  const broken = countBroken(text);
  console.log(`шаг ${pass}: длина ${text.length}, потерянных символов ${broken}, читается как русский: ${looksNormal(text)}`);
  if (looksNormal(text) && broken === 0) break;
}
await writeFile(out, text, 'utf8');
console.log(`результат записан: ${out}`);
