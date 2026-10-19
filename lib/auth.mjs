// Пароли, сессии и ключ для Fever API.
// Пароль хранится только как scrypt-хеш; ключ Fever (md5 от «логин:пароль»)
// считается один раз при смене пароля — сам пароль в открытом виде не сохраняется.

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_KEYLEN = 32;

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const candidate = scryptSync(String(password), salt, expected.length || SCRYPT_KEYLEN);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/** Ключ Fever API: md5 от «логин:пароль» (так его считает протокол Fever). */
export const feverApiKey = (user, password) => createHash('md5').update(`${user}:${password}`).digest('hex');

export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export const newSecret = () => randomBytes(32).toString('hex');

// ------------------------------------------------------------------ сессии

export function issueSession(secret, user, ttlMs) {
  const expires = Date.now() + ttlMs;
  const payload = `${user}|${expires}`;
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${signature}`;
}

export function readSession(secret, token) {
  const [body, signature] = String(token ?? '').split('.');
  if (!secret || !body || !signature) return null;
  let payload;
  try {
    payload = Buffer.from(body, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (!safeEqual(signature, expected)) return null;
  const [user, expires] = payload.split('|');
  if (!user || !Number(expires) || Number(expires) < Date.now()) return null;
  return { user, expires: Number(expires) };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    out[name] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

export function cookieHeader(name, value, { maxAge, expires } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  if (expires) parts.push(`Expires=${new Date(expires).toUTCString()}`);
  return parts.join('; ');
}
