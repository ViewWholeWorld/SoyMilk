import postgres from "postgres";
import { config } from "./config.ts";

export interface DatabaseSettings {
  poolMax: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
}

function boundedInteger(environment: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = environment[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Environment variable ${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function databaseSettings(environment: NodeJS.ProcessEnv = process.env): DatabaseSettings {
  return {
    poolMax: boundedInteger(environment, "DATABASE_POOL_MAX", 10, 1, 50),
    statementTimeoutMs: boundedInteger(environment, "DATABASE_STATEMENT_TIMEOUT_MS", 30_000, 100, 120_000),
    lockTimeoutMs: boundedInteger(environment, "DATABASE_LOCK_TIMEOUT_MS", 5_000, 50, 30_000),
  };
}

const settings = databaseSettings();

// int8 and numeric come back as numbers: ids and scores in this schema stay far below 2^53.
const numberType = (oid: number) => ({
  to: oid,
  from: [oid],
  serialize: (value: unknown) => String(value),
  parse: (value: string) => Number(value),
});

export const sql = postgres(config.databaseUrl, {
  max: settings.poolMax,
  // Keep connections through quiet minutes: a reconnect costs a SCRAM exchange on the next request.
  idle_timeout: 600,
  connect_timeout: 10,
  onnotice: () => {},
  // Prepared statements keep PostgreSQL's plan cache: planning a detail read took longer than running
  // it. Searches plan every execution instead (withCustomPlans). JIT compilation costs more than
  // these short queries ever run.
  connection: {
    jit: "off",
    options: `-c statement_timeout=${settings.statementTimeoutMs} -c lock_timeout=${settings.lockTimeoutMs}`,
  },
  types: {
    int8: numberType(20),
    numeric: numberType(1700),
  },
});

export type Sql = typeof sql;
export type Tx = postgres.TransactionSql;
export type Db = Sql | Tx;

/**
 * Runs queries with plans made for their actual values. A cached generic plan cannot tell a
 * two-character search term (no usable trigram) from a longer one and would scan the whole trigram
 * index, so every search goes through here.
 */
export function withCustomPlans<T>(fn: (db: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SET LOCAL plan_cache_mode = force_custom_plan`;
    return fn(tx);
  }) as Promise<T>;
}

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}

/** First row of a query that always returns one (aggregates). */
export function one<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected one row");
  return row;
}
