import { readFile, writeFile } from 'node:fs/promises';

const dir = process.argv[2];
const file = dir + '/public/app.js';
let app = await readFile(file, 'utf8');

// Старый блок компенсации по высоте списка
const oldBlock = [
  "    const listEl = document.querySelector('#list');",
  '    const beforeTop = listEl ? listEl.scrollTop : 0;',
  '    const beforeHeight = listEl ? listEl.scrollHeight : 0;',
  '    requestAnimationFrame(() => {',
  '      softRefreshCards();',
  '      updateActiveArticle();',
  '      if (!listEl || beforeTop <= 0) return;',
  '      const delta = listEl.scrollHeight - beforeHeight;',
  '      if (delta) listEl.scrollTop = Math.max(0, beforeTop + delta);',
  '    });',
].join('\n');

// Новая: компенсация по «якорной» карточке — возвращаем её туда же на экране
const newBlock = [
  "    const listEl = document.querySelector('#list');",
  '    // Якорь: первая видимая карточка. Запоминаем её положение на экране до',
  '    // обновления и возвращаем прокрутку так, чтобы она осталась на месте.',
  '    const listRect = listEl ? listEl.getBoundingClientRect() : null;',
  '    const anchor = listEl && listRect',
  "      ? [...listEl.querySelectorAll('.article[data-item]')]",
  '        .find((card) => card.getBoundingClientRect().bottom > listRect.top + 4)',
  '      : null;',
  "    const anchorId = anchor?.dataset.item ?? '';",
  '    const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;',
  '    requestAnimationFrame(() => {',
  '      softRefreshCards();',
  '      updateActiveArticle();',
  '      if (!listEl || !anchorId || listEl.scrollTop <= 0) return;',
  "      const again = listEl.querySelector('.article[data-item=\"' + anchorId + '\"]');",
  '      if (!again) return;',
  '      const shift = again.getBoundingClientRect().top - anchorTop;',
  '      if (Math.abs(shift) >= 1) listEl.scrollTop += shift;',
  '    });',
].join('\n');

if (!app.includes(oldBlock)) {
  console.log('старый блок компенсации не найден');
  process.exit(1);
}
app = app.replace(oldBlock, newBlock);
await writeFile(file, app, 'utf8');
console.log('ok — компенсация по якорной карточке');
