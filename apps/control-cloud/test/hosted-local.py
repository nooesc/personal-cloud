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
state=ROOT/'work/hosted-local-users.json';state.write_text(json.dumps(users));state.chmod(0o600)
a,b=users[0]['token'],users[1]['token']
call('/api/snapshot',expected=401)
view,_=call('/api/session',session=a);assert view['mode']=='hosted'
project,_=call('/api/projects',{'name':'Hosted QA','repository':'nooesc/personal-cloud','branch':'main'},session=a,expected=201)
assert not call('/api/snapshot',session=b)[0]['projects']
call('/api/projects/'+project['id']+'/services',{'name':'intrusion','port':8080},session=b,expected=404)
service,_=call('/api/projects/'+project['id']+'/services',{'name':'web','port':8080,'placement':{'kind':'automatic'}},session=a,expected=201)
call('/api/projects/'+project['id']+'/environment',{'key':'QA_SECRET','value':'do-not-expose'},session=a,method='PUT')
assert 'do-not-expose' not in json.dumps(call('/api/snapshot',session=a)[0])
call('/api/projects/'+project['id']+'/environment/QA_SECRET/reveal',session=b,expected=404)
assert call('/api/projects/'+project['id']+'/environment/QA_SECRET/reveal',session=a)[0]['value']=='do-not-expose'
grant,_=call('/api/enrollment-tokens',{'location':'home','roles':['compute'],'tags':['local-qa']},session=a,expected=201)
report={'hostname':'local-qa-agent','os':'Linux (Debian 12)','architecture':'amd64','cpu_cores':4,'cpu_percent':1,'memory_total':8000000000,'memory_used':1000000000,'disk_total':100000000000,'disk_used':1000000000,'docker':True,'nomad':False,'wireguard_public_key':base64.b64encode(secrets.token_bytes(32)).decode()}
machine,_=call('/api/agent/enroll',{'token':grant['token'],'report':report},expected=201)
call('/api/agent/enroll',{'token':grant['token'],'report':report},expected=401)
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
