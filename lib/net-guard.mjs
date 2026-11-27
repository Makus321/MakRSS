// Сетевой слой для внешних адресов: защита от SSRF.
//
// Зачем: читалка ходит по ссылкам, которые приходят из лент и из адресной
// строки (/api/img?u=…, /api/video?u=…, /api/media?…). Без проверки такой
// запрос можно направить на localhost, в приватную сеть или на метаданные
// облака (169.254.169.254), а редирект с внешнего хоста обходил любую
// проверку строки URL.
//
// Здесь: резолвим имя в IP, отбрасываем приватные/служебные диапазоны и
// проходим редиректы вручную, проверяя каждый шаг заново.

import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_REDIRECTS = 5;

/**
 * Адрес отклонён защитой от SSRF. Отдельный класс нужен, чтобы маршруты-прокси
 * отвечали 403 и не отправляли браузер туда, куда сами ходить не стали.
 */
export class SsrfError extends Error {
  constructor(message = 'адрес не разрешён') {
    super(message);
    this.name = 'SsrfError';
  }
}
const DEFAULT_TIMEOUT_MS = 15_000;

/** Приватные и служебные IPv4-диапазоны: [начало, бит маски]. */
const V4_BLOCKS = [
  ['0.0.0.0', 8],        // «этот хост»
  ['10.0.0.0', 8],       // приватная сеть
  ['100.64.0.0', 10],    // CGNAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local, метаданные облака
  ['172.16.0.0', 12],    // приватная сеть
  ['192.0.0.0', 24],     // служебные протоколы
  ['192.0.2.0', 24],     // документация
  ['192.168.0.0', 16],   // домашняя сеть
  ['198.18.0.0', 15],    // тестовые сети
  ['198.51.100.0', 24],  // документация
  ['203.0.113.0', 24],   // документация
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // зарезервировано
];

const v4ToInt = (ip) => ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;

