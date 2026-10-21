# AGENTS.md — SoyMilk 协作指南

SoyMilk 是覆盖游戏、AI、科技、经济、娱乐的私网资讯站，负责采集、模型筛选与写作、事件归组及刊物生成。先读 [README](README.md)，再按[文档索引](docs/文档索引.md)查阅任务资料；维护 NAS 先读[站点维护说明](docs/运维部署/站点维护说明.md)。使用中文沟通与编写说明，代码沿用相邻风格。

## 第一章：技术栈声明

| 层次 | 技术与约定 |
| --- | --- |
| 运行时与语言 | Node.js **24.11+**、TypeScript、ESM；后端直接运行 `.ts`，不单独构建 |
| 包管理 | npm workspaces：`apps/*`、`packages/*`、`industry`；使用 `npm ci` 和现有锁文件 |
| 网页 | React 19、React Router 8（SSR）、Vite 8、Tailwind CSS 4 |
| API | Fastify 5；共享类型与 HTTP 约定放在 `packages/contracts` |
| 数据与任务 | PostgreSQL 17、`postgres` 客户端、pg-boss 12 队列 |
| 部署 | Docker Compose；NAS 使用 `deploy/nas/Dockerfile`（Bookworm）手动构建和发布 |

必须保持的边界：

- 网页只通过 HTTP 访问 API，不访问数据库、模型或密钥。网站、RSS、公开 API、MCP 统一从 `packages/backend/src/publication/` 读取。
- 页面访问不调用模型；模型处理在 worker 中执行。付费调用经过 `providers/receipts.ts` 和预算熔断，保留请求身份、消费者及 unknown 保护。
- 公开内容匿名且不因管理员身份改变；后台仅限管理员。信源默认公开摘要和原文链接，`site_fulltext` 须有明确许可。
- 页面和定时任务使用北京时间；模型完成时间不改变时间轴，不能重复加八小时。排序与归档遵循[时间轴与时区](docs/内容管理/时间轴与时区.md)。

## 第二章：目录结构

- 项目目录或代码结构发生新增、删除、移动、重命名或职责调整时，须在同一次变更中同步更新 `AGENTS.md` 的目录结构、路径及相关说明，保持与实际项目结构一致。

```text
apps/
  api/src/                 # Fastify 入口、routes/、HTTP 响应与分享图
  worker/src/              # worker 入口 main.ts、定时任务 schedules.ts
  web/
    app/routes/            # 公开页面与 admin/ 后台路由
    app/features/          # 信息流、文章、刊物、模型配置等功能组件
    app/components/        # 公共 UI 与页面外壳
    app/lib/               # HTTP 客户端、格式化、浏览器状态等
    tests/                 # 网页回归
packages/
  contracts/src/           # 跨应用类型、HTTP 策略与 MCP 合约
  backend/src/
    sources/               # 信源采集、解析与健康诊断
    content/               # 原文提取、清洗与材料管理
    editorial/             # 预筛、评分、理解、写作与翻译
    events/                # 事件归组、关系、热度与综述
    reports/               # 日报、周报、月报生成
    providers/             # 模型适配、授权、回执、定价与限流
    publication/           # 所有公开出口的统一读取层
    jobs/                  # 队列与任务处理
    admin/                 # 后台业务与鉴权
    operations/            # 预算恢复、诊断、备份与心跳
    media/                 # 图片与媒体处理
    db.ts                  # 数据库连接
    config.ts              # 后端配置
industry/                  # 行业配置、提示词、品牌与条款
database/migrations/       # 按编号追加的数据库增量迁移
scripts/                   # 初始化、迁移、种子、冒烟、HTTP 验收与评测入口
tests/                     # 后端回归；http/ 为真实 HTTP 验收，fixtures/ 为夹具
deploy/nas/                # NAS Dockerfile、Compose 入口及私有覆盖位置
integrations/              # 可选接入示例，不代表生产已部署
assets/                    # 字体等静态资源
docs/                      # 中文操作文档、计划和历史证据
```

