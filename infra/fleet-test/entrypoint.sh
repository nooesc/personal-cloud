#!/bin/sh
set -eu
mkdir -p /var/lib/personal-cloud/volumes /opt/personal-cloud/data /etc/nomad.d
# This daemon has its own data root; the host Docker socket is never mounted.
dockerd --host=unix:///var/run/docker.sock --storage-driver=overlay2 --insecure-registry=127.0.0.1:5000 >/var/log/dockerd.log 2>&1 &
docker_pid=$!
trap 'kill "$docker_pid" ${nomad_pid:-} 2>/dev/null || true' EXIT INT TERM
for i in $(seq 1 90); do docker info >/dev/null 2>&1 && break; sleep 1; done
docker info >/dev/null
# Nested services share only this disposable container's network namespace.
docker run -d --name pc-registry --network host --restart unless-stopped registry:2 >/dev/null
docker run -d --name pc-buildkit --network host --privileged --restart unless-stopped moby/buildkit:v0.33.0 --addr tcp://0.0.0.0:1234 >/dev/null
cat > /etc/nomad.d/test.json <<JSON
{
 "data_dir":"/var/lib/nomad","bind_addr":"0.0.0.0",
 "advertise":{"http":"127.0.0.1:4646","rpc":"127.0.0.1:4647","serf":"127.0.0.1:4648"},
 "server":{"enabled":true,"bootstrap_expect":1},
 "client":{"enabled":true,"cpu_total_compute":24000,"servers":["127.0.0.1:4647"],"host_network":{"pc_private":{"cidr":"127.0.0.0/8"}},"host_volume":{"pc-data":{"path":"/var/lib/personal-cloud/volumes","read_only":false}},"meta":{"pc_machine_id":"${PC_TEST_MACHINE_ID:-00000000-0000-4000-8000-000000000001}","pc_compute":"true","pc_builder":"true","pc_database":"true","pc_location":"home","pc_tag_test":"true"}},
 "plugin":{"docker":{"config":{"allow_privileged":true,"volumes":{"enabled":true},"gc":{"dangling_containers":{"enabled":false}}}}},
 "telemetry":{"publish_allocation_metrics":true,"publish_node_metrics":true,"collection_interval":"1s"},"consul":{"auto_advertise":false,"server_auto_join":false,"client_auto_join":false}
}
JSON
nomad agent -config=/etc/nomad.d/test.json &
nomad_pid=$!
wait "$nomad_pid"