/** IPv6 → 128-битное число. Понимает «::», зону (%eth0) и IPv4-хвост. */
function v6ToBigInt(input) {
  let text = String(input ?? '').toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  // Встроенный IPv4 (::ffff:1.2.3.4) заменяем двумя шестнадцатеричными группами:
  // без этого такой адрес не разбирался и проходил как «не IPv6».
  const tail4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail4) {
    const [a, b, c, d] = tail4[1].split('.').map((part) => Number(part) & 0xff);
    text = text.slice(0, tail4.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const gaps = Math.max(0, 8 - headParts.length - tailParts.length);
  const parts = [...headParts, ...Array(gaps).fill('0'), ...tailParts];
  if (parts.length !== 8) return null;
  let value = 0n;
  for (const part of parts) {
    const group = Number.parseInt(part || '0', 16);
    if (!Number.isFinite(group)) return null;
    value = (value << 16n) | BigInt(group & 0xffff);
  }
  return value;
}

/** Маска префикса длиной bits для 128-битного числа. */
const v6Mask = (bits) => (bits <= 0 ? 0n : ((1n << 128n) - (1n << BigInt(128 - bits))));

/**
 * Служебные IPv6-диапазоны: [база, длина префикса].
 * Раньше проверялись только fc00::/7, fe80::/10, 2001:db8::/32 и запись
 * ::ffff:1.2.3.4 в «точечной» форме — канонический ::ffff:7f00:1 проходил.
 */
const V6_BLOCKS = [
  ['100::', 64],        // discard-only
  ['2001::', 32],       // Teredo: внутри может быть приватный IPv4
  ['2001:10::', 28],    // ORCHID
  ['2001:20::', 28],    // ORCHIDv2
  ['2001:db8::', 32],   // документация
  ['fc00::', 7],        // ULA
  ['fe80::', 10],       // link-local
  ['ff00::', 8],        // multicast
];

const v4FromInt = (value) => [24n, 16n, 8n, 0n]
  .map((shift) => Number((value >> shift) & 0xffn)).join('.');

/** IPv4, встроенный в IPv6 (mapped, compatible, NAT64, 6to4), — по правилам IPv4. */
function isBlockedV6(address) {
  const value = v6ToBigInt(address);
  if (value === null) return true;                    // не разобрали — не пускаем
  for (const [base, bits] of V6_BLOCKS) {
    const mask = v6Mask(bits);
    if ((value & mask) === (v6ToBigInt(base) & mask)) return true;
  }
  // v4FromInt работает с BigInt: раньше сюда передавался Number
  // и сравнение Number >> 1n падало с «Cannot mix BigInt and other types».
  const low = value & 0xffffffffn;
  // ::/96 — IPv4-compatible (сюда же :: и ::1): младшие 32 бита и есть IPv4.
  if (value >> 32n === 0n) return isBlockedAddress(v4FromInt(low));
  // ::ffff:0:0/96 — IPv4-mapped.
  if (value >> 32n === 0xffffn) return isBlockedAddress(v4FromInt(low));
  // 64:ff9b::/96 и 64:ff9b:1::/48 — NAT64: IPv4 спрятан в младших 32 битах.
  if ((value & v6Mask(96)) === (v6ToBigInt('64:ff9b::') & v6Mask(96))) return isBlockedAddress(v4FromInt(low));
  if ((value & v6Mask(48)) === (v6ToBigInt('64:ff9b:1::') & v6Mask(48))) return isBlockedAddress(v4FromInt(low));
  // 2002::/16 — 6to4: IPv4 лежит в битах 16…47.
  if ((value & v6Mask(16)) === (v6ToBigInt('2002::') & v6Mask(16))) {
    return isBlockedAddress(v4FromInt((value >> 80n) & 0xffffffffn));
  }
  return false;
}

/** IP в приватном или служебном диапазоне? */
export function isBlockedAddress(address) {
  const ip = String(address ?? '').trim();
  if (!ip) return true;
  if (net.isIPv4(ip)) {
    const value = v4ToInt(ip);
    return V4_BLOCKS.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (value & mask) === (v4ToInt(base) & mask);
    });
  }
  if (net.isIPv6(ip)) return isBlockedV6(ip);
  return true;   // не IP — считаем недопустимым
}

/**
 * Проверяет адрес перед запросом: протокол http(s), имя резолвится,
 * ни один из адресов не приватный.
 * @returns {Promise<URL>} проверенный адрес
 */
export async function assertPublicUrl(input) {
  let parsed;
  try {
    parsed = new URL(String(input));
  } catch {
    throw new SsrfError('плохой адрес');
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new SsrfError('разрешены только http(s)');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');

  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new SsrfError('адрес в приватной сети');
    return parsed;
  }

  let addresses = [];
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new SsrfError('имя не разрешается');
  }
  if (!addresses.length) throw new SsrfError('имя не разрешается');
  for (const entry of addresses) {
    if (isBlockedAddress(entry.address)) throw new SsrfError('адрес в приватной сети');
  }
  return parsed;
}

/**
 * fetch с защитой от SSRF: проверка адреса, ручные редиректы (≤5, каждый
 * проверяется заново), таймаут.
 */
const FINAL_URL = Symbol('finalUrl');

/** Адрес, на котором реально закончился запрос (после редиректов). */
export const finalUrlOf = (response, fallback = '') => response?.[FINAL_URL] ?? fallback;

export async function safeFetch(input, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = options;
  let current = await assertPublicUrl(input);
  const signal = rest.signal ?? AbortSignal.timeout(timeoutMs);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(current.toString(), { ...rest, signal, redirect: 'manual' });
    Object.defineProperty(response, FINAL_URL, { value: current.toString(), configurable: true });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    const next = new URL(location, current).toString();
    current = await assertPublicUrl(next);
  }
  throw new SsrfError('слишком много перенаправлений');
}
