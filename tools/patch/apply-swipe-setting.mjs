import { readFile, writeFile } from 'node:fs/promises';

const dir = process.argv[2];
const file = dir + '/public/app.js';
let app = await readFile(file, 'utf8');

const readAnchor = "  setSelectValue($('#set-image-wrap'), state.prefs.imageWrap ? 'yes' : 'no');";
if (app.includes('set-swipe-next') && app.includes('swipeNext')) {
  console.log('уже подключено');
} else {
  if (!app.includes(readAnchor)) { console.log('не найдено чтение set-image-wrap'); process.exit(1); }
  app = app.replace(readAnchor, readAnchor + "\n  setSelectValue($('#set-swipe-next'), state.prefs.swipeNext === false ? 'no' : 'yes');");

  const changeAnchor = [
    "  $('#set-image-wrap').addEventListener('change', (e) => {",
    '    state.prefs.imageWrap = e.target.value !== \'no\';',
    '    savePrefs();',
    '    renderList();',
    '  });',
  ].join('\n');
  if (!app.includes(changeAnchor)) { console.log('не найден обработчик set-image-wrap'); process.exit(1); }
  app = app.replace(changeAnchor, changeAnchor + [
    '',
    "  $('#set-swipe-next').addEventListener('change', (e) => {",
    "    state.prefs.swipeNext = e.target.value !== 'no';",
    '    savePrefs();',
    '  });',
  ].join('\n'));

  await writeFile(file, app, 'utf8');
  console.log('ok — настройка свайпа подключена');
}
