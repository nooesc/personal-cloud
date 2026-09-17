#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v docker >/dev/null || { echo 'Docker with Compose is required.' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'Python 3 is required to initialize durable credentials.' >&2; exit 1; }
env_file="${PC_ENV_FILE:-.env.production}"
python3 - "$env_file" <<'PY'
import os, pathlib, secrets, sys
path=pathlib.Path(sys.argv[1])
if not path.exists():
    port=os.environ.get('PC_PORT','4310')
    origin=os.environ.get('PC_PUBLIC_URL',f'http://127.0.0.1:{port}').rstrip('/')
    if not origin.startswith(('http://','https://')) or any(c.isspace() for c in origin):
        raise SystemExit('PC_PUBLIC_URL must be an HTTP(S) origin.')
    lines=['# Durable production credentials. Back up securely with your PostgreSQL data.',
        'POSTGRES_PASSWORD='+secrets.token_hex(24),
        'PC_ADMIN_TOKEN='+secrets.token_hex(32),
        'PC_SECRET_KEY='+secrets.token_hex(32),
        'PC_PUBLIC_URL='+origin,
        'PC_PORT='+port,
        'PC_VERSION='+os.environ.get('PC_VERSION','latest'),
        'PC_HOST_BIND='+os.environ.get('PC_HOST_BIND','127.0.0.1')]
    path.parent.mkdir(parents=True,exist_ok=True)
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as file:file.write('\n'.join(lines)+'\n')
values=dict(line.split('=',1) for line in path.read_text().splitlines() if '=' in line and not line.lstrip().startswith('#'))
for key in ('POSTGRES_PASSWORD','PC_ADMIN_TOKEN','PC_SECRET_KEY'):
    if len(values.get(key,''))<32:raise SystemExit(f'{key} is missing or too short in {path}; restore or repair that file before starting.')
if len(values['PC_SECRET_KEY'])!=64 or any(c not in '0123456789abcdefABCDEF' for c in values['PC_SECRET_KEY']):
    raise SystemExit('PC_SECRET_KEY must contain exactly 64 hexadecimal characters. Never replace an existing key without migrating encrypted secrets.')
os.chmod(path,0o600)
print(f'Using durable configuration: {path}. Owner sign-in token is PC_ADMIN_TOKEN in that file.')
PY
compose=(docker compose --env-file "$env_file" -f compose.production.yml -p "${PC_COMPOSE_PROJECT:-personal-cloud-production}")
if [ "${PC_BUILD_FROM_SOURCE:-0}" = 1 ]; then
  echo 'Building API and web images from this checkout.'
  "${compose[@]}" build
else
  echo 'Pulling published API and web images (no local compilation).'
  if ! "${compose[@]}" pull; then
    echo 'Image download failed. Check that PC_VERSION names a published, publicly accessible release. To deliberately build this checkout instead, run PC_BUILD_FROM_SOURCE=1 bash scripts/start.sh.' >&2
    exit 1
  fi
fi
"${compose[@]}" up --no-build --pull never --detach --wait "$@"
printf '\ndinghy is running. Open PC_PUBLIC_URL from %s.\nBack up this file together with your PostgreSQL database; encrypted credentials require the original PC_SECRET_KEY.\n' "$env_file"
