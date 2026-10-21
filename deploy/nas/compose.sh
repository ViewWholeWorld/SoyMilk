#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
export DOCKER_CONFIG="$PWD/.docker"
# 使用 NAS 已配置的网络出口；需要显式代理时由调用方传入环境变量。
mkdir -p "$DOCKER_CONFIG"
chmod 700 "$DOCKER_CONFIG"
if [ -f deploy/nas/compose.release.yml ]; then
  set -- -f deploy/nas/compose.release.yml "$@"
fi
exec "${SOYMILK_DOCKER:-/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker}" compose \
  -p soymilk-nas -f docker-compose.yml -f deploy/nas/compose.override.yml \
  -f deploy/nas/compose.codex-worker.yml -f deploy/nas/compose.web-time.yml "$@"
