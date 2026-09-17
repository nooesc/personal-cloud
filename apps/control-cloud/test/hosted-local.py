"""Exercise actual local D1/DO/R2. Only localhost; never production."""
import base64, hashlib, json, os, secrets, subprocess, urllib.request, urllib.error, uuid, time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
BASE='http://localhost:4321'
ORIGIN='http://localhost:4320'
def call(path,data=None,session=None,method=None,headers=None,expected=200):
 h={'Origin':ORIGIN,**(headers or {})}
 if session:h['Cookie']='pc_hosted_session='+session
 if isinstance(data,(dict,list)):data=json.dumps(data).encode();h['Content-Type']='application/json'
 req=urllib.request.Request(BASE+path,data=data,headers=h,method=method)
 try:
  with urllib.request.urlopen(req,timeout=60) as r: status=r.status;raw=r.read();rh=dict(r.headers)
 except urllib.error.HTTPError as e: status=e.code;raw=e.read();rh=dict(e.headers)
 if status!=expected: raise AssertionError((path,status,expected,raw[:1000]))
 try:result=json.loads(raw)
 except:result=raw
 return result,rh
users=[];sql=[];stamp=int(time.time()*1000)
for i in range(2):
 uid,wid=str(uuid.uuid4()),str(uuid.uuid4());token=secrets.token_urlsafe(32);digest=base64.urlsafe_b64encode(hashlib.sha256(token.encode()).digest()).decode().rstrip('=');users.append({'id':uid,'workspace':wid,'token':token})
 sql.extend([f"INSERT INTO users(id,github_id,login,created_at) VALUES('{uid}',{stamp+i},'local-hosted-qa-{i}',{stamp});",f"INSERT INTO workspaces VALUES('{wid}','Local Hosted QA {i}',{stamp});",f"INSERT INTO memberships VALUES('{wid}','{uid}','owner',{stamp});",f"INSERT INTO sessions VALUES('{digest}','{uid}','{wid}',{stamp+3600000},{stamp},0);"])
seed=ROOT/'work/hosted-local-seed.sql';seed.write_text('\n'.join(sql));seed.chmod(0o600)
subprocess.run(['pnpm','--filter','@personal-cloud/control-cloud','exec','wrangler','d1','execute','DIRECTORY','--local','--file',str(seed)],cwd=ROOT,check=True,stdout=subprocess.DEVNULL)
state=ROOT/'work'/Path(os.environ.get('HOSTED_QA_STATE_FILE','hosted-local-users.json')).name;state.write_text(json.dumps(users));state.chmod(0o600)
a,b=users[0]['token'],users[1]['token']
call('/api/snapshot',expected=401)
view,_=call('/api/session',session=a);assert view['mode']=='hosted'
initial=call('/api/snapshot',session=a)[0]['readiness']
assert initial['status']=='blocked' and initial['counts']['ready_to_run']==0
assert {x['code'] for x in initial['blockers']}=={'github_access','runtime_missing'}
# Optional account inventory is private and never inherits operator credentials.
call('/api/integrations/cloudflare/overview',expected=401)
for session in [a,b]:
 assert call('/api/integrations/cloudflare/overview',session=session)[0]['status']=='not_connected'
