/** Диагностика: что реально видно на странице после попытки входа. */
const port = Number(process.argv[2]);
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
console.log('  1 старт:', JSON.stringify(await evaluate(`({
  url: location.href,
  modal: document.querySelector('#login-modal')?.hidden,
  cards: document.querySelectorAll('.article').length,
  text: (document.body.innerText || '').slice(0, 80),
})`)));
console.log('  2 вход:', JSON.stringify(await evaluate(`(async () => {
  const user = document.querySelector('#login-user');
  const pass = document.querySelector('#login-pass');
  if (!user || !pass) return 'нет формы';
  user.value = 'traffic';
  pass.value = 'Traf-test-2026';
  document.querySelector('#login-submit').click();
  await new Promise((r) => setTimeout(r, 5000));
  return { modal: document.querySelector('#login-modal')?.hidden, cards: document.querySelectorAll('.article').length, err: document.querySelector('#login-error')?.textContent ?? '' };
})()`)));
await sleep(3000);
console.log('  3 после:', JSON.stringify(await evaluate(`({
  cards: document.querySelectorAll('.article').length,
  text: (document.body.innerText || '').slice(0, 100),
  sub: document.querySelector('#view-sub')?.textContent ?? '',
})`)));
console.log('  4 фильтр Все:', JSON.stringify(await evaluate(`(async () => {
  const buttons = [...document.querySelectorAll('.seg button, .seg .btn, button')];
  const all = buttons.find((b) => (b.textContent || '').trim() === 'Все');
  if (!all) return { found: false, labels: buttons.slice(0, 8).map((b) => (b.textContent || '').trim()) };
  all.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 4000));
  return { found: true, cards: document.querySelectorAll('.article').length, sub: document.querySelector('#view-sub')?.textContent ?? '' };
})()`)));
ws.close();
