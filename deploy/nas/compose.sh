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
# 旧镜像只认 DATABASE_URL；字段式连接由新镜像直接读取。该兼容地址只在边界生成一次，
# 用户名、密码和库名分别 percent-encode，供 docker-compose.yml 透传、回退和兼容探针共用。
DATABASE_URL=$(sh deploy/nas/database-url.sh)
export DATABASE_URL
exec "${SOYMILK_DOCKER:-/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker}" compose \
  -p soymilk-nas -f docker-compose.yml -f deploy/nas/compose.override.yml \
  -f deploy/nas/compose.codex-worker.yml -f deploy/nas/compose.web-time.yml "$@"
