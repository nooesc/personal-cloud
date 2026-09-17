#!/bin/sh
# Embedded in the agent: invoked only by explicit --provision when tools are missing.
set -eu
umask 077
[ "$(id -u)" = 0 ] || { echo 'Provisioning requires root' >&2;exit 1; }
. /etc/os-release
case "${ID}:${VERSION_ID:-}" in
 ubuntu:22.04|ubuntu:24.04|debian:12|debian:13) family=debian;;
 fedora:44|fedora-asahi-remix:44) family=fedora;;
 arch:*|omarchy:4.*) family=arch;;
 *) echo 'Use Ubuntu 22.04/24.04, Debian 12/13, Fedora/Asahi 44, Arch, or Omarchy 4' >&2;exit 1;;
esac
command -v systemctl >/dev/null
case "$(uname -m)" in x86_64) arch=amd64;; aarch64) arch=arm64;; *) exit 1;; esac
case "$family" in
 arch)
  # Do not refresh only package databases or perform an unattended OS upgrade.
  pacman -S --needed --noconfirm ca-certificates curl unzip wireguard-tools iproute2 iptables procps-ng
  if ! command -v docker >/dev/null; then pacman -S --needed --noconfirm docker docker-buildx; fi
  ;;
 debian)
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
  ;;
 fedora)
  dnf install -y ca-certificates curl unzip wireguard-tools iproute iptables-nft procps-ng
  if ! command -v docker >/dev/null; then
   curl --proto '=https' --tlsv1.2 -fsSL https://download.docker.com/linux/fedora/docker-ce.repo -o /etc/yum.repos.d/docker-ce.repo
   dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin
  fi
  ;;
esac
if ! command -v nomad >/dev/null; then
 tmp=$(mktemp -d)
 trap 'rm -rf "$tmp"' EXIT HUP INT TERM
 cd "$tmp"
 version=${PC_NOMAD_VERSION:-2.0.6}
 case "$version" in *[!a-zA-Z0-9._-]*) echo "Invalid Nomad version" >&2; exit 1;; esac
 file="nomad_${version}_linux_${arch}.zip"
 curl --proto '=https' --tlsv1.2 -fsSLO "https://releases.hashicorp.com/nomad/$version/$file"
 curl --proto '=https' --tlsv1.2 -fsSL "https://releases.hashicorp.com/nomad/$version/nomad_${version}_SHA256SUMS" -o checksums
 awk -v name="$file" '$2==name {print;found=1} END{if(!found)exit 1}' checksums > selected-checksum
 sha256sum -c selected-checksum
 unzip -q "$file" nomad
 install -m 0755 nomad /usr/local/bin/nomad
fi
systemctl enable --now docker
