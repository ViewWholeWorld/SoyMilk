import { stub, useModelStubs, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { buildDigestInput } from "@aihot/backend/events/digest-input";
import { promptText, renderPromptText } from "@aihot/backend/editorial/prompts";
import { parseDigestCases, evaluateDigests } from "../scripts/eval-story-digests-core.ts";

const T = tag();
let fail = false;
const users: string[] = [];
const provider = await stub((_hit,req) => {
  if (fail) return { choices: [{ message: { content: "invalid-json" } }] };
  users.push(JSON.parse(req.body).messages[1].content);
  return { choices: [{ message: { content: JSON.stringify({ title:"测试事件",digest:"主体发布新产品，当前仅适用于明确列出的地区。",latest:"产品发布" }) } }],usage:{ prompt_tokens:10,completion_tokens:10 } };
});
await useModelStubs({ DEEPSEEK: provider.url });
const cases = parseDigestCases(JSON.stringify({ caseId:T,previousDigest:"旧综述",knownArticleIds:["old"],reports:[
  { id:"new",title:"新进展",summary:"新摘要",source:"测试源",firstParty:true,publishedAt:"2026-10-12T08:00:00Z" },
  { id:"old",title:"初次发布",summary:null,source:"测试源",firstParty:false,publishedAt:"2026-10-11T08:00:00Z" },
] }));
after(async () => { await provider.close(); await sql`DELETE FROM receipts WHERE purpose='story_digest_eval' AND subject LIKE 'digest-eval:%'`; await closeDb(); });
test("调用上限和重复提示词在发请求前拒绝", async () => {
  const hits = provider.hits();
  await assert.rejects(evaluateDigests(cases,[{ name:"a",text:"甲" },{ name:"b",text:"乙" }],1),/上限/);
  await assert.rejects(evaluateDigests(cases,[{ name:"a",text:"甲" },{ name:"b",text:"甲" }]),/重复/);
  assert.equal(provider.hits(),hits);
});
test("评测使用生产输入、保存结果并在原样重跑时复用回执", async () => {
  const before = (await sql`SELECT count(*)::int AS n FROM story_digests`)[0]!.n;
  const systems = [{ name:"当前",text:promptText("story-digest") },{ name:"候选",text:renderPromptText("{{siteName}} 测试候选提示词") }];
  const rows = await evaluateDigests(cases,systems);
  assert.ok(rows.every(r => "result" in r));
  const expected = buildDigestInput(cases[0]!.reports.map(r => ({ id:r.id,title:r.title,summary:r.summary,source_name:r.source,first_party:r.firstParty,at:new Date(r.publishedAt) })),"旧综述",new Set(["old"])).user;
  assert.deepEqual(users,[expected,expected]);
  assert.ok(expected.indexOf("初次发布") < expected.indexOf("新进展"));
  assert.match(expected,/【新】/);
  const hits = provider.hits();
  assert.ok((await evaluateDigests(cases,systems)).every(r => "reused" in r && r.reused));
  assert.equal(provider.hits(),hits);
  assert.equal((await sql`SELECT count(*)::int AS n FROM story_digests`)[0]!.n,before);
});
test("解析错误按失败记录，不写回事件；候选模板拒绝未知变量", async () => {
  fail = true;
  const rows = await evaluateDigests([{ ...cases[0]!,caseId:T+'-failed' }],[{ name:"失败",text:"失败提示词" }]);
  assert.ok("error" in rows[0]!);
  assert.throws(() => renderPromptText("{{missing}}"),/no value/);
  assert.throws(() => parseDigestCases(JSON.stringify({ caseId:"bad",reports:[] })),/第 1 行/);
});
