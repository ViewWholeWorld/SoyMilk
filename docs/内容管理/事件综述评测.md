# 事件综述评测

`scripts/eval-story-digests.ts` 复用生产综述输入、40 篇报道窗口和输出结构（`title`、`digest`、`latest`）。默认使用当前 `digest` 模型、温度 0.3、输出上限 1200 token；模型账号、预算与回执保护照常生效。新提示词只在后续有新报道时自然应用，本工具不批量更新事件。

## 只读导出

在明确选择的数据库环境执行：

```sh
node --env-file-if-exists=.env scripts/eval-story-digests.ts --stories <事件publicId>,<另一个publicId> --out work/story-digest-cases.jsonl
```

导出当前未合并事件的可用公开报道，不调用模型、不写事件。默认案例为完整重建输入；JSONL 可补充 `previousDigest` 与 `knownArticleIds` 比较增量综述。样本含新闻内容，分享前检查来源许可。许可随时可能变化，应在实际比较前重新导出并核对。

## 有上限的比较

```sh
node --env-file-if-exists=.env scripts/eval-story-digests.ts --cases work/story-digest-cases.jsonl --system work/candidate-story-digest.md --max-calls 18 --out-dir outputs/story-digest-eval
```

这是显式模型操作；运行前确认调用环境和预算。未传 `--system` 时只评测当前提示词，传入时每个案例比较两种提示词。总案例数乘提示词数必须不超过上限，空提示词和重复候选会在调用前拒绝。模板支持已有行业引用与变量，未知变量报错。

比较通过同一输入生成结果，以输入及提示词摘要登记稳定回执；原样重跑复用已有结果。请求仍可能受提供方重试策略影响，`--max-calls` 限制评测项数量，实际请求与费用同时受站内预算约束。输出 JSON 保存结果、用量、回执及复用状态，Markdown 便于并排阅读；失败单独记录并以非零状态退出，不写回 `stories` 或 `story_digests`。

人工比较主体和结论是否明确、事实是否有输入依据、限制是否完整、旧进展是否被错误重复，以及中文是否自然。工具不把模型自评当作质量证明。本轮隔离验证仅使用本地替身，不进行生产付费比较。
