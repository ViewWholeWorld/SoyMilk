// A committed permission restriction must invalidate public snapshots in every API process.
// Check on both sides of a cached read, including a read already in flight during the edit.
import { sql, type Tx } from "../db.ts";
import { cached, type Cached } from "../lib/cache.ts";

const PERMISSION_EPOCH = "publication.permission-epoch";
let epoch = -1;
const clearers = new Set<() => void>();

export function registerPublicationCache(clear: () => void): void {
  clearers.add(clear);
}

export function publicationCacheEpoch(): number {
  return epoch;
}

async function currentEpoch(): Promise<number> {
  const [row] = await sql<{ value: { epoch: number } }[]>`SELECT value FROM settings WHERE key = ${PERMISSION_EPOCH}`;
  const current = row?.value.epoch ?? 0;
  // Concurrent checks can complete out of order; an older check never restores an earlier epoch.
  if (current > epoch) {
    epoch = current;
    for (const clear of clearers) clear();
  }
  return current;
}

export async function readPublicationCache<T>(read: () => Promise<T>): Promise<T> {
  for (;;) {
    const before = await currentEpoch();
    if (before < epoch) continue;
    const value = await read();
    if (await currentEpoch() === before && before === epoch) return value;
  }
}

export function publicationCached<T>(load: () => Promise<T>, opts: Parameters<typeof cached<T>>[1]): Cached<T> {
  const entry = cached(load, opts);
  registerPublicationCache(() => entry.clear());
  return { get: () => readPublicationCache(() => entry.get()), clear: () => entry.clear() };
}

/** Called last in the transaction that tightens public projections. Rollbacks leave caches valid. */
export async function advancePublicationPermissions(tx: Tx): Promise<void> {
  await tx`INSERT INTO settings (key, value) VALUES (${PERMISSION_EPOCH}, '{"epoch":1}'::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = jsonb_build_object('epoch', (settings.value->>'epoch')::bigint + 1), updated_at = now()`;
}
