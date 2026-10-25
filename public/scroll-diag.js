/**
 * Самодиагностика прокрутки: 30 секунд следит за списком и показывает прямо на
 * экране каждый сдвиг. Сравниваем с «базой», снятой в момент остановки, а не
 * с предыдущим кадром — иначе медленный сдвиг по 1 px не ловился.
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

  const stamp = () => ((Date.now() - startedAt) / 1000).toFixed(1) + ' с';
  const paint = () => {
    logEl.textContent = lines.length ? lines.slice(-14).join('\n') : 'сдвигов не зафиксировано';
  };

  const listEl = () => document.querySelector('#list');
  const anchorCard = () => {
    const list = listEl();
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

    let userScrolling = false;
    let lastScrollAt = 0;
    let baseline = null;          // снимок после остановки
    let lastScrollTop = listEl()?.scrollTop ?? 0;
    let mutations = 0;

    const observer = new MutationObserver((records) => { mutations += records.length; });
    const list = listEl();
    if (list) observer.observe(list, { childList: true, subtree: true, attributes: true, characterData: true });

    list?.addEventListener('scroll', () => {
      lastScrollAt = Date.now();
      userScrolling = true;
      baseline = null;            // пока двигаем — базой не пользуемся
    }, { passive: true });

    const snapshot = () => {
      const el = listEl();
      const card = anchorCard();
      return {
        scrollTop: Math.round(el?.scrollTop ?? 0),
        height: Math.round(el?.scrollHeight ?? 0),
        id: card?.dataset.item ?? '',
        top: card ? Math.round(card.getBoundingClientRect().top) : 0,
      };
    };

    sampler = setInterval(() => {
      const el = listEl();
      if (!el) return;
      const idle = Date.now() - lastScrollAt > 350;

      if (!idle) { lastScrollTop = el.scrollTop; return; }

      if (userScrolling) {
        userScrolling = false;
        baseline = snapshot();
        mutations = 0;
        return;
      }
      if (!baseline) { baseline = snapshot(); return; }

      const now = snapshot();
      const shiftScroll = now.scrollTop - baseline.scrollTop;
      const shiftCard = now.id && now.id === baseline.id ? now.top - baseline.top : 0;
      const shiftHeight = now.height - baseline.height;

      if (Math.abs(shiftScroll) > 0 || Math.abs(shiftCard) > 0 || Math.abs(shiftHeight) > 0) {
        lines.push([
          stamp(),
          'прокрутка ' + (shiftScroll > 0 ? '+' : '') + shiftScroll,
          'карточка ' + (shiftCard > 0 ? '+' : '') + shiftCard,
          'высота ' + (shiftHeight > 0 ? '+' : '') + shiftHeight,
          'DOM ' + mutations,
        ].join(' · '));
        if (stateEl) stateEl.textContent = 'найдено сдвигов: ' + lines.length;
        paint();
        baseline = now;
        mutations = 0;
      }

      lastScrollTop = now.scrollTop;
    }, 50);

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
