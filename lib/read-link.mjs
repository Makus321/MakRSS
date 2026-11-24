// Сверка статей по ссылке: одна и та же статья может лежать и в обычной ленте
// Хабра, и в блоке «Читают сейчас». Отметки «прочитано» не должны расходиться.

/** Ключ статьи: схема, www, хвостовой слэш и регистр хоста не важны. */
export function linkKey(url) {
  try {
    const parsed = new URL(String(url ?? ''));
    if (!/^https?:$/i.test(parsed.protocol)) return '';
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${host}${pathname}${parsed.search}`.toLowerCase();
  } catch {
    return '';
  }
}

/** Все статьи из списков, чьи ссылки совпали с набором ключей. */
export function itemsWithLinks(lists, keys) {
  const found = [];
  if (!keys || !keys.size) return found;
  for (const list of lists) {
    for (const item of list ?? []) {
      if (!item?.link) continue;
      if (keys.has(linkKey(item.link))) found.push(item);
    }
  }
  return found;
}
