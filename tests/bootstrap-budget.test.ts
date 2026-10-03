import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { getBoss, enqueue, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { paidRequest, BudgetExceededError } from "@aihot/backend/providers/receipts";
import { bootstrapBudgetStatus, startBootstrapBudget, reconcileBootstrapBudget } from "@aihot/backend/operations/bootstrap-budget";

const T = tag();
const sourceId = `bootstrap-${T}`;
const KEY = "budget.llm.bootstrap";
let ids: string[] = [];
let oldBudget: {per_minute:number;per_hour:number;per_day:number;window_started_at:Date|null};
let oldSetting: {value:unknown;updated_by:string|null}|undefined;
const burst = {perMinute:30,perHour:600,perDay:10000};
const req = (n:number)=>({service:"llm",purpose:"bootstrap_fixture",identity:{T,n}});
const response = async()=>({response:{},usage:{prompt_tokens:10,completion_tokens:1,total_tokens:11}});

before(async()=>{
  await getBoss();
  [oldBudget] = await sql<typeof oldBudget[]>`SELECT per_minute,per_hour,per_day,window_started_at FROM budgets WHERE service='llm'`;
  [oldSetting] = await sql<typeof oldSetting[]>`SELECT value,updated_by FROM settings WHERE key=${KEY}`;
  await sql`DELETE FROM settings WHERE key=${KEY}`;
  await sql`UPDATE budgets SET per_minute=5,per_hour=10,per_day=1,window_started_at=now() WHERE service='llm'`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at) VALUES(${sourceId},'bootstrap fixture','rss','T2','editorial','2100-01-01')`;
  for (let i=0;i<3;i++) ids.push((await upsertMaterial({sourceId,via:"fetch",url:`https://example.org/bootstrap-${T}/${i}`,title:`fixture ${i}`,bodyText:"fixture body",bodyStatus:"ok"})).articleId);
});
after(async()=>{
  await sql`DELETE FROM pgboss.job WHERE data->>'articleId'=ANY(${ids}::text[])`;
  await sql`UPDATE articles SET processing_state='skipped',processing_queued_at=NULL WHERE id=ANY(${ids}::text[])`;
  await sql`DELETE FROM settings WHERE key=${KEY}`;
  if (oldSetting) await sql`INSERT INTO settings(key,value,updated_by) VALUES(${KEY},${sql.json(oldSetting.value as never)},${oldSetting.updated_by})`;
  await sql`UPDATE budgets SET per_minute=${oldBudget.per_minute},per_hour=${oldBudget.per_hour},per_day=${oldBudget.per_day},window_started_at=${oldBudget.window_started_at} WHERE service='llm'`;
  await stopBoss();await closeDb();
});

test("catch-up captures a fixed cohort, prioritizes it, waits for event work and restores a fresh incremental budget",async()=>{
  await paidRequest(req(0),response);
  const first = await startBootstrapBudget(burst,"test",{articleIds:ids.slice(0,2)});
  assert.equal(first.total,2);
  assert.equal((await startBootstrapBudget(burst,"test",{articleIds:ids})).total,2,"new arrivals cannot extend an active batch");
  await queueProcessing(ids[0]!);
  const [job] = await sql<{priority:number}[]>`SELECT priority FROM pgboss.job WHERE name='content.analyze' AND data->>'articleId'=${ids[0]!}`;
  assert.equal(job!.priority,1);
  for(let i=1;i<=11;i++) await paidRequest(req(i),response);
  await sql`UPDATE articles SET processing_state='analyzed' WHERE id=ANY(${ids.slice(0,2)}::text[])`;
  await enqueue(QUEUES.group,{articleId:ids[0]!},{singletonKey:`bootstrap-${T}`});
  assert.equal((await reconcileBootstrapBudget()).status,"active","the captured articles' event work must settle first");
  await sql`UPDATE pgboss.job SET state='completed' WHERE name='events.group' AND data->>'articleId'=${ids[0]!}`;
  assert.equal((await reconcileBootstrapBudget()).status,"restored");
  const view=await bootstrapBudgetStatus();assert.equal(view!.pending,0);assert.equal(view!.total,2);
  assert.equal((await sql`SELECT processing_state FROM articles WHERE id=${ids[2]!}`)[0]!.processing_state,"new");
  await paidRequest(req(12),response);
  await assert.rejects(paidRequest(req(13),response),BudgetExceededError,"new work gets its original one-call window after the burst");
  const [ledger] = await sql<{n:number}[]>`SELECT count(*)::int n FROM receipts WHERE purpose='bootstrap_fixture'`;
  assert.equal(ledger!.n,13,"the historical charged requests remain recorded");
});

test("a manual budget edit cancels automatic restoration and is never overwritten",async()=>{
  await startBootstrapBudget(burst,"test",{articleIds:[ids[2]!]});
  await sql`UPDATE budgets SET per_day=50 WHERE service='llm'`;
  assert.equal((await reconcileBootstrapBudget()).status,"superseded");
  assert.equal((await sql`SELECT per_day FROM budgets WHERE service='llm'`)[0]!.per_day,50);
});

test("an unfinished catch-up expires and a restart can still restore its original limits",async()=>{
  await startBootstrapBudget(burst,"test",{articleIds:[ids[2]!]});
  await sql`UPDATE settings SET value=jsonb_set(value,'{expiresAt}',to_jsonb((now()-interval '1 minute')::text)) WHERE key=${KEY}`;
  assert.equal((await reconcileBootstrapBudget()).status,"expired");
  assert.equal((await sql`SELECT per_day FROM budgets WHERE service='llm'`)[0]!.per_day,50);
  assert.equal((await bootstrapBudgetStatus())!.pending,1);
});
