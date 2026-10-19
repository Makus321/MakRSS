#!/usr/bin/env bash
# Установка читалки на Ubuntu/Debian: пользователь, каталоги, systemd-юнит.
#
#   sudo ./deploy/install.sh                 # обычная установка
#   sudo APP_DIR=/opt/rss DATA_DIR=/srv/rss ./deploy/install.sh
#   sudo ADMIN_USER=roman ADMIN_PASS=secret PORT=8080 ./deploy/install.sh
#
# Скрипт идемпотентен: повторный запуск обновляет код и перезапускает сервис,
# данные (/var/lib/rss-reader) при этом не трогаются.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/rss-reader}"
DATA_DIR="${DATA_DIR:-/var/lib/rss-reader}"
APP_USER="${APP_USER:-rss}"
PORT="${PORT:-8787}"
HOST="${HOST:-127.0.0.1}"
ADMIN_USER="${ADMIN_USER:-rss}"
ENV_FILE=/etc/rss-reader.env
UNIT_FILE=/etc/systemd/system/rss-reader.service

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m!!\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Запускать нужно от root: sudo $0"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  cat >&2 <<'EOF'
Node.js не найден. Установите его, например так (Ubuntu 22.04/24.04):

  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs

и запустите установку снова.
EOF
  exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 18 ]] || die "Нужен Node.js 18 или новее (сейчас $("$NODE_BIN" -v))"
say "Node.js $("$NODE_BIN" -v) — $NODE_BIN"

if ! id -u "$APP_USER" >/dev/null 2>&1; then
  say "создаю системного пользователя $APP_USER"
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi

say "каталоги: $APP_DIR (код), $DATA_DIR (данные)"
mkdir -p "$APP_DIR" "$DATA_DIR"

say "копирую код"
install -m 0644 "$SRC_DIR/server.mjs" "$APP_DIR/server.mjs"
install -m 0644 "$SRC_DIR/README.md" "$APP_DIR/README.md"
rm -rf "$APP_DIR/lib" "$APP_DIR/public"
mkdir -p "$APP_DIR/lib" "$APP_DIR/public"
install -m 0644 "$SRC_DIR"/lib/*.mjs "$APP_DIR/lib/"
install -m 0644 "$SRC_DIR"/public/* "$APP_DIR/public/"
chown -R root:root "$APP_DIR"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

if [[ -f "$ENV_FILE" ]]; then
  say "конфиг $ENV_FILE уже есть — оставляю (пароль администратора не меняю)"
  # shellcheck disable=SC1090
  ADMIN_USER="$(grep -E '^ADMIN_USER=' "$ENV_FILE" | cut -d= -f2- || echo "$ADMIN_USER")"
  ADMIN_PASS="$(grep -E '^ADMIN_PASS=' "$ENV_FILE" | cut -d= -f2- || true)"
else
  ADMIN_PASS="${ADMIN_PASS:-admin}"
  say "пишу $ENV_FILE (администратор $ADMIN_USER, пароль по умолчанию — смените в /admin)"
  cat > "$ENV_FILE" <<EOF
# Настройки MAK RSS Reader (используются systemd-юнитом rss-reader).
# Порт и адрес: наружу отдавайте через nginx, оставив 127.0.0.1.
PORT=$PORT
HOST=$HOST
DATA_DIR=$DATA_DIR
REFRESH_MINUTES=5
# Первый администратор создаётся при старте, если пользователей ещё нет.
# Дальше логины, пароли и ключи Fever заводятся в админке: http://<хост>:$PORT/admin
ADMIN_USER=$ADMIN_USER
ADMIN_PASS=$ADMIN_PASS
# Докачка полного текста статей со страниц: 1 — включена, 0 — выключена.
FETCH_FULL=1
# Сколько непрочитанных статей хранить на ленту (непрочитанное не удаляется).
MAX_UNREAD_PER_FEED=1500
KEEP_READ_DAYS=30
EOF
  chmod 600 "$ENV_FILE"
fi

say "ставлю systemd-юнит"
sed -e "s|__APP_DIR__|$APP_DIR|g" \
    -e "s|__DATA_DIR__|$DATA_DIR|g" \
    -e "s|__APP_USER__|$APP_USER|g" \
    -e "s|__NODE__|$NODE_BIN|g" \
    "$SRC_DIR/deploy/rss-reader.service" > "$UNIT_FILE"
chmod 644 "$UNIT_FILE"

systemctl daemon-reload
systemctl enable rss-reader >/dev/null
systemctl restart rss-reader
sleep 2

if systemctl is-active --quiet rss-reader; then
  say "сервис запущен"
else
  journalctl -u rss-reader -n 30 --no-pager || true
  die "сервис не поднялся — смотрите вывод выше"
fi

for _ in $(seq 1 15); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/"; then break; fi
  sleep 1
done

cat <<EOF

Готово.

  Адрес:      http://127.0.0.1:$PORT   (слушает только localhost)
  Админка:    http://127.0.0.1:$PORT/admin
  Логин:      $ADMIN_USER    (первый администратор)
  Пароль:     ${ADMIN_PASS:-<как в $ENV_FILE>}
  Данные:     $DATA_DIR   (users.json + u/<пользователь>/state.json и content/)
  Логи:       journalctl -u rss-reader -f
  Обновление: sudo $SRC_DIR/deploy/install.sh

Пользователи, их пароли и ключи Fever заводятся в админке (/admin).
Внешние клиенты подключаются к http://<хост>:$PORT/fever/ под своим аккаунтом.

Для доступа снаружи поставьте nginx по образцу deploy/nginx.conf.example
(там же подсказка про TLS) и откройте 80/443, а не $PORT.
EOF
