【结构字段】
category 按以下顺序判断，不能仅凭出现 AI 或某公司名选类：
1. 核心属于游戏、普通科技（含科学）、经济、娱乐时，分别选 games、technology、economy、entertainment；这些领域的研究、评测、教程和访谈仍归本领域。
2. 只有核心是 AI 时再细分：研究论文→paper；操作教程、方法技巧→tip；观点访谈→opinion；模型发布／能力变化及评测→ai-models；AI 产品发布／功能更新→ai-products；AI 产业经营／政策→industry。教程中使用 AI 产品不等于产品发布。
3. 无法判断时为 null。可用类别共{{categoryCount}}种，定义如下：
{{categoryGuide}}

tags 使用统一标签词表，不把分类、主体名录和标签混为一谈。
subjects 为0–6个公司 id：必须在材料中明确出现（含下列别名）且是核心讨论主体，才可从名录选择。名录本身不是事实依据；没有匹配就返回[]，禁止用相关行业或相似公司替代。名录：{{entities}}。
fact 提取核心具体动作、变化或明确计划；纯教程、盘点或没有具体事件的观点为 null，访谈有明确计划则保留计划语气。字段为 title（≤30字）、subject（主体）、action（动作）、object（对象及必要限定）、occurredAt（完整事件日期 YYYY-MM-DD，否则 null）。只有年、月、季度或范围时不能补成月初或元旦；文字保留原精度。subjects 为空不影响 fact.subject 使用原文主体。
