import assert from "node:assert/strict";
import { test } from "node:test";
import { promptText, promptVersion } from "@aihot/backend/editorial/prompts";

test("正文翻译与重试提示词保留完整共享规则及五领域边界", () => {
  for (const name of ["translate-body", "translate-body-retry"]) {
    const system = promptText(name);
    for (const rule of ["safety", "rules-domain", "translate-body-rules"]) {
      assert.ok(system.includes(promptText(rule)), `${name} 应包含完整的 ${rule}`);
    }
    assert.doesNotMatch(system, /科技媒体/u);
  }
});

test("重试提示词说明链接、占位符和条数问题并要求按原顺序输出", () => {
  const retry = promptText("translate-body-retry");
  assert.ok(retry.includes("这些片段上一次的译文丢失或重复了链接或占位符，或条数没对上。"));
  assert.ok(retry.includes("这次宁可贴近原文语序，按原顺序逐条输出，让每个 <a id=\"Ln\"> 链接和 ⟦n⟧ 占位符都恰好出现一次。"));
  assert.notEqual(retry, promptText("translate-body"));
});

test("翻译提示词内容版本包含专用重试提示词", () => {
  assert.match(promptVersion("translate-body", "translate-body-retry", "translate-post"),
    /^translate-body\+translate-body-retry\+translate-post@[a-f0-9]{10}$/u);
});

test("标题与内容理解区分此前发布和当前教程演示", () => {
  const title = promptText("rules-self-contained-title");
  assert.ok(title.includes("本条在讲用法、做演示或再次推广时，标题写介绍、演示或讲解，把发布交代成此前的事，不能写成“推出/发布/上线”"));
  assert.ok(title.includes("只有原文明确某项能力现在才开放或新增，才对那一项用对应动作。"));
  assert.ok(title.includes("正文 “At DevDay, we introduced ChatGPT Space … See how it works below” → “OpenAI 演示 DevDay 发布的 ChatGPT Space 团队协作用法”，不能写成“OpenAI 在 DevDay 推出 ChatGPT Space”。"));
  assert.ok(promptText("content-understanding").includes("原文把发布写成过去的事、本条在讲用法或做演示时，不算本次发布，选 tutorial_explainer。"));
});