行业定制按[行业定制指南](docs/内容管理/行业定制指南.md)修改 `industry/`：`site.ts`、`taxonomy.ts`、`topics.json`、`sources.json`、`prompts/`、`selection.ts`、`brand/`、`pages/`。保留已确认的站名、领域、信源及分类，新策略再确认。评分保留内容类型、五维加权、噪声压制和安全边界，用标注样本[校准门槛](docs/内容管理/精选评分与校准.md)。条款／隐私模板公开上线前需用户确认；对外只使用 SoyMilk 品牌。

## 第三章：环境搭建与开发流程

### 本地开发

准备 Node.js 24.11+、npm 和独立 PostgreSQL，以下命令仅用于新开发环境：

```bash
npm ci
node scripts/init-env.ts     # 仅首次运行，拒绝覆盖已有 .env
createdb soymilk_dev
```

在本地 `.env` 配置数据库和访问地址，并显式关闭采集与模型安全阀：

```dotenv
DATABASE_URL=postgres://127.0.0.1:5432/soymilk_dev
API_BASE_URL=http://127.0.0.1:3001
SITE_URL=http://localhost:3000
COLLECT_ENABLED=false
MODEL_CALLS_ENABLED=false
```

执行迁移和种子初始化，再将三个 `dev` 命令分别放在独立终端运行：

```bash
node --env-file=.env scripts/migrate.ts
node --env-file=.env scripts/seed.ts
npm run dev:api              # API：3001
npm run dev:worker           # 队列与定时任务
npm run dev:web              # 网页：http://localhost:3000
```

修改相关模块和文档后完成第四章检查。迁移必须向后兼容、按编号追加，不重写既有迁移。Docker 安装见[首次部署指南](docs/运维部署/首次部署指南.md)。

### NAS 维护与发布

- 通过 HTTP 内网或 Tailscale IP 加端口访问，不要求 HTTPS。模型在 `/admin/models` 管理，Codex 设备授权无需 SSH 回调隧道。
- 生产采集和模型调用已授权开启；保持账号、模型、强度、预算、Codex 复用及模型／文章分析并发 **2**。不通过改请求身份、重评、换账号或提高预算加速，不为测试修改生产开关。
- 入口为 `ssh beans-nas`，部署目录 `/share/homes/tromso/apps/soymilk` 不是 Git checkout。统一用 `sh deploy/nas/compose.sh`，保留私有覆盖及最后的 `compose.release.yml`，核对 setup/API/worker/web 镜像和 setup 的 `--topics-only`。
- 已取消 CI、自动镜像发布和自动部署。发布、新增迁移、基础 Compose 及受保护定制变更须有具体授权；按[手动部署流程](docs/运维部署/生产环境手动部署.md)验证、排空 worker、备份、切换和验收。仅回退兼容应用，保留新状态、迟到分析过滤、轮次及回执消费者；不恢复旧库、删除付费记录或批量重开历史终态。
- **Hermes 已不在 NAS 部署**。旧文档的固定网络、启动与原生客户端验收要求不再适用；仓库示例仅供可选接入，公开 MCP 五个匿名只读工具继续保留。
- 不读取或输出生产 `.env`、密钥、Codex `auth.json`、令牌、完整 Docker inspect／Compose config 或未筛选日志。通过 `bootstrapBudgetStatus()`、`modelsOverview().tokenSummary` 等状态接口输出必要统计，运行计数和预算标注查询时间。

## 第四章：测试规范

- 使用独立数据库、数据目录、虚构密钥和隔离网络，不访问生产库、真实模型或外部服务。库名以 `_test` 或 `_ci` 结尾，`COLLECT_ENABLED`、`MODEL_CALLS_ENABLED` 保持关闭。
- 模型用例用 `tests/setup.ts` 的 `stub()` 与 `useModelStubs()` 绑定本进程的本地替身，仅临时放行内存入口；子进程也须显式绑定。隔离方法见[隔离回归测试](docs/开发指南/隔离回归测试.md)。
- 功能改动至少完成以下检查。纯文档检查内容、路径和差异；简单样式不额外编写测试。

```bash
npm run typecheck
# 在隔离 PostgreSQL 实例中新建空库，迁移后运行后端套件
createdb soymilk_test
DATABASE_URL=postgres://127.0.0.1:5432/soymilk_test node scripts/migrate.ts
DATABASE_URL=postgres://127.0.0.1:5432/soymilk_test npm test
npm run build -w @aihot/web
node --test apps/web/tests/*.test.ts
# 启动隔离站点后，以实际配置的访问主机验收
node scripts/smoke.ts --base http://localhost:3000
node scripts/mcp-check.ts http://localhost:3000/api/mcp
```

