FROM docker:29-dind AS docker
FROM debian:bookworm-slim
COPY --from=docker /usr/local/bin/ /usr/local/bin/
COPY --from=docker /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/
ARG NOMAD_VERSION=2.0.6
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip iproute2 iptables wireguard-tools bash python3 procps util-linux xz-utils && rm -rf /var/lib/apt/lists/* \
 && arch="$(uname -m)" && case "$arch" in x86_64) arch=amd64;; aarch64) arch=arm64;; esac \
 && cd /tmp && curl -fsSLO "https://releases.hashicorp.com/nomad/${NOMAD_VERSION}/nomad_${NOMAD_VERSION}_linux_${arch}.zip" \
 && curl -fsSLO "https://releases.hashicorp.com/nomad/${NOMAD_VERSION}/nomad_${NOMAD_VERSION}_SHA256SUMS" \
 && awk -v file="nomad_${NOMAD_VERSION}_linux_${arch}.zip" '$2 == file' "nomad_${NOMAD_VERSION}_SHA256SUMS" | sha256sum -c - \
 && unzip "nomad_${NOMAD_VERSION}_linux_${arch}.zip" nomad -d /usr/local/bin && rm /tmp/nomad*
COPY entrypoint.sh /usr/local/bin/fleet-test-entrypoint
VOLUME ["/var/lib/docker"]
ENTRYPOINT ["/usr/local/bin/dind", "/usr/local/bin/fleet-test-entrypoint"]
