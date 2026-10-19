// Пользователи читалки: список логинов, роли, хеши паролей и ключи Fever.
// Данные лежат в <data>/users.json — отдельно от лент, у каждого пользователя
// своя папка <data>/u/<id>/ со своими подписками, статьями и медиа.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { feverApiKey, hashPassword, newSecret, verifyPassword } from './auth.mjs';

const LOGIN_RE = /^[A-Za-z0-9._-]{3,32}$/;
const MIN_PASSWORD = 4;

export class Users {
  constructor(dataDir, log = () => {}) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'users.json');
    this.log = log;
    this.state = { version: 1, secret: '', users: [] };
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(await readFile(this.file, 'utf8'));
        this.state = { version: 1, secret: parsed.secret || '', users: Array.isArray(parsed.users) ? parsed.users : [] };
      } catch (err) {
        this.log(`users.json повреждён (${err.message}) — начинаем с пустого списка`);
      }
    }
    if (!this.state.secret) {
      this.state.secret = newSecret();
      await this.save();
    }
    return this;
  }

  // ------------------------------------------------------------- хранилище

  async save() {
    const text = JSON.stringify(this.state, null, 2);
    const tmp = `${this.file}.tmp`;
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(tmp, text, 'utf8');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rename(tmp, this.file);
        return;
      } catch (err) {
        if (attempt === 4) {
          // ownCloud/антивирус иногда держат файл — пишем напрямую.
          await writeFile(this.file, text, 'utf8').catch(() => {});
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
      }
    }
  }

  // ------------------------------------------------------------- выборки

  get all() { return this.state.users; }

  byId(id) { return this.state.users.find((u) => u.id === id) ?? null; }

  byLogin(login) {
    const needle = String(login ?? '').trim().toLowerCase();
    return this.state.users.find((u) => u.login.toLowerCase() === needle) ?? null;
  }

  byApiKey(key) {
    const needle = String(key ?? '').trim();
    if (!needle) return null;
    return this.state.users.find((u) => u.apiKey && u.apiKey === needle && !u.disabled) ?? null;
  }

  verify(user, password) {
    return Boolean(user) && !user.disabled && verifyPassword(password, user.hash);
  }

  /** Публичное представление пользователя (без хеша пароля). */
  view(user, extra = {}) {
    return {
      id: user.id,
      login: user.login,
      role: user.role,
      apiKey: user.apiKey,
      disabled: Boolean(user.disabled),
      createdAt: user.createdAt,
      lastSeenAt: user.lastSeenAt ?? null,
      ...extra,
    };
  }

  // ------------------------------------------------------------- изменения

  static validateLogin(login) {
    const value = String(login ?? '').trim();
    if (!LOGIN_RE.test(value)) return 'логин: 3–32 символа, латиница, цифры, точка, дефис или подчёркивание';
    return null;
  }

  static validatePassword(password) {
    if (String(password ?? '').length < MIN_PASSWORD) return `пароль короче ${MIN_PASSWORD} символов`;
    return null;
  }

  async create({ login, password, role = 'user' }) {
    const cleanLogin = String(login ?? '').trim();
    const loginError = Users.validateLogin(cleanLogin);
    if (loginError) throw new Error(loginError);
    const passwordError = Users.validatePassword(password);
    if (passwordError) throw new Error(passwordError);
    if (this.byLogin(cleanLogin)) throw new Error(`логин «${cleanLogin}» уже занят`);
    const user = {
      id: randomBytes(6).toString('hex'),
      login: cleanLogin,
      role: role === 'admin' ? 'admin' : 'user',
      hash: hashPassword(password),
      apiKey: feverApiKey(cleanLogin, password),
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
      disabled: false,
    };
    this.state.users.push(user);
    await this.save();
    return user;
  }

  async setPassword(user, password) {
    const passwordError = Users.validatePassword(password);
    if (passwordError) throw new Error(passwordError);
    user.hash = hashPassword(password);
    user.apiKey = feverApiKey(user.login, password);
    await this.save();
    return user;
  }

  async setRole(user, role) {
    user.role = role === 'admin' ? 'admin' : 'user';
    await this.save();
    return user;
  }

  async setDisabled(user, disabled) {
    user.disabled = Boolean(disabled);
    await this.save();
    return user;
  }

  /** Новый ключ Fever без смены пароля. */
  async renewApiKey(user) {
    user.apiKey = randomBytes(16).toString('hex');
    await this.save();
    return user;
  }

  async rename(user, login) {
    const cleanLogin = String(login ?? '').trim();
    const loginError = Users.validateLogin(cleanLogin);
    if (loginError) throw new Error(loginError);
    const other = this.byLogin(cleanLogin);
    if (other && other.id !== user.id) throw new Error(`логин «${cleanLogin}» уже занят`);
    user.login = cleanLogin;
    await this.save();
    return user;
  }

  async remove(user) {
    const index = this.state.users.findIndex((u) => u.id === user.id);
    if (index >= 0) this.state.users.splice(index, 1);
    await this.save();
  }

  countAdmins() {
    return this.state.users.filter((u) => u.role === 'admin' && !u.disabled).length;
  }

  /** Отметка «заходил» — сохраняем не чаще раза в 5 минут. */
  async touch(user) {
    const now = Date.now();
    if (user.lastSeenAt && now - Date.parse(user.lastSeenAt) < 5 * 60_000) return;
    user.lastSeenAt = new Date(now).toISOString();
    await this.save();
  }
}

/** Первый запуск: заводим администратора, иначе войти будет некому. */
export async function ensureDefaultAdmin(users, { login, password, log = () => {} }) {
  if (users.all.length) return null;
  const user = await users.create({ login, password, role: 'admin' });
  log(`создан администратор «${user.login}» с паролем «${password}» — смените его в админке /admin`);
  return user;
}

export const userDir = (dataDir, userId) => path.join(dataDir, 'u', userId);
