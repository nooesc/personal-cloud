#!/usr/bin/env python3
"""Run database concurrency/recovery regressions without printing connection secrets."""
import os,subprocess
from pathlib import Path
root=Path(__file__).resolve().parent.parent
config=dict(l.split('=',1) for l in (root/'.env').read_text().splitlines() if l and not l.startswith('#'))
env=dict(os.environ,PC_TEST_DATABASE_URL=config['DATABASE_URL'])
for suite in ['runtime::lifecycle_tests','integrations::tests::postgres','networking::tests::','github_app::tests::postgres']:
 subprocess.run(['cargo','test','-p','personal-cloud-api',suite,'--','--ignored'],cwd=root,env=env,check=True)
