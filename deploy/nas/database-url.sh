#!/bin/sh
# 生成旧镜像兼容的 DATABASE_URL。
#
# 新镜像按 DATABASE_HOST/USER/PASSWORD/NAME 字段连接；旧镜像只认 DATABASE_URL。
# 该地址只在 Compose/NAS 边界生成一次，用户名、密码和库名分别做 percent-encode，
# 供 docker-compose.yml 透传、旧镜像回退和 auto-release.sh 的旧镜像兼容探针共用。
# 脚本只读取环境变量或 .env 中下列键，不 source 文件、不展开变量、不打印密码。
#
# 用法：DATABASE_URL=$(sh deploy/nas/database-url.sh)
# 环境变量 SOYMILK_ENV_FILE 可指定 .env 路径（默认 .env）。

set -eu

ENV_FILE=${SOYMILK_ENV_FILE:-.env}

# 读取 .env 中某个键的字面值；去掉首尾成对引号，不处理转义。
dotenv_value() {
  [ -f "$ENV_FILE" ] || return 0
  value=$(LC_ALL=C sed -n "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" | tail -n 1 | tr -d '\r')
  case "$value" in
    \"*\") value=${value#\"}; value=${value%\"} ;;
    \'*\') value=${value#\'}; value=${value%\'} ;;
  esac
  printf '%s' "$value"
}

# 环境变量优先，其次 .env，最后默认值。
setting() {
  eval "value=\${$1-}"
  if [ -z "$value" ]; then value=$(dotenv_value "$ENV_FILE" "$1"); fi
  if [ -z "$value" ] && [ "$#" -ge 2 ]; then value=$2; fi
  printf '%s' "$value"
}

# RFC 3986 percent-encode：保留 A-Z a-z 0-9 - . _ ~，其余按字节编码。
# od -b（POSIX 八进制字节）兼容 NAS BusyBox 1.24，不使用 -t。
percent_encode() {
  encoded=
  for octal in $(printf '%s' "$1" | od -An -v -b); do
    code=$((0$octal))
    if { [ "$code" -ge 48 ] && [ "$code" -le 57 ]; } ||
       { [ "$code" -ge 65 ] && [ "$code" -le 90 ]; } ||
       { [ "$code" -ge 97 ] && [ "$code" -le 122 ]; } ||
       [ "$code" -eq 45 ] || [ "$code" -eq 46 ] || [ "$code" -eq 95 ] || [ "$code" -eq 126 ]; then
      encoded=$encoded$(printf "\\$octal")
    else
      encoded=$encoded%$(printf '%02X' "$code")
    fi
  done
  printf '%s' "$encoded"
}

password=$(setting DATABASE_PASSWORD)
if [ -z "$password" ]; then password=$(setting POSTGRES_PASSWORD); fi
if [ -z "$password" ]; then
  if [ -n "${DATABASE_URL:-}" ]; then
    printf '%s\n' "$DATABASE_URL"
    exit 0
  fi
  printf '缺少 POSTGRES_PASSWORD 或 DATABASE_PASSWORD，无法生成兼容连接地址\n' >&2
  exit 1
fi

host=$(setting DATABASE_HOST db)
port=$(setting DATABASE_PORT 5432)
user=$(setting DATABASE_USER aihot)
name=$(setting DATABASE_NAME aihot)

printf 'postgres://%s:%s@%s:%s/%s\n' \
  "$(percent_encode "$user")" "$(percent_encode "$password")" "$host" "$port" "$(percent_encode "$name")"
