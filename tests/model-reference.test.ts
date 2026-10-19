import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { saveModelConnection, deleteModelConnection, readModelConfig } from "@aihot/backend/providers/model-config";
import { switchModel } from "@aihot/backend/admin/models";
import { invalidateModelCache, modelFor } from "@aihot/backend/editorial/models";
after(closeDb);
const input={name:"引用回归",type:"api-key",model:"fixture-special",baseUrl:"http://127.0.0.1:1/v1",apiKey:"fictional-key"};
test("R06：能力引用阻止非默认连接删除，解除后可以删除",async()=>{
  const c=await saveModelConnection(input),key=`connection:${c.id}`;
  const previous=await sql`SELECT value FROM settings WHERE key='models.score'`;
  try {
    await switchModel("score",key,"本地回归","test");
    await assert.rejects(deleteModelConnection(c.id),error=>error instanceof Error && /score/.test(error.message) && (error as any).statusCode===409);
    invalidateModelCache(); assert.equal(await modelFor("score"),key);
    await switchModel("score",null,"解除引用","test");
    assert.ok(await deleteModelConnection(c.id)); assert.equal(await deleteModelConnection(c.id),null);
  } finally {
    await sql`DELETE FROM settings WHERE key='models.score'`;
    if(previous.length) await sql`INSERT INTO settings(key,value) VALUES('models.score',${sql.json(previous[0]!.value)})`;
    invalidateModelCache();
  }
});
test("R06：并发分配与删除只能成功一方，不留下悬空引用",async()=>{
  const previous=await sql`SELECT value FROM settings WHERE key='models.score'`;
  try {
    for(let i=0;i<4;i++) {
      const c=await saveModelConnection(input),key=`connection:${c.id}`;
      const results=await Promise.allSettled([switchModel("score",key,"并发回归","test"),deleteModelConnection(c.id)]);
      assert.ok(results.some(r=>r.status==="rejected"));
      const [setting]=await sql`SELECT value FROM settings WHERE key='models.score'`;
      if(setting?.value.model===key) assert.ok((await readModelConfig()).connections.some(x=>x.id===c.id));
      await switchModel("score",null,"清理合成引用","test"); await deleteModelConnection(c.id);
    }
  } finally {
    await sql`DELETE FROM settings WHERE key='models.score'`;
    if(previous.length) await sql`INSERT INTO settings(key,value) VALUES('models.score',${sql.json(previous[0]!.value)})`;
    invalidateModelCache();
  }
});
