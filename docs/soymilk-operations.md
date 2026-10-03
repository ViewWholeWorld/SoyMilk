# SoyMilk 当前维护说明

本文件说明当前维护方式。运行计数和首轮状态必须现场查询；[信源记录](soymilk-feeds.md)与[复用实测](codex-reuse-benchmark.md)中的数字是带日期的历史快照。

## 站点与模型

- 站名 SoyMilk，游戏、AI、科技、经济、娱乐五个兴趣领域；行业包有 42 个 RSS 和 44 个主题。各源使用七天新闻窗口，首次导入上限为 2 条，公开摘要与原文链接。
- NAS 项目目录 `/share/homes/tromso/apps/soymilk`，已配置 SSH 别名 `beans-nas`。内网访问 `http://192.168.1.62:3000`，Tailscale 访问 `http://100.89.232.66:3000`。本站采用使用者选择的 HTTP 私网方式。
- `/admin/models` 统一管理 API Key 连接、Codex 账号、默认模型及各能力的模型与 reasoning effort。现有默认连接为 gpt-6-luna，使用模型默认强度；目录返回的默认值可能变化，应从当前账号目录确认，不统一假定为 medium。
- 采集、模型调用已获授权开启；飞书与 IndexNow 关闭。原文抓取失败时保留可取得的 RSS 标题摘要；`JINA_BODY_FALLBACK=false`，不假装取得全文或绕过付费墙。
- worker 已开启 `CODEX_REUSE_ENABLED=true`、`CODEX_CONCURRENCY=2`、`ANALYZE_CONCURRENCY=2`。连接按两分钟一批复用，空闲两秒释放；账号管理让路、订阅耗尽等待和限流降到单路的保护同时生效。实际服务状态必须检查，不能依据旧标签判断。

## 首轮预算和用量

首轮固定捕获 745 篇，临时限额 30/分钟、600/小时、10000/24小时；文章与关联事件任务结束后，worker 每五分钟的检查自动恢复 10/分钟、120/小时、600/24小时，并重新开始站内预算计数。开放最长 48 小时；此轮到期时间为北京时间 2026-10-05 04:34:53。管理员手动改限额时自动恢复退出，保留手动设置。账号订阅额度不会被站内计数重置。

北京时间 2026-10-03 11:22:58 的只读核验为 active，剩余 174 篇、失败 0、缺失 0、待完成事件任务 4 个，实际限额与临时状态一致。累计已报告输入 31,713,695 token、输出 431,807 token；明确报告缓存的输入 27,155,168 token，其中命中 19,558,400 token，加权缓存率 72.02%。历史缺少缓存明细的 4,558,527 输入 token 保持未知。这是核验时的快照，后续以如下查询为准：

```sh
ssh beans-nas
cd /share/homes/tromso/apps/soymilk
sh deploy/nas/compose.sh ps
sh deploy/nas/compose.sh exec -T api node --input-type=module <<'JS'
import { bootstrapBudgetStatus } from '@aihot/backend/operations/bootstrap-budget';
import { modelsOverview } from '@aihot/backend/admin/models';
import { sql, closeDb } from '@aihot/backend/db';
console.log(JSON.stringify({bootstrap:await bootstrapBudgetStatus()}));
console.log(JSON.stringify({tokenSummary:(await modelsOverview()).tokenSummary}));
console.log(JSON.stringify({budgets:await sql`SELECT service,per_minute,per_hour,per_day,window_started_at FROM budgets WHERE service='llm'`}));
await closeDb();
JS
```

以上查询不调用模型，仅输出统计。不要读取或输出环境文件、密钥、授权文件或完整连接配置。缓存率按明确报告缓存状态的输入 token 加权；缺少缓存明细的历史请求保持未知。推理 token 已包含在输出内，回执复用不重复计入。

达到站内次数上限后等待窗口，订阅额度耗尽后等待重置；正常等待不等于 worker 故障。保持既有回执与请求身份，不通过重评、更换账号或自动提高限额消除等待。恢复遗漏时先修复 worker，必要时调用现有 `reconcileBootstrapBudget()` 接续恢复，不手工覆盖其状态。

## 更新时间与页面

