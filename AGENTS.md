# 给 Agent 的说明

这是 SoyMilk，从 AIHOT 框架 Fork 后定制的私网资讯站：采集信源、用模型筛选和写作、归组事件、出日报，并通过网站、RSS、公开 API 和 MCP 对外提供。当前行业包覆盖游戏、AI、科技、经济、娱乐，含 42 个 RSS 信源和 44 个主题。先读 README，再读 `docs/soymilk-operations.md` 和本次任务对应的文档；上游示例与历史实测不能当作当前部署状态。

## 当前已授权的配置

- 站名已确定为 SoyMilk，上述兴趣、信源和分类已由使用者授权。继续维护时保留这些决定；只有提出新的行业或内容策略变更时才需要澄清。
- NAS 上通过 HTTP 内网或 Tailscale IP 加端口访问；使用者明确不要求本站 HTTPS。管理员使用 `/admin/models` 配置模型，Codex 网页授权无需 SSH 回调隧道。
- 生产采集和模型调用已由使用者授权开启，飞书及 IndexNow 仍关闭。开发、测试使用独立环境关闭安全阀，不要为了跑测试修改生产开关。
- 正式 worker 已启用 Codex 连接复用，模型与文章分析并发上限为 2。保持账号、模型和推理强度设置，不通过新增请求身份、重评或提高预算来加速。
- 首轮捕获 745 篇的临时预算与自动恢复已部署。实时状态以 `bootstrapBudgetStatus()`、预算实际限额及 `modelsOverview().tokenSummary` 为准；历史快照中的剩余数、用量与镜像标签不代表现在。
- 条款与隐私页仍为私网试用模板；公开上线前需要使用者本人确认。

## 最常见的任务：改成另一个行业

按 `docs/customize.md` 的顺序做。行业相关的一切都在 `industry/`：站名文案（`site.ts`）、分类标签（`taxonomy.ts`）、主题（`topics.json`）、示范信源（`sources.json`）、提示词（`prompts/`）、门槛（`selection.ts`）、模块开关（`features.ts`）、品牌（`brand/`）、条款页（`pages/`）。通常不需要改 `apps/` 和 `packages/`。

更换行业时，这些尚未确定的配置要问使用者本人，不要替他决定，也不要重复询问已有决定：站名；要盯哪些信源；什么消息重要、什么是噪声；分类怎么分；条款和隐私说明的内容（`industry/pages/` 是模板，公开上线前需要他本人确认）。

改评分标准时保留原有结构（内容类型、五个维度加权、噪声压制、安全边界），替换的是“什么算重要”“什么算噪声”的例子。门槛要用使用者标注的样本重新校准（`docs/selection.md`），不要凭感觉改数字。

## 运行与检查

- Node.js 24 直接运行 TypeScript，后端没有构建步骤。npm workspaces：`apps/*`、`packages/*`、`industry`。
- 本机运行和 Docker 见 `docs/deploy.md`。
- NAS 的额外 Compose 覆盖由 `deploy/nas/compose.sh` 统一加载。更新时保留 worker 复用与预算恢复覆盖，先核对运行服务，不能只运行根目录的 Compose 而丢失 NAS 设置。
- 改完至少跑：
  ```bash
  npm run typecheck
  DATABASE_URL=postgres://127.0.0.1:5432/<名字>_test npm test   # 空库，名字必须以 _test 或 _ci 结尾，先 node scripts/migrate.ts
  npm run build -w @aihot/web && node --test apps/web/tests/*.test.ts
  node scripts/smoke.ts --base http://localhost:3000             # 站点跑起来以后
  ```
- `tests/` 里部分测试用的是示例行业的分类、标签和公司，改了 `industry/taxonomy.ts` 后把这些例子换成新行业的对应项。
- 完整后端套件存在尚未解决的基线失败；核对本次日志与之前基线，明确报告新增或耗时敏感的失败，不能把相关测试通过写成全套通过。测试库与网络必须隔离，不访问生产库、真实模型或外部付费服务。

## 要守住的规则

- 前端（`apps/web`）只通过 HTTP 读 `apps/api`，数据库、模型调用和密钥只在后端。
- 所有公开出口都从 `packages/backend/src/publication/` 这一个读取层读，新增公开出口也一样。
- 读者打开页面不触发模型调用；模型只在 worker 的任务里调用。
- 付费请求都经过回执（`providers/receipts.ts`）和预算熔断，不要绕开。
- 开发和测试时保持安全阀关闭：`COLLECT_ENABLED`、`MODEL_CALLS_ENABLED`、`FEISHU_*_ENABLED`、`INDEXNOW_SUBMIT_ENABLED`。测试不访问任何外部服务。
- 信源默认只展示摘要和原文链接（`site_fulltext` 关）；只有来源明确允许时才打开全文。
- 公开内容匿名，管理员和访客看到的一样；后台只允许管理员。
- 数据库迁移只做向后兼容的增量，新迁移按编号加在 `database/migrations/` 末尾。
- 不要提交 `.env`、密钥和 `.data/`。
- 排查 NAS 时不读取或输出 `.env`、API Key、Codex `auth.json`、授权令牌；使用应用提供的状态接口，只输出必要统计。不要输出完整 Docker inspect、Compose config 或未筛选的生产日志。
- 不要使用 AIHOT 的名字和 Logo。
- 页面与定时任务按北京时间。左侧为收录或事件进展时间，历史资料按可信原文时间归档；模型完成时间不改变时间轴。排查先核对原文、收录和锚点字段，不能因为显示凌晨就改时区或给记录再加八小时，见 `docs/timeline-time.md`。

## 提交与文档

- 不同 feature 分开实现和提交；每项完成对应验证后先提交 Git，再开始下一项。该功能的文档同步更新，保留使用者已有改动。
- README 和 `docs/soymilk-operations.md` 说明当前使用方式；实测和部署历史明确标注日期与阶段。配置变化时同步更新相关文档和本文件，删除已经失效的操作建议。
- 运行中的计数、首轮剩余和订阅窗口属于实时数据，文档只记录带时间的核验快照，并提供只读查询方法，不能把某次读数写成永久现况。

## 写代码

匹配周围代码的写法、命名和注释密度。选能清楚解决问题的简单方案，只定义正在使用的抽象。验证改动涉及的重要行为，不为简单的样式改动写测试。
