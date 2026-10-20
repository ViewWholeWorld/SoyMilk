// Atom link bases are inherited from feed to entry to link, starting at the fetched document URL.
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { fetchRss } from "@aihot/backend/sources/rss";

const entry = (links: string, base = "") => `<entry${base}><id>urn:test:entry</id><title>Research update</title><updated>2026-10-01T00:00:00Z</updated>${links}</entry>`;
const feed = (entries: string, base = "") => `<feed xmlns="http://www.w3.org/2005/Atom"${base}><id>urn:test:feed</id><title>News</title><updated>2026-10-01T00:00:00Z</updated><author><name>Publisher</name></author>${entries}</feed>`;
const pages: Record<string, string> = {
  "/feed-base": feed(entry('<link href="article-1"/>'), ' xml:base="https://publisher.example/news/"'),
  "/entry-base": feed(entry('<link href="article-1"/>', ' xml:base="https://publisher.example/stories/"'), ' xml:base="https://feed.example/"'),
  "/link-base": feed(entry('<link xml:base="https://publisher.example/articles/" href="article-1"/>')),
  "/news/inherited.xml": feed(entry('<link xml:base="../articles/" href="article-1"/>', ' xml:base="stories/"'), ' xml:base="../publisher/"'),
  "/news/feed.xml": feed(entry('<link href="article-1"/>')),
  "/absolute": feed(entry('<link rel="self" href="entry.xml"/><link rel="alternate" href="https://publisher.example/article-1"/>'), ' xml:base="https://feed.example/"'),
  "/fallback": feed(entry('<link rel="related" href="article-1"/>')),
  "/missing": feed(entry("") + entry('<link rel="alternate"/>')),
  "/fragments": feed(entry('<link href="notes#first"/>') + entry('<link href="notes#second"/>'), ' xml:base="https://publisher.example/"'),
  "/news/rss.xml": '<rss version="2.0"><channel><title>RSS</title><item><title>Relative article</title><link>../article</link></item><item><title>Absolute article</title><link>https://publisher.example/absolute</link></item></channel></rss>',
  "/dates": feed(entry('<link href="https://publisher.example/no-published"/>') + entry('<published>2026-09-29T00:00:00Z</published><link href="https://publisher.example/published"/>')),
};
const server = http.createServer((req, res) => {
  if (req.url === "/old/feed.xml") {
    res.writeHead(302, { location: "/news/feed.xml" });
    return res.end();
  }
  if (req.url === "/old/rss.xml") { res.writeHead(302, { location: "/news/rss.xml" }); return res.end(); }
  res.setHeader("content-type", "application/atom+xml");
  res.end(pages[req.url!] ?? "");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const previousPrivateFetch = config.allowPrivateNetworkFetch;
config.allowPrivateNetworkFetch = true;
after(async () => {
  config.allowPrivateNetworkFetch = previousPrivateFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function read(path: string, preserveUrlFragment = false) {
  return (await fetchRss({ config: { feedUrl: root + path, preserveUrlFragment }, participation_mode: "editorial" } as never)).candidates;
}

test("Atom article links honor absolute xml:base on feed, entry and link", async () => {
  for (const [path, expected] of [
    ["/feed-base", "https://publisher.example/news/article-1"],
    ["/entry-base", "https://publisher.example/stories/article-1"],
    ["/link-base", "https://publisher.example/articles/article-1"],
  ]) assert.equal((await read(path!))[0]!.url, expected);
});

test("relative xml:base values compose through feed, entry and link", async () => {
  assert.equal((await read("/news/inherited.xml"))[0]!.url, root + "/publisher/articles/article-1");
});

test("relative Atom links use the final document URL after redirects", async () => {
  assert.equal((await read("/old/feed.xml"))[0]!.url, root + "/news/article-1");
});

test("absolute alternate links and the first-link fallback keep working", async () => {
  assert.equal((await read("/absolute"))[0]!.url, "https://publisher.example/article-1");
  assert.equal((await read("/fallback"))[0]!.url, root + "/article-1");
  assert.deepEqual(await read("/missing"), []);
});

test("fragment identities are computed from the resolved Atom article URL", async () => {
  const items = await read("/fragments", true);
  assert.deepEqual(items.map((item) => item.identityKey), ["url:https://publisher.example/notes#first", "url:https://publisher.example/notes#second"]);
});

test("RSS相对链接按最终 feed URL 解析，绝对链接保持", async () => {
  assert.deepEqual((await read("/old/rss.xml")).map(item => item.url), [root + "/article", "https://publisher.example/absolute"]);
});

test("Atom updated仅记录修订时间，不冒充首次published", async () => {
  const [unknown, published] = await read("/dates");
  assert.equal(unknown!.publishedAt, null);
  assert.equal(unknown!.sourceUpdatedAt!.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(published!.publishedAt!.toISOString(), "2026-09-29T00:00:00.000Z");
});
