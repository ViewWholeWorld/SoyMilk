# SoyMilk

SoyMilk 是从 [AIHOT](https://github.com/KKKKhazix/AIHOT) Fork 后定制的私网资讯站，覆盖游戏、AI、科技、经济、娱乐。它采集信源，用模型预筛、评分和写作，把相关报道归组为事件，并通过网页、RSS、公开 API 和 MCP 提供内容。

当前行业包包含 42 个 RSS 信源和 44 个主题，保留原有五个评分维度、权重和入选门槛。正式 NAS 的维护入口见 [当前维护说明](docs/soymilk-operations.md)；信源部署和复用实验中的数量、用量与耗时是带日期的历史快照。

## 当前功能

- `/admin/models` 统一管理 API Key 连接、Codex 网页授权、默认模型及各项能力的模型与 reasoning effort。HTTP 内网和 Tailscale IP 可使用设备代码授权，无需本站 HTTPS 回调。
- 正式 worker 复用 Codex 连接，模型与文章分析并发上限为 2，每次调用使用独立会话。回执、站内预算、账号管理让路和订阅限流保护继续生效。
- 首轮固定范围的临时预算在处理结束或到期时自动恢复。后台记录输入、输出、缓存与推理 token；缺少缓存明细的历史请求保持未知。
- RSS 使用七天新闻窗口，首次导入上限为每源 2 条；公开摘要与原文链接，全文许可按来源控制。
- 时间轴使用北京时间。左侧显示收录或事件进展时间，历史内容按可信原文时间归档，模型完成时间不改变排序。详见 [时间轴与时区](docs/timeline-time.md)。

## 首次部署到另一台机器

需要 Docker Compose；使用初始化脚本时还需 Node.js 24.11 以上。

```sh
git clone https://github.com/ViewWholeWorld/SoyMilk.git
cd SoyMilk
node scripts/init-env.ts
```

在新生成的 `.env` 中先明确设置 `COLLECT_ENABLED=false`、`MODEL_CALLS_ENABLED=false`，并将 `SITE_URL` 改为读者实际访问地址，再启动：

```sh
docker compose up -d --build
```

后台在 `/admin`。用初始化时生成的管理员密码登录，在「大模型配置」添加 API Key 连接或使用 **Sign in with Codex**，选择模型后再决定是否开启采集和模型调用。关闭安全阀时站点可以保持空白；首轮处理耗时取决于素材、模型响应和预算，不保证固定半小时完成。

现有 NAS 已获授权开启生产，维护时不要重放上述首次部署的关阀操作。NAS 更新统一使用部署目录中的 `deploy/nas/compose.sh`，保留额外覆盖和正式 worker 配置，见 [维护说明](docs/soymilk-operations.md)。

## 开发与文档

先读 [AGENTS.md](AGENTS.md)。不同 feature 分别完成验证和提交，再开始下一项；开发与测试使用关闭安全阀的独立环境，不访问生产数据库、真实模型或外部付费服务。每次改动记录完整套件的实际结果，不能将部分检查通过写成全部通过，测试方法见[隔离回归测试](docs/testing.md)。

| 文档 | 内容 |
| --- | --- |
| [当前维护说明](docs/soymilk-operations.md) | NAS 入口、正式配置、预算、只读核验和验证现况 |
| [隔离回归测试](docs/testing.md) | 本地模型替身、安全阀、临时数据及共享数据库断言 |
| [网页模型与授权](docs/chatgpt-auth.md) | API Key、Codex 设备代码、模型强度和 worker 保护 |
| [时间轴与时区](docs/timeline-time.md) | 北京时间、收录与原文时间、截图核验 |
| [兴趣信源与部署历史](docs/soymilk-feeds.md) | 五个领域的信源选择及各阶段记录 |
| [连接复用实测](docs/codex-reuse-benchmark.md) | 有界实验结果与正式接入记录 |
| [部署](docs/deploy.md) | 首次安装、HTTPS 可选配置、更新和备份 |
| [架构](docs/architecture.md) | 进程边界、发布读取层与目录 |
| [行业定制](docs/customize.md) | 站名、分类、信源、提示词与品牌 |
| [信源](docs/sources.md) | 采集类型、分级与全文许可 |
| [精选与校准](docs/selection.md) | 评分流程、样本与入选门槛 |
| [事件归组](docs/grouping.md) | 事件关系与评测 |
| [模型榜](docs/leaderboard.md) | 公开评测与 Codex 重置监控 |

Fork 仍可通过 upstream 获取和合并源仓库更新；合并时保留本站定制和部署配置。技术栈为 Node.js 24、TypeScript、React Router、Fastify、PostgreSQL、pg-boss、Tailwind CSS 和 Docker Compose。

## 来源与许可

原框架来自 [KKKKhazix/AIHOT](https://github.com/KKKKhazix/AIHOT)。代码使用 [MIT 许可证](LICENSE)，第三方字体和标志等归属见 [NOTICE](NOTICE)。本站使用 SoyMilk 名称和品牌；条款与隐私页目前为使用者认可的私网试用模板，公开上线前需另行确认。
