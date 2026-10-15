-- Supplemental history estimates never overwrite attempts, receipts, budgets or original prices.
CREATE TABLE model_cost_backfill_runs (
  id uuid PRIMARY KEY,
  plan_hash text NOT NULL,
  plan jsonb NOT NULL,
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','completed')),
  total bigint NOT NULL DEFAULT 0,
  processed bigint NOT NULL DEFAULT 0,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (processed >= 0 AND processed <= total)
);

CREATE TABLE model_cost_backfill_results (
  run_id uuid NOT NULL REFERENCES model_cost_backfill_runs(id) ON DELETE CASCADE,
  -- No FK to the live tables: history estimates must not lock paid receipts or block retention.
  attempt_id bigint NOT NULL,
  provider_key text,
  requested_model text,
  billing_kind text CHECK (billing_kind IN ('api','subscription_equivalent')),
  pricing_snapshot jsonb,
  metadata jsonb,
  usage_hash text,
  normalized_usage jsonb,
  estimated_cost numeric(24,12),
  currency text CHECK (currency IN ('USD','CNY')),
  estimate_status text CHECK (estimate_status IN ('complete','approximate','partial','unpriced','missing_usage','invalid_usage')),
  detail jsonb,
  mapping_evidence jsonb,
  processed_at timestamptz,
  PRIMARY KEY (run_id,attempt_id)
);
CREATE INDEX model_cost_backfill_pending_idx ON model_cost_backfill_results(run_id,attempt_id) WHERE processed_at IS NULL;
