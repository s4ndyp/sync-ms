#!/bin/sh
set -e

PB=/usr/local/bin/pocketbase
PB_PID=""
COL_PID=""

cleanup() {
  if [ -n "$COL_PID" ]; then
    kill "$COL_PID" 2>/dev/null || true
  fi
  if [ -n "$PB_PID" ]; then
    kill "$PB_PID" 2>/dev/null || true
    wait "$PB_PID" 2>/dev/null || true
  fi
}
trap cleanup INT TERM

"$PB" migrate up \
  --dir="/app/pb_data" \
  --migrationsDir="/app/pb_migrations" \
  --hooksDir="/app/pb_hooks"

"$PB" serve \
  --http="0.0.0.0:8090" \
  --dir="/app/pb_data" \
  --publicDir="/app/pb_public" \
  --migrationsDir="/app/pb_migrations" \
  --hooksDir="/app/pb_hooks" \
  --automigrate=false &
PB_PID=$!

i=0
while [ "$i" -lt 90 ]; do
  if curl -sf "http://127.0.0.1:8090/api/health" >/dev/null; then
    break
  fi
  i=$((i + 1))
  sleep 1
done

/usr/local/bin/syncms-collector &
COL_PID=$!

wait "$COL_PID"
cleanup
