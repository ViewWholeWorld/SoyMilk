# ChatGPT / Codex 订阅授权

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
