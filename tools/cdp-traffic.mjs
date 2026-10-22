#!/usr/bin/env node
/**
 * Замер реального трафика читалки в headless-браузере через CDP.
 *
 * Перед запуском поднимите браузер с отладочным портом (tools/run-cdp-traffic.ps1)
 * и задайте переменные окружения RSS_TEST_LOGIN и RSS_TEST_PASS.
 *
 * Запуск:
 *   node tools/cdp-traffic.mjs --port 9223 --url https://rss.letsplay.today/ --scroll 10
 *
 * Печатает вес по типам ресурсов и самые тяжёлые запросы. Зависимостей нет:
 * используется встроенный WebSocket Node.js.
 */
import process from 'node:process';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = String(process.argv[i] ?? '').replace(/^--/, '');
  args.set(key, process.argv[i + 1]);
}

const port = Number(args.get('port') ?? 9223);
const targetUrl = args.get('url') ?? 'https://rss.letsplay.today/';
const loginName = process.env.RSS_TEST_LOGIN ?? '';
const loginSecret = process.env.RSS_TEST_PASS ?? '';
const scrollSteps = Number(args.get('scroll') ?? 10);
const settle = Number(args.get('settle') ?? 700);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Адрес отладочного сокета СТРАНИЦЫ: у браузерного нет домена Network. */
async function pageSocketUrl() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      let list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      let page = list.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (!page) {
        // Нет вкладок — открываем свою.
        await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' }).catch(() => {});
        await sleep(500);
        list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
        page = list.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      }
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* браузер ещё стартует */ }
    await sleep(300);
  }
  throw new Error('не удалось подключиться к странице браузера');
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
    return this;
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(listener) {
    this.listeners.push(listener);
  }

  close() {
    try { this.ws.close(); } catch { /* уже закрыт */ }
  }
}

const cdp = await new Cdp(await pageSocketUrl()).open();

const stats = new Map();
const requests = new Map();

const problems = [];
cdp.on((message) => {
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params?.exceptionDetails ?? {};
    problems.push((details.exception?.description ?? details.text ?? 'ошибка').split('\n')[0]);
  }
  if (message.method === 'Network.responseReceived' && message.params?.response?.status >= 400) {
    problems.push('HTTP ' + message.params.response.status + ' ' + message.params.response.url.slice(0, 80));
  }
  if (message.method === 'Network.requestWillBeSent') {
    const { requestId, request, type } = message.params;
    requests.set(requestId, { url: request.url, type });
  }
  if (message.method === 'Network.loadingFinished') {
    const { requestId, encodedDataLength } = message.params;
    const info = requests.get(requestId);
    if (!info) return;
    const entry = stats.get(info.url) ?? { bytes: 0, type: info.type, count: 0 };
    entry.bytes += encodedDataLength ?? 0;
    entry.count += 1;
    stats.set(info.url, entry);
  }
});

await cdp.send('Network.enable');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');

async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return result?.result?.value;
}

// Собираем ошибки страницы ещё до загрузки приложения.
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: "window.__errors = [];"
    + "addEventListener('error', (e) => window.__errors.push(String(e.message)));"
    + "addEventListener('unhandledrejection', (e) => window.__errors.push('rejection: ' + String(e.reason && e.reason.message || e.reason)));",
});

await cdp.send('Page.navigate', { url: targetUrl });
await sleep(2500);

if (loginName && loginSecret) {
const body = JSON.stringify({ user: loginName, ['password']: loginSecret, remember: true });
  const script = "fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, "
    + 'body: ' + JSON.stringify(body) + ' }).then((r) => r.json()).then((d) => Boolean(d && d.ok))';
  const ok = await evaluate(script);
  console.log('  вход:', ok ? 'ок' : 'не удался');
  await cdp.send('Page.navigate', { url: targetUrl });
  await sleep(3000);
}

for (let step = 0; step < scrollSteps; step += 1) {
  await evaluate("(() => { const list = document.querySelector('#list'); "
    + 'if (!list) return 0; list.scrollTop = list.scrollTop + list.clientHeight * 0.9; return list.scrollTop; })()');
  await sleep(settle);
}

await sleep(1500);

// Диагностика: сколько карточек отрисовано и что вернул сервер.
if (problems.length) { console.log('  проблемы:'); for (const p of problems.slice(0, 6)) console.log('   ·', p); }
const probe = await evaluate("fetch('/api/data?view=unread&limit=5&offset=0&unread=1&nocache=' + Date.now(), { cache: 'no-store' })"
  + ".then((r) => r.text()).then((t) => t.slice(0, 160)).catch((e) => 'ошибка: ' + e.message)");
console.log('  ответ /api/data:', probe);
console.log('  ошибки страницы:', await evaluate("(window.__errors || []).slice(0, 4)"));
console.log('  версия:', await evaluate("document.querySelector('#sidebar-version')?.textContent"));
console.log('  строк в дереве:', await evaluate("document.querySelector('#tree')?.children.length"));
console.log('  текст страницы:', await evaluate("(document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 160)"));
console.log('  карточек в списке:', await evaluate("document.querySelectorAll('.article').length"));
console.log('  вход показан:', await evaluate("!document.querySelector('#login-modal')?.hidden"));
console.log('  текст списка:', await evaluate("(document.querySelector('#list')?.textContent ?? '').slice(0, 90)"));
console.log('  тост:', await evaluate("(document.querySelector('#toast')?.textContent ?? '').slice(0, 90)"));
console.log('  статей в состоянии:', await evaluate("(window.__rssState && window.__rssState.data && window.__rssState.data.items || []).length"));

const byUrl = [...stats.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
const byType = new Map();
let total = 0;
for (const [, value] of byUrl) {
  total += value.bytes;
  const type = value.type ?? 'Other';
  byType.set(type, (byType.get(type) ?? 0) + value.bytes);
}

const kb = (bytes) => (bytes / 1024).toFixed(1) + ' КБ';
console.log('\n== по типам ==');
for (const [type, bytes] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
  console.log('  ' + type.padEnd(10) + ' ' + kb(bytes));
}
const grouped = new Map();
for (const [url, value] of byUrl) {
  const key = url.replace(/\?.*$/, '');
  const entry = grouped.get(key) ?? { bytes: 0, count: 0 };
  entry.bytes += value.bytes;
  entry.count += value.count;
  grouped.set(key, entry);
}
console.log('\n== самые тяжёлые запросы ==');
for (const [url, value] of [...grouped.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 14)) {
  console.log('  ' + String(value.count).padStart(3) + '× ' + kb(value.bytes).padStart(10) + '  ' + url.slice(0, 88));
}
console.log('\n== ВСЕГО: ' + kb(total) + ' ==');

cdp.close();
process.exit(0);
