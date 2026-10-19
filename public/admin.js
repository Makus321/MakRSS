// Админка MAK RSS Reader: вход, список пользователей, ключи Fever.
// Данные берутся из /api/admin/*; у каждого пользователя своя папка данных.

const $ = (selector) => document.querySelector(selector);

async function api(pathname, body) {
  const res = await fetch(pathname, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.ok === false) {
    const error = new Error(payload.error ?? `HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return payload;
}

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

function message(element, text, kind = '') {
  element.className = `msg ${kind}`;
  element.textContent = text ?? '';
}

const when = (iso) => {
  if (!iso) return '—';
  const date = new Date(iso);
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} ч назад`;
  return date.toLocaleDateString('ru-RU');
};

let currentUser = null;
let users = [];

function renderUsers() {
  const adminCount = users.filter((u) => u.role === 'admin' && !u.disabled).length;
  $('#users').innerHTML = users.map((user) => {
    const me = currentUser && user.login === currentUser.login;
    const stats = user.stats ?? {};
    return `<tr>
      <td>${esc(user.login)}${me ? ' <span class="badge">это вы</span>' : ''}${user.disabled ? ' <span class="badge off">отключён</span>' : ''}</td>
      <td><span class="badge ${user.role === 'admin' ? 'admin' : ''}">${user.role === 'admin' ? 'админ' : 'пользователь'}</span></td>
      <td class="stats">${stats.feeds ?? 0}</td>
      <td class="stats">${stats.items ?? 0}</td>
      <td class="stats">${stats.unread ?? 0}</td>
      <td class="muted">${when(user.createdAt)}</td>
      <td class="muted">${when(user.lastSeenAt)}</td>
      <td class="key-cell"><code>${esc(user.apiKey ?? '')}</code></td>
      <td><div class="actions">
        <button class="btn" data-act="password" data-id="${esc(user.id)}">пароль</button>
        <button class="btn" data-act="rename" data-id="${esc(user.id)}">логин</button>
        <button class="btn" data-act="role" data-id="${esc(user.id)}" data-role="${user.role === 'admin' ? 'user' : 'admin'}"
          ${me ? 'disabled title="себе роль не меняем"' : ''}>${user.role === 'admin' ? 'снять админа' : 'сделать админом'}</button>
        <button class="btn" data-act="renew-key" data-id="${esc(user.id)}">новый ключ</button>
        <button class="btn" data-act="${user.disabled ? 'enable' : 'disable'}" data-id="${esc(user.id)}"
          ${me ? 'disabled' : ''}>${user.disabled ? 'включить' : 'отключить'}</button>
        <button class="btn danger" data-act="delete" data-id="${esc(user.id)}"
          ${me || (user.role === 'admin' && adminCount <= 1) ? 'disabled' : ''}>удалить</button>
      </div></td>
    </tr>`;
  }).join('') || '<tr><td colspan="9" class="muted">пользователей нет</td></tr>';

  const origin = location.origin;
  $('#fever-info').innerHTML = `Клиенты (Reeder, Fiery Feeds, Unread и другие) подключаются к <code>${esc(origin)}/fever/</code>.
    Ключ API у каждого свой — он указан в таблице выше; при смене пароля ключ меняется.<br><br>` +
    users.map((user) => `• <b>${esc(user.login)}</b> — ключ <code>${esc(user.apiKey ?? '')}</code>`).join('<br>');
}

async function load() {
  try {
    const payload = await api('/api/admin/users');
    currentUser = payload.me;
    users = payload.users;
    $('#login-box').hidden = true;
    $('#panel').hidden = false;
    $('#logout').hidden = false;
    $('#who').textContent = `вы вошли как ${payload.me.login}`;
    renderUsers();
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      $('#login-box').hidden = false;
      $('#panel').hidden = true;
      $('#logout').hidden = true;
      $('#who').textContent = '';
      message($('#login-msg'), err.status === 403 ? 'Нужны права администратора: войдите под администратором.' : '');
      return;
    }
    message($('#users-msg'), err.message, 'err');
  }
}

async function act(action, id) {
  const user = users.find((u) => u.id === id);
  if (!user) return;
  const body = { id, action };
  try {
    if (action === 'password') {
      const value = prompt(`Новый пароль для «${user.login}» (не короче 4 символов):`);
      if (!value) return;
      body.password = value;
    } else if (action === 'rename') {
      const value = prompt(`Новый логин вместо «${user.login}»:`, user.login);
      if (!value || value === user.login) return;
      body.login = value;
    } else if (action === 'role') {
      body.role = user.role === 'admin' ? 'user' : 'admin';
    } else if (action === 'delete') {
      if (!confirm(`Удалить пользователя «${user.login}»?`)) return;
      body.purge = confirm('Удалить вместе с его подписками и статьями? OK — удалить данные, Отмена — оставить папку на диске.');
    }
    const payload = await api('/api/admin/user', body);
    message($('#users-msg'), action === 'delete' ? `пользователь «${user.login}» удалён${body.purge ? ' вместе с данными' : ''}`
      : `готово: ${user.login}${payload.note ? ` — ${payload.note}` : ''}`, 'ok');
    await load();
  } catch (err) {
    message($('#users-msg'), err.message, 'err');
  }
}

$('#users').addEventListener('click', (event) => {
  const button = event.target.closest('[data-act]');
  if (button && !button.disabled) act(button.dataset.act, button.dataset.id);
});

$('#create-btn').addEventListener('click', async () => {
  const login = $('#new-login').value.trim();
  const password = $('#new-pass').value;
  if (!login || !password) { message($('#create-msg'), 'нужны логин и пароль', 'err'); return; }
  $('#create-btn').disabled = true;
  try {
    await api('/api/admin/users', { login, password, role: $('#new-role').value });
    message($('#create-msg'), `пользователь «${login}» создан`, 'ok');
    $('#new-login').value = '';
    $('#new-pass').value = '';
    await load();
  } catch (err) {
    message($('#create-msg'), err.message, 'err');
  } finally {
    $('#create-btn').disabled = false;
  }
});

$('#login-btn').addEventListener('click', async () => {
  try {
    await api('/api/login', {
      login: $('#login-name').value.trim(),
      password: $('#login-pass').value,
      remember: $('#login-remember').checked,
    });
    $('#login-pass').value = '';
    message($('#login-msg'), '');
    await load();
  } catch (err) {
    message($('#login-msg'), err.message, 'err');
  }
});
$('#login-pass').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#login-btn').click(); });
$('#new-pass').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#create-btn').click(); });

$('#logout').addEventListener('click', async () => {
  await api('/api/logout', {}).catch(() => {});
  await load();
});

// ---------------------------------------------------------------- оформление

const savedTheme = localStorage.getItem('rss.admin.theme');
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
$('#theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('rss.admin.theme', next);
});

load();
