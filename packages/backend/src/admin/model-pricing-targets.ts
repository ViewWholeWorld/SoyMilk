import { sql, type Db } from "../db.ts";
import { registeredModels } from "../providers/llm.ts";
import { modelBillingContext } from "../providers/model-billing.ts";
import { pricingSnapshotFor, type BillingContext } from "../providers/model-pricing.ts";

export async function modelPricingTargets(db: Db = sql) {
  const registry = await registeredModels();
  const targets = new Map<string, BillingContext & { deleted: boolean; historical: boolean }>();
  const key = (entry: BillingContext) => JSON.stringify([entry.providerKey, entry.requestedModel]);
  for (const spec of Object.values(registry)) {
    if (!spec.model) continue;
    const entry = { ...modelBillingContext(spec), deleted: false, historical: false };
    targets.set(key(entry), entry);
  }
  const rules = await db<{ provider_key: string; requested_model: string; billing_kind: BillingContext["billingKind"] }[]>`SELECT provider_key,requested_model,billing_kind FROM model_pricing`;
  const connections = new Set(Object.values(registry).flatMap(spec => spec.connection?.id ? [`connection:${spec.connection.id}`] : []));
  for (const rule of rules) {
    const current = [...targets.values()].find(target => target.providerKey === rule.provider_key);
    const entry = { providerKey: rule.provider_key, requestedModel: rule.requested_model, billingKind: current?.billingKind ?? rule.billing_kind,
      providerLabel: current?.providerLabel ?? rule.provider_key, deleted: rule.provider_key.startsWith("connection:") && !connections.has(rule.provider_key), historical: true };
    if (!targets.has(key(entry))) targets.set(key(entry), entry);
  }
  return Promise.all([...targets.values()].map(async target => ({ ...target, effective: await pricingSnapshotFor(db, target) })));
}
