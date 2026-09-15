#!/bin/sh
set -eu
outer=${1:?Outer pc-fleet-test container}
hub=${2:-pc-agent-install-test}
worker=${3:-pc-agent-worker-test}
PC_MESH_OUTER="$outer" PC_MESH_HUB="$hub" PC_MESH_WORKER="$worker" python3 - <<'PY'
import json,os,subprocess,time
outer=os.environ['PC_MESH_OUTER'];hub=os.environ['PC_MESH_HUB'];worker=os.environ['PC_MESH_WORKER']
assert outer.startswith('pc-fleet-test-')
assert subprocess.check_output(['docker','inspect','--format','{{index .Config.Labels "personal-cloud.disposable-fleet"}}',outer],text=True).strip()=='true'
for name in [hub,worker]:
 assert subprocess.check_output(['docker','exec',outer,'docker','inspect','--format','{{index .Config.Labels "personal-cloud.installer-test"}}',name],text=True).strip()=='true'
def inside(name,args,**kwargs):return subprocess.check_output(['docker','exec','-i',outer,'docker','exec','-i',name,*args],**kwargs)
probe='''import json,urllib.request,urllib.error
headers={'X-Nomad-Token':open('/var/lib/personal-cloud/nomad.token').read().strip()}
def get(path):
 with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:4646'+path,headers=headers)) as response:return json.load(response)
rows=[]
for row in get('/v1/nodes'):
 detail=get('/v1/node/'+row['ID']);rows.append({'node_id':row['ID'],'status':row['Status'],'meta':detail['Meta']})
try:
 urllib.request.urlopen('http://127.0.0.1:4646/v1/jobs');anonymous=200
except urllib.error.HTTPError as error:anonymous=error.code
print(json.dumps({'nodes':rows,'anonymous_jobs_status':anonymous}))
'''
for _ in range(90):
 result=json.loads(inside(hub,['python3','-'],input=probe.encode()))
 ready=[node for node in result['nodes'] if node['status']=='ready']
 if len(ready)>=2:break
 time.sleep(1)
else:raise RuntimeError('Private worker did not join the approved Nomad cluster')
assert result['anonymous_jobs_status']==403,'Unauthenticated Nomad access must be rejected'
worker_id=inside(worker,['cat','/opt/nomad/client/client-id'],text=True).strip()
worker_row=next(node for node in ready if node['node_id']==worker_id)
assert worker_row['meta']['pc_compute']=='true'
assert worker_row['meta']['pc_builder']=='false'
assert worker_row['meta']['pc_database']=='false'
assert worker_row['meta']['pc_tag_'+b'private-worker-test'.hex()]=='true'
for name in [hub,worker]:
 peers=inside(name,['wg','show','pc0','latest-handshakes'],text=True).splitlines()
 assert any(int(peer.split()[1])>0 for peer in peers),'WireGuard handshake absent on '+name
 permissions=inside(name,['stat','-c','%a','/var/lib/personal-cloud/agent.json','/var/lib/personal-cloud/wireguard.key'],text=True).splitlines()
 assert permissions==['600','600']
print(json.dumps(result,indent=2))
print('Two real provisioned Linux agents joined over WireGuard; ACL isolation and owner-selected role metadata passed')
PY
