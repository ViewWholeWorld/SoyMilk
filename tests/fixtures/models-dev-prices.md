# models.dev 冻结价格片段

来源：<https://github.com/anomalyco/models.dev>，MIT，固定提交 `b8d6cca87ec2fdd246387436f9f9377fa41d8f6f`（2026-10-15 读取）。许可原文保存在 [models-dev.LICENSE](models-dev.LICENSE)。

`models-dev-prices.json` 包含该提交的四个精简 provider/model 片段：OpenAI `gpt-4.1`、`gpt-6-luna`，DeepSeek `deepseek-flash`，小米 `mimo-v2.6-flash`。由对应 `providers/<provider>/provider.toml`、`providers/<provider>/models/<model>.toml` 及 `models/<owner>/<model>.toml` 合并，保留名称、ID、成本和必要元数据；与 `packages/core/src/index.ts` 及 `packages/web/script/build.ts` 的旧版 `/api.json` provider/model 映射输出对照。夹具不代表当前报价。

该版本 README 的 “Schema Reference” 与成本字段说明明确 input / output / reasoning / cache_read / cache_write 单位均为 USD / 每百万 token。主 schema 位于 `packages/core/src/schema.ts`。本地适配器支持普通输入、输出、缓存读取与单档完整写入价；reasoning 与 output 相等时不另收费，非空 tiers / 多档缓存 / 音频等附加计价项明确标记不支持。

新旧 schema、未支持档位、价格精度与边界另有人工夹具覆盖。完整测试使用冻结数据与 MockAgent，目录同步、官方 URL 模型调用的网络均被内存替身拦截，未访问任何真实模型。

2026-10-15 北京时间 23:23，本机只读请求在线 `/api.json` 返回 HTTP 200、`application/json`，响应约 5.67 MB。使用当前适配器解析 230 个供应商、8874 条模型条目，其中 7540 条可表示为本版基础单价、1334 条明确标为不支持，声明／默认币种均为 USD。该响应仅保存在临时目录作结构核验，没有在测试中联网或导入生产。它是带时间的本机检查，后续 NAS 同步结果见下段，失败不会清空本地目录。

2026-10-16 北京时间 00:13:04，NAS 正式应用手动同步成功并登记审计，导入 8,868 条模型，其中 7,537 条支持、1,331 条不支持；自定义价格规则保持不变，见[部署核验](../../docs/soymilk-operations.md#2026-10-16-模型定价正式上线)。这与前一天本机读取属于不同时间的目录快照，数量可以不同；它没有替换冻结测试夹具，也不代表当前报价。

币种扩展另用人工构造的 provider／model／cost.currency 夹具验证 USD、CNY、RMB 别名和冲突拒绝，不把这些构造数据当作官方人民币报价。官方冻结片段仍按其 USD 约定解析，价格数字不自动换汇。
