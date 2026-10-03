// A second API process with its own warm caches; it reads only the isolated test database.
import { closeDb } from "@aihot/backend/db";
import { loadPool } from "@aihot/backend/publication/pool";
import { loadTimeline } from "@aihot/backend/publication/timeline";
import { topicPageCounts } from "@aihot/backend/publication/topics";
import { listReports } from "@aihot/backend/publication/reports";
import { sitemapXml } from "@aihot/backend/publication/sitemap";
import { loadSiteStats } from "@aihot/backend/site/stats";

const [id, topic, tag, report] = process.argv.slice(2);
process.on("message", async () => {
  try {
    const [pool, timeline, topics, reports, sitemap, stats] = await Promise.all([
      loadPool({ tag }), loadTimeline({ tag }), topicPageCounts(), listReports("daily"), sitemapXml(), loadSiteStats(),
    ]);
    process.send!({ pool: pool.total, cards: timeline.cards.length, topic: topics.find(t => t.slug === topic)?.total,
      headline: reports.find(r => r.key === report)?.title, sitemap: sitemap.includes(`/items/${id}`),
      latest: stats.latest.some(item => item.id === id) });
  } catch (error) { process.send!({ error: String(error) }); }
});
process.on("disconnect", async () => { await closeDb(); });
process.send!({ ready: true });