call('/api/integrations/cloudflare/account',{'account_id':'invalid','api_token':'local-test'},session=a,expected=400)
call('/api/integrations/cloudflare/account',session=a,method='DELETE')
assert call('/api/integrations/cloudflare/overview',session=a)[0]['status']=='not_connected'
assert call('/api/integrations/cloudflare/overview',session=b)[0]['status']=='not_connected'
# Cloud-only projects need neither GitHub nor machines, but machine deployments still do.
cloud_project,_=call('/api/projects',{'name':'Imported cloud app'},session=a,expected=201)
assert cloud_project['repository']==''
cloud_snapshot=call('/api/snapshot',session=a)[0]
assert cloud_snapshot['capabilities']['project_organization'] is True
assert cloud_snapshot['project_resources']==[]
assert any(p['id']==cloud_project['id'] for p in cloud_snapshot['projects'])
call('/api/projects/'+cloud_project['id']+'/services',{'name':'blocked'},session=a,expected=409)
call('/api/projects/'+cloud_project['id'],{'repository':'nooesc/personal-cloud'},session=b,method='PATCH',expected=404)
linked,_=call('/api/projects/'+cloud_project['id'],{'repository':'nooesc/personal-cloud'},session=a,method='PATCH')
assert linked['repository']=='nooesc/personal-cloud'
call('/api/integrations/cloudflare/organize',{'account_id':'a'*32,'revision':'0','assignments':[]},expected=401)
call('/api/integrations/cloudflare/organize',{'account_id':'a'*32,'revision':'0','assignments':[{'kind':'worker','name':'invented','project_id':cloud_project['id']}]},session=a,expected=409)
assert call('/api/snapshot',session=a)[0]['project_resources']==[]
print('PASS: real workerd repository-free project persistence, later repository connection, cross-workspace denial and disconnected resource rejection')
project,_=call('/api/projects',{'name':'Hosted QA','repository':'nooesc/personal-cloud','branch':'main'},session=a,expected=201)
assert not call('/api/snapshot',session=b)[0]['projects']
call('/api/projects/'+project['id']+'/services',{'name':'intrusion','port':8080},session=b,expected=404)
service,_=call('/api/projects/'+project['id']+'/services',{'name':'web','port':8080,'placement':{'kind':'automatic'}},session=a,expected=201)
defaults,_=call('/api/projects/'+project['id']+'/services',{'name':'defaults'},session=a,expected=201)
assert defaults['port']==3000
preflight,_=call('/api/services/'+service['id']+'/preflight',session=a)
assert preflight['status']=='blocked'
call('/api/services/'+service['id']+'/preflight',session=b,expected=404)
blocked,_=call('/api/services/'+service['id']+'/deploy',{},session=a,expected=409)
assert blocked['readiness']['status']=='blocked'
assert call('/api/snapshot',session=a)[0]['deployments']==[]
call('/api/projects/'+project['id']+'/environment',{'key':'QA_SECRET','value':'do-not-expose'},session=a,method='PUT')
assert 'do-not-expose' not in json.dumps(call('/api/snapshot',session=a)[0])
call('/api/projects/'+project['id']+'/environment/QA_SECRET/reveal',session=b,expected=404)
assert call('/api/projects/'+project['id']+'/environment/QA_SECRET/reveal',session=a)[0]['value']=='do-not-expose'
grant,_=call('/api/enrollment-tokens',{'location':'home','roles':['compute'],'tags':['local-qa']},session=a,expected=201)
report={'hostname':'local-qa-agent','os':'Linux (Debian 12)','architecture':'amd64','cpu_cores':4,'cpu_percent':1,'memory_total':8000000000,'memory_used':1000000000,'disk_total':100000000000,'disk_used':1000000000,'docker':True,'nomad':False,'wireguard_public_key':base64.b64encode(secrets.token_bytes(32)).decode()}
machine,_=call('/api/agent/enroll',{'token':grant['token'],'report':report},expected=201)
call('/api/agent/enroll',{'token':grant['token'],'report':report},expected=401)
snapshot=call('/api/snapshot',session=a)[0]
assert snapshot['readiness']['counts']=={'connected':1,'ready_to_run':0,'ready_to_build':0}
assert snapshot['readiness']['machines'][0]['state']=='reporting_only'
assert snapshot['enrollments'][0]['machine_id']==machine['id']
assert grant['token'] not in json.dumps(snapshot) and 'token_hash' not in json.dumps(snapshot)
recommended,_=call('/api/enrollment-tokens',{},session=a,expected=201)
assert recommended['roles']==['compute','builder']
call('/api/enrollment-tokens/'+recommended['id'],session=b,method='DELETE',expected=404)
call('/api/enrollment-tokens/'+recommended['id'],session=a,method='DELETE')
call('/api/agent/enroll',{'token':recommended['token'],'report':report},expected=401)
assert all(e['id']!=recommended['id'] for e in call('/api/snapshot',session=a)[0]['enrollments'])
call('/api/enrollment-tokens/'+grant['id'],session=a,method='DELETE',expected=409)
assert call('/api/snapshot',session=b)[0]['enrollments']==[]
print('PASS: persisted readiness, inventory-only counts, safe enrollment progress, defaults, tenant-isolated preflight and blocked deploy without side effects')
credential={'Authorization':'Bearer '+machine['credential']}
call('/api/agent/'+machine['id']+'/heartbeat',report,headers=credential)
config,_=call('/api/agent/'+machine['id']+'/config',headers=credential);assert config['nomad']['server'];assert config['peers']==[]
call('/api/agent/'+machine['id']+'/heartbeat',report,headers={'Authorization':'Bearer invalid'},expected=401)
call('/api/agent/'+machine['id']+'/runtime-ready',{},headers=credential)
assert not call('/api/snapshot',session=b)[0]['machines']
call('/api/machines/'+machine['id'],{'location':'home','roles':['compute'],'tags':[]},method='PUT',session=b,expected=404)
call('/api/workspaces/'+users[0]['workspace']+'/select',{},session=b,expected=403)
# An unauthenticated browser cannot forge the internal routing identity.
call('/api/snapshot',headers={'x-pc-workspace-id':users[0]['workspace'],'x-pc-user-id':users[0]['id']},expected=401)
# Authenticated request still cannot select another tenant using internal headers.
assert not call('/api/snapshot',session=b,headers={'x-pc-workspace-id':users[0]['workspace']})[0]['projects']
state.write_text(json.dumps({'users':users,'machine':machine,'project':project,'service':service}));state.chmod(0o600)
# OCI registry exercises run against actual local R2 and per-upload Durable Objects.
registry,_=call('/api/registry/credentials',{},session=a)
registry_headers={'Authorization':'Basic '+base64.b64encode((registry['registry_username']+':'+registry['registry_password']).encode()).decode()}
call('/v2/',headers=registry_headers)
name=registry['repository_prefix']+'/'+service['id']
foreign='personal-cloud/'+users[1]['workspace']+'/'+service['id']
call('/v2/'+foreign+'/tags/list',headers=registry_headers,expected=403)
blob=b'actual-r2-registry-content'; digest='sha256:'+hashlib.sha256(blob).hexdigest()
_,upload=call('/v2/'+name+'/blobs/uploads/',data=b'',headers=registry_headers,method='POST',expected=202)
location=upload.get('Location') or upload.get('location')
call(location,data=blob,method='PATCH',headers=registry_headers,expected=202)
call(location+'?digest='+digest,data=b'',method='PUT',headers=registry_headers,expected=201)
assert call('/v2/'+name+'/blobs/'+digest,headers=registry_headers)[0]==blob
manifest=json.dumps({'schemaVersion':2,'mediaType':'application/vnd.oci.image.manifest.v1+json','config':{'mediaType':'application/vnd.oci.image.config.v1+json','digest':digest,'size':len(blob)},'layers':[]},indent=2).encode()
_,mh=call('/v2/'+name+'/manifests/qa',data=manifest,method='PUT',headers={**registry_headers,'Content-Type':'application/vnd.oci.image.manifest.v1+json'},expected=201)
md=mh.get('Docker-Content-Digest') or mh.get('docker-content-digest');assert md=='sha256:'+hashlib.sha256(manifest).hexdigest()
retrieved,_=call('/v2/'+name+'/manifests/'+md,headers=registry_headers);assert retrieved['config']['digest']==digest
print('PASS: R2 OCI upload, digest verification, exact manifest bytes, retrieval, repository isolation')
print('PASS: actual local D1/DO account separation, projects, secrets, single-use enrollment, agent credentials, networking and forged-routing rejection')
# A protocol simulator exercises persisted scheduler observations in real workerd.
# It does not run Nomad or establish that an application can actually deploy.
import threading
stop=threading.Event();sim_errors=[];draining=threading.Event()
node={'ID':'local-scheduler-node','Status':'ready','SchedulingEligibility':'eligible','Drain':False,'Drivers':{'docker':{'Healthy':True}},'Attributes':{'cpu.arch':'amd64'},'Meta':{'pc_machine_id':machine['id'],'pc_compute':'true','pc_builder':'true'}}
def scheduler_simulator():
 try:
  while not stop.is_set():
   commands=call('/api/agent/'+machine['id']+'/commands',headers=credential)[0]['commands']
   for command in commands:
    path=command['request']['path']
    if path=='/v1/nodes': result=[{'ID':node['ID']}]
    elif path=='/v1/node/'+node['ID']: result={**node,'Drain':draining.is_set()}
    else: raise AssertionError('unexpected scheduler mutation/read '+path)
    call('/api/agent/'+machine['id']+'/commands/'+command['id'],{'status':200,'body':json.dumps(result)},headers=credential)
   stop.wait(.1)
 except Exception as error: sim_errors.append(error)
