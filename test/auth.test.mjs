// Тесты авторизации: разбор Basic-заголовка и конкурентная запись users.json.
// Регрессии, которые эти тесты ловят:
//   1) пароль с «:» обрезался до двоеточия, и вход не проходил;
//   2) два параллельных save() писали в один временный файл и теряли изменения.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  hashPassword, verifyPassword, parseBasicAuth, safeEqual, feverApiKey,
  issueSession, readSession, newSecret, parseCookies,
} from '../lib/auth.mjs';
import { Users } from '../lib/users.mjs';

const encode = (value) => 'Basic ' + Buffer.from(value, 'utf8').toString('base64');
const tricky = ['pa', 'ss', 'word'].join(':');
const russian = ['мой', 'пароль'].join(' ');

test('пароль: хеш и проверка', () => {
  const stored = hashPassword(tricky);
  assert.equal(verifyPassword(tricky, stored), true);
  assert.equal(verifyPassword(tricky.slice(0, -1), stored), false);
  assert.equal(verifyPassword('', stored), false);
});

test('parseBasicAuth: пароль с двоеточием не обрезается', () => {
  const parsed = parseBasicAuth(encode('user:' + tricky));
  assert.deepEqual(parsed, { login: 'user', password: tricky });
});

test('parseBasicAuth: кириллица в логине и пробел в пароле', () => {
  const parsed = parseBasicAuth(encode('Пётр:' + russian));
  assert.deepEqual(parsed, { login: 'Пётр', password: russian });
});

test('parseBasicAuth: мусор и чужие схемы дают null', () => {
  assert.equal(parseBasicAuth(''), null);
  assert.equal(parseBasicAuth(undefined), null);
  assert.equal(parseBasicAuth('Bearer token'), null);
  assert.equal(parseBasicAuth(encode('без двоеточия')), null);
  assert.equal(parseBasicAuth(encode(':пустой логин')), null);
});

test('safeEqual и ключ Fever', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.match(feverApiKey('user', 'pass'), /^[0-9a-f]{32}$/);
});

test('сессии: выпуск и чтение', () => {
  const secret = newSecret();
  const token = issueSession(secret, 'ivan', 60_000);
  const parsed = readSession(secret, token);
  assert.equal(parsed.user, 'ivan');
  assert.equal(readSession(newSecret(), token), null);
});

async function makeUsers() {
  const dir = await mkdtemp(path.join(tmpdir(), 'rss-users-'));
  const users = new Users(dir, () => {});
  await users.init();
  return { dir, users };
}

test('users.json: параллельные сохранения не теряют изменения', async () => {
  const { dir, users } = await makeUsers();
  try {
    await users.create({ login: 'alpha', password: 'one-pass' });
    await users.create({ login: 'beta', password: 'two-pass' });
    await Promise.all(Array.from({ length: 10 }, () => users.save()));
    const raw = await readFile(path.join(dir, 'users.json'), 'utf8');
    const parsed = JSON.parse(raw);            // бросит, если файл обрезан
    assert.deepEqual(parsed.users.map((u) => u.login).sort(), ['alpha', 'beta']);
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'временные файлы должны быть переименованы');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('users.json: удаление пользователя сохраняется при параллельной записи', async () => {
  const { dir, users } = await makeUsers();
  try {
    await users.create({ login: 'gamma', password: 'three-pass' });
    await users.create({ login: 'delta', password: 'four-pass' });
    const gamma = users.byLogin('gamma');
    await users.remove(gamma);
    await Promise.all([users.save(), users.save(), users.save()]);
    const parsed = JSON.parse(await readFile(path.join(dir, 'users.json'), 'utf8'));
    assert.deepEqual(parsed.users.map((u) => u.login), ['delta']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parseCookies: битый процент не роняет запрос', () => {
  // Регрессия: decodeURIComponent('%zz') бросал URIError, и обработчик запроса
  // падал целиком из-за одной испорченной cookie.
  const parsed = parseCookies('a=1; bad=%zz; good=%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82');
  assert.equal(parsed.a, '1');
  assert.equal(parsed.bad, '%zz');            // оставляем как пришло
  assert.equal(parsed.good, 'привет');
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(''), {});
});

test('сессия: версия сохраняется и читается', () => {
  const secret = newSecret();
  const token = issueSession(secret, 'ivan', 60_000, 7);
  assert.equal(readSession(secret, token).version, 7);
  // Старый токен без версии считается версией 0 — после обновления никто не вылетает.
  const legacy = issueSession(secret, 'ivan', 60_000);
  assert.equal(readSession(secret, legacy).version, 0);
});

test('пароль: длина ограничена, гигабайтная строка не вешает scrypt', () => {
  const long = 'x'.repeat(1024 * 1024);
  const started = Date.now();
  const stored = hashPassword(long);
  const took = Date.now() - started;
  assert.ok(took < 1500, 'хеширование слишком долгое: ' + took + ' мс');
  // Обрезка одинаковая при записи и проверке: длинный пароль продолжает подходить.
  assert.equal(verifyPassword(long, stored), true);
  assert.equal(verifyPassword('x'.repeat(5000), stored), true);
});

test('смена пароля отзывает сессии: версия увеличивается', async () => {
  const pw1 = ['rev', 'oke'].join('-');
  const pw2 = ['second', 'pass'].join('-');
  const { dir, users } = await makeUsers();
  try {
    const user = await users.create({ login: 'revoke', password: pw1 });
    const secret = newSecret();
    const before = issueSession(secret, user.login, 60_000, user.sessionVersion ?? 0);
    assert.equal(readSession(secret, before).version, 0);
    await users.setPassword(user, pw2);
    assert.equal(user.sessionVersion, 1, 'версия должна увеличиться');
    const token = readSession(secret, before);
    // Контроллер сравнивает версию из токена с версией пользователя: 0 ≠ 1 — сессия мертва.
    assert.notEqual(token.version, user.sessionVersion);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('users.verify: Basic Auth проверяет пароль по users.json', async () => {
  const pw = ['ba', 'sic'].join('-');
  const wrong = ['wr', 'ong'].join('-');
  const { dir, users } = await makeUsers();
  try {
    const user = await users.create({ login: 'basic', password: pw });
    assert.equal(users.verify(user, pw), true);
    assert.equal(users.verify(user, wrong), false);
    await users.setDisabled(user, true);
    assert.equal(users.verify(user, pw), false, 'заблокированный не должен входить');
    assert.equal(user.sessionVersion, 1, 'блокировка тоже отзывает сессии');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
