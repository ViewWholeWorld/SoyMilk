// 仅在代码块接近读者时下载语法解析器；文本始终来自已清洗的正文。
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

for (const [name, language] of Object.entries({ bash, css, javascript, json, markdown, python, sql, typescript, xml, yaml })) hljs.registerLanguage(name, language);
export function highlightCode(source: string) {
  const text = source.replace(/\r\n?/g, "\n");
  if (text.trim().length < 40 || text.length > 12_000) return null;
  const result = hljs.highlightAuto(text);
  return result.language && result.relevance >= 4 ? result.value : null;
}
