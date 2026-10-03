# 网页大模型配置与 ChatGPT 订阅授权

## 网页配置（推荐）

管理员登录后打开 `/admin/models` 的「大模型配置」。可以保存多组连接并选择默认连接，下方也可为各项能力分别指定模型。

### Sign in with Codex

1. 点击 **Sign in with Codex**，复制页面显示的验证码。
2. 打开 OpenAI 授权页面，用 ChatGPT 账号确认。首次使用可能需要在 ChatGPT 安全设置中允许设备代码登录（工作区也可能由管理员控制）。
3. 返回网站，授权结果自动更新，Codex 账号卡片会自动读取模型列表。在「Codex 模型」中选择模型，点击「保存并设为默认」即可。列表读取失败时也可手动填写账号支持的模型名；不会因此发起推理。

使用官方 Codex app-server 的 `chatgptDeviceCode` 流程，支持 Docker/NAS、HTTP 内网和 Tailscale IP，无需本站 HTTPS 回调或 SSH 隧道。依赖锁定为 `@openai/codex@0.160.0`；Codex 自己保管和刷新令牌，应用不读取或复制用户本机的 `auth.json`。模型目录供选择，实际权限以任务执行结果为准。可在此页断开账号。

刷新页面会恢复本会话尚未完成的授权。用另一个地址或浏览器登录时会形成不同会话：网页显示已有授权，并提供「取消旧授权并重新开始」，不用等待旧验证码超时。其他会话不能读取原验证码；只有显式点击重新开始才会取消旧授权。

### API Key 连接

点击「添加 API Key 连接」，填写名称、服务商基础地址、模型名和密钥，再在「默认连接」中选择并应用。支持 OpenAI 兼容的 **Chat Completions** 协议，提供 OpenAI、DeepSeek、通义千问和智谱地址预设，也支持自定义兼容服务。原生 Anthropic Messages/Gemini 需通过兼容服务接入。按模型能力选择 JSON 输出和图片输入。

密钥不会在网页或审计记录中回显；编辑时留空保留，填写新值替换，删除非默认连接会移除密钥。配置保存在共享数据卷 `model-config/connections.json`（文件 600，目录 700），API 和 worker 在调用时读取，无需重启。Codex 使用独立 `model-config/codex/`。这些目录包含敏感凭据，备份应妥善保管，不要提交或上传。

使用 `default` 的能力跟随默认连接，单独指定的能力保留自己的选择。连接修改、账号变更会改变回执身份。选择「原有配置」恢复环境变量设置。

### 模型与推理强度

Codex 账号卡片、连接编辑表单，以及下方各项能力的「切换」弹窗均可设置 reasoning effort。Codex 的可选强度和「模型默认」标注来自官方 `model/list`，不统一写死为 medium；选择「模型默认」时不发送 effort，保留模型自身默认行为。旧连接没有此字段，升级后沿用这一行为。

各项能力的弹窗直接列出 Codex 模型目录，无需先手工添加连接。选择模型和推理强度后确认，会保存或复用对应连接并只切换该项能力；同一个模型可为预筛设置 low、为评分设置 high，不改变其他能力的配置。`default` 表示跟随网站默认连接，卡片会显示实际连接、模型和配置的推理强度。改变默认连接的强度会创建或复用对应配置，不改写其他能力已经引用的连接。

API Key 连接可在编辑表单设置强度，经兼容接口的 `reasoning_effort` 发送；支持程度由服务商和模型决定，不支持时保留默认。显式开启推理时不发送 temperature，避免接口拒绝不兼容的采样参数。Codex 强度通过 `turn/start.effort` 发送；配置变化会隔离回执，不能复用旧强度的结果。

保存、登录和读取状态不会启动采集或推理，`MODEL_CALLS_ENABLED=false` 和 `COLLECT_ENABLED=false` 保持关闭。模型只在 worker 调用，经原有回执和预算熔断。Codex 使用临时会话和只读沙箱，关闭命令、图片文件读取、网页搜索，拒绝所有服务端工具/批准请求。配置接口需要管理员会话，写请求验证 CSRF，授权结果仅发起登录的会话可查询。

