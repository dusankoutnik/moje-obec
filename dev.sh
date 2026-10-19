#!/bin/bash
# Spuštění Node/npm příkazů v kontejneru s Node 22 (na hostiteli nemusí Node 22 být).
# Použití: ./dev.sh npm install   |   ./dev.sh npm test   |   ./dev.sh npx tsc --noEmit
# Soubory vznikají pod vaším uid (ne root). Síť `platforma_test` se používá pro testovací Postgres.
set -euo pipefail
cd "$(dirname "$0")"
NET="${DEV_NET:-}"
ARGS=(--rm -v "$PWD":/app -w /app -u "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_cache=/tmp/.npm)
[ -t 0 ] && ARGS+=(-it)
[ -n "$NET" ] && ARGS+=(--network "$NET")
[ -n "${DATABASE_URL:-}" ] && ARGS+=(-e DATABASE_URL="$DATABASE_URL")
[ -n "${TEST_DATABASE_URL:-}" ] && ARGS+=(-e TEST_DATABASE_URL="$TEST_DATABASE_URL")
exec docker run "${ARGS[@]}" node:22-bookworm-slim "$@"
