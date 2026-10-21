-- 待批时间和付费批次分开保存；已冻结成员与原始请求在恢复时保持不变。
CREATE TABLE prefilter_waiting (
  article_id text PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  attempt_tag text NOT NULL DEFAULT '',
  single_only boolean NOT NULL DEFAULT false,
  queued_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prefilter_waiting_due ON prefilter_waiting(queued_at,article_id);

CREATE TABLE prefilter_batches (
  id uuid PRIMARY KEY,
  model_key text NOT NULL,
  configuration_hash text NOT NULL,
  prompt_version text NOT NULL,
  system_text text NOT NULL,
  user_text text NOT NULL,
  receipt_id bigint REFERENCES receipts(id),
  state text NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','waiting','unknown','completed','failed','cancelled')),
  failures integer NOT NULL DEFAULT 0,
  retry_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX prefilter_batches_recovery ON prefilter_batches(state,retry_at);

CREATE TABLE prefilter_batch_members (
  batch_id uuid NOT NULL REFERENCES prefilter_batches(id),
  position integer NOT NULL,
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  attempt_tag text NOT NULL,
  queued_at timestamptz NOT NULL,
  input_hash text NOT NULL,
  missing_evidence boolean NOT NULL,
  result jsonb,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','stale','cancelled')),
  PRIMARY KEY(batch_id,position),
  UNIQUE(batch_id,article_id)
);
CREATE UNIQUE INDEX prefilter_member_identity ON prefilter_batch_members(article_id,revision,attempt_tag)
  WHERE state <> 'cancelled';
