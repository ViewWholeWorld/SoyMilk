# NAS 手动部署

2026-10-13 使用者确认已删除自动部署容器及 CI，并要求取消这些机制。仓库不再提供 GitHub CI、自动镜像发布、发布频道轮询或自动部署脚本。应用自身的采集、模型任务、预算恢复和数据库备份定时任务继续按原配置运行。

## 更新前

1. 在独立开发环境验证候选代码，检查方法见 [隔离回归测试](testing.md)。测试不连接生产数据库、模型或外部付费服务。没有运行的检查说明原因，不以历史通过结果替代本次验证。
2. 核对 NAS 当前容器、镜像和迁移；新增迁移、基础 Compose 或受保护定制变更取得具体授权后再部署。NAS 目录 `/share/homes/tromso/apps/soymilk` 不是 Git checkout，不能直接 `git pull`。
3. 将经过验证的源码单独准备为候选构建目录，排除环境文件、密钥、授权目录、数据及 Git 目录。使用 `deploy/nas/Dockerfile` 的 Bookworm 镜像构建，不使用根目录的 Trixie 镜像。新镜像使用唯一标签，记录源提交及镜像 ID；不要覆盖旧镜像标签。
4. 保存当前运行镜像 ID、最后的镜像覆盖及三个私有覆盖作为应用回退点。保留已有生产环境文件、数据卷、模型账号、预算、worker 复用与并发 2，以及 Hermes 的固定内部网络。

`3.5.1` 中包含的 PR #7 队列审核补修将 pg-boss 从 `12.34.0` 升到 `12.35.0`，以保护处理器和延迟事务只结算自己领取的任务轮次。该依赖的内部 schema 从 **42 升为 43**，包括队列统计及死信溯源字段和索引；虽未新增本站 `database/migrations/` 文件，仍属于需要具体授权的数据库变更。部署前只读确认现场依赖与队列 schema，取得授权后再启动候选 API／worker；内部升级由首个初始化 pg-boss 的进程执行，不能以本站 setup 的应用迁移完成推定队列结构已升级。2026-10-16 已具体确认并完成两类升级，当前快照见[维护说明](soymilk-operations.md#2026-10-16-模型定价正式上线)；后续部署仍须按现场起点判断。保留原队列、任务、预算和回执，不重建队列来消除旧任务。隔离升级验证及仅回退旧队列运行库的检查见 [本轮队列验收](archive/testing-20261015.md#2026-10-15-pr-7-队列领取轮次补修)；这些检查不是生产部署授权。

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

## 模型定价 3.5.1 的升级检查

2026-10-16 使用者具体确认后已完成 NAS 首次升级，见[正式发布快照](soymilk-operations.md#2026-10-16-模型定价正式上线)。以下清单保留给其他环境或后续升级，不构成新的生产变更授权。本版包含 `0045_model_pricing.sql`（目录、规则、attempt 可空列与连接时间索引）、`0046_model_cost_backfills.sql`（独立补算表）和 `0047_model_cost_time.sql`（live 模型时间索引），总计 44 个本站迁移。不得修改或跳过旧迁移，也不在迁移时回填旧金额。

1. 先只读核对现场 attempt 数量、索引大小和磁盘余量，再在独立合成数据测试库评估迁移耗时；不把生产备份或数据卷接入回归。现场迁移还须考虑锁等待。`0045` 追加列和普通索引、`0047` 普通索引会持有表锁；setup 应在旧 worker 请求结束且 API 停止后运行。合成 5 万条记录上 `0045`＋`0046` 进程总耗时约 194 ms，`0047` 约 118 ms（含 Node 启动），不是生产耗时承诺。测试前后原始金额／用量／状态 hash 一致。
2. 按上文保存旧镜像及数据库／附件备份，构建唯一候选镜像，保持私有覆盖、授权、并发 2、预算与安全阀设置。迁移成功后再启动候选 API、worker、web。旧 API／worker 短时混用可继续写入原字段；其新请求没有价格快照时显示未知归属，不追套当前价格。网页应与 API 一起切换，旧 API 不提供新增补算接口。
3. 管理员打开 `/admin/models`，检查连接价格、费用覆盖与新旧记录；`3.5.2` 起价格在“模型价格”标签，费用与补算移至 `/admin/model-stats`。用已有记录核对，勿真实试调用模型。检查只读 `/api/admin/model-pricing`、`model-costs`、`model-price-catalog`、`model-cost-backfills` 接口。确认调价未修改连接 generation、预算或历史回执。
4. 显式点击一次目录同步，检查目标网络允许 `https://models.dev/api.json`、内容为 provider/model JSON、USD 单位与支持档位。2026-10-16 已从 NAS 正式应用成功同步并登记审计，计数仅为[带时间快照](soymilk-operations.md#2026-10-16-模型定价正式上线)；后续网络仍需现场核验。官方固定源码与本机核验见[夹具来源](../tests/fixtures/models-dev-prices.md)。网络或结构不兼容时保留旧目录，并可使用人工单价，不通过修改 URL 指向其他源来绕过检查。
5. 历史补算可先只读预览；只有管理员明确选择创建并继续时才保存独立结果，不随部署自动执行。若暂不需要，设置 `MODEL_COST_BACKFILL_ENABLED=false`；新请求定价和已有结果读取不受影响。CLI、证据映射与暂停恢复见[操作说明](model-pricing.md)。
6. 应用回退保留 `0045`—`0047`、目录、快照和补算结果，恢复旧 API／worker／web 镜像即可。已验证旧 `3.4.7` 运行库在升级后结构写入及复用回执；不回滚数据库、不删除付费记录。旧网页不展示新增费用字段，重回新版后仍可读取。

## 模型配置与统计 3.5.2 的升级检查

本版新增 `0048_model_suppliers.sql` 和 `0049_model_stats_time.sql`，总计 46 个本站迁移。`0048` 建立轻量供应商表、五个固定官方记录和 `receipt_attempts.supplier_id` 可空外键；`0049` 在事务内替换原统计时间部分索引，将仅 `requested_model` 非空的请求纳入，同时兼容旧版条件。迁移不回填已有请求或改写金额、用量和回执。索引替换会持有表锁，须取得具体授权、排空 worker、备份后运行 setup。北京时间 2026-10-16 17:22:49 已具体确认并完成 NAS 升级，见[发布快照](soymilk-operations.md#2026-10-16-模型配置与统计正式上线)；该记录不构成后续生产结构变更授权。

部署时同时切换 API 与网页，保留 worker 复用、账号、并发及预算覆盖。管理员分别核对 `/admin/models` 的两个标签和 `/admin/model-stats` 的两个标签；新接口为 `model-assignments`、`model-suppliers`、`model-stats`、`model-stats/options`、`model-attempts`，费用接口已使用供应商／型号汇总契约，明细独立读取。使用已存在的数据核对即可，不真实试调用、不自动同步目录或执行补算。

旧应用可继续向新增可空列的表写入，已有供应商记录和快照在应用回退时保留；回退不撤销数据库迁移。旧页面没有供应商选择，若回退期间编辑连接，应在恢复新版后核对其新请求归属；已保存的历史归属保持不变。
