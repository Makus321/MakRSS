/**
 * Замер прокрутки списка: ищет самопроизвольные сдвиги после остановки.
 * Запуск: node tools/patch/check-scroll.mjs <port> <login> <password> [имя ленты]
 */
const port = Number(process.argv[2]);
const login = process.argv[3];
const password = process.argv[4];
const feedName = process.argv[5] ?? 'Хабр';

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) { console.log('нет страницы'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const waiting = new Map();
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq;
  waiting.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
ws.addEventListener('message', (event) => {
  const data = JSON.parse(event.data);
  if (data.id && waiting.has(data.id)) { waiting.get(data.id)(data.result); waiting.delete(data.id); }
});
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result?.exceptionDetails) return { error: result.exceptionDetails.text };
  return result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Page.enable');
await send('Emulation.setCPUThrottlingRate', { rate: 4 });   // как на телефоне
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: 'https://rss.letsplay.today/' });
await sleep(6000);

const auth = await evaluate(`(async () => {
  const modal = document.querySelector('#login-modal');
  if (!modal || modal.hidden) return 'session';
  document.querySelector('#login-user').value = ${JSON.stringify(login)};
  document.querySelector('#login-pass').value = ${JSON.stringify(password)};
  document.querySelector('#login-submit').click();
  await new Promise((r) => setTimeout(r, 4000));
  return 'submitted';
})()`);
console.log('вход:', JSON.stringify(auth));
await sleep(2000);

const opened = await evaluate(`(async () => {
  const rows = [...document.querySelectorAll('.row')];
  const row = rows.find((r) => (r.textContent || '').includes(${JSON.stringify(feedName)})) ?? rows[0];
  if (!row) return { error: 'нет лент в дереве', rows: rows.length };
  row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 4000));
  return { feed: (row.textContent || '').trim().slice(0, 24), cards: document.querySelectorAll('.article').length };
})()`);
console.log('лента:', JSON.stringify(opened));
if (!opened?.cards) { console.log('карточек нет — замер невозможен'); ws.close(); process.exit(1); }

// Раскрываем несколько карточек: так начинается фоновая догрузка текста.
const expanded = await evaluate(`(async () => {
  const cards = [...document.querySelectorAll('.article')].slice(0, 4);
  for (const card of cards) {
    card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 700));
  }
  await new Promise((r) => setTimeout(r, 2500));
  return cards.length;
})()`);
console.log('раскрыто карточек:', expanded);

// Прокручиваем шагами, после каждого шага «отпускаем» и смотрим,
// меняется ли позиция сама по себе и уезжает ли контрольная карточка.
const result = await evaluate(`(async () => {
  const list = document.querySelector('#list');
  const jumps = [];
  const cardHeight = (card) => Math.round(card.getBoundingClientRect().height);
  const anchor = () => {
    const top = list.getBoundingClientRect().top;
    return [...list.querySelectorAll('.article[data-item]')]
      .find((card) => card.getBoundingClientRect().bottom > top + 4) ?? null;
  };
  for (let step = 0; step < 20; step += 1) {
    list.scrollTop += 240;
    await new Promise((r) => setTimeout(r, 120));
    const card = anchor();
    const id = card?.dataset.item ?? '';
    const beforeTop = card ? Math.round(card.getBoundingClientRect().top) : 0;
    const beforeScroll = list.scrollTop;
    const beforeHeight = list.scrollHeight;
    // ждём 1,5 секунды: за это время приходит фоновая загрузка
    await new Promise((r) => setTimeout(r, 1500));
    const again = id ? list.querySelector('.article[data-item="' + id + '"]') : null;
    const afterTop = again ? Math.round(again.getBoundingClientRect().top) : null;
    const shift = afterTop === null ? null : afterTop - beforeTop;
    if (Math.abs(list.scrollTop - beforeScroll) > 1 || (shift !== null && Math.abs(shift) > 1)) {
      jumps.push({
        step,
        scroll: [Math.round(beforeScroll), Math.round(list.scrollTop)],
        anchorShiftPx: shift,
        heightDelta: list.scrollHeight - beforeHeight,
      });
    }
  }
  return { jumps, cards: document.querySelectorAll('.article').length, scrollTop: Math.round(list.scrollTop), scrollHeight: list.scrollHeight };
})()`);
console.log('замер:', JSON.stringify(result));
ws.close();
