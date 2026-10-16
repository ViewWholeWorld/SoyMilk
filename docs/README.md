# 文档索引

日常开发从 [Git 规范](git-guidelines.md)、[架构](architecture.md)和[隔离回归测试](testing.md)开始。维护 NAS 先读[当前维护说明](soymilk-operations.md)，发布按[手动部署](manual-deploy.md)执行。

| 用途 | 文档 |
| --- | --- |
| 部署与接入 | [首次部署](deploy.md)、[Codex 授权](chatgpt-auth.md)、[Hermes](hermes.md) |
| 内容与配置 | [行业定制](customize.md)、[兴趣信源](soymilk-feeds.md)、[信源机制](sources.md)、[精选校准](selection.md)、[事件归组](grouping.md)、[时间轴](timeline-time.md) |
| 模型费用 | [配置、统计与补算操作](model-pricing.md)、[3.5.2 实施与验收](3.5.2优化内容.md)、[原定价设计](model-pricing-plan.md) |
| 模型用量优化 | [新闻处理 token 用量优化计划（待实施）](token-usage-optimization-plan.md) |
| 持续维护 | [上游审查台账](upstream-review.md)、[综述评测](story-digest-evaluation.md)、[空库 HTTP API 验收](http-api-testing.md)、[维护变更记录](changelog.md) |

## 历史归档

已结束的计划、一次性实验和过往验收放在 `archive/`，供追溯和回退时核对。归档内容中的“待实现”“未合并”、旧镜像及运行计数描述的是当时阶段，不能作为当前操作步骤。

| 记录 | 范围 |
| --- | --- |
| [上游兼容性审核](archive/upstream-review-20261004.md) | 2026-10-04 的架构差异与保留决定 |
| [七项功能移植](archive/upstream-port-plan-20261013.md) | 已完成的功能计划、实现与发布证据 |
| [上游修复计划](archive/upstream-fix-plan-20261014.md) | PR #7 的审查、实施与补修记录 |
| [Codex 连接复用实测](archive/codex-reuse-benchmark.md) | 一次性实验与正式接入历史 |
| [隔离回归与发布历史](archive/testing-20261015.md) | 截至 2026-10-15 的测试数量、失败、复核和发布证据 |
