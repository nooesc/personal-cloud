#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 - <<'PY'
import socket
for port in (4310,4311):
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try: sock.bind(('127.0.0.1',port))
        except OSError: raise SystemExit(f'Port {port} is in use. Stop the existing dinghy process before starting another.')
PY
python3 scripts/setup-env.py
if [ ! -d node_modules ]; then pnpm install --frozen-lockfile; fi
docker compose up -d --wait postgres
cargo build --workspace
api_pid=''
web_pid=''
cleanup() {
  if [ -n "$api_pid" ]; then kill "$api_pid" 2>/dev/null || true; wait "$api_pid" 2>/dev/null || true; fi
  if [ -n "$web_pid" ]; then kill "$web_pid" 2>/dev/null || true; wait "$web_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 0' INT TERM
./target/debug/personal-cloud-api &
api_pid=$!
(cd apps/web && exec node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4310 --strictPort) &
web_pid=$!
printf '\ndinghy: http://127.0.0.1:4310\nOwner token: PC_ADMIN_TOKEN in .env\nPostgres data persists after stopping.\n\n'
# Both children are the servers themselves, so cleanup also works after API failure.
while kill -0 "$api_pid" 2>/dev/null && kill -0 "$web_pid" 2>/dev/null; do sleep 1; done
printf '\nA server exited. Stopping the companion process.\n' >&2
exit 1
