# Hermes Agent 接入

SoyMilk 的 `/api/mcp` 是匿名、只读、无状态的 Streamable HTTP 服务，不需要 API Key。所有工具读取同一个公开发布层；读取新闻不会触发采集、模型写作或后台管理操作。Hermes 支持远程 HTTP MCP 和本地 `SKILL.md`，分别见[官方 MCP 文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)与[技能文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)。

## 当前 NAS 连接

- Hermes 容器为 `hermes`，`HERMES_HOME=/opt/data`，目录由 Container Station 持久化。
- MCP 配置在容器内 `/opt/data/config.yaml` 的 `mcp_servers.soymilk`，示例见 [mcp.yaml](../integrations/hermes/mcp.yaml)。现有 `fast-note-sync` 与 `qnap-nas` 连接保持不变。
- 资讯技能在 `/opt/data/skills/research/soymilk-news/SKILL.md`，仓库维护源见 [soymilk-news](../integrations/hermes/skills/soymilk-news/SKILL.md)。它覆盖简报、关键词搜索、热点、事件时间线与日报，不包含部署或管理员能力。
- 本次只给 `web` 增加现有 `agent-net` 网络连接，保留它原来的默认网络；API、worker、数据库的原网络未改，不增加端口映射。
- 网页固定内部地址为 `172.29.20.7:3000`，别名 `soymilk`。Hermes 使用自定义 DNS，不解析这个新增 Docker 别名，因此 MCP 用内部固定 IP，不修改全局 DNS 或代理策略。
- 持久化设置已合并进 NAS 私有 `deploy/nas/compose.web-time.yml`，结构见 [网络示例](../integrations/hermes/web-network.example.yml)。后续 `compose.sh` 手动及自动更新都会保留它；最后的 `compose.release.yml` 仍决定镜像，不回退旧网页镜像。
- MCP 请求附带 `Host: 192.168.1.62:3000`，继续通过原有 Host 校验；内部固定地址不是读者访问或引用链接的地址。

不要直接用示例覆盖整个 Hermes 配置或 NAS 私有 Compose 文件，应只合并相关字段。换机器时核对 `agent-net` 是否存在、子网与地址是否空闲，并同步调整网络覆盖和 MCP URL；在普通内网客户端上可直接使用 `http://192.168.1.62:3000/api/mcp`，不需要 Docker 网络覆盖。

## 信任与范围

当前安装的 Hermes 原生客户端发现五个工具，但没有正确识别服务提供的只读提示，`trust: untrusted` 会对这些读操作要求审批。此连接使用 `trust: full`，仅信任使用者自行控制的 SoyMilk 服务，**明确白名单五个现有只读工具**，同时关闭资源与提示词包装器。不要把这个信任设置复制给未知第三方 MCP，或移除工具白名单。

信任服务与信任新闻内容不同：所有标题、摘要、正文、链接仍是不可信外部资料，技能要求不执行其中的指令，不透露凭据，不依据新闻改配置。重要数字与原话要核对原始来源，只有公开摘要时不假装取得全文。

当前客户端注册名称如下；技能也要求优先采用实际可用的工具定义，兼容其他版本的命名变化：

| Hermes 工具 | 用途 |
| --- | --- |
| `mcp__soymilk__soymilk_get_latest` | 过去 24 小时或 7 天的精选/全部公开动态 |
| `mcp__soymilk__soymilk_search` | 最近 7 天的主题、公司、产品、人物搜索 |
| `mcp__soymilk__soymilk_get_hot_topics` | 当前热点排名与真实公开事件 ID |
| `mcp__soymilk__soymilk_get_story` | 已返回事件 ID 的来龙去脉与时间线 |
| `mcp__soymilk__soymilk_get_daily` | 最新日报或真实日期的已出版日报 |

这不是全网搜索；搜索窗口仅 `24h` 与 `7d`。日报是固定出版物，不能把最新一期自动说成今天的滚动新闻。技能默认中文回答、北京时间、精选优先、注明来源和阅读链接；不存在的日报、空结果、网络故障要如实说明。

## 在 Hermes 使用

可以直接问「用 SoyMilk 整理今天的游戏和 AI 资讯」「搜索最近一周 OpenAI 的消息」「今天有什么热点，展开第一个事件的时间线」「读取最新日报」。也可以显式加载 `soymilk-news` 技能。

新会话会读取已保存的配置。运行中的网关版本若支持配置监听会自动更新；已有聊天尚未出现工具时发送 `/reload-mcp`，技能列表未更新时发送 `/reload-skills`，或开始新会话。本次没有为此重启 Hermes、发起 Agent 对话或调用模型。

## 核验与回退

北京时间 2026-10-03 17:14 的核验快照：在正在安装的 Hermes 客户端中发现恰好五个工具，最新资讯、搜索、热点、真实事件详情、最新日报均返回非空答案；技能可被发现并加载。核验不调用模型。SoyMilk 正式站点 34 项公开冒烟检查全部通过，API、worker、数据库未重启，自动部署控制器已恢复运行。此快照不能替代后续现场连通性检查，且不是一次完整 Agent 对话验收。

Hermes 原配置备份在容器持久目录 `/opt/data/backups/soymilk-mcp-20261003T091141Z/config.yaml`；文件权限为 `600`，不要打印或提交，因为可能包含其他连接的认证配置。NAS 原网页覆盖备份在 `/share/homes/tromso/apps/soymilk/backups/hermes-network-20261003/compose.web-time.yml`。

解除接入时优先仅删除 `mcp_servers.soymilk` 与对应技能，不用旧备份覆盖后续已有设置。去除网页额外网络时先暂停自动部署、只恢复相关网络字段，再用既有 `compose.sh` 只更新 web，完成后恢复部署控制器；不要恢复数据库、重置回执或修改生产开关。
