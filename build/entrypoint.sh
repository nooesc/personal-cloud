#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${PC_REPOSITORY:?}" "${PC_COMMIT:?}" "${PC_IMAGE_TAG:?}" "${BUILDKIT_HOST:?}"
mkdir -p /workspace/source /workspace/plan /root/.docker
printf 'PC_STEP=clone Cloning repository at a pinned commit\n'
export GIT_TERMINAL_PROMPT=0
if [ -n "${PC_SOURCE_TOKEN:-}" ]; then
  auth=$(printf 'x-access-token:%s' "$PC_SOURCE_TOKEN" | base64 | tr -d '\n')
  git -c "http.extraheader=AUTHORIZATION: basic $auth" init -q /workspace/source
  git -C /workspace/source remote add origin "https://github.com/${PC_REPOSITORY}.git"
  git -C /workspace/source -c "http.extraheader=AUTHORIZATION: basic $auth" fetch --depth=1 origin "$PC_COMMIT"
  unset auth PC_SOURCE_TOKEN
else
  git init -q /workspace/source
  git -C /workspace/source remote add origin "https://github.com/${PC_REPOSITORY}.git"
  git -C /workspace/source fetch --depth=1 origin "$PC_COMMIT"
fi
git -C /workspace/source checkout -q --detach FETCH_HEAD
actual=$(git -C /workspace/source rev-parse HEAD)
[ "$actual" = "$PC_COMMIT" ] || { echo 'Commit verification failed'; exit 1; }
rm -rf /workspace/source/.git
root=$(realpath "/workspace/source/${PC_ROOT_DIRECTORY:-.}")
case "$root" in /workspace/source|/workspace/source/*) ;; *) echo 'Root directory escapes repository'; exit 1;; esac
[ -d "$root" ] || { echo 'Root directory does not exist'; exit 1; }
if [ -n "${PC_REGISTRY_USERNAME:-}" ]; then
  jq -n --arg registry "$PC_REGISTRY_HOST" --arg auth "$(printf '%s:%s' "$PC_REGISTRY_USERNAME" "$PC_REGISTRY_PASSWORD" | base64 | tr -d '\n')" '{auths:{($registry):{auth:$auth}}}' > /root/.docker/config.json
  unset PC_REGISTRY_PASSWORD PC_REGISTRY_USERNAME
fi
output="type=image,name=${PC_IMAGE_TAG},push=true"
if [ "${PC_INSECURE_REGISTRY:-false}" = true ]; then output="$output,registry.insecure=true"; fi
if [ -f "$root/Dockerfile" ]; then
  printf 'PC_STEP=detect Dockerfile detected\n'
  buildctl build --frontend dockerfile.v0 --local "context=$root" --local "dockerfile=$root" --opt "platform=${PC_PLATFORM:-linux/amd64}" --output "$output" --metadata-file /workspace/metadata.json --progress plain
else
  printf 'PC_STEP=detect Detecting application with Railpack\n'
  railpack prepare "$root" --plan-out /workspace/plan/railpack-plan.json --info-out /workspace/plan/info.json
  printf 'PC_STEP=build Building application and uploading image\n'
  buildctl build --frontend gateway.v0 --opt source=ghcr.io/railwayapp/railpack-frontend:v0.39.0 --local "context=$root" --local dockerfile=/workspace/plan --opt "platform=${PC_PLATFORM:-linux/amd64}" --opt "build-arg:cache-key=${PC_SERVICE_ID}" --output "$output" --metadata-file /workspace/metadata.json --progress plain
fi
digest=$(jq -er '."containerimage.digest"' /workspace/metadata.json)
[[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Builder returned an invalid image digest'; exit 1; }
printf 'PC_STEP=upload Image uploaded\nPC_IMAGE=%s@%s\n' "${PC_IMAGE_TAG%:*}" "$digest"
