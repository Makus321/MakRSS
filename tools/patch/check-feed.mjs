/**
 * Открывает подписку в дереве и замеряет картинки в статьях.
 * Запуск: node tools/patch/check-feed.mjs <port> <login> <password> [подстрока названия ленты]
 */
const port = Number(process.argv[2]);
const login = process.argv[3];
const password = process.argv[4];
const wanted = process.argv[5] ?? '';

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
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
  return result?.exceptionDetails ? { error: result.exceptionDetails.text } : result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'https://rss.letsplay.today/' });
await sleep(6000);

const loginState = await evaluate(`(async () => {
  const modal = document.querySelector('#login-modal');
  if (!modal || modal.hidden) return 'session';
  document.querySelector('#login-user').value = ${JSON.stringify(login)};
  document.querySelector('#login-pass').value = ${JSON.stringify(password)};
  document.querySelector('#login-submit').click();
  await new Promise((r) => setTimeout(r, 4000));
  return 'submitted';
})()`);
console.log('  вход:', JSON.stringify(loginState));
await sleep(3000);

const opened = await evaluate(`(async () => {
  const rows = [...document.querySelectorAll('.row')];
  const row = ${JSON.stringify(wanted)}
    ? rows.find((r) => (r.textContent || '').includes(${JSON.stringify(wanted)}))
    : rows[0];
  if (!row) return { error: 'нет строк в дереве', rows: rows.length };
  row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 4000));
  return { name: (row.textContent || '').slice(0, 30), cards: document.querySelectorAll('.article').length };
})()`);
console.log('  лента:', JSON.stringify(opened));

const measured = await evaluate(`(async () => {
  const list = document.querySelector('#list');
  for (let i = 0; i < 4; i += 1) { list.scrollTop = list.scrollHeight; await new Promise((r) => setTimeout(r, 900)); }
  const cards = [...document.querySelectorAll('.article')].slice(0, 14);
  const out = [];
  for (const card of cards) {
    card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1500));
    // Ждём, пока картинки реально загрузятся (до 12 секунд на карточку).
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const pics = [...card.querySelectorAll('.a-body img')];
      if (pics.length && pics.every((i) => i.complete)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const body = card.querySelector('.a-body');
    if (!body) continue;
    const imgs = [...body.querySelectorAll('img')];
    if (!imgs.length) continue;
    out.push({
      title: (card.querySelector('.a-title')?.textContent ?? '').slice(0, 24),
      total: imgs.length,
      loaded: imgs.filter((i) => i.naturalWidth > 0).length,
      visible: imgs.filter((i) => i.getBoundingClientRect().height > 20).length,
      floated: imgs.filter((i) => i.classList.contains('wrap-left')).length,
      src: (imgs[0].getAttribute('src') ?? '').slice(0, 34),
    });
    if (out.length >= 2) break;
  }
  return out;
})()`);
console.log('  замер:', JSON.stringify(measured));
ws.close();
