// Минимальный XML-парсер без внешних зависимостей.
// Задача — разобрать RSS 2.0 / RSS 1.0 (RDF) / Atom, поэтому поддерживается
// ровно то, что встречается в фидах: пролог, DOCTYPE, комментарии, CDATA,
// самозакрывающиеся теги, атрибуты в кавычках, XML-сущности и пространства имён.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

export function decodeEntities(input) {
  if (!input || input.indexOf('&') === -1) return input;
  return input.replace(/&(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try { return String.fromCodePoint(code); } catch { return match; }
    }
    const key = body.toLowerCase();
    return Object.hasOwn(ENTITIES, key) ? ENTITIES[key] : match;
  });
}

export function escapeText(input) {
  return String(input).replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

/** Индекс символа '>', закрывающего тег (учитывает кавычки внутри атрибутов). */
function findTagEnd(source, start) {
  let quote = null;
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return source.length;
}

function parseAttributes(source) {
  const attrs = {};
  const re = /([^\s=/<>]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const value = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5];
    attrs[m[1]] = decodeEntities(value ?? '');
  }
  return attrs;
}

/** Разбирает XML в дерево { name, attrs, children }; текстовые узлы — { text }. */
export function parseXml(source) {
  const root = { name: '#document', attrs: {}, children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      const tail = source.slice(i);
      if (tail.trim()) top().children.push({ text: decodeEntities(tail) });
      break;
    }
    if (lt > i) {
      const chunk = source.slice(i, lt);
      if (chunk.trim()) top().children.push({ text: decodeEntities(chunk) });
    }

    if (source.startsWith('<?', lt)) {
      const end = source.indexOf('?>', lt);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt);
      // Внутри CDATA текст не декодируется: там лежит готовый HTML/текст как есть.
      top().children.push({ text: source.slice(lt + 9, end === -1 ? source.length : end) });
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<!', lt)) {
      const end = source.indexOf('>', lt);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith('</', lt)) {
      const end = source.indexOf('>', lt);
      const name = source.slice(lt + 2, end === -1 ? source.length : end).trim();
      for (let k = stack.length - 1; k > 0; k -= 1) {
        if (stack[k].name === name) { stack.length = k; break; }
      }
      i = end === -1 ? source.length : end + 1;
      continue;
    }

    const end = findTagEnd(source, lt);
    let inner = source.slice(lt + 1, end);
    const selfClosing = inner.endsWith('/');
    if (selfClosing) inner = inner.slice(0, -1);
    const nameMatch = /^([^\s/>]+)/.exec(inner);
    const name = nameMatch ? nameMatch[1] : '';
    const node = { name, attrs: parseAttributes(inner.slice(name.length)), children: [] };
    top().children.push(node);
    if (!selfClosing && name) stack.push(node);
    i = end + 1;
  }

  return root;
}

export function localName(node) {
  if (!node || !node.name) return '';
  const idx = node.name.indexOf(':');
  return (idx === -1 ? node.name : node.name.slice(idx + 1)).toLowerCase();
}

export function elementChildren(node) {
  return (node?.children ?? []).filter((c) => c.name);
}

export function child(node, name) {
  const want = name.toLowerCase();
  return elementChildren(node).find((c) => localName(c) === want) ?? null;
}

export function children(node, name) {
  const want = name.toLowerCase();
  return elementChildren(node).filter((c) => localName(c) === want);
}

/** Склеивает весь текст внутри узла (с учётом вложенных тегов и CDATA). */
export function text(node) {
  if (!node) return '';
  let out = '';
  for (const c of node.children ?? []) {
    if (c.name) out += text(c);
    else out += c.text ?? '';
  }
  return out;
}

export function trimmedText(node) {
  return text(node).replace(/\s+/g, ' ').trim();
}

/** Сериализует содержимое узла обратно в HTML (для Atom content type="xhtml"). */
export function serializeChildren(node) {
  let out = '';
  for (const c of node.children ?? []) {
    if (!c.name) { out += escapeText(c.text ?? ''); continue; }
    const attrs = Object.entries(c.attrs ?? {})
      .map(([k, v]) => ` ${k}="${String(v).replace(/"/g, '&quot;')}"`)
      .join('');
    out += `<${c.name}${attrs}>${serializeChildren(c)}</${c.name}>`;
  }
  return out;
}
