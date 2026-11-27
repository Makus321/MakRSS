// Пароли, сессии и ключ для Fever API.
// Пароль хранится только как scrypt-хеш; ключ Fever (md5 от «логин:пароль»)
// считается один раз при смене пароля — сам пароль в открытом виде не сохраняется.

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_KEYLEN = 32;
// scrypt на строке в мегабайт — это бесплатный DoS: длину пароля ограничиваем.
// Хеш считается от обрезанного значения, поэтому одинаково для входа и регистрации.
const MAX_PASSWORD_LENGTH = 4096;
const passwordFor = (password) => String(password ?? '').slice(0, MAX_PASSWORD_LENGTH);

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(passwordFor(password), salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const candidate = scryptSync(passwordFor(password), salt, expected.length || SCRYPT_KEYLEN);
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

/**
 * Сессия содержит версию пользователя: смена пароля или блокировка её увеличивают,
 * и все ранее выданные cookie перестают действовать.
 */
export function issueSession(secret, user, ttlMs, version = 0) {
  const expires = Date.now() + ttlMs;
  const payload = `${user}|${expires}|${Number(version) || 0}`;
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
  const [user, expires, version] = payload.split('|');
  if (!user || !Number(expires) || Number(expires) < Date.now()) return null;
  // Старые токены (без версии) считаем версией 0 — после обновления никто не вылетает.
  return { user, expires: Number(expires), version: Number(version) || 0 };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    // Битый процент (%zz) раньше бросал URIError и валил весь запрос:
    // значение оставляем как пришло, разбор продолжается.
    const raw = part.slice(index + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

export function cookieHeader(name, value, { maxAge, expires, secure = false } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  // Secure обязателен, когда сайт отдаётся по HTTPS: иначе браузер пришлёт
  // cookie и по открытому HTTP, если такой запрос возможен.
  if (secure) parts.push('Secure');
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  if (expires) parts.push(`Expires=${new Date(expires).toUTCString()}`);
  return parts.join('; ');
}

/**

/**
 * Разбирает заголовок Authorization: Basic …
 * Пароль может содержать «:», поэтому режем строку только по первому двоеточию:
 * иначе пароль «pa:ss» превращался в «pa» и вход не проходил.
 */
export function parseBasicAuth(header) {
  const raw = String(header ?? "");
  const match = /^Basic\s+/i.exec(raw);
  if (!match) return null;
  let decoded = "";
  try {
    decoded = Buffer.from(raw.slice(match[0].length), "base64").toString("utf8");
  } catch {
    return null;
  }
  const at = decoded.indexOf(":");
  if (at <= 0) return null;
  return { login: decoded.slice(0, at), password: decoded.slice(at + 1) };
}