审查修复版本在后台收紧信源全文许可或公开参与方式时，同一事务更新已有公开投影、搜索与精选同步账本，API 进程读取缓存时核对权限版本。此操作不依赖 worker，也不触发模型调用；权限扩大及普通元数据修改仍由 worker 重建。详见[信源许可](sources.md#分级参与方式与全文)。已下载的 HTTP 响应按各出口原有缓存时间过期，不能据此保证客户端立即删除旧副本。本轮修复先在本地分支验证和提交，正式 NAS 的行为仍以实际运行版本为准。

NAS 的 Hermes 容器已增加 SoyMilk MCP 和 `soymilk-news` 技能，原有 MCP 与模型设置保持不变。连接使用网页在 `agent-net` 上的固定内部地址，网络覆盖保存在私有 `compose.web-time.yml`，后续更新必须保留；见 [Hermes 接入](hermes.md)。这只是公开内容读取，不触发新闻模型任务，也不增加管理员能力。

左侧为收录或事件进展时间，使用北京时间；模型排队不会改写时间轴。首次集中采集会令多篇文章显示相同分钟，详见[时间轴与时区](timeline-time.md)。

更新 NAS 统一通过 `deploy/nas/compose.sh`，该入口加载私有 NAS 覆盖、`compose.codex-worker.yml` 和 `compose.web-time.yml`。这些 NAS 覆盖文件保存在部署目录，不应误以为仅运行根目录 Compose 就会保留正式配置。

自动部署启用后，入口在三个既有私有覆盖之后加载 `compose.release.yml`，统一固定 setup/API/worker/web 的镜像摘要。后续手动部署也须核对这个最后覆盖，不能只重建根目录镜像或修改较早的 worker/web 覆盖却仍运行旧版本。环境、网络、卷及并发设置仍来自原私有覆盖。

上游自动同步由 `Sync Upstream` 每小时检查，先构造候选并运行完整 `Check`，通过后才推进 `main`。冲突、受保护的定制/迁移/部署/模型保护文件变更会暂停并创建 Issue；详见[自动更新](auto-deploy.md)。

`Check` 的两个验证作业通过后发布 Bookworm NAS 镜像及 `deployment-channel` 固定摘要清单。独立 `soymilk-auto-deploy` 容器每 15 分钟自行拉取，Docker 重启策略覆盖 NAS 重启，不依赖电脑或系统 cron。部署前正常结束 worker 任务并备份数据库与附件，验证后记录 `.data/auto-deploy/status.json`；失败只回退应用镜像，保留数据库与付费回执。任何数据库迁移或基础 Compose 变化暂停等待人工确认，NAS 推送通知尚未配置。

北京时间 2026-10-03 11:20:39 已部署网页时间说明，web 镜像为 `soymilk-nas-web:timeline-time`，SHA256 为 `1bd5f533ea1a485029428603fec687f779c34da4b427ae43da4a7a54f443fbb4`。API 和 worker 的容器 ID、镜像及启动时间保持原样，继续使用 `soymilk-nas-app:codex-worker`。网页回退点为 `backups/web-time-20261003-112033`，保留原覆盖入口和旧网页镜像，不涉及数据库恢复；后续维护仍须现场核对实际镜像。

先按 feature 提交经过验证的代码，再进入下一项。部署前保存当前镜像与覆盖入口；仅改网页时只替换 web。API 无 Docker 健康检查字段时使用 `/api/health` 的实际 HTTP 响应。已计费的请求必须保留，代码回退时不通过恢复旧数据库覆盖新回执。

## 验证现况

2026-10-03 测试修复后，完整隔离空库回归 **615 项全部通过，失败、取消、跳过均为 0**，耗时约 784 秒。类型检查、网页构建、31 项网页测试和 34 项正式站点冒烟检查也通过。

北京时间 2026-10-03 13:19，[GitHub Check #1](https://github.com/ViewWholeWorld/SoyMilk/actions/runs/37099294769) 在提交 `fd58b0c` 上完成：`check` 和 `docker` 两个作业全部通过，完整后端回归 615 项全部通过，失败、取消、跳过均为 0，耗时约 131 秒，与上述隔离空库基线一致。类型检查、网页构建、31 项网页测试、空站点冒烟及 MCP 合约检查、Docker 构建与启动检查也通过；空站点尚无模型榜数据，三个模型榜页面按既有冒烟规则未检查。本机重新运行类型检查、网页构建和 31 项网页测试，以及正式站点的 34 项只读冒烟检查，均通过。

该 fork 的 GitHub Actions 已启用，后续 `main` 推送和 PR 更新会运行 `.github/workflows/check.yml`，也可手动选择分支运行。首次核验通过后，[PR #1](https://github.com/ViewWholeWorld/SoyMilk/pull/1) 于北京时间 2026-10-03 13:22 合并到 SoyMilk 的 `main`，合并提交为 `860e95f`，保留各功能的独立提交。本地 `main` 跟踪 `origin/main`；上游更新继续从 `upstream/main` 获取并合并，不能用上游分支覆盖本站定制。

修复仅涉及测试、CI 与文档：需要模型的用例显式绑定本进程创建的本地替身，每个文件独立临时数据目录，不继承真实模型配置；全库队列扫描断言检查本信源的准确任务集合；评分缓存断言将墙钟耗时与决策、用量指标分开。新增三项检查验证外部地址、未注册或已关闭替身不能打开模型入口。测试默认环境开关关闭，模型流程仅在内存中放行本地替身，详见[隔离回归测试](testing.md)。

本次检查使用独立 Docker 内部网络和临时 `_test` PostgreSQL，不挂载生产数据或授权目录。正式 API、worker、网页镜像及预算未改；测试服务已清理。统计日志保存在忽略目录 `.data/checks-test-fixes-full.log` 和 NAS 构建目录同名文件。

### 历史：时间说明部署时的验证

2026-10-03 时间说明修改：类型检查、网页构建、31 项网页测试、手机宽度的精选与全部动态显示，以及 NAS 候选镜像的两项 Linux SSR 检查通过。正式部署后从内网实际访问地址运行 34 项公开页面、API、RSS、MCP 冒烟检查全部通过；MCP 对内部容器别名 `web` 的 Host 拒绝属于现有策略，测试应使用实际站点主机。

完整隔离回归 612 项中 560 通过、51 失败、1 取消；此前为 562 通过、49 失败、1 取消。

比旧基线多出现的两项失败是 `core-source-promotion` 的恢复数量断言，以及 `selection-eval-runtime` 将缓存前后的 `wallSeconds` 纳入相等比较（本次 1 秒与 0 秒）。本次完整运行耗时约 880 秒，旧基线约 338 秒。

当时在另一个独立空测试库仅复核这两项：恢复数量测试通过；评测测试仍因 `wallSeconds` 为 1 秒与 0 秒失败，决策、准确率、token 和平均延迟等其余字段一致。当时未修改共享扫描和耗时断言，因此该阶段不能宣称全套通过。后续测试修复及完整通过结果见本节开头；这段历史不再代表当前测试状态。时间说明未修改后端业务代码，检查使用隔离网络及测试库，未访问生产数据库或模型。
