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

// Точный размер окна: headless игнорирует --window-size для узких значений.
const viewWidth = Number(args.get('width') ?? 0);
const viewHeight = Number(args.get('height') ?? 0);
if (viewWidth && viewHeight) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewWidth, height: viewHeight, deviceScaleFactor: 1, mobile: viewWidth < 700,
  });
}

await cdp.send('Network.enable');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');

/** Клик настоящей мышью по элементу (CDP Input): синтетический click не всегда работает. */
async function realClick(selector) {
  const box = await evaluate('(() => { const el = document.querySelector(' + JSON.stringify(selector) + '); '
    + 'if (!el) return null; const r = el.getBoundingClientRect(); '
    + 'return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 40)) }; })()');
  if (!box) return false;
  const base = { x: box.x, y: box.y, button: 'left', clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: base.x, y: base.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  return true;
}


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


// --- проверки, что функциональность не сломалась (пишутся в отчёт) ---
// --- замер отступов карточки ---
const styleProbe = await evaluate(`(() => {
  const list = document.querySelector('#list');
  const card = document.querySelector('.article');
  const head = document.querySelector('.article .a-head');
  const title = document.querySelector('.article .a-title');
  if (!list || !card || !head) return null;
  const cs = (el) => getComputedStyle(el);
  const rect = (el) => el.getBoundingClientRect();
  return {
    listPad: cs(list).padding,
    headPad: cs(head).padding,
    cardRadius: cs(card).borderRadius,
    cardMargin: cs(card).marginBottom,
    gapToRight: Math.round(rect(card).right - rect(title).right),
    cardWidth: Math.round(rect(card).width),
    titleWidth: Math.round(rect(title).width),
    textAlign: cs(title).textAlign,
  };
})()`);
console.log('  отступы карточки:', JSON.stringify(styleProbe));

// На узком экране дерево — выдвижная панель: сначала открываем её.
await evaluate("(() => { const btn = document.querySelector('#menu-btn'); if (!btn) return null; const r = btn.getBoundingClientRect(); if (r.width > 0) btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); return r.width; })()");
await sleep(600);

const beforeTree = await evaluate("document.querySelectorAll('#tree .row').length");
await realClick('#tree .row[data-feed-row]');
await sleep(2500);
const afterTree = await evaluate("document.querySelectorAll('#tree .row').length");
const feedCards = await evaluate("document.querySelectorAll('.article').length");
const treeText = await evaluate("(document.querySelector('#tree')?.innerText ?? '').slice(0, 60)");
console.log('  дерево до клика по ленте:', beforeTree);
console.log('  дерево после клика:', afterTree, '| карточек:', feedCards, '| текст дерева:', JSON.stringify(treeText));
const checks = [];
checks.push(['карточек на экране', await evaluate("document.querySelectorAll('.article').length")]);

// переключаемся на «Все статьи»: в непрочитанных карточка исчезает после прочтения
await realClick('[data-view="all"]');
await sleep(2500);
checks.push(['карточек после переключения вида', await evaluate("document.querySelectorAll('.article').length")]);

await realClick('.article .a-head');
await sleep(6000);
checks.push(['раскрытых статей', await evaluate("document.querySelectorAll('.article.expanded').length")]);
checks.push(['текст статьи, символов', await evaluate("(document.querySelector('.article .a-body')?.innerText ?? '').length")]);
checks.push(['картинок в статье', await evaluate("document.querySelectorAll('.article .a-body img').length")]);

await realClick('.article [data-star]');
await sleep(1500);
checks.push(['звёздочка нажата', await evaluate("document.querySelectorAll('.article [data-star].on').length")]);

await realClick('#search, input[type="search"]');
await evaluate("(() => { const input = document.querySelector('#search, input[type=search]'); if (!input) return null; input.value = 'и'; input.dispatchEvent(new Event('input', { bubbles: true })); return input.value; })()");
await sleep(1500);
checks.push(['карточек после поиска', await evaluate("document.querySelectorAll('.article').length")]);

for (const [label, value] of checks) console.log('  ✓ ' + label + ': ' + value);

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

const clampProbe = await evaluate(`(() => {
  const el = document.querySelector('.article .a-excerpt');
  if (!el) return null;
  const cs = getComputedStyle(el);
  return {
    inlineClamp: el.style.webkitLineClamp,
    computedClamp: cs.webkitLineClamp,
    display: cs.display,
    height: Math.round(el.getBoundingClientRect().height),
    lineHeight: cs.lineHeight,
    settingsLines: (window.__lines ?? 'нет'),
  };
})()`);
console.log('  строки анонса:', JSON.stringify(clampProbe));

// Проверка «полного вида»: включаем его для ленты и смотрим, есть ли текст и кнопки.
const fullModeCheck = await evaluate(`(async () => {
  const feedRow = document.querySelector('#tree .row[data-feed-row]');
  const feedId = feedRow?.dataset.feedRow;
  if (!feedId) return 'нет ленты';
  await fetch('/api/feeds/view', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: feedId, view: 'full' }) });
  location.reload();
  return feedId;
})()`);
console.log('  full-режим включён для ленты:', fullModeCheck);
await sleep(6000);
const fullProbe = await evaluate(`(() => {
  const card = document.querySelector('.article');
  const body = document.querySelector('.article .a-body');
  const actions = document.querySelector('.article .a-actions');
  if (!card) return null;
  const r = (el) => el ? el.getBoundingClientRect() : null;
  return {
    cardHeight: Math.round(r(card).height),
    bodyText: (body?.innerText ?? '').trim().length,
    bodyDisplay: body ? getComputedStyle(body).display : 'нет',
    actionsRect: r(actions) ? { top: Math.round(r(actions).top), left: Math.round(r(actions).left), w: Math.round(r(actions).width), h: Math.round(r(actions).height) } : null,
    cardRect: { left: Math.round(r(card).left), right: Math.round(r(card).right) },
    buttons: [...document.querySelectorAll('.article .a-actions button')].map((b) => Math.round(b.getBoundingClientRect().top)),
  };
})()`);
console.log('  полный вид:', JSON.stringify(fullProbe));

const hitProbe = await evaluate(`(() => {
  const btn = document.querySelector('.article [data-star]');
  if (!btn) return 'нет кнопки';
  const r = btn.getBoundingClientRect();
  const cx = Math.round(r.left + r.width / 2);
  const cy = Math.round(r.top + r.height / 2);
  const top = document.elementFromPoint(cx, cy);
  return {
    rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    point: { cx, cy },
    topTag: top ? top.tagName + '.' + (top.className || '') : 'нет',
    isButton: top === btn || btn.contains(top),
    pointerEvents: getComputedStyle(btn).pointerEvents,
    display: getComputedStyle(btn.parentElement).position,
  };
})()`);
console.log('  что под курсором у звезды:', JSON.stringify(hitProbe));

// Проверка кнопки «в избранное»: считаем бейдж до и после, ждём ответа сервера.
const starBefore = Number((await evaluate("document.querySelector('#badge-starred')?.textContent ?? '0'")).trim() || 0);
await realClick('.article [data-star]');
await sleep(3000);
const starAfter = Number((await evaluate("document.querySelector('#badge-starred')?.textContent ?? '0'")).trim() || 0);
const starServer = await evaluate("fetch('/api/data', { cache: 'no-store' }).then((r) => r.json()).then((d) => (d.data || d).counts?.starred ?? -1)");
console.log('  избранное: бейдж', starBefore, '→', starAfter, '| на сервере:', starServer);

// Проверка масштаба: ставим 60% и смотрим ширину карточки.
const zoomProbe = await evaluate(`(async () => {
  const card = () => document.querySelector('.article');
  if (!card()) return null;
  const before = Math.round(card().getBoundingClientRect().width);
  const minus = document.querySelector('.width-controls button, [data-width-dec], #width-dec');
  for (let i = 0; i < 12 && minus; i += 1) minus.click();
  await new Promise((r) => setTimeout(r, 500));
  const after = Math.round(card().getBoundingClientRect().width);
  return { before, after, value: document.querySelector('#width-value')?.textContent || '' };
})()`);
console.log('  масштаб:', JSON.stringify(zoomProbe));

// Замер геометрии после загрузки списка.
const geometryFinal = await evaluate(`(() => {
  const list = document.querySelector('#list');
  const card = document.querySelector('.article');
  const head = document.querySelector('.article .a-head');
  const title = document.querySelector('.article .a-title');
  if (!list || !card || !head) return null;
  const r = (el) => el.getBoundingClientRect();
  const cs = (el) => getComputedStyle(el);
  return {
    windowWidth: window.innerWidth,
    listPad: cs(list).padding,
    headPad: cs(head).padding,
    cardLeftGap: Math.round(r(card).left),
    cardRightGap: Math.round(window.innerWidth - r(card).right),
    cardWidth: Math.round(r(card).width),
    textRightGap: Math.round(r(card).right - r(title).right),
    maxWidth: cs(card).maxWidth,
  };
})()`);
console.log('  геометрия карточки:', JSON.stringify(geometryFinal));

// Проверка живых событий: открыт ли /api/events и приходят ли изменения.
const sseProbe = await evaluate(`(async () => {
  const before = (document.querySelector('#badge-starred')?.textContent ?? '').trim();
  // Помечаем первую статью избранной «извне» (как это сделал бы Fever-клиент).
  const id = document.querySelector('.article')?.dataset.item;
  if (!id) return { error: 'нет статьи' };
  await fetch('/api/star', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, starred: true, light: true }) });
  await new Promise((r) => setTimeout(r, 4000));
  const after = (document.querySelector('#badge-starred')?.textContent ?? '').trim();
  return { before, after, eventsOpen: performance.getEntriesByType('resource').some((e) => e.name.includes('/api/events')) };
})()`);
console.log('  события:', JSON.stringify(sseProbe));

// Ищем элементы с «0:00» — что это за время.
const findZero = await evaluate(`(() => {
  const hits = [];
  for (const el of document.querySelectorAll('*')) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
    if (!own.includes('0:00')) continue;
    hits.push({ tag: el.tagName + '.' + (el.className || ''), id: el.id || '', text: own.slice(0, 60) });
  }
  return hits.slice(0, 6);
})()`);
console.log('  элементы с 0:00:', JSON.stringify(findZero));
const headText = await evaluate("(document.querySelector('.pane-head')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 200)");
console.log('  шапка списка:', headText);

// Геометрия строки пароля: где поля и где кнопка.
const passRowProbe = await evaluate(`(() => {
  const input = document.querySelector('#set-pass-current');
  const button = document.querySelector('#save-credentials');
  if (!input || !button) return null;
  const r = (el) => el.getBoundingClientRect();
  return {
    input: { top: Math.round(r(input).top), bottom: Math.round(r(input).bottom), h: Math.round(r(input).height) },
    button: { top: Math.round(r(button).top), bottom: Math.round(r(button).bottom), h: Math.round(r(button).height) },
    deltaBottom: Math.round(r(button).bottom - r(input).bottom),
    align: getComputedStyle(input.closest('.pass-row')).alignItems,
  };
})()`);
console.log('  строка пароля:', JSON.stringify(passRowProbe));

// Снимок настроек, если задан --settings.
const settingsShot = args.get('settings');
if (settingsShot) {
  await realClick('#settings-btn');
  await sleep(1200);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  if (shot?.data) {
    const { writeFile: write } = await import('node:fs/promises');
    await write(settingsShot, Buffer.from(shot.data, 'base64'));
    console.log('  снимок настроек:', settingsShot);
  }
}

// Снимок экрана для визуальной проверки (если задан --shot).
const shotPath = args.get('shot');
if (shotPath) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  if (shot?.data) {
    const { writeFile: write } = await import('node:fs/promises');
    await write(shotPath, Buffer.from(shot.data, 'base64'));
    console.log('  снимок:', shotPath);
  }
}

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
