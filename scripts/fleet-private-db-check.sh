#!/bin/sh
# Real private-IP PostgreSQL round trip in the owned, provisioned Linux target.
set -eu
outer=${1:?Outer pc-fleet-test container}
inner=${2:-pc-agent-install-test}
case "$outer" in pc-fleet-test-*) ;; *) exit 1;; esac
[ "$(docker inspect --format '{{index .Config.Labels "personal-cloud.disposable-fleet"}}' "$outer")" = true ]
[ "$(docker exec "$outer" docker inspect --format '{{index .Config.Labels "personal-cloud.installer-test"}}' "$inner")" = true ]
docker exec -i "$outer" docker exec -i "$inner" python3 - <<'PY'
import json,os,secrets,subprocess,time,urllib.request,uuid
headers={'X-Nomad-Token':open('/var/lib/personal-cloud/nomad.token').read().strip(),'Content-Type':'application/json'}
def api(path,data=None,method=None):
 req=urllib.request.Request('http://127.0.0.1:4646'+path,data=json.dumps(data).encode() if data is not None else None,headers=headers,method=method)
 with urllib.request.urlopen(req,timeout=15) as response:
  data=response.read();return json.loads(data) if data else None
suffix=uuid.uuid4().hex[:10];job='pc-fleet-db-check-'+suffix;volume=job+'-data';allocation=None
password=secrets.token_hex(24);node=open('/opt/nomad/client/client-id').read().strip();ip=open('/var/lib/personal-cloud/private-ip').read().strip()
for path in ['/opt/pc-private-db-check.ready.json','/opt/pc-private-db-check.finish']:
 try:os.unlink(path)
 except FileNotFoundError:pass
try:
 for _ in range(30):
  try:
   if api('/v1/status/leader'):break
  except Exception:pass
  time.sleep(1)
 api('/v1/jobs',{'Job':{'ID':job,'Name':job,'Type':'service','Datacenters':['dc1'],'Constraints':[{'LTarget':'${node.unique.id}','Operand':'=','RTarget':node}], 'TaskGroups':[{'Name':'db','Count':1,'Networks':[{'Mode':'host','DynamicPorts':[{'Label':'db','To':5432,'HostNetwork':'pc_private'}]}],'Tasks':[{'Name':'postgres','Driver':'docker','Config':{'image':'postgres:17-alpine','ports':['db'],'volumes':[volume+':/var/lib/postgresql/data']},'Env':{'POSTGRES_USER':'fleet','POSTGRES_DB':'fleet_test','POSTGRES_PASSWORD':password},'Resources':{'CPU':300,'MemoryMB':256}}]}]}})
 for _ in range(90):
  allocations=api('/v1/job/'+job+'/allocations')
  if allocations:
   allocation=api('/v1/allocation/'+allocations[0]['ID'])
   if allocation['ClientStatus']=='running':break
   if allocation['ClientStatus']=='failed':raise RuntimeError('PostgreSQL allocation failed')
  time.sleep(1)
 else:raise RuntimeError('PostgreSQL did not start')
 assert allocation['NodeID']==node
 shared=allocation['AllocatedResources']['Shared'];ports=shared.get('Ports',[])
 for network in shared.get('Networks',[]):ports+=network.get('DynamicPorts',[])
 port=next(p['Value'] for p in ports if p['Label']=='db')
 env=os.environ.copy();env['PGPASSWORD']=password
 workers=[n for n in api('/v1/nodes') if n['ID']!=node and n['Status']=='ready']
 def query(sql,attempts=15):
  if workers:
   client_job='pc-fleet-db-client-'+uuid.uuid4().hex[:10];client_allocation=None
   args=['-c','for i in $(seq 1 30); do psql "$@" && exit 0; sleep 1; done; exit 1','pc-db-client','-h',ip,'-p',str(port),'-U','fleet','-d','fleet_test','-At','-v','ON_ERROR_STOP=1','-c',sql]
   try:
    api('/v1/jobs',{'Job':{'ID':client_job,'Name':client_job,'Type':'batch','Datacenters':['dc1'],'Constraints':[{'LTarget':'${node.unique.id}','Operand':'=','RTarget':workers[0]['ID']}],'TaskGroups':[{'Name':'query','Tasks':[{'Name':'client','Driver':'docker','Config':{'image':'postgres:17-alpine','command':'sh','args':args},'Env':{'PGPASSWORD':password},'Resources':{'CPU':100,'MemoryMB':64}}]}]}})
    for _ in range(90):
     allocations=api('/v1/job/'+client_job+'/allocations')
     if allocations:
      client_allocation=api('/v1/allocation/'+allocations[0]['ID'])
      if client_allocation['ClientStatus']=='complete':break
      if client_allocation['ClientStatus']=='failed':raise RuntimeError('Worker-to-database query failed')
     time.sleep(1)
    else:raise RuntimeError('Worker query timed out')
    assert client_allocation['NodeID']==workers[0]['ID']
    req=urllib.request.Request('http://127.0.0.1:4646/v1/client/fs/logs/'+client_allocation['ID']+'?task=client&type=stdout&plain=true&origin=start&offset=0',headers=headers)
    with urllib.request.urlopen(req,timeout=10) as response:return response.read().decode().strip()
   finally:
    api('/v1/job/'+client_job+'?purge=true',method='DELETE')
  for _ in range(attempts):
   result=subprocess.run(['docker','run','--rm','--network','bridge','-e','PGPASSWORD','postgres:17-alpine','psql','-h',ip,'-p',str(port),'-U','fleet','-d','fleet_test','-At','-v','ON_ERROR_STOP=1','-c',sql],env=env,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
   if result.returncode==0:return result.stdout.strip()
   time.sleep(1)
  raise RuntimeError('Private PostgreSQL connection failed')
 query("CREATE TABLE fleet_roundtrip(value text); INSERT INTO fleet_roundtrip VALUES ('private-network-ok')")
 assert query('SELECT value FROM fleet_roundtrip')=='private-network-ok'
 print(('Real Nomad task on second worker' if workers else 'Real container')+' connected to PostgreSQL over private address '+ip+':'+str(port),flush=True)
 api('/v1/client/allocation/'+allocation['ID']+'/restart',{'TaskName':'postgres'})
 time.sleep(2)
 assert query('SELECT value FROM fleet_roundtrip')=='private-network-ok'
 after=api('/v1/allocation/'+allocation['ID']);assert after['NodeID']==node
 print('Persisted PostgreSQL row survived allocation restart on its pinned node',flush=True)
 ready={'allocation_id':allocation['ID'],'machine_id':json.load(open('/var/lib/personal-cloud/agent.json'))['id'],'node_id':node,'private_ip':ip,'port':port}
 with open('/opt/pc-private-db-check.ready.json','w') as file:json.dump(ready,file)
 print('Network counter probe ready: '+json.dumps(ready),flush=True)
 for _ in range(60):
  if os.path.exists('/opt/pc-private-db-check.finish'):break
  time.sleep(1)
finally:
 try:api('/v1/job/'+job+'?purge=true',method='DELETE')
 except Exception:pass
 if allocation:
  ids=subprocess.check_output(['docker','ps','-aq','--filter','label=com.hashicorp.nomad.alloc_id='+allocation['ID']],text=True).split()
  if ids:subprocess.run(['docker','rm','-f',*ids],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 subprocess.run(['docker','volume','rm',volume],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 print('Removed only the private-database check job and its temporary volume',flush=True)
PY
