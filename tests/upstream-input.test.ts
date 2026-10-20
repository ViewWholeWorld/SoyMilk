import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { looseQuery, strictQuery, QueryError } from "../apps/api/src/http/respond.ts";
import type { FastifyRequest } from "fastify";

test("HTTP查询拒绝控制字符，未知参数不污染原型，首值和重复契约保持", () => {
  const req = (url: string) => ({ raw: { url } }) as FastifyRequest;
  for (const url of ["/?q=ab%00cd", "/?%00=x", "/?q=ab%0Dcd", "/?q=valid&q=%00"]) {
    assert.throws(() => looseQuery(req(url)), QueryError);
    assert.throws(() => strictQuery(req(url), ["q"]), QueryError);
  }
  assert.equal(looseQuery(req("/?q=first&q=second")).q, "first");
  assert.throws(() => strictQuery(req("/?q=first&q=second"), ["q"]), QueryError);
  const q = looseQuery(req("/?__proto__=safe&constructor=value"));
  assert.equal(Object.getPrototypeOf(q), Object.prototype); assert.equal(q.__proto__, "safe"); assert.equal(q.constructor, "value");
});

test("请求头大小写覆盖默认，带引号字符集正确解码且NUL只替换文本视图", async () => {
  const previous = getGlobalDispatcher(), allowPrivate = config.allowPrivateNetworkFetch;
  const mock = new MockAgent(); mock.disableNetConnect(); setGlobalDispatcher(mock); config.allowPrivateNetworkFetch = true;
  try {
    const bytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0]);
    mock.get("http://upstream.invalid").intercept({ path: "/", headers: { "user-agent": "caller-agent" } }).reply(200, bytes, { headers: { "content-type": 'text/html; charset="gb2312"' } });
    const response = await guardedFetch("http://upstream.invalid/", { headers: { "User-Agent": "caller-agent" } });
    assert.equal(response.text(), "中文\uFFFD"); assert.deepEqual(response.body, bytes);
    mock.assertNoPendingInterceptors();
  } finally { setGlobalDispatcher(previous); config.allowPrivateNetworkFetch = allowPrivate; await mock.close(); }
});
