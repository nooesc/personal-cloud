#!/bin/sh
set -eu
name=${1:?Pass the exact pc-fleet-test container name}
case "$name" in pc-fleet-test-*) ;; *) echo 'Refusing unrelated container name' >&2; exit 1;; esac
label=$(docker inspect --format '{{index .Config.Labels "personal-cloud.disposable-fleet"}}' "$name")
[ "$label" = true ] || { echo 'Refusing container without ownership label' >&2; exit 1; }
docker rm -fv "$name"
