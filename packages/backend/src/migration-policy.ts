import { createHash } from "node:crypto";

export interface MigrationFile {
  name: string;
  number: number;
}

export interface AppliedMigration {
  name: string;
  checksum: string | null;
}

export function migrationFiles(files: string[]): MigrationFile[] {
  const parsed = files.map((name) => {
    const match = /^(\d{4})_[A-Za-z0-9][A-Za-z0-9_-]*\.sql$/.exec(name);
    if (!match) throw new Error(`invalid migration filename: ${name}`);
    return { name, number: Number(match[1]) };
  }).sort((a, b) => a.number - b.number || a.name.localeCompare(b.name));
  const seen = new Set<number>();
  let previous = -1;
  for (const migration of parsed) {
    if (seen.has(migration.number)) throw new Error(`duplicate migration number: ${migration.number}`);
    if (migration.number <= previous) throw new Error(`migration numbers must increase: ${migration.name}`);
    seen.add(migration.number);
    previous = migration.number;
  }
  return parsed;
}

export function migrationChecksum(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function validateAppliedMigrations(applied: AppliedMigration[], files: MigrationFile[], checksums: Map<string, string>): void {
  const known = new Set(files.map((file) => file.name));
  for (const row of applied) {
    if (!known.has(row.name)) throw new Error(`database has migration missing from image: ${row.name}`);
    const expected = checksums.get(row.name);
    if (!expected) throw new Error(`missing checksum for migration: ${row.name}`);
    if (row.checksum && row.checksum !== expected) throw new Error(`migration checksum mismatch: ${row.name}`);
  }
  const highestApplied = Math.max(-1, ...applied.map((row) => files.find((file) => file.name === row.name)!.number));
  const appliedNames = new Set(applied.map((row) => row.name));
  const backfilled = files.find((file) => !appliedNames.has(file.name) && file.number <= highestApplied);
  if (backfilled) throw new Error(`unapplied migration number is older than the database: ${backfilled.name}`);
}
