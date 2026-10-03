import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runDeployment, assertCompatible, type DeploymentActions } from "../deploy/nas/auto-update.ts";
import { validateManifest, releaseOverlay, fingerprints } from "../deploy/nas/release-manifest.ts";

const release = { schema: 1 as const, revision: "a".repeat(40), image: `ghcr.io/viewwholeworld/soymilk@sha256:${"b".repeat(64)}`,
  migrationsHash: "c".repeat(64), composeHash: "d".repeat(64) };

test("release channel accepts only this repository's immutable images and exact revisions", () => {
  assert.deepEqual(validateManifest(release), release);
  for (const value of [null, { ...release, schema: 2 }, { ...release, image: "ghcr.io/viewwholeworld/soymilk:latest" },
    { ...release, image: release.image.replace("viewwholeworld", "someone") }, { ...release, revision: "main" },
    { ...release, migrationsHash: "unknown" }]) assert.throws(() => validateManifest(value), /Invalid release/);
  assert.throws(() => releaseOverlay({ setup: "latest", api: release.image, worker: release.image, web: release.image }), /immutable/);
  const overlay = releaseOverlay({ setup: release.image, api: release.image, worker: release.image, web: release.image });
  assert.equal((overlay.match(/pull_policy: never/g) ?? []).length, 4);
  const command = JSON.parse(overlay.match(/command: (\[.*\])/)![1]);
  assert.deepEqual(command, ["sh", "-c", "node scripts/migrate.ts && node scripts/seed.ts --topics-only"]);
  assert.doesNotMatch(overlay, /environment|volumes/);
});

test("migration fingerprints are portable, and any migration or Compose change blocks deployment", () => {
  const root = mkdtempSync(path.join(tmpdir(), "soymilk-manifest-"));
  try {
    mkdirSync(path.join(root, "database/migrations"), { recursive: true });
    writeFileSync(path.join(root, "database/migrations/0001.sql"), "SELECT 1;\r\n");
    writeFileSync(path.join(root, "docker-compose.yml"), "services:\r\n");
    const first = fingerprints(root);
    writeFileSync(path.join(root, "database/migrations/0001.sql"), "SELECT 1;\n");
    writeFileSync(path.join(root, "docker-compose.yml"), "services:\n");
    assert.deepEqual(fingerprints(root), first);
    const manifest = { ...release, ...first };
    assert.doesNotThrow(() => assertCompatible(manifest, first, first));
    writeFileSync(path.join(root, "database/migrations/0002.sql"), "SELECT 2;\n");
    assert.throws(() => assertCompatible(manifest, first, fingerprints(root)), /manual approval/);
    assert.throws(() => assertCompatible(manifest, { ...first, composeHash: "e".repeat(64) }, first), /manual approval/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function actions(fail?: keyof DeploymentActions, rollbackFails = false) {
  const calls: string[] = [];
  const adapter = Object.fromEntries(["compatible", "snapshot", "stop", "backup", "install", "migrate", "start", "smoke", "complete", "rollback"].map((stage) => [stage, () => {
    calls.push(stage);
    if (stage === fail || (rollbackFails && stage === "rollback")) throw new Error("simulated failure");
  }])) as unknown as DeploymentActions;
  return { calls, adapter };
}

test("deployment backs up after graceful stop and verifies before marking complete", () => {
  const a = actions();
  assert.equal(runDeployment(a.adapter).status, "deployed");
  assert.deepEqual(a.calls, ["compatible", "snapshot", "stop", "backup", "install", "migrate", "start", "smoke", "complete"]);
});

test("failed compatibility never stops services; backup, migration and smoke failures roll back only the application", () => {
  const blocked = actions("compatible");
  assert.equal(runDeployment(blocked.adapter).status, "blocked");
  assert.deepEqual(blocked.calls, ["compatible"]);
  for (const stage of ["stop", "backup", "install", "migrate", "start", "smoke", "complete"] as const) {
    const a = actions(stage);
    assert.deepEqual(runDeployment(a.adapter), { status: "rolled-back", stage });
    assert.equal(a.calls.at(-1), "rollback");
    assert.ok(!a.calls.includes("complete") || stage === "complete");
  }
  const a = actions("smoke", true);
  assert.deepEqual(runDeployment(a.adapter), { status: "rollback-failed", stage: "smoke" });
});
