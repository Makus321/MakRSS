#!/usr/bin/env bash
# Ручной запуск читалки без systemd (Linux/macOS):
#   ./start.sh                 # http://127.0.0.1:8787
#   PORT=9000 ./start.sh       # другой порт
#   DATA_DIR=/srv/rss ./start.sh
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js не найден (нужен 18+)"; exit 1; }
echo "RSS reader: http://${HOST:-127.0.0.1}:${PORT:-8787}   (Ctrl+C — остановить)"
exec node server.mjs "$@"
