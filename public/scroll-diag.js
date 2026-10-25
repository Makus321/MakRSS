/**
 * Самодиагностика прокрутки: следит за высотой содержимого и положением карточек
 * и пишет в панель КАЖДОЕ изменение — в том числе во время инерции прокрутки.
 * Так видно, что именно меняет раскладку: текст, картинки или догрузка.
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
    logEl.textContent = lines.length ? lines.slice(-16).join('\n') : 'изменений раскладки не зафиксировано';
  };

  const state = () => {
    const list = document.querySelector('#list');
    if (!list) return null;
    const listTop = list.getBoundingClientRect().top;
    const cards = [...list.querySelectorAll('.article[data-item]')];
    const first = cards.find((card) => card.getBoundingClientRect().bottom > listTop + 4) ?? null;
    return {
      scrollTop: Math.round(list.scrollTop),
      scrollHeight: Math.round(list.scrollHeight),
      cardsHeight: Math.round(cards.reduce((sum, card) => sum + card.getBoundingClientRect().height, 0)),
      cardCount: cards.length,
      firstId: first?.dataset.item ?? '',
      firstTop: first ? Math.round(first.getBoundingClientRect().top) : 0,
    };
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

    let prev = state();
    let mutations = 0;
    const observer = new MutationObserver((records) => { mutations += records.length; });
    const list = document.querySelector('#list');
    if (list) observer.observe(list, { childList: true, subtree: true, attributes: true, characterData: true });

    sampler = setInterval(() => {
      const now = state();
      if (!now || !prev) { prev = now; return; }
      const heightDelta = now.scrollHeight - prev.scrollHeight;
      const cardsDelta = now.cardsHeight - prev.cardsHeight;
      const scrollDelta = now.scrollTop - prev.scrollTop;
      const sameCard = now.firstId && now.firstId === prev.firstId;
      const cardDelta = sameCard ? now.firstTop - prev.firstTop : 0;
      // При обычной прокрутке высоты не меняются вовсе, поэтому любой скачок
      // высоты — это и есть причина сдвига.
      const contentChanged = heightDelta !== 0 || cardsDelta !== 0 || now.cardCount !== prev.cardCount;
      const scrollJumped = Math.abs(scrollDelta) > 2;

      if (contentChanged || scrollJumped) {
        lines.push([
          stamp(),
          'высота списка ' + (heightDelta > 0 ? '+' : '') + heightDelta,
          'высота карточек ' + (cardsDelta > 0 ? '+' : '') + cardsDelta,
          'прокрутка ' + (scrollDelta > 0 ? '+' : '') + scrollDelta,
          'карточка ' + (cardDelta > 0 ? '+' : '') + cardDelta,
          'DOM ' + mutations,
        ].join(' · '));
        if (stateEl) stateEl.textContent = 'записано событий: ' + lines.length;
        paint();
        mutations = 0;
      }
      prev = now;
    }, 50);

    timer = setTimeout(() => stop('замер закончен: событий ' + lines.length), 30000);
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
    const text = 'Диагностика прокрутки\n' + (lines.length ? lines.join('\n') : 'изменений не зафиксировано');
    try {
      await navigator.clipboard.writeText(text);
      if (stateEl) stateEl.textContent = 'скопировано в буфер';
    } catch {
      if (stateEl) stateEl.textContent = 'не удалось скопировать — сделайте снимок';
    }
  });
}
