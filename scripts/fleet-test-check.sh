#!/bin/sh
set -eu
name=${1:?Pass the exact pc-fleet-test container name}
case "$name" in pc-fleet-test-*) ;; *) echo 'Refusing unrelated container' >&2;exit 1;; esac
[ "$(docker inspect --format '{{index .Config.Labels "personal-cloud.disposable-fleet"}}' "$name")" = true ]
port=$(docker port "$name" 4646/tcp | sed 's/.*://')
NOMAD_ADDR="http://127.0.0.1:$port" python3 - <<'PY'
import json,os,time,urllib.request
base=os.environ['NOMAD_ADDR']
def request(path,data=None,method=None):
    req=urllib.request.Request(base+path,data=json.dumps(data).encode() if data is not None else None,method=method,headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=15) as response:
        body=response.read()
        return json.loads(body) if body else None
job='pc-fleet-harness-check'
request('/v1/jobs',{'Job':{'ID':job,'Name':job,'Type':'batch','Datacenters':['dc1'],'TaskGroups':[{'Name':'verify','Tasks':[{'Name':'verify','Driver':'docker','Config':{'image':'busybox:1.37','command':'sh','args':['-c','echo PERSONAL_CLOUD_RUNTIME_OK']},'Resources':{'CPU':100,'MemoryMB':64}}]}]}})
try:
    for _ in range(60):
        allocations=request('/v1/job/'+job+'/allocations')
        if allocations:
            allocation=request('/v1/allocation/'+allocations[0]['ID'])
            if allocation['ClientStatus']=='complete':
                print('Real Nomad Docker batch completed:',allocation['ID'])
                print('Node:',allocation['NodeID'])
                break
            if allocation['ClientStatus']=='failed':
                raise RuntimeError(json.dumps(allocation['TaskStates']))
        time.sleep(1)
    else:
        raise RuntimeError('Runtime job did not complete within 60 seconds')
finally:
    request('/v1/job/'+job+'?purge=true',method='DELETE')
PY
