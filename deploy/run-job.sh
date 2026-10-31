#!/usr/bin/env bash
# Llama a una rutina de la API desde el propio VPS, con la clave CRON_SECRET de .env.production (así la clave no queda escrita en el crontab).
# Uso:  deploy/run-job.sh /jobs/utec/refresh            (POST por defecto)
#       deploy/run-job.sh "/jobs/email-summary?kind=weekly"
set -euo pipefail
cd "$(dirname "$0")/.."
SECRET="$(grep '^CRON_SECRET=' .env.production | cut -d= -f2-)"
[ -n "$SECRET" ] || { echo "Falta CRON_SECRET en .env.production" >&2; exit 1; }
echo "$(date -u +%FT%TZ) $1"
curl -fsS -m 600 -X "${2:-POST}" -H "Authorization: Bearer ${SECRET}" "http://127.0.0.1:4000${1}"
echo
