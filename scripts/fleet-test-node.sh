#!/bin/sh
# Add/stop/restart a second real Nomad client inside the explicitly owned harness.
set -eu
name=${1:?Pass the exact pc-fleet-test container name}
action=${2:-start}
case "$name" in pc-fleet-test-*) ;; *) exit 1;; esac
[ "$(docker inspect --format '{{index .Config.Labels "personal-cloud.disposable-fleet"}}' "$name")" = true ]
case "$action" in
 start)
  docker exec -i -e "PC_TEST_MACHINE_ID2=${PC_TEST_MACHINE_ID2:-00000000-0000-4000-8000-000000000002}" "$name" sh <<'INNER'
set -eu
if [ -f /var/run/pc-second.pid ] && kill -0 "$(cat /var/run/pc-second.pid)" 2>/dev/null; then
 echo 'Second client already running';exit 0
fi
ip address replace 127.0.0.2/32 dev lo
mkdir -p /var/lib/nomad-second /opt/personal-cloud/second-data
cat > /etc/nomad.d/second.json <<JSON
{
 "name":"pc-fleet-second","data_dir":"/var/lib/nomad-second","bind_addr":"127.0.0.2",
 "ports":{"http":4652,"rpc":4653,"serf":4654},
 "advertise":{"http":"127.0.0.2:4652","rpc":"127.0.0.2:4653","serf":"127.0.0.2:4654"},
 "client":{"enabled":true,"cpu_total_compute":24000,"servers":["127.0.0.1:4647"],"cgroup_parent":"nomad-second.slice","min_dynamic_port":32001,"max_dynamic_port":40000,"host_network":{"pc_private":{"cidr":"127.0.0.2/32"}},"host_volume":{"pc-data":{"path":"/opt/personal-cloud/second-data","read_only":false}},"meta":{"pc_machine_id":"$PC_TEST_MACHINE_ID2","pc_compute":"true","pc_builder":"true","pc_database":"true","pc_location":"home","pc_tag_test":"true"}},
 "plugin":{"docker":{"config":{"allow_privileged":false,"volumes":{"enabled":true}}}},
 "telemetry":{"publish_allocation_metrics":true,"publish_node_metrics":true,"collection_interval":"1s"},"consul":{"auto_advertise":false,"server_auto_join":false,"client_auto_join":false}
}
JSON
nomad config validate /etc/nomad.d/second.json
nohup nomad agent -config=/etc/nomad.d/second.json > /var/log/nomad-second.log 2>&1 &
echo $! > /var/run/pc-second.pid
INNER
  for i in $(seq 1 30); do
   if docker exec "$name" sh -c 'test -f /var/lib/nomad-second/client/client-id && curl -fsS http://127.0.0.2:4652/v1/agent/health >/dev/null' 2>/dev/null; then
    docker exec "$name" sh -c 'printf "PC_SECOND_NODE_ID=";cat /var/lib/nomad-second/client/client-id;echo'
    exit 0
   fi
   sleep 1
  done
  docker exec "$name" tail -25 /var/log/nomad-second.log >&2
  exit 1
  ;;
 stop)
  # Hard-stop only this client process; the cluster server stays available.
  docker exec "$name" sh -c 'test -f /var/run/pc-second.pid && kill -KILL "$(cat /var/run/pc-second.pid)" && rm /var/run/pc-second.pid'
  docker exec -i "$name" python3 - <<'INNER'
import json,subprocess,urllib.request
node=open('/var/lib/nomad-second/client/client-id').read().strip()
with urllib.request.urlopen('http://127.0.0.1:4646/v1/node/'+node+'/allocations') as response:
    allocations=json.load(response)
for allocation in allocations:
    containers=subprocess.check_output(['docker','ps','-q','--filter','label=com.hashicorp.nomad.alloc_id='+allocation['ID']],text=True).split()
    for container in containers:
        subprocess.run(['docker','kill',container],check=False,stdout=subprocess.DEVNULL)
print('Stopped second client and its allocation containers; scheduler remains available')
INNER
  ;;
 logs) docker exec "$name" tail -80 /var/log/nomad-second.log;;
 *) echo 'Use start, stop or logs' >&2;exit 1;;
esac
