-- Model-specific pricing is separate from the legacy service_prices table. Values are snapshots,
-- so changing a rule never changes an already completed attempt.
CREATE TABLE model_price_catalog (
  source                 text NOT NULL,
  source_provider_id     text NOT NULL,
  source_model_id        text NOT NULL,
  name                   text NOT NULL,
  currency               text NOT NULL CHECK (currency IN ('USD', 'CNY')),
  input_per_mtok         numeric(20, 8),
  output_per_mtok        numeric(20, 8),
  cache_read_per_mtok    numeric(20, 8),
  cache_write_per_mtok   numeric(20, 8),
  source_url             text,
  retrieved_at           timestamptz NOT NULL,
  revision               integer NOT NULL DEFAULT 1,
  price_hash             text NOT NULL,
  supported              boolean NOT NULL DEFAULT true,
  unsupported_reason     text,
  raw_pricing            jsonb,
  active                 boolean NOT NULL DEFAULT true,
  PRIMARY KEY (source, source_provider_id, source_model_id)
);

CREATE INDEX model_price_catalog_search_idx ON model_price_catalog (source, name, source_provider_id);

CREATE TABLE model_price_sync_state (
  source          text PRIMARY KEY,
  etag            text,
  last_modified   text,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error      text,
  entry_count     integer NOT NULL DEFAULT 0,
  catalog_revision text
);

CREATE TABLE model_pricing (
  provider_key           text NOT NULL,
  requested_model        text NOT NULL,
  billing_kind           text NOT NULL CHECK (billing_kind IN ('api', 'subscription_equivalent')),
  mode                   text NOT NULL CHECK (mode IN ('reference', 'custom')),
  reference_provider_id  text,
  reference_model_id     text,
  currency               text NOT NULL CHECK (currency IN ('USD', 'CNY')),
  input_per_mtok         numeric(20, 8),
  output_per_mtok        numeric(20, 8),
  cache_read_per_mtok    numeric(20, 8),
  cache_write_per_mtok   numeric(20, 8),
  revision               integer NOT NULL DEFAULT 1,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             text,
  note                   text,
  price_hash             text,
  PRIMARY KEY (provider_key, requested_model),
  CHECK (mode <> 'custom' OR (input_per_mtok IS NOT NULL OR output_per_mtok IS NOT NULL)),
  CHECK (input_per_mtok IS NULL OR input_per_mtok >= 0),
  CHECK (output_per_mtok IS NULL OR output_per_mtok >= 0),
  CHECK (cache_read_per_mtok IS NULL OR cache_read_per_mtok >= 0),
  CHECK (cache_write_per_mtok IS NULL OR cache_write_per_mtok >= 0)
);

ALTER TABLE receipt_attempts
  ADD COLUMN provider_key text,
  ADD COLUMN provider_label_snapshot text,
  ADD COLUMN billing_kind text CHECK (billing_kind IN ('api', 'subscription_equivalent')),
  ADD COLUMN requested_model text,
  ADD COLUMN reported_model text,
  ADD COLUMN pricing_snapshot jsonb,
  ADD COLUMN normalized_usage jsonb,
  ADD COLUMN estimated_cost numeric(24, 12),
  ADD COLUMN estimated_currency text CHECK (estimated_currency IN ('USD', 'CNY')),
  ADD COLUMN estimate_status text CHECK (estimate_status IN ('complete', 'approximate', 'partial', 'unpriced', 'missing_usage', 'invalid_usage')),
  ADD COLUMN estimate_detail jsonb;

CREATE INDEX receipt_attempts_provider_time_idx ON receipt_attempts (provider_key, started_at);
