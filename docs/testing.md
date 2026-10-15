# 隔离回归测试

2026-10-13 起本站取消 GitHub CI、自动镜像发布与 NAS 自动部署，测试由维护者在独立环境手动运行。[历史验收记录](archive/testing-20261015.md)中的 CI、自动部署测试数量和发布结果仅为历史记录；现已删除自动部署专属测试，不能将旧套件总数当作当前数量。

测试只写入迁移完成的独立空库，数据库名必须以 `_test` 或 `_ci` 结尾。禁止连接生产库、挂载生产数据卷或复制环境文件及授权凭据。NAS 上用独立检查容器和 `--internal` Docker 网络，仅让检查容器与临时 PostgreSQL 相互连接；不发布数据库端口，不使用正式 Compose 项目运行测试。

## 2026-10-16 NAS 3.5.1 验收与正式部署

源码 `main@14374c8aef58d7bd758cfddba777944ae4784d37`，NAS 以 `deploy/nas/Dockerfile` 构建两个唯一 Bookworm 镜像：正式镜像 `57a57ba83fde`，带开发依赖的检查镜像 `3c003005c549`。运行环境为 Node.js 24.21.0、PostgreSQL 17.11、pg-boss 12.35.0。

- 检查镜像内 `npm run typecheck`、网页生产构建和网页 **56/56** 通过；NAS 独立 `--internal` 网络、tmpfs 新空库的 `npm test` 完整后端 **740/740**，失败／取消／跳过均为 0，**307.993 秒**。相对本地本轮 740 项数量相同，相对 PR #7 基线 694 项增加 46 项。
- 实际精简正式镜像在独立新空库完成迁移、44 个主题、30 项冒烟、真实密码后台登录、四个定价／费用／目录／补算 HTTP 读取接口，以及预览／创建／继续／选中补算视图；结束时 receipts 与 attempts 均为 0。五工具 MCP 合约由独立检查镜像通过；生产镜像未安装开发依赖。
- 独立旧 3.4.6 镜像建立 schema 42 和 created／active／retry／failed 四种任务，新运行库升级至 43 后逐一比较全部旧字段与微秒时间，结果不变；旧 12.34 运行库在 43 上成功继续并完成任务。队列辅助脚本先修正了默认导入和 Date／JSON 微秒表示差异，每次均重建隔离夹具，最终未放宽业务断言；首次日志一并保留。
- 正式镜像 516 个源码／配置／测试文件逐一 SHA-256 与提交一致，锁文件完整 JSON 一致。测试安全阀关闭，使用虚构凭据、独立数据目录和本进程绑定的模型替身，无生产数据库／数据卷／授权或外部付费服务；网络核验在回归之外只读执行。临时测试容器和网络在留存日志后已移除。

