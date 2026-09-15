#!/usr/bin/env python3
"""Power-loss acceptance for an owned disposable fleet created by runtime-smoke.py."""
import argparse,json,time,subprocess,urllib.request,urllib.error
from pathlib import Path
root=Path(__file__).resolve().parent.parent;parser=argparse.ArgumentParser();parser.add_argument('harness');args=parser.parse_args();harness=args.harness;state=json.loads((root/'work'/f'{harness}-acceptance.json').read_text());c=dict(l.split('=',1) for l in Path('.env').read_text().splitlines() if l and not l.startswith('#'));base='http://127.0.0.1:4311/api';nomad=dict(l.split('=',1) for l in (root/'work'/f'{harness}.env').read_text().splitlines() if l)['NOMAD_ADDR'];mid2='00000000-0000-4000-8000-000000000002'
def api(path,data=None,method=None):
 r=urllib.request.Request(base+path,data=json.dumps(data).encode() if data is not None else None,method=method,headers={'Authorization':'Bearer '+c['PC_ADMIN_TOKEN'],'Content-Type':'application/json'})
 try:return json.load(urllib.request.urlopen(r,timeout=90))
 except urllib.error.HTTPError as e:raise AssertionError(e.read().decode())
def nom(path,data=None):return json.load(urllib.request.urlopen(urllib.request.Request(nomad+path,data=json.dumps(data).encode() if data is not None else None,headers={'Content-Type':'application/json'})))
def sql(q):return subprocess.check_output(['docker','compose','exec','-T','postgres','psql','-U','personal_cloud','-d','personal_cloud','-At','-v','ON_ERROR_STOP=1','-c',q],text=True).strip()
def service():return next(s for s in api('/snapshot')['services'] if s['id']==state['service'])
def wait_deploy(id):
 for _ in range(150):
  d=api('/deployments/'+id)
  if d['status']=='healthy':return d
  assert d['status']!='failed',d.get('error')
  time.sleep(2)
 raise AssertionError('Deployment timed out')
# Put one automatic stateless service onto the second physical-node simulation.
node1=next(n for n in nom('/v1/nodes') if n['Name']!='pc-fleet-second')['ID']
nom('/v1/node/'+node1+'/eligibility',{'NodeID':node1,'Eligibility':'ineligible'})
try:
 dep=api('/services/'+state['service']+'/deploy',{'image':service()['image_digest']})['id'];d=wait_deploy(dep);assert service()['machine_id']==mid2
finally:nom('/v1/node/'+node1+'/eligibility',{'NodeID':node1,'Eligibility':'eligible'})
print('PASS automatic stateless release starts on second node',flush=True)
# Real pinned PostgreSQL co-located on the node that will fail.
sql("UPDATE machines SET last_seen=now() WHERE id='"+mid2+"'")
db=api('/databases',{'project_id':state['project'],'name':'failure-drill','machine_id':mid2})['id'];state['databases'].append(db);(root/'work'/f'{harness}-acceptance.json').write_text(json.dumps(state,indent=2))
for _ in range(150):
 row=next(d for d in api('/snapshot')['databases'] if d['id']==db)
 if row['status']=='healthy':break
 assert row['status']!='failed',row.get('error');time.sleep(2)
assert row['status']=='healthy'
print('PASS PostgreSQL healthy on explicitly selected second node',flush=True)
started=time.monotonic();subprocess.run(['bash','scripts/fleet-test-node.sh',harness,'stop'],check=True)
try:
 for _ in range(120):
  s=service()
  if s['status']=='healthy' and s.get('machine_id')!=mid2:break
  time.sleep(2)
 assert s['status']=='healthy' and s.get('machine_id')!=mid2,s
 response=subprocess.check_output(['docker','exec',harness,'curl','-fsS',s['address']],text=True)
 assert 'Welcome to FastAPI' in response
 print('PASS actual node loss reschedules stateless service; HTTP recovered in',round(time.monotonic()-started,1),'seconds',flush=True)
 row=next(d for d in api('/snapshot')['databases'] if d['id']==db)
 assert row['machine_id']==mid2 and row['status']!='healthy',row
 allocs=nom('/v1/job/'+row['job_id']+'/allocations')
 node2=next(n for n in nom('/v1/nodes') if n['Name']=='pc-fleet-second')['ID']
 assert all(a['NodeID']==node2 for a in allocs)
 print('PASS PostgreSQL stays assigned to failed node, no relocation',flush=True)
finally:subprocess.run(['bash','scripts/fleet-test-node.sh',harness,'start'],check=True)
# Explicit retry keeps the same named volume and node; removal leaves the data recoverable.
for _ in range(90):
 n=next(n for n in nom('/v1/nodes') if n['Name']=='pc-fleet-second')
 if n['Status']=='ready':break
 time.sleep(2)
sql("UPDATE machines SET last_seen=now() WHERE id='"+mid2+"'")
api('/databases/'+db+'/retry',{})
for _ in range(150):
 row=next(d for d in api('/snapshot')['databases'] if d['id']==db)
 if row['status']=='healthy':break
 assert row['status']!='failed',row.get('error');time.sleep(2)
assert row['status']=='healthy' and row['machine_id']==mid2
print('PASS recovered node restores PostgreSQL on original volume',flush=True)
api('/databases/'+db,method='DELETE');state['databases'].remove(db);(root/'work'/f'{harness}-acceptance.json').write_text(json.dumps(state,indent=2))
