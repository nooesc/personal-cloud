#!/usr/bin/env python3
"""Real Linux runtime acceptance. Use only an owned fleet-test harness, running dev API.
Creates clearly labelled test records; retains them for browser inspection unless --cleanup.
Never configures an existing fleet or calls Cloudflare. See infra/README.md.
"""
import argparse,json,os,subprocess,time,urllib.request,urllib.error,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser();parser.add_argument('harness');parser.add_argument('--cleanup',action='store_true');args=parser.parse_args()
config=dict(l.split('=',1) for l in (ROOT/'.env').read_text().splitlines() if l and not l.startswith('#'))
manifest=dict(l.split('=',1) for l in (ROOT/'work'/f'{args.harness}.env').read_text().splitlines() if l)
label=subprocess.check_output(['docker','inspect','-f','{{ index .Config.Labels "personal-cloud.disposable-fleet" }}',args.harness],text=True).strip()
# Harness ownership is also checked by every infra lifecycle script.
assert args.harness.startswith('pc-fleet-test-') and label, 'Expected owned Linux test harness'
BASE=os.environ.get('PC_TEST_API','http://127.0.0.1:4311')+'/api'
state_path=ROOT/'work'/f'{args.harness}-acceptance.json'
def api(path,data=None,method=None,expected=(200,201,202)):
 req=urllib.request.Request(BASE+path,data=json.dumps(data).encode() if data is not None else None,method=method,headers={'Authorization':'Bearer '+config['PC_ADMIN_TOKEN'],'Content-Type':'application/json'})
 try:
  with urllib.request.urlopen(req,timeout=90) as r: status,body=r.status,r.read()
 except urllib.error.HTTPError as e:status,body=e.code,e.read()
 assert status in expected, f'{path}: HTTP {status}: {body.decode()}'
 return json.loads(body)
def sql(query):
 return subprocess.check_output(['docker','compose','exec','-T','postgres','psql','-U','personal_cloud','-d','personal_cloud','-At','-v','ON_ERROR_STOP=1','-c',query],cwd=ROOT,text=True).strip()
def observe(deployment,seconds=600):
 deadline=time.monotonic()+seconds;prior=None
 while time.monotonic()<deadline:
  d=api('/deployments/'+deployment)
  if d['step']!=prior:print('deployment',d['step'],flush=True);prior=d['step']
  if d['status'] in ('healthy','failed'):return d
  time.sleep(3)
 raise AssertionError('Deployment deadline exceeded')
def private_get(address):
 return subprocess.check_output(['docker','exec',args.harness,'curl','-fsS',address],text=True)
def service(sid):return next(s for s in api('/snapshot')['services'] if s['id']==sid)
if args.cleanup:
 state=json.loads(state_path.read_text())
 for did in state.get('databases',[]):api('/databases/'+did,method='DELETE')
 api('/projects/'+state['project'],method='DELETE');print('Test project removed; volumes preserved');raise SystemExit
nodes=json.load(urllib.request.urlopen(manifest['NOMAD_ADDR']+'/v1/nodes'))
for stub in nodes:
 n=json.load(urllib.request.urlopen(manifest['NOMAD_ADDR']+'/v1/node/'+stub['ID']));mid=n['Meta']['pc_machine_id'];uuid.UUID(mid)
 report={'hostname':'acceptance-'+n['Name'],'os':'Linux test harness','architecture':n['Attributes']['cpu.arch'],'cpu_cores':4,'cpu_percent':0,'memory_total':4294967296,'memory_used':0,'disk_total':10737418240,'disk_used':0,'docker':True,'nomad':True,'nomad_node_id':n['ID'],'private_ip':n['HTTPAddr'].split(':')[0]}
 # Node inventory is real; utilization comes from agent after installer acceptance.
 encoded=json.dumps(report).replace("'","''")
 sql(f"INSERT INTO machines(id,credential_hash,location,roles,tags,report) VALUES('{mid}','acceptance-{mid}','home',ARRAY['compute','builder','database'],ARRAY['acceptance'],'{encoded}') ON CONFLICT(id) DO UPDATE SET report=excluded.report,last_seen=now()")
api('/runtime',{'nomad_url':manifest['NOMAD_ADDR'],'registry_url':'http://127.0.0.1:5000','buildkit_address':'tcp://127.0.0.1:1234','builder_image':'personal-cloud-builder:dev','allow_insecure_registry':True,'require_cloudflare':False},'PUT')
pid=api('/projects',{'name':'Runtime acceptance '+uuid.uuid4().hex[:6],'repository':'railwayapp/railpack','branch':'main'})['id']
sid=api('/projects/'+pid+'/services',{'name':'FastAPI','port':8000,'placement':{'kind':'automatic'},'root_directory':'examples/python-fastapi','health_path':'/','auto_deploy':False})['id']
state={'project':pid,'service':sid,'databases':[]};state_path.write_text(json.dumps(state,indent=2))
api('/projects/'+pid+'/environment',{'key':'ACCEPTANCE_SECRET','value':'runtime-secret-'+uuid.uuid4().hex},'PUT')
assert all('value' not in v for v in api('/projects/'+pid+'/environment')['variables'])
# Build from source via application controller, not a synthetic job fixture.
dep=api('/services/'+sid+'/deploy',{'commit_sha':'42a99f26e38cbaa1fbeb85443c56733c61fa2eda'})['id'];state['first_deployment']=dep;state_path.write_text(json.dumps(state,indent=2))
d=observe(dep,1200);assert d['status']=='healthy',d
s=service(sid);assert 'Welcome to FastAPI' in private_get(s['address']);assert '@sha256:' in d['image_digest']
assert api('/services/'+sid+'/metrics')['ResourceUsage'];assert 'lines' in api('/services/'+sid+'/logs')
print('PASS source -> Railpack -> BuildKit -> immutable registry -> Nomad -> healthy HTTP, logs, metrics',flush=True)
# Health failure must leave old version responding.
settings={'name':'FastAPI','port':8000,'placement':{'kind':'automatic'},'root_directory':'examples/python-fastapi','health_path':'/missing-health','auto_deploy':False}
api('/services/'+sid,settings,'PUT')
failed=api('/services/'+sid+'/deploy',{'image':d['image_digest']})['id'];f=observe(failed,360);assert f['status']=='failed',f
assert service(sid)['current_deployment_id']==dep;assert 'Welcome to FastAPI' in private_get(s['address'])
print('PASS failed health check retains previous healthy version',flush=True)
settings['health_path']='/';api('/services/'+sid,settings,'PUT')
rb=api('/services/'+sid+'/rollback',{'deployment_id':dep})['id'];r=observe(rb,360);assert r['status']=='healthy' and r['image_digest']==d['image_digest'],r
assert not any(step['step']=='clone' for step in r['steps']);assert 'Welcome to FastAPI' in private_get(service(sid)['address'])
print('PASS immutable rollback without rebuilding',flush=True)
state['rollback_deployment']=rb;state_path.write_text(json.dumps(state,indent=2))
print('Acceptance records:',state_path)