使用者具体确认后，于北京时间 **00:12:18** 完成正式切换。数据库／附件／旧应用和覆盖已备份，应用迁移 0045—0047 与 queue schema 42→43 成功；停稳前后原 receipts／attempts／队列任务的数量与原始字段 hash 一致。内网及 Tailscale 各 30 项冒烟、五工具 MCP、Hermes 原生客户端、四个后台生产读取函数及匿名 401 鉴权通过；models.dev 正式同步成功且自定义规则不变。模型、预算和保护配置前后一致，未运行真实模型试调用、自动补算或生产写库回归；运行快照见[维护说明](soymilk-operations.md#2026-10-16-模型定价正式上线)。

部署辅助脚本首次经 SSH stdin 执行时，Compose 的交互输入使脚本在 setup 后结束；当时仅完成幂等 setup，尚未启动新版业务进程。改为先保存 NAS 脚本再执行，重跑 setup 并完成队列升级、历史摘要比较和启动。Hermes 辅助客户端首次存在旧 SDK 导入问题，按其现有安装 API 修正后在切换前后均通过；未改 Hermes 配置或授权。最终环境核对先发现 Docker 返回变量顺序不同，逐项确认值一致后改为按键排序比较，保留首次日志。以上辅助问题没有跳过测试或改写生产数据来通过检查。

日志保存在忽略目录 `.data/release-3.5.1-14374c8-20261015/`：NAS `nas/logs/backend-nas.log`、`build-checks.log`、`production-smoke.log`、`production-mcp.log`、`queue-compat.log` 及辅助首次日志；正式切换的 `stop-and-backup.log`、`migrate-and-start.log`、`production-after.json`、`postdeploy.json`、`production-smoke.log`、`tailscale-smoke.log`、`production-mcp.log`、`hermes-after.log`、`catalog-sync.log`、`final-runtime.json` 和源码清单。数据库备份只保留在 NAS 私有备份目录，不下载或提交。后续源码或维护文档修改不自动部署。

## 2026-10-15 本地续接模型定价候选 3.5.1

本机 `wujingwei/model-pricing@bcf86f0` 最初只有定价基础实现，前一开发环境的后续改动未提交、未推送，因此本地没有这些内容。本轮从可读取的开发记录恢复代码并核对，再直接在当前项目重新验证；前一环境的历史通过数字不作为本轮结果。

- 完整后端 **740/740**，失败、取消、跳过均为 0，**137.847 秒**；相对 PR #7 的 694 项比较基线增加 46 项。定价、目录、费用、补算、回执事务及信源统计相关 **52/52**，同样零失败、取消和跳过，6.044 秒。
- 完整网页 **56/56**，失败、取消、跳过均为 0，**2.950 秒**；比原 44 项增加 12 项，包含真实生产 SSR。`npm run typecheck`、`npm run check:version`、网页生产构建通过。
- 新空站点初始化 44 个主题后，**30 项冒烟**、五个公开 MCP 工具合约、`/admin/models` 及四个价格／费用／目录／补算只读接口通过。真实 HTTP 的预览、创建、继续及选中补算视图通过；结束时 receipts／attempts 均为 0，实际 OpenAPI 为 `3.5.1`。
- 从旧 `main@a518ad8` 的 41 个迁移开始，插入 **5 万条合成请求**后应用 `0045`—`0047`，迁移进程共 70 ms（含 Node 启动，不代表生产锁等待）。原金额、币种、用量、状态及时间字段 hash 一致。旧 `3.4.7` 应用在新结构上写入并复用同一回执，只执行一次本地响应；原实际金额不变、快照保持为空。新版定价及旧记录未知归属继续正确。EXPLAIN 使用新增时间索引，最近 40 条查询执行 0.026 ms、3 个 buffer hits，仅为本轮合成夹具结果。
- 本机在测试之外只读取得 models.dev 在线 HTTP 200、JSON 响应，并用当前解析器核验结构；统计和边界见[夹具来源](../tests/fixtures/models-dev-prices.md)。测试全程仅用冻结夹具与进程登记的本地／内存替身；未调用真实模型或访问生产服务。

本轮使用 Node.js **24.22.0**、PostgreSQL **16.15**、pg-boss **12.35.0**，通过独立 user/network namespace 仅启用 loopback；PostgreSQL 安装包解压到临时目录，不改系统服务。`soymilk_pricing_focused_test`、`soymilk_pricing_acceptance_test`、`soymilk_pricing_upgrade_test`、`soymilk_pricing_smoke_test` 均为独立新库。环境清空后显式指定虚构凭据、空授权目录和临时数据目录，采集、模型、飞书及 IndexNow 环境安全阀保持关闭，没有加载生产环境文件。各次产品检查均通过，无跳过用例；补丁恢复与验收辅助脚本的问题已在正式检查前修正，未放宽业务断言或预算。

日志保存在忽略目录 `.data/checks/model-pricing-20261015/`：`focused.log`、`backend.log`、`typecheck.log`、`version.log`、`build.log`、`web.log`、`smoke-acceptance.log`、`mcp-acceptance.log`、`admin-http.log`、`upgrade.log`、`old-runtime.log`、`new-runtime.log`、`live-catalog.json` 及最终源码 SHA-256 清单。数据库服务已停止，临时数据库与辅助源码在留存日志后清理。以上为开发验收结束时的快照；随后提交、推送与 PR 状态以仓库记录为准。该本地验收阶段未进行生产迁移或部署；2026-10-16 的后续 NAS 验收和正式切换见本页前节。

## 最近完整基线

2026-10-15，PR #7 合并前的最终隔离验收为后端 **694/694**、网页 **44/44**，类型、版本、构建和 30 项空站点冒烟通过；pg-boss 实际版本为 **12.35.0**。这是修复前的比较基线，不代表后续定价改动已经通过。详细失败、复核与日志见[历史记录](archive/testing-20261015.md#2026-10-15-pr-7-队列领取轮次补修)。

## 模型替身与安全阀

`tests/setup.ts` 将采集、模型、飞书和 IndexNow 环境开关设为 false，隔离凭据目录，并为每个测试文件创建临时数据目录，退出时清理。未配置的模型连接使用空测试密钥和本机不可用地址，避免继承真实服务配置。

需要模型流程的用例先创建 `stub()`，再显式绑定：

```ts
import { stub, useModelStubs } from "./setup.ts";

const provider = await stub(() => ({ choices: [{ message: { content: '{"ok":true}' } }] }));
await useModelStubs({ DEEPSEEK: provider.url });
```

`useModelStubs` 只接受本测试进程由 `stub()` 创建且尚未关闭的服务，写入虚构的测试密钥，并临时开启内存中的模型入口；环境变量开关仍为 false。这样可以验证评分、回执、预算、归组与恢复流程，不调用真实模型。关闭安全阀的用例仍验证请求在发送前被拒绝。独立子进程测试必须显式指向本地替身，并在隔离网络内运行。

## 共享数据库与断言

整个套件按文件串行运行，因为用例共享预算及队列。文件之间的行即使有唯一标签，也可能被全库恢复扫描选中；涉及扫描时应检查本用例文章的完整任务集合及重复执行的稳定性，不能把全库返回数量当成本信源的数量。使用真实队列 worker 的用例要临时停放其他用例的任务，结束后恢复。

缓存前后的评分、决策、覆盖率和已记录 token 应相等；墙钟耗时分别验证为有限非负数。缓存会改变耗时，不能要求首次计算与缓存复用耗时相等，也不强制要求每次缓存调用都更快。

## 运行

```sh
npm run typecheck
DATABASE_URL=postgres://127.0.0.1:5432/soymilk_test node scripts/migrate.ts
DATABASE_URL=postgres://127.0.0.1:5432/soymilk_test npm test
npm run build -w @aihot/web
node --test apps/web/tests/*.test.ts
node scripts/smoke.ts --base http://实际站点地址:3000
```

后端测试需要带开发依赖的检查环境及 PostgreSQL 工具；NAS 的检查镜像、数据库和网络与生产服务独立。记录测试总数、失败及取消项；遇到失败先修正替身和隔离，再复核业务行为，不跳过断言或通过真实付费请求让测试变绿。冒烟检查使用真实访问主机，MCP 会拒绝未配置的内部容器别名。

`scripts/mcp-check.ts` 使用开发依赖中的 MCP 客户端，应从本机或检查环境执行；精简生产镜像没有该客户端，不在生产镜像临时安装开发依赖。部署后的公开接口合约可以从检查环境只读核验，不执行后端写库测试。
