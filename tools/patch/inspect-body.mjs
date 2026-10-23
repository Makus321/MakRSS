/** Проверяет преобразование текста поста так же, как это делает сервер. */
const response = await fetch('http://127.0.0.1:8787/api/bodies', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ids: [process.argv[2]] }),
});
const data = await response.json();
const content = data.bodies?.[process.argv[2]]?.content ?? '';
console.log('content_len', content.length, 'imgs', (content.match(/<img/gi) ?? []).length);
console.log('own_paragraphs', (content.match(/<p>\s*<img/gi) ?? []).length);
console.log('first_200', JSON.stringify(content.slice(0, 200)));
const srcs = [...content.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]);
console.log('srcs', srcs.map((s) => s.slice(0, 30)));
const tags = [...content.matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1].toLowerCase());
const counts = {};
for (const tag of tags) counts[tag] = (counts[tag] ?? 0) + 1;
console.log('tags', JSON.stringify(counts));
