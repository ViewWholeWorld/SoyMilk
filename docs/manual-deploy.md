# NAS 手动部署

2026-10-13 使用者确认已删除自动部署容器及 CI，并要求取消这些机制。仓库不再提供 GitHub CI、自动镜像发布、发布频道轮询或自动部署脚本。应用自身的采集、模型任务、预算恢复和数据库备份定时任务继续按原配置运行。

## 更新前

1. 在独立开发环境验证候选代码，检查方法见 [隔离回归测试](testing.md)。测试不连接生产数据库、模型或外部付费服务。没有运行的检查说明原因，不以历史通过结果替代本次验证。
2. 核对 NAS 当前容器、镜像和迁移；新增迁移、基础 Compose 或受保护定制变更取得具体授权后再部署。NAS 目录 `/share/homes/tromso/apps/soymilk` 不是 Git checkout，不能直接 `git pull`。
3. 将经过验证的源码单独准备为候选构建目录，排除环境文件、密钥、授权目录、数据及 Git 目录。使用 `deploy/nas/Dockerfile` 的 Bookworm 镜像构建，不使用根目录的 Trixie 镜像。新镜像使用唯一标签，记录源提交及镜像 ID；不要覆盖旧镜像标签。
4. 保存当前运行镜像 ID、最后的镜像覆盖及三个私有覆盖作为应用回退点。保留已有生产环境文件、数据卷、模型账号、预算、worker 复用与并发 2，以及 Hermes 的固定内部网络。

候选 `3.4.7` 的 PR #7 队列审核补修将 pg-boss 从 `12.34.0` 升到 `12.35.0`，以保护处理器和延迟事务只结算自己领取的任务轮次。该依赖的内部 schema 从 **42 升为 43**，包括队列统计及死信溯源字段和索引；虽未新增本站 `database/migrations/` 文件，仍属于需要具体授权的数据库变更。部署前只读确认现场依赖与队列 schema，取得授权后再启动候选 API／worker；内部升级由首个初始化 pg-boss 的进程执行，不能以本站 setup 的 41 个迁移已完成推定队列结构已升级。保留原队列、任务、预算和回执，不重建队列来消除旧任务。隔离升级验证及仅回退旧队列运行库的检查见 [本轮队列验收](testing.md#2026-10-15-pr-7-队列领取轮次补修)；这些检查不是生产部署授权。

构建命令示例（在候选源码目录执行；每次更新换一个唯一标签）：

```sh
DOCKER=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
export DOCKER_CONFIG="$PWD/.docker"
mkdir -p "$DOCKER_CONFIG"
chmod 700 "$DOCKER_CONFIG"
"$DOCKER" build -f deploy/nas/Dockerfile -t soymilk-nas-app:manual-20261013 .
```

## 最后的镜像覆盖

`deploy/nas/compose.sh` 保留三个私有覆盖，最后加载现有 `deploy/nas/compose.release.yml`。保留原文件名用于兼容已有部署，维护者手动修改其镜像；它不再由控制器生成。每次更新须检查 setup、API、worker、web 四个镜像，不能只改较早的 worker/web 覆盖或仅重建 `aihot-app`。

以下仅为最终覆盖的示例，镜像须先完成构建，实际更新使用本轮唯一标签或镜像 ID：

```yaml
services:
  setup:
    image: soymilk-nas-app:manual-20261013
    pull_policy: never
    command: ["sh", "-c", "node scripts/migrate.ts && node scripts/seed.ts --topics-only"]
  api:
    image: soymilk-nas-app:manual-20261013
    pull_policy: never
  worker:
    image: soymilk-nas-app:manual-20261013
    pull_policy: never
  web:
    image: soymilk-nas-app:manual-20261013
    pull_policy: never
```

此覆盖只指定镜像与 setup 命令，不替换生产环境、网络、卷或并发配置。`--topics-only` 按 slug 同步行业包主题，不导入示范信源或模型目录，也不删除其他主题。

## 切换与核验

1. 先完成候选镜像构建及检查，再在正式部署目录停止旧 worker，等待正在进行的付费请求结束：`sh deploy/nas/compose.sh stop -t 230 worker`。随后停止 API/web：`sh deploy/nas/compose.sh stop -t 30 api web`。
2. 备份数据库和 `/data` 下的 `uploads/`、`feedback-screenshots/`，保留应用回退点。数据库服务保持原样；不要执行 `down -v`。
3. 手动更新最后的镜像覆盖，保持三个私有覆盖。执行 `sh deploy/nas/compose.sh run --rm --no-deps setup`；迁移或主题同步失败时停止更新，不能继续启动新版。
4. setup 成功后执行 `sh deploy/nas/compose.sh up -d --no-build --pull never setup api worker web`。使用 `sh deploy/nas/compose.sh ps` 核对服务，逐一检查实际镜像，并通过 `/api/health` 检查 API。
5. 使用实际访问主机执行 `node scripts/smoke.ts --base http://192.168.1.62:3000`；从带开发依赖的独立检查环境运行 `node scripts/mcp-check.ts http://192.168.1.62:3000/api/mcp`。核对 worker 复用和两项并发仍为原配置，并验证 Hermes 的五个只读工具连通性。

仅更新网页且没有迁移时可只替换 web，但仍须核对最后覆盖和 Hermes 网络。NAS 日志仅筛选必要统计，不输出环境文件、密钥、授权或完整 Docker/Compose 配置。

失败时恢复保存的应用镜像覆盖并重新检查站点；不恢复旧数据库或删除付费回执。迁移及主题同步可能已经写入数据，应用回退不会撤销这些写入，兼容性应在更新前确认。

旧 `deployment-channel`、GHCR 镜像、`.data/auto-deploy/` 状态及备份保留为历史资料，本次不删除；当前版本以运行中的容器和镜像为准。后续源码提交不会自动改变线上服务。
