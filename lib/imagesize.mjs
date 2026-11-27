/**
 * Размер картинки по её содержимому: нужен, чтобы браузер заранее знал высоту
 * и лента не прыгала при загрузке. Поддерживаем JPEG и PNG, остальное — null.
 */
export function imageSize(buf) {
  try {
    if (!buf || buf.length < 24) return null;

    // PNG: 8 байт сигнатуры, затем IHDR с шириной и высотой (big-endian).
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }

    // JPEG: ищем маркер начала кадра (SOF0–SOF3, SOF5–SOF7, SOF9–SOF11, SOF13–SOF15).
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < buf.length) {
        if (buf[offset] !== 0xff) { offset += 1; continue; }
        const marker = buf[offset + 1];
        const length = buf.readUInt16BE(offset + 2);
        const isFrame = (marker >= 0xc0 && marker <= 0xc3)
          || (marker >= 0xc5 && marker <= 0xc7)
          || (marker >= 0xc9 && marker <= 0xcb)
          || (marker >= 0xcd && marker <= 0xcf);
        if (isFrame) {
          const height = buf.readUInt16BE(offset + 5);
          const width = buf.readUInt16BE(offset + 7);
          return width && height ? { width, height } : null;
        }
        // Маркеры без длины (RST0–RST7, TEM, SOI, EOI) не двигают offset на length.
        if (marker >= 0xd0 && marker <= 0xd9) { offset += 2; continue; }
        if (marker === 0x01) { offset += 2; continue; }
        if (!length || length < 2) return null;
        offset += 2 + length;
      }
      return null;
    }

    // WebP: VP8X / VP8 / VP8L — длину проверяем для каждой ветки: короткий буфер
    // раньше читался за своими границами (buf[24] был undefined).
    if (buf.length >= 16 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const kind = buf.toString('ascii', 12, 16);
      if (kind === 'VP8X') {
        if (buf.length < 30) return null;
        const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
        const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
        return { width, height };
      }
      if (kind === 'VP8 ') {
        if (buf.length < 30) return null;
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      if (kind === 'VP8L') {
        if (buf.length < 25) return null;
        const bits = buf.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
  } catch { /* неизвестный формат — размер не нужен */ }
  return null;
}
