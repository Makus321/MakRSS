#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# MAK RSS Reader — установка на сервер (Ubuntu/Debian).
#
# Ставит всё, что нужно, и настраивает доступ по https:
#   1. Node.js (официальная сборка в /opt, без apt-репозиториев);
#   2. системного пользователя и каталоги данных;
#   3. саму читалку в /opt/rss-reader и службу systemd на 127.0.0.1;
#   4. маршруты в HAProxy (если он есть): домен по http -> читалка,
#      домен по https (SNI) -> читалка со своим сертификатом;
#   5. сертификат Let's Encrypt через certbot (проверка домена отдаёт сама читалка);
#   6. задание cron для продления сертификата.
#
# Запуск (из каталога rss-reader):
#   sudo ./deploy/install-vps.sh
#   sudo DOMAIN=rss.example.com EMAIL=me@example.com ./deploy/install-vps.sh
#
# Повторный запуск безопасен: код обновляется, данные, сертификат и настройки
# HAProxy не трогаются. Отдельные шаги можно выключить:
#   WITH_HAPROXY=no  SKIP_NODE=yes  SKIP_CERT=yes
# ---------------------------------------------------------------------------
set -euo pipefail

DOMAIN="${DOMAIN:-rss.letsplay.today}"
EMAIL="${EMAIL:-}"                                  # пусто — регистрация без почты
APP_DIR="${APP_DIR:-/opt/rss-reader}"
DATA_DIR="${DATA_DIR:-/var/lib/rss-reader}"
TLS_DIR="${TLS_DIR:-/etc/rss-reader/tls}"
APP_USER="${APP_USER:-rss}"
HTTP_PORT="${HTTP_PORT:-8787}"
HTTPS_PORT="${HTTPS_PORT:-8788}"
ACME_DIR="${ACME_DIR:-/var/www/acme}"
NODE_VERSION="${NODE_VERSION:-22.11.0}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-admin}"
WITH_HAPROXY="${WITH_HAPROXY:-auto}"
SKIP_NODE="${SKIP_NODE:-no}"
SKIP_CERT="${SKIP_CERT:-no}"
ENV_FILE=/etc/rss-reader.env
UNIT_FILE=/etc/systemd/system/rss-reader.service
TLS_HOOK=/usr/local/bin/rss-reader-tls.sh
CRON_FILE=/etc/cron.d/rss-reader-cert
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die() { printf '\n\033[1;31mОшибка: %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "нужны права root: sudo $0"
[[ -f "$SRC_DIR/server.mjs" ]] || die "не нахожу server.mjs — запускайте скрипт из каталога rss-reader"
command -v systemctl >/dev/null || die "нужен systemd"
command -v curl >/dev/null || { say "ставлю curl"; apt-get update -qq && apt-get install -y -qq curl; }

# --------------------------------------------------------------- 1. Node.js
install_node() {
  local major=0
  if command -v node >/dev/null 2>&1; then
    major="$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  fi
  if [[ "$major" -ge 18 && "$SKIP_NODE" != yes ]]; then
    note "Node.js уже есть: $(node -v) — оставляю как есть"
    return
  fi
  say "ставлю Node.js ${NODE_VERSION} (официальная сборка)"
  local arch node_arch
  arch="$(dpkg --print-architecture)"
  case "$arch" in
    amd64) node_arch=x64 ;;
    arm64) node_arch=arm64 ;;
    *) die "неизвестная архитектура: $arch (нужна amd64 или arm64)" ;;
  esac
  command -v xz >/dev/null || { apt-get update -qq && apt-get install -y -qq xz-utils; }
  local tarball="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"
  local url="https://nodejs.org/dist/v${NODE_VERSION}/${tarball}"
  note "качаю $url"
  curl -fsSL "$url" -o "/tmp/${tarball}" || die "не удалось скачать Node.js"
  tar -xJf "/tmp/${tarball}" -C /opt
  rm -f "/tmp/${tarball}"
  ln -sfn "/opt/node-v${NODE_VERSION}-linux-${node_arch}/bin/node" /usr/local/bin/node
  note "готово: $(/usr/local/bin/node -v)"
}

# ----------------------------------------------------- 2. пользователь и каталоги
create_user() {
  say "готовлю пользователя и каталоги"
  id -u "$APP_USER" >/dev/null 2>&1 || {
    useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
    note "создан системный пользователь $APP_USER"
  }
  install -d -m 750 -o "$APP_USER" -g "$APP_USER" "$DATA_DIR"
  install -d -m 755 "$ACME_DIR"
  install -d -m 750 -o root -g "$APP_USER" "$TLS_DIR"
  note "данные: $DATA_DIR, проверки Let's Encrypt: $ACME_DIR"
}

