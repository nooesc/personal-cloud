#!/bin/sh
# Exercise encrypted spoke -> hub -> spoke traffic only inside the owned harness.
set -eu
name=${1:?Pass the exact pc-fleet-test container name}
case "$name" in pc-fleet-test-*) ;; *) exit 1;; esac
[ "$(docker inspect --format '{{index .Config.Labels "personal-cloud.disposable-fleet"}}' "$name")" = true ]
docker exec -i "$name" bash <<'BASH'
set -euo pipefail
prefix="pcw$$"
dir=$(mktemp -d /opt/pc-network-check.XXXXXX)
cleanup() {
  for role in hub a b; do ip netns delete "$prefix-$role" 2>/dev/null || true; done
  ip link delete "$prefix" 2>/dev/null || true
  rm -rf "$dir"
}
trap cleanup EXIT
umask 077
ip link add "$prefix" type bridge
ip link set "$prefix" up
for role in hub a b; do
  ip netns add "$prefix-$role"
  ip link add "$prefix-$role" type veth peer name "v-$role"
  ip link set "v-$role" netns "$prefix-$role"
  ip link set "$prefix-$role" master "$prefix"
  ip link set "$prefix-$role" up
  ip -n "$prefix-$role" link set lo up
  ip -n "$prefix-$role" link set "v-$role" up
  wg genkey > "$dir/$role.key"
  wg pubkey < "$dir/$role.key" > "$dir/$role.pub"
  ip -n "$prefix-$role" link add wg0 type wireguard
  ip netns exec "$prefix-$role" wg set wg0 private-key "$dir/$role.key" listen-port 51820
  ip -n "$prefix-$role" link set wg0 up
done
for pair in hub:1 a:2 b:3; do
  role=${pair%:*}; num=${pair#*:}
  ip -n "$prefix-$role" address add "192.0.2.$num/24" dev "v-$role"
  ip -n "$prefix-$role" address add "10.77.250.$num/24" dev wg0
done
ip netns exec "$prefix-hub" sysctl -qw net.ipv4.ip_forward=1
for pair in a:2 b:3; do
  role=${pair%:*}; num=${pair#*:}
  ip netns exec "$prefix-hub" wg set wg0 peer "$(cat "$dir/$role.pub")" allowed-ips "10.77.250.$num/32"
  ip netns exec "$prefix-$role" wg set wg0 peer "$(cat "$dir/hub.pub")" allowed-ips 10.77.0.0/16 endpoint 192.0.2.1:51820 persistent-keepalive 1
done
ip netns exec "$prefix-b" python3 -c 'import socket;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.bind(("10.77.250.3",18080));s.settimeout(15);data,peer=s.recvfrom(1024);s.sendto(data,peer)' &
server=$!
sleep 2
ip netns exec "$prefix-a" python3 -c 'import socket;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(10);s.sendto(b"PRIVATE_FLEET_ROUNDTRIP",("10.77.250.3",18080));assert s.recv(1024)==b"PRIVATE_FLEET_ROUNDTRIP";print("Encrypted spoke-to-spoke WireGuard round trip passed through hub")'
wait "$server"
ip netns exec "$prefix-hub" wg show wg0 latest-handshakes | awk '$2>0 {n++} END {if(n!=2)exit 1;print "Both peers completed a WireGuard handshake"}'
BASH