Codex 和网页配置的接口使用 `EGRESS_PROXY_URL`；新接口禁止跳转并保留出站地址检查。本地推理服务需由部署者按现有网络策略配置。

### Worker 连接复用与并发

在 worker 环境中设置 `CODEX_REUSE_ENABLED=true`、`CODEX_CONCURRENCY=2` 可复用官方 app-server 连接，最多同时执行两次模型请求。每次请求仍建立独立的临时会话；其他 API Key 连接沿用其原有流程。`ANALYZE_CONCURRENCY=2` 决定同时处理多少篇文章，Codex 并发上限还会约束评分、写作、事件与日报中的所有 Codex 请求。

连接以两分钟为一批复用，空闲两秒后释放，已发送的请求完成后才关闭；每批都检查订阅用量。登录、退出、读取账号和模型目录时，worker 完成在途请求并让出账号锁；授权期间不再启动新的 Codex 请求。异常中断保留未知回执，后续任务按原恢复流程接续。

数据库锁保证多个请求不会同时穿过站内剩余次数。首轮临时预算及自动恢复机制独立生效，提速不会提高限额。订阅窗口用满时暂停新请求直到重置；上游返回速率限制时先等待一分钟，再暂时降至单路十分钟。可能已经计费的失败响应仍按未知回执处理，不自动切换账号或购买额度。并发提高消耗额度的速度，订阅窗口的真实限额仍由服务端决定。