worker=threading.Thread(target=scheduler_simulator,daemon=True);worker.start()
try:
 call('/api/agent/'+machine['id']+'/heartbeat',{**report,'nomad':True},headers=credential)
 def observe_until(predicate):
  deadline=time.monotonic()+25
  while time.monotonic()<deadline:
   current=call('/api/snapshot',session=a)[0]['readiness']
   if predicate(current): return current
   time.sleep(.25)
  raise AssertionError(('readiness did not converge',current,sim_errors))
 ready=observe_until(lambda r:r['counts']['ready_to_run']==1)
 assert ready['counts']['ready_to_build']==1 and ready['status']=='blocked'
 assert [x['code'] for x in ready['blockers']]==['github_access']
 assert call('/api/snapshot',session=b)[0]['readiness']['counts']['ready_to_run']==0
 draining.set()
 observe_until(lambda r:r['counts']['ready_to_run']==0 and any(x['code']=='compute_missing' for x in r['blockers']))
 assert not sim_errors,sim_errors
 print('PASS: actual workerd readiness refresh, scheduler-protocol capability observation, drain invalidation and tenant isolation (simulated runtime only)')
finally:
 stop.set();worker.join(timeout=3)
 call('/api/agent/'+machine['id']+'/heartbeat',report,headers=credential)