# ------------------------------------------------------------- 3. сама читалка
install_app() {
  say "копирую читалку в $APP_DIR"
  install -d -m 755 "$APP_DIR"
  for item in server.mjs reader-core.mjs lib public deploy README.md; do
    [[ -e "$SRC_DIR/$item" ]] || continue
    cp -a "$SRC_DIR/$item" "$APP_DIR/"
  done
  chown -R root:root "$APP_DIR"
  chmod -R go-w "$APP_DIR"
  note "файлов: $(find "$APP_DIR" -type f | wc -l)"
}

# ----------------------------------------------------------- 4. настройки и служба
write_env() {
  if [[ -f "$ENV_FILE" ]]; then
    note "$ENV_FILE уже есть — оставляю (пароль администратора не меняю)"
    return
  fi
  say "пишу $ENV_FILE"
  cat > "$ENV_FILE" <<EOF
# MAK RSS Reader. Служба rss-reader читает этот файл при запуске.
PORT=$HTTP_PORT
HOST=127.0.0.1
DATA_DIR=$DATA_DIR

# HTTPS: читалка сама держит сертификат (HAProxy пропускает TLS по SNI).
HTTPS_PORT=$HTTPS_PORT
# Порт, который видит посетитель снаружи (за HAProxy это 443) — нужен для
# перенаправления с http на https.
HTTPS_PUBLIC_PORT=${HTTPS_PUBLIC_PORT:-443}
TLS_CERT=$TLS_DIR/fullchain.pem
TLS_KEY=$TLS_DIR/privkey.pem
# Каталог, из которого отдаётся проверка владения доменом для Let's Encrypt.
ACME_DIR=$ACME_DIR

# Первый администратор создаётся при первом запуске — смените пароль в /admin.
ADMIN_USER=$ADMIN_USER
ADMIN_PASS=$ADMIN_PASS

REFRESH_MINUTES=5
FETCH_FULL=1
MAX_UNREAD_PER_FEED=1500
KEEP_READ_DAYS=30
EOF
  chmod 600 "$ENV_FILE"
}

write_unit() {
  say "ставлю службу systemd"
  sed -e "s|__APP_DIR__|$APP_DIR|g" \
      -e "s|__DATA_DIR__|$DATA_DIR|g" \
      -e "s|__APP_USER__|$APP_USER|g" \
      -e "s|__NODE__|/usr/local/bin/node|g" \
      "$SRC_DIR/deploy/rss-reader.service" > "$UNIT_FILE"
  chmod 644 "$UNIT_FILE"
  systemctl daemon-reload
}

write_tls_hook() {
  say "ставлю обработчик сертификата (копирует его читалке и перезапускает службу)"
  cat > "$TLS_HOOK" <<EOF
#!/bin/sh
# Кладём свежий сертификат туда, где его читает служба rss-reader.
set -e
install -d -m 750 -o root -g $APP_USER $TLS_DIR
install -m 640 -o root -g $APP_USER /etc/letsencrypt/live/$DOMAIN/fullchain.pem $TLS_DIR/fullchain.pem
install -m 640 -o root -g $APP_USER /etc/letsencrypt/live/$DOMAIN/privkey.pem $TLS_DIR/privkey.pem
systemctl restart rss-reader || true
EOF
  chmod 755 "$TLS_HOOK"
}

