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
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    // IPv4 внутри IPv6 (::ffff:127.0.0.1) проверяем как IPv4.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isBlockedAddress(mapped[1]);
    if (lower === '::' || lower === '::1') return true;               // unspecified, loopback
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;                // fc00::/7 (ULA)
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;                // fe80::/10 (link-local)
    if (/^2001:db8:/.test(lower)) return true;                        // документация
    return false;
  }
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
    throw new Error('плохой адрес');
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('разрешены только http(s)');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');

  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new Error('адрес в приватной сети');
    return parsed;
  }

  let addresses = [];
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error('имя не разрешается');
  }
  if (!addresses.length) throw new Error('имя не разрешается');
  for (const entry of addresses) {
    if (isBlockedAddress(entry.address)) throw new Error('адрес в приватной сети');
  }
  return parsed;
}

/**
 * fetch с защитой от SSRF: проверка адреса, ручные редиректы (≤5, каждый
 * проверяется заново), таймаут.
 */
export async function safeFetch(input, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = options;
  let current = await assertPublicUrl(input);
  const signal = rest.signal ?? AbortSignal.timeout(timeoutMs);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(current.toString(), { ...rest, signal, redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    const next = new URL(location, current).toString();
    current = await assertPublicUrl(next);
  }
  throw new Error('слишком много перенаправлений');
}
