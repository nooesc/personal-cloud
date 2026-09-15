# Clean supported Linux target for installer/agent verification inside the test daemon.
FROM debian:12
ENV container=docker
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus ca-certificates curl sudo socat \
 && rm -rf /var/lib/apt/lists/* \
 && systemctl mask getty.target console-getty.service
VOLUME ["/var/lib/docker", "/var/lib/containerd"]
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
