#!/bin/sh
# Embedded in the agent: invoked only by explicit --provision when tools are missing.
set -eu
umask 077
[ "$(id -u)" = 0 ] || { echo 'Provisioning requires root' >&2;exit 1; }
. /etc/os-release
case "${ID}:${VERSION_ID}" in ubuntu:22.04|ubuntu:24.04|debian:12|debian:13) ;; *) echo 'Use Ubuntu 22.04/24.04 or Debian 12/13' >&2;exit 1;; esac
command -v systemctl >/dev/null
case "$(uname -m)" in x86_64) arch=amd64;; aarch64) arch=arm64;; *) exit 1;; esac
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl unzip wireguard-tools iproute2 iptables procps
if ! command -v docker >/dev/null; then
 install -m 0755 -d /etc/apt/keyrings
 curl --proto '=https' --tlsv1.2 -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
 chmod 0644 /etc/apt/keyrings/docker.asc
 printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' "$(dpkg --print-architecture)" "$ID" "$VERSION_CODENAME" > /etc/apt/sources.list.d/personal-cloud-docker.list
 apt-get update
 apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin
fi
if ! command -v nomad >/dev/null; then
 tmp=$(mktemp -d)
 trap 'rm -rf "$tmp"' EXIT HUP INT TERM
 cd "$tmp"
 version=2.0.6
 file="nomad_${version}_linux_${arch}.zip"
 curl --proto '=https' --tlsv1.2 -fsSLO "https://releases.hashicorp.com/nomad/$version/$file"
 curl --proto '=https' --tlsv1.2 -fsSL "https://releases.hashicorp.com/nomad/$version/nomad_${version}_SHA256SUMS" -o checksums
 awk -v name="$file" '$2==name {print;found=1} END{if(!found)exit 1}' checksums > selected-checksum
 sha256sum -c selected-checksum
 unzip -q "$file" nomad
 install -m 0755 nomad /usr/local/bin/nomad
fi
systemctl enable --now docker
