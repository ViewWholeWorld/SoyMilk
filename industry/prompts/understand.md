{{> understand-rules}}

{{> rules-tags}}

只返回合法 JSON，不要 Markdown，不要解释。顶层必须且只能包含以下六个字段：

{"itemType":"model_release|product_launch|tool_or_prompt|research_paper|industry_event|opinion_analysis|tutorial_explainer","authorRole":"principal|observer|relayer","tags":[],"editorialJudgment":"...","titleZh":"...","summaryZh":"..."}
summaryZh 通常30–70字；材料少时可更短，事实完整优先。