# New guided installs report a setup wait, not an inventory-only failure.
setup_grant,_=call('/api/enrollment-tokens',{'setup_intent':'runtime'},session=a,expected=201)
setup_machine,_=call('/api/agent/enroll',{'token':setup_grant['token'],'report':report},expected=201)
setup_view=call('/api/snapshot',session=a)[0]
setup_cap=next(m for m in setup_view['readiness']['machines'] if m['machine_id']==setup_machine['id'])
assert setup_cap['state']=='checking' and not setup_cap['can_run']
print('PASS: persisted runtime setup intent waits for observed capabilities without claiming readiness')

# Native Apple capability is separate from Linux scheduler eligibility.
sim=str(uuid.uuid4())
apple_report={**report}
apple_report['apple']={'enabled':True,'xcode':'Local synthetic Xcode capability','simulators':[{'id':sim,'name':'Local test simulator','runtime':'iOS-test'}]}
apple_report['os']='macOS';apple_report['docker']=False;apple_report['nomad']=False
call('/api/agent/'+machine['id']+'/heartbeat',apple_report,headers=credential)
snap=call('/api/snapshot',session=a)[0]
m=next(m for m in snap['readiness']['machines'] if m['machine_id']==machine['id'])
assert not m['can_apple'] and not m['can_run'] # Inventory alone is not Nomad readiness
path='/api/projects/'+project['id']+'/apple-jobs'
assert call(path,session=a)[0]['jobs']==[]
call(path,session=b,expected=404)
call(path,headers=credential,expected=401)
call(path,{'scheme':'App','container':'../App.xcodeproj','commit':'a'*40,'action':'test','simulator':sim,'machine_id':machine['id']},session=a,expected=400)
call('/api/agent/'+machine['id']+'/apple-jobs',{},headers=credential,expected=410)
call('/api/agent/'+machine['id']+'/apple-jobs',{},headers={'Authorization':'Bearer wrong'},expected=401)
print('PASS real workerd Apple readiness, persisted capability, queue polling and tenant/auth validation')

call('/api/agent/'+machine['id']+'/heartbeat',report,headers=credential)
