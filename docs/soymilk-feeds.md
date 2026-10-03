# SoyMilk 兴趣信源配置与部署历史

本文按部署阶段保留历史记录，不能直接作为当前运行状态或重启步骤。正式配置和只读查询入口见[当前维护说明](soymilk-operations.md)。

2026-10-02：保留原有 18 个 AI 信源，新增以下 24 个原生 RSS/Atom。全部使用 NAS 上的生产 RSS 解析器，经现有 Mihomo 出口实际验证，返回有效条目。未加入返回无效文档的 AnandTech 地址。

| 领域 | 信源 | RSS |
|---|---|---|
| 游戏 | PC Gamer | https://www.pcgamer.com/rss/ |
| 游戏 | Eurogamer | https://www.eurogamer.net/feed |
| 游戏 | GameSpot | https://www.gamespot.com/feeds/mashup/ |
| 游戏 | Gematsu | https://www.gematsu.com/feed |
| 游戏 | 机核 | https://www.gcores.com/rss |
| 游戏 | 触乐 | https://www.chuapp.com/feed |
| 游戏 | The Guardian Games | https://www.theguardian.com/technology/games/rss |
| 科技 | Ars Technica | https://feeds.arstechnica.com/arstechnica/index |
| 科技 | Engadget | https://www.engadget.com/rss.xml |
| 科技 | IT之家 | https://www.ithome.com/rss/ |
| 科技 | 爱范儿 | https://www.ifanr.com/feed |
| 科技 | Cloudflare Blog | https://blog.cloudflare.com/rss/ |
| 科技 | GitHub Blog | https://github.blog/feed/ |
| 科技 | The Guardian Science | https://www.theguardian.com/science/rss |
| 经济 | BBC Business | https://feeds.bbci.co.uk/news/business/rss.xml |
| 经济 | The Guardian Business | https://www.theguardian.com/business/rss |
| 经济 | Financial Times | https://www.ft.com/rss/home |
| 经济 | FT 中文网 | https://www.ftchinese.com/rss/feed |
| 娱乐 | Variety | https://variety.com/feed/ |
| 娱乐 | Deadline | https://deadline.com/feed/ |
| 娱乐 | BBC Entertainment & Arts | https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml |
| 娱乐 | The Guardian Film | https://www.theguardian.com/film/rss |
| 娱乐 | Anime News Network | https://www.animenewsnetwork.com/news/rss.xml |
| AI | The Guardian AI | https://www.theguardian.com/technology/artificialintelligenceai/rss |

Cloudflare 和 GitHub 为官方一手来源（T1），其他新增媒体为 T2。新增源默认每 120 分钟检查，原有 AI 源的频率保留。启用内容生产后，42 个 RSS 均按发布时间排序、首次回填最多 2 条，并设置 `maxItemAgeDays: 7`；该时间窗口在后续采集也生效，防止 OpenAI、Hugging Face 等带完整历史的订阅导入大量旧文。没有有效日期的条目仍可进入处理，已有文章保留；重叠报道由现有网址去重和事件归组处理。所有源只公开摘要与原文链接，全文展示与全文分发保持关闭；原文的付费墙和地区限制仍可能适用。

分类增加 `games`、`technology`、`economy`、`entertainment`，原有 AI 类别网址保留。主题增加游戏、科技、经济、影视娱乐、自托管与 NAS、科学。预筛与翻译提示词覆盖五个领域，普通科技和游戏内容不再因未提及 AI 而被挡掉，也不会将财经 token、电力 transformer 或影视作品误译成 AI 术语。

兴趣来自使用者本次列出的五个领域，以及旧 RSS 兴趣档案中的开发者工具、自托管、网络安全、芯片、宏观市场、重要游戏、电影与流媒体。默认优先实质发布、重要变化、深入分析和可复用实践；压低纯促销、私生活八卦、传闻炒作、重复转载和标题党。五个评分维度、类型权重、信源精选门槛与内容理解门槛保持原值；后续只能根据使用者标注的样本重新校准，见 [selection.md](selection.md)。

## 历史：空站试用与模型榜首次 503

站点按使用者此前的空站试用要求，设为 `COLLECT_ENABLED=false`、`MODEL_CALLS_ENABLED=false`。登录 Codex 和保存模型连接不会自动打开这两个开关。文章数因此是 0，RSS 数量不足并非根因。

模型榜在采集关闭时只对已有快照计算，新部署没有快照，计算失败且没有发布轮次，接口按契约返回 503。此次通过 worker 的评测抓取入口获取公开评测，再将计算任务放入现有 worker 队列，成功发布真实榜单；没有调用大模型或填充示例排名。该入口的上游抓取失败会保留旧快照。

## 历史：首次信源部署验证

类型检查、前端构建及 31 项前端测试通过。独立空库完成所有迁移、42 个信源及 44 个主题初始化，重复导入不重复添加信源。受影响后端测试为 33 通过、7 失败、1 取消；修正后的完整套件为 541 通过、49 失败、1 取消，失败与取消项与部署前基线一致，没有新增失败。预筛测试现在通过任务用途识别响应，不再硬编码 AI 行业的文案。

首次信源部署时，NAS 实际运行新镜像；网站、公开 API、RSS、MCP、站点地图等冒烟检查全部通过。模型榜成功发布首轮，界面显示真实排名。当时数据库核验信源 42、主题 44、文章 0，采集、模型、飞书及 IndexNow 开关均为 false；后续启用结果见下文。