新增或变更 HTTP API，须同步 `tests/http/routes.ts` 和业务用例，并在**另一个未迁移空库**运行：

```bash
createdb soymilk_http_test
DATABASE_URL=postgres://127.0.0.1:5432/soymilk_http_test npm run test:http
```

HTTP 验收自行迁移，重跑另建空库。按[接口验收指南](docs/开发指南/接口验收指南.md)用合成或脱敏夹具覆盖鉴权／CSRF、正常与空结果、边界、筛选分页、冲突和幂等；仅断言 401／200 不算业务验收，外部依赖例外须登记。

后端套件按文件串行；修改分类时同步行业测试样例。报告本次通过、失败、取消、跳过及复核结果，与基线比较；不忽略历史失败，不把部分检查或历史结果写成全套通过。

## 第五章：Git 规范

详细规则见[版本控制协作规范](docs/开发指南/版本控制协作规范.md)，本文及仓库部署规范优先。

- 先检查 `git status`、`git branch -a` 和所有未提交／未跟踪改动，保留用户工作。从最新 `develop` 切 `feature/`、`bugfix/`、`refactor/`、`docs/`、`test/` 或 `chore/` 分支，不在 `main`、`develop` 直接提交。
- 一个任务一个分支。**仅在用户明确要求时提交**；分项提交获授权后，每项验证并提交再开始下一项。使用 Conventional Commits，逐文件暂存，检查 `git diff --staged` 与 `git diff --check`；不提交 `.env`、密钥、授权缓存、`.data/` 和日志。
- 日常 PR 指向 `develop`；`release/vX.Y.Z` 从 `develop` 发往 `main`，`hotfix/` 从 `main` 切出，发布后回合 `develop`。合并、推送受保护分支、标签／发版、删除远程分支或改写已推送历史须有明确授权，不跳过钩子或强推共享分支。
- 上游改动手动移植，先读[上游审查台账](docs/问题修复/上游审查台账.md)，按完整 SHA 续查、复核待办，逐项记录后推进游标。审核、实现和部署分别记录，不重新引入下线功能。
- 同步相关中文文档和索引链接。用户可见变更更新 `industry/changelog.json`，最新条目置顶；维护配置或测试调整记入[维护变更记录](docs/历史记录/维护变更记录.md)。
- 发版按 SemVer，同步根 `package.json`、锁文件根包、`PUBLIC_VERSIONS.v1OpenApi`、网站日志顶层及最新条目的 `version`，运行 `npm run check:version`。`latestVersion` 为北京时间日期时间；纯文档不升应用版本，不补造历史公告。
- 交付说明验证、分支、提交、推送、PR、合并与部署的实际状态；提交或合并不等于 NAS 已更新。

## 第六章：最近的更改

仅保留近期摘要；镜像、备份、测试计数及历史发布见[站点维护说明](docs/运维部署/站点维护说明.md)，生产状态须现场核对。

| 日期 | 更改与后续约束 |
| --- | --- |
| 2026-10-20 | 本指南重组为六章；按用户确认清理 Hermes 在 NAS 部署的过时要求。 |
| 2026-10-20 · 3.7.0 | 已部署：移除飞书、反馈、联系二维码／作者推广、IndexNow、X／公众号专用采集；保留三类刊物、补生成、分享图、文章二维码、RSS／API／MCP、密码登录和付费保护，保留历史数据。见[精简记录](docs/系统优化/2026-10-20-单人私用功能精简.md)。 |
| 2026-10-20 · 3.6.0 | 已部署：上游 N1—N8、恢复诊断及新闻优化自动采用；六项切换开关已移除，仍遵守配置兼容条件、两次独立评分和回执保护。见[实施验收](docs/问题修复/2026-10-20-上游移植实施计划与验收.md)。 |

阶段性的[P2 自然效果核查](docs/系统优化/2026-10-20-P2自然效果核查.md)尚未完成完整日质量、延迟与净费用验收。更早下线的 Tibo 重置监控和模型排行榜不恢复。
