#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
. ./deploy/nas/release-policy.sh

if [ -f deploy/nas/auto-release.env ]; then
  # shellcheck disable=SC1091
  . ./deploy/nas/auto-release.env
fi
IMAGE_REPO=${IMAGE_REPO:-ghcr.io/viewwholeworld/soymilk}
GITHUB_REPO=${GITHUB_REPO:-ViewWholeWorld/SoyMilk}
if [ "${SOYMILK_DOCKER+x}" = x ]; then export SOYMILK_DOCKER; fi
WEB_SMOKE_BASE=${WEB_SMOKE_BASE:-http://localhost:3000}
API_HEALTH_URL=${API_HEALTH_URL:-http://localhost:3001/api/health}
SEED_TOPICS_ON_RELEASE=${SEED_TOPICS_ON_RELEASE:-false}
case "$SEED_TOPICS_ON_RELEASE" in
  true|false) ;;
  *) printf 'SEED_TOPICS_ON_RELEASE 必须是 true 或 false\n' >&2; exit 2 ;;
esac
version=
dry_run=false
for arg do
  case "$arg" in
    --dry-run) dry_run=true ;;
    v[0-9]*|[0-9]*) [ -z "$version" ] || exit 2; version=${arg#v} ;;
    *) printf '用法：sh deploy/nas/auto-release.sh [vX.Y.Z] [--dry-run]\n' >&2; exit 2 ;;
  esac
done

run() {
  if [ "$dry_run" = true ]; then
    printf '计划：'
    printf ' %s' "$@"
    printf '\n'
  else
    "$@"
  fi
}
docker_cmd() { "${SOYMILK_DOCKER:-/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker}" "$@"; }
compose() { sh deploy/nas/compose.sh "$@"; }

# 公开 tags API，无令牌；分页后按稳定语义版本排序。
resolve_version() {
  if [ -z "$version" ]; then
    page=1
    tags=
    while :; do
      response=$(curl -fsS "https://api.github.com/repos/$GITHUB_REPO/tags?per_page=100&page=$page") || return 1
      names=$(printf '%s' "$response" | sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p')
      tags="$tags
$names"
      # 空页结束；预发布标签不参与排序，但仍继续翻页。
      case "$response" in *'"name"'*) page=$((page + 1)) ;; *) break ;; esac
    done
    version=$(printf '%s\n' "$tags" | sed '/^$/d; s/^v//' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)
  fi
  printf '%s\n' "$version" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'
  verify_release_ref
}

