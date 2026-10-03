import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prepareCandidate, requiresReview } from "../scripts/automation/upstream-sync.ts";

test("upstream automation guards customization, migrations, model protection and deployment", () => {
  assert.deepEqual(requiresReview(["apps/web/app/feed.tsx", "industry/site.ts", "database/migrations/9999.sql",
    ".github/workflows/check.yml", "deploy/nas/compose.sh", "packages/backend/src/providers/budget.ts",
    "packages/backend/src/operations/bootstrap-budget.ts", "docker-compose.yml"]), [
    "industry/site.ts", "database/migrations/9999.sql", ".github/workflows/check.yml", "deploy/nas/compose.sh",
    "packages/backend/src/providers/budget.ts", "packages/backend/src/operations/bootstrap-budget.ts", "docker-compose.yml",
  ]);
  assert.throws(() => prepareCandidate(".", "bad/ref"), /numeric/);
});

test("candidate is a merge preserving customization; no-op and guarded changes never push main", () => {
  const root = mkdtempSync(path.join(tmpdir(), "soymilk-sync-test-"));
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  try {
    const upstream = path.join(root, "upstream");
    const origin = path.join(root, "origin.git");
    const work = path.join(root, "work");
    mkdirSync(upstream);
    git(upstream, "init", "-b", "main");
    writeFileSync(path.join(upstream, "feed.txt"), "baseline\n");
    mkdirSync(path.join(upstream, "deploy"));
    writeFileSync(path.join(upstream, "deploy", "protected.txt"), "deployment contract\n");
    git(upstream, "add", "."); git(upstream, "commit", "-m", "baseline");
    git(root, "clone", "--bare", upstream, origin);
    git(root, "clone", origin, work);
    mkdirSync(path.join(work, "industry"));
    writeFileSync(path.join(work, "industry", "site.ts"), "SoyMilk\n");
    git(work, "add", "."); git(work, "commit", "-m", "customization"); git(work, "push", "origin", "main");
    const base = git(work, "rev-parse", "HEAD");
    assert.equal(prepareCandidate(work, "1", upstream).changed, "false");
    writeFileSync(path.join(upstream, "feed.txt"), "updated\n");
    git(upstream, "add", "."); git(upstream, "commit", "-m", "routine update");
    const candidate = prepareCandidate(work, "2", upstream);
    assert.equal(candidate.changed, "true");
    assert.equal(candidate.base, base);
    assert.equal(git(work, "show", "HEAD:industry/site.ts"), "SoyMilk");
    assert.equal(git(work, "rev-parse", "origin/main"), base);
    assert.equal(git(work, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length, 3);
    git(upstream, "mv", "deploy/protected.txt", "moved.txt");
    git(upstream, "commit", "-m", "move protected deployment file");
    assert.throws(() => prepareCandidate(work, "3", upstream), /Manual review required/);
    assert.equal(git(work, "rev-parse", "origin/main"), base);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
