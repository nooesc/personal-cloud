FROM moby/buildkit:v0.33.0 AS buildkit
FROM alpine:3.22
ARG TARGETARCH
ARG RAILPACK_VERSION=0.39.0
RUN apk add --no-cache bash git curl jq ca-certificates tar coreutils \
 && case "$TARGETARCH" in arm64) arch=arm64;; amd64) arch=x86_64;; *) exit 1;; esac \
 && asset="railpack-v${RAILPACK_VERSION}-${arch}-unknown-linux-musl.tar.gz" \
 && curl -fsSL "https://github.com/railwayapp/railpack/releases/download/v${RAILPACK_VERSION}/${asset}" -o "/tmp/${asset}" \
 && curl -fsSL "https://github.com/railwayapp/railpack/releases/download/v${RAILPACK_VERSION}/checksums.txt" -o /tmp/checksums.txt \
 && cd /tmp && grep " ${asset}$" checksums.txt | sha256sum -c - \
 && tar -xzf "$asset" -C /usr/local/bin railpack \
 && rm -f /tmp/railpack* /tmp/checksums.txt
COPY --from=buildkit /usr/bin/buildctl /usr/local/bin/buildctl
COPY entrypoint.sh /usr/local/bin/pc-build
ENTRYPOINT ["/usr/local/bin/pc-build"]