verify_release_ref() {
  tag="v$version"
  tag_response=$(curl -fsS -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$GITHUB_REPO/git/ref/tags/$tag") || {
    printf '无法读取发布标签 %s\n' "$tag" >&2
    return 1
  }
  tag_type=$(printf '%s' "$tag_response" | release_object_type)
  tag_sha=$(printf '%s' "$tag_response" | release_object_sha)
  [ -n "$tag_sha" ] || { printf '发布标签 %s 没有可解析的提交\n' "$tag" >&2; return 1; }
  if [ "$tag_type" = tag ]; then
    # Annotated tag: dereference the tag object once and use only the commit it points at.
    tag_object=$(curl -fsS -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$GITHUB_REPO/git/tags/$tag_sha") || return 1
    if [ "$(printf '%s' "$tag_object" | release_object_type)" != commit ]; then
      printf '注释标签 %s 未指向提交\n' "$tag" >&2
      return 1
    fi
    tag_sha=$(printf '%s' "$tag_object" | release_object_sha)
    [ -n "$tag_sha" ] || { printf '注释标签 %s 没有可解析的提交\n' "$tag" >&2; return 1; }
  elif [ "$tag_type" != commit ]; then
    printf '发布标签 %s 指向不支持的 %s 对象\n' "$tag" "${tag_type:-unknown}" >&2
    return 1
  fi
  compare_response=$(curl -fsS -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$GITHUB_REPO/compare/main...$tag_sha") || return 1
  compare_status=$(printf '%s' "$compare_response" | sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' | head -n 1)
  compare_ahead_by=$(printf '%s' "$compare_response" | sed -n 's/.*"ahead_by"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -n 1)
  if ! release_ref_is_on_main "$compare_status" "${compare_ahead_by:-unknown}"; then
    printf '发布标签 %s 不在 main 历史上（compare=%s ahead_by=%s）\n' "$tag" "${compare_status:-unknown}" "${compare_ahead_by:-unknown}" >&2
    return 1
  fi
  # Same commit, ci.yml, push event, newest run only: a queued/in-progress run, a failed rerun, or
  # PR-only success is not release evidence.
  ci_response=$(curl -fsS -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$GITHUB_REPO/actions/workflows/ci.yml/runs?head_sha=$tag_sha&event=push&per_page=1") || return 1
  ci_status=$(printf '%s' "$ci_response" | sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' | head -n 1)
  ci_conclusion=$(printf '%s' "$ci_response" | sed -n 's/.*"conclusion"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' | head -n 1)
  if ! release_ci_allows "$ci_status" "$ci_conclusion"; then
    printf '发布标签 %s 的 push CI 未通过（status=%s conclusion=%s）\n' "$tag" "${ci_status:-missing}" "${ci_conclusion:-missing}" >&2
    return 1
  fi
}

version_not_lower() {
  old_version=$1
  new_version=$2
  awk -F. -v old="$old_version" -v new="$new_version" 'BEGIN {
    split(old, o); split(new, n);
    if (n[1] > o[1] || (n[1] == o[1] && (n[2] > o[2] || (n[2] == o[2] && n[3] >= o[3])))) exit 0;
    exit 1;
  }'
}

if [ "$dry_run" = true ]; then
  resolve_version
  image="$IMAGE_REPO:$version"
  run sha256sum docker-compose.yml deploy/nas/compose.sh deploy/nas/database-url.sh deploy/nas/compose.override.yml deploy/nas/compose.codex-worker.yml deploy/nas/compose.web-time.yml
  run compose ps -q api
  run docker_cmd inspect --format '{{.Image}}' '<api容器>'
  run compose ps -a -q '<setup/api/worker/web>'
  run docker_cmd inspect --format '{{.Image}}' '<四服务容器，须均等于旧镜像ID>'
  run docker_cmd image inspect --format '{{.Id}}' '<已有最后覆盖的api镜像，须等于旧镜像ID>'
  run docker_cmd pull "$image"
  run cp '<镜像覆盖及三个私有覆盖>' 'backups/release-<时间>/'
  run docker_cmd run --rm --entrypoint ls "$image" /app/database/migrations
  run docker_cmd run --rm --entrypoint ls '<当前镜像ID>' /app/database/migrations
  printf '计划：有新迁移或 SEED_TOPICS_ON_RELEASE=true 时运行 pg_dump 和 pg_restore --list 非空检查；否则打印“无新迁移，跳过数据库备份”。\n'
  printf '计划：新镜像 setup 默认只迁移；仅显式 SEED_TOPICS_ON_RELEASE=true 时同步 topics，并保留 topics 前后快照与差异。\n'
  printf '计划：迁移完成后临时以旧镜像读取稳定表，兼容检查失败则只回退应用。\n'
  run docker_cmd inspect --format '{{.Id}} {{.Image}} {{.State.StartedAt}}' '<db容器，保存切换前状态>'
  run compose stop -t 230 worker
  run docker_cmd inspect --format '{{.State.ExitCode}}' '<worker容器，须为0>'
  run compose exec -T db psql -X -U aihot -d aihot -At -c "SELECT count(*) FROM receipt_attempts WHERE status='pending'"
  printf '计划：排空须正常退出且 pending 为 0；失败以旧配置重启 worker，记录 drain/failed 并退出，不停止 API/web 或切换覆盖。\n'
  run compose stop -t 30 api web
  run sed '<仅替换四个服务的image>' deploy/nas/compose.release.yml
  run compose run --rm --no-deps setup
  run compose up -d --no-build --pull never setup api worker web
  run docker_cmd inspect --format '{{.Image}}' '<setup/api/worker/web容器>'
  run docker_cmd inspect --format '{{.State.ExitCode}}' '<setup容器，须为0>'
  run docker_cmd inspect --format '{{.Id}} {{.Image}} {{.State.StartedAt}}' '<db容器，须与切换前一致>'
  run sha256sum docker-compose.yml deploy/nas/compose.sh deploy/nas/database-url.sh deploy/nas/compose.override.yml deploy/nas/compose.codex-worker.yml deploy/nas/compose.web-time.yml
  run diff '<切换前配置校验和>' '<验收时配置校验和>'
  run compose exec -T web node scripts/smoke.ts --base "$WEB_SMOKE_BASE"
  printf '计划：成功后仅保留最新 3 个 backups/release-* 目录；清理失败只记日志。\n'
  printf '计划：成功后对 %s 中除新镜像和上一镜像外的 ID 执行 docker image rm，不强制删除；失败只记日志。\n' "$IMAGE_REPO"
  printf '失败时恢复镜像覆盖并固定旧镜像ID，仅回退应用；不恢复数据库。\n'
  exit 0
fi

status_dir=deploy/nas/release-status
mkdir -p "$status_dir"
lock="$status_dir/lock"
if ! mkdir "$lock" 2>/dev/null; then
  printf '已有发布正在运行\n' >&2
  exit 1
fi
stamp=$(date '+%Y%m%d-%H%M%S')
previous_image=
result=failed
step=resolve
new_migrations=false
rollback_needed=false
backup="backups/release-$stamp"
release=deploy/nas/compose.release.yml

health() {
  compose exec -T api node -e 'fetch(process.argv[1], {signal: AbortSignal.timeout(10000)}).then(r => {if (!r.ok) process.exit(1)}).catch(() => process.exit(1))' "$API_HEALTH_URL"
}
retry_health() {
  attempt=0
  while [ "$attempt" -lt 5 ]; do
    if health; then return 0; fi
    attempt=$((attempt + 1))
    sleep 5
  done
  return 1
}
# 保留覆盖中的其他配置，只替换四个目标服务的镜像。
set_images() {
  awk -v image="$1" '
    /^  [^ ]/ { target = ($0 ~ /^  (setup|api|worker|web):/) }
    target && /^    image:/ { print "    image: " image; next }
    { print }
  ' "$release" > "$release.tmp" || return 1
  mv "$release.tmp" "$release"
}
set_setup_command() {
  setup_command='node scripts/migrate.ts'
  if [ "$SEED_TOPICS_ON_RELEASE" = true ]; then setup_command="$setup_command && node scripts/seed.ts --topics-only"; fi
  awk -v command="$setup_command" '
    /^  [^ ]/ { target = ($0 ~ /^  setup:/) }
    target && /^    command:/ { print "    command: [\"sh\", \"-c\", \"" command "\"]"; target = 0; next }
    { print }
  ' "$release" > "$release.tmp" || return 1
  mv "$release.tmp" "$release"
}
cleanup() {
  release_dirs=$(for dir in backups/release-*; do
    [ -d "$dir" ] || continue
    printf '%s\n' "$dir"
  done)
  release_dirs=$(printf '%s\n' "$release_dirs" | LC_ALL=C sort -r)
  printf '%s\n' "$release_dirs" | sed '1,3d' | while IFS= read -r dir; do
    rm -rf "$dir" || printf '清理备份失败：%s\n' "$dir"
  done
  if image_ids=$(docker_cmd image ls --no-trunc --format '{{.ID}}' "$IMAGE_REPO"); then
    image_ids=$(printf '%s\n' "$image_ids" | sort -u)
    printf '%s\n' "$image_ids" | while IFS= read -r image_id; do
      [ -n "$image_id" ] || continue
      [ "$image_id" != "$new_image" ] && [ "$image_id" != "$previous_image" ] || continue
      docker_cmd image rm "$image_id" || printf '清理镜像失败：%s\n' "$image_id"
    done
  else
    printf '列出仓库镜像失败，跳过镜像清理\n'
  fi
}
write_release() {
  setup_command='node scripts/migrate.ts'
  if [ "$SEED_TOPICS_ON_RELEASE" = true ]; then setup_command="$setup_command && node scripts/seed.ts --topics-only"; fi
  cat > "$release" <<YAML
services:
  setup:
    image: $1
    pull_policy: never
    command: ["sh", "-c", "$setup_command"]
  api:
    image: $1
    pull_policy: never
  worker:
    image: $1
    pull_policy: never
  web:
    image: $1
    pull_policy: never
YAML
}
finish() {
  code=$?
  trap - 0 HUP INT TERM
  set +e
  if [ "$rollback_needed" = true ] && [ "$result" != success ]; then
    printf '步骤 %s 失败，回退应用\n' "$step"
    if [ "$new_migrations" = true ]; then
      printf '数据库已迁移，旧应用需兼容（迁移可能已部分执行）\n'
    fi
    restored=true
    if [ -f "$backup/compose.release.yml" ]; then
      cp "$backup/compose.release.yml" "$release" && set_images "$previous_image" || restored=false
    else
      write_release "$previous_image" || restored=false
    fi
    # 不启动依赖，避免失败的 setup 被 Compose 再次执行；旧 ID 不受 latest 变更影响。
    if [ "$restored" = true ] && compose up -d --no-deps --no-build --pull never api worker web && retry_health; then
      result=rolled_back
    else
      result=failed
    fi
    code=1
  fi
  now=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  printf '{"version":"%s","previous_image":"%s","result":"%s","step":"%s","time":"%s"}\n' \
    "$version" "$previous_image" "$result" "$step" "$now" > "$status_dir/last-result.json"
  printf '版本 %s，结果 %s，步骤 %s\n' "$version" "$result" "$step"
  printf '版本 %s，结果 %s，步骤 %s\n' "$version" "$result" "$step" >&3
  if [ -n "${NOTIFY_WEBHOOK_URL:-}" ]; then
    warning=
    if [ "$new_migrations" = true ] && [ "$rollback_needed" = true ] && [ "$result" != success ]; then
      warning='；数据库已迁移，旧应用需兼容'
    fi
    curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
      -d "{\"text\":\"SoyMilk $version $result $step$warning\"}" "$NOTIFY_WEBHOOK_URL" >/dev/null 2>&1 || :
  fi
  rmdir "$lock"
  exit "$code"
}
trap finish 0
trap 'exit 1' HUP INT TERM
# 解析失败也留下本次日志与 failed 状态。
exec 3>&1
printf '发布日志：%s/%s-<版本>.log\n' "$status_dir" "$stamp"
exec >> "$status_dir/$stamp-resolve.log" 2>&1
mkdir -p "$backup"
sha256sum docker-compose.yml deploy/nas/compose.sh deploy/nas/database-url.sh deploy/nas/compose.override.yml \
  deploy/nas/compose.codex-worker.yml deploy/nas/compose.web-time.yml > "$backup/config-before.sha256"
resolve_version
mv "$status_dir/$stamp-resolve.log" "$status_dir/$stamp-$version.log"
printf '目标版本 %s\n' "$version"
image="$IMAGE_REPO:$version"
step=current
container=$(compose ps -q api)
[ -n "$container" ]
previous_image=$(docker_cmd inspect --format '{{.Image}}' "$container")
for service in setup api worker web; do
  container=$(compose ps -a -q "$service")
  [ -n "$container" ]
  actual=$(docker_cmd inspect --format '{{.Image}}' "$container")
  [ "$actual" = "$previous_image" ]
done
if [ -f "$release" ]; then
  release_image=$(awk '
    /^  [^ ]/ { api = ($0 ~ /^  api:/) }
    api && /^    image:/ { gsub(/["\047]/, "", $2); print $2; exit }
  ' "$release")
  [ -n "$release_image" ]
  actual=$(docker_cmd image inspect --format '{{.Id}}' "$release_image")
  [ "$actual" = "$previous_image" ]
fi
current_version=$(docker_cmd run --rm --entrypoint node "$previous_image" -p 'JSON.parse(require("fs").readFileSync("/app/package.json", "utf8")).version')
if ! version_not_lower "$current_version" "$version"; then
  printf '目标版本 %s 低于当前运行版本 %s，拒绝无确认降级\n' "$version" "$current_version" >&2
  exit 1
fi
if [ "$current_version" = "$version" ]; then
  printf '已是最新\n'
  result=noop
  rm -rf "$backup"
  exit 0
fi
step=pull
run docker_cmd pull "$image"
new_image=$(docker_cmd inspect --format '{{.Id}}' "$image")
image_version=$(docker_cmd run --rm --entrypoint node "$image" -p 'JSON.parse(require("fs").readFileSync("/app/package.json", "utf8")).version')
[ "$image_version" = "$version" ]
step=backup-config
for file in compose.release.yml compose.override.yml compose.codex-worker.yml compose.web-time.yml; do
  if [ -f "deploy/nas/$file" ]; then cp "deploy/nas/$file" "$backup/$file"; fi
done
step=migrations
docker_cmd run --rm --entrypoint ls "$previous_image" /app/database/migrations > "$backup/migrations-old.txt"
sort -o "$backup/migrations-old.txt" "$backup/migrations-old.txt"
docker_cmd run --rm --entrypoint ls "$image" /app/database/migrations > "$backup/migrations-new.txt"
sort -o "$backup/migrations-new.txt" "$backup/migrations-new.txt"
grep -vxFf "$backup/migrations-old.txt" "$backup/migrations-new.txt" > "$backup/migrations-added.txt" || [ "$?" -eq 1 ]
if [ -s "$backup/migrations-added.txt" ]; then
  new_migrations=true
  printf '新增迁移（随发布自动执行）：\n'
  cat "$backup/migrations-added.txt"
fi
step=backup-data
if [ "$new_migrations" = true ] || [ "$SEED_TOPICS_ON_RELEASE" = true ]; then
  compose exec -T db pg_dump -U aihot -d aihot -Fc > "$backup/db.dump"
  compose exec -T db pg_restore --list < "$backup/db.dump" > "$backup/database-contents.txt"
  [ -s "$backup/database-contents.txt" ]
  if [ "$SEED_TOPICS_ON_RELEASE" = true ]; then
    compose exec -T db psql -X -U aihot -d aihot -At -F '\t' -c "SELECT slug,name,grp,entity_id,tags,definition,related,position FROM topics ORDER BY slug" > "$backup/topics-before.tsv"
  fi
else
  printf '无新迁移，跳过数据库备份\n'
fi
container=$(compose ps -q db)
[ -n "$container" ]
docker_cmd inspect --format '{{.Id}} {{.Image}} {{.State.StartedAt}}' "$container" > "$backup/db-before.txt"
step=drain
if run compose stop -t 230 worker &&
  container=$(compose ps -a -q worker) && [ -n "$container" ] &&
  worker_exit=$(docker_cmd inspect --format '{{.State.ExitCode}}' "$container") && [ "$worker_exit" = 0 ] &&
  pending=$(compose exec -T db psql -X -U aihot -d aihot -At -c "SELECT count(*) FROM receipt_attempts WHERE status='pending'") && [ "$pending" = 0 ]; then
  :
else
  compose up -d --no-deps --no-build --pull never worker
  exit 1
fi
# 排空确认通过后才准备应用恢复，避免后续写覆盖失败留下停机。
rollback_needed=true
step=stop
run compose stop -t 30 api web
step=override
if [ -f "$release" ]; then set_images "$image"; set_setup_command; else write_release "$image"; fi
step=setup
run compose run --rm --no-deps setup </dev/null
if [ "$SEED_TOPICS_ON_RELEASE" = true ]; then
  compose exec -T db psql -X -U aihot -d aihot -At -F '\t' -c "SELECT slug,name,grp,entity_id,tags,definition,related,position FROM topics ORDER BY slug" > "$backup/topics-after.tsv"
  if diff -u "$backup/topics-before.tsv" "$backup/topics-after.tsv" > "$backup/topics.diff"; then
    printf 'topics 未变化\n'
  else
    diff_status=$?
    [ "$diff_status" -eq 1 ] || exit "$diff_status"
    printf 'topics 发生变化，差异保存在 %s/topics.diff\n' "$backup"
  fi
fi
if [ "$new_migrations" = true ]; then
  step=compatibility
  # Apply the new schema first, then run the old image against it before starting the new services.
  set_images "$previous_image"
  run compose run --rm --no-deps --entrypoint node worker --input-type=module -e 'import postgres from "postgres"; const db=postgres(process.env.DATABASE_URL); await db`SELECT 1 FROM articles LIMIT 0`; await db`SELECT 1 FROM receipts LIMIT 0`; await db.end();'
  set_images "$image"
fi
step=start
run compose up -d --no-build --pull never setup api worker web
step=verify
sleep 5
for service in setup api worker web; do
  if [ "$service" = setup ]; then
    container=$(compose ps -a -q "$service")
  else
    container=$(compose ps -q "$service")
  fi
  [ -n "$container" ]
  actual=$(docker_cmd inspect --format '{{.Image}}' "$container")
  [ "$actual" = "$new_image" ]
done
container=$(compose ps -a -q setup)
[ "$(docker_cmd inspect --format '{{.State.ExitCode}}' "$container")" = 0 ]
container=$(compose ps -q db)
[ -n "$container" ]
docker_cmd inspect --format '{{.Id}} {{.Image}} {{.State.StartedAt}}' "$container" > "$backup/db-after.txt"
diff "$backup/db-before.txt" "$backup/db-after.txt"
sha256sum docker-compose.yml deploy/nas/compose.sh deploy/nas/database-url.sh deploy/nas/compose.override.yml \
  deploy/nas/compose.codex-worker.yml deploy/nas/compose.web-time.yml > "$backup/config-after.sha256"
diff "$backup/config-before.sha256" "$backup/config-after.sha256"
retry_health
attempt=0
until compose exec -T web node scripts/smoke.ts --base "$WEB_SMOKE_BASE"; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 3 ] || exit 1
  sleep 5
done
result=success
cleanup || :
