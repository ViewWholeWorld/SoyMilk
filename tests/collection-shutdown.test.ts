import "./setup.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

test("a collection interrupted during shutdown closes its run for later recovery", () => {
  const child = [
    'import assert from "node:assert/strict";',
    'import "./tests/setup.ts";',
    'import { sql, closeDb } from "@aihot/backend/db";',
    'import { shutdownSignal } from "@aihot/backend/lib/shutdown";',
    'import { collectSource } from "@aihot/backend/sources/collect";',
    'const id = "shutdown-boundary-" + Date.now().toString(36);',
    'await sql.unsafe("INSERT INTO sources (id, name, kind, config, tier, participation_mode, next_fetch_at) VALUES (\'" + id + "\', \'" + id + "\', \'rss\', \'{\\"feedUrl\\":\\"not a URL\\"}\'::jsonb, \'T1\', \'editorial\', \'2100-01-01\')");',
    'shutdownSignal.abort();',
    'const result = await collectSource(id, { force: true });',
    'const [run] = await sql.unsafe("SELECT status, error, detail FROM fetch_runs WHERE source_id = \'" + id + "\' ORDER BY id DESC LIMIT 1");',
    'assert.equal(result.status, "skipped");',
    'assert.equal(result.error, "shutdown");',
    'assert.equal(run.status, "skipped");',
    'assert.equal(run.error, "shutdown");',
    'assert.equal(run.detail.waiting.kind, "shutdown");',
    'await sql.unsafe("DELETE FROM sources WHERE id = \'" + id + "\'");',
    'await closeDb();',
  ].join("\n");
  execFileSync(process.execPath, ["--input-type=module", "-e", child], { cwd: new URL("..", import.meta.url), env: process.env, stdio: "inherit" });
});
