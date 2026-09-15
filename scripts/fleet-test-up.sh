#!/bin/sh
# Start only a uniquely named, explicitly owned disposable Linux test stack.
set -eu
cd "$(dirname "$0")/.."
name="${PC_FLEET_TEST_NAME:-pc-fleet-test-$(date +%s)}"
case "$name" in pc-fleet-test-*) ;; *) echo 'Name must begin pc-fleet-test-' >&2; exit 1;; esac
mkdir -p work
state="work/$name.env"
if docker container inspect "$name" >/dev/null 2>&1; then echo "Container already exists: $name" >&2; exit 1; fi
docker build -t personal-cloud-fleet-test:local infra/fleet-test
cid=$(docker run -d --privileged --cgroupns=private --name "$name" --label personal-cloud.disposable-fleet=true -e "PC_TEST_MACHINE_ID=${PC_TEST_MACHINE_ID:-00000000-0000-4000-8000-000000000001}" -p 127.0.0.1::4646 -p 127.0.0.1::5000 -p 127.0.0.1::1234 personal-cloud-fleet-test:local)
printf 'PC_FLEET_TEST_NAME=%s\nPC_FLEET_TEST_ID=%s\n' "$name" "$cid" > "$state"
for i in $(seq 1 150); do
  if [ "$(docker inspect --format '{{.State.Running}}' "$name")" != true ]; then docker logs "$name" --tail 30 >&2; exit 1; fi
  port=$(docker port "$name" 4646/tcp | sed 's/.*://')
  if curl -fsS "http://127.0.0.1:$port/v1/status/leader" 2>/dev/null | grep -q '4647'; then
    registry=$(docker port "$name" 5000/tcp | sed 's/.*://')
    buildkit=$(docker port "$name" 1234/tcp | sed 's/.*://')
    printf 'NOMAD_ADDR=http://127.0.0.1:%s\nPC_REGISTRY_URL=http://127.0.0.1:%s\nBUILDKIT_HOST=tcp://127.0.0.1:%s\nPC_NOMAD_REGISTRY=127.0.0.1:5000\n' "$port" "$registry" "$buildkit" >> "$state"
    cat "$state"
    printf '\nReady. Load with: . %s\nRemove with: scripts/fleet-test-down.sh %s\n' "$state" "$name"
    exit 0
  fi
  sleep 2
done
echo "Runtime startup failed; inspect docker logs $name. State retained: $state" >&2
exit 1
