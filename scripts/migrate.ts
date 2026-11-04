// Applies database/migrations/*.sql in order, each in its own transaction. Safe to re-run.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { migrationChecksum, migrationFiles, validateAppliedMigrations } from "@aihot/backend/migration-policy";

const dir = path.join(REPO_ROOT, "database/migrations");
const files = migrationFiles(readdirSync(dir).filter((f) => f.endsWith(".sql")));
const texts = new Map(files.map(({ name }) => [name, readFileSync(path.join(dir, name), "utf8")]));
const checksums = new Map([...texts].map(([name, text]) => [name, migrationChecksum(text)]));
const lock = await sql.reserve();
let count = 0;
try {
  const transaction = async (fn: (tx: typeof lock) => Promise<void>) => {
    await lock`BEGIN`;
    try {
      await fn(lock);
      await lock`COMMIT`;
    } catch (error) {
      await lock`ROLLBACK`;
      throw error;
    }
  };
  await lock`SELECT pg_advisory_lock(hashtext('soymilk:migrations'))`;
  await transaction(async (tx) => {
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    await tx`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text`;
  });
  const appliedRows = await lock<{ name: string; checksum: string | null }[]>`SELECT name, checksum FROM schema_migrations ORDER BY name`;
  validateAppliedMigrations(appliedRows, files, checksums);
  const applied = new Set(appliedRows.map((row) => row.name));
  for (const { name } of files) {
    if (applied.has(name)) {
      if (appliedRows.find((row) => row.name === name)?.checksum === null) {
        await lock`UPDATE schema_migrations SET checksum = ${checksums.get(name)!} WHERE name = ${name}`;
      }
      continue;
    }
    const text = texts.get(name)!;
    await transaction(async (tx) => {
      await tx.unsafe(text);
      await tx`INSERT INTO schema_migrations (name, checksum) VALUES (${name}, ${checksums.get(name)!})`;
    });
    console.log(`applied ${name}`);
    count += 1;
  }
  console.log(count === 0 ? "database is up to date" : `${count} migration(s) applied`);
} finally {
  await lock`SELECT pg_advisory_unlock(hashtext('soymilk:migrations'))`.catch(() => undefined);
  lock.release();
  await closeDb();
}
