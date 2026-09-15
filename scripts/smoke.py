#!/usr/bin/env python3
"""Behavioral integration checks against the local control plane; cleans only its own rows."""
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import uuid
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parent.parent
config = dict(line.split('=', 1) for line in (ROOT / '.env').read_text().splitlines() if line and not line.startswith('#'))
BASE = 'http://127.0.0.1:4311/api'
OWNER = config['PC_ADMIN_TOKEN']
prefix = f'smoke-{uuid.uuid4().hex[:12]}'
project = None
machine = None
token_ids = []

def request(path, data=None, credential=OWNER, expected=200, origin=None, method=None, cookie=None):
    headers = {'Content-Type': 'application/json'}
    if credential:
        headers['Authorization'] = f'Bearer {credential}'
    if cookie:
        headers['Cookie'] = cookie
    if origin:
        headers['Origin'] = origin
    req = urllib.request.Request(BASE + path, headers=headers, data=json.dumps(data).encode() if data is not None else None, method=method)
    try:
        response = urllib.request.urlopen(req, timeout=10)
        status, body = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, body = error.code, error.read()
    assert status == expected, f'{path}: expected {expected}, got {status}: {body}'
    return json.loads(body)

def sql(query):
    return subprocess.run(['docker','compose','exec','-T','postgres','psql','-U','personal_cloud','-d','personal_cloud','-v','ON_ERROR_STOP=1','-At','-c',query], cwd=ROOT, check=True, capture_output=True, text=True).stdout.strip()

def enrollment():
    item = request('/enrollment-tokens', {'location':'home','roles':['compute','builder'],'tags':['smoke']})
    token_ids.append(item['id'])
    return item

try:
    req=urllib.request.Request(BASE+'/session',headers={'Content-Type':'application/json'},data=json.dumps({'token':OWNER}).encode())
    with urllib.request.urlopen(req,timeout=10) as response:
        cookie=response.headers['Set-Cookie'].split(';')[0]
        assert 'HttpOnly' in response.headers['Set-Cookie'] and 'SameSite=Strict' in response.headers['Set-Cookie']
        assert OWNER not in cookie
    request('/snapshot',credential=None,cookie=cookie)
    request('/session',credential=None,cookie=cookie,method='DELETE')
    request('/snapshot',credential=None,cookie=cookie,expected=401)
    request('/snapshot', credential=None, expected=401)
    request('/snapshot', credential='invalid', expected=401)
    request('/snapshot', origin='https://untrusted.example', expected=403)
    request('/projects', {'name':'Invalid','repository':'https://gitlab.com/a/b'}, expected=400)
    p=request('/projects', {'name':prefix,'repository':'example/smoke','branch':'main'}, expected=201)
    project=p['id']
    request(f'/projects/{project}/services', {'name':prefix,'port':3000,'placement':{'kind':'automatic'}}, expected=201)
    request(f'/projects/{project}/services', {'name':prefix,'port':3000,'placement':{'kind':'automatic'}}, expected=409)
    request(f'/projects/{project}/services', {'name':'bad-port','port':0,'placement':{'kind':'automatic'}}, expected=400)
    expired=enrollment()
    sql(f"UPDATE enrollment_tokens SET expires_at=now()-interval '1 second' WHERE id='{expired['id']}'")
    report={'hostname':prefix,'os':'Linux','architecture':'amd64','cpu_cores':4,'cpu_percent':12.5,'memory_total':8000000000,'memory_used':2000000000,'disk_total':100000000000,'disk_used':10000000000,'docker':True,'nomad':True}
    request('/agent/enroll', {'token':expired['token'],'report':report}, credential=None, expected=401)
    fresh=enrollment()
    # Two simultaneous claims must create exactly one identity.
    def claim():
        req=urllib.request.Request(BASE+'/agent/enroll',headers={'Content-Type':'application/json'},data=json.dumps({'token':fresh['token'],'report':report}).encode())
        try:
            with urllib.request.urlopen(req,timeout=10) as res: return res.status,json.load(res)
        except urllib.error.HTTPError as e: return e.code,json.load(e)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        claims=list(pool.map(lambda _:claim(),range(2)))
    assert sorted(status for status,_ in claims)==[201,401],claims
    identity=next(body for status,body in claims if status==201)
    machine=identity['id']
    request('/snapshot',credential=identity['credential'],expected=401)
    request(f'/agent/{machine}/heartbeat',report,credential=OWNER,expected=401)
    request(f'/agent/{machine}/heartbeat',report,credential=identity['credential'])
    snapshot=request('/snapshot')
    row=next(m for m in snapshot['machines'] if m['id']==machine)
    assert row['status']=='online' and row['roles']==['compute','builder']
    assert 'credential' not in json.dumps(snapshot) and OWNER not in json.dumps(snapshot)
    sql(f"UPDATE machines SET last_seen=now()-interval '46 seconds' WHERE id='{machine}'")
    assert next(m for m in request('/snapshot')['machines'] if m['id']==machine)['status']=='offline'
    report['nomad']=False
    request(f'/agent/{machine}/heartbeat',report,credential=identity['credential'])
    assert next(m for m in request('/snapshot')['machines'] if m['id']==machine)['status']=='degraded'
    report['cpu_percent']=150
    request(f'/agent/{machine}/heartbeat',report,credential=identity['credential'],expected=400)
    assert any(p['id']==project for p in request('/snapshot')['projects'])
    assert sql(f"SELECT count(*) FROM projects WHERE id='{project}'")=='1'
    print('PASS: session creation/revocation, owner authentication, origin isolation, persisted projects/services, duplicate handling, single-use enrollment race, expiry, credential isolation, health transitions, metrics validation, and secret redaction.')
finally:
    if machine: sql(f"DELETE FROM machines WHERE id='{machine}'")
    if project: sql(f"DELETE FROM projects WHERE id='{project}'")
    for item in token_ids: sql(f"DELETE FROM enrollment_tokens WHERE id='{item}'")
    sql(f"DELETE FROM events WHERE message LIKE '{prefix}%'")
