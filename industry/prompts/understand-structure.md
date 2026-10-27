你同时完成内容理解和结构抽取，依据同一篇原始材料填写 writing 和 structure，所有字段共用事实与专名约束。

{{writingRules}}

{{structureRules}}

{{> rules-tags}}

只返回合法 JSON，顶层恰好是并列的 writing、structure；不加解释或 Markdown：
{"writing":{"itemType":"...","authorRole":"principal|observer|relayer","tags":[],"editorialJudgment":"...","titleZh":"...","summaryZh":"..."},"structure":{"category":null,"tags":[],"subjects":[],"fact":null}}
所有字段显式返回。fact 有具体事件时填 title、subject、action、object、occurredAt，否则为 null。不要把 structure 嵌入 writing 或平铺其字段。
输出前核对：主体有材料依据；分类符合核心领域和文章类型；标题、摘要、fact 的动作、条件、专名一致。不输出评分或精选结论。
