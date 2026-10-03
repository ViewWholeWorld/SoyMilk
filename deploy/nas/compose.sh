#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
export DOCKER_CONFIG="$PWD/.docker"
export HTTP_PROXY="${HTTP_PROXY:-http://127.0.0.1:17890}"
export HTTPS_PROXY="${HTTPS_PROXY:-http://127.0.0.1:17890}"
mkdir -p "$DOCKER_CONFIG"
chmod 700 "$DOCKER_CONFIG"
if [ -f deploy/nas/compose.release.yml ]; then
  set -- -f deploy/nas/compose.release.yml "$@"
fi
exec "${SOYMILK_DOCKER:-/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker}" compose \
  -p soymilk-nas -f docker-compose.yml -f deploy/nas/compose.override.yml \
  -f deploy/nas/compose.codex-worker.yml -f deploy/nas/compose.web-time.yml "$@"
