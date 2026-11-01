import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { parseHTML } from "linkedom";
import { transformSync } from "rolldown/utils";
import type { StoryDetail, StoryReportView } from "@aihot/contracts/site";

// 直接渲染实际事件页，路由 loader 仅提供合成数据，不访问网络。
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && context.parentURL?.includes("/apps/web/app/")) {
      const url = new URL(specifier, context.parentURL);
      for (const ext of [".ts", ".tsx"]) if (existsSync(new URL(url.href + ext))) return next(url.href + ext, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith("file:") && url.endsWith(".tsx")) return { format: "module", shortCircuit: true, source: transformSync(url, readFileSync(new URL(url), "utf8"), { lang: "tsx", jsx: { runtime: "automatic" } }).code };
    return next(url, context);
  },
});
after(() => hooks.deregister());
const { default: StoryPage } = await import("../app/routes/story.tsx");

test("事件页 SSR 的报道日标题跨年带年份，同年不带，以北京时间判年", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-12-31T16:00:00Z") });
  const timeline: StoryReportView[] = ["2026-12-31T15:30:00Z", "2026-12-31T16:15:00Z"].map((publishedAt, i) => ({
    id: `report-${i}`, title: `测试报道 ${i}`, summary: null,
    source: { id: "fixture", name: "测试信源", kind: "rss", iconUrl: null, firstParty: false },
    publishedAt, originalUrl: "https://example.invalid/report", selected: false, factId: `fact-${i}`,
  }));
  const story: StoryDetail = {
    publicId: "year-boundary", title: "跨年事件", status: "settled", reportCount: 2, sourceCount: 1,
    firstReportAt: timeline[0]!.publishedAt, latestAt: timeline[1]!.publishedAt,
    digest: null, digestUpdatedAt: null, summary: null, excerpt: null, latest: null,
    whyHot: { participants48h: 0, newParticipants6h: 0, recentReports24h: 0, observationComplete: true, rank: null, heat: null },
    developments: [], officialReports: [], timeline, heat: [], related: [],
  };
  const handler = createStaticHandler([{ path: "/story/:publicId", Component: StoryPage, loader: () => ({ story }) }]);
  const context = await handler.query(new Request("http://site.test/story/year-boundary"));
  assert.ok(!(context instanceof Response));
  const router = createStaticRouter(handler.dataRoutes, context);
  const html = renderToStaticMarkup(createElement(StaticRouterProvider, { router, context, hydrate: false }));
  const { document } = parseHTML(html);
  const headings = Array.from(document.querySelectorAll('#event-reports .font-semibold'), node => node.textContent);
  assert.deepEqual(headings, ["1月1日", "2026年12月31日"]);
  const times = Array.from(document.querySelectorAll("#event-reports time"), node => node.textContent);
  assert.deepEqual(times, ["00:15", "23:30"]);
});
