/**
 * Проверка отображения картинок в браузере (headless Chromium через CDP).
 * Ищем статью с картинками из кэша (/api/media) и статью с обычными картинками,
 * замеряем: сколько img в DOM, у скольких naturalWidth > 0, сколько с обтеканием.
 *
 * Запуск: node tools/patch/check-browser.mjs <port> <login> <password>
 */
const port = Number(process.argv[2]);
const login = process.argv[3];
const password = process.argv[4];
const base = 'https://rss.letsplay.today/';

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) { console.log('CHECK_FAIL: нет страницы'); process.exit(1); }

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
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: base });
await sleep(5000);

// вход, если показали форму
const logged = await evaluate(`(async () => {
  const modal = document.querySelector('#login-modal');
  if (!modal || modal.hidden) return 'session';
  document.querySelector('#login-user').value = ${JSON.stringify(login)};
  document.querySelector('#login-pass').value = ${JSON.stringify(password)};
  document.querySelector('#login-submit').click();
  await new Promise((r) => setTimeout(r, 4000));
  return 'submitted';
})()`);
console.log('  вход:', JSON.stringify(logged));
// После входа перезагружаем: приложение поднимает данные только при старте.
await evaluate('setTimeout(() => location.reload(), 50)');
await sleep(9000);

// раскрываем первые карточки и замеряем две: из кэша и обычную
console.log('  карточек на странице:', await evaluate("document.querySelectorAll('.article').length"));
const report = await evaluate(`(async () => {
  const allView = document.querySelector('[data-view="all"]');
  if (allView) {
    allView.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 2500));
  }
  const cards = [...document.querySelectorAll('.article')].slice(0, 12);
  for (const card of cards) {
    card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 700));
  }
  await new Promise((r) => setTimeout(r, 2500));
  const measure = (card) => {
    const body = card.querySelector('.a-body');
    if (!body) return null;
    const imgs = [...body.querySelectorAll('img')];
    if (!imgs.length) return null;
    return {
      title: (card.querySelector('.a-title')?.textContent ?? '').slice(0, 28),
      total: imgs.length,
      loaded: imgs.filter((i) => i.naturalWidth > 0).length,
      visible: imgs.filter((i) => i.getBoundingClientRect().height > 20).length,
      floated: imgs.filter((i) => i.classList.contains('wrap-left')).length,
      cached: imgs.filter((i) => (i.getAttribute('src') ?? '').startsWith('/api/media')).length,
    };
  };
  const cached = [];
  const external = [];
  for (const card of cards) {
    const info = measure(card);
    if (!info) continue;
    if (info.cached > 0) cached.push(info);
    else external.push(info);
  }
  return { cached: cached.slice(0, 2), external: external.slice(0, 2) };
})()`);
console.log('  статьи с картинками:', JSON.stringify(report));

const cachedOk = (report?.cached ?? []).every((i) => i.total === i.loaded && i.total === i.visible && i.floated === 0);
const externalOk = (report?.external ?? []).every((i) => i.loaded > 0);
const hasCached = (report?.cached?.length ?? 0) > 0;
const hasExternal = (report?.external?.length ?? 0) > 0;
console.log('CHECK3 cached_posts_ok:', cachedOk, 'posts_with_cache:', report?.cached?.length ?? 0);
console.log('CHECK4 external_posts_ok:', externalOk, 'posts_external:', report?.external?.length ?? 0);
console.log('RESULT:', cachedOk && externalOk && hasCached && hasExternal ? 'PASS' : 'FAIL');
ws.close();
