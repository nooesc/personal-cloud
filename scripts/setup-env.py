#!/usr/bin/env python3
"""Generate local-only credentials once. Never print secrets."""
import os
from pathlib import Path
import secrets
path = Path(__file__).resolve().parent.parent / '.env'
if not path.exists():
    password = secrets.token_hex(24)
    contents = f'''POSTGRES_PASSWORD={password}
DATABASE_URL=postgres://personal_cloud:{password}@127.0.0.1:55438/personal_cloud
PC_ADMIN_TOKEN={secrets.token_hex(32)}
PC_BIND=127.0.0.1:4311
PC_WEB_ORIGIN=http://127.0.0.1:4310
'''
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as file:
        file.write(contents)
    print('Local credentials generated in .env (mode 0600).')
else:
    print('Using existing .env.')
