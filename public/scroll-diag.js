/**
 * Самодиагностика прокрутки: 30 секунд следит за списком и показывает прямо на
 * экране каждый сдвиг (позиция ленты, положение карточек, высота содержимого).
 * Нужна, чтобы ловить рывки на телефоне без консоли разработчика.
 */
export function installScrollDiagnostics() {
  const panel = document.querySelector('#scroll-diag');
  const startBtn = document.querySelector('#scroll-diag-start');
  const logEl = document.querySelector('#scroll-diag-log');
  const stateEl = document.querySelector('#scroll-diag-state');
  const copyBtn = document.querySelector('#scroll-diag-copy');
  const closeBtn = document.querySelector('#scroll-diag-close');
  if (!panel || !startBtn || !logEl) return;

  let running = false;
  let timer = null;
  let sampler = null;
  let startedAt = 0;
  const lines = [];

  const stamp = () => {
    const elapsed = Math.round((Date.now() - startedAt) / 100) / 10;
    return elapsed.toFixed(1) + ' с';
  };

  const paint = () => {
    logEl.textContent = lines.length ? lines.slice(-14).join('\n') : 'сдвигов не зафиксировано';
  };

  const anchorCard = () => {
    const list = document.querySelector('#list');
    if (!list) return null;
    const top = list.getBoundingClientRect().top;
    return [...list.querySelectorAll('.article[data-item]')]
      .find((card) => card.getBoundingClientRect().bottom > top + 4) ?? null;
  };

  const stop = (reason) => {
    if (!running) return;
    running = false;
    clearInterval(sampler);
    clearTimeout(timer);
    if (stateEl) stateEl.textContent = reason ?? 'замер закончен';
    paint();
  };

  const start = () => {
    if (running) return;
    running = true;
    startedAt = Date.now();
    lines.length = 0;
    panel.hidden = false;
    if (stateEl) stateEl.textContent = 'идёт замер, прокручивайте ленту';
    paint();

    let lastScroll = document.querySelector('#list')?.scrollTop ?? 0;
    let lastHeight = document.querySelector('#list')?.scrollHeight ?? 0;
    let lastAnchorId = anchorCard()?.dataset.item ?? '';
    let lastAnchorTop = lastAnchorId ? Math.round(anchorCard().getBoundingClientRect().top) : 0;
    let lastUserScrollAt = Date.now();
    let mutations = 0;

    const list = document.querySelector('#list');
    list?.addEventListener('scroll', () => { lastUserScrollAt = Date.now(); }, { passive: true });

    const observer = new MutationObserver((records) => { mutations += records.length; });
    if (list) observer.observe(list, { childList: true, subtree: true, attributes: true });

    sampler = setInterval(() => {
      const listEl = document.querySelector('#list');
      if (!listEl) return;
      const card = anchorCard();
      const anchorId = card?.dataset.item ?? '';
      const anchorTop = card ? Math.round(card.getBoundingClientRect().top) : 0;
      const idle = Date.now() - lastUserScrollAt > 400;
      const scrollDelta = Math.round(listEl.scrollTop - lastScroll);
      const heightDelta = listEl.scrollHeight - lastHeight;
      const sameAnchor = anchorId && anchorId === lastAnchorId;
      const anchorDelta = sameAnchor ? anchorTop - lastAnchorTop : 0;

      // Сдвиг = лента уже не листается, а карточка или позиция изменились.
      if (idle && (Math.abs(scrollDelta) > 1 || Math.abs(anchorDelta) > 1 || heightDelta !== 0)) {
        lines.push([
          stamp(),
          'scroll ' + (scrollDelta > 0 ? '+' : '') + scrollDelta + ' px',
          'карточка ' + (anchorDelta > 0 ? '+' : '') + anchorDelta + ' px',
          'высота ' + (heightDelta > 0 ? '+' : '') + heightDelta + ' px',
          'изменений DOM ' + mutations,
        ].join(' · '));
        if (stateEl) stateEl.textContent = 'найдено сдвигов: ' + lines.length;
        paint();
        mutations = 0;
      }

      lastScroll = listEl.scrollTop;
      lastHeight = listEl.scrollHeight;
      lastAnchorId = anchorId;
      lastAnchorTop = anchorTop;
    }, 60);

    timer = setTimeout(() => stop('замер закончен: сдвигов ' + lines.length), 30000);
  };

  startBtn.addEventListener('click', (event) => {
    event.preventDefault();
    start();
  });

  closeBtn?.addEventListener('click', () => {
    stop('замер остановлен');
    panel.hidden = true;
  });

  copyBtn?.addEventListener('click', async () => {
    const text = 'Диагностика прокрутки\n' + (lines.length ? lines.join('\n') : 'сдвигов не зафиксировано');
    try {
      await navigator.clipboard.writeText(text);
      if (stateEl) stateEl.textContent = 'скопировано в буфер';
    } catch {
      if (stateEl) stateEl.textContent = 'не удалось скопировать — сделайте снимок';
    }
  });
}