## 历史：启用内容生产与串行排队

采集与模型调用需要分别启用。仅采集会把素材存入后台，但文章仍需经过模型预筛、评分、摘要、结构化和发布才能出现在公开页面。首次启用建议先少量验证 Codex 实际调用，再启动自动采集；Codex 使用账号额度，其他 API 使用服务商计费。站点默认连接保持使用者已选择的 GPT-6-Luna、模型默认推理强度。

首次回填有可信原文日期时按该日期归档，同一天发布的回填也可能出现在今天；没有可信日期时使用收录时间。模型完成时间不移动时间轴，回填不自动推送，详见[时间轴与时区](timeline-time.md)。精选、热点和日报的出现还取决于评分、事件归组、发布等待和刊期，不能直接用抓取条数代替公开条数。

2026-10-02 经使用者授权开启 `COLLECT_ENABLED=true`、`MODEL_CALLS_ENABLED=true`。当时分析并发为 1，采集并发为 2；模型请求限额为每分钟 10 次、每小时 120 次、每天 600 次。飞书和 IndexNow 关闭，默认模型保持 GPT-6-Luna，推理强度使用模型默认值。后续已接入两路复用和首轮临时预算，现况见[维护说明](soymilk-operations.md)。

启动时发现，同一 Codex 账号的结构化、评分和事件综述任务会争用账号锁，超过 15 秒后使部分文章等待重试。该阶段先在同一 worker 内串行排队，再取得跨进程锁；其他进程占用账号时按等待处理，不计为文章处理失败。后续正式改为有限时长的两路连接复用及账号管理让路，见[模型配置](chatgpt-auth.md)。付费回执、请求身份和预算流程保留。

该阶段部署过 `soymilk-nas-app:codex-queue`，42 个 RSS 均完成成功采集；此旧镜像后来已由正式复用版本替代。公开接口首次核验有 14 篇真实文章、4 篇精选，首页可见 AI 和经济内容，全部动态可见游戏和娱乐内容。类型检查、前端构建、31 项前端测试、40 项受影响后端测试和 34 项线上冒烟检查通过。完整后端套件为 594 项：544 通过、49 失败、1 取消；逐项对比失败与取消名称，与当时启用前的基线一致，没有新增失败。每日汇总按北京时间 08:00 的现有任务生成。

OpenAI、GameSpot 与金融媒体的部分正文无法直接取得，原流程因此进入未配置密钥的 Jina 回退并等待重试。生产环境已设 `JINA_BODY_FALLBACK=false`：直接正文抓取失败时记录为未确认，按可取得的 RSS 标题、摘要和内容进行筛选；不会假装获得全文，也不会绕过付费墙。受影响条目通过原有处理队列重新接续，不新建付费重评身份。

该阶段上线前平稳停止 worker 并保存数据库、私有数据、环境文件和旧源文件备份，旧镜像标记为 `soymilk-nas-app:pre-codex-queue`。这不是后续部署的最新回退点；回退应先核对当前备份，并保留已计费的请求记录。运行时开关和凭据只保存在 NAS 的私有配置中，不写入仓库。

## 历史：首轮预算与 token 统计部署

2026-10-03 按使用者要求临时提高模型请求限额到每分钟 30 次、每小时 600 次、每 24 小时 10,000 次，捕获当时的 745 篇待处理文章并优先处理。首轮范围不会随新采集扩大；worker 每 5 分钟检查，文章及关联归组、综述任务结束后自动恢复原来的 10/分钟、120/小时、600/24小时。临时预算最长 48 小时，在北京时间 2026-10-05 04:34 到期。管理员手工修改限额时自动恢复会退出，避免覆盖手工设置；失败文章数量会单独展示。恢复时重新开始站内限额计数，保留完整历史付费请求和 token 记录，账号额度不受此重置影响。

每次实际请求的用量保存在 `receipt_attempts.usage`，回执汇总保存在 `receipts.usage`。Codex 适配器现在保留缓存输入、缓存写入及推理 token；兼容 API 返回的相关明细也纳入统计。后台「大模型配置」显示输入、输出、已报告缓存/非缓存输入、推理 token、缓存明细覆盖次数和加权缓存率，各项能力也有独立统计。非缓存输入只计算明确报告缓存状态的请求；缓存率为该部分缓存输入总和除以输入总和。推理 token 包含在输出内，不另加进总量。实际重试分别统计，复用已收到的回执不会重复计入。

旧版 600 次请求的 4,558,527 个输入 token 没有缓存明细，无法事后还原，显示为未知；新部署已验证真实请求返回缓存及推理明细。管理员页面读状态不触发模型调用。高负载下 Codex 账号锁可能暂时占用，账号状态尚未取得时显示「待确认」，可用刷新状态重试。

本次类型检查、前端构建与 31 项前端测试、36 项受影响后端测试、34 项生产冒烟检查通过。完整空库后端测试共 599 项：549 通过、49 失败、1 取消；逐项对照此前 594 项的基线，失败和取消名称均相同。增量迁移 `0042_budget_window_start.sql` 向后兼容。数据库、私有数据和旧源文件已备份，`soymilk-nas-app:pre-bootstrap` 保存更新前镜像。
