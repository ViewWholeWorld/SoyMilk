import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AdminModelSupplier } from "@aihot/contracts/admin";
import { sql } from "../db.ts";

export async function listModelSuppliers(): Promise<AdminModelSupplier[]> {
  return sql<AdminModelSupplier[]>`SELECT id,name FROM model_suppliers ORDER BY name,id`;
}

export async function createModelSupplier(input: unknown): Promise<AdminModelSupplier> {
  const { name: raw } = z.object({ name: z.string().trim().min(1).max(100) }).parse(input);
  const name = raw.replace(/\s+/gu, " ");
  const [supplier] = await sql<AdminModelSupplier[]>`
    INSERT INTO model_suppliers(id,name,normalized_name) VALUES(${randomUUID()},${name},${name.toLowerCase()})
    ON CONFLICT(normalized_name) DO UPDATE SET normalized_name=EXCLUDED.normalized_name RETURNING id,name`;
  return supplier!;
}
