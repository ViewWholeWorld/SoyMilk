import assert from "node:assert/strict";
import { test } from "node:test";
import { isChinese } from "@aihot/backend/lib/language";

test("共享中文判断优先使用声明，未知语言排除假名及韩文证据", () => {
  for (const language of ["zh", "zh-CN", "zh-Hant", "ZH_tw"]) assert.equal(isChinese(language, "English"), true);
  for (const language of ["en", "ja", "ko", "fr"]) assert.equal(isChinese(language, "漢字新闻"), false);
  for (const language of [null, "", "und", "unknown", "auto"]) {
    assert.equal(isChinese(language, "中文新闻与 AI"), true);
    assert.equal(isChinese(language, "東京のニュース"), false);
    assert.equal(isChinese(language, "漢字와 한국어"), false);
    assert.equal(isChinese(language, "English text"), false);
    assert.equal(isChinese(language, "中文".repeat(300) + "東京のニュース"), false);
  }
});
