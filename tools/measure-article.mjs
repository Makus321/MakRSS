// Собирает тестовую страницу со статьёй и скриптом, который измеряет ширины блоков.
// Нужно, чтобы понять, какие элементы статьи оказываются уже карточки.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const project = process.argv[2];
const articleFile = process.argv[3];
const out = process.argv[4];

const css = await readFile(path.join(project, 'public', 'style.css'), 'utf8');
const raw = await readFile(articleFile, 'utf8');
const clean = raw.replace(/\sstyle="[^"]*"/gi, '').replace(/\s(on\w+|srcdoc)="[^"]*"/gi, '');

const measure = `
<script>
window.addEventListener('load', () => setTimeout(() => {
  const body = document.querySelector('.a-body');
  const card = document.querySelector('.article');
  const cardWidth = card.getBoundingClientRect().width;
  const rows = [];
  for (const el of body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    rows.push([el.tagName.toLowerCase(), Math.round(r.width), Math.round(r.left - card.getBoundingClientRect().left)]);
  }
  const summary = rows.filter(([tag, w, left]) => w < cardWidth - 2 && ['p','figure','img','figcaption','ul','ol','li','div','section','h2','h3','blockquote'].includes(tag));
  const byTag = {};
  for (const [tag, w, left] of summary) {
    if (!byTag[tag]) byTag[tag] = { count: 0, minWidth: w, maxWidth: w, minLeft: left, maxLeft: left };
    const s = byTag[tag];
    s.count += 1; s.minWidth = Math.min(s.minWidth, w); s.maxWidth = Math.max(s.maxWidth, w);
    s.minLeft = Math.min(s.minLeft, left); s.maxLeft = Math.max(s.maxLeft, left);
  }
  const pre = document.createElement('pre');
  pre.id = 'report';
  // Что вылезает за карточку — именно это заставляет список прокручиваться вбок.
  const cardRect = card.getBoundingClientRect();
  const tooWide = [];
  for (const el of body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    if (r.right > cardRect.right + 1 || r.width > cardWidth + 1) {
      const src = el.getAttribute('src');
      const wAttr = el.getAttribute('width');
      tooWide.push(el.tagName.toLowerCase() + ' w=' + Math.round(r.width) + ' +' + Math.round(r.right - cardRect.right)
        + (wAttr ? ' width=' + wAttr : '')
        + (src ? ' …' + String(src).slice(-20) : ''));
    }
  }
  const list = document.querySelector('.list');
  pre.textContent = JSON.stringify({
    cardWidth: Math.round(cardWidth),
    listClientWidth: list.clientWidth,
    listScrollWidth: list.scrollWidth,
    боковойСкролл: list.scrollWidth - list.clientWidth,
    слишкомШироких: tooWide.length,
    примеры: tooWide.slice(0, 6),
    byTag,
  }, null, 1);
  pre.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99;background:#fff;color:#000;font:12px monospace;padding:8px;white-space:pre-wrap;border-bottom:2px solid red';
  document.body.prepend(pre);
}, 1200));
</script>`;

const page = `<!doctype html>
<html lang="ru" data-theme="light"><head><meta charset="utf-8">
<style>${css}</style>
<style>body { margin: 0 } .app { display: block } .list { height: none; overflow: visible; padding: 8px 12px }</style>
</head><body>
<main class="list-pane"><div class="list" id="list">
  <article class="article expanded compact" style="--read-width:100%" data-item="x">
    <div class="a-head">
      <div class="a-main"><h3 class="a-title">Тестовая статья</h3><div class="a-meta"><span class="src">Mobile-Review</span></div></div>
      <div class="a-actions"><button>☆</button><button>✓</button></div>
    </div>
    <div class="a-body">${clean}</div>
  </article>
</div></main>
${measure}
</body></html>`;

await writeFile(out, page, 'utf8');
console.log('страница собрана:', out);
