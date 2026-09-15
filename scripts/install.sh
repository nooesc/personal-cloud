#!/bin/sh
# Reviewed, explicit Linux bootstrap. Release archives are verified before execution.
set -eu
umask 077
fail() { echo "Personal Cloud: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail 'Run with sudo (the agent installs Docker, Nomad and WireGuard).'
[ "$(uname -s)" = Linux ] || fail 'Use an Ubuntu 24.04 Linux VM on macOS; see infra/README.md.'
[ -r /etc/os-release ] || fail 'Cannot identify this Linux distribution.'
. /etc/os-release
case "${ID}:${VERSION_ID}" in ubuntu:22.04|ubuntu:24.04|debian:12|debian:13) ;; *) fail 'Supported: Ubuntu 22.04/24.04 and Debian 12/13.';; esac
command -v systemctl >/dev/null || fail 'This machine must run systemd.'
: "${PC_API:?Set PC_API to your HTTPS control-plane URL}"
case "$PC_API" in https://*) ;; http://127.0.0.1:*|http://localhost:*) ;; *) fail 'Remote control planes require HTTPS.';; esac
case "$PC_API" in *'"'*|*'%'*|*'\'*|*'
'*) fail 'Invalid control-plane URL';; esac
[ -f /var/lib/personal-cloud/agent.json ] || [ -n "${PC_ENROLL_TOKEN:-}" ] || fail 'Set PC_ENROLL_TOKEN to the enrollment token from your dashboard.'
repo=${PC_RELEASE_REPOSITORY:-nooesc/personal-cloud}
version=${PC_VERSION:-latest}
nomad_version=${PC_NOMAD_VERSION:-2.0.6}
case "$repo" in *[!a-zA-Z0-9_./-]*|*..*) fail 'Invalid release repository';; esac
case "$version:$nomad_version" in *[!a-zA-Z0-9._:-]*) fail 'Invalid version';; esac
case "$(uname -m)" in x86_64) arch=amd64;; aarch64|arm64) arch=arm64;; *) fail 'Supported architectures: amd64 and arm64.';; esac
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl unzip gnupg wireguard-tools iproute2
# Use Docker's signed package repository; never execute an unverified remote shell.
install -m 0755 -d /etc/apt/keyrings
curl --proto '=https' --tlsv1.2 -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
chmod 0644 /etc/apt/keyrings/docker.asc
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' "$(dpkg --print-architecture)" "$ID" "$VERSION_CODENAME" > /etc/apt/sources.list.d/personal-cloud-docker.list
apt-get update
apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin
systemctl enable --now docker
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
cd "$tmp"
fetch() { curl --proto '=https' --tlsv1.2 --retry 3 -fsSL "$1" -o "$2"; }
nomad_archive="nomad_${nomad_version}_linux_${arch}.zip"
fetch "https://releases.hashicorp.com/nomad/$nomad_version/$nomad_archive" "$nomad_archive"
fetch "https://releases.hashicorp.com/nomad/$nomad_version/nomad_${nomad_version}_SHA256SUMS" nomad-checksums
awk -v name="$nomad_archive" '$2==name {print;found=1} END{if(!found)exit 1}' nomad-checksums > selected-checksum
sha256sum -c selected-checksum
unzip -q "$nomad_archive" nomad
install -m 0755 nomad /usr/local/bin/nomad
if [ "$version" = latest ]; then base="https://github.com/$repo/releases/latest/download"; else base="https://github.com/$repo/releases/download/$version"; fi
archive="personal-cloud-agent-linux-${arch}.tar.gz"
fetch "$base/$archive" "$archive"
fetch "$base/SHA256SUMS" SHA256SUMS
awk -v name="$archive" '$2==name {print;found=1} END{if(!found)exit 1}' SHA256SUMS > selected-checksum
sha256sum -c selected-checksum
# Extract only the expected executable; archive paths cannot write elsewhere.
tar -xzf "$archive" personal-cloud-agent
install -m 0755 personal-cloud-agent /usr/local/bin/personal-cloud-agent
install -m 0700 -d /var/lib/personal-cloud /etc/nomad.d
install -m 0755 -d /opt/nomad /opt/personal-cloud/data
cat > /etc/systemd/system/nomad.service <<'SERVICE'
[Unit]
Description=Personal Cloud Nomad runtime
Wants=network-online.target
After=network-online.target docker.service
Requires=docker.service
[Service]
ExecStart=/usr/local/bin/nomad agent -config=/etc/nomad.d/personal-cloud.json
Restart=on-failure
RestartSec=5
KillMode=process
LimitNOFILE=65536
[Install]
WantedBy=multi-user.target
SERVICE
# Enrollment token is used only by the one-shot setup; durable config stores no enrollment secret.
printf 'PC_API="%s"\n' "$PC_API" > /var/lib/personal-cloud/agent.env
if [ -n "${PC_WIREGUARD_ENDPOINT:-}" ]; then
 case "$PC_WIREGUARD_ENDPOINT" in *[!a-zA-Z0-9.:[\]-]*) fail 'Invalid WireGuard endpoint';; esac
 printf 'PC_WIREGUARD_ENDPOINT="%s"\n' "$PC_WIREGUARD_ENDPOINT" >> /var/lib/personal-cloud/agent.env
fi
cat > /etc/systemd/system/personal-cloud-agent.service <<'SERVICE'
[Unit]
Description=Personal Cloud fleet agent
Wants=network-online.target
After=network-online.target docker.service
Requires=docker.service
[Service]
Type=simple
EnvironmentFile=/var/lib/personal-cloud/agent.env
ExecStart=/usr/local/bin/personal-cloud-agent --state /var/lib/personal-cloud/agent.json --provision
Restart=on-failure
RestartSec=10
UMask=0077
[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
# The first provisioned machine becomes the private fleet server automatically.
/usr/local/bin/personal-cloud-agent --state /var/lib/personal-cloud/agent.json --provision --once
unset PC_ENROLL_TOKEN
systemctl enable nomad personal-cloud-agent
systemctl restart personal-cloud-agent
echo 'Personal Cloud installed. Agent status: systemctl status personal-cloud-agent'
echo 'Logs: journalctl -u personal-cloud-agent -u nomad -f'
