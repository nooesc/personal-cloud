# Fleet runtime and local verification

## Supported production machines

Use a fresh **Ubuntu 22.04/24.04 or Debian 12/13** Linux system with systemd,
root access and amd64 or arm64. Enrollment is explicit installation consent:
Docker packages, Nomad, WireGuard, two systemd units and private routing are
installed. Existing Docker daemon settings are preserved; provisioning adds the
private registry CIDR and may restart Docker. Do not provision an unrelated
production Docker host as a test machine.

From the dashboard, create an enrollment token with the desired roles and tags.
Run the generated command, replacing the example values:

```sh
curl -fsSL https://cloud.example.com/install.sh | sudo env \
  PC_API=https://cloud.example.com PC_ENROLL_TOKEN=TOKEN \
  PC_WIREGUARD_ENDPOINT=server.example.com:51820 sh
```

The first provisioned machine is the private fleet server. Prefer a VPS with a
reachable UDP 51820 endpoint for this first machine; allow that UDP port in its
provider firewall. Subsequent home machines connect outbound to this hub and do
not require forwarded ports. Leave `PC_WIREGUARD_ENDPOINT` unset for those
machines. A single-machine fleet works without a public UDP endpoint. Do not
forward Nomad, BuildKit, Docker or database ports to the Internet.

The agent's HTTPS poll relays controller requests to local Nomad. Its ACL
management token stays at `/var/lib/personal-cloud/nomad.token` (0600), and only
the local agent uses it. Fleet requests and results are encrypted in PostgreSQL.
Owner credentials never go to agents. Agents can claim and answer only commands
for their own machine. Timed-out mutations are not blindly re-delivered.

WireGuard uses `10.77.0.0/16`, durable per-machine addresses, node-local private
keys and a hub-and-spoke layout. The server enables IPv4 forwarding only to
forward private peer traffic; the firewall addition permits `pc0` to `pc0`.
Machine metadata and peer changes reconcile every 30 seconds. WireGuard peer
updates use `wg syncconf`, preserving existing connections where possible.
Nomad role/tag updates restart the local Nomad agent without killing running
Docker workloads. Tags become collision-free `pc_tag_<UTF-8 hex>` metadata keys.

Inspect or rotate a key on a provisioned node:

```sh
sudo systemctl status personal-cloud-agent nomad
sudo journalctl -u personal-cloud-agent -u nomad -f
sudo systemctl stop personal-cloud-agent
sudo sh -c 'set -a; . /var/lib/personal-cloud/agent.env; set +a; personal-cloud-agent --state /var/lib/personal-cloud/agent.json --provision --rotate-wireguard --once'
sudo systemctl start personal-cloud-agent
```

Rotation reports the new public key before reconciling peers. Other nodes receive
it on their next configuration poll, so expect up to 30 seconds of interruption.
Back up the agent identity, WireGuard key, Nomad token, Nomad server data, control
PostgreSQL, `PC_SECRET_KEY`, and machine-local database volumes securely. Do not
delete the first server or its state to repair an offline database; stateful
workloads remain pinned and require explicit recovery.

The installer downloads versioned release assets over HTTPS and verifies the
exact archive against `SHA256SUMS` before executing it. `PC_VERSION=vX.Y.Z` pins
an agent release; default `latest` follows the current published release. Release
CI also emits GitHub artifact provenance attestations. Agent binaries use musl
so the same release works across supported Debian/Ubuntu glibc versions. Nomad
retains its separate upstream license.

## macOS: supported Linux VM path

The fleet agent may report inventory on macOS, but Docker Engine, Nomad client
isolation and WireGuard provisioning run **inside a Linux VM**. Create an Ubuntu
24.04 arm64 VM on Apple Silicon (amd64 on Intel) using your existing VM manager,
give it a persistent disk and at least 4 CPUs/8 GiB RAM, then run the same
installer from inside the VM. Its persistent disk owns any database volumes.
NAT networking is sufficient for a home worker connecting to a VPS hub. No
installer modifies macOS networking or its existing Docker Desktop containers.

## Disposable local integration harness

This harness is for development, not public deployment. It creates one uniquely
named, privileged Docker container with its own Docker daemon, data volume,
cgroup namespace and network namespace. It never mounts the host Docker socket
or host network, and publishes only random loopback ports. The privileged
container can create nested workload isolation and WireGuard interfaces without
modifying macOS network settings.

```sh
scripts/fleet-test-up.sh
# Load the exact env path printed by the script:
. work/pc-fleet-test-TIMESTAMP.env
scripts/fleet-test-check.sh "$PC_FLEET_TEST_NAME"
scripts/fleet-network-check.sh "$PC_FLEET_TEST_NAME"
```

`NOMAD_ADDR` is the host-accessible Nomad API. `PC_REGISTRY_URL` is a
host-accessible registry inspection URL, and `BUILDKIT_HOST` is host-accessible
BuildKit. **Inside Nomad jobs**, the registry is `127.0.0.1:5000` and BuildKit is
`tcp://127.0.0.1:1234`; jobs using BuildKit use Docker host network mode inside
the isolated container. Configure the app's development runtime accordingly.
The harness enables `pc_private` host networking on loopback and named Docker
volumes. It supplies 24000 CPU MHz because virtual Apple Silicon CPUs do not
expose a frequency for Nomad's CPU fingerprint.

The default machine metadata UUID is
`00000000-0000-4000-8000-000000000001`. To use an enrolled development machine's
UUID instead, set `PC_TEST_MACHINE_ID` before starting the harness. The controller
must have a corresponding real development machine row. Harness nodes have
compute, builder and database roles; running harness jobs does not change the
owner-selected roles of any existing fleet machine.

Build the application builder inside the nested daemon:

```sh
docker cp build "$PC_FLEET_TEST_NAME":/opt/pc-build
docker exec "$PC_FLEET_TEST_NAME" docker build \
  --build-arg TARGETARCH=arm64 -t personal-cloud-builder:dev /opt/pc-build
```

Use `TARGETARCH=amd64` on an Intel host. Set runtime `builder_image` to
`personal-cloud-builder:dev`. The check script submits and observes a real
Nomad Docker batch, fails on task failure/timeout, then purges only its own test
job. The network check creates three temporary Linux network namespaces inside
the owned harness and verifies an encrypted spoke-to-spoke round trip through
the hub before deleting its namespaces and keys. All cloud integrations still require real provider credentials; the
harness does not fake their state.

Stop and delete only this harness and its anonymous volumes:

```sh
scripts/fleet-test-down.sh "$PC_FLEET_TEST_NAME"
```

The teardown checks the exact name prefix and ownership label. It never runs
Docker prune or touches unrelated containers/volumes.

## Upstream references

- [Nomad client configuration](https://developer.hashicorp.com/nomad/docs/configuration/client)
- [Nomad agent configuration](https://developer.hashicorp.com/nomad/docs/configuration)
- [Nomad configuration validation](https://developer.hashicorp.com/nomad/commands/config/validate)
- [WireGuard quick start](https://www.wireguard.com/quickstart/)