# --------------------------------------------------------------- 5. HAProxy
setup_haproxy() {
  local cfg=/etc/haproxy/haproxy.cfg
  if [[ "$WITH_HAPROXY" == no ]]; then
    note "HAProxy пропускаем (WITH_HAPROXY=no)"
    return
  fi
  if [[ ! -f "$cfg" ]]; then
    note "HAProxy не найден — настройте прокси на 127.0.0.1:$HTTP_PORT и :$HTTPS_PORT вручную"
    return
  fi
  if grep -q "rss_reader_tls" "$cfg"; then
    note "HAProxy уже настроен на этот домен — правок не делаю"
    return
  fi
  say "добавляю маршруты в HAProxy ($DOMAIN)"
  cp -a "$cfg" "$cfg.bak.$(date +%Y%m%d-%H%M%S)"
  note "копия конфига: $cfg.bak.*"
  awk -v dom="$DOMAIN" '
    /bind :80/ && !http_done { print; print "  use_backend rss_reader_http if { req.hdr(host) -i " dom " }"; http_done=1; next }
    /req_ssl_hello_type/ && !tls_done { print; print "    use_backend rss_reader_tls if { req.ssl_sni -i " dom " }"; tls_done=1; next }
    { print }
  ' "$cfg" > "$cfg.new"
  cat >> "$cfg.new" <<EOF

# --- MAK RSS Reader (добавлено deploy/install-vps.sh) ---
backend rss_reader_http
  mode http
  server srv 127.0.0.1:$HTTP_PORT
backend rss_reader_tls
  mode tcp
  server srv 127.0.0.1:$HTTPS_PORT
EOF
  if haproxy -c -f "$cfg.new" >/dev/null 2>&1; then
    mv "$cfg.new" "$cfg"
    systemctl reload haproxy
    note "конфиг проверен и применён"
  else
    rm -f "$cfg.new"
    die "HAProxy не принял новый конфиг — старый файл не тронут (haproxy -c -f $cfg)"
  fi
}

# ---------------------------------------------------------------- 6. сертификат
issue_cert() {
  if [[ "$SKIP_CERT" == yes ]]; then
    note "сертификат пропускаем (SKIP_CERT=yes)"
    return
  fi
  if [[ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]]; then
    note "сертификат для $DOMAIN уже есть — обновляю через deploy-hook"
    "$TLS_HOOK"
    return
  fi
  say "получаю сертификат Let's Encrypt для $DOMAIN"
  command -v certbot >/dev/null || {
    apt-get update -qq
    apt-get install -y -qq certbot
  }
  local mail_args
  if [[ -n "$EMAIL" ]]; then mail_args=(--email "$EMAIL"); else mail_args=(--register-unsafely-without-email); fi
  certbot certonly --webroot -w "$ACME_DIR" -d "$DOMAIN" \
    --non-interactive --agree-tos "${mail_args[@]}" \
    --deploy-hook "$TLS_HOOK" \
    --rsa-key-size 2048
  "$TLS_HOOK"
}

setup_cron() {
  say "ставлю задание cron для продления сертификата"
  cat > "$CRON_FILE" <<EOF
# Продление сертификата Let's Encrypt для читалки ($DOMAIN).
# certbot renew сам решает, нужно ли продление; после успеха срабатывает
# deploy-hook из /etc/letsencrypt/renewal/$DOMAIN.conf — он кладёт сертификат
# читалке и перезапускает службу.
23 3,15 * * * root certbot renew --quiet --deploy-hook $TLS_HOOK
EOF
  chmod 644 "$CRON_FILE"
  note "задание: $CRON_FILE (дважды в день)"
}

# ------------------------------------------------------------------ 7. запуск
start_service() {
  say "запускаю службу"
  systemctl enable rss-reader >/dev/null 2>&1 || true
  systemctl restart rss-reader
  local i
  for i in $(seq 1 20); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$HTTP_PORT/api/session"; then
      note "служба отвечает на 127.0.0.1:$HTTP_PORT"
      return
    fi
    sleep 1
  done
  journalctl -u rss-reader -n 30 --no-pager || true
  die "служба не отвечает — смотрите вывод выше"
}

verify() {
  say "проверяю доступ снаружи"
  local code_http code_https
  code_http="$(curl -s -o /dev/null -w '%{http_code}' "http://$DOMAIN/" || echo 000)"
  note "http://$DOMAIN/ → $code_http (ожидается 301)"
  if [[ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]]; then
    code_https="$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/" || echo 000)"
    note "https://$DOMAIN/ → $code_https (ожидается 200)"
  else
    note "https пока без сертификата"
  fi
}

install_node
create_user
install_app
write_env
write_unit
write_tls_hook
setup_haproxy
start_service
issue_cert
setup_cron
verify

cat <<EOF

Готово.

  Читалка:   https://$DOMAIN/
  Админка:   https://$DOMAIN/admin
  Логин:     $ADMIN_USER   (пароль по умолчанию $ADMIN_PASS — смените в админке)
  Служба:    systemctl status rss-reader
  Логи:      journalctl -u rss-reader -f
  Данные:    $DATA_DIR
  Обновить:  sudo $SRC_DIR/deploy/install-vps.sh

Сертификат продлевается автоматически ($CRON_FILE). Проверить вручную:
  certbot renew --dry-run
EOF