官方说明：[Codex app-server](https://developers.openai.com/codex/app-server)、[设备代码登录](https://developers.openai.com/codex/auth)。

## 命令行直接授权（高级选项）

以下保留另一条直接授权路径（`LLM_AUTH_MODE=chatgpt`），与网页 Codex 托管登录独立。一般使用上面的网页配置即可。

SoyMilk 的默认模型可以使用官方 **Sign in with ChatGPT** 的订阅授权。此功能用于 worker 的内容筛选、写作和日报；后台仍使用管理员密码登录。

这是一条独立的 OAuth 授权：**不要导入 Codex 的 `auth.json`，也不要把访问令牌填进 `LLM_API_KEY`**。已有 Codex 登录不代表已经授予 SoyMilk 使用订阅的权限。当前官方接口处于预览阶段，可用模型和额度以授权账号为准。

## 配置

首次配置期间保持 `COLLECT_ENABLED=false` 和 `MODEL_CALLS_ENABLED=false`。在运行浏览器的电脑上，用 Node.js 24 执行：

```sh
node --env-file-if-exists=.env scripts/chatgpt-auth.ts login
node --env-file-if-exists=.env scripts/chatgpt-auth.ts status
node --env-file-if-exists=.env scripts/chatgpt-auth.ts models
```

打开终端显示的 OpenAI 授权链接，自行登录并选择是否授权订阅额度。回调只监听 `127.0.0.1:1455`，不需要为网站增加 HTTPS。端口被占用时可设置 `CHATGPT_LOGIN_PORT`，重试前关闭上一个登录进程。

`status` 只显示账号、连接状态、订阅授权状态和到期时间，不显示令牌。`models` 不执行推理，但会请求账号可用模型列表，可能续期令牌。从输出中选择模型，再配置：

```dotenv
LLM_AUTH_MODE=chatgpt
LLM_MODEL=<models 命令输出的 model>
LLM_EXTRA_JSON=
# 默认为 AIHOT_DATA_DIR 下的 chatgpt 目录：Docker 中是 /data/chatgpt。
# CHATGPT_AUTH_DIR=/data/chatgpt
CHATGPT_PROFILE=default
```

这一模式不使用 `LLM_BASE_URL` 和 `LLM_API_KEY`，也不向其他 API 自动降级。其他具名模型仍沿用自己的 API Key。模型有图片能力时可使用原有 `LLM_VISION=true`；向量接口仍需要独立配置，不由本授权提供。

配置不会打开模型或采集安全阀。正式采集和推理需要另行启用；开发和测试保持关闭。

## NAS：通过 SSH 完成授权

推荐在 NAS 本身保存并续期令牌，通过 SSH 将回调端口转发到运行浏览器的电脑。先暂停 worker，避免维护进程和 worker 同时使用刷新令牌。

在电脑的一个终端运行（`nas` 换成已配置的 SSH 别名）：

```sh
ssh -N -L 1455:127.0.0.1:1455 nas
```

另一个终端 SSH 到 NAS。使用已经构建的镜像和数据卷启动一次授权进程；将示例中的镜像、数据卷和代理换成部署实际值：

```sh
docker run --rm --network host \
  --env-file .env \
  -e AIHOT_DATA_DIR=/data \
  -e EGRESS_PROXY_URL=http://127.0.0.1:7890 \
  -v YOUR_DATA_VOLUME:/data YOUR_APP_IMAGE \
  node scripts/chatgpt-auth.ts login
```

在电脑浏览器打开该进程打印的 URL。通过 SSH 隧道，HTTP loopback 回调会送到 NAS 授权进程。凭据直接写入 NAS 数据卷，无需在聊天中传递任何令牌。登录结束后关闭 SSH 隧道。

如果选择在电脑完成登录后复制凭据，先在 NAS 执行 `init-host` 生成并保留它自己的 `host.json`，只通过 SSH 导入对应 profile 的 JSON，**不要用电脑的 host.json 覆盖 NAS 的主机标识**。随后由 NAS 独占续期该会话，避免电脑同时刷新同一套令牌。

## 凭据与多账号

凭据保存在 `.data/chatgpt/<CHATGPT_PROFILE>.json`，每个 profile 独立保存注册 ID、验证后的账号身份、授权范围和令牌；`host.json` 保存持久化的主机标识。用 `CHATGPT_PROFILE=another` 添加另一个账号，切换配置后重建 worker。已有 profile 的重新授权必须验证为同一个账号。

首次回调会将注册 ID 写入同目录的 `<profile>.json.registration`，代码交换失败后仍可重用该 ID。主机标识使用单独的 `host.json.lock`，避免不同 profile 同时初始化时改变标识。

Unix 文件采用 `0600`，目录采用 `0700`，写入时原子替换。Windows 部署应同时限制目录 ACL。不要将这些文件提交到 Git、发进聊天、复制到浏览器存储或记入日志。包含附件数据卷的备份也包含授权凭据，必须按密钥备份保管。

刷新令牌按 profile 使用共享目录锁串行更新。进程在持锁时崩溃可能留下 `<profile>.json.lock`，此时不会冒险并发刷新；确认 worker 和所有授权进程都已停止后，才移除该空锁目录并重启。

退出授权：

```sh
node --env-file-if-exists=.env scripts/chatgpt-auth.ts logout
```

命令先向 OpenAI 撤销会话，成功后清除本地令牌，保留账号注册和主机标识。网络故障时保留令牌以便重试；也可以在 ChatGPT 设置中断开应用，再按状态提示重新授权。

## 请求和恢复

所有模型请求仍经过现有 `paidRequest`、`llm` 预算及回执。回执身份包括传输方式和账号注册的哈希，不含令牌。响应中的用量转为已有后台使用的字段；订阅消耗不是 API 现金费用，不伪造金额。

接口使用 `/v1/responses`、`store:false`、`stream:true`。不发送本预览接口不支持的 `temperature`、输出 token 上限和服务商附加参数；JSON 输出由提示词和原有 schema 校验约束。因不发送 token 上限，需同时设置请求预算和 ChatGPT 侧应用额度。

只有 `response.completed` 才算收到完整结果。中断或不完整的流保留“结果不明”回执，继续走原有恢复流程；429、授权失效和额度错误不会切换到另一收费接口。配额和会话失效需在 ChatGPT 设置或重新授权中解决。

## 验证与官方文档

`tests/chatgpt-auth.test.ts` 使用内存 HTTPS 替身和虚构凭据，禁止外部连接；覆盖 OAuth 状态、ID-token 签名与身份、授权范围、令牌轮换、存储权限、Responses 参数、流中断、回执复用和预算。

- [官方授权流程](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [账号与令牌续期](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [自托管主机](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)
- [预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
